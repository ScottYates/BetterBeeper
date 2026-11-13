/**
 * The red proof for the update handoff's two promises.
 *
 * A check that is green proves nothing on its own. What matters is that each
 * rule here is load-bearing: that breaking it turns the check it was written
 * for red. That is what this does - it breaks each rule in turn and requires
 * the named check to catch it.
 *
 * The baseline is asserted, not printed and trusted. A harness that prints a
 * baseline and moves on is trusting it, and a mutation can then be reported
 * as "caught" against a case that was already failing - a false catch, and a
 * proof that looked green for the wrong reason. So the baseline has to be the
 * same number of cases as every later run, and every named case has to be
 * PASS in it, or this refuses to run at all.
 *
 * Run with `node tools/update-handoff-redproof.js`.
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = {
  updater: path.join(ROOT, 'src', 'main', 'updater.js'),
  helper: path.join(ROOT, 'tools', 'update-helper', 'Program.cs'),
  form: path.join(ROOT, 'tools', 'update-helper', 'StatusForm.cs'),
  nsis: path.join(ROOT, 'tools', 'nsis', 'installer.nsh'),
  builder: path.join(ROOT, 'electron-builder.yml'),
  runner: path.join(ROOT, 'tools', 'private-desktop-runner.cs'),
};

const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function applyEdit(original, from, to) {
  for (const pattern of [from, from.replace(/\n/g, '\r\n')]) {
    if (pattern !== from && !original.includes('\r\n')) continue;
    const count = original.split(pattern).length - 1;
    if (count === 1) return { ok: true, text: original.replace(pattern, to) };
    if (count > 1) return { ok: false, why: 'pattern appears ' + count + ' times' };
  }
  return { ok: false, why: 'pattern not found' };
}

const MUTATIONS = [
  {
    what: 'the update uninstalls the old version again',
    file: 'nsis',
    from: `  SetErrorLevel 0
  Quit`,
    to: `  ; The old version is uninstalled as usual.`,
    expect: 'the script makes the old uninstaller give up',
  },
  {
    what: 'the installer script is not included',
    file: 'builder',
    from: '  include: tools/nsis/installer.nsh',
    to: '  # include: tools/nsis/installer.nsh',
    expect: 'the installer includes the script that installs over the top',
  },
  {
    what: 'the window is never built',
    file: 'helper',
    from: `            using (var form = new StatusForm(state, trace, options.Offscreen, options.Place))
            {
                form.Pump();
            }`,
    to: `            // The window is never built, so there is nothing to see.`,
    expect: 'the helper puts a window up',
  },
  {
    what: 'the window is built but never shown',
    file: 'form',
    from: '            Application.Run(this);',
    to: '            Application.Run();',
    expect: 'the window is visible',
  },
  {
    what: 'the update writes into the pinned items folder',
    file: 'helper',
    from: `            if (!options.NoWindow)
            {
                TaskbarPin.Inspect(options.ShortcutPath, options.PinFolder, trace);
            }`,
    to: `            if (!options.NoWindow)
            {
                TaskbarPin.Inspect(options.ShortcutPath, options.PinFolder, trace);
                if (!string.IsNullOrEmpty(options.PinFolder))
                {
                    System.IO.Directory.CreateDirectory(options.PinFolder);
                    System.IO.File.Copy(options.ShortcutPath, System.IO.Path.Combine(options.PinFolder, "Better Beeper.lnk"), true);
                }
            }`,
    expect: 'the update does not touch the taskbar pin',
  },
  {
    what: 'the installer is not told it is an update',
    file: 'helper',
    from: '                Arguments = "/S --updated",',
    to: '                Arguments = "/S",',
    expect: 'the installer is told this is an update',
  },
  {
    what: 'the window is made transparent again',
    file: 'form',
    from: `                StartPosition = FormStartPosition.Manual;
                ShowInTaskbar = false;`,
    to: `                StartPosition = FormStartPosition.Manual;
                ShowInTaskbar = false;
                Opacity = 0.0;`,
    expect: 'the window is not transparent',
  },
  {
    what: 'the window is never brought to the front',
    file: 'form',
    from: `                Volatile.Write(ref _state.BringToFront, 0);
                ComeToFront();`,
    to: '                Volatile.Write(ref _state.BringToFront, 0);',
    expect: 'the window is put in front once the app has gone',
  },
  {
    // The opposite failure, and the one that was measured: a test that takes
    // the focus away from the user. The window is off the screen, so there is
    // nothing to see - but it would still swallow the user's keystrokes.
    what: 'a test takes the focus from the user',
    file: 'form',
    from: `                if (_offscreen)
                {
                    // A check must never take the focus.`,
    to: `                if (false)
                {
                    // A check must never take the focus.`,
    expect: 'a test never takes the focus from the user',
  },
  {
    // The rule the user asked for: never pop up a window. Ever.
    //
    // The runner gives the helper a desktop of its own, so every window the
    // helper creates is on a desktop Windows does not draw. Point the runner
    // at the desktop the user is looking at and that guarantee is gone - and
    // the trace says so, which is what this case reads.
    what: 'the helper is run on the desktop the user is looking at',
    file: 'runner',
    from: 'startup.lpDesktop = "WinSta0\\\\" + desktopName;',
    to: 'startup.lpDesktop = "WinSta0\\\\Default";',
    expect: 'a check never puts a window on the desktop the user is looking at',
  },
  {
    // The other half of the same guarantee: the desktop has to be the one
    // the run was given, not one the runner decided on. A hard-coded name
    // would still be a private desktop - and still not the one the check
    // asked for, so the check would be measuring the wrong run.
    what: 'the runner decides the desktop for itself',
    file: 'runner',
    from: 'startup.lpDesktop = "WinSta0\\\\" + desktopName;',
    to: 'startup.lpDesktop = "WinSta0\\\\" + "bb-fixed";',
    expect: "the runner cannot be pointed at the user's desktop by accident",
  },
  {
    what: 'the helper runs from the install folder again',
    file: 'updater',
    from: `function helperRunPath() {
  const base = process.env.LOCALAPPDATA || app.getPath('appData');
  return path.join(base, 'Better Beeper', 'update-helper', HELPER_EXE);
}`,
    to: `function helperRunPath() {
  return helperPath();
}`,
    expect: 'the helper is run from outside the install folder',
  },
  {
    what: 'the helper is run from where it shipped',
    file: 'updater',
    from: '    return target;',
    to: '    return source;',
    expect: 'the app copies the helper somewhere safe before it runs it',
  },
  {
    what: 'the helper is not asked to leave a trace',
    file: 'updater',
    from: `    // The helper writes down what it did as it does it. The window is the
    // part of this that has no other evidence: the app is gone while the
    // install runs, and "the window showed" was an assumption until the
    // helper started saying so.
    '--trace', helperTracePath(),
`,
    to: '',
    expect: 'the helper is asked to leave a trace',
  },
  {
    what: 'the trace is written somewhere the app will not look',
    file: 'updater',
    from: "const HELPER_TRACE_FILE = 'update-helper-trace.txt';",
    to: "const HELPER_TRACE_FILE = 'somewhere-else.txt';",
    expect: 'the trace is written where the app can find it',
  },
];

function runCheck() {
  try {
    const out = execFileSync('npm', ['run', 'check:handoff', '--silent'], { windowsHide: true,
      cwd: ROOT, encoding: 'utf8', timeout: 600000, shell: true,
    });
    return { code: 0, out };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      out: String(err.stdout || '') + String(err.stderr || ''),
    };
  }
}

function verdictFor(out, name) {
  for (const line of out.split(/\r?\n/)) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!clean.startsWith('PASS') && !clean.startsWith('FAIL')) continue;
    const rest = clean.slice(5).trim();
    const detail = rest.indexOf('  [');
    const printed = detail === -1 ? rest : rest.slice(0, detail);
    if (printed === name) return clean.startsWith('FAIL') ? 'FAIL' : 'PASS';
  }
  return null;
}

const before = {};
for (const [k, p] of Object.entries(FILES)) before[k] = hash(p);

let caught = 0;
const holes = [];

// The baseline is asserted, not printed and trusted.
console.log('running the baseline...');
const baselineRun = runCheck();
const baselineCount = baselineRun.out.match(/(\d+)\/(\d+) checks passed/);
if (!baselineCount) {
  console.log('the baseline did not report a count');
  console.log(baselineRun.out.split(/\r?\n/).slice(-20).join('\n'));
  process.exit(1);
}

const namedCases = [...new Set(MUTATIONS.map((m) => m.expect))];
const notGreen = namedCases.filter((name) => verdictFor(baselineRun.out, name) !== 'PASS');
if (notGreen.length) {
  console.log('these named cases are not green in the baseline, so a mutation could not be caught by them:');
  for (const name of notGreen) console.log(`  - ${name}`);
  process.exit(1);
}

console.log(`baseline: ${baselineCount[1]}/${baselineCount[2]} checks passed, ${namedCases.length} named cases green\n`);

for (const m of MUTATIONS) {
  const target = FILES[m.file];
  const original = fs.readFileSync(target, 'utf8');
  let applied = false;
  try {
    const edit = applyEdit(original, m.from, m.to);
    if (!edit.ok) {
      holes.push(`${m.what} -- ${edit.why}`);
      console.log(`SKIP  ${m.what}\n      ${edit.why}`);
      continue;
    }
    fs.writeFileSync(target, edit.text, 'utf8');
    applied = true;

    const { out } = runCheck();
    const verdict = verdictFor(out, m.expect);
    const after = out.match(/(\d+)\/(\d+) checks passed/);

    if (!after) {
      holes.push(`${m.what} -- the suite did not report a count`);
      console.log(`HOLE  ${m.what}\n      the suite died before printing a count`);
    } else if (after[2] !== baselineCount[2]) {
      holes.push(`${m.what} -- the suite reported ${after[2]} cases, not ${baselineCount[2]}`);
      console.log(`HOLE  ${m.what}\n      the suite lost cases: ${after[2]} instead of ${baselineCount[2]}`);
    } else if (verdict === null) {
      holes.push(`${m.what} -- "${m.expect}" never printed`);
      console.log(`HOLE  ${m.what}\n      the named check never printed`);
    } else if (verdict === 'FAIL') {
      caught++;
      console.log(`RED   ${m.what}\n      "${m.expect}" failed as it should`);
    } else {
      holes.push(`${m.what} -- "${m.expect}" stayed green`);
      console.log(`HOLE  ${m.what}\n      "${m.expect}" stayed green`);
    }
  } finally {
    if (applied) fs.writeFileSync(target, original, 'utf8');
    const now = hash(target);
    if (now !== before[m.file]) {
      console.log(`\nRESTORE FAILED for ${path.basename(target)}`);
      process.exit(1);
    }
  }
}

console.log(`\n${caught}/${MUTATIONS.length} mutations caught by the check they were written for`);
if (holes.length) {
  console.log('\nHoles (the rule is not actually load-bearing):');
  for (const h of holes) console.log(`  - ${h}`);
  process.exit(1);
}
process.exit(0);
