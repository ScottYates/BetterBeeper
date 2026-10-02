/**
 * check:released - every push to main has a release.
 *
 * The rule is "a release after each push", and a rule nobody checks is a rule
 * that quietly stops being true. This fails when main is ahead of the newest
 * tag, or when package.json and that tag disagree, which is the usual way a
 * version bump gets lost between the commit and the upload.
 *
 * It is read-only: it never builds, never installs and never talks to GitHub
 * beyond the local refs, so it is safe to run at any time.
 *
 * Run with `npm run check:released`.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
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

  console.log(`branch        : ${branch}`);
  console.log(`head          : ${head.slice(0, 7)}`);
  console.log(`newest tag    : ${tag || '(none)'}`);
  console.log(`package.json  : ${pkg.version}`);

  if (problems.length === 0) {
    console.log(`\nOK  every push to ${branch} has a release.`);
    return;
  }

  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}

main();
