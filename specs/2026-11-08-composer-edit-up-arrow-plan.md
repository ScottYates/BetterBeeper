# Edit a Previous Message from the Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pressing the up arrow in an empty composer opens your most recent editable message in the composer, with a banner above it, and Enter saves the edit.

**Architecture:** A new module, `src/renderer/js/composer-edit.js`, owns both halves of the feature: the pure rules that decide what can be edited (read from the chat's `capabilities` and the message's own fields), and the session that holds the message being edited, draws the banner, and steps through the candidates. `thread.js` imports the module and hands it its own functions, so the dependency runs one way only and the rules can be checked without Electron. The existing bubble editor is removed, so there is one edit mode.

**Tech Stack:** Electron 38, Node 24, vanilla ES modules in the renderer, no bundler. The checks are plain Node scripts run through `tools/run-check.js`.

**Design spec:** `specs/2026-11-08-composer-edit-up-arrow-design.md`

## Global Constraints

- Every code comment and every markdown file is pure ASCII. `npm run check:ascii` must pass.
- **No test may open a console window or a desktop dialog.** Every Electron check runs through `tools/run-check.js`, which parses before it loads, requires inside a catch, and listens for `uncaughtException` and `unhandledRejection`. Never run `cmd.exe` through `start`.
- `npm run check:syntax` parses every JS file and every harness. Run it before any Electron check after editing a file.
- **New files are LF.** `package.json` is committed as CRLF but checked out as LF, because `core.autocrlf` is on and git normalises it on commit: edit it in place and confirm `git diff` shows only your added line, with no whole-file line-ending churn.
- Commit with `git commit -F <file>` and then move the message file to the recoverable trash. **Always name the paths you add. Never `git add -A`.**
- The renderer keeps `contextIsolation: true` and `nodeIntegration: false`. Never disable `webSecurity`.
- Test messages only to "Note to self" / "Signal Note to Self".
- Beeper's own rule, quoted in the spec: *"Messages with attachments cannot be edited."*
- `capabilities.edit` is a support level: `-2` rejected, `-1` dropped, `0` unsupported, `1` partial, `2` full. **One or more may edit.**
- `capabilities.editMaxAge` is in **seconds**. A missing key means no age limit, not zero.
- A chat with **no `capabilities` object at all** means the bridge did not say; that is treated as editable. A chat with a `capabilities` object and **no `edit` key** means the bridge said it cannot edit; that is refused.
- `editMaxCount` is never enforced client-side. Beeper's message payload carries no per-message edit count, so any number the app produced would ignore edits made on another device.
- **The harness is a template literal.** A backtick inside it ends the string early and the check file stops parsing. Never write a backtick inside the harness text: use string concatenation (`'Editing message: ' + text`) instead of a template literal. The `const harness =` marker must start at the beginning of a line.
- One release per piece of work, not one per commit: the commits land as they are made and `npm run release` is cut once, at the end. `check:released` compares the newest tag with the branch head, so the release must be the last thing that happens.
- `npm run release` publishes **without installing**. Scott installs by hand so the in-app updater has something newer to fetch.
- The published asset is verified by SHA-256 against **GitHub's own asset digest**, not against the CLI's success message.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/renderer/js/composer-edit.js` | **New.** The rules that decide what can be edited, and the session: which message is being edited, the banner, the keys, the save. Imports the thread's functions rather than the thread. |
| `src/renderer/js/thread.js` | Wires the module in, hands the arrow keys to it, saves an edit instead of sending when one is open, marks the bubble being edited, and (Task 3) drops the bubble editor. |
| `src/renderer/index.html` | The banner row above the composer. |
| `src/renderer/styles.css` | The banner, the composer in its editing state, the bubble being edited. |
| `src/renderer/js/state.js` | One comment: `state.editing` now means the composer is editing that message. |
| `tools/composer-edit-check.js` | **New.** The check. Drives the real `index.html`. |
| `tools/composer-edit-redproof.js` | **New.** Reintroduces each rule and proves the named check goes red. |
| `package.json` | One script: `check:composeredit`. |

---

### Task 1: The rules that decide what can be edited

**Files:**
- Create: `src/renderer/js/composer-edit.js`
- Create: `tools/composer-edit-check.js`
- Modify: `package.json` (add the `check:composeredit` script)

**Interfaces:**
- Consumes: nothing. This task stands alone.
- Produces, for Tasks 2 and 3:
  - `chatAllowsEdit(chat): boolean`
  - `editMaxAgeSeconds(chat): number | null`
  - `isEditableMessage(chat, message, now = Date.now()): boolean`
  - `editableMessages(chat, messages, now = Date.now()): Message[]`

- [ ] **Step 1: Write the check file with the rule cases**

Create `tools/composer-edit-check.js` with exactly this content. The rule cases come first; the app cases are added in Tasks 2 and 3.

```js
/**
 * Dev check: editing a message you have already sent.
 *
 * The rules that decide what can be edited live in one module with no
 * Electron and no thread import, so they can be driven directly here. A rule
 * that is wrong fails in this file rather than in a chat nobody opened.
 *
 * Every case has a control that reproduces the behaviour it replaced,
 * because a suite that has been green over a feature nobody exercised is
 * worse than no suite at all.
 *
 * The DOM is generated from the real index.html, so the check cannot drift
 * from the app, and the API boundary is stubbed so no account and no network
 * are needed.
 *
 * Run with `npm run check:composeredit`.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const harnessGuard = require('./harness-guard');

const ROOT = path.join(__dirname, '..');
const js = (name) => pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', name)).href;
const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');
const HARNESS = path.join(__dirname, '.composer-edit-harness.html');

/** Real markup, real stylesheet, no app scripts. */
function buildHarness() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const stripped = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/href="styles\.css"/g, 'href="../src/renderer/styles.css"')
    .replace(/(href|src)="\.\//g, '$1="../src/renderer/');
  fs.writeFileSync(HARNESS, stripped);
}

async function main() {
  const { app, BrowserWindow } = require('electron');
  const os = require('os');
  app.setPath('userData', path.join(os.tmpdir(), 'bb-composer-edit-profile'));
  buildHarness();

  const harness = String.raw`
    (async () => {
      const cases = [];
      const add = async (name, fn) => {
        let ok = false;
        let detail = '';
        try { const r = await fn(); ok = r === true; if (r !== true) detail = String(r); }
        catch (e) { ok = false; detail = e.message; }
        cases.push([name, ok, detail]);
      };

      // A throw anywhere in the body must not take the cases collected so
      // far with it: a harness that dies reports one failure and hides the
      // rest, which is how a broken check looks like a passing one.
      try {
        await body();
      } catch (e) {
        cases.push(['the harness ran to the end', false, e && (e.stack || e.message)]);
      }
      return JSON.stringify(cases);

      async function body() {
        const CE = await import(${JSON.stringify(js('composer-edit.js'))});

        // --- the chat's capability -----------------------------------------

        const chat = (caps) => ({ id: 'c1', title: 'A chat', capabilities: caps });
        const NOW = Date.parse('2026-11-08T12:00:00Z');
        const own = (over) => Object.assign({
          id: 'm1',
          chatID: 'c1',
          isSender: true,
          isDeleted: false,
          type: 'TEXT',
          text: 'hello',
          timestamp: new Date(NOW - 1000).toISOString(),
        }, over || {});

        await add('a chat with no capabilities object may be edited', () =>
          CE.chatAllowsEdit(chat(undefined)) === true || 'it was refused');

        await add('CONTROL: a chat that says editing is full may be edited', () =>
          CE.chatAllowsEdit(chat({ edit: 2 })) === true || 'it was refused');

        await add('a chat that says editing is partial may be edited', () =>
          CE.chatAllowsEdit(chat({ edit: 1 })) === true || 'it was refused');

        await add('a chat that says editing is unsupported may not be edited', () =>
          CE.chatAllowsEdit(chat({ edit: 0 })) === false || 'it was allowed');

        await add('a chat that says editing is rejected may not be edited', () =>
          CE.chatAllowsEdit(chat({ edit: -2 })) === false || 'it was allowed');

        await add('a chat whose capabilities have no edit key may not be edited', () =>
          CE.chatAllowsEdit(chat({ attachments: {}, maxTextLength: 160 })) === false
          || 'it was allowed');

        await add('CONTROL: no capabilities object is not the same as no edit key', () =>
          (CE.chatAllowsEdit(chat(undefined)) === true
            && CE.chatAllowsEdit(chat({ maxTextLength: 160 })) === false)
          || 'the two states were treated the same');

        await add('the edit window is read in seconds', () =>
          CE.editMaxAgeSeconds(chat({ edit: 2, editMaxAge: 900 })) === 900
          || ('it read ' + CE.editMaxAgeSeconds(chat({ edit: 2, editMaxAge: 900 }))));

        await add('CONTROL: a chat with no edit window has no age limit', () =>
          CE.editMaxAgeSeconds(chat({ edit: 2 })) === null
          || ('it read ' + CE.editMaxAgeSeconds(chat({ edit: 2 }))));

        // --- the message ---------------------------------------------------

        await add('your own message can be edited', () =>
          CE.isEditableMessage(chat({ edit: 2 }), own(), NOW) === true || 'it was refused');

        await add('CONTROL: somebody else\'s message cannot be edited', () =>
          CE.isEditableMessage(chat({ edit: 2 }), own({ isSender: false }), NOW) === false
          || 'it was allowed');

        await add('a deleted message cannot be edited', () =>
          CE.isEditableMessage(chat({ edit: 2 }), own({ isDeleted: true }), NOW) === false
          || 'it was allowed');

        await add('a hidden message cannot be edited', () =>
          CE.isEditableMessage(chat({ edit: 2 }), own({ isHidden: true }), NOW) === false
          || 'it was allowed');

        await add('a message with an attachment cannot be edited', () =>
          CE.isEditableMessage(
            chat({ edit: 2 }), own({ attachments: [{ mimeType: 'image/png' }] }), NOW,
          ) === false || 'it was allowed');

        await add('a message inside the edit window can be edited', () =>
          CE.isEditableMessage(
            chat({ edit: 2, editMaxAge: 900 }),
            own({ timestamp: new Date(NOW - 600000).toISOString() }),
            NOW,
          ) === true || 'it was refused');

        await add('CONTROL: a message past the edit window cannot be edited', () =>
          CE.isEditableMessage(
            chat({ edit: 2, editMaxAge: 900 }),
            own({ timestamp: new Date(NOW - 1000000).toISOString() }),
            NOW,
          ) === false || 'it was allowed');

        await add('CONTROL: a chat with no edit window has no age limit', () =>
          CE.isEditableMessage(
            chat({ edit: 2 }),
            own({ timestamp: new Date(NOW - 100000000).toISOString() }),
            NOW,
          ) === true || 'an old message was refused');

        await add('CONTROL: a message with no timestamp cannot be edited', () =>
          CE.isEditableMessage(
            chat({ edit: 2, editMaxAge: 900 }), own({ timestamp: null }), NOW,
          ) === false || 'it was allowed');

        await add('a read-only chat may not be edited', () =>
          CE.isEditableMessage(
            { id: 'c1', isReadOnly: true, capabilities: { edit: 2 } }, own(), NOW,
          ) === false || 'it was allowed');

        // --- the list ------------------------------------------------------

        await add('the editable list is oldest first', () => {
          const list = CE.editableMessages(chat({ edit: 2 }), [
            own({ id: 'm3', timestamp: new Date(NOW - 3000).toISOString() }),
            own({ id: 'm1', timestamp: new Date(NOW - 9000).toISOString() }),
            own({ id: 'm2', timestamp: new Date(NOW - 6000).toISOString() }),
          ], NOW);
          return (list.length === 3 && list[0].id === 'm1' && list[2].id === 'm3')
            || ('got ' + list.map((m) => m.id).join(','));
        });

        await add('CONTROL: the editable list skips everything that cannot be edited', () => {
          const list = CE.editableMessages(chat({ edit: 2 }), [
            own({ id: 'm1', timestamp: new Date(NOW - 9000).toISOString() }),
            own({ id: 'm2', isSender: false, timestamp: new Date(NOW - 8000).toISOString() }),
            own({ id: 'm3', attachments: [{}], timestamp: new Date(NOW - 7000).toISOString() }),
            own({ id: 'm4', isDeleted: true, timestamp: new Date(NOW - 6000).toISOString() }),
            own({ id: 'm5', timestamp: new Date(NOW - 5000).toISOString() }),
          ], NOW);
          return (list.length === 2 && list[0].id === 'm1' && list[1].id === 'm5')
            || ('got ' + list.map((m) => m.id).join(','));
        });

        await add('the same chat and the same messages always give the same list', () => {
          const messages = [
            own({ id: 'm1', timestamp: new Date(NOW - 9000).toISOString() }),
            own({ id: 'm2', timestamp: new Date(NOW - 8000).toISOString() }),
          ];
          const a = CE.editableMessages(chat({ edit: 2 }), messages, NOW).map((m) => m.id);
          const b = CE.editableMessages(chat({ edit: 2 }), messages, NOW).map((m) => m.id);
          return (a.length === 2 && a.join(',') === b.join(',')) || 'the list changed between calls';
        });
      }
    })()
  `;

  await app.whenReady();
  harnessGuard(app, { label: 'check:composeredit' });
  const win = new BrowserWindow({ show: false });
  await win.loadFile(HARNESS);
  let harnessCases;
  try {
    const result = await win.webContents.executeJavaScript(harness, true);
    harnessCases = JSON.parse(result);
  } catch (err) {
    harnessCases = [['the browser harness ran to the end', false, err.message]];
  }
  app.exit(0);

  // The wiring across the processes is checked against the source: the edit
  // has to reach Beeper, and a break in any of the three lists leaves the
  // button doing nothing at all, with nothing on screen to say so.
  //
  // The channel name is a string on both sides of the bridge, and a typo on
  // one side only leaves both source checks green while the feature does
  // nothing. So the two names are read out of the source and compared.
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'preload.js'), 'utf8');
  const ipcSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'api.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'main.js'), 'utf8');

  const preloadChannel = (preloadSrc.match(/edit: \(chatID, messageID, text\) => invoke\('([^']+)'/) || [])[1];
  const ipcChannel = (ipcSrc.match(/ipcMain\.handle\('([^']+)', handle\(\(chatID, messageID, text\)/) || [])[1];

  const sourceCases = [
    ['the renderer can ask for an edit',
      /edit: \(chatID, messageID, text\) => window\.beeper\.messages\.edit\(/.test(apiSrc)],
    ['the preload can send one',
      /edit: \(chatID, messageID, text\) => invoke\('messages:edit'/.test(preloadSrc)],
    ['the main process has a handler for it',
      /ipcMain\.handle\('messages:edit'/.test(ipcSrc)],
    ['and the two sides are talking about the same channel',
      Boolean(preloadChannel) && preloadChannel === ipcChannel,
      `the preload listens on "${preloadChannel}", the main process handles "${ipcChannel}"`],
    // The global Escape handler runs in the capture phase, so it sees the key
    // before the composer's own handler does. Without this guard one Escape
    // would cancel the edit and close the conversation behind it, and
    // nothing in the harness could catch it, because the harness does not
    // load main.js.
    ['the global Escape handler leaves an edit alone',
      /if \(state\.editing\) return;/.test(mainSrc)],
  ].map(([name, ok, detail]) => [name, ok, detail || '']);

  const cases = harnessCases.concat(sourceCases);
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
```

- [ ] **Step 2: Add the npm script**

`package.json` is committed as CRLF and checked out as LF. Read it, insert the script, and write it back without changing the line endings:

```powershell
$path = 'C:\Users\scott\.minimax\sessions\mvs_4dde349d75f244c0bc376193b4c9a51a\workspace\beeper-desktop-chat\package.json'
$text = [IO.File]::ReadAllText($path)
$needle = '"check:composer": "electron tools/run-check.js tools/composer-check.js",'
$replacement = $needle + ' "check:composeredit": "electron tools/run-check.js tools/composer-edit-check.js",'
if ($text.Contains($needle) -and -not $text.Contains('check:composeredit')) {
  [IO.File]::WriteAllText($path, $text.Replace($needle, $replacement))
}
```

The script goes next to `check:composer`, which is the feature it belongs beside.

- [ ] **Step 3: Run the check and watch it fail**

Run: `npm run check:composeredit`
Expected: FAIL on every case, with a message like `Failed to fetch dynamically imported module` or a harness error, because `src/renderer/js/composer-edit.js` does not exist yet.

- [ ] **Step 4: Write the rules**

Create `src/renderer/js/composer-edit.js` with exactly this content:

```js
/**
 * Editing a message you have already sent.
 *
 * The rules live here rather than in the thread so they can be driven
 * directly by a check. Nothing in this file imports the thread, and the
 * thread imports this file, so the dependency runs one way only.
 *
 * Which messages can be edited is a property of the chat as much as of the
 * message: Beeper advertises editing per chat, and the window it allows is
 * fifteen minutes on Messenger and twenty-four hours on Signal. The rules
 * below read that advertisement rather than assuming every network behaves
 * the same way.
 */

import { parseTs } from './util.js';

/**
 * The lowest support level that still means "you may edit".
 *
 * Beeper's levels are -2 rejected, -1 dropped, 0 unsupported, 1 partially
 * supported, 2 fully supported. One is the point where an edit is allowed.
 */
const SUPPORTED = 1;

/**
 * Can this chat edit a message at all?
 *
 * Three states, and they are not the same:
 *
 *   no capabilities object  - the bridge did not say. Allowed, because that
 *                             is what the app has always done and Matrix
 *                             supports edits.
 *   a capabilities object
 *   with no edit key        - the bridge said it cannot edit. Refused.
 *   an edit level           - one or more may edit, zero or less may not.
 *
 * Google Voice is the second case and Beeper's own Matrix chats are the
 * first, and they were measured against the live bridge rather than guessed.
 */
export function chatAllowsEdit(chat) {
  const caps = chat?.capabilities;
  if (!caps || typeof caps !== 'object') return true;
  const level = caps.edit;
  if (level === undefined || level === null) return false;
  const value = Number(level);
  if (!Number.isFinite(value)) return false;
  return value >= SUPPORTED;
}

/**
 * The chat's edit window, in seconds, or null when it has none.
 *
 * Signal allows twenty-four hours, Messenger fifteen minutes, and the
 * Signal note to self has no limit at all - the key is simply not there.
 */
export function editMaxAgeSeconds(chat) {
  const caps = chat?.capabilities;
  if (!caps || typeof caps !== 'object') return null;
  const seconds = Number(caps.editMaxAge);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds;
}

/** Epoch millis for any of the timestamp shapes Beeper sends. */
function millisOf(value) {
  const date = parseTs(value);
  return date ? date.getTime() : 0;
}

/**
 * Can this message be edited, right now?
 *
 * `now` is a parameter so a check can ask about a message sent two days ago
 * without waiting two days.
 */
export function isEditableMessage(chat, message, now = Date.now()) {
  if (!chat || !message) return false;
  if (!chatAllowsEdit(chat)) return false;
  // A read-only chat cannot be written to at all, so there is nothing to
  // edit in it either.
  if (chat.isReadOnly) return false;
  if (!message.isSender) return false;
  if (message.isDeleted) return false;
  if (message.isHidden) return false;
  // Beeper's own rule: a message with an attachment cannot be edited.
  if ((message.attachments || []).length) return false;

  const maxAge = editMaxAgeSeconds(chat);
  if (maxAge !== null) {
    const sent = millisOf(message.timestamp);
    if (!sent) return false;
    if (now - sent > maxAge * 1000) return false;
  }
  return true;
}

/**
 * The messages that can be edited, oldest first.
 *
 * Oldest first because that is the order the up arrow walks them: the
 * newest one is entered first, and each further press steps towards the
 * past.
 *
 * The order is made here rather than assumed of the caller: the list the
 * renderer holds is usually oldest first already, but a message that
 * arrives late, or a window that was paged in, does not have to be.
 * Sorting a copy leaves the caller's array alone, and the sort is stable,
 * so two messages sent in the same millisecond keep the order they came in.
 */
export function editableMessages(chat, messages, now = Date.now()) {
  return (messages || [])
    .filter((message) => isEditableMessage(chat, message, now))
    .sort((a, b) => millisOf(a.timestamp) - millisOf(b.timestamp));
}
```

- [ ] **Step 5: Run the check and watch it pass**

Run: `npm run check:syntax` then `npm run check:composeredit`
Expected: `check:syntax` reports the new file parses; `check:composeredit` prints `27/27 checks passed` (22 rule cases and 5 source-level cases, which are counted in the same suite).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/js/composer-edit.js tools/composer-edit-check.js package.json
git commit -F <message file>
```

Message:

```
feat: the rules that decide what a message can be edited

Which messages can be edited is a property of the chat as much as of
the message. Beeper advertises editing per chat, and the window it
allows is fifteen minutes on Messenger and twenty-four hours on
Signal, so the rules read that advertisement rather than assuming
every network behaves the same way.

The three states of the advertisement are kept apart, because they
are not the same: a chat with no capabilities object at all is a
bridge that did not say, and a chat with a capabilities object and no
edit key is a bridge that said it cannot edit. Google Voice is the
second and Beeper's own Matrix chats are the first, both measured
against the live bridge.
```

---

### Task 2: The session, the banner, and the keys

**Files:**
- Modify: `src/renderer/js/composer-edit.js` (add the session)
- Modify: `src/renderer/js/thread.js` (wire it in, hand it the keys, save an edit instead of sending, mark the bubble)
- Modify: `src/renderer/index.html` (the banner row)
- Modify: `src/renderer/styles.css` (the banner and the editing state)
- Modify: `tools/composer-edit-check.js` (the app cases)

**Interfaces:**
- Consumes: `chatAllowsEdit`, `isEditableMessage`, `editableMessages` from Task 1.
- Produces:
  - `initComposerEdit(handles)` where `handles` is
    `{ getChat(), getMessages(), getSendOnEnter(), hasPendingAttachments(), clearReply(), focusComposer(), renderAll() }`
  - `handleComposerKey(event): boolean` - true when the key was used
  - `startEdit(message): boolean`
  - `stepEdit(delta): boolean`
  - `cancelEdit({ render } = {})`
  - `saveEdit(): Promise<boolean>`
  - `isEditing(): boolean`
  - `editSession(): { messageID, original, index, total }`

- [ ] **Step 1: Add the banner row to the markup**

In `src/renderer/index.html`, immediately after the `#reply-preview` div (which ends at line 223), add:

```html
          <div id="edit-preview" class="edit-preview" hidden>
            <span id="edit-preview-text" class="muted"></span>
            <button id="btn-cancel-edit" class="icon-btn tiny-btn" data-tip="Cancel edit" aria-label="Cancel edit">&#10005;</button>
          </div>
```

The banner takes the reply preview's slot, so the two are never on screen at once.

- [ ] **Step 2: Style the banner and the editing state**

In `src/renderer/styles.css`, after the `#reply-preview-text` rule (line 916), add:

```css
/* The edit banner. It sits in the reply preview's slot, so the two are
   never on screen at once. */
.edit-preview {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 7px 16px; background: var(--bg-elev);
  border-top: 1px solid var(--border-soft);
  font-size: 12.5px; flex: none;
}
#edit-preview-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.composer.is-editing .composer-field { border-color: var(--accent); }
.msg-bubble-wrap.is-editing .msg-bubble { outline: 1px solid var(--accent); }
```

- [ ] **Step 3: Add the app cases to the check**

In `tools/composer-edit-check.js`, inside `body()`, after the rule cases and before the closing `}` of the function, add this block. The stub and the app are set up here, so this block must come after the rule cases.

```js
        // --- the session, driven through the app ---------------------------

        const editCalls = [];
        const storeCalls = [];

        const envelope = (data) => ({ ok: true, data });
        const bubble = (id, ts, text, over) => Object.assign({
          id, chatID: 'c-edit', accountID: 'a1', senderID: 'a1', senderName: 'Me',
          text, timestamp: ts, isSender: true, type: 'TEXT', attachments: [],
        }, over || {});

        window.beeper = {
          on: () => {},
          chats: {
            list: async () => envelope([]),
            get: async () => envelope(null),
            patch: async () => envelope({}),
            markRead: async () => envelope(true),
            markUnread: async () => envelope(true),
            archive: async () => envelope(true),
            create: async () => envelope({}),
          },
          messages: {
            list: async () => envelope({ items: [], hasMore: false }),
            search: async () => envelope({ items: [] }),
            get: async () => envelope(null),
            edit: async (chatID, messageID, text) => {
              editCalls.push({ chatID, messageID, text });
              return envelope({ id: messageID, chatID, text });
            },
          },
          assets: {
            resolve: async () => envelope(null),
            download: async () => envelope(null),
            reupload: async () => envelope(null),
            saveAs: async () => envelope(null),
            pick: async () => envelope([]),
            upload: async () => envelope(null),
            uploadBytes: async () => envelope(null),
          },
          history: {
            // Five messages, and the two in the middle cannot be edited:
            // one is not mine and one has a picture. With only two eligible
            // messages the step could never be caught skipping anything, so
            // the skipping would be untested.
            open: async () => envelope({
              messages: [
                bubble('oldest', new Date(NOW - 5000).toISOString(), 'the oldest one'),
                bubble('theirs', new Date(NOW - 4000).toISOString(), 'not mine', { isSender: false }),
                bubble('pictures', new Date(NOW - 3000).toISOString(), 'with a picture', { attachments: [{ mimeType: 'image/png' }] }),
                bubble('middle', new Date(NOW - 2000).toISOString(), 'the middle one'),
                bubble('newest', new Date(NOW - 1000).toISOString(), 'the newest one'),
              ],
              complete: true,
              hasMore: false,
            }),
            page: async () => envelope({ messages: [], hasMore: false, complete: true }),
            upsert: async (chatID, message) => {
              storeCalls.push({ chatID, id: message.id, text: message.text });
              return envelope({ written: 1 });
            },
            search: async () => envelope([]),
            searchInChat: async () => envelope([]),
            status: async () => envelope({ messages: 0, chats: 0, bytes: 0 }),
            refresh: async () => envelope({ queued: true }),
            jobs: async () => envelope({ jobs: [] }),
          },
        };

        const S = await import(${JSON.stringify(js('state.js'))});
        const T = await import(${JSON.stringify(js('thread.js'))});
        T.initThread();
        S.state.chats.set('c-edit', {
          id: 'c-edit',
          title: 'A conversation',
          type: 'single',
          participants: { items: [{ isSelf: true }, { isSelf: false }] },
          capabilities: { edit: 2, editMaxCount: 10, editMaxAge: 86400 },
        });
        await T.openChat('c-edit');
        await settle(150);

        const composer = document.getElementById('composer');
        const banner = document.getElementById('edit-preview');
        const press = (key, extra) => composer.dispatchEvent(
          new KeyboardEvent('keydown', Object.assign({ key, bubbles: true }, extra || {})),
        );

        await add('the banner exists and is hidden to begin with', () =>
          (banner !== null && banner.hidden === true) || 'there is no banner');

        await add('the up arrow on an empty composer opens an edit', () => {
          press('ArrowUp');
          return CE.isEditing() === true || 'no edit was opened';
        });

        await add('the composer holds the text of the message being edited', () =>
          composer.value === 'the newest one' || ('it holds ' + composer.value));

        await add('the banner says what is being edited', () =>
          /Editing message/.test(document.getElementById('edit-preview-text').textContent)
          || 'the banner says nothing');

        await add('the composer placeholder says an edit is in progress', () =>
          /edit/i.test(composer.placeholder) || ('it reads ' + composer.placeholder));

        await add('the up arrow again steps to the older message', () => {
          press('ArrowUp');
          return composer.value === 'the middle one' || ('it holds ' + composer.value);
        });

        await add('CONTROL: the up arrow steps over another person\'s message and over a picture', () => {
          press('ArrowUp');
          return composer.value === 'the oldest one' || ('it holds ' + composer.value);
        });

        await add('CONTROL: there is nothing older to step to', () => {
          press('ArrowUp');
          return composer.value === 'the oldest one' || ('it holds ' + composer.value);
        });

        await add('the down arrow steps back to the newer message', () => {
          press('ArrowDown');
          press('ArrowDown');
          return composer.value === 'the newest one' || ('it holds ' + composer.value);
        });

        await add('CONTROL: the up arrow does nothing when the composer has text', () => {
          CE.cancelEdit();
          composer.value = 'a message being written';
          press('ArrowUp');
          const opened = CE.isEditing();
          composer.value = '';
          CE.cancelEdit();
          return opened === false || 'the arrow took over a draft';
        });

        await add('CONTROL: the up arrow does not step once the text has been changed', () => {
          press('ArrowUp');
          const before = composer.value;
          composer.value = before + ' and changed';
          press('ArrowUp');
          const after = composer.value;
          CE.cancelEdit();
          return after === before + ' and changed' || ('it stepped to ' + after);
        });

        await add('Enter saves the edit', async () => {
          press('ArrowUp');
          composer.value = 'the newest one, corrected';
          editCalls.length = 0;
          press('Enter');
          await settle(200);
          return editCalls.length === 1 || (editCalls.length + ' calls were made');
        });

        await add('the edit goes to the message being edited', () =>
          (editCalls[0] && editCalls[0].messageID === 'newest' && editCalls[0].chatID === 'c-edit')
          || ('it went to ' + JSON.stringify(editCalls[0])));

        await add('the edit carries the new text', () =>
          (editCalls[0] && editCalls[0].text === 'the newest one, corrected')
          || ('it carried ' + JSON.stringify(editCalls[0] && editCalls[0].text)));

        await add('the bubble shows the new text', async () => {
          await settle(200);
          const node = document.querySelector('[data-message-id="newest"]');
          return (node && node.textContent.includes('the newest one, corrected'))
            || 'the bubble still shows the old text';
        });

        await add('the edit is written to the local store', async () => {
          await settle(200);
          const written = storeCalls.find((c) => c.id === 'newest');
          return (written && written.text === 'the newest one, corrected')
            || ('the store was told ' + JSON.stringify(storeCalls));
        });

        await add('CONTROL: the banner is hidden once the edit is saved', () =>
          banner.hidden === true || 'the banner stayed open');

        await add('CONTROL: Escape cancels the edit', () => {
          press('ArrowUp');
          const opened = CE.isEditing();
          press('Escape');
          return (opened === true && CE.isEditing() === false) || 'the edit survived';
        });

        await add('CONTROL: a cancelled edit makes no call', async () => {
          editCalls.length = 0;
          press('ArrowUp');
          press('Escape');
          await settle(150);
          return editCalls.length === 0 || (editCalls.length + ' calls were made');
        });

        await add('CONTROL: a cancelled edit empties the composer', () => {
          press('ArrowUp');
          press('Escape');
          return composer.value === '' || ('it holds ' + composer.value);
        });

        await add('CONTROL: an empty edit is not sent', async () => {
          press('ArrowUp');
          composer.value = '   ';
          editCalls.length = 0;
          press('Enter');
          await settle(150);
          const none = editCalls.length === 0;
          CE.cancelEdit();
          return none || (editCalls.length + ' calls were made');
        });

        await add('CONTROL: a read-only chat does not open an edit', () => {
          const chat = S.state.chats.get('c-edit');
          const was = chat.isReadOnly;
          chat.isReadOnly = true;
          press('ArrowUp');
          const opened = CE.isEditing();
          chat.isReadOnly = was;
          CE.cancelEdit();
          return opened === false || 'the edit opened in a read-only chat';
        });

        await add('the session says which message is being edited', () => {
          press('ArrowUp');
          const session = CE.editSession();
          const ok = (session.messageID === 'newest' && session.total === 3 && session.index === 2);
          CE.cancelEdit();
          return ok || ('it says ' + JSON.stringify(session));
        });

        await add('CONTROL: opening another conversation cancels the edit', async () => {
          press('ArrowUp');
          const opened = CE.isEditing();
          S.state.chats.set('c-other', {
            id: 'c-other', title: 'Another conversation', type: 'single',
            participants: { items: [{ isSelf: true }, { isSelf: false }] },
          });
          await T.openChat('c-other');
          await settle(200);
          return (opened === true && CE.isEditing() === false) || 'the edit survived the switch';
        });
```

Also add a `settle` helper to the harness, next to the `add` helper. Put this directly after the `add` definition:

```js
      const settle = (ms) => new Promise((r) => setTimeout(r, ms || 60));
```

- [ ] **Step 4: Run the check and watch the new cases fail**

Run: `npm run check:composeredit`
Expected: the rule cases still pass, and every `the session, driven through the app` case fails, because `isEditing`, `startEdit` and the banner do not exist yet.

- [ ] **Step 5: Add the session to `composer-edit.js`**

In `src/renderer/js/composer-edit.js`, add these imports at the top (with the existing `parseTs` import):

```js
import { api, call } from './api.js';
import { state, upsertMessage, isMessageHidden, isMessageDeleted } from './state.js';
import { decodeEntities, clipText } from './entities.js';
import { toast } from './ui.js';
```

Then append this to the end of the file:

```js
// ---------------------------------------------------------------------------
// The session
//
// The message being edited, and the text it was loaded with. The original
// text is kept because it is what says whether the user has changed
// anything yet: while the composer still holds it, the arrow key steps to
// another message; once it has been changed, the arrow key is the caret.
// ---------------------------------------------------------------------------

/**
 * Everything the module needs from the thread, handed in rather than
 * imported, so the dependency between the two runs one way only.
 */
let deps = {
  getChat: () => null,
  getMessages: () => [],
  getSendOnEnter: () => true,
  hasPendingAttachments: () => false,
  clearReply: () => {},
  focusComposer: () => {},
  renderAll: () => {},
};

let session = null;
/**
 * The placeholder the composer had before an edit started.
 *
 * Captured when the edit starts rather than when the module is wired up,
 * because the thread sets the placeholder to the chat's name every time it
 * draws the header, and a value taken at startup would be the markup's
 * generic one by the time the first edit began.
 */
let defaultPlaceholder = '';
/** The tooltip the send button had before an edit started. */
let defaultSendTip = '';
let defaultSendLabel = '';

function composerEl() { return document.getElementById('composer'); }
function bannerEl() { return document.getElementById('edit-preview'); }
function bannerTextEl() { return document.getElementById('edit-preview-text'); }
function sendEl() { return document.getElementById('btn-send'); }

/** Wire the banner to the app. The thread hands its own functions in. */
export function initComposerEdit(handles) {
  deps = { ...deps, ...(handles || {}) };

  const send = sendEl();
  if (send && !defaultSendTip) {
    defaultSendTip = send.dataset.tip || '';
    defaultSendLabel = send.getAttribute('aria-label') || '';
  }

  const cancel = document.getElementById('btn-cancel-edit');
  if (cancel) cancel.addEventListener('click', () => cancelEdit());

  const banner = bannerEl();
  if (banner) banner.hidden = true;
}

/** True while a message is being edited. */
export function isEditing() {
  return Boolean(session);
}

/** What the check reads to see what the session is doing. */
export function editSession() {
  if (!session) return { messageID: null, original: '', index: -1, total: 0 };
  const list = candidateMessages();
  const index = list.findIndex((m) => m.id === session.messageID);
  return { messageID: session.messageID, original: session.original, index, total: list.length };
}

/**
 * The messages that could be edited, oldest first.
 *
 * The two local sets are filtered here rather than in the rule, because they
 * live in the app's own state and not on the message: a message the user
 * deleted on this device is gone from this app, not from Beeper.
 */
function candidateMessages() {
  const chat = deps.getChat();
  const list = deps.getMessages() || [];
  const visible = list.filter(
    (m) => !m.isHidden && !isMessageHidden(m.id) && !isMessageDeleted(m.id),
  );
  return editableMessages(chat, visible);
}

// ---------------------------------------------------------------------------
// The keyboard
// ---------------------------------------------------------------------------

/**
 * The composer's share of the keyboard.
 *
 * Returns true when the key was used, so the caller knows not to send.
 */
export function handleComposerKey(event) {
  if (!event) return false;

  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    // A platform shortcut that uses an arrow is not ours to swallow.
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    return handleArrow(event);
  }

  // Escape cancels the edit. The global handler in main.js leaves an edit
  // alone - it returns early while one is open - so the key reaches here
  // and is used for the edit rather than for closing the conversation.
  if (event.key === 'Escape' && session) {
    event.preventDefault();
    cancelEdit();
    return true;
  }

  // An edit is a send, so it follows the same rule as a message does about
  // when Enter sends.
  if (event.key === 'Enter' && !event.shiftKey && session) {
    const sendOnEnter = deps.getSendOnEnter();
    if (sendOnEnter || event.metaKey || event.ctrlKey) {
      event.preventDefault();
      saveEdit();
      return true;
    }
  }
  return false;
}

/**
 * The up and down arrows.
 *
 * With no session, the up arrow opens an edit. With one, the arrows step
 * through the editable messages: up towards the past, down towards the
 * present.
 */
function handleArrow(event) {
  const composer = composerEl();
  const text = String(composer?.value || '');

  if (!session) {
    // The arrow only starts an edit when the composer is empty. Anything
    // typed means the user is writing a message, and the arrow belongs to
    // the text they are writing.
    if (text.trim() !== '') return false;
    const started = startEditFromComposer();
    if (started) event.preventDefault();
    return started;
  }

  // Once the text has been changed, the arrow is the caret again: stepping
  // would throw away what the user wrote.
  if (text !== session.original) return false;

  const step = event.key === 'ArrowUp' ? -1 : 1;
  const moved = stepEdit(step);
  if (moved) event.preventDefault();
  return moved;
}

/**
 * Open an edit on the most recent message that can be edited.
 *
 * The newest one is entered first, and each further press of the up arrow
 * steps towards the past.
 */
function startEditFromComposer() {
  const chat = deps.getChat();
  if (!chat) return false;
  if (!chatAllowsEdit(chat)) return false;

  // A staged attachment has already been uploaded. Dropping it quietly would
  // throw away work, so the arrow refuses instead.
  if (deps.hasPendingAttachments()) {
    toast('Send or remove the attachment before editing', 'error');
    return false;
  }

  const list = candidateMessages();
  if (!list.length) return false;
  return startEdit(list[list.length - 1]);
}

/**
 * Open an edit on one message.
 *
 * The text is decoded before it goes into the composer, so what is edited is
 * what the reader sees rather than the markup behind it.
 */
export function startEdit(message) {
  const chat = deps.getChat();
  if (!chat || !message) return false;
  if (!isEditableMessage(chat, message)) return false;

  const composer = composerEl();
  if (!composer) return false;

  // The placeholder to put back when the edit ends is the one the
  // composer had when the edit began, which is the chat's name. Only a
  // fresh session captures it: stepping to another message keeps the
  // first capture, or the edit placeholder would be captured as the one
  // to restore.
  if (!session) defaultPlaceholder = composer.placeholder;

  const original = decodeEntities(message.text || '');
  session = {
    messageID: message.id,
    chatID: message.chatID || chat.id,
    original,
    message,
  };
  state.editing = message.id;

  // A reply and an edit cannot both be pending, and the edit wins.
  deps.clearReply();

  composer.value = original;
  const end = original.length;
  if (typeof composer.setSelectionRange === 'function') composer.setSelectionRange(end, end);

  showBanner(original);
  // The bubble being edited is marked, and the marker is only on screen
  // once the thread has been drawn again.
  deps.renderAll();
  deps.focusComposer();
  return true;
}

/**
 * Step to the message before or after the one being edited.
 *
 * A step that would leave the list does nothing: there is nothing older to
 * edit, and wrapping round to the newest one would make a mis-step
 * unrecoverable.
 */
export function stepEdit(delta) {
  if (!session) return false;
  const list = candidateMessages();
  if (!list.length) return false;
  const current = list.findIndex((m) => m.id === session.messageID);
  const from = current >= 0 ? current : list.length - 1;
  const next = from + delta;
  if (next < 0 || next >= list.length) return false;
  return startEdit(list[next]);
}

/**
 * End the edit without saving.
 *
 * The composer is emptied only when there was an edit: without one, it
 * holds a draft the user wrote, and that is not ours to throw away.
 */
export function cancelEdit({ render = true } = {}) {
  const had = Boolean(session);
  // The old bubble editor marked a message as being edited without
  // opening a session here, so the marker can be up even when there is no
  // session to end.
  const marked = Boolean(state.editing);
  session = null;
  state.editing = null;

  if (had) {
    const composer = composerEl();
    if (composer) composer.value = '';
    hideBanner();
  }
  // The thread is redrawn for the marker, so there is nothing to redraw
  // when there was no edit and no marker: a reply would otherwise rebuild
  // the whole thread for nothing.
  if (render && (had || marked)) deps.renderAll();
}

/**
 * Save the edit.
 *
 * A failure keeps the text in the composer and the session open: an edit
 * that did not happen must not cost the user what they wrote.
 */
export async function saveEdit() {
  if (!session) return false;
  const composer = composerEl();
  const text = String(composer?.value || '').trim();
  if (!text) {
    toast('A message cannot be empty', 'error');
    return false;
  }

  // An edit that changes nothing is not an edit. The bubble editor this
  // replaces compared the text first and only saved when it had actually
  // changed, so the session ends here and the message is left alone.
  if (text === session.original) {
    cancelEdit();
    return false;
  }

  const message = session.message;
  const chatID = session.chatID;

  const res = await call(
    () => api.messages.edit(chatID, message.id, text),
    { context: 'edit message', throwOnError: true },
  ).catch((err) => ({ __error: err }));

  if (res?.__error) {
    toast('Could not edit the message: ' + res.__error.message, 'error', 5000);
    return false;
  }

  const updated = { ...message, text, editedTimestamp: new Date().toISOString() };
  upsertMessage(chatID, updated);
  // Written through to the store, or the next start would draw the old text
  // again, from the copy on disk.
  await call(() => api.history.upsert(chatID, updated), { context: 'history', fallback: null });

  session = null;
  state.editing = null;
  if (composer) composer.value = '';
  hideBanner();
  deps.renderAll();
  toast('Message edited', 'success', 1500);
  return true;
}

// ---------------------------------------------------------------------------
// The banner
// ---------------------------------------------------------------------------

function showBanner(original) {
  const banner = bannerEl();
  if (banner) banner.hidden = false;
  const label = bannerTextEl();
  if (label) label.textContent = 'Editing message: ' + clipText(original, 120);

  const composer = composerEl();
  if (composer) composer.placeholder = 'Edit your message...';
  // An edit changes text. There is no such thing as an edited attachment,
  // so the buttons that add one are taken away while it is in progress.
  const attach = document.getElementById('btn-attach');
  if (attach) attach.hidden = true;
  const attachImage = document.getElementById('btn-attach-image');
  if (attachImage) attachImage.hidden = true;
  // The same button saves the edit, so it says so.
  const send = sendEl();
  if (send) {
    send.dataset.tip = 'Save edit (Enter)';
    send.setAttribute('aria-label', 'Save edit');
  }

  const footer = document.querySelector('.composer');
  if (footer) footer.classList.add('is-editing');
}

function hideBanner() {
  const banner = bannerEl();
  if (banner) banner.hidden = true;
  const label = bannerTextEl();
  if (label) label.textContent = '';

  const composer = composerEl();
  if (composer) composer.placeholder = defaultPlaceholder;
  const attach = document.getElementById('btn-attach');
  if (attach) attach.hidden = false;
  const attachImage = document.getElementById('btn-attach-image');
  if (attachImage) attachImage.hidden = false;
  const send = sendEl();
  if (send) {
    send.dataset.tip = defaultSendTip;
    send.setAttribute('aria-label', defaultSendLabel);
  }

  const footer = document.querySelector('.composer');
  if (footer) footer.classList.remove('is-editing');
}
```

- [ ] **Step 6: Wire it into `thread.js`**

In `src/renderer/js/thread.js`:

1. Add the import after the `thread-search.js` import (line 17):

```js
import {
  initComposerEdit,
  handleComposerKey,
  isEditing,
  startEdit,
  cancelEdit,
  saveEdit,
} from './composer-edit.js';
```

2. In `initThread()`, after the `initThreadSearch({...})` block (which ends at line 147), add:

```js
  // The edit session: the up arrow opens the last message that can be
  // edited in the composer itself, and the thread hands over the functions
  // it needs rather than the module reaching in for them.
  initComposerEdit({
    getChat: () => currentChat,
    getMessages: () => state.messages.get(state.activeChatID) || [],
    getSendOnEnter: () => state.settings.sendOnEnter !== false,
    hasPendingAttachments: () => pendingAttachments.length > 0,
    clearReply: () => { state.replyTo = null; updateReplyPreview(); },
    focusComposer: () => focusComposer(),
    renderAll: () => renderAll(),
  });
```

3. Replace the composer keydown handler (lines 160-166) with:

```js
  composer.addEventListener('keydown', (event) => {
    // The edit session gets the keys first: an edit is a send, and it must
    // not go out as a new message.
    if (handleComposerKey(event)) return;

    const sendOnEnter = state.settings.sendOnEnter !== false;
    if (event.key === 'Enter' && !event.shiftKey && (sendOnEnter || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      sendCurrent();
    }
  });
```

4. In `openChat()`, the chat-switch block (lines 340-346) becomes:

```js
  if (state.activeChatID !== chatID) {
    pendingAttachments = [];
    state.replyTo = null;
    // The edit belongs to the conversation it was started in. The thread is
    // drawn again below, so the banner does not need a second redraw.
    cancelEdit({ render: false });
    // The marks belong to the conversation that was open, so they go with it.
    closeThreadSearch();
  }
```

5. At the top of `sendCurrent()` (line 2125), add:

```js
async function sendCurrent() {
  // An open edit is a send that changes a message rather than adding one.
  if (isEditing()) {
    await saveEdit();
    return;
  }

  const composer = $('#composer');
```

6. In `messageNode`, replace the `state.editing === message.id` branch (lines 1163-1203) with:

```js
  // The message being edited is marked, not replaced. The text being
  // changed is in the composer, and the bubble keeps showing what it says.
  if (state.editing === message.id) bubbleWrap.classList.add('is-editing');

  if (message.linkedMessageID) bubbleWrap.append(replyQuoteNode(message));

  // Folded away on this device: the arrow opens it again.
  if (isMessageHidden(message.id)) {
    bubbleWrap.append(collapsedNode(message));
    return wrapMessageRow(message, isOut, isFirst, isLast, bubbleWrap);
  }

  const bubble = el('div', { class: 'msg-bubble' });

  if (message.attachments?.length) bubble.append(attachmentsNode(message));

  const inner = el('div', { class: 'bubble-inner' });

  if (!message.isDeleted && message.text) {
    inner.append(el('div', { class: 'bubble-text', html: renderRichText(message.text) }));
  } else if (message.isDeleted) {
    inner.append(el('div', { class: 'bubble-text muted', text: 'This message was deleted' }));
  } else if (!message.attachments?.length) {
    inner.append(
      el('div', { class: 'bubble-text muted', text: message.type ? `[${message.type.toLowerCase()}]` : '' }),
    );
  }

  // Beeper tucks the timestamp inside the bubble at the trailing edge.
  inner.append(
    el('span', {
      class: 'bubble-time',
      text: messageTime(message.timestamp),
      title: fullTime(message.timestamp),
    }),
  );
  bubble.append(inner);

  if (message.reactions?.length) bubble.append(reactionsNode(message, selfID));

  bubbleWrap.append(bubble);
```

7. In `setReplyTo`, cancel an open edit before setting the reply:

```js
function setReplyTo(message) {
  // A reply and an edit cannot both be pending, and the newest action
  // wins. The other direction already follows this rule: starting an edit
  // clears the reply.
  cancelEdit();
  state.replyTo = { id: message.id, text: message.text || message.type || '' };
  updateReplyPreview();
  $('#composer').focus();
}
```

- [ ] **Step 7: Run the check and watch it pass**

Run: `npm run check:syntax` then `npm run check:composeredit`
Expected: `check:syntax` passes; `check:composeredit` prints `51/51 checks passed` (27 from Task 1 and the 24 cases above).

The review of this task found four defects in the code above - the edited
message was removed from the thread instead of marked, a reply and an edit
could both be pending, the composer placeholder was captured too early, and an
edit that changed nothing was still sent - and fixing them added four more
cases: `the message being edited stays in the thread while the edit is open`,
`CONTROL: the composer placeholder goes back to the chat after the edit`,
`CONTROL: a reply cancels an open edit` and
`CONTROL: an edit that changes nothing is not sent`. The red proof added a
mutation for each of them, and the last task added one more case and mutation
for the marker class itself, so the suite is `61/61` and the red proof catches
`19/19`, not the `51/51` this step first expected.

If the app cases fail, the likely causes are: the harness needs the `settle` helper added next to `add` (Step 3 says where); or `openChat` did not draw the messages because the stub is missing a method the thread calls.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/js/composer-edit.js src/renderer/js/thread.js src/renderer/index.html src/renderer/styles.css tools/composer-edit-check.js
git commit -F <message file>
```

Message:

```
feat: the up arrow in the composer opens the last message you can edit

The composer now holds the text of the message being edited, with a
banner above it, and Enter saves the change. The up arrow steps back
through your own editable messages and the down arrow steps forward
again, so a mis-step is not a one-way door.

The arrow only acts on an empty composer, and only steps while the
text it loaded has not been changed: anything typed means the user is
writing, and the arrow belongs to the text they are writing.

The edits are written through to the local store, because an edit
that only lived in the renderer would be drawn from disk as the old
text the next time the app started.
```

---

### Task 3: One edit mode

**Files:**
- Modify: `src/renderer/js/thread.js` (delete the bubble editor, move the menu item)
- Modify: `src/renderer/js/state.js` (the comment on `state.editing`)
- Modify: `tools/composer-edit-check.js` (the menu cases)

**Interfaces:**
- Consumes: `startEdit`, `isEditableMessage` from Tasks 1 and 2.
- Produces: nothing new. The menu items are the interface.

- [ ] **Step 1: Add the menu cases to the check**

In `tools/composer-edit-check.js`, inside `body()`, after the session cases, add:

```js
        // --- one edit mode -------------------------------------------------

        // The conversation is opened again first, so the menu is asked about
        // the chat that advertises editing rather than the one the switch
        // left behind.
        await T.openChat('c-edit');
        await settle(200);

        await add('the menu offers Edit on an editable message', () => {
          const message = S.state.messages.get('c-edit').find((m) => m.id === 'newest');
          const items = T.messageMenuItems(document.body, message);
          return items.some((i) => i.label === 'Edit') || 'there is no Edit item';
        });

        await add('CONTROL: the menu does not offer Edit on a message that cannot be edited', () => {
          const message = S.state.messages.get('c-edit').find((m) => m.id === 'pictures');
          const items = T.messageMenuItems(document.body, message);
          return items.some((i) => i.label === 'Edit') === false || 'Edit was offered';
        });

        await add('CONTROL: the menu still offers Delete for everyone on a message that cannot be edited', () => {
          const message = S.state.messages.get('c-edit').find((m) => m.id === 'pictures');
          const items = T.messageMenuItems(document.body, message);
          return items.some((i) => i.label === 'Delete for everyone')
            || 'the delete item was taken away';
        });

        await add('CONTROL: the menu Edit opens the composer session', () => {
          const message = S.state.messages.get('c-edit').find((m) => m.id === 'newest');
          const items = T.messageMenuItems(document.body, message);
          const edit = items.find((i) => i.label === 'Edit');
          if (!edit) return 'there is no Edit item';
          edit.onSelect();
          const opened = CE.isEditing();
          CE.cancelEdit();
          return opened === true || 'the session did not open';
        });

        await add('CONTROL: there is no editor in the bubble any more', async () => {
          press('ArrowUp');
          // The thread is drawn again while the edit is open, which is when
          // the old bubble editor would have put its textarea on screen.
          S.upsertMessage(
            'c-edit',
            bubble('newest', new Date(NOW - 1000).toISOString(), 'the newest one, corrected'),
          );
          await settle(250);
          const textareas = document.querySelectorAll('#message-list textarea').length;
          CE.cancelEdit();
          return textareas === 0 || (textareas + ' textareas are in the thread');
        });
```

- [ ] **Step 2: Run the check and watch the menu cases fail**

Run: `npm run check:composeredit`
Expected: the new menu cases fail, because the menu still offers Edit on any own message and the bubble editor is still there.

- [ ] **Step 3: Delete the bubble editor and move the menu item**

In `src/renderer/js/thread.js`:

1. Delete the whole `editingNode(message)` function (lines 1619-1652).

2. Replace `messageMenuItems` (lines 1667-1692) with:

```js
export function messageMenuItems(anchor, message) {
  // Two different rules, decided separately.
  //
  // Editing is a capability the chat advertises, and it has an age limit:
  // fifteen minutes on Messenger, twenty-four hours on Signal, and nothing
  // at all on a chat that does not say. A message with an attachment cannot
  // be edited either.
  //
  // Deleting is not editing. It has its own capability and its own age
  // limit, and this feature does not touch them. One flag deciding both is
  // what made this worth spelling out: narrowing it for Edit would quietly
  // take away the ability to delete a message that has an attachment or has
  // aged out of its edit window.
  const canEdit = isEditableMessage(currentChat, message);
  const canDelete = message.isSender && !message.isDeleted;
  return [
    { label: 'Reply', onSelect: () => setReplyTo(message) },
    { label: 'React', onSelect: () => openEmojiPicker(anchor, (e) => toggleReaction(message, e)) },
    { label: 'Copy text', onSelect: () => copyText(decodeEntities(message.text || '')) },
    canShare(message)
      ? { label: 'Share with...', onSelect: () => openSharePicker(message, currentChat) }
      : null,
    // Sits after Share because both are about the message leaving this window -
    // to somebody, or to disk. Each attachment already has its own one-click
    // route, so this is the bulk case and nothing more.
    ...downloadMenuItems(message).map((item) => ({
      label: item.label,
      onSelect: () => { saveAttachments(downloadableAttachments(message)); },
    })),
    canEdit ? { label: 'Edit', onSelect: () => { startEdit(message); } } : null,
    canDelete
      ? { label: 'Delete for everyone', danger: true, onSelect: () => deleteMessage(message) }
      : null,
    {
      label: 'Copy message ID',
      onSelect: () => copyText(message.id),
    },
  ].filter(Boolean);
}
```

3. Add `isEditableMessage` to the import from `./composer-edit.js` (the import added in Task 2):

```js
import {
  initComposerEdit,
  handleComposerKey,
  isEditing,
  isEditableMessage,
  startEdit,
  cancelEdit,
  saveEdit,
} from './composer-edit.js';
```

- [ ] **Step 4: Update the comment on `state.editing`**

In `src/renderer/js/state.js`, replace:

```js
  /** messageID currently being edited, per chat */
  editing: null,
```

with:

```js
  /** messageID the composer is editing, per chat */
  editing: null,
```

- [ ] **Step 5: Run the check and watch it pass**

Run: `npm run check:syntax` then `npm run check:composeredit` then `npm run check:ascii`
Expected: `check:composeredit` prints `61/61 checks passed`; the ASCII check is clean.

- [ ] **Step 6: Run the whole suite**

Run: `npm run check:all`
Expected: every suite passes, including the new one.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/js/thread.js src/renderer/js/state.js tools/composer-edit-check.js
git commit -F <message file>
```

Message:

```
feat: one edit mode, in the composer

The bubble editor is gone. The context menu's Edit opens the same
composer session the up arrow opens, because two editors in one chat
means two rules about which message is being edited and two places to
look for the text.

The menu's two items are now decided separately. Edit follows the
chat's advertised capability and its age limit; Delete for everyone
keeps the rule it has today. One flag was deciding both, and
narrowing it for Edit would have quietly taken away the ability to
delete a message that has a picture or has aged out of its edit
window.
```

---

### Task 4: The red proof

**Files:**
- Create: `tools/composer-edit-redproof.js`

**Interfaces:**
- Consumes: `npm run check:composeredit`, and the source of `src/renderer/js/composer-edit.js` and `src/renderer/js/thread.js`.
- Produces: nothing the app uses. It is the evidence that each rule is load-bearing.

- [ ] **Step 1: Write the red proof**

Create `tools/composer-edit-redproof.js` with exactly this content. It follows the pattern of `tools/search-nav-redproof.js`: each mutation is applied to the source, the named check is run, and the file is restored in a `finally`, verified by content hash.

```js
/**
 * Red proof for editing a message from the composer.
 *
 * A check that has never been seen to fail is not evidence of anything. This
 * reintroduces each rule one at a time and asserts that the NAMED check
 * fails. A mutation that leaves the suite green is reported as a hole,
 * because it means that rule is not actually load-bearing.
 *
 * The last one is the other direction: a neutral rewrite that must stay green.
 *
 * Every file is restored in a finally, verified by content hash.
 *
 * Run with: node tools/composer-edit-redproof.js
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = {
  edit: path.join(ROOT, 'src', 'renderer', 'js', 'composer-edit.js'),
  thread: path.join(ROOT, 'src', 'renderer', 'js', 'thread.js'),
};

// Which suite proves which file.
const SUITE = {
  edit: 'check:composeredit',
  thread: 'check:composeredit',
};

const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/**
 * Replace `from` with `to`, requiring it to appear exactly once.
 *
 * The repository is mostly LF with a few CRLF files, so a literal written
 * with \n would silently not match a CRLF file, every mutation would report
 * SKIP, and the suite would look green for the wrong reason.
 */
function replaceOnce(original, from, to) {
  for (const pattern of [from, from.replace(/\n/g, '\r\n')]) {
    if (pattern !== from && !original.includes('\r\n')) continue;
    const count = original.split(pattern).length - 1;
    if (count === 1) return { ok: true, text: original.replace(pattern, to) };
    if (count > 1) return { ok: false, why: 'pattern appears ' + count + ' times' };
  }
  return { ok: false, why: 'pattern not found' };
}

function applyEdit(original, from, to) {
  const froms = Array.isArray(from) ? from : [from];
  const tos = Array.isArray(to) ? to : [to];
  if (froms.length !== tos.length) return { ok: false, why: 'mismatched edit counts' };
  let text = original;
  for (let i = 0; i < froms.length; i++) {
    const result = replaceOnce(text, froms[i], tos[i]);
    if (!result.ok) return { ok: false, why: result.why };
    text = result.text;
  }
  return { ok: true, text };
}

const MUTATIONS = [
  {
    what: 'the up arrow opens nothing',
    file: 'edit',
    from: "    const started = startEditFromComposer();\n    if (started) event.preventDefault();\n    return started;",
    to: "    return false;",
    expect: 'the up arrow on an empty composer opens an edit',
  },
  {
    what: 'the arrow steps towards the present instead of the past',
    file: 'edit',
    from: "  const step = event.key === 'ArrowUp' ? -1 : 1;",
    to: "  const step = event.key === 'ArrowUp' ? 1 : -1;",
    expect: 'the up arrow again steps to the older message',
  },
  {
    what: 'the arrow acts even when the composer has text',
    file: 'edit',
    from: "    if (text.trim() !== '') return false;\n",
    to: '',
    expect: 'CONTROL: the up arrow does nothing when the composer has text',
  },
  {
    what: 'the arrow steps even after the text has been changed',
    file: 'edit',
    from: "  if (text !== session.original) return false;\n",
    to: '',
    expect: 'CONTROL: the up arrow does not step once the text has been changed',
  },
  {
    what: 'a chat with no capabilities object is refused',
    file: 'edit',
    from: "  if (!caps || typeof caps !== 'object') return true;",
    to: "  if (!caps || typeof caps !== 'object') return false;",
    expect: 'a chat with no capabilities object may be edited',
  },
  {
    what: 'a chat whose capabilities have no edit key is allowed',
    file: 'edit',
    from: "  if (level === undefined || level === null) return false;",
    to: "  if (level === undefined || level === null) return true;",
    expect: 'a chat whose capabilities have no edit key may not be edited',
  },
  {
    what: 'the edit window is ignored',
    file: 'edit',
    from: "    if (now - sent > maxAge * 1000) return false;",
    to: "    if (false) return false;",
    expect: 'CONTROL: a message past the edit window cannot be edited',
  },
  {
    what: 'a message with an attachment can be edited',
    file: 'edit',
    from: "  if ((message.attachments || []).length) return false;",
    to: '',
    expect: 'a message with an attachment cannot be edited',
  },
  {
    what: 'somebody else\'s message can be edited',
    file: 'edit',
    from: "  if (!message.isSender) return false;",
    to: '',
    expect: 'CONTROL: somebody else\'s message cannot be edited',
  },
  {
    what: 'Enter sends a new message instead of saving the edit',
    file: 'edit',
    from: "  if (event.key === 'Enter' && !event.shiftKey && session) {",
    to: "  if (event.key === 'Enter' && !event.shiftKey && false) {",
    expect: 'Enter saves the edit',
  },
  {
    what: 'the edit is not written to the local store',
    file: 'edit',
    from: "  await call(() => api.history.upsert(chatID, updated), { context: 'history', fallback: null });",
    to: '',
    expect: 'the edit is written to the local store',
  },
  {
    what: 'the bubble editor is still there',
    file: 'thread',
    from: "  if (state.editing === message.id) bubbleWrap.classList.add('is-editing');",
    to: "  if (state.editing === message.id) { bubbleWrap.classList.add('is-editing'); bubbleWrap.append(el('textarea', {})); }",
    expect: 'CONTROL: there is no editor in the bubble any more',
  },
  {
    what: 'the menu offers Edit on a message that cannot be edited',
    file: 'thread',
    from: "  const canEdit = isEditableMessage(currentChat, message);",
    to: "  const canEdit = message.isSender && !message.isDeleted;",
    expect: 'CONTROL: the menu does not offer Edit on a message that cannot be edited',
  },
  {
    what: 'the menu takes away the delete item along with Edit',
    file: 'thread',
    from: "  const canDelete = message.isSender && !message.isDeleted;",
    to: "  const canDelete = canEdit;",
    expect: 'CONTROL: the menu still offers Delete for everyone on a message that cannot be edited',
  },
  {
    // Not a bug. The same rule, written the other way round.
    what: 'TOLERATED: the step is written as a branch',
    file: 'edit',
    from: "  const step = event.key === 'ArrowUp' ? -1 : 1;",
    to: "  const step = event.key !== 'ArrowUp' ? 1 : -1;",
    expect: 'the up arrow again steps to the older message',
    expectGreen: true,
  },
];

function runCheck(suite) {
  try {
    const out = execFileSync('npm.cmd', ['run', suite, '--silent'], {
      cwd: ROOT, encoding: 'utf8', timeout: 600000, shell: true,
    });
    return { code: 0, out };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      out: String(err.stdout || '') + String(err.stderr || ''),
    };
  }
}

/** The verdict for the one named check, ignoring every other line. */
function verdictFor(out, name) {
  for (const line of out.split(/\r?\n/)) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!clean.startsWith('PASS') && !clean.startsWith('FAIL')) continue;
    const rest = clean.slice(5).trim();
    const detail = rest.indexOf('  [');
    const printed = detail === -1 ? rest : rest.slice(0, detail);
    if (printed === name) return clean.startsWith('FAIL') ? 'FAIL' : 'PASS';
  }
  return null;
}

const before = {};
for (const [k, p] of Object.entries(FILES)) before[k] = hash(p);

let caught = 0;
let tolerated = 0;
const holes = [];
const expected = MUTATIONS.filter((m) => !m.expectGreen).length;
console.log(`baseline: ${runCheck('check:composeredit').out.match(/(\d+\/\d+) checks passed/)?.[1] || '?'}\n`);

for (const m of MUTATIONS) {
  const target = FILES[m.file];
  const original = fs.readFileSync(target, 'utf8');
  let applied = false;
  try {
    const edit = applyEdit(original, m.from, m.to);
    if (!edit.ok) {
      holes.push(`${m.what} -- ${edit.why}`);
      console.log(`SKIP  ${m.what}\n      ${edit.why}`);
      continue;
    }
    fs.writeFileSync(target, edit.text, 'utf8');
    applied = true;

    const { out } = runCheck(SUITE[m.file]);
    const verdict = verdictFor(out, m.expect);
    if (verdict === null) {
      holes.push(`${m.what} -- "${m.expect}" never printed`);
      console.log(`HOLE  ${m.what}\n      the named check never printed`);
    } else if (m.expectGreen) {
      if (verdict === 'PASS') {
        tolerated++;
        console.log(`TOLERATED  ${m.what}\n      stayed green, as it should`);
      } else {
        holes.push(`${m.what} -- went red on a neutral rewrite, so it is pinned to the code`);
        console.log(`HOLE  ${m.what}\n      went red on a neutral rewrite`);
      }
    } else if (verdict === 'FAIL') {
      caught++;
      console.log(`RED   ${m.what}\n      "${m.expect}" failed as it should`);
    } else {
      holes.push(`${m.what} -- "${m.expect}" stayed green`);
      console.log(`HOLE  ${m.what}\n      "${m.expect}" stayed green`);
    }
  } finally {
    if (applied) fs.writeFileSync(target, original, 'utf8');
    const now = hash(target);
    if (now !== before[m.file]) {
      console.log(`\nRESTORE FAILED for ${path.basename(target)}`);
      process.exit(1);
    }
  }
}

console.log(`\n${caught}/${expected} mutations caught by the check they were written for`);
console.log(`${tolerated}/${MUTATIONS.length - expected} neutral rewrites tolerated (not re-pinned)`);
if (holes.length) {
  console.log('\nHoles:');
  for (const h of holes) console.log(`  - ${h}`);
  process.exit(1);
}
process.exit(0);
```

- [ ] **Step 2: Run it**

Run: `node tools/composer-edit-redproof.js`
Expected: `14/14 mutations caught` and `1/1 neutral rewrites tolerated`.

A `SKIP` means the pattern in the mutation no longer matches the source, which is a hole: the source has been written differently from the plan. Fix the mutation's `from` string to match the source, or fix the source to match the plan. A `HOLE` means the named check stayed green, so that rule is not load-bearing and the check needs a case for it.

- [ ] **Step 3: Commit**

```bash
git add tools/composer-edit-redproof.js
git commit -F <message file>
```

Message:

```
test: prove each rule of the composer edit is load-bearing

A check that has never been seen to fail is not evidence of anything.
Each rule is reintroduced one at a time and the named check has to
fail, and the one neutral rewrite has to stay green.
```

---

### Task 5: The handoff notes and the release

**Files:**
- Modify: `HANDOFF-betterbeeper.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the published release.

- [ ] **Step 1: Write the handoff section**

In `HANDOFF-betterbeeper.md`, add a new `## Work done 2026-11-08` section above `## Verification status`, with these three subsections in this wording:

```markdown
### The up arrow edits the message you sent last

The composer takes the up arrow now. With an empty composer, it opens the
most recent message that can still be edited: the text comes back into the
composer, a banner above it says what is being edited, and Enter saves the
change. The up arrow again steps back through your own editable messages,
and the down arrow steps forward again, so a mis-step is not a one-way
door.

The arrow only acts on an empty composer, and it only steps while the text
it loaded has not been changed. Anything typed means the user is writing,
and the arrow belongs to the text they are writing.

The edit is written through to the local store as well as to Beeper. An
edit that only lived in the renderer would be drawn from disk as the old
text the next time the app started.

### Beeper advertises editing per chat, and there are three answers to read

`capabilities.edit` is a support level: -2 rejected, -1 dropped, 0
unsupported, 1 partially supported, 2 fully supported. Measured against the
live bridge on 2026-11-08:

| Network | Chats | `edit` | `editMaxCount` | `editMaxAge` |
| --- | --- | --- | --- | --- |
| Signal | 3 | 2 | 10 | 86400 s (24 h) |
| Signal Note to Self | 1 | 2 | 10 | absent, so no limit |
| Facebook/Messenger | 3 | 2 | 5 | 900 s (15 min) |
| Google Voice | 91 | absent | absent | absent |
| Beeper (Matrix) | 2 | no `capabilities` object at all | | |

Three states, and they are not the same: a chat with no `capabilities`
object at all is a bridge that did not say, and that is allowed; a chat
with a `capabilities` object and no `edit` key is a bridge that said it
cannot edit, and that is refused; and an `edit` level of 1 or more may
edit. Google Voice is the second and Beeper's own Matrix chats are the
first.

`editMaxAge` is in seconds and is enforced before the arrow offers
anything, so the app never offers an edit the server will refuse.

`editMaxCount` is not enforced. Beeper's message payload carries no
per-message count of how many times a message has been edited, so the only
number the app could produce would count the edits made on this device
and ignore the ones made on a phone. The server's refusal is shown as a
toast instead.

### One edit mode, and two different rules behind the menu

The bubble editor is gone. The context menu's `Edit` opens the same
composer session the up arrow opens, because two editors in one chat means
two rules about which message is being edited and two places to look for
the text.

The menu's two items are decided separately, and they used to share one
flag. `Edit` follows the chat's advertised capability and its age limit.
`Delete for everyone` keeps the rule it has today, because delete is a
different capability with a different age limit that this feature does
not touch, and because narrowing the shared flag would have quietly taken
away the ability to delete a message that has a picture or has aged out of
its edit window.
```

Then add two rows to the verification table in `## Verification status`:

```
| `check:composeredit` | 61/61 checks passed |
| `tools/composer-edit-redproof.js` | 19/19 mutations caught, no holes |
```

Record the counts the run actually printed. They should be 61/61 and 19/19;
if they differ, a case was added or lost on the way, and that difference has
to be accounted for before the release is cut.

- [ ] **Step 2: Run everything one last time**

Run: `npm run check:syntax`, `npm run check:ascii`, `npm run check:all`, `node tools/composer-edit-redproof.js`
Expected: all green, with the counts written into the handoff notes.

- [ ] **Step 3: Commit the notes**

```bash
git add HANDOFF-betterbeeper.md
git commit -F <message file>
```

Message:

```
docs: record editing a message from the composer

What the up arrow does, the three states of Beeper's capability
advertisement and why they are different, the edit window per network,
and the two separate rules behind the Edit and Delete for everyone
menu items.
```

- [ ] **Step 4: Push and cut the release**

Run: `npm run release`
Expected: the version is bumped to a minor (a `feat:` commit means a minor), the installer is built, the release is published, and the tool prints the SHA-256 it fetched back from GitHub.

The release must not install: `npm run release` already passes `--skip-install`.

- [ ] **Step 5: Verify the published asset against GitHub's own digest**

Run:

```bash
gh release view v<version> --repo ScottYates/BetterBeeper --json assets --jq '.assets[] | "\(.name)  \(.digest)"'
```

Expected: the digest matches the SHA-256 the release tool printed, character for character. The CLI saying "published successfully" is not evidence that the 90 MB arrived intact.

- [ ] **Step 6: Confirm the branch is clean and released**

Run: `npm run check:released` and `git status --short`
Expected: `OK  every push to main has a release.` and an empty status.

- [ ] **Step 7: Move the commit message files to the recoverable trash**

Every message file written for the commits above goes to the recoverable trash, one target per call:

```powershell
& 'C:\Users\scott\.minimax\bin\mavis-trash.cmd' -- '<path to the message file>'
```

Do not delete anything else, and never anything outside the workspace.
