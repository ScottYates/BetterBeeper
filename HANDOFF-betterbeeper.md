# BetterBeeper working handoff

Last updated 2026-10-21, as the unread fix and the people list were released
as v1.21.0, on top of the chat list refresh button released as v1.20.0.

The version before this one described a v1.18.6-era tree. The one before that
described a v1.17.0-era tree, claimed the GitHub CLI was not authenticated, and
described an update helper that is no longer on `main`. Do not trust any of it
without re-checking.

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

The last few commits, with the `Release 1.21.0` commit sitting on top of them:

```
e9fcc06  feat: show everyone in a conversation
b02d8a5  fix: opening a chat clears its unread badge
4b1125b  Release 1.20.0
7380b24  docs: point the handoff at v1.20.0 before it is cut
6f1d349  feat: refresh the chat list by hand and report what arrived
```

Release is **v1.21.0**. The tag sits on the `Release 1.21.0` commit, which is
the commit that carries the version, so `main` is not left ahead of its own
tag. `package.json` says 1.21.0. The **installed app still reports
`ProductVersion 1.19.8.0`**, on purpose: releases are published without
installing, so the in-app update path has a newer release to offer and gets
exercised on a real account. Install it from the app when you want it.

v1.21.0 carried the unread fix and the people list. It is a minor bump,
because `tools/release.js` derives the level from the commit subjects since
the last tag and the `feat:` is the higher of the two. v1.20.0 carried the
chat list refresh button, v1.19.7 the entity fix, and v1.19.8 was the same
code plus the handoff behind it.

`tools/release.js` owns the version field and derives the bump from commit
subjects since the last tag, so do not hand-edit it.

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

"Synced" is now the middle item of the status row, between `live` and the
version, instead of a panel of its own above the footer. Its list no longer
lingers: it opens only for work in flight. It used to hold the last couple of
finished jobs between the chat list and the status line.

The heading is the word "Synced", with the stored message count after it when
there is one. It was "Chats synced" until Scott shortened it, and the count
assertion in check:sidebar passes on any wording that mentions messages, so
there is a separate check for the word itself. That one matters more than it
looks: the failure check asks the heading NOT to read "Synced" while a sync has
failed, and pinning that to the old wording would have made it a check that can
only pass.

A failed sync is the exception. With the list shut, the summary line is the only
place it can still be seen, so the heading reads what could not be synced instead
of "Synced" beside a chat that did not.

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

## Work done 2026-10-20

### Text that arrives HTML-escaped is now shown as it was written

Reported as "handle web encoded characters in display please, things like
`&amp;` and the like".

Some bridges hand Beeper text that has been HTML-escaped, so the API returns
`&amp;` and `&quot;` where the sender wrote an ampersand and a quote. Measured
against live data before changing anything: **359 messages, 8 of them carrying
a reference, and not one literal `&` outside a reference.** So the escaping is
Beeper's, not the sender typing. Only two reference names appear in the wild:
`quot` and `amp`.

The message body already handled it, by accident of how it is built: the HTML
branch of `renderRichText` parses with DOMParser, and DOMParser resolves
character references while it parses. The plain-text branch did not, and it
escaped the text again on the way out, so a bubble showed `&amp;` where the
sender wrote `&`. Everything that puts text into the DOM as a string had the
same problem: the sidebar preview, the chat title, the draft, the reply quote,
the reply preview, the editor and the copy action.

**Decoding belongs at the display boundary, not at ingestion.** Decoding on the
way into the store looks tidier and is wrong: the HTML branch resolves
references itself, so a stored-and-decoded message gets resolved twice and
`&amp;amp;` becomes `&`. Decoding where the text is drawn also keeps the value
that goes back to Beeper equal to what the sender typed.

`src/renderer/js/entities.js` holds the decoder and the clip, and touches no
DOM. That is what lets `share.js` use it without giving up on being loadable on
its own, and what lets the decoder be checked under plain node.

`clipText` exists because a preview that ends in `&am` shows the reader the
very thing the decoder is meant to hide. A cut inside a reference keeps the
whole reference; a cut anywhere else is left alone, because dropping the
fragment would throw away text the sender actually typed.

`npm run check:entity` is new: 31 cases over the decoder, the clip, the chat
title and the sidebar preview, each with a control case pinning the old
behaviour. The render cases went into `check:rich`, because that is where the
DOM branch already lives. Both fail on the old code, 12 and 3 cases
respectively, and the one case guarding against decoding twice fails on its own
when the HTML branch is given a decoder as well.

Verified against the live account afterwards: the 10 live texts that carry a
reference all render resolved.

### Released as v1.19.7, and v1.19.8 for the handoff behind it

`npm run release`, which publishes without installing so the in-app update path
keeps something newer to offer. The tag sits on the commit that carries the
version, so `main` is not left ahead of its own tag.

The published asset was fetched back and hashed against the file that was built,
because a CLI reporting success is not evidence that 90 MB arrived intact. For
v1.19.7: `DEB02382026406DF4B17BD6D7B7CF9CD4BDB5ED566C5D0570AC8CCC02B4FE931`,
95,349,139 bytes, matching the local build exactly.

v1.19.8 is the same code plus the handoff refresh, cut for the reason above:
`check:released` fails whenever `main` is ahead of the newest tag, so a push
that only updates this file still needs a release behind it.

### The chat list can be refreshed by hand

Reported as "add a refresh button for the list of chats to check if a new chat
has come in".

The app already re-reads the chat list when the window comes back to the
foreground, but that is a background nicety: at most once a minute, silently,
and only when the window regains focus. A chat that arrived while the app was
sitting in the background with the window already focused was not noticed at
all, and there was no way to ask.

The button is the leftmost in the sidebar's tool row and reads as the same
circled-arrow glyph (U+21BB) the thread's own refresh button uses - the same
mark for the same meaning in two different headers. It spins while the call
is in flight and the tooltip says "Checking for new chats", which is the same
pair of signals the thread's refresh button uses. The button is not disabled
while it works: a disabled button loses focus, and the tooltip would stop
appearing over it at exactly the moment it matters. A second click is dropped
by a flag instead, because two calls would race each other's answer about
which chats are new.

**The answer is a diff on ids, not on titles or timestamps.** A chat that was
renamed, or that received a message, is the same chat and is not new;
comparing anything else would announce it as one. The check carries a control
case that runs a title-based diff on purpose and shows it making exactly that
mistake.

The report separates two cases that read differently. With the list already
on screen, "no new chats" is a real answer and is said out loud, because
silence after a deliberate click is indistinguishable from a button that does
nothing. With nothing loaded before the call, every chat in the response is
new to the app but new to nobody, so the line is "Loaded N chats" instead.

Only the first page is read. A new chat arrives at the top of the list, so it
is in the first page by definition; the deeper history already in the state is
not what the user is asking about. Measured on the live account: 199 chats in
the state, 100 on the first page.

Selection and wording live in `src/renderer/js/chat-list-refresh.js`, pure, so
`npm run check:refreshchats` can exercise them under plain node. The DOM side
- the button exists, sits in the sidebar header, is not the thread's button,
and spins only while it is working - is in `check:sidebar`, which grew from 58
to 66 cases.

The spin rule was generalised rather than duplicated: `#btn-refresh.is-busy`
became `.icon-btn.is-busy`, and `job-spin` was renamed to `spin`. Both refresh
buttons now share one rule and one keyframe.

Verified against the live account in the running app. The negative path
reported "No new chats" over the real list. The positive path was produced by
removing one chat from the renderer's known set and letting the refresh fetch
it back: the toast said "1 new chat", the chat went back into the state, and
its row came back with no duplicate. The first attempt at that test picked a
chat from the second page and reported nothing new, which is correct - a
refresh reads the first page only, and that chat was never going to be in it.

## Work done 2026-10-21

### Opening a chat clears its unread badge

Reported as "when i click on a chat conversation on the left side it should
clear the unread notifications for that chat".

It did not, and it had not for a long time. Clicking an unread chat opened it,
drew its messages, and left the badge exactly where it was. Measured against
the live account: the client still said `unreadCount: 2`, the server still said
`unreadCount: 2`, and the mark-read call was never even made.

The gate was the newest message's `isUnread` flag, and no message this app has
ever received carries that field. Beeper's message objects are id, chatID,
accountID, senderID, senderName, timestamp, sortKey, type, text, isSender,
isDeleted and mentions - measured in the local store and against
`GET /v1/chats/{id}/messages`, which agree. A gate on a field that is never
there never passes, so the "mark a chat as read when I open it" setting was
dead code that happened to look alive.

The gate is now the chat's unread count, which is the same number the sidebar
badge and the app icon are drawn from, and the only unread signal the app has.
The rule lives in `unread.js` next to the count the icon is drawn from,
because it is the one thing that must not exist twice, and the sidebar's own
copy now reads it from there.

The whole chat is marked, with no message id. A read receipt is a position in
the conversation, and this app does not always have the newest message to
point at - the local store can be behind the server, and
`GET /v1/chats/{chatID}` carries no preview at all. Omitting the id is what
`POST /v1/chats/{chatID}/read` means by marking the whole chat, and it is the
call the mark-all-read button already makes.

Both copies of the chat have to agree afterwards. The badge and the app icon
are drawn from `state.chats`, the thread header reads `currentChat`, and
"mark as unread" reads that one to put the count back, so a chat that says
"2 unread" in one place and "read" in the other is worse than either.

Verified against the live account: the negative path leaves the count alone,
and the positive path - clicking an unread chat - took the client from 1 to 0,
took the badge off the row, and took the server from 1 to 0.

### The check that passed over it

`check:focusread` had a case called "opening a chat marks the unread message
read", and it had been passing, over a feature that did not work.

Two things were wrong with it, and both are the kind that hide a defect.

The assertion was written as `add(name, condition ? true : 'the reason it
failed')`, and the helper coerced the value with `!!`. A reason is a non-empty
string, so a failed assertion was truthy and the case passed. The helper now
compares against `true` and nothing else, and the same trap was closed in
`check:share`, `check:api`, `check:settings` and the two live tools, which
were safe only because every call they make happens to pass a real boolean.

The fixture invented the field the app does not have. It put `isUnread` on its
messages, so the rule was exercised against data the app never receives. The
fixture is now the real shape, and a case asserts that it carries no unread
flag, so a fixture that quietly grows the missing field again would fail
rather than hide the bug a second time.

There is a control case now, which is the shape the other checks in this repo
use: it runs the old gate against the real fixture and shows that it would
have declined this very chat. `check:focusread` is 27 cases.

### Everyone in a conversation

Reported as "also see if you can add an option to show all users in a
conversation".

A group's title is Beeper's own summary and it hides people behind an
ellipsis: "Eric, Hallie, Mike & 2 others" names three of five and says nothing
about the other two. The app is handed every one of them - the chat's
participants carry the full list, and a total that agrees with it - and shows
none of them.

There is now a people button at the head of the thread header's action row,
and it opens a list of everyone in the conversation. Measured on the live
account, a group whose title names three people lists all six, and the two the
title hid are in it.

Each person is named the way a person would be: their name if Beeper has one,
otherwise their address, otherwise their number, otherwise the raw id. The
second line is a way of reaching them - a number or an address - and only when
it is not the same thing as the name. A Beeper account's id is its username
with an @ in front, so printing both is noise, and a contact whose name is its
own number has nothing left to add. A number written two ways is one number:
"+1 515-988-3633" and "+15159883633" are the same person, and the number is
not printed under itself.

You come first, then the admins, then everyone else, each group by name, and
the order is the same every time, because a list that reshuffles itself
between openings is a list nobody can learn. A person is listed once: Beeper
can list the same account twice in a conversation that has been merged.

The naming and the order live in `src/renderer/js/participants.js`, pure, so
`npm run check:participants` can exercise them - 36 cases, with a control that
the list shows more people than the title names.

## Verification status

`npm run check:all` gives **42/42 suites passed** on the v1.21.0 release
commit, 2026-10-21. It was 41 suites before `check:participants` was added, 40
before `check:refreshchats`, 39 before `check:entity`, and 35/37 on
2026-10-14.

`check:released` is the one that moves with the git state. It fails whenever
`main` is ahead of the newest tag, because a push with no release behind it is
exactly what it exists to catch. So it is green on a release commit and red on
the commit after one, until the next release catches it up. That is the rule
working, not a defect, and it is why a docs-only push still gets a release.

| Check | Result |
| --- | --- |
| `check:update` | 59/59, after `check:update` gained a built helper to read the PE header of |
| `check:released` | green on a release commit, red while `main` is ahead of the last tag |
| `tools/update-redproof.js` | 17/17 mutations caught, no holes |

Individually measured: `check:entity` 0 failing across 31 cases,
`check:rich` 27/27, `check:preview` 0 failing across 18 cases,
`check:markallread` 0 failing across 18 cases,
`check:refreshchats` 0 failing across 24 cases,
`check:focusread` 27/27,
`check:participants` 0 failing across 36 cases (new),
`check:sidebar` 66/66, `check:unread` 32/32, `check:layout` 13/13,
`check:api` 136/136, `check:composer` 17/17, `check:actions` 21/21,
`check:about` 6/6, `check:installer` passing, `check:syntax` OK on every JS
file and harness, `check:ascii` OK.

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

The fourth one is the sharpest, because it was not a bad assertion at all. The
assertion in `check:focusread` was correct, the helper it was handed to was
the problem, and the fixture it ran against was a shape the app never sees.
Three things had to be true for a dead feature to pass a green check: the rule
gated on a field Beeper does not send, the fixture invented that field, and
the helper coerced a failure reason into a pass. Fix any one of them and the
bug shows. The general rule that follows: **a fixture must be the real shape,
and a helper must not be able to turn a failure into a pass.** Compare against
`true` and nothing else, and keep the "everything is load-bearing" case, which
is what would have caught the unused condition.

## Still outstanding

1. **TLS warnings.** A log showed `handshake failed ... net_error -202`
   (`ERR_CERT_ALT_NAME_INVALID`). The update prompt did appear, so the GitHub API
   call worked. Probably a different endpoint or an intercepting proxy.
   Unresolved.
2. **Empty command windows** appeared after one interrupted update. Most likely
   orphaned consoles. Never proven.
3. **This file is now tracked**, which cuts both ways. Its git state section goes
   stale silently, which is exactly how two earlier versions of it misled the
   reader. Refresh it as part of finishing a task rather than when someone
   notices it is wrong.

Not outstanding any more, but still true and easy to trip over: the updater
asks GitHub for a **Release**, not for a commit. It calls `releases/latest` and
compares that tag against `app.getVersion()`, which is what is installed. So it
says "up to date" while there are commits on main that were never released: a
commit is not a release and there is nothing for it to offer. `check:released`
is what catches that gap.

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