Better Beeper 1.28.0

A Windows desktop chat client for Beeper, built on Beeper's own Desktop REST API,
its WebSocket event stream, and the built-in MCP server.

## Install

Download `Better Beeper-1.28.0-x64-setup.exe` and run it. It installs per-user, so no
administrator rights are needed, and it leaves Beeper Desktop itself alone: both can run
at the same time.

Beeper Desktop must be running and you must already be signed in to Beeper. Better Beeper
signs in through Beeper's own OAuth flow, so it never sees or stores your Beeper password.

This build is **not code-signed**, so Windows SmartScreen will warn you on first run
("Windows protected your PC"). Choose "More info" then "Run anyway".

## What changed

- docs: record what the review changed (`5bd6337`)
- fix: the five findings from the whole-branch review (`d6ef50d`)
- docs: correct the plan counts to what the suites print (`b5b8417`)
- docs: record editing a message from the composer (`3685ea8`)
- test: the bubble being edited is marked in the thread (`00b5e18`)
- test: prove each rule of the composer edit is load-bearing (`e566ac8`)
- feat: one edit mode, in the composer (`598e59a`)
- docs: the plan's Task 2 code, corrected where the review found it wrong (`00355a5`)
- fix: the message being edited stays in the thread, and the reply and the edit are exclusive (`1ab929a`)
- feat: the up arrow in the composer opens the last message you can edit (`2fa3aa8`)
- docs: correct the plan where the implementation found it wrong (`fe80d0a`)
- feat: the rules that decide what a message can be edited (`f54ea44`)

Full notes and known limitations: <https://github.com/ScottYates/BetterBeeper>.
