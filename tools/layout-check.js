/**
 * Dev check: a message bubble uses the width of the chat pane.
 *
 * The bug this exists for: `.msg-bubble-wrap` carried `max-width:
 * min(620px, 72%)`, so on a window with room to spare every message stopped
 * about two thirds of the way across and left a dead column down the right of
 * the thread. The percentage is the part that bit - the 620px alone was never
 * reached at normal window sizes.
 *
 * The check loads the real stylesheet into a harness sized like the actual chat
 * pane and measures the rendered boxes, rather than grepping the CSS, so a rule
 * that still caps the width fails whether it is written as a percentage, a
 * pixel value, or a calc().
 *
 * Run with `npm run check:layout`.
 */
const path = require('path');
const harnessGuard = require('./harness-guard');
const { pathToFileURL } = require('url');

async function main() {
  const { app, BrowserWindow } = require('electron');

  // An isolated profile, so the test cannot inherit a cached stylesheet.
  const os = require('os');
  app.setPath('userData', path.join(os.tmpdir(), 'bb-layout-check-profile'));

  const harness = `
    (() => {
     try {
      const list = document.getElementById('list');
      const wrap = document.getElementById('wrap');
      const bubble = document.getElementById('bubble');
      const shortWrap = document.getElementById('wrap-short');
      const shortBubble = document.getElementById('bubble-short');

      const cs = getComputedStyle(wrap);
      const box = (n) => n.getBoundingClientRect();
      const style = getComputedStyle(list);

      // The room a bubble may actually use is the pane minus the list padding,
      // and for an incoming row minus the avatar and the flex gap beside it.
      // An outgoing row has no avatar and gets the whole width.
      const paneRoom = box(list).width
        - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const rowRoom = (id) => {
        const row = document.getElementById(id);
        const avatar = row.querySelector('.avatar');
        const gap = avatar ? parseFloat(getComputedStyle(row).gap || '0') : 0;
        return box(row).width - (avatar ? box(avatar).width : 0) - gap;
      };

      // Chromium hands back the specified value unresolved, so
      // "min(100%, 880px)" arrives as a string and parseFloat of it is NaN.
      // The only trustworthy answer is to let the engine resolve it: give a
      // probe a box exactly as wide as the pane and ask how wide it gets.
      const effectiveCap = (value, against) => {
        const holder = document.createElement('div');
        holder.style.cssText = 'position:absolute;left:-9999px;top:0;';
        holder.style.width = (against || paneRoom) + 'px';
        const probe = document.createElement('div');
        probe.style.cssText = 'position:absolute;visibility:hidden;height:1px;';
        probe.style.width = value;
        holder.appendChild(probe);
        document.body.appendChild(holder);
        const measured = probe.getBoundingClientRect().width;
        holder.remove();
        return measured;
      };

      const cases = [];
      const add = (name, fn) => {
        let ok = false;
        let detail = '';
        try { const r = fn(); ok = r === true; if (r !== true) detail = String(r); }
        catch (e) { ok = false; detail = e.message; }
        cases.push([name, ok, detail]);
      };

      add('a long message uses the full width of its row', () => {
        const used = box(bubble).width;
        const room = rowRoom('msg');
        return used > room - 2
          || ('bubble ' + used.toFixed(1) + 'px of ' + room.toFixed(1) + 'px available');
      });

      add('a long outgoing message uses the full width of its row', () => {
        const used = box(document.getElementById('bubble-out')).width;
        const room = rowRoom('msg-out');
        return used > room - 2
          || ('bubble ' + used.toFixed(1) + 'px of ' + room.toFixed(1) + 'px available');
      });

      add('the wrap cap can never be the limiting factor at this pane width', () => {
        // A min() of 620px and 72% resolves to a pixel value, so testing the
        // string for a "%" misses it. What matters is the resolved number: if
        // it is below the room available, the cap is what is holding the
        // bubble in.
        const cap = effectiveCap(cs.maxWidth);
        return cap >= paneRoom - 0.5
          || ('cap ' + cs.maxWidth + ' (' + cap.toFixed(1) + 'px) is under the ' + paneRoom.toFixed(1) + 'px pane');
      });

      add('the rule is not the old fixed cap', () => {
        const max = cs.maxWidth;
        return !(max === '620px' || max === 'min(620px, 72%)')
          || ('max-width is still ' + max);
      });

      add('a short message still hugs its text', () => {
        // Filling the pane must not mean every bubble stretches edge to edge.
        const short = box(shortBubble).width;
        return short < paneRoom / 2
          || ('short bubble is ' + short.toFixed(1) + 'px of ' + paneRoom.toFixed(1) + 'px');
      });

      // --- the composer -----------------------------------------------------
      // It auto-grew to 180px as the text wrapped, pushing the thread up and
      // leaving the newest message riding the top of the window.

      const composer = document.getElementById('composer');

      add('the composer is one line tall when empty', () => {
        const h = box(composer).height;
        return h > 20 && h < 60 || ('height ' + h.toFixed(1) + 'px is not one line');
      });

      add('the composer does not grow when a long message is typed', () => {
        const before = box(composer).height;
        composer.value = 'This is a deliberately long message that would certainly wrap '
          + 'onto several lines if the box still auto-grew, which is exactly what it used to do.';
        const after = box(composer).height;
        composer.value = '';
        return Math.abs(after - before) < 0.5
          || ('grew from ' + before.toFixed(1) + 'px to ' + after.toFixed(1) + 'px');
      });

      add('a long message scrolls sideways instead of wrapping', () => {
        composer.value = 'This is a deliberately long message that would certainly wrap '
          + 'onto several lines if the box still auto-grew, which is exactly what it used to do.';
        const cs = getComputedStyle(composer);
        composer.value = '';
        const noWrap = cs.whiteSpace === 'pre' || cs.whiteSpace === 'pre-wrap';
        const scrolls = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
        return noWrap && scrolls
          || ('white-space ' + cs.whiteSpace + ', overflow-x ' + cs.overflowX);
      });

      add('the composer has no height cap to grow into', () => {
        // max-height is what the old auto-grow respected, so its return would
        // silently bring the behaviour back.
        const cs = getComputedStyle(composer);
        return cs.maxHeight === 'none'
          || ('max-height is ' + cs.maxHeight + ', so the box can still grow');
      });

      add('a Shift+Enter newline can still be scrolled back to', () => {
        // Enter sends, but Shift+Enter types a real newline. With
        // overflow-y hidden those rows exist and cannot be seen, which is
        // worse than the box growing ever was.
        const before = box(composer).height;
        // Escaped twice on purpose: this harness is a template literal, so a
        // bare \\n would land in the page script as a real line break and turn
        // the string below into an unterminated literal.
        composer.value = 'first line\\nsecond line\\nthird line';
        const cs = getComputedStyle(composer);
        const reaches = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
        const held = Math.abs(box(composer).height - before) < 0.5;
        composer.value = '';
        return reaches && held
          || ('overflow-y ' + cs.overflowY + ', height held: ' + held);
      });

      add('the composer fits inside the pane', () => {
        const field = composer.closest('.composer-field');
        return box(field).right <= box(list).right + 1
          || ('field right ' + box(field).right.toFixed(1) + ' vs list right ' + box(list).right.toFixed(1));
      });

      add('the bubble does not overflow the pane', () => {
        return box(wrap).right <= box(list).right + 1
          || ('wrap right ' + box(wrap).right.toFixed(1) + ' vs list right ' + box(list).right.toFixed(1));
      });

      return JSON.stringify({
        cases: cases,
        metrics: {
          paneRoom: paneRoom.toFixed(1),
          incomingRowRoom: rowRoom('msg').toFixed(1),
          bubbleWidth: box(bubble).width.toFixed(1),
          shortBubbleWidth: box(shortBubble).width.toFixed(1),
          maxWidth: cs.maxWidth,
          effectiveCap: effectiveCap(cs.maxWidth).toFixed(1),
        },
      });
     } catch (err) {
       return JSON.stringify({ error: (err && err.message) + ' @ ' + (err && err.stack || '').split('\\n')[1] });
     }
    })()
  `;

  await app.whenReady();
  // Expire on our own rather than being killed from outside, which would pop
  // an Electron error dialog that looks like the app under test crashing.
  harnessGuard(app, { label: 'check:layout' });
  const win = new BrowserWindow({ show: false, width: 900, height: 700 });
  await win.loadFile(path.join(__dirname, 'layout-harness.html'));
  const out = JSON.parse(await win.webContents.executeJavaScript(harness, true));
  app.exit(0);
  if (out.error) {
    console.error('harness threw: ' + out.error);
    process.exit(1);
  }

  let failed = 0;
  for (const [name, ok, detail] of out.cases) {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
  }
  console.log(`\nmeasured: ${JSON.stringify(out.metrics)}`);
  console.log(`${out.cases.length - failed}/${out.cases.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
