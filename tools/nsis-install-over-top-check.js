/**
 * Dev check: an update installs over the top of the old version.
 *
 * The update used to uninstall the old version first. That uninstaller is what
 * deletes the Start Menu shortcut and unregisters the app's identity
 * (`WinShell::UninstAppUserModelId` in electron-builder's own template), and the
 * taskbar pin is the shell's entry for that identity - so every update took
 * the pin with it, and the app had to be pinned by hand again. That is what was
 * reported.
 *
 * The fix is a custom NSIS hook that makes the old uninstaller give up before
 * it deletes anything: `tools/nsis/installer.nsh`, included by
 * `electron-builder.yml`, whose `customUnInstall` macro quits the uninstaller
 * with a success code.
 *
 * Everything else in this project can only see that the hook is *there* - the
 * script is in the config, the macro is in the file, the template calls the
 * hook before it does the damage. None of that says the hook *works*, and
 * "works" here has a precise meaning: the uninstaller must stop before the
 * deletion, and it must stop with the exit code the installer is looking for,
 * because the installer carries on only if the uninstaller succeeded.
 *
 * So this check builds two tiny NSIS programs in a sandbox and runs them:
 *
 *   - the control, which is the same program with the hook left out. It has
 *     to delete the file and write its marker, or the check proves nothing -
 *     a test that cannot fail is not a test.
 *   - the treatment, which is the same program with the repository's own
 *     `tools/nsis/installer.nsh` included. The file must survive, the marker
 *     must not appear, and the exit code must be zero.
 *
 * Nothing here touches the real installation: the sandbox is in the temp
 * directory, the "app" is a text file, and the programs are NSIS's own
 * uninstallers running silently with no window.
 *
 * Run with: npm run check:nsis
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MACRO_FILE = path.join(ROOT, 'tools', 'nsis', 'installer.nsh');

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
  if (!cond) failed++;
};

/**
 * makensis, which electron-builder downloaded when it built an installer.
 *
 * It is not a dependency of this project - electron-builder fetches it into
 * its cache - so the check says plainly that it is missing rather than
 * quietly passing over the whole thing.
 */
function findMakensis() {
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.toLowerCase() === 'makensis.exe') found.push(full);
    }
  };
  walk(cache, 0);
  if (found.length) {
    // The one in Bin/ is the command line tool; the other is the same file.
    found.sort((a, b) => (a.endsWith(`${path.sep}Bin${path.sep}makensis.exe`) ? 1 : 0)
      - (b.endsWith(`${path.sep}Bin${path.sep}makensis.exe`) ? 1 : 0));
    return found[0];
  }
  return null;
}

/**
 * The NSIS program the check builds.
 *
 * It is shaped like electron-builder's uninstaller: an install section that
 * writes an uninstaller, and an "un." section - the sections whose names start
 * with "un." are the ones the uninstaller runs. The hook goes where
 * electron-builder puts it, before the damage.
 */
function script({ include, victim, marker }) {
  return [
    include ? `!include "${include}"` : '; the hook is deliberately left out',
    'Name "Better Beeper Sandbox Uninstaller"',
    'OutFile "setup.exe"',
    'InstallDir "$EXEDIR"',
    'RequestExecutionLevel user',
    '',
    'Section "Install"',
    '  WriteUninstaller "$EXEDIR\\uninstaller.exe"',
    'SectionEnd',
    '',
    'Section "un.install"',
    '  ; This is the damage: the uninstaller removing what the app installed,',
    '  ; which in the real app is the Start Menu shortcut and the app identity.',
    include ? '  !insertmacro customUnInstall' : '  ; no hook here',
    `  Delete "${victim}"`,
    `  FileOpen $0 "${marker}" w`,
    '  FileWrite $0 "the uninstall ran past the hook"',
    '  FileClose $0',
    'SectionEnd',
    '',
  ].join('\n');
}

/**
 * Builds one program and runs its uninstaller over a file it is told to
 * delete. Returns what happened.
 */
function runScenario(dir, source) {
  fs.mkdirSync(dir, { recursive: true });
  const victim = path.join(dir, 'shortcut.lnk');
  const marker = path.join(dir, 'finished.txt');
  const nsi = path.join(dir, 'sandbox.nsi');

  fs.writeFileSync(nsi, source, 'utf8');
  fs.writeFileSync(victim, 'the shortcut the uninstaller would delete', 'utf8');

  let build = null;
  try {
    execFileSync(MAKENSIS, [nsi], { cwd: dir, stdio: 'pipe', timeout: 120000 });
    build = 'ok';
  } catch (err) {
    build = String(err.stderr || err.message).trim();
  }

  // The uninstaller exists only once the installer has run: WriteUninstaller
  // is what puts it there.
  let install = null;
  const setup = path.join(dir, 'setup.exe');
  if (build === 'ok' && fs.existsSync(setup)) {
    const result = spawnSync(setup, ['/S'], { cwd: dir, timeout: 120000 });
    install = result.status === 0 ? 'ok' : `exit code ${result.status}`;
  }

  let run = null;
  let code = null;
  const uninstaller = path.join(dir, 'uninstaller.exe');
  if (build === 'ok' && fs.existsSync(uninstaller)) {
    // "_?=" is how the real installer runs the old uninstaller: it runs in
    // place instead of copying itself to the temp directory first.
    //
    // That matters for more than fidelity. Run the ordinary way, the
    // uninstaller copies itself to temp and returns at once, and the copy
    // does the work afterwards - so a check that looks at the files straight
    // afterwards is looking before the uninstall has happened, and it sees a
    // program that did nothing. Run in place, the program does its work before
    // it returns.
    const result = spawnSync(uninstaller, ['/S', `_?=${dir}`], { cwd: dir, timeout: 120000 });
    code = typeof result.status === 'number' ? result.status : null;
    run = 'ran';
  }

  return {
    build,
    install,
    run,
    code,
    victimSurvived: fs.existsSync(victim),
    markerWritten: fs.existsSync(marker),
  };
}

const MAKENSIS = findMakensis();

check('the hook script is in the repository', fs.existsSync(MACRO_FILE), MACRO_FILE);
check('NSIS is available to build the test with', !!MAKENSIS,
  MAKENSIS || 'makensis.exe is not in the electron-builder cache');

if (MAKENSIS && fs.existsSync(MACRO_FILE)) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-nsis-check-'));

  // The control: the same program with the hook left out. It has to do the
  // damage, or the treatment proves nothing.
  const control = runScenario(
    path.join(stage, 'control'),
    script({
      include: null,
      victim: path.join(stage, 'control', 'shortcut.lnk'),
      marker: path.join(stage, 'control', 'finished.txt'),
    }),
  );

  // The treatment: the repository's own script, included.
  //
  // The path is written with backslashes, which is what electron-builder
  // writes: NSIS's preprocessor does not find a file named with forward
  // slashes, and the real build's include line is `!include "<path>"` with a
  // Windows path.
  const treatment = runScenario(
    path.join(stage, 'treatment'),
    script({
      include: MACRO_FILE,
      victim: path.join(stage, 'treatment', 'shortcut.lnk'),
      marker: path.join(stage, 'treatment', 'finished.txt'),
    }),
  );

  check('the control program builds', control.build === 'ok', control.build || '');
  check('the control program installs', control.install === 'ok', control.install || '');
  check('the control uninstaller runs', control.run === 'ran', '');
  check('without the hook the uninstaller deletes what it is told to',
    control.build === 'ok' && !control.victimSurvived && control.markerWritten,
    `survived=${control.victimSurvived} marker=${control.markerWritten}`);

  check('the program with the hook builds', treatment.build === 'ok', treatment.build || '');
  check('the program with the hook installs', treatment.install === 'ok', treatment.install || '');
  check('with the hook the uninstaller stops before it deletes anything',
    treatment.build === 'ok' && treatment.victimSurvived && !treatment.markerWritten,
    `survived=${treatment.victimSurvived} marker=${treatment.markerWritten}`);
  check('the uninstaller gives up with a success code, so the installer carries on',
    treatment.code === 0, `exit code ${treatment.code}`);

  // The file the check just built is the repository's file, not a copy that
  // happens to look like it.
  const generated = fs.readFileSync(path.join(stage, 'treatment', 'sandbox.nsi'), 'utf8');
  check('the hook that was tested is the repository\'s own script',
    generated.includes(MACRO_FILE), '');

  if (process.env.BB_KEEP_NSIS_SANDBOX) console.log(`sandbox kept at ${stage}`);
  else fs.rmSync(stage, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? 'OK' : 'FAILED'}  ${failed === 0 ? 'the update installs over the top' : `${failed} checks failed`}`);
process.exit(failed ? 1 : 0);
