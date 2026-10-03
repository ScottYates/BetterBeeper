# Better Beeper

A desktop chat client for [Beeper Desktop](https://beeper.com), built on Beeper's
[Desktop API](https://developers.beeper.com/desktop-api/).

The chat UI talks to Beeper's REST API and its live WebSocket event stream. An optional AI
assistant panel talks to Beeper's built-in **MCP** server, so a model can search and read your
chats, and send, with every action shown to you before it happens.

> No screenshots in this repository. The development captures of this app show real contact
> names, phone numbers and private message text, so they are not published. The one image below
> is a synthetic sheet of the hand-drawn network glyphs and contains no user data.

---

## Features

**Chat**

- Sidebar across every connected network, with unread counts, pins, mutes, drafts and archive
- The header is a view switcher. Clicking "Inbox" opens a menu of Inbox, Unread and Archive,
  the current one is marked, and the label follows the view you pick
- There is no Voice calls row. Beeper's Desktop API has no calls endpoint at all; the v1 spec
  covers chats, messages, contacts, assets, search and setup. A call history entry could never
  list anything, so it was built once to check the live spec and then removed
- Note chats are pinned to the top of the list and are otherwise ordinary rows: same height,
  same padding, same preview line as every other chat, with a pin marking why they are up
  there. Clicking one opens the note. Its avatar is your profile picture, so it does not open
  the image viewer. The pin is a real pin, so a note can be unpinned from the header and it
  moves down with everything else
- Each avatar carries a brand glyph for its source network: Signal, Google Voice, Facebook,
  WhatsApp, Instagram, Telegram, Discord and about 20 more, drawn as inline SVG on a
  brand-coloured disc. An unmapped bridge falls back to a monogram, so a new network still
  reads correctly. Google Voice uses its real green-gradient mark on a near-black disc, because
  a green glyph on a green disc is invisible. Facebook and Messenger use the lowercase `f`,
  which is the part of the logo that survives being shrunk to 16 px on a coloured disc
- A bubble in a multi-network chat carries its own network badge, so you can see which bridge a
  message arrived on
- Drag the divider between the list and the thread to resize the conversation list (200-620px).
  Double-click the divider to reset it, or focus it and use the arrow keys
- The window is freely resizable, and both the window size and the list width are remembered
  between runs
- Text size is adjustable and remembered, in five steps from 90% to 150%. It scales the whole
  UI, so type, icons, bubbles and spacing grow together, and it is reapplied before the first
  paint so the window never opens at one size and then jumps to another
- Thread view with day dividers, read receipts, reply quoting, and per-message hover actions
- Beeper-style bubbles: the timestamp sits inside the bubble at its trailing edge, and sender
  names are hidden in one-to-one chats because the header already says who you are talking to
- Send, edit, delete, and emoji-react to messages
- Attach files, which are uploaded to Beeper and then referenced by the message
- Paste an image straight into the composer with Ctrl+V. A pasted screenshot is a clipboard
  file with no text beside it, so there is nothing for the textarea to insert; it is uploaded
  and chipped onto the message instead. Works wherever focus happens to be in the thread, and
  an ordinary text paste is left completely alone
- Right-click any image in a message to open it, copy it, or copy its address. "Copy image"
  puts a real picture on the system clipboard rather than a path or a URL, so it pastes as a
  picture into this app and into anything else on the desktop
- Hide any message behind an arrow to get it out of the way, and delete one "on this device"
  only, for when you want a message gone for you without it disappearing for everyone else.
  Neither tells Beeper anything. A local delete leaves a tombstone you can click to bring the
  message back, because a delete that silently throws the text away is not one to do by accident
- Animated GIFs animate as they should: nothing in the stylesheet suppresses image animation,
  and `loading="lazy"` does not hold them still
- Independent vertical scrolling for the chat list and the message thread, with infinite
  scroll backwards through history
- Opening a chat always lands on its newest message, even when you were scrolled up in the
  previous one and even when images are still decoding
- Hover any row to archive it without opening it. The button becomes "Move back to inbox" on
  the same row once archived, so the Archive view is a two-way door. Archiving is confirmed
  against Beeper rather than assumed, and the one chat Beeper refuses to archive stays archived
  here anyway (see "Beeper accepts isPinned and then ignores it" below)
- Mute, pin, archive and mark-unread from the thread header
- Pinning is kept in this app rather than at Beeper. Beeper's Desktop API accepts
  `isPinned` on `PATCH /v1/chats/{id}` and then drops it, so the pin set lives in
  `settings.json` and the list is ordered by it
- `Esc` closes the open chat and returns you to the list
- Desktop notifications for messages that arrive while the window is in the background, with a
  full preference set under Settings > Notifications, including a master switch to turn them
  off entirely

**Tooltips**

- Every icon button has a hover tooltip, drawn by the app rather than the browser's native
  `title`, so it matches the rest of the styling and never flashes late
- Tooltips flip above or below the button depending on available space, and appear after a
  420 ms dwell so they do not fire as the pointer crosses the toolbar
- Labels follow state: the archive button reads "Archive chat" until you archive, then
  "Move back to inbox". The same applies to mute and pin

**Chat list layout**

- Collapsible search and filter rows under the Inbox header, matching Beeper's compact header
- Rows are ordered pinned first, then by recency. Notes to self count as pinned, which is what
  keeps them at the top by default, so unpinned they drop back into the recency order like any
  other chat. Archived chats drop out of the main list. Ordering is the only thing pinning
  changes; it never resizes a row

**Message width**

- A message uses the whole chat pane. It used to stop at `max-width: min(620px, 72%)`, which
  left a dead column down the right of any window with room to spare - the percentage, not the
  620px, was doing the damage at normal sizes. Short messages still hug their text, because the
  wrap is sized by content up to the cap
- The cap is now `min(100%, 880px)`. The 880px only matters on a very wide window, where a
  bubble stretched across 2000px would run to about 150 characters a line
- Inline images stay at their original 340px, and that is deliberate. Widening the cap to
  `min(100%, 520px)` looks correct and does nothing: the image sits *inside* `.msg-bubble`,
  which is `fit-content`, so the percentage resolves against a width the image itself is
  deciding and the browser answers with roughly the intrinsic size. Giving an image real room
  means letting the text bubble containing it grow to the full row, which changes the text
  layout as well. That is a bigger change than this one, and it is the obvious next step if
  the preview still reads as too small
- `check:layout` measures the rendered boxes against the real stylesheet, so a cap written as a
  percentage, a pixel value or a `calc()` all fail it. It drops from 6/6 to 2/6 on the old rule

**Image viewer**

- Click any image or avatar and it opens in its own frameless window on top of the app, sized
  to fill the same monitor the Better Beeper window is on, so it never appears over a different
  screen
- The window is always on top at `screen-saver` level and visible on all workspaces, so it stays
  put over full-screen apps. Only one viewer exists at a time, and closing it hands focus back
  to the chat
- Mouse wheel or trackpad zooms, anchored on the pointer so the pixel under the cursor stays put
- Click and drag pans once zoomed in (10% to 1200%)
- Double-click toggles between fit and 2.5x, `+` and `-` step, `0` resets, and `Fit` re-fits
  after the screen changes
- Click without dragging, `Esc`, or the close button closes the viewer

**Search**

- One box for both chat titles and full message history
- Scope filter (All, Chats, Messages), with the query highlighted in results
- Clicking a result jumps to that exact message in its thread

**New chat**

- Search contacts on any account and start single or group conversations

**Live**

- WebSocket event stream with automatic reconnection and backoff
- Messages, reactions and chat state update in place. The open chat is always subscribed, even
  when it is not one of the most recent

**Assistant (MCP)**

- Connects to Beeper's built-in MCP server at `http://localhost:23373/v0/mcp`
- Streams its replies and shows every tool it calls, with arguments and results
- Bring your own model: any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, Ollama, LM
  Studio, vLLM) or Anthropic. The key is encrypted in your OS keychain and is only used from the
  main process

**Security**

- OAuth 2.0 + PKCE with dynamic client registration, so there is no manual token copy-paste
- Access token and AI key encrypted at rest through Electron `safeStorage` (DPAPI on Windows)
- `contextIsolation` on, `nodeIntegration` off, strict CSP
- Message HTML passes through a DOM-based allowlist sanitizer, so a chat cannot inject markup
- Local media is served over a dedicated `beeper-file://` protocol instead of disabling
  `webSecurity`

---

## Requirements

- Beeper Desktop running on this machine, with the Desktop API enabled (Beeper > Settings >
  Integrations > Desktop API). It listens on `http://localhost:23373`.
- Node.js 20 or newer to build and run from source.

## Run from source

```bash
npm install
npm start
```

On first launch the app detects Beeper and walks you through approval. It registers itself as an
OAuth client, opens Beeper's own consent dialog, and exchanges the result for a token. You click
**Approve** once; the token is stored encrypted and reused on every later launch.

To paste a token yourself, use **Use a token instead** on the connect screen. Create one in
Beeper > Settings > Integrations > Approved connections, then **+**.

## Build and install

```bash
npm run dist           # build the installer, then silently replace the installed app
npm run dist:only      # build only, leave the installed app alone
npm run deploy         # re-run just the install, using the installer already in release/
npm run deploy:check   # report what would happen, install nothing
npm run pack           # unpacked build -> release/win-unpacked/

npm run check:notify   # notification preference logic
npm run check:send     # optimistic-send bubble absorption
npm run check:rich      # message HTML sanitizing keeps the markup's structure
npm run check:pin       # pinning moves the row and flags it, notes included
npm run check:archive   # archiving survives a Beeper that accepts and ignores it
npm run check:layout    # message bubbles use the full width of the chat pane
npm run check:composer  # the composer placeholder names one person and stays one line
npm run check:paste     # a pasted image becomes an attachment; a text paste is not swallowed
npm run check:imagecopy # which image URLs may be copied, and how they map back to bytes
npm run check:api       # the preload surface, the IPC handlers and the renderer agree
npm run check:visibility # hiding and locally deleting a message, and surviving a restart
npm run check:gif       # an animated GIF really advances frames on screen
npm run check:syntax    # every JS file parses, so a broken check cannot pose as an app crash
npm run check:bump      # the semver level chosen from a commit message is right
npm run check:released  # every push to main has a release
npm run check:icons     # network glyphs, including the self-coloured Google Voice mark
npm run check:ascii     # documentation and code comments stay ASCII
npm run check:live     # send a real message, then assert the thread and the list are intact
```

Two of the clipboard checks need the app running and a real clipboard, because only a real
clipboard can answer whether something is pasteable. They attach and remove an attachment in the
Note to self chat and never send a message:

```bash
"Better Beeper.exe" --remote-debugging-port=9222
npm run check:paste-live
npm run check:imagecopy-live   # copies an image, then pastes it straight back
```

## Releasing

**Every push to `main` gets a release.** `npm run release` does the whole thing, and the
version number is not a judgement call - it is derived from the commit messages since the last
tag:

| commits since the last tag | bump |
|---|---|
| `fix:` or `perf:` | patch |
| `feat:` | minor |
| a `!` after the type, or a `BREAKING CHANGE:` trailer | major |
| anything else, including `docs:` and `chore:` | patch |

It never declines to cut a release, because `check:released` would then fail forever on a push
that semver says needs nothing. Semver picks how big, not whether. `--bump=<level>` overrides
the derived level, and `--dry-run` prints the decision without changing anything.

The steps, in order: bump `package.json`, build to a scratch directory, install over the
existing copy, `gh release create` tagged on `main`, then **fetch the published asset back and
compare SHA-256 against what was built**. That last step is not ceremony. A CLI reporting
success is not evidence that 90 MB arrived intact, and a truncated upload looks exactly like
success until somebody tries to install it.

`check:released` is the enforcement. It fails when `main` is ahead of the newest tag, and when
`package.json` and that tag disagree, which is the usual way a version bump gets lost between
the commit and the upload. It is read-only, so it is safe to run at any time.

Two details worth knowing if you run this by hand:

- `gh` creates the tag on the remote only. Both scripts `git fetch --tags` first, because
  otherwise the repo you just released looks unreleased forever.
- The breaking-change trailer is matched case-sensitively, as the spec defines it. Bodies
  routinely say "not a breaking change", and reading that as a major would be worse than
  missing an unlabelled one.

`npm run dist` is the one command you need. It builds the NSIS installer and then runs it with
`/S`, so the copy in **Start menu -> Better Beeper** is replaced for you. You never run the setup
file by hand.

`tools/install-update.js` does the install side:

1. Finds the existing install through the per-user uninstall registry key, so a custom install
   directory still works. Falls back to `%LOCALAPPDATA%\Programs\Better Beeper`.
2. Closes any running copy. The app runs as 4 processes, and the installer cannot replace locked
   files, so an open window would otherwise fail the install.
3. Runs the installer silently through NSIS `/S` and waits for it.
4. Verifies by content, comparing the SHA-256 of the installed `resources/app.asar` against the
   freshly built one. Timestamps do not work here: the installed exe carries the timestamp of
   the build inside it, which is older than the setup.exe that carries it. Comparing content
   also makes a repeat `npm run deploy` a no-op that still passes.

To stop the installer closing your window, use `npm run dist:only` and update by hand.
`node tools/install-update.js --keep-running` skips step 2 as well.

---

## Configuration

Open **Settings** from the gear icon in the sidebar.

| Setting | Notes |
| --- | --- |
| Assistant provider | `OpenAI-compatible` or `Anthropic` |
| Base URL | for example `https://api.openai.com/v1`, or `http://localhost:11434/v1` for Ollama |
| Model | Model identifier, for example `gpt-4o-mini` |
| API key | Stored encrypted; blank means "keep the existing key" |
| Theme | `system`, `dark`, `light` |
| Text size | `Small` through `Largest` (90% to 150%). Scales the whole UI and is restored before the first paint |
| Enter to send | Off to use `Ctrl/Cmd+Enter` instead |
| Mark read on open | Applies when you open a chat |
| Show desktop notifications | Master switch; off means no notifications at all |
| Show in the notification | `Sender and message text`, `Sender only`, or `Nothing` |
| Also notify for muted chats | Off by default, so muted chats stay quiet |
| Play a sound | Silent notifications when off |
| Notify while focused | Off by default, so you only hear about messages when the window is in the background |

Notifications never fire for your own outgoing messages, and clicking one restores and focuses
the window. The logic lives in `src/main/notify.js` as pure functions, so it can be checked
without a live message:

```bash
npm run check:notify    # 18 cases across every preference combination
```

The conversation list width, and the window size, position and maximized state, are remembered
automatically and need no setting. Stored bounds are clamped to whichever display currently
owns them, so unplugging a monitor cannot strand the window off-screen.

Data lives in Electron's `userData` directory, which is `%APPDATA%\Better Beeper` on Windows.
The directory is named after `productName`, not the npm package name.

- `auth.json` holds the OAuth client and access token, encrypted
- `settings.json` holds preferences, the AI endpoint and the encrypted key

**Disconnect** in Settings revokes the token at Beeper and deletes the local copy.

### Upgrading from "Beeper Desktop Chat"

The app was renamed to **Better Beeper**. Preferences migrate automatically: `settings.json` is
copied out of the old `%APPDATA%\Beeper Desktop Chat` folder on first launch.

The stored Beeper token does not migrate. Electron's `safeStorage` binds its ciphertext to the
app name, so a token encrypted as "Beeper Desktop Chat" cannot be decrypted as "Better Beeper".
You will be asked to approve the connection once more in Beeper. After that the token is stored
and reused like any other.

The previous install folder at `%LOCALAPPDATA%\Programs\Beeper Desktop Chat` is left on disk
after the first install under the new name. It is unused and safe to delete.

---

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + N` | New chat |
| `Ctrl/Cmd + F` or `Ctrl/Cmd + K` | Focus search |
| `Ctrl/Cmd + Shift + A` | Toggle the assistant panel |
| `Enter` / `Shift+Enter` | Send / newline |
| `Esc` | Close the open chat; close menus, popovers, modals and the image viewer first |
| Wheel | Scroll the list under the cursor; zoom inside the image viewer window |
| Drag | Pan inside the image viewer window |

---

## Architecture

```
src/
  main/            Node side. Owns the Beeper token; the renderer never sees it.
    main.js          app lifecycle, window, beeper-file:// protocol, notifications
    config.js        endpoint map, OAuth constants, page sizes, timeouts
    auth.js          OAuth 2.0 + PKCE, RFC 7591 client registration, loopback redirect
    token-store.js   encrypted token persistence
    settings.js      preferences + encrypted AI key
    beeper-client.js REST client (chats, messages, assets, contacts, search)
    beeper-ws.js     WebSocket event stream with backoff reconnection
    mcp-client.js    MCP client for Beeper's built-in server
    assistant.js     tool-calling loop against an OpenAI-compatible or Anthropic model
    ipc.js           the whole renderer-facing IPC surface
  preload/
    preload.js       contextBridge: the only surface the renderer can reach
  renderer/
    index.html       app shell
    styles.css       design tokens, dark/light themes
    js/              main, sidebar, thread, assistant, modals, state, api, ui, util
    viewer.html      the image-viewer window's own shell
    viewer.css       viewer chrome: zoom badge, toolbar, hint
    js/viewer.js     viewer zoom / pan / close, standalone (no preload, sandboxed)
  tools/
    cdp.js           dev helper: evaluate JS in the running renderer, capture screenshots
    click.js         dev helper: dispatch a real mouse click on an element
    wheel.js         dev helper: dispatch a real wheel event, assert the target scrolled
    drag.js          dev helper: dispatch a real press-move-release, assert the drag landed
    hover.js         dev helper: move the real mouse onto an element, assert hover-only UI shows
    press-key.js     dev helper: send a real key press, assert keyboard shortcuts
    verify-asar.js    dev helper: hash every src/ file against a packaged app.asar
    install-update.js post-build: silently replace the installed copy, then verify it
    notify-check.js   check: notification preferences, no app or message needed
    send-check.js     check: optimistic-bubble absorption in the live state module
    send-harness.html page that hosts send-check.js (a data: URL cannot import ES modules)
    rich-text-check.js  check: the message HTML sanitizer keeps lists, links and emphasis
    rich-harness.html   page that hosts rich-text-check.js, for the same reason
    live-send.js      check: drive the running app's composer end to end
    pin-check.js     check: pin and unpin move the row and its flag, notes included
    pin-harness.html page that hosts pin-check.js, for the same reason
    archive-check.js  check: an archive survives a Beeper that accepts and ignores it
    archive-harness.html  page that hosts archive-check.js, for the same reason
    layout-check.js   check: a message bubble fills the chat pane, measured not grepped
    layout-harness.html  page that hosts layout-check.js, against the real stylesheet
    syntax-check.js   check: every JS file parses, so a broken check cannot look like a crash
    harness-guard.js  dev helper: a check harness expires on its own instead of being killed
    release.js        bump the version from the commits, build, install, publish, verify by hash
    released-check.js check: every push to main has a release
    bump-check.js     check: the semver level a commit message produces is the right one
    icon-check.mjs    check: every network glyph still renders, self-coloured or not
    ascii-check.js    check: markdown and code comments stay ASCII
    badge-probe.js    dev helper: prove glyph badges stay square and monograms stay pills
    glyph-sheet.js    dev helper: render every shipped glyph large, on real badge colours
    glyph-candidates.js  dev helper: render one network's candidate marks side by side
    gv-preview.js     dev helper: compare Google Voice mark candidates side by side
    msg-dump.js       dev helper: dump raw message records behind the last few bubbles
    window-bounds.js  dev helper: report real browser-window bounds (Browser domain)
    probe-bounds.js   dev helper: seed settings.json windowBounds to test restore clamping
```

### Matching Beeper's behaviour

A few things had to be worked out rather than read off the spec, because the API returns data
that Beeper's own UI interprets on the client side:

- **Note to self** is detected structurally, as a chat where every participant has `isSelf` set,
  rather than by matching the title. That way it covers both Beeper's "Note to self" and
  Signal's "Signal Note to Self". It is a Signal chat, so it also carries a Signal network badge
  and can legitimately contain a second note chat. The list shows each as its own row.
- **Timestamps sit inside the bubble** at its trailing edge, and sender names are suppressed in
  one-to-one chats. Both match Beeper.
- **`seen` is polymorphic.** Matrix returns a `{ userID: ISO }` map while other bridges return a
  single timestamp, so `seenAt()` unwraps whichever shape arrives and shows the latest.
- **Network glyphs are hand-drawn.** Beeper reports network names but never ships artwork, so
  `network-icons.js` holds a mark per network on a 16x16 grid, rendered white on the
  brand-coloured badge. Unknown networks fall back to a monogram.

  ![Network glyphs](docs/network-glyphs.png)

- **Google Voice is the exception.** Its real mark is a green gradient, and its brand disc is
  also green, so a self-coloured glyph on the usual disc renders as a flat green circle with an
  invisible speck. That was verified, not assumed. It ships its own near-black disc through
  `badgeBackground()` and paints itself, like the real app icon. Every other mark stays
  monochrome so the list still reads as one set.
- **A round badge needs a square box.** The badge carried `padding: 0 3px` with
  `box-sizing: content-box`, because a two-letter monogram needs horizontal room. That padding
  applied to every badge, making them 23x21, and `border-radius: 50%` on a non-square box draws
  an oval rather than a circle, so all 87 badges were subtly squashed. Glyph badges are now a
  fixed 21x21 circle and the monogram fallback has its own `.is-mono` pill. `check:live` asserts
  the square-ness, and that assertion was confirmed by reintroducing the bug (87 ovals at
  31x25).
- **`markRead` runs on every re-render**, so a message Beeper refuses to mark read would retry
  forever and bury the thread under identical error toasts. Failures are remembered per
  `chat/message` for a minute before being retried.

### Behaviours that are easy to break

Each of these caused a real bug here.

- **The HTML sanitizer must nest, not just filter.** The allowlist walk appended each
  cleaned element and then appended that element's children as its *siblings*, so every
  permitted tag rendered empty with its content hoisted beside it. A plain `<p>` still looked
  right because the text survived, which is exactly why this went unnoticed, but a bulleted
  message arrived as an empty `<ul>` followed by loose `<li>`s: bullets out in the margin,
  no hanging indent, and a large gap between items. `<em>` and `<strong>` lost their emphasis
  and `<a>` stopped being a link. The children now go inside the element. `check:rich` covers
  it, and was confirmed by putting the two lines back the wrong way round: 9 of 19 assertions
  fail, reporting `ul had siblings: UL,LI,LI`.
- **Message bodies need `white-space: pre-wrap`, which turns source formatting into blank lines.**
  That rule is what makes a plain-text message keep the line breaks the user pressed. It also means
  the newlines a sender's *HTML* is indented with become visible: a list arriving as
  `<ul>\n<li>a</li>\n<li>b</li>\n</ul>` rendered with an empty line under every bullet, even after
  the nesting was fixed. The sanitizer now drops whitespace-only text nodes, but only where they
  are clearly formatting: the parent is a list, or an element sibling is a block-level element.
  Inline spacing is left alone, because the single space in `<strong>a</strong> <em>b</em>` is
  content, and removing it would run the words together. `check:rich` asserts both directions.
- **Unpinning a note chat appeared to do nothing.** The note-to-self rows were built by their own
  `noteItem()` that hard-coded the pin flag, and were appended from a partition of the list ahead
  of everything else. So a note could be unpinned with the header button and nothing on screen
  would change: the button said off while the row kept its paperclip and stayed at the top. Note
  chats are now pinned by default because `isPinned()` treats them that way, and they go through
  the same sort and the same flag builder as every other row. `check:pin` covers the round trip
  for both kinds of chat, and drops from 11/11 to 2/11 if the hard-coded flag comes back.
- **Two copies of the app can both be running, and only one owns the debug port.** A dev run that
  fails to bind `:9222` leaves the installed copy answering every `tools/cdp.js` evaluation, so a
  change looks like it did nothing. `cdp.js` now prints the URL it attached to on every call,
  which is the fastest way to notice. `check:rich` also runs against a throwaway profile, since
  Chromium caches `file://` modules in `userData` and a check that inherits that cache is not a
  check.
- **A broken check looks exactly like the app crashing.** A comment containing backticks was
  written inside the template literal holding a check harness's page script. The backticks
  closed the string early and the file became a `SyntaxError`, which under `electron` is an
  uncaught exception in the main process: a modal "A JavaScript error occurred" dialog on the
  desktop, naming `tools/layout-check.js` and not the app. The app was fine the whole time.

  Two things now stop that recurring. `check:syntax` runs `node --check` over every JS file in
  plain Node, with no window and therefore no possible dialog, and it also extracts each
  harness's page script out of its template literal and parses that - a file can be perfectly
  valid and still be broken inside the string. It caught both mistakes made here: a comment
  with backticks, and a parameter shadowed by a `const` in the same function. Each harness also
  installs `harness-guard.js`, so a stalled check exits on its own instead of waiting to be
  killed from outside - being killed is what turns a bad moment into a dialog. Neither would
  have helped if the mistake had been made inside the renderer, but the renderer is loaded and
  exercised by the app itself on every launch.
- **Beeper accepts `isPinned` and then ignores it.** `PATCH /v1/chats/{id}` answers 200 and
  returns the value from before the change, and a fresh `GET` a second later confirms nothing
  moved. Verified on 4.3.160 across Signal, Google Voice and Matrix, while `isMuted` and
  `isLowPriority` on the same endpoint do apply, so it is the field and not the call. The pin
  set is therefore kept in this app, as a map of chatID to the user's choice. It is a map and
  not a set of pinned ids because Beeper does report some chats as pinned on its own, the
  note-to-self rows, and a set could add those but never remove them. The client still sends the
  PATCH, so that the two sources agree if Beeper ever starts honouring the field, but it never
  merges the response: that response carries the pre-change value and would undo the pin.
- **Beeper also ignores `isArchived` for its own built-in "Note to self" chat.** Same shape as
  the pin: `PATCH /v1/chats/{id}` answers ok, and a fresh `GET` still reports `isArchived`
  false. It is specific to that one chat, though - ordinary chats and the Signal note-to-self
  chat archive and restore fine, which is why this went unnoticed for so long.

  The old code set the flag optimistically and trusted it. That made the archive look broken:
  the row would leave the list for a moment and the next chat event would merge Beeper's stale
  value straight back in. Archiving now reads the chat back afterwards and compares. Only when
  Beeper disagrees is the user's choice recorded locally, and the list filters on the resolved
  value rather than on the raw field.

  Two details matter. Nothing is recorded when the confirming `GET` itself fails, because a
  request that could not be checked is not evidence that it was ignored. And the read is
  retried a few times, because the `GET` is not ordered behind the `PATCH` - Beeper can report
  the old value for a moment after accepting a write, and a single read made an ordinary
  archive look ignored. Only `true` is ever stored, with restoring deleting the entry, so the
  override map stays limited to the chat that needs it and an archive made in another Beeper
  client is not shadowed here.

  `check:archive` drives this against a stub that can be told to ignore the request, or to
  apply it late. It drops from 11/11 to 6/9 if the confirmation is removed.
- **Construction-time window bounds are wrong on a mixed-DPI desktop.** The width and height
  passed to the `BrowserWindow` constructor are converted using the *primary* display's scale
  factor, so on a second monitor at a different scale the window arrives at the wrong size. A
  window asked for 720x520 opened at 480x347 on a primary display set to 150%. Position was
  unaffected, which made it look like a clamping bug. Re-applying the same bounds with
  `setBounds()` once the window exists uses the scale of the display it actually landed on, and
  the size then holds. The position has to be guarded with `Number.isFinite` the same way the
  constructor guards it, because `setBounds` converts its arguments eagerly and throws on
  `undefined` on a first run with nothing stored.
- **Pick the viewer's display from the window, not from a rectangle.** The viewer opens full-size
  on one monitor, so getting this wrong drops an always-on-top window over whatever the user is
  working in. It first used `screen.getDisplayMatching(mainWindow.getBounds())`, which answers
  "which display overlaps this rect" and returned the primary display on a multi-monitor setup.
  It now asks `mainWindow.getDisplay()`, which is the question being asked, and keeps
  `getDisplayMatching()` only as a fallback.
- **Text size uses page zoom rather than a CSS `font-size` override.** Three things in this UI
  convert between pointer coordinates and CSS pixels: the sidebar splitter, which sets the width
  from `event.clientX`; the tooltip placement; and the popover clamping. The sidebar also carries
  a 200-620px clamp. Scaling only the type would grow the words while every box, every pointer
  calculation and that clamp kept describing the old size, so the splitter would drift out of
  step with the divider it is supposed to be dragging. Page zoom scales type, boxes and hit
  targets together and keeps all of it in one coordinate space. It is also the mechanism the View
  menu's `zoomIn` / `zoomOut` / `resetZoom` roles already used.
- **Chromium restores its own page zoom after you set one.** Page zoom is persisted per origin,
  so a zoom set through the View menu, or by an earlier version of the app, comes back on the
  next launch and overwrites anything applied before the document loaded. The symptom is
  confusing: the setting is stored correctly and the Settings dialog shows the right value while
  the window is not that size. Both windows re-apply the saved scale on
  `did-finish-load`, so the stored value wins.
- **The optimistic bubble must be inserted before the send round trip, not after.** Beeper can
  deliver the authoritative copy over the WebSocket while `sendMessage()` is still awaiting its
  response; the Signal bridge does this reliably. The placeholder was originally created from the
  response, so it did not exist yet when the echo arrived, could not be absorbed, and the real
  message landed beside it. The placeholder then sat on "Sending" forever, because a placeholder
  only ever leaves by being absorbed. It now goes in first under a local `~txn:` id, and once the
  response returns, `rekeyMessage()` adopts the `pendingMessageID` Beeper hands back so the
  authoritative message merges into that same bubble. Re-keying is a no-op when the echo already
  absorbed it, which is the good case.
- **A reaction is its own message row.** A `REACTION` event carries its own `id` and
  `linkedMessageID`, and it renders inside the row of the message it reacts to. Anything that
  counts rendered rows by `data-message-id` will double-count every message that has a reaction
  on it; count the `.msg-bubble` text instead. `tools/live-send.js` was wrong this way and
  reported a phantom duplicate that did not exist.
- **Some Beeper endpoints answer 204 with no body.** Unarchiving a chat succeeds but resolves to
  `null`, so `if (!ok) return` silently discards a successful call. Callers that must tell
  success from failure use `callOk()` from `api.js` and compare against the exported `FAILED`
  sentinel instead of testing the result for truthiness.
- **Chrome's scroll anchoring fights "scroll to bottom".** When an image above the viewport
  finishes loading, Chrome shifts `scrollTop` to keep the anchored node still, and that fires a
  scroll event, which the app would otherwise read as the user scrolling up and abandon the
  pending re-pin. `thread.js` suppresses scroll-driven `atBottom` updates for a short window
  after `scrollToBottom()`, and any real input (wheel, touch, click, key) ends that window
  immediately.
- **An optimistic bubble and its confirmed message can both be empty.** A send drops a `pending`
  placeholder into the thread immediately, and the real message arrives later over the WebSocket
  or the send response. `absorbPendingPlaceholder()` folds the second into the first instead of
  appending a duplicate, but it used to bail out on `if (!incoming.isSender || !incoming.text)`,
  and an attachment-only send has no text on either side. The result was a second bubble that
  never resolved, sitting on "Sending" forever. Both texts are now normalised to `''` before
  comparison, and text-less matches get a 60 s window instead of 3 minutes so an unrelated media
  message cannot swallow the placeholder later:

  ```bash
  npm run check:send    # 8 cases: text, attachment-only, older/newer, foreign sender, re-key
  ```

  The check runs the real `state.js` in a harness page (`tools/send-harness.html`), so it needs
  neither a running app nor a network.

  `npm run check:send` covers the module in isolation. `npm run check:live` covers the whole
  path: it drives the real composer in a running app, sends one uniquely tagged message to Note
  to self, waits for the REST round trip and the WebSocket echo, then asserts the thread holds
  exactly one copy of it and nothing on "Sending". It also guards the list itself: no ghost
  reaction rows, no oval network badges, and note rows no taller than ordinary ones.

  ```bash
  "Better Beeper.exe" --remote-debugging-port=9222   # or: npm start -- --remote-debugging-port=9222
  npm run check:live
  ```

### Why REST for the UI and MCP for the assistant

The REST API is cheaper and typed: it returns the exact schemas the UI needs, and the WebSocket
gives real-time push. MCP is designed for agents, and it already declares Beeper's whole
capability surface as tools, so the assistant does not need a second hand-written schema, and
Beeper evolves it independently.

### IPC contract

Every main-process handler returns `{ ok: true, data }` or `{ ok: false, error }`. The `handle()`
wrapper in `ipc.js` normalises this automatically, so a handler can return a raw payload or an
explicit envelope. `src/renderer/js/api.js` unwraps it and funnels failures to a single toast
channel.

---

## Development

```bash
npm run dev      # same as start, with DevTools detached
```

Useful while the app is running (`--remote-debugging-port=9222`):

```bash
node tools/cdp.js "document.getElementById('thread-name').textContent"
node tools/cdp.js --shot=out.png "window.beeper.events.debug()"
node tools/cdp.js --page=oauth "document.body.innerText"
node tools/click.js '#message-list img.att-image'       # real click -> opens the viewer window
node tools/wheel.js '#message-list' -500                 # real wheel event, asserts the pane scrolled
node tools/wheel.js --page=viewer.html '#stage' -500    # same, but zooming the image instead
node tools/drag.js --page=viewer.html '#stage' -150 -90  # real press-move-release, asserts it panned
```

`cdp.js`, `wheel.js` and `drag.js` all take `--page=<url-substring>`, which matters now that the
image viewer is a second renderer target of its own: `viewer.html` for the viewer, `index.html`
(the default) for the app.

---

## Notes and limitations

- The Beeper WebSocket is documented as experimental. Its event stream covers subscribed chats
  only, and not every bridge emits every event type.
- Message search only sees history that Beeper has indexed for that bridge, so results vary by
  network.
- Beeper returns local media inconsistently: attachments as `file:///...` URLs and chat avatars
  as bare filesystem paths. Both are normalised in `localMediaUrl()`.
- This client is for your own account on your own machine. It talks to `localhost` only, apart
  from any AI endpoint you configure yourself.
