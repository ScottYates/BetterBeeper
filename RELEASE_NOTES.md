A Windows desktop chat client for Beeper, built on Beeper's own Desktop REST API, its WebSocket event stream, and the built-in MCP server. Everything in the UI goes through the same API your phone does - nothing is scraped and nothing is proxied.

## Install

Download `Better Beeper-1.0.0-x64-setup.exe` and run it. It installs per-user, so no administrator rights are needed, and it leaves Beeper Desktop itself alone: both can run at the same time.

Beeper Desktop must be running and you must already be signed in to Beeper. Better Beeper signs in through Beeper's own OAuth flow, so it never sees or stores your Beeper password.

## First release

This is the first published build. It is **not code-signed**, so Windows SmartScreen will warn you on download and on first run ("Windows protected your PC"). Choose "More info" then "Run anyway". A signing certificate is the obvious next step.

## What it does

- Sidebar across every connected network, with unread counts, pins, mutes, drafts and archive
- Threads with day dividers, replies, reactions, edits, deletes and read receipts
- Compose with attachments, emoji picker and drag-and-drop
- Inline images that open in a separate always-on-top window on whichever monitor the app is on
- Search across chats and message history
- An assistant panel driven by Beeper's MCP server, with every tool call shown before it runs
- A view switcher for Inbox, Unread and Archive
- Adjustable text size, persisted, applied as page zoom so the splitter, tooltips and popovers stay in step
- Per-network glyphs, including self-coloured marks where the brand supplies its own disc

## Known limitations

Some things Beeper advertises do not work through its API on 4.3.160, and the app works around them locally rather than pretending they took effect:

- **Pinning is kept in this app.** `PATCH /v1/chats/{id}` accepts `isPinned` and returns 200, then silently drops it. The request is still sent so the two agree if Beeper ever fixes this.
- **Archiving the built-in "Note to self" chat is kept in this app**, for the same reason. Archiving any other chat, including the Signal note chat, works normally.
- **Beeper's own Desktop API is the only chat source.** There is no calls feature, because the live spec has no calls endpoint.

## Building it

Node 24 and npm, no Rust toolchain. `npm install`, then `npm run dist` builds a Windows installer and silently installs it over whatever copy is already there.

The checks under `npm run check:*` are the interesting part: each one exists because something here actually broke, and each is written to fail if the bug comes back. `check:syntax` in particular parses every JavaScript file *and* every check harness, because a broken harness once produced a crash dialog that named the check rather than the app.
