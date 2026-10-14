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

### The helper is not built automatically. Remember it.

`electron-builder.yml` has **no `beforeBuild` hook**, and `tools/release.js` does
not build the helper either: it goes straight to electron-builder. The only thing
that pulls the helper in is `extraResources: from: build/update-helper`.

So the packaging step depends on a human having run `npm run build:helper` first,
on a machine that has the .NET SDK. Neither is true here.

Verified: `build/update-helper` does not exist, `dotnet` is absent, and there is
no hook. **Not verified:** whether electron-builder fails loudly on a missing
`extraResources` source or quietly ships an installer with no helper in it. That
distinction matters more than it looks, because a helper-less build is an app
whose update handoff cannot work, which is the exact thing 1.18.2 through 1.18.6
were spent fixing.

Worth knowing: the superseded branch had `beforeBuild: node tools/build-update-ui.js`
wired up automatically. This automation was lost when the .NET helper replaced
it. Restoring it, as `beforeBuild: npm run build:helper`, would turn a silent
packaging mistake into a loud build failure. That one line has not been applied,
because it cannot be tested on this machine without the SDK.

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

A feature request has been drafted for Beeper and is **not yet posted**. Send it
to the community room linked from the Desktop API docs, or `help@beeper.com`.

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

`npm run check:all` gives **34/36 suites passed** on this tree, 2026-10-14.
Both failures are expected and neither is a defect in the app:

| Check | Result |
| --- | --- |
| `check:update` | 58/59. The one failure is the missing .NET SDK, see below. |
| `check:released` | main is 2 commits ahead of v1.18.6 with no release. The repo asking for one, not a regression. |

Individually measured the same day: `check:preview` 0 failing across 18 cases
(new), `check:markallread` 0 failing across 18 cases (new), `check:sidebar` 58/58,
`check:unread` 32/32, `check:layout` 13/13, `check:api` 136/136,
`check:installer` passing, `check:syntax` OK on every JS file and harness,
`check:ascii` OK. The two figures above predate mark-all-read; re-run
`check:all` for a current full number.

`check:preview` is new and worth knowing about: it carries a **control case** that
reproduces the old behaviour, and disabling the fix makes it fail. That control
is what caught a wrong claim in the original fix (that the preview had to be
written after the spread; it does not, because a field the incoming object lacks
cannot participate in a spread either way).

General lesson this keeps re-confirming: a static or text-level check will happily
bless broken code. Three times this project a suite passed over a real defect.
Always pair a new assertion with a case that proves the assertion can fail.

## Still outstanding

1. **The .NET SDK is not installed on this machine.** `dotnet` is absent from
   PATH and neither `%ProgramFiles%\dotnet\dotnet.exe` nor the x86 one exists.
   Consequences, all expected rather than bugs:
   - `npm run check:update` fails exactly one case, "the built helper, if there is
     one, has no console subsystem", with detail "not built yet: run npm run
     build:helper". It reads `build/update-helper/`, which never gets produced.
   - `npm run release` cannot produce a correct package here, because nothing
     builds the helper for it. See the section above; this is the blocker on
     1.18.7.
   Installing the SDK is system software and needs explicit approval.
2. **The typing feature request has not been posted.** The draft is in the
   session history.
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