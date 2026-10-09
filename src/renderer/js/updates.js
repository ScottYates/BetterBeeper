/**
 * The update prompt, and the progress bar that follows it.
 *
 * This is deliberately the only place in the app that offers to replace itself,
 * and it never does so unprompted: the check runs on launch, the user decides,
 * and the download only starts after they accept. An app that quietly replaces
 * its own binary is an app nobody trusts with anything else.
 *
 * The progress bar is a real one rather than an indeterminate spinner, because
 * the download is a 90 MB installer and an unknown wait is the part people
 * cancel. GitHub serves the asset size in the release payload, so the true
 * fraction is known.
 */

import { $, el, clear } from './util.js';
import { api, call } from './api.js';
import { state } from './state.js';
import { openModal, closeModal, toast } from './ui.js';

const LS_KEY = 'bb:update-dismissed';

/** How often the launch check runs. A daily poll is plenty for a chat client. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

let lastCheckAt = 0;

/** Release notes, rendered as plain text. Never as markup from the network. */
function notesBlock(notes) {
  const text = String(notes || '').trim();
  if (!text) return null;
  // Capped: a long release body would otherwise stretch the modal past the
  // window, and the full notes are one click away on the releases page.
  const box = el('div', { class: 'update-notes' });
  box.append(el('div', { class: 'muted tiny', text: text.slice(0, 900) }));
  if (text.length > 900) {
    box.append(el('div', { class: 'muted tiny', text: '...' }));
  }
  return box;
}

/** '12.4 MB' / '900 KB', so the size is readable without counting digits. */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Offer an available update.
 *
 * Returns true when the user accepted, so a caller can tell the difference
 * between "declined" and "never shown". Guarded so a second prompt cannot stack
 * on the first: an update check that can queue modals will eventually queue two.
 */
let prompting = false;

export async function promptForUpdate(info) {
  if (!info?.updateAvailable || prompting) return false;
  // Never offer an install we cannot actually perform.
  if (!info.asset) {
    toast('An update is available, but there is no installer for this machine.', 'info', 6000);
    return false;
  }

  prompting = true;
  const accepted = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(value);
    };

    const body = el(
      'div',
      { class: 'update-body' },
      el('p', {
        class: 'muted',
        text: `Better Beeper ${info.version} is available. You are on ${info.current}.`,
      }),
      el('p', {
        class: 'muted tiny',
        text: `The app will close and reopen by itself. Nothing in your chats is affected.`,
      }),
      info.asset?.size
        ? el('p', { class: 'muted tiny', text: `Download size: ${formatBytes(info.asset.size)}` })
        : null,
      notesBlock(info.notes),
    );

    openModal({
      title: 'Update available',
      body,
      footer: [
        el('button', {
          class: 'btn',
          text: 'Not now',
          onClick: () => finish(false),
        }),
        el('button', {
          class: 'btn btn-primary',
          text: `Download and install`,
          onClick: () => finish(true),
        }),
      ],
      // Escape, the X and a click outside all mean "not now" rather than
      // silently cancelling an in-flight download.
      onClose: () => finish(false),
    });
  });

  prompting = false;

  if (!accepted) {
    try {
      // Remembered so a dismissed update is not re-asked on every launch.
      localStorage.setItem(LS_KEY, String(info.version));
    } catch {
      /* private mode, or storage disabled; the check simply runs again */
    }
    return false;
  }

  await runDownload(info);
  return true;
}

/**
 * Download, show the bar, then stage and quit.
 *
 * The bar is drawn in a second modal because the first one is gone by now, and
 * it is deliberately not dismissible: cancelling a half-written installer is
 * exactly the state the bar exists to avoid.
 */
async function runDownload(info) {
  const fill = el('div', { class: 'update-bar-fill' });
  const label = el('div', { class: 'muted tiny', text: 'Starting the download...' });
  const detail = el('div', { class: 'muted tiny', text: '' });

  const body = el(
    'div',
    { class: 'update-body' },
    el('div', { class: 'update-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill),
    label,
    detail,
  );

  const { body: bodyNode } = openModal({ title: `Updating to ${info.version}`, body });
  const bar = bodyNode.querySelector('.update-bar');

  // The bar has to follow the stream, which arrives over a push channel rather
  // than through the download call's own return value.
  const off = window.beeper?.on?.updaterProgress?.((progress) => {
    if (!progress || typeof progress.percent !== 'number') return;
    const pct = Math.max(0, Math.min(100, Math.round(progress.percent)));
    fill.style.width = `${pct}%`;
    bar.setAttribute('aria-valuenow', String(pct));

    if (progress.phase === 'ready') {
      label.textContent = 'Downloaded. Restarting...';
      detail.textContent = 'The app will close and reopen by itself.';
    } else {
      label.textContent = `Downloading ${pct}%`;
      const parts = [];
      if (progress.written) parts.push(formatBytes(progress.written));
      if (progress.total) parts.push(`of ${formatBytes(progress.total)}`);
      detail.textContent = parts.join(' ');
    }
  });

  try {
    const res = await call(() => api.updateDownload(), { context: 'update download' });

    if (res?.skipped) {
      off?.();
      closeModal();
      toast('That update is no longer available. Try again later.', 'info', 5000);
      return;
    }

    if (res?.requiresRestart) {
      // Give the renderer a beat to paint 100% before the window goes away.
      await new Promise((r) => setTimeout(r, 700));
      off?.();
      await api.updateQuit();
      return;
    }

    off?.();
    closeModal();
    toast('The update could not be downloaded.', 'error');
  } catch (err) {
    off?.();
    closeModal();
    toast(err?.message || 'The update could not be downloaded.', 'error');
  }
}

/** Was this exact version already declined? */
function wasDismissed(version) {
  try {
    return localStorage.getItem(LS_KEY) === String(version);
  } catch {
    return false;
  }
}

/**
 * Say so when the last install did not take.
 *
 * The app that could not install itself is gone by the time anyone could be
 * told, so this is read on the next launch. Without it a failed install is
 * indistinguishable from an update that was never offered.
 */
function reportFailedInstall(info) {
  const last = info?.lastInstall;
  if (!last || last.ok !== false) return;
  toast(
    `The last update did not install (installer exit ${last.code ?? 'unknown'}). Still on ${info.current}.`,
    'error',
    8000,
  );
}

/**
 * The launch check.
 *
 * Deferred a little after startup so it never competes with the first paint or
 * with Beeper's own discovery call, which both want the same event loop. Rate
 * limited to once a day, and skipped when the window is not visible yet or when
 * the user is mid-compose; a modal arriving on top of a half-written message is
 * the kind of thing that loses work.
 */
export async function checkForUpdatesOnLaunch({ force = false } = {}) {
  if (state.settings?.autoUpdates === false && !force) return null;

  const now = Date.now();
  if (!force && now - lastCheckAt < CHECK_INTERVAL_MS) return null;
  lastCheckAt = now;

  const info = await call(() => api.updateCheck(), { context: 'update check', fallback: null });
  if (!info) return null;
  reportFailedInstall(info);

  // A staged-but-unapplied install means we already asked and already
  // downloaded. Saying so is more useful than asking again.
  if (info.staged) {
    toast('An update is ready. Restart the app to install it.', 'info', 6000);
    return info;
  }

  if (!info.updateAvailable) return info;
  if (wasDismissed(info.version)) return info;

  // Only interrupt for something the user is not in the middle of.
  const doc = document;
  const composing = doc.querySelector('.composer textarea:focus');
  if (composing) return info;

  await promptForUpdate(info);
  return info;
}

/** The Settings button: check now, on demand, regardless of the daily limit. */
export async function checkNow() {
  lastCheckAt = Date.now();
  const info = await call(() => api.updateCheck(), { context: 'update check', fallback: null });
  if (!info) {
    toast('Could not reach GitHub to check for updates.', 'error');
    return null;
  }
  reportFailedInstall(info);
  if (info.staged) {
    toast('An update is ready. Restart the app to install it.', 'info', 6000);
    return info;
  }
  if (!info.updateAvailable) {
    toast(`Better Beeper ${info.current} is the latest version.`, 'success', 2600);
    return info;
  }
  await promptForUpdate(info);
  return info;
}