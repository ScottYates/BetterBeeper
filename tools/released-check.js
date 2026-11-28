/**
 * check:released - every push to main has a release, and the old ones are gone.
 *
 * The rule is "a release after each push", and a rule nobody checks is a rule
 * that quietly stops being true. This fails when main is ahead of the newest
 * tag, or when package.json and that tag disagree, which is the usual way a
 * version bump gets lost between the commit and the upload.
 *
 * The second rule is "keep only the three most recent releases". Every
 * release leaves a 91 MB installer on GitHub and a 427 MB build directory
 * locally, and nothing removed them: 101 releases and 9 GB of assets is what
 * that looks like. The release script prunes them now, and this is the check
 * that the pruning happened - a release cut from another clone, or a release
 * cut before the pruning existed, leaves the count too high and this says so.
 *
 * It is read-only: it never builds, never installs, never deletes and never
 * talks to GitHub beyond reading the release list, so it is safe to run at
 * any time.
 *
 * Run with `npm run check:released`.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const KEEP = 3;
const PROBE = path.join(__dirname, 'locked-bytes.ps1');

/**
 * How much old build output is a problem.
 *
 * A full build is about 427 MB, so 100 MB is a quarter of one: enough that
 * it is a build sitting on the disk rather than the leftover of one that
 * could not be removed because a file in it is open.
 *
 * The bytes that count are the ones a prune could actually take away. A
 * file another program is holding open cannot be removed by anything, and
 * it is not a build sitting on the disk - it is the one file in a build
 * that has already been emptied. Counting it would report a problem that
 * is not one, and a check that cries wolf is a check that gets ignored.
 */
const STALE_MB_LIMIT = 100;

function git(args) {
  return execFileSync('git', args, { windowsHide: true, cwd: ROOT, encoding: 'utf8' }).trim();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

/** The size of a directory, in bytes. */
function sizeOf(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try { total += fs.statSync(full).size; } catch { /* unreadable */ }
      }
    }
  };
  walk(dir);
  return total;
}

/** The releases on GitHub, newest first. Empty when the CLI is not there. */
function githubReleases() {
  try {
    const out = execFileSync('gh', [
      'release', 'list', '--repo', 'ScottYates/BetterBeeper',
      '--limit', '200', '--json', 'tagName,publishedAt',
    ], { windowsHide: true, cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const list = JSON.parse(out);
    list.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
    return list;
  } catch {
    return [];
  }
}

/** The local build directories, newest version first. */
function localBuildDirs() {
  const dirs = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = /^release-v(\d+)\.(\d+)\.(\d+)$/.exec(entry.name);
    if (m) dirs.push({ name: entry.name, v: [Number(m[1]), Number(m[2]), Number(m[3])] });
  }
  dirs.sort((a, b) => {
    for (let i = 0; i < 3; i++) if (a.v[i] !== b.v[i]) return a.v[i] > b.v[i] ? -1 : 1;
    return 0;
  });
  return dirs;
}

/**
 * How much of the old build output could be removed right now.
 *
 * The prune tool empties an old build directory and leaves behind whatever
 * another program is holding open - the desktop app that runs out of the
 * build folder, or a file indexer with a handle on it. Those bytes are real
 * and they are on the disk, but nothing can be done about them until the
 * handle is released, and reporting them as a build that needs pruning is a
 * problem that has no answer.
 *
 * So the bytes are split: the ones a prune could take away now, and the ones
 * it cannot. Only the first kind is a failure. The second is reported, so
 * that it is never a secret.
 *
 * The split is measured by asking the operating system rather than guessed:
 * a file can only be deleted if every handle on it was opened with
 * FILE_SHARE_DELETE, so asking for DELETE access to it answers exactly the
 * question "could this be removed?".
 *
 * If the probe cannot answer - no PowerShell, a timeout, something else -
 * then every byte counts. The check has to be right when it cannot ask.
 */
function probeLocks(dirs) {
  if (!dirs.length) return { removable: 0, locked: 0 };
  let out;
  try {
    out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PROBE],
      {
        input: dirs.join('\n'),
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 120000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  } catch {
    return null;
  }
  const removable = Number((out.match(/^removable\s+(\d+)/m) || [])[1]);
  const locked = Number((out.match(/^locked\s+(\d+)/m) || [])[1]);
  if (!Number.isFinite(removable) || !Number.isFinite(locked)) return null;
  return { removable, locked };
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const problems = [];

  const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = tryGit(['rev-parse', 'HEAD']);
  if (!branch || !head) {
    console.error('not a git repository (or HEAD is unborn) - nothing to check');
    process.exit(1);
  }

  // gh creates tags on the remote only, so a tag cut by npm run release is
  // invisible locally until it is fetched. Without this the check would report
  // a released repo as unreleased forever.
  tryGit(['fetch', '--tags', '--quiet', 'origin']);

  const tag = tryGit(['describe', '--tags', '--abbrev=0']);
  if (!tag) {
    problems.push('no tag exists at all, so nothing has ever been released');
  } else {
    const tagCommit = tryGit(['rev-list', '-n', '1', tag]);
    const ahead = Number(tryGit(['rev-list', '--count', `${tag}..HEAD`]) || 0);
    if (ahead > 0) {
      problems.push(
        `main is ${ahead} commit(s) ahead of ${tag}, so those pushes have no release.\n` +
        `    Run "npm run release" to publish them.`,
      );
    }
    if (tagCommit && tagCommit !== head && ahead === 0) {
      // Nothing to do; kept for clarity if the counts ever disagree.
    }
  }

  const tagVersion = tag ? tag.replace(/^v/, '') : null;
  if (tagVersion && tagVersion !== pkg.version) {
    problems.push(
      `package.json says ${pkg.version} but the newest tag is ${tag}.\n` +
      '    One of them was not committed, or the bump was made without publishing.',
    );
  }

  // The old ones have to go.
  //
  // A release is 91 MB of installer and a build directory is 427 MB, and
  // nothing used to remove either. The release script prunes them now; this
  // is the check that says the pruning is actually happening.
  const releases = githubReleases();
  if (releases.length) {
    if (releases.length > KEEP) {
      problems.push(
        `${releases.length} releases are published and only ${KEEP} should be.\n` +
        `    The oldest are ${releases.slice(KEEP).map((r) => r.tagName).join(', ')}.\n` +
        '    Run "npm run prune" to remove them. The git tags stay.',
      );
    }
  } else {
    console.log('releases       : (the GitHub CLI is not available, so they were not counted)');
  }

  const builds = localBuildDirs();
  let staleLine = '';
  let heldNote = '';
  if (builds.length) {
    // Measured in bytes, not in directories.
    //
    // A directory that could not be removed because one file in it is open -
    // an app running out of the build folder, or a file indexer - is not a
    // build sitting on the disk. Counting directories would report a problem
    // that is not one, and a check that cries wolf is a check that gets
    // ignored.
    const stale = builds.slice(KEEP);
    let staleBytes = 0;
    for (const d of stale) {
      staleBytes += sizeOf(path.join(ROOT, d.name));
    }

    // The bytes that count are the ones a prune could actually take away.
    // The rest are reported, not failed on: they are the file another
    // program is holding open, and nothing can be done about them until the
    // handle is released.
    const probe = probeLocks(stale.map((d) => path.join(ROOT, d.name)));
    const removableBytes = probe ? probe.removable : staleBytes;
    const lockedBytes = probe ? probe.locked : 0;

    const removableMb = removableBytes / 1048576;
    const lockedMb = lockedBytes / 1048576;

    if (lockedBytes > 0) {
      heldNote =
        `${lockedMb.toFixed(0)} MB in ${stale.length} old build director` +
        `${stale.length === 1 ? 'y is' : 'ies are'} held open by another program and cannot be ` +
        'removed until the handle is released. The next prune will take them.';
    }

    staleLine =
      `${(staleBytes / 1048576).toFixed(0)} MB on disk, ` +
      `${removableMb.toFixed(0)} MB removable, ${lockedMb.toFixed(0)} MB held open`;

    if (removableMb > STALE_MB_LIMIT) {
      problems.push(
        `${removableMb.toFixed(0)} MB of old build output is still on disk and only ${KEEP} builds should be.\n` +
        `    The oldest are ${stale.map((d) => d.name).join(', ')}.\n` +
        '    Run "npm run prune" to remove them.',
      );
    }
  }

  console.log(`branch        : ${branch}`);
  console.log(`head          : ${head.slice(0, 7)}`);
  console.log(`newest tag    : ${tag || '(none)'}`);
  console.log(`package.json  : ${pkg.version}`);
  console.log(`releases kept : ${releases.length || '?'} of ${KEEP}`);
  console.log(`builds kept   : ${builds.length} of ${KEEP}`);
  if (staleLine) console.log(`old output    : ${staleLine}`);
  if (heldNote) console.log(`held open    : ${heldNote}`);

  if (problems.length === 0) {
    console.log(`\nOK  every push to ${branch} has a release, and the old ones are gone.`);
    return;
  }

  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}

main();
