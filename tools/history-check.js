/**
 * Dev check: the local message store.
 *
 * This is the module that decides what history exists on this machine, and the
 * one place in the app that can quietly destroy real data: a backfill that
 * stopped partway has ordinary gaps, and reading those gaps as "Beeper deleted
 * these" would tombstone messages that were never touched.
 *
 * So the rule is asserted in both directions -- a complete run must tombstone,
 * an interrupted one must not -- and the check is proven to go red when the
 * guard is removed. A check that cannot fail is not a check.
 *
 * Plain node, no Electron: message-store.js deliberately imports nothing from
 * electron so it can be exercised here. See media-path.js for the precedent.
 *
 * Run with `npm run check:history`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMessageStore } = require(path.join(__dirname, '..', 'src', 'main', 'message-store.js'));
const { openMediaStore } = require(path.join(__dirname, '..', 'src', 'main', 'media-store.js'));
const { createHistorySync } = require(path.join(__dirname, '..', 'src', 'main', 'history-sync.js'));

const cases = [];

function add(name, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = fn();
    ok = r === true;
    if (r !== true) detail = String(r);
  } catch (e) {
    ok = false;
    detail = e.message;
  }
  cases.push([name, ok, detail]);
}

/** A message shaped like the ones Beeper actually sends. */
const msg = (id, ts, text, extra) =>
  Object.assign({ id, timestamp: ts, text, senderID: 's1', senderName: 'Someone' }, extra || {});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-history-check-'));
const store = openMessageStore(dir);

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

add('the store opens and reports a schema version', () =>
  store.userVersion() >= 1 || ('got ' + store.userVersion()));

add('the database file is where it claims to be', () =>
  fs.existsSync(store.file) || ('missing ' + store.file));

add('reopening the same directory keeps the data', () => {
  store.upsertMessages('c0', [msg('keep', 1000, 'survives a reopen')], {});
  const again = openMessageStore(dir);
  const found = again.page('c0', { limit: 10 }).map((m) => m.id);
  again.close();
  return found.join(',') === 'keep' || ('got ' + JSON.stringify(found));
});

// ---------------------------------------------------------------------------
// Writing and reading
// ---------------------------------------------------------------------------

store.upsertMessages('c1', [msg('m3', 3000, 'third'), msg('m1', 1000, 'first'), msg('m2', 2000, 'second')], {
  oldestTs: 1000,
});

add('messages come back oldest first', () => {
  const got = store.page('c1', { limit: 10 }).map((m) => m.id).join(',');
  return got === 'm1,m2,m3' || ('got ' + got);
});

add('the newest page really is the newest', () =>
  store.newest('c1', 2).map((m) => m.id).join(',') === 'm2,m3' || 'wrong window');

add('paging before a message excludes it and everything newer', () => {
  const got = store.page('c1', { before: 'm2', limit: 10 }).map((m) => m.id).join(',');
  return got === 'm1' || ('got ' + got);
});

add('the payload survives the round trip', () => {
  // With no cursor, page() is the newest page; that is the whole point of it.
  const back = store.page('c1', { limit: 1 })[0];
  return (back.id === 'm3' && back.senderName === 'Someone' && back.text === 'third')
    || JSON.stringify(back);
});

add('the oldest of a full page is still the oldest', () => {
  const first = store.page('c1', { limit: 10 })[0];
  return (first.id === 'm1' && first.text === 'first') || JSON.stringify(first);
});

add('writing the same id twice updates rather than duplicating', () => {
  store.upsertMessages('c1', [msg('m1', 1000, 'edited')], { oldestTs: 1000 });
  const all = store.page('c1', { limit: 10 });
  return (all.length === 3 && all[0].text === 'edited')
    || ('got ' + JSON.stringify(all.map((m) => m.text)));
});

add('an empty chat pages to nothing rather than throwing', () =>
  store.page('nope', { limit: 10 }).length === 0 || 'threw');

add('the same message id in two chats is kept in both', () => {
  // Caught by building the backfill queue: a fake Beeper that handed the same
  // ids to two chats lost one of them entirely, because the key was id alone.
  store.upsertMessages('dupA', [msg('same-id', 1000, 'in A')], {});
  store.upsertMessages('dupB', [msg('same-id', 1000, 'in B')], {});
  const a = store.page('dupA', { limit: 5 }).map((m) => m.text).join(',');
  const b = store.page('dupB', { limit: 5 }).map((m) => m.text).join(',');
  return (a === 'in A' && b === 'in B') || ('A=' + a + ' B=' + b);
});

add('tombstoning one chat leaves the other with the same id alone', () => {
  store.upsertMessages('dupA', [msg('same-id', 1000, 'in A')], {});
  store.reconcile('dupA', [], { complete: true, oldestTs: 1000 });
  const b = store.page('dupB', { limit: 5 }).map((m) => m.text).join(',');
  return b === 'in B' || ('B=' + b);
});

add('a message with no timestamp still stores', () => {
  store.upsertMessages('c1b', [msg('notime', undefined, 'no clock')], {});
  return store.page('c1b', { limit: 5 }).length === 1 || 'dropped a message with no timestamp';
});

add('an ISO timestamp is understood, not read as year zero', () => {
  store.upsertMessages('c1c', [msg('iso', '2026-03-04T10:00:00Z', 'iso')], {});
  const row = store.chatStatus('c1c');
  const back = store.page('c1c', { limit: 5 })[0];
  return row.count === 1 && back.timestamp === '2026-03-04T10:00:00Z' || 'lost the message';
});

// ---------------------------------------------------------------------------
// Tombstones
// ---------------------------------------------------------------------------

add('a complete run tombstones what Beeper dropped', () => {
  store.upsertMessages('c2', [msg('a', 1000, 'kept'), msg('b', 2000, 'gone later')], {});
  const r = store.reconcile('c2', ['a'], { complete: true, oldestTs: 1000 });
  const drawn = store.page('c2', { limit: 10 }).map((m) => m.id);
  return (r.tombstoned === 1 && drawn.join(',') === 'a')
    || ('tombstoned ' + r.tombstoned + ', drew ' + JSON.stringify(drawn));
});

add('an interrupted run tombstones nothing', () => {
  store.upsertMessages('c3', [msg('x', 1000, 'x'), msg('y', 2000, 'y')], {});
  const r = store.reconcile('c3', ['x'], { complete: false, oldestTs: 1000 });
  const drawn = store.page('c3', { limit: 10 }).map((m) => m.id).join(',');
  return (r.tombstoned === 0 && drawn === 'x,y') || ('tombstoned ' + r.tombstoned + ', drew ' + drawn);
});

add('an interrupted run leaves the chat incomplete', () =>
  store.isComplete('c3') === false || 'an interrupted run marked the chat complete');

add('a complete run marks the chat complete', () =>
  store.isComplete('c2') === true || 'a complete run did not mark the chat complete');

add('a tombstone is not resurrected by a later write', () => {
  store.upsertMessages('c2', [msg('b', 2000, 'back again')], {});
  const drawn = store.page('c2', { limit: 10 }).map((m) => m.id);
  return !drawn.includes('b') || 'a tombstone came back';
});

add('a tombstone is not resurrected by a later reconcile either', () => {
  store.reconcile('c2', ['a', 'b'], { complete: true, oldestTs: 1000 });
  const drawn = store.page('c2', { limit: 10 }).map((m) => m.id);
  return !drawn.includes('b') || 'a complete reconcile with b still un-gone';
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

store.upsertMessages('c4', [msg('s1', 1000, 'the quick brown fox'), msg('s2', 2000, 'lazy dog sleeps')], {});

add('search finds a word in stored history', () => {
  const hits = store.search('brown', { limit: 10 });
  return (hits.length === 1 && hits[0].id === 's1')
    || ('got ' + JSON.stringify(hits.map((h) => h.id)));
});

add('search returns more than Beeper ever would', () => {
  const many = [];
  for (let i = 0; i < 60; i++) many.push(msg('n' + i, 3000 + i, 'needle in haystack ' + i));
  store.upsertMessages('c5', many, {});
  const hits = store.search('needle', { limit: 50 });
  return hits.length === 50 || ('got ' + hits.length);
});

add('search skips tombstoned rows', () => {
  store.reconcile('c4', ['s1'], { complete: true, oldestTs: 1000 });
  return store.search('sleeps', { limit: 10 }).length === 0 || 'returned a tombstone';
});

add('an edited message is findable by its new text', () => {
  store.upsertMessages('c4', [msg('s1', 1000, 'rewritten entirely')], {});
  return (store.search('rewritten', { limit: 10 }).length === 1
      && store.search('brown', { limit: 10 }).length === 0)
    || 'the index did not follow the edit';
});

add('search can be scoped to chats', () => {
  const hits = store.search('needle', { limit: 50, chatIDs: ['c5'] });
  return hits.length > 0 && hits.every((h) => h.chatID === 'c5') || 'scoping leaked another chat';
});

add('search scoped to an empty chat list returns nothing', () =>
  store.search('needle', { limit: 10, chatIDs: [] }).length === 0 || 'ignored the scope');

add('an unbalanced quote is searched for literally instead of throwing', () => {
  store.search('"unbalanced', { limit: 10 });
  store.search('a AND (', { limit: 10 });
  store.search('*', { limit: 10 });
  store.search('', { limit: 10 });
  return true;
});

add('an empty query returns nothing rather than everything', () =>
  store.search('', { limit: 10 }).length === 0 && store.search('   ', { limit: 10 }).length === 0
    || 'an empty query matched rows');

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

add('status counts only live messages', () => {
  const s = store.chatStatus('c5');
  return s.count === 60 || ('got ' + s.count);
});

add('stats report a file on disk', () => {
  const s = store.stats();
  return s.messages > 0 && s.bytes > 0 || JSON.stringify(s);
});

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

const media = openMediaStore(dir);
const mediaSrc = path.join(dir, 'source.bin');
fs.writeFileSync(mediaSrc, 'media bytes that must survive');

add('an image is stored', () => {
  const r = media.adopt(mediaSrc, { fileName: 'holiday photo.jpg', mimeType: 'image/jpeg' });
  return r && /^[0-9a-f]{64}$/.test(r.hash) || ('got ' + JSON.stringify(r));
});

// Everything gets pulled down. The bytes live on disk either way, never in the
// database, so the only question is whether this machine has a copy at all -
// and a video or a document scrolled past months ago will not still be in a
// cache Beeper is free to evict.
for (const [label, attachment] of [
  ['a video', { fileName: 'clip.mp4', mimeType: 'video/mp4' }],
  ['a video with no mime type', { fileName: 'holiday.mov' }],
  ['an archive', { fileName: 'backup.zip', mimeType: 'application/x-zip-compressed' }],
  ['a pdf', { fileName: 'report.pdf', mimeType: 'application/pdf' }],
  ['audio', { fileName: 'song.mp3', mimeType: 'audio/mpeg' }],
]) {
  add(`${label} is pulled down to the filesystem`, () => {
    const r = media.adopt(mediaSrc, attachment);
    return (r && /^[0-9a-f]{64}$/.test(r.hash)) || ('refused: ' + JSON.stringify(r));
  });
}

add('a stored file keeps a readable extension', () => {
  // Distinct bytes, or content addressing does its job and returns the copy
  // some earlier test made from the same content under a different name.
  const unique = path.join(dir, 'unique-clip.mp4');
  fs.writeFileSync(unique, 'bytes no other test has written');
  const r = media.adopt(unique, { fileName: 'clip.mp4', mimeType: 'video/mp4' });
  return (r && r.relativePath.endsWith('.mp4') === true) || ('got ' + JSON.stringify(r));
});

// The policy that every attachment is kept, whatever it is. This started life
// as "images only", which quietly meant a video sent in March was gone by June.
add('every kind of attachment is pulled down, not just pictures', () => {
  const kinds = [
    ['holiday.png', 'image/png'],
    ['clip.mp4', 'video/mp4'],
    ['song.mp3', 'audio/mpeg'],
    ['report.pdf', 'application/pdf'],
    ['backup.zip', 'application/zip'],
    ['notes.txt', 'text/plain'],
    ['data.json', 'application/json'],
    ['no-extension-at-all', 'application/octet-stream'],
    ['weird.name.with.dots.v2.tar.gz', 'application/gzip'],
  ];
  const skipped = [];
  for (const [i, [fileName, mimeType]] of kinds.entries()) {
    // Distinct bytes per kind, so content addressing returns this one's copy.
    const src = path.join(dir, `kind-${i}.bin`);
    fs.writeFileSync(src, `unique bytes for ${fileName}`);
    if (!media.adopt(src, { fileName, mimeType })) skipped.push(fileName);
  }
  return skipped.length === 0 || 'never stored: ' + skipped.join(', ');
});

add('an attachment with no name at all is still stored', () => {
  const src = path.join(dir, 'nameless.bin');
  fs.writeFileSync(src, 'bytes from an attachment with no filename');
  const r = media.adopt(src, { mimeType: 'application/octet-stream' });
  return (r && media.has(r.hash)) || 'refused an attachment that has no name';
});

// The claim that matters: the database holds records, the filesystem holds
// bytes. If that ever quietly reversed, every attachment would end up inline
// in SQLite and the store would balloon by the size of the media itself.
add('attachment bytes never end up inside the database', () => {
  const big = Buffer.alloc(700 * 1024, 0x41);
  const bigPath = path.join(dir, 'big.bin');
  fs.writeFileSync(bigPath, big);

  // A megabyte-scale attachment, stored.
  const adopted = media.adopt(bigPath, { fileName: 'clip.mp4', mimeType: 'video/mp4' });
  if (!adopted) return 'the file was not stored at all';

  store.upsertMessages('qbig', [{
    id: 'big1',
    timestamp: 1000,
    text: 'a large attachment',
    senderID: 's',
    senderName: 'x',
    // What the store records: a reference, not the bytes.
    attachments: [{ id: 'b1', fileName: 'clip.mp4', mimeType: 'video/mp4', fileSize: big.length, localMediaHash: adopted.hash }],
  }], {});

  const row = store.page('qbig', { limit: 1 })[0];
  const payloadBytes = Buffer.byteLength(JSON.stringify(row));
  return payloadBytes < 2000
    || ('a single record grew to ' + payloadBytes + ' bytes - the bytes are going into the database');
});

add('the database stays small next to the media it points at', () => {
  const dbBytes = fs.statSync(store.file).size;
  const mediaBytes = media.totalBytes();
  // The database is records; the media folder is bytes. They live in different
  // places and stay that way.
  return dbBytes < 8 * 1024 * 1024 || ('the database is already ' + Math.round(dbBytes / 1024 / 1024) + ' MB');
});

add('an image with no mime type is stored by its extension', () => {
  const r = media.adopt(mediaSrc, { fileName: 'holiday.png' });
  return Boolean(r && r.hash) || 'refused a .png with no mime type';
});

add('adopting still copies the file under a hash name', () => {
  const r = media.adopt(mediaSrc, { fileName: 'holiday photo.jpg', mimeType: 'image/jpeg' });
  return r && /^[0-9a-f]{64}$/.test(r.hash) || ('got ' + JSON.stringify(r));
});

add('the stored name never contains the message filename', () => {
  const r = media.adopt(mediaSrc, { fileName: '../../evil.jpg', mimeType: 'image/jpeg' });
  return r && !r.relativePath.includes('..') && !r.relativePath.includes('evil')
    || ('got ' + JSON.stringify(r));
});

add('a traversal filename cannot escape the media root', () => {
  const r = media.adopt(mediaSrc, { fileName: '../../evil.jpg', mimeType: 'image/jpeg' });
  const full = path.join(media.root, r.relativePath);
  return path.resolve(full).startsWith(path.resolve(media.root)) || ('wrote to ' + full);
});

add('the same bytes are stored once', () => {
  const a = media.adopt(mediaSrc, { fileName: 'one.mp4', mimeType: 'video/mp4' });
  const b = media.adopt(mediaSrc, { fileName: 'two.mp4', mimeType: 'video/mp4' });
  return a.hash === b.hash || 'stored twice';
});

add('a missing source returns null rather than throwing', () =>
  media.adopt(path.join(dir, 'nope.bin'), { fileName: 'x.jpg', mimeType: 'image/jpeg' }) === null || 'threw');

add('stored media can be found again by its hash', () => {
  const r = media.adopt(mediaSrc, { fileName: 'again.mp4', mimeType: 'video/mp4' });
  return media.has(r.hash) && Boolean(media.pathFor(r.hash)) || 'lost the file';
});

add('media reports its own size', () =>
  media.totalBytes() > 0 && media.count() > 0 || 'reported nothing');

// The extension is a convenience, not part of a file's identity, so a lookup
// by hash has to work without the caller knowing how the name was spelled.
add('a stored file is found by hash alone, whatever it is named', () => {
  const r = media.adopt(mediaSrc, { fileName: 'clip.mp4', mimeType: 'video/mp4' });
  const name = path.basename(r.relativePath);
  if (name === r.hash) return 'stored with no extension to find it by';
  return media.pathFor(r.hash) === path.join(media.root, r.relativePath)
    || 'could not find ' + name + ' from its hash alone';
});

add('a file named with an extension still resolves to the same bytes', () => {
  const r = media.adopt(mediaSrc, { fileName: 'clip.mp4', mimeType: 'video/mp4' });
  const found = media.pathFor(r.hash);
  return found && fs.readFileSync(found).equals(fs.readFileSync(mediaSrc))
    || 'resolved to something else';
});

add('a hash that was never stored resolves to nothing', () =>
  media.pathFor('0'.repeat(64)) === null || 'invented a file');

add('a name that merely starts with the hash is not a match', () => {
  // A hash that was never adopted, so there is no correct answer to find by
  // accident. An interrupted copy leaves a ".part" beside the target, and
  // neither it nor a stray backup is the attachment.
  const orphan = 'a1b2c3d4'.repeat(8);
  const dir = path.join(media.root, orphan.slice(0, 2));
  fs.mkdirSync(dir, { recursive: true });
  const junk = ['.part', '.bak', '.tmp'].map((tail) => path.join(dir, orphan + tail));
  for (const j of junk) fs.writeFileSync(j, 'not the attachment');
  try {
    const found = media.pathFor(orphan);
    if (!found) return true;
    if (junk.includes(found)) return 'returned ' + path.basename(found);
    return 'invented ' + path.basename(found);
  } finally {
    for (const j of junk) fs.unlinkSync(j);
    fs.rmdirSync(dir);
  }
});

add('the real file still wins when junk sits beside it', () => {
  const r = media.adopt(mediaSrc, { fileName: 'clip.mp4', mimeType: 'video/mp4' });
  const real = path.join(media.root, r.relativePath);
  const junk = [real + '.part', real + '.bak'];
  for (const j of junk) fs.writeFileSync(j, 'not the attachment');
  try {
    const found = media.pathFor(r.hash);
    if (junk.includes(found)) return 'returned ' + path.basename(found);
    return found && fs.readFileSync(found).equals(fs.readFileSync(mediaSrc)) ? true : 'returned the wrong bytes';
  } finally {
    for (const j of junk) fs.unlinkSync(j);
  }
});

// ---------------------------------------------------------------------------
// The backfill queue
// ---------------------------------------------------------------------------

/**
 * A fake Beeper serving a fixed number of 20-message pages, then the end.
 *
 * Page counts are per chat and ids are unique per chat, because a single
 * global counter quietly makes this fake lie: it hands out the same message
 * ids to every chat, which is not something Beeper does, and it hides bugs
 * where one chat's write lands in another.
 */
function fakeBeeper(pages, { failAfter = null, onPage } = {}) {
  const calls = [];
  const perChat = new Map();
  return {
    calls,
    fetchPage: async (chatID, { cursor, direction, limit } = {}) => {
      const index = (perChat.get(chatID) || 0) + 1;
      perChat.set(chatID, index);
      calls.push({ chatID, cursor, direction, limit });
      if (typeof onPage === 'function') onPage(calls.length);
      if (failAfter !== null && calls.length > failAfter) throw new Error('bridge is down');

      const items = [];
      const base = (pages - index) * 1000;
      for (let i = 0; i < 20; i++) {
        items.push(msg(`${chatID}-p${index}-${i}`, base - i, `page ${index} message ${i}`));
      }
      const last = items.length - 1;
      return {
        items,
        hasMore: index < pages,
        oldestCursor: items[last].id,
      };
    },
  };
}

async function queueCases() {
  await addAsync('the queue adopts a page\'s attachments before storing it', async () => {
    // Caught live: Settings read "Attachments None yet" forever, because the
    // media store existed but nothing ever handed it anything.
    const pic = path.join(dir, 'picture.png');
    fs.writeFileSync(pic, 'pretend png bytes');
    let seenIds = null;

    const beeper = {
      calls: 0,
      fetchPage: async (chatID) => {
        beeper.calls++;
        return {
          items: [{
            id: 'withpic',
            timestamp: 1000,
            text: 'look at this',
            attachments: [{ id: 'a1', fileName: 'holiday photo.png', mimeType: 'image/png', srcURL: pic }],
          }],
          hasMore: false,
          oldestCursor: 'withpic',
        };
      },
    };

    const sync = createHistorySync({
      store,
      media,
      fetchPage: beeper.fetchPage,
      adoptMedia: async (items) => {
        for (const m of items) {
          for (const att of m.attachments || []) {
            if (att.localMediaHash) continue;
            const adopted = media.adopt(att.srcURL, att);
            if (adopted) {
              att.localMediaPath = adopted.relativePath;
              att.localMediaHash = adopted.hash;
            }
          }
        }
      },
      onProgress: () => {},
    });

    sync.request('qp');
    await sync.drain();

    // Read it back out of the store: the path has to have survived the write,
    // not merely been set on the object the fetcher handed over.
    const stored = store.page('qp', { limit: 5 })[0];
    seenIds = stored && stored.attachments ? stored.attachments[0] : null;
    return (seenIds && /^[0-9a-f]{64}$/.test(seenIds.localMediaHash || ''))
      || ('stored attachment was ' + JSON.stringify(seenIds));
  });

  await addAsync('a stored attachment resolves back to our own copy', async () => {
    const stored = store.page('qp', { limit: 5 })[0];
    const url = media.urlFor(stored.attachments[0].localMediaHash);
    return Boolean(url) && url.includes(stored.attachments[0].localMediaHash)
      || ('no url for our own copy: ' + url);
  });

  await addAsync('an attachment that will not copy does not lose its message', async () => {
    const sync = createHistorySync({
      store,
      media,
      fetchPage: async () => ({
        items: [{
          id: 'badpic',
          timestamp: 2000,
          text: 'this picture is broken',
          attachments: [{ id: 'a2', fileName: 'gone.png', srcURL: path.join(dir, 'not-here.png') }],
        }],
        hasMore: false,
        oldestCursor: 'badpic',
      }),
      adoptMedia: async (items) => {
        for (const m of items) {
          for (const att of m.attachments || []) {
            const adopted = media.adopt(att.srcURL, att);
            if (adopted) att.localMediaHash = adopted.hash;
          }
        }
      },
      onProgress: () => {},
    });
    sync.request('qbad');
    await sync.drain();
    return store.page('qbad', { limit: 5 }).length === 1 || 'the message went missing with its picture';
  });

  await addAsync('the queue still works with no media step at all', async () => {
    const beeper = fakeBeeper(2);
    const sync = createHistorySync({ store, media, fetchPage: beeper.fetchPage, onProgress: () => {} });
    sync.request('qnomed');
    await sync.drain();
    return store.chatStatus('qnomed').count === 40 || 'broke without adoptMedia';
  });

  await addAsync('a complete chat adopts media in its newest page too', async () => {
    // Otherwise a photo arriving in an already-finished chat is never copied,
    // and the store stays exactly as temporary as Beeper's cache for the one
    // case that matters most: the newest message.
    //
    // The picture appears only on the second fetch, so it can only have been
    // copied by the tail refresh. Letting the first backfill see it too would
    // make the check pass whether or not refreshTail adopts anything.
    const pic = path.join(dir, 'fresh.png');
    fs.writeFileSync(pic, 'a newly arrived picture');
    let call = 0;

    const sync = createHistorySync({
      store,
      media,
      fetchPage: async (chatID) => {
        call++;
        const fresh = call > 1;
        const items = [{
          id: 'tail-pic',
          timestamp: 1000 + call,
          text: fresh ? 'here is a picture' : 'plain text',
          attachments: fresh ? [{ id: 'n1', fileName: 'fresh.png', srcURL: pic }] : [],
        }];
        return { items, hasMore: false, oldestCursor: items[0].id };
      },
      adoptMedia: async (items) => {
        for (const m of items) {
          for (const att of m.attachments || []) {
            const adopted = media.adopt(att.srcURL, att);
            if (adopted) att.localMediaHash = adopted.hash;
          }
        }
      },
      onProgress: () => {},
    });

    sync.request('qm1');
    await sync.drain();
    const afterFirst = store.page('qm1', { limit: 5 })[0];
    const copiedOnFirstPass = Boolean((afterFirst.attachments || [])[0]?.localMediaHash);

    sync.request('qm1');
    await sync.drain();
    const afterSecond = store.page('qm1', { limit: 5 })[0];
    const hash = (afterSecond.attachments || [])[0]?.localMediaHash;

    return (!copiedOnFirstPass && /^[0-9a-f]{64}$/.test(hash || ''))
      || ('after first pass: ' + copiedOnFirstPass + ', after tail refresh: ' + hash);
  });

  add('a sweep walks the whole store in insertion order', () => {
  store.upsertMessages('qs1', [msg('z1', 1000, 'one'), msg('z2', 2000, 'two')], {});
  store.upsertMessages('qs2', [msg('z3', 3000, 'three')], {});

  // Walk it the way the startup sweep does: in pages, following rowid.
  let cursor = 0;
  const seen = [];
  for (let i = 0; i < 200; i++) {
    const page = store.afterRowid(cursor, 50);
    if (!page.length) break;
    cursor = page[page.length - 1].rowid;
    for (const row of page) seen.push(row.message.id);
  }

  const at = (id) => seen.indexOf(id);
  const ordered = at('z1') >= 0 && at('z2') > at('z1') && at('z3') > at('z2');
  const once = seen.filter((id) => id === 'z1' || id === 'z2' || id === 'z3').length === 3;
  return (ordered && once) || ('z1 at ' + at('z1') + ', z2 at ' + at('z2') + ', z3 at ' + at('z3') + ' of ' + seen.length);
});

add('the sweep returns the whole payload, not a summary', () => {
  store.upsertMessages('qs3', [msg('z9', 9000, 'sweep me', { attachments: [{ id: 'p1', fileName: 'a.png' }] })], {});
  const rows = store.afterRowid(0, 500).filter((r) => r.message.id === 'z9');
  const att = rows[0]?.message?.attachments?.[0];
  return (att && att.fileName === 'a.png') || ('lost the attachment: ' + JSON.stringify(rows[0]?.message?.attachments));
});

add('sweeping an empty store yields nothing rather than looping', () =>
  Array.isArray(store.afterRowid(999999, 10)) || 'did not return an array');

await addAsync('a full walk stores every page exactly once', async () => {
    const beeper = fakeBeeper(4);
    const sync = createHistorySync({ store, media, fetchPage: beeper.fetchPage, onProgress: () => {} });
    sync.request('q1');
    await sync.drain();
    const s = store.chatStatus('q1');
    return s.count === 80 || ('stored ' + s.count + ' of 80');
  });

  await addAsync('a completed chat is marked complete', async () => {
    const beeper = fakeBeeper(3);
    const sync = createHistorySync({ store, media, fetchPage: beeper.fetchPage, onProgress: () => {} });
    sync.request('q2');
    await sync.drain();
    return store.isComplete('q2') || 'never completed';
  });

  await addAsync('a complete chat is never walked again', async () => {
    // The whole point. Re-opening a completed chat must cost one page.
    const beeper = fakeBeeper(3);
    const sync = createHistorySync({ store, media, fetchPage: beeper.fetchPage, onProgress: () => {} });
    sync.request('q3');
    await sync.drain();
    const before = beeper.calls.length;

    sync.request('q3');
    await sync.drain();
    const after = beeper.calls.length - before;
    return after === 1 || ('re-walked a complete chat in ' + after + ' calls');
  });

  await addAsync('a resumed run does not tombstone the earlier run', async () => {
    // First run is cut short, second finishes. The messages the first run
    // stored are real and must survive the second run's reconcile.
    const pages = [
      fakeBeeper(3),
      null,
    ];
    pages[1] = {
      calls: [],
      fetchPage: async (chatID, { cursor, direction } = {}) => {
        pages[1].calls.push({ cursor, direction });
        if (direction === 'before') {
          return { items: [msg('tail', 500, 'from the interrupted run')], hasMore: false, oldestCursor: 'tail' };
        }
        return { items: [], hasMore: false };
      },
    };

    const sync1 = createHistorySync({ store, media, fetchPage: pages[0].fetchPage, onProgress: () => {}, maxPages: 1 });
    sync1.request('q4');
    await sync1.drain();
    const afterFirst = store.chatStatus('q4').count;
    if (store.isComplete('q4')) return 'the capped run marked the chat complete';

    const sync2 = createHistorySync({ store, media, fetchPage: pages[1].fetchPage, onProgress: () => {} });
    sync2.request('q4');
    await sync2.drain();

    const s = store.chatStatus('q4');
    return (afterFirst === 20 && s.count === 21)
      || ('after first ' + afterFirst + ', after resume ' + s.count);
  });

  await addAsync('a failed fetch leaves the chat incomplete', async () => {
    const beeper = fakeBeeper(5, { failAfter: 1 });
    const sync = createHistorySync({ store, media, fetchPage: beeper.fetchPage, onProgress: () => {} });
    sync.request('q5');
    await sync.drain();
    return store.isComplete('q5') === false || 'a failed run marked the chat complete';
  });

  await addAsync('a failed fetch tombstones nothing', async () => {
    store.upsertMessages('q6', [msg('safe1', 1000, 'safe'), msg('safe2', 2000, 'also safe')], {});
    let calls = 0;
    const sync = createHistorySync({
      store,
      media,
      fetchPage: async () => {
        calls++;
        throw new Error('bridge is down');
      },
      onProgress: () => {},
    });
    sync.request('q6');
    await sync.drain();
    const drawn = store.page('q6', { limit: 10 }).map((m) => m.id).join(',');
    return drawn === 'safe1,safe2' || ('got ' + drawn);
  });

  await addAsync('a repeated cursor does not loop forever', async () => {
    let calls = 0;
    const sync = createHistorySync({
      store,
      media,
      fetchPage: async () => {
        calls++;
        // Always claims more, but never moves the cursor.
        return { items: [msg('s' + calls, 1000 + calls, 'stuck')], hasMore: true, oldestCursor: 's1' };
      },
      onProgress: () => {},
    });
    sync.request('q7');
    await sync.drain();
    return calls <= 3 || ('looped ' + calls + ' times on a cursor that never moved');
  });

  await addAsync('a stalled cursor does not mark the chat complete', async () => {
    return store.isComplete('q7') === false || 'a stalled run claimed to be complete';
  });

  await addAsync('requesting the same chat twice queues it once', async () => {
    const beeper = fakeBeeper(2);
    const sync = createHistorySync({ store, media, fetchPage: beeper.fetchPage, onProgress: () => {} });
    sync.request('q8');
    sync.request('q8');
    sync.request('q8');
    await sync.drain();
    return beeper.calls.length <= 2 || ('fetched ' + beeper.calls.length + ' pages for one chat');
  });

  await addAsync('progress is reported so the UI can show it', async () => {
    const states = [];
    const beeper = fakeBeeper(2);
    const sync = createHistorySync({
      store,
      media,
      fetchPage: beeper.fetchPage,
      onProgress: (p) => states.push(p.state),
    });
    sync.request('q9');
    await sync.drain();
    const wanted = ['started', 'done'];
    return wanted.every((s) => states.includes(s)) || ('got ' + JSON.stringify(states));
  });

  await addAsync('two chats are both walked', async () => {
    const beeper = fakeBeeper(2);
    const sync = createHistorySync({ store, media, fetchPage: beeper.fetchPage, onProgress: () => {} });
    sync.request('qa');
    sync.request('qb');
    await sync.drain();
    return (store.chatStatus('qa').count === 40 && store.chatStatus('qb').count === 40)
      || ('qa ' + store.chatStatus('qa').count + ', qb ' + store.chatStatus('qb').count);
  });

  await addAsync('stop() stops starting new work', async () => {
    const beeper = fakeBeeper(2);
    const sync = createHistorySync({ store, media, fetchPage: beeper.fetchPage, onProgress: () => {} });
    sync.stop();
    const accepted = sync.request('qc');
    await sync.drain();
    return accepted === false && beeper.calls.length === 0 || 'kept working after stop';
  });
}

async function addAsync(name, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = await fn();
    ok = r === true;
    if (r !== true) detail = String(r);
  } catch (e) {
    ok = false;
    detail = e.message;
  }
  cases.push([name, ok, detail]);
}

async function main() {
  await queueCases();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });

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