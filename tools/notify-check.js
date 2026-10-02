/**
 * Dev check: exercises the notification policy without needing a live message.
 * Run with `npm run check:notify`.
 */
const { shouldNotify, notificationBody } = require('../src/main/notify');

const base = {
  notifyEnabled: true,
  notifyPreview: 'full',
  notifyMutedChats: false,
  notifySound: true,
  notifyWhenFocused: false,
};
const bg = { windowFocused: false, windowVisible: true, chat: { title: 'Mike', isMuted: false } };
const fg = { windowFocused: true, windowVisible: true, chat: { title: 'Mike', isMuted: false } };
const muted = { windowFocused: false, windowVisible: true, chat: { title: 'Mike', isMuted: true } };

const cases = [
  // the master switch
  ['notifications off, in background', { ...bg }, { ...base, notifyEnabled: false }, false],
  ['notifications off, window focused', { ...fg }, { ...base, notifyEnabled: false, notifyWhenFocused: true }, false],
  ['notifications on, in background', { ...bg }, base, true],
  ['notifications on, window focused', { ...fg }, base, false],
  ['notifications on, focused + opt in', { ...fg }, { ...base, notifyWhenFocused: true }, true],

  // muted chats
  ['muted chat, default', muted, base, false],
  ['muted chat, opt in', muted, { ...base, notifyMutedChats: true }, true],

  // never notify yourself, even from another device
  ['own message is suppressed', bg, base, false, { messageIsOwn: true }],
  ['own message, notifications on + focused opt-in', fg, { ...base, notifyWhenFocused: true }, false, { messageIsOwn: true }],

  // missing prefs must fail closed, not crash
  ['no prefs at all', bg, null, false],
];

const messageCases = [
  ['full preview, text', { senderName: 'Mike Fazio', text: 'see you at 6' }, 'full', 'Mike Fazio: see you at 6'],
  ['sender preview', { senderName: 'Mike Fazio', text: 'see you at 6' }, 'sender', 'Mike Fazio'],
  ['no preview', { senderName: 'Mike Fazio', text: 'see you at 6' }, 'none', 'New message'],
  ['own message drops the name', { isSender: true, text: 'ok' }, 'full', 'ok'],
  ['attachment counted', { senderName: 'Mike', attachments: [{}, {}, {}] }, 'full', 'Mike: 3 attachments'],
  ['one attachment', { senderName: 'Mike', attachments: [{}] }, 'full', 'Mike: 1 attachment'],
  ['type as fallback', { senderName: 'Mike', type: 'IMAGE' }, 'full', 'Mike: image'],
  ['no sender, no text', {}, 'full', 'New message'],
];

let failed = 0;

for (const [name, state, prefs, want, extra = {}] of cases) {
  const got = shouldNotify({ ...state, prefs, ...extra });
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (want ${want}, got ${got})`}`);
}

for (const [name, entry, mode, want] of messageCases) {
  const got = notificationBody(entry, mode);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (want "${want}", got "${got}")`}`);
}

console.log(`\n${cases.length + messageCases.length - failed}/${cases.length + messageCases.length} checks passed`);
process.exit(failed ? 1 : 0);
