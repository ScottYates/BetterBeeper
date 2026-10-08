/**
 * Dev check: the optimistic-send placeholder must be absorbed once the real
 * message arrives, or the thread shows the message twice with one of them
 * stuck on "sending".
 *
 * Run with `npm run check:send`.
 */
const path = require('path');
const fs = require('fs');
const harnessGuard = require('./harness-guard');
const { pathToFileURL } = require('url');

const statePath = path.join(__dirname, '..', 'src', 'renderer', 'js', 'state.js');
const threadPath = path.join(__dirname, '..', 'src', 'renderer', 'js', 'thread.js');

// state.js pulls in DOM helpers, so exercise it in a browser via Electron.
async function main() {
  const { app, BrowserWindow } = require('electron');
  const src = pathToFileURL(statePath).href;
  const harness = `
    (async () => {
      const st = await import(${JSON.stringify(src)});
      const now = Date.now();
      const chatID = 'test-chat';
      const out = {};

      const reset = () => st.state.messages.set(chatID, []);
      const ids = () => (st.state.messages.get(chatID) || []).map((m) => m.id);
      const pending = () => (st.state.messages.get(chatID) || []).filter((m) => m.sendStatus === 'pending');

      // A normal text send.
      reset();
      st.upsertMessage(chatID, { id: 'PH-A', isSender: true, sendStatus: 'pending', text: 'hi', timestamp: new Date(now).toISOString(), sortKey: '1', attachments: [] });
      st.upsertMessage(chatID, { id: 'REAL-A', isSender: true, sendStatus: 'sent', text: 'hi', timestamp: new Date(now).toISOString(), sortKey: '2', attachments: [] });
      out.textSend = ids();

      // An attachment-only send: the placeholder has no text to match on.
      reset();
      st.upsertMessage(chatID, { id: 'PH-B', isSender: true, sendStatus: 'pending', text: '', timestamp: new Date(now).toISOString(), sortKey: '1', attachments: [] });
      st.upsertMessage(chatID, { id: 'REAL-B', isSender: true, sendStatus: 'sent', text: '', timestamp: new Date(now).toISOString(), sortKey: '2', attachments: [{ id: 'att' }] });
      out.attachmentSend = ids();

      // Two attachment sends in a row must absorb one placeholder each.
      reset();
      st.upsertMessage(chatID, { id: 'PH-C1', isSender: true, sendStatus: 'pending', text: '', timestamp: new Date(now).toISOString(), sortKey: '1', attachments: [] });
      st.upsertMessage(chatID, { id: 'PH-C2', isSender: true, sendStatus: 'pending', text: '', timestamp: new Date(now + 1000).toISOString(), sortKey: '2', attachments: [] });
      st.upsertMessage(chatID, { id: 'REAL-C1', isSender: true, sendStatus: 'sent', text: '', timestamp: new Date(now).toISOString(), sortKey: '3', attachments: [{ id: 'a' }] });
      st.upsertMessage(chatID, { id: 'REAL-C2', isSender: true, sendStatus: 'sent', text: '', timestamp: new Date(now + 1000).toISOString(), sortKey: '4', attachments: [{ id: 'b' }] });
      out.twoAttachments = ids();

      // Someone else's message must never absorb your placeholder.
      reset();
      st.upsertMessage(chatID, { id: 'PH-D', isSender: true, sendStatus: 'pending', text: 'mine', timestamp: new Date(now).toISOString(), sortKey: '1', attachments: [] });
      st.upsertMessage(chatID, { id: 'REAL-D', isSender: false, sendStatus: 'sent', text: 'mine', timestamp: new Date(now).toISOString(), sortKey: '2', attachments: [] });
      out.fromSomeoneElse = ids();

      // A stale placeholder must not absorb a much later message.
      reset();
      const longAgo = new Date(now - 20 * 60 * 1000).toISOString();
      st.upsertMessage(chatID, { id: 'PH-E', isSender: true, sendStatus: 'pending', text: 'old', timestamp: longAgo, sortKey: '1', attachments: [] });
      st.upsertMessage(chatID, { id: 'REAL-E', isSender: true, sendStatus: 'sent', text: 'old', timestamp: new Date(now).toISOString(), sortKey: '2', attachments: [] });
      out.staleKeepsBoth = ids();

      // The ordering race that left bubbles stuck on "sending" for real: the
      // placeholder is inserted before the round trip, and Beeper answers with
      // its own pendingMessageID, which we then adopt.
      reset();
      st.upsertMessage(chatID, { id: '~txn:local:1', isSender: true, sendStatus: 'pending', text: 'race', timestamp: new Date(now).toISOString(), sortKey: '1', attachments: [] });
      out.rekeyed = (st.rekeyMessage(chatID, '~txn:local:1', '~txn:network:99') && ids().join(',')) || 'FAILED';

      // The authoritative message then merges into the re-keyed bubble by id.
      st.upsertMessage(chatID, { id: '~txn:network:99', isSender: true, sendStatus: 'sent', text: 'race', timestamp: new Date(now).toISOString(), sortKey: '2', attachments: [] });
      out.afterMerge = ids();

      // If the echo absorbed the placeholder first, re-keying is a harmless no-op.
      reset();
      st.upsertMessage(chatID, { id: 'PH-F', isSender: true, sendStatus: 'pending', text: 'echo first', timestamp: new Date(now).toISOString(), sortKey: '1', attachments: [] });
      st.upsertMessage(chatID, { id: 'REAL-F', isSender: true, sendStatus: 'sent', text: 'echo first', timestamp: new Date(now).toISOString(), sortKey: '2', attachments: [] });
      const noop = st.rekeyMessage(chatID, '~txn:local:2', '~txn:network:100');
      out.echoFirst = { result: noop, ids: ids().join(',') };

      // A real confirmation carries no sendStatus at all - that was read off a
      // live Beeper echo, not assumed. So merging one into a bubble that is
      // still marked pending leaves the flag exactly as it was, and nothing in
      // the app ever clears it.
      reset();
      st.upsertMessage(chatID, { id: '~txn:local:3', isSender: true, sendStatus: 'pending', text: 'merge', timestamp: new Date(now).toISOString(), sortKey: '1', attachments: [] });
      st.rekeyMessage(chatID, '~txn:local:3', '~beeper-mautrix-go_1');
      st.upsertMessage(chatID, { id: '~beeper-mautrix-go_1', isSender: true, text: 'merge', timestamp: new Date(now + 300).toISOString(), sortKey: '2', attachments: [] });
      out.mergeStatus = (st.state.messages.get(chatID) || [])[0]?.sendStatus ?? '(none)';

      // Two identical sends in flight. The confirmations arrive in the order the
      // messages were sent, so the first one belongs to the oldest bubble still
      // waiting - not to the newest one.
      reset();
      st.upsertMessage(chatID, { id: 'PH-G1', isSender: true, sendStatus: 'pending', text: 'same', timestamp: new Date(now).toISOString(), sortKey: '1', attachments: [] });
      st.upsertMessage(chatID, { id: 'PH-G2', isSender: true, sendStatus: 'pending', text: 'same', timestamp: new Date(now + 400).toISOString(), sortKey: '2', attachments: [] });
      st.upsertMessage(chatID, { id: 'REAL-G1', isSender: true, text: 'same', timestamp: new Date(now + 800).toISOString(), sortKey: '3', attachments: [] });
      out.inFlight = ids();

      // An optimistic insert is not a confirmation. Typing the same thing twice
      // used to let the second bubble swallow the first as it was inserted, and
      // the two sends then shared one placeholder.
      reset();
      st.upsertMessage(chatID, { id: 'PH-L1', isSender: true, sendStatus: 'pending', text: 'again', timestamp: new Date(now).toISOString(), sortKey: '1', attachments: [] });
      st.upsertMessage(chatID, { id: 'PH-L2', isSender: true, sendStatus: 'pending', text: 'again', timestamp: new Date(now + 400).toISOString(), sortKey: '2', attachments: [] });
      out.twoPlaceholders = ids().join(',');

      // The stored text is not always byte-identical to what was typed. A
      // confirmation nothing can match must still settle the oldest send rather
      // than leave it on "sending" for good.
      reset();
      st.upsertMessage(chatID, { id: 'PH-I', isSender: true, sendStatus: 'pending', text: 'hi', timestamp: new Date(now).toISOString(), sortKey: '1', attachments: [] });
      st.upsertMessage(chatID, { id: 'REAL-I', isSender: true, text: 'hi ', timestamp: new Date(now + 500).toISOString(), sortKey: '2', attachments: [] });
      out.unmatchedText = { ids: ids().join(','), pending: pending().length };

      // Marking a send failed must only ever touch the bubble we own.
      reset();
      st.upsertMessage(chatID, { id: 'PH-J', isSender: true, sendStatus: 'pending', text: 'boom', timestamp: new Date(now).toISOString(), sortKey: '1', attachments: [] });
      out.markPresent = typeof st.markSendFailed === 'function' ? st.markSendFailed(chatID, 'PH-J') : 'MISSING';
      out.markStatus = (st.state.messages.get(chatID) || [])[0]?.sendStatus ?? '(none)';

      // The confirmation already absorbed it, so the message did go out. Failing
      // it here would put the same text in the thread a second time.
      reset();
      st.upsertMessage(chatID, { id: 'PH-K', isSender: true, sendStatus: 'pending', text: 'boom', timestamp: new Date(now).toISOString(), sortKey: '1', attachments: [] });
      st.upsertMessage(chatID, { id: 'REAL-K', isSender: true, text: 'boom', timestamp: new Date(now + 200).toISOString(), sortKey: '2', attachments: [] });
      out.markGone = typeof st.markSendFailed === 'function' ? st.markSendFailed(chatID, 'PH-K') : 'MISSING';
      out.markGoneIds = ids().join(',');

      return JSON.stringify(out);
    })()
  `;

  await app.whenReady();
  // Expire on our own rather than being killed from outside, which would pop
  // an Electron error dialog that looks like the app under test crashing.
  harnessGuard(app, { label: 'check:send' });
  const win = new BrowserWindow({ show: false });
  // A real file:// page: a data: URL cannot import ES modules.
  await win.loadFile(path.join(__dirname, 'send-harness.html'));
  const result = await win.webContents.executeJavaScript(harness, true);
  app.exit(0);
  return JSON.parse(result);
}

main()
  .then((out) => {
    if (process.env.SEND_CHECK_DEBUG) console.log(JSON.stringify(out, null, 2));
    const threadSrc = fs.readFileSync(threadPath, 'utf8');
    // Wiring: the failure branch has to go through the helper. Asserting on the
    // helper alone would pass while thread.js went on re-inserting bubbles.
    const failureBranch = /markSendFailed\(chat\.id, txnID\)/.test(threadSrc);
    const resurrects =
      /upsertMessage\(\s*chat\.id,\s*\{\s*id:\s*txnID,\s*sendStatus:\s*'failed'/.test(threadSrc);

    const cases = [
      ['text send absorbs its placeholder', out.textSend.join(',') === 'REAL-A'],
      ['attachment send absorbs its placeholder', out.attachmentSend.join(',') === 'REAL-B'],
      ['two attachment sends absorb both', out.twoAttachments.join(',') === 'REAL-C1,REAL-C2'],
      ['incoming message from someone else leaves ours', out.fromSomeoneElse.join(',') === 'PH-D,REAL-D'],
      ['stale placeholder is not absorbed by a late message', out.staleKeepsBoth.join(',') === 'PH-E,REAL-E'],
      ['re-key adopts the id Beeper returns', out.rekeyed === '~txn:network:99'],
      ['authoritative message merges into the re-keyed bubble', out.afterMerge.join(',') === '~txn:network:99'],
      ['re-key is a no-op once the echo absorbed it', out.echoFirst.result === false && out.echoFirst.ids === 'REAL-F'],
      ['a confirmation stops the bubble claiming to be in flight', out.mergeStatus === '(none)'],
      ['the first confirmation settles the oldest of two in-flight sends', out.inFlight.join(',') === 'PH-G2,REAL-G1'],
      ['typing the same thing twice keeps both bubbles', out.twoPlaceholders === 'PH-L1,PH-L2'],
      ['a confirmation nothing matches still settles a send', out.unmatchedText.ids === 'REAL-I' && out.unmatchedText.pending === 0],
      ['a failed send marks the bubble it owns', out.markPresent === true && out.markStatus === 'failed'],
      ['a failed send never re-inserts a bubble that already landed', out.markGone === false && out.markGoneIds === 'REAL-K'],
      ['the renderer fails a send through that helper', failureBranch && !resurrects],
    ];
    let failed = 0;
    for (const [name, ok] of cases) {
      if (!ok) failed++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    }
    console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error('failed:', err.message);
    process.exit(1);
  });
