/**
 * Red proof for the quit-hands-off-to-the-install checks in check:update.
 *
 * The bug this was written for: staging a download wrote a marker, the marker
 * was consumed on the next launch, and the quit in between did nothing except
 * quit. The app closed and stayed closed, and the status window never appeared
 * because the script that opens it is written by the launch-time apply.
 *
 * Two halves, and both are mutated here. Reverting only ipc.js leaves every
 * behavioural check green, because they drive quitAndInstall() directly - so the
 * wiring is guarded by a source assertion on the handler itself, and that
 * assertion has to be proven too or it is decoration.
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
    from: '  if (pending && launchInstall(pending, { spawnProcess })) {',
    to: '  if (false && launchInstall(pending, { spawnProcess })) {',
    expect: 'quitting with an update staged hands the install off',
  },
  {
    what: 'the status window script is not written',
    file: 'updater',
    from: '    fs.writeFileSync(statusPath, statusWindowScript(runningFlag), \'utf8\');',
    to: '',
    expect: 'the status window the user was promised is written too',
  },
  {
    what: 'the running flag is not written',
    file: 'updater',
    from: '    fs.writeFileSync(runningFlag, String(Date.now()), \'utf8\');',
    to: '',
    expect: 'the running flag is written before the window can check for it',
  },
  {
    what: 'the staged marker is never consumed',
    file: 'updater',
    from: '  const pending = readPending();\n  if (pending && launchInstall(pending, { spawnProcess })) {\n    clearPending();',
    to: '  const pending = readPending();\n  if (pending && launchInstall(pending, { spawnProcess })) {',
    expect: 'the staged marker is consumed so it cannot install twice',
  },
  {
    what: 'the apply script is spawned by something other than the script on disk',
    file: 'updater',
    from: "    const child = spawnProcess('cmd.exe', ['/v:on', '/c', scriptPath], {",
    to: "    const child = spawnProcess('cmd.exe', ['/v:on', '/c', 'update.cmd'], {",
    expect: 'the spawned command is the apply script on disk',
  },
  {
    what: 'a missing installer is launched anyway',
    file: 'updater',
    from: '  if (!installer || !fs.existsSync(installer)) return false;',
    to: '  if (!installer) return false;',
    expect: 'an installer that has gone does not stop the app from quitting',
  },
  {
    what: 'quitting with nothing staged still writes an install script',
    file: 'updater',
    from: '  const pending = readPending();\n  if (pending && launchInstall(pending, { spawnProcess })) {',
    to: '  const pending = readPending() || { installer: process.execPath, relaunch: process.execPath };\n  if (pending && launchInstall(pending, { spawnProcess })) {',
    expect: 'quitting with nothing staged is an ordinary quit',
  },
  {
    what: 'the status window goes back through cmd /c with doubled quotes',
    file: 'updater',
    from: '`if exist "${statusScript}" start "Better Beeper Update" "${statusScript}"\\r\\n`',
    to: '`if exist "${statusScript}" start "Better Beeper Update" cmd.exe /v:on /c ""${statusScript}""\\r\\n`',
    expect: 'the status window line is one cmd can actually parse',
  },
  {
    what: 'the status window is never opened at all',
    file: 'updater',
    from: '  const showStatus = statusScript\n    ? `if exist "${statusScript}" start "Better Beeper Update" "${statusScript}"\\r\\n`\n    : \'\';',
    to: '  const showStatus = \'\';',
    expect: 'the apply script opens a status window while it installs',
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