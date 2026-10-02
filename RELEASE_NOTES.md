Better Beeper 1.0.1

A Windows desktop chat client for Beeper, built on Beeper's own Desktop REST API,
its WebSocket event stream, and the built-in MCP server.

## Install

Download `Better Beeper-1.0.1-x64-setup.exe` and run it. It installs per-user, so no
administrator rights are needed, and it leaves Beeper Desktop itself alone: both can run
at the same time.

Beeper Desktop must be running and you must already be signed in to Beeper. Better Beeper
signs in through Beeper's own OAuth flow, so it never sees or stores your Beeper password.

This build is **not code-signed**, so Windows SmartScreen will warn you on first run
("Windows protected your PC"). Choose "More info" then "Run anyway".

## What changed

- fix: tell electron-builder not to publish, because npm names this script release (`5e76590`)
- fix: run electron-builder and gh through paths execFileSync can spawn (`87ed61a`)
- chore: cut releases from conventional commits, and check that every push has one (`e8fc119`)
- Keep the v1.0.0 release notes in the repo (`e36cdc0`)

Full notes and known limitations: <https://github.com/ScottYates/BetterBeeper>.
