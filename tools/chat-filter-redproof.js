/**
 * The red proof for the chat filter.
 *
 * Typing with no chat open narrows the chat list on screen, and Escape takes
 * the filter back off. The rules are small, and small rules are the ones
 * that rot quietly: a filter that matched the wrong names, or one that
 * swallowed the first letter of every message typed into an open chat, would
 * look like a small annoyance rather than like a broken feature.
 *
 * A check that is green proves nothing on its own. What matters is that the
 * rules are load-bearing: that breaking each one turns the check it was
 * written for red, and that the check is what catches it.
 *
 * The baseline is asserted, not printed and trusted - a mutation reported as
 * "caught" against a case that was already failing is a false catch.
 *
 * Every break here is in the source only, and every one of them is put back
 * before the next, byte for byte.
 *
 * Run with `npm run check:chatfilterredproof`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require('electron');

const FILTER = path.join(ROOT, 'src', 'renderer', 'js', 'chat-filter.js');
const SIDEBAR = path.join(ROOT, 'src', 'renderer', 'js', 'sidebar.js');
const MAIN = path.join(ROOT, 'src', 'renderer', 'js', 'main.js');

const originals = {
  [FILTER]: fs.readFileSync(FILTER, 'utf8'),
  [SIDEBAR]: fs.readFileSync(SIDEBAR, 'utf8'),
  [MAIN]: fs.readFileSync(MAIN, 'utf8'),
};

/**
 * The line endings a file uses.
 *
 * The tree is CRLF, and a pattern written with LF would not be found in it -
 * a red proof that silently finds nothing is worse than no red proof.
 */
const endings = {};
function eol(file) {
  if (endings[file] === undefined) {
    endings[file] = fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n';
  }
  return endings[file];
}

/** Runs a suite under plain node and says what it said. */
function run(file) {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', file)], {
      cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true,
    });
    return { code: 0, out };
  } catch (err) {
    return {
      code: typeof err.status === 'number' && err.status !== 0 ? err.status : 1,
      out: String(err.stdout || '') + String(err.stderr || ''),
    };
  }
}

/** Runs the Electron suite, which needs the Electron binary rather than node. */
function runElectron(file) {
  try {
    const out = execFileSync(ELECTRON, ['tools/run-check.js', file], {
      cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true,
    });
    return { code: 0, out };
  } catch (err) {
    return {
      code: typeof err.status === 'number' && err.status !== 0 ? err.status : 1,
      out: String(err.stdout || '') + String(err.stderr || ''),
    };
  }
}

const green = (result) => result.code === 0 && /checks passed/.test(result.out);
const failing = (result) => result.out.split(/\r?\n/).filter((l) => /^FAIL/.test(l.trim()))
  .map((l) => l.replace(/^FAIL\s+/, ''));

const checks = [];
const add = (name, ok, detail) => checks.push([name, ok, detail || '']);

// ---------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------

const suites = {
  filter: () => run('chat-filter-check.mjs'),
  sidebar: () => runElectron('tools/sidebar-check.js'),
};

const baseline = {
  filter: suites.filter(),
  sidebar: suites.sidebar(),
};

const baselineGreen = Object.values(baseline).every(green);
add('the baseline is green', baselineGreen,
  Object.entries(baseline)
    .filter(([, r]) => !green(r))
    .map(([name, r]) => `${name}: ${r.out.split(/\r?\n/).slice(-4).join(' | ')}`)
    .join(' ; '));

if (!baselineGreen) {
  for (const [name, ok, detail] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The mutations
// ---------------------------------------------------------------------------

/** A pattern as lines, so the file's own line endings are used. */
const lines = (file, ...rows) => rows.join(eol(file));

const mutations = [
  {
    name: 'the filter matches the case exactly',
    file: FILTER,
    from: lines(FILTER, "  const want = String(needle || '').trim().toLowerCase();"),
    to: lines(FILTER, "  const want = String(needle || '').trim();"),
    suites: ['filter'],
    // A name is a name: "BEN" has to find "Benji".
  },
  {
    name: 'the filter only matches the start of a name',
    file: FILTER,
    from: lines(FILTER, '  return filterName(chat).includes(want);'),
    to: lines(FILTER, '  return filterName(chat).startsWith(want);'),
    suites: ['filter'],
    // "enj" is in the middle of "Benji".
  },
  {
    name: 'a keystroke in a field starts a filter',
    file: FILTER,
    from: lines(FILTER, "    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return false;"),
    to: lines(FILTER, '    // the field check is gone'),
    suites: ['filter'],
    // A keystroke that is going somewhere else belongs to whatever it is
    // going to.
  },
  {
    name: 'a shortcut starts a filter',
    file: FILTER,
    from: lines(FILTER, '  if (event.ctrlKey || event.metaKey || event.altKey) return false;'),
    to: lines(FILTER, '  // the modifier check is gone'),
    suites: ['filter'],
    // Ctrl+K is the search, not a filter.
  },
  {
    name: 'the list is not narrowed at all',
    file: SIDEBAR,
    from: lines(SIDEBAR, '  const shown = filterChats(all, state.chatFilter);'),
    to: lines(SIDEBAR, '  const shown = all;'),
    suites: ['sidebar'],
    // The whole feature.
  },
  {
    name: 'the count says how many chats there are, not how many matched',
    file: SIDEBAR,
    from: lines(SIDEBAR, '  count.textContent = shown ? `${shown} of ${total}` : \'No matches\';'),
    to: lines(SIDEBAR, '  count.textContent = shown ? `${total} of ${total}` : \'No matches\';'),
    suites: ['sidebar'],
    // A count of four when two matched is a count that cannot be trusted.
  },
  {
    name: 'the filter box stays after the filter is cleared',
    file: SIDEBAR,
    from: lines(SIDEBAR, '  row.hidden = !state.chatFilter || Boolean(state.searchQuery);'),
    to: lines(SIDEBAR, '  row.hidden = false;'),
    suites: ['sidebar'],
    // A box that is not filtering anything is a box that says nothing.
  },
  {
    name: 'the filter box sits over the search results',
    file: SIDEBAR,
    from: lines(SIDEBAR, '  row.hidden = !state.chatFilter || Boolean(state.searchQuery);'),
    to: lines(SIDEBAR, '  row.hidden = !state.chatFilter;'),
    suites: ['sidebar'],
    // One filter at a time: the search takes the pane over, and the two
    // boxes do not sit together.
  },
  {
    name: 'typing into an open chat starts a filter',
    file: MAIN,
    from: lines(MAIN, '    if (state.activeChatID) return;'),
    to: lines(MAIN, '    // the guard is gone'),
    suites: ['filter'],
    // The composer has the keyboard when a chat is open. Without the guard,
    // the first letter of every message would start a filter instead.
  },
];

for (const mutation of mutations) {
  const original = originals[mutation.file];
  if (!original.includes(mutation.from)) {
    add(mutation.name, false, 'the pattern is not in the file any more');
    continue;
  }

  fs.writeFileSync(mutation.file, original.replace(mutation.from, mutation.to));

  try {
    const results = {};
    for (const name of mutation.suites) results[name] = suites[name]();

    const stillGreen = Object.entries(results).filter(([, r]) => green(r));
    if (stillGreen.length) {
      add(mutation.name, false, `${stillGreen.map(([n]) => n).join(', ')} stayed green`);
      continue;
    }

    const caught = Object.values(results).flatMap((r) => failing(r));
    if (!caught.length) {
      add(mutation.name, false, 'the suites went red without naming a case');
      continue;
    }
    add(mutation.name, true, caught.join(' ; '));
  } finally {
    fs.writeFileSync(mutation.file, original);
  }
}

// ---------------------------------------------------------------------------
// The tree is as it was
// ---------------------------------------------------------------------------

const restored = Object.entries(originals).every(([file, text]) => fs.readFileSync(file, 'utf8') === text);
add('the files are exactly as they were', restored);

const after = {
  filter: suites.filter(),
  sidebar: suites.sidebar(),
};
const afterGreen = Object.values(after).every(green);
add('every suite is green again', afterGreen,
  Object.entries(after)
    .filter(([, r]) => !green(r))
    .map(([name, r]) => `${name}: ${r.out.split(/\r?\n/).slice(-4).join(' | ')}`)
    .join(' ; '));

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

let failures = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}

console.log(`\n${checks.length - failures}/${checks.length} checks passed`);
process.exit(failures ? 1 : 0);
