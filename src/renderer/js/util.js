/** Tiny DOM + formatting helpers shared across the renderer. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const DATE_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const FULL_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function parseTs(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Compact stamp for the chat list: time today, "Mon" this week, else date. */
export function listTime(value) {
  const date = parseTs(value);
  if (!date) return '';
  const now = new Date();
  if (startOfDay(date) === startOfDay(now)) return TIME_FMT.format(date);
  const weekAgo = now.getTime() - 7 * 864e5;
  if (date.getTime() > weekAgo) return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date);
  if (date.getFullYear() === now.getFullYear()) return DATE_FMT.format(date);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: '2-digit' }).format(date);
}

export function messageTime(value) {
  const date = parseTs(value);
  return date ? TIME_FMT.format(date) : '';
}

export function fullTime(value) {
  const date = parseTs(value);
  return date ? FULL_FMT.format(date) : '';
}

/** "Today" / "Yesterday" / "Mon, Mar 3" separator between days. */
export function dayLabel(value) {
  const date = parseTs(value);
  if (!date) return '';
  const now = new Date();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 864e5);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(date);
  if (date.getFullYear() === now.getFullYear()) return DATE_FMT.format(date);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

export function relative(value) {
  const date = parseTs(value);
  if (!date) return '';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Beeper's `text` field is "rich text", but in practice it is a mix of:
 *   - plain text / Markdown for most bridges
 *   - literal HTML for some (Matrix rooms, bots)
 *
 * So we branch: plain-ish text goes through the Markdown subset below, while
 * anything containing tags is parsed and run through an allowlist sanitizer
 * first. The sanitizer is DOM-based and drops every element and attribute that
 * is not explicitly permitted, so message content can never inject markup,
 * scripts, or remote resources.
 */
export function renderRichText(text) {
  const source = String(text ?? '');
  if (!source) return '';

  if (/<[a-z!/][\s\S]*>/i.test(source)) {
    return renderHtmlMessage(source);
  }

  // Plain text / Markdown: fenced code blocks first, then inline formatting.
  return source
    .split(/```/)
    .map((block, i) => {
      if (i % 2 === 1) {
        const newline = block.indexOf('\n');
        const body = newline === -1 ? block : block.slice(newline + 1);
        return `<pre><code>${body.replace(/^\n+|\n+$/g, '')}</code></pre>`;
      }
      return inline(block);
    })
    .join('');
}

// Elements we are willing to keep. Everything else is unwrapped, which keeps
// its readable text but discards the element itself.
const ALLOWED_TAGS = new Set([
  'A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'I', 'LI', 'OL',
  'P', 'PRE', 'S', 'SPAN', 'STRONG', 'U', 'UL',
]);

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

function renderHtmlMessage(source) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(source, 'text/html');
  } catch {
    return escapeHtml(source);
  }

  const fragment = sanitizeChildren(doc, doc.body);
  applyMarkdownToTextNodes(fragment);

  const holder = document.createElement('div');
  holder.append(fragment);
  return holder.innerHTML;
}

// Elements that start on a line of their own. Used to tell apart whitespace
// that is only source formatting from whitespace the sender actually typed.
const BLOCK_LEVEL = /^(P|UL|OL|LI|BLOCKQUOTE|PRE|DIV|SECTION|ARTICLE|HR|TABLE|TR|TD|TH)$/;

/**
 * Is this text node whitespace the sender never typed?
 *
 * Message bodies render with `white-space: pre-wrap`, so a plain-text message
 * keeps the line breaks the user pressed. That same rule turns the newlines a
 * sender's *HTML* is pretty-printed with into visible blank lines: a list that
 * arrives as `<ul>\n<li>a</li>\n<li>b</li>\n</ul>` renders with a blank line
 * after every bullet. Such nodes are pure formatting, so they are dropped.
 *
 * Inline whitespace is never touched. `<strong>a</strong> <em>b</em>` has a
 * single space between the elements, and removing it would run the words
 * together; the rule therefore only fires when an element sibling is a
 * block-level element, or when the parent is a list whose children are items.
 */
function isFormattingWhitespace(node) {
  if (node.data.trim() !== '') return false;
  const parent = node.parentElement;
  if (!parent) return false;
  if (parent.tagName === 'UL' || parent.tagName === 'OL') return true;

  let prev = node.previousSibling;
  while (prev && prev.nodeType !== Node.ELEMENT_NODE) prev = prev.previousSibling;
  let next = node.nextSibling;
  while (next && next.nodeType !== Node.ELEMENT_NODE) next = next.nextSibling;

  if (prev && BLOCK_LEVEL.test(prev.tagName)) return true;
  if (next && BLOCK_LEVEL.test(next.tagName)) return true;
  return false;
}

function sanitizeChildren(doc, sourceNode) {
  const out = document.createDocumentFragment();

  for (const child of [...sourceNode.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (!isFormattingWhitespace(child)) out.append(doc.createTextNode(child.data));
      continue;
    }
    // Comments, processing instructions, CDATA: dropped outright.
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = child.tagName.toUpperCase();
    if (!ALLOWED_TAGS.has(tag)) {
      // Unwrap: keep the content, drop the element.
      out.append(sanitizeChildren(doc, child));
      continue;
    }

    const clean = doc.createElement(tag.toLowerCase());
    if (tag === 'A') {
      const href = child.getAttribute('href') || '';
      if (SAFE_URL.test(href.trim())) {
        clean.setAttribute('href', href.trim());
        clean.setAttribute('rel', 'noopener noreferrer nofollow');
        clean.setAttribute('target', '_blank');
      }
    }
    // The sanitized children have to go *inside* the clean element. Appending
    // them to `out` instead renders every allowed element empty and hoists its
    // content out as siblings, which is invisible for a plain <p> (the text
    // still shows) but destroys everything structural: lists come out as an
    // empty <ul> followed by loose <li>s, <em> and <strong> lose their styling
    // and <a> stops being a link at all.
    clean.append(sanitizeChildren(doc, child));
    out.append(clean);
  }
  return out;
}

/** Runs the Markdown subset over surviving text nodes only. */
function applyMarkdownToTextNodes(fragment) {
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    // Never re-format inside links or code.
    if (parent && /^(A|CODE|PRE)$/.test(parent.tagName)) continue;
    if (!node.data.trim()) continue;
    targets.push(node);
  }

  for (const node of targets) {
    const holder = document.createElement('div');
    holder.innerHTML = inline(node.data);
    node.replaceWith(...holder.childNodes);
  }
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" rel="noreferrer noopener nofollow" target="_blank">$1</a>',
    )
    .replace(
      /\b(https?:\/\/[^\s<]+)/g,
      (url) => `<a href="${url}" rel="noreferrer noopener nofollow" target="_blank">${url}</a>`,
    );
}

export function initials(text) {
  const words = String(text || '?')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Deterministic hue so a given participant always gets the same colour. */
export function hueFor(seed) {
  const str = String(seed || '');
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) hash = (hash * 31 + str.charCodeAt(i)) % 360;
  return hash;
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function autoGrow(textarea, max = 180) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, max)}px`;
}

export function fileSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🙏', '🔥', '✅'];
