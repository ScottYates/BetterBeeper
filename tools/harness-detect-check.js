/**
 * The syntax check has to find a check harness, and it has to do it without
 * finding one that is not there.
 *
 * A harness is a page script held in a template literal, and the syntax check
 * pulls that literal out and parses it on its own - that is what catches a
 * backtick in a comment before Electron turns it into a dialog on the desktop.
 *
 * Finding it means looking for the declaration of the harness variable. The
 * launcher check writes a deliberately broken harness as a fixture, so the
 * marker text has to appear inside a string somewhere in this repository. A
 * detector that searched the whole file for the marker found that fixture and
 * reported a file that is perfectly fine as broken.
 *
 * So the marker is matched at the start of a line, and that is the rule this
 * check holds up.
 *
 * This runs under plain node. It requires the detector, so it needs the file
 * to export it without running a walk of the whole repository.
 *
 * Run with: npm run check:harness
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { checkHarness, HARNESS_DECL } = require('./syntax-check.js');

const cases = [];
const add = (name, ok, detail = '') => cases.push([name, ok === true, ok === true ? '' : String(detail)]);

// The marker is spelled here rather than written out, so that this file does
// not itself look like a harness to the detector it is testing.
const MARK = 'const harness = ';

// --- the marker inside a string is not a harness ---------------------------

const inAString = 'const fixture = "' + MARK + '`a line`;";\n';
add('a marker inside a string is not a harness',
  checkHarness('fixture', inAString) === null,
  checkHarness('fixture', inAString) || '');

// The real fixture in the launcher check, read from the file it lives in.
const launcherSource = fs.readFileSync(path.join(ROOT, 'tools', 'launcher-check.js'), 'utf8');
add('the launcher check\'s own fixture is not mistaken for a harness',
  checkHarness('launcher-check.js', launcherSource) === null,
  checkHarness('launcher-check.js', launcherSource) || '');

add('and the launcher check does hold the marker text',
  launcherSource.includes(MARK),
  'the fixture is supposed to contain the marker text');

// --- a real harness is found -----------------------------------------------

const good = MARK + '`\n  (async () => { return 1; })\n  `;\n';
add('a harness that parses is not reported',
  checkHarness('good', good) === null,
  checkHarness('good', good) || '');

add('and it is recognised as a harness',
  HARNESS_DECL.test(good));

const sidebarSource = fs.readFileSync(path.join(ROOT, 'tools', 'sidebar-check.js'), 'utf8');
add('the sidebar check\'s harness is found',
  HARNESS_DECL.test(sidebarSource));
add('and its page script is not reported',
  checkHarness('sidebar-check.js', sidebarSource) === null,
  checkHarness('sidebar-check.js', sidebarSource) || '');

// --- a broken harness is reported ------------------------------------------

const brokenPage = MARK + '`\n  (async () => { return 1; )\n  `;\n';
const brokenPageProblem = checkHarness('broken', brokenPage);
add('a harness whose page script does not parse is reported',
  !!brokenPageProblem && /does not parse/.test(brokenPageProblem),
  brokenPageProblem || 'no problem was reported');

const noOpening = 'const harness = undefined;\n';
const noOpeningProblem = checkHarness('no-opening', noOpening);
add('a harness with no opening backtick is reported',
  !!noOpeningProblem && /no opening backtick/.test(noOpeningProblem),
  noOpeningProblem || 'no problem was reported');

const noClosing = MARK + '`\n  (async () => { return 1; })\n';
const noClosingProblem = checkHarness('no-closing', noClosing);
add('a harness with no closing backtick is reported',
  !!noClosingProblem && /no closing backtick/.test(noClosingProblem),
  noClosingProblem || 'no problem was reported');

// --- the repository as it stands --------------------------------------------

const toolFiles = fs.readdirSync(path.join(ROOT, 'tools'))
  .filter((name) => name.endsWith('.js'));
const found = toolFiles.filter((name) => {
  const source = fs.readFileSync(path.join(ROOT, 'tools', name), 'utf8');
  return HARNESS_DECL.test(source);
});

add('the repository has harnesses to find',
  found.length >= 20,
  'only ' + found.length + ' found');

add('every harness found in the tools directory parses',
  found.every((name) => {
    const source = fs.readFileSync(path.join(ROOT, 'tools', name), 'utf8');
    return checkHarness(name, source) === null;
  }),
  found.filter((name) => {
    const source = fs.readFileSync(path.join(ROOT, 'tools', name), 'utf8');
    return checkHarness(name, source) !== null;
  }).join(', '));

// --- the report -------------------------------------------------------------

let failed = 0;
for (const [name, ok, detail] of cases) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed ? 1 : 0);
