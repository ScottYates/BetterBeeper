/**
 * check:bump - the version number is chosen by code, so test that code.
 *
 * tools/release.js decides patch, minor or major from the commit messages
 * since the last tag. Getting that wrong is quiet and expensive: a breaking
 * change shipped as a patch cannot be undone, and a docs commit shipped as a
 * minor trains everyone to ignore the version numbers.
 *
 * This requires the real functions out of release.js rather than repeating
 * the regex here, because a copy would drift and then quietly stop testing
 * anything.
 *
 * Run with `npm run check:bump`.
 */
const { bumpFor, bumpVersion } = require('./release.js');

const S = (subject, body = '') => ({ subject, body });

const cases = [
  // The conventional mapping.
  { want: 'patch', commits: [S('fix: a bug')] },
  { want: 'patch', commits: [S('perf: faster')] },
  { want: 'minor', commits: [S('feat: a feature')] },

  // Not user-visible, so they do not move the level by themselves.
  { want: null, commits: [S('docs: words')] },
  { want: null, commits: [S('chore: tidy')] },
  { want: null, commits: [S('test: more tests')] },
  { want: null, commits: [S('refactor: move things')] },
  { want: null, commits: [S('build: deps')] },
  { want: null, commits: [S('ci: pipeline')] },
  { want: null, commits: [S('style: formatting')] },

  // Breaking, three ways.
  { want: 'major', commits: [S('feat!: breaking feature')] },
  { want: 'major', commits: [S('fix!: breaking fix')] },
  { want: 'major', commits: [S('chore: ordinary', 'BREAKING CHANGE: it is not')] },
  { want: 'major', commits: [S('chore: ordinary', 'BREAKING-CHANGE: hyphen form')] },

  // The trailer is case-sensitive on purpose: bodies routinely say
  // "not a breaking change", and reading that as a major would be worse than
  // missing an unlabelled one. The commit is still a fix, so still a patch.
  { want: null, commits: [S('chore: ordinary', 'breaking change: lower case')] },
  { want: 'patch', commits: [S('fix: a bug', 'this is not a BREAKING CHANGE')] },

  // Scopes.
  { want: 'patch', commits: [S('fix(scope): scoped fix')] },
  { want: 'minor', commits: [S('feat(sidebar): scoped feature')] },
  { want: 'major', commits: [S('feat(api)!: scoped and breaking')] },

  // Not conventional commits at all. These still get a release, but the level
  // falls back to patch in release.js rather than here.
  { want: null, commits: [S('random words with no type')] },
  { want: null, commits: [S('Some Title Case Commit')] },
  { want: null, commits: [S('Merge branch main into feature')] },

  // A run of commits takes the highest level, whatever the order.
  { want: 'minor', commits: [S('chore: c'), S('fix: a'), S('feat: b')] },
  { want: 'minor', commits: [S('feat: b'), S('fix: a'), S('chore: c')] },
  { want: 'major', commits: [S('fix: a'), S('feat!: b')] },
  { want: 'patch', commits: [S('fix: a'), S('docs: d')] },
  { want: 'patch', commits: [S('docs: a'), S('fix: b')] },
  { want: null, commits: [S('docs: a'), S('chore: b'), S('test: c')] },
  { want: null, commits: [] },
];

const versionCases = [
  { from: '1.0.0', level: 'patch', want: '1.0.1' },
  { from: '1.0.9', level: 'patch', want: '1.0.10' },
  { from: '1.9.4', level: 'patch', want: '1.9.5' },
  { from: '1.0.0', level: 'minor', want: '1.1.0' },
  { from: '1.9.4', level: 'minor', want: '1.10.0' },
  { from: '1.9.4', level: 'major', want: '2.0.0' },
  { from: '0.9.9', level: 'major', want: '1.0.0' },
];

let failed = 0;
for (const { commits, want } of cases) {
  const got = bumpFor(commits);
  const ok = got === want;
  if (!ok) failed++;
  const label = commits.map((c) => c.subject).join(' | ') || '(no commits)';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} -> ${got} (want ${want})`);
}

for (const { from, level, want } of versionCases) {
  const got = bumpVersion(from, level);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${from} + ${level} -> ${got} (want ${want})`);
}

const total = cases.length + versionCases.length;
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
