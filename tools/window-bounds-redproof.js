/**
 * The red proof for the window's place.
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
 * Run with `node tools/window-bounds-redproof.js`.
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = {
  bounds: path.join(ROOT, 'src', 'main', 'window-bounds.js'),
  main: path.join(ROOT, 'src', 'main', 'main.js'),
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

const RECT = '  const rect = { x: Math.round(x), y: Math.round(y), width, height };';

const MUTATIONS = [
  {
    what: 'the position is clamped into the work area again',
    file: 'bounds',
    from: RECT,
    to: '  const rect = { x: Math.round(Math.min(Math.max(x, area.x), area.x + area.width - width)), y: Math.round(Math.min(Math.max(y, area.y), area.y + area.height - height)), width, height };',
    expect: 'a window closed 30px past the right edge comes back exactly',
  },
  {
    what: 'the taskbar clamp comes back',
    file: 'bounds',
    from: RECT,
    to: '  const rect = { x: Math.round(x), y: Math.round(Math.min(Math.max(y, area.y), area.y + area.height - height)), width, height };',
    expect: 'a window closed over the taskbar comes back exactly',
  },
  {
    what: 'the position is off by a pixel',
    file: 'bounds',
    from: RECT,
    to: '  const rect = { x: Math.round(x) + 1, y: Math.round(y), width, height };',
    expect: 'a window closed in the middle comes back exactly',
  },
  {
    what: 'the size is fitted to the display again',
    file: 'bounds',
    from: '  const width = Number.isFinite(savedWidth) && savedWidth > 0 ? Math.max(minWidth, savedWidth) : area.width;',
    to: '  const width = Math.max(minWidth, Math.min(savedWidth || area.width, area.width));',
    expect: 'a window wider than its display keeps its size',
  },
  {
    what: 'a window whose display has gone is not rescued',
    file: 'bounds',
    from: '  if (touchesADisplay(displays, rect)) return rect;',
    to: '  if (true) return rect;',
    expect: 'a window whose display has gone is brought back onto a display',
  },
  {
    what: 'the rescue leaves the window in the void',
    file: 'bounds',
    from: '    x: Math.round(fa.x + Math.max(0, (fa.width - fw) / 2)),',
    to: '    x: Math.round(fa.x + fa.width + 50),',
    expect: 'a window whose display has gone is not left in the void',
  },
  {
    what: 'the app stops asking the module',
    file: 'main',
    from: `    return (
      resolveWindowBounds(saved, displays, { minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT }) || {}
    );`,
    to: '    return { x: saved.x, y: saved.y, width: saved.width, height: saved.height };',
    expect: 'the app asks the geometry module where to put the window',
  },
  {
    what: 'a minimized window is remembered',
    file: 'bounds',
    from: '    if (win.isMinimized() || win.isFullScreen()) return null;',
    to: '    if (false) return null;',
    expect: 'a minimized window is not remembered',
  },
  {
    what: 'the window is not remembered when it closes',
    file: 'main',
    from: `  mainWindow.on('close', () => {
    clearTimeout(boundsTimer);
    saveBounds();
  });`,
    to: '  // The window is not remembered when it closes.',
    expect: 'the window is remembered when it closes',
  },
];

function runCheck() {
  try {
    const out = execFileSync('npm', ['run', 'check:windowbounds', '--silent'], { windowsHide: true,
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
