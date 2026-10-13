'use strict';

/**
 * App updates, from the GitHub releases this repo publishes.
 *
 * The shape of it mirrors `tools/install-update.js`, which already installs a
 * freshly built setup.exe over the running copy from the command line. That
 * script can close the app because it is a separate process doing it. The app
 * cannot: this code runs *inside* the process whose files the installer is
 * about to replace. So the install is split across the process boundary, and
 * the other side of it is a small WinForms program (tools/update-helper):
 *
 *   1. main process asks GitHub for the newest release
 *   2. renderer prompts, and on accept streams the asset to disk, reporting
 *      progress as it goes
 *   3. the file is stashed in userData with a marker naming the exe to relaunch
 *   4. the quit that follows hands the install to the helper and exits
 *   5. the helper shows a window, waits for this process to be gone and its
 *      files to be free, runs the installer silently, records the result, and
 *      starts the app again
 *
 * The helper is a program rather than a batch file, and that is the whole
 * reason it exists in this language. It is built as a WinExe, so Windows never
 * allocates a console for it: no window can flash at any point in an update,
 * because there is no console anywhere in the path. A batch file can only be
 * handed a console and told what to draw in it.
 *
 * Step 4 has to hand over rather than simply quit, because step 3 only writes a
 * marker and a marker is consumed on the next launch. Quitting on its own
 * therefore ends the update: the app closes and nothing reopens it, and the user
 * has to open it by hand for the install to happen at all. The launch-time apply
 * below still exists, for a machine that was shut down rather than quit between
 * staging and installing - both go through launchInstall().
 *
 * The helper is detached and unref'd, because this process is about to exit and
 * a child still holding the event loop open prevents that. It must not be
 * awaited either: the installer cannot replace the running executable, so
 * waiting here would deadlock against our own still-running process. The helper
 * resolves that by waiting for us first.
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

/** How the last install went, written by the handoff helper when it finishes. */
const INSTALL_RESULT_FILE = 'update-result.txt';

/**
 * The program that takes the install from here.
 *
 * A small WinForms app (tools/update-helper) rather than a batch file, and the
 * difference is not a matter of taste. It is built as a WinExe, so it links
 * against the Windows GUI subsystem and Windows never allocates a console for
 * it: there is no black rectangle, because there is no console to flash. A
 * batch file has no such option - it can only be given a console and told to
 * draw something in it, which is precisely the thing being removed.
 *
 * It owns the whole handoff: waiting for this process to go, running the
 * installer, recording the result, and starting the app again.
 */
const HELPER_EXE = 'BetterBeeper.UpdateHelper.exe';

const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Where the helper lives.
 *
 * extraResources puts it beside the asar in a packaged build. Unpacked - a dev
 * run, or the check suite - it is read from the repository's build directory,
 * which is where `dotnet publish` writes it.
 */
function helperPath() {
  const packaged = path.join(process.resourcesPath || '', 'update-helper', HELPER_EXE);
  if (app.isPackaged) return packaged;
  return path.join(app.getAppPath(), 'build', 'update-helper', HELPER_EXE);
}

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
 * Hand the install to the handoff helper and let it take it from there.
 *
 * The one place either entry point goes through. There used to be exactly one
 * entry point - the next launch - and the quit after a staged download was not
 * wired to it, so the app closed and nothing came back. Two callers reaching
 * for one function is the fix; two copies of this function is the bug that
 * produced it.
 *
 * Everything after this point is the helper's: the window, the wait for this
 * process to go, the installer, the relaunch. There is no script written here
 * and nothing to go wrong in a shell.
 *
 * Returns true when something was actually launched.
 *
 * `spawnProcess` is a seam for the check. This function's whole job is to hand
 * 90 MB of installer to another process, which is exactly the thing a test
 * must not really do; and a stubbed boundary that records the call is enough,
 * because what is being verified is *that it was launched, and with what*.
 */
function launchInstall(pending, { spawnProcess = spawn, helper = helperPath(), parentPid = process.pid } = {}) {
  const installer = pending && pending.installer;
  if (!installer || !fs.existsSync(installer)) return false;
  if (!fs.existsSync(helper)) return false;

  const relaunch = (pending && pending.relaunch) || process.execPath;
  const result = path.join(app.getPath('userData'), INSTALL_RESULT_FILE);

  const args = [
    '--installer', installer,
    '--relaunch', relaunch,
    '--result', result,
    '--pid', String(parentPid),
  ];

  try {
    const child = spawnProcess(helper, args, {
      detached: true,
      stdio: 'ignore',
      // Nothing to hide. The helper has no console to hide, and asking the
      // shell to be hidden here is what used to mean "a console may appear".
      windowsHide: true,
    });
    child.unref();
  } catch {
    // Could not start the install. There is nothing useful to do from inside
    // the process that was supposed to be replaced, and throwing here would
    // block the app from starting at all.
    return false;
  }

  return true;
}

/**
 * Run a pending install, then exit.
 *
 * Called from main.js before the window exists. The install is handed to the
 * detached helper and this process exits immediately: the installer needs to
 * replace a running executable, so waiting for it here would deadlock against
 * ourselves. The helper waits for this process to actually be gone before it
 * starts, which is what makes quitting first safe.
 */
function applyPendingUpdate(deps) {
  // Before anything overwrites it: this is the outcome of the *previous* run.
  previousInstall = readInstallResult();

  const pending = readPending();
  if (!pending) return false;

  if (!launchInstall(pending, deps)) {
    // The installer or the helper has gone. Drop the marker so a stale one
    // cannot fire on every launch from here on, and start normally rather than
    // refusing to open.
    clearPending();
    return false;
  }

  clearPending();
  setTimeout(() => app.exit(0), 300);
  return true;
}

/**
 * Quit, having first handed the install over if one is staged.
 *
 * This is the half that was missing. Staging only writes a marker, and a marker
 * is consumed on the *next* launch - so a plain quit closed the app and left
 * nothing scheduled to reopen it. The user saw a promise that the app "will
 * close and reopen by itself", and then had to notice it was gone and open it
 * again by hand for anything to happen at all. The status window never appeared
 * either, because the script that opens it was never written until that manual
 * relaunch.
 *
 * So the quit hands the install over first, through the same launchInstall() the
 * next launch would have used. It is safe to do this while still running: the
 * helper waits for this process to be gone, and for its files to be free, before
 * it invokes the installer.
 *
 * Returns true when the install was handed off; false when there was nothing
 * staged, which is an ordinary quit.
 */
function quitAndInstall(deps) {
  const pending = readPending();
  if (pending && launchInstall(pending, deps)) {
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
  checkForUpdate,
  downloadAsset,
  stageUpdate,
  applyPendingUpdate,
  quitAndInstall,
  pendingStatus,
  helperPath,
  HELPER_EXE,
};