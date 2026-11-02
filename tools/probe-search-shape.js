/**
 * Dev probe: what Beeper's own message search actually returns, and whether
 * it can be narrowed to one chat.
 *
 * Why this exists: the in-conversation search merges two sources - the local
 * store and Beeper's server-side search - and the server side had never been
 * asked the two questions the merge depends on:
 *
 *   1. Does /v1/messages/search honour chatIDs? The client already sends the
 *      parameter, but nothing in the app had ever passed one, so "it accepts
 *      the parameter" and "it filters by it" are very different claims.
 *   2. Can a single message be fetched by id, so a hit the local store has
 *      never seen can be turned into a real bubble in the thread?
 *
 * It is read-only: GET requests only, no writes, no window, no database
 * touched. It talks to the Note to self chat only, because that is the one
 * chat the rules allow live checks against.
 *
 * The token is read without TokenStore, on purpose. TokenStore.read() deletes
 * an auth.json it cannot decrypt, and this probe must never be the reason the
 * app signs itself out. If the ciphertext will not decrypt, this prints why
 * and stops, leaving the file alone.
 *
 * Run with: npx electron tools/probe-search-shape.js
 */
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// The real app profile. Electron would otherwise use the profile of whatever
// name the script runs under, and safeStorage binds its ciphertext to that
// name - so the token would not decrypt, and the probe would look like a
// broken integration rather than a wrong path.
const USER_DATA = 'C:\\Users\\Scott\\AppData\\Roaming\\Better Beeper';

app.setPath('userData', USER_DATA);

function readToken() {
  const file = path.join(USER_DATA, 'auth.json');
  const packed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const data = packed.encrypted
    ? (() => {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('this OS keychain is unavailable, so the token cannot be read');
        }
        const json = safeStorage.decryptString(Buffer.from(packed.data, 'base64'));
        return JSON.parse(json);
      })()
    : packed.data;

  // The store holds the whole token record; the API wants the bearer string.
  const token = typeof data === 'string' ? data : data?.accessToken;
  if (!token) throw new Error('auth.json held no access token');
  // Shape only. The token itself is never printed.
  console.log('token record  :', typeof data === 'string' ? 'a bare string' : Object.keys(data).join(', '));
  console.log('token length  :', String(token).length);
  return String(token);
}

async function get(base, token, pathPart, query) {
  const url = new URL(pathPart, base);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(`GET ${url.pathname} -> ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/** The keys of an object, so a shape can be reported without its contents. */
function keysOf(value) {
  return value && typeof value === 'object' ? Object.keys(value).sort() : [];
}

/**
 * A word that is actually in the chat, so the search has something to find.
 *
 * The text in this chat can be pasted markup, so the words are taken from
 * plain alphabetic runs only, and the most common one is used: a word that
 * occurs often is far more likely to be findable than the longest one, which
 * is often a run-together string from a pasted document.
 */
function pickTerms(messages) {
  const counts = new Map();
  for (const message of messages || []) {
    for (const word of String(message.text || '').match(/[A-Za-z]{4,}/g) || []) {
      const lower = word.toLowerCase();
      counts.set(lower, (counts.get(lower) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([word]) => word);
}

async function main() {
  const token = readToken();
  const info = await get('http://localhost:23373', null, '/v1/info');
  const base = info?.baseURL || info?.baseUrl || 'http://localhost:23373';

  const chats = await get(base, token, '/v1/chats', { limit: 200 });
  const list = chats?.items || chats?.chats || [];
  const note = list.find((chat) => /note to self/i.test(String(chat?.title || '')));
  if (!note) {
    console.log('no Note to self chat found among', list.length, 'chats');
    console.log('titles:', list.map((c) => c?.title).join(' | '));
    return;
  }
  console.log('base url      :', base);
  console.log('chat found    :', note.title, '(' + note.id + ')');

  // A couple of real messages, to pick a word from and to have an id to fetch.
  const page = await get(base, token, `/v1/chats/${encodeURIComponent(note.id)}/messages`, {
    limit: 50,
  });
  const messages = page?.items || page?.messages || [];
  const withText = messages.filter((m) => typeof m.text === 'string' && m.text.length);
  console.log('messages seen :', messages.length, '| with text:', withText.length);
  console.log('message keys  :', keysOf(messages[0]).join(', '));
  console.log('text keys     :', keysOf(withText[0]).join(', '));

  const terms = pickTerms(messages);
  console.log('search terms  :', terms.join(', ') || '(none found)');
  if (!terms.length) return;

  const term = terms[0];

  // 1. Does chatIDs narrow the search?
  const all = await get(base, token, '/v1/messages/search', { query: term, limit: 20 });
  const scoped = await get(base, token, '/v1/messages/search', {
    query: term,
    chatIDs: note.id,
    limit: 20,
  });
  const allItems = all?.items || [];
  const scopedItems = scoped?.items || [];
  console.log('');
  console.log('search without chatIDs :', allItems.length, 'items; keys:', keysOf(allItems[0]).join(', '));
  console.log('search with chatIDs    :', scopedItems.length, 'items');
  const foreign = scopedItems.filter((item) => item.chatID && item.chatID !== note.id);
  console.log('items from another chat :', foreign.length);
  console.log('items carrying chatID  :', scopedItems.filter((i) => i.chatID).length, 'of', scopedItems.length);
  console.log('has text on a hit       :', scopedItems.some((i) => typeof i.text === 'string' && i.text.length));
  console.log('timestamp field present :', keysOf(scopedItems[0]).filter((k) => /time|date|ts/i.test(k)).join(', ') || 'none');
  console.log('hit ids are in the chat :', scopedItems.filter((i) => messages.some((m) => m.id === i.id)).length, 'of', scopedItems.length);

  // A second term, to be sure one word was not a fluke.
  if (terms[1]) {
    const second = await get(base, token, '/v1/messages/search', {
      query: terms[1],
      chatIDs: note.id,
      limit: 20,
    });
    console.log('second term             :', terms[1], '->', (second?.items || []).length, 'items');
  }

  // 3. Word or substring? The local store will match substrings, and a merge
  // that counted a server hit the local search would not have found would
  // make the counter disagree with what is highlighted.
  const word = terms[0];
  const partial = word.slice(0, Math.max(3, word.length - 2));
  const partialRes = await get(base, token, '/v1/messages/search', {
    query: partial,
    chatIDs: note.id,
    limit: 20,
  });
  const fullRes = await get(base, token, '/v1/messages/search', {
    query: word,
    chatIDs: note.id,
    limit: 20,
  });
  console.log('');
  console.log('full word               :', word, '->', (fullRes?.items || []).length, 'items');
  console.log('partial word            :', partial, '->', (partialRes?.items || []).length, 'items');
  console.log('server matches substring:', (partialRes?.items || []).length > 0);

  // 4. Does a multi-word query behave like a phrase?
  if (terms[1]) {
    const phrase = `${terms[0]} ${terms[1]}`;
    const phraseRes = await get(base, token, '/v1/messages/search', {
      query: phrase,
      chatIDs: note.id,
      limit: 20,
    });
    console.log('two words               :', phrase, '->', (phraseRes?.items || []).length, 'items');
  }

  // 2. Can one message be fetched by id, to become a real bubble?
  const hit = scopedItems.find((item) => item.id) || messages[0];
  if (!hit?.id) {
    console.log('no id to fetch');
    return;
  }
  try {
    const one = await get(base, token, `/v1/chats/${encodeURIComponent(note.id)}/messages/${encodeURIComponent(hit.id)}`);
    console.log('');
    console.log('single message fetch : ok');
    console.log('fetched keys         :', keysOf(one).join(', '));
    console.log('fetched has text     :', typeof one?.text === 'string' && one.text.length > 0);
  } catch (err) {
    console.log('');
    console.log('single message fetch : FAILED', err.status || '', String(err.body || err.message).slice(0, 200));
  }
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (err) {
    console.log('probe failed:', err.message);
    if (err.body) console.log('body:', String(err.body).slice(0, 400));
  }
  app.quit();
});
