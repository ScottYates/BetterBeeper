/**
 * The red proof for check:appicon.
 *
 * A check that has never been seen to fail is a check that might not be able
 * to. This breaks the icon files on purpose, one at a time, in a copy of the
 * tree, and insists that the check notices each one.
 *
 * The copy is what makes this safe to run: the repository is never touched,
 * and the check that examines the copy is the same check that examines the
 * real tree, because the tools always come from this repository and only the
 * files are pointed somewhere else.
 *
 * Usage: node tools/app-icon-redproof.js
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** The files the check reads. They are copied into the scratch tree. */
const FILES = [
  'build/icon.svg',
  'build/icon.ico',
  'src/assets/icon.png',
  'electron-builder.yml',
  'src/main/main.js',
  'src/main/auth.js',
];

/** The electron binary, which is what the check has to run under. */
function electronBin() {
  const exe = process.platform === 'win32' ? 'electron.exe' : 'electron';
  const local = path.join(ROOT, 'node_modules', 'electron', 'dist', exe);
  if (fs.existsSync(local)) return local;
  return process.platform === 'win32' ? 'electron.cmd' : 'electron';
}

/** A fresh copy of the files the check reads. */
function makeTree() {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-icon-redproof-'));
  for (const file of FILES) {
    const to = path.join(tree, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), to);
  }
  return tree;
}

/** Run the check against a tree and say what it said. */
function runCheck(tree, extraEnv) {
  try {
    const stdout = execFileSync(
      electronBin(),
      [
        path.join(ROOT, 'tools', 'run-check.js'),
        path.join(ROOT, 'tools', 'app-icon-check.js'),
        `--root=${tree}`,
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      }
    );
    return { code: 0, output: stdout };
  } catch (err) {
    // A failing check exits non-zero, which is the point of most of these.
    return { code: err.status === undefined ? -1 : err.status, output: `${err.stdout || ''}` };
  }
}

/** Did the output contain this case as a FAIL? */
function failedOn(output, caseName) {
  return output.split(/\r?\n/).some((line) => line.startsWith('FAIL') && line.includes(caseName));
}

const CASES = [
  {
    name: 'the artwork is edited and the files are not regenerated',
    expect: 'the .ico is what the artwork produces today',
    break: (tree) => {
      const file = path.join(tree, 'build', 'icon.svg');
      const svg = fs.readFileSync(file, 'utf8').replace('#4a9bff', '#ff0000');
      fs.writeFileSync(file, svg, 'utf8');
    },
  },
  {
    name: 'the .ico is cut short',
    expect: 'every image in the .ico is inside the file',
    break: (tree) => {
      const file = path.join(tree, 'build', 'icon.ico');
      const bytes = fs.readFileSync(file);
      fs.writeFileSync(file, bytes.slice(0, bytes.length - 200));
    },
  },
  {
    name: 'the window png is not the one inside the .ico',
    expect: 'the 256 pixel image in the .ico is the window png',
    break: (tree) => {
      const file = path.join(tree, 'src', 'assets', 'icon.png');
      const bytes = fs.readFileSync(file);
      fs.writeFileSync(file, bytes.slice(0, 1000));
    },
  },
  {
    name: 'the builder is not told which icon to use',
    expect: 'the builder is told which icon to use',
    break: (tree) => {
      const file = path.join(tree, 'electron-builder.yml');
      const text = fs.readFileSync(file, 'utf8').replace(/^\s*icon:\s*build\/icon\.ico\s*$/m, '  # no icon');
      fs.writeFileSync(file, text, 'utf8');
    },
  },
  {
    name: 'the main window is not given the icon',
    expect: 'the main window is given the icon',
    break: (tree) => {
      const file = path.join(tree, 'src', 'main', 'main.js');
      const text = fs.readFileSync(file, 'utf8').replace(/\n\s*icon:\s*APP_ICON,/, '');
      fs.writeFileSync(file, text, 'utf8');
    },
  },
  {
    name: 'the approval window is not given the icon',
    expect: 'the approval window is given the icon',
    break: (tree) => {
      const file = path.join(tree, 'src', 'main', 'auth.js');
      const text = fs.readFileSync(file, 'utf8').replace(
        /\n\s*icon:\s*path\.join\(__dirname, '\.\.', 'assets', 'icon\.png'\),/,
        ''
      );
      fs.writeFileSync(file, text, 'utf8');
    },
  },
  {
    // The drawing has to come out at the size it was asked for.
    //
    // A capture is the size of the window times the display's scale factor,
    // so on a display set to 150% a 16 pixel window captures 24 pixels - and
    // the check would then be comparing two different pictures, on one
    // machine and not another. The override draws the artwork at twice the
    // size on purpose, which is wrong on any machine.
    name: 'the artwork is drawn at the wrong size',
    expect: 'the artwork is drawn at the size it is wanted',
    env: { BB_ICON_FORCE_SCALE: '2' },
  },
];

let caught = 0;
let missed = 0;

console.log('the untouched tree must pass');
const clean = makeTree();
const cleanRun = runCheck(clean);
if (cleanRun.code === 0) {
  console.log('  PASS  the check is green on the real files');
} else {
  console.log('  FAIL  the check is red on the real files');
  console.log(cleanRun.output);
  missed += 1;
}

for (const testCase of CASES) {
  const tree = makeTree();
  if (testCase.break) testCase.break(tree);
  const run = runCheck(tree, testCase.env);
  const caughtIt = run.code !== 0 && failedOn(run.output, testCase.expect);
  if (caughtIt) {
    caught += 1;
    console.log(`  PASS  caught: ${testCase.name}`);
  } else {
    missed += 1;
    console.log(`  FAIL  not caught: ${testCase.name}`);
    console.log(`        expected the case "${testCase.expect}" to fail`);
    console.log(run.output);
  }
  fs.rmSync(tree, { recursive: true, force: true });
}
fs.rmSync(clean, { recursive: true, force: true });

console.log(`\n${missed ? 'FAILED' : 'OK'}  ${caught} caught, ${missed} missed`);
process.exit(missed ? 1 : 0);
