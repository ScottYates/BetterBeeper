Better Beeper 1.31.0

A Windows desktop chat client for Beeper, built on Beeper's own Desktop REST API,
its WebSocket event stream, and the built-in MCP server.

## Install

Download `Better Beeper-1.31.0-x64-setup.exe` and run it. It installs per-user, so no
administrator rights are needed, and it leaves Beeper Desktop itself alone: both can run
at the same time.

Beeper Desktop must be running and you must already be signed in to Beeper. Better Beeper
signs in through Beeper's own OAuth flow, so it never sees or stores your Beeper password.

This build is **not code-signed**, so Windows SmartScreen will warn you on first run
("Windows protected your PC"). Choose "More info" then "Run anyway".

## What changed

- docs: typing marks a chat read, and the checks must not put a window up (`58f4565`)
- fix: no check may put a console window on the desktop (`206f7f8`)
- feat: typing in a chat marks it read (`261029b`)

Full notes and known limitations: <https://github.com/ScottYates/BetterBeeper>.
