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
const modalsURL = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'modals.js')).href;

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
      const M = await import(${JSON.stringify(modalsURL)});

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
      add('my own message offers hide and the local delete on hover', () => {
        const got = titles({ ...base, isSender: true });
        return got.includes('Delete on this device') && got.includes('Hide message')
          || ('got ' + JSON.stringify(got));
      });

      add('somebody else\'s message also offers the local delete', () => {
        // The hover trash is the local delete, which works on anybody's
        // message. Only the Beeper delete is restricted to your own.
        const got = titles({ ...base, isSender: false });
        return got.includes('Delete on this device') && got.includes('Hide message')
          || ('got ' + JSON.stringify(got));
      });

      add('the hover trash is never the Beeper delete', () => {
        // If it were, a stray click would remove a message for everyone with no
        // way back. The menu is the only place that can happen.
        const got = titles({ ...base, isSender: true });
        return !got.includes('Delete message') || ('got ' + JSON.stringify(got));
      });

      add('a folded message does not also offer hide', () => {
        // The fold already carries an arrow back. Two controls for one state
        // is how they drift apart.
        S.loadHiddenMessages(['m']);
        const got = titles({ ...base, id: 'm', isSender: true });
        return !got.includes('Hide message') && got.includes('Delete on this device')
          || ('got ' + JSON.stringify(got));
      });

      add('react and more are still on the row', () => {
        const got = titles({ ...base, isSender: true });
        return got.includes('React') && got.includes('More') || ('got ' + JSON.stringify(got));
      });

      add('an incoming message still has all four hover actions', () => {
        // The control case. A row that lost its actions would satisfy the
        // "never the Beeper delete" assertion above.
        const got = titles({ ...base, isSender: false });
        return got.length === 4 || ('got ' + JSON.stringify(got));
      });

      // --- the context menu -----------------------------------------------------
      const labels = (message) => T.messageMenuItems(null, message).map((i) => i.label);

      add('the Beeper delete is in the menu on my own message', () => {
        const got = labels({ ...base, isSender: true });
        return got.includes('Delete for everyone') || ('got ' + JSON.stringify(got));
      });

      add('the Beeper delete is not offered on somebody else\'s message', () => {
        const got = labels({ ...base, isSender: false });
        return !got.includes('Delete for everyone') || ('got ' + JSON.stringify(got));
      });

      add('the local delete is not duplicated in the menu', () => {
        // It is on the row now. Having it in both places is how the two drift.
        const got = labels({ ...base, isSender: true });
        return !got.includes('Delete on this device') || ('got ' + JSON.stringify(got));
      });

      add('the menu no longer offers hide', () => {
        const got = labels({ ...base, isSender: true });
        return !got.includes('Hide message') && !got.includes('Show message')
          || ('got ' + JSON.stringify(got));
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

      // --- the Clear list button is reachable, not just present ------------------
      // This is here because the button shipped in the middle of a scrolling
      // modal, 240px below the fold, and the first version of this check found
      // it with querySelector and called it done. Existing in the DOM and
      // visible to a person are different claims, so this measures the one the
      // user actually makes.
      S.setMessageDeleted('a', true);
      S.setMessageDeleted('b', true);
      try {
        await M.openSettings();
      } catch (e) {
        add('settings opens', () => 'settings threw: ' + e.message);
      }

      const modalBody = document.querySelector('.modal-body');
      const clearRow = document.querySelector('.clear-deleted-row');
      add('the Clear list button is in the settings modal', () => {
        return Boolean(clearRow && clearRow.querySelector('button'))
          || 'not found';
      });

      add('the Clear list button is visible without scrolling', () => {
        if (!modalBody || !clearRow) return 'nothing to measure';
        const btn = clearRow.querySelector('button').getBoundingClientRect();
        const view = modalBody.getBoundingClientRect();
        const onScreen = btn.top >= view.top && btn.bottom <= view.bottom;
        return (onScreen && modalBody.scrollTop === 0)
          || ('button at ' + Math.round(btn.top) + '-' + Math.round(btn.bottom)
              + ' inside ' + Math.round(view.top) + '-' + Math.round(view.bottom)
              + ' scrollTop ' + modalBody.scrollTop);
      });

      add('the count of deleted messages is shown next to the button', () => {
        if (!clearRow) return 'no row';
        const text = clearRow.querySelector('span').textContent;
        return text.indexOf('2') >= 0 || ('got ' + JSON.stringify(text));
      });

      add('the button is enabled while there is something to clear', () => {
        if (!clearRow) return 'no row';
        return clearRow.querySelector('button').disabled === false || 'disabled with 2 deleted';
      });

      document.querySelector('#modal-root')?.replaceChildren();

      reset();
      return JSON.stringify(cases);
    })()
  `;

  await app.whenReady();
  harnessGuard(app, { label: 'check:actions' });
  const win = new BrowserWindow({ show: false, width: 1100, height: 780 });
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
