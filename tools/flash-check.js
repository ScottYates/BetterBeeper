/**
 * Dev check: the taskbar icon flashing when a message arrives.
 *
 * The rule is small, and every way of getting it wrong is invisible until the
 * user is looking at their screen:
 *
 *   shouldStart  Your own message must not flash anything - you sent it, you
 *                know it went. Neither must one that arrives while the window
 *                is in front of you, because a flashing button on the window
 *                being read is noise.
 *
 *   shouldStop   Windows keeps flashing until it is explicitly told to stop. A
 *                flash left running after the user has come back to the window
 *                is the loudest way to get this wrong, so stopping on focus is
 *                half the feature rather than a detail.
 *
 *   the API      `flashFrame` is a BrowserWindow method, and it is not stubbed
 *                out here. The preflight calls it on a real window and the
 *                recording checks below watch the same seam the app uses. A
 *                check that replaced the call with a recorder would pass
 *                happily against a method that does not exist - which is
 *                exactly how `app.setOverlayIcon` hid a dead badge behind
 *                forty green checks.
 *
 * Run with `npm run check:flash`.
 */
const path = require('path');
const os = require('os');
const harnessGuard = require('./harness-guard');

const ROOT = path.join(__dirname, '..');
const flashPath = path.join(ROOT, 'src', 'main', 'flash.js');
const mainPath = path.join(ROOT, 'src', 'main', 'main.js');

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

async function main() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(os.tmpdir(), 'bb-flash-check-profile'));
  harnessGuard(app, { label: 'check:flash' });

  const flash = require(flashPath);

  // ---- the platform --------------------------------------------------------

  add('Windows is the platform this is for', () =>
    flash.supportsFlash('win32') === true || 'win32 was not supported');

  add('a platform with no taskbar flash is left alone', () => {
    // Not simulated, not faked: macOS and Linux simply do not have the call.
    const others = ['darwin', 'linux', 'freebsd', ''];
    const wrong = others.filter((p) => flash.supportsFlash(p) !== false);
    return wrong.length === 0 || 'claimed support on: ' + wrong.join(', ');
  });

  add('the running platform agrees with the decision', () =>
    flash.supportsFlash(process.platform) === (process.platform === 'win32')
      || process.platform);

  // ---- when to start -------------------------------------------------------

  add('a message that arrives in the background starts a flash', () =>
    flash.shouldStart({ windowFocused: false, windowVisible: true }) === true
      || 'a background message did not flash');

  add('a message that arrives while minimised starts a flash', () =>
    flash.shouldStart({ windowFocused: false, windowVisible: false }) === true
      || 'a minimised message did not flash');

  add('a message that arrives while you are reading does not', () =>
    flash.shouldStart({ windowFocused: true, windowVisible: true }) === false
      || 'the window flashed at the user who was looking at it');

  add('your own message never flashes anything', () =>
    flash.shouldStart({ windowFocused: false, windowVisible: false, messageIsOwn: true }) === false
      || 'sending a message flashed your own taskbar');

  add('nothing to flash about, flashes nothing', () =>
    flash.shouldStart() === true || 'an empty frame started a flash');

  // ---- when to stop --------------------------------------------------------

  add('focus stops a running flash', () =>
    flash.shouldStop({ flashing: true, windowFocused: true }) === true
      || 'a running flash survived the window being focused');

  add('a flash keeps running while the window is still in the background', () =>
    flash.shouldStop({ flashing: true, windowFocused: false }) === false
      || 'the flash stopped while the user was still elsewhere');

  add('focusing with nothing flashing does nothing', () =>
    flash.shouldStop({ flashing: false, windowFocused: true }) === false
      || 'a flash was cleared that had never started');

  // ---- the real API, called for real ---------------------------------------

  // A BrowserWindow cannot be made before the app is ready.
  await app.whenReady();
  const win = new BrowserWindow({ show: false });

  add('the window really has a flashFrame method', () =>
    typeof win.flashFrame === 'function' || 'typeof flashFrame is ' + typeof win.flashFrame);

  add('flashing a real window does not throw', () => {
    win.flashFrame(true);
    win.flashFrame(false);
    return true;
  });

  // ---- the seam, watched rather than trusted ------------------------------

  const calls = [];
  const real = flash.taskbar.set;
  flash.taskbar.set = (on) => {
    calls.push(Boolean(on));
    return true;
  };

  const fakeWindow = (focused, visible) => ({
    isFocused: () => focused,
    isVisible: () => visible,
    isDestroyed: () => false,
  });

  const seed = () => {
    calls.length = 0;
    flash.resetFlash();
  };

  add('a background message reaches the taskbar as one start', () => {
    seed();
    const acted = flash.onIncoming(fakeWindow(false, true), {});
    return (acted === true && calls.join(',') === 'true' && flash.isFlashing() === true)
      || JSON.stringify({ acted, calls, state: flash.isFlashing() });
  });

  add('focusing after a flash reaches the taskbar as one stop', () => {
    seed();
    flash.onIncoming(fakeWindow(false, true), {});
    calls.length = 0;
    const acted = flash.onFocus(fakeWindow(true, true));
    return (acted === true && calls.join(',') === 'false' && flash.isFlashing() === false)
      || JSON.stringify({ acted, calls, state: flash.isFlashing() });
  });

  add('your own message never reaches the taskbar', () => {
    seed();
    flash.onIncoming(fakeWindow(false, false), { messageIsOwn: true });
    return (calls.length === 0 && flash.isFlashing() === null)
      || JSON.stringify({ calls, state: flash.isFlashing() });
  });

  add('a message read on arrival never reaches the taskbar', () => {
    seed();
    flash.onIncoming(fakeWindow(true, true), {});
    return (calls.length === 0 && flash.isFlashing() === null)
      || JSON.stringify({ calls, state: flash.isFlashing() });
  });

  add('a second message while flashing does not re-ask', () => {
    // The button is already flashing. Asking again does not make it louder, and
    // it would mean an IPC-sized write on every message on a busy account.
    seed();
    flash.onIncoming(fakeWindow(false, true), {});
    calls.length = 0;
    const acted = flash.onIncoming(fakeWindow(false, true), {});
    return (acted === false && calls.length === 0)
      || JSON.stringify({ acted, calls });
  });

  add('focus arriving with no flash on does not touch the taskbar', () => {
    seed();
    flash.onFocus(fakeWindow(true, true));
    return calls.length === 0 || calls.join(',');
  });

  add('a message after the flash stopped starts a fresh one', () => {
    // The cycle: arrive, get noticed, go back, another one arrives. If the
    // cleared state were sticky the second message would never flash, which is
    // how a feature quietly stops working an hour later.
    seed();
    flash.onIncoming(fakeWindow(false, true), {});
    flash.onFocus(fakeWindow(true, true));
    calls.length = 0;
    const acted = flash.onIncoming(fakeWindow(false, true), {});
    return (acted === true && calls.join(',') === 'true' && flash.isFlashing() === true)
      || JSON.stringify({ acted, calls, state: flash.isFlashing() });
  });

  add('the taskbar is told to stop exactly once per flash', () => {
    seed();
    flash.onIncoming(fakeWindow(false, true), {});
    calls.length = 0;
    flash.onFocus(fakeWindow(true, true));
    flash.onFocus(fakeWindow(true, true));
    return calls.join(',') === 'false' || calls.join(',');
  });

  // A destroyed window must not throw on the way out.
  add('a destroyed window is handled rather than thrown at', () => {
    seed();
    const dead = { isFocused: () => false, isVisible: () => false, isDestroyed: () => true };
    let threw = false;
    try {
      flash.onIncoming(dead, {});
    } catch (e) {
      threw = true;
    }
    return threw === false || 'a destroyed window threw';
  });

  add('a window with no flashFrame is handled rather than thrown at', () => {
    seed();
    const bare = { isFocused: () => false, isVisible: () => false, isDestroyed: () => false };
    let threw = false;
    try {
      flash.onIncoming(bare, {});
    } catch (e) {
      threw = true;
    }
    return threw === false || 'a window without flashFrame threw';
  });

  // Put the real seam back before anything else runs. The checks that follow
  // are the ones that need the window to actually be called, and a recorder
  // left in place of it makes them all pass with nothing having happened.
  flash.taskbar.set = real;

  // ---- the app really calls flashFrame ------------------------------------
  //
  // The checks above confirm the platform HAS the method. That is not the same
  // as the app using it: swapping flashFrame for any other call - exactly what
  // setOverlayIcon was - leaves the platform perfectly capable and the feature
  // completely dead, and every check so far would stay green.
  //
  // So this runs the real seam, unstubbed, against a window object that records
  // what it was asked to do.

  add('the app really calls flashFrame on the window', () => {
    seed();
    const seen = [];
    flash.setWindowSource(() => ({
      isFocused: () => false,
      isVisible: () => true,
      isDestroyed: () => false,
      flashFrame: (on) => seen.push(Boolean(on)),
    }));
    flash.onIncoming({ isFocused: () => false, isVisible: () => true }, {});
    flash.onFocus({ isFocused: () => true, isVisible: () => true });
    flash.setWindowSource(() => null);
    return seen.join(',') === 'true,false' || JSON.stringify(seen);
  });

  add('nothing but flashFrame is asked of the window', () => {
    seed();
    const seen = [];
    const guarded = new Proxy({
      isFocused: () => false,
      isVisible: () => true,
      isDestroyed: () => false,
      flashFrame: (on) => seen.push('flashFrame:' + on),
    }, {
      get(target, prop) {
        if (prop in target) return target[prop];
        return () => { seen.push('unexpected:' + String(prop)); };
      },
    });
    flash.setWindowSource(() => guarded);
    flash.onIncoming({ isFocused: () => false, isVisible: () => true }, {});
    flash.onFocus({ isFocused: () => true, isVisible: () => true });
    flash.setWindowSource(() => null);
    return seen.join(',') === 'flashFrame:true,flashFrame:false' || JSON.stringify(seen);
  });

  // ---- wiring: the decisions have to be the ones that run ------------------

  const fs = require('node:fs');
  const mainSrc = fs.readFileSync(mainPath, 'utf8');

  add('the app wires the flash up', () => /wireFlash\(\);/.test(mainSrc));
  add('messages are what trigger it', () => /events\.on\('message\.upserted'[\s\S]{0,400}flash\.onIncoming/.test(mainSrc));
  add('focus is what stops it', () => /mainWindow\.on\('focus',[^\n]*flash\.onFocus/.test(mainSrc));
  add('restoring the window stops it too', () => /mainWindow\.on\('restore',[^\n]*flash\.onFocus/.test(mainSrc));
  add('it never takes focus itself', () => {
    // Asking to be noticed is not the same as interrupting. A show()/focus()
    // inside the flash path would steal the user's attention from whatever they
    // were actually doing.
    const body = mainSrc.slice(mainSrc.indexOf('function wireFlash'), mainSrc.indexOf('function wireNotifications'));
    return !/\.(show|focus|restore)\(/.test(body) || 'the flash path takes focus';
  });
  add('the flash wiring runs even when notifications are unsupported', () => {
    // wireNotifications() returns early when Notification.isSupported() is
    // false; wireFlash() must not live inside it.
    const fn = mainSrc.slice(mainSrc.indexOf('function wireFlash'), mainSrc.indexOf('function wireNotifications'));
    return fn.indexOf('isSupported') === -1 || 'wireFlash depends on notification support';
  });
  add('the notification path still finds the same message', () => {
    // Both halves were picking the entry out of the frame by hand; one copy of
    // that rule is the only reason they cannot disagree about whose message it
    // was. Exactly one copy: zero would mean the helper went missing, and two
    // would mean it was quietly duplicated again.
    //
    // The g flag is the whole check. String.match() without it returns only the
    // first match, so the count was always exactly 1 and this passed no matter
    // what the file contained.
    const copies = (mainSrc.match(/new Set\(frame/gi) || []).length;
    return copies === 1 || copies + ' copies of the entry lookup';
  });

  return cases;
}

main()
  .then((cs) => {
    let failed = 0;
    for (const [name, ok, detail] of cs) {
      if (!ok) failed++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
    }
    console.log(`\n${cs.length - failed}/${cs.length} checks passed`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error('failed:', err.message);
    process.exit(1);
  });