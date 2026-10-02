/**
 * Cut a release: bump the version, build, install, tag, publish, verify.
 *
 * The magnitude comes from the commit messages since the last tag, following
 * the conventional-commit mapping:
 *
 *   fix, perf                                   -> patch
 *   feat                                        -> minor
 *   anything with a breaking-change marker       -> major
 *   anything else, including docs and chores    -> patch
 *
 * Scott's rule is "a release after every push", so this never declines to
 * cut one: an unrecognised or docs-only commit still gets a patch release,
 * because check:released would otherwise fail forever on a push that semver
 * says needs nothing. Semver picks how big, not whether. Pass --bump to
 * override the derived level.
 *
 * The published asset is then fetched back and hashed against the file that
 * was built. A CLI reporting success is not evidence that 90 MB arrived
 * intact, and a silent truncation would be indistinguishable from success
 * until somebody tried to install the thing.
 *
 * Usage:  node tools/release.js [--dry-run] [--bump=patch|minor|major]
 */
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');
const REPO = 'ScottYates/BetterBeeper';

// A `!` before the colon, or a breaking-change trailer in the body, is a major.
// The scope comes before the bang, as in `feat(api)!: ...`, so the order of
// these groups is load-bearing: putting `!` first silently fails to match every
// scoped breaking commit and ships it as an unclassified patch.
//
// The trailer is matched case-sensitively, as the Conventional Commits spec
// defines it, and deliberately so: commit bodies routinely contain the phrase
// "not a breaking change", and treating that as a major would be worse than
// missing an unlabelled one.
const CONVENTIONAL = /^(?<type>[a-z]+)(?<scope>\([^)]*\))?(?<bang>!)?:\s+(?<subject>.+)$/s;

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

function git(args) {
  return run('git', args).trim();
}

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/** The newest tag reachable from HEAD, by commit date. */
function lastTag() {
  // gh creates the tag on the remote only. Without this the script would see
  // no tag at all after a release it just made, and re-release on the next run.
  try {
    run('git', ['fetch', '--tags', '--quiet', 'origin']);
  } catch {
    console.error('warning: could not fetch tags from origin, using what is local');
  }
  try {
    return git(['describe', '--tags', '--abbrev=0']);
  } catch {
    return null;
  }
}

/** Commit subjects since the last tag, newest first. */
function commitsSince(tag) {
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  const out = git(['log', range, '--pretty=format:%H%x1f%s%x1f%b%x1e']);
  return out
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, subject = '', body = ''] = chunk.split('\x1f');
      return { sha, subject, body };
    });
}

/** Map a commit list to a semver bump, or null when nothing is worth releasing. */
function bumpFor(commits) {
  let level = null;
  const rank = { patch: 1, minor: 2, major: 3 };
  for (const c of commits) {
    const m = CONVENTIONAL.exec(c.subject);
    const type = m ? m.groups.type : null;
    const breaking = Boolean(m && m.groups.bang) || /^BREAKING[ -]CHANGE/m.test(c.body);
    let thisLevel = null;
    if (breaking) thisLevel = 'major';
    else if (type === 'feat') thisLevel = 'minor';
    else if (['fix', 'perf'].includes(type)) thisLevel = 'patch';
    // docs, chore, test, refactor, style, build, ci: not user-visible.
    if (thisLevel && (!level || rank[thisLevel] > rank[level])) level = thisLevel;
  }
  return level;
}

function bumpVersion(version, level) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

/** Download to a temp file and hash it, so the published bytes are compared. */
function fetchSha256(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const hash = crypto.createHash('sha256');
    https
      .get(url, { headers: { 'User-Agent': 'better-beeper-release-check' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          fetchSha256(res.headers.location, dest).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        res.on('data', (chunk) => hash.update(chunk));
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(hash.digest('hex').toUpperCase())));
      })
      .on('error', reject);
  });
}

function releaseNotes(version, commits) {
  const lines = [
    `Better Beeper ${version}`,
    '',
    'A Windows desktop chat client for Beeper, built on Beeper\'s own Desktop REST API,',
    'its WebSocket event stream, and the built-in MCP server.',
    '',
    '## Install',
    '',
    `Download \`Better Beeper-${version}-x64-setup.exe\` and run it. It installs per-user, so no`,
    'administrator rights are needed, and it leaves Beeper Desktop itself alone: both can run',
    'at the same time.',
    '',
    'Beeper Desktop must be running and you must already be signed in to Beeper. Better Beeper',
    "signs in through Beeper's own OAuth flow, so it never sees or stores your Beeper password.",
    '',
    'This build is **not code-signed**, so Windows SmartScreen will warn you on first run',
    '("Windows protected your PC"). Choose "More info" then "Run anyway".',
    '',
    '## What changed',
    '',
  ];
  for (const c of commits) lines.push(`- ${c.subject} (\`${c.sha.slice(0, 7)}\`)`);
  lines.push('', 'Full notes and known limitations: <https://github.com/' + REPO + '>.', '');
  return lines.join('\n');
}

/**
 * Find the GitHub CLI.
 *
 * winget installs it to Program Files, which is not always on PATH for a
 * non-interactive shell, so fall back to the documented location rather than
 * failing with ENOENT at the last step.
 */
function findGh() {
  const candidates = [
    'gh',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'bin', 'gh.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe'),
  ];
  for (const c of candidates) {
    if (path.isAbsolute(c) ? fs.existsSync(c) : true) {
      try {
        execFileSync(c, ['--version'], { stdio: 'ignore' });
        return c;
      } catch {
        /* try the next one */
      }
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const forced = (args.find((a) => a.startsWith('--bump=')) || '').split('=')[1];

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  const current = pkg.version;
  const tag = lastTag();

  console.log(`current version : ${current}`);
  console.log(`last tag        : ${tag || '(none)'}`);
  console.log(`head            : ${git(['rev-parse', '--short', 'HEAD'])}`);

  const commits = commitsSince(tag);
  const derived = bumpFor(commits);
  console.log(`\ncommits since ${tag || 'the beginning'}: ${commits.length}`);
  for (const c of commits) console.log(`  ${c.sha.slice(0, 7)}  ${c.subject}`);

  // Never declines: the rule is a release per push, so an unrecognised or
  // docs-only commit still gets a patch rather than leaving check:released
  // failing forever on a push semver says needs nothing.
  const level = forced || derived || 'patch';
  if (!['patch', 'minor', 'major'].includes(level)) fail(`--bump must be patch, minor or major, got "${level}"`);

  const next = bumpVersion(current, level);
  console.log(`\nbump            : ${level}  (${current} -> ${next})`);
  if (!derived) console.log('note: no conventional fix/feat/breaking commit, defaulting to patch');
  if (derived && forced && derived !== forced) {
    console.log(`note: --bump=${forced} overrides the derived ${derived}`);
  }

  if (dryRun) {
    console.log('\n--dry-run: stopping before any change.');
    return;
  }

  // 1. Version in package.json. The build reads it, so it has to land first.
  pkg.version = next;
  fs.writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log(`\nwrote ${path.relative(ROOT, PKG)} at ${next}`);

  // 2. Build. A scratch output directory avoids the stale-artefact lock that
  //    bit twice on release/win-unpacked; gitignore covers release-*.
  //    electron-builder is invoked through node rather than npx: on Windows npx
  //    is a .cmd, and execFileSync cannot spawn one without a shell.
  const outDir = `release-v${next}`;
  const builderCli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  if (!fs.existsSync(builderCli)) fail(`electron-builder is not installed (${builderCli} missing)`);
  console.log(`building into ${outDir}...`);
  // --publish=never is not optional here. npm sets lifecycle_event=release for
  // this script, and electron-builder treats that as "go and publish to GitHub",
  // then fails because it has no PAT. We publish with gh a few lines below.
  // electron-builder calls this out itself: the behaviour goes away in v27.
  run(process.execPath, [
    builderCli, '--win', '--x64',
    `--config.directories.output=${outDir}`,
    '--publish=never',
  ]);

  const built = fs
    .readdirSync(path.join(ROOT, outDir))
    .find((f) => f.toLowerCase().endsWith('-setup.exe'));
  if (!built) fail(`no *-setup.exe in ${outDir}`);
  const installer = path.join(ROOT, outDir, built);
  const localHash = sha256(installer);
  console.log(`installer       : ${built}  (${(fs.statSync(installer).size / 1048576).toFixed(2)} MB)`);

  // 3. Install it, so the running copy is the thing that was published.
  console.log('installing over the existing copy...');
  run(installer, ['/S'], { stdio: 'ignore' });

  // 4. Publish. The tag is created on main at HEAD by gh.
  const gh = findGh();
  if (!gh) {
    fail('the GitHub CLI (gh) is not installed or not on PATH.\n  Install it with: winget install --id GitHub.cli -e');
  }
  const notesPath = path.join(ROOT, 'RELEASE_NOTES.md');
  fs.writeFileSync(notesPath, releaseNotes(next, commits), 'utf8');
  console.log(`publishing v${next}...`);
  run(gh, [
    'release', 'create', `v${next}`, installer,
    '--repo', REPO,
    '--title', `Better Beeper ${next}`,
    '--notes-file', notesPath,
    '--target', 'main',
  ], { stdio: 'inherit' });

  // 5. Verify. A truncated or wrong upload looks exactly like success.
  const url = `https://github.com/${REPO}/releases/download/v${next}/${encodeURIComponent(built)}`;
  const tmp = path.join(os.tmpdir(), `bb-verify-${process.pid}.exe`);
  console.log(`\nverifying the published bytes from ${url}`);
  const remoteHash = await fetchSha256(url, tmp);
  fs.rmSync(tmp, { force: true });

  if (remoteHash !== localHash) {
    fail(`published asset does not match the build\n  local  ${localHash}\n  remote ${remoteHash}`);
  }
  console.log(`match: ${localHash}`);

  // 6. Commit the version bump and the notes.
  run('git', ['add', 'package.json', 'RELEASE_NOTES.md']);
  run('git', ['commit', '-m', `Release ${next}`, '-m', `Bump ${level} from ${current}, published as a GitHub Release.`]);
  run('git', ['push', 'origin', 'main'], { stdio: 'inherit' });

  console.log(`\ndone. v${next} is live: https://github.com/${REPO}/releases/tag/v${next}`);
  console.log(`main is now ${git(['rev-parse', '--short', 'HEAD'])}, clean: ${git(['status', '--porcelain']) === ''}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\nrelease failed:', err.message);
    if (err.stdout) console.error(String(err.stdout).trim());
    console.error('\nThe version in package.json may already have been bumped. Check with');
    console.error('`git status` and `gh release list` before retrying, so you do not skip a version.');
    process.exit(1);
  });
}

// Exported so `check:bump` can test this code rather than a copy of it. A
// duplicated regex would drift, and the version number is not something to
// trust an untested copy of.
module.exports = { bumpFor, bumpVersion, CONVENTIONAL, lastTag, commitsSince };
