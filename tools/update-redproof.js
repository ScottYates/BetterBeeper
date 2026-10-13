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
    from: '            WaitForProcessExit(options.ParentPid);\n            WaitForFileFree(options.RelaunchPath);',
    to: '            WaitForProcessExit(options.ParentPid);',
    expect: 'the helper waits for the app to go before installing',
  },
  {
    what: 'the helper never restarts the app',
    file: 'helper',
    from: '            if (state.Ok && options.RelaunchPath is not null)\n            {\n                StartRelaunch(options.RelaunchPath);\n            }\n',
    to: '',
    expect: 'the helper starts the app again afterwards',
  },
  {
    what: 'the helper stops recording the outcome',
    file: 'helper',
    from: '            WriteResult(options, state.ExitCode, state.Detail);\n',
    to: '',
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
    what: 'the window insists on staying on top',
    file: 'form',
    from: '            StartPosition = FormStartPosition.CenterScreen;',
    to: '            TopMost = true;\n            StartPosition = FormStartPosition.CenterScreen;',
    expect: 'the status window does not force itself to the top',
  },
];

function runCheck() {
  try {
    const out = execFileSync('npm', ['run', 'check:update', '--silent'], {
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
console.log(`baseline: ${runCheck().out.match(/(\d+\/\d+) checks passed/)?.[1] || '?'}\n`);

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
    if (verdict === null) {
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