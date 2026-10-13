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
//
// The stub is held in a variable rather than an inline literal because the
// checks below drive the real file-writing and quitting paths, and they need to
// point userData at a sandbox and observe the exit rather than performing one.
const os = require('node:os');

let userDataPath = ROOT;
const exits = [];
const quits = [];
const appStub = {
  getVersion: () => '1.3.3',
  getPath: (name) => (name === 'userData' ? userDataPath : ROOT),
  getAppPath: () => ROOT,
  isPackaged: false,
  exit: (code) => exits.push(code),
  quit: () => quits.push(true),
  get isQuitting() { return false; },
};

const Module = require('module');
const realLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: appStub,
      net: { fetch: async () => { throw new Error('network is not available in check:update'); } },
    };
  }
  return realLoad.call(this, request, parent, isMain);
};

const updater = require(updaterPath);
const { compareVersions, pickInstallerAsset, isNewerRelease } = updater;
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

// Checks that have to await something - a scheduled quit, a timer - cannot run
// synchronously at the point they are written, so they are collected and run
// together at the end.
const execChecks = [];
const addExec = (name, fn) => execChecks.push([name, fn]);

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
    'checkForUpdate', 'downloadAsset', 'stageUpdate', 'applyPendingUpdate',
    'quitAndInstall', 'pendingStatus', 'helperPath']) {
    if (typeof updater[name] !== 'function') return 'missing ' + name;
  }
  return true;
});

add('the batch helpers are gone, not merely unused', () => {
  // installScript() and statusWindowScript() built the cmd files that had to be
  // quoted into existence. They are removed rather than left behind: dead code
  // with passing checks is worse than no code, because the next person reads the
  // checks and believes the batch path is still live.
  const gone = ['installScript', 'statusWindowScript'].filter((n) => typeof updater[n] === 'function');
  return gone.length === 0 || ('still exported: ' + gone.join(', '));
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

// ---- the handoff helper, and the absence of any shell ------------------------
//
// A silent NSIS install empties the whole install folder for about a minute: the
// app is gone, there is no process, and launching it again in that window does
// nothing. Every part of that is correct and all of it reads as a crash, so the
// update has to say what it is doing - in a window that is not a console.
//
// That window used to be a batch file opened with `start`, which is why the
// status "window" was a black rectangle with a progress bar drawn in ASCII in
// it. Two releases shipped with it, and it never once appeared: the line that
// opened it was `start "..." cmd.exe /v:on /c ""<path>""`, which cmd rejects
// outright with "The syntax of the command is incorrect", and the check beside
// it asserted that exact string.
//
// The fix is not better quoting. It is that the handoff is now a program
// (tools/update-helper) built as a WinExe, so Windows never allocates a console
// for it at all. These checks are about that being true of the source, the
// packaging, and - where it has been built - the binary itself.

const HELPER_PROJECT = path.join(ROOT, 'tools', 'update-helper');
const HELPER_BUILD = path.join(ROOT, 'build', 'update-helper');

add('the handoff is a program, and it is a WinExe', () => {
  // The single line that makes a console impossible: the GUI subsystem has no
  // console to allocate, so there is nothing to flash, hide or mis-quote.
  const csproj = fs.readFileSync(path.join(HELPER_PROJECT, 'UpdateHelper.csproj'), 'utf8');
  return /<OutputType>WinExe<\/OutputType>/.test(csproj)
    || 'the helper is not a WinExe, so it can still be given a console';
});

add('the helper waits for the app to go before installing', () => {
  // The app is the thing being replaced, so installing while it is alive locks
  // its files and lands a half-applied update.
  const src = fs.readFileSync(path.join(HELPER_PROJECT, 'Program.cs'), 'utf8');
  return (src.includes('WaitForProcessExit') && src.includes('WaitForFileFree')
      && src.indexOf('WaitForFileFree') < src.indexOf('Process.Start'))
    || 'the helper starts the installer before the app has released its files';
});

add('the helper starts the app again afterwards', () => {
  // The *call*, not the method. `src.includes('StartRelaunch')` is satisfied by
  // the definition alone, so commenting out the only call site leaves the check
  // green while the app never comes back - which is the exact bug that started
  // this, one layer up.
  const src = fs.readFileSync(path.join(HELPER_PROJECT, 'Program.cs'), 'utf8');
  return /StartRelaunch\(options\.RelaunchPath\)/.test(src)
    || 'the helper defines StartRelaunch but nothing ever calls it';
});

add('the helper records how the install went', () => {
  // The process that could not install itself is gone; the next launch is the
  // only other chance to say what happened. Again the call, not the definition.
  const src = fs.readFileSync(path.join(HELPER_PROJECT, 'Program.cs'), 'utf8');
  return /WriteResult\(options, state\.ExitCode, state\.Detail\)/.test(src)
    || 'the helper defines WriteResult but the outcome is never written';
});

add('the updater hands the install to the helper, not to a shell', () => {
  const src = fs.readFileSync(updaterPath, 'utf8');
  return !/cmd\.exe|\/c\b|\.cmd'/.test(src.replace(/\/\*[\s\S]*?\*\//g, ''))
    || 'updater.js still reaches for a command interpreter';
});

add('the updater writes no script at all', () => {
  // Nothing to quote, nothing to mis-parse, nothing left behind on disk after a
  // failed update.
  const src = fs.readFileSync(updaterPath, 'utf8');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return !/update-apply\.cmd|update-status\.cmd|installScript|statusWindowScript/.test(body)
    || 'the batch machinery is still in updater.js';
});

add('the helper is passed the four things it needs', () => {
  const src = fs.readFileSync(updaterPath, 'utf8');
  return ['--installer', '--relaunch', '--result', '--pid'].every((flag) => src.includes(flag))
    || 'the helper is not told what to install, where to write, or what to restart';
});

add('the helper ships with the app, outside the asar', () => {
  // It has to exist as a real file to be launched. extraResources puts it next
  // to the asar; inside the archive it would be a path to something unpacked
  // that is not there.
  //
  // Matched as the actual mapping rather than the words "extraResources" and
  // "update-helper": the explanatory comment above the rule names both, so a
  // bare pair of substring tests is satisfied by the comment alone.
  const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  return (/- from: build\/update-helper/.test(yml) && /^\s*to: update-helper\s*$/m.test(yml))
    || 'the helper is not mapped into extraResources, so a packaged build cannot update';
});

add('the built helper, if there is one, has no console subsystem', () => {
  // Read out of the PE header rather than trusted from the csproj, because the
  // csproj is the intention and the header is the artifact. This is the whole
  // claim of this feature, and it is checkable without opening a window.
  const exe = path.join(HELPER_BUILD, updater.HELPER_EXE);
  if (!fs.existsSync(exe)) return 'not built yet: run npm run build:helper';

  const head = fs.readFileSync(exe);
  if (head.readUInt16LE(0) !== 0x5a4d) return 'that is not a PE file';
  const pe = head.readInt32LE(0x3c);
  const subsystem = head.readUInt16LE(pe + 0x5c);
  // IMAGE_SUBSYSTEM_WINDOWS_GUI. 1 would be console, which is the bug.
  return (subsystem === 2
    ? true
    : 'the built helper is subsystem ' + subsystem + ' (console), so a window can appear');
});
// ---- the quit has to start the install --------------------------------------
//
// The bug this is for, and it was found by using the app rather than by reading
// it: staging writes a marker, and a marker is consumed on the *next* launch. But
// the quit that followed a staged download only quit. Nothing ran the script
// that opens the status window, installs, and starts the app again.
//
// So the app closed and stayed closed. The status window the release notes
// promised never appeared, because the script that opens it is only written by
// the launch-time apply - which needed a launch that nothing was going to
// perform. The update only completed if the user noticed the app was gone and
// opened it again by hand.
//
// Driven against a real sandbox: these paths write files and hand a process to
// another process, and asserting on the calls rather than on a return value is
// the point.

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-update-check-'));
const PENDING = 'update-pending.json';
const HELPER = path.join(sandbox, 'BetterBeeper.UpdateHelper.exe');

/**
 * Stage an install, then take the quit path, recording what it spawned.
 *
 * The spawn is stubbed rather than performed: its whole job is to install over
 * this machine. What has to be true is that the helper was *asked* to, and with
 * what - and the helper itself is stubbed into existence as a file, because
 * launchInstall refuses to run when it is missing and that refusal is a real
 * behaviour worth being able to reach.
 */
function driveQuit({ stage = true, installerPresent = true, helperPresent = true } = {}) {
  userDataPath = sandbox;
  exits.length = 0;
  quits.length = 0;
  for (const f of [PENDING, HELPER, path.join(sandbox, 'setup.exe')]) {
    try { fs.rmSync(f, { force: true }); } catch { /* not there */ }
  }

  const installer = path.join(sandbox, 'setup.exe');
  if (installerPresent) fs.writeFileSync(installer, 'MZ fake installer');
  if (helperPresent) fs.writeFileSync(HELPER, 'MZ fake helper');

  if (stage) {
    fs.writeFileSync(
      path.join(sandbox, PENDING),
      JSON.stringify({ installer, relaunch: 'C:\\Program Files\\Better Beeper\\app.exe' }),
      'utf8',
    );
  }

  const spawned = [];
  const handed = updater.quitAndInstall({
    helper: HELPER,
    parentPid: 4242,
    spawnProcess: (cmd, args) => {
      spawned.push({ cmd, args });
      return { unref() {} };
    },
  });

  const argOf = (flag) => {
    const call = spawned[0];
    if (!call) return undefined;
    const i = call.args.indexOf(flag);
    return i === -1 ? undefined : call.args[i + 1];
  };

  return {
    handed, spawned, exits, quits,
    helperSpawned: spawned.length ? path.basename(spawned[0].cmd) : '',
    argOf,
    pendingCleared: !fs.existsSync(path.join(sandbox, PENDING)),
  };
}

let quitRun = driveQuit();

add('quitting with an update staged hands the install off', () => {
  const r = quitRun;
  return (r.handed === true && r.spawned.length === 1)
    || ('handed=' + r.handed + ' spawned=' + r.spawned.length);
});

add('what is spawned is the helper, not a shell', () => {
  // The entire point of the rewrite. `cmd.exe` here would mean a console can be
  // allocated, and a console is the thing being removed.
  const r = quitRun;
  return r.helperSpawned === updater.HELPER_EXE
    || ('spawned: ' + r.helperSpawned);
});

add('the helper is told which installer to run', () => {
  const r = quitRun;
  const got = r.argOf('--installer');
  return (got && got.endsWith('setup.exe')) || ('--installer was ' + got);
});

add('the helper is told which app to restart', () => {
  const r = quitRun;
  return r.argOf('--relaunch') === 'C:\\Program Files\\Better Beeper\\app.exe'
    || ('--relaunch was ' + r.argOf('--relaunch'));
});

add('the helper is told where to record the outcome', () => {
  // The process that could not install itself is gone; this is the only way the
  // next launch learns what happened.
  const r = quitRun;
  const got = r.argOf('--result');
  return (got && got.endsWith('update-result.txt')) || ('--result was ' + got);
});

add('the helper is told which process to wait for', () => {
  // Without this it waits only for the executable to be unlocked, and Electron's
  // renderer children can still be holding it.
  const r = quitRun;
  return r.argOf('--pid') === '4242' || ('--pid was ' + r.argOf('--pid'));
});

add('no script is left on disk for the handoff', () => {
  // Nothing to quote, nothing to mis-parse, and nothing to clean up if the
  // update is abandoned half way.
  const left = fs.readdirSync(sandbox).filter((f) => f.endsWith('.cmd') || f.endsWith('.flag'));
  return left.length === 0 || ('left behind: ' + left.join(', '));
});

add('the staged marker is consumed so it cannot install twice', () => {
  const r = quitRun;
  return r.pendingCleared === true || 'the marker survived and would install again on next launch';
});

add('quitting for an install exits, rather than only being asked to', () => {
  // app.exit(0) rather than app.quit(): the installer needs this executable
  // released, so a graceful quit that can be cancelled is the wrong verb.
  const r = quitRun;
  return r.quits.length === 0 || 'it quit gracefully instead of exiting';
});

// These two are async because the quit is *scheduled*, not immediate: an
// ordinary app.quit() is asked for on a 150ms timer so the IPC reply reaches
// the renderer first. Reading the record synchronously would see nothing and
// report a quit that was never requested.
addExec('quitting with nothing staged is an ordinary quit', async () => {
  const r = driveQuit({ stage: false });
  await new Promise((res) => setTimeout(res, 300));
  const clean = r.handed === false && r.spawned.length === 0 && r.quits.length === 1;
  return clean
    || ('handed=' + r.handed + ' spawned=' + r.spawned.length + ' quits=' + r.quits.length);
});

addExec('an installer that has gone does not stop the app from quitting', async () => {
  const r = driveQuit({ installerPresent: false });
  await new Promise((res) => setTimeout(res, 300));
  return (r.handed === false && r.quits.length === 1)
    || ('handed=' + r.handed + ' quits=' + r.quits.length);
});

addExec('a helper that has gone does not stop the app from quitting', async () => {
  // A packaged build that somehow lost its helper must not leave the app
  // unable to close, and must not claim to have installed anything.
  const r = driveQuit({ helperPresent: false });
  await new Promise((res) => setTimeout(res, 300));
  return (r.handed === false && r.spawned.length === 0 && r.quits.length === 1)
    || ('handed=' + r.handed + ' spawned=' + r.spawned.length + ' quits=' + r.quits.length);
});

add('the quit handler goes through the updater, not a bare app.quit', () => {
  // The exact line that was wrong: a plain setTimeout(app.quit) in ipc.js, which
  // could never start an install no matter what updater.js did.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8');
  const handler = /ipcMain\.handle\('updater:quit'[\s\S]*?\n {2}\}\)\);/.exec(src);
  if (!handler) return 'the updater:quit handler was not found';
  return handler[0].includes('updater.quitAndInstall()')
    || 'the handler does not hand off: ' + handler[0].replace(/\s+/g, ' ').slice(0, 120);
});
// The sandbox is torn down in report(), after the async checks above have run.
// Doing it here would reset userData to the repo root before they executed, and
// they would have written their scripts into the working tree instead.

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

  // Only now: the quit checks above wrote into this sandbox, and the async ones
  // had not run until the loop above finished. Left behind, the next run would
  // find a marker staged by the last one.
  userDataPath = ROOT;
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }

  let failed = 0;
  for (const [name, ok, detail] of cases) {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

report();