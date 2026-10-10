/**
 * Red proof for check:download.
 *
 * A check that has never gone red is not evidence about anything. Each mutation
 * below reintroduces one specific bug and asserts that the NAMED check fails.
 * A mutation that leaves the suite green is reported as a hole, because it means
 * that rule is not actually load-bearing.
 *
 * Every file is restored in a finally, and the restore is verified by content
 * hash: if this script is killed part way through it must not leave the tree
 * mutated, and a restore that silently did nothing is worse than none.
 *
 * Run with: node tools/download-redproof.js
 */
const path = require('path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = {
  thread: path.join(ROOT, 'src', 'renderer', 'js', 'thread.js'),
  ui: path.join(ROOT, 'src', 'renderer', 'js', 'ui.js'),
  download: path.join(ROOT, 'src', 'renderer', 'js', 'download.js'),
  css: path.join(ROOT, 'src', 'renderer', 'styles.css'),
};

const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const MUTATIONS = [
  {
    what: 'the context menu stops passing the attachment through',
    file: 'thread',
    from: '      attachment: img.__attachment,\n',
    to: '',
    expect: 'right-clicking an attachment image offers to save it',
  },
  {
    what: 'Save is offered for an image with nothing behind it',
    file: 'ui',
    from: '  if (attachment) {\n',
    to: '  if (true) {\n',
    expect: 'an image with no attachment behind it is not offered a save',
  },
  {
    what: 'the image is never stamped with its attachment',
    file: 'thread',
    from: '  img.__attachment = attachment;\n',
    to: '',
    expect: 'the image carries the attachment it was drawn from',
  },
  {
    what: 'a reused image element keeps the attachment it first had',
    file: 'thread',
    from: '    cached.__attachment = attachment;\n',
    to: '',
    expect: 'and it saves the file it is now showing, not the one it first showed',
  },
  {
    what: 'the fallback replaces the bare player instead of the wrapper',
    file: 'thread',
    from: '    wrap.replaceWith(fileNode(attachment));',
    to: '    video.replaceWith(fileNode(attachment));',
    expect: 'and it leaves no orphaned save button behind',
  },
  {
    what: 'the video loses its save button',
    file: 'thread',
    from: "        class: 'att-download',",
    to: "        class: 'att-not-a-button',",
    expect: 'the wrapper holds the player and a save button',
  },
  {
    what: 'the save button is labelled with the wrong attribute name',
    file: 'thread',
    from: "        'aria-label': videoSaveLabel(attachment),",
    to: '        ariaLabel: videoSaveLabel(attachment),',
    expect: 'the save button has a real aria-label, not a silently ignored one',
  },
  {
    what: 'the video save button does nothing',
    file: 'thread',
    from: '        onClick: () => saveAttachment(attachment),\n      },\n      el(\'span\', { text: \'⬇\' }),',
    to: '        onClick: () => {},\n      },\n      el(\'span\', { text: \'⬇\' }),',
    expect: 'the video save button saves the video',
  },
  {
    what: 'the label is singular whatever the count',
    file: 'download',
    from: "  if (n <= 1) return 'Download attachment';",
    to: "  return 'Download attachment';",
    expect: 'several attachments are plural and carry the count',
  },
  {
    what: 'an empty slot in the array is counted as a file',
    file: 'download',
    from: '  return list.filter((a) => a && typeof a === \'object\');',
    to: '  return list;',
    expect: 'an empty slot is not counted as a file',
  },
  {
    what: 'every message offers a download, even with nothing on it',
    file: 'download',
    from: '  if (count === 0) return [];\n',
    to: '',
    expect: 'a message with no attachments has no download entry',
  },
  {
    what: 'the video button says nothing when the file has no name',
    file: 'download',
    from: "  const name = attachment?.fileName || attachment?.name || 'video';\n  return `Save ${name}`;",
    to: '  return attachment?.fileName ? \'Save\' : \'\';',
    expect: 'a video with no filename still says what the button does',
  },
  {
    what: 'downloading a message saves nothing',
    file: 'thread',
    from: 'onSelect: () => { saveAttachments(downloadableAttachments(message)); },',
    to: 'onSelect: () => {},',
    expect: 'downloading a message saves every attachment, one dialog each',
  },
  {
    what: 'the invisible save button still takes clicks',
    file: 'css',
    from: 'cursor: pointer; opacity: 0; pointer-events: none;',
    to: 'cursor: pointer; opacity: 0;',
    expect: 'the save button starts unclickable while it is invisible',
  },
  {
    what: 'the button is positioned against the bubble, not the video',
    file: 'css',
    from: '.att-video-wrap {\n  position: relative; align-self: flex-start;',
    to: '.att-video-wrap {\n  position: relative;',
    expect: 'the wrapper opts out of the flex stretch that would widen it',
  },
  {
    what: 'the wrapper stretches across the bubble again',
    file: 'css',
    from: '  position: relative; align-self: flex-start;\n',
    to: '  position: relative;\n',
    expect: 'the video wrapper shrink-wraps to the video rather than the bubble',
  },
];

function runCheck() {
  try {
    const out = execFileSync('npm', ['run', 'check:download', '--silent'], {
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

/** The PASS/FAIL verdict for one named check, or null if it never printed. */
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

/**
 * Apply one edit, whatever line endings the file happens to use.
 *
 * The patterns below are all written with plain \n, because that is what is
 * readable. Half the repo is CRLF and half is LF, so a pattern is retried with
 * CRLF line endings before it is called unmatched - rather than every mutation
 * carrying its own guess about the file it lands in, which is a rule written
 * once per file and certain to drift.
 */
function applyEdit(original, from, to) {
  for (const pattern of [from, from.replace(/\n/g, '\r\n')]) {
    if (pattern !== from && !original.includes('\r\n')) continue;
    const count = original.split(pattern).length - 1;
    if (count === 1) return { ok: true, text: original.replace(pattern, to) };
    if (count > 1) return { ok: false, why: 'pattern appears ' + count + ' times' };
  }
  return { ok: false, why: 'pattern not found' };
}

const before = {};
for (const [k, p] of Object.entries(FILES)) before[k] = hash(p);

let caught = 0;
const holes = [];

console.log(`baseline: ${runCheck().out.match(/(\d+\/\d+) checks passed/)?.[1] || '?'}\n`);

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

    const { code, out } = runCheck();
    const verdict = verdictFor(out, m.expect);
    if (verdict === null) {
      holes.push(`${m.what} -- "${m.expect}" never printed`);
      console.log(`HOLE  ${m.what}\n      the named check never printed`);
    } else if (verdict === 'FAIL') {
      caught++;
      console.log(`RED   ${m.what}\n      "${m.expect}" failed as it should`);
    } else {
      holes.push(`${m.what} -- "${m.expect}" stayed green`);
      console.log(`HOLE  ${m.what}\n      "${m.expect}" stayed green (exit ${code})`);
    }
  } finally {
    if (applied) fs.writeFileSync(target, original, 'utf8');
    // Verified, not assumed: a restore that did nothing would leave the next
    // mutation testing a file nobody is reading any more.
    const now = hash(target);
    if (now !== before[m.file]) {
      console.log(`\nRESTORE FAILED for ${path.basename(target)}: expected ${before[m.file]}, got ${now}`);
      process.exit(1);
    }
  }
}

console.log(`\n${caught}/${MUTATIONS.length} mutations caught by the check they were written for`);
if (holes.length) {
  console.log('\nHoles (the rule is not actually load-bearing):');
  for (const h of holes) console.log(`  - ${h}`);
  process.exit(1);
}
process.exit(0);
