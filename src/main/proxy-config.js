'use strict';

/**
 * Chromium must not go looking for a proxy.
 *
 * The app does not need one. The renderer makes no network requests at all, and
 * the only thing the main process fetches is the GitHub release feed, which it
 * asks for with Electron's `net.fetch`. Nothing here is worth a proxy, and
 * nothing here is worth what looking for one costs.
 *
 * What looking for one costs was measured, not guessed. Chromium's proxy
 * auto-discovery looks for a WPAD file, and it looks for it by fetching
 * `http://wpad/wpad.dat`. On a machine where `wpad` resolves to something, the
 * fetch is followed wherever it leads - and where it leads here is a redirect
 * to `https://wpad/...`, on a host whose certificate does not cover the name
 * `wpad`. The handshake fails with `net_error -202`
 * (`ERR_CERT_ALT_NAME_INVALID`), and that failure is what was reported as a
 * TLS warning in the app's log. It was never the GitHub call: that one goes
 * to api.github.com, which serves a certificate for itself and was never
 * involved.
 *
 * The fix is to stop the search rather than to argue with the certificate:
 * `--proxy-server=direct://` says every request goes straight out, so there is
 * no proxy to discover and no handshake to fail. The net log of an Electron
 * process started with it contains no mention of a proxy lookup at all.
 *
 * This is deliberately a Chromium switch and not a Node setting. `net.fetch` in
 * the main process goes through Chromium's network stack, so it is the
 * Chromium proxy configuration that has to say "direct" - and it is also the
 * only place the discovery request was coming from.
 *
 * The switch has to be set before the network stack starts, which is before
 * `app.whenReady()`. Applying it later is accepted by Electron and ignored by
 * Chromium, which is the worst of both: the call looks like it worked.
 */

/**
 * The proxy configuration Chromium is given.
 *
 * `direct://` is Chromium's own spelling of "no proxy, ever": a request goes
 * to the host it names, with nothing in between. It is not a host called
 * "direct", which is what a typo here would silently produce.
 */
const DIRECT = 'direct://';

/**
 * Tell Chromium to go straight out, and not to look for a proxy on the way.
 *
 * `commandLine` is `app.commandLine`, passed in rather than required so this
 * can be exercised without Electron.
 */
function applyProxyPolicy(commandLine) {
  if (!commandLine || typeof commandLine.appendSwitch !== 'function') return false;
  commandLine.appendSwitch('proxy-server', DIRECT);
  return true;
}

module.exports = { applyProxyPolicy, DIRECT };
