/** Modals: start a new chat, share a message with someone, and app settings. */

import { $, el, clear, debounce, escapeHtml, initials, hueFor, fullTime, renderRichText } from './util.js';
import { api, call } from './api.js';
import { state, bus, chatList, chatTitle, upsertChat, deletedList, clearDeletedMessages, CHAT_PAGE, noteChatPage, chatPageState } from './state.js';
import { openModal, closeModal, toast } from './ui.js';
import { avatarNode } from './sidebar.js';
import {
  shareText,
  shareQueue,
  shareableChats,
  partitionShareable,
  chatDisplayName,
  canShare,
  shareNotice,
  CHAT_CHUNK,
} from './share.js';
import {
  targetKey,
  chatTarget,
  contactTarget,
  toggleSelection,
  orderedTargets,
  buildPlan,
  deliverPlan,
  retryableTargets,
  unsentTargets,
  planSendCount,
  selectionSummary,
  sentSummary,
  runSummary,
  SENT,
  FAILED,
  STOPPED,
} from './share-queue.js';
import { setJobStats } from './jobs.js';
import { checkNow } from './updates.js';
import { participantList, participantPhone, participantDetail } from './participants.js';

/**
 * Text-size presets, as [zoom factor, label]. 1 is the size the UI was designed
 * at; the percentage is shown so the choice is unambiguous. The main process
 * clamps whatever lands here into 0.5-3.
 */
const TEXT_SCALES = [
  [0.9, 'Small (90%)'],
  [1, 'Default (100%)'],
  [1.15, 'Large (115%)'],
  [1.3, 'Larger (130%)'],
  [1.5, 'Largest (150%)'],
];

/**
 * Where a new build is ever published. GitHub resolves /releases/latest to the
 * newest tag, so this link cannot go stale the way a pinned version URL would.
 */
export const RELEASES_URL = 'https://github.com/ScottYates/BetterBeeper/releases/latest';

/**
 * The running version, for the About row in settings.
 *
 * Says "unknown" rather than falling back to a plausible-looking number: a
 * settings panel that quietly claims 1.0.0 when it has not loaded the real
 * version is worse than one that admits it does not know.
 */
export function versionLabel(version) {
  const value = String(version ?? state.appVersion ?? '').trim();
  return value ? `Better Beeper ${value}` : 'Better Beeper (version unknown)';
}

/** How many messages are hidden on this device, in words. */
function deletedCountText() {
  const n = deletedList().length;
  if (!n) return 'None';
  return `${n} hidden on this device`;
}

/** Human-readable size. Same scale the thread uses for attachments. */
function bytesLabel(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * The History section's numbers, filled in once the main process answers.
 *
 * Rendered as a placeholder and then filled rather than awaited inline, so
 * opening Settings never waits on a disk walk to size the media folder.
 */
function historyStatRow() {
  const row = el('div', { class: 'history-stats-inner' }, el('span', { class: 'muted tiny', text: 'Measuring…' }));

  call(() => api.history.status(), { context: 'history', fallback: null }).then((s) => {
    if (!s) {
      row.replaceChildren(el('span', { class: 'muted tiny', text: 'History is not available yet.' }));
      return;
    }
    // Keep the sidebar's idle line honest without making it its own source of
    // truth: Settings already measures the totals, so hand them over.
    setJobStats(s);
    const syncing = s.running ? 'Fetching older messages…' : s.queued ? `${s.queued} chat${s.queued === 1 ? '' : 's'} queued` : 'Up to date';
    row.replaceChildren(
      el('div', { class: 'form-row' }, el('label', { text: 'Stored' }), el('span', { text: `${s.messages || 0} message${s.messages === 1 ? '' : 's'} in ${s.chats || 0} chat${s.chats === 1 ? '' : 's'}` })),
      el('div', { class: 'form-row' }, el('label', { text: 'Database' }), el('span', { text: bytesLabel(s.bytes) })),
      el('div', { class: 'form-row' }, el('label', { text: 'Attachments' }), el('span', { text: s.mediaCount ? `${s.mediaCount} file${s.mediaCount === 1 ? '' : 's'}, ${bytesLabel(s.mediaBytes)}` : 'None yet' })),
      el('div', { class: 'form-row' }, el('label', { text: 'Status' }), el('span', { text: syncing })),
    );
  });

  return row;
}

// ---------------------------------------------------------------------------
// New chat
// ---------------------------------------------------------------------------

/**
 * Everyone in a conversation.
 *
 * A group's title is Beeper's own summary and it hides people behind an
 * ellipsis - "Eric, Hallie, Mike & 2 others" names three of five and says
 * nothing about the other two. The app is handed every one of them and shows
 * none of them, so this is where they are.
 *
 * The order and the naming live in participants.js so they can be checked
 * rather than read.
 *
 * The phone number is not in the chat record - Beeper's bridge does not send
 * one - so it is read separately, from Beeper Desktop's own store, keyed by
 * the same id the bridge hands out. The list opens straight away with the
 * names, and the numbers arrive a moment later. Waiting for them would mean
 * a blank list for as long as the read takes, and there is nothing in the
 * names that the numbers change.
 */
export function openParticipants(chat) {
  const { people, hidden } = participantList(chat);

  const list = el('div', { class: 'result-list' });
  // The rows that are waiting for a number, and the line under them, which
  // changes when the number arrives: a number shown beside the name is not
  // repeated underneath it.
  const waiting = new Map();

  for (const person of people) {
    const phone = el('span', { class: 'result-item-phone' });
    const sub = el('div', { class: 'result-item-sub' });
    list.append(
      el(
        'div',
        { class: 'result-item is-static' },
        avatarNode(person.participant, person.name, 'sm'),
        el(
          'div',
          { class: 'result-item-body' },
          el(
            'div',
            { class: 'result-item-line' },
            el('span', { class: 'result-item-name', text: person.name }),
            phone,
            person.tags.length
              ? el('span', { class: 'result-item-tag', text: person.tags.join(' · ') })
              : null,
          ),
          sub,
        ),
      ),
    );
    waiting.set(person.id, { phone, sub });
  }

  const body = el(
    'div',
    {},
    people.length
      ? list
      : el('div', { class: 'search-summary', text: 'Nobody else is in this conversation.' }),
    hidden
      ? el('div', {
          class: 'search-summary',
          text: `and ${hidden} more not shown`,
        })
      : null,
  );

  const who = people.length === 1 ? '1 person' : `${people.length} people`;
  openModal({
    title: `${chatTitle(chat) || 'Conversation'} - ${who}`,
    body,
    footer: [el('button', { class: 'btn', text: 'Close', onClick: closeModal })],
  });

  // The numbers, once they are read.
  if (!people.length) return;
  const ids = people.map((person) => person.id);
  call(() => api.participants.numbers(ids), { context: 'phone numbers', fallback: {} }).then((numbers) => {
    for (const person of people) {
      const slots = waiting.get(person.id);
      if (!slots) continue;
      const number = participantPhone(person.participant, numbers);
      if (number) slots.phone.textContent = number;
      const detail = participantDetail(person.participant, number);
      slots.sub.textContent = detail;
      if (!detail) slots.sub.remove();
    }
  });
}

export function openNewChat() {
  const results = el('div', { class: 'result-list' });
  const summary = el('div', { class: 'search-summary', text: 'Search your contacts to start a conversation.' });

  const search = el('input', {
    type: 'search',
    placeholder: 'Search contacts…',
    autocomplete: 'off',
    spellcheck: 'false',
  });

  let selection = new Map(); // contactID -> contact

  const selectedBar = el('div', { class: 'search-summary' });
  const createBtn = el('button', {
    class: 'btn btn-primary',
    text: 'Start chat',
    disabled: true,
    onClick: createChat,
  });

  const accountSelect = el('select');
  for (const account of state.accounts) {
    accountSelect.append(
      el('option', {
        value: account.accountID,
        text: `${account.network || account.accountID} · ${account.user?.fullName || account.user?.username || ''}`,
      }),
    );
  }
  const connected = state.accounts.filter((a) => a.status === 'connected');
  if (connected.length) {
    accountSelect.value = connected[0].accountID;
  }

  const body = el(
    'div',
    {},
    el('div', { class: 'form-row' }, el('label', { text: 'Account' }), accountSelect),
    el('div', { class: 'form-row' }, search),
    summary,
    results,
    selectedBar,
  );

  openModal({
    title: 'New chat',
    body,
    footer: [el('button', { class: 'btn', text: 'Cancel', onClick: closeModal }), createBtn],
  });

  search.addEventListener(
    'input',
    debounce(async () => {
      const query = search.value.trim();
      if (!query) {
        summary.textContent = 'Search your contacts to start a conversation.';
        clear(results);
        return;
      }
      const accountID = accountSelect.value;
      if (!accountID) {
        summary.textContent = 'No account selected.';
        return;
      }
      summary.textContent = 'Searching…';
      const res = await call(() => api.contacts(accountID, { query, limit: 40 }), {
        context: 'contacts',
        fallback: null,
      });
      if (!res) {
        summary.textContent = 'Could not load contacts for that account.';
        return;
      }
      const items = res.items || [];
      summary.textContent = items.length
        ? `${items.length} contact${items.length === 1 ? '' : 's'}`
        : 'No contacts matched. Beeper can only search contacts it has synced for this bridge.';

      clear(results);
      for (const contact of items) {
        const contactID = contact.id || contact.userID;
        if (!contactID) continue;
        const node = el(
          'div',
          {
            class: `result-item${selection.has(contactID) ? ' is-selected' : ''}`,
            dataset: { contactId: contactID },
            onClick: () => {
              if (selection.has(contactID)) selection.delete(contactID);
              else selection.set(contactID, contact);
              node.classList.toggle('is-selected', selection.has(contactID));
              node.querySelector('.result-check')?.remove();
              if (selection.has(contactID)) node.append(el('span', { class: 'result-check', text: '✓' }));
              updateSelected();
            },
          },
          avatarNode(contact, contact.fullName || contact.username || '?', 'sm'),
          el(
            'div',
            { class: 'result-item-body' },
            el('div', { class: 'result-item-title', text: contact.fullName || contact.username || contact.phoneNumber || contactID }),
            el('div', {
              class: 'result-item-sub',
              text: contact.username || contact.phoneNumber || contact.email || contactID,
            }),
          ),
        );
        results.append(node);
      }
    }, 300),
  );

  function updateSelected() {
    const count = selection.size;
    selectedBar.textContent = count ? `${count} selected` : '';
    createBtn.disabled = count === 0;
  }

  async function createChat() {
    const accountID = accountSelect.value;
    const contactIDs = [...selection.keys()];
    if (!accountID || !contactIDs.length) return;

    createBtn.disabled = true;
    createBtn.textContent = 'Creating…';

    const single = contactIDs.length === 1;
    const res = await call(
      () =>
        api.chats.create({
          accountID,
          type: single ? 'single' : 'group',
          participantIDs: contactIDs,
          title: single ? undefined : contactIDs.map((id) => selection.get(id)?.fullName).filter(Boolean).join(', '),
        }),
      { context: 'create chat', throwOnError: true },
    ).catch((err) => ({ __error: err }));

    if (res?.__error) {
      toast(res.__error.message, 'error', 5000);
      createBtn.disabled = false;
      createBtn.textContent = 'Start chat';
      return;
    }

    const chatID = res?.id || res?.chatID;
    closeModal();
    toast('Chat created', 'success', 1800);
    if (chatID) {
      upsertChat(res);
      bus.emit('chats:changed');
      bus.emit('chat:open', chatID);
    }
  }
}

// ---------------------------------------------------------------------------
// Share a message with someone else
// ---------------------------------------------------------------------------

/** Said when the box has nothing left in it to send. */
const NOTHING_TO_SEND = 'There is nothing to send - add some text, or keep a file.';

/**
 * Who a message can be shared with.
 *
 * One list holding two kinds of target: the chats that already exist, and the
 * contacts that do not have one yet. Both are needed - sharing into a chat you
 * have to go and create first is not sharing, and it is the common case when
 * you are forwarding something to someone you have never messaged.
 *
 * The decisions - what counts as shareable, what the forwarded text says, how
 * many sends it turns into - live in share.js so they can be checked on their
 * own. What is here is the picking and the sending.
 */
export function openSharePicker(message, sourceChat) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const source = chatDisplayName(sourceChat);

  // Editable before it goes. The value is set as a property rather than passed
  // through el(), which sets attributes: a textarea has no value attribute, so
  // the text would silently arrive empty.
  const draft = el('textarea', { class: 'share-edit', rows: '4', placeholder: 'Add a message...' });
  draft.value = shareText(message);

  const results = el('div', { class: 'result-list' });
  const contactResults = el('div', { class: 'result-list' });
  // The list scrolls on its own. The box and the search above it stay where
  // they are, and the rows move underneath them, so the list can be three
  // hundred chats long without pushing the search off the top of the modal.
  const scroll = el('div', { class: 'share-scroll' }, results, contactResults);
  const summary = el('div', { class: 'search-summary' });
  const selectedLine = el('div', { class: 'search-summary' });
  const runList = el('div', { class: 'share-run' });
  const runSummaryLine = el('div', { class: 'search-summary' });

  // The two halves of the picker. The picking half is hidden when the run
  // starts, and the run half is hidden until then, so there is one thing on
  // screen at a time rather than a form that has become meaningless.
  const pickBox = el('div', { class: 'share-pick' });
  const runBox = el('div', { class: 'share-run-wrap' });
  runBox.style.display = 'none';

  const search = el('input', {
    type: 'search',
    placeholder: 'Search chats and contacts...',
    autocomplete: 'off',
    spellcheck: 'false',
  });

  // The destinations picked, in the order they were picked, because that is
  // the order they are sent in.
  let selected = [];

  // Every chat on offer, in the Inbox's order.
  //
  // The rows on screen are a window over this list: they are drawn a chunk
  // at a time, and the count underneath says how many there are in all
  // rather than how many happen to be on screen.
  let matches = [];
  // The chats whose rows are already drawn, so a row is never drawn twice
  // and a page of new chats can be added to the end of the list.
  const drawnIds = new Set();
  // How many read-only chats were left out, and how many contacts are on
  // offer.
  let readOnlyCount = 0;
  let contactCount = 0;
  // A page of chats is on its way from Beeper.
  let paging = false;
  // The list is being filled in.
  let filling = false;

  /**
   * How far before the end of the list the fill happens.
   *
   * A little before the end rather than at it, so the next rows are there
   * before the user reaches for them.
   */
  const FILL_AHEAD = 160;
  // Every destination on offer, by key, so a pick survives a redraw.
  const targets = new Map();
  // key -> the row on screen: a pick is a class change, not a rebuild.
  const rowNodes = new Map();
  // key -> the row in the run list.
  const runRows = new Map();
  // What the last run did, one entry per destination.
  let outcomes = [];
  // A run is in flight.
  let busy = false;
  // The run was told to stop, and ends after the destination it is on.
  let stopping = false;
  // The picker was closed, so nothing may be drawn after this.
  let closed = false;

  const sendButton = el('button', { class: 'btn btn-primary', text: 'Send', onClick: () => startRun() });
  const retryButton = el('button', { class: 'btn', text: 'Retry', onClick: () => startRetry() });
  const againButton = el('button', { class: 'btn', text: 'Send the rest', onClick: () => sendStopped() });
  const cancelButton = el('button', {
    class: 'btn',
    text: 'Cancel',
    onClick: () => { if (busy) stop(); else closeModal(); },
  });
  retryButton.hidden = true;
  againButton.hidden = true;

  /**
   * What would be sent if a target were picked right now.
   *
   * Read at the moment of sending rather than captured when the picker opened:
   * the whole point of the box is that the text can change in between.
   */
  const outgoing = () => ({ text: draft.value.trim(), attachments });

  function setSummary(text) {
    summary.textContent = text;
  }

  /**
   * One row on offer.
   *
   * A click ticks the row and sends nothing. The send is the button's job,
   * because the button is also where the count of what is about to happen is
   * said, and a click cannot say that.
   */
  function row({ title, sub, avatar, target, list = results }) {
    const key = targetKey(target);
    const node = el(
      'div',
      { class: 'result-item', onClick: () => toggle(target) },
      avatar,
      el(
        'div',
        { class: 'result-item-body' },
        el('div', { class: 'result-item-title', text: title }),
        sub ? el('div', { class: 'result-item-sub', text: sub }) : null,
      ),
    );
    list.append(node);
    rowNodes.set(key, node);
    return node;
  }

  /** Tick a destination, or untick it. */
  function toggle(target) {
    if (busy) return;
    const key = targetKey(target);
    if (!key) return;
    selected = toggleSelection(selected, key);
    paintSelection();
  }

  /**
   * What is picked, and what picking it will do.
   *
   * The count of messages is said here rather than after the fact, because
   * four messages turning up in somebody else's chat is not something to
   * discover afterwards.
   */
  function paintSelection() {
    const chosen = chosenTargets();
    for (const [key, node] of rowNodes) {
      const on = selected.includes(key);
      node.classList.toggle('is-selected', on);
      // The tick is the same one the New chat picker uses, so the two
      // multi-selects in the app look like each other.
      const ticked = node.querySelector('.result-check');
      if (on && !ticked) node.append(el('span', { class: 'result-check', text: '✓' }));
      if (!on && ticked) ticked.remove();
    }
    const queue = currentQueue();
    if (!queue) {
      selectedLine.textContent = NOTHING_TO_SEND;
      sendButton.disabled = true;
      return;
    }
    const plan = buildPlan(chosen, queue);
    selectedLine.textContent = selectionSummary(chosen.length, planSendCount(plan));
    sendButton.textContent = chosen.length === 0
      ? 'Send'
      : chosen.length === 1
        ? `Send to ${chosen[0].label}`
        : `Send to ${chosen.length} people`;
    sendButton.disabled = busy || chosen.length === 0;
  }

  // A share can be several messages, so say so before it happens rather than
  // letting four messages turn up in someone else's chat unexplained.
  const header = shareNotice(message);

  // What it is being shared from, for the person deciding where to send it. Not
  // part of the message: the outgoing text is whatever is in the box below, and
  // nothing else.
  const from = [
    message.senderName ? `From ${message.senderName}` : '',
    source ? source : '',
  ].filter(Boolean).join(' in ');

  // The children are filtered before they are appended.
  //
  // The native append takes a null as the text "null", so a picker that
  // appends a missing file line as a null says "null" in the middle of
  // itself - on every share of a message that has no files, which is the
  // ordinary case.
  pickBox.append(...[
    from ? el('div', { class: 'share-source', text: from }) : null,
    draft,
    attachments.length
      ? el('div', {
          class: 'share-files',
          text: `${attachments.length} file${attachments.length === 1 ? '' : 's'} going along: `
            + attachments.map((a) => a.fileName || 'attachment').join(', '),
        })
      : null,
    el('div', { class: 'form-row' }, search),
    el('div', { class: 'share-notice', text: header }),
    selectedLine,
    scroll,
    summary,
  ].filter(Boolean));
  runBox.append(runList, runSummaryLine);

  openModal({
    title: 'Share with...',
    // The wrapper holds the two halves of the picker, the picking half and
    // the run half, and only one of them is ever on screen.
    body: el('div', { class: 'share-body' }, pickBox, runBox),
    // The body does not scroll: the list inside it does, and two scrollers
    // over one list is a list nobody can scroll.
    bodyClass: 'share-modal',
    footer: [cancelButton, againButton, retryButton, sendButton],
    // Closing mid-run stops the queue. The destinations that were not reached
    // are not sent, and the toast says how far it got before it stopped.
    onClose: () => {
      closed = true;
      if (busy) stopping = true;
    },
  });

  search.focus();

  /**
   * The queue for whatever is in the box now.
   *
   * Emptying the text of a message that had no files leaves nothing to send, so
   * that is caught here rather than being handed to Beeper as a blank message.
   */
  function currentQueue() {
    const payload = outgoing();
    if (!canShare(payload)) return null;
    return shareQueue(payload, payload.text);
  }

  /** The destinations that are ticked, in the order they were ticked. */
  function chosenTargets() {
    return orderedTargets([...targets.values()], selected);
  }

  /** Send to everything that is ticked. */
  async function startRun() {
    if (busy) return;
    const queue = currentQueue();
    if (!queue) return complain();
    const chosen = chosenTargets();
    if (!chosen.length) return;
    await run(chosen, queue, true);
  }

  /** Send again the parts of a failed destination that did not go. */
  async function startRetry() {
    if (busy) return;
    const left = retryableTargets(outcomes);
    if (!left.length) return;
    await run(left, null, false);
  }

  /** Send the destinations the run never reached. */
  async function sendStopped() {
    if (busy) return;
    const stopped = outcomes.filter((o) => o.state === STOPPED);
    const left = unsentTargets(outcomes).filter((t) => stopped.some((o) => o.key === t.key));
    if (!left.length) return;
    await run(left, null, false);
  }

  /**
   * The run itself.
   *
   * Everything is frozen once it starts, so it cannot be done twice, and the
   * picker turns into the list of what happened - one row per destination,
   * because a share to six people that quietly failed for one of them is not
   * something to find out from a toast.
   */
  async function run(targetsToSend, payloads, reset) {
    const plan = buildPlan(targetsToSend, payloads);
    busy = true;
    stopping = false;
    renderRun(plan, reset);
    pickBox.style.display = 'none';
    runBox.style.display = 'block';
    lock();

    const res = await deliverPlan(plan, shareIO());
    outcomes = mergeOutcomes(outcomes, res.outcomes);
    busy = false;

    paintOutcomes();
    finish();
  }

  /** Everything is frozen once a send starts, so it cannot be done twice. */
  function lock() {
    search.disabled = true;
    draft.disabled = true;
    sendButton.disabled = true;
    cancelButton.textContent = 'Stop';
  }

  /** Stop the run after the destination it is on. */
  function stop() {
    if (!busy) return;
    stopping = true;
    if (!closed) runSummaryLine.textContent = 'Stopping after this one...';
  }

  /** One row per destination in the run list. */
  function renderRun(plan, reset) {
    if (reset) {
      clear(runList);
      runRows.clear();
    }
    for (const target of plan) {
      if (runRows.has(target.key)) continue;
      const node = el(
        'div',
        { class: 'share-run-row', dataset: { key: target.key, state: 'waiting' } },
        el('span', { class: 'share-run-name', text: target.label }),
        el('span', { class: 'share-run-state', text: 'Waiting' }),
      );
      runList.append(node);
      runRows.set(target.key, node);
    }
  }

  /** Say what happened to each destination. */
  function paintOutcomes() {
    for (const outcome of outcomes) {
      const node = runRows.get(outcome.key);
      if (!node) continue;
      node.dataset.state = outcome.state;
      const state = node.querySelector('.share-run-state');
      if (state) state.textContent = stateText(outcome);
    }
  }

  function stateText(outcome) {
    if (outcome.state === SENT) {
      return outcome.sent > 1 ? `Sent (${outcome.sent} messages)` : 'Sent';
    }
    if (outcome.state === FAILED) return `Failed - ${outcome.error || 'could not be sent'}`;
    if (outcome.state === STOPPED) return 'Not sent';
    return 'Waiting';
  }

  /**
   * Fold a second run into what the first one did.
   *
   * The counts add up, so a destination that took two files and then one more
   * on a retry says three, not one.
   */
  function mergeOutcomes(prev, next) {
    const byKey = new Map((prev || []).map((o) => [o.key, o]));
    for (const outcome of next || []) {
      const before = byKey.get(outcome.key);
      byKey.set(
        outcome.key,
        before ? { ...outcome, sent: (before.sent || 0) + (outcome.sent || 0) } : outcome,
      );
    }
    return [...byKey.values()];
  }

  /**
   * The end of a run.
   *
   * Everything that went closes the picker. Anything that did not keeps it
   * open, because a retry needs somewhere to live, and a picker that has
   * closed cannot be retried from.
   */
  function finish() {
    const failed = outcomes.filter((o) => o.state === FAILED);
    const stopped = outcomes.filter((o) => o.state === STOPPED);
    const line = runSummary(outcomes);

    if (!closed) {
      runSummaryLine.textContent = line;
      retryButton.textContent = failed.length ? `Retry ${failed.length} failed` : 'Retry';
      retryButton.hidden = !failed.length;
      againButton.textContent = stopped.length ? `Send ${stopped.length} more` : 'Send the rest';
      againButton.hidden = !stopped.length;
      sendButton.hidden = true;
      cancelButton.textContent = 'Close';
    }

    if (!failed.length && !stopped.length) {
      closeModal();
      toast(sentSummary(outcomes), 'success', 2400);
      return;
    }
    toast(line || 'Some of it did not go.', 'error', 6000);
  }

  /**
   * The network, for one run.
   *
   * A contact's chat is started when the run reaches it, and the id is kept,
   * so a retry sends into the same chat instead of starting a second one.
   */
  function shareIO() {
    return {
      resolveChat: async (target) => {
        if (target.chatID) return target.chatID;
        if (target.kind !== 'contact') return '';
        // The chat is created empty and the queue is sent into it afterwards,
        // the same way it is sent into a chat that already existed. Beeper does
        // take an opening message with a new chat, and using it here would mean
        // the text went out twice over the moment the first message had an
        // attachment.
        const created = await call(
          () =>
            api.chats.create({
              accountID: sourceChat?.accountID || connectedAccountID(),
              type: 'single',
              participantIDs: [target.id],
            }),
          { context: 'start a chat to share into', throwOnError: true },
        );
        const chatID = created?.id || created?.chatID;
        if (chatID) {
          upsertChat(created);
          bus.emit('chats:changed');
        }
        return chatID || '';
      },
      // A reupload that resolves to nothing is a failure, not an empty result:
      // `call` returns its fallback for a falsy value, and passing that
      // straight on would send the message with the file quietly dropped.
      reupload: async (attachment) => {
        const uploaded = await call(() => api.assets.reupload(attachment), {
          context: 'copy the file for the other chat',
          throwOnError: true,
        });
        if (!uploaded) throw new Error('The file could not be copied to the other chat.');
        return uploaded;
      },
      send: (chatID, payload) =>
        call(() => api.messages.send(chatID, payload), {
          context: 'send the shared message',
          throwOnError: true,
        }),
      shouldStop: () => stopping,
    };
  }

  /** The box was emptied of everything there was to send. The picker stays open. */
  function complain() {
    setSummary(NOTHING_TO_SEND);
    paintSelection();
  }

  /**
   * All chats and contacts matching what has been typed so far.
   *
   * Two lists rather than one: the contacts search takes a round trip, and
   * appending into a single list after that await meant either losing the chats
   * or redrawing them while the user was already clicking on them.
   *
   * The chats are worked out in full and then drawn a chunk at a time. The
   * count underneath is of everything that matched, not of the rows that
   * happen to be on screen: a list that says "50 chats" when there are two
   * hundred is a count that cannot be trusted.
   */
  async function refresh() {
    const query = recompute();
    clear(results);
    clear(contactResults);
    // The rows are rebuilt, so the row map is rebuilt with them. The picks
    // themselves live in `selected` and do not care: a destination that is
    // still ticked stays ticked, even while it is off the screen.
    rowNodes.clear();
    drawnIds.clear();
    contactCount = 0;
    drawChunk();

    // Contacts only once there is something to search for: everyone Beeper has
    // synced is a long list nobody asked to scroll.
    if (query) {
      const accountID = connectedAccountID();
      if (accountID) {
        contactResults.append(el('div', { class: 'search-summary', text: 'Searching contacts...' }));
        const res = await call(
          () => api.contacts(accountID, { query, limit: 20 }),
          { context: 'contacts to share with', fallback: null },
        );
        if (closed) return;
        clear(contactResults);
        for (const contact of res?.items || []) {
          if (!contact.id && !contact.userID) continue;
          const target = contactTarget(
            contact,
            contact.fullName || contact.username || contact.phoneNumber || 'Contact',
          );
          targets.set(targetKey(target), target);
          contactCount += 1;
          row({
            list: contactResults,
            title: target.label,
            sub: `Start a new chat - ${contact.username || contact.phoneNumber || contact.email || 'contact'}`,
            avatar: avatarNode(contact, contact.fullName || contact.username || '?', 'sm'),
            target,
          });
        }
      }
    }

    paintSummary(query);

    // The ticks are drawn again after every redraw: a search rebuilds the
    // rows, and a pick that was on screen has to still be on screen.
    paintSelection();
  }

  /**
   * Work out what is on offer.
   *
   * The whole list, not a screenful of it: the Inbox's chats that are not the
   * chat the message came from, the ones matching what has been typed, and
   * the read-only ones counted but not offered.
   */
  function recompute() {
    const query = search.value.trim();
    const found = shareableChats(chatList(), { sourceChatID: sourceChat?.id || '', query });
    const parts = partitionShareable(found);
    matches = parts.writable;
    readOnlyCount = parts.readOnly.length;
    return query;
  }

  /**
   * Draw the next chunk of rows.
   *
   * A chunk at a time, because a list of three hundred rows is a list nobody
   * can read, and one row at a time is a list that takes a minute to appear.
   * The rows already on screen are not drawn again.
   */
  function drawChunk() {
    const pending = matches.filter((chat) => !drawnIds.has(chat.id));
    const end = Math.min(CHAT_CHUNK, pending.length);
    for (let i = 0; i < end; i += 1) {
      const chat = pending[i];
      drawnIds.add(chat.id);
      const target = chatTarget(chat, chatDisplayName(chat));
      targets.set(targetKey(target), target);
      row({
        title: target.label,
        sub: chat.network ? `Chat on ${chat.network}` : 'Chat',
        avatar: avatarNode(chat, initials(target.label) || '?', 'sm'),
        target,
      });
    }
    return end;
  }

  /**
   * Say what is on offer.
   *
   * The count is of everything that matched, not of the rows on screen.
   */
  function paintSummary(query) {
    const hidden = readOnlyCount
      ? ` ${readOnlyCount} read-only chat${readOnlyCount === 1 ? '' : 's'} left out - they cannot receive messages.`
      : '';
    const parts = [];
    if (matches.length) parts.push(`${matches.length} chat${matches.length === 1 ? '' : 's'}`);
    if (contactCount) parts.push(`${contactCount} contact${contactCount === 1 ? '' : 's'}`);
    if (!parts.length) {
      setSummary(query ? `Nothing matched "${query}".${hidden}` : `No chats to share into yet.${hidden}`);
      return;
    }
    setSummary(parts.join(', ') + '.' + hidden);
  }

  /**
   * Is the user at the end of the list?
   */
  function atEnd() {
    return scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - FILL_AHEAD;
  }

  /**
   * Fill the list in as the user reaches the end of it.
   *
   * Two steps, in this order: draw what is already loaded, and only then ask
   * Beeper for the next page. Asking first would fetch chats the picker
   * already has.
   */
  async function fillMore() {
    if (busy || closed || filling) return;
    filling = true;
    try {
      if (drawChunk()) {
        paintSelection();
        return;
      }
      await loadNextPage();
    } finally {
      filling = false;
    }
  }

  /**
   * Ask Beeper for the chats after the ones already loaded.
   *
   * The app loads two pages of chats when it starts and the account has more
   * than that, so the list the picker can offer is longer than the list it
   * was handed. The cursor for the next page was recorded when the page
   * before it was read.
   */
  async function loadNextPage() {
    if (paging) return;
    const { cursor, hasMore } = chatPageState();
    if (!hasMore || !cursor) return;
    paging = true;
    try {
      const res = await call(
        () => api.chats.list({ limit: CHAT_PAGE, cursor, direction: 'before' }),
        { context: 'more chats to share with', fallback: null },
      );
      if (res) {
        for (const chat of res.items || []) upsertChat(chat);
        noteChatPage(res.oldestCursor, res.hasMore);
      }
    } finally {
      paging = false;
    }
    if (closed) return;
    // The new chats may match what was typed, so the list is worked out again.
    // The rows already on screen stay where they are.
    recompute();
    drawChunk();
    paintSummary(search.value.trim());
    paintSelection();
  }

  search.addEventListener('input', debounce(refresh, 200));
  // The count of what is about to be sent depends on what is in the box, so
  // editing the box moves it.
  draft.addEventListener('input', () => paintSelection());
  // The list fills in as the user reaches the end of it.
  scroll.addEventListener('scroll', () => { if (atEnd()) fillMore(); });
  // A list too short to scroll has no scroll event of its own, and the wheel
  // is then the only sign that the user has reached the end of it.
  scroll.addEventListener('wheel', () => {
    if (scroll.scrollHeight <= scroll.clientHeight && atEnd()) fillMore();
  }, { passive: true });
  refresh();
}

function connectedAccountID() {
  const connected = state.accounts.filter((a) => a.status === 'connected');
  return connected[0]?.accountID || state.accounts[0]?.accountID || '';
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function openSettings() {
  const settings = (await call(() => api.settings.get(), { context: 'settings' })) || {};
  state.settings = { ...state.settings, ...settings };

  const theme = el('select');
  for (const value of ['system', 'dark', 'light']) {
    theme.append(el('option', { value, text: value, selected: (settings.theme || 'system') === value }));
  }
  const sendOnEnter = el('input', { type: 'checkbox', checked: settings.sendOnEnter !== false });
  const markReadOnOpen = el('input', { type: 'checkbox', checked: settings.markReadOnOpen !== false });

  // Text size. The value is a page-zoom factor; 1 is the designed size. The
  // percentage is shown so the choice does not have to be guessed at.
  const savedScale = Number(settings.textScale);
  const currentScale = Number.isFinite(savedScale) && savedScale > 0 ? savedScale : 1;
  const textScale = el('select');
  for (const [value, label] of TEXT_SCALES) {
    textScale.append(el('option', { value: String(value), text: label, selected: Math.abs(currentScale - value) < 0.001 }));
  }
  // A stored factor that is not one of the presets (hand-edited, or clamped in
  // the main process) still has to show something sensible rather than snap
  // the dropdown to an unrelated value.
  if (!TEXT_SCALES.some(([value]) => Math.abs(currentScale - value) < 0.001)) {
    textScale.append(el('option', {
      value: String(currentScale),
      text: `Custom (${Math.round(currentScale * 100)}%)`,
      selected: true,
    }));
  }

  const autoUpdates = el('input', { type: 'checkbox', checked: settings.autoUpdates !== false });

  const notifyEnabled = el('input', { type: 'checkbox', checked: settings.notifyEnabled !== false });
  const notifyPreview = el('select');
  for (const [value, label] of [
    ['full', 'Sender and message text'],
    ['sender', 'Sender only'],
    ['none', 'Nothing — just "New message"'],
  ]) {
    notifyPreview.append(el('option', { value, text: label, selected: (settings.notifyPreview || 'full') === value }));
  }
  const notifyMutedChats = el('input', { type: 'checkbox', checked: settings.notifyMutedChats === true });
  const notifySound = el('input', { type: 'checkbox', checked: settings.notifySound !== false });
  const notifyWhenFocused = el('input', {
    type: 'checkbox',
    checked: settings.notifyWhenFocused === true,
  });

  // The sub-options are meaningless with notifications off, so dim them.
  const notifyOptions = el(
    'div',
    { class: 'notify-options' },
    el(
      'div',
      { class: 'form-row' },
      el('label', { text: 'Show in the notification' }),
      notifyPreview,
    ),
    el(
      'label',
      { class: 'form-row row-check', style: { display: 'flex', gap: '9px', alignItems: 'center' } },
      notifyMutedChats,
      el('span', { text: 'Also notify for muted chats' }),
    ),
    el(
      'label',
      { class: 'form-row row-check', style: { display: 'flex', gap: '9px', alignItems: 'center' } },
      notifySound,
      el('span', { text: 'Play a sound' }),
    ),
    el(
      'label',
      { class: 'form-row row-check', style: { display: 'flex', gap: '9px', alignItems: 'center' } },
      notifyWhenFocused,
      el('span', { text: 'Notify even while this window is focused' }),
    ),
  );

  const syncNotifyOptions = () => {
    notifyOptions.classList.toggle('is-disabled', !notifyEnabled.checked);
    for (const input of notifyOptions.querySelectorAll('input, select')) input.disabled = !notifyEnabled.checked;
  };
  notifyEnabled.addEventListener('change', syncNotifyOptions);
  syncNotifyOptions();

  const body = el(
    'div',
    {},
    // History first, on purpose. The modal body caps at 86vh and scrolls, and this
    // section measured 302-550 inside a 107-484 body - present in the DOM,
    // answering every "is it there" check, and 66px below the fold where nobody
    // would ever scroll to find it. A history store that quietly fills the disk
    // and a backfill the user cannot see are both things you only find out
    // about too late, so the numbers go where they cannot be missed.
    el('h4', { text: 'History', style: { marginBottom: '10px' } }),
    // Measured, never estimated. "Fully self-contained" is worth very little
    // if it quietly fills the disk, so the real numbers are on screen.
    el('div', { class: 'history-stats' }, historyStatRow()),
    el('p', {
      class: 'hint',
      style: { marginTop: '-6px', marginBottom: '18px' },
      text: 'Every message you open is kept on this computer, so history survives a restart and search reaches further back than Beeper can. Beeper still decides what exists.',
    }),

    // First of the rest on purpose. The modal body scrolls, and this section sat 240px below
    // the fold at a 115% text scale - which is the same as not existing: it was
    // in the DOM, every check that asked whether it was *there* passed, and
    // nobody could find it. The only way back after deleting a message on this
    // device has to be visible without scrolling.
    el('h4', { text: 'Messages', style: { marginBottom: '10px' } }),
    el(
      'div',
      { class: 'form-row' },
      el('label', { text: 'Deleted on this device' }),
      // There is no per-message restore any more, so this is the only way back.
      // It saves first and clears second: a failed save that had already wiped
      // the list would show the messages again for this session only, and then
      // silently put them back on the next start.
      (() => {
        const count = el('span', { class: 'muted tiny', text: deletedCountText() });
        const btn = el('button', {
          class: 'btn btn-sm',
          text: 'Clear list',
          disabled: deletedList().length === 0,
          onClick: async () => {
            btn.disabled = true;
            const saved = await call(() => api.settings.set({ deletedMessages: [] }), {
              context: 'clear deleted messages',
            });
            if (!saved) {
              btn.disabled = false;
              toast('Could not clear the deleted list', 'error');
              return;
            }
            state.settings = saved;
            const restored = clearDeletedMessages();
            count.textContent = deletedCountText();
            // The thread filters these messages out, so it has to redraw for
            // them to come back rather than just flipping a flag.
            bus.emit('messages:changed', { chatID: state.activeChatID });
            toast(
              `${restored} message${restored === 1 ? '' : 's'} shown again`,
              'success',
              2000,
            );
          },
        });
        return el('div', { class: 'clear-deleted-row' }, count, btn);
      })(),
      el('p', {
        class: 'hint',
        text: 'Deleting on this device removes a message from this app only; Beeper keeps it. Clearing the list makes those messages visible again.',
      }),
    ),

    el('button', {
      class: 'btn btn-sm',
      text: 'Show available MCP tools',
      style: { marginBottom: '22px' },
      onClick: () => showToolsCatalog(),
    }),

    el('h4', { text: 'Behaviour', style: { marginBottom: '10px' } }),
    el(
      'div',
      { class: 'form-row' },
      el('label', { text: 'Theme' }),
      theme,
    ),
    el(
      'div',
      { class: 'form-row' },
      el('label', { text: 'Text size' }),
      textScale,
    ),
    el(
      'label',
      { class: 'form-row', style: { display: 'flex', gap: '9px', alignItems: 'center' } },
      sendOnEnter,
      el('span', { text: 'Press Enter to send (Shift+Enter for a new line)' }),
    ),
    el(
      'label',
      { class: 'form-row', style: { display: 'flex', gap: '9px', alignItems: 'center' } },
      markReadOnOpen,
      el('span', { text: 'Mark a chat as read when I open it' }),
    ),

    el('h4', { text: 'Notifications', style: { margin: '20px 0 10px' } }),
    el(
      'label',
      { class: 'form-row', style: { display: 'flex', gap: '9px', alignItems: 'center' } },
      notifyEnabled,
      el('span', { text: 'Show desktop notifications' }),
    ),
    notifyOptions,

    el('h4', { text: 'Connection', style: { margin: '20px 0 10px' } }),
    el('p', { class: 'muted tiny', id: 'settings-connection' }),
    el('button', {
      class: 'btn btn-sm',
      text: 'Disconnect from Beeper',
      style: { marginTop: '10px' },
      onClick: async () => {
        const res = await call(() => api.disconnect(), { context: 'disconnect' });
        if (res !== null) {
          closeModal();
          window.location.reload();
        }
      },
    }),

    el('h4', { text: 'About', style: { margin: '20px 0 10px' } }),
    el(
      'label',
      { class: 'form-row', style: { display: 'flex', gap: '9px', alignItems: 'center' } },
      autoUpdates,
      el('span', { text: 'Check for updates automatically' }),
    ),
    el('p', {
      class: 'muted tiny',
      style: { marginTop: '-6px' },
      text: 'Once a day. When one is found it asks before downloading anything.',
    }),
    el(
      'div',
      { class: 'form-row about-row' },
      el('span', { class: 'muted tiny', id: 'settings-version', text: versionLabel() }),
      el('button', {
        class: 'btn btn-sm',
        text: 'Check for updates',
        style: { marginRight: '2px' },
        onClick: async (event) => {
          const btn = event.currentTarget;
          btn.disabled = true;
          btn.textContent = 'Checking...';
          try {
            await checkNow();
          } finally {
            btn.disabled = false;
            btn.textContent = 'Check for updates';
          }
        },
      }),
      el('a', {
        class: 'about-link',
        href: RELEASES_URL,
        title: RELEASES_URL,
        text: 'Get the most recent release',
        // A real link, so it can be copied and middle-clicked, but opened
        // through the main process rather than navigating the app window.
        onClick: (event) => {
          event.preventDefault();
          api.shell.openExternal(RELEASES_URL);
        },
      }),
    ),
  );

  openModal({
    title: 'Settings',
    body,
    footer: [
      el('button', { class: 'btn', text: 'Cancel', onClick: closeModal }),
      el('button', {
        class: 'btn btn-primary',
        text: 'Save',
        onClick: async () => {
          const patch = {
            theme: theme.value,
            textScale: Number(textScale.value),
            sendOnEnter: sendOnEnter.checked,
            markReadOnOpen: markReadOnOpen.checked,
            notifyEnabled: notifyEnabled.checked,
            notifyPreview: notifyPreview.value,
            notifyMutedChats: notifyMutedChats.checked,
            notifySound: notifySound.checked,
            notifyWhenFocused: notifyWhenFocused.checked,
            autoUpdates: autoUpdates.checked,
          };

          const saved = await call(() => api.settings.set(patch), { context: 'save settings' });
          if (saved) {
            state.settings = saved;
            applyTheme(saved.theme);
            closeModal();
            toast('Settings saved', 'success', 1600);
            window.dispatchEvent(new CustomEvent('settings:changed'));
          }
        },
      }),
    ],
  });
}

export function applyTheme(theme) {
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  const resolved = theme === 'system' ? (prefersLight ? 'light' : 'dark') : theme;
  document.documentElement.dataset.theme = resolved;
}

/**
 * What Beeper's MCP server will let a client ask it to do.
 *
 * This outlived the assistant, which was the only thing that ever called the
 * tools. Beeper still runs the server and the app still connects to it, so
 * being able to see the catalogue is the honest reason to keep doing so.
 */
export async function showToolsCatalog() {
  const body = el('div', { class: 'result-list' }, el('p', { class: 'muted', text: 'Loading MCP tools…' }));
  openModal({ title: 'Beeper MCP tools', body });

  const tools = (await call(() => api.mcp.tools(), { context: 'mcp tools', fallback: [] })) || [];
  clear(body);
  if (!tools.length) {
    body.append(el('p', { class: 'muted', text: 'Beeper reported no MCP tools.' }));
    return;
  }
  body.append(
    el('p', { class: 'muted tiny', text: `${tools.length} tools exposed by Beeper’s MCP server:` }),
  );
  for (const tool of tools) {
    body.append(
      el(
        'div',
        { class: 'result-item', style: { cursor: 'default' } },
        el(
          'div',
          { class: 'result-item-body' },
          el('div', { class: 'result-item-title', text: tool.name || '(unnamed)' }),
          tool.description ? el('div', { class: 'result-item-sub', text: tool.description }) : null,
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Message search (accessible from the sidebar search)
// ---------------------------------------------------------------------------

export async function openMessageSearch(query) {
  const body = el('div', { class: 'result-list' }, el('div', { class: 'search-loading', text: 'Searching…' }));
  openModal({ title: `Search: ${query}`, body });

  const res = await call(() => api.messages.search({ query, limit: 50 }), {
    context: 'message search',
    fallback: null,
  });
  clear(body);
  const items = res?.items || [];
  if (!items.length) {
    body.append(el('div', { class: 'empty-note', text: 'No matching messages found.' }));
    return;
  }
  for (const message of items) {
    const chat = state.chats.get(message.chatID);
    body.append(
      el(
        'div',
        {
          class: 'result-item',
          onClick: () => {
            closeModal();
            bus.emit('chat:open', message.chatID, { focusMessageID: message.id });
          },
        },
        avatarNode(chat, chatTitle(chat) || '?', 'sm'),
        el(
          'div',
          { class: 'result-item-body' },
          el('div', { class: 'result-item-sub', text: `${chatTitle(chat) || 'Chat'} · ${message.senderName || ''} · ${fullTime(message.timestamp)}` }),
          el('div', { class: 'result-item-title', html: renderRichText(message.text || '', 160) }),
        ),
      ),
    );
  }
}
