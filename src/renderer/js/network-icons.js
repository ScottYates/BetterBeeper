/**
 * Brand glyphs for the network a chat or message came from.
 *
 * Beeper's Desktop API reports networks as names ("Signal", "Facebook/Messenger",
 * "Beeper (Matrix)") but never ships artwork for them, so each glyph here is a
 * hand-drawn mark on a 16x16 grid. They are rendered white on the brand-coloured
 * badge, which keeps them legible at 14px and lets one badge style cover every
 * network. Anything unmapped falls back to a monogram, so a bridge Beeper ships
 * tomorrow still renders something sane.
 */

const G = {
  // Beeper runs on Matrix: the [>_<] mark.
  beeper: '<path d="M5.6 3.4H3.2v9.2h2.4M10.4 3.4h2.4v9.2h-2.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.2 6.2 9.8 9.8M9.8 6.2 6.2 9.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',

  // Signal's mark is the rounded speech bubble.
  signal: '<path d="M8 2.6c-3.2 0-5.6 2-5.6 4.6 0 1.4.8 2.7 2 3.6v2l2.3-1.3c.4.1.9.1 1.3.1 3.2 0 5.6-2 5.6-4.4S11.2 2.6 8 2.6Z" fill="currentColor"/>',

  // Facebook / Messenger: the lowercase "f" of the Facebook logo, not the
  // Messenger bolt. Beeper reports "Facebook/Messenger", and the f is what
  // actually identifies the account in the list.
  facebook:
    '<path d="M13.8 2c-.9-.1-1.6-.2-2.4-.2-2.9 0-4.8 1.8-4.8 4.9v1.7H4.2v2.8h2.4v5.1h3.4V11.2h2.8l.4-2.8H10V6.8c0-1.1.5-1.6 1.7-1.6.6 0 1.4.1 2 .3Z" fill="currentColor"/>',

  // WhatsApp: handset inside a bubble.
  whatsapp:
    '<path d="M8 2.4a5.6 5.6 0 0 0-4.8 8.5L2.6 13.9l3.1-.6A5.6 5.6 0 1 0 8 2.4Z" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/><path d="M6.2 5.9c-.2 0-.5.1-.6.4-.2.3-.2.7 0 1 .4.9 1.1 1.6 2.1 2 .4.2.8.1 1-.1l.3-.4-.9-.6-.4.3c-.5-.2-.9-.6-1.1-1.1l.3-.4-.6-.9-.4-.2Z" fill="currentColor"/>',

  telegram:
    '<circle cx="8" cy="8" r="6.1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.9 7.6 11.6 5 9.9 11.6l-1.6-.6-1 .9-.2-1.4 2.9-2.8-3.5 1.4-.6-.5Z" fill="currentColor"/>',

  instagram:
    '<rect x="2.6" y="2.6" width="10.8" height="10.8" rx="3.1" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2.6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="11.1" cy="4.9" r="1" fill="currentColor"/>',

  discord:
    '<path d="M8 2.6c2 0 3.4.5 3.4.5l.6 1.2s1.3.5 2 1.6c.6 1 .8 2.6.8 2.6s-.9 2.4-1.7 2.9c-.8.5-2 .6-2 .6l-.5-1.1s-1.3.3-2.6.3-2.6-.3-2.6-.3L4.9 11s-1.2-.1-2-.6C2.1 9.9 1.2 7.5 1.2 7.5s.2-1.6.8-2.6c.7-1.1 2-1.6 2-1.6l.6-1.2s1.4-.5 3.4-.5Z" fill="currentColor"/>',

  // Classic SMS / RCS bubble.
  sms: '<path d="M8 2.9c-3.1 0-5.6 1.9-5.6 4.3 0 1.3.8 2.5 2 3.3v2.1l2.2-1.2c.4.1.9.1 1.4.1 3.1 0 5.6-1.9 5.6-4.3S11.1 2.9 8 2.9Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',

  imessage:
    '<path d="M8 2.6c-3.3 0-5.9 2.1-5.9 4.7 0 2.6 2.6 4.7 5.9 4.7.6 0 1.2-.1 1.7-.2l2.3 1-.5-1.9c1.5-.8 2.4-2.2 2.4-3.6 0-2.6-2.6-4.7-5.9-4.7Z" fill="currentColor"/>',

  gmail:
    '<rect x="2.4" y="4" width="11.2" height="8" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m2.9 4.7 5.1 3.9 5.1-3.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',

  'google chat':
    '<path d="M8 2.8c-3.1 0-5.6 1.9-5.6 4.3s2.5 4.3 5.6 4.3c.5 0 1-.1 1.5-.2l2 1-.4-1.7c1.5-.8 2.5-2 2.5-3.4 0-2.4-2.5-4.3-5.6-4.3Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M9.9 6.3a2.3 2.3 0 1 0 0 3.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M9.5 8h1.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',

  'x / twitter':
    '<path d="M3.3 3.3 12.7 12.7M12.7 3.3 3.3 12.7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',

  linkedin:
    '<rect x="2.6" y="2.6" width="10.8" height="10.8" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5.4" cy="5.6" r="1" fill="currentColor"/><path d="M4.5 7.3h1.8v4.1H4.5zM7.8 7.3h1.7v.6c.3-.4.8-.7 1.6-.7 1.3 0 1.9.8 1.9 2.2v2h-1.8V9.7c0-.6-.3-1-.8-1s-.9.4-.9 1v2.6H7.8z" fill="currentColor"/>',

  tiktok:
    '<path d="M9.4 2.4h2c.1 1 .5 1.8 1.2 2.3.6.4 1.3.6 2 .6v2c-.7 0-1.4-.2-2-.5v3.6a3.6 3.6 0 1 1-3.6-3.6c.3 0 .6 0 .8.1v2.1a1.6 1.6 0 1 0 1.1 1.5V2.4Z" fill="currentColor"/>',

  reddit:
    '<circle cx="8" cy="9.4" r="3.1" fill="none" stroke="currentColor" stroke-width="1.35"/><circle cx="6.4" cy="9.2" r="0.85" fill="currentColor"/><path d="M8 5.1c1.9 0 3.5.5 4.6 1.4M6.2 4.1 5.5 2.6M9.8 4.1l.7-1.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',

  bluesky:
    '<path d="M8 5.4C6.7 3.6 4.3 1.9 2.9 2.2 1.5 2.5 1.2 5.6 1.5 7.2c.3 1.7 1.9 2.2 3.3 2-1.9.3-2.2 1.7-1.2 3 .9 1.2 2.4.2 3.2-1.4.4.8.7 1.5 1.2 2 .5-.5.8-1.2 1.2-2 .8 1.6 2.3 2.6 3.2 1.4 1-1.3.7-2.7-1.2-3 1.4.2 3-.3 3.3-2 .3-1.6 0-4.7-1.4-5-1.4-.3-3.8 1.4-5.1 3.2Z" fill="currentColor"/>',

  steam:
    '<circle cx="8" cy="8" r="6.1" fill="none" stroke="currentColor" stroke-width="1.35"/><circle cx="10" cy="6" r="1.9" fill="currentColor"/><path d="M2.2 10.4 8 12.4" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/><circle cx="4.6" cy="5.4" r="0.9" fill="currentColor"/>',

  // Slack's own mark is a four-pill pinwheel, which turns to mush at 11px; the
  // hash it is built from is what the brand actually reads as.
  slack:
    '<path d="M6.4 2.5 5.2 13.5M11 2.5 9.8 13.5M3 5.9h11M2.6 10.1h11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',

  zoom:
    '<rect x="2.2" y="4.4" width="7.6" height="7.2" rx="1.8" fill="currentColor"/><path d="m10.4 8.4 3.4-2.3v5.8l-3.4-2.3z" fill="currentColor"/>',

  line: '<path d="M8 2.9c-3.2 0-5.7 1.9-5.7 4.3 0 2.4 2.5 4.3 5.7 4.3.5 0 1 0 1.4-.2l2.2 1-.5-1.8c1.6-.8 2.6-2 2.6-3.3 0-2.4-2.5-4.3-5.7-4.3Z" fill="currentColor"/>',

  wechat:
    '<path d="M6.2 3.1c-2.6 0-4.7 1.7-4.7 3.8 0 1.2.7 2.3 1.8 3l-.5 1.6 1.9-1c.5.1 1 .2 1.5.2h.4a3.6 3.6 0 0 1-.2-1.2c0-2.1 2.1-3.8 4.7-3.8h.4C11.1 4.4 8.9 3.1 6.2 3.1Z" fill="currentColor"/><path d="M14.5 8.3c0-1.9-1.9-3.4-4.2-3.4S6.1 6.4 6.1 8.3s1.9 3.4 4.2 3.4c.5 0 1-.1 1.4-.2l1.6.9-.4-1.4c.9-.6 1.6-1.6 1.6-2.7Z" fill="currentColor"/>',

  nextcloud:
    '<circle cx="8" cy="8" r="6.1" fill="none" stroke="currentColor" stroke-width="1.35"/><path d="M8 4.4a3.6 3.6 0 0 1 3.4 2.4M8 11.6A3.6 3.6 0 0 1 4.6 9.2M8 4.4v7.2" fill="none" stroke="currentColor" stroke-width="1.2"/>',

  // The badge already supplies Pinterest's red disc, so the glyph is just the P.
  pinterest:
    '<path d="M6.7 13.6 8.6 7.8m-.8-1c0-1.2.9-2.1 2.2-2.1s2.1.9 2.1 2.1c0 2-1.3 2.9-2.6 2.9-.8 0-1.3-.5-1.2-1.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',

  twitch:
    '<path d="M3 2.6h10.2v6.9l-2.6 2.6h-2l-1.9 2v-2H3V2.6Z" fill="currentColor"/><path d="M6.3 5.4v3M9.3 5.4v3" fill="none" stroke="#18181b" stroke-width="1.3" stroke-linecap="round"/>',
};

/** Bridges that reuse a glyph rather than having one of their own. */
const ALIASES = {
  matrix: 'beeper',
  'beeper (matrix)': 'beeper',
  beeper: 'beeper',
  messenger: 'facebook',
  'facebook/messenger': 'facebook',
  facebook: 'facebook',
  'google voice': 'google voice',
  googlevoice: 'google voice',
  signal: 'signal',
  whatsapp: 'whatsapp',
  telegram: 'telegram',
  instagram: 'instagram',
  discord: 'discord',
  sms: 'sms',
  'sms / rcs': 'sms',
  rcs: 'sms',
  imessage: 'imessage',
  'apple messages': 'imessage',
  gmail: 'gmail',
  email: 'gmail',
  outlook: 'gmail',
  'google chat': 'google chat',
  'x / twitter': 'x / twitter',
  twitter: 'x / twitter',
  x: 'x / twitter',
  linkedin: 'linkedin',
  tiktok: 'tiktok',
  reddit: 'reddit',
  bluesky: 'bluesky',
  steam: 'steam',
  slack: 'slack',
  zoom: 'zoom',
  line: 'line',
  wechat: 'wechat',
  nextcloud: 'nextcloud',
  pinterest: 'pinterest',
  twitch: 'twitch',
};

/** Maps a Beeper network name to a glyph key, or null when we have no artwork. */
export function glyphFor(networkName) {
  const raw = String(networkName || '').trim().toLowerCase();
  if (!raw) return null;
  if (ALIASES[raw]) return ALIASES[raw];
  // "Beeper (Matrix)" / "Facebook/Messenger" style decorations.
  const stripped = raw.replace(/\s*\(.*?\)\s*$/g, '').trim();
  if (ALIASES[stripped]) return ALIASES[stripped];
  for (const part of stripped.split(/[/,]/)) {
    const key = part.trim();
    if (key && ALIASES[key]) return ALIASES[key];
  }
  return null;
}

/**
 * Marks that carry their own colours instead of being a single `currentColor`
 * glyph on the brand disc.
 *
 * Google Voice is the case that forces this. Its real artwork is a green
 * gradient, and the brand disc for it is Google green, so a self-coloured glyph
 * on the usual disc is completely invisible (verified: a flat green circle with
 * a speck). Giving it a near-black disc, like the actual app icon, is the only
 * way the mark reads. Everything else stays monochrome for consistency.
 *
 * `svg(uid)` must return markup where every paint is `url(#uid)`, so the
 * gradient id stays unique per rendered instance.
 */
const SELF_COLOURED = {
  'google voice': {
    badge: '#111614',
    // A petal in the upper right whose tip points to the lower left, and a
    // comma-shaped hook below it, split by a thin diagonal gap.
    svg: (uid) => `
      <defs>
        <linearGradient id="${uid}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#00c9a7"/>
          <stop offset="0.5" stop-color="#3ed16b"/>
          <stop offset="1" stop-color="#25c55f"/>
        </linearGradient>
      </defs>
      <path d="M4.5 8.3C4.8 4.2 7.4 1.3 10.3 1.3c2.6 0 4.3 1.4 4.3 3.8 0 2.1-1.4 3.6-3.7 3.9Z" fill="url(#${uid})"/>
      <path d="M3.1 7.6c-.4 3 1.7 6 5.1 6.4 2.1.2 3.8-.8 4.2-2.4" fill="none" stroke="url(#${uid})" stroke-width="2.55" stroke-linecap="round"/>`,
  },
};

/** True when we have real artwork for this network rather than a monogram. */
export function hasGlyph(networkName) {
  return glyphFor(networkName) !== null;
}

let gradientSeq = 0;

/**
 * Inline SVG markup for a network, sized to sit inside the avatar badge.
 * Monochrome marks take the badge's foreground colour; self-coloured marks
 * carry their own gradient and need `badgeBackground()` for the disc.
 */
export function networkIconMarkup(networkName, { size = 11 } = {}) {
  const key = glyphFor(networkName);
  if (!key) return '';
  const custom = SELF_COLOURED[key];
  const body = custom ? custom.svg(`nv${(gradientSeq += 1)}`) : G[key];
  return (
    `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
    `${body}</svg>`
  );
}

/**
 * Disc colour for a network's badge, or `''` when the caller should use the
 * network's brand colour. Only self-coloured marks override it.
 */
export function badgeBackground(networkName) {
  const key = glyphFor(networkName);
  return (key && SELF_COLOURED[key]?.badge) || '';
}
