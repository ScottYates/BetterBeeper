/**
 * Dev check: which actions a message row offers, and the one-way delete's
 * escape hatch.
 *
 * Delete and Hide moved out of the right-click menu and onto the hover actions.
 * That is easy to get half right: leave "Delete" in the menu as well and the
 * change looks done while the destructive path is still in two places, or
 * forget that only your own messages can be deleted and put the button on
 * everyone's rows, where clicking it does nothing.
 *
 * So this asserts on the rendered row, not on the source: it builds real
 * message nodes and reads the buttons off them. A control that is built but
 * never wired up still shows up here, which is the point.
 *
 * The clear-list button is checked here too, because it is the other half of
 * the same decision: with no per-message restore, forgetting every deleted
 * message at once is the only way back.
 *
 * Run with `npm run check:actions`.
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
  app.setPath('userData', path.join(os.tmpdir(), 'bb-actions-check-profile'));

  // Single backslashes on purpose: this harness is String.raw, and
  // check:syntax parses that same raw text, so the two have to agree. In a
  // plain template literal "\\n" would collapse and the assertion below would
  // test something other than what it reads as.
  const harness = String.raw`
    (async () => {
      const S = await import(${JSON.stringify(stateURL)});
      const T = await import(${JSON.stringify(threadURL)});

      const cases = [];
      const add = (name, fn) => {
        let ok = false;
        let detail = '';
        try { const r = fn(); ok = r === true; if (r !== true) detail = String(r); }
        catch (e) { ok = false; detail = e.message; }
        cases.push([name, ok, detail]);
      };

      const base = {
        chatID: 'chat-1',
        accountID: 'account-1',
        senderID: 'sender-1',
        senderName: 'Someone',
        text: 'hello',
        timestamp: 1700000000000,
      };

      const titles = (message) => {
        const node = T.messageNode(message, null);
        return [...node.querySelectorAll('.msg-hover-actions button')]
          .map((b) => b.title);
      };

      const reset = () => { S.loadHiddenMessages([]); S.loadDeletedMessages([]); };

      // --- hover actions --------------------------------------------------------
      reset();
      add('my own message offers delete and hide on hover', () => {
        const got = titles({ ...base, isSender: true });
        return got.includes('Delete message') && got.includes('Hide message')
          || ('got ' + JSON.stringify(got));
      });

      add('somebody else\'s message does not offer delete', () => {
        const got = titles({ ...base, isSender: false });
        return !got.includes('Delete message') && got.includes('Hide message')
          || ('got ' + JSON.stringify(got));
      });

      add('a message Beeper already deleted offers no delete', () => {
        const got = titles({ ...base, isSender: true, isDeleted: true });
        return !got.includes('Delete message') || ('got ' + JSON.stringify(got));
      });

      add('a folded message does not also offer hide', () => {
        // The fold already carries an arrow back. Two controls for one state
        // is how they drift apart.
        S.loadHiddenMessages(['m']);
        const got = titles({ ...base, id: 'm', isSender: true });
        return !got.includes('Hide message') && got.includes('Delete message')
          || ('got ' + JSON.stringify(got));
      });

      add('react and more are still on the row', () => {
        const got = titles({ ...base, isSender: true });
        return got.includes('React') && got.includes('More') || ('got ' + JSON.stringify(got));
      });

      add('an incoming message still has its hover actions', () => {
        // The control case. A filter that dropped the row's actions entirely
        // would satisfy the "no delete" assertion above.
        const got = titles({ ...base, isSender: false });
        return got.length === 3 || ('got ' + JSON.stringify(got));
      });

      // --- the context menu -----------------------------------------------------
      const labels = (message) => T.messageMenuItems(null, message).map((i) => i.label);

      add('the context menu no longer offers delete', () => {
        const got = labels({ ...base, isSender: true });
        return !got.includes('Delete') || ('got ' + JSON.stringify(got));
      });

      add('the context menu no longer offers hide', () => {
        const got = labels({ ...base, isSender: true });
        return !got.includes('Hide message') && !got.includes('Show message')
          || ('got ' + JSON.stringify(got));
      });

      add('the local-only delete stays in the menu', () => {
        const got = labels({ ...base, isSender: true });
        return got.includes('Delete on this device') || ('got ' + JSON.stringify(got));
      });

      add('editing is still offered on my own message', () => {
        const got = labels({ ...base, isSender: true });
        return got.includes('Edit') || ('got ' + JSON.stringify(got));
      });

      add('editing is not offered on somebody else\'s message', () => {
        const got = labels({ ...base, isSender: false });
        return !got.includes('Edit') || ('got ' + JSON.stringify(got));
      });

      // --- clearing the deleted list --------------------------------------------
      reset();
      add('clearing reports how many were restored', () => {
        S.setMessageDeleted('a', true);
        S.setMessageDeleted('b', true);
        const count = S.clearDeletedMessages();
        return count === 2 || ('reported ' + count);
      });

      add('clearing empties the list', () => {
        return S.deletedList().length === 0 || ('left ' + JSON.stringify(S.deletedList()));
      });

      add('clearing makes the messages drawable again', () => {
        // The point of the button. Flag-cleared is not enough: the thread
        // filters on the flag, so this is what puts the messages back on screen.
        S.state.messages.set('chat-clear', [
          { id: 'a', text: 'a', timestamp: 1700000000000 },
          { id: 'b', text: 'b', timestamp: 1700000001000 },
        ]);
        S.setMessageDeleted('a', true);
        S.setMessageDeleted('b', true);
        S.clearDeletedMessages();
        const drawn = T.renderableMessages('chat-clear').map((m) => m.id);
        return JSON.stringify(drawn) === JSON.stringify(['a', 'b'])
          || ('got ' + JSON.stringify(drawn));
      });

      add('clearing an empty list reports nothing rather than failing', () => {
        reset();
        const count = S.clearDeletedMessages();
        return count === 0 && S.deletedList().length === 0 || ('reported ' + count);
      });

      add('clearing does not resurrect the hidden ones', () => {
        // Hidden is a different choice, with its own arrow back. Clearing the
        // deleted list must not quietly undo it.
        reset();
        S.state.messages.set('chat-keep', [{ id: 'h', text: 'h', timestamp: 1700000000000 }]);
        S.setMessageHidden('h', true);
        S.setMessageDeleted('other', true);
        S.clearDeletedMessages();
        return S.isMessageHidden('h') === true
          || 'clearing the deleted list also un-hid a folded message';
      });

      reset();
      return JSON.stringify(cases);
    })()
  `;

  await app.whenReady();
  harnessGuard(app, { label: 'check:actions' });
  const win = new BrowserWindow({ show: false });
  await win.loadFile(path.join(__dirname, 'actions-harness.html'));
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
