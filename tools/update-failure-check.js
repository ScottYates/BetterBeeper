/**
 * The update failure path, driven end to end.
 *
 * The 1.28.8 update wedged: the installer stopped part way through, holding an
 * exclusive lock on Better Beeper.exe, and the app could not be started again
 * until Windows was restarted. Four things were wrong with the handling, and
 * all four are about what happens when the install does not work:
 *
 *   1. The installer was killed with Process.Kill(), which stops one process.
 *      The children it had started carried on, and they are what held the
 *      lock. The tree is now stopped through a job object.
 *
 *   2. The install was attempted even when the app's files were still held.
 *      An installer that cannot get the files it wants does not fail, it
 *      wedges - holding the very file the app needs to start. The install is
 *      now not attempted at all in that case.
 *
 *   3. The app was only started again when the install had worked, so a failed
 *      install left the user with no app at all. It is now started again
 *      whatever happened.
 *
 *   4. The result was written after the app was started, so the app could
 *      start, look for the result, and find nothing. The result is now written
 *      first.
 *
 * None of that can be checked by reading the source. It has to be run.
 *
 * So this suite runs the real helper - the program that ships in the app -
 * against real executables built here for the purpose:
 *
 *   FakeInstaller   hangs forever, and starts FakeChild first
 *   FakeChild       hangs forever, from a different path
 *   FakeOk          exits 0 at once
 *   FakeFail        exits 3 at once
 *   FakeRelaunch    reads the result file and copies it into a marker file
 *   FakeLock        holds a file open so nothing else can
 *
 * FakeChild is deliberately at a different path from FakeInstaller, so the
 * sweep by path cannot find it. Only the job object can stop it, which is what
 * makes the first check mean something.
 *
 * FakeRelaunch is how the ordering is proved. It reads the result file as it
 * starts, so the marker it leaves behind is the result *as the app saw it*.
 * A helper that wrote the result after starting the app would leave an empty
 * marker, and the failure would never have been reported to anybody.
 *
 * The helper is run with --no-window. It is a real windowed program and this
 * is a test suite: nothing may appear on the desktop.
 *
 * Run with `npm run check:updatefailure`.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync, spawnSync, spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HELPER_PROJECT = path.join(ROOT, 'tools', 'update-helper');

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

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

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-update-failure-'));

/** A synchronous sleep. Node has no one, and this suite cannot await. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Waits for a condition, or gives up. */
function waitFor(fn, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    sleep(50);
  }
  return null;
}

function fileText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** Waits for a file to appear, and returns its contents. */
function waitForFile(p, timeoutMs = 10000) {
  const found = waitFor(() => fs.existsSync(p), timeoutMs);
  if (!found) return null;
  return fileText(p) ?? '';
}

// ---------------------------------------------------------------------------
// Building the helper and the fakes
// ---------------------------------------------------------------------------

const { findCompiler } = require(path.join(ROOT, 'tools', 'build-helper.js'));

const compiler = findCompiler();

function compileFake(name, source) {
  const cs = path.join(sandbox, `${name}.cs`);
  const out = path.join(sandbox, `${name}.exe`);
  fs.writeFileSync(cs, source, 'utf8');
  execFileSync(compiler, [
    '/nologo',
    '/target:winexe',
    '/optimize+',
    `/out:${out}`,
    cs,
  ], { stdio: 'pipe' });
  return out;
}

// The helper under test. Rebuilt every run so it can never be a stale binary
// that passes for a fix that is not there, and built into this suite's own
// sandbox so a run cannot fail because the repository's build is in use.
const HELPER_DIR = path.join(sandbox, 'helper');
execFileSync(process.execPath, [
  path.join(ROOT, 'tools', 'build-helper.js'), '--force', '--out', HELPER_DIR,
], { stdio: 'pipe' });
const HELPER_EXE = path.join(HELPER_DIR, 'BetterBeeper.UpdateHelper.exe');

const FAKE_INSTALLER = compileFake('FakeInstaller', `using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

internal static class FakeInstaller
{
    private static int Main(string[] args)
    {
        var childPath = Environment.GetEnvironmentVariable("BB_CHILD_PATH");
        var pidFile = Environment.GetEnvironmentVariable("BB_PID_FILE");

        var child = 0;
        if (!string.IsNullOrEmpty(childPath))
        {
            var childProcess = Process.Start(new ProcessStartInfo(childPath)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            if (childProcess != null) child = childProcess.Id;
        }

        var me = Process.GetCurrentProcess().Id;
        if (!string.IsNullOrEmpty(pidFile))
        {
            File.WriteAllText(pidFile, me + " " + child);
        }

        Thread.Sleep(Timeout.Infinite);
        return 0;
    }
}
`);

const FAKE_CHILD = compileFake('FakeChild', `using System;
using System.Threading;

internal static class FakeChild
{
    private static int Main(string[] args)
    {
        Thread.Sleep(Timeout.Infinite);
        return 0;
    }
}
`);

const FAKE_OK = compileFake('FakeOk', `internal static class FakeOk
{
    private static int Main(string[] args)
    {
        return 0;
    }
}
`);

const FAKE_FAIL = compileFake('FakeFail', `internal static class FakeFail
{
    private static int Main(string[] args)
    {
        return 3;
    }
}
`);

const FAKE_RELAUNCH = compileFake('FakeRelaunch', `using System;
using System.IO;

internal static class FakeRelaunch
{
    private static int Main(string[] args)
    {
        var marker = Environment.GetEnvironmentVariable("BB_MARKER_PATH");
        if (string.IsNullOrEmpty(marker)) return 0;

        var result = Environment.GetEnvironmentVariable("BB_RESULT_PATH");
        var text = "";
        if (!string.IsNullOrEmpty(result) && File.Exists(result)) text = File.ReadAllText(result);

        File.WriteAllText(marker, text);
        return 0;
    }
}
`);

const FAKE_LOCK = compileFake('FakeLock', `using System;
using System.IO;
using System.Threading;

internal static class FakeLock
{
    private static int Main(string[] args)
    {
        if (args.Length < 1) return 2;

        using (var stream = new FileStream(args[0], FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            var ready = Environment.GetEnvironmentVariable("BB_LOCK_READY");
            if (!string.IsNullOrEmpty(ready)) File.WriteAllText(ready, "locked");
            Thread.Sleep(Timeout.Infinite);
        }

        return 0;
    }
}
`);

// ---------------------------------------------------------------------------
// Running the helper
// ---------------------------------------------------------------------------

/**
 * Runs the helper the way the app runs it, and reports what it left behind.
 *
 * --pid 0 because the check is not the app: there is no parent process for
 * the helper to wait for, and it is written to wait for none.
 */
function runHelper({ installer, relaunch, result, env = {}, installTimeout = '3', releaseTimeout = '5' }) {
  const args = [
    '--no-window',
    '--installer', installer,
    '--relaunch', relaunch,
    '--result', result,
    '--pid', '0',
    '--install-timeout', installTimeout,
    '--release-timeout', releaseTimeout,
  ];

  const run = spawnSync(HELPER_EXE, args, {
    env: { ...process.env, ...env },
    timeout: 120000,
    windowsHide: true,
    encoding: 'utf8',
  });

  return {
    status: run.status,
    error: run.error ? run.error.message : null,
    result: fileText(result),
  };
}

/** The result the helper wrote, split into the code and the reason. */
function parseResult(text) {
  if (text == null) return null;
  const trimmed = text.trim();
  const tab = trimmed.indexOf('\t');
  return {
    code: Number(tab === -1 ? trimmed : trimmed.slice(0, tab)),
    detail: tab === -1 ? '' : trimmed.slice(tab + 1).trim(),
    raw: trimmed,
  };
}

/** Is this process still alive? */
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function killIfAlive(pid) {
  if (!pid) return;
  try { process.kill(pid); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

const RESULT = path.join(sandbox, 'update-result.txt');
const MARKER = path.join(sandbox, 'marker.txt');
const PID_FILE = path.join(sandbox, 'pids.txt');

function clearRun() {
  for (const f of [RESULT, MARKER, PID_FILE]) {
    try { fs.rmSync(f, { force: true }); } catch { /* not there */ }
  }
}

/**
 * The incident: an installer that never finishes.
 *
 * The helper has to stop it and its children, find that the app's files are
 * free again, start the app back, and have written the reason before the app
 * started - so the app can say what happened.
 */
clearRun();
const wedged = runHelper({
  installer: FAKE_INSTALLER,
  relaunch: FAKE_RELAUNCH,
  result: RESULT,
  env: { BB_CHILD_PATH: FAKE_CHILD, BB_PID_FILE: PID_FILE, BB_RESULT_PATH: RESULT, BB_MARKER_PATH: MARKER },
});
const wedgedResult = parseResult(wedged.result);
const wedgedPids = (fileText(PID_FILE) || '').split(/\s+/).filter(Boolean).map(Number);
// The marker existing and the marker being empty are different things, and the
// difference is the whole point: an empty marker means the app started before
// the result was written, so it never learned what had happened.
const wedgedMarker = waitForFile(MARKER);
// The children have to be gone too. Give them a moment to actually die.
const childrenGone = waitFor(() => wedgedPids.every((pid) => !alive(pid)), 15000);

add('a wedged installer is stopped and the app starts again', () => {
  if (wedged.status === null) return 'the helper did not finish: ' + wedged.error;
  if (wedgedResult?.code !== 2) return 'the result code was ' + (wedgedResult && wedgedResult.code) + ', wanted 2 (the installer was stopped)';
  if (wedgedMarker === null) return 'the app was never started again';
  return true;
});

add('the whole installer tree is stopped, not just the installer', () => {
  // The child is at a different path, so the sweep by path cannot find it.
  // Only the job object can stop it.
  if (wedgedPids.length < 2) return 'the fake installer did not start its child: ' + JSON.stringify(wedgedPids);
  if (!childrenGone) return 'a process from the installer is still running: ' + JSON.stringify(wedgedPids);
  return true;
});

add('the app reads the result the helper wrote', () => {
  if (wedgedMarker === null) return 'the app was never started again';
  if (wedgedMarker.trim() !== wedgedResult.raw) {
    return 'the app saw "' + wedgedMarker.trim() + '" but the result was "' + wedgedResult.raw + '"';
  }
  return true;
});

add('the result is written before the app is started again', () => {
  // The app reads the result on its way up, so the result has to be there
  // before the app starts.
  //
  // This one is checked in the source rather than observed, and deliberately
  // so: the order is a race, and .NET's own start-up time is long enough that
  // the app usually wins it even when the order is wrong. A behavioural check
  // here would be green against a bug - which is the one thing a check must
  // not be.
  const src = fs.readFileSync(path.join(HELPER_PROJECT, 'Program.cs'), 'utf8');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const write = body.indexOf('WriteResult(options, code, detail);');
  const relaunch = body.indexOf('TryRelaunch(options, out why)');
  if (write === -1) return 'the outcome is never written';
  if (relaunch === -1) return 'the app is never started again';
  if (write > relaunch) return 'the result is written after the app has been started';
  return true;
});

add('a failed install still starts the app again', () => {
  // The old version is still on disk and still runnable after a failed
  // install. Starting it is the whole point.
  if (wedgedMarker === null) return 'the app was never started again';
  return true;
});

add('the reason an installer was stopped is written down', () => {
  if (!wedgedResult?.detail) return 'the result has no detail';
  if (!/did not finish/i.test(wedgedResult.detail)) return 'the detail says "' + wedgedResult.detail + '"';
  return true;
});

// ---------------------------------------------------------------------------
// The install that works
// ---------------------------------------------------------------------------

clearRun();
const good = runHelper({
  installer: FAKE_OK,
  relaunch: FAKE_RELAUNCH,
  result: RESULT,
  env: { BB_RESULT_PATH: RESULT, BB_MARKER_PATH: MARKER },
});
const goodResult = parseResult(good.result);
const goodMarker = waitForFile(MARKER);

add('a successful install says so', () => {
  if (goodResult?.code !== 0) return 'the result code was ' + (goodResult && goodResult.code) + ', wanted 0';
  if (goodMarker === null) return 'the app was not started again';
  return true;
});

// ---------------------------------------------------------------------------
// The installer that fails
// ---------------------------------------------------------------------------

clearRun();
const failed = runHelper({
  installer: FAKE_FAIL,
  relaunch: FAKE_RELAUNCH,
  result: RESULT,
  env: { BB_RESULT_PATH: RESULT, BB_MARKER_PATH: MARKER },
});
const failedResult = parseResult(failed.result);
const failedMarker = waitForFile(MARKER);

add('an installer that fails is reported with its exit code', () => {
  if (failedResult?.code !== 1) return 'the result code was ' + (failedResult && failedResult.code) + ', wanted 1';
  if (!/exit code 3/.test(failedResult.detail || '')) return 'the detail says "' + failedResult.detail + '"';
  return true;
});

add('an installer that fails still starts the app again', () => {
  if (failedMarker === null) return 'the app was never started again';
  return true;
});

// ---------------------------------------------------------------------------
// The app's files are held
// ---------------------------------------------------------------------------

clearRun();
const LOCK_READY = path.join(sandbox, 'locked.txt');
try { fs.rmSync(LOCK_READY, { force: true }); } catch { /* not there */ }

// The lock is held by a real process, because a lock cannot be held from node:
// node opens files with sharing enabled, so nothing would actually be blocked.
const locker = spawn(FAKE_LOCK, [FAKE_RELAUNCH], {
  env: { ...process.env, BB_LOCK_READY: LOCK_READY },
  windowsHide: true,
  stdio: 'ignore',
});
const locked = waitFor(() => fs.existsSync(LOCK_READY));

const held = locked
  ? runHelper({
    installer: FAKE_INSTALLER,
    relaunch: FAKE_RELAUNCH,
    result: RESULT,
    releaseTimeout: '3',
    env: { BB_CHILD_PATH: FAKE_CHILD, BB_PID_FILE: PID_FILE, BB_RESULT_PATH: RESULT, BB_MARKER_PATH: MARKER },
  })
  : { status: null, error: 'the lock could not be taken', result: null };
const heldResult = parseResult(held.result);

add('the install is not attempted while the app\'s files are held', () => {
  // An installer that cannot get the files it wants does not fail, it wedges -
  // and it wedges holding the very file the app needs to start.
  if (!locked) return 'the lock could not be taken, so nothing was proved';
  if (fs.existsSync(PID_FILE)) return 'the installer was started anyway';
  return true;
});

add('the app\'s files being held is reported as the reason', () => {
  if (!locked) return 'the lock could not be taken, so nothing was proved';
  if (heldResult?.code !== 3) {
    return 'the result code was ' + (heldResult && heldResult.code) + ', wanted 3, and the detail said "'
      + (heldResult && heldResult.detail) + '"';
  }
  if (!/holding/i.test(heldResult.detail || '')) return 'the detail says "' + heldResult.detail + '"';
  return true;
});

try { locker.kill(); } catch { /* already gone */ }

// ---------------------------------------------------------------------------
// The app that cannot be started again
// ---------------------------------------------------------------------------

clearRun();
const noExe = path.join(sandbox, 'ThereIsNoAppHere.exe');
const unstartable = runHelper({
  installer: FAKE_OK,
  relaunch: noExe,
  result: RESULT,
  env: { BB_RESULT_PATH: RESULT, BB_MARKER_PATH: MARKER },
});
const unstartableResult = parseResult(unstartable.result);

add('an app that cannot be started again is reported', () => {
  if (unstartableResult?.code !== 4) return 'the result code was ' + (unstartableResult && unstartableResult.code) + ', wanted 4';
  // The detail is the reason, and the reason here is the one that lets the
  // user do something: the installer is still on disk and running it again
  // finishes the update.
  if (!/is not there/.test(unstartableResult.detail || '')) return 'the detail says "' + unstartableResult.detail + '"';
  if (!/installer is still at/.test(unstartableResult.detail || '')) return 'the detail does not say where the installer is';
  return true;
});

// ---------------------------------------------------------------------------
// The helper that could not even work out what to do
// ---------------------------------------------------------------------------

clearRun();

// No --installer, so the arguments cannot be parsed. The app starts this
// program and then exits, so it is on its way out by now: a helper that gave
// up quietly here would leave the user with no app at all.
const confused = spawnSync(HELPER_EXE, [
  '--no-window',
  '--relaunch', FAKE_RELAUNCH,
  '--result', RESULT,
  '--pid', '0',
], {
  env: { ...process.env, BB_RESULT_PATH: RESULT, BB_MARKER_PATH: MARKER },
  timeout: 60000,
  windowsHide: true,
  encoding: 'utf8',
});
const confusedMarker = waitForFile(MARKER);

add('the app is started again even when the helper could not parse its arguments', () => {
  if (confused.status === null) return 'the helper did not finish';
  if (confusedMarker === null) return 'the app was never started again';
  return true;
});

// ---------------------------------------------------------------------------
// The app side: reading the result back
// ---------------------------------------------------------------------------

const Module = require('module');
const realLoad = Module._load;
let userDataPath = sandbox;
const appStub = {
  getVersion: () => '1.30.1',
  getPath: (name) => (name === 'userData' ? userDataPath : ROOT),
  getAppPath: () => ROOT,
  isPackaged: false,
  exit: () => {},
  quit: () => {},
  get isQuitting() { return false; },
};
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') {
    return { app: appStub, net: { fetch: async () => { throw new Error('no network in the check'); } } };
  }
  return realLoad.call(this, request, parent, isMain);
};
const updater = require(path.join(ROOT, 'src', 'main', 'updater.js'));
Module._load = realLoad;

const RESULT_FILE = 'update-result.txt';

function writeResult(text) {
  fs.writeFileSync(path.join(sandbox, RESULT_FILE), text, 'utf8');
  return updater.readInstallResult();
}

add('the install result keeps the reason the helper wrote', () => {
  const read = writeResult('-1\tThe installer did not finish within 15 minutes and was stopped.');
  if (!read) return 'nothing was read';
  if (read.code !== -1) return 'the code was ' + read.code;
  if (read.detail !== 'The installer did not finish within 15 minutes and was stopped.') {
    return 'the detail was "' + read.detail + '"';
  }
  return true;
});

add('the install result says which outcome it was', () => {
  const read = writeResult('2\tThe installer did not finish.');
  if (!read?.message) return 'there is no message';
  if (!/stopped/i.test(read.message)) return 'the message says "' + read.message + '"';
  return true;
});

add('a result the build does not know still says the update did not install', () => {
  const read = writeResult('nonsense');
  if (!read) return 'nothing was read';
  if (read.ok !== false) return 'it reported success';
  if (!/did not install/i.test(read.message || '')) return 'the message says "' + read.message + '"';
  return true;
});

add('the result file is read once and then cleared', () => {
  writeResult('1\tsomething went wrong');
  const second = updater.readInstallResult();
  if (second !== null) return 'the file was still there on the second read';
  return true;
});

add('the app names every outcome the helper can write', () => {
  // The helper's codes and the app's sentences have to agree, and there is
  // nothing that keeps them agreeing except this check.
  const cs = fs.readFileSync(path.join(HELPER_PROJECT, 'Program.cs'), 'utf8');
  const codes = [...cs.matchAll(/public const int (\w+) = (-?\d+);/g)].map((m) => Number(m[2]));
  const missing = codes.filter((code) => !updater.INSTALL_OUTCOMES[code]);
  return missing.length === 0
    || ('no sentence for code ' + missing.join(', '));
});

add('every outcome is named in the user\'s terms', () => {
  // The sentence is what the toast leads with, so it has to say something
  // the reader can act on. "The installer stopped" says what happened; the
  // detail that goes with it says why.
  const codes = [0, 1, 2, 3, 4, -1];
  const bland = codes.filter((code) => {
    const sentence = updater.describeInstallOutcome(code) || '';
    return sentence.length < 20 || !/[a-z]/.test(sentence);
  });
  return bland.length === 0
    || ('no sentence worth reading for code ' + bland.join(', '));
});

add('the renderer shows the reason, not just a number', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'updates.js'), 'utf8');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  if (!/last\.message/.test(body)) return 'the outcome sentence is not used';
  if (!/last\.detail/.test(body)) return 'the reason is not shown';
  return true;
});

add('a failed install is reported even when automatic updates are off', () => {
  // The report used to ride on the update check, and the update check is
  // skipped when automatic updates are off - so the person who had turned
  // them off and had an update fail anyway was never told. The outcome has to
  // be asked for on its own.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'updates.js'), 'utf8');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  if (!/api\.updateStatus\(/.test(body)) return 'the outcome is never asked for on its own';

  const fn = /export async function reportInstallOutcome\(\)[\s\S]*?\n\}/.exec(body);
  if (!fn) return 'there is no reportInstallOutcome';
  if (/autoUpdates/.test(fn[0])) return 'the report is behind the automatic-updates guard';
  return true;
});

add('the status window says what happened, not what usually happens', () => {
  // The old window said "Better Beeper will reopen on the old version"
  // whatever had happened, and the code only reopened the app when the
  // install had worked - so on a failed install it promised something it did
  // not do. The wording has to come from the result.
  const src = fs.readFileSync(path.join(HELPER_PROJECT, 'StatusForm.cs'), 'utf8');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  if (!/switch\s*\(\s*_state\.ExitCode\s*\)/.test(body)) return 'the window does not switch on the result code';
  if (!/case ResultCodes\.FilesHeld/.test(body)) return 'the window does not say what to do about held files';
  if (!/case ResultCodes\.RelaunchFailed/.test(body)) return 'the window does not say what to do about an app that would not start';
  return true;
});

add('the update can be stopped before the installer finishes', () => {
  // Waiting out a fifteen minute timeout with nothing to do about it is the
  // worst way to spend the time an installer is hanging. The window has a
  // button, and the work notices it.
  //
  // The use, not the name: the field is declared either way, so a check that
  // only looks for the name is satisfied by the declaration and would pass on
  // a program that ignored the button completely.
  const src = fs.readFileSync(path.join(HELPER_PROJECT, 'Program.cs'), 'utf8');
  const form = fs.readFileSync(path.join(HELPER_PROJECT, 'StatusForm.cs'), 'utf8');
  if (!/Volatile\.Read\(ref\s+\w+\.CancelRequested\)/.test(src)) return 'the work never looks at the stop request';
  if (!/Volatile\.Write\(ref\s+\w+\.CancelRequested/.test(form)) return 'the button never makes the request';
  if (!/Click\s*\+=\s*OnStopClicked/.test(form)) return 'the button is not wired to anything';
  return true;
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

let failures = 0;
for (const [name, ok, detail] of cases) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}

// Everything this suite started has to be stopped before the sandbox goes.
for (const pid of wedgedPids) killIfAlive(pid);

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${cases.length - failures}/${cases.length} checks passed`);
process.exit(failures ? 1 : 0);
