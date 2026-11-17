Better Beeper 1.32.0

A Windows desktop chat client for Beeper, built on Beeper's own Desktop REST API,
its WebSocket event stream, and the built-in MCP server.

## Install

Download `Better Beeper-1.32.0-x64-setup.exe` and run it. It installs per-user, so no
administrator rights are needed, and it leaves Beeper Desktop itself alone: both can run
at the same time.

Beeper Desktop must be running and you must already be signed in to Beeper. Better Beeper
signs in through Beeper's own OAuth flow, so it never sees or stores your Beeper password.

This build is **not code-signed**, so Windows SmartScreen will warn you on first run
("Windows protected your PC"). Choose "More info" then "Run anyway".

## What changed

- docs: the handoff for the GIF player, and the two checks that were wrong (`8113c96`)
- feat: an animated GIF plays three times, then stops, with a button over it (`3620229`)
- fix: the history progress check needed a slow machine to pass (`5422244`)

Full notes and known limitations: <https://github.com/ScottYates/BetterBeeper>.
