Better Beeper 1.32.2

A Windows desktop chat client for Beeper, built on Beeper's own Desktop REST API,
its WebSocket event stream, and the built-in MCP server.

## Install

Download `Better Beeper-1.32.2-x64-setup.exe` and run it. It installs per-user, so no
administrator rights are needed, and it leaves Beeper Desktop itself alone: both can run
at the same time.

Beeper Desktop must be running and you must already be signed in to Beeper. Better Beeper
signs in through Beeper's own OAuth flow, so it never sees or stores your Beeper password.

This build is **not code-signed**, so Windows SmartScreen will warn you on first run
("Windows protected your PC"). Choose "More info" then "Run anyway".

## What changed

- docs: the handoff for the play item that was missing (`f07b48c`)
- fix: the GIF player may read the file, and a GIF that cannot be played can be saved (`4036266`)

Full notes and known limitations: <https://github.com/ScottYates/BetterBeeper>.
