Better Beeper 1.26.0

A Windows desktop chat client for Beeper, built on Beeper's own Desktop REST API,
its WebSocket event stream, and the built-in MCP server.

## Install

Download `Better Beeper-1.26.0-x64-setup.exe` and run it. It installs per-user, so no
administrator rights are needed, and it leaves Beeper Desktop itself alone: both can run
at the same time.

Beeper Desktop must be running and you must already be signed in to Beeper. Better Beeper
signs in through Beeper's own OAuth flow, so it never sees or stores your Beeper password.

This build is **not code-signed**, so Windows SmartScreen will warn you on first run
("Windows protected your PC"). Choose "More info" then "Run anyway".

## What changed

- docs: describe searching inside a conversation (`62a5703`)
- fix: a progress-event count that depended on how fast the machine is (`2fab2ac`)
- fix: the check runner names the failing case instead of the last few lines (`2e135d9`)
- feat: reach the rest of the conversation when searching (`a82fa56`)
- feat: search inside the conversation that is open (`93f6987`)
- feat: the renderer can ask Beeper for a single message (`c6f21bb`)
- feat: the search rules in a module of their own (`19a8281`)
- feat: the local store can search one chat by substring (`1b483b8`)
- docs: plan the in-conversation search (`543c044`)
- docs: design the in-conversation search (`a0181fa`)
- chore: add a read-only probe for Beeper's message search (`e135017`)

Full notes and known limitations: <https://github.com/ScottYates/BetterBeeper>.
