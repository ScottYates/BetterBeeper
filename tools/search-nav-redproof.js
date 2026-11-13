/**
 * Red proof for the search arrows.
 *
 * There are two searches: the conversation's own, which steps through its
 * matches, and the sidebar's, which steps through the results it drew. The
 * arrows are what both are read as being for, and until now neither set of
 * buttons had been driven by a check - the conversation's arrows were on
 * screen and only the keyboard behind them was ever exercised.
 *
 * A check that has never been seen to fail is not evidence of anything. This
 * reintroduces each part of the stepping one at a time and asserts that the
 * NAMED check fails. A mutation that leaves the suite green is reported as a
 * hole, because it means that rule is not actually load-bearing.
 *
 * The last one is the other direction: a neutral rewrite that must stay green.
 *
 * Every file is restored in a finally, verified by content hash.
 *
 * Run with: node tools/search-nav-redproof.js
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = {
  sidebar: path.join(ROOT, 'src', 'renderer', 'js', 'sidebar.js'),
  nav: path.join(ROOT, 'src', 'renderer', 'js', 'search-nav.js'),
  threadSearch: path.join(ROOT, 'src', 'renderer', 'js', 'thread-search.js'),
};

// Which suite proves which file. The step rule is shared, so changing it
// shows up in both searches; the sidebar's suite is the one that proves it.
const SUITE = {
  sidebar: 'check:sidebar',
  nav: 'check:sidebar',
  threadSearch: 'check:threadsearch',
};

const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/**
 * Replace `from` with `to`, requiring it to appear exactly once.
 *
 * `from` and `to` may be arrays, for a mutation that needs more than one
 * piece changed.
 *
 * The repository is mostly LF with a few CRLF files, so a literal written with
 * \n would silently not match a CRLF file, every mutation would report SKIP, and
 * the suite would look green for the wrong reason.
 */
function replaceOnce(original, from, to) {
  for (const pattern of [from, from.replace(/\n/g, '\r\n')]) {
    if (pattern !== from && !original.includes('\r\n')) continue;
    const count = original.split(pattern).length - 1;
    if (count === 1) return { ok: true, text: original.replace(pattern, to) };
    if (count > 1) return { ok: false, why: 'pattern appears ' + count + ' times' };
  }
  return { ok: false, why: 'pattern not found' };
}

function applyEdit(original, from, to) {
  const froms = Array.isArray(from) ? from : [from];
  const tos = Array.isArray(to) ? to : [to];
  if (froms.length !== tos.length) return { ok: false, why: 'mismatched edit counts' };
  let text = original;
  for (let i = 0; i < froms.length; i++) {
    const result = replaceOnce(text, froms[i], tos[i]);
    if (!result.ok) return { ok: false, why: result.why };
    text = result.text;
  }
  return { ok: true, text };
}

const MUTATIONS = [
  {
    what: 'the next arrow steps backwards',
    file: 'sidebar',
    from: "  $('#search-next')?.addEventListener('click', () => stepSearchResults(1));",
    to: "  $('#search-next')?.addEventListener('click', () => stepSearchResults(-1));",
    expect: 'the next arrow steps forward',
  },
  {
    what: 'the arrows are not wired to anything',
    file: 'sidebar',
    from: [
      "  $('#search-prev')?.addEventListener('click', () => stepSearchResults(-1));\n",
      "  $('#search-next')?.addEventListener('click', () => stepSearchResults(1));\n",
    ],
    to: ['', ''],
    expect: 'the next arrow steps forward',
  },
  {
    what: 'the counter never moves',
    file: 'sidebar',
    from: '  count.textContent = searchRows.length ? `${searchIndex + 1} of ${searchRows.length}` : \'No matches\';',
    to: '  count.textContent = searchRows.length ? `1 of ${searchRows.length}` : \'No matches\';',
    expect: 'the next arrow steps forward',
  },
  {
    what: 'the current result is not marked',
    file: 'sidebar',
    from: "    row.classList.add('is-current');\n",
    to: '',
    expect: 'the first result is the current one',
  },
  {
    what: 'the current result is not brought into view',
    file: 'sidebar',
    from: "    row.scrollIntoView({ block: 'nearest' });\n",
    to: '',
    expect: 'the current result is brought into view',
  },
  {
    what: 'the Enter key steps backwards',
    file: 'sidebar',
    from: '      if (searchRows.length) stepSearchResults(event.shiftKey ? -1 : 1);',
    to: '      if (searchRows.length) stepSearchResults(-1);',
    expect: 'Enter steps to the next result',
  },
  {
    what: 'Enter steps through results that are not the ones asked for',
    file: 'sidebar',
    from: '      const typed = input.value.trim();\n'
      + '      if (typed !== state.searchQuery) {\n'
      + '        state.searchQuery = typed;\n'
      + '        runSearch();\n'
      + '        return;\n'
      + '      }\n',
    to: '',
    expect: 'Enter searches for what is in the box, not the old results',
  },
  {
    what: 'stepping past the end does not wrap',
    file: 'nav',
    from: '  if (next >= total) return 0;',
    to: '  if (next >= total) return next;',
    expect: 'stepping past the end wraps to the first result',
  },
  {
    what: 'stepping back past the start does not wrap',
    file: 'nav',
    from: '  if (next < 0) return total - 1;',
    to: '  if (next < 0) return next;',
    expect: 'stepping back past the start wraps to the last result',
  },
  {
    what: 'the conversation\'s next button does nothing',
    file: 'threadSearch',
    from: '  if (next) next.addEventListener(\'click\', () => step(1));',
    to: '  if (next) next.addEventListener(\'click\', () => {});',
    expect: 'the next button steps to the next match',
  },
  {
    what: 'the conversation\'s previous button steps forward',
    file: 'threadSearch',
    from: '  if (prev) prev.addEventListener(\'click\', () => step(-1));',
    to: '  if (prev) prev.addEventListener(\'click\', () => step(1));',
    expect: 'the previous button steps back',
  },
  {
    what: 'the conversation\'s arrow does not bring the match into view',
    file: 'threadSearch',
    from: '  deps.scrollToMessage(hit.id);\n',
    to: '',
    expect: 'the arrow brings the match into view',
  },
  {
    // Not a bug. The same rule, written the other way round.
    what: 'TOLERATED: the step is written as a branch',
    file: 'nav',
    from: '  const next = current + (step < 0 ? -1 : 1);',
    to: '  const next = step < 0 ? current - 1 : current + 1;',
    expect: 'the next arrow steps forward',
    expectGreen: true,
  },
];

function runCheck(suite) {
  try {
    const out = execFileSync('npm.cmd', ['run', suite, '--silent'], { windowsHide: true,
      cwd: ROOT, encoding: 'utf8', timeout: 600000, shell: true,
    });
    return { code: 0, out };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      out: String(err.stdout || '') + String(err.stderr || ''),
    };
  }
}

/** The verdict for the one named check, ignoring every other line. */
function verdictFor(out, name) {
  for (const line of out.split(/\r?\n/)) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!clean.startsWith('PASS') && !clean.startsWith('FAIL')) continue;
    const rest = clean.slice(5).trim();
    const detail = rest.indexOf('  [');
    const printed = detail === -1 ? rest : rest.slice(0, detail);
    if (printed === name) return clean.startsWith('FAIL') ? 'FAIL' : 'PASS';
  }
  return null;
}

const before = {};
for (const [k, p] of Object.entries(FILES)) before[k] = hash(p);

let caught = 0;
let tolerated = 0;
const holes = [];
const expected = MUTATIONS.filter((m) => !m.expectGreen).length;
console.log(`baseline: ${runCheck('check:sidebar').out.match(/(\d+\/\d+) checks passed/)?.[1] || '?'}\n`);

for (const m of MUTATIONS) {
  const target = FILES[m.file];
  const original = fs.readFileSync(target, 'utf8');
  let applied = false;
  try {
    const edit = applyEdit(original, m.from, m.to);
    if (!edit.ok) {
      holes.push(`${m.what} -- ${edit.why}`);
      console.log(`SKIP  ${m.what}\n      ${edit.why}`);
      continue;
    }
    fs.writeFileSync(target, edit.text, 'utf8');
    applied = true;

    const { out } = runCheck(SUITE[m.file]);
    const verdict = verdictFor(out, m.expect);
    if (verdict === null) {
      holes.push(`${m.what} -- "${m.expect}" never printed`);
      console.log(`HOLE  ${m.what}\n      the named check never printed`);
    } else if (m.expectGreen) {
      if (verdict === 'PASS') {
        tolerated++;
        console.log(`TOLERATED  ${m.what}\n      stayed green, as it should`);
      } else {
        holes.push(`${m.what} -- went red on a neutral rewrite, so it is pinned to the code`);
        console.log(`HOLE  ${m.what}\n      went red on a neutral rewrite`);
      }
    } else if (verdict === 'FAIL') {
      caught++;
      console.log(`RED   ${m.what}\n      "${m.expect}" failed as it should`);
    } else {
      holes.push(`${m.what} -- "${m.expect}" stayed green`);
      console.log(`HOLE  ${m.what}\n      "${m.expect}" stayed green`);
    }
  } finally {
    if (applied) fs.writeFileSync(target, original, 'utf8');
    const now = hash(target);
    if (now !== before[m.file]) {
      console.log(`\nRESTORE FAILED for ${path.basename(target)}`);
      process.exit(1);
    }
  }
}

console.log(`\n${caught}/${expected} mutations caught by the check they were written for`);
console.log(`${tolerated}/${MUTATIONS.length - expected} neutral rewrites tolerated (not re-pinned)`);
if (holes.length) {
  console.log('\nHoles:');
  for (const h of holes) console.log(`  - ${h}`);
  process.exit(1);
}
process.exit(0);
