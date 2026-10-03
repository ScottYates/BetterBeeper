/**
 * Dev check: hiding and locally deleting a message, and both surviving a restart.
 *
 * Two choices that look alike and are not:
 *
 *   hidden  - folded behind an arrow, still in Beeper, still visible to
 *             everyone else. Reversible in one click.
 *   deleted - a tombstone in the thread, gone from this app. Beeper is never
 *             told, so no other device and no other person is affected.
 *
 * The bug this guards is the quiet one. A hidden message that forgets to write
 * itself to settings looks perfect right up until the app is closed, and a
 * local delete that leaks into Beeper is the worst possible outcome of the
 * feature: the user asked to remove it for themselves and it disappeared for
 * everyone.
 *
 * Run with `npm run check:visibility`.
 */
const path = require('path');
const { pathToFileURL } = require('url');
const harnessGuard = require('./harness-guard');

const stateURL = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'state.js')).href;
const threadURL = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'thread.js')).href;

async function main() {
  const { app, BrowserWindow } = require('electron');
  const os = require('os');
  // An isolated profile, so the test cannot execute a cached copy of state.js.
  app.setPath('userData', path.join(os.tmpdir(), 'bb-visibility-check-profile'));

  const harness = `
    (async () => {
      const S = await import(${JSON.stringify(stateURL)});
      const T = await import(${JSON.stringify(threadURL)});
      const summary = T.messageSummary;

      const cases = [];
      const add = (name, fn) => {
        let ok = false;
        let detail = '';
        try { const r = fn(); ok = r === true; if (r !== true) detail = String(r); }
        catch (e) { ok = false; detail = e.message; }
        cases.push([name, ok, detail]);
      };

      const reset = () => { S.loadHiddenMessages([]); S.loadDeletedMessages([]); };

      // --- a plain message is neither hidden nor deleted ------------------------
      reset();
      add('an untouched message is visible', () => {
        return S.isMessageHidden('m1') === false && S.isMessageDeleted('m1') === false
          || 'a fresh message is already hidden';
      });

      // --- hiding ---------------------------------------------------------------
      reset();
      add('hiding a message folds it away', () => {
        S.setMessageHidden('m1', true);
        return S.isMessageHidden('m1') === true || 'not hidden';
      });

      add('hiding one message leaves the rest alone', () => {
        S.setMessageHidden('m2', true);
        return S.isMessageHidden('m2') === true
          && S.isMessageHidden('m3') === false
          && S.isMessageDeleted('m3') === false
          || 'the choice bled into another message';
      });

      add('showing a message again un-hides it', () => {
        S.setMessageHidden('m1', false);
        return S.isMessageHidden('m1') === false || 'still hidden';
      });

      add('a hidden message is still not deleted', () => {
        reset();
        S.setMessageHidden('m1', true);
        return S.isMessageDeleted('m1') === false
          || 'folding a message also deleted it';
      });

      // --- deleting on this device ---------------------------------------------
      reset();
      add('deleting on this device hides the message here', () => {
        S.setMessageDeleted('m1', true);
        return S.isMessageDeleted('m1') === true || 'not deleted';
      });

      add('restoring brings the message back', () => {
        S.setMessageDeleted('m1', false);
        return S.isMessageDeleted('m1') === false || 'still deleted';
      });

      add('deleting locally also unfolds the message', () => {
        reset();
        S.setMessageHidden('m1', true);
        S.setMessageDeleted('m1', true);
        return S.isMessageHidden('m1') === false
          || 'the message is both folded and deleted, so the fold can never be seen';
      });

      add('restoring does not bring the fold back', () => {
        S.setMessageDeleted('m1', false);
        return S.isMessageHidden('m1') === false
          || 'restoring also un-hid it';
      });

      // --- persistence ----------------------------------------------------------
      reset();
      add('hidden messages survive a restart', () => {
        S.setMessageHidden('keep-me', true);
        S.setMessageHidden('drop-me', true);
        S.setMessageHidden('drop-me', false);
        const saved = S.hiddenList();
        S.loadHiddenMessages(saved);
        return S.isMessageHidden('keep-me') === true && S.isMessageHidden('drop-me') === false
          || ('after reload: ' + JSON.stringify(saved));
      });

      add('locally deleted messages survive a restart', () => {
        S.setMessageDeleted('gone', true);
        S.loadDeletedMessages(S.deletedList());
        return S.isMessageDeleted('gone') === true || 'the local delete was lost';
      });

      add('the two lists do not bleed into each other', () => {
        reset();
        S.setMessageHidden('h1', true);
        S.loadDeletedMessages(S.deletedList());
        return S.isMessageHidden('h1') === true && S.isMessageDeleted('h1') === false
          || 'loading one list cleared the other';
      });

      // --- rubbish input --------------------------------------------------------
      reset();
      add('a missing id is never hidden or deleted', () => {
        S.setMessageHidden(null, true);
        S.setMessageHidden(undefined, true);
        S.setMessageDeleted('', true);
        return S.hiddenList().length === 0 && S.deletedList().length === 0
          || ('stored ' + JSON.stringify({ h: S.hiddenList(), d: S.deletedList() }));
      });

      add('rubbish in settings does not become a hidden message', () => {
        S.loadHiddenMessages(['ok-1', null, 42, '', undefined, 'ok-2']);
        return JSON.stringify(S.hiddenList().sort()) === JSON.stringify(['ok-1', 'ok-2'])
          || ('got ' + JSON.stringify(S.hiddenList()));
      });

      add('a settings value of the wrong shape is ignored', () => {
        S.loadHiddenMessages(null);
        S.loadDeletedMessages('not-an-array');
        return S.hiddenList().length === 0 && S.deletedList().length === 0
          || 'a bad value produced entries';
      });

      // --- the folded summary ----------------------------------------------------
      add('a folded message summarises its own text', () => {
        return summary({ text: 'the actual message' }) === 'the actual message'
          || ('got ' + JSON.stringify(summary({ text: 'the actual message' })));
      });

      add('a folded summary is clamped and single-line', () => {
        const long = 'word '.repeat(80);
        const out = summary({ text: long });
        return out.length <= 120 && !out.includes('\\n')
          || ('length ' + out.length);
      });

      add('a folded summary folds newlines into spaces', () => {
        const out = summary({ text: 'first\\nsecond\\tthird' });
        return !out.includes('\\n') && !out.includes('\\t')
          || ('got ' + JSON.stringify(out));
      });

      add('a photo with no caption folds to something readable', () => {
        return summary({ attachments: [{ type: 'img', mimeType: 'image/png' }] }) === 'Photo'
          || ('got ' + JSON.stringify(summary({ attachments: [{ type: 'img' }] })));
      });

      add('a file with no caption folds to its name', () => {
        const out = summary({ attachments: [{ fileName: 'notes.pdf', mimeType: 'application/pdf' }] });
        return out === 'notes.pdf' || ('got ' + JSON.stringify(out));
      });

      add('a message with nothing in it still folds to something', () => {
        const out = summary({});
        return typeof out === 'string' && out.length > 0 || ('got ' + JSON.stringify(out));
      });

      reset();
      return JSON.stringify(cases);
    })()
  `;

  await app.whenReady();
  harnessGuard(app, { label: 'check:visibility' });
  const win = new BrowserWindow({ show: false });
  await win.loadFile(path.join(__dirname, 'visibility-harness.html'));
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
