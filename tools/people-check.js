/**
 * Dev check: the people in a chat show their phone number beside their name.
 *
 * The number is not in the chat record. Beeper's bridge sends a participant
 * as an id, a name, a picture and a few flags, and its schema says the phone
 * number is omitted when it is unknown - which, measured on the live account
 * on 2026-11-23, is every participant in every chat: not one of the 492
 * across 200 chats carried one.
 *
 * So the number is read separately, from Beeper Desktop's own store, keyed by
 * the very id the bridge hands out, and it arrives at the list late. The
 * people list therefore has to open before the numbers are there and fill
 * them in afterwards, and it has to put them beside the name rather than
 * anywhere else.
 *
 * This is the real list, opened by the real code, in a real window. The only
 * thing replaced is the IPC boundary, because the thing under test is what
 * the list does with a number once it has one.
 *
 * Run with `npm run check:people`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const harnessGuard = require('./harness-guard');

const ROOT = path.join(__dirname, '..');
const url = (...p) => pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', ...p)).href;
const modalsURL = url('modals.js');

/** The people in the chat, as the bridge sends them. */
const JIM = '@g1dvtdhUgwiwN6W9x_gy2xUPmBQGVal745KScIT-FG2hxIbW0AP7qZC6x-JYVngnQy4ddEQgaK1T40qI8kapLw:local-signal.localhost';
const KEVIN = '@named:beeper.com';
const NUMBER = '@number:beeper.com';

const CHAT = {
  id: '!people-check',
  title: 'A group chat',
  participants: {
    total: 3,
    items: [
      { id: JIM, fullName: 'Jim Kraai', cannotMessage: false, isSelf: false, isAdmin: false, isPending: false, isNetworkBot: false },
      { id: KEVIN, fullName: 'Kevin Nabity', cannotMessage: false, isSelf: false, isAdmin: false, isPending: false, isNetworkBot: false },
      // A person whose name is their own number. Printing the number beside
      // the number is noise, and it is the normal case for a phone network.
      { id: NUMBER, fullName: '+15154932243', cannotMessage: false, isSelf: false, isAdmin: false, isPending: false, isNetworkBot: false },
    ],
  },
};

/** The numbers, as they come back from the store. */
const NUMBERS = {
  [JIM]: '+15159887152',
  [KEVIN]: '+15158659563',
  [NUMBER]: '+15154932243',
};

async function main() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(os.tmpdir(), 'bb-people-check-profile'));

  // Expire on our own rather than being killed from outside, which would pop
  // an Electron error dialog that looks like the app under test crashing.
  harnessGuard(app, { label: 'check:people' });

  await app.whenReady();

  const win = new BrowserWindow({ show: false, width: 520, height: 640 });
  await win.loadFile(path.join(__dirname, 'people-harness.html'));

  const harness = `
    (async () => {
      // The harness page has no preload, so window.beeper does not exist. This
      // is the boundary: everything above it is the app's own code.
      const asked = [];
      window.beeper = new Proxy({}, {
        get: (_t, ns) => new Proxy({}, {
          get: (_t2, fn) => (...args) => {
            if (ns === 'participants' && fn === 'numbers') {
              asked.push(args[0]);
              return Promise.resolve({ ok: true, data: ${JSON.stringify(NUMBERS)} });
            }
            return Promise.resolve({ ok: true, data: {} });
          },
        }),
      });

      const M = await import(${JSON.stringify(modalsURL)});
      const cases = [];
      // Strict on purpose. These assertions are written as
      // "condition || reason it failed", and a helper that coerced with !!
      // would read that reason as a pass, so every one of them would be green
      // forever no matter what the list did.
      const add = (name, ok, detail) => {
        const passed = ok === true;
        cases.push([name, passed, passed ? '' : (detail ?? String(ok))]);
      };
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));

      const chat = ${JSON.stringify(CHAT)};

      // ---- the list, with the numbers -------------------------------------
      M.openParticipants(chat);
      await wait(400);

      const rows = () => Array.from(document.querySelectorAll('#modal-root .result-item'));
      const lineOf = (row) => row.querySelector('.result-item-line');
      const nameOf = (row) => row.querySelector('.result-item-name');
      const phoneOf = (row) => row.querySelector('.result-item-phone');
      const subOf = (row) => row.querySelector('.result-item-sub');
      // The rows are found by name, not by position: the list is sorted by
      // name, and a number sorts before a letter, so the order is not the
      // order the people were written down in.
      const rowFor = (name) => rows().find((row) => nameOf(row) && nameOf(row).textContent === name);

      add('the list opened', rows().length === 3 || 'the list has ' + rows().length + ' rows');
      add('the names are shown', Array.from(document.querySelectorAll('.result-item-name')).map((n) => n.textContent).sort().join(',') === '+15154932243,Jim Kraai,Kevin Nabity',
        Array.from(document.querySelectorAll('.result-item-name')).map((n) => n.textContent).join(','));

      const jim = rowFor('Jim Kraai');
      add('a number is shown beside the name', phoneOf(jim) && phoneOf(jim).textContent === '+15159887152',
        'the row says ' + (phoneOf(jim) ? phoneOf(jim).textContent : 'nothing'));
      add('the number is on the same line as the name',
        phoneOf(jim) && lineOf(jim) && lineOf(jim).contains(phoneOf(jim)) && lineOf(jim).contains(nameOf(jim)),
        'the number has to be beside the name, not under it');
      add('the number is not repeated under the name', !subOf(jim) || !subOf(jim).textContent,
        'the line under the name says ' + (subOf(jim) ? subOf(jim).textContent : ''));

      // And it has to LOOK like it is beside the name, not just be in the
      // same element. A line that is not laid out as a row puts the number on
      // a line of its own, and the markup would still say the two are
      // together. So the two boxes are measured.
      const nameBox = nameOf(jim).getBoundingClientRect();
      const phoneBox = phoneOf(jim).getBoundingClientRect();
      const beside = phoneBox.left >= nameBox.left && phoneBox.top < nameBox.bottom && phoneBox.bottom > nameBox.top;
      add('and the number is really drawn beside the name', beside,
        'the name is at ' + Math.round(nameBox.left) + ',' + Math.round(nameBox.top) +
        ' and the number at ' + Math.round(phoneBox.left) + ',' + Math.round(phoneBox.top));

      const kevin = rowFor('Kevin Nabity');
      add('a second person gets their number too', phoneOf(kevin) && phoneOf(kevin).textContent === '+15158659563',
        'the row says ' + (phoneOf(kevin) ? phoneOf(kevin).textContent : 'nothing'));

      const numberNamed = rowFor('+15154932243');
      add('a person whose name is their number is not given it twice',
        numberNamed && (!phoneOf(numberNamed) || !phoneOf(numberNamed).textContent),
        'the row says ' + (numberNamed && phoneOf(numberNamed) ? phoneOf(numberNamed).textContent : 'nothing'));
      add('the numbers were asked for by id', asked.length === 1 && asked[0].length === 3,
        JSON.stringify(asked));

      // ---- the same list, without the numbers ----------------------------
      document.querySelector('#modal-root').innerHTML = '';
      window.beeper = new Proxy({}, {
        get: (_t, ns) => new Proxy({}, {
          get: (_t2, fn) => (...args) => {
            if (ns === 'participants' && fn === 'numbers') return Promise.resolve({ ok: true, data: {} });
            return Promise.resolve({ ok: true, data: {} });
          },
        }),
      });
      M.openParticipants(chat);
      await wait(400);
      const bare = Array.from(document.querySelectorAll('#modal-root .result-item-phone'))
        .map((n) => n.textContent)
        .join(',');
      add('CONTROL: with no numbers there are no numbers', bare === ',,' || 'the rows say ' + bare);
      add('and the names are still there', document.querySelectorAll('.result-item-name').length === 3);

      return JSON.stringify(cases);
    })()
  `;

  const raw = await win.webContents.executeJavaScript(harness, true);
  const cases = JSON.parse(raw);

  let failed = 0;
  for (const [name, ok, detail] of cases) {
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);

  // The windows are NOT destroyed here: see tools/gif-player-check.js for why
  // tearing down a busy renderer takes the results with it.
  app.exit(0);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('failed:', err && (err.stack || err.message));
  process.exit(1);
});
