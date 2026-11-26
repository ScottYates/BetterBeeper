/**
 * Sharing one message with several people.
 *
 * The decisions, kept apart from the picking and the sending so they can be
 * checked without a window, a network, or a Beeper account - the same reason
 * share.js has no imports.
 *
 * Three things make this more than sending the same queue twice:
 *
 *   - Beeper takes one attachment per send, so a message with three files is
 *     three messages, and every one of them needs its own copy of every file
 *     in every destination. Five people and two files is ten messages.
 *   - A failure in one destination says nothing about the next one. A queue
 *     that stopped at the first refusal would leave four people with nothing,
 *     so the run carries on and records what failed.
 *   - A destination that took two of three files before one failed has two
 *     files in the chat already. Sending all three again would put the first
 *     two there a second time, so a retry sends only what did not go.
 */

import { deliverPayloads } from './share.js';

/** What happened to one destination. */
export const SENT = 'sent';
export const FAILED = 'failed';
export const STOPPED = 'stopped';

/**
 * One key per destination.
 *
 * A chat and a contact are different kinds of place, so they get different
 * keys: a contact who also has a chat is one person, and picking both would
 * send them the same message twice.
 */
export function targetKey(target) {
  if (!target) return '';
  const id = target.id || '';
  // A destination with no id is not a destination, and a key of "chat:" would
  // make every one of them look like the same place.
  if (!id) return '';
  if (target.kind === 'contact') return `contact:${id}`;
  return `chat:${id}`;
}

/** A chat that already exists. */
export function chatTarget(chat, label) {
  return {
    kind: 'chat',
    id: chat?.id || '',
    label: label || chat?.title || 'Chat',
    // The chat to send into is known up front, so a retry does not have to
    // find it again.
    chatID: chat?.id || '',
  };
}

/** A contact with no chat yet: one gets started when the run reaches it. */
export function contactTarget(contact, label) {
  return {
    kind: 'contact',
    id: contact?.id || contact?.userID || '',
    label: label || contact?.fullName || contact?.username || 'Contact',
    chatID: '',
  };
}

/**
 * Add a destination to the selection, or take it out again.
 *
 * The order is the order they were picked in, because that is the order they
 * will be sent in, and a person watching a queue expects it to run the way
 * they built it.
 */
export function toggleSelection(selected, key) {
  const list = Array.isArray(selected) ? selected : [];
  if (!key) return [...list];
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
}

/** The destinations in the order they were picked, without the ones that are gone. */
export function orderedTargets(targets, selected) {
  const byKey = new Map((targets || []).map((t) => [targetKey(t), t]));
  const out = [];
  for (const key of selected || []) {
    const target = byKey.get(key);
    if (target) out.push(target);
  }
  return out;
}

/**
 * The run: one entry per destination, in order, each carrying the payloads.
 *
 * A destination may bring its own payloads - a retry sends only what is left
 * of that one - and when it does, they are used. Otherwise every destination
 * shares the list, copied, because each destination needs its own copies of
 * the files and one entry's sends must not change another's.
 */
export function buildPlan(targets, payloads) {
  const list = Array.isArray(targets) ? targets : [];
  const shared = Array.isArray(payloads) ? payloads : [];
  const out = [];
  const seen = new Set();
  for (const target of list) {
    const key = targetKey(target);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const own = Array.isArray(target.payloads) ? target.payloads : null;
    out.push({
      key,
      kind: target.kind,
      id: target.id,
      label: target.label,
      chatID: target.chatID || '',
      payloads: [...(own || shared)],
    });
  }
  return out;
}

/**
 * Send the plan, one destination after another.
 *
 * A failure in one destination does not stop the run: the next one is a
 * different chat with a different person, and stopping would leave them with
 * nothing because somebody else's send was refused. Within one destination the
 * payloads still stop at the first failure, so nobody gets half a conversation.
 *
 * The run stops early only when it is told to - the picker was closed, or the
 * person pressed Stop. The destinations that were not reached are recorded as
 * stopped rather than quietly dropped, so the picker can say how far it got.
 *
 * Never throws. The network is passed in, so this can be run against a
 * recording instead of a real account.
 *
 * @param io  {
 *   resolveChat(target): string|Promise<string>,  - starts a chat for a contact
 *   reupload(attachment): attachment|Promise<attachment>,
 *   send(chatID, payload): void|Promise<void>,
 *   shouldStop(): boolean                        - optional
 * }
 */
export async function deliverPlan(plan, io) {
  const outcomes = [];
  for (const target of plan || []) {
    const payloads = Array.isArray(target.payloads) ? target.payloads : [];
    const outcome = {
      key: target.key,
      kind: target.kind,
      id: target.id,
      label: target.label,
      state: 'waiting',
      sent: 0,
      total: payloads.length,
      error: '',
      chatID: target.chatID || '',
      pending: [...payloads],
    };
    outcomes.push(outcome);

    if (io && typeof io.shouldStop === 'function' && io.shouldStop()) {
      outcome.state = STOPPED;
      continue;
    }

    let chatID = outcome.chatID;
    if (!chatID) {
      try {
        chatID = await io.resolveChat(target);
        outcome.chatID = chatID || '';
      } catch (err) {
        outcome.state = FAILED;
        outcome.error = err?.message || 'Could not start that chat.';
        continue;
      }
    }
    if (!chatID) {
      outcome.state = FAILED;
      outcome.error = 'Beeper did not return a chat to send into.';
      continue;
    }

    const res = await deliverPayloads(payloads, {
      reupload: io.reupload,
      send: (payload) => io.send(chatID, payload),
    });
    outcome.sent = res.sent.length;
    outcome.pending = res.pending;
    outcome.state = res.ok ? SENT : FAILED;
    outcome.error = res.error || '';
  }
  return { outcomes };
}

/**
 * The destinations worth sending again.
 *
 * Only the ones that failed, and only the payloads that did not go. A
 * destination that took two of three files keeps those two: sending them
 * again would put them in the chat twice.
 */
export function retryableTargets(outcomes) {
  const out = [];
  for (const outcome of outcomes || []) {
    if (!outcome || outcome.state !== FAILED) continue;
    const pending = Array.isArray(outcome.pending) ? outcome.pending : [];
    if (!pending.length) continue;
    out.push({
      key: outcome.key,
      kind: outcome.kind,
      id: outcome.id,
      label: outcome.label,
      // The chat a contact's payloads went to is kept, so the retry sends
      // into the same chat instead of starting a second one.
      chatID: outcome.chatID || '',
      payloads: pending,
    });
  }
  return out;
}

/**
 * Everything that did not go.
 *
 * The failed destinations, with only the payloads that did not get there, and
 * the destinations the run never reached, with all of theirs. This is what a
 * second press of the button sends: what is left, and nothing that already
 * arrived.
 */
export function unsentTargets(outcomes) {
  const out = [];
  for (const outcome of outcomes || []) {
    if (!outcome) continue;
    if (outcome.state === STOPPED) {
      const payloads = Array.isArray(outcome.pending) ? outcome.pending : [];
      if (!payloads.length) continue;
      out.push({
        key: outcome.key,
        kind: outcome.kind,
        id: outcome.id,
        label: outcome.label,
        chatID: outcome.chatID || '',
        payloads,
      });
      continue;
    }
    if (outcome.state !== FAILED) continue;
    const pending = Array.isArray(outcome.pending) ? outcome.pending : [];
    if (!pending.length) continue;
    out.push({
      key: outcome.key,
      kind: outcome.kind,
      id: outcome.id,
      label: outcome.label,
      // The chat a contact's payloads went to is kept, so the retry sends
      // into the same chat instead of starting a second one.
      chatID: outcome.chatID || '',
      payloads: pending,
    });
  }
  return out;
}

/** How many messages the plan will send. */
export function planSendCount(plan) {
  let total = 0;
  for (const target of plan || []) {
    total += (target?.payloads || []).length;
  }
  return total;
}

/** How many destinations the plan has. */
export function planTargetCount(plan) {
  return (plan || []).length;
}

/**
 * What the picker says while nothing has been sent yet.
 *
 * The count of messages is said before anything goes out, because four
 * messages turning up in somebody else's chat is not something to discover
 * afterwards.
 */
export function selectionSummary(selectedCount, messageCount) {
  const people = Number(selectedCount) || 0;
  if (!people) return 'Pick one or more people to send this to.';
  const messages = Number(messageCount) || 0;
  const what = `${messages} message${messages === 1 ? '' : 's'}`;
  return `${people} selected - ${what} will be sent.`;
}

/** What the toast says when the run is over. */
export function sentSummary(outcomes) {
  const sent = (outcomes || []).filter((o) => o.state === SENT);
  if (!sent.length) return '';
  const messages = sent.reduce((n, o) => n + (o.sent || 0), 0);
  const where = sent.length === 1 ? sent[0].label : `${sent.length} people`;
  if (messages > 1) return `Shared to ${where} as ${messages} messages`;
  return `Shared to ${where}`;
}

/**
 * What the picker says about the destinations that did not get it.
 *
 * Empty when everything went, because there is then nothing to say.
 */
export function runSummary(outcomes) {
  const list = outcomes || [];
  const failed = list.filter((o) => o.state === FAILED);
  const stopped = list.filter((o) => o.state === STOPPED);
  if (!failed.length && !stopped.length) return '';
  const bits = [];
  if (failed.length) bits.push(`${failed.length} could not be sent`);
  if (stopped.length) bits.push(`${stopped.length} were not sent`);
  return `${bits.join(', ')}.`;
}
