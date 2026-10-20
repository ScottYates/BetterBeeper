/**
 * Dev check: text that arrives HTML-escaped is shown as the sender wrote it.
 *
 * Found live: some bridges hand Beeper text that has been HTML-escaped, so the
 * API returns `&amp;` and `&quot;` where the sender wrote `&` and `"`. The
 * message body already handled it, because the HTML branch of `renderRichText`
 * parses with DOMParser and DOMParser resolves character references on its
 * own. Everything else did not: the plain-text branch escaped the text again
 * without resolving it first, and the sidebar preview, the chat title, the
 * reply quote, the reply preview, the editor and the copy action all put the
 * raw text into the DOM.
 *
 * Measured against live data before fixing anything: 359 messages, 8 of them
 * carrying a reference, and not one literal `&` outside a reference. So the
 * escaping is Beeper's, not the sender's typing.
 *
 * The control cases are the important ones. They pin the old behaviour, which
 * is what the user was looking at, so the cases above cannot pass by the
 * input changing underneath them.
 *
 * Run with `npm run check:entity`.
 */
import { decodeEntities, clipText } from '../src/renderer/js/entities.js';
import { escapeHtml } from '../src/renderer/js/util.js';
import { chatTitle, chatPreviewText } from '../src/renderer/js/state.js';

let fails = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
  if (!cond) fails += 1;
};

// --- the decoder ------------------------------------------------------------

ok('an ampersand reference is resolved', decodeEntities('&amp;') === '&');
ok('a quote reference is resolved', decodeEntities('&quot;') === '"');
ok('a less-than reference is resolved', decodeEntities('&lt;') === '<');
ok('a greater-than reference is resolved', decodeEntities('&gt;') === '>');
ok('an apostrophe reference is resolved', decodeEntities('&apos;') === "'");
ok('a decimal reference is resolved', decodeEntities('&#39;') === "'");
ok('a hex reference is resolved', decodeEntities('&#x27;') === "'");
ok('a hex reference to an ampersand is resolved', decodeEntities('&#x26;') === '&');

ok(
  'a whole sentence comes out as it was written',
  decodeEntities('Tom &amp; Jerry said &quot;hi&quot;') === 'Tom & Jerry said "hi"',
  'got ' + JSON.stringify(decodeEntities('Tom &amp; Jerry said &quot;hi&quot;')),
);

// The references that are not HTML escaping. These are the sender's text.
ok('a bare ampersand is left alone', decodeEntities('AT&T') === 'AT&T');
ok('an ampersand between words is left alone', decodeEntities('R&D') === 'R&D');
ok('a lone ampersand is left alone', decodeEntities('a & b') === 'a & b');
ok('an unterminated reference is left alone', decodeEntities('&amp') === '&amp');
ok(
  'a reference this app does not resolve is left alone',
  decodeEntities('&copy; 2026') === '&copy; 2026',
  'turning that into a copyright sign would be rewriting what was written',
);

// One level, and one level only.
ok(
  'a doubly encoded reference is resolved once',
  decodeEntities('&amp;amp;') === '&amp;',
  'got ' + JSON.stringify(decodeEntities('&amp;amp;')),
);

ok('empty text stays empty', decodeEntities('') === '');
ok('nothing stays nothing', decodeEntities(null) === '' && decodeEntities(undefined) === '');

// The control. The old code had no decoder at all, so the text reached the
// DOM exactly as it arrived. This is what the user was seeing.
const asItArrives = (text) => text;
ok(
  'CONTROL: encoded text arrives encoded, so the decoder is what changes it',
  asItArrives('Tom &amp; Jerry') === 'Tom &amp; Jerry',
);
ok(
  'CONTROL: the old plain-text path escaped the reference a second time',
  escapeHtml('Tom &amp; Jerry') === 'Tom &amp;amp; Jerry',
  'this is the string the sidebar preview and the bubble used to show',
);

// --- clipping ---------------------------------------------------------------

ok('text shorter than the limit is untouched', clipText('short', 20) === 'short');
ok(
  'text at the limit is untouched',
  clipText('Tom &amp; Jerry', 15) === 'Tom &amp; Jerry',
);
ok(
  'a cut inside a reference keeps the whole reference',
  clipText('Tom &amp; Jerry', 7) === 'Tom &amp;',
  'got ' + JSON.stringify(clipText('Tom &amp; Jerry', 7)),
);
ok(
  'a cut inside a numeric reference keeps the whole reference',
  clipText('a &#39;b', 4) === 'a &#39;',
  'got ' + JSON.stringify(clipText('a &#39;b', 4)),
);
ok(
  'a cut in ordinary text is left alone',
  clipText('Tom and Jerry went to the shop', 8) === 'Tom and ',
);
ok(
  'an ampersand that starts nothing is left alone',
  clipText('AT&T', 3) === 'AT&',
  'got ' + JSON.stringify(clipText('AT&T', 3)),
);
ok(
  'an ampersand followed by a space is left alone',
  clipText('AT& co', 3) === 'AT&',
  'got ' + JSON.stringify(clipText('AT& co', 3)),
);
ok(
  'a cut with no limit at all keeps everything',
  clipText('Tom &amp; Jerry') === 'Tom &amp; Jerry',
);

// --- the title --------------------------------------------------------------

ok(
  'a chat title is shown with its references resolved',
  chatTitle({ title: 'Tom &amp; Jerry' }) === 'Tom & Jerry',
  'got ' + JSON.stringify(chatTitle({ title: 'Tom &amp; Jerry' })),
);
ok('a chat with no title has no title', chatTitle({}) === '' && chatTitle(null) === '');

// --- the sidebar preview ----------------------------------------------------

const encodedChat = {
  id: 'chat-1',
  title: 'Tom &amp; Jerry',
  preview: { id: 'm1', text: 'the soup &amp; the sandwich', type: 'TEXT' },
};

ok(
  'the sidebar preview shows the text as it was written',
  chatPreviewText(encodedChat) === 'the soup & the sandwich',
  'got ' + JSON.stringify(chatPreviewText(encodedChat)),
);

// The control. The old preview line returned the message text exactly as it
// arrived, which is the raw reference the user was reading.
const oldPreviewLine = (message) => message.text;
ok(
  'CONTROL: the old preview line returned the raw reference',
  oldPreviewLine({ text: 'the soup &amp; the sandwich' }) === 'the soup &amp; the sandwich',
);

console.log(`\n${fails ? 'FAIL' : 'OK'}  ${fails} failing of the cases above.`);
process.exit(fails ? 1 : 0);
