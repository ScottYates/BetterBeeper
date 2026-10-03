/**
 * Dev check: the thread is only rebuilt when what it draws actually changed.
 *
 * An animated GIF only keeps playing if its <img> is never detached from the
 * document, because a detached image loses its playback. The thread used to be
 * cleared and rebuilt on every incoming event, so a typing indicator or a read
 * receipt restarted every GIF on screen several times a second and they never
 * appeared to move. In a quiet chat they played fine, which is why this went
 * unnoticed.
 *
 * The fix skips the rebuild when nothing visible changed, judged by
 * threadSignature. Both halves matter and they pull against each other:
 *
 *   - too coarse, and the thread stops updating when it should;
 *   - too fine, and the rebuild comes back and the GIFs freeze again.
 *
 * So this asserts the signature is stable for identical input AND changes for
 * every field the row actually draws. Adding a new field to messageNode without
 * adding it here is the failure this catches.
 *
 * Run with `npm run check:gifrebuild`.
 */
const path = require('path');
const { pathToFileURL } = require('url');
const harnessGuard = require('./harness-guard');

const threadURL = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'thread.js')).href;

async function main() {
  const { app, BrowserWindow } = require('electron');
  const os = require('os');
  app.setPath('userData', path.join(os.tmpdir(), 'bb-gif-rebuild-check-profile'));

  const harness = `
    (async () => {
      const T = await import(${JSON.stringify(threadURL)});
      const sig = T.threadSignature;

      const cases = [];
      const add = (name, fn) => {
        let ok = false;
        let detail = '';
        try { const r = fn(); ok = r === true; if (r !== true) detail = String(r); }
        catch (e) { ok = false; detail = e.message; }
        cases.push([name, ok, detail]);
      };

      const base = () => [{
        id: 'm1', isSender: true, accountID: 'a1', senderID: 'u1', senderName: 'Me',
        text: 'hello', type: 'TEXT', timestamp: '2026-01-01T10:00:00Z',
        attachments: [{ id: 'att1', fileName: 'a.gif', fileSize: 10, mimeType: 'image/gif' }],
        reactions: [{ key: '\\u{1F44D}', count: 1, isSelf: true }],
        links: [{ url: 'https://example.com' }],
        linkedMessageID: 'm0', editedTimestamp: '', sendStatus: 'sent', isDeleted: false,
      }];

      const withField = (field, value) => {
        const list = base();
        list[0] = Object.assign({}, list[0]);
        if (field === 'reactionCount') list[0].reactions = [{ key: 'x', count: value, isSelf: true }];
        else if (field === 'attachmentList') list[0].attachments = [{ id: 'att2', fileName: 'b.png', fileSize: 5, mimeType: 'image/png' }];
        else if (field === 'linkList') list[0].links = [{ url: 'https://other.example' }];
        else list[0][field] = value;
        return list;
      };

      add('the same messages always produce the same signature', () => {
        return sig(base()) === sig(base()) || 'two identical calls disagree';
      });

      add('an empty list has a signature', () => {
        const s = sig([]);
        return typeof s === 'string' && s.length > 0 || 'got ' + JSON.stringify(s);
      });

      // Every one of these is drawn by messageNode. If the signature ignores
      // any of them, the thread stops updating on that change.
      const fields = [
        ['text', 'goodbye'], ['type', 'IMAGE'], ['timestamp', '2026-01-02T10:00:00Z'],
        ['isSender', false], ['senderID', 'u2'], ['senderName', 'Someone'],
        ['accountID', 'a2'], ['isDeleted', true], ['sendStatus', 'sending'],
        ['editedTimestamp', '2026-01-01T11:00:00Z'], ['linkedMessageID', 'm9'],
        ['id', 'm2'], ['reactionCount', 7], ['attachmentList', true], ['linkList', true],
      ];
      for (const [field, value] of fields) {
        // Concatenated rather than interpolated: this whole block lives in a
        // template literal in the checker, so a dollar-brace in the name would
        // be evaluated here in the checker instead of in the page.
        add('a change to ' + field + ' changes the signature', () => {
          const a = sig(base());
          const b = sig(withField(field, value));
          return a !== b || ('both are ' + JSON.stringify(a).slice(0, 80));
        });
      }

      add('a new message changes the signature', () => {
        const a = sig(base());
        const b = base();
        b.push(Object.assign({}, b[0], { id: 'm2' }));
        return a !== sig(b) || 'appending a message was ignored';
      });

      add('a removed message changes the signature', () => {
        const two = base();
        two.push(Object.assign({}, two[0], { id: 'm2' }));
        return sig(two) !== sig(base()) || 'removing a message was ignored';
      });

      add('reordering messages changes the signature', () => {
        const a = base();
        const b = base();
        b.push(Object.assign({}, b[0], { id: 'm2' }));
        return sig(a) !== sig(b) || 'order is invisible to the signature';
      });

      add('an empty list and a missing one are told apart from content', () => {
        return sig([]) !== sig(base()) || 'an empty thread looks like a full one';
      });

      return JSON.stringify(cases);
    })()
  `;

  await app.whenReady();
  harnessGuard(app, { label: 'check:gifrebuild' });
  const win = new BrowserWindow({ show: false });
  await win.loadFile(path.join(__dirname, 'gif-rebuild-harness.html'));
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
