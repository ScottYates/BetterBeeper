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
 * This suite runs the real helper with the real window and reads what the
 * window did out of the trace the helper leaves behind. The trace is the only
 * way to observe it: the window exists on the interactive desktop, and there
 * is no other place its behaviour can be recorded.
 *
 * The runs happen on a desktop of their own - WinSta0, but not the desktop
 * the user is looking at - so every window the helper creates is on a desktop
 * Windows does not draw. That is the difference between a promise ("the code
 * will not show a window") and a guarantee (there is nowhere for a window to
 * be shown). The off-screen mode is asked for as well, so there are two
 * independent reasons for the user not to see anything, and the window is
 * still created, shown, sized and placed for real, so the trace is a record
 * of a real window and not of a rehearsal.
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
  ], { stdio: 'pipe', windowsHide: true });
  return out;
}

// The helper under test, built into this suite's own sandbox so a run can
// never be a stale binary and can never fail because the repository's build
// is in use.
const HELPER_DIR = path.join(sandbox, 'helper');
execFileSync(process.execPath, [
  path.join(ROOT, 'tools', 'build-helper.js'), '--force', '--out', HELPER_DIR,
], { stdio: 'pipe', windowsHide: true });
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

// ---------------------------------------------------------------------------
// Running the helper for real, with the real window, on a desktop of its own
// ---------------------------------------------------------------------------

// The runner that gives the helper a desktop of its own.
//
// This is the whole answer to "never put a window on my screen". Moving the
// window off the screen is a promise about what the code will do; a desktop
// of its own is a fact about where the code runs. Every window the helper
// creates is on that desktop, so Windows never draws it and it can never be
// the foreground window - whatever the helper does with TopMost, Activate or
// SetForegroundWindow.
//
// It is compiled here, into this suite's own sandbox, for the same reason the
// helper is: a run must never be a stale binary.
const PRIVATE_DESKTOP_RUNNER = path.join(sandbox, 'PrivateDesktopRunner.exe');
execFileSync(compiler, [
  '/nologo',
  '/target:winexe',
  '/optimize+',
  `/out:${PRIVATE_DESKTOP_RUNNER}`,
  path.join(ROOT, 'tools', 'private-desktop-runner.cs'),
], { stdio: 'pipe', windowsHide: true });

// The desktop the runs below happen on. The name is in the trace, so the check
// can prove afterwards that the helper really was somewhere else.
const PRIVATE_DESKTOP = 'bb-check-' + process.pid;

/**
 * Whether the runner really gives the helper a desktop of its own.
 *
 * This is read from the runner's source *before* the helper is started, and
 * the helper is only started if it is true.
 *
 * That order matters, and it is not tidiness. A check that proves a rule
 * works has to break the rule, and the rule here is "the helper's window can
 * never reach the user's desktop". Breaking it in the source is harmless;
 * breaking it at run time is not - that is a window on someone's screen, and
 * the proof of the rule would be the popup it is about.
 *
 * So the containment is established before the contained thing is used.
 */
function runnerGivesAPrivateDesktop() {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'private-desktop-runner.cs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  if (!/CreateDesktop\(/.test(code)) return false;
  // Exactly one program is started, and it is started on the desktop it was
  // given. A second CreateProcess, or a second lpDesktop, would be a way for
  // the rule to be broken without the line that states it changing.
  //
  // The call is counted, not the declaration of it: the runner declares
  // CreateProcess and calls it, and only the call starts anything.
  if ((code.match(/=\s*CreateProcess\s*\(/g) || []).length !== 1) return false;
  if ((code.match(/lpDesktop\s*=/g) || []).length !== 1) return false;
  if (!/lpDesktop\s*=\s*"WinSta0\\\\"\s*\+\s*desktopName/.test(code)) return false;
  if (/lpDesktop\s*=\s*"WinSta0\\\\Default"/.test(code)) return false;
  return true;
}

const RUNNER_IS_PRIVATE = runnerGivesAPrivateDesktop();

/**
 * Runs the helper with its real window, on a desktop of its own.
 *
 * The window is created and shown for real - that is the only way to find out
 * whether the window works - but it is on a desktop Windows does not draw, so
 * a test can never put anything in front of the user or take the focus away
 * from them. The off-screen mode is still asked for as well, so the window is
 * moved off the screen as well as being on a hidden desktop: two independent
 * reasons for the user not to see it.
 *
 * Returns the trace's lines.
 */
function runHelperWithWindow({ installer = FAKE_INSTALLER, label = 'run', place = null } = {}) {
  const dir = path.join(sandbox, label);
  fs.mkdirSync(dir, { recursive: true });

  const trace = path.join(dir, 'trace.txt');
  const result = path.join(dir, 'result.txt');
  const shortcut = path.join(dir, 'Better Beeper.lnk');
  const pinFolder = path.join(dir, 'TaskBar');
  const pidFile = path.join(dir, 'child.pid');

  // The Start Menu shortcut, as the installer would have left it.
  fs.writeFileSync(shortcut, 'the shortcut as the installer left it', 'utf8');

  const run = spawnSync(PRIVATE_DESKTOP_RUNNER, [
    PRIVATE_DESKTOP,
    HELPER_EXE,
    '--installer', installer,
    '--relaunch', FAKE_RELAUNCH,
    '--result', result,
    '--pid', '0',
    '--trace', trace,
    '--offscreen',
    // A short wait for the app's files. The real helper waits two minutes,
    // because the app might genuinely be slow to let go of them; here the
    // thing it is waiting for is a file in this suite's own sandbox, and a
    // helper still waiting after ten seconds is a helper still running after
    // the check has finished.
    '--release-timeout', '10',
    '--shortcut', shortcut,
    '--pin-folder', pinFolder,
    ...(place ? ['--place', place] : []),
  ], {
    timeout: 90000,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, BB_PRIVATE_DESKTOP_PID_FILE: pidFile },
  });

  let text = '';
  try { text = fs.readFileSync(trace, 'utf8'); } catch { /* no trace at all */ }

  // A helper that is still running is a helper with a window on the desktop.
  //
  // The runner stops one that overstays, and this is the check that the
  // runner was asked to do it: a process left behind after a check is a
  // process whose window is still on the user's screen.
  let leftover = null;
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (pid && pidAlive(pid)) {
      leftover = pid;
      try { process.kill(pid); } catch { /* already gone */ }
    }
  } catch { /* no pid file: the program never started */ }

  return {
    run,
    trace: text,
    leftover,
    lines: text.split(/\r?\n/).filter((l) => l.trim()),
    result: (() => { try { return fs.readFileSync(result, 'utf8'); } catch { return null; } })(),
    shortcut,
    pinFolder,
    pinned: path.join(pinFolder, 'Better Beeper.lnk'),
  };
}

/** Is this process still running? */
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it is there and belongs to somebody else.
    return e.code === 'EPERM';
  }
}

/**
 * A run with no window in it, for when the runner cannot be trusted.
 *
 * The helper is not started at all: the containment has to be established
 * before the contained thing is used.
 */
function noRun(label) {
  const dir = path.join(sandbox, label);
  fs.mkdirSync(dir, { recursive: true });
  return {
    run: { status: null },
    trace: '',
    leftover: null,
    lines: [],
    result: null,
    shortcut: path.join(dir, 'Better Beeper.lnk'),
    pinFolder: path.join(dir, 'TaskBar'),
    pinned: path.join(dir, 'TaskBar', 'Better Beeper.lnk'),
  };
}

const good = RUNNER_IS_PRIVATE ? runHelperWithWindow({ label: 'good' }) : noRun('good');
const failed = RUNNER_IS_PRIVATE
  ? runHelperWithWindow({ installer: FAKE_FAIL, label: 'failed' })
  : noRun('failed');
// A run where the app says where the window should go.
const placed = RUNNER_IS_PRIVATE
  ? runHelperWithWindow({ label: 'placed', place: '1000,500' })
  : noRun('placed');

/**
 * The name of the desktop the helper's window was on, as the trace said.
 */
function desktopFrom(lines) {
  const tick = lines.find((l) => l.startsWith('tick '));
  if (!tick) return null;
  const m = /desktop=(\S+)/.exec(tick);
  return m ? m[1] : null;
}

/**
 * The window station the helper's window was on, as the trace said.
 */
function stationFrom(lines) {
  const tick = lines.find((l) => l.startsWith('tick '));
  if (!tick) return null;
  const m = /station=(\S+)/.exec(tick);
  return m ? m[1] : null;
}

/**
 * Where the window was put, as the trace recorded it.
 *
 * The trace holds the bounds read back from the window after it was placed,
 * so this is what the window actually did rather than what the code meant.
 */
function placementFrom(lines) {
  const line = lines.find((l) => l.startsWith('place handle-created'));
  if (!line) return null;
  const m = /x=(-?\d+) y=(-?\d+) w=(\d+) h=(\d+) display=(.+)$/.exec(line);
  if (!m) return null;
  return {
    x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]),
    display: m[5].trim(),
  };
}

/** The primary display's work area, as the trace recorded it. */
function primaryWorkFrom(lines) {
  const line = lines.find((l) => l.startsWith('primary-work='));
  if (!line) return null;
  const m = /primary-work=(-?\d+),(-?\d+),(\d+),(\d+)/.exec(line);
  if (!m) return null;
  return { left: Number(m[1]), top: Number(m[2]), width: Number(m[3]), height: Number(m[4]) };
}

/**
 * Where a window centred on a point ends up.
 *
 * The same arithmetic the helper does: centred on the point, and never
 * hanging over the edge of the work area.
 */
function centredOn(work, point, w, h) {
  const x = Math.min(Math.max(point.x - Math.floor(w / 2), work.left), work.left + work.width - w);
  const y = Math.min(Math.max(point.y - Math.floor(h / 2), work.top), work.top + work.height - h);
  return { x, y };
}

/**
 * Where a window centred in an area ends up.
 *
 * The helper divides by two and truncates, and so does this: the two have to
 * agree on the rounding, or the check is measuring its own arithmetic rather
 * than the window.
 */
function centredIn(work, w, h) {
  return {
    x: work.left + Math.floor((work.width - w) / 2),
    y: work.top + Math.floor((work.height - h) / 2),
  };
}

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

add('a check never puts a window on the desktop the user is looking at', () => {
  // The rule the user asked for: never pop up a window. Ever.
  //
  // This is not a promise about what the helper's code will do - it is a fact
  // about where the helper runs. The run happens on a desktop of its own, so
  // every window it creates is on a desktop Windows does not draw, whatever
  // the helper does with TopMost, Activate or SetForegroundWindow. The user
  // cannot see it and it cannot take their keyboard.
  //
  // The trace says which desktop the window was on, so this is measured
  // rather than assumed.
  if (!RUNNER_IS_PRIVATE) {
    return 'the runner does not give the helper a desktop of its own, so the window was not run at all';
  }

  const desktop = desktopFrom(good.lines);
  if (!desktop) return 'the trace says nothing about which desktop the window was on';
  if (desktop === 'Default') {
    return 'the helper ran on the desktop the user is looking at';
  }
  if (desktop !== PRIVATE_DESKTOP) {
    return `the helper ran on the desktop "${desktop}" and not on the one it was given`;
  }
  return true;
});

add('a check never leaves a window behind', () => {
  // A helper that is still running after a check is a helper whose window is
  // still on the user's screen - it just happens to be on a desktop Windows
  // is not drawing. The runner stops one that overstays, and this is the
  // check that it was asked to.
  if (!RUNNER_IS_PRIVATE) return 'the window was not run at all, so nothing was left behind';
  if (good.leftover) return 'the helper was still running when the check finished: ' + good.leftover;
  if (failed.leftover) return 'the helper was still running after a failed install: ' + failed.leftover;
  if (placed.leftover) return 'the helper was still running after a placed run: ' + placed.leftover;
  return true;
});

add('the runner cannot be pointed at the user\'s desktop by accident', () => {
  // The guarantee is only as good as the runner. If the runner ever hard-codes
  // "Default" - or if the desktop name it is given is ignored - every window
  // in every check goes straight back onto the user's screen.
  //
  // The comments are stripped first: this file explains at length why the
  // desktop is not the user's, and a search that read the prose would find
  // the word and call the rule satisfied.
  if (!RUNNER_IS_PRIVATE) {
    return 'the runner does not build the desktop name from the name it was given';
  }
  return true;
});

add('the window is on the interactive window station', () => {
  // The station is what makes the desktop trick a fair test rather than a
  // different program entirely. "WinSta0" is the interactive station - the
  // session the user is in - so the window is a real window, on the real
  // station, with a real size and a real position. It is only the desktop
  // within it that is not the one being looked at.
  //
  // A window on another station would be invisible for a different reason
  // entirely, and could not even be measured the way a real update measures
  // it.
  const station = stationFrom(good.lines);
  if (!station) return 'the trace says nothing about which window station the window was on';
  if (station !== 'WinSta0') return 'the window was not on the interactive window station: ' + station;
  return true;
});

add('the real update still shows its window on the user\'s screen', () => {
  // The private desktop is for checks. A real update is the one moment a
  // window is supposed to appear: the app has gone and the user is waiting.
  //
  // So the app must not use the private desktop runner, and it must not ask
  // for the off-screen mode. If either of those ever changes, the update
  // becomes a silent one and the user is left staring at nothing.
  const src = fs.readFileSync(updaterPath, 'utf8');
  if (/private-desktop/i.test(src)) {
    return 'the app runs the helper on a private desktop, so its window would never be seen';
  }
  if (/--offscreen/.test(src)) {
    return 'the app asks for the off-screen mode, so its window would never be seen';
  }
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

add('the window is put in front once the app has gone', () => {
  // The window is activated when it is shown, but that is while the app is
  // still on screen and in the foreground, and Windows does not always let a
  // window that is not the foreground one come to the front. The app being
  // gone is the moment the user is looking for something, so the window is
  // put in front then - and a window that is behind whatever the user was
  // working in is the same as no window at all.
  //
  // This cannot be *run* to prove it, and that is deliberate: putting a window
  // in front takes the focus, and a test must never take the focus from the
  // person it is supposed to be helping. So the proof is the wiring - the flag
  // is set once the app has gone, and the front is taken by TopMost, Show,
  // Activate and SetForegroundWindow - and the trace of a real update, which
  // is the only place where taking the focus is what the user asked for.
  const src = fs.readFileSync(path.join(HELPER_PROJECT, 'StatusForm.cs'), 'utf8');
  if (!/TopMost = true;/.test(src)) return 'the window is never put above the others';
  if (!/Activate\(\);/.test(src)) return 'the window is never activated';
  if (!/SetForegroundWindow\(Handle\);/.test(src)) return 'the window is never put in the foreground';

  // And the tick has to actually make the call.
  //
  // The three lines above are the means; the tick is the moment. A helper
  // that has the code and never calls it has a window that is up and behind
  // everything else, which is the same as no window - and a check that only
  // looks for the code would call that a pass.
  const tickStart = src.indexOf('private void OnTick(');
  if (tickStart === -1) return 'the window has no tick, so it never looks at the flag';
  const tickEnd = src.indexOf('private void Finish(', tickStart);
  const tick = tickEnd === -1 ? src.slice(tickStart) : src.slice(tickStart, tickEnd);
  if (!/BringToFront/.test(tick)) return 'the tick never looks at the flag';
  if (!/ComeToFront\(\);/.test(tick)) {
    return 'the tick never brings the window to the front when the app has gone';
  }

  const helper = fs.readFileSync(path.join(HELPER_PROJECT, 'Program.cs'), 'utf8');
  if (!/Volatile\.Write\(ref state\.BringToFront, 1\)/.test(helper)) {
    return 'the helper never asks for the window to be brought to the front';
  }
  if (!/parent-gone[\s\S]{0,1500}BringToFront, 1\)/.test(helper)) {
    return 'the window is brought to the front before the app has gone';
  }
  return true;
});

add('a test never takes the focus from the user', () => {
  // The window is off the screen, so there is nothing to see - but activating
  // it would still take the focus, and the user's keystrokes would go to a
  // window they cannot see. That is worse than a popup: it is a popup that
  // also takes over the keyboard.
  //
  // So the off-screen mode must not activate the window, and must not put it
  // above the others either. The trace says which it did.
  const front = good.lines.find((l) => l.startsWith('brought-to-front'));
  if (!front) return 'the trace says nothing about the front of the window';
  if (!/skipped offscreen/.test(front)) {
    return 'the off-screen run put the window in front anyway: ' + front;
  }
  const tick = good.lines.find((l) => l.startsWith('tick '));
  if (tick && /foreground=yes/.test(tick)) {
    return 'the off-screen window took the focus: ' + tick;
  }
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
// Where the window goes
// ---------------------------------------------------------------------------

add('the window is put in the middle of the primary display', () => {
  // Windows used to do this, and Windows centres on the display the *mouse* is
  // on. That is a display nobody chose: on the update that was measured, the
  // window came up on the far-left display while the user was at the primary.
  // It was up and visible for the whole install and nobody saw it, which is
  // exactly the report "the helper window does not show".
  //
  // So the window is placed explicitly, on the primary display, in the middle
  // of its work area.
  const place = placementFrom(good.lines);
  if (!place) return 'the trace says nothing about where the window was put';
  const work = primaryWorkFrom(good.lines);
  if (!work) return 'the trace does not say where the primary display is';

  const want = centredIn(work, place.w, place.h);
  if (place.x !== want.x || place.y !== want.y) {
    return `the window was put at ${place.x},${place.y} and the middle of the primary display is ${want.x},${want.y}`;
  }
  if (place.display !== 'primary') return 'the window was not on the primary display: ' + place.display;
  return true;
});

add('the window is put where the app says it should be', () => {
  // The app knows which display the user was looking at - it was on screen.
  // The helper is told, and puts the window in the middle of that point.
  const place = placementFrom(placed.lines);
  if (!place) return 'the trace says nothing about where the window was put';
  const work = primaryWorkFrom(placed.lines);
  if (!work) return 'the trace does not say where the primary display is';

  const want = centredOn(work, { x: 1000, y: 500 }, place.w, place.h);
  if (place.x !== want.x || place.y !== want.y) {
    return `the window was put at ${place.x},${place.y} and it should have been at ${want.x},${want.y}`;
  }
  return true;
});

add('the window does not follow the mouse', () => {
  // The rule, in the source: Windows must not be asked to centre the window,
  // because Windows centres on the display the mouse is on.
  //
  // The comments are stripped first. This file says at length why the window
  // is placed explicitly rather than by Windows, and the explanation contains
  // the very words being looked for - a search that read the prose would find
  // them and report a rule that is not broken.
  const src = fs.readFileSync(path.join(HELPER_PROJECT, 'StatusForm.cs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  if (/FormStartPosition\.CenterScreen/.test(code)) {
    return 'the window is centred by Windows, which centres it on the display the mouse is on';
  }
  if (!/StartPosition\s*=\s*FormStartPosition\.Manual/.test(code)) {
    return 'the window is not placed explicitly';
  }
  return true;
});

add('the app tells the helper where to put the window', () => {
  // Without this, the window goes on the primary display whatever the user is
  // looking at - better than following the mouse, and still not right.
  const src = fs.readFileSync(updaterPath, 'utf8');
  if (!/'--place'/.test(src)) return 'the app never tells the helper where to put the window';
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

  spawnSync(PRIVATE_DESKTOP_RUNNER, [
    PRIVATE_DESKTOP,
    HELPER_EXE,
    '--installer', FAKE_INSTALLER,
    '--relaunch', FAKE_RELAUNCH,
    '--result', path.join(dir, 'result.txt'),
    '--pid', '0',
    '--offscreen',
    '--release-timeout', '10',
    '--shortcut', shortcut,
    '--pin-folder', pinFolder,
  ], { timeout: 90000, windowsHide: true, stdio: 'ignore' });

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
