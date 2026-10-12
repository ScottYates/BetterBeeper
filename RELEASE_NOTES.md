Better Beeper 1.17.1

A Windows desktop chat client for Beeper, built on Beeper's own Desktop REST API,
its WebSocket event stream, and the built-in MCP server.

## Install

Download `Better Beeper-1.17.1-x64-setup.exe` and run it. It installs per-user, so no
administrator rights are needed, and it leaves Beeper Desktop itself alone: both can run
at the same time.

Beeper Desktop must be running and you must already be signed in to Beeper. Better Beeper
signs in through Beeper's own OAuth flow, so it never sees or stores your Beeper password.

This build is **not code-signed**, so Windows SmartScreen will warn you on first run
("Windows protected your PC"). Choose "More info" then "Run anyway".

## What changed

- Merge branch 'fix/gif-check-offscreen' (`f8bed0e`)
- test: run the GIF check offscreen so it stops opening a window (`e4b9a60`)
- fix: the lockfile still claimed the old project name and version (`5dd8799`)
- Merge origin/main (v1.17.0) and carry the updater download fix onto it (`e074e17`)
- Merge branch 'fix/updater-download' (`420f856`)
- fix: the update download died on Electron's ClientRequest, which has no setTimeout (`bd2a129`)

Full notes and known limitations: <https://github.com/ScottYates/BetterBeeper>.
