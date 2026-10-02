/**
 * Dev-only: stop a check harness from needing to be killed from outside.
 *
 * A harness that opens a real BrowserWindow and has to be terminated by an
 * outer timeout makes Electron raise its own "A JavaScript error occurred in
 * the Electron process" dialog on the developer's desktop, which looks like the
 * app under test crashing. A stalled check should give up on its own instead.
 *
 * The timer is deliberately not unref'd: while the window is open it is what
 * keeps the loop alive, and clearGuard() drops it on a normal finish.
 */
module.exports = function harnessGuard(app, { ms = 60000, label = 'check' } = {}) {
  const timer = setTimeout(() => {
    console.error(`${label}: still running after ${ms}ms, giving up`);
    try {
      app.exit(1);
    } catch {
      process.exit(1);
    }
  }, ms);

  return function clearGuard() {
    clearTimeout(timer);
  };
};
