/**
 * Dev check: an inbox row with new entries has to look different from a read
 * one, in both themes.
 *
 * The bug this exists for: the unread count badge was the *only* thing
 * separating a chat with three new messages from a chat you had already read.
 * An 18px pill sitting at the end of a 300px row is easy to skim straight
 * past, and the title weight, the preview line and the timestamp were all
 * identical either way, so scanning the list for what is new meant reading
 * every badge rather than seeing it.
 *
 * The row now carries the state on several independent axes. This check
 * measures the real stylesheet over the real renderChats(), for both a plain
 * chat and a note-to-self chat, in the dark and the light theme, so a rule
 * that only works in one theme, or that the class stopped being applied, or
 * that the cascade order let a later rule swallow, fails here.
 *
 * It is deliberately measurement, not source matching. "There is a rule with
 * .is-unread in it" passes long after the thing it was written for has stopped
 * being true; "the unread title is heavier than the read title, in both
 * themes, as rendered" cannot.
 *
 * Run with `npm run check:unread`.
 */
const path = require('path');
const harnessGuard = require('./harness-guard');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const stateURL = pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', 'state.js')).href;
const sidebarURL = pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', 'sidebar.js')).href;
const cssURL = pathToFileURL(path.join(ROOT, 'src', 'renderer', 'styles.css')).href;

async function main() {
  const { app, BrowserWindow } = require('electron');

  // An isolated profile, so the test can never read a cached copy of the
  // renderer modules. Chromium caches file:// modules in userData, which means a
  // stale renderer can otherwise be executed after the source changed.
  const os = require('os');
  app.setPath('userData', path.join(os.tmpdir(), 'bb-unread-check-profile'));

  const harness = `
    (async () => {
     try {
      const S = await import(${JSON.stringify(stateURL)});
      const B = await import(${JSON.stringify(sidebarURL)});

      // ---- colour maths -------------------------------------------------
      // getComputedStyle hands back rgb()/rgba() strings, and the unread wash
      // is translucent, so a contrast figure computed against it directly
      // would be a number about nothing. Everything is composited over its
      // real parents first, which is what the eye actually integrates.

      const parse = (value) => {
        const m = String(value || '').match(/rgba?\\(([^)]+)\\)/);
        if (!m) return null;
        const parts = m[1].split(',').map((p) => parseFloat(p));
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
      };

      const over = (fg, bg) => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1,
      });

      // Walk up until something opaque, so a translucent row is judged against
      // the surface it really sits on.
      const painted = (node) => {
        let cur = node;
        let stack = [];
        while (cur) {
          const c = parse(getComputedStyle(cur).backgroundColor);
          if (c && c.a > 0) {
            stack.push(c);
            if (c.a >= 1) break;
          }
          cur = cur.parentElement;
        }
        let base = { r: 13, g: 13, b: 15, a: 1 }; // --bg, the app's darkest
        for (let i = stack.length - 1; i >= 0; i -= 1) base = over(stack[i], base);
        return base;
      };

      const lum = (c) => {
        const f = (v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      };

      const ratio = (a, b) => {
        const la = lum(a);
        const lb = lum(b);
        const hi = Math.max(la, lb);
        const lo = Math.min(la, lb);
        return (hi + 0.05) / (lo + 0.05);
      };

      const colorOf = (node) => over(parse(getComputedStyle(node).color), painted(node));
      const weightOf = (node) => parseInt(getComputedStyle(node).fontWeight, 10) || 400;
      const same = (a, b) => Math.abs(a.r - b.r) < 0.5 && Math.abs(a.g - b.g) < 0.5 && Math.abs(a.b - b.b) < 0.5;

      // ---- seed ---------------------------------------------------------
      const person = (id, title, lastActivity, unreadCount) => ({
        id: id, title: title, lastActivity: lastActivity, type: 'single',
        participants: { items: [{ isSelf: true }, { isSelf: false }] },
        unreadCount: unreadCount,
        // Every seeded chat carries preview text. Without it a read row's
        // preview line collapses to zero height while the unread row's badge
        // gives it 18px, and the height check below reports a difference that
        // is an artefact of the fixture rather than of the styling.
        preview: { id: id + '-p', text: 'the last thing said in this chat' },
      });
      const note = (id, title, lastActivity, unreadCount) => ({
        id: id, title: title, lastActivity: lastActivity, type: 'single',
        participants: { items: [{ isSelf: true }] },
        unreadCount: unreadCount,
        preview: { id: id + '-p', text: 'a note to self' },
      });

      // A read chat, an unread one, and the same pair as note-to-self rows, so
      // a treatment applied to only one of the two builders is caught.
      const seed = (activeID) => {
        S.state.chats.clear();
        S.state.chats.set('!read', person('!read', 'Bravo', '2026-01-01T10:00:00Z', 0));
        S.state.chats.set('!unread', person('!unread', 'Alpha', '2026-01-02T10:00:00Z', 3));
        S.state.chats.set('!note-read', note('!note-read', 'Note', '2026-01-03T10:00:00Z', 0));
        S.state.chats.set('!note-unread', note('!note-unread', 'Note to self', '2026-01-04T10:00:00Z', 1));
        S.loadPins({});
        S.loadArchived([]);
        S.state.filter = 'all';
        S.state.searchQuery = '';
        S.state.activeChatID = activeID || null;
        B.renderChats();
      };

      const row = (id) => document.querySelector('#chat-list > .chat-item[data-chat-id="' + id + '"]');
      const part = (r, sel) => r.querySelector(sel);

      // Everything a reader could use to tell the two rows apart, measured
      // once so every case can assert against the same snapshot.
      const read = (id) => {
        const r = row(id);
        return {
          hasClass: r.classList.contains('is-unread'),
          background: painted(r),
          bar: parse(getComputedStyle(r, '::before').backgroundColor),
          barWidth: getComputedStyle(r, '::before').width,
          titleWeight: weightOf(part(r, '.chat-item-title')),
          title: colorOf(part(r, '.chat-item-title')),
          preview: colorOf(part(r, '.chat-item-preview')),
          time: colorOf(part(r, '.chat-item-time')),
          height: r.getBoundingClientRect().height,
          badge: (part(r, '.chat-unread') || {}).textContent || '',
        };
      };

      const cases = [];
      const add = (name, fn) => {
        let ok = false;
        let detail = '';
        try { const r = fn(); ok = r === true; if (r !== true) detail = String(r); }
        catch (e) { ok = false; detail = e.message; }
        cases.push([name, ok, detail]);
      };

      // Each theme is checked as a whole, so a label in the output says which
      // one actually failed rather than leaving you to guess.
      for (const theme of ['dark', 'light']) {
        const label = '[' + theme + '] ';
        const enter = () => { document.documentElement.dataset.theme = theme; seed(); };

        add(label + 'a read row is not marked unread', () => {
          enter();
          const r = read('!read');
          return r.hasClass === false || ('row carries is-unread');
        });

        add(label + 'an unread row is marked unread', () => {
          enter();
          const r = read('!unread');
          return r.hasClass === true || ('row has no is-unread class');
        });

        add(label + 'a note-to-self row is marked unread too', () => {
          // noteItem() is a separate builder. A treatment added to chatItem()
          // alone would leave your own notes looking read while unread.
          enter();
          const r = read('!note-unread');
          return r.hasClass === true || ('note row has no is-unread class');
        });

        add(label + 'the unread title is heavier than the read title', () => {
          enter();
          const u = read('!unread');
          const r = read('!read');
          return u.titleWeight > r.titleWeight
            || ('unread ' + u.titleWeight + ' vs read ' + r.titleWeight);
        });

        add(label + 'the unread preview line reads louder than the read one', () => {
          // Measured as contrast against each row's own background, not as a
          // sum of RGB. "Brighter" is only true in the dark theme: --text is
          // *darker* than --text-dim on light, so a brightness sum scores the
          // light theme exactly backwards. Contrast has the same meaning in
          // both, which is the property actually being claimed.
          enter();
          const u = read('!unread');
          const r = read('!read');
          const cu = ratio(u.preview, u.background);
          const cr = ratio(r.preview, r.background);
          return cu > cr
            || ('unread ' + cu.toFixed(2) + ':1 vs read ' + cr.toFixed(2) + ':1');
        });

        add(label + 'the unread timestamp is tinted, the read one is not', () => {
          enter();
          const u = read('!unread');
          const r = read('!read');
          return !same(u.time, r.time)
            || ('both timestamps are ' + JSON.stringify(u.time));
        });

        add(label + 'the unread row is washed and the read row is not', () => {
          enter();
          const u = read('!unread');
          const r = read('!read');
          return !same(u.background, r.background)
            || ('both backgrounds composite to ' + JSON.stringify(u.background));
        });

        add(label + 'the unread row carries a left accent bar the read one lacks', () => {
          enter();
          const u = read('!unread');
          const r = read('!read');
          const hasBar = (s) => s.bar && s.bar.a > 0 && parseFloat(s.barWidth) > 0;
          return hasBar(u) && !hasBar(r)
            || ('unread bar ' + JSON.stringify(u.bar) + ' @ ' + u.barWidth
              + ', read bar ' + JSON.stringify(r.bar) + ' @ ' + r.barWidth);
        });

        add(label + 'the unread preview clears a readable contrast ratio', () => {
          // The whole point is that it can be read while scanning, so hold it
          // to the AA body-text threshold against the surface it composites
          // onto rather than trusting the token choice by eye.
          enter();
          const u = read('!unread');
          const c = ratio(u.preview, u.background);
          return c >= 4.5 || ('contrast is ' + c.toFixed(2) + ':1 against its own background');
        });

        add(label + 'the unread title clears a readable contrast ratio', () => {
          enter();
          const u = read('!unread');
          const c = ratio(u.title, u.background);
          return c >= 4.5 || ('contrast is ' + c.toFixed(2) + ':1 against its own background');
        });

        add(label + 'the read preview keeps its original dim colour', () => {
          // Regression guard. Lifting every row to --text would make the unread
          // state meaningless, so a read row has to stay visibly quieter.
          enter();
          const r = read('!read');
          const c = ratio(r.preview, r.background);
          const u = read('!unread');
          return c < ratio(u.preview, u.background)
            || ('read preview ' + c.toFixed(2) + ':1 is as loud as unread '
              + ratio(u.preview, u.background).toFixed(2) + ':1');
        });

        add(label + 'the unread badge still shows the count', () => {
          enter();
          return read('!unread').badge === '3' || ('badge is "' + read('!unread').badge + '"');
        });

        add(label + 'a read row has no badge at all', () => {
          enter();
          return read('!read').badge === '' || ('badge is "' + read('!read').badge + '"');
        });

        add(label + 'an unread row is the same height as a read one', () => {
          // A taller unread row would reflow the whole list every time a
          // message landed, so prominence has to come from weight and colour.
          // Measured against the avatar, which is what actually sets the row
          // height: the preview line and the badge are both shorter than it.
          enter();
          const u = read('!unread');
          const r = read('!read');
          return Math.abs(u.height - r.height) < 0.5
            || ('unread ' + u.height.toFixed(1) + 'px vs read ' + r.height.toFixed(1) + 'px');
        });

        add(label + 'the open row keeps its own background over the unread wash', () => {
          // Equal specificity, so this is decided by source order. If the
          // unread rules ever land after .is-active, the chat you have open
          // would be tinted like the ones you have not.
          enter();
          seed('!unread');
          const open = row('!unread');
          const openBg = painted(open);
          const other = painted(row('!read'));
          return !same(openBg, other)
            || ('the open unread row composites to the same ' + JSON.stringify(openBg));
        });
      }

      // ---- cascade order ------------------------------------------------
      // Hover cannot be simulated here, so instead of pretending to check it
      // this reads the shipping stylesheet's own rule order. The three states
      // share one specificity, so the order *is* the behaviour, and a rule
      // moved below :hover would silently repaint every unread row on mouse
      // over.

      // Exact selector match, not a substring. The is-unread selector is also
      // the prefix of the ::before and the descendant rules, and a substring
      // test against the background selector quietly matched those instead.
      // CSSOM selectorText carries no trailing brace, so the selector is
      // compared on its own.
      const ruleIndex = (selector) => {
        const sheet = [...document.styleSheets].find((s) => (s.href || '').endsWith('styles.css'));
        if (!sheet) return -1;
        const rules = [...sheet.cssRules];
        return rules.findIndex((r) => r.selectorText === selector);
      };

      add('the unread wash is declared before the hover background', () => {
        const unread = ruleIndex('.chat-item.is-unread');
        const hover = ruleIndex('.chat-item:hover');
        return unread > -1 && hover > -1 && unread < hover
          || ('unread rule at ' + unread + ', hover rule at ' + hover);
      });

      add('the unread wash is declared before the open-row background', () => {
        const unread = ruleIndex('.chat-item.is-unread');
        const active = ruleIndex('.chat-item.is-active');
        return unread > -1 && active > -1 && unread < active
          || ('unread rule at ' + unread + ', active rule at ' + active);
      });

      // Report from the page, decide the exit code in Node: the renderer has
      // no process object to exit with.
      return JSON.stringify(cases.map(([name, ok, detail]) => [name, ok, detail]));
     } catch (err) {
       return JSON.stringify({ error: (err && err.message) + ' @ ' + (err && err.stack || '').split('\\n')[1] });
     }
    })()
  `;

  await app.whenReady();
  // Expire on our own rather than being killed from outside, which would pop
  // an Electron error dialog that looks like the app under test crashing.
  harnessGuard(app, { label: 'check:unread' });
  const win = new BrowserWindow({ show: false, width: 420, height: 720 });
  // A real file:// page, because a data: URL cannot import an ES module.
  await win.loadFile(path.join(__dirname, 'unread-harness.html'));
  const out = JSON.parse(await win.webContents.executeJavaScript(harness, true));
  app.exit(0);

  if (out && out.error) {
    console.error('harness threw: ' + out.error);
    process.exit(1);
  }

  let failed = 0;
  for (const [name, ok, detail] of out) {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
  }
  console.log(`\n${out.length - failed}/${out.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
