Better Beeper 1.19.0

A Windows desktop chat client for Beeper, built on Beeper's own Desktop REST API,
its WebSocket event stream, and the built-in MCP server.

## Install

Download `Better Beeper-1.19.0-x64-setup.exe` and run it. It installs per-user, so no
administrator rights are needed, and it leaves Beeper Desktop itself alone: both can run
at the same time.

Beeper Desktop must be running and you must already be signed in to Beeper. Better Beeper
signs in through Beeper's own OAuth flow, so it never sees or stores your Beeper password.

This build is **not code-signed**, so Windows SmartScreen will warn you on first run
("Windows protected your PC"). Choose "More info" then "Run anyway".

## What changed

- docs: the typing request went out, and how the updater decides (`c61bd8c`)
- build: the update helper needs no toolchain installed (`af7795a`)
- docs: the working handoff, brought up to date (`d82d6f9`)
- feat: mark every chat as read from the sidebar (`89d15a6`)
- fix: the sync summary joins the status line, and its list only opens for work (`3a9b49b`)
- fix: the inbox row did not follow the last message in an open chat (`481db73`)

Full notes and known limitations: <https://github.com/ScottYates/BetterBeeper>.
