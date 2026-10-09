/**
 * Dev check: sharing a message has to put it somewhere else, intact, once.
 *
 * Forwarding is where three separate mistakes are easy to make, and none of
 * them show up in the composer, because the composer only ever sends one
 * message:
 *
 *   - Beeper takes ONE attachment per send. A message with three files is four
 *     messages, so "share" that quietly drops files 2 and 3 looks like it
 *     worked.
 *   - A file cannot cross chats by pointing at the chat it came from. The other
 *     chat has no access to this one's assets, so it has to be copied across
 *     first or the recipient gets a broken reference.
 *   - A chat you are already in is not "somewhere else". Offering it turns a
 *     share into a second copy of the message in the same conversation.
 *
 * The rules are in share.js with no imports, so they are driven directly here
 * against a recording instead of a real account. The picker in modals.js is
 * then driven for real - real DOM, real clicks - with only window.beeper
 * replaced, which is the actual boundary: if the picker stops calling the
 * method the preload actually exposes, this fails.
 *
 * Run with `npm run check:share`.
 */
const path = require('path');
const fs = require('fs');
const harnessGuard = require('./harness-guard');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const shareURL = pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', 'share.js')).href;
const modalsURL = pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', 'modals.js')).href;
const threadPath = path.join(ROOT, 'src', 'renderer', 'js', 'thread.js');
const preloadPath = path.join(ROOT, 'src', 'preload', 'preload.js');

// modals.js pulls in DOM helpers, so exercise it in a real browser via Electron.
async function main() {
  const { app, BrowserWindow } = require('electron');

  // An isolated profile, so the test can never run a cached copy of the
  // renderer modules: Chromium caches file:// modules in userData, which means
  // a stale renderer can otherwise be executed after the source changed.
  const os = require('os');
  app.setPath('userData', path.join(os.tmpdir(), 'bb-share-check-profile'));

  const harness = `
    (async () => {
      const S = await import(${JSON.stringify(shareURL)});
      const M = await import(${JSON.stringify(modalsURL)});
      const St = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', 'state.js')).href)});

      const cases = [];
      const add = (name, ok, detail) => cases.push([name, !!ok, detail || '']);
      const check = (name, fn) => {
        try {
          const r = fn();
          add(name, r === true, r === true ? '' : String(r));
        } catch (e) { add(name, false, e.message); }
      };
      const checkAsync = async (name, fn) => {
        try {
          const r = await fn();
          add(name, r === true, r === true ? '' : String(r));
        } catch (e) { add(name, false, e.message); }
      };

      const att = (n) => ({ id: 'att' + n, fileName: 'file' + n + '.png', mimeType: 'image/png' });
      const msg = (over) => ({ id: 'm1', text: 'hello', senderName: 'Alex', attachments: [], ...over });

      // ---------------------------------------------------------------------
      // What is worth sharing
      // ---------------------------------------------------------------------

      check('a message with text can be shared', () => S.canShare(msg()) || 'canShare was false');

      check('a message with only files can be shared', () =>
        S.canShare(msg({ text: '', attachments: [att(1)] })) || 'canShare was false');

      check('a deleted message cannot be shared', () =>
        S.canShare(msg({ isDeleted: true })) === false || 'a deleted message was offered');

      check('a message with neither text nor files cannot be shared', () =>
        S.canShare(msg({ text: '   ', attachments: [] })) === false || 'an empty message was offered');

      check('a missing message cannot be shared', () =>
        S.canShare(null) === false || 'canShare(null) was true');

      // ---------------------------------------------------------------------
      // What the recipient sees
      // ---------------------------------------------------------------------

      check('the share says where it came from', () => {
        const got = S.shareAttribution(msg(), 'Team chat');
        return got === 'Forwarded from Alex in Team chat' || got;
      });

      check('the attribution degrades without a sender name', () => {
        const got = S.shareAttribution(msg({ senderName: '' }), 'Team chat');
        return got === 'Forwarded from Team chat' || got;
      });

      check('no attribution is invented when there is nothing to say', () =>
        S.shareAttribution(msg({ senderName: '' }), '') === '' || 'an empty line was produced');

      check('the attribution sits above the message, not after it', () => {
        const got = S.shareText(msg(), 'Team chat');
        return got === 'Forwarded from Alex in Team chat\\n\\nhello' || JSON.stringify(got);
      });

      // ---------------------------------------------------------------------
      // How many sends this turns into
      // ---------------------------------------------------------------------

      check('a text-only message is one send', () =>
        S.shareSendCount(msg()) === 1 || 'count was ' + S.shareSendCount(msg()));

      check('a message with one file is still one send', () => {
        const q = S.shareQueue(msg({ attachments: [att(1)] }), 'Team chat');
        // !! on purpose: the chain ends in a string, and a truthy string is not
        // the boolean the runner compares against.
        return !!(q.length === 1 && q[0].attachment && q[0].text)
          || JSON.stringify(q.map((p) => Object.keys(p)));
      });

      check('three files become three sends, because Beeper takes one file each', () => {
        // Not four: the text rides along with the first file rather than
        // needing a send of its own.
        const q = S.shareQueue(msg({ attachments: [att(1), att(2), att(3)] }), 'Team chat');
        return q.length === 3 || 'queue was ' + q.length + ' long';
      });

      check('only the first send carries the text', () => {
        const q = S.shareQueue(msg({ attachments: [att(1), att(2), att(3)] }), 'Team chat');
        const withText = q.filter((p) => p.text).length;
        return withText === 1 || withText + ' of ' + q.length + ' sends carried the text';
      });

      check('every file still gets sent, in order', () => {
        const q = S.shareQueue(msg({ attachments: [att(1), att(2), att(3)] }), 'Team chat');
        const ids = q.map((p) => p.attachment && p.attachment.id).filter(Boolean);
        return ids.join(',') === 'att1,att2,att3' || ids.join(',');
      });

      check('a file with no message text still starts the queue with the text slot empty', () => {
        const q = S.shareQueue(msg({ text: '', senderName: '', attachments: [att(1)] }), '');
        return (q.length === 1 && q[0].attachment && !q[0].text) || JSON.stringify(q);
      });

      // ---------------------------------------------------------------------
      // Saying what is about to happen
      // ---------------------------------------------------------------------

      check('a one-send share is not announced as several', () => {
        const got = S.shareNotice(msg(), 'Team chat');
        return got === 'Pick a chat or a contact to send this to.' || got;
      });

      check('the notice counts sends, not files plus one for the text', () => {
        // The text rides along with the first file, so three files is three
        // messages, not four.
        const got = S.shareNotice(msg({ attachments: [att(1), att(2), att(3)] }), 'Team chat');
        return /sends 3 messages/.test(got) || got;
      });

      check('the notice does not say the first message carries no file', () => {
        // "the text, then 2 files" describes a split that never happens: the
        // first message carries the text AND the first file.
        const got = S.shareNotice(msg({ attachments: [att(1), att(2)] }), 'Team chat');
        return /one per file/.test(got) || got;
      });

      // ---------------------------------------------------------------------
      // Which chats are worth offering
      // ---------------------------------------------------------------------

      const chat = (id, title, lastActivity, over) =>
        Object.assign({ id: id, title: title, lastActivity: lastActivity }, over || {});

      const CHATS = [
        chat('!src', 'Source chat', '2026-03-05T00:00:00Z'),
        chat('!new', 'Newest', '2026-03-04T00:00:00Z'),
        chat('!old', 'Oldest', '2026-03-01T00:00:00Z'),
        chat('!mid', 'Middle', '2026-03-02T00:00:00Z'),
        chat('!ro', 'Read only', '2026-03-03T00:00:00Z', { isReadOnly: true }),
        chat('!merged', 'Merged', '2026-03-03T12:00:00Z', { mergedIntoChatID: '!new' }),
      ];

      check('the chat it came from is not offered back to itself', () => {
        const ids = S.shareableChats(CHATS, { sourceChatID: '!src' }).map((c) => c.id);
        return ids.indexOf('!src') === -1 || ids.join(',');
      });

      check('a merged row is left out, its real chat is already there', () => {
        const ids = S.shareableChats(CHATS, { sourceChatID: '!src' }).map((c) => c.id);
        return (ids.indexOf('!merged') === -1 && ids.indexOf('!new') !== -1) || ids.join(',');
      });

      check('the newest chats are offered first', () => {
        const ids = S.shareableChats(CHATS, { sourceChatID: '!src' }).map((c) => c.id);
        return ids.slice(0, 3).join(',') === '!new,!ro,!mid' || ids.join(',');
      });

      check('search matches a chat title whatever the case', () => {
        const ids = S.shareableChats(CHATS, { sourceChatID: '!src', query: 'MID' }).map((c) => c.id);
        return ids.join(',') === '!mid' || ids.join(',');
      });

      check('an empty search does not match nothing', () => {
        const ids = S.shareableChats(CHATS, { sourceChatID: '!src', query: '' }).map((c) => c.id);
        return ids.length === 4 || ids.join(',');
      });

      check('a long account does not dump every chat into the picker', () => {
        const many = Array.from({ length: 60 }, (_, i) => chat('!c' + i, 'Chat ' + i, '2026-03-01T00:00:0' + (i % 10) + 'Z'));
        const got = S.shareableChats(many, {});
        return got.length === S.CHAT_LIMIT || 'offered ' + got.length;
      });

      check('read-only chats are separated out rather than dropped', () => {
        const { writable, readOnly } = S.partitionShareable(S.shareableChats(CHATS, { sourceChatID: '!src' }));
        const ids = readOnly.map((c) => c.id);
        return (ids.join(',') === '!ro' && writable.indexOf('!ro') === -1) || (ids.join(',') + ' | ' + writable.map((c) => c.id).join(','));
      });

      check('an untitled chat is still nameable', () => {
        const got = S.chatDisplayName(chat('!x', '   ', '2026-03-01T00:00:00Z'));
        return got === 'Untitled chat' || got;
      });

      // ---------------------------------------------------------------------
      // Sending it
      // ---------------------------------------------------------------------

      /** Records what went out, in order, without touching a real account. */
      const recorder = (opts) => {
        const log = { sent: [], uploads: [] };
        const io = {
          reupload: async (a) => {
            if (opts && opts.reuploadFails) throw new Error('upload refused');
            log.uploads.push(a && a.id);
            // The copy id goes LAST, or the original fields clobber it and the
            // test quietly compares the original attachment against itself.
            return Object.assign({}, a, { id: 'copy-' + (a && a.id) });
          },
          send: async (payload) => {
            if (opts && opts.failAt === log.sent.length + 1) throw new Error('send refused');
            log.sent.push(payload);
            return { id: 'sent' + log.sent.length };
          },
        };
        return { log: log, io: io };
      };

      await checkAsync('the queue goes out in order, one message at a time', async () => {
        const r = recorder();
        const res = await S.deliverQueue(S.shareQueue(msg({ attachments: [att(1), att(2), att(3)] }), 'Team chat'), r.io);
        // The order is the point, not just the tally: if the sends were fired
        // off together the count would still be right while the files arrive
        // in whatever order the network felt like.
        const order = r.log.sent.map((p) => (p.attachment && p.attachment.id) || '(text)').join(',');
        return (res.ok && res.count === 3 && order === 'copy-att1,copy-att2,copy-att3')
          || JSON.stringify({ res: res, order: order });
      });

      await checkAsync('each file is copied across before it is sent', async () => {
        const r = recorder();
        await S.deliverQueue(S.shareQueue(msg({ attachments: [att(1), att(2)] }), 'Team chat'), r.io);
        return r.log.uploads.join(',') === 'att1,att2' || r.log.uploads.join(',');
      });

      check('a text-only share copies no files', () =>
        S.shareQueue(msg()).every((p) => !p.attachment) || 'an empty share queued an upload');

      await checkAsync('a text-only share copies no files at all', async () => {
        const r = recorder();
        await S.deliverQueue(S.shareQueue(msg(), 'Team chat'), r.io);
        return r.log.uploads.length === 0 || r.log.uploads.join(',');
      });

      await checkAsync('every sent message points at a copy, not the original', async () => {
        // All of them, not just the first: the point is that no file in the
        // share can reach the other chat by pointing back at this one.
        const r = recorder();
        await S.deliverQueue(S.shareQueue(msg({ attachments: [att(1), att(2), att(3)] }), 'Team chat'), r.io);
        const ids = r.log.sent.map((p) => (p.attachment && p.attachment.id) || '(none)');
        return ids.join(',') === 'copy-att1,copy-att2,copy-att3' || ids.join(',');
      });

      await checkAsync('a rejected send stops the queue instead of pressing on', async () => {
        // Two people read a chat with half of somebody else's conversation in
        // it differently from one with all of it.
        const r = recorder({ failAt: 2 });
        const res = await S.deliverQueue(S.shareQueue(msg({ attachments: [att(1), att(2), att(3)] }), 'Team chat'), r.io);
        return (res.ok === false && res.count === 1 && r.log.sent.length === 1)
          || JSON.stringify({ res: res, sent: r.log.sent.length });
      });

      await checkAsync('a partial share reports how far it got', async () => {
        const r = recorder({ failAt: 2 });
        const res = await S.deliverQueue(S.shareQueue(msg({ attachments: [att(1), att(2)] }), 'Team chat'), r.io);
        return res.error === 'send refused' || JSON.stringify(res);
      });

      await checkAsync('a failed upload does not send a text-only message in its place', async () => {
        // The failure mode this guards: the upload fails, the code carries on,
        // and the recipient gets the words with the file silently missing.
        const r = recorder({ reuploadFails: true });
        const res = await S.deliverQueue(S.shareQueue(msg({ attachments: [att(1)] }), 'Team chat'), r.io);
        return (res.ok === false && r.log.sent.length === 0) || JSON.stringify(res);
      });

      await checkAsync('deliverQueue never throws at its caller', async () => {
        let threw = false;
        try {
          await S.deliverQueue([{ text: 'x' }], { reupload: async () => ({}), send: async () => { throw new Error('x'); } });
        } catch (e) { threw = true; }
        return threw === false || 'deliverQueue threw';
      });

      await checkAsync('a missing send method fails rather than crashing the picker', async () => {
        let threw = false;
        let res = null;
        try {
          res = await S.deliverQueue([{ text: 'x' }], { reupload: async () => ({}) });
        } catch (e) { threw = true; }
        return (threw === false && res && res.ok === false) || JSON.stringify({ threw: threw, res: res });
      });

      // ---------------------------------------------------------------------
      // The picker itself, driven for real
      // ---------------------------------------------------------------------

      // The one boundary that gets replaced: window.beeper. Everything above
      // this line is the real module; everything below runs the real modal,
      // the real search, and the real click handlers.
      const calls = { send: [], uploads: [], create: [], contacts: [] };
      let reuploadReturnsNothing = false;
      let failSendAt = 0;

      window.beeper = {
        accounts: { list: async () => ({ ok: true, data: [] }) },
        contacts: {
          list: async (accountID, params) => {
            calls.contacts.push({ accountID: accountID, query: params && params.query });
            return { ok: true, data: { items: [
              { userID: '!contact1', fullName: 'Bea Example', username: 'bea' },
            ] } };
          },
        },
        chats: {
          list: async () => ({ ok: true, data: {} }),
          create: async (payload) => {
            calls.create.push(payload);
            return { ok: true, data: { id: '!newchat', title: 'Bea Example' } };
          },
        },
        messages: {
          send: async (chatID, payload) => {
            calls.send.push({ chatID: chatID, payload: payload });
            if (failSendAt && calls.send.length === failSendAt) return { ok: false, error: { message: 'send refused' } };
            return { ok: true, data: { id: 'm' + calls.send.length } };
          },
        },
        assets: {
          reupload: async (attachment) => {
            calls.uploads.push(attachment && attachment.id);
            return reuploadReturnsNothing ? { ok: true, data: null } : { ok: true, data: { id: 'copy-' + attachment.id } };
          },
        },
      };

      const tick = (ms) => new Promise((r) => setTimeout(r, ms || 12));
      const root = () => document.querySelector('#modal-root');
      const lists = () => [...document.querySelectorAll('#modal-root .result-list')];
      const titles = (list) => [...list.querySelectorAll('.result-item-title')].map((n) => n.textContent);
      const summaries = () => [...document.querySelectorAll('#modal-root .search-summary')].map((n) => n.textContent);
      const toastText = () => [...document.querySelectorAll('#toast-root .toast')].map((n) => n.textContent).join(' | ');

      const SOURCE = { id: '!src', title: 'Source chat', accountID: '!acct', lastActivity: '2026-03-05T00:00:00Z' };

      function seed(over) {
        St.state.chats.clear();
        for (const c of [SOURCE, chat('!other', 'Other chat', '2026-03-04T00:00:00Z', over)])
          St.state.chats.set(c.id, c);
        St.state.accounts = [{ accountID: '!acct', status: 'connected' }];
        calls.send.length = 0; calls.uploads.length = 0; calls.create.length = 0; calls.contacts.length = 0;
        reuploadReturnsNothing = false;
        failSendAt = 0;
        document.querySelector('#toast-root').innerHTML = '';
      }

      async function open(message, sourceChat) {
        M.openSharePicker(message || msg(), sourceChat || SOURCE);
        await tick();
      }

      await checkAsync('the picker offers the other chats, not the one it came from', async () => {
        seed();
        await open();
        const got = titles(lists()[0] || document.createElement('div'));
        return got.join(',') === 'Other chat' || got.join(',');
      });

      await checkAsync('a read-only chat is left out and the picker says so', async () => {
        seed({ isReadOnly: true });
        await open();
        const got = titles(lists()[0] || document.createElement('div'));
        const said = summaries().join(' ');
        return (got.length === 0 && /1 read-only chat/.test(said)) || ('rows: ' + got.join(',') + ' / summary: ' + said);
      });

      await checkAsync('the picker says how many messages a share will send', async () => {
        seed();
        await open(msg({ attachments: [att(1), att(2), att(3)] }));
        const header = summaries()[0] || '';
        // A literal, not shareNotice()'s own output: comparing the picker to the
        // function it calls would agree with any number the function produces.
        return header === 'Sending this sends 3 messages, one per file - Beeper takes a single file at a time.'
          || header;
      });

      await checkAsync('a single-send share is not announced as several', async () => {
        seed();
        await open();
        const header = summaries()[0] || '';
        return /Pick a chat or a contact/.test(header) || header;
      });

      await checkAsync('picking a chat sends the forwarded text once', async () => {
        seed();
        await open();
        (lists()[0].querySelector('.result-item')).click();
        await tick(60);
        return (calls.send.length === 1
          && calls.send[0].chatID === '!other'
          && calls.send[0].payload.text === 'Forwarded from Alex in Source chat\\n\\nhello')
          || JSON.stringify(calls.send);
      });

      await checkAsync('picking a chat with files sends every file, copied across', async () => {
        seed();
        await open(msg({ attachments: [att(1), att(2)] }));
        (lists()[0].querySelector('.result-item')).click();
        await tick(60);
        return (calls.send.length === 2 && calls.uploads.join(',') === 'att1,att2')
          || JSON.stringify({ sent: calls.send.length, uploads: calls.uploads });
      });

      await checkAsync('the success message says where it went', async () => {
        seed();
        await open();
        (lists()[0].querySelector('.result-item')).click();
        await tick(60);
        return /Shared to Other chat/.test(toastText()) || toastText();
      });

      await checkAsync('a send that fails part way says how far it got', async () => {
        seed();
        failSendAt = 2;
        await open(msg({ attachments: [att(1), att(2)] }));
        (lists()[0].querySelector('.result-item')).click();
        await tick(60);
        const said = toastText();
        return (/1 of the messages went/.test(said) && /send refused/.test(said)) || said;
      });

      await checkAsync('a copy that produced nothing stops the share rather than sending the text alone', async () => {
        seed();
        reuploadReturnsNothing = true;
        await open(msg({ attachments: [att(1)] }));
        (lists()[0].querySelector('.result-item')).click();
        await tick(60);
        return (calls.send.length === 0 && /could not be copied/i.test(toastText()))
          || JSON.stringify({ sent: calls.send.length, toast: toastText() });
      });

      await checkAsync('searching finds a contact who has no chat yet', async () => {
        seed();
        await open();
        const search = root().querySelector('input[type=search]');
        search.value = 'bea';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await tick(400);
        const got = titles(lists()[1] || document.createElement('div'));
        return got.join(',') === 'Bea Example' || got.join(',');
      });

      await checkAsync('a contact with no chat gets one created, then the queue goes in', async () => {
        seed();
        await open();
        const search = root().querySelector('input[type=search]');
        search.value = 'bea';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await tick(400);
        (lists()[1].querySelector('.result-item')).click();
        await tick(60);
        return (calls.create.length === 1 && calls.send.length === 1 && calls.send[0].chatID === '!newchat')
          || JSON.stringify({ create: calls.create.length, send: calls.send.length });
      });

      await checkAsync('a new chat is created empty, so the text is never sent twice', async () => {
        // createChat accepts an opening messageText. Using it here would post
        // the text once at creation and again as the first queued send.
        seed();
        await open(msg({ attachments: [att(1)] }));
        const search = root().querySelector('input[type=search]');
        search.value = 'bea';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await tick(400);
        (lists()[1].querySelector('.result-item')).click();
        await tick(60);
        const payload = calls.create[0] || {};
        const clean = !('messageText' in payload);
        const twice = calls.send.filter((s) => s.payload.text).length === 1;
        return (clean && twice) || JSON.stringify({ create: payload, texts: calls.send.filter((s) => s.payload.text).length });
      });

      await checkAsync('clicking twice cannot send the same message twice', async () => {
        seed();
        await open();
        const row = lists()[0].querySelector('.result-item');
        row.click(); row.click(); row.click();
        await tick(60);
        return calls.send.length === 1 || calls.send.length + ' sends went out';
      });

      // Report from the page, decide the exit code in Node: the renderer has
      // no process object to exit with.
      return JSON.stringify(cases);
    })()
  `;

  await app.whenReady();
  // Expire on our own rather than being killed from outside, which would pop
  // an Electron error dialog that looks like the app under test crashing.
  harnessGuard(app, { label: 'check:share' });
  const win = new BrowserWindow({ show: false });
  // A real file:// page, because a data: URL cannot import an ES module.
  await win.loadFile(path.join(__dirname, 'share-harness.html'));
  const result = await win.webContents.executeJavaScript(harness, true);
  app.exit(0);
  return JSON.parse(result);
}

main()
  .then((cases) => {
    const threadSrc = fs.readFileSync(threadPath, 'utf8');
    const preloadSrc = fs.readFileSync(preloadPath, 'utf8');

    // Wiring. Asserting on share.js alone would pass while thread.js grew its
    // own idea of what is shareable, or while the preload stopped exposing the
    // method the picker calls.
    const menuHasShare = /label:\s*'Share with\.\.\.'/.test(threadSrc);
    const menuGated = /canShare\(message\)[\s\S]{0,120}Share with\.\.\./.test(threadSrc);
    const menuOpensPicker = /openSharePicker\(message,\s*currentChat\)/.test(threadSrc);
    const exposesReupload = /reupload:\s*\(attachment\)\s*=>\s*invoke\('assets:reupload'/.test(preloadSrc);

    cases.push(
      ['the message menu offers sharing', menuHasShare],
      ['sharing is offered only when there is something to share', menuGated],
      ['the menu item opens the picker for that message', menuOpensPicker],
      ['the preload exposes the file-copy call the picker needs', exposesReupload],
    );

    let failed = 0;
    for (const [name, ok, detail] of cases) {
      if (!ok) failed++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
    }
    console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error('failed:', err.message);
    process.exit(1);
  });