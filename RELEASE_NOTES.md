Better Beeper 1.6.0

A Windows desktop chat client for Beeper, built on Beeper's own Desktop REST API,
its WebSocket event stream, and the built-in MCP server.

## Install

Download `Better Beeper-1.6.0-x64-setup.exe` and run it. It installs per-user, so no
administrator rights are needed, and it leaves Beeper Desktop itself alone: both can run
at the same time.

Beeper Desktop must be running and you must already be signed in to Beeper. Better Beeper
signs in through Beeper's own OAuth flow, so it never sees or stores your Beeper password.

This build is **not code-signed**, so Windows SmartScreen will warn you on first run
("Windows protected your PC"). Choose "More info" then "Run anyway".

## What changed

- fix(history): put the history numbers where they can be seen (`4403a8f`)
- fix(history): tell the thread when a backfill lands (`44969db`)
- feat(history): search the local store, and show what it is holding (`3bc5967`)
- feat(history): the thread reads from disk instead of Beeper (`c379b50`)
- feat(history): content-addressed media and the backfill queue (`9683159`)
- feat(history): local message store, tombstones and full-text search (`3c8edfa`)
- docs: design for local message history (`f8e0cd2`)

Full notes and known limitations: <https://github.com/ScottYates/BetterBeeper>.
