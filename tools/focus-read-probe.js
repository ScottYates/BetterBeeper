/**
 * Live probe: does coming back to the window count as having read the message?
 *
 * Reproduces the case without needing anyone to actually message: minimises the
 * window so document.hasFocus() is false, injects a message carrying isUnread
 * the way an arriving one does, confirms the render pass declines to mark it
 * read because the window is in the background, then restores the window and
 * looks again.
 *
 * Nothing is sent to anyone. The message is local state only.
 *
 * Run with the app already listening: node tools/focus-read-probe.js
 */
const WS = require('ws');
const { execFileSync } = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimise, then restore and foreground, the real OS window.
 *
 * window.blur() from the renderer is not enough: document.hasFocus() stays true
 * while the OS window is still the foreground one, so the render pass goes on
 * marking things read and the case is never actually reproduced.
 */
function windowState(action) {
  const ps = `
$code = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static IntPtr Find(string needle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (sb.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
$h = [W]::Find('${'Better Beeper'}')
if ($h -eq [IntPtr]::Zero) { $h = [W]::Find('Better') }
if ($h -eq [IntPtr]::Zero) { Write-Output 'nowindow'; exit 0 }
if ('${action}' -eq 'minimize') { [void][W]::ShowWindow($h, 6) }
if ('${action}' -eq 'restore') {
  [void][W]::ShowWindow($h, 9)
  # SetForegroundWindow is refused for a process that is not already foreground,
  # so the window would come back without ever having focus. AppActivate goes
  # through the shell and does work.
  $ws = New-Object -ComObject WScript.Shell
  [void]$ws.AppActivate($h)
}
Write-Output 'ok'
`;
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
}

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9222/json/list');
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error('no renderer page on port 9222');
}

async function main() {
  const target = await findPage();
  const ws = new WS(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  const send = (method, params) => {
    const n = ++id;
    ws.send(JSON.stringify({ id: n, method, params: params || {} }));
    return new Promise((resolve, reject) => pending.set(n, { resolve, reject }));
  };
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await sleep(3500);

  // Open the first chat that has messages.
  const opened = await evaluate(`(async () => {
    const items = [...document.querySelectorAll('#chat-list > .chat-item')];
    for (const item of items) {
      item.click();
      await new Promise((r) => setTimeout(r, 800));
      if (document.querySelector('.msg')) return 'opened';
    }
    return 'no chat opened';
  })()`);
  console.log('chat:', opened);
  if (opened !== 'opened') throw new Error(opened);

  // Counting the real call by wrapping window.beeper does not work here: the
  // preload bridge objects are frozen, so assigning to them is silently ignored
  // and the counter stays at zero whether or not the app called anything. An
  // earlier version of this probe reported "nothing marked it read" forever for
  // exactly that reason.
  //
  // So watch what markRead actually changes instead: the chat's unread count,
  // which it sets to zero and then repaints. Nothing is emitted that would
  // overwrite it from the server first - emitting chats:changed refetches the
  // chat and resets it to the server's value, which makes the badge clear for
  // entirely the wrong reason.
  console.log('minimising:', windowState('minimize'));
  await sleep(1200);
  const bg = await evaluate(`JSON.stringify({ hasFocus: document.hasFocus(), hidden: document.visibilityState })`);
  console.log('window while minimised:', bg);

  const delivered = await evaluate(`(async () => {
    const st = await import('./js/state.js');
    const chatID = st.state.activeChatID;
    const chat = st.state.chats.get(chatID);
    if (!chat) return 'no active chat';
    const existing = st.state.messages.get(chatID) || [];
    if (!existing.length) return 'chat has no messages';

    // A real message, flipped unread, rather than an invented one. markChatRead
    // is sent to Beeper with this message's id, and Beeper has never heard of a
    // made-up one: the call fails, markRead gives up, and the unread count is
    // left exactly where it was - which reads as "the fix does nothing" when in
    // fact the fix ran and the fixture was not real.
    const list = existing.map((m, i) => (i === existing.length - 1 ? Object.assign({}, m, { isUnread: true }) : m));
    st.state.messages.set(chatID, list);
    st.state.chats.set(chatID, { ...chat, unreadCount: 1 });
    // Only messages:changed. Emitting chats:changed refetches the chat from the
    // server and resets unreadCount to the server's value, which would clear the
    // very thing being measured for entirely the wrong reason.
    st.bus.emit('messages:changed', { chatID });
    await new Promise((r) => setTimeout(r, 900));
    const msgs = st.state.messages.get(chatID) || [];
    const last = msgs[msgs.length - 1] || {};
    const row = document.querySelector('#chat-list .chat-item[data-chat-id="' + chatID + '"]');
    return JSON.stringify({
      hasFocus: document.hasFocus(),
      messageID: last.id,
      unreadCount: (st.state.chats.get(chatID) || {}).unreadCount,
      lastIsUnread: !!last.isUnread,
      rowShowsUnread: !!(row && row.classList.contains('is-unread')),
      unreadPills: document.querySelectorAll('#chat-list .chat-unread').length,
    });
  })()`);
  console.log('while backgrounded:', delivered);

  // Is the running app actually the code on disk? Chromium caches file:// ES
  // modules in userData, so a renderer can still be running yesterday's
  // thread.js while the file next to it has changed. And did the DOM focus
  // event fire at all when the window was brought back?
  console.log('preflight:', await evaluate(`(async () => {
    const T = await import('./js/thre' + 'ad.js');
    window.__focusFired = 0;
    window.__visibilityFired = 0;
    window.addEventListener('focus', () => { window.__focusFired++; });
    document.addEventListener('visibilitychange', () => { window.__visibilityFired++; });
    return JSON.stringify({
      hasMarkReadOnReturn: typeof T.markReadOnReturn === 'function',
    });
  })()`));

  // Bring the window back, the way clicking the taskbar does.
  console.log('restoring:', windowState('restore'));
  await sleep(1500);

  const after = await evaluate(`(async () => {
    const st = await import('./js/state.js');
    const chatID = st.state.activeChatID;
    const msgs = st.state.messages.get(chatID) || [];
    const last = msgs[msgs.length - 1] || {};
    const row = document.querySelector('#chat-list .chat-item[data-chat-id="' + chatID + '"]');
    return JSON.stringify({
      hasFocus: document.hasFocus(),
      unreadCount: (st.state.chats.get(chatID) || {}).unreadCount,
      lastIsUnread: !!last.isUnread,
      rowShowsUnread: !!(row && row.classList.contains('is-unread')),
      unreadPills: document.querySelectorAll('#chat-list .chat-unread').length,
      focusEvents: window.__focusFired || 0,
      visibilityEvents: window.__visibilityFired || 0,
    });
  })()`);
  console.log('after focusing back:', after);

  const state = JSON.parse(after);
  const readIt = state.unreadCount === 0 && state.rowShowsUnread === false;
  console.log('');
  console.log(readIt
    ? 'RESULT: coming back to the window counted as reading it.'
    : 'RESULT: the new message is STILL unread after focusing the window.');

  // Put the message back the way it was, so nothing is left marked read.
  await evaluate(`(async () => {
    const st = await import('./js/state.js');
    const chatID = st.state.activeChatID;
    const msgs = (st.state.messages.get(chatID) || []).map((m) => Object.assign({}, m, { isUnread: false }));
    st.state.messages.set(chatID, msgs);
    st.bus.emit('messages:changed', { chatID });
    return 'cleaned';
  })()`);

  ws.close();
  process.exit(readIt ? 0 : 1);
}

main().catch((err) => {
  console.error('probe failed:', err.message);
  process.exit(1);
});