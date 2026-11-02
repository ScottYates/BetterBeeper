/**
 * Red proof for the resolved-avatar cache.
 *
 * The cache is what stops a rebuilt avatar from flashing, and it used to grow
 * for ever: every avatar URL the app had ever seen stayed in it until the
 * window closed. It also used to keep handing out a picture whose file the
 * media pruner had removed, so the avatar showed a broken image for good.
 *
 * A check that has never been seen to fail is not evidence of anything. This
 * reintroduces each part of the fix one at a time and asserts that the NAMED
 * check fails. A mutation that leaves the check green is reported as a hole.
 *
 * The last one is the other direction: a neutral rewrite that must stay green.
 *
 * Every file is restored in a finally, verified by content hash.
 *
 * Run with: node tools/avatar-redproof.js
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'src', 'renderer', 'js', 'sidebar.js');

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

/** `from` and `to` may be arrays, for a mutation that needs more than one piece changed. */
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
    what: 'the cache is not bounded',
    from: '  while (resolvedAvatars.size > RESOLVED_AVATARS) {\n'
      + '    const oldest = resolvedAvatars.keys().next().value;\n'
      + '    resolvedAvatars.delete(oldest);\n'
      + '  }\n',
    to: '',
    expect: 'the resolved pictures are forgotten when there are too many',
  },
  {
    // Dropping the newest instead of the oldest does not just change which
    // picture goes: it drops the picture that was just asked for, so the one
    // in use is the one that goes. That is the case that catches it.
    what: 'the newest picture is dropped instead of the oldest',
    from: '    const oldest = resolvedAvatars.keys().next().value;\n',
    to: '    const oldest = [...resolvedAvatars.keys()].pop();\n',
    expect: 'a picture that is in use is not the one that goes',
  },
  {
    what: 'a picture that failed to load is still remembered',
    from: 'function resolveAvatarAgain(node, imgURL, lightbox) {\n  forgetAvatar(imgURL);\n',
    to: 'function resolveAvatarAgain(node, imgURL, lightbox) {\n',
    expect: 'and the failed picture is not remembered',
  },
  {
    what: 'a picture that failed to load is never asked for again',
    from: '      node.append(avatarImg(url, lightbox, isRetry ? null : () => {\n'
      + '        // The picture did not load, so the file behind it is not there. The\n'
      + '        // media pruner can remove it while the app is open, and a cache that\n'
      + '        // keeps handing out a picture that is not there shows a broken image\n'
      + '        // for ever. So the entry is dropped and the picture is asked for\n'
      + '        // again.\n'
      + '        resolveAvatarAgain(node, imgURL, lightbox);\n'
      + '      }));\n',
    to: '      node.append(avatarImg(url, lightbox, null));\n',
    expect: 'a picture whose file has gone is asked for again',
  },
  {
    // Not a bug. The same rule, written the other way round.
    what: 'TOLERATED: the size is checked with a different comparison',
    from: '  while (resolvedAvatars.size > RESOLVED_AVATARS) {',
    to: '  while (resolvedAvatars.size >= RESOLVED_AVATARS + 1) {',
    expect: 'the resolved pictures are forgotten when there are too many',
    expectGreen: true,
  },
];

function runCheck() {
  try {
    const out = execFileSync('npm.cmd', ['run', 'check:sidebar', '--silent'], {
      cwd: ROOT, encoding: 'utf8', timeout: 300000, shell: true,
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
    const edit = applyEdit(original, m.from, m.to);
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
