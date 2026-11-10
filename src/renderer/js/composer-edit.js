/**
 * Editing a message you have already sent.
 *
 * The rules that decide what can be edited live in a module of their own,
 * `composer-edit-rules.js`, so they can be checked without a window. This
 * module drives the session: the composer, the banner, and the save.
 *
 * Nothing in this file imports the thread, and the thread imports this file,
 * so the dependency runs one way only.
 */

import { api, call } from './api.js';
import { state, upsertMessage, isMessageHidden, isMessageDeleted } from './state.js';
import { decodeEntities, encodeEntities, clipText } from './entities.js';
import { relative } from './util.js';
import { toast } from './ui.js';
import {
  chatAllowsEdit,
  editMaxAgeSeconds,
  isEditableMessage,
  editableMessages,
  millisOf,
  chatEditRefusal,
  editWindowLabel,
} from './composer-edit-rules.js';

// The rules live in a module of their own, so they can be checked without a
// window. They are re-exported here so that every importer keeps working
// unchanged and the dependency still runs one way only.
export {
  chatAllowsEdit,
  editMaxAgeSeconds,
  isEditableMessage,
  editableMessages,
  millisOf,
  chatEditRefusal,
  editWindowLabel,
};

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
  markEditing: () => {},
  markNotEditable: () => {},
  scrollToMessage: () => {},
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
  if (!chatAllowsEdit(chat)) {
    // The chat cannot edit at all - Google Voice, for one. There is no message
    // to point at, so the explanation is about the chat.
    explainNoEdit();
    return false;
  }

  // A staged attachment has already been uploaded. Dropping it quietly would
  // throw away work, so the arrow refuses instead.
  if (deps.hasPendingAttachments()) {
    toast('Send or remove the attachment before editing', 'error');
    return false;
  }

  const list = candidateMessages();
  if (!list.length) {
    // Nothing here can be edited. Say why, and say which message it was: an
    // arrow that does nothing at all is the same thing as a broken feature.
    explainNoEdit();
    return false;
  }
  return startEdit(list[list.length - 1]);
}

/**
 * Explain why there is nothing to edit, and show the message it would have been.
 *
 * The message is shown because the reason is about a particular message. "Your
 * last message here was sent 4d ago and Signal allows editing for 24 hours" is
 * an answer about that message, and the reader should be looking at it while
 * they read it.
 */
function explainNoEdit() {
  const chat = deps.getChat();
  const refusal = chatEditRefusal(chat, deps.getMessages() || []);
  if (!refusal) return false;

  if (refusal.message) {
    deps.markNotEditable(refusal.message.id);
    deps.scrollToMessage(refusal.message.id);
  }
  toast(refusalMessage(chat, refusal), 'info', 4500);
  return true;
}

/**
 * The sentence the toast is made of.
 *
 * The window is the chat's own, so it is the number Beeper published for that
 * chat rather than a rule written here: fifteen minutes on Messenger,
 * twenty-four hours on Signal, and no limit at all on the note to self.
 */
function refusalMessage(chat, refusal) {
  const window = editWindowLabel(chat);
  switch (refusal.code) {
    case 'chat-cannot-edit':
      return 'This chat does not support editing messages';
    case 'chat-read-only':
      return 'This chat is read-only, so there is nothing to edit';
    case 'no-own-messages':
      return 'You have not sent any messages in this chat yet';
    case 'too-old': {
      const age = refusal.newestOwnAt ? relative(refusal.newestOwnAt) : '';
      const window_ = window ? ` for ${window} after you send them` : '';
      const last = age ? ` Your last one here was sent ${age}.` : '';
      return `Messages can only be edited${window_}.${last}`;
    }
    case 'has-attachment':
      return 'A message with an attachment cannot be edited';
    case 'not-confirmed':
      return 'That message has not been sent yet';
    default:
      return 'There is nothing here to edit';
  }
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
  // The cursor is not placed here on purpose. Putting it at the end of what
  // was loaded is what the focus helper does for every other path into the
  // composer, it runs after this, and a second rule here would only ever be
  // a rule the helper overrules.

  showBanner(original);
  // The bubble being edited is marked. Only the marker moves: drawing the
  // thread again would detach every image in it, which restarts an animated
  // GIF, and it would throw away where the reader was.
  deps.markEditing(message.id);
  // The "this one cannot be edited" mark goes with it: the message it pointed
  // at is now in the composer, and two marks on one bubble would be a puzzle.
  deps.markNotEditable(null);
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
  // The marker is taken off the bubble it was on. Nothing else on screen
  // changes, so the thread is not drawn again: a reply would otherwise
  // rebuild the whole thread for nothing.
  if (render && (had || marked)) deps.markEditing(null);
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

  // Beeper is sent the text as it was typed. The store is sent the encoded
  // text, because that is how a message is stored everywhere else:
  // decoding happens where the text is shown, never in the stored message.
  // Storing the decoded text loses one level of entity resolution - the
  // bubble shows the reference resolved, and the copy on disk keeps it that
  // way for good.
  const stored = {
    ...message,
    text: encodeEntities(text),
    editedTimestamp: new Date().toISOString(),
  };
  upsertMessage(chatID, stored);
  // Written through to the store, or the next start would draw the old text
  // again, from the copy on disk.
  await call(() => api.history.upsert(chatID, stored), { context: 'history', fallback: null });

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
