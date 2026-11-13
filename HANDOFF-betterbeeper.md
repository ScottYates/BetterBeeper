# BetterBeeper working handoff

Last updated 2026-11-02, with a search inside the conversation that is open:
a magnifier in the thread header, the matches highlighted in the conversation
itself, and Enter and Shift+Enter stepping through them. Released as
**v1.26.0**.

The version before this one described the v1.25.0 released state, which
carried the desktop notification click. The one before that described the
v1.24.0 released state, which carried the composer focus, the paste-and-drop
work for any file, and the fix for an attachment vanishing on a socket
reconnect. The one before that described a v1.21.0 released state. The one
before that described a v1.18.6-era tree, claimed the GitHub CLI was not
authenticated, and described an update helper that is no longer on `main`. Do
not trust any of it without re-checking.

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

Branch `main`, in sync with origin. The work described under "Work done
2026-11-12" is committed and released.

**This section does not name a version, on purpose.** `git describe --tags
--abbrev=0` names it, and the `Release x.y.z` commit at the top of the list
below carries the version in its own subject. A handoff that says "1.28.3" is
wrong the moment the next release is cut, and that is exactly how two earlier
versions of this file misled the reader: a number that was true when it was
written and false by the time it was read, with nothing to say so. The
complaint in "Still outstanding" about this file going stale is a complaint
about this section, and the fix is to stop pinning a version in prose.

The last few commits, most recent first. The commit that carries this
paragraph is above them:

```
261029b  feat: typing in a chat marks it read
206f7f8  fix: no check may put a console window on the desktop
5b3c229  fix: the update installs over the top, so the taskbar pin survives
9f342c6  Release 1.30.5
2135695  docs: the window's place, and the wpad record is not an issue
1f8a6e7  fix: the window opens exactly where it was closed
3fe318a  Release 1.30.4
```

The newest tag is on the topmost `Release` commit, so `main` is not left
ahead of its own tag, and `package.json` agrees with it.

**v1.30.2** carried the update failure path: the handoff helper can now give
up on a wedged installer, the app comes back on the old version whatever
happened, and the reason is written down before it does. It was a patch bump,
because `tools/release.js` derives the level from the commit subjects since
the last tag and the commit it carried was a `fix:`. **v1.28.3** carried the
two things this file had left outstanding: the TLS warning, which was
Chromium's proxy auto-discovery rather than anything to do with GitHub, and
the checks that say the update path cannot put a console window on the
desktop. It was a patch bump, because `tools/release.js` derives the level
from the commit subjects since the last tag and both of the commits it
carried were `fix:`. **v1.28.2** carried the composer growing to
fit the message being edited. **v1.28.0** carried the composer edit itself.
v1.27.0 carried the arrows in the sidebar's search. v1.26.0 carried the
in-conversation search. v1.25.0 carried the notification click. v1.24.0
carried the composer focus, the paste and drop work, and the reconnect fix.
v1.23.0 carried the contact refresh report, v1.22.0 the contact refresh
itself, v1.21.1 a handoff correction, v1.21.0 the unread fix and the people
list, and v1.20.0 the chat list refresh button.

`tools/release.js` owns the version field and derives the bump from commit
subjects since the last tag, so do not hand-edit it.

**A release is required behind every push to `main`.** `check:released` fails
whenever `main` is ahead of the newest tag, so the work above needs
`npm run release` before it is pushed, not after.

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

### The names in a chat, and why the refresh could not change them

v1.22.0 shipped the contact refresh: refreshing a conversation also re-reads the
people in it, so somebody who had changed their name stops appearing under the
old one. It works. What it could not do is explain itself, and for the contact
the complaint was about it had nothing to say at all.

**The contact 16414858965 has no name anywhere in Beeper.** Measured, layer by
layer, on the live account:

- the Google Voice bridge's own store, `%APPDATA%\BeeperTexts\local-gvoice\megabridge.db`,
  row `ghost`: `name = "+16414858965"`, `extra_profile = null`,
  `identifiers = ["tel:+16414858965"]`
- Beeper Desktop's own store, `%APPDATA%\BeeperTexts\index.db`, row
  `participants`: `full_name = "+16414858965"`, `nickname = null`
- the bridge API, `GET /v1/chats/{id}`: `participants[].fullName = "+16414858965"`,
  and no `username` at all
- the chat record itself: `title = "+16414858965"`

So the app was right and the data was thin. A Google Voice contact with no name
in Google Contacts is a number in every layer Beeper has, and refreshing it
cannot turn it into a name. Of the 123 Google Voice contacts Beeper Desktop
keeps, 68 have a number as their name and 53 have a real one.

**And the refresh said nothing while it happened.** A refresh that changed
nothing looked exactly like a refresh that was broken, because neither of them
spoke. That is the part worth fixing, and it is now fixed: the refresh reports
what it found, including the people Beeper cannot name at all.

Three things changed, and one of them was a bug that had been there all along.

**A number is not a name.** `contactName` took `fullName` as the name, and
Beeper fills `fullName` in with the number for a contact it has no name for -
so for most of a phone network's contacts, the "name" was a number. The
function's own comment said a number is not a name and must not be used as
one; the code did not agree. It matters because the name map is what the store
is written with, and a number written over a name is a name lost. `isPhoneNumber`
now draws the line, and a participant whose only name is a number is left out
of the map - which is also what keeps the store from being written a number at
all.

**Your own messages are not renamed, in both places.** The screen has always
left them alone; the store did not, so the two disagreed about the same
message. `nameMap` takes `skipSelf` now, and the store is given that map.

**The refresh says what it found.** `contactReport` works out who was renamed
and who Beeper cannot name; `contactRefreshMessage` says it: "Updated 4 names:
Ada Lovelace", "Beeper has no name yet for +16414858965", or "No contact
changes".

**And the jobs panel was waiting for the window to paint.** The panel's renders
are coalesced into a `requestAnimationFrame`, and a window that is not painting
does not run that callback - so the guard above it dropped every later render
too. The panel stopped updating and stayed stopped, with the state behind it
still moving. A timer is not tied to painting, so `scheduleRender` now has one
as well, and whichever arrives first does the work. This was found because the
refresh report is a toast, and a toast is a DOM change at a moment that moved
the frame; the panel's staleness was already there. `check:sidebar` now has a
check for it that holds the frames back and waits for the row to appear anyway.

## Work done 2026-10-22

Three requests in one: clicking a conversation must leave the cursor in its
composer, pasting must work for attachments as well as images, and drag and
drop must work for both. **Released as v1.24.0.**

### The cursor goes to the composer

`openChat()` calls `focusComposer()` right after it draws the thread and
**before** it awaits the store read. That order matters: the read is an IPC
round trip into the process that is running the background syncs, so a read
that queues behind a sync would leave the cursor waiting with it. The focus
happens first, so the cursor is ready while the messages are still arriving.

The caret goes to the **end** of whatever is in the box, not the start. A draft
the user was part way through is the common case, and a cursor that jumps to
the beginning of it is its own small annoyance.

`focusComposer()` is defensive on purpose: it is called from inside
`openChat`, so an exception raised there would leave the user with a chat that
did not open at all. A composer that is not a textarea has no `value` and no
`setSelectionRange`, and both are checked.

Measured live: the focus was in the search box, a conversation was clicked, and
`document.activeElement` became the composer textarea with the caret at the end
of a 29 character draft.

### Paste and drop take any file

The paste path was images only, because the code filtered the clipboard items
on `type.startsWith('image/')`. A document copied from Explorer is a file like
any other, so the filter is gone and the path takes anything.

Two decisions worth keeping:

- **A file wins over any text beside it.** That is what makes pasting a
  document copied from Explorer attach the document rather than type its path
  into the box.
- **Upload by bytes, for both.** `api.assets.uploadBytes` takes
  `{ data, fileName, mimeType }` and is not image-specific. One code path for
  paste and drop, no change to the preload or the IPC surface, and a clipboard
  file has no path to offer anyway. `webUtils.getPathForFile` was considered and
  rejected: exposing it through the preload would need a matching IPC handler
  under `check:api`, and it buys nothing for a clipboard payload.

The drop limit is 100 MB and the paste limit is 25 MB. A dropped file is one
the user picked out of a folder; a clipboard payload is whatever the OS put
there.

**The whole window takes the drop,** excluding the search box and the manual
token field, matching what the paste handler excludes. A file is dropped into
a conversation, not into a particular box.

Three things the drag had to get right:

- **`dragover` has to call `preventDefault`.** Without it the browser refuses
  the drop and the drop event never fires at all.
- **The file has to be recognised while the payload is still protected.** During
  a drag the browser will not let the app read the files, so `getAsFile()` can
  come back empty and the files list is empty too. What the browser does say,
  from the first `dragover` onwards, is `dataTransfer.types` contains `Files`.
  That is the signal `hasFileItem()` uses, with the files as the fallback.
- **The drop must be claimed before the chat check.** A file dropped on a page
  that does not claim it makes the browser navigate to that file, and
  navigating this window away from the app is worse than a file that did not
  get attached. So the drop is always claimed when it carries a file, and a
  drop with no conversation open says so instead of doing nothing.

The window says it will take the file while the drag is over it: `.app` gets an
`is-dropping` class and a dashed overlay reads "Drop to attach". A drag that
appears to be ignored is one nobody tries twice.

### The attachment vanished when the socket reconnected

This is the bug that made the first live attempt look like the feature did not
work at all: the drop was claimed, the upload ran, and the chip was gone five
seconds later.

`main.js` re-opens the chat it is showing whenever the live event socket
reconnects:

```js
window.beeper.on.eventsReady(() => {
  if (state.activeChatID) openChat(state.activeChatID);
});
```

and `openChat()` started with `pendingAttachments = []`, so every reconnect
threw away the file the user had just attached - and the reply they were
writing. The pending state belongs to the chat it was made in, so it is now
cleared only when the user moves to a **different** chat. Re-opening the same
chat keeps it.

That is the whole difference between the two: the file survives the re-open,
and it still goes when the user moves on.

### Two checks that were wrong about the app

`check:focusread` and `check:download` both failed the moment this work went
in, and both were the harness's fault. Their page had `<div id="composer">`
with the buttons inside it, while the app has a `<textarea id="composer">` with
the buttons beside it. A fixture that says div where the app says textarea is
a fixture that lies: the code that reads the draft out of the composer gets
`undefined`, and the check reports a failure that is not in the app.

Both pages are generated from the real `index.html` now, the way
`check:threadopen` and `check:sidebar` already did, so the DOM in a check
cannot drift from the DOM the app ships.

`check:paste` was rewritten on the same pattern. It used to run against a
blank page and drive the parsing functions; it now runs against the real
markup and drives **the whole path**: a real `dragover`, a real `drop`, a real
`paste`, and the upload that follows each one, with the API boundary stubbed.
52 cases. The upload is stubbed so the second half of the check needs no
account, no window and no network.

### How this was verified without disturbing the account

The live app was never driven for this. Two things made that possible:

- **A hidden window with the real preload and the real IPC.** A probe in the
  Electron main process registers the app's own `ipc.js`, opens a hidden
  `BrowserWindow` with the real preload and the real `index.html`, and drops a
  file into the real DOM. The only thing replaced is `history:open`, so the
  probe never writes to the message database the running app has open. That
  exercises the one hop the hermetic check stubs: renderer, bridge, preload,
  IPC, client, and the real local Beeper server.
- **Only the Note to self chat.** The probe finds the Note to self chat, opens
  it, drops one small text file, checks the chip, and takes the attachment back
  off. No message is ever sent.

The result was `"Attached 1 file"`, a chip reading `e2e-probe.txt`, and the
chip still there after the chat was re-opened. The upload itself was also
measured on its own, against the real local server: a document uploaded with a
mime type comes back with an `uploadID`, so Beeper does accept a typed
document.

## Work done 2026-10-27

### A notification click opens the chat and puts the cursor in it

Reported as "when you click on a pop up notification, it should open to the
chat and focus the text entry field".

It did neither. The click handler in `src/main/main.js` brought the window up
and nothing else, so the user was left looking at whatever chat was already
open, then had to find the right conversation in the list, click it, and click
the composer before they could reply. A toast is a request to reply.

**The click now names the chat it was about,** and the renderer opens it. The
main process sends the chat id over a new push channel, `notification:click`;
the preload carries it; the renderer opens that conversation. Opening a chat
has focused the composer since v1.24.0, so the caret lands there with no
extra work - which is the point of having done that first.

**The window is often not the foreground window when the click arrives.** The
main process has only just been asked to show it, and Windows can refuse the
foreground request outright. A caret set in a background window does not
always survive the activation, so the composer is asked for focus again when
the window takes focus.

That second attempt is **armed once, and only for a click that asked for it**.
An ordinary return to the window must not drag the caret back into the
composer, because the user may have been in the search box, or editing a
message, or halfway through a reply. So the flag is set only when the window
was not already active when the click arrived, and it is cleared the moment
it is used. The control case in the check is the one that fails if it leaks.

The logic lives in `src/renderer/js/notification-click.js`, and the wiring
lives there too - `wireNotificationClicks()` installs the handler the app
really uses, rather than the bootstrap doing it inline. That is what lets the
check drive the real subscription instead of calling the module's function
and hoping the bootstrap matches.

`check:notificationclick` is 20 cases, and
`tools/notification-click-redproof.js` catches 12/12 mutations with 1/1
neutral rewrite tolerated. The red proof found three things worth keeping:

- A check whose body throws reports one failure and hides the rest, which is
  how a broken check looks like a passing one. The harness now keeps the
  cases it collected and adds the error to them, instead of losing all of
  them.
- The first version of the source assertion for the preload matched the
  *subscription* and said nothing about the body, so a wiring that stopped
  opening the conversation would have stayed green. The subscription is now
  driven through the real handler, and the source assertion is about the
  line that installs it.
- The channel name is a string on both sides of the bridge, and a typo on
  one side only left both source checks green while the click did nothing
  at all. The two names are now read out of the source and compared, so
  they cannot drift apart unnoticed.

### A regex that was not a regex

`npm run check:syntax` exists because "a broken check cannot pose as an app
crash", and this is exactly the case it was written for. A pattern written as
`/notificationClick: \(fn) => on\('notification:click', fn\)/` has an
unescaped closing bracket: the regex ended at that bracket and everything
after it was read as flags, so the file did not parse and Electron showed a
JavaScript error dialog instead of the check failing.

**Validate the JavaScript before running it.** `npm run check:syntax` parses
every file in the tree and every harness in it, and it is the difference
between a check failing and the app looking broken.

## Work done 2026-11-02

### Searching inside the conversation that is open

The sidebar has always had a search box, and it searches every conversation
at once. That is the right tool for "where did I talk about the invoice" and
the wrong one for "what did she say about Saturday", which needs the
conversation that is already open.

A magnifier in the thread header now opens a search row under the header, in
the same shape as the sidebar's, so the app has one search idiom rather than
two. The matches are highlighted in the conversation itself rather than listed
beside it, the counter says how many there are, and Enter and Shift+Enter step
through them. **The sidebar's search is untouched** - same input, same scope
selector, same results.

**The matching rule is a substring, not a whole word.** The store's FTS index
matches tokens, so "batt" does not find "battery", and that is the wrong
behaviour for a search box. The store therefore gained a second search,
scoped to one chat, that scans that chat's rows. One chat is thousands of
messages at most and `(chatID, ts, id)` is already indexed, so the scan is
quick, and it cannot reach into another chat by construction. The FTS search
is untouched and the sidebar still uses it.

**Two sources are merged, and the measurements that shaped that are worth
keeping.** `tools/probe-search-shape.js` was written to ask Beeper's own
search three questions, and the answers are in the file's output:

- `chatIDs` **is** honoured. The same query returned 20 hits unscoped and 1
  hit scoped, with none from another chat.
- a hit carries the full `text` and `timestamp`, so a hit can be drawn as a
  real bubble rather than as a line in a list.
- a single message can be fetched by id, which is what turns a hit this
  machine has never stored into a bubble in the thread.
- it matches substrings (`stro` finds `strong`), but a **two-word query
  behaves like a phrase**: `strong code` returns nothing where the single
  words return hits. So Beeper is asked for single-word queries only, and
  its hits are re-tested against the same substring rule the local search
  uses, so the counter can never count a match that is not highlighted.

**Reaching a hit that is not on screen** took two paths. A hit the store holds
but the thread has not drawn is paged backwards through the store until the
window reaches it, and then scrolled to; the scroll position is not preserved
across those pages, because the user asked to be put on the message. A hit only
Beeper knows about is fetched by id, stored, and drawn, and a search that
finds one queues a refresh of the chat - the app is being told its copy of the
conversation is incomplete, and the refresh shows in the jobs panel like any
other, so nothing happens quietly.

The logic lives in `src/renderer/js/thread-search.js`: the matching rule, the
merge, the step order and the highlighter, with no Electron and no import of
the thread. The thread imports it and hands it its own functions, so the
dependency runs one way only and both halves can be checked. The store's
chat-scoped scan is `searchInChat` in `src/main/message-store.js`. The
check is `npm run check:threadsearch` (`tools/thread-search-check.js`), and
`tools/thread-search-redproof.js` proves it can fail.

**The Escape key needed a guard.** The global Escape handler runs in the
capture phase, so it sees the key before the search row's own handler does.
Without a guard, one Escape would close the row *and* the conversation behind
it. The harness does not load `main.js`, so that guard is checked against the
source rather than driven.

### A bug the new check found while it was being written

**A message arriving during a search wiped every mark on screen.** The thread
rebuilds itself in two places, not one: `renderAll`, and the rebuild that
handles an arriving message. Only the first was putting the marks back. The
case that found it is "a message arriving during a search does not wipe the
marks", and the red proof breaks the one line that fixes it.

### Two things in the tooling that were measuring the machine

- **The check runner kept the last six lines of a failed suite**, which is its
  summary: it names the count but not the case that failed. The FAIL lines
  are kept now. This is what a flaky history case looked like - one failure in
  a sweep of forty-five, passing every time it was run alone, and no way to
  tell which case it was.
- **One history case asserted a count that depended on how fast the machine
  is.** The progress announcements are coalesced on a wall-clock interval, so
  the count for the same 200 pages varies with how long the walk took, and a
  walk of 200 pages takes about fifteen seconds here. The case now asserts
  what does not vary: no two announcements are closer together than the
  interval, and there cannot be more of them than the time that passed allows.
  Setting the interval to zero still turns it red.

### The arrows, in both searches

The conversation's own search has had a pair of arrows since it was built, and
the sidebar's search had none. Both step through their results now, the same
way, and the rule they share lives in a module of its own.

**The sidebar's search** draws a list of results - the chats that matched, then
the messages that did - and the arrows step through that list. The current one
is marked with the same soft wash and the same accent edge the conversation's
search puts on the match it is on, it is brought into view, and the counter
beside the box says `3 of 12`. Enter steps forward and Shift+Enter steps back,
which is what the conversation's search already did.

**Stepping does not open anything.** The results list *is* the answer to a
sidebar search, and opening a chat would replace the list with that chat, so
there would be nothing left to step to. Clicking a result still opens it, as
it always did.

**Enter searches for what is in the box.** The box is debounced, so a user who
types and presses Enter straight away would otherwise be stepping through the
results of a search they have already changed - or, with nothing on screen to
step through, getting the answer to the previous question. If the text in the
box is not what the results on screen came from, Enter asks for the search
instead of stepping through stale ones.

The case for that reads the counter **straight after the key, with nothing
awaited in between**. The debounce runs the search a moment later anyway, so
a case that waited for the results would pass with the behaviour taken out.
A timer cannot fire in the middle of a synchronous block, so what the counter
says at that instant is what the Enter did.

**The step rule is shared.** `nextIndex` was in `thread-search.js`, which is
the conversation's module, and the sidebar could not have used it there
without depending on a module named after somebody else's feature. It is in
`src/renderer/js/search-nav.js` now, and `thread-search.js` re-exports it so
the check and the app still find it where they always did.

**The buttons had never been driven by a check.** The conversation's arrows
were on screen from the first release of that search, and the only thing ever
exercised was the keyboard behind them - Enter and Shift+Enter. Two buttons
that nothing had ever clicked is how a button ends up wired to the wrong
thing. Both sets of arrows are driven now, and the cases assert the exact
index the arrow lands on rather than that something changed.

**Both arrows bring what they land on into view.** The sidebar scrolls the
current result into the list; the conversation scrolls the current match into
the thread. A match that is not on screen is a match the arrow did not find,
so each side asserts it.

`tools/search-nav-redproof.js` reintroduces each part of the stepping one at a
time and asserts that the named check fails. It is not in the sweep, because
it mutates the working tree on purpose; run it by hand after touching either
search.

### A hidden window has no layout, and a rectangle of zero is inside every pane

The sidebar's check runs in a window that is never shown, and that is the right
way to do it - a check that puts a window on the desktop is a check that
interrupts the person running it. But a window that is not shown has no layout
in it, and **the app shell was hidden in the harness page** because the shell
is hidden until the app's own script connects, and the harness strips the
scripts. So every rectangle inside it was zero.

That made the check that the current result is brought into view pass without
anything being brought into view. The assertion was "the row is inside the
pane", and a row of zero height at a zero position is inside a pane of zero
height at a zero position. The check was measuring nothing.

Two things fixed it, and both are worth keeping:

- **The shell is shown in the harness**, so the layout is real.
- **There is a control case** - "the results list has a height to scroll in" -
  that fails loudly if the layout ever goes back to zero. A check that cannot
  fail is not a check, and the way to stop that is to make the thing it
  depends on its own case.

The same trap was in the conversation search, where nothing could be measured
either. There the check watches the call to `scrollIntoView` instead: the app
asking the browser to bring the match into view is the part that belongs to
the app, and what the browser then does with it is the browser's business.

One more thing about `scrollIntoView` and 'nearest': a row taller than the
pane it is scrolled into gets its **top** edge aligned and the rest of it
hangs below. So a pane one row tall cannot show that the row is in view - only
that its top is. The pane has to be two rows tall for the question the user
would ask to be the question the check asks.

### The checks must never put a window on the desktop

A check that does not parse is an uncaught exception in Electron's main
process, and Electron answers that with an error dialog: a window that pops
up in the middle of the desktop, looking like the app under test crashing, for
a mistake in a file nobody was even running. That is what happened on
2026-11-02, from a backtick inside a template literal in a check file.

**Every Electron check now runs through `tools/run-check.js`.** It parses the
file before Electron loads it, so a file that does not parse is reported in
the terminal and the process ends - nothing is shown. It loads the check
inside a catch, and it listens for `uncaughtException` and
`unhandledRejection`, because the dialog appears when an exception reaches
the top of the stack with nobody listening. A check that fails is a check that
failed, and it belongs in the output.

`npm run check:launcher` covers all of that: it runs the launcher on a file
that does not parse and on one that throws, and it reads the npm scripts to
be sure none of them launch Electron directly any more. It runs under plain
node, so it cannot put a window on the screen either.

**The parse step is what to do before running anything.** `npm run
check:syntax` parses every JS file and every harness, and it is the thing to
run first after editing a check. A harness is a template literal, so a
backtick in one ends the string early and the file stops parsing.

**The syntax check has to find a harness without finding one that is not
there.** It looks for the declaration of the harness variable, and the
launcher check writes a deliberately broken harness as a fixture - so the
marker text has to appear inside a string somewhere in this repository. The
detector searched the whole file for the marker, found that fixture, and
reported a file that is perfectly fine as broken. The marker is matched at
the **start of a line** now, and `npm run check:harness` holds that up:
`tools/syntax-redproof.js` reintroduces each part of the rule and asserts the
named case fails.

### The avatar cache forgot nothing, and remembered everything

The resolved-avatar cache is what stops a rebuilt avatar from flashing. The
chat list is rebuilt on every local state change, and a rebuilt avatar has no
memory of the image it had, so without the cache every avatar is a circle of
initials for a frame and then the picture. That is why it is cached.

It was cached for ever. Every avatar URL the app had ever seen stayed in the
map until the window closed, and a map that only grows is a leak. It is
bounded now - two hundred pictures - and the ones that have not been wanted
for the longest are the ones that go, because the ones still in use are the
ones being asked about now.

**A cached picture can go stale.** The file behind a resolved URL is a copy
in the app's own media folder, and `npm run media:prune` can remove it while
the app is open. The cache would keep handing out that picture, so the avatar
showed a broken image for good and nothing ever asked for it again. The
browser is the only thing that can say the file is not there, so the image
now watches for its own failure: when one does not load, the entry is dropped
and the picture is asked for again - once, because a picture that is broken
on purpose must not ask for ever.

`check:sidebar` covers all of it, and `tools/avatar-redproof.js`
reintroduces each part of the fix and asserts that the named case fails.

### The note-to-self chat, measured

The note-to-self chat (`!WYgEUOHBAKcVStQTpC:beeper.com`, the pinned "Note")
held thirty-odd stored messages and the thread drew one of them. Measured
against the live account, every link in the chain is sound:

- The store holds 51 messages for that chat, none tombstoned, and the chat is
  marked complete. The read path returns all 51: `pageWithMore` on the real
  file, with the real store code.
- The renderer draws all 51 when they are handed to it directly - the real
  payloads, through the real `openChat`, in a hidden window.
- Beeper's own API answers 20 messages for that chat, so the store is ahead of
  the API, not behind it. The thread has read from disk since v1.10.0 ("the
  thread reads from disk instead of Beeper"), and a thread reading from
  Beeper would have had 20, not 1.

What was missing was proof, and the case that carries it: `check:historyrender`
now opens a note-to-self chat with 31 stored messages and asserts that all 31
are drawn and that the oldest one is on screen too. A list that loses
everything but the newest is indistinguishable from a list that was never
read, so the case counts rows rather than looking for a word.

`tools/history-render-redproof.js` reintroduces the loss - the page fed in as
only its newest message, and the page not fed in at all - and asserts that the
named case fails.

## Work done 2026-11-08

### The up arrow edits the message you sent last

The composer takes the up arrow now. With an empty composer, it opens the
most recent message that can still be edited: the text comes back into the
composer, a banner above it says what is being edited, and Enter saves the
change. The up arrow again steps back through your own editable messages,
and the down arrow steps forward again, so a mis-step is not a one-way
door.

The arrow only acts on an empty composer, and it only steps while the text
it loaded has not been changed. Anything typed means the user is writing,
and the arrow belongs to the text they are writing.

The edit is written through to the local store as well as to Beeper. An
edit that only lived in the renderer would be drawn from disk as the old
text the next time the app started.

### Beeper advertises editing per chat, and there are three answers to read

`capabilities.edit` is a support level: -2 rejected, -1 dropped, 0
unsupported, 1 partially supported, 2 fully supported. Measured against the
live bridge on 2026-11-08:

| Network | Chats | `edit` | `editMaxCount` | `editMaxAge` |
| --- | --- | --- | --- | --- |
| Signal | 3 | 2 | 10 | 86400 s (24 h) |
| Signal Note to Self | 1 | 2 | 10 | absent, so no limit |
| Facebook/Messenger | 3 | 2 | 5 | 900 s (15 min) |
| Google Voice | 91 | absent | absent | absent |
| Beeper (Matrix) | 2 | no `capabilities` object at all | | |

Three states, and they are not the same: a chat with no `capabilities`
object at all is a bridge that did not say, and that is allowed; a chat
with a `capabilities` object and no `edit` key is a bridge that said it
cannot edit, and that is refused; and an `edit` level of 1 or more may
edit. Google Voice is the second and Beeper's own Matrix chats are the
first.

`editMaxAge` is in seconds and is enforced before the arrow offers
anything, so the app never offers an edit the server will refuse.

`editMaxCount` is not enforced. Beeper's message payload carries no
per-message count of how many times a message has been edited, so the only
number the app could produce would count the edits made on this device
and ignore the ones made on a phone. The server's refusal is shown as a
toast instead.

### One edit mode, and two different rules behind the menu

The bubble editor is gone. The context menu's `Edit` opens the same
composer session the up arrow opens, because two editors in one chat means
two rules about which message is being edited and two places to look for
the text.

The menu's two items are decided separately, and they used to share one
flag. `Edit` follows the chat's advertised capability and its age limit.
`Delete for everyone` keeps the rule it has today, because delete is a
different capability with a different age limit that this feature does
not touch, and because narrowing the shared flag would have quietly taken
away the ability to delete a message that has a picture or has aged out of
its edit window.

### What the review caught, and what was changed

A review of the whole branch found five things that had to be fixed before
the feature could ship. They are fixed, and each one has a named case that
goes red when the fix is taken out again.

**The up arrow could land on a message that was never sent.** The app puts
an optimistic bubble on screen before the send round trip comes back, and
leaves it at "failed" when the send does not go through. It is your own
message and it is the newest one, so it passed every rule and the arrow
stepped straight onto it. Enter then asked Beeper to edit an id Beeper had
never heard of. A message the bridge has not confirmed is not editable any
more.

**Every arrow step redrew the whole thread.** That detached every image in
it, which restarts an animated GIF, and it threw away where the reader was.
The marker is moved on its own now, the thread is drawn again only when the
text really has changed, and the signature that decides whether a redraw is
needed follows the marker.

**The rules could not be checked without a window.** They lived in the same
module as the session, which imports the UI for its toasts, and the UI
reaches for `document` the moment it is loaded, so a plain Node import threw
`ReferenceError: document is not defined`. The rules are in
`composer-edit-rules.js` now, which imports nothing but the utility
helpers, and `npm run check:composereditrules` checks them with no Electron
and no window at all.

**The store was given the decoded text.** The convention in `entities.js` is
that decoding happens where the text is shown and never in the stored
message, so storing the decoded value lost one level of entity resolution:
in the bubble at once, and on disk for good. The store is given the encoded
text now, and Beeper is still given the text as it was typed.

The one trade-off: `<` and `>` are encoded too, so an edit to a message that
arrived as literal HTML (a Matrix room, a bot) is stored escaped, and the
app shows the markup as text instead of rendering it. That is the honest
reading of the convention, and it only shows after an edit.

**The red proof could have been green for the wrong reason.** It printed a
baseline and asserted nothing, so a mutation could be reported as caught
against a case that was already failing. The baseline is asserted now, and
every named case has to be PASS in it, or the proof refuses to run.

Two things the review left open have been dealt with since.

**A message arriving in a chat with no history is now drawn.** `state.js`
announced a change to the thread before it put the message in the store, so
for a chat this window had never opened there was no list to put it in yet:
the thread was told about a message it could not see, drew nothing, and the
message did not appear until whatever came next. For the first message in a
chat that is your own message, sitting there not drawn while Beeper is still
answering. The list goes into the store before the change is announced. It
was measured on the tree before this feature as well, so this feature never
caused it.

**The redraw signature is proved, not assumed.** The line that keeps the
signature describing what is on screen had no case of its own, because every
redraw in the app is preceded by an update that has already set the same
value. There is a way to see it: a chat this window already has, whose store
read answers with nothing, and whose messages arrive again from the
background sync. Nothing about the thread has changed, so it must not be
drawn again, and that is the signature's job. `check:threadopen` says so
now, and `tools/thread-open-redproof.js` takes the line away to prove the
case goes red without it.

## Work done 2026-11-09

### The composer grows to fit the message being edited

The up arrow puts the text of the message into the composer, and the composer
is one line - it has been since the auto-grow was removed, because a composer
that grows as you type pushes the thread up and leaves the newest message
riding at the top of the window.

An edited message is a message that already exists, and read back in a
one-line box that scrolls sideways, the end of it - and the cursor with it -
is off the screen, and the message being edited cannot be read at all. So
while an edit is open the box is as tall as the text needs: `field-sizing`
lets the box be sized by what is in it, and the text wraps instead of running
off to the right. The cap is 30vh, which is what stops a long message from
eating the thread. The composer is one line again the moment the edit ends.

The cursor is at the end of the text when the edit opens. It already was: the
browser puts the cursor at the end when a value is assigned, and the focus
helper puts it there for every other path into the composer. The session does
not set it a second time - a second rule there would only ever be a rule the
focus helper overrules.

### A check that stopped working on its own

The composer edit suite stopped passing on 2026-11-09, with nothing in the
app having changed. The chat in the check advertises a twenty-four hour edit
window, and its messages were timestamped against a fixed date - so the
moment the clock passed that date, every message in the chat fell outside
its window, nothing in it could be edited any more, and every case that
needed an edit failed while every case that did not still passed.

The messages are timestamped against the real clock now. A check that depends
on a wall clock has to be dated against it, or it is a check that works for a
day.

### The TLS warning was Chromium looking for a proxy

The log said `handshake failed ... net_error -202`. That code is
`ERR_CERT_AUTHORITY_INVALID`: the certificate chain was issued by an authority
that is not trusted. (It is not `ERR_CERT_ALT_NAME_INVALID`, which is -200 -
this file said so until 2026-11-11, and the difference matters, because the
cause is an untrusted authority rather than a name that does not match.) The
handoff had guessed "probably a different endpoint or an intercepting proxy".
It was neither, and it was never the GitHub call - api.github.com serves a
certificate for itself, was reachable with a plain `https.get` from this
machine, and was never in the log.

It was **Chromium's proxy auto-discovery**. Chromium looks for a WPAD file by
fetching `http://wpad/wpad.dat`. On this machine `wpad` resolved to
`wpad.yatesframe.com`, which is Scott's own YunoHost box at 139.64.176.66.
The fetch is answered with a redirect to `https://wpad/yunohost/admin`, and
the certificate that answers is **YunoHost's default self-signed one** -
`CN=yunohost.org`, issuer `O=yunohost, CN=yunohost.org` - because no vhost
serves that name, so nginx falls back to the default server. The chain is not
trusted, so the handshake fails with -202. The net log of an Electron process
started here says so in as many words: the name `wpad` is in it, and so are
the -202 errors. The real `yatesframe.com` certificate is a Let's Encrypt one
(`CN=yatesframe.com`) and does not cover the name either, so the redirect is
broken either way - it is only the reason that is different.

The fix is `src/main/proxy-config.js`: `--proxy-server=direct://`, applied
before `app.whenReady()`. A switch set after the network stack has started is
accepted by Electron and ignored by Chromium, so the timing is part of the
rule. The app has no use for a proxy - the renderer makes no network requests
at all, and the only outbound call in the app is the GitHub release feed.

**The DNS side of it is closed too, and is not on the list any more.** `wpad`
was resolved as an alias of `wpad.yatesframe.com`, both pointing at
139.64.176.66, where no vhost serves that name. The record now points at
`0.0.0.0`, so the lookup fails at once instead of being answered with an
untrusted certificate. Nothing is left to do there, and it is not an item to
chase: the app does not go looking, and the browsers that do are the
browser's business, not this app's.

**The check has a control, and the control is the point.** "No proxy lookup
happened" is also what a Chromium that never looks would produce, on a machine
where the lookup would have failed anyway: a check that cannot see the problem
reports a pass and proves nothing. So `check:proxy` runs the probe twice, once
with the app's policy and once without, and the run without it has to show the
lookup:

| run | `wpad` in the net log | `-202` errors |
| --- | --- | --- |
| the app's policy applied | 0 | 0 |
| the policy left off | 52 | 12 |

`tools/proxy-redproof.js` mutates the probe so that it applies the policy even
when it is told not to, and the control case goes red - which is what makes
the control worth having. It is 5/5 mutations caught, with its own baseline
asserted.

One trap worth recording: the first version of this check searched the net log
for the word "wpad", case-insensitively, and failed against a log that was
clean. The net log's own table of constants carries names like
`WPAD_DHCP_WIN_FETCH` in every log it ever writes. The count that means
something is a *URL* whose host is `wpad`.

### The empty command windows were a batch file's status window

The handoff said "Most likely orphaned consoles. Never proven." It is proven
now, from the git history.

The updater between **v1.18.0 and v1.18.3** wrote two batch files and opened
the second one on the screen:

```
if exist "<statusScript>" start "Better Beeper Update" "<statusScript>"
```

That is a console window by construction. The status script drew a progress
bar in ASCII in it, and it closed itself when the install finished - which is
what the old code says it did: "the status window polls it and closes itself
when it goes, which is what stops an orphaned window sitting there". **An
interrupted update never cleared the flag, so the window never closed.** That
is the empty command window: a console standing there with nothing left in
it, after an interrupted update, on exactly the versions that had one.

v1.18.4 and v1.18.5 shipped a rewrite of that line
(`start "..." cmd.exe /v:on /c ""<path>""`) that cmd rejects outright, so in
those two releases the window never appeared at all. v1.18.6 replaced the
whole thing with the .NET helper.

The current path cannot have a console window, and now three checks say so
rather than the handoff saying "probably":

| where | what it is |
| --- | --- |
| `tools/update-helper/UpdateHelper.csproj` | the helper is a `WinExe`, so Windows never allocates a console for it |
| `src/main/updater.js` | the helper is spawned with `windowsHide: true`, so nothing is shown even if it had one |
| `tools/update-helper/Program.cs` | the installer is started with `CreateNoWindow = true` and `UseShellExecute = false` |
| `src/` as a whole | no batch file anywhere in the app, not just in the updater |

The last one is the rule that was broken before. The old check only ever
looked at `updater.js`, so a batch file used anywhere else in the app would
have passed it; the new check walks `src/`, and the red proof puts a batch
file in `ipc.js` to prove the walk sees it. `tools/update-redproof.js` is now
21/21, up from 17.

### The up arrow was right, and silence was the defect

Reported as "the up arrow does not seem to work in all conversations. For
instance Corinne's signal chat does not respond to up arrow".

**The rules were correct.** Measured against the live bridge, over 100 chats,
with the app's own `composer-edit-rules.js` imported into the probe:

| chat | network | edit level | window | editable of mine |
| --- | --- | --- | --- | --- |
| Jim Kraai | Signal | 2 | 24 hours | 5 |
| Mike Fazio | Signal | 2 | 24 hours | 1 |
| Signal note to self | Signal | 2 | none | 1 |
| **Corinne** | Signal | 2 | 24 hours | **0** |
| Scott Burgess, Tracey Yates, Shawn Williams | Messenger | 2 | 15 minutes | 0 |
| Note to self | Beeper (Matrix) | - | - | 20 |
| Google Voice chats | Google Voice | no edit key | - | 0 |

Corinne's newest message of yours was **94.0 hours old** and the window Signal
publishes for that chat is 24 hours. Eight of your ten messages there were too
old and two had attachments. Nothing was broken: the arrow had nothing it was
allowed to open, and it said nothing about that.

**A key that does nothing is indistinguishable from a broken key**, so the fix is
to explain, not to change which messages are editable. The arrow still skips what
it cannot edit and still opens the newest editable message when there is one.
When there is nothing it can open it now:

- says why, in the chat's own terms - the window the chat published (24 hours on
  Signal, 15 minutes on Messenger, none on a note to self), and how old your
  last message there was;
- marks the message it could not open, with a dashed outline that is not the
  editing outline, and scrolls the thread to it, so the sentence is about
  something the reader is looking at.

**One rule, two views.** `isEditableMessage` is `messageEditRefusal(...) ===
null`, so the answer and the reason cannot disagree. The chat-level reason is
the one that applies to **most** of your messages, a tie going to the newest,
because that is the one the arrow would have opened. For Corinne that is "too
old" (8 of 10), not "has attachment" (2 of 10).

The refusal codes are the contract the explanation is written from:
`chat-cannot-edit`, `chat-read-only`, `no-own-messages`, `too-old`,
`has-attachment`, `not-confirmed`, `deleted`, `hidden`, `not-mine`.

**One assumption to flag.** Scott's "if a message is not editable, show this and
explain why" arrived with no image attached, and the questionnaire that would
have settled it was interrupted by his next message. The reading taken was: mark
the message in the thread and scroll to it, plus a toast naming the reason, the
window and the age. The alternative reading - a note on the message bubble
itself - is not what shipped, and it is the one thing here to revisit if the
behaviour is not what was meant.

### "Failed to download attachment" is the bridge talking, not the sender

Measured: the phrase is the **first line of the message text itself**. When a
bridge cannot download an attachment it does not send the message without it -
it sends the message with the failure written into the text. Google's Voice
bridge does it like this:

```
Failed to download attachment

here's another deer I passed. big eight but not quite what I was looking for.
```

Four such messages on this account, **all Google Voice**, every one of them a
voice message whose audio Google refused to serve when Beeper's bridge asked
for it, and every one of them carrying **zero attachment objects**. Beeper's own
SDK log (`%APPDATA%\BeeperTexts\logs\sdk\sdk-*.log`) says why:

```
{"level":"error","component":"bridges","local_bridge_id":"local-gvoice",
 "request_url":"https://voice.google.com/u/0/a/i/71b0ffcda8c7540f291cb3032ecaa2ecec181517-1?s=1",
 "status_code":400,"error":"unexpected status code 400",
 "message":"Failed to download attachment"}
```

So the bubble read as if the sender had typed the complaint themselves and then
said something else, and the missing file was nowhere to be seen. The
placeholder is now taken off the text and shown as what it is: the sender's
words stay the message, and a chip says "Attachment could not be downloaded".

The placeholder only counts as one **when something follows it**, so a message
that is exactly the phrase is still somebody's words.

**The bytes cannot be recovered from here.** Google answers Beeper's bridge with
HTTP 400 for those voice messages, so the file is not on this machine and
cannot be fetched through the app. The most this app can do is present the
failure honestly, and it now does.

**Found, not fixed, and it is upstream.** Google Voice attachment ids are
`file:///C:/...` URLs, and the bridge's `POST /v1/assets/download` rejects them
with HTTP 400 `URL must start with mxc:// or localmxc://`. Twenty-four of the
twenty-five attachments probed were fine, so this is a narrow fault in Beeper's
Google Voice bridge rather than a general one.

### The notice about a missing attachment was beside the words, not above them

The first version of the missing-attachment notice put the chip into the
bubble as a third item in a row. The bubble is a row of text and timestamp
(`.bubble-inner { display: flex; align-items: flex-end; gap: 9px; }`), so the
words were squeezed into a narrow column down the side of the bubble with the
chip sitting at the bottom of it.

The notice and the words now share a column of their own (`.bubble-stack`):
the notice is on its own line above the words, and the words start at the same
left edge as the notice. The timestamp is unchanged - it is still at the
trailing edge of the bubble, at the bottom.

**The check measures the screen, and a screen with no layout measures
nothing.** The app shell is hidden until the app's own script connects and the
harness strips the scripts, so the shell is shown before anything is measured,
and a control case fails loudly if there is still no layout: the list has to
be taller than zero and the words wider than zero. Two mutations prove the
case is load-bearing - removing the stack from the markup, and turning the
column into a row - and both make it red.

## Work done 2026-11-10

### The read receipt was your own read, not a delivery

Asked for as "check delivered times in messages". The times on messages were
checked against the live bridge, and the receipt on your own messages was
wrong.

**What Beeper actually sends.** A message carries `seen`: a map of account id
to the time that account read it. Measured over 484 messages from 100 chats:

| | |
| --- | --- |
| message objects | `id`, `chatID`, `accountID`, `senderID`, `senderName`, `timestamp`, `sortKey`, `isSender`, `type`, `isDeleted`, `mentions`, `text`, **`seen`**, `isUnread`, `attachments`, `isHidden`, `linkedMessageID`, `reactions`, `links`, `editedTimestamp` |
| a "delivered" field | **there is none** - `seen` is the only read state there is |
| `timestamp` format | ISO 8601 with `Z`, 484 of 484, none missing and none unparseable |
| `seen` shape | always a map, 445 of 484 messages; never a bare boolean or a bare string |

**The bug.** On a message of yours, the map names **you** first, with the time
your own window marked the conversation read - a second or two after you hit
send, because the message is on screen in your window as you send it. The app
took the latest entry in the map and wrote it as the receipt, so the receipt on
your own messages was your own read time.

Measured over 261 messages of yours:

| | count | gap between the send and the "read" |
| --- | --- | --- |
| the map names only you | **242** | median **0 minutes** (a second or two), worst case 577 days |
| the map names somebody else as well | 4 | 0.1 to 108.7 minutes |

So 98% of the receipts on screen were a time that said "read" about a message
the other person had not read at all, and the outliers were worse: an old
message of yours that you scrolled past in the last week carried a receipt
saying it was read 143 days after you sent it.

**The rule now.** The receipt on a message of yours is somebody **else's** read
time. Your own read is not a delivery, so it is not shown. A message nobody
else has read carries no receipt - just the tick that says it was sent, which
is what the row already had a place for.

Who is "you" comes from the chat's own participant list: every one of the 100
chats on the live account marks exactly one participant with `isSelf`, and
that id is the one the seen map names when you read your own message. The
message's own sender id is the fallback for a chat with no participant list.
The account list is not usable for this: `GET /v1/accounts` returned nothing.

**A read on another day carries the date.** A message sent at 11pm and read at
8am said "8:03 AM", which reads as the morning before rather than the morning
after. The receipt now carries the date when the read was on a different day
than the send.

The rules live in `src/renderer/js/read-receipts.js`, which touches no DOM, so
`npm run check:readreceipts` runs them under plain node. The rendering is
checked in `check:threadopen` (a message only you have read carries no
receipt; a message somebody else has read does; and the receipt appears when
their read time arrives), and the rule that the app's own read time is not a
delivery is checked in `check:composer`.

`tools/thread-open-redproof.js` is 13/13 with no holes, up from 9/9: four new
mutations - your own read counting as a delivery, the receipt written from any
seen time, the thread's signature forgetting the delivery time, and the oldest
read winning instead of the newest.

**One thing this does not do.** Only 4 of your 261 messages carried anybody
else's read time, so most of your sent messages now show the sent tick and no
time. That is what the data says: Signal and Messenger do not report the
recipient's read state for most messages on this account, and where they do
report it, it is 0.1 to 108 minutes after the send.

## Work done 2026-11-11

### The app has an icon now, and it is drawn from one file

The executable was carrying Electron's default icon. There is now a real
one: a white speech balloon on the app's own accent blue, which is the
outgoing bubble colour, so the icon and the app are the same product, with
"BB" knocked out of the balloon in the plate colour. The balloon says
"chat", the letters say "this one", and knocking them out rather than
drawing them on top keeps the mark to one shape inside another, which is
what still reads at 16 pixels in a crowded taskbar.

The letters are drawn as paths, not set as text. A font is a dependency the
build machine may not have, and a monogram that changes shape because
somebody installed a different font is not a stable icon. The letter is one
path with two counters, filled with evenodd so the counters come out as
holes, and the second B is a copy of the first shifted sideways, so both
letters are guaranteed to be the same shape.

The artwork is one file, `build/icon.svg`, and everything else is drawn from
it:

| file | who uses it |
| --- | --- |
| `build/icon.svg` | the artwork, and the only file edited by hand |
| `build/icon.ico` | electron-builder puts it in the executable, the installer and the shortcuts |
| `src/assets/icon.png` | packed into the app, and handed to the windows |

`npm run icon` redraws the two generated files. `tools/build-icon.js` does
the drawing and `tools/icon-render.js` does the rasterising, and the split
exists because the check has to draw the artwork the same way the builder
does, or it is comparing two different things.

**The .ico is written by hand.** There is no icon library in this project and
adding one for a format this small would be a larger dependency than the
problem. The format is a six byte header, a sixteen byte directory entry per
size, and then the images: a DIB for each of the small sizes, which is what
the older readers that still draw icons in the shell expect, and a PNG for
the 256 pixel one, which Windows has understood since Vista and which is a
quarter of the size of the same picture as a DIB.

**Drawing at each size, not shrinking one picture.** All seven sizes Windows
asks for (16, 24, 32, 48, 64, 128, 256) are drawn at that size, by putting
the SVG in a page of exactly that size and capturing the page. An icon made
by shrinking a 512 pixel picture looks like a smudge at 16, which is the
size the taskbar uses.

**One bug, found by asking Windows to read the file back.** Electron's
`toBitmap()` returns the pixels top-down, while a DIB stores its rows
bottom-up: the first row in the file is the bottom row of the picture. The
first `.ico` came out upside down, and nothing in the build noticed. It was
found by loading the file with `System.Drawing.Icon` and looking at what
Windows drew, which is why the check now reads the file back rather than
trusting the code that wrote it.

`check:appicon` draws the artwork again, builds the `.ico` from that fresh
drawing, and compares it with the file in the repository byte for byte. An
artwork that was edited without the files being regenerated is caught instead
of quietly shipping the old picture. `tools/app-icon-redproof.js` breaks the
files on purpose in a copy of the tree and insists the check notices each
one: seven mutations, seven caught.

### The icon check only passed on a display set to 100%

Pulled onto this machine, `check:appicon` was the one red suite out of 53:
`rendered 24x24, wanted 16x16`. The files in the repository were right - the
other 14 cases passed, and the committed `.ico` and `.png` are the correct
sizes. The **check** was wrong here, and wrong in a way that would have
shipped a wrong icon.

**Why.** A capture is the size of the window **times the display's scale
factor**. The renderer puts the SVG in a page of exactly 16 pixels and
captures the page; this display is set to 150% (`AppliedDPI` 144), so the
capture came back 24 pixels. The same artwork therefore produced a different
file on every machine, `npm run icon` on a scaled display would have written
files of the wrong sizes, and the check could not reproduce the repository's
files at all - it was comparing two different pictures and reporting the
difference as a byte number.

**The fix.** `tools/icon-render.js` forces `force-device-scale-factor=1`
before the app is ready, so the drawing is in device pixels one for one. The
redraw on this machine now reproduces the committed `.ico` and `.png` **byte
for byte**, which is also the proof that the committed files are the right
ones - the check had been comparing the wrong thing, and now it compares the
right thing.

The size is a **named case** now - "the artwork is drawn at the size it is
wanted" - rather than an exception that killed the suite with a byte number.
`tools/app-icon-redproof.js` is 7 caught, 0 missed: the new mutation draws
the artwork at twice the size on purpose (`BB_ICON_FORCE_SCALE=2`), which is
wrong on any machine, so the proof does not depend on the display it runs on.

The windows are given the icon as well. `main.js` passes it to the main
window, `auth.js` to the approval window, and the app now sets an explicit
AppUserModelID, so Windows groups the taskbar entry and the jump list under
"Better Beeper" instead of under `electron.exe` when the app is run from
source.

### The app would not launch, and the reason was a process that could not be killed

**Symptom.** The installed app produced no window, no error dialog and no
exit code. Every attempt to start it hung.

**It was not the code.** Every installed file was byte-identical (SHA-256) to
the official 1.28.8 payload, the same tree ran fine from source, and a copy
of the install directory ran fine. Only the installed path failed.

**It was a lock on the executable.** Opening `Better Beeper.exe` with read
access and no sharing fails with "used by another process". It was the only
file in the folder that was held. Windows blocks the launch of a locked image
inside the loader, so the start call never returns: no window, no error, no
diagnostic. Any probe that calls `Start-Process` on it wedges too, which is
how several probes here hung before the cause was known.

**Who held it.** The Restart Manager API names the holder: pid 13316,
`Better.Beeper-1.28.8-x64-setup.exe`, the 1.28.8 auto-update installer,
started by the update helper with `/S`.

**Why it could not be cleared.** The installer was already in kernel
termination: `NtTerminateProcess` returned `0xC000010A`
(STATUS_PROCESS_IS_TERMINATING). `Stop-Process -Force`, `taskkill /F /T`
and renaming the install directory all failed with "in use". Only a reboot
releases it. The helper had already timed out at fifteen minutes and written
`-1  The installer did not finish within 15 minutes.` to `update-result.txt`,
so the app was left with a locked executable and no way to start.

**The relaunch script.** `C:\Users\Scott\AppData\Local\BetterBeeper\relaunch-check.ps1`
is left behind for after the reboot. It tests the lock first and refuses to
launch while the executable is held, and the launch itself runs under a
thirty second job timeout, so it cannot wedge the way every other attempt
did. Exit codes: `0` running, `2` still locked, `3` the launch call hung, `4`
started but nothing survived. It was verified on all three paths against real
executables, and two bugs in it were found that way: the lock probe needed
read-only access to work on protected files, and the process detection had to
recognise a stub process that exits and leaves the real one behind.

**What this means for the updater.** The wedge happened inside the update
handoff, and the update handoff is the code that is supposed to leave a
runnable app behind. It did not. The helper gave up after fifteen minutes
and wrote a report, but it could not abandon the wedged installer, and the
app it was updating was left unable to start. That is a defect in the
updater, not a one-off, and it is listed under "Still outstanding".

### The failure path is fixed, and the helper can be stopped

**The ask.** "closed. fix the failure path" - the handoff helper needs a way to
give up on a wedged installer, and the updater needs a failure path that
leaves the previous executable runnable.

**Four things were wrong, and all four are fixed.**

1. **The installer was killed one process at a time.** `Process.Kill()` stops
   the process it is given. An NSIS installer spawns children, and they are
   what keep the app's files open. The installer and everything it starts are
   now put in a **job object** (`tools/update-helper/Program.cs`, the `Job`
   class), which is the only thing Windows offers that stops a whole tree at
   once. The job is created with `KILL_ON_JOB_CLOSE`, so anything still in it
   when the handle closes dies as well - which covers the helper itself being
   killed, which would otherwise leave an installer running with the app's
   files open.

2. **The install was attempted even while the app's files were held.** The old
   code waited for the files to be free and then installed regardless of the
   answer. That is how an installer ended up fighting a lock it could not
   take: it wedged, holding the very file the app needs to start. The wait is
   now a decision (`ReleaseAppFiles`): if the app's executable is still held
   after the wait, the app's own leftover processes are stopped, and if it is
   still held after that, **the install is not attempted at all**. The helper
   says what is holding it and that Windows has to be restarted.

3. **The app was only started again when the install had worked.** A failed
   install therefore left the user with **no app at all**, which is the worst
   outcome available: the old version is still on disk and still runnable, and
   nothing was starting it. The app is now started again whatever happened,
   and the outcome says which version came back.

4. **The result was written after the app was started.** The app reads the
   result on its way up, so it could start, look for the file, and find
   nothing - and the failure was never reported to anybody. The result is now
   written first.

**The window stopped lying.** The old status window said "Better Beeper will
reopen on the old version" whatever had happened, and the code only reopened
the app when the install had worked. The wording now comes from the result
code, so it says what happened rather than what usually happens. There is
also a **Stop the update** button: waiting out a fifteen minute timeout with
nothing to do about it is the worst way to spend the time an installer is
hanging.

**The reason is no longer thrown away.** The result file is `code<TAB>detail`,
and `readInstallResult()` used to do `Number(raw)` over the whole file, which
turns `-1<TAB>The installer did not finish within 15 minutes.` into `NaN`. The
code came back null and the reason was dropped: the user was told the
installer exited with an unknown number, which is the one thing they could not
do anything with. The detail is kept now, and the app says the outcome in
words - the installer was stopped, the app's files are held, the app could not
be started again.

**A failed install is reported even with automatic updates off.** The report
used to ride on the update check, and the update check is skipped when
automatic updates are off - so the person who had turned them off and had an
update fail anyway, because they asked for one by hand, was never told. There
is a new `updater:status` handler that answers the question directly, with no
network call, and the renderer asks it at startup.

**The codes are the helper's and the app's to agree on.** `ResultCodes` in
`Program.cs` and `INSTALL_OUTCOMES` in `src/main/updater.js` have to mean the
same thing, and there is nothing that keeps them agreeing except a check that
reads one and compares it with the other.

| Code | What happened | What the app says |
| --- | --- | --- |
| 0 | It installed | nothing - it worked |
| 1 | The installer ran and failed | "The update did not install: the installer stopped with an error." |
| 2 | The installer was stopped | "The update did not install: the installer was stopped." |
| 3 | Something is holding the app's files | "Windows is still holding Better Beeper's files, so it could not be started. Restart Windows to use it again." |
| 4 | The app could not be started again | "Better Beeper could not be started again." |
| -1 | Something else went wrong | "Something went wrong with the update." |

**The check runs the real helper.** `check:updatefailure` builds the helper
that ships in the app and runs it against real executables built for the
purpose: an installer that hangs and starts a child, a child that hangs from a
*different* path, one that exits 0, one that exits 3, one that reads the
result file, and one that holds a file open so nothing else can. The child is
at a different path on purpose, so the sweep by path cannot find it and only
the job object can stop it - which is what makes the check mean something.

**What that check found.** It found a bug in the fix itself: the branch that
gives up on a held folder returned `InstallerFailed` instead of `FilesHeld`,
so the app was told the installer had failed rather than that Windows was
holding its files. That is the whole reason the suite runs the program rather
than reading it.

**One rule is checked in the source, deliberately.** "The result is written
before the app is started again" is a race, and .NET's own start-up time is
long enough that the app usually wins it even when the order is wrong. A
behavioural check there would be green against a bug, so that one is checked
in the source instead. Every other rule is checked by running the thing.

**The helper shows a window even when it cannot start.** It used to exit
silently when it could not even work out what it was asked to do, which is
indistinguishable from never having been started. It now says so, on a window
with a Close button, and waits for it to be read.

### The update's window was never checked, and the pin was never kept

Scott reported two things about an update: the helper's window does not show,
and the app comes off the taskbar and has to be pinned again by hand.

**The window.** The helper's window had never once been run. Every check that
drove the helper passed `--no-window`, because a window on the desktop during a
test is not allowed - so "the window shows" was an assumption with nothing
behind it, and the window path could have been broken for as long as it had
been written.

The helper now writes down what it did as it does it (`--trace <file>`), and
the app always asks for one: `<userData>\update-helper-trace.txt`. The trace
says whether the window was built, whether the message loop started, and - the
part that matters - whether the window was visible and which desktop it was
on. A window on a desktop the user is not looking at is a different failure
from a window that was never created, and only the trace tells the two apart.

`check:handoff` runs the real helper with the real window and reads the
trace. The window is put off the screen while the check runs, so the window
path can be exercised without putting anything in front of the user. It is
still created, still shown and still visible in every sense Windows cares
about, which is what the trace records.

> **Superseded later the same day.** The off-screen mode used to make the
> window *transparent* as well, and the paragraph above said so. A transparent
> window is `Visible = true`, so that made the check unable to tell an
> invisible window from a visible one. The mode now only moves the window, and
> the check asks whether it is opaque. The pin paragraph below was wrong about
> the pin for a different reason - see "The pin went missing because the
> update uninstalled the old version" above.

Running that check on this machine says the window works: it is built, it is
visible, it is on the `Default` desktop, and it is up while the install runs
rather than after it. It says the same when the helper is spawned exactly the
way `updater.js` spawns it - detached, `stdio: 'ignore'`, `windowsHide: true`
- and when the spawning process is Electron itself and exits 300 ms later.

**The pin.** The taskbar pin is a copy of the Start Menu shortcut. That was
measured, not assumed: on this machine the pinned `Better Beeper.lnk` and the
Start Menu `Better Beeper.lnk` had the same SHA-256, and both had the
modification time of the install. The installer rewrites the shortcut - the
uninstaller deletes it and the installer creates it again - and Explorer's
copy is left holding an item it can no longer match, so the pin has to be put
back by hand.

The helper puts it back, from the shortcut as the installer left it, and it
does so whether the install worked or not: a failed install rewrites the
shortcut just as well as a good one. The helper is the only thing alive
across the gap the installer makes, so it is the only place the pin can be
put back.

> **This was wrong, and it made the pin worse.** Overwriting Explorer's own
> copy of the pinned shortcut does not restore a pin; it makes Explorer
> register the item as a new one - `Better Beeper (2).lnk` - at the end of the
> list. The helper now only inspects the pin. See "The pin went missing
> because the update uninstalled the old version" above.

**And the helper itself.** It used to run from inside the install folder - the
very folder the installer replaces. Windows will not delete a running
program, so the installer could not finish deleting it, gave up with "File is
busy", and the helper's own executable was never replaced by the new one. The
app now copies the helper to `%LOCALAPPDATA%\Better Beeper\update-helper\` and
runs that copy, so the install folder is free to be replaced while the helper
keeps going.

`tools/update-handoff-redproof.js` breaks each of those rules in turn and
requires the check they were written for to catch it: 9/9, with an asserted
baseline.

### The proxy check's control had stopped being possible

The `wpad` DNS record now points at `0.0.0.0` instead of resolving to a host
that served a PAC file. That is the right thing to have done with it: it is
what stopped Chromium reaching for a proxy at all, and the -202 certificate
failure cannot come back while nothing is listening.

It also broke `check:proxy`, which needs a control - a run with the proxy
policy left off, in which Chromium *does* look for a proxy. With the record
pointed at a black hole, Chromium never made the request, so the control saw
no lookup and the check reported that it could not see the problem it exists
to catch. The case that says "Chromium does not go looking for a proxy" was
passing for the wrong reason: there was never going to be a lookup to find.

The control now points "wpad" at the loopback address with Chromium's
`--host-resolver-rules`, so the name resolves and Chromium's own proxy
auto-discovery has something to find. Nothing is serving
`http://wpad/wpad.dat`, so the fetch fails, and it does not matter: the point
is that Chromium tried, and the net log says so. The control is now part of
the check rather than a property of the network the check runs on.

`tools/proxy-redproof.js` was 5/5 before and is 5/5 now, but one of those
mutations is now caught for a different reason. "The proxy policy does
nothing" used to leave the check green, because with no WPAD lookup possible
there was nothing for the missing policy to cause. It goes red now, which is
the whole point of the case.

## Work done 2026-11-12

### The window came back slightly off, and the offset was the overhang

**What was reported:** "the close and reopen coordinates do not seem to exactly
work. When the window is very close to the edge of a monitor, it comes back
slightly offset from where it closed."

**What it was.** The saved bounds were clamped into the work area of whichever
display owned them:

    x: Math.round(Math.min(Math.max(saved.x, area.x), area.x + area.width - width)),

That clamp was there for a good reason - a window whose display has been
unplugged would otherwise open in the void, with no way to get it back - but it
did not stop at the case it was for. It applied to every position, including
the ones the user had chosen.

**Measured, not assumed.** A probe (since removed) drove the real window
through every edge of every one of this machine's seven displays, with the
window hidden so that nothing reached the desktop, and read the bounds back at
each step. The offset was exactly the overhang, and nothing else:

| the window was closed | it came back |
| --- | --- |
| 30px past the right edge of a display | 30px to the left of that |
| 30px past the left edge | 30px to the right of that |
| 30px above the top edge | 30px below it |
| 30px below the work area | 30px above it |
| flush with an edge | exactly where it was |

The last row is the one that matters: a window that was *exactly* at an edge
came back exactly. The offset only ever appeared when the window was over the
edge, and then the offset was the overhang. Nothing else about the desktop was
involved - the same numbers came out of every display, at every scale factor,
on both sides of the screen.

The taskbar was the same case. The primary display's work area is 48px shorter
than the display because of the taskbar along the bottom, so a window closed
over the taskbar came back above it - and the bottom edge of the screen is
where a window lives most of the time.

**What it is now.** `src/main/window-bounds.js` holds the geometry, away from
Electron, and the rule is one sentence: the window opens exactly where it was
closed - the same position and the same size.

The clamp survives in the one case it was written for. If the saved window
touches no display at all - the monitor it was on is gone - it is brought onto
the primary display and centred. That test is "touches no display", not "is not
entirely inside one": a window hanging over an edge still touches its display,
and a window in the gap between two displays does not.

**The size was being tidied up too.** The old code also fitted the width and
height to the display, so a 900px window on the 682px-wide portrait display
came back 720px wide - the app's minimum. That is the same tidying, and it is
gone as well: the size is the size the user had.

**The last move was being thrown away.** The bounds were written 400ms after
the last move event - a drag fires one for every pixel - and the window closing
did not write anything at all. A window closed within 400ms of being dragged
therefore came back where it was *before* the drag. The window now saves its
bounds when it closes, as well as on the debounce, and the rule about what is
worth saving has moved into `boundsToRemember()`: a minimized or full-screen
window is not saved (its bounds are not the shape the user chose), and a
maximized window is saved as the rectangle it had before it was maximized.

**What proves it.** `npm run check:windowbounds` (28/28) checks the geometry
against displays that are made up - a taskbar in the way, a monitor that is not
there, a display narrower than the minimum window - because the cases that
matter are not the ones this machine happens to have. It also asks the real
desktop the same question, and puts a real window where the app would put one -
hidden, so nothing appears on the desktop - and reads back where it landed.

`tools/window-bounds-redproof.js` breaks each rule in turn: 9/9 mutations
caught, no holes, with the baseline asserted. The mutations are the ones that
would bring the bug back - the clamp returning, the taskbar clamp on its own, a
one-pixel nudge, the size fitted to the display again, the rescue for a
vanished display removed, the rescue leaving the window in the void, the app
stopping asking the module at all, a minimized window being remembered, and
the window not being remembered when it closes.

### The pin went missing because the update uninstalled the old version

**What was reported:** "the taskbar pin does not survive. the icon disappears
during install and reappears when launched at the right end of the icon list
rather than where i put it, and it is no longer pinned."

**What the pin is.** Explorer's pinned taskbar items live in
`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Taskband\Favorites`,
a blob that lists each item by the AppUserModelId of the app behind it, and in
a copy of the shortcut under `%APPDATA%\Microsoft\Internet Explorer\Quick
Launch\User Pinned\TaskBar`. Read on this machine, the blob lists
`Better Beeper (2).lnk` with the id `com.yates.better-beeper` at position 3 -
between Google Voice and deck.blue - and the pinned folder holds both
`Better Beeper.lnk` and `Better Beeper (2).lnk`, both 2626 bytes, both pointing
at the app's exe, both carrying the modification time of the install.

**Why the update took it.** The uninstaller is what deletes the Start Menu
shortcut and unregisters the app's identity -
`WinShell::UninstAppUserModelId "${APP_ID}"` in electron-builder's own
`uninstaller.nsh`. The pin is the shell's entry for that identity, so an update
that uninstalls the old version gives the shell a reason to drop it.

Why the old version was uninstalled is a flag. `nsisScriptGenerator.flags()`
generates `${isUpdated}` from `StdUtils.TestParameter $R9 "updated"`, which
tests the **command line** of the installer. The helper was launching the
installer with only `/S`, so `${isUpdated}` was false, so
`setIsTryToKeepShortcuts` forced `isTryToKeepShortcuts` to false, so
`$keepShortcuts` was false, so the uninstaller ran without `--keep-shortcuts`
and the shortcut was rewritten and the identity unregistered. The modification
time of the Start Menu shortcut says which branch ran: it was the install's.

**What is now.** Two changes, and the second is the one Scott asked for:

1. The installer is launched with `--updated` (`/S --updated`), so
   `${isUpdated}` is true, so the installer keeps the Start Menu shortcut and
   passes `--keep-shortcuts` on to the uninstaller it would otherwise run.
2. The update installs **over the top**. `tools/nsis/installer.nsh` is included
   by `electron-builder.yml`, and its `customUnInstall` macro makes the old
   uninstaller give up before it deletes anything - `SetErrorLevel 0`, then
   `Quit` - so the new files are written over the old ones and nothing happens
   to the shortcut or to the app's identity.

The trade is written down in the script itself: a file the new version no
longer ships is left on disk rather than removed. A few hundred kilobytes, in
exchange for leaving the user's own settings alone.

**The fix that made it worse is gone.** The 2026-11-11 work added
`TaskbarPin.Restore`, which copied the shortcut over Explorer's pinned copy and
told the shell about the change. That is not how the pin works: the pinned file
is Explorer's own state, and overwriting it made Explorer register the item as
a **new** item - `Better Beeper (2).lnk` - and put it at the end of the list.
The pin was not restored; it was replaced by a copy of itself in the wrong
place. The helper now only **inspects** the pin and writes down what it finds
(`pin present` / `pin missing`), and never writes to the pinned folder.

**What proves it.** `check:handoff` is 20 cases now: the installer is told it
is an update, the builder config includes the script, the script makes the old
uninstaller give up, electron-builder's own template calls the hook *before* it
unregisters the identity, the update writes nothing into the pinned folder
(whether the install works or fails), a pinned shortcut is left exactly as it
was, and the helper's window is up, opaque, on the interactive desktop and not
cloaked.

`tools/update-handoff-redproof.js` breaks each of those rules in turn: 12/12
mutations caught, no holes, with the baseline asserted.

**And the hook itself was tested by running it.** Every other check can only
see that the hook is *there* - the script is in the config, the macro is in
the file, the template calls it before the damage. None of that says the hook
works, and "works" here has a precise meaning: the old uninstaller must stop
before it deletes anything, and it must stop with the exit code the installer
is looking for, because the installer carries on only if the uninstaller
succeeded.

So `npm run check:nsis` builds two tiny NSIS programs with `makensis` (the
one electron-builder downloaded) and runs them in a sandbox in the temp
directory. The **control** is the same program with the hook left out, and it
has to delete the file it is told to delete and write its marker - if it did
not, the check would be proving nothing. The **treatment** is the same program
with the repository's own `tools/nsis/installer.nsh` included, and the file
has to survive, the marker must not appear, and the exit code must be zero.
11/11.

Two things about that check are worth knowing, because both of them were
mistakes in the first version of it:

- **NSIS does not find a file named with forward slashes.** The include line
  has to use Windows paths, which is what electron-builder writes anyway.
- **An uninstaller run the ordinary way copies itself to the temp directory
  and returns at once**, and the copy does the work afterwards - so a check
  that looks at the files straight afterwards is looking before the uninstall
  has happened and sees a program that did nothing. The real installer runs
  the old uninstaller with `_?=`, which runs it in place, and so does this
  check.

`tools/nsis-install-over-top-redproof.js` breaks the hook in the repository -
the `Quit` taken out, and the success code turned into a failure - and
requires the check to notice: 2/2, no holes, with the baseline asserted.

**One thing is still true on this machine.** The persisted `Favorites` blob
still has the pin at position 3, but the live taskbar is out of sync with it -
the shell has not re-read the blob, and it is the shell's live state that is
wrong, not the blob. The pin comes back at the right place when Explorer does.
The one-time repair is restarting Explorer - which closes the Explorer windows
and restarts the taskbar - or signing out and back in. That has not been done:
it is the user's desktop, and the windows he has open are his.

### The helper's window was up, and behind everything else

**What was reported:** "the helper window does not show still."

**What the trace said.** The trace from the update that Scott ran said:

    tick visible=True handle=yes bounds=1042,556,476,279 desktop=Default

The window was built, it was visible, it was on the `Default` desktop, and it
was up for the whole install: `installer-started` comes after that tick and
`work-done code=0` comes two and a half minutes later. So the window was never
missing. It was **behind everything else**. It was activated when it was first
shown, which is while Better Beeper is still the foreground app and in the
middle of quitting, and a window that is not the foreground one is often not
allowed to come to the front at all.

**What is now.** Once the app's process is gone - `parent-gone` - the helper
puts the window in front: `TopMost = true`, then `Show`, `Activate`,
`SetForegroundWindow`. It is taken off `TopMost` again when it finishes, so the
app that comes back afterwards is not left behind it.

**This reverses a rule from 2026-10-13, and the reason it was made no longer
holds.** TopMost was removed then because the window was not draggable - there
was no caption bar and nothing to grab - so it sat in the middle of the screen
above everything with no way to move it, which is a window someone cannot get
out of the way of. The window can be dragged now (grab any part of it), so that
objection is answered. The other half of that reason - that the window should
not demand the front of the desktop for its whole life - is kept: the window is
**not** in front from the moment it opens, only once the app has gone, and it
gives the front up when the work is done. `check:update` asserts exactly that
now, in place of the old "the window does not force itself to the top": it must
be put in front at some point, that point must not be before it has a reason
to, and it must let go of the front again.

Windows may still refuse `SetForegroundWindow`; it is a privilege, and the
helper is not the foreground process. So the trace records `foreground=` as
well as `topmost=`, and the check requires the window to be **above** the
others (`topmost=yes`), which is what the user sees. `foreground=yes` is the
best-effort part, and the check does not fail on it: a check that fails on
something Windows is entitled to refuse is a check that fails for no reason.

**The check could not have caught this before.** The off-screen test mode used
to make the window transparent, and a transparent window is `Visible = true` -
so the old check could not tell an invisible window from a visible one, and
"the window is not transparent" was not a question it could ask. The off-screen
mode now only *moves* the window off the screen and leaves it opaque, and the
check can ask the questions that matter: is it transparent, is it cloaked (on
a virtual desktop nobody is looking at), is it on the interactive window
station (`WinSta0`), and is it above the others.

## Work done 2026-11-13

### Typing in a chat marks it read

**What was asked:** "if there is a new message in a chat, mark it as read also
after i type anything in it's chat window."

**What the app did.** There were three ways to mark a chat read: opening it,
the window coming back to the front, and a message arriving while the window
had focus. Typing was not one of them.

That leaves two gaps, and they are different gaps.

The first is the one the ask is about. A message that arrives while the window
is in the background is rendered with no focus and deliberately not marked -
correct, because nobody was looking at it then. When you come back, the focus
handler asks again. But if you do not come back, because you were already
looking at the chat in another window, or because the focus never moved,
nothing asks again and the message stays unread in a chat you are sitting in.
Typing is the signal that says "I am here and I have this open" and the app
was not listening for it.

The second is a race, and it is the one that puts a badge on a chat that is
open and on screen. The order on a live message is:

    applyMessageEvent(frame)      -> renders, and marks read if the window has focus
    refreshChatSummary(frame)     -> reads the chat back from the server

The mark-read call and the read-back are both on their way at the same moment,
and the read-back can carry the count as it was *before* the mark reached the
server. The mark then clears the local count, the read-back writes the old
count back over it, and the badge is on a chat the user is looking at. Nothing
asks again after that: the next render only happens when another message
arrives.

**What it is now.** Typing in the composer of the open chat marks that chat
read - the whole chat, with no message id, which is what
`POST /v1/chats/{chatID}/read` means when the id is left off, and the same
call the mark-all-read button makes. The rule is three conditions, in
`src/renderer/js/type-read.js`:

- there is an open chat,
- that chat still has unread messages,
- the "mark a chat as read when I open it" setting is on.

The setting gates it, like it gates opening and returning. Someone who turned
that off does not want the app deciding what they have read, and typing is
still the app deciding. It is on by default.

**One call per chat at a time.** Typing asks the same question on every
keystroke, and the answer is still "yes" until the call that is already on
its way comes back - so without a guard, every letter of every word would put
another call on the bridge. `marksInFlight` holds the chats whose mark-read
call is in flight, and a second request for one of them is dropped. The
in-flight call clears the count when it lands, which is the same answer the
dropped one would have given.

**What proves it.** `npm run check:typeread` (18/18) drives the real
`thread.js` in a browser harness with only the IPC boundary replaced, and
types into the real composer: a chat with a message waiting is marked read by
typing, the count comes back to zero, a burst of six keystrokes is **one**
call and not six, an already-read chat is not marked again, a chat with
nothing unread is not marked, the setting is respected, and a chat with no
chat open is not marked. It also reproduces the race above - the count written
back by the server's answer - and shows that typing clears it.

The rule itself is driven directly as well, including the case that flips each
condition in turn, because a condition written into the signature and never
consulted is a condition that does nothing.

`tools/typeread-redproof.js` breaks each rule in turn - the call site removed,
the rule ignoring the open chat, the rule ignoring the unread count, the rule
ignoring the setting, and the in-flight guard taken out - and requires the
check to catch it: 5/5, no holes, with the baseline asserted.

### The update's window shows where the user is looking

**What was asked:** "the helper window does not show still".

**What it did.** The window was up for the whole install. The trace from the
update that was measured says so: `tick visible=True handle=yes
bounds=1042,556,476,279`, and it was up before the install, during it and
after it. It was not missing. It was somewhere nobody was looking.

The reason is `FormStartPosition.CenterScreen`. Windows centres a window on
the **display the mouse is on**, and the mouse was on the far-left display -
one of seven. The window came up at (1042, 556) on the display at
(-1920, -18), which is the middle of that display's work area: the far left of
a seven-display desk, while the user was at the primary.

So the window was never placed at all. Windows placed it, and Windows places
it on the display the mouse happens to be on.

**What it is now.** The window is placed explicitly:

- the app tells the helper where to put it - the centre of the app's own
  window, converted from DIP to physical pixels with `screen.dipToScreenPoint`,
  because Electron's bounds are DIP and the helper's screen API is physical
  pixels;
- the helper falls back to the centre of the primary display's work area when
  the app says nothing;
- the bounds are clamped inside that work area, so the window is never under
  the taskbar and never hanging over an edge.

The placement happens in `OnHandleCreated`, while the window is still hidden.
A window that is moved after it appears is a window that appears in the
corner of the screen first, and a flash in the corner of the user's screen is
the one thing this rule exists to stop.

`FormStartPosition.CenterScreen` is gone, and `npm run check:handoff` reads
the source to make sure it does not come back - with the comments stripped
first, because the comment that explains why it is not used contains the
words the check looks for.

### Nothing a check does can put a window on the desktop

**What was asked:** "you keep popping up windows that are taking focus. NEVER
pop up a window. EVER!!"

**What it did.** Three different things, all of them windows.

**The helper's own window.** `check:handoff` runs the real helper with the
real window, because "the window shows" had been an assumption with nothing
behind it. The off-screen mode moved it to (-32000, -32000) and asked Windows
not to activate it - and the placement rule above put it at the centre of the
primary display first, because the placement happened while the window was
hidden and the off-screen move happened after it had been shown.

**The focus.** Even off the screen, `Activate()` and `SetForegroundWindow()`
took the foreground. The trace said `brought-to-front foreground=yes`. A
window the user cannot see that has their keyboard is worse than a popup: it
is a popup that also takes over the keyboard.

**The consoles.** A console program started from a process with no console of
its own is given one. `npm`, `git`, `csc` and `powershell` are all console
programs, and twenty-five tool files were starting them without
`windowsHide: true`.

**What it is now: a guarantee, not a promise.**

The helper's window is now run on **a desktop of its own**.
`tools/private-desktop-runner.cs` creates a desktop (`CreateDesktop`) on the
interactive window station (`WinSta0`) and starts the helper on it with
`STARTUPINFO.lpDesktop` pointing there. Windows does not draw a window on a
desktop nobody is looking at, and it cannot make it the foreground window
either - so however the helper places it, activates it or sets `TopMost` on
it, there is nowhere for the user to see it and nothing for it to take.

That is the difference between a promise ("the code will not show a window")
and a guarantee (there is nowhere for a window to be shown). The window is
still created, shown, sized and placed for real, so the trace is a record of
a real window and not a rehearsal: `visible=True handle=yes`, `cloaked=no`,
`transparent=no`, `station=WinSta0`, and `desktop=bb-check-<pid>` rather than
`Default`.

The window station is deliberately still the interactive one. A different
*station* would be a different session, and the window could not be measured
there at all; a different *desktop* on the same station is the real session's
desktop, just not the one being looked at. So the window is a genuine window,
on the genuine station, with a genuine size and position.

The off-screen mode stays as a second, independent reason for the user not to
see anything, and the focus is never taken: the off-screen mode returns
before `TopMost`, `Activate()` or `SetForegroundWindow()`, and the window is
shown with `ShowWithoutActivation`.

**Every console is hidden.** `windowsHide: true` is now on every process any
tool starts - twenty-five files, and every one of `npm`, `git`, `csc`,
`powershell`, the installer and the uninstaller among them.

**What proves it.** Two new suites:

- `npm run check:nowindow` (7/7) checks that no tool starts a process
  without hiding its console, that no check suite shows a browser window,
  that the tools which do show one are not in the sweep, that the helper is
  never run on the user's desktop, that the private desktop is a desktop of
  its own, and that the helper cannot take the focus while it is off the
  screen.
- `tools/window-safety-redproof.js` breaks each of those rules in turn and
  requires the check to catch it: 6/6, no holes, with the baseline asserted.

And it was measured, not argued about. A watcher recorded every visible
top-level window and every change of the foreground window for the whole run
of `check:handoff` - the suite that builds the helper, starts it three times
with its real window, and reads back what it did. The result was 48 visible
windows, every one of them the user's own, and one foreground window, the
user's own browser. Nothing else appeared, and the focus never changed.

### The proof of the rule was the popup it was about

**What was asked:** "you are popping up windows AGAIN! stop it!!!!!"

**What happened.** The red proof for the rule above breaks the rule to prove
the check catches it - and one of the rules it breaks is the private desktop.
Pointing the runner at `Default` is exactly how you prove the check notices,
and pointing the runner at `Default` is exactly how a window appears on the
user's desktop.

Four helper processes were left running, on the desktop, taking the focus.
The red proof had *worked*: the check went red, which is what it was asked to
do. The proof of the rule was the popup.

There was a second failure behind it. The runner was killed by the check's
timeout while its child - the helper - was still running, and killing the
runner does not kill the helper. So a run that timed out left a window
behind, on the desktop, for as long as the helper lived.

**What it is now.** Three changes, all of them about the order of things.

1. **The containment is established before the contained thing is used.** The
   check reads the runner's source and works out whether it really gives the
   helper a desktop of its own - one `CreateProcess` call, one `lpDesktop`,
   built from the name it was given, and not "Default". If it does not, the
   helper is **not started at all**. A broken rule is then a broken rule in
   the source, which is harmless, and the check goes red saying so.

2. **The runner refuses the user's desktop.** It returns without starting
   anything if it is asked for a desktop called "Default", whatever else it
   has been asked to do.

3. **Nothing is left running.** The runner writes the child's process id to a
   file the check names, waits with a timeout instead of forever, and stops
   the child if it overstays. The check reads the pid back and fails if the
   helper was still alive - "a check never leaves a window behind".

**The general lesson, because it will happen again.** A red proof that
proves a *containment* rule works by breaking the containment is only safe if
the break cannot reach the user. Breaking it in the source is safe; breaking
it at run time is the thing the rule exists to prevent. So: the check
establishes the containment first, and the proof breaks it in the source
only.

## Verification status
`npm run check:all` sweeps **59 suites**, and all 59 of them pass on a release
commit. On the tree carrying the work, before the release is cut, 58 of them
pass: the one that does not is `check:released`, which is red until the release
is cut, because `main` is ahead of the newest tag. It was 58 suites on the
tree carrying the 2026-11-12 work, 57 of them passing; it was 57 suites on the
tree carrying the 2026-11-11 work, 54 of them passing; it was 54 suites on the
tree carrying the 2026-11-09 work, 53 of them passing; 53 suites on the tree
carrying the 2026-11-08 work, 52 of them passing; 47/47 on the tree
carrying the 2026-11-02 work, 2026-11-02. It was
45/45 on the v1.26.0 release commit, 44/44 on the v1.25.0 release commit and
on the v1.24.0 release commit, 2026-10-27; 43/43 on the v1.23.0 release
commit, 2026-10-21; 42 suites before `check:contactrefresh` was added, 41
before `check:participants`, 40 before `check:refreshchats`, 39 before
`check:entity`, and 35/37 on 2026-10-14.

`check:released` is the one that moves with the git state. It fails whenever
`main` is ahead of the newest tag, because a push with no release behind it is
exactly what it exists to catch. So it is green on a release commit and red on
the commit after one, until the next release catches it up. That is the rule
working, not a defect, and it is why a docs-only push still gets a release.

| Check | Result |
| --- | --- |
| `check:update` | 63/63, after `check:update` gained a built helper to read the PE header of |
| `check:updatefailure` | 23/23 checks passed, running the real helper against real executables, with no window (new) |
| `check:handoff` | 29/29 checks passed, running the real helper with the real window on a desktop of its own, so nothing can be seen |
| `check:nowindow` | 7/7 checks passed, that no tool may put a window or a console on the desktop (new) |
| `check:proxy` | 5/5 checks passed, with a control run that has to show the proxy lookup |
| `check:windowbounds` | 28/28 checks passed, against made-up displays and against the real one (new) |
| `check:typeread` | 18/18 checks passed, typing into the real composer in a browser harness (new) |
| `tools/typeread-redproof.js` | 5/5 mutations caught, no holes, with an asserted baseline (new) |
| `check:composeredit` | 58/58 checks passed |
| `check:composereditrules` | 45/45 checks passed, with no Electron and no window |
| `check:bridgeplaceholder` | 12/12 checks passed, with no Electron and no window (new) |
| `check:threadopen` | 29/29 checks passed |
| `check:readreceipts` | 14/14 checks passed, with no Electron and no window (new) |
| `check:released` | green on a release commit, red while `main` is ahead of the last tag |
| `tools/update-redproof.js` | 25/25 mutations caught, no holes |
| `tools/update-failure-redproof.js` | 15/15 mutations caught, no holes, with an asserted baseline (new) |
| `tools/update-handoff-redproof.js` | 15/15 mutations caught, no holes, with an asserted baseline (new) |
| `tools/window-safety-redproof.js` | 7/7 mutations caught, no holes, with an asserted baseline (new) |
| `check:nsis` | 11/11 checks passed, with the hook built and run by NSIS itself, control included (new) |
| `tools/nsis-install-over-top-redproof.js` | 2/2 mutations caught, no holes, with an asserted baseline (new) |
| `tools/proxy-redproof.js` | 5/5 mutations caught, no holes |
| `tools/window-bounds-redproof.js` | 9/9 mutations caught, no holes, with an asserted baseline (new) |
| `tools/search-nav-redproof.js` | 12/12 mutations caught, no holes |
| `tools/syntax-redproof.js` | 3/3 mutations caught, no holes |
| `tools/avatar-redproof.js` | 4/4 mutations caught, no holes |
| `tools/history-render-redproof.js` | 2/2 mutations caught, no holes |
| `tools/composer-edit-redproof.js` | 43/43 mutations caught, no holes |
| `tools/thread-open-redproof.js` | 13/13 mutations caught, no holes |
| `check:appicon` | 20/20 checks passed, with the artwork redrawn and compared byte for byte (new) |
| `tools/app-icon-redproof.js` | 6/6 mutations caught, no holes (new) |

Individually measured: `check:entity` 0 failing across 31 cases,
`check:rich` 27/27, `check:preview` 0 failing across 18 cases,
`check:markallread` 0 failing across 18 cases,
`check:refreshchats` 0 failing across 24 cases,
`check:focusread` 27/27,
`check:participants` 0 failing across 36 cases (new),
`check:contactrefresh` 71/71 and `tools/contact-refresh-redproof.js` 19/19
mutations caught, 2/2 neutral rewrites tolerated (new),
`check:paste` 52/52 (rewritten, new),
`check:threadopen` 29/29 and `tools/thread-open-redproof.js` 13/13 mutations
caught, 1/1 neutral rewrite tolerated,
`check:notificationclick` 20/20 and
`tools/notification-click-redproof.js` 12/12 mutations caught, 1/1 neutral
rewrite tolerated (new),
`check:threadsearch` 53/53 and `tools/thread-search-redproof.js` 11/11
mutations caught, 1/1 neutral rewrite tolerated (new),
`check:sidebar` 87/87 and `tools/avatar-redproof.js` 4/4 mutations caught, 1/1
neutral rewrite tolerated (new),
`check:historyrender` 28/28 and `tools/history-render-redproof.js` 2/2
mutations caught, 1/1 neutral rewrite tolerated (new),
`check:composereditrules` 45/45 and `check:composeredit` 58/58 and
`tools/composer-edit-redproof.js` 43/43
mutations caught, 1/1 neutral rewrite tolerated,
`check:unread` 32/32, `check:layout` 13/13,
`check:api` 136/136, `check:composer` 17/17, `check:actions` 21/21,
`check:about` 6/6, `check:installer` passing, `check:syntax` OK on every JS
file and harness, `check:ascii` OK.

`check:paste` is worth a word, because it is the shape the other checks
should take. It drives the **real** event path - a `dragover`, a `drop`, a
`paste` - against the **real** markup, and stubs only the API boundary. Two
cases in it are controls: one shows the drag signal is the types list and not
the files, and one shows that re-opening the same chat keeps the attachment
while opening a different chat clears it. Those two are a pair on purpose: if
the re-open always cleared, the first would fail, and if it never cleared, the
second would.

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

Both of the two that were here are closed, and what was found is worth
keeping:

1. **The TLS warning was Chromium looking for a proxy, not a bad certificate
   on the GitHub call.** Closed in v1.28.3 - see "The TLS warning was Chromium
   looking for a proxy" above. The cause is fixed in the app, and the DNS side
   of it is closed too: the `wpad` record points at `0.0.0.0`, so the lookup
   fails at once rather than being answered with an untrusted certificate.
   Nothing is outstanding here, in the app or on the DNS.
2. **The empty command windows were the old status window.** Closed in
   v1.28.3 - see "The empty command windows were a batch file's status window"
   above. The update path cannot have a console window now, and the checks say
   so.
3. **Legacy `update-apply.cmd` and `update-status.cmd` are still on disk** for
   anyone who last ran v1.18.0 to v1.18.5. Nothing runs them - the app has not
   looked for them since v1.18.6 - so they are inert. The one-time startup
   cleanup that would delete them was proposed and not taken; it is still an
   option, and it is a few lines in `main.js`.
4. **This file is now tracked**, which cuts both ways. Its git state section goes
   stale silently, which is exactly how two earlier versions of it misled the
   reader. Refresh it as part of finishing a task rather than when someone
   notices it is wrong. The git state section no longer names a version, so the
   part of it that used to go stale on every release now cannot. The rest of
   the file still has to be refreshed by hand.
5. **The voice-message bytes are gone upstream.** Four Google Voice messages
   on this account arrived with "Failed to download attachment" in front of
   them because Google answers Beeper's own bridge with HTTP 400 when it asks
   for those files. The app now shows that honestly - the sender's words and a
   notice about the missing attachment - but **the files cannot be recovered
   from this machine or from the app**. Nothing in this repository can change
   that; it is Google's answer to Beeper's bridge.
6. **Google Voice attachment ids are `file:///C:/...`**, and the bridge's
   `POST /v1/assets/download` rejects them with HTTP 400 "URL must start with
   mxc:// or localmxc://". Twenty-four of the twenty-five attachments probed
   were fine, so it is a narrow fault in Beeper's Google Voice bridge. Not
   fixable here; worth a report to Beeper if it is still true.
7. **The update handoff can leave the app unable to start.** Closed in
   v1.30.2 - see "The failure path is fixed, and the helper can be stopped"
   above. The helper now puts the installer in a job object and stops the
   whole tree, refuses to install at all while the app's files are held,
   starts the app again whatever the install did, and writes the reason
   before it does. The app reads that reason and shows it.
   **One thing it cannot do:** if the installer is already in kernel
   termination, as it was on 2026-11-11, no process of ours can stop it, and
   the lock stays until Windows is restarted. The helper now says exactly
   that - "Windows is still holding Better Beeper's files. Restart Windows to
   use Better Beeper again." - rather than leaving the user with a dead app
   and no explanation. The old version of the app is still on disk and is
   still runnable once the lock is gone.
8. **The window came back slightly off from where it was closed.** Closed in
   v1.30.5 - see "The window came back slightly off, and the offset was the
   overhang" above. The saved bounds were clamped into the work area of the
   display that owned them, so a window closed over an edge came back by
   exactly the overhang, and a window closed over the taskbar came back above
   it. The window now opens exactly where it was closed, at exactly the size
   it was closed at, and the clamp survives only for the case it was written
   for: a display that has been unplugged. The last move before the window
   closed was also being thrown away, by a debounce that nothing ever
   flushed; the window now saves its bounds when it closes.
9. **The live taskbar on this machine is out of sync with Explorer's own
   record of the pin.** The persisted `Favorites` blob has
   `Better Beeper (2).lnk` at position 3, between Google Voice and deck.blue,
   but the running shell has the item at the end of the list and no longer
   pinned. The pin comes back where it was when Explorer re-reads the blob:
   restart Explorer - which closes the Explorer windows and restarts the
   taskbar - or sign out and back in. **This has not been done.** It is the
   user's desktop and the windows he has open are his; and it is a one-time
   repair for the damage the 1.30.4 "put the pin back" code did, which is
   gone now that the update installs over the top.

Not outstanding any more, but still true and easy to trip over: the updater
asks GitHub for a **Release**, not for a commit. It calls `releases/latest` and
compares that tag against `app.getVersion()`, which is what is installed. So it
says "up to date" while there are commits on main that were never released: a
commit is not a release and there is nothing for it to offer. `check:released`
is what catches that gap.

## Environment gotchas that cost time

- **Validate the JavaScript before running it.** `npm run check:syntax` parses
  every file in the tree and every harness in it. A check that does not parse
  does not fail - it throws, and Electron answers a broken check with a
  "A JavaScript error occurred in the main process" dialog, which reads as
  the app crashing rather than as a check being broken.
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
- **`TokenStore.read()` DELETES the credentials it cannot decrypt.** The file
  is written by the app under `<userData>\Local State`'s key, so a probe that
  reads it with the **wrong** `userData` cannot decrypt it - and `read()`
  treats that as "this will never become decryptable", logs
  `stored credentials are unreadable, clearing:` and calls `clear()`, which
  removes `auth.json`. The app is then signed out on its next start. This
  happened on 2026-10-22 while probing the upload endpoint; the file was put
  back by running the app's own OAuth flow headlessly (register a client, POST
  `/oauth/authorize/callback`, exchange the code, write the file with
  `TokenStore.write()`), which needs no window and no click, because the local
  Beeper server approves on its own when the desktop app is already signed in.
  **Point `userData` at the real profile before reading a token, or copy the
  whole profile, `Local State` included.**
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
- **An app that will not launch may be locked rather than broken.** No window,
  no error and no exit code is what a locked executable looks like: Windows
  blocks the launch inside the loader, so the start call never returns and any
  probe that calls `Start-Process` on it hangs instead of failing. Test the
  lock first - open the exe with read access and no sharing, and a failure
  saying "used by another process" is the answer. The Restart Manager API
  (`RmStartSession` / `RmRegisterResources` / `RmGetList`) then names the
  holder. `NtTerminateProcess` returning `0xC000010A` means the holder is
  already in kernel termination: it cannot be killed, and only a reboot
  releases the lock.
