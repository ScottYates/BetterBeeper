/**
 * Nothing a check does may put a window on the user's screen.
 *
 * The rule the user asked for is short: never pop up a window. Ever. The
 * failures that produced it were all the same failure wearing different
 * clothes - a check that started a program, and the program was a console
 * program, and a console program started from a process with no console of
 * its own is given one:
 *
 *   - a window that flashed in the middle of the desktop and vanished again
 *   - a window that stayed until somebody closed it
 *   - a window that was off the screen but had taken the focus, so the user's
 *     keystrokes went to something they could not see
 *
 * Each of those is one flag away from not happening, so this suite is about
 * the flag: `windowsHide: true` on every process any tool starts, and a
 * browser window that is never shown.
 *
 * The other half is the update helper, which has a real window and must have
 * one - the app is gone for a minute during an update and the window is what
 * says so. That window is run on a desktop of its own, so a check can drive
 * the real thing and the user sees nothing at all. This suite checks that the
 * desktop is still a desktop of its own, because that is the whole guarantee.
 *
 * Run with `npm run check:nowindow`.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'tools');
const pkg = require(path.join(ROOT, 'package.json'));

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

/** Every source file under tools/, with the ones that are not checks. */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * The source with its comments taken out.
 *
 * The comments in this repository explain the rules at length, and they use
 * the very words being looked for. A search that read the prose would find
 * "windowsHide" in an explanation of what windowsHide is for and call the
 * rule satisfied.
 */
function code(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const files = walk(TOOLS);

/** Finds the matching close paren for the open paren at `open`. */
function matchParen(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Splits a call's arguments, keeping where each one starts. */
function splitArgs(inner, base) {
  const args = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      args.push({ text: inner.slice(start, i), start: base + start });
      start = i + 1;
    }
  }
  args.push({ text: inner.slice(start), start: base + start });
  return args;
}

const SPAWNERS = ['spawnSync', 'spawn', 'execFileSync', 'execFile', 'execSync', 'exec'];

/**
 * Every call that starts a process, with the options object it was given.
 *
 * The options object is the argument Node actually reads: the third for
 * spawn and execFile, the second for exec and execSync. An object in any
 * other position is not read at all - a flag written there looks like it is
 * there and does nothing, which is worse than not writing it.
 *
 * A trailing comma is the trap. It makes the last argument an empty one, and
 * the options object - which is the one before it - looks like it is not the
 * last thing in the call.
 */
function processCalls(text) {
  const found = [];
  for (const name of SPAWNERS) {
    const re = new RegExp('(?<![\\w$.])' + name + '\\s*\\(', 'g');
    let m;
    while ((m = re.exec(text))) {
      const open = text.indexOf('(', m.index);
      const close = matchParen(text, open);
      if (close === -1) continue;

      const inner = text.slice(open + 1, close).replace(/,\s*$/, '');
      const args = splitArgs(inner, open + 1);
      const optionsAt = (name === 'exec' || name === 'execSync') ? 1 : 2;
      const options = args[optionsAt] ? args[optionsAt].text.trim() : '';

      found.push({
        name,
        line: text.slice(0, m.index).split('\n').length,
        options,
        count: args.length,
        optionsAt,
        whole: text.slice(open + 1, close),
      });
    }
  }
  return found;
}

/**
 * The files a check suite runs.
 *
 * The sweep is what runs on `npm run check:all`, and the live probes are
 * deliberately not in it - they drive the installed app over a debugging port
 * and are run by hand, against a running build.
 */
const LIVE = new Set(['check:live', 'check:paste-live', 'check:imagecopy-live', 'check:sendrace']);
const sweepFiles = new Set();
for (const [name, command] of Object.entries(pkg.scripts)) {
  if (!name.startsWith('check:') || LIVE.has(name)) continue;
  for (const match of String(command).matchAll(/tools[\\/][\w.-]+\.(?:js|mjs|cjs)/g)) {
    sweepFiles.add(match[0].replace(/[\\/]/g, '/'));
  }
}
// The suites are also reached through the runner and the sweep itself.
for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (/-check\.(js|mjs|cjs)$/.test(rel)) sweepFiles.add(rel);
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

add('no tool starts a process without hiding its console', () => {
  // The rule is about every tool, not only the ones in the sweep: a probe
  // that flashes a console window is just as much a window on the user's
  // screen as a suite that does.
  //
  // The options object has to be there, has to be the one Node reads, and has
  // to say so. A call with no options at all is a call that can flash.
  const offenders = [];
  for (const file of files) {
    for (const call of processCalls(code(file))) {
      if (!call.options.startsWith('{')) {
        offenders.push(`${path.relative(ROOT, file)}:${call.line} ${call.name} has no options object`);
        continue;
      }
      // Anything after the options object is an argument Node does not read.
      // A flag written there looks like it is in force and is not.
      if (call.count > call.optionsAt + 1) {
        offenders.push(`${path.relative(ROOT, file)}:${call.line} ${call.name} has an argument after its options, so the options are not the ones it reads`);
        continue;
      }
      if (!/windowsHide\s*:\s*true/.test(call.options)) {
        offenders.push(`${path.relative(ROOT, file)}:${call.line} ${call.name} does not hide its console`);
      }
    }
  }
  if (offenders.length) return offenders.join('; ');
  return true;
});

add('no check suite shows a browser window', () => {
  // A browser window that is shown is a window on the user's screen. The
  // checks that need a window create it with `show: false` and drive it from
  // the renderer, which never needs to be on screen.
  //
  // The tools that do show one - the probes that photograph the taskbar, and
  // the one that takes a screenshot - are run by hand and are not part of the
  // sweep. This says so, rather than trusting it.
  const offenders = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const text = code(file);
    const index = text.indexOf('new BrowserWindow(');
    if (index === -1) continue;

    // The options object of the window.
    const open = text.indexOf('(', index);
    const close = matchParen(text, open);
    const options = close === -1 ? '' : text.slice(open + 1, close);
    if (!/show\s*:\s*true/.test(options)) continue;

    if (sweepFiles.has(rel)) {
      offenders.push(`${rel} shows a window and is part of the sweep`);
    }
  }
  if (offenders.length) return offenders.join('; ');
  return true;
});

add('the tools that do show a window are not run by the sweep', () => {
  // The other half of the rule above: a tool may show a window, but then it
  // must not be something `npm run check:all` reaches.
  const offenders = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const text = code(file);
    if (!/new\s+BrowserWindow\(/.test(text)) continue;
    const index = text.indexOf('new BrowserWindow(');
    const open = text.indexOf('(', index);
    const close = matchParen(text, open);
    const options = close === -1 ? '' : text.slice(open + 1, close);
    if (!/show\s*:\s*true/.test(options)) continue;
    if (sweepFiles.has(rel)) offenders.push(rel);
  }
  if (offenders.length) return offenders.join(', ');
  return true;
});

add('the helper is never run on the desktop the user is looking at', () => {
  // The update helper has a real window, and a check has to drive the real
  // window to find out whether it works. So the check runs it on a desktop of
  // its own - not the one the user is looking at - and this is the check that
  // says so.
  //
  // The rule is that no check starts the helper directly on the user's
  // desktop. There are exactly two ways to start it that are allowed:
  //
  //   - through the runner that gives it a desktop of its own, or
  //   - with --no-window, which does not build a window at all.
  //
  // Anything else - the helper started plainly, with a window, on the
  // desktop the user is looking at - is the bug this whole arrangement
  // exists to prevent.
  const offenders = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (!/-check\.(js|mjs|cjs)$/.test(rel)) continue;
    const text = code(file);

    for (const call of processCalls(text)) {
      // Is this call starting the helper? The executable, not a file that
      // merely has "helper" in its name - tools/build-helper.js is not the
      // helper, it is the thing that builds it.
      const startsHelper = /\bHELPER_EXE\b/.test(call.whole)
        || /BetterBeeper\.UpdateHelper\.exe/.test(call.whole);
      if (!startsHelper) continue;

      // Started through the runner that gives it a desktop of its own.
      if (/PRIVATE_DESKTOP_RUNNER/.test(call.whole)) continue;

      // Or with no window at all. The flag is in the argument list, which may
      // be a variable, so the file is the place to look for it.
      if (/--no-window/.test(text)) continue;

      offenders.push(`${rel}:${call.line} starts the helper on the user's desktop`);
    }
  }
  if (offenders.length) return offenders.join('; ');
  return true;
});

add('the private desktop is a desktop of its own', () => {
  // The guarantee is only as good as the runner. If the runner ever builds
  // the desktop name from anything but the name it was given - "Default", say
  // - then every window in every check goes straight back onto the user's
  // screen.
  //
  // The call is counted, not the declaration of it: the runner declares
  // CreateProcess and calls it, and only the call starts anything.
  const src = code(path.join(TOOLS, 'private-desktop-runner.cs'));
  if (!/CreateDesktop\(/.test(src)) return 'the runner does not make a desktop';
  if ((src.match(/=\s*CreateProcess\s*\(/g) || []).length !== 1) {
    return 'the runner does not start exactly one program';
  }
  if ((src.match(/lpDesktop\s*=/g) || []).length !== 1) {
    return 'the runner does not say where the program runs exactly once';
  }
  if (!/lpDesktop\s*=\s*"WinSta0\\\\"\s*\+\s*desktopName/.test(src)) {
    return 'the runner does not build the desktop name from the name it was given';
  }
  if (/lpDesktop\s*=\s*"WinSta0\\\\Default"/.test(src)) {
    return 'the runner is hard-coded to the desktop the user is looking at';
  }
  return true;
});

add('the helper cannot take the focus while it is off the screen', () => {
  // A window that is off the screen but activated still takes the user's
  // keystrokes. That is worse than a popup: it is a popup that also takes
  // over the keyboard.
  //
  // The off-screen mode therefore says so and stops there, and the real path
  // - the app has gone and the user asked for the update - does put the
  // window in front.
  //
  // The rule is about ComeToFront, which is the method that takes the focus.
  // Looking at the whole file would not do: the off-screen mode is mentioned
  // in several places, and one of them being wrong would hide the one that
  // matters.
  const src = code(path.join(TOOLS, 'update-helper', 'StatusForm.cs'));
  const start = src.indexOf('public void ComeToFront()');
  if (start === -1) return 'the helper has no way to bring the window to the front at all';
  const end = src.indexOf('private void OnTick(', start);
  const body = end === -1 ? src.slice(start) : src.slice(start, end);

  const guard = body.search(/if\s*\(\s*_offscreen\s*\)/);
  if (guard === -1) {
    return 'the off-screen mode is not checked for before the window is brought to the front';
  }
  const activation = body.indexOf('SetForegroundWindow(Handle);');
  if (activation === -1) return 'the window is never put in the foreground at all';
  if (activation < guard) return 'the window is put in the foreground before the off-screen check';

  // And the guard has to actually stop it: a check that returns is what keeps
  // the activation from happening.
  const after = body.slice(guard);
  if (!/return\s*;/.test(after)) {
    return 'the off-screen check does not stop the window from being brought to the front';
  }
  return true;
});

add('the app still starts the helper with a window', () => {
  // The other side of the rule: the private desktop is for checks. A real
  // update is the one moment a window is supposed to appear - the app has
  // gone and the user is waiting - so the app must not use the private
  // desktop and must not ask for the off-screen mode.
  const src = code(path.join(ROOT, 'src', 'main', 'updater.js'));
  if (/private-desktop/i.test(src)) {
    return 'the app runs the helper on a private desktop, so its window would never be seen';
  }
  if (/--offscreen/.test(src)) {
    return 'the app asks for the off-screen mode, so its window would never be seen';
  }
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

console.log(`\n${cases.length - failures}/${cases.length} checks passed`);
process.exit(failures ? 1 : 0);
