/**
 * Dev check: sharing one message with several people.
 *
 * The picker used to send to exactly one place, so the hard part of a share
 * was not in the code. It is now. Three things can go wrong, and none of them
 * show up in a single-target share:
 *
 *   - Beeper takes ONE attachment per send, and a file cannot cross chats by
 *     pointing at where it was. So every destination needs its own copies of
 *     every file, and the count of what is about to happen is people times
 *     files - which has to be said before any of it goes out.
 *   - A refusal in one destination says nothing about the next one. A queue
 *     that stopped at the first refusal would leave the other people with
 *     nothing because somebody else's send failed.
 *   - A destination that took two of three files before one failed has two
 *     files in the chat already. Sending all three again would put the first
 *     two there a second time, so a retry sends only what did not go.
 *
 * The rules are in share-queue.js and share.js with no DOM and no imports
 * beyond each other, so they are driven directly here against a recording
 * instead of a real account.
 *
 * Run with `npm run check:sharequeue`.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARE = pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', 'share.js')).href;
const QUEUE = pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', 'share-queue.js')).href;

/**
 * The modules, if they can be loaded.
 *
 * The imports are dynamic and inside a try/catch, so a module that reaches for
 * the DOM becomes a named failing case rather than a suite that dies before
 * printing anything.
 */
let share = null;
let queue = null;
let importError = '';
try {
  share = await import(SHARE);
  queue = await import(QUEUE);
} catch (err) {
  importError = err && err.message ? err.message : String(err);
}

const cases = [];
const add = (name, fn) => {
  let ok = false;
  let detail = '';
  try {
    const result = fn();
    ok = result === true;
    if (result !== true) detail = String(result);
  } catch (err) {
    ok = false;
    detail = err && err.message ? err.message : String(err);
  }
  cases.push([name, ok, detail]);
};

const addAsync = async (name, fn) => {
  let ok = false;
  let detail = '';
  try {
    const result = await fn();
    ok = result === true;
    if (result !== true) detail = String(result);
  } catch (err) {
    ok = false;
    detail = err && err.message ? err.message : String(err);
  }
  cases.push([name, ok, detail]);
};

const withModules = (fn) => {
  if (!share || !queue) return () => importError || 'the modules could not be loaded';
  return () => fn(share, queue);
};

const withQueue = (fn) => {
  if (!queue) return () => importError || 'the module could not be loaded';
  return () => fn(queue);
};

// --- the pieces -------------------------------------------------------------------

const att = (n) => ({ id: 'att' + n, fileName: 'file' + n + '.png', mimeType: 'image/png' });
const payload = (n) => ({ text: n === 0 ? 'hello' : undefined, attachment: att(n) });

/** Records what went out, in order, without touching a real account. */
const recorder = (opts = {}) => {
  const log = { sent: [], uploads: [], created: [] };
  const io = {
    resolveChat: async (target) => {
      if (target.chatID) return target.chatID;
      log.created.push(target.id);
      if (opts.createFailsFor && opts.createFailsFor.includes(target.id)) {
        throw new Error('chat refused');
      }
      return '!chat-' + target.id;
    },
    reupload: async (a) => {
      if (opts.reuploadFails) throw new Error('upload refused');
      log.uploads.push(a && a.id);
      return Object.assign({}, a, { id: 'copy-' + (a && a.id) });
    },
    send: async (chatID, body) => {
      if (opts.failChat === chatID) throw new Error('send refused');
      log.sent.push({ chatID, payload: body });
    },
    shouldStop: () => opts.shouldStop === true,
  };
  return { log, io };
};

add('the modules can be read without a window', () =>
  (share !== null && queue !== null) || ('the modules could not be loaded: ' + importError));

// --- one key per destination ------------------------------------------------------

add('a chat and a contact with the same id are two different places', withQueue((Q) => {
  const chat = Q.targetKey(Q.chatTarget({ id: '!a' }, 'A'));
  const contact = Q.targetKey(Q.contactTarget({ id: '!a' }, 'A'));
  return (chat !== contact && chat === 'chat:!a' && contact === 'contact:!a')
    || JSON.stringify({ chat, contact });
}));

add('a destination with no id has no key', withQueue((Q) =>
  Q.targetKey(Q.chatTarget({ id: '' }, 'A')) === '' || 'a key was made for nothing'));

// --- ticking ----------------------------------------------------------------------

add('ticking adds the destination once', withQueue((Q) =>
  Q.toggleSelection([], 'chat:!a').join(',') === 'chat:!a'
    || 'the first tick did not take'));

add('ticking twice unticks it', withQueue((Q) =>
  Q.toggleSelection(Q.toggleSelection([], 'chat:!a'), 'chat:!a').length === 0
    || 'the second tick did not untick'));

add('the picks keep the order they were made in', withQueue((Q) => {
  let picked = [];
  for (const key of ['chat:!a', 'chat:!b', 'chat:!c']) picked = Q.toggleSelection(picked, key);
  return picked.join(',') === 'chat:!a,chat:!b,chat:!c' || picked.join(',');
}));

add('ticking nothing changes nothing', withQueue((Q) =>
  Q.toggleSelection(['chat:!a'], '').join(',') === 'chat:!a' || 'an empty key changed the picks'));

add('the destinations come back in the order they were picked', withQueue((Q) => {
  const targets = [Q.chatTarget({ id: '!b' }, 'B'), Q.chatTarget({ id: '!a' }, 'A')];
  const ordered = Q.orderedTargets(targets, ['chat:!a', 'chat:!b']);
  return ordered.map((t) => t.id).join(',') === '!a,!b' || ordered.map((t) => t.id).join(',');
}));

add('a pick that is no longer on offer is left out', withQueue((Q) => {
  const ordered = Q.orderedTargets([Q.chatTarget({ id: '!a' }, 'A')], ['chat:!a', 'chat:!gone']);
  return ordered.length === 1 || ordered.length + ' destinations came back';
}));

// --- the plan ---------------------------------------------------------------------

add('the plan has one entry per destination, in order', withQueue((Q) => {
  const plan = Q.buildPlan(
    [Q.chatTarget({ id: '!a' }, 'A'), Q.chatTarget({ id: '!b' }, 'B')],
    [payload(1)],
  );
  return (plan.length === 2 && plan[0].id === '!a' && plan[1].id === '!b')
    || JSON.stringify(plan.map((p) => p.id));
}));

add('the same destination cannot be in the plan twice', withQueue((Q) => {
  const plan = Q.buildPlan(
    [Q.chatTarget({ id: '!a' }, 'A'), Q.chatTarget({ id: '!a' }, 'A')],
    [payload(1)],
  );
  return plan.length === 1 || plan.length + ' entries';
}));

add('each destination gets its own copy of the payloads', withQueue((Q) => {
  const shared = [payload(1)];
  const plan = Q.buildPlan(
    [Q.chatTarget({ id: '!a' }, 'A'), Q.chatTarget({ id: '!b' }, 'B')],
    shared,
  );
  plan[0].payloads.push(payload(2));
  return (plan[0].payloads.length === 2 && plan[1].payloads.length === 1)
    || JSON.stringify(plan.map((p) => p.payloads.length));
}));

add('a destination that brings its own payloads uses those', withQueue((Q) => {
  // The retry case: the destination sends only what did not go.
  const plan = Q.buildPlan(
    [{ key: 'chat:!a', kind: 'chat', id: '!a', label: 'A', chatID: '!a', payloads: [payload(2)] }],
    [payload(1)],
  );
  return (plan.length === 1 && plan[0].payloads.length === 1 && plan[0].payloads[0].attachment.id === 'att2')
    || JSON.stringify(plan[0].payloads);
}));

add('the plan says how many messages are about to go out', withQueue((Q) => {
  const plan = Q.buildPlan(
    [Q.chatTarget({ id: '!a' }, 'A'), Q.chatTarget({ id: '!b' }, 'B')],
    [payload(1), payload(2)],
  );
  return Q.planSendCount(plan) === 4 || Q.planSendCount(plan);
}));

// --- the run ----------------------------------------------------------------------

await addAsync('the destinations are sent one after another', withQueue(async (Q) => {
  const r = recorder();
  const plan = Q.buildPlan(
    [Q.chatTarget({ id: '!a' }, 'A'), Q.chatTarget({ id: '!b' }, 'B')],
    [payload(1)],
  );
  await Q.deliverPlan(plan, r.io);
  return r.log.sent.map((s) => s.chatID).join(',') === '!a,!b'
    || r.log.sent.map((s) => s.chatID).join(',');
}));

await addAsync('a refusal in one destination does not stop the next', withQueue(async (Q) => {
  const r = recorder({ failChat: '!a' });
  const plan = Q.buildPlan(
    [Q.chatTarget({ id: '!a' }, 'A'), Q.chatTarget({ id: '!b' }, 'B')],
    [payload(1)],
  );
  const res = await Q.deliverPlan(plan, r.io);
  const states = res.outcomes.map((o) => o.state).join(',');
  return (states === 'failed,sent' && r.log.sent.length === 1)
    || JSON.stringify({ states, sent: r.log.sent.length });
}));

await addAsync('a destination stops at its own first refusal', withQueue(async (Q) => {
  // Half a conversation in somebody else's chat reads differently from all
  // of it, so the payloads of one destination stop at the first failure.
  const r = recorder({ failChat: '!a' });
  const plan = Q.buildPlan([Q.chatTarget({ id: '!a' }, 'A')], [payload(1), payload(2)]);
  const res = await Q.deliverPlan(plan, r.io);
  const outcome = res.outcomes[0];
  return (outcome.sent === 0 && outcome.pending.length === 2 && outcome.state === 'failed')
    || JSON.stringify({ sent: outcome.sent, pending: outcome.pending.length });
}));

await addAsync('what did not go is reported as pending', withQueue(async (Q) => {
  const r = recorder();
  const io = {
    ...r.io,
    send: async (chatID, body) => {
      if (!body.attachment || body.attachment.id !== 'copy-att2') {
        r.log.sent.push({ chatID, payload: body });
        return;
      }
      throw new Error('send refused');
    },
  };
  const plan = Q.buildPlan([Q.chatTarget({ id: '!a' }, 'A')], [payload(1), payload(2)]);
  const res = await Q.deliverPlan(plan, io);
  const outcome = res.outcomes[0];
  return (outcome.sent === 1 && outcome.pending.length === 1
    && outcome.pending[0].attachment.id === 'att2')
    || JSON.stringify({ sent: outcome.sent, pending: outcome.pending.map((p) => p.attachment.id) });
}));

await addAsync('a contact gets a chat, and the id is kept', withQueue(async (Q) => {
  const r = recorder();
  const plan = Q.buildPlan([Q.contactTarget({ id: '!p' }, 'P')], [payload(1)]);
  const res = await Q.deliverPlan(plan, r.io);
  const outcome = res.outcomes[0];
  return (r.log.created.join(',') === '!p' && outcome.chatID === '!chat-!p' && outcome.state === 'sent')
    || JSON.stringify({ created: r.log.created, chatID: outcome.chatID, state: outcome.state });
}));

await addAsync('a chat that cannot be started fails that destination only', withQueue(async (Q) => {
  const r = recorder({ createFailsFor: ['!p'] });
  const plan = Q.buildPlan(
    [Q.contactTarget({ id: '!p' }, 'P'), Q.chatTarget({ id: '!b' }, 'B')],
    [payload(1)],
  );
  const res = await Q.deliverPlan(plan, r.io);
  const states = res.outcomes.map((o) => o.state).join(',');
  return (states === 'failed,sent' && /chat refused/.test(res.outcomes[0].error))
    || JSON.stringify({ states, error: res.outcomes[0].error });
}));

await addAsync('the run stops when it is told to', withQueue(async (Q) => {
  const r = recorder({ shouldStop: true });
  const plan = Q.buildPlan(
    [Q.chatTarget({ id: '!a' }, 'A'), Q.chatTarget({ id: '!b' }, 'B')],
    [payload(1)],
  );
  const res = await Q.deliverPlan(plan, r.io);
  const states = res.outcomes.map((o) => o.state).join(',');
  return (states === 'stopped,stopped' && r.log.sent.length === 0)
    || JSON.stringify({ states, sent: r.log.sent.length });
}));

await addAsync('the run never throws at its caller', withQueue(async (Q) => {
  let threw = false;
  try {
    await Q.deliverPlan([{ key: 'chat:!a', payloads: [payload(1)] }], {});
  } catch (e) {
    threw = true;
  }
  return threw === false || 'deliverPlan threw';
}));

// --- sending again ----------------------------------------------------------------

add('the retry picks the destinations that failed', withQueue((Q) => {
  const outcomes = [
    { key: 'chat:!a', state: 'sent', pending: [] },
    { key: 'chat:!b', state: 'failed', pending: [payload(2)] },
  ];
  const left = Q.retryableTargets(outcomes);
  return (left.length === 1 && left[0].key === 'chat:!b')
    || JSON.stringify(left.map((t) => t.key));
}));

add('the retry sends only what did not go', withQueue((Q) => {
  // Two files are already in the chat. Sending all three again would put the
  // first two there a second time.
  const outcomes = [{ key: 'chat:!a', state: 'failed', pending: [payload(3)] }];
  const left = Q.retryableTargets(outcomes);
  return (left[0].payloads.length === 1 && left[0].payloads[0].attachment.id === 'att3')
    || JSON.stringify(left[0].payloads.map((p) => p.attachment.id));
}));

add('the retry keeps the chat a contact was given', withQueue((Q) => {
  const outcomes = [{ key: 'contact:!p', state: 'failed', chatID: '!chat-!p', pending: [payload(2)] }];
  const left = Q.retryableTargets(outcomes);
  return (left[0].chatID === '!chat-!p') || left[0].chatID;
}));

add('a destination that got everything is not retried', withQueue((Q) =>
  Q.retryableTargets([{ key: 'chat:!a', state: 'failed', pending: [] }]).length === 0
    || 'a destination with nothing pending was retried'));

add('what did not go includes the destinations never reached', withQueue((Q) => {
  const outcomes = [
    { key: 'chat:!a', state: 'failed', pending: [payload(2)] },
    { key: 'chat:!b', state: 'stopped', pending: [payload(1)] },
    { key: 'chat:!c', state: 'sent', pending: [] },
  ];
  const left = Q.unsentTargets(outcomes);
  return left.map((t) => t.key).join(',') === 'chat:!a,chat:!b'
    || left.map((t) => t.key).join(',');
}));

// --- what it says -----------------------------------------------------------------

add('nothing picked says what to do', withQueue((Q) =>
  Q.selectionSummary(0, 0) === 'Pick one or more people to send this to.'
    || Q.selectionSummary(0, 0)));

add('the count of messages is said before anything goes', withQueue((Q) =>
  Q.selectionSummary(2, 6) === '2 selected - 6 messages will be sent.'
    || Q.selectionSummary(2, 6)));

add('one message is not counted as several', withQueue((Q) =>
  Q.selectionSummary(1, 1) === '1 selected - 1 message will be sent.'
    || Q.selectionSummary(1, 1)));

add('one destination is named in the toast', withQueue((Q) =>
  Q.sentSummary([{ state: 'sent', label: 'Other chat', sent: 1 }]) === 'Shared to Other chat'
    || Q.sentSummary([{ state: 'sent', label: 'Other chat', sent: 1 }])));

add('several destinations are counted in the toast', withQueue((Q) =>
  Q.sentSummary([
    { state: 'sent', label: 'A', sent: 2 },
    { state: 'sent', label: 'B', sent: 2 },
  ]) === 'Shared to 2 people as 4 messages'
    || Q.sentSummary([
      { state: 'sent', label: 'A', sent: 2 },
      { state: 'sent', label: 'B', sent: 2 },
    ])));

add('the failures are counted', withQueue((Q) =>
  Q.runSummary([
    { state: 'sent', label: 'A', sent: 1 },
    { state: 'failed', label: 'B', sent: 0 },
  ]) === '1 could not be sent.'
    || Q.runSummary([
      { state: 'sent', label: 'A', sent: 1 },
      { state: 'failed', label: 'B', sent: 0 },
    ])));

add('a run where everything went says nothing about failures', withQueue((Q) =>
  Q.runSummary([{ state: 'sent', label: 'A', sent: 1 }]) === ''
    || Q.runSummary([{ state: 'sent', label: 'A', sent: 1 }])));

// --- the single-destination rules still hold --------------------------------------

await addAsync('one destination still stops at the first refusal', withModules(async (S) => {
  const r = recorder();
  const io = {
    reupload: r.io.reupload,
    send: async (body) => {
      if (r.log.sent.length + 1 === 2) throw new Error('send refused');
      r.log.sent.push({ payload: body });
    },
  };
  const res = await S.deliverQueue([payload(1), payload(2), payload(3)], io);
  return (res.ok === false && res.count === 1 && r.log.sent.length === 1)
    || JSON.stringify({ res, sent: r.log.sent.length });
}));

await addAsync('the payloads that went are named', withModules(async (S) => {
  const r = recorder();
  const io = {
    reupload: r.io.reupload,
    send: async (body) => {
      if (r.log.sent.length + 1 === 2) throw new Error('send refused');
      r.log.sent.push({ payload: body });
    },
  };
  const res = await S.deliverPayloads([payload(1), payload(2), payload(3)], io);
  return (res.ok === false && res.sent.length === 1 && res.pending.length === 2)
    || JSON.stringify({ sent: res.sent.length, pending: res.pending.length });
}));

add('a text-only share is one send', withModules((S) =>
  S.shareQueue({ text: 'hello', attachments: [] }).length === 1 || 'not one send'));

add('three files become three sends, because Beeper takes one file each', withModules((S) =>
  S.shareQueue({ text: 'hello', attachments: [att(1), att(2), att(3)] }).length === 3
    || 'not three sends'));

// --- the report --------------------------------------------------------------------

let failed = 0;
for (const [name, ok, detail] of cases) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed ? 1 : 0);
