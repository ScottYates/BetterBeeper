/**
 * Red proof for check:spellmenu.
 *
 * The bug: right-clicking a word with a spell-check squiggle under it did
 * nothing. The squiggles worked; Electron simply builds no context menu unless
 * something builds one, and nothing did.
 *
 * Every mutation below reintroduces one part of that, and asserts that the NAMED
 * check fails. A mutation that leaves the suite green is reported as a hole,
 * because it means that rule is not actually load-bearing.
 *
 * Every file is restored in a finally, verified by content hash.
 *
 * Run with: node tools/spellmenu-redproof.js
 */
const path = require('path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = {
  spell: path.join(ROOT, 'src', 'main', 'spell-context.js'),
  menu: path.join(ROOT, 'src', 'main', 'context-menu.js'),
  main: path.join(ROOT, 'src', 'main', 'main.js'),
};

const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function applyEdit(original, from, to) {
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
    what: 'no menu is offered for a misspelled word at all',
    file: 'spell',
    from: "  if (typeof params.misspelledWord === 'string' && params.misspelledWord.trim()) return true;",
    to: '  if (false) return true;',
    expect: 'a menu is offered for a misspelled word',
  },
  {
    what: 'the suggestions are not put on the menu',
    file: 'spell',
    from: '      items.push({ id: \'replace\', label: suggestion, replaces: suggestion });',
    to: '',
    expect: 'the suggestions are offered, in the order given',
  },
  {
    what: 'the suggestions come out in the wrong order',
    file: 'spell',
    from: '    for (const suggestion of suggestions.slice(0, MAX_SUGGESTIONS)) {',
    to: '    for (const suggestion of suggestions.slice(0, MAX_SUGGESTIONS).reverse()) {',
    expect: 'the suggestions are offered, in the order given',
  },
  {
    what: 'the menu forgets which word it was about',
    file: 'spell',
    from: "    items.push({ id: 'add-word', label: `Add \"${word}\" to dictionary`, word });",
    to: "    items.push({ id: 'add-word', label: 'Add to dictionary' });",
    expect: 'the word can be added to the dictionary',
  },
  {
    what: 'add-to-dictionary is skipped when there are no suggestions',
    file: 'spell',
    from: '  if (word) {\n    for (const suggestion of suggestions.slice(0, MAX_SUGGESTIONS)) {',
    to: '  if (word && suggestions.length) {\n    for (const suggestion of suggestions.slice(0, MAX_SUGGESTIONS)) {',
    expect: 'a word the dictionary has never seen can still be taught',
  },
  {
    what: 'every suggestion is put on the menu',
    file: 'spell',
    from: 'suggestions.slice(0, MAX_SUGGESTIONS)',
    to: 'suggestions',
    expect: 'a long suggestion list is cut down to a menu',
  },
  {
    what: 'a native menu pops up on top of the image popover',
    file: 'spell',
    from: "  if (!params || typeof params !== 'object') return false;\n  if (typeof params.misspelledWord === 'string' && params.misspelledWord.trim()) return true;",
    to: "  if (!params || typeof params !== 'object') return false;\n  return true;",
    expect: 'right-clicking an image is left to the app',
  },
  {
    what: 'a menu appears on a blank click',
    file: 'spell',
    from: "  if (typeof params.misspelledWord === 'string' && params.misspelledWord.trim()) return true;\n  if (params.isEditable === true) return true;",
    to: '  return true;',
    expect: 'right-clicking empty space offers nothing',
  },
  {
    what: 'the composer loses its text actions',
    file: 'spell',
    from: "  if (params.isEditable) items.push({ id: 'cut', label: 'Cut' });",
    to: '',
    expect: 'the composer still gets cut, copy, paste and select all',
  },
  {
    what: 'paste is offered in a message, which is not editable',
    file: 'spell',
    from: "  if (params.isEditable) items.push({ id: 'paste', label: 'Paste' });",
    to: "  items.push({ id: 'paste', label: 'Paste' });",
    expect: 'paste is not offered where there is no field to paste into',
  },
  {
    what: 'copy is offered with nothing selected',
    file: 'spell',
    from: "  if (params.selectionText) items.push({ id: 'copy', label: 'Copy' });",
    to: "  items.push({ id: 'copy', label: 'Copy' });",
    expect: 'copy is only offered where there is something selected',
  },
  {
    what: 'the menu ends in a divider',
    file: 'spell',
    from: '  while (out.length && out[out.length - 1].id === \'sep\') out.pop();',
    to: '  while (false) out.pop();',
    expect: 'a trailing divider is never left at the bottom',
  },
  {
    what: 'the divider trimming is never applied',
    file: 'menu',
    from: '  const items = trimSeparators(spellContextItems(params));',
    to: '  const items = spellContextItems(params);',
    expect: 'the menu is built from the trimmed list',
  },
  {
    what: 'a misspelled word with no other action has no way out',
    file: 'spell',
    from: "  if (params.isEditable || params.selectionText || word) items.push({ id: 'sep' });\n  items.push({ id: 'select-all', label: 'Select all' });",
    to: "  if (params.isEditable || params.selectionText || word) items.push({ id: 'sep' });",
    expect: 'a misspelled word with nothing else still gets select all',
  },
  {
    what: 'nonsense input throws instead of being ignored',
    file: 'spell',
    from: '  const word = typeof params.misspelledWord === \'string\' ? params.misspelledWord.trim() : \'\';',
    to: '  const word = params.misspelledWord.trim();',
    expect: 'nonsense input produces no menu rather than throwing',
  },
  {
    what: 'the main window stops listening for the event',
    file: 'main',
    from: '  wireSpellContextMenu(mainWindow.webContents);\n',
    to: '',
    expect: 'the main window attaches the handler',
  },
  {
    what: 'the handler is never subscribed',
    file: 'menu',
    from: "  webContents.on('context-menu', (_event, params) => {",
    to: '  const never = (_event, params) => {',
    expect: 'the handler actually listens for the event',
  },
  {
    what: 'choosing a suggestion does nothing',
    file: 'menu',
    from: '        click: () => webContents.replaceMisspelling(entry.replaces),',
    to: '        click: () => {},',
    expect: 'choosing a suggestion replaces the misspelling',
  },
  {
    what: 'add-to-dictionary does nothing',
    file: 'menu',
    from: '        click: () => webContents.session.addWordToSpellCheckerDictionary(entry.word),',
    to: '        click: () => {},',
    expect: 'choosing add-to-dictionary teaches the word',
  },
];

function runCheck() {
  try {
    const out = execFileSync('npm', ['run', 'check:spellmenu', '--silent'], {
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

    const { out } = runCheck();
    const verdict = verdictFor(out, m.expect);
    if (verdict === null) {
      holes.push(`${m.what} -- "${m.expect}" never printed`);
      console.log(`HOLE  ${m.what}\n      the named check never printed`);
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

console.log(`\n${caught}/${MUTATIONS.length} mutations caught by the check they were written for`);
if (holes.length) {
  console.log('\nHoles (the rule is not actually load-bearing):');
  for (const h of holes) console.log(`  - ${h}`);
  process.exit(1);
}
process.exit(0);