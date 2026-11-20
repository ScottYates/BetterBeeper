/**
 * Keeps the workspace from filling up with old builds, and the repository's
 * release storage from growing with every version.
 *
 * The rule is three: keep the three most recent releases, delete the rest,
 * and leave the git tags alone.
 *
 * Why it is a tool and not a habit: this was 101 releases and 9 GB of
 * installer assets, and about 25 GB of local build directories before it was
 * swept. Every release leaves a 427 MB directory behind and a 91 MB asset on
 * GitHub, so "clean up as you go" is not a thing to remember - it is a thing
 * to automate, and the release script calls this automatically.
 *
 * The tags stay. A tag is a few bytes and it is the version history; the
 * release script reads the newest tag to decide the next version number, and
 * `git describe` reads it. Deleting a *release* removes its installer and
 * nothing else.
 *
 * Usage:
 *   node tools/prune.js                prune the local build directories
 *   node tools/prune.js --releases     and the GitHub releases
 *   node tools/prune.js --dry-run      say what would go, and stop
 *   node tools/prune.js --keep=5       keep five instead of three
 *   node tools/prune.js --root=<dir>   prune some other folder instead
 *
 * A deletion that cannot happen - a file another program has open - is
 * reported and left alone. It is not a reason to fail: the release is
 * already published by the time this runs, and the next run will try again.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const REPO = 'ScottYates/BetterBeeper';
const DEFAULT_KEEP = 3;

/** The build directories this tool is allowed to delete. */
const LOCAL_DIRS = /^release-v\d+\.\d+\.\d+$/;

/**
 * The version in a build directory's name, as a comparable number.
 *
 * "1.9.5" and "1.10.0" have to sort by version, not by text: "1.10.0" sorts
 * before "1.9.5" as a string, and the wrong order would prune the newest
 * build and keep the oldest.
 */
function versionOf(name) {
  const m = /^release-v(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const newer = (a, b) => {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
};

/** The size of a directory, in bytes. */
function sizeOf(dir) {
  let total = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        try { walk(full); } catch { /* unreadable */ }
      } else {
        try { total += fs.statSync(full).size; } catch { /* unreadable */ }
      }
    }
  };
  try { walk(dir); } catch { /* unreadable */ }
  return total;
}

/**
 * Removes the local build directories that are not among the newest.
 *
 * Only directories the release tooling created and owns are touched, and
 * only ones whose name is a version: a directory that happens to be called
 * "release" or "release-new" is somebody's scratch space and is left alone.
 *
 * A directory is emptied before it is removed, so that a file something else
 * has open does not keep 427 MB alive. That is the difference between "the
 * old build is gone" and "the old build is still there, but only the one
 * file that is locked is".
 *
 * The folder it works on can be pointed somewhere else, so that a proof can
 * exercise the tool on a set of made-up directories instead of on the real
 * ones.
 */
function pruneLocal(keep, dryRun, root) {
  const base = root || ROOT;
  const dirs = fs.readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && LOCAL_DIRS.test(e.name))
    .map((e) => ({ name: e.name, version: versionOf(e.name) }))
    .filter((d) => d.version)
    .sort((a, b) => (newer(a.version, b.version) ? -1 : 1));

  const doomed = dirs.slice(keep);
  const kept = dirs.slice(0, keep);
  // The folder is named when it is not the usual one, so that a tool pointed
  // at the wrong place says so in its own output rather than quietly pruning
  // the real builds.
  if (base !== ROOT) console.log(`(folder: ${base})`);
  console.log(`local build directories: keeping ${kept.map((d) => d.name).join(', ') || '(none)'}`);

  let freed = 0;
  for (const d of doomed) {
    const full = path.join(base, d.name);
    const size = sizeOf(full);
    if (dryRun) {
      console.log(`  would remove ${d.name} (${(size / 1048576).toFixed(1)} MB)`);
      freed += size;
      continue;
    }

    // Empty it first: one locked file should not keep the whole build alive.
    let left = 0;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        try {
          if (entry.isDirectory()) {
            walk(child);
            try { fs.rmSync(child, { recursive: true, force: true }); } catch { /* locked */ }
          } else {
            fs.rmSync(child, { force: true });
          }
        } catch {
          left++;
        }
      }
    };
    try { walk(full); } catch { /* the directory itself is gone */ }

    try {
      fs.rmSync(full, { recursive: true, force: true });
      console.log(`  removed ${d.name} (${(size / 1048576).toFixed(1)} MB)`);
      freed += size;
    } catch {
      const remaining = sizeOf(full);
      freed += size - remaining;
      console.log(
        `  emptied ${d.name} (${(size / 1048576).toFixed(1)} MB)` +
        (remaining ? `, ${(remaining / 1048576).toFixed(1)} MB left in ${left} locked file(s)` : ''),
      );
    }
  }

  return freed;
}

/**
 * Removes the GitHub releases that are not among the newest.
 *
 * The tags are not touched: `gh release delete` without --cleanup-tag leaves
 * them, which is what keeps the version history and the release script's
 * next-version calculation intact.
 */
function pruneReleases(keep, dryRun) {
  let gh;
  try {
    gh = execFileSync('where.exe', ['gh'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim();
  } catch {
    console.log('\nGitHub releases: the GitHub CLI is not installed, so they were left alone.');
    return 0;
  }

  let list;
  try {
    list = JSON.parse(execFileSync(gh, [
      'release', 'list', '--repo', REPO, '--limit', '200', '--json', 'tagName,publishedAt',
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true }));
  } catch (err) {
    console.log(`\nGitHub releases: could not list them (${err.message}), so they were left alone.`);
    return 0;
  }

  list.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  const keepTags = list.slice(0, keep).map((r) => r.tagName);
  const dropTags = list.slice(keep).map((r) => r.tagName);

  console.log(`\nGitHub releases: keeping ${keepTags.join(', ') || '(none)'}`);

  let freed = 0;
  for (const tag of dropTags) {
    if (dryRun) {
      console.log(`  would delete ${tag}`);
      continue;
    }
    try {
      execFileSync(gh, ['release', 'delete', tag, '--repo', REPO, '--yes'], {
        stdio: 'pipe', windowsHide: true, timeout: 120000,
      });
      console.log(`  deleted ${tag}`);
    } catch (err) {
      console.log(`  left ${tag}: ${String(err.stderr || err.message).split('\n')[0]}`);
    }
  }

  return freed;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const alsoReleases = args.includes('--releases');
  const keepArg = args.find((a) => a.startsWith('--keep='));
  const keep = keepArg ? Number(keepArg.split('=')[1]) : DEFAULT_KEEP;
  const rootArg = args.find((a) => a.startsWith('--root='));
  const root = rootArg ? path.resolve(rootArg.split('=').slice(1).join('=')) : ROOT;

  if (!Number.isInteger(keep) || keep < 1) {
    console.error('--keep has to be a whole number of at least 1');
    process.exit(2);
  }

  if (rootArg && !fs.existsSync(root)) {
    console.error(`--root is not a folder: ${root}`);
    process.exit(2);
  }

  console.log(dryRun ? 'dry run - nothing is being deleted\n' : '');

  const freed = pruneLocal(keep, dryRun, root);
  if (alsoReleases) pruneReleases(keep, dryRun);

  if (!dryRun && freed) {
    console.log(`\nfreed ${(freed / 1048576).toFixed(1)} MB of build output`);
  }
}

if (require.main === module) main();

module.exports = { versionOf, newer, pruneLocal, pruneReleases, DEFAULT_KEEP };
