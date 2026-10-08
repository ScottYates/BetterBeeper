/**
 * The standalone image viewer window.
 *
 * Opened as its own always-on-top window above the app rather than as an
 * overlay inside it, so the image is limited by the display rather than by the
 * main window's size, and so zooming here never scrolls or re-renders the chat
 * list or thread behind it.
 *
 *   wheel / trackpad  -> zoom toward the pointer
 *   drag              -> pan, as far as you like
 *   double-click      -> toggle fit and 2x
 *   + / - / 0         -> step in, step out, reset to fit
 *   Esc, click, X     -> close
 *
 * The image URL arrives as a query parameter so the window can be a plain
 * `loadFile` with no IPC round trip and no Node access in the renderer.
 */

const MIN_SCALE = 0.1;
const MAX_SCALE = 12;

const stage = document.getElementById('stage');
const img = document.getElementById('img');
const zoomLabel = document.getElementById('zoom');
const errorBox = document.getElementById('error');
const hint = document.getElementById('hint');

const params = new URLSearchParams(location.search);
const src = params.get('src') || '';
const alt = params.get('alt') || '';

if (alt) img.alt = alt;
if (src) img.src = src;
else errorBox.hidden = false;

img.addEventListener('error', () => { errorBox.hidden = false; });

// scale is relative to "fit"; the initial fit is measured once the image loads.
const view = { scale: 1, x: 0, y: 0 };
let fit = 1;
let dragging = null;
let moved = 0;

function apply() {
  img.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale * fit})`;
  zoomLabel.textContent = `${Math.round(view.scale * fit * 100)}%`;
  stage.classList.toggle('is-zoomed', view.scale > 1.01);
}

function measureFit() {
  const rect = stage.getBoundingClientRect();
  // The image's own natural size, capped to whatever room the window gives it.
  const w = img.naturalWidth || rect.width;
  const h = img.naturalHeight || rect.height;
  if (!w || !h) return 1;
  return Math.min(rect.width / w, rect.height / h, 1);
}

/**
 * Deliberately no clamp on the pan.
 *
 * There used to be one, and it was wrong in a way that made the image
 * impossible to use. It computed how far the image could move from the size of
 * the *window* rather than the size of the *image*, which are different numbers
 * once the image has been scaled to fit.
 *
 * Measured on a 1200x4000 portrait image in a 2226x939 window, zoomed in four
 * times: the image was really 3756 pixels tall, the clamp believed it was 939,
 * and it allowed 347 pixels of upward drag where 1408 were needed to bring the
 * bottom of the picture into view. The reported symptom - cannot drag it up far
 * enough to see all of it - is that, exactly.
 *
 * Free movement is what a viewer should do anyway. Fit, the 0 key and a
 * double-click all put the image back, so there is no way to be stranded.
 */

function setScale(next, anchorX, anchorY) {
  const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
  if (clamped === view.scale) return;

  const rect = stage.getBoundingClientRect();
  const cx = anchorX ?? rect.width / 2;
  const cy = anchorY ?? rect.height / 2;
  const ratio = clamped / view.scale;
  // Keep the point under the pointer (or the centre) pinned while scaling.
  view.x = cx - (cx - view.x) * ratio;
  view.y = cy - (cy - view.y) * ratio;
  view.scale = clamped;

  apply();
}

function reset() {
  view.scale = 1;
  view.x = 0;
  view.y = 0;
  apply();
}

function zoomBy(factor) {
  setScale(view.scale * factor);
}

function close() {
  window.close();
}

stage.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    const factor = Math.exp(-event.deltaY * 0.0016);
    setScale(view.scale * factor, event.clientX - rect.left, event.clientY - rect.top);
    hint.classList.add('is-faded');
  },
  { passive: false },
);

stage.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  dragging = { x: event.clientX - view.x, y: event.clientY - view.y };
  moved = 0;
  stage.setPointerCapture(event.pointerId);
  stage.classList.add('is-dragging');
});

stage.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  const nextX = event.clientX - dragging.x;
  const nextY = event.clientY - dragging.y;
  moved = Math.max(moved, Math.abs(nextX - view.x) + Math.abs(nextY - view.y));
  view.x = nextX;
  view.y = nextY;
  apply();
});

stage.addEventListener('pointerup', (event) => {
  const wasDragging = dragging;
  dragging = null;
  stage.releasePointerCapture?.(event.pointerId);
  stage.classList.remove('is-dragging');
  // A press that did not move is a click, which closes the viewer.
  if (wasDragging && moved < 5) close();
});

stage.addEventListener('dblclick', () => {
  setScale(view.scale > 1.05 ? 1 : 2.5);
});

document.getElementById('zoom-in').addEventListener('click', (e) => { e.stopPropagation(); zoomBy(1.25); });
document.getElementById('zoom-out').addEventListener('click', (e) => { e.stopPropagation(); zoomBy(1 / 1.25); });
document.getElementById('zoom-fit').addEventListener('click', (e) => { e.stopPropagation(); reset(); });
document.getElementById('close').addEventListener('click', (e) => { e.stopPropagation(); close(); });

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); close(); return; }
  if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.25); return; }
  if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomBy(1 / 1.25); return; }
  if (event.key === '0') { event.preventDefault(); reset(); }
});

// Refit when the window itself is resized, so the image never ends up cropped.
window.addEventListener('resize', () => {
  fit = measureFit();
  apply();
});

img.addEventListener('load', () => {
  fit = measureFit();
  reset();
});
