'use strict';

/**
 * A probe that starts Electron and can be told to leave Chromium's proxy
 * discovery alone, so a check can prove two things at once:
 *
 *   - with the app's policy applied, Chromium never looks for a proxy
 *   - without it, Chromium does look, and the check can see that it did
 *
 * The second half is the one that matters. A check that asserts "no proxy
 * lookup happened" is also satisfied by a Chromium that never looks, on a
 * machine where the lookup would have failed anyway - it would be measuring
 * nothing and reporting a pass. So the same probe is run twice, once with the
 * policy and once without, and the run without it has to show the lookup.
 *
 * It uses the app's own module rather than a copy of it, so a change to the
 * policy is a change to what the probe does.
 *
 * The window is hidden and the process exits on its own. Nothing here is
 * allowed to reach the desktop.
 */

const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const {
  applyProxyPolicy,
} = require(path.join(__dirname, '..', '..', 'src', 'main', 'proxy-config.js'));

// The control run is this probe with the policy left off.
if (!process.argv.includes('--no-policy')) {
  applyProxyPolicy(app.commandLine);
}

// The proxy discovery happens in the browser process as it starts, so the
// probe only has to stay alive long enough for it to be written down. The
// timeout is a backstop, not the plan.
const bail = setTimeout(() => app.exit(0), 20000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<title>proxy probe</title>');
  setTimeout(() => {
    clearTimeout(bail);
    win.destroy();
    // A graceful quit, so Chromium writes the net log out.
    app.quit();
  }, 4000);
});
