/**
 * Dev check: the composer is addressed to one person, and stays one line.
 *
 * Two things went wrong here, and they are separate bugs in one box:
 *
 * The placeholder read "Message Beeper Updates on Beeper (Matrix)". The network
 * was already in the header two rows above and the "Message" prefix was pure
 * padding, so the name was pushed to the right of a box too narrow to show it -
 * the user saw a truncated hint for the person they were writing to. It is now
 * the bare name.
 *
 * The textarea auto-grew to 180px as the text wrapped, pushing the thread up
 * and leaving the newest message riding the top of the window. It is one line
 * now, and a long message scrolls sideways.
 *
 * The height assertions live in check:layout, which measures the real
 * stylesheet. This file covers the placeholder text, which is a function.
 *
 * Run with `npm run check:composer`.
 */
const path = require('path');
const { pathToFileURL } = require('url');
const harnessGuard = require('./harness-guard');

const threadURL = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'thread.js')).href;

async function main() {
  const { app, BrowserWindow } = require('electron');
  const os = require('os');
  // An isolated profile, so the test cannot execute a cached copy of thread.js.
  app.setPath('userData', path.join(os.tmpdir(), 'bb-composer-check-profile'));

  const harness = `
    (async () => {
      const T = await import(${JSON.stringify(threadURL)});
      const placeholder = T.composerPlaceholder;

      const person = (title, extra) => Object.assign({
        id: '!x', title: title, type: 'single',
        participants: { items: [{ isSelf: true }, { isSelf: false }] },
      }, extra || {});

      const note = (title) => ({
        id: '!n', title: title, type: 'single',
        participants: { items: [{ isSelf: true }] },
      });

      const cases = [];
      const add = (name, fn) => {
        let ok = false;
        let detail = '';
        try { const r = fn(); ok = r === true; if (r !== true) detail = String(r); }
        catch (e) { ok = false; detail = e.message; }
        cases.push([name, ok, detail]);
      };

      add('a one-to-one chat shows just the name', () => {
        return placeholder(person('Tracey Yates')) === 'Tracey Yates'
          || ('got ' + JSON.stringify(placeholder(person('Tracey Yates'))));
      });

      add('a group chat shows just its name', () => {
        return placeholder(person('Beeper Updates')) === 'Beeper Updates'
          || ('got ' + JSON.stringify(placeholder(person('Beeper Updates'))));
      });

      add('the network never appears in the placeholder', () => {
        // The old string appended " on <network>"; a long name plus that
        // suffix is what overflowed the single-line box.
        const chat = person('Tracey Yates', { network: 'Google Voice', accountID: 'ba_x' });
        const out = placeholder(chat);
        return !/\\bon\\b/.test(out) && !out.includes('Google Voice') && !out.includes('ba_x')
          || ('got ' + JSON.stringify(out));
      });

      add('the placeholder carries no "Message" prefix', () => {
        const out = placeholder(person('Tracey Yates'));
        return !out.startsWith('Message') || ('got ' + JSON.stringify(out));
      });

      add('a note chat keeps its own wording', () => {
        return placeholder(note('Note')) === 'Write a note…'
          || ('got ' + JSON.stringify(placeholder(note('Note'))));
      });

      add('an untitled chat falls back to something sensible', () => {
        const a = placeholder(person(''));
        const b = placeholder(null);
        return a && b && a === b && a.length > 0
          || ('untitled: ' + JSON.stringify(a) + ' null: ' + JSON.stringify(b));
      });

      add('a title of only spaces is treated as untitled', () => {
        const out = placeholder(person('   '));
        return out === 'Write a message…' || ('got ' + JSON.stringify(out));
      });

      return JSON.stringify(cases);
    })()
  `;

  await app.whenReady();
  harnessGuard(app, { label: 'check:composer' });
  const win = new BrowserWindow({ show: false });
  await win.loadFile(path.join(__dirname, 'composer-harness.html'));
  const result = await win.webContents.executeJavaScript(harness, true);
  app.exit(0);

  const cases = JSON.parse(result);
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
