/**
 * Red proof for the update handoff checks in check:update.
 *
 * Two bugs are in here, and both survived a green suite:
 *
 *   - the quit after a staged download only quit, so the app closed and nothing
 *     reopened it. Staging writes a marker and a marker is consumed on the next
 *     launch; nothing performed that launch.
 *   - the status window was a batch file opened with `start "... cmd /c ""...""`,
 *     which cmd rejects outright. A check asserted that exact string, so the
 *     window was certified without ever being opened.
 *
 * The second is now a WinExe helper with no console at all, so several of these
 * mutations put the batch path back to prove the checks notice.
 *
 * Every file is restored in a finally, verified by content hash.
 *
 * Run with: node tools/update-redproof.js
 */
const path = require('path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = {
  ipc: path.join(ROOT, 'src', 'main', 'ipc.js'),
  updater: path.join(ROOT, 'src', 'main', 'updater.js'),
  csproj: path.join(ROOT, 'tools', 'update-helper', 'UpdateHelper.csproj'),
  helper: path.join(ROOT, 'tools', 'update-helper', 'Program.cs'),
  form: path.join(ROOT, 'tools', 'update-helper', 'StatusForm.cs'),
  yml: path.join(ROOT, 'electron-builder.yml'),
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
    what: 'the quit handler goes back to a bare app.quit',
    file: 'ipc',
    from: '    updater.quitAndInstall();',
    to: '    setTimeout(() => app.quit(), 150);',
    expect: 'the quit handler goes through the updater, not a bare app.quit',
  },
  {
    what: 'quitAndInstall never starts the install',
    file: 'updater',
    from: '  if (pending && launchInstall(pending, deps)) {',
    to: '  if (false && launchInstall(pending, deps)) {',
    expect: 'quitting with an update staged hands the install off',
  },
  {
    what: 'the app stops telling the helper where to put its window',
    file: 'updater',
    from: "  if (place) args.push('--place', `${place.x},${place.y}`);",
    to: '  // The helper is left to decide where the window goes.',
    expect: 'the app tells the helper where to put its window',
  },
  {
    what: 'the app tells the helper the wrong place',
    file: 'updater',
    from: "  if (place) args.push('--place', `${place.x},${place.y}`);",
    to: "  if (place) args.push('--place', `${place.x},${place.y + 1}`);",
    expect: 'the app tells the helper where to put its window',
  },
  {
    what: 'the handoff is spawned through cmd again',
    file: 'updater',
    from: '    const child = spawnProcess(helper, args, {',
    to: "    const child = spawnProcess('cmd.exe', ['/c', helper, ...args], {",
    expect: 'what is spawned is the helper, not a shell',
  },
  {
    what: 'the helper is not told which process to wait for',
    file: 'updater',
    from: "    '--pid', String(parentPid),\n",
    to: '',
    expect: 'the helper is told which process to wait for',
  },
  {
    what: 'the helper is not told where to record the outcome',
    file: 'updater',
    from: "    '--result', result,\n",
    to: '',
    expect: 'the helper is told where to record the outcome',
  },
  {
    what: 'the staged marker is never consumed',
    file: 'updater',
    from: '  if (pending && launchInstall(pending, deps)) {\n    clearPending();',
    to: '  if (pending && launchInstall(pending, deps)) {',
    expect: 'the staged marker is consumed so it cannot install twice',
  },
  {
    what: 'quitting with nothing staged still hands over',
    file: 'updater',
    from: '  const pending = readPending();\n  if (pending && launchInstall(pending, deps)) {',
    to: '  const pending = readPending() || { installer: process.execPath, relaunch: process.execPath };\n  if (pending && launchInstall(pending, deps)) {',
    expect: 'quitting with nothing staged is an ordinary quit',
  },
  {
    what: 'the helper is built as a console app',
    file: 'csproj',
    from: '<OutputType>WinExe</OutputType>',
    to: '<OutputType>Exe</OutputType>',
    expect: 'the handoff is a program, and it is a WinExe',
  },
  {
    what: 'the helper goes back to bundling a whole runtime',
    file: 'csproj',
    from: '<TargetFramework>net48</TargetFramework>',
    to: '<TargetFramework>net8.0-windows</TargetFramework>\n    <RuntimeIdentifier>win-x64</RuntimeIdentifier>\n    <SelfContained>true</SelfContained>',
    expect: 'the handoff targets the framework Windows already ships',
  },
  {
    what: 'the helper installs before the app has released its files',
    file: 'helper',
    from: `            if (!ReleaseAppFiles(options.RelaunchPath, options.ReleaseTimeoutSeconds))
            {
                state.Detail = "Something is still holding Better Beeper's files. Restart Windows to use "
                    + "Better Beeper again.";
                trace.Write("files-held");
                return ResultCodes.FilesHeld;
            }`,
    to: '            // The install is attempted whatever is holding the app\'s files.',
    expect: 'the helper waits for the app to go before installing',
  },
  {
    what: 'the helper never restarts the app',
    file: 'helper',
    from: '            string why;\n            if (!TryRelaunch(options, out why))',
    to: '            string why;\n            why = "The app was not started again.";\n            if (false)',
    expect: 'the helper starts the app again afterwards',
  },
  {
    what: 'the helper stops recording the outcome',
    file: 'helper',
    from: `            // the 1.28.8 wedge invisible - the result existed, but not yet.
            WriteResult(options, code, detail);`,
    to: `            // the 1.28.8 wedge invisible - the result existed, but not yet.`,
    expect: 'the helper records how the install went',
  },
  {
    what: 'the helper is not shipped with the app',
    file: 'yml',
    from: 'extraResources:\n  - from: build/update-helper\n    to: update-helper\n    filter:\n      - "**/*"',
    to: 'extraResources: []',
    expect: 'the helper ships with the app, outside the asar',
  },
  {
    what: 'the batch machinery is put back',
    file: 'updater',
    from: 'function launchInstall(pending,',
    to: 'function installScript() { return "@echo off"; }\r\n\r\nfunction launchInstall(pending,',
    expect: 'the updater writes no script at all',
  },
  {
    what: 'the window is not draggable',
    file: 'form',
    from: '            if (ReleaseCapture())\n            {\n                SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);\n            }',
    to: '            // drag removed',
    expect: 'the status window can be moved out of the way',
  },
  {
    what: 'only the bare background drags, not the labels',
    file: 'form',
    from: '            title.MouseDown += DragFrom;\n            _status.MouseDown += DragFrom;\n            _elapsed.MouseDown += DragFrom;\n            _warning.MouseDown += DragFrom;\n',
    to: '',
    expect: 'the status window can be moved out of the way',
  },
  {
    // The window must not be in front of everything from the moment it opens:
    // the app is still on the screen then, and a window that demands the front
    // of the desktop for its whole life is a window someone cannot get out of
    // the way of.
    what: 'the window insists on staying on top from the start',
    file: 'form',
    from: '            StartPosition = FormStartPosition.Manual;\n            ClientSize = new Size(470, 250);',
    to: '            TopMost = true;\n            StartPosition = FormStartPosition.Manual;\n            ClientSize = new Size(470, 250);',
    expect: 'the status window comes to the front when the app has gone, and lets go of it when it is done',
  },
  {
    // The other half of the same rule: the window has to be put in front when
    // the app has gone. Without this it is activated while the app is still
    // in the foreground, which is the one moment it cannot be seen.
    what: 'the window is never put in front of anything',
    file: 'form',
    from: '                TopMost = true;\n                Show();',
    to: '                Show();',
    expect: 'the status window comes to the front when the app has gone, and lets go of it when it is done',
  },
  {
    // And it has to let go of the front when the install is done, or it is
    // still there over the app that comes back.
    what: 'the window never gives up the front of the screen',
    file: 'form',
    from: '                TopMost = false;',
    to: '                // the window keeps the front',
    expect: 'the status window comes to the front when the app has gone, and lets go of it when it is done',
  },
  {
    // The empty console windows that were reported after an interrupted update
    // were the old status window: a batch file opened with `start`, which is a
    // console window by construction and which closed itself only when the
    // update finished. The batch files are long gone. These four mutations
    // put the ability to have a console back, one piece at a time, so the
    // checks that say it cannot happen are known to be load-bearing.
    what: 'the helper is started without the console hidden',
    file: 'updater',
    from: '      windowsHide: true,\n',
    to: '',
    expect: 'the helper is started with the console hidden',
  },
  {
    what: 'the installer is started in a way that can give it a console',
    file: 'helper',
    from: '                CreateNoWindow = true,',
    to: '                CreateNoWindow = false,',
    expect: 'the installer is started without a console',
  },
  {
    what: 'the installer is started through the shell',
    file: 'helper',
    from: '                UseShellExecute = false,',
    to: '                UseShellExecute = true,',
    expect: 'the installer is started without a console',
  },
  {
    // Not in the updater: the rule is about the app. The check beside it only
    // ever looked at updater.js, which is why this one goes somewhere else.
    what: 'a batch file is used somewhere else in the app',
    file: 'ipc',
    from: "const { ipcMain, dialog, shell, app, BrowserWindow, clipboard, nativeImage } = require('electron');",
    to: "const { ipcMain, dialog, shell, app, BrowserWindow, clipboard, nativeImage } = require('electron');\nconst statusScript = 'update-status.cmd';",
    expect: 'nothing in the app runs a batch file',
  },
];

function runCheck() {
  try {
    const out = execFileSync('npm', ['run', 'check:update', '--silent'], { windowsHide: true,
      cwd: ROOT, encoding: 'utf8', timeout: 300000, shell: true,
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
//
// A harness that prints a baseline and moves on is trusting it, and a
// mutation can then be reported as "caught" against a case that was already
// failing - a false catch, and a proof that looked green for the wrong
// reason. So the baseline has to be N/N, and every named case has to be PASS
// in it, or this refuses to run.
const baselineRun = runCheck();
const baselineCount = baselineRun.out.match(/(\d+)\/(\d+) checks passed/);

if (!baselineCount) {
  console.log('the check suite did not report a count - it died before printing one');
  console.log(baselineRun.out.split(/\r?\n/).slice(-8).join('\n'));
  process.exit(1);
}

if (baselineCount[1] !== baselineCount[2]) {
  console.log(`the baseline is not green: ${baselineCount[1]}/${baselineCount[2]}`);
  console.log(baselineRun.out.split(/\r?\n/).filter((l) => l.trim().startsWith('FAIL')).join('\n'));
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