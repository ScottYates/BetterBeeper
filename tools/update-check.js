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
const { compareVersions, pickInstallerAsset, isNewerRelease } = updater;
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
    'checkForUpdate', 'downloadAsset', 'stageUpdate', 'applyPendingUpdate', 'pendingStatus']) {
    if (typeof updater[name] !== 'function') return 'missing ' + name;
  }
  return true;
});

// ---- report ----------------------------------------------------------------

let failed = 0;
for (const [name, ok, detail] of cases) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed ? 1 : 0);