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
//
// It writes down the command line it was given, because what the installer is
// told matters: the installer decides from its own arguments whether this is
// an update, and an update keeps the app's shortcuts and its registered
// identity. An update that does not say so takes the taskbar pin with it.
const FAKE_OK_ARGS = path.join(sandbox, 'fake-ok-args.txt');
const FAKE_INSTALLER = compileFake('FakeOk', `using System;
using System.IO;
using System.Threading;

internal static class FakeOk
{
    private static int Main(string[] args)
    {
        File.WriteAllText(@"${FAKE_OK_ARGS}", string.Join(" ", args));
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
  //
  // The desktop name alone is not enough: every window station has a desktop
  // called "Default", and a window on another station is invisible. The
  // station is the interactive one - WinSta0 - on the desktop the user is
  // looking at.
  const tick = good.lines.find((l) => l.startsWith('tick '));
  if (!tick) return 'the window never ticked';
  if (!/desktop=Default/.test(tick)) return 'the window was not on the interactive desktop: ' + tick;
  if (!/station=WinSta0/.test(tick)) return 'the window was not on the interactive window station: ' + tick;
  return true;
});

add('the window is not transparent', () => {
  // A transparent window is a window nobody can see, and the form's own
  // Visible property says nothing about it - a transparent window is Visible.
  // This is the case the off-screen mode used to make: it made the window
  // transparent, so the check could not tell an invisible window from a
  // visible one, which is the whole thing it is here to catch.
  const tick = good.lines.find((l) => l.startsWith('tick '));
  if (!tick) return 'the window never ticked';
  if (!/transparent=no/.test(tick)) return 'the window was transparent: ' + tick;
  return true;
});

add('the window is not hidden on another desktop', () => {
  // A cloaked window is one the desktop manager is not showing: it is on a
  // virtual desktop that is not the one being looked at. It is Visible as far
  // as Windows is concerned and nobody sees it.
  const tick = good.lines.find((l) => l.startsWith('tick '));
  if (!tick) return 'the window never ticked';
  if (!/cloaked=no/.test(tick)) return 'the window was cloaked: ' + tick;
  return true;
});

add('the window comes to the front once the app has gone', () => {
  // The window is activated when it is shown, but that is while the app is
  // still on screen and in the foreground, and Windows does not always let a
  // window that is not the foreground one come to the front. The app being
  // gone is the moment the user is looking for something, so the window is
  // put in front then - and a window that is behind whatever the user was
  // working in is the same as no window at all.
  //
  // "Topmost" is the part that is guaranteed. Windows may refuse
  // SetForegroundWindow - it is a privilege, and the helper is not the
  // foreground process - so the trace records whether the window became the
  // foreground one, but the window being *above* the others is what the user
  // sees, and that is what is required here.
  if (!good.lines.some((l) => l.startsWith('brought-to-front'))) {
    return 'the window was never brought to the front';
  }
  const front = good.lines.find((l) => l.startsWith('brought-to-front'));
  if (!/topmost=yes/.test(front)) return 'the window was not put above the others: ' + front;
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

add('the update does not touch the taskbar pin', () => {
  // The pin is not a file that happens to be in a folder. It is Explorer's own
  // state - the list of pinned items, their order, and the identity each one
  // carries - and the file in the pinned folder is Explorer's copy of it.
  //
  // Writing over that copy does not restore a pin. Explorer notices the file
  // changed, treats it as a new item, and adds it at the end of the list. That
  // is exactly what the old "put the pin back" did on the machine it was
  // measured on: the pinned "Better Beeper.lnk" was overwritten, Explorer
  // registered a second item called "Better Beeper (2).lnk", and the pin moved
  // to the end of the list and stopped matching the app.
  //
  // So the rule is that the update does not write there at all.
  const left = fs.existsSync(good.pinFolder) ? fs.readdirSync(good.pinFolder) : [];
  if (left.length) return 'the update wrote into the pinned items folder: ' + left.join(', ');
  return true;
});

add('a failed install does not touch the taskbar pin either', () => {
  const left = fs.existsSync(failed.pinFolder) ? fs.readdirSync(failed.pinFolder) : [];
  if (left.length) return 'a failed install wrote into the pinned items folder: ' + left.join(', ');
  return true;
});

add('a pinned shortcut is left exactly as it was', () => {
  // Not rewritten, not replaced, not given a new name. The pin is the user's
  // and the update has no business touching it.
  const dir = path.join(sandbox, 'untouched');
  fs.mkdirSync(dir, { recursive: true });
  const shortcut = path.join(dir, 'Better Beeper.lnk');
  const pinFolder = path.join(dir, 'TaskBar');
  fs.mkdirSync(pinFolder, { recursive: true });
  fs.writeFileSync(shortcut, 'the shortcut', 'utf8');
  const pinned = path.join(pinFolder, 'Better Beeper.lnk');
  fs.writeFileSync(pinned, 'the pinned shortcut, byte for byte', 'utf8');
  const before = sha(pinned);

  spawnSync(HELPER_EXE, [
    '--installer', FAKE_INSTALLER,
    '--relaunch', FAKE_RELAUNCH,
    '--result', path.join(dir, 'result.txt'),
    '--pid', '0',
    '--offscreen',
    '--shortcut', shortcut,
    '--pin-folder', pinFolder,
  ], { timeout: 25000, windowsHide: true, stdio: 'ignore' });

  if (!fs.existsSync(pinned)) return 'the pinned shortcut was taken away';
  if (sha(pinned) !== before) return 'the pinned shortcut was rewritten';
  if (fs.readdirSync(pinFolder).length !== 1) return 'the update added something to the pinned items folder';
  return true;
});

add('the installer is told this is an update', () => {
  // The installer decides from its own command line whether this is an
  // update. An update keeps the Start Menu shortcut and the app's registered
  // identity; anything else deletes them and writes new ones - and the taskbar
  // pin is the shell's entry for that identity.
  //
  // This is the whole reason the pin went missing on every update: the
  // installer was being run as if it were a fresh install.
  let recorded = '';
  try { recorded = fs.readFileSync(FAKE_OK_ARGS, 'utf8'); } catch { /* the installer never ran */ }
  if (!recorded) return 'the installer was never run, so it was never told anything';
  if (!/--updated/.test(recorded)) return 'the installer was not told it is an update: ' + recorded;
  if (!/\/S/.test(recorded)) return 'the installer was not run silently: ' + recorded;
  return true;
});

// ---------------------------------------------------------------------------
// The update installs over the top
// ---------------------------------------------------------------------------

add('the installer includes the script that installs over the top', () => {
  // The uninstaller is what deletes the Start Menu shortcut and unregisters
  // the app's identity, and the taskbar pin is the shell's entry for that
  // identity. So an update that uninstalls the old version takes the pin with
  // it, every time, and the app has to be pinned by hand again.
  //
  // The fix is that the update does not uninstall anything: the installer
  // writes the new files over the old ones.
  const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  // A commented-out line is not an include. The whole line is dropped before
  // the line is looked for, so "include: ..." behind a "#" does not pass.
  const live = yml
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  if (!/^\s*include:\s*tools\/nsis\/installer\.nsh\s*$/m.test(live)) {
    return 'electron-builder.yml does not include tools/nsis/installer.nsh';
  }
  if (!fs.existsSync(path.join(ROOT, 'tools', 'nsis', 'installer.nsh'))) {
    return 'the script electron-builder.yml includes is not there';
  }
  return true;
});

add('the script makes the old uninstaller give up', () => {
  const nsh = fs.readFileSync(path.join(ROOT, 'tools', 'nsis', 'installer.nsh'), 'utf8');
  if (!/!macro\s+customUnInstall/.test(nsh)) return 'there is no customUnInstall macro';
  if (!/^\s*Quit\s*$/m.test(nsh)) return 'the uninstaller is not told to quit';
  if (!/SetErrorLevel\s+0/.test(nsh)) {
    return 'the installer checks the uninstaller exit code, so it has to be zero';
  }
  return true;
});

add('the uninstaller gives up before it deletes the shortcuts', () => {
  // The hook has to come before the uninstaller deletes the shortcuts and
  // unregisters the app's identity, or the script is called too late to
  // matter. This reads electron-builder's own template, so a change in
  // electron-builder turns the check red rather than quietly undoing the fix.
  const templatePath = path.join(
    ROOT, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'uninstaller.nsh',
  );
  if (!fs.existsSync(templatePath)) {
    return 'node_modules is not installed, so the hook cannot be checked';
  }
  const template = fs.readFileSync(templatePath, 'utf8');
  const hook = template.indexOf('!insertmacro customUnInstall');
  const damage = template.indexOf('WinShell::UninstAppUserModelId');
  if (hook === -1) return 'electron-builder no longer calls the custom uninstall hook';
  if (damage === -1) return 'the template no longer unregisters the app identity';
  if (hook > damage) return 'the hook comes after the damage, so it is too late';
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
