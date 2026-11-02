Better Beeper 1.27.0

A Windows desktop chat client for Beeper, built on Beeper's own Desktop REST API,
its WebSocket event stream, and the built-in MCP server.

## Install

Download `Better Beeper-1.27.0-x64-setup.exe` and run it. It installs per-user, so no
administrator rights are needed, and it leaves Beeper Desktop itself alone: both can run
at the same time.

Beeper Desktop must be running and you must already be signed in to Beeper. Better Beeper
signs in through Beeper's own OAuth flow, so it never sees or stores your Beeper password.

This build is **not code-signed**, so Windows SmartScreen will warn you on first run
("Windows protected your PC"). Choose "More info" then "Run anyway".

## What changed

- docs: record the arrows in both searches, the window that never opens, and the hidden window that had no layout (`3825d14`)
- fix: the checks must never put a window on the desktop, and must not report a good file as broken (`92453a6`)
- feat: add up and down arrows to the sidebar search (`32cbae1`)
- refactor: move the step rule out of the conversation search (`93441a6`)

Full notes and known limitations: <https://github.com/ScottYates/BetterBeeper>.
