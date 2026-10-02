/**
 * Dev check: the message HTML sanitizer must keep the structure of the markup
 * it allows through.
 *
 * The bug this exists for: the sanitizer appended a cleaned element and then
 * appended the element's sanitized children as its *siblings*, so every allowed
 * element rendered empty with its content hoisted next to it. A plain <p> still
 * looked fine because the text survived, which is why it went unnoticed, but
 * lists came out as an empty <ul> followed by loose <li>s, <em> and <strong>
 * lost their emphasis, and <a> stopped being a link.
 *
 * Run with `npm run check:rich`.
 */
const path = require('path');
const harnessGuard = require('./harness-guard');
const { pathToFileURL } = require('url');

const utilPath = path.join(__dirname, '..', 'src', 'renderer', 'js', 'util.js');

// util.js uses DOM globals, so exercise it in a browser via Electron.
async function main() {
  const { app, BrowserWindow } = require('electron');

  // An isolated profile, so the test can never read a cached copy of util.js.
  // Chromium caches file:// modules in userData, which means a dev run of the
  // real app can happily execute a stale renderer after the file changed. A
  // check that inherits that is not a check.
  const os = require('os');
  app.setPath('userData', path.join(os.tmpdir(), 'bb-rich-check-profile'));

  const src = pathToFileURL(utilPath).href;
  const harness = `
    (async () => {
      const { renderRichText } = await import(${JSON.stringify(src)});

      // Parse a rendered fragment so assertions can talk about structure
      // rather than about exact markup.
      const parse = (html) => {
        const d = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
        return d.body.firstElementChild;
      };

      const cases = [];
      const add = (name, fn) => {
        let ok = false;
        let detail = '';
        try { const r = fn(); ok = r === true; if (r !== true) detail = String(r); }
        catch (e) { ok = false; detail = e.message; }
        cases.push([name, ok, detail]);
      };

      add('paragraph keeps its text inside the p', () => {
        const root = parse(renderRichText('<p>hello world</p>'));
        const p = root.querySelector('p');
        return !!p && p.textContent.trim() === 'hello world' || ('p text was: ' + JSON.stringify(p && p.textContent));
      });

      add('list items stay inside their ul', () => {
        const root = parse(renderRichText('<ul><li>one</li><li>two</li></ul>'));
        const ul = root.querySelector('ul');
        if (!ul) return 'no ul survived';
        const items = [...root.querySelectorAll('li')];
        if (items.length !== 2) return 'expected 2 li, got ' + items.length;
        const inside = items.every((li) => li.parentElement === ul);
        const text = items.map((li) => li.textContent.trim()).join(',');
        return (inside && text === 'one,two') || ('li parent/text was: ' + inside + ' / ' + text);
      });

      add('list has no text between the items', () => {
        // The failure mode that reads worst on screen: empty list elements with
        // the content as loose siblings.
        const root = parse(renderRichText('<ul><li>one</li><li>two</li></ul>'));
        return root.children.length === 1 && root.children[0].tagName === 'UL' || ('ul had siblings: ' + [...root.children].map((c) => c.tagName).join(','));
      });

      add('ordered list keeps its numbering markup', () => {
        const root = parse(renderRichText('<ol><li>first</li><li>second</li></ol>'));
        const ol = root.querySelector('ol');
        if (!ol) return 'no ol survived';
        const items = [...ol.querySelectorAll('li')];
        return items.length === 2 || ('expected 2 li inside ol, got ' + items.length);
      });

      add('link stays a link with its text', () => {
        const root = parse(renderRichText('<p>see <a href="https://example.com/x">the docs</a></p>'));
        const a = root.querySelector('a');
        if (!a) return 'no anchor survived';
        const href = a.getAttribute('href') || '';
        return (href === 'https://example.com/x' && a.textContent.trim() === 'the docs') || ('href/text: ' + href + ' / ' + a.textContent);
      });

      add('emphasis keeps its text inside the em', () => {
        const root = parse(renderRichText('<p>a little more <em>you</em></p>'));
        const em = root.querySelector('em');
        return !!em && em.textContent.trim() === 'you' || ('em text: ' + JSON.stringify(em && em.textContent));
      });

      add('strong and code keep their text', () => {
        const root = parse(renderRichText('<p><strong>bold</strong> and <code>x = 1</code></p>'));
        const s = root.querySelector('strong');
        const c = root.querySelector('code');
        return (s && s.textContent.trim() === 'bold' && c && c.textContent.trim() === 'x = 1') || 'strong/code text lost';
      });

      add('fenced code block keeps its body inside pre', () => {
        const root = parse(renderRichText('\`\`\`\\nconst a = 1;\\n\`\`\`'));
        const pre = root.querySelector('pre');
        if (!pre) return 'no pre survived';
        return pre.textContent.includes('const a = 1;') || ('pre text: ' + JSON.stringify(pre.textContent));
      });

      add('html code block keeps its body inside code', () => {
        // The fenced case above takes the plain-text path, so it never reaches
        // the sanitizer. This one does, and it broke the same way.
        const root = parse(renderRichText('<pre><code>const a = 1;</code></pre>'));
        const code = root.querySelector('pre > code');
        return !!code && code.textContent.trim() === 'const a = 1;' || ('code text: ' + JSON.stringify(code && code.textContent));
      });

      add('pretty-printed list keeps no newline text nodes', () => {
        // Beeper sends HTML indented across lines. Under white-space: pre-wrap
        // those newlines render, which showed up as a blank line under every
        // bullet.
        const root = parse(renderRichText('<ul>\\n<li>one</li>\\n<li>two</li>\\n</ul>'));
        const ul = root.querySelector('ul');
        const stray = [...ul.childNodes].filter((n) => n.nodeType === 3 && n.data.trim() === '');
        return stray.length === 0 || ('stray whitespace nodes inside ul: ' + stray.length);
      });

      add('pretty-printed body keeps no newline between blocks', () => {
        const root = parse(renderRichText('<p>intro</p>\\n<p>outro</p>'));
        const stray = [...root.childNodes].filter((n) => n.nodeType === 3 && n.data.trim() === '');
        return stray.length === 0 || ('stray whitespace nodes at top level: ' + stray.length);
      });

      add('inline spacing between tags is preserved', () => {
        // The opposite mistake: this space is content, not formatting.
        const root = parse(renderRichText('<p><strong>a</strong> <em>b</em> and <code>c</code></p>'));
        return root.textContent.replace(/\\s+/g, ' ').trim() === 'a b and c' || ('text: ' + JSON.stringify(root.textContent));
      });

      add('inline newlines the sender typed are preserved', () => {
        const root = parse(renderRichText('<p>first line\\nsecond line</p>'));
        return root.textContent.includes('\\n') || ('expected a kept newline, got: ' + JSON.stringify(root.textContent));
      });

      add('space inside a list item is preserved', () => {
        const root = parse(renderRichText('<ul>\\n<li>one <em>two</em> words</li>\\n</ul>'));
        const li = root.querySelector('li');
        return li && li.textContent.replace(/\\s+/g, ' ').trim() === 'one two words' || ('li text: ' + JSON.stringify(li && li.textContent));
      });

      add('blockquote keeps its text', () => {
        const root = parse(renderRichText('<blockquote>quoted line</blockquote>'));
        const bq = root.querySelector('blockquote');
        return !!bq && bq.textContent.trim() === 'quoted line' || 'blockquote text lost';
      });

      add('nested markup keeps its shape', () => {
        const root = parse(renderRichText('<blockquote><p>quote with <strong>bold</strong></p></blockquote>'));
        const strong = root.querySelector('blockquote strong');
        return !!strong && strong.textContent.trim() === 'bold' || 'nested strong lost';
      });

      add('disallowed tags are unwrapped, text kept', () => {
        const root = parse(renderRichText('<p>keep <script>alert(1)</script><marquee>this</marquee></p>'));
        const text = root.textContent;
        return (text.includes('keep') && text.includes('this') && !root.querySelector('script') && !root.querySelector('marquee')) || ('text: ' + text);
      });

      add('event handler attributes are stripped', () => {
        const root = parse(renderRichText('<p onclick="steal()">text</p><img src=x onerror=steal()>'));
        return (root.querySelector('p') && !root.querySelector('p').hasAttribute('onclick') && !root.querySelector('img')) || 'unsafe attribute or img survived';
      });

      add('javascript: hrefs are removed', () => {
        const root = parse(renderRichText('<p><a href="javascript:alert(1)">click</a></p>'));
        const a = root.querySelector('a');
        return !!a && !a.hasAttribute('href') || 'javascript href survived';
      });

      // Report from the page, decide the exit code in Node: the renderer has
      // no process object to exit with.
      return JSON.stringify(cases.map(([name, ok, detail]) => [name, ok, detail]));
    })()
  `;

  await app.whenReady();
  // Expire on our own rather than being killed from outside, which would pop
  // an Electron error dialog that looks like the app under test crashing.
  harnessGuard(app, { label: 'check:rich' });
  const win = new BrowserWindow({ show: false });
  // A real file:// page, because a data: URL cannot import an ES module.
  await win.loadFile(path.join(__dirname, 'rich-harness.html'));
  const result = await win.webContents.executeJavaScript(harness, true);
  app.exit(0);
  return JSON.parse(result);
}

main()
  .then((cases) => {
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
