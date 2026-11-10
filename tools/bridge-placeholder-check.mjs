/**
 * Dev check: the placeholder Beeper's bridge puts in when it cannot fetch an
 * attachment.
 *
 * When a bridge fails to download an attachment it does not send the message
 * without it: it sends the message with the failure written into the text.
 * Google's Voice bridge does it like this:
 *
 *   Failed to download attachment
 *
 *   here is what the voice message said
 *
 * So the bubble reads as if the sender had typed the complaint themselves and
 * then said something else. They did not: the voice message's audio could not
 * be fetched, and the bridge said so in the only place it had.
 *
 * Measured on this account: four such messages, all Google Voice, every one of
 * them a voice message whose audio Google refused to serve (HTTP 400) when
 * Beeper's bridge asked for it.
 *
 * The rule is pure, so it is checked under plain Node - no Electron, no
 * window, no account and no network.
 *
 * Run with `npm run check:bridgeplaceholder`.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = pathToFileURL(
  path.join(ROOT, 'src', 'renderer', 'js', 'bridge-placeholder.js'),
).href;

/**
 * The module, if it can be loaded.
 *
 * The import is dynamic and inside a try/catch, so a module that reaches for
 * the DOM is a case that fails, not a suite that never starts.
 */
let placeholder = null;
let importError = '';
try {
  placeholder = await import(MODULE);
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
  if (!placeholder) return () => importError || 'the module could not be loaded';
  return () => fn(placeholder);
};

// The load itself is a case. A rule that needs a window is a bug this suite
// exists to catch, so it is named rather than hidden.
add('the rule can be checked without a window', () =>
  placeholder !== null || ('the module could not be loaded: ' + importError));

// --- the measured shape ------------------------------------------------------

add('the measured message is recognised as a missing attachment', withModule((P) => {
  const raw = 'Failed to download attachment\n\nhere\'s another deer I passed.';
  const out = P.splitBridgePlaceholder(raw);
  return (out.missing === true && out.text === 'here\'s another deer I passed.')
    || ('it said ' + JSON.stringify(out));
}));

add('CONTROL: the words of the sender are not thrown away', withModule((P) => {
  const raw = 'Failed to download attachment\n\nfirst line\nsecond line';
  const out = P.splitBridgePlaceholder(raw);
  return out.text === 'first line\nsecond line'
    || ('it kept ' + JSON.stringify(out.text));
}));

add('a message with nothing after the placeholder has no text left', withModule((P) => {
  const out = P.splitBridgePlaceholder('Failed to download attachment\n\n');
  return (out.missing === true && out.text === '')
    || ('it said ' + JSON.stringify(out));
}));

// --- the message is the sender's own words -----------------------------------

add('CONTROL: a message that is exactly the placeholder is the sender\'s words', withModule((P) => {
  const out = P.splitBridgePlaceholder('Failed to download attachment');
  return (out.missing === false && out.text === 'Failed to download attachment')
    || ('it said ' + JSON.stringify(out));
}));

add('CONTROL: a message that starts the same way is the sender\'s words', withModule((P) => {
  const raw = 'Failed to download attachment because the deer was too far away';
  const out = P.splitBridgePlaceholder(raw);
  return (out.missing === false && out.text === raw)
    || ('it said ' + JSON.stringify(out));
}));

add('CONTROL: the phrase in the middle of a message is the sender\'s words', withModule((P) => {
  const raw = 'the bridge said Failed to download attachment and then stopped';
  const out = P.splitBridgePlaceholder(raw);
  return (out.missing === false && out.text === raw)
    || ('it said ' + JSON.stringify(out));
}));

add('CONTROL: an ordinary message is untouched', withModule((P) => {
  const out = P.splitBridgePlaceholder('hello there');
  return (out.missing === false && out.text === 'hello there')
    || ('it said ' + JSON.stringify(out));
}));

add('CONTROL: a message with no text at all is not a missing attachment', withModule((P) => {
  const out = P.splitBridgePlaceholder(undefined);
  return (out.missing === false && out.text === '')
    || ('it said ' + JSON.stringify(out));
}));

add('CONTROL: a null text is not a missing attachment', withModule((P) => {
  const out = P.splitBridgePlaceholder(null);
  return (out.missing === false && out.text === '')
    || ('it said ' + JSON.stringify(out));
}));

// --- the shape of the placeholder --------------------------------------------

add('the placeholder is the one the bridge writes', withModule((P) =>
  P.PLACEHOLDER === 'Failed to download attachment'
  || ('it says ' + JSON.stringify(P.PLACEHOLDER))));

add('a blank line after the placeholder is the bridge\'s own shape', withModule((P) => {
  // The bridge puts a blank line between the complaint and the transcript.
  // A single newline is accepted too, because that is the same shape with the
  // blank line left out.
  const out = P.splitBridgePlaceholder('Failed to download attachment\nthe words');
  return out.missing === true || ('it said ' + JSON.stringify(out));
}));

// --- the report --------------------------------------------------------------

let failed = 0;
for (const [name, ok, detail] of cases) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed ? 1 : 0);
