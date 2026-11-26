/**
 * Dev check: the shape of `sendStatus`.
 *
 * The field has two shapes, and they come from different places.
 *
 * - The app's own flag, on the bubble it puts on screen before the send round
 *   trip comes back: 'pending', then 'sent', or 'failed'.
 * - The bridge's delivery receipt, which is an object:
 *   `{ status: 'SUCCESS', timestamp, deliveredToUsers }`.
 *
 * The bridge started sending the receipt on 2026-11-24, and the app kept
 * comparing the field with the string 'sent'. Every message of the user's own
 * came back as "not confirmed", so the up arrow had nothing to open, and the
 * bubble grew a second tick beside the read receipt.
 *
 * The shapes below are the ones measured in the app's own store on 2026-11-25:
 * 59 receipts saying SUCCESS, one saying FAIL_RETRIABLE, and no message
 * carrying the app's own string form.
 *
 * This module is read by plain Node with no Electron and no window.
 *
 * Run with `npm run check:sendstatus`.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = pathToFileURL(
  path.join(ROOT, 'src', 'renderer', 'js', 'send-status.js'),
).href;

/**
 * The module, if it can be loaded.
 *
 * The import is dynamic and inside a try/catch, so a module that reaches for
 * the DOM becomes a named failing case rather than a suite that dies before
 * printing anything.
 */
let mod = null;
let importError = '';
try {
  mod = await import(MODULE);
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

const withModule = (fn) => {
  if (!mod) return () => importError || 'the module could not be loaded';
  return () => fn(mod);
};

add('the module can be read without a window', () =>
  mod !== null || ('the module could not be loaded: ' + importError));

// --- the shapes, as they were measured -------------------------------------------

/** The receipt the bridge sends when a message went out. */
const RECEIPT = {
  status: 'SUCCESS',
  timestamp: '2026-11-26T03:06:02.362Z',
  deliveredToUsers: ['@YynP0amA7e3:local-signal.localhost'],
};

/** The receipt it sends when the send did not go out. */
const RECEIPT_FAILED = {
  internalError: 'the bridge could not reach the network',
  message: 'the message could not be delivered',
  reason: 'the bridge is offline',
  status: 'FAIL_RETRIABLE',
  timestamp: '2026-11-25T23:41:48.989Z',
};

// --- the app's own flag -----------------------------------------------------------

add('a message with no status of its own has been sent', withModule((S) =>
  S.sendState({}) === 'sent' || 'it read ' + S.sendState({})));

add('CONTROL: the app\'s own pending flag is pending', withModule((S) =>
  S.sendState({ sendStatus: 'pending' }) === 'pending'
  || 'it read ' + S.sendState({ sendStatus: 'pending' })));

add('CONTROL: the app\'s own failed flag is failed', withModule((S) =>
  S.sendState({ sendStatus: 'failed' }) === 'failed'
  || 'it read ' + S.sendState({ sendStatus: 'failed' })));

add('CONTROL: the app\'s own sent flag is sent', withModule((S) =>
  S.sendState({ sendStatus: 'sent' }) === 'sent'
  || 'it read ' + S.sendState({ sendStatus: 'sent' })));

add('a flag nobody has seen is not sent', withModule((S) =>
  S.sendState({ sendStatus: 'sending' }) === 'pending'
  || 'it read ' + S.sendState({ sendStatus: 'sending' })));

// --- the bridge's receipt ---------------------------------------------------------

add('the bridge\'s delivery receipt is sent', withModule((S) =>
  S.sendState({ sendStatus: RECEIPT }) === 'sent'
  || 'it read ' + S.sendState({ sendStatus: RECEIPT })));

add('a receipt with no recipients on it is still sent', withModule((S) =>
  S.sendState({ sendStatus: { status: 'SUCCESS', timestamp: '2026-11-26T03:06:02.362Z' } }) === 'sent'
  || 'it read ' + S.sendState({ sendStatus: { status: 'SUCCESS', timestamp: '2026-11-26T03:06:02.362Z' } })));

add('the bridge\'s failed receipt is failed', withModule((S) =>
  S.sendState({ sendStatus: RECEIPT_FAILED }) === 'failed'
  || 'it read ' + S.sendState({ sendStatus: RECEIPT_FAILED })));

add('a receipt with a status nobody has seen is not sent', withModule((S) =>
  S.sendState({ sendStatus: { status: 'SOMETHING_NEW' } }) === 'pending'
  || 'it read ' + S.sendState({ sendStatus: { status: 'SOMETHING_NEW' } })));

add('a receipt with no status in it is not sent', withModule((S) =>
  S.sendState({ sendStatus: {} }) === 'pending'
  || 'it read ' + S.sendState({ sendStatus: {} })));

// --- the two shapes are told apart ------------------------------------------------

add('CONTROL: the receipt is not read as the app\'s own flag', withModule((S) => {
  // The bug in one line: a receipt is an object, so it is never the string
  // 'sent', and a field compared with that string rejects every message the
  // bridge confirmed.
  const asString = (m) => {
    const status = m?.sendStatus;
    if (status === undefined || status === null) return true;
    return status === 'sent';
  };
  if (asString({ sendStatus: RECEIPT }) === true) {
    return 'the old comparison happened to accept the receipt';
  }
  return S.sendState({ sendStatus: RECEIPT }) === 'sent'
    || 'the module read the receipt as ' + S.sendState({ sendStatus: RECEIPT });
}));

add('CONTROL: the two shapes do not end up in the same state', withModule((S) => {
  const pending = S.sendState({ sendStatus: 'pending' });
  const receipt = S.sendState({ sendStatus: RECEIPT });
  return (pending !== receipt) || 'both read as ' + pending;
}));

// --- the report --------------------------------------------------------------------

let failed = 0;
for (const [name, ok, detail] of cases) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed ? 1 : 0);
