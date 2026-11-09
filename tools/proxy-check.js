/**
 * Dev check: Chromium does not go looking for a proxy.
 *
 * The app has no use for a proxy, and Chromium's search for one was not free.
 * The proxy auto-discovery fetches `http://wpad/wpad.dat`; where that leads
 * on this machine is a redirect to a host whose certificate does not cover the
 * name it was asked for, and the handshake fails with `net_error -202`
 * (`ERR_CERT_ALT_NAME_INVALID`). That failure is what was reported as a TLS
 * warning in the app's log. It was never the GitHub call - api.github.com
 * serves a certificate for itself and was never involved.
 *
 * So this is checked by measurement rather than by reading the source. The
 * probe (tools/proxy-probe) starts Electron with a net log, and the log is
 * read afterwards:
 *
 *   - the app's policy applied   no mention of a proxy lookup, no bad cert
 *   - the policy left off        a proxy lookup, and the certificate failure
 *
 * The second run is the one that makes the first mean anything. "No proxy
 * lookup happened" is also what a Chromium that never looks would produce, on
 * a machine where the lookup would have failed anyway - a check that cannot
 * see the problem reports a pass and proves nothing. So the control run has
 * to show the lookup, and if it does not, this check says so rather than
 * passing quietly.
 *
 * Run with `npm run check:proxy`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'tools', 'proxy-probe');
const WORK = path.join(ROOT, 'build', 'proxy-check');
const MAIN = path.join(ROOT, 'src', 'main', 'main.js');
const POLICY = path.join(ROOT, 'src', 'main', 'proxy-config.js');

const { applyProxyPolicy, DIRECT } = require(POLICY);

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

/**
 * The Electron binary, without being an Electron app.
 *
 * `require('electron')` is the path to the executable when this is plain Node,
 * and the module itself when it is not. Only the first is wanted here.
 */
function electronBinary() {
  const fromPackage = require('electron');
  if (typeof fromPackage === 'string' && fs.existsSync(fromPackage)) return fromPackage;
  const guess = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  return fs.existsSync(guess) ? guess : null;
}

/**
 * Start the probe with a net log and read what Chromium put in it.
 *
 * The window the probe opens is hidden, and the process quits on its own, so
 * nothing reaches the desktop and nothing has to be killed.
 */
function runProbe(label, extraArgs) {
  const log = path.join(WORK, `${label}.json`);
  fs.mkdirSync(WORK, { recursive: true });
  if (fs.existsSync(log)) fs.rmSync(log);

  const binary = electronBinary();
  if (!binary) return { error: 'the Electron binary is not installed' };

  const args = [
    `--log-net-log=${log}`,
    ...extraArgs,
    PROBE,
  ];
  const run = spawnSync(binary, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    // Nothing here may put a console on the desktop.
    windowsHide: true,
  });

  if (run.error) return { error: `the probe did not run: ${run.error.message}` };
  if (!fs.existsSync(log)) {
    return { error: `the probe wrote no net log (exit ${run.status})` };
  }

  const text = fs.readFileSync(log, 'utf8');
  // The proxy lookup is a request to a host called "wpad": Chromium fetches
  // http://wpad/wpad.dat to see whether there is a proxy to use.
  //
  // Matched as a URL host on purpose. The net log's own table of constants
  // carries names like WPAD_DHCP_WIN_FETCH in every log it ever writes, so a
  // search for the word "wpad" finds those and reports a lookup that never
  // happened - which is how this check first failed against a log that was
  // clean.
  const lookups = (text.match(/https?:\/\/wpad[/:"]/gi) || []).length;
  const badCerts = (text.match(/"net_error":\s*-202/g) || []).length;

  // The log is kept until the cases have been judged, and thrown away only if
  // they passed. A failed run leaves its evidence behind.
  return { lookups, badCerts, log };
}

console.log('running the proxy probe (about ten seconds)...');
const fixed = runProbe('fixed', []);
const control = runProbe('control', ['--no-policy']);

// ---- the policy itself -----------------------------------------------------

add('the proxy policy sends Chromium straight out', () => {
  // The switch, not a comment about it. `direct://` is Chromium's spelling of
  // "no proxy": a host called "direct" would be a different thing entirely,
  // and would fail in a way that looks like a network problem.
  const switches = [];
  const recorded = { appendSwitch: (name, value) => switches.push([name, value]) };
  applyProxyPolicy(recorded);
  const hit = switches.find(([name]) => name === 'proxy-server');
  if (!hit) return 'the policy does not set a proxy server';
  if (hit[1] !== DIRECT) return `the proxy server is "${hit[1]}", not "${DIRECT}"`;
  if (DIRECT !== 'direct://') return `the policy spells direct as "${DIRECT}"`;
  return true;
});

add('the app applies the proxy policy before the window exists', () => {
  // The switch is read when Chromium's network stack starts. Set after that,
  // Electron accepts it and Chromium ignores it - so the call site has to come
  // before the app is ready, not merely exist in the file.
  //
  // The comments are stripped first. This file explains the rule in prose
  // above the call, and a search that finds "app.whenReady()" in the prose
  // would conclude that the call comes after the app is ready - which is the
  // opposite of what the code says.
  //
  // The call has to be a statement of its own. Wrapped in a callback - which is
  // what "apply it once the app is ready" looks like - it is too late, and a
  // search for the call's text alone would not see the difference.
  const src = fs.readFileSync(MAIN, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const statement = /^[ \t]*applyProxyPolicy\(app\.commandLine\);/m.exec(code);
  if (!statement) return 'the app never applies the proxy policy as a statement of its own';
  const ready = code.indexOf('app.whenReady()');
  if (ready === -1) return 'the app has no whenReady to be before';
  if (statement.index > ready) {
    return 'the proxy policy is applied after the app is ready, which is too late';
  }
  return true;
});

// ---- what Chromium actually did ---------------------------------------------

add('Chromium does not go looking for a proxy', () => {
  if (fixed.error) return fixed.error;
  if (fixed.lookups > 0) {
    return `the net log mentions a proxy lookup ${fixed.lookups} times`;
  }
  return true;
});

add('the certificate failure is gone from the log', () => {
  // net_error -202 is ERR_CERT_ALT_NAME_INVALID: the handshake against a
  // certificate that does not cover the name. This is the warning itself.
  if (fixed.error) return fixed.error;
  if (fixed.badCerts > 0) {
    return `the net log still has ${fixed.badCerts} certificate name failures`;
  }
  return true;
});

add('the check can see a proxy lookup when there is one', () => {
  // The control. Without it, the two checks above could be passing because
  // this machine's Chromium never looked, and a check that cannot see the
  // problem is not a check.
  if (control.error) return control.error;
  if (control.lookups === 0) {
    return 'the probe with the policy left off still saw no proxy lookup, so this check cannot see the problem it exists to catch';
  }
  return true;
});

let failed = 0;
for (const [name, ok, detail] of cases) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`);
}

// The logs are evidence. They are thrown away when everything passed, and
// left where they are when it did not, so a failure can be read.
if (failed === 0) {
  for (const run of [fixed, control]) {
    if (run && run.log && fs.existsSync(run.log)) fs.rmSync(run.log, { force: true });
  }
  try {
    fs.rmSync(WORK, { recursive: true, force: true });
  } catch {
    /* the directory is not important */
  }
} else {
  console.log('\nthe net logs were kept:');
  for (const run of [fixed, control]) {
    if (run && run.log) console.log(`  ${run.log}`);
  }
}

console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed ? 1 : 0);
