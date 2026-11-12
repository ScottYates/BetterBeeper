/**
 * The update handoff's two promises: a window, and a taskbar pin.
 *
 * Both of them were being made and neither of them was being checked.
 *
 * The window is the part of the update the user actually sees. The app closes,
 * the install folder is replaced, and for about a minute there is nothing on
 * the screen at all - which is correct and reads as a crash. So the helper
 * puts a window up. Every check that drove the helper passed --no-window,
 * because a window on the desktop during a test is not allowed, and that
 * meant the window path had never once been run. "The window shows" was an
 * assumption with nothing behind it.
 *
 * This suite runs the real helper with the real window, off the screen and
 * fully transparent, and reads what the window did out of the trace the
 * helper leaves behind. The trace is the only way to observe it: the window
 * exists on the interactive desktop, and there is no other place its behaviour
 * can be recorded.
 *
 * The pin is the other half. The taskbar pin is a copy of the Start Menu
 * shortcut - measured, not assumed: on a real machine the pinned
 * "Better Beeper.lnk" and the Start Menu "Better Beeper.lnk" had the same
 * SHA-256. The installer rewrites that shortcut, so the pin has to be put back
 * afterwards. This suite checks that it is, including when the install fails,
 * because a failed install rewrites the shortcut too.
 *
 * And the helper itself has to be run from somewhere the installer does not
 * touch. It used to live inside the install folder - the very folder the
 * installer deletes - so the installer could not finish deleting it and the
 * helper's own executable was never replaced. That is checked here too.
 *
 * Run with `npm run check:handoff`.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HELPER_PROJECT = path.join(ROOT, 'tools', 'update-helper');
const updaterPath = path.join(ROOT, 'src', 'main', 'updater.js');

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

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-handoff-'));
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

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

/** A synchronous sleep. Node has none, and this suite cannot await. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

// The helper under test, built into this suite's own sandbox so a run can
// never be a stale binary and can never fail because the repository's build
// is in use.
const HELPER_DIR = path.join(sandbox, 'helper');
execFileSync(process.execPath, [
  path.join(ROOT, 'tools', 'build-helper.js'), '--force', '--out', HELPER_DIR,
], { stdio: 'pipe' });
const HELPER_EXE = path.join(HELPER_DIR, 'BetterBeeper.UpdateHelper.exe');

// An installer that takes a moment, so the window is genuinely up while the
// install runs rather than for a single tick.
const FAKE_INSTALLER = compileFake('FakeOk', `using System;
using System.Threading;

internal static class FakeOk
{
    private static int Main(string[] args)
    {
        Thread.Sleep(1500);
        return 0;
    }
}
`);

// An installer that fails.
const FAKE_FAIL = compileFake('FakeFail', `internal static class FakeFail
{
    private static int Main(string[] args)
    {
        return 3;
    }
}
`);

// Stands in for the app being started again. It must not be the real app.
const FAKE_RELAUNCH = compileFake('FakeRelaunch', `internal static class FakeRelaunch
{
    private static int Main(string[] args)
    {
        return 0;
    }
}
`);

// ---------------------------------------------------------------------------
// Running the helper for real, with the real window
// ---------------------------------------------------------------------------

/**
 * Runs the helper with its window on, off the screen and fully transparent.
 *
 * The window is put off the screen and made transparent so that a test never
 * puts anything in front of the user. It is still created, still shown and
 * still visible in every sense Windows cares about, which is what the trace
 * records.
 *
 * Returns the trace's lines.
 */
function runHelperWithWindow({ installer = FAKE_INSTALLER, label = 'run' } = {}) {
  const dir = path.join(sandbox, label);
  fs.mkdirSync(dir, { recursive: true });

  const trace = path.join(dir, 'trace.txt');
  const result = path.join(dir, 'result.txt');
  const shortcut = path.join(dir, 'Better Beeper.lnk');
  const pinFolder = path.join(dir, 'TaskBar');

  // The Start Menu shortcut, as the installer would have left it.
  fs.writeFileSync(shortcut, 'the shortcut as the installer left it', 'utf8');

  const run = spawnSync(HELPER_EXE, [
    '--installer', installer,
    '--relaunch', FAKE_RELAUNCH,
    '--result', result,
    '--pid', '0',
    '--trace', trace,
    '--offscreen',
    '--shortcut', shortcut,
    '--pin-folder', pinFolder,
  ], { timeout: 25000, windowsHide: true, stdio: 'ignore' });

  let text = '';
  try { text = fs.readFileSync(trace, 'utf8'); } catch { /* no trace at all */ }

  return {
    run,
    trace: text,
    lines: text.split(/\r?\n/).filter((l) => l.trim()),
    result: (() => { try { return fs.readFileSync(result, 'utf8'); } catch { return null; } })(),
    shortcut,
    pinFolder,
    pinned: path.join(pinFolder, 'Better Beeper.lnk'),
  };
}

const good = runHelperWithWindow({ label: 'good' });
const failed = runHelperWithWindow({ installer: FAKE_FAIL, label: 'failed' });

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

add('the helper runs the install and records how it went', () => {
  // The trace is the evidence for everything else here, so it has to be
  // there. A helper that never started writes nothing at all.
  if (!good.lines.length) return 'the helper left no trace';
  if (!good.lines.some((l) => l.startsWith('work-done'))) return 'the helper never finished the work';
  return true;
});

add('the helper puts a window up', () => {
  // The form being built and the message loop starting. Both are facts about
  // the window, written down as they happen.
  if (!good.lines.some((l) => l.startsWith('form-constructed'))) return 'the window was never built';
  if (!good.lines.some((l) => l.startsWith('pump-enter'))) return 'the window never started its message loop';
  return true;
});

add('the window is visible', () => {
  // A window that is not visible is not a window, however well it was built.
  const tick = good.lines.find((l) => l.startsWith('tick '));
  if (!tick) return 'the window never ticked, so it never drew itself';
  if (!/visible=True/.test(tick)) return 'the window was never visible: ' + tick;
  return true;
});

add('the window is on the desktop the user is looking at', () => {
  // A window on some other desktop is created and painted and nobody sees it.
  // That is a different failure from a window that was never created, and the
  // two need different fixes.
  const tick = good.lines.find((l) => l.startsWith('tick '));
  if (!tick) return 'the window never ticked';
  if (!/desktop=Default/.test(tick)) return 'the window was not on the interactive desktop: ' + tick;
  return true;
});

add('the window is up while the install runs, not after it', () => {
  // The window exists to cover the gap where the app is gone. A window that
  // appears once the install is already finished has missed the part it was
  // for.
  const tick = good.lines.findIndex((l) => l.startsWith('tick '));
  const done = good.lines.findIndex((l) => l.startsWith('work-done'));
  if (tick === -1) return 'the window never ticked';
  if (done === -1) return 'the install never finished';
  if (tick > done) return 'the window only appeared after the install was already over';
  return true;
});

add('the window is taken off the screen when a test asks for it', () => {
  // The off-screen mode is what lets the window path be run at all without
  // putting a window in front of the user. If it stops working, the next
  // person to run this suite gets a popup on their desktop.
  const shown = good.lines.find((l) => l.startsWith('offscreen shown'));
  if (!shown) return 'the window was not moved off the screen';
  if (!/bounds=-32000,-32000/.test(shown)) return 'the window is not off the screen: ' + shown;
  return true;
});

// ---------------------------------------------------------------------------
// The taskbar pin
// ---------------------------------------------------------------------------

add('the taskbar pin is put back after the install', () => {
  // The pin is a copy of the Start Menu shortcut, and the installer rewrites
  // that shortcut, so the copy has to be put back. This is the difference
  // between "the app stays where it was" and "re-pin it by hand".
  if (!fs.existsSync(good.pinned)) return 'there is no pinned shortcut afterwards';
  if (sha(good.pinned) !== sha(good.shortcut)) return 'the pinned shortcut is not a copy of the Start Menu one';
  return true;
});

add('the taskbar pin is put back even when the install fails', () => {
  // A failed install rewrites the shortcut just as well as a good one, so
  // leaving the pin alone on failure is leaving the pin broken.
  if (!fs.existsSync(failed.pinned)) return 'a failed install left the app unpinned';
  if (sha(failed.pinned) !== sha(failed.shortcut)) return 'the pinned shortcut is not a copy of the Start Menu one';
  return true;
});

add('a pinned shortcut that has gone stale is replaced', () => {
  // The copy has to be overwritten, not merely skipped when one is already
  // there. A stale copy is what a pin that no longer matches looks like.
  const dir = path.join(sandbox, 'stale');
  fs.mkdirSync(dir, { recursive: true });
  const shortcut = path.join(dir, 'Better Beeper.lnk');
  const pinFolder = path.join(dir, 'TaskBar');
  fs.mkdirSync(pinFolder, { recursive: true });
  fs.writeFileSync(shortcut, 'the new shortcut', 'utf8');
  fs.writeFileSync(path.join(pinFolder, 'Better Beeper.lnk'), 'the old stale one', 'utf8');

  spawnSync(HELPER_EXE, [
    '--installer', FAKE_INSTALLER,
    '--relaunch', FAKE_RELAUNCH,
    '--result', path.join(dir, 'result.txt'),
    '--pid', '0',
    '--offscreen',
    '--shortcut', shortcut,
    '--pin-folder', pinFolder,
  ], { timeout: 25000, windowsHide: true, stdio: 'ignore' });

  const pinned = path.join(pinFolder, 'Better Beeper.lnk');
  if (!fs.existsSync(pinned)) return 'the stale pin was not replaced';
  if (sha(pinned) !== sha(shortcut)) return 'the stale pin is still there';
  return true;
});

// ---------------------------------------------------------------------------
// The helper is run from somewhere the installer does not touch
// ---------------------------------------------------------------------------

// updater.js requires electron at load time, so it is stubbed the same way
// check:update does it. LOCALAPPDATA is pointed at a sandbox so the copy the
// app makes does not land in the real one.
const localAppData = path.join(sandbox, 'LocalAppData');
fs.mkdirSync(localAppData, { recursive: true });
const previousLocalAppData = process.env.LOCALAPPDATA;
process.env.LOCALAPPDATA = localAppData;

const appStub = {
  getVersion: () => '1.3.3',
  getPath: (name) => (name === 'userData' ? path.join(sandbox, 'userData') : ROOT),
  getAppPath: () => ROOT,
  isPackaged: false,
  exit: () => {},
  quit: () => {},
  get isQuitting() { return false; },
};

const Module = require('node:module');
const realLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') {
    return { app: appStub, net: { fetch: async () => { throw new Error('no network in a check'); } } };
  }
  return realLoad.call(this, request, parent, isMain);
};

const updater = require(updaterPath);
Module._load = realLoad;

add('the helper is run from outside the install folder', () => {
  // The installer replaces the install folder wholesale, and the helper used
  // to run from inside it. Windows will not delete a running program, so the
  // installer could not finish, and the helper's own executable was never
  // replaced by the new one.
  //
  // The rule is that the helper does not run from where it shipped. The
  // packaged path is inside the install folder by definition, so "not the
  // packaged path" is the whole rule - and it is checked against the real
  // function rather than a guess about what the path looks like.
  const run = updater.helperRunPath();
  const packaged = updater.helperPath();
  if (!run) return 'the helper has nowhere to run from';
  if (run.toLowerCase() === packaged.toLowerCase()) {
    return 'the helper still runs from the install folder: ' + run;
  }
  if (!run.toLowerCase().startsWith(localAppData.toLowerCase())) {
    return 'the helper does not run from the copy that was made: ' + run;
  }
  return true;
});

add('the app copies the helper somewhere safe before it runs it', () => {
  // The copy is what makes the run path safe. If it is not made, the helper
  // runs from the install folder again.
  const prepared = updater.prepareHelper();
  if (!prepared) return 'the helper could not be prepared';
  if (prepared.toLowerCase() !== updater.helperRunPath().toLowerCase()) {
    return 'the helper is not run from the prepared copy: ' + prepared;
  }
  if (!fs.existsSync(prepared)) return 'the prepared helper is not there';
  return true;
});

add('the helper is asked to leave a trace', () => {
  // The trace is how the window's behaviour is observed at all. Without it
  // the next person to ask "did the window show" is back to guessing.
  const src = fs.readFileSync(updaterPath, 'utf8');
  if (!/--trace/.test(src)) return 'the helper is not asked for a trace';
  return true;
});

add('the trace is written where the app can find it', () => {
  const trace = updater.helperTracePath();
  if (!trace || !trace.toLowerCase().includes('update-helper-trace')) {
    return 'the trace path is not the one the app knows about: ' + trace;
  }
  return true;
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
else process.env.LOCALAPPDATA = previousLocalAppData;

let failures = 0;
for (const [name, ok, detail] of cases) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${cases.length - failures}/${cases.length} checks passed`);
process.exit(failures ? 1 : 0);
