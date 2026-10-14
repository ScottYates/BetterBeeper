/**
 * Dev check: the sidebar preview line follows a `message.upserted` frame.
 *
 * Found live: with a chat open, new messages rendered in the thread and the
 * row for that same chat in the inbox beside it kept showing an older message.
 *
 * Nothing was broken in any way the other checks could see. The frame parsed,
 * no field was missing, the API surface was unchanged, and the sidebar's own
 * rowSignature correctly includes the preview text. The defect was upstream of
 * all of that: `GET /v1/chats/{chatID}` returns the plain Chat schema, which
 * has no `preview` field, while `GET /v1/chats` returns ChatWithPreview, which
 * does. Merging the former over the cached chat therefore left the old preview
 * standing, the signature never moved, and the row was never rebuilt.
 *
 * So these cases assert the merge itself rather than the rendering. The control
 * case is the important one: a merge WITHOUT the preview reapplied is asserted
 * to keep the stale preview, which is what proves the check is measuring the
 * fix and not just agreeing with itself.
 *
 * Run with `npm run check:preview`.
 */
import { newestPreviewEntry, mergeChatSummary, messageOrderKey } from '../src/renderer/js/chat-preview.js';

let fails = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
  if (!cond) fails += 1;
};

const msg = (id, sortKey, over = {}) => ({
  id, chatID: 'chat-1', sortKey, timestamp: '2026-10-14T10:00:00.000Z',
  type: 'TEXT', text: `text ${id}`, ...over,
});

// --- the frame scan --------------------------------------------------------

ok(
  'a single-entry frame yields that entry',
  newestPreviewEntry({ entries: [msg('m1', '0001')] })?.id === 'm1',
);
ok(
  'a frame with no entries yields nothing',
  newestPreviewEntry({ entries: [] }) === null && newestPreviewEntry({}) === null,
);
ok(
  'a frame with no entries property yields nothing',
  newestPreviewEntry(undefined) === null,
);

const batch = { entries: [msg('m1', '0001'), msg('m3', '0003'), msg('m2', '0002')] };
ok(
  'a batch picks the newest by sortKey, not the last entry',
  newestPreviewEntry(batch)?.id === 'm3',
  'entries arrived out of order, so position is not a proxy for recency',
);

ok(
  'a deleted message is not previewed',
  newestPreviewEntry({ entries: [msg('m1', '0001'), msg('m2', '0002', { isDeleted: true })] })?.id === 'm1',
);
ok(
  'a hidden message is not previewed',
  newestPreviewEntry({ entries: [msg('m1', '0001'), msg('m2', '0002', { isHidden: true })] })?.id === 'm1',
);
ok(
  'an entry with no id is ignored',
  newestPreviewEntry({ entries: [msg('m1', '0001'), { sortKey: '0009' }] })?.id === 'm1',
);
ok(
  'a frame of only deleted messages yields nothing',
  newestPreviewEntry({ entries: [msg('m1', '0001', { isDeleted: true })] }) === null,
);
ok(
  'timestamp is the fallback when sortKey is absent',
  newestPreviewEntry({
    entries: [
      { id: 'a', timestamp: '2026-10-14T10:00:00.000Z' },
      { id: 'b', timestamp: '2026-10-14T11:00:00.000Z' },
    ],
  })?.id === 'b',
);
ok(
  'sortKey wins over timestamp when both are present',
  messageOrderKey(msg('m', '0001', { timestamp: '2099-01-01T00:00:00.000Z' })) === '0001',
);

// --- the merge, which is the actual regression -----------------------------

const cached = { id: 'chat-1', title: 'Sam', unreadCount: 3, preview: msg('old', '0001') };
// This is a real getChat response: no `preview` key anywhere in it.
const fromGetChat = { id: 'chat-1', title: 'Sam', unreadCount: 4 };

// The control. This is the old code, and it is why the bug was invisible:
// a field the incoming object does not have cannot participate in a spread,
// so the stale preview survives the merge untouched.
const withoutFix = { ...cached, ...fromGetChat };
ok(
  'CONTROL: a merge with no preview reapplied keeps the stale one',
  withoutFix.preview?.id === 'old',
  'if this ever fails the check is not measuring the thing it claims to',
);

const incoming = msg('new', '0005', { text: 'the message you are looking at' });
const merged = mergeChatSummary(cached, fromGetChat, incoming, 'chat-1');

ok('the merge replaces the stale preview', merged.preview?.id === 'new');
ok('the merge keeps the incoming chat fields', merged.unreadCount === 4 && merged.title === 'Sam');
ok('the merge stamps the chat ID onto the preview', merged.preview?.chatID === 'chat-1');
ok(
  'a spread cannot drop a field the incoming object does not have',
  Object.prototype.hasOwnProperty.call(fromGetChat, 'preview') === false
    && ({ ...cached, ...fromGetChat }).preview?.id === 'old'
    && ({ preview: incoming, ...fromGetChat }).preview?.id === 'new',
  'this is the mechanism the bug hid behind, in both orders',
);

const noEntry = mergeChatSummary(cached, fromGetChat, null, 'chat-1');
ok(
  'a chat.upserted frame carries no message and leaves the preview alone',
  noEntry.preview?.id === 'old',
);

const coldStart = mergeChatSummary(undefined, fromGetChat, incoming, 'chat-1');
ok('the merge works when the chat was not cached at all', coldStart.preview?.id === 'new');

// --- the row contract this depends on --------------------------------------
// chatPreviewText reads chat.preview, so a moved preview is what changes the
// sidebar signature. Asserted against the real function rather than restated.
const { chatPreviewText } = await import('../src/renderer/js/state.js');
ok(
  'the sidebar preview text follows the merged preview',
  chatPreviewText(merged) === 'the message you are looking at',
  'got ' + JSON.stringify(chatPreviewText(merged)),
);

console.log(`\n${fails ? 'FAIL' : 'OK'}  ${fails} failing of the cases above.`);
process.exit(fails ? 1 : 0);