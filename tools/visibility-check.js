/**
 * Dev check: hiding and locally deleting a message, and both surviving a restart.
 *
 * Two choices that look alike and are not:
 *
 *   hidden  - folded behind an arrow, still in Beeper, still visible to
 *             everyone else. Reversible in one click.
 *   deleted - gone from this app's thread, not drawn at all. There is no restore
 *             anywhere in the UI. Beeper is never told, so no other device and
 *             no other person is affected.
 *
 * The bug this guards is the quiet one. A hidden message that forgets to write
 * itself to settings looks perfect right up until the app is closed, and a
 * local delete that leaks into Beeper is the worst possible outcome of the
 * feature: the user asked to remove it for themselves and it disappeared for
 * everyone.
 *
 * It also guards the delete itself, by checking the set of messages the thread
 * draws rather than only the flag. Flagging a message is not deleting it: a
 * tombstone row left behind by an earlier version of this would satisfy every
 * assertion about the flag while the text was still on screen.
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

      add('deleting locally also unfolds the message', () => {
        reset();
        S.setMessageHidden('m1', true);
        S.setMessageDeleted('m1', true);
        return S.isMessageHidden('m1') === false
          || 'the message is both folded and deleted, so the fold can never be seen';
      });

      // --- what the thread actually draws ---------------------------------------
      // The delete has to take the row away, not just flag it. The drawn set is
      // the honest place to prove that: if a tombstone ever came back, the
      // message would be in this list again.
      const seed = (chatID, ids) => {
        S.state.messages.set(chatID, ids.map((id, i) => ({
          id,
          text: 'message ' + id,
          timestamp: 1700000000000 + i * 1000,
          accountID: 'account-1',
        })));
      };
      const drawn = (chatID) => T.renderableMessages(chatID).map((m) => m.id);

      reset();
      seed('c1', ['a', 'b', 'c']);
      add('untouched messages are drawn', () => {
        return JSON.stringify(drawn('c1')) === JSON.stringify(['a', 'b', 'c'])
          || ('got ' + JSON.stringify(drawn('c1')));
      });

      reset();
      seed('c2', ['a', 'b', 'c']);
      S.setMessageDeleted('b', true);
      add('a message deleted on this device is not drawn', () => {
        return JSON.stringify(drawn('c2')) === JSON.stringify(['a', 'c'])
          || ('got ' + JSON.stringify(drawn('c2')));
      });

      add('deleting leaves no tombstone row behind', () => {
        return drawn('c2').length === 2 || ('got ' + JSON.stringify(drawn('c2')));
      });

      add('the record stays in state, so Beeper still has the message', () => {
        const raw = (S.state.messages.get('c2') || []).map((m) => m.id);
        return JSON.stringify(raw) === JSON.stringify(['a', 'b', 'c'])
          || ('got ' + JSON.stringify(raw));
      });

      add('deleting one message leaves the others alone', () => {
        reset();
        seed('c5', ['a', 'b', 'c']);
        S.setMessageDeleted('a', true);
        return JSON.stringify(drawn('c5')) === JSON.stringify(['b', 'c'])
          || ('got ' + JSON.stringify(drawn('c5')));
      });

      reset();
      seed('c3', ['only']);
      S.setMessageDeleted('only', true);
      add('deleting the last message leaves nothing to draw', () => {
        return drawn('c3').length === 0 || ('got ' + JSON.stringify(drawn('c3')));
      });

      reset();
      seed('c4', ['a', 'r', 'b']);
      const reaction = S.state.messages.get('c4')[1];
      reaction.type = 'REACTION';
      reaction.isHidden = true;
      add('reaction records are still not drawn as rows', () => {
        return JSON.stringify(drawn('c4')) === JSON.stringify(['a', 'b'])
          || ('got ' + JSON.stringify(drawn('c4')));
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
