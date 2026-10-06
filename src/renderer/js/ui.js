/** Toasts, modals, and a couple of small overlay widgets. */

import { $, el, clear } from './util.js';

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export function toast(message, kind = 'info', ms = 3200) {
  const root = $('#toast-root');
  const node = el('div', { class: `toast is-${kind}`, text: message });
  root.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s ease';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, ms);
  return node;
}

// ---------------------------------------------------------------------------
// Tooltips
// ---------------------------------------------------------------------------

/**
 * Beeper-style hover tooltips. Any element carrying `data-tip="..."` gets a
 * dark pill above it after a short dwell. These replace the browser's native
 * `title` tooltips, which are slow, unstyled and cannot be positioned
 * consistently next to the icon buttons in the thread header.
 */
let tipNode = null;
let tipTimer = null;
let tipOwner = null;

const TIP_DELAY_MS = 420;
const TIP_HIDE_MS = 90;

function ensureTipNode() {
  if (tipNode) return tipNode;
  tipNode = el('div', { class: 'tooltip', role: 'tooltip', hidden: true });
  document.body.append(tipNode);
  return tipNode;
}

function placeTip(target) {
  const node = ensureTipNode();
  node.textContent = target.dataset.tip;
  node.hidden = false;

  const rect = target.getBoundingClientRect();
  const tip = node.getBoundingClientRect();
  const gap = 8;

  let top = rect.top - tip.height - gap;
  // Flip below when there is no room above.
  if (top < 8) top = rect.bottom + gap;

  let left = rect.left + rect.width / 2 - tip.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tip.width - 8));

  node.style.top = `${Math.round(top)}px`;
  node.style.left = `${Math.round(left)}px`;
}

function hideTip() {
  clearTimeout(tipTimer);
  if (tipNode) tipNode.hidden = true;
  tipOwner = null;
}

export function initTooltips(root = document) {
  root.addEventListener('pointerover', (event) => {
    const target = event.target.closest?.('[data-tip]');
    if (!target || target === tipOwner) return;
    hideTip();
    tipOwner = target;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => placeTip(target), TIP_DELAY_MS);
  });

  root.addEventListener('pointerout', (event) => {
    const target = event.target.closest?.('[data-tip]');
    if (!target) return;
    // Ignore moves between a button and the icon inside it.
    if (event.relatedTarget && target.contains(event.relatedTarget)) return;
    hideTip();
  });

  root.addEventListener('pointerdown', hideTip, true);
  window.addEventListener('blur', hideTip);
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('resize', hideTip);
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

let activeClose = null;

export function closeModal() {
  const root = $('#modal-root');
  root.hidden = true;
  clear(root);
  if (activeClose) {
    const fn = activeClose;
    activeClose = null;
    fn();
  }
}

export function openModal({ title, body, footer, width, onClose, onSubmit }) {
  const root = $('#modal-root');
  clear(root);
  root.hidden = false;
  activeClose = onClose || null;

  const modal = el('div', { class: 'modal', style: width ? { width } : null });
  modal.append(
    el(
      'div',
      { class: 'modal-header' },
      el('h3', { text: title }),
      el('button', {
        class: 'icon-btn',
        'aria-label': 'Close',
        text: '✕',
        onClick: closeModal,
      }),
    ),
  );

  const bodyNode = el('div', { class: 'modal-body' });
  if (body) bodyNode.append(body);
  modal.append(bodyNode);

  if (footer) modal.append(el('div', { class: 'modal-footer' }, footer));

  root.append(modal);

  // Click outside the modal closes it.
  root.onclick = (event) => {
    if (event.target === root) closeModal();
  };

  if (onSubmit) {
    const handler = (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onSubmit();
      }
    };
    modal.addEventListener('keydown', handler);
  }

  return { modal, body: bodyNode };
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#modal-root').hidden) {
    event.stopPropagation();
    closeModal();
  }
});

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      closeModal();
    };

    openModal({
      title,
      body: el('p', { class: 'muted', text: message }),
      footer: [
        el('button', { class: 'btn', text: 'Cancel', onClick: () => finish(false) }),
        el('button', {
          class: `btn ${danger ? 'btn-primary' : 'btn-primary'}`,
          text: confirmLabel,
          style: danger ? { background: 'var(--danger)', borderColor: 'var(--danger)' } : null,
          onClick: () => finish(true),
        }),
      ],
      onClose: () => finish(false),
    });
  });
}

// ---------------------------------------------------------------------------
// Popover menu
// ---------------------------------------------------------------------------

export function openPopover(anchor, items, { width } = {}) {
  document.querySelectorAll('.msg-menu, .emoji-popover').forEach((n) => n.remove());

  const menu = el('div', { class: 'msg-menu', style: width ? { minWidth: `${width}px` } : null });
  for (const item of items) {
    if (!item) continue;
    menu.append(
      el('button', {
        // `checked` marks the item the menu is currently showing, so a view
        // switcher can say which one you are in.
        class: [item.danger ? 'danger' : null, item.checked ? 'is-active' : null]
          .filter(Boolean)
          .join(' ') || null,
        text: item.label,
        onClick: () => {
          closePopover();
          item.onSelect();
        },
      }),
    );
  }

  document.body.append(menu);
  positionPopover(menu, anchor);

  const onDocClick = (event) => {
    if (!menu.contains(event.target)) closePopover();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') closePopover();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
  }, 0);

  menu._cleanup = () => {
    document.removeEventListener('mousedown', onDocClick);
    document.removeEventListener('keydown', onKey);
    menu.remove();
  };
  return menu;
}

export function openEmojiPicker(anchor, onPick) {
  document.querySelectorAll('.msg-menu, .emoji-popover').forEach((n) => n.remove());
  const picker = el('div', { class: 'emoji-popover' });
  for (const emoji of ['👍', '❤️', '😂', '🎉', '👀', '🙏', '🔥', '✅', '💯', '🤔', '😅', '😢', '👏', '🚀', '☕', '🐛']) {
    picker.append(el('button', { text: emoji, onClick: () => { closePopover(); onPick(emoji); } }));
  }
  document.body.append(picker);
  positionPopover(picker, anchor);

  const onDocClick = (event) => {
    if (!picker.contains(event.target)) closePopover();
  };
  setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
  picker._cleanup = () => {
    document.removeEventListener('mousedown', onDocClick);
    picker.remove();
  };
  return picker;
}

function positionPopover(node, anchor) {
  const rect = anchor.getBoundingClientRect();
  node.style.position = 'fixed';
  node.style.top = `${rect.bottom + 6}px`;
  node.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - node.offsetWidth - 8))}px`;
  // Flip above the anchor if there is no room below.
  if (rect.bottom + node.offsetHeight + 12 > window.innerHeight) {
    node.style.top = `${Math.max(8, rect.top - node.offsetHeight - 6)}px`;
  }
}

export function closePopover() {
  document.querySelectorAll('.msg-menu, .emoji-popover').forEach((node) => {
    node._cleanup?.();
    node.remove();
  });
}

// ---------------------------------------------------------------------------
// Image viewer
// ---------------------------------------------------------------------------

/**
 * Open an image in the overlay viewer window.
 *
 * The viewer used to be a position: fixed overlay inside this window, which
 * tied it to the app window twice over: the image could never be larger than
 * the window, and zooming competed with the chat list and thread for scroll
 * and re-renders. It is now a separate always-on-top window in the main
 * process (see openImageViewer in main.js), so it covers the display and
 * zooms on its own. This function keeps the name and call sites unchanged.
 */
export function openLightbox(srcUrl, { alt = '' } = {}) {
  if (!srcUrl) return { close() {} };
  if (!window.beeper?.images?.openViewer) {
    toast('Could not open the image viewer.', 'error');
    return { close() {} };
  }
  window.beeper.images.openViewer(srcUrl, alt);
  // The window owns its own lifetime; the renderer only needs a no-op close
  // so call sites do not have to special-case this.
  return { close() {}, view: { scale: 1, x: 0, y: 0 }, detached: true };
}

/**
 * Put a displayed image on the system clipboard as a real image, so it can be
 * pasted straight back into this composer or into any other app.
 *
 * The bytes go over as an image rather than a path or a URL, which is what makes
 * it pasteable elsewhere: Windows applications look at the clipboard formats,
 * and only CF_DIB/CF_BITMAP makes something paste as a picture.
 */
export async function copyImage(srcUrl) {
  if (!srcUrl) return false;
  if (!window.beeper?.images?.copy) {
    toast('Could not copy the image.', 'error');
    return false;
  }

  const res = await window.beeper.images.copy(srcUrl);
  if (res?.ok) {
    toast('Image copied', 'success', 1500);
    return true;
  }
  toast(res?.error?.message || 'Could not copy the image.', 'error');
  return false;
}

/**
 * Save any attachment that is not shown inline - a document, an archive, an
 * audio file, anything the thread cannot draw itself.
 *
 * This is the only route out of the app for those, so it reports honestly: a
 * cancelled dialog is silent, because the user just chose not to do it, while a
 * real failure is worth a toast rather than a row that appears to do nothing.
 */
export async function saveAttachment(attachment) {
  if (!attachment) return false;
  if (!window.beeper?.assets?.saveAs) {
    toast('Could not save this file.', 'error');
    return false;
  }

  const res = await window.beeper.assets.saveAs(attachment);
  if (res?.ok) {
    const data = res.data;
    if (data?.saved) {
      toast(`Saved ${data.name || attachment.fileName || 'the file'}`, 'success', 2200);
      return true;
    }
    // The user closed the dialog. Not an error, and saying so would be noise.
    if (data?.cancelled) return false;
  }

  toast(res?.error?.message || 'Could not save this file.', 'error');
  return false;
}

/**
 * Menu for a displayed image: open it, copy it out, or copy its address.
 *
 * Uses the same popover as the message menu rather than a native one, so it
 * looks like the rest of the app and needs no new bridge surface - the only
 * thing the main process has to know about is the copy itself.
 */
export function imageMenu(anchor, srcUrl, { pointer } = {}) {
  if (!srcUrl) return false;
  if (!window.beeper?.images?.copy) return false;

  // positionPopover places the menu under the anchor's bottom-left corner, so
  // a zero-size point sitting at the cursor is exactly a context menu origin.
  let origin = anchor;
  let point = null;
  if (pointer) {
    point = document.createElement('div');
    point.style.cssText = `position:fixed;left:${pointer.x}px;top:${pointer.y}px;width:0;height:0;pointer-events:none;`;
    document.body.append(point);
    origin = point;
  }

  const menu = openPopover(origin, [
    { label: 'Open image', onSelect: () => openLightbox(srcUrl) },
    { label: 'Copy image', onSelect: () => { copyImage(srcUrl); } },
    { label: 'Copy image address', onSelect: () => copyText(srcUrl) },
  ]);

  if (point && menu) {
    const cleanup = menu._cleanup;
    menu._cleanup = () => {
      cleanup?.();
      point.remove();
    };
  }
  return true;
}

function copyText(value) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(String(value)).catch(() => {});
    return;
  }
  toast('Could not copy the address.', 'error');
}

