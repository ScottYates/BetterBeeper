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
import { api, call } from './api.js';
import { state, upsertMessage, isMessageHidden, isMessageDeleted } from './state.js';
import { decodeEntities, clipText } from './entities.js';
import { toast } from './ui.js';

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
