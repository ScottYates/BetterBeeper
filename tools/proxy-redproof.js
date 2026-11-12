/**
 * Red proof for the proxy checks in check:proxy.
 *
 * The TLS warning this work fixed - `net_error -202`, a certificate whose chain
 * was issued by an authority that is not trusted - was not the GitHub call
 * failing. It was Chromium's proxy auto-discovery: it fetches
 * `http://wpad/wpad.dat`, follows the redirect to a host that answers with
 * YunoHost's default self-signed certificate, and the handshake fails. The fix
 * is to stop the search.
 *
 * A check that says "no proxy lookup happened" is only worth something if it
 * can see one when there is one, so the suite runs the probe twice: once with
 * the app's policy and once without. The mutations below take each of those
 * apart in turn, and the control - the run without the policy - is mutated
 * too, because a control that cannot fail is not a control.
 *
 * Every file is restored in a finally, verified by content hash, and the
 * baseline is asserted before anything is mutated: a mutation "caught" against
 * a case that was already red proves nothing.
 *
 * Run with: node tools/proxy-redproof.js
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = {
  policy: path.join(ROOT, 'src', 'main', 'proxy-config.js'),
  main: path.join(ROOT, 'src', 'main', 'main.js'),
  probe: path.join(ROOT, 'tools', 'proxy-probe', 'main.js'),
};

const SUITE = 'check:proxy';

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
    // The policy stops doing anything. This is the regression the whole thing
    // exists to catch: the proxy lookup comes back, and with it the
    // certificate failure.
    what: 'the proxy policy does nothing',
    file: 'policy',
    from: "  commandLine.appendSwitch('proxy-server', DIRECT);",
    to: '  // the policy was removed',
    expect: 'Chromium does not go looking for a proxy',
  },
  {
    // The switch is set, but to a proxy rather than to no proxy. The lookup
    // would not come back - Chromium would be told where to send things - but
    // the app would be using a proxy it never asked for, and the policy would
    // be a lie.
    what: 'the policy points Chromium at a proxy',
    file: 'policy',
    from: "const DIRECT = 'direct://';",
    to: "const DIRECT = 'http://proxy.invalid:8080';",
    expect: 'the proxy policy sends Chromium straight out',
  },
  {
    // The app stops asking for the policy at all. The module is still there,
    // still correct, and doing nothing.
    what: 'the app never applies the policy',
    file: 'main',
    from: 'applyProxyPolicy(app.commandLine);\n',
    to: '',
    expect: 'the app applies the proxy policy before the window exists',
  },
  {
    // Applied, but too late. A switch set after the network stack has started
    // is accepted by Electron and ignored by Chromium, which is the worst of
    // both: it looks like it worked.
    what: 'the policy is applied after the app is ready',
    file: 'main',
    from: 'applyProxyPolicy(app.commandLine);',
    to: 'app.whenReady().then(() => applyProxyPolicy(app.commandLine));',
    expect: 'the app applies the proxy policy before the window exists',
  },
  {
    // The control. The probe applies the policy even when it is told not to,
    // so the run without the policy looks exactly like the run with it, and
    // the control cannot fail. This is what makes the control worth having.
    what: 'the probe applies the policy even when told not to',
    file: 'probe',
    from: "if (!process.argv.includes('--no-policy')) {",
    to: 'if (true) {',
    expect: 'the check can see a proxy lookup when there is one',
  },
];

function runCheck() {
  try {
    const out = execFileSync('npm.cmd', ['run', SUITE, '--silent'], {
      cwd: ROOT, encoding: 'utf8', timeout: 600000, shell: true, windowsHide: true,
    });
    return { code: 0, out };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      out: String(err.stdout || '') + String(err.stderr || ''),
    };
  }
}

/** The verdict for the one named check, ignoring every other line. */
function verdictFor(out, name) {
  for (const line of out.split(/\r?\n/)) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!clean.startsWith('PASS') && !clean.startsWith('FAIL')) continue;
    const rest = clean.slice(5).trim();
    const detail = rest.indexOf('  (');
    const printed = detail === -1 ? rest : rest.slice(0, detail);
    if (printed === name) return clean.startsWith('FAIL') ? 'FAIL' : 'PASS';
  }
  return null;
}

const before = {};
for (const [k, p] of Object.entries(FILES)) before[k] = hash(p);

const holes = [];

// ---------------------------------------------------------------------------
// The baseline
//
// A mutation "caught" against a case that was already red proves nothing, so
// the baseline has to be green and every named case has to be in it, PASS.
// ---------------------------------------------------------------------------

const { code, out } = runCheck();
const counts = out.match(/(\d+)\/(\d+) checks passed/);
if (!counts) {
  console.log(`BASELINE FAILED  ${SUITE}\n      the suite did not print a count`);
  process.exit(1);
}
if (code !== 0 || counts[1] !== counts[2]) {
  console.log(`BASELINE FAILED  ${SUITE}\n      it printed ${counts[1]}/${counts[2]} checks passed`);
  process.exit(1);
}
console.log(`baseline  ${SUITE}  ${counts[1]}/${counts[2]} checks passed`);

for (const m of MUTATIONS) {
  const verdict = verdictFor(out, m.expect);
  if (verdict === 'PASS') continue;
  holes.push(`${m.what} -- "${m.expect}" is ${verdict === null ? 'not in the baseline' : verdict}`);
  console.log(`HOLE  ${m.what}\n      "${m.expect}" is ${verdict === null ? 'not in the baseline' : 'already ' + verdict}`);
}

if (holes.length) {
  console.log('\nThe baseline does not prove these mutations, so the proof cannot run.');
  process.exit(1);
}
console.log('');

let caught = 0;
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

    const run = runCheck();
    const verdict = verdictFor(run.out, m.expect);
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

// Every file the proof touched has to be back where it started, not just the
// one the last mutation happened to be in.
for (const [k, p] of Object.entries(FILES)) {
  if (hash(p) !== before[k]) {
    console.log(`\nRESTORE FAILED for ${path.basename(p)}`);
    process.exit(1);
  }
}

console.log(`\n${caught}/${MUTATIONS.length} mutations caught by the check they were written for`);
if (holes.length) {
  console.log('\nHoles:');
  for (const h of holes) console.log(`  - ${h}`);
  process.exit(1);
}
process.exit(0);
