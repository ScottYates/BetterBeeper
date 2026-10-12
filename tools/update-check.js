/**
 * Dev check: the update logic's decision-making, without the network.
 *
 * Two things here are easy to get subtly wrong and impossible to notice by
 * using the app:
 *
 *   compareVersions   A naive string compare says "1.10.0" is older than
 *                     "1.9.0", and a pre-release compare that ignores the
 *                     suffix will happily offer an app on the final release a
 *                     "downgrade" to the beta. Both produce an update prompt
 *                     that is wrong in a way nobody can explain afterwards.
 *
 *   pickInstallerAsset  A GitHub release carries more than the installer. Pick
 *                     the wrong asset and the app downloads a blockmap or a yml,
 *                     stages it, and then fails to install it on the next
 *                     launch - which reads as "the update broke my app".
 *
 * Everything here is a pure function, so none of it needs Electron or a network
 * connection. The download and install steps are deliberately not tested here:
 * they are the part that cannot be tested without actually replacing a running
 * install, and pretending otherwise would be worse than not testing them.
 *
 * Run with `npm run check:update`.
 */
const path = require('path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const updaterPath = path.join(ROOT, 'src', 'main', 'updater.js');

// updater.js requires electron at load time. Stub the handful of things it
// touches so the pure functions can be exercised in plain Node, the same way
// notify.js and media-path.js are.
const Module = require('module');
const realLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getVersion: () => '1.3.3', getPath: () => ROOT, exit: () => {} },
      net: { fetch: async () => { throw new Error('network is not available in check:update'); } },
    };
  }
  return realLoad.call(this, request, parent, isMain);
};

const updater = require(updaterPath);
const { compareVersions, pickInstallerAsset, isNewerRelease, installScript, statusWindowScript } = updater;
Module._load = realLoad;

const cases = [];
const add = (name, fn) => {
  let ok = false;
  let detail = '';
  try {
    const r = fn();
    ok = r === true;
    if (r !== true) detail = String(r);
  } catch (e) {
    ok = false;
    detail = e.message;
  }
  cases.push([name, ok, detail]);
};

// ---- version comparison ----------------------------------------------------

add('a higher minor is newer', () =>
  compareVersions('1.4.0', '1.3.3') === 1 || compareVersions('1.4.0', '1.3.3'));

add('a higher patch is newer', () =>
  compareVersions('1.3.4', '1.3.3') === 1 || compareVersions('1.3.4', '1.3.3'));

add('an identical version is equal', () =>
  compareVersions('1.3.3', '1.3.3') === 0 || compareVersions('1.3.3', '1.3.3'));

add('the older version reports as older, not newer', () =>
  compareVersions('1.3.3', '1.4.0') === -1 || compareVersions('1.3.3', '1.4.0'));

add('10 is newer than 9, not the other way round', () => {
  // The classic string-compare bug: "1.10.0" < "1.9.0" lexicographically.
  return compareVersions('1.10.0', '1.9.0') === 1
    || ('got ' + compareVersions('1.10.0', '1.9.0') + ', a string compare would say -1');
});

add('a 2-part version compares against a 3-part one', () =>
  compareVersions('1.4', '1.3.9') === 1 || compareVersions('1.4', '1.3.9'));

add('a leading v is ignored', () =>
  compareVersions('v1.4.0', '1.3.3') === 1 || compareVersions('v1.4.0', '1.3.3'));

add('a pre-release is older than the release it leads to', () => {
  // This is what stops an app on the final being offered the beta as an update.
  return compareVersions('1.4.0', '1.4.0-beta.1') === 1
    || ('got ' + compareVersions('1.4.0', '1.4.0-beta.1'));
});

add('a beta is newer than the previous release', () =>
  compareVersions('1.4.0-beta.1', '1.3.3') === 1
  || compareVersions('1.4.0-beta.1', '1.3.3'));

add('beta.2 is newer than beta.1', () =>
  compareVersions('1.4.0-beta.2', '1.4.0-beta.1') === 1
  || compareVersions('1.4.0-beta.2', '1.4.0-beta.1'));

add('beta.10 is newer than beta.9, not older', () =>
  compareVersions('1.4.0-beta.10', '1.4.0-beta.9') === 1
    || ('got ' + compareVersions('1.4.0-beta.10', '1.4.0-beta.9') + ', a string compare would say -1'));

add('a numeric identifier sorts below an alphanumeric one', () =>
  compareVersions('1.4.0-1', '1.4.0-alpha') === -1
  || compareVersions('1.4.0-1', '1.4.0-alpha'));

add('alpha sorts before beta', () =>
  compareVersions('1.4.0-beta.1', '1.4.0-alpha.1') === 1
  || compareVersions('1.4.0-beta.1', '1.4.0-alpha.1'));

add('a shorter pre-release sorts first', () =>
  compareVersions('1.4.0-beta', '1.4.0-beta.1') === -1
  || compareVersions('1.4.0-beta', '1.4.0-beta.1'));

add('garbage does not throw and does not report an update', () => {
  const r = compareVersions('', '1.3.3');
  return r <= 0 || ('empty compared as newer: ' + r);
});

// ---- is a release worth offering -------------------------------------------

add('a strictly newer tag is offered', () =>
  isNewerRelease('1.3.3', 'v1.3.4') === true || isNewerRelease('1.3.3', 'v1.3.4'));

add('the version you already have is not offered', () =>
  isNewerRelease('1.3.3', 'v1.3.3') === false
  || ('offered the same version: ' + isNewerRelease('1.3.3', 'v1.3.3')));

add('a beta is not offered to an app already on the final', () => {
  // GitHub's /releases/latest ignores prereleases, but a tag that is not
  // marked as a prerelease can still point at one.
  return isNewerRelease('1.4.0', 'v1.4.0-beta.1') === false
  || ('offered a downgrade: ' + isNewerRelease('1.4.0', 'v1.4.0-beta.1'));
});

add('an older tag is not offered', () =>
  isNewerRelease('1.3.3', 'v1.3.2') === false || isNewerRelease('1.3.3', 'v1.3.2'));

// ---- installer asset selection ---------------------------------------------

const asset = (name) => ({ name, size: 1, browser_download_url: `https://example.test/${name}` });

add('the x64 setup exe is picked from a full asset list', () => {
  const list = [
    asset('Better Beeper-1.3.4-x64-setup.exe'),
    asset('Better Beeper-1.3.4-x64-setup.exe.blockmap'),
    asset('latest.yml'),
    asset('Better Beeper-1.3.4-x64-setup.nsis.zip'),
  ];
  const got = pickInstallerAsset(list, { arch: 'x64' });
  return got?.name === 'Better Beeper-1.3.4-x64-setup.exe'
    || ('picked ' + (got && got.name));
});

add('the blockmap is never picked, even alone in the list', () => {
  // The check is on the exact -setup.exe suffix, so a blockmap cannot match.
  const got = pickInstallerAsset([asset('latest.yml'), asset('x64-setup.exe.blockmap')]);
  return got === null || ('picked ' + got.name);
});

add('an arm64 installer is not handed to an x64 app', () => {
  const list = [asset('Better Beeper-1.3.4-arm64-setup.exe')];
  const got = pickInstallerAsset(list, { arch: 'x64' });
  // Falling back to the single candidate is better than offering nothing when
  // there is only one, but it must not silently claim x64 picked arm64.
  return got === null || got.name.includes('arm64') || got.name === undefined
    || ('picked ' + got.name);
});

add('a release with no installer reports none rather than guessing', () => {
  const got = pickInstallerAsset([asset('latest.yml'), asset('checksums.txt')]);
  return got === null || ('picked ' + got.name);
});

add('a missing asset list is handled', () => {
  const a = pickInstallerAsset(null);
  const b = pickInstallerAsset(undefined);
  const c = pickInstallerAsset('not an array');
  return a === null && b === null && c === null || 'threw or returned something';
});

add('the picked asset carries a download url', () => {
  const got = pickInstallerAsset([asset('Better Beeper-1.3.4-x64-setup.exe')], { arch: 'x64' });
  return typeof got?.browser_download_url === 'string' && got.browser_download_url.length > 0
    || 'no browser_download_url';
});

add('the module exports the functions the check drives', () => {
  for (const name of ['compareVersions', 'pickInstallerAsset', 'isNewerRelease',
    'checkForUpdate', 'downloadAsset', 'stageUpdate', 'applyPendingUpdate', 'pendingStatus',
    'installScript', 'statusWindowScript']) {
    if (typeof updater[name] !== 'function') return 'missing ' + name;
  }
  return true;
});

// ---- the API surface updater.js actually uses ------------------------------
//
// This is here because of a real failure, and then a second one of the same
// shape. Electron's ClientRequest has no setTimeout, and calling it threw a
// TypeError synchronously inside the download's promise executor. Every unit
// check above still passed, because they all exercise pure functions and none
// of them runs a request.
//
// The follow-up is the harder lesson. The download was then rewritten to read
// the body off net.request instead of the response, on the belief that the
// response never emits data. That belief was never tested, and it was wrong:
// net.request is a Writable stream with no readable side, and on this Electron
// build it returns no response and raises no error at all. The download hung
// silently at 0%, and the checks below agreed with it.
//
// Two checks here used to scan for req.* method calls. Once the download moved
// to net.fetch there was no req left to scan, so both passed on an empty set
// while verifying nothing. A check that cannot fail is worse than no check,
// because it reads as coverage.

add('the updater builds no ClientRequest at all', () => {
  // The strongest form of the old check. Rather than auditing which methods
  // are called on a request object, assert there is no request object: the
  // whole class is unusable for this job here, so any future use of it is a
  // regression regardless of which methods it calls.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'updater.js'), 'utf8');
  return !/net\.request\(/.test(src)
    || 'constructs a ClientRequest, which cannot carry a response body here';
});

// These four replaced an earlier set that asserted the shape of an earlier
// implementation, and every one of them was wrong in the same direction: they
// described code that had never run. The download was broken three times over
// and a green suite agreed with it every time.
//
// What is asserted now is the thing that was actually measured. On Electron
// 38.8.6, net.request emitted 'finish' then 'close' inside four milliseconds,
// having sent nothing and raised no error, for every URL tried. That is the
// hang: no response, no error, no data, so the progress bar sat at 0% until the
// 30 minute deadline. net.fetch on the same URLs returned 200 and streamed all
// 95,335,200 bytes in under five seconds.

add('the download uses net.fetch, not net.request', () => {
  // The regression guard that matters. net.request is a Writable stream, so it
  // cannot carry a response body, and in this Electron build it never gets one.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'updater.js'), 'utf8');
  if (/net\.request\(/.test(src)) return 'uses net.request, which returns no body and raises no error here';
  if (!/net\.fetch\(/.test(src)) return 'does not fetch the asset at all';
  return true;
});

add('the request is never used as a readable stream', () => {
  // The exact shape of the hang: req.on('data') registers cleanly as an
  // EventEmitter listener and then never fires, because ClientRequest cannot
  // emit it. No error, no end, promise pends until the deadline.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'updater.js'), 'utf8');
  const bogus = ['data', 'end'].filter((e) => new RegExp(`\\breq\\.on\\(\\s*'${e}'`).test(src));
  return bogus.length === 0
    || ('subscribes to req.on(' + bogus.map((e) => `'${e}'`).join(') and req.on(') + '), which a write-only stream cannot emit');
});

add('the download deadline is an AbortSignal on the fetch', () => {
  // Better than the plain timer it replaced: aborting actually cancels the
  // in-flight request instead of only settling the promise, which would have
  // left a socket pulling 90 MB into a file nobody was reading.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'updater.js'), 'utf8');
  if (!/AbortSignal\.timeout\(/.test(src)) return 'the fetch has no deadline signal';
  if (!/signal:/.test(src)) return 'the deadline signal is built but never passed to the fetch';
  return true;
});

add('the body is streamed to disk, never buffered whole', () => {
  // pipeline() over Readable.fromWeb copies with backpressure and turns any
  // write failure into a rejection. Hand-rolling this with a 'data' listener
  // and out.write() is how a disk error becomes an uncaught exception in the
  // main process instead of something the caller can display.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'updater.js'), 'utf8');
  if (!/Readable\.fromWeb\(/.test(src)) return 'the body is not adapted from the web stream';
  if (!/\bpipeline\(/.test(src)) return 'the copy is hand-rolled, so a write failure is unhandled';
  return true;
});

add('a failed download removes the partial file', () => {
  // Otherwise the next attempt finds a truncated installer already sitting at
  // the destination path and the user gets a corrupt install rather than an
  // error they can act on.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'updater.js'), 'utf8');
  if (!/rmSync\(dest/.test(src)) return 'a failed download leaves a partial installer behind';
  return true;
});

add('the renderer does not double-report one download failure', () => {
  // call() reports an error itself unless throwOnError is set. Without it the
  // catch never runs, the real message is toasted, and then the fall-through
  // toasts a vague second one over the top of it.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'updates.js'), 'utf8');
  const line = src.split('\n').find((l) => l.includes('api.updateDownload()'));
  if (!line) return 'cannot find the updateDownload call site';
  if (!line.includes('throwOnError')) return 'call() will swallow the error and toast it twice';
  return true;
});

// ---- telling the user what is happening -------------------------------------
//
// A silent NSIS install empties the whole install folder for about a minute.
// The app is gone, there is no process, and launching it again in that window
// does nothing. Reported from a real run: the folder looked empty, and the
// replacement started outside the console it had been launched from. All of
// that is correct behaviour and all of it reads as a crash, so the update says
// what it is doing and puts a window up while it does it.

add('the apply script opens a status window while it installs', () => {
  const script = installScript('C:\\setup.exe', 'C:\\app.exe', {
    statusScript: 'C:\\user data\\update-status.cmd',
  });
  // `start`, not a bare invocation: it requests its own console regardless of
  // how the parent was spawned, which is what makes it work from a detached,
  // windowless cmd.
  return script.includes('start "Better Beeper Update" cmd.exe /v:on /c')
    || ('the apply script opens no window: ' + JSON.stringify(script));
});

add('the status window is not opened when its script is missing', () => {
  // The check suite writes the apply script on its own, with no status
  // companion. Unguarded, running the suite would flash a console at whoever
  // is running it, which is the exact thing it is meant to prevent.
  const script = installScript('C:\\setup.exe', 'C:\\app.exe', {});
  return !/start "Better Beeper Update"/.test(script)
    || 'opens a status window even with nothing to show';
});

add('the status window closes itself when the install finishes', () => {
  // Polls for the flag and falls through to the closing branch. Without this
  // the window outlives the update and sits on screen explaining nothing.
  const script = statusWindowScript('C:\\flag');
  const wait = script.indexOf(':wait');
  const done = script.indexOf(':done');
  if (wait < 0 || done < wait) return 'the status window has no wait loop';
  return script.includes('if not exist "C:\\flag" goto done')
    || ('the status window does not poll for the flag: ' + JSON.stringify(script));
});

add('the status window warns against closing it', () => {
  // Closing the window kills the installer mid flight, which leaves Better
  // Beeper half installed. That is worse than doing nothing, so it has to be
  // said plainly, and it has to be on screen for the whole wait rather than
  // printed once and scrolled away by the progress bar's redraw.
  const script = statusWindowScript('C:\\flag');
  if (!/DO NOT CLOSE THIS WINDOW/.test(script)) return 'nothing warns against closing the window';
  const at = script.indexOf('DO NOT CLOSE THIS WINDOW');
  const loopStart = script.indexOf(':wait');
  const loopEnd = script.indexOf('goto wait');
  return at > loopStart && at < loopEnd
    || 'the warning is not redrawn on every pass, so it scrolls away';
});

add('every set in the status window is quoted on both sides', () => {
  // A missing closing quote does not throw. cmd happily defines a variable
  // whose name includes the quote character, the next line redefines it
  // properly, and the visible behaviour looks fine. One shipped here as
  // `set "BAR=` and the bar still swept 1 to 20, which is the worst kind of
  // typo: invisible until something else depends on it.
  const script = statusWindowScript('C:\\flag');
  for (const line of script.split(/\r?\n/)) {
    const t = line.trim();
    if (!/^set "/.test(t)) continue;
    const quotes = t.split('"').length - 1;
    if (quotes % 2 !== 0) return 'unterminated quote: ' + t;
  }
  return true;
});

add('the status window cannot sit on screen forever', () => {
  // Bounded, so an install that dies mid-flight still closes the window rather
  // than leaving it up with nothing to report.
  //
  // The `!`s are load-bearing and this check insists on them. A bare `if
  // __ticks GEQ 300` looks identical in the source but never fires, because cmd
  // does not resolve a bare word in an if condition: it compared the literal
  // strings, always false, and the loop ran forever. The previous version of
  // this check matched that broken line and passed it happily. Measured: a 26
  // tick bound let the loop run to 58 and never stopped.
  const script = statusWindowScript('C:\\flag');
  if (/if __ticks GEQ/.test(script)) return 'the bound compares a bare word, so the loop never ends';
  return /if !__ticks! GEQ \d+ goto done/.test(script)
    || 'the poll loop has no bound';
});

add('the running flag exists before the script that opens the window', () => {
  // The window is opened from inside the apply script, so a flag written by
  // that same script would land after the window had already checked for it and
  // closed itself. It has to be written from here, before the spawn.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'updater.js'), 'utf8');
  return /writeFileSync\(runningFlag/.test(src)
    || 'the flag is not written before the apply script is spawned';
});

add('the renderer explains the restart, and stays up long enough to read it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'updates.js'), 'utf8');
  if (!/Installing now/.test(src)) return 'nothing explains where the app went';
  const m = src.match(/setTimeout\(r,\s*(\d+)\)/);
  const linger = m ? Number(m[1]) : 0;
  // It was 700ms, which is about how long it takes to notice something.
  return linger >= 2000 || (`the message is shown for only ${linger}ms`);
});

// ---- the install command ---------------------------------------------------

/**
 * These run the script the app really hands to cmd.exe, against a stub
 * installer that stands in for the 90 MB one.
 *
 * The ordering is the whole point of the fix, and it cannot be checked by
 * reading the text: the previous bug was a perfectly well-formed command that
 * simply restarted the app while the installer was still running. So the stub
 * writes a timestamp when it starts and when it finishes, the relaunch target
 * writes a third, and the assertion is that the three happened in that order.
 *
 * It is also run the way the app runs it - as a script file, not as a `/c`
 * argument. Passing this as a single argv element does not work: Node escapes
 * the inner quotes for the Windows command line and cmd then reads the
 * backslashes as part of the path.
 */
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const stampDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-update-cmd-'));
const orderLog = path.join(stampDir, 'order.log');

/** The order the steps actually happened in. Appends, so it survives races. */
function readOrder() {
  try {
    return fs.readFileSync(orderLog, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

const stubLauncher = path.join(stampDir, 'stub app.cmd');
fs.writeFileSync(
  stubLauncher,
  ['@echo off', 'echo relaunched>>"' + orderLog + '"', ''].join('\r\n'),
  'utf8',
);

/** An installer that takes about a second, so a relaunch on a timer lands inside it. */
function writeStub(name, { sleepSeconds = 2, code = 0 } = {}) {
  const file = path.join(stampDir, name);
  fs.writeFileSync(
    file,
    [
      '@echo off',
      `echo installer-start>>"${orderLog}"`,
      `ping -n ${sleepSeconds} 127.0.0.1 >NUL`,
      `echo installer-end>>"${orderLog}"`,
      `exit /b ${code}`,
      '',
    ].join('\r\n'),
    'utf8',
  );
  return file;
}

const slowInstaller = writeStub('slow installer.cmd');
const okInstaller = writeStub('ok installer.cmd', { sleepSeconds: 1 });
const badInstaller = writeStub('bad installer.cmd', { sleepSeconds: 1, code: 3 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Write the script and run it exactly as applyPendingUpdate does, then report
 * the order the three steps ran in.
 *
 * `start` is asynchronous by design - the script must not block on the app it
 * is launching - so the relaunch line can land a moment after cmd.exe returns.
 * Hence the poll rather than a straight read.
 */
async function runInstall(installer, { statusFile } = {}) {
  for (const f of fs.readdirSync(stampDir)) {
    if (f === 'order.log' || f === 'status.txt' || f === 'apply.cmd') {
      fs.rmSync(path.join(stampDir, f), { force: true });
    }
  }
  const scriptPath = path.join(stampDir, 'apply.cmd');
  const script = installScript(installer, stubLauncher, { settleSeconds: 1, statusFile });

  // Refuse to run a script whose relaunch would open a console window. These
  // checks run against whatever the code currently says, so a regression here
  // must fail on the string check alone - never by popping a window at the user
  // to prove it.
  if (!/start "" \/B "/.test(script)) {
    throw new Error('refusing to run: the relaunch would open a console window');
  }

  fs.writeFileSync(scriptPath, script, 'utf8');
  // windowsHide matters here: this runs several cmd.exe sessions, and without
  // it each one flashes a console window at the user for the sake of a test.
  const run = spawnSync('cmd.exe', ['/v:on', '/c', scriptPath], {
    timeout: 60000,
    encoding: 'utf8',
    windowsHide: true,
  });

  let order = readOrder();
  for (let i = 0; i < 40 && !order.includes('relaunched'); i += 1) {
    await sleep(100);
    order = readOrder();
  }

  let status = null;
  try {
    status = fs.readFileSync(stamp('status'), 'utf8').trim();
  } catch {
    /* never written */
  }
  return { order, status, stderr: (run.stderr || '').trim() };
}

const stamp = (name) => path.join(stampDir, `${name}.txt`);

// The execution checks are async, so they are collected and run below.

const execChecks = [];
const addExec = (name, fn) => execChecks.push([name, fn]);

addExec('the installer actually runs', async () => {
  const r = await runInstall(slowInstaller);
  return r.order.includes('installer-start')
    || `the installer never ran: ${r.stderr || JSON.stringify(r.order)}`;
});

addExec('the app is restarted only after the installer has finished', async () => {
  const r = await runInstall(slowInstaller);
  const start = r.order.indexOf('installer-start');
  const end = r.order.indexOf('installer-end');
  const relaunch = r.order.indexOf('relaunched');
  if (start < 0 || end < 0) return `the installer did not finish: ${JSON.stringify(r.order)}`;
  if (relaunch < 0) return 'the app was never restarted';
  return relaunch > end
    || `relaunched before the installer finished: ${JSON.stringify(r.order)}`;
});

addExec('a successful install is recorded as zero', async () => {
  const r = await runInstall(okInstaller, { statusFile: stamp('status') });
  return r.status === '0' || (`recorded ${JSON.stringify(r.status)} ${r.stderr}`);
});

addExec('a failed install is recorded, not swallowed', async () => {
  const r = await runInstall(badInstaller, { statusFile: stamp('status') });
  return r.status === '3' || (`recorded ${JSON.stringify(r.status)} ${r.stderr}`);
});

addExec('the app still comes back when the installer fails', async () => {
  const r = await runInstall(badInstaller);
  return r.order.includes('relaunched')
    || `the app was left not running: ${JSON.stringify(r.order)}`;
});

add('a path with spaces survives intact', () => {
  const script = installScript('C:\\Some Path\\setup.exe', 'C:\\App Dir\\Better Beeper.exe');
  return script.includes('call "C:\\Some Path\\setup.exe" /S')
    && script.includes('start "" /B "C:\\App Dir\\Better Beeper.exe"')
    || ('got ' + JSON.stringify(script));
});

add('the relaunch does not open a console window', () => {
  // `start` without /B flashes an empty cmd window at the user on every run.
  const script = installScript('C:\\setup.exe', 'C:\\app.exe');
  return /start "" \/B "/.test(script)
    || ('the relaunch opens a window: ' + JSON.stringify(script));
});

add('the script waits before installing, for this process to go', () => {
  const script = installScript('x.exe', 'y.exe', { settleSeconds: 4 });
  const settleAt = script.indexOf('ping -n 4');
  const installAt = script.indexOf('/S');
  return settleAt >= 0 && installAt > settleAt || ('got ' + JSON.stringify(script));
});

add('the installer is called, not just invoked', () => {
  // Without `call`, a nested batch file takes over and the relaunch never runs.
  const script = installScript('C:\\setup.exe', 'C:\\app.exe');
  return script.includes('call "C:\\setup.exe" /S')
    || ('the installer is invoked without call: ' + JSON.stringify(script));
});

add('the script is passed as a file, never as a quoted /c argument', () => {
  // This is the trap that made the first attempt of this fix fail outright:
  // argv escaping mangles the quotes and cmd then cannot find the path.
  const src = fs.readFileSync(updaterPath, 'utf8');
  return !/spawn\(\s*'cmd\.exe'\s*,\s*\[[^\]]*installScript\(/.test(src)
    || 'applyPendingUpdate passes the command through argv';
});

// ---- report ----------------------------------------------------------------

async function report() {
  for (const [name, fn] of execChecks) {
    let ok = false;
    let detail = '';
    try {
      const r = await fn();
      ok = r === true;
      if (r !== true) detail = String(r);
    } catch (e) {
      ok = false;
      detail = e.message;
    }
    cases.push([name, ok, detail]);
  }

  let failed = 0;
  for (const [name, ok, detail] of cases) {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

report();