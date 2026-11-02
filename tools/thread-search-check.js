/**
 * Dev check: the rules behind searching inside a conversation.
 *
 * The matching rule, the merge of the two sources, the step order and the
 * highlighter all live in one module with no Electron and no thread import,
 * so they can be driven directly here. A rule that is wrong fails in this
 * file rather than in a thread nobody opened.
 *
 * Every case has a control that reproduces the behaviour it replaced,
 * because a suite that has been green over a feature nobody exercised is
 * worse than no suite at all.
 *
 * The DOM is generated from the real index.html, so the check cannot drift
 * from the app, and the API boundary is stubbed so no account and no network
 * are needed.
 *
 * Run with `npm run check:threadsearch`.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const harnessGuard = require('./harness-guard');

const ROOT = path.join(__dirname, '..');
const js = (name) => pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', name)).href;
const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');
const HARNESS = path.join(__dirname, '.thread-search-harness.html');

/** Real markup, real stylesheet, no app scripts. */
function buildHarness() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const stripped = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/href="styles\.css"/g, 'href="../src/renderer/styles.css"')
    .replace(/(href|src)="\.\//g, '$1="../src/renderer/');
  fs.writeFileSync(HARNESS, stripped);
}

async function main() {
  const { app, BrowserWindow } = require('electron');
  const os = require('os');
  app.setPath('userData', path.join(os.tmpdir(), 'bb-thread-search-profile'));
  buildHarness();

  const harness = String.raw`
    (async () => {
      const cases = [];
      const add = async (name, fn) => {
        let ok = false;
        let detail = '';
        try { const r = await fn(); ok = r === true; if (r !== true) detail = String(r); }
        catch (e) { ok = false; detail = e.message; }
        cases.push([name, ok, detail]);
      };
      const settle = (ms) => new Promise((r) => setTimeout(r, ms || 60));

      // A throw anywhere in the body must not take the cases collected so
      // far with it: a harness that dies reports one failure and hides the
      // rest, which is how a broken check looks like a passing one.
      try {
        await body();
      } catch (e) {
        cases.push(['the harness ran to the end', false, e && (e.stack || e.message)]);
      }
      return JSON.stringify(cases);

      async function body() {
        const TS = await import(${JSON.stringify(js('thread-search.js'))});

        // --- the matching rule -------------------------------------------

        await add('a fragment of a word matches', () =>
          TS.matchesQuery('the battery is flat', 'batt') === true || 'the fragment did not match');

        await add('the whole word matches too', () =>
          TS.matchesQuery('the battery is flat', 'battery') === true || 'the word did not match');

        await add('a word that is not there does not match', () =>
          TS.matchesQuery('the battery is flat', 'batteryx') === false || 'it matched anyway');

        await add('the match ignores case', () =>
          TS.matchesQuery('The Battery Is Flat', 'BATTERY') === true || 'the case mattered');

        await add('every term of a multi-word query must be found', () =>
          (TS.matchesQuery('the battery is flat', 'flat batt') === true
            && TS.matchesQuery('the battery is flat', 'flat missing') === false)
          || 'the terms were not all required');

        await add('an empty query matches nothing', () =>
          TS.matchesQuery('anything', '') === false || 'an empty query matched');

        await add('a single word query is one word', () =>
          (TS.isSingleWord('battery') === true && TS.isSingleWord('flat battery') === false)
          || 'the word count was wrong');

        await add('CONTROL: an empty query is not a single word', () =>
          TS.isSingleWord('') === false || 'an empty query counted as a word');

        // --- the merge ----------------------------------------------------

        await add('two sources are merged into one list', () => {
          const merged = TS.mergeHits(
            [{ chatID: 'c1', id: 'a', text: 'x', ts: 1000 }],
            [{ chatID: 'c1', id: 'b', text: 'y', timestamp: 2000 }],
          );
          return (merged.length === 2 && merged[0].id === 'a' && merged[1].id === 'b')
            || ('got ' + JSON.stringify(merged.map((h) => h.id)));
        });

        await add('a message both sides know about appears once', () => {
          const merged = TS.mergeHits(
            [{ chatID: 'c1', id: 'a', text: 'x', ts: 1000 }],
            [{ chatID: 'c1', id: 'a', text: 'x', timestamp: 1000 }],
          );
          return merged.length === 1 || ('got ' + merged.length);
        });

        await add('the local copy wins, so a known message is not fetched again', () => {
          const merged = TS.mergeHits(
            [{ chatID: 'c1', id: 'a', text: 'x', ts: 1000 }],
            [{ chatID: 'c1', id: 'a', text: 'x', timestamp: 1000 }],
          );
          return merged[0].source === 'local' || ('the source is ' + merged[0].source);
        });

        await add('hits are ordered oldest first, so stepping forward walks down the thread', () => {
          // The two timestamps are far apart on purpose: the local hit is in
          // epoch millis and Beeper's is a date string, and the order has to
          // come out right whichever shape each side used.
          const merged = TS.mergeHits(
            [{ chatID: 'c1', id: 'new', text: 'x', ts: 1800000000000 }],
            [{ chatID: 'c1', id: 'old', text: 'y', timestamp: '2024-01-01T00:00:00Z' }],
          );
          return merged[0].id === 'old' || ('the first is ' + merged[0].id);
        });

        await add('CONTROL: a hit with no id is dropped rather than drawn', () => {
          const merged = TS.mergeHits([{ chatID: 'c1', text: 'x', ts: 1000 }], []);
          return merged.length === 0 || ('got ' + merged.length);
        });

        // --- the step order -----------------------------------------------

        await add('stepping forward from nothing lands on the first hit', () =>
          TS.nextIndex(-1, 5, 1) === 0 || ('got ' + TS.nextIndex(-1, 5, 1)));

        await add('stepping forward advances', () =>
          TS.nextIndex(0, 5, 1) === 1 || ('got ' + TS.nextIndex(0, 5, 1)));

        await add('stepping back from nothing lands on the last hit', () =>
          TS.nextIndex(-1, 5, -1) === 4 || ('got ' + TS.nextIndex(-1, 5, -1)));

        await add('stepping past the end wraps to the first', () =>
          TS.nextIndex(4, 5, 1) === 0 || ('got ' + TS.nextIndex(4, 5, 1)));

        await add('stepping back past the start wraps to the last', () =>
          TS.nextIndex(0, 5, -1) === 4 || ('got ' + TS.nextIndex(0, 5, -1)));

        await add('CONTROL: with no hits there is nowhere to step to', () =>
          TS.nextIndex(-1, 0, 1) === -1 || ('got ' + TS.nextIndex(-1, 0, 1)));

        // --- the highlighter, against real markup --------------------------

        await add('a match in the thread is marked', () => {
          const root = document.getElementById('message-list');
          root.innerHTML = '<div class="msg"><div class="msg-text">the battery is flat</div></div>';
          const count = TS.highlightIn(root, 'batt');
          return (count === 1 && root.querySelectorAll('mark.ts-hit').length === 1)
            || ('marked ' + count);
        });

        await add('the mark holds the matched text', () => {
          const root = document.getElementById('message-list');
          root.innerHTML = '<div class="msg"><div class="msg-text">the battery is flat</div></div>';
          TS.highlightIn(root, 'batt');
          return root.querySelector('mark.ts-hit').textContent === 'batt'
            || ('the mark reads ' + root.querySelector('mark.ts-hit').textContent);
        });

        await add('a match inside markup is still found', () => {
          const root = document.getElementById('message-list');
          root.innerHTML = '<div class="msg"><div class="msg-text">a <strong>batt</strong>ery here</div></div>';
          const count = TS.highlightIn(root, 'batt');
          return count === 1 || ('marked ' + count);
        });

        await add('CONTROL: words that are not there are not marked', () => {
          const root = document.getElementById('message-list');
          root.innerHTML = '<div class="msg"><div class="msg-text">plain words</div></div>';
          const count = TS.highlightIn(root, 'strong');
          return count === 0 || ('marked ' + count);
        });

        await add('every match is marked, not only the first', () => {
          const root = document.getElementById('message-list');
          root.innerHTML = '<div class="msg"><div class="msg-text">batt and batt and batt</div></div>';
          const count = TS.highlightIn(root, 'batt');
          return count === 3 || ('marked ' + count);
        });

        await add('the text around a match is left exactly as it was', () => {
          const root = document.getElementById('message-list');
          root.innerHTML = '<div class="msg"><div class="msg-text">the battery is flat</div></div>';
          TS.highlightIn(root, 'batt');
          return root.textContent === 'the battery is flat'
            || ('the text reads ' + root.textContent);
        });

        await add('clearing removes every mark and keeps the text', () => {
          const root = document.getElementById('message-list');
          root.innerHTML = '<div class="msg"><div class="msg-text">the battery is flat</div></div>';
          TS.highlightIn(root, 'batt');
          const cleared = TS.clearHighlights(root);
          return (cleared === 1
            && root.querySelectorAll('mark.ts-hit').length === 0
            && root.textContent.includes('the battery is flat'))
            || ('cleared ' + cleared);
        });

        await add('CONTROL: a mark that was not ours is left alone', () => {
          const root = document.getElementById('message-list');
          root.innerHTML = '<div class="msg"><div class="msg-text">a <mark>real</mark> mark</div></div>';
          TS.clearHighlights(root);
          return root.querySelectorAll('mark').length === 1 || 'it removed a mark it did not make';
        });
      }
    })()
  `;

  await app.whenReady();
  harnessGuard(app, { label: 'check:threadsearch' });
  const win = new BrowserWindow({ show: false });
  await win.loadFile(HARNESS);
  let harnessCases;
  try {
    const result = await win.webContents.executeJavaScript(harness, true);
    harnessCases = JSON.parse(result);
  } catch (err) {
    harnessCases = [['the browser harness ran to the end', false, err.message]];
  }
  app.exit(0);

  const cases = harnessCases;
  let failed = 0;
  for (const [name, ok, detail] of cases) {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
