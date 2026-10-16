/**
 * Dev check: the right-click menu over a misspelled word.
 *
 * Reported from using the app: right-clicking a word with a red squiggle under
 * it did nothing at all.
 *
 * The squiggles were never broken - Chromium spellchecks the thread - so the
 * obvious hypothesis, that spellcheck was off, is wrong, and `spellcheck: true`
 * is set in the window. The real reason is one level up: Electron shows no
 * context menu by default on any platform, and there was no `context-menu`
 * handler, so nothing ever built one. The image menu in the thread is a
 * renderer popover and does not reach this path.
 *
 * What is decided here is what belongs on that menu. The rule is pure
 * (spell-context.js) and driven directly, with no Electron, because the wiring
 * is three lines and the decisions are all of the interest.
 *
 * Run with `npm run check:spellmenu`.
 */
const path = require('path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const spellPath = path.join(ROOT, 'src', 'main', 'spell-context.js');
const menuPath = path.join(ROOT, 'src', 'main', 'context-menu.js');
const mainPath = path.join(ROOT, 'src', 'main', 'main.js');

const { spellContextItems, shouldShowContextMenu, trimSeparators } = require(spellPath);

const cases = [];
// Takes either a thunk or a plain boolean, and only a real `true` counts: these
// assertions are written as `cond || 'why it failed'`, and a helper that coerced
// with !! would read that reason - a non-empty string - as a pass, making every
// one of them green forever. A throw is a failure too: one assertion must never
// be able to take the suite down with it.
const add = (name, fnOrValue, detail) => {
  let ok = false;
  let why = '';
  try {
    const value = typeof fnOrValue === 'function' ? fnOrValue() : fnOrValue;
    ok = value === true;
    if (!ok) why = detail ?? String(value);
  } catch (e) {
    why = 'threw: ' + e.message;
  }
  cases.push([name, ok, why]);
};

const WORD = 'recieve';
const SUGGESTIONS = ['receive', 'relieve', 'deceive'];

/** The click that produced the report. */
const misspelled = {
  misspelledWord: WORD,
  dictionarySuggestions: SUGGESTIONS,
  isEditable: false,
  selectionText: '',
};

const ids = (params) => spellContextItems(params).map((i) => i.id);
const labels = (params) => spellContextItems(params).map((i) => i.label);

add('a menu is offered for a misspelled word', () =>
  (shouldShowContextMenu(misspelled) === true || 'nothing was offered at all'));

add('the suggestions are offered, in the order given', () => {
  const got = labels(misspelled).slice(0, SUGGESTIONS.length);
  return (got.join('|') === SUGGESTIONS.join('|')) || ('got ' + got.join('|'));
});

add('the word can be added to the dictionary', () => {
  const addWord = spellContextItems(misspelled).find((i) => i.id === 'add-word');
  return (addWord && addWord.word === WORD)
    || 'no add-to-dictionary entry, or it does not know which word';
});

add('a word the dictionary has never seen can still be taught', () => {
  // No suggestions at all is the case a person most wants this for: the squiggle
  // is right, there is just nothing close enough to offer.
  const params = { misspelledWord: 'Beeperish', dictionarySuggestions: [] };
  return ids(params).includes('add-word') || 'nothing but Select all was offered';
});

add('a long suggestion list is cut down to a menu', () => {
  const many = Array.from({ length: 40 }, (_, i) => 'word' + i);
  const n = spellContextItems({ ...misspelled, dictionarySuggestions: many })
    .filter((i) => i.id === 'replace').length;
  return n === 8 || ('offered ' + n + ' suggestions');
});

add('right-clicking an image is left to the app', () => {
  // The thread already answers this with its own popover. A native menu on top
  // of that is the app arguing with itself.
  return (shouldShowContextMenu({ srcURL: 'beeper-file://x.png' }) === false)
    || 'a menu would appear on top of the image popover';
});

add('right-clicking empty space offers nothing', () =>
  (shouldShowContextMenu({}) === false) || 'a menu appears on a blank click');

add('the composer still gets cut, copy, paste and select all', () => {
  const got = ids({ isEditable: true, selectionText: 'hello' });
  const wanted = ['cut', 'copy', 'paste', 'select-all'];
  return wanted.every((w) => got.includes(w)) || ('got ' + got.join(','));
});

add('paste is not offered where there is no field to paste into', () => {
  // A message is not editable, so Cut and Paste would be lies in a menu.
  const got = ids({ isEditable: false, selectionText: 'some text' });
  return (!got.includes('paste') && !got.includes('cut')) || ('got ' + got.join(','));
});

add('copy is only offered where there is something selected', () => {
  const none = ids({ isEditable: false, selectionText: '' });
  const some = ids({ isEditable: false, selectionText: 'word' });
  return (!none.includes('copy') && some.includes('copy')) || ('empty: ' + none.join(','));
});

add('a trailing divider is never left at the bottom', () => {
  // Exercised directly rather than through spellContextItems. That always ends
  // with Select all, so no trailing divider is reachable from it - testing it
  // that way would pass no matter what trimSeparators did, which is exactly how
  // this check shipped green the first time with the loop inside it disabled.
  const trimmed = trimSeparators([{ id: 'cut' }, { id: 'copy' }, { id: 'sep' }]);
  return (trimmed.length === 2 && trimmed[trimmed.length - 1].id === 'copy')
    || ('got ' + JSON.stringify(trimmed));
});

add('a misspelled word with nothing else still gets select all', () => {
  const got = ids(misspelled);
  return got.includes('select-all') || ('got ' + got.join(','));
});

add('nonsense input produces no menu rather than throwing', () => {
  // {} is the one that matters: Electron does pass params without every key, so
  // reading misspelledWord without guarding it is a crash on a real click.
  for (const bad of [undefined, null, 'string', 42, {}, { misspelledWord: 7 }, { dictionarySuggestions: null }]) {
    try {
      if (shouldShowContextMenu(bad) !== false) return 'claimed a menu for ' + JSON.stringify(bad);
      // The list may still hold the always-present Select all, and that is fine:
      // the menu is not shown, so nothing reaches it. What must never appear is
      // an entry built out of a field that was not there - "Add to dictionary"
      // with no word behind it would teach the checker an empty string.
      for (const entry of spellContextItems(bad)) {
        if (entry.id === 'add-word' && !entry.word) {
          return 'add-to-dictionary with no word for ' + JSON.stringify(bad);
        }
        if (entry.id === 'replace' && !entry.replaces) {
          return 'a suggestion with nothing to replace for ' + JSON.stringify(bad);
        }
      }
    } catch (e) {
      return 'threw on ' + JSON.stringify(bad) + ': ' + e.message;
    }
  }
  return true;
});

// ---- the wiring -------------------------------------------------------------
//
// Text: these cannot be checked by running the menu, because running it means
// opening one on the machine of whoever is running the suite. What they do is
// keep the three things that have to be true actually true - attached, wired,
// and declining to appear where the app already has its own menu.

const mainSrc = fs.readFileSync(mainPath, 'utf8');
const menuSrc = fs.readFileSync(menuPath, 'utf8');

add('the main window attaches the handler', () =>
  /wireSpellContextMenu\(mainWindow\.webContents\)/.test(mainSrc)
    || 'nothing listens for context-menu on the main window');

add('the handler actually listens for the event', () =>
  /webContents\.on\('context-menu'/.test(menuSrc) || 'nothing listens for context-menu');

add('the menu is built from the trimmed list', () =>
  /trimSeparators\(\s*spellContextItems\(params\)\s*\)/.test(menuSrc)
    || 'the divider trimming is never applied');

add('choosing a suggestion replaces the misspelling', () =>
  /replaceMisspelling\(/.test(menuSrc) || 'a suggestion does nothing when chosen');

add('choosing add-to-dictionary teaches the word', () =>
  /addWordToSpellCheckerDictionary\(/.test(menuSrc) || 'add-to-dictionary does nothing');

let failed = 0;
for (const [name, ok, detail] of cases) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed ? 1 : 0);