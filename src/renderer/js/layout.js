/** Resizable panes: the conversation list splitter, and remembering its width. */

import { $ } from './util.js';
import { api } from './api.js';
import { state } from './state.js';

const MIN = 200;
const MAX = 620;
// Below this the thread has no room left, so the list gives ground first.
const MIN_THREAD = 360;

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/**
 * What the user chose, kept separate from what the window can currently fit.
 * Otherwise shrinking the window would permanently rewrite their preference:
 * the sidebar would shrink, and growing the window again would not bring it
 * back.
 */
let preferredWidth = 300;

export function sidebarWidth() {
  const raw = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10);
  return Number.isFinite(raw) ? raw : preferredWidth;
}

function apply() {
  const max = Math.max(MIN, window.innerWidth - MIN_THREAD);
  const width = clamp(preferredWidth, MIN, Math.min(MAX, max));
  document.documentElement.style.setProperty('--sidebar-w', `${width}px`);
  return width;
}

export function setSidebarWidth(px) {
  preferredWidth = clamp(Math.round(px), MIN, MAX);
  return apply();
}

let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  // Dragging fires a lot; only the final width is worth a disk write. Persist
  // the preference, not the value the current window size happens to allow.
  saveTimer = setTimeout(() => {
    api.settings.set({ sidebarWidth: preferredWidth }).catch(() => {});
  }, 320);
}

export function initLayout() {
  const splitter = $('#splitter-sidebar');
  if (!splitter) return;

  // Restore before the first paint of the list, so the pane never visibly snaps.
  const saved = state.settings?.sidebarWidth;
  if (Number.isFinite(saved)) preferredWidth = clamp(saved, MIN, MAX);
  apply();

  const app = $('#app');
  let dragging = false;

  const onMove = (event) => {
    if (!dragging) return;
    event.preventDefault();
    setSidebarWidth(event.clientX);
  };

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('is-dragging');
    app.classList.remove('is-resizing');
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', stop);
    document.removeEventListener('pointercancel', stop);
    persist();
  };

  splitter.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    splitter.classList.add('is-dragging');
    app.classList.add('is-resizing');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', stop);
    document.addEventListener('pointercancel', stop);
  });

  // Double-click resets to the default, the way Beeper's handle behaves.
  splitter.addEventListener('dblclick', () => {
    setSidebarWidth(300);
    persist();
  });

  // Arrow keys nudge the divider once it has focus.
  splitter.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 40 : 12;
    if (event.key === 'ArrowLeft') setSidebarWidth(sidebarWidth() - step);
    else if (event.key === 'ArrowRight') setSidebarWidth(sidebarWidth() + step);
    else return;
    event.preventDefault();
    persist();
  });

  // A window narrow enough to starve the thread clamps the list for us, and
  // widening it again restores the width the user actually chose.
  window.addEventListener('resize', apply);
}
