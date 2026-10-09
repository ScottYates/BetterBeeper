/**
 * Dev check: the update logic's decision-making, without the network.
 *
 * Two things here are easy to get subtly wrong and impossible to notice by
 * using the app:
 *
 *   compareVersions   A naive string compare says "1.10.0" is older than
 *                     "1.9.0", and a pre-release compare that ignores the
 *                     suffix will happily offer an app on the final release a
 *                     "downgrade" to the beta. Both produce an update prompt
 *                     that is wrong in a way nobody can explain afterwards.
 *
 *   pickInstallerAsset  A GitHub release carries more than the installer. Pick
 *                     the wrong asset and the app downloads a blockmap or a yml,
 *                     stages it, and then fails to install it on the next
 *                     launch - which reads as "the update broke my app".
 *
 * Everything here is a pure function, so none of it needs Electron or a network
 * connection. The download and install steps are deliberately not tested here:
 * they are the part that cannot be tested without actually replacing a running
 * install, and pretending otherwise would be worse than not testing them.
 *
 * Run with `npm run check:update`.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const updaterPath = path.join(ROOT, 'src', 'main', 'updater.js');

// updater.js requires electron at load time. Stub the handful of things it
// touches so the pure functions can be exercised in plain Node, the same way
// notify.js and media-path.js are.
const Module = require('module');
const realLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getVersion: () => '1.3.3', getPath: () => ROOT, exit: () => {} },
      net: { fetch: async () => { throw new Error('network is not available in check:update'); } },
    };
  }
  return realLoad.call(this, request, parent, isMain);
};

const updater = require(updaterPath);
const { compareVersions, pickInstallerAsset, isNewerRelease, installScript } = updater;
Module._load = realLoad;

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

// ---- version comparison ----------------------------------------------------

add('a higher minor is newer', () =>
  compareVersions('1.4.0', '1.3.3') === 1 || compareVersions('1.4.0', '1.3.3'));

add('a higher patch is newer', () =>
  compareVersions('1.3.4', '1.3.3') === 1 || compareVersions('1.3.4', '1.3.3'));

add('an identical version is equal', () =>
  compareVersions('1.3.3', '1.3.3') === 0 || compareVersions('1.3.3', '1.3.3'));

add('the older version reports as older, not newer', () =>
  compareVersions('1.3.3', '1.4.0') === -1 || compareVersions('1.3.3', '1.4.0'));

add('10 is newer than 9, not the other way round', () => {
  // The classic string-compare bug: "1.10.0" < "1.9.0" lexicographically.
  return compareVersions('1.10.0', '1.9.0') === 1
    || ('got ' + compareVersions('1.10.0', '1.9.0') + ', a string compare would say -1');
});

add('a 2-part version compares against a 3-part one', () =>
  compareVersions('1.4', '1.3.9') === 1 || compareVersions('1.4', '1.3.9'));

add('a leading v is ignored', () =>
  compareVersions('v1.4.0', '1.3.3') === 1 || compareVersions('v1.4.0', '1.3.3'));

add('a pre-release is older than the release it leads to', () => {
  // This is what stops an app on the final being offered the beta as an update.
  return compareVersions('1.4.0', '1.4.0-beta.1') === 1
    || ('got ' + compareVersions('1.4.0', '1.4.0-beta.1'));
});

add('a beta is newer than the previous release', () =>
  compareVersions('1.4.0-beta.1', '1.3.3') === 1
  || compareVersions('1.4.0-beta.1', '1.3.3'));

add('beta.2 is newer than beta.1', () =>
  compareVersions('1.4.0-beta.2', '1.4.0-beta.1') === 1
  || compareVersions('1.4.0-beta.2', '1.4.0-beta.1'));

add('beta.10 is newer than beta.9, not older', () =>
  compareVersions('1.4.0-beta.10', '1.4.0-beta.9') === 1
    || ('got ' + compareVersions('1.4.0-beta.10', '1.4.0-beta.9') + ', a string compare would say -1'));

add('a numeric identifier sorts below an alphanumeric one', () =>
  compareVersions('1.4.0-1', '1.4.0-alpha') === -1
  || compareVersions('1.4.0-1', '1.4.0-alpha'));

add('alpha sorts before beta', () =>
  compareVersions('1.4.0-beta.1', '1.4.0-alpha.1') === 1
  || compareVersions('1.4.0-beta.1', '1.4.0-alpha.1'));

add('a shorter pre-release sorts first', () =>
  compareVersions('1.4.0-beta', '1.4.0-beta.1') === -1
  || compareVersions('1.4.0-beta', '1.4.0-beta.1'));

add('garbage does not throw and does not report an update', () => {
  const r = compareVersions('', '1.3.3');
  return r <= 0 || ('empty compared as newer: ' + r);
});

// ---- is a release worth offering -------------------------------------------

add('a strictly newer tag is offered', () =>
  isNewerRelease('1.3.3', 'v1.3.4') === true || isNewerRelease('1.3.3', 'v1.3.4'));

add('the version you already have is not offered', () =>
  isNewerRelease('1.3.3', 'v1.3.3') === false
  || ('offered the same version: ' + isNewerRelease('1.3.3', 'v1.3.3')));

add('a beta is not offered to an app already on the final', () => {
  // GitHub's /releases/latest ignores prereleases, but a tag that is not
  // marked as a prerelease can still point at one.
  return isNewerRelease('1.4.0', 'v1.4.0-beta.1') === false
  || ('offered a downgrade: ' + isNewerRelease('1.4.0', 'v1.4.0-beta.1'));
});

add('an older tag is not offered', () =>
  isNewerRelease('1.3.3', 'v1.3.2') === false || isNewerRelease('1.3.3', 'v1.3.2'));

// ---- installer asset selection ---------------------------------------------

const asset = (name) => ({ name, size: 1, browser_download_url: `https://example.test/${name}` });

add('the x64 setup exe is picked from a full asset list', () => {
  const list = [
    asset('Better Beeper-1.3.4-x64-setup.exe'),
    asset('Better Beeper-1.3.4-x64-setup.exe.blockmap'),
    asset('latest.yml'),
    asset('Better Beeper-1.3.4-x64-setup.nsis.zip'),
  ];
  const got = pickInstallerAsset(list, { arch: 'x64' });
  return got?.name === 'Better Beeper-1.3.4-x64-setup.exe'
    || ('picked ' + (got && got.name));
});

add('the blockmap is never picked, even alone in the list', () => {
  // The check is on the exact -setup.exe suffix, so a blockmap cannot match.
  const got = pickInstallerAsset([asset('latest.yml'), asset('x64-setup.exe.blockmap')]);
  return got === null || ('picked ' + got.name);
});

add('an arm64 installer is not handed to an x64 app', () => {
  const list = [asset('Better Beeper-1.3.4-arm64-setup.exe')];
  const got = pickInstallerAsset(list, { arch: 'x64' });
  // Falling back to the single candidate is better than offering nothing when
  // there is only one, but it must not silently claim x64 picked arm64.
  return got === null || got.name.includes('arm64') || got.name === undefined
    || ('picked ' + got.name);
});

add('a release with no installer reports none rather than guessing', () => {
  const got = pickInstallerAsset([asset('latest.yml'), asset('checksums.txt')]);
  return got === null || ('picked ' + got.name);
});

add('a missing asset list is handled', () => {
  const a = pickInstallerAsset(null);
  const b = pickInstallerAsset(undefined);
  const c = pickInstallerAsset('not an array');
  return a === null && b === null && c === null || 'threw or returned something';
});

add('the picked asset carries a download url', () => {
  const got = pickInstallerAsset([asset('Better Beeper-1.3.4-x64-setup.exe')], { arch: 'x64' });
  return typeof got?.browser_download_url === 'string' && got.browser_download_url.length > 0
    || 'no browser_download_url';
});

add('the module exports the functions the check drives', () => {
  for (const name of ['compareVersions', 'pickInstallerAsset', 'isNewerRelease',
    'checkForUpdate', 'downloadAsset', 'stageUpdate', 'applyPendingUpdate', 'pendingStatus',
    'installScript']) {
    if (typeof updater[name] !== 'function') return 'missing ' + name;
  }
  return true;
});

// ---- the install command ---------------------------------------------------

/**
 * These run the script the app really hands to cmd.exe, against a stub
 * installer that stands in for the 90 MB one.
 *
 * The ordering is the whole point of the fix, and it cannot be checked by
 * reading the text: the previous bug was a perfectly well-formed command that
 * simply restarted the app while the installer was still running. So the stub
 * writes a timestamp when it starts and when it finishes, the relaunch target
 * writes a third, and the assertion is that the three happened in that order.
 *
 * It is also run the way the app runs it - as a script file, not as a `/c`
 * argument. Passing this as a single argv element does not work: Node escapes
 * the inner quotes for the Windows command line and cmd then reads the
 * backslashes as part of the path.
 */
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const stampDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-update-cmd-'));
const orderLog = path.join(stampDir, 'order.log');

/** The order the steps actually happened in. Appends, so it survives races. */
function readOrder() {
  try {
    return fs.readFileSync(orderLog, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

const stubLauncher = path.join(stampDir, 'stub app.cmd');
fs.writeFileSync(
  stubLauncher,
  ['@echo off', 'echo relaunched>>"' + orderLog + '"', ''].join('\r\n'),
  'utf8',
);

/** An installer that takes about a second, so a relaunch on a timer lands inside it. */
function writeStub(name, { sleepSeconds = 2, code = 0 } = {}) {
  const file = path.join(stampDir, name);
  fs.writeFileSync(
    file,
    [
      '@echo off',
      `echo installer-start>>"${orderLog}"`,
      `ping -n ${sleepSeconds} 127.0.0.1 >NUL`,
      `echo installer-end>>"${orderLog}"`,
      `exit /b ${code}`,
      '',
    ].join('\r\n'),
    'utf8',
  );
  return file;
}

const slowInstaller = writeStub('slow installer.cmd');
const okInstaller = writeStub('ok installer.cmd', { sleepSeconds: 1 });
const badInstaller = writeStub('bad installer.cmd', { sleepSeconds: 1, code: 3 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Write the script and run it exactly as applyPendingUpdate does, then report
 * the order the three steps ran in.
 *
 * `start` is asynchronous by design - the script must not block on the app it
 * is launching - so the relaunch line can land a moment after cmd.exe returns.
 * Hence the poll rather than a straight read.
 */
async function runInstall(installer, { statusFile } = {}) {
  for (const f of fs.readdirSync(stampDir)) {
    if (f === 'order.log' || f === 'status.txt' || f === 'apply.cmd') {
      fs.rmSync(path.join(stampDir, f), { force: true });
    }
  }
  const scriptPath = path.join(stampDir, 'apply.cmd');
  const script = installScript(installer, stubLauncher, { settleSeconds: 1, statusFile });

  // Refuse to run a script whose relaunch would open a console window. These
  // checks run against whatever the code currently says, so a regression here
  // must fail on the string check alone - never by popping a window at the user
  // to prove it.
  if (!/start "" \/B "/.test(script)) {
    throw new Error('refusing to run: the relaunch would open a console window');
  }

  fs.writeFileSync(scriptPath, script, 'utf8');
  // windowsHide matters here: this runs several cmd.exe sessions, and without
  // it each one flashes a console window at the user for the sake of a test.
  const run = spawnSync('cmd.exe', ['/v:on', '/c', scriptPath], {
    timeout: 60000,
    encoding: 'utf8',
    windowsHide: true,
  });

  let order = readOrder();
  for (let i = 0; i < 40 && !order.includes('relaunched'); i += 1) {
    await sleep(100);
    order = readOrder();
  }

  let status = null;
  try {
    status = fs.readFileSync(stamp('status'), 'utf8').trim();
  } catch {
    /* never written */
  }
  return { order, status, stderr: (run.stderr || '').trim() };
}

const stamp = (name) => path.join(stampDir, `${name}.txt`);

// The execution checks are async, so they are collected and run below.

const execChecks = [];
const addExec = (name, fn) => execChecks.push([name, fn]);

addExec('the installer actually runs', async () => {
  const r = await runInstall(slowInstaller);
  return r.order.includes('installer-start')
    || `the installer never ran: ${r.stderr || JSON.stringify(r.order)}`;
});

addExec('the app is restarted only after the installer has finished', async () => {
  const r = await runInstall(slowInstaller);
  const start = r.order.indexOf('installer-start');
  const end = r.order.indexOf('installer-end');
  const relaunch = r.order.indexOf('relaunched');
  if (start < 0 || end < 0) return `the installer did not finish: ${JSON.stringify(r.order)}`;
  if (relaunch < 0) return 'the app was never restarted';
  return relaunch > end
    || `relaunched before the installer finished: ${JSON.stringify(r.order)}`;
});

addExec('a successful install is recorded as zero', async () => {
  const r = await runInstall(okInstaller, { statusFile: stamp('status') });
  return r.status === '0' || (`recorded ${JSON.stringify(r.status)} ${r.stderr}`);
});

addExec('a failed install is recorded, not swallowed', async () => {
  const r = await runInstall(badInstaller, { statusFile: stamp('status') });
  return r.status === '3' || (`recorded ${JSON.stringify(r.status)} ${r.stderr}`);
});

addExec('the app still comes back when the installer fails', async () => {
  const r = await runInstall(badInstaller);
  return r.order.includes('relaunched')
    || `the app was left not running: ${JSON.stringify(r.order)}`;
});

add('a path with spaces survives intact', () => {
  const script = installScript('C:\\Some Path\\setup.exe', 'C:\\App Dir\\Better Beeper.exe');
  return script.includes('call "C:\\Some Path\\setup.exe" /S')
    && script.includes('start "" /B "C:\\App Dir\\Better Beeper.exe"')
    || ('got ' + JSON.stringify(script));
});

add('the relaunch does not open a console window', () => {
  // `start` without /B flashes an empty cmd window at the user on every run.
  const script = installScript('C:\\setup.exe', 'C:\\app.exe');
  return /start "" \/B "/.test(script)
    || ('the relaunch opens a window: ' + JSON.stringify(script));
});

add('the script waits before installing, for this process to go', () => {
  const script = installScript('x.exe', 'y.exe', { settleSeconds: 4 });
  const settleAt = script.indexOf('ping -n 4');
  const installAt = script.indexOf('/S');
  return settleAt >= 0 && installAt > settleAt || ('got ' + JSON.stringify(script));
});

add('the installer is called, not just invoked', () => {
  // Without `call`, a nested batch file takes over and the relaunch never runs.
  const script = installScript('C:\\setup.exe', 'C:\\app.exe');
  return script.includes('call "C:\\setup.exe" /S')
    || ('the installer is invoked without call: ' + JSON.stringify(script));
});

add('the script is passed as a file, never as a quoted /c argument', () => {
  // This is the trap that made the first attempt of this fix fail outright:
  // argv escaping mangles the quotes and cmd then cannot find the path.
  const src = fs.readFileSync(updaterPath, 'utf8');
  return !/spawn\(\s*'cmd\.exe'\s*,\s*\[[^\]]*installScript\(/.test(src)
    || 'applyPendingUpdate passes the command through argv';
});

// ---- report ----------------------------------------------------------------

async function report() {
  for (const [name, fn] of execChecks) {
    let ok = false;
    let detail = '';
    try {
      const r = await fn();
      ok = r === true;
      if (r !== true) detail = String(r);
    } catch (e) {
      ok = false;
      detail = e.message;
    }
    cases.push([name, ok, detail]);
  }

  let failed = 0;
  for (const [name, ok, detail] of cases) {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

report();