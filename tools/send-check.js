/**
 * Dev check: the optimistic-send placeholder must be absorbed once the real
 * message arrives, or the thread shows the message twice with one of them
 * stuck on "sending".
 *
 * Run with `npm run check:send`.
 */
const path = require('path');
const { pathToFileURL } = require('url');

const statePath = path.join(__dirname, '..', 'src', 'renderer', 'js', 'state.js');

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

      return JSON.stringify(out);
    })()
  `;

  await app.whenReady();
  const win = new BrowserWindow({ show: false });
  // A real file:// page: a data: URL cannot import ES modules.
  await win.loadFile(path.join(__dirname, 'send-harness.html'));
  const result = await win.webContents.executeJavaScript(harness, true);
  app.exit(0);
  return JSON.parse(result);
}

main()
  .then((out) => {
    const cases = [
      ['text send absorbs its placeholder', out.textSend.join(',') === 'REAL-A'],
      ['attachment send absorbs its placeholder', out.attachmentSend.join(',') === 'REAL-B'],
      ['two attachment sends absorb both', out.twoAttachments.join(',') === 'REAL-C1,REAL-C2'],
      ['incoming message from someone else leaves ours', out.fromSomeoneElse.join(',') === 'PH-D,REAL-D'],
      ['stale placeholder is not absorbed by a late message', out.staleKeepsBoth.join(',') === 'PH-E,REAL-E'],
      ['re-key adopts the id Beeper returns', out.rekeyed === '~txn:network:99'],
      ['authoritative message merges into the re-keyed bubble', out.afterMerge.join(',') === '~txn:network:99'],
      ['re-key is a no-op once the echo absorbed it', out.echoFirst.result === false && out.echoFirst.ids === 'REAL-F'],
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
