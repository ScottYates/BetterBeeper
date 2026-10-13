'use strict';

/**
 * App updates, from the GitHub releases this repo publishes.
 *
 * The shape of it mirrors `tools/install-update.js`, which already installs a
 * freshly built setup.exe over the running copy from the command line. That
 * script can close the app because it is a separate process doing it. The app
 * cannot: this code runs *inside* the process whose files the installer is
 * about to replace. So the install is split across the restart:
 *
 *   1. main process asks GitHub for the newest release
 *   2. renderer prompts, and on accept streams the asset to disk, reporting
 *      progress as it goes
 *   3. the file is stashed in userData with a marker naming the exe to relaunch
 *   4. the quit that follows hands the install to a detached cmd and exits
 *   5. that script opens the status window, runs the installer silently, and
 *      starts the app again once it has finished
 *
 * Step 4 has to launch the script rather than simply quit, because step 3 only
 * writes a marker and a marker is consumed on the next launch. Quitting on its
 * own therefore ends the update: the app closes and nothing reopens it, and the
 * user has to open it by hand for the install to happen at all. The launch-time
 * apply below still exists, for a machine that was shut down rather than quit
 * between staging and installing - both go through launchInstall().
 *
 * Step 5 is the part worth being careful about. It is a plain NSIS build, so
 * `/S` is a silent reinstall. It must be detached and unref'd, because the
 * parent is about to exit and a child still holding the event loop open
 * prevents that. It must not be awaited either: the installer cannot replace
 * the running executable, so waiting for it here would deadlock against our
 * own still-running process.
 *
 * Nothing is verified beyond what GitHub itself served, and the SHA-256 check
 * in install-update.js is deliberately *not* reproduced here. That script can
 * compare against a build it made on this machine; an update downloaded from
 * the network has no local counterpart to compare against, and inventing one
 * would be theatre. HTTPS plus the asset URL GitHub published is the trust
 * boundary.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { app, net } = require('electron');

const REPO = 'ScottYates/BetterBeeper';
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const USER_AGENT = 'BetterBeeper-updater';

/** The marker file dropped in userData; consumed by applyPendingUpdate(). */
const PENDING_FILE = 'update-pending.json';

/** How the last install went, written by the detached cmd after it exits. */
const INSTALL_RESULT_FILE = 'update-result.txt';

/** The batch file the detached cmd actually runs. Kept on disk, not in argv. */
const APPLY_SCRIPT_FILE = 'update-apply.cmd';

/**
 * The window the user sees while the installer runs.
 *
 * A silent NSIS install replaces the whole install folder, so for the minute it
 * takes the app is simply gone: no window, no process, and an install directory
 * that is briefly empty. Every part of that reads as a crash. The status window
 * is batch only, deliberately: a separate visible console opened with `start`,
 * which works regardless of how the parent process was spawned.
 */
const STATUS_SCRIPT_FILE = 'update-status.cmd';

/**
 * Exists only while an install is in flight. The status window polls it and
 * closes itself when it goes, which is what stops an orphaned window sitting
 * on screen after a failed update.
 */
const RUNNING_FLAG_FILE = 'update-running.flag';

const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Compare two dotted versions.
 *
 * Returns 1 when `a` is newer, -1 when older, 0 when equal. Pre-release
 * suffixes are read the way npm reads them, so 1.4.0-beta.1 is *older* than
 * 1.4.0. That matters here because `gh release create` is pointed at a tag on
 * main: if a pre-release is ever published to /releases/latest, an app already
 * on the final must not be told to "update" backwards to the beta.
 *
 * Numeric identifiers compare numerically (1.10.0 is newer than 1.9.0) and
 * alphanumeric ones compare as text, both case-insensitively. Anything with a
 * non-numeric part is treated as a pre-release marker.
 */
function compareVersions(a, b) {
  const split = (value) => {
    const raw = String(value ?? '').trim().replace(/^v/i, '');
    const [core, pre = ''] = raw.split('-', 2);
    return {
      core: core.split('.').map((n) => {
        const v = parseInt(n, 10);
        return Number.isFinite(v) ? v : 0;
      }),
      pre,
    };
  };

  const left = split(a);
  const right = split(b);
  const len = Math.max(left.core.length, right.core.length);

  for (let i = 0; i < len; i += 1) {
    const l = left.core[i] ?? 0;
    const r = right.core[i] ?? 0;
    if (l !== r) return l > r ? 1 : -1;
  }

  // No suffix on either side: identical. Exactly one side: the suffixed one is
  // the earlier prerelease.
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;

  const lParts = left.pre.split('.');
  const rParts = right.pre.split('.');
  const plen = Math.max(lParts.length, rParts.length);
  for (let i = 0; i < plen; i += 1) {
    const l = lParts[i];
    const r = rParts[i];
    if (l === undefined) return -1; // fewer identifiers sorts first
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) {
      if (Number(l) !== Number(r)) return Number(l) > Number(r) ? 1 : -1;
    } else if (ln !== rn) {
      // Numeric identifiers always have lower precedence than alphanumeric.
      return ln ? -1 : 1;
    } else if (l.toLowerCase() !== r.toLowerCase()) {
      return l.toLowerCase() > r.toLowerCase() ? 1 : -1;
    }
  }
  return 0;
}

/**
 * Pick the installer out of a release's asset list.
 *
 * Matches on the arch suffix first and the `-setup.exe` name second, because a
 * release can also carry a blockmap, a yml and (once this ever builds more than
 * one target) a dmg. Returns null when nothing matches rather than guessing:
 * offering an update that then fails to find an installer is worse than
 * reporting that there is nothing to install.
 */
function pickInstallerAsset(assets, { arch = process.arch } = {}) {
  if (!Array.isArray(assets)) return null;

  const wantArch = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch;
  const candidates = assets.filter((a) => typeof a?.name === 'string' && a.name.toLowerCase().endsWith('-setup.exe'));
  if (!candidates.length) return null;

  const exact = candidates.find((a) => a.name.toLowerCase().includes(`-${wantArch}-setup.exe`));
  return exact || candidates[0];
}

/** Is a release worth offering? Only a strictly newer one is. */
function isNewerRelease(current, tag) {
  return compareVersions(tag, current) > 0;
}

function pendingPath() {
  return path.join(app.getPath('userData'), PENDING_FILE);
}

function readPending() {
  try {
    const raw = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'));
    if (raw && typeof raw.installer === 'string' && raw.installer) return raw;
  } catch {
    /* no marker, or one we cannot read; both mean "nothing to do" */
  }
  return null;
}

function writePending(record) {
  fs.writeFileSync(pendingPath(), JSON.stringify(record, null, 2), 'utf8');
}

function clearPending() {
  try {
    fs.rmSync(pendingPath(), { force: true });
  } catch {
    /* nothing to remove */
  }
}

/**
 * GET a URL and hand back the body as a string.
 *
 * Uses Electron's `net` rather than node's `https`, because `net` goes through
 * Chromium's stack and so honours the system proxy. A corporate proxy is a
 * normal way to run this app and a node request would hang on it.
 */
async function fetchText(url, { timeout = 20000 } = {}) {
  const res = await net.fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res.text();
}

/**
 * Ask GitHub what the newest release is.
 *
 * Answers `{ updateAvailable: false, current, ... }` rather than throwing for
 * the ordinary "you are up to date" case, so a caller has one shape to handle.
 * A network failure is still an error: silently reporting "no update" for an
 * outage would be indistinguishable from being current, and the user is then
 * never told.
 */
async function checkForUpdate({ current = app.getVersion() } = {}) {
  const payload = await fetchText(LATEST_URL);
  const release = JSON.parse(payload);

  const tag = String(release?.tag_name || '').trim();
  if (!tag) throw new Error('GitHub returned a release with no tag');

  const asset = pickInstallerAsset(release.assets);
  const available = isNewerRelease(current, tag);

  return {
    updateAvailable: available,
    current,
    version: tag.replace(/^v/i, ''),
    tag,
    notes: String(release.body || '').trim(),
    url: release.html_url || `https://github.com/${REPO}/releases/tag/${tag}`,
    publishedAt: release.published_at || null,
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size || 0 } : null,
    // Reported so the UI can say why there is nothing to do.
    reason: !available
      ? 'current'
      : asset
        ? null
        : 'no-installer-for-this-arch',
  };
}

/**
 * Stream an asset to disk, reporting progress.
 *
 * `net.request` is used rather than a bare https.get for the proxy behaviour
 * above, and the body is written through a stream so a 90 MB installer never
 * has to exist in memory at once. Progress is throttled to whole percentage
 * points: a 90 MB file at 64 KB chunks would otherwise push thousands of
 * messages at the renderer, and each one is a structured clone across the
 * context bridge.
 */
async function downloadAsset(asset, onProgress, { timeout = DOWNLOAD_TIMEOUT_MS } = {}) {
  if (!asset?.url) throw new Error('no installer to download');

  const total = Number(asset.size) || 0;
  const dest = path.join(app.getPath('temp'), asset.name);

  let written = 0;
  let lastPercent = -1;
  const report = () => {
    if (typeof onProgress !== 'function') return;
    const percent = total > 0 ? Math.floor((written / total) * 100) : 0;
    if (percent === lastPercent) return;
    lastPercent = percent;
    onProgress({ written, total, percent });
  };

  if (typeof onProgress === 'function') onProgress({ written: 0, total, percent: 0 });

  let res;
  try {
    // net.fetch, not net.request. Measured on Electron 38.8.6: net.request
    // emits 'finish' then 'close' within a few milliseconds, having sent
    // nothing and raised no error, for every URL tried. The request object is
    // a Writable stream with no way to read the response, and in this build it
    // never gets one. net.fetch on the same URLs returns 200 and streams the
    // whole asset. Both go through Chromium's stack and honour the proxy, so
    // nothing is lost by using the one that works.
    res = await net.fetch(asset.url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new Error(`the download could not start: ${err.message}`);
  }

  if (!res.ok) throw new Error(`the download server answered ${res.status}`);
  if (!res.body) throw new Error('the download server sent no body');

  const out = fs.createWriteStream(dest);
  try {
    // res.body is a web ReadableStream. Readable.fromWeb adapts it, and
    // pipeline does the copying, the backpressure and the error handling in
    // one place, so a write failure surfaces as a rejection rather than an
    // uncaught exception in the main process.
    const src = Readable.fromWeb(res.body);
    src.on('data', (chunk) => {
      written += chunk.length;
      report();
    });
    await pipeline(src, out);
  } catch (err) {
    out.destroy();
    try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
    throw new Error(`the download failed part way: ${err.message}`);
  }

  if (typeof onProgress === 'function') onProgress({ written, total, percent: 100 });
  return dest;
}

/**
 * Remember the installer, then let the caller quit.
 *
 * The relaunch target is the *installed* exe when there is one, so the app
 * restarts from the normal install rather than from the copy in temp, which the
 * installer may not have touched. Falling back to the current executable is
 * what makes this work while running unpacked during development.
 */
function stageUpdate(installerPath) {
  const exe = process.execPath;
  writePending({ installer: installerPath, relaunch: exe, stagedAt: new Date().toISOString() });
  return { staged: true, relaunch: exe };
}

/**
 * The batch file that finishes an install once this process is gone.
 *
 * A silent NSIS install cannot replace the executable while the app is running,
 * and unpacking 90 MB takes several seconds. So the relaunch has to come *after*
 * the installer exits - not on a timer. Starting the app one second after
 * spawning the installer put the old binary straight back onto the files the
 * installer was replacing, which locks them, makes the install fail or land
 * half-applied, and hands the user the same version back with nothing to show
 * for it.
 *
 * This is a *file* rather than a one-liner for a reason that is not obvious:
 * passing a command containing quotes as a single `cmd /c` argument does not
 * survive the trip. Node escapes the inner quotes for the Windows command line,
 * and cmd.exe's own parsing then treats the backslashes as part of the path, so
 * the installer never runs and a `start` reports a path it cannot find. A file
 * has no quoting layer between here and the shell at all.
 *
 * The steps are deliberately not chained with `&&`: if the installer fails the
 * app should still come back, rather than leaving the user with nothing running
 * and no way back in.
 */
function installScript(installer, exe, { settleSeconds = 3, statusFile = null, runningFlag = null, statusScript = null } = {}) {
  // `ping` is a sleep that works in a windowed session with no console.
  const settle = settleSeconds > 0 ? `ping -n ${settleSeconds} 127.0.0.1 >NUL\r\n` : '';
  // Delayed expansion, so the code read is the installer's and not whatever the
  // shell happened to hold when the line was parsed. Needs /v:on to be on.
  const record = statusFile ? `echo !errorlevel!>"${statusFile}"\r\n` : '';
  // Opens a console window for the status script, which requests its own console
  // regardless of how this process was spawned - that is the reliable way to put
  // a window on screen from a detached, windowless parent.
  //
  // The path is given to `start` directly rather than through `cmd.exe /c`. The
  // /c form needs the path quoted a second time for cmd, and cmd never unwraps
  // it: `cmd /c ""C:\...\status.cmd""` fails outright with "The syntax of the
  // command is incorrect", so the window silently never opened. That line had
  // only ever been checked as text, for two releases.
  //
  // /v:on is gone because it was never needed: the status script turns delayed
  // expansion on for itself with setlocal, so the bar and the tick counter work
  // without the command line asking for it.
  //
  // Guarded on the file existing so the check suite, which writes this script on
  // its own without the status companion, cannot flash a console at whoever is
  // running the tests.
  const showStatus = statusScript
    ? `if exist "${statusScript}" start "Better Beeper Update" "${statusScript}"\r\n`
    : '';
  // Cleared after the installer exits, which is the signal the status window
  // waits on to close itself.
  const clearFlag = runningFlag ? `del "${runningFlag}" >NUL 2>&1\r\n` : '';
  return [
    '@echo off',
    showStatus,
    settle,
    // `call`, not a bare invocation: running one batch file from another without
    // it transfers control and the caller never resumes, so the relaunch below
    // would be silently skipped. It is also correct for an .exe installer,
    // which is what this actually runs against in production.
    `call "${installer}" /S`,
    record,
    clearFlag,
    // /B: relaunch without opening a console window. The app is a GUI binary
    // so it never needed one, but a plain `start` opens one for anything it
    // launches, and the first version of this flashed an empty cmd window at the
    // user every time it ran.
    `start "" /B "${exe}"`,
    '',
  ].join('\r\n');
}

/**
 * The window shown while the installer runs.
 *
 * Batch only and no dependencies, because this is the one thing standing
 * between the user and an unexplained disappearance. It polls the running flag
 * and closes itself when the install finishes, with a bounded loop so a failed
 * update cannot strand a window on screen.
 */
function statusWindowScript(flag, { pollSeconds = 2, maxTicks = 300 } = {}) {
  // Sized to the text and nothing more: 60 columns by 16 rows is exactly the
  // widest line plus the prompt. `mode` needs a real console, which is what
  // `start` gives it.
  //
  // The bar is deliberately indeterminate and says so. NSIS running with /S
  // reports no progress, so a bar that filled up would be inventing a number
  // the app does not have. It sweeps instead, and the tick count is the honest
  // part: it goes up, which is what tells the user nothing is wedged.
  //
  // Note the +1 on the ping. `-n` is a count of pings, not a duration, so
  // `ping -n 1` returns immediately and the loop spins as fast as the disk
  // allows. That is not a theoretical concern: it burned through maxTicks and
  // closed the window in milliseconds, which is exactly the bug this window
  // exists to prevent.
  return [
    '@echo off',
    'mode con: cols=60 lines=16',
    'title Better Beeper Update',
    'setlocal EnableDelayedExpansion',
    'set "TRACK=...................."',
    'set /a __ticks=0',
    'set /a __phase=0',
    ':wait',
    `if not exist "${flag}" goto done`,
    'set /a __ticks+=1',
    `if !__ticks! GEQ ${maxTicks} goto done`,
    'set /a __phase+=1',
    'if !__phase! GEQ 21 set /a __phase=1',
    'set "BAR="',
    'for /L %%i in (1,1,%__phase%) do set "BAR=!BAR!#"',
    `ping -n ${pollSeconds + 1} 127.0.0.1 >NUL`,
    'cls',
    'echo   Better Beeper is updating',
    'echo.',
    'echo   Installing now. The installer is about 90 MB, so this can',
    'echo   take a minute. Better Beeper is closed while this happens,',
    'echo   which is why the app disappears for a moment.',
    'echo.',
    'echo   ========================================================',
    'echo     DO NOT CLOSE THIS WINDOW',
    'echo.',
    'echo     Closing it stops the update and leaves Better Beeper',
    'echo     half installed. It closes itself when it is done.',
    'echo   ========================================================',
    'echo.',
    'echo   [!BAR!]  !__ticks!',
    'goto wait',
    ':done',
    'cls',
    'echo   Update finished.',
    'echo.',
    'echo   Better Beeper is starting now. This window closes itself',
    'echo   in a moment.',
    'ping -n 4 127.0.0.1 >NUL',
    '',
  ].join('\r\n');
}

/** Read and clear how the last install went.
 *
 * The process that could not install itself is gone, so a silent failure has no
 * other chance of being reported - the next launch is the first moment anyone
 * can be told.
 */
function readInstallResult() {
  const file = path.join(app.getPath('userData'), INSTALL_RESULT_FILE);
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const code = Number(raw);
    return { ok: Number.isFinite(code) && code === 0, code: Number.isFinite(code) ? code : null };
  } catch {
    return null; // no marker, or one we cannot read: nothing to report
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** How the install that ran before this launch went, once read. */
let previousInstall = null;

/**
 * Write the scripts and hand the install to a detached cmd.
 *
 * The one place either entry point goes through. There used to be exactly one
 * entry point - the next launch - and the quit after a staged download was not
 * wired to it, so the app closed and nothing came back. Two callers reaching
 * for one function is the fix; two copies of this function is the bug that
 * produced it.
 *
 * Returns true when something was actually launched.
 *
 * `spawnProcess` is a seam for the check. This function's whole job is to hand
 * 90 MB of installer to another process, which is exactly the thing a test
 * must not really do; and a stubbed boundary that records the call is enough,
 * because what is being verified is *that it was launched and with what*.
 */
function launchInstall(pending, { spawnProcess = spawn } = {}) {
  const installer = pending && pending.installer;
  if (!installer || !fs.existsSync(installer)) return false;

  const statusFile = path.join(app.getPath('userData'), INSTALL_RESULT_FILE);
  const runningFlag = path.join(app.getPath('userData'), RUNNING_FLAG_FILE);
  const statusPath = path.join(app.getPath('userData'), STATUS_SCRIPT_FILE);
  const relaunch = (pending && pending.relaunch) || process.execPath;

  let scriptPath;
  try {
    scriptPath = path.join(app.getPath('userData'), APPLY_SCRIPT_FILE);
    fs.writeFileSync(statusPath, statusWindowScript(runningFlag), 'utf8');
    fs.writeFileSync(
      scriptPath,
      installScript(installer, relaunch, { statusFile, runningFlag, statusScript: statusPath }),
      'utf8',
    );
    // Written before the installer starts, not by the script: the status window
    // is opened from inside that script, and a window that appears before the
    // flag exists would check once, see nothing, and close itself immediately.
    fs.writeFileSync(runningFlag, String(Date.now()), 'utf8');
  } catch {
    return false;
  }

  try {
    const child = spawnProcess('cmd.exe', ['/v:on', '/c', scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    // Could not start the installer. There is nothing useful to do from inside
    // the process that was supposed to be replaced, and throwing here would
    // block the app from starting at all.
    return false;
  }

  return true;
}

/**
 * Run a pending install, then exit.
 *
 * Called from main.js before the window exists. The install is handed to a
 * detached cmd.exe running a script we wrote, and this process exits
 * immediately: the installer needs to replace a running executable, so waiting
 * for it here would deadlock against ourselves.
 */
function applyPendingUpdate() {
  // Before anything overwrites it: this is the outcome of the *previous* run.
  previousInstall = readInstallResult();

  const pending = readPending();
  if (!pending) return false;

  if (!launchInstall(pending)) {
    // The installer has gone, or the scripts could not be written. Drop the
    // marker so a stale one cannot fire on every launch from here on, and start
    // normally rather than refusing to open.
    clearPending();
    return false;
  }

  clearPending();
  setTimeout(() => app.exit(0), 300);
  return true;
}

/**
 * Quit, having first started the install if one is staged.
 *
 * This is the half that was missing. Staging only writes a marker, and a marker
 * is consumed on the *next* launch - so a plain quit closed the app and left
 * nothing scheduled to reopen it. The user saw a promise that the app "will
 * close and reopen by itself", and then had to notice it was gone and open it
 * again by hand for anything to happen at all. The status window never appeared
 * either, because the script that opens it was never written until that manual
 * relaunch.
 *
 * So the quit starts the install first, through the same launchInstall() the
 * next launch would have used. It is safe to do this while still running: the
 * script sleeps before invoking the installer, and this process exits
 * immediately afterwards, so the executable is free by the time the installer
 * needs to replace it.
 *
 * Returns true when the install was handed off; false when there was nothing
 * staged, which is an ordinary quit.
 */
function quitAndInstall({ spawnProcess = spawn } = {}) {
  const pending = readPending();
  if (pending && launchInstall(pending, { spawnProcess })) {
    clearPending();
    setTimeout(() => app.exit(0), 300);
    return true;
  }

  setTimeout(() => app.quit(), 150);
  return false;
}

/**
 * Is a pending install staged but not yet applied?
 *
 * Reported so the UI can say "restart to finish updating" instead of letting
 * the user quit and find nothing changed.
 */
function pendingStatus() {
  const pending = readPending();
  return {
    staged: Boolean(pending),
    stagedAt: (pending && pending.stagedAt) || null,
    lastInstall: previousInstall,
  };
}

module.exports = {
  REPO,
  RELEASES_URL: `https://github.com/${REPO}/releases`,
  compareVersions,
  pickInstallerAsset,
  isNewerRelease,
  installScript,
  statusWindowScript,
  checkForUpdate,
  downloadAsset,
  stageUpdate,
  applyPendingUpdate,
  quitAndInstall,
  pendingStatus,
};