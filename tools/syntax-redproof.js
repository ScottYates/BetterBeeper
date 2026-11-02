/**
 * Red proof for the harness detector.
 *
 * The syntax check pulls a check harness's page script out of its template
 * literal and parses it on its own, because that is what catches a stray
 * backtick before Electron turns it into a dialog on the desktop. Finding the
 * harness means finding its declaration.
 *
 * The declaration is matched at the start of a line, because the marker text
 * also appears inside a string: the launcher check writes a deliberately broken
 * harness as a fixture, so it has to hold the marker text. A detector that
 * searched the whole file found that fixture and reported a file that is
 * perfectly fine as broken - which is the bug this was written to fix.
 *
 * A check that has never been seen to fail is not evidence of anything. This
 * reintroduces each part of the rule one at a time and asserts that the NAMED
 * check fails. A mutation that leaves the check green is reported as a hole.
 *
 * The last one is the other direction: a neutral rewrite that must stay green.
 *
 * Every file is restored in a finally, verified by content hash.
 *
 * Run with: node tools/syntax-redproof.js
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'tools', 'syntax-check.js');

const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/**
 * Replace `from` with `to`, requiring it to appear exactly once.
 *
 * The repository is mostly LF with a few CRLF files, so a literal written with
 * \n would silently not match a CRLF file and the mutation would report SKIP.
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

const MUTATIONS = [
  {
    what: 'the marker is matched anywhere in the file, not at the start of a line',
    from: 'const HARNESS_DECL = /^[ \\t]*const harness = /m;',
    to: 'const HARNESS_DECL = /const harness = /;',
    expect: 'a marker inside a string is not a harness',
  },
  {
    what: 'a harness whose page script does not parse is not reported',
    from: '    return `harness page script does not parse: ${err.message}`;',
    to: '    return null;',
    expect: 'a harness whose page script does not parse is reported',
  },
  {
    what: 'a harness opened with String.raw is not recognised',
    from: 'const HARNESS_OPEN = /^[ \\t]*const harness = (?:String\\.raw)?`/m;',
    to: 'const HARNESS_OPEN = /^[ \\t]*const harness = `/m;',
    expect: 'every harness found in the tools directory parses',
  },
  {
    // Not a bug. The same test, written the other way round.
    what: 'TOLERATED: the declaration is found with exec instead of test',
    from: '  if (!HARNESS_DECL.test(source)) return null;',
    to: '  if (HARNESS_DECL.exec(source) === null) return null;',
    expect: 'a marker inside a string is not a harness',
    expectGreen: true,
  },
];

function runCheck() {
  try {
    const out = execFileSync('npm.cmd', ['run', 'check:harness', '--silent'], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000, shell: true,
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

const before = hash(TARGET);

let caught = 0;
let tolerated = 0;
const holes = [];
const expected = MUTATIONS.filter((m) => !m.expectGreen).length;
console.log(`baseline: ${runCheck().out.match(/(\d+\/\d+) checks passed/)?.[1] || '?'}\n`);

for (const m of MUTATIONS) {
  const original = fs.readFileSync(TARGET, 'utf8');
  let applied = false;
  try {
    const edit = replaceOnce(original, m.from, m.to);
    if (!edit.ok) {
      holes.push(`${m.what} -- ${edit.why}`);
      console.log(`SKIP  ${m.what}\n      ${edit.why}`);
      continue;
    }
    fs.writeFileSync(TARGET, edit.text, 'utf8');
    applied = true;

    const { out } = runCheck();
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
    if (applied) fs.writeFileSync(TARGET, original, 'utf8');
    if (hash(TARGET) !== before) {
      console.log(`\nRESTORE FAILED for ${path.basename(TARGET)}`);
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
