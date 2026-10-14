# BetterBeeper working handoff

Last updated 2026-10-14, after mark-all-read and the two renderer fixes landed on
top of v1.18.6.

The version before this one described a v1.17.0-era tree, claimed the GitHub CLI
was not authenticated, and described an update helper that is no longer on
`main`. Do not trust any of it without re-checking.

## Where everything is

| What | Where |
| --- | --- |
| Working copy | any clone of this repository |
| GitHub | `https://github.com/ScottYates/BetterBeeper` |
| Installed app | `%LOCALAPPDATA%\Programs\Better Beeper` |
| Beeper Desktop | `%LOCALAPPDATA%\Programs\BeeperTexts` |

Paths here are written as environment variables rather than absolute ones,
because this is a public repository and a checked-in absolute path is a map of
one person's machine.

## Git state

Branch `main`, pushed and in sync with origin. This file is committed, so the
tree is clean.

```
89d15a6  feat: mark every chat as read from the sidebar
3a9b49b  fix: the sync summary joins the status line, and its list only opens for work
481db73  fix: the inbox row did not follow the last message in an open chat
783d2ad  Release 1.18.6
```

Release is **v1.18.6**. `package.json` says 1.18.6, and the installed app reports
`ProductVersion 1.18.6.0`. `tools/release.js` owns the version field and derives
the bump from commit subjects since the last tag, so do not hand-edit it.

Local branches, none of them needed any more:

- `feat/update-window-standalone-exe` - the superseded update window. Keep it if
  you want to compare the two updaters; `main` does not use it.
- `feat/unread-rows-and-auto-update`, `fix/gif-check-offscreen`,
  `fix/updater-download`, `fix/download-uses-net-fetch` - all merged.

`backup-before-merge` was deleted. It was fully merged and pushed.

**Standing rule:** fetch and pull before starting work on any task. That rule
paid for itself the moment it was added: `main` was found 10 commits behind,
sitting at v1.18.1 while origin was at v1.18.6.

## The update helper is the .NET one now

`main` carries `tools/update-helper/` (`Program.cs`, `StatusForm.cs`,
`UpdateHelper.csproj`), a .NET Framework helper built by
`npm run build:helper`. The earlier `tools/UpdateUi.cs` plus
`tools/build-update-ui.js` approach is **not** on `main`; it survives only on
`feat/update-window-standalone-exe`. Keep the .NET helper, it is the better
design and it is what ships.

The two implementations collided on `.gitignore`, `electron-builder.yml`,
`src/main/updater.js` and `tools/update-check.js`, which is why the local
update-window commit was parked rather than merged.

### The helper builds with no toolchain installed

This used to need the .NET SDK: `build:helper` was `dotnet build ...`, and with no
SDK on the machine it could not run at all, which left `check:update` one case
short and made the next release impossible to cut here.

It now compiles with the .NET Framework compiler that ships inside Windows,
`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, via
`tools/build-helper.js`. Nothing needs installing on any machine.

Worth being clear about, because it is easy to assume the opposite: **the SDK
never made the helper small.** `<TargetFramework>net48</TargetFramework>` does,
because it links against the .NET Framework already on the machine instead of
bundling a runtime. The 5 KB versus 63 MB choice is net48 against a modern
runtime, not `dotnet` against `csc.exe`. The SDK was only ever build tooling on
disk. The helper is 12.5 KB either way.

The cost is the language. That compiler is C# 5, so `Program.cs` had to drop its
nine nullable reference annotations (compile-time only, erased before any IL
exists), its four C# 7 `when` guards, and one C# 9 `is not null`. The top of
`Program.cs` says so, and warns the next person that a CS0453 is this
constraint rather than a broken build.

`UpdateHelper.csproj` is no longer what builds it, but it stays: it is the
clearest description of the program and `check:update` reads `WinExe` and
`net48` out of it.

### The helper is built by every packaging path

`tools/release.js` and `tools/dist.js` both call `tools/build-helper.js` before
electron-builder. `dist:scratch` runs it through npm first. Nothing invokes
electron-builder without it.

This was originally an electron-builder `beforeBuild` hook, which **failed the
1.19.0 release with "Cannot find module '<project>\node tools/build-helper.js'"**.
`beforeBuild` is not a general pre-build hook: electron-builder resolves it as a
module to `import`, not a command to run, and a truthy return tells
electron-builder that node_modules is being handled outside it. Calling it
directly from the script is unambiguous, and it is testable by running a
release, which a hook in the config was not.

The version bump for 1.19.0 had already been committed and pushed when that
happened, but no tag was created and nothing was published, so the retry found
the same 1.19.0 rather than skipping a version.

## Work done 2026-10-14

### Typing notifications: not implementable, do not retry

Measured against live Beeper Desktop 4.3.160 / Client API v5.0.0:

- `/v1/spec` has 78 operations, none typing. The WebSocket domain event enum is
  exactly four: `chat.upserted`, `chat.deleted`, `message.upserted`,
  `message.deleted`.
- `Chat.capabilities.typingNotifications` is real and genuinely true per bridge
  (Signal and Facebook/Messenger; absent for Google Voice and Beeper Matrix). It
  is a capability flag with no read path behind it.
- Matrix escape hatches are closed: `GET /_matrix/client/v3/sync` and
  `PUT .../state/m.typing/...` both 404 on the local proxy. Room state returns
  state events only.
- The Client API token is not a Matrix token: the same bearer against
  `https://matrix.beeper.com` returns 401 `M_UNKNOWN_TOKEN`.
- It cannot be polled either. Beeper's own bundle handles `case"m.typing"` from
  the sync **ephemeral** block into an in-memory activity manager and logs
  `Ignoring ephemeral ... to avoid DB writes`. Ephemeral events are never
  persisted, so room state will never hold them.

Read receipts are the contrast that proves the API can carry this class of data:
`Message.seen` carries per-reader timestamps. Typing simply has no equivalent.

A feature request was drafted for Beeper and **sent** on 2026-10-14, to the
community room linked from the Desktop API docs. It cites the measured gap above,
the read-receipt contrast, and three concrete shapes for a fix. Do not re-send it.
If Beeper ships a typing event, `beeper-ws.js` already re-emits unknown frame
types, so the transport would need very little work.

### The chat list did not follow the last message in an open chat

`GET /v1/chats` returns `ListChatsOutput` whose items are `ChatWithPreview`, which
carry a `preview` message. `GET /v1/chats/{chatID}` returns the plain `Chat`
schema, which has **no** `preview` field. Measured: all 100 list items had one, no
getChat response did.

The refresh after a `message.upserted` frame merged that preview-less object over
the cached chat, so the stale preview survived, `rowSignature` never changed, and
the row was never rebuilt. The message you were reading in the thread never
reached the list beside it until the 60 second inbox refresh happened to land.

The frame already carries the messages in its `entries`, so the newest one is
taken from there now, ordered by `sortKey` rather than position, skipping deleted
and hidden entries. Logic lives in `src/renderer/js/chat-preview.js`; guarded by
`npm run check:preview`.

### The sync summary joined the status line

"Chats synced" is now the middle item of the status row, between `live` and the
version, instead of a panel of its own above the footer. Its list no longer
lingers: it opens only for work in flight. It used to hold the last couple of
finished jobs between the chat list and the status line.

A failed sync is the exception. With the list shut, the summary line is the only
place it can still be seen, so the heading reads what could not be synced instead
of "Chats synced" beside a chat that did not.

### Mark all chats as read

A checkmark button in the sidebar tool row, next to the filter and search
buttons. It is **hidden whenever no chat is unread**, because a permanently
visible control that cannot be pressed into doing anything is worse than no
control, and an inbox that has just been cleared should stop offering to clear
itself.

`POST /v1/chats/{chatID}/read` takes an **optional** message id, and omitting it
marks the whole chat. That is the only correct call for this: the app has not
necessarily loaded the last message of a chat it has never opened, so there would
be no id to mark through, and a read receipt is a position in the conversation
rather than a flag on it.

One user action becomes one write per unread chat, and one account here has 89
chats, so the writes go four at a time and the count is reported once at the
end. That needed a `silent` option on `call()` in `api.js`: without it, a run of
failed writes produces one toast per chat and the one message worth reading is
buried. Selection and pacing live in `src/renderer/js/mark-all-read.js`, guarded
by `npm run check:markallread` and three cases in `check:sidebar`.

## Verification status

`npm run check:all` gives **35/37 suites passed** on this tree, 2026-10-14.
The one failure is `check:released`, and it is the repo asking for a release
rather than a defect: `main` is ahead of v1.18.6 with nothing published for
those commits. Run `npm run release` when you want 1.18.7.

It was 34/36 before the helper build changed, with `check:update` also failing.

| Check | Result |
| --- | --- |
| `check:update` | 59/59, after `check:update` gained a built helper to read the PE header of |
| `check:released` | main is ahead of v1.18.6 with no release. Expected. |
| `tools/update-redproof.js` | 17/17 mutations caught, no holes |

Individually measured the same day: `check:preview` 0 failing across 18 cases
(new), `check:markallread` 0 failing across 18 cases (new), `check:sidebar` 58/58,
`check:unread` 32/32, `check:layout` 13/13, `check:api` 136/136,
`check:composer` 17/17, `check:actions` 21/21, `check:about` 6/6,
`check:installer` passing, `check:syntax` OK on every JS file and harness,
`check:ascii` OK.

`tools/update-redproof.js` is not in the sweep, because it mutates the working
tree on purpose. Run it by hand after touching the updater. It mutates a real
line out of `Program.cs`, `StatusForm.cs`, the csproj or `electron-builder.yml`,
and asserts the matching `check:update` case notices.

That is not a theoretical tool. Rewriting `is not null` as `!= null` broke one
of its seventeen mutations, because it matches source text by literal string, and
nothing else noticed: `check:update` was green throughout. Run it by hand.

`check:preview` is new and worth knowing about: it carries a **control case** that
reproduces the old behaviour, and disabling the fix makes it fail. That control
is what caught a wrong claim in the original fix (that the preview had to be
written after the spread; it does not, because a field the incoming object lacks
cannot participate in a spread either way).

General lesson this keeps re-confirming: a static or text-level check will happily
bless broken code. Three times this project a suite passed over a real defect.
Always pair a new assertion with a case that proves the assertion can fail.

## Still outstanding

1. **1.18.7 has not been cut.** `check:released` is red for exactly this reason.
   `npm run release` can now build the helper here, so the machine is ready. It
   will derive the version from the commits since v1.18.6.
2. **The updater asks GitHub for a Release, not for a commit.** It calls
   `releases/latest` and compares that tag against `app.getVersion()`, which is
   what is installed. So it correctly says "up to date" at 1.18.6 even with five
   commits on main: a commit is not a release and there is nothing for it to
   offer. `check:released` is what catches that gap, which is why it is the one
   red suite.
3. **TLS warnings.** A log showed `handshake failed ... net_error -202`
   (`ERR_CERT_ALT_NAME_INVALID`). The update prompt did appear, so the GitHub API
   call worked. Probably a different endpoint or an intercepting proxy.
   Unresolved.
4. **Empty command windows** appeared after one interrupted update. Most likely
   orphaned consoles. Never proven.
5. **This file is now tracked**, which cuts both ways. Its git state section goes
   stale silently, which is exactly how two earlier versions of it misled the
   reader. Refresh it as part of finishing a task rather than when someone
   notices it is wrong.

## Environment gotchas that cost time

- **`npm.cmd`, not `npm`.** PowerShell resolves `npm` to `npm.ps1`, which the
  execution policy blocks.
- **PATH is stale mid-session.** If a tool looks missing after installing it,
  prefix with
  `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`
  A restart is what makes it permanent.
- **`rm --` takes LITERAL paths.** It does not evaluate PowerShell. `"$env:TEMP\x"`,
  `Join-Path $t 'x'` and backtick line continuations are all passed through
  unexpanded and fail. Always paste the fully-expolved absolute path.
- **The GitHub CLI is authenticated**, as `ScottYates`, scopes `gist`, `read:org`,
  `repo`, `workflow`. An earlier version of this file said otherwise.
- **Electron `safeStorage` on Windows is keyed by `Local State`, not the app
  name.** To read another Electron app's ciphertext, point `userData` at that
  app's real folder before `app.whenReady()`; the key is `os_crypt.encrypted_key`
  in `<userData>\Local State`. `app.setName()` does nothing for this.
- **The shell validates its working directory before running anything.** If the
  session folder is deleted, every command fails with
  `Working directory does not exist`.
- **File tools keep working when the shell is dead.**
- **Watch the folder name.** `betterbeeeper` (three e's) and `betterbeeper`
  (two e's) are different directories. That mismatch produced a long run of
  bogus "not a git repository" errors and a false conclusion that the filesystem
  was unstable. It was not.
- **`Select-String` with regex metacharacters can fail silently** and swallow
  output from the rest of a command. Plain `-SimpleMatch` is safer for literals
  like `res.on(`.
- **Beeper's MCP `search_docs` tool is useless as evidence.** It returns "not
  found" for every query, including `messages` and `chats`. Always run a control
  query before believing a negative from any search tool.