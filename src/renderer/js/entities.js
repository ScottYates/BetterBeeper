/**
 * HTML character references, resolved for display.
 *
 * Some bridges hand Beeper text that has been HTML-escaped, so the API returns
 * `&amp;` and `&quot;` where the sender wrote `&` and `"`. Measured against
 * live data: across 359 messages there was not one literal `&` outside a
 * character reference, so the escaping is real and not the sender's own
 * typing.
 *
 * Nothing here touches the DOM, so this module can be loaded on its own and
 * checked without a window.
 */

/**
 * The character references HTML escaping produces.
 *
 * Only these five are resolved. A message that contains `&copy;` is showing
 * the sender's text rather than an encoding, and turning it into a copyright
 * sign would be the app rewriting what somebody wrote.
 */
const NAMED_REFERENCES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** The names this app resolves, used to spot a reference cut in half. */
const REFERENCE_NAMES = Object.keys(NAMED_REFERENCES);

/** A whole character reference: `&amp;`, `&#39;`, `&#x27;`. */
const REFERENCE = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,10});$/;

/** A character reference anywhere in a string. */
const REFERENCE_ANY = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,10});/g;

/**
 * Resolve HTML character references in text that arrives already encoded.
 *
 * Decoding happens where the text is displayed, never in the stored message,
 * so the value that goes back to Beeper is the one the sender typed. It also
 * happens exactly once per render: the HTML branch of `renderRichText` parses
 * with DOMParser, which resolves references on its own, so decoding there
 * first would resolve them twice and turn `&amp;amp;` into `&`.
 */
export function decodeEntities(value) {
  const text = String(value ?? '');
  if (!text.includes('&')) return text;
  return text.replace(REFERENCE_ANY, (match, body) => {
    if (body[0] !== '#') return NAMED_REFERENCES[body.toLowerCase()] ?? match;
    const hex = body[1] === 'x' || body[1] === 'X';
    const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
    if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return match;
    try {
      return String.fromCodePoint(code);
    } catch {
      return match;
    }
  });
}

/**
 * Cut text for a one-line preview without leaving half a reference behind.
 *
 * A preview that ends in `&am` shows the reader the very thing this is meant
 * to hide, so a cut inside a reference keeps the whole reference. A cut
 * anywhere else is left alone: dropping the fragment would throw away text
 * the sender actually typed.
 */
export function clipText(value, max) {
  const text = String(value ?? '');
  if (!max || max <= 0 || text.length <= max) return text;
  const head = text.slice(0, max);
  const amp = head.lastIndexOf('&');
  if (amp === -1) return head;

  const fragment = head.slice(amp + 1);
  const named = REFERENCE_NAMES.some((name) => name.startsWith(fragment));
  const numeric = /^#([0-9]{0,7}|x[0-9a-fA-F]{0,6})$/i.test(fragment);
  if (!named && !numeric) return head;

  const finished = text.slice(max).match(/^[a-zA-Z0-9]{0,12};/);
  if (finished && REFERENCE.test(`&${fragment}${finished[0]}`)) return head + finished[0];
  return head;
}
