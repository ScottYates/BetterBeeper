/**
 * The red proof for check:gifplayer.
 *
 * A check that has never been seen to fail is a check that might not be able
 * to. This breaks the player on purpose, one thing at a time, in a copy of
 * the tree, and insists that the check notices each one.
 *
 * The copy is what makes this safe to run: the repository is never touched,
 * and the check that examines the copy is the same check that examines the
 * real tree, because the tools always come from this repository and only the
 * files are pointed somewhere else.
 *
 * Each break is aimed at one case, so a green run means that case can fail.
 * A break that took the whole feature down would prove much less: the check
 * could be red for a reason that has nothing to do with the thing being
 * broken.
 *
 * Usage: node tools/gif-player-redproof.js
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** The files the check reads. They are copied into the scratch tree. */
const FILES = [
  'tools/gif-player-harness.html',
];

/** The folders the check reads, copied whole. */
const DIRS = [
  'src/renderer',
];

/** The electron binary, which is what the check has to run under. */
function electronBin() {
  const exe = process.platform === 'win32' ? 'electron.exe' : 'electron';
  const local = path.join(ROOT, 'node_modules', 'electron', 'dist', exe);
  if (fs.existsSync(local)) return local;
  return process.platform === 'win32' ? 'electron.cmd' : 'electron';
}

/** Copy a folder and everything in it. */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else fs.copyFileSync(source, target);
  }
}

/** A fresh copy of the files the check reads. */
function makeTree() {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-gifplayer-redproof-'));
  for (const dir of DIRS) {
    copyDir(path.join(ROOT, dir), path.join(tree, dir));
  }
  for (const file of FILES) {
    const to = path.join(tree, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), to);
  }
  return tree;
}

/** Run the check against a tree and say what it said. */
function runCheck(tree) {
  try {
    const stdout = execFileSync(
      electronBin(),
      [
        path.join(ROOT, 'tools', 'run-check.js'),
        path.join(ROOT, 'tools', 'gif-player-check.js'),
        `--root=${tree}`,
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );
    return { code: 0, output: stdout, errors: '' };
  } catch (err) {
    // A failing check exits non-zero, which is the point of most of these.
    // The error output is kept as well: a check that dies rather than fails
    // says nothing about the case it was aimed at, and the reader has to be
    // able to see the difference.
    return {
      code: err.status === undefined ? -1 : err.status,
      output: `${err.stdout || ''}`,
      errors: `${err.stderr || ''}`,
    };
  }
}

/** Did the output contain this case as a FAIL? */
function failedOn(output, caseName) {
  return output.split(/\r?\n/).some((line) => line.startsWith('FAIL') && line.includes(caseName));
}

/**
 * Replace a run of text in a file, whatever the line endings are.
 *
 * The stylesheet is checked out with CRLF and the new files with LF, so a
 * replacement written with plain newlines would silently match nothing. A
 * break that does not happen is a break that is not caught, and the proof
 * would report a failure in the check rather than in itself.
 */
function replaceIn(file, pattern, replacement) {
  const text = fs.readFileSync(file, 'utf8');
  const next = text.replace(pattern, replacement);
  if (next === text) throw new Error(`the break did not change ${file}: ${pattern}`);
  fs.writeFileSync(file, next, 'utf8');
}

const CASES = [
  {
    // The whole point of the feature: three loops and then stop. One loop is
    // not three loops, and the picture has to stop early enough to show it.
    name: 'the player stops after one loop instead of three',
    expect: 'it plays three times over, not once and not five',
    break: (tree) => {
      replaceIn(
        path.join(tree, 'src', 'renderer', 'js', 'gif-player.js'),
        /export const DEFAULT_LOOPS = 3;/,
        'export const DEFAULT_LOOPS = 1;'
      );
    },
  },
  {
    // A pause that does not pause is worse than no pause: the reader presses
    // the button and the picture carries on.
    name: 'the pause does not pause',
    expect: 'pausing freezes the frame that was showing, not the first one',
    break: (tree) => {
      replaceIn(
        path.join(tree, 'src', 'renderer', 'js', 'gif-player.js'),
        /  pause\(\) \{\r?\n    this\.wanted = false;\r?\n    this\._sync\(\);\r?\n  \}/,
        '  pause() {\n    // broken on purpose: the picture keeps going\n  }'
      );
    },
  },
  {
    // The play button has to start the picture again.
    name: 'the play button does not start it again',
    expect: 'pressing play starts it again',
    break: (tree) => {
      replaceIn(
        path.join(tree, 'src', 'renderer', 'js', 'gif-player.js'),
        /  play\(options = \{\}\) \{\r?\n    if \(options\.forever === true\) this\.forever = true;\r?\n    this\.wanted = true;\r?\n    this\._sync\(\);\r?\n  \}/,
        '  play(options = {}) {\n    // broken on purpose: nothing is started\n  }'
      );
    },
  },
  {
    // A play item over a still picture is a lie, and the reader would be
    // pressing a control that does nothing.
    name: 'a file with one frame is treated as an animation',
    expect: 'a file with one frame is not an animation',
    break: (tree) => {
      replaceIn(
        path.join(tree, 'src', 'renderer', 'js', 'gif-player.js'),
        /this\.animated = track\.animated === true && this\.frameCount > 1;/,
        'this.animated = true;'
      );
    },
  },
  {
    // The frames have to reach the canvas. A player that decodes and throws
    // the pictures away would pass every count and show nothing.
    name: 'the frames are decoded but never drawn',
    expect: 'the picture changes while it plays',
    break: (tree) => {
      replaceIn(
        path.join(tree, 'src', 'renderer', 'js', 'gif-player.js'),
        /    this\.context\.clearRect\(0, 0, width, height\);\r?\n    this\.context\.drawImage\(image, 0, 0\);/,
        '    // broken on purpose: the frame is decoded and thrown away'
      );
    },
  },
  {
    // The thread has to hand the picture to the player. A GIF left as a
    // plain picture plays forever, which is what this feature is about.
    name: 'the thread never hands the picture to the player',
    expect: 'the thread hands the picture to the player',
    break: (tree) => {
      replaceIn(
        path.join(tree, 'src', 'renderer', 'js', 'thread.js'),
        /  wrap\.classList\.add\('is-playing'\);/,
        "  // broken on purpose: the player is never told to take over"
      );
    },
  },
  {
    // The menu is the only way to stop a GIF now, so the thread has to hand
    // the player to the menu. Without it there is no way to start a GIF
    // again, or to stop one that is still going.
    name: 'the menu never offers the play and pause item',
    expect: 'the menu offers to play a paused animation',
    break: (tree) => {
      replaceIn(
        path.join(tree, 'src', 'renderer', 'js', 'thread.js'),
        /      animation: player\r?\n        \? \{ paused: player\.paused, toggle: \(\) => player\.toggle\(\) \}\r?\n        : null,/,
        '      animation: null,'
      );
    },
  },
  {
    // The item has to say what the press will do. An item that always says
    // Play would offer to play a picture that is already playing, and the
    // reader would press it and nothing would happen.
    name: 'the menu item always says the same thing',
    expect: 'the menu offers to pause a playing animation',
    break: (tree) => {
      replaceIn(
        path.join(tree, 'src', 'renderer', 'js', 'ui.js'),
        /label: animation\.paused \? 'Play animation' : 'Pause animation',/,
        "label: 'Play animation',"
      );
    },
  },
  {
    // And the item has to do the thing it says. The first thing that breaks
    // is the picture that will not start, because the menu was asked to play
    // a picture that was paused.
    name: 'the menu item does nothing',
    expect: 'pressing it starts the picture again',
    break: (tree) => {
      replaceIn(
        path.join(tree, 'src', 'renderer', 'js', 'ui.js'),
        /onSelect: \(\) => \{ animation\.toggle\(\); \},/,
        'onSelect: () => {},'
      );
    },
  },
  {
    // A cached picture is reused rather than made again, so the attachment it
    // carries has to be refreshed with it. The right-click menu is built from
    // that attachment, and a stale one offers to save the wrong file.
    name: 'the canvas keeps the attachment it was first drawn with',
    expect: 'the canvas carries the attachment that is on screen now',
    break: (tree) => {
      replaceIn(
        path.join(tree, 'src', 'renderer', 'js', 'thread.js'),
        /      if \(canvas\) canvas\.__attachment = attachment;/,
        '      // broken on purpose: the canvas keeps the attachment it had'
      );
    },
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
  console.log(cleanRun.errors);
  missed += 1;
}

for (const testCase of CASES) {
  const tree = makeTree();
  testCase.break(tree);
  const run = runCheck(tree);
  const caughtIt = run.code !== 0 && failedOn(run.output, testCase.expect);
  if (caughtIt) {
    caught += 1;
    console.log(`  PASS  caught: ${testCase.name}`);
  } else {
    missed += 1;
    console.log(`  FAIL  not caught: ${testCase.name}`);
    console.log(`        expected the case "${testCase.expect}" to fail`);
    console.log(run.output);
    console.log(run.errors);
  }
  fs.rmSync(tree, { recursive: true, force: true });
}
fs.rmSync(clean, { recursive: true, force: true });

console.log(`\n${missed ? 'FAILED' : 'OK'}  ${caught} caught, ${missed} missed`);
process.exit(missed ? 1 : 0);
