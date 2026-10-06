Better Beeper 1.4.0

A Windows desktop chat client for Beeper, built on Beeper's own Desktop REST API,
its WebSocket event stream, and the built-in MCP server.

## Install

Download `Better Beeper-1.4.0-x64-setup.exe` and run it. It installs per-user, so no
administrator rights are needed, and it leaves Beeper Desktop itself alone: both can run
at the same time.

Beeper Desktop must be running and you must already be signed in to Beeper. Better Beeper
signs in through Beeper's own OAuth flow, so it never sees or stores your Beeper password.

This build is **not code-signed**, so Windows SmartScreen will warn you on first run
("Windows protected your PC"). Choose "More info" then "Run anyway".

## What changed

- fix: verify the install against the build its own installer came from (`5b0d829`)
- Merge pull request #2 from ScottYates/feat/unread-rows-and-auto-update (`34e85b7`)
- Merge pull request #1 from ScottYates/main (`e7afbef`)
- Merge branch 'feat/unread-rows-and-auto-update' (`98ffdb4`)
- feat: check for a new release, ask, then install and relaunch (`a6d1641`)
- feat: make an unread inbox row visibly unread (`fb874ba`)

Full notes and known limitations: <https://github.com/ScottYates/BetterBeeper>.
