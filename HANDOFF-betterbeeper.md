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
2026-11-09" is committed and released as **v1.28.3**. It is a patch bump,
because `tools/release.js` derives the level from the commit subjects since
the last tag and both of them are `fix:`.

The last few commits, with the `Release 1.28.3` commit sitting on top of them:

```
8017e89  fix: the update path cannot put a console on the desktop
de191d8  fix: Chromium does not go looking for a proxy
73284bd  Release 1.28.2
a17a03c  fix: the composer shows the whole message being edited
f4cb7c5  Release 1.28.1
```

The newest tag is **v1.28.3**, on the `Release 1.28.3` commit, so `main` is
not left ahead of its own tag. `package.json` says 1.28.3.

v1.28.3 carried the two things this file had left outstanding: the TLS
warning, which was Chromium's proxy auto-discovery rather than anything to do
with GitHub, and the checks that say the update path cannot put a console
window on the desktop. v1.28.2 carried the composer growing to fit the
message being edited. v1.28.0 carried the composer edit itself. v1.27.0
carried the arrows in the sidebar's search. v1.26.0 carried the
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

The log said `handshake failed ... net_error -202`, which is
`ERR_CERT_ALT_NAME_INVALID`: a certificate that does not cover the name it was
asked for. The handoff had guessed "probably a different endpoint or an
intercepting proxy". It was neither, and it was never the GitHub call -
api.github.com serves a certificate for itself, was reachable with a plain
`https.get` from this machine, and was never in the log.

It was **Chromium's proxy auto-discovery**. Chromium looks for a WPAD file by
fetching `http://wpad/wpad.dat`. On this machine `wpad` resolves to
`wpad.yatesframe.com`, which is Scott's own YunoHost box. The fetch is
answered with a redirect to `https://wpad/yunohost/admin`, and the certificate
that answers does not cover the name `wpad`, so the handshake fails with
-202. The net log of an Electron process started here says so in as many
words: the name `wpad` is in it, and so are the -202 errors.

The fix is `src/main/proxy-config.js`: `--proxy-server=direct://`, applied
before `app.whenReady()`. A switch set after the network stack has started is
accepted by Electron and ignored by Chromium, so the timing is part of the
rule. The app has no use for a proxy - the renderer makes no network requests
at all, and the only outbound call in the app is the GitHub release feed.

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

## Verification status

`npm run check:all` sweeps **50 suites** on the tree carrying the 2026-11-09
work, and 49 of them pass. The one that does not is `check:released`, which
is red until the release is cut, because `main` is ahead of the newest tag.
It was 49/49 on the tree carrying the 2026-11-08 work, 47/47 on the tree
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
| `check:update` | 62/62, after `check:update` gained a built helper to read the PE header of |
| `check:proxy` | 5/5 checks passed, with a control run that has to show the proxy lookup |
| `check:composeredit` | 48/48 checks passed |
| `check:composereditrules` | 26/26 checks passed, with no Electron and no window |
| `check:released` | green on a release commit, red while `main` is ahead of the last tag |
| `tools/update-redproof.js` | 21/21 mutations caught, no holes |
| `tools/proxy-redproof.js` | 5/5 mutations caught, no holes |
| `tools/search-nav-redproof.js` | 12/12 mutations caught, no holes |
| `tools/syntax-redproof.js` | 3/3 mutations caught, no holes |
| `tools/avatar-redproof.js` | 4/4 mutations caught, no holes |
| `tools/history-render-redproof.js` | 2/2 mutations caught, no holes |
| `tools/composer-edit-redproof.js` | 29/29 mutations caught, no holes |
| `tools/thread-open-redproof.js` | 7/7 mutations caught, no holes |

Individually measured: `check:entity` 0 failing across 31 cases,
`check:rich` 27/27, `check:preview` 0 failing across 18 cases,
`check:markallread` 0 failing across 18 cases,
`check:refreshchats` 0 failing across 24 cases,
`check:focusread` 27/27,
`check:participants` 0 failing across 36 cases (new),
`check:contactrefresh` 71/71 and `tools/contact-refresh-redproof.js` 19/19
mutations caught, 2/2 neutral rewrites tolerated (new),
`check:paste` 52/52 (rewritten, new),
`check:threadopen` 18/18 and `tools/thread-open-redproof.js` 7/7 mutations
caught, 1/1 neutral rewrite tolerated (new),
`check:notificationclick` 20/20 and
`tools/notification-click-redproof.js` 12/12 mutations caught, 1/1 neutral
rewrite tolerated (new),
`check:threadsearch` 53/53 and `tools/thread-search-redproof.js` 11/11
mutations caught, 1/1 neutral rewrite tolerated (new),
`check:sidebar` 87/87 and `tools/avatar-redproof.js` 4/4 mutations caught, 1/1
neutral rewrite tolerated (new),
`check:historyrender` 28/28 and `tools/history-render-redproof.js` 2/2
mutations caught, 1/1 neutral rewrite tolerated (new),
`check:composereditrules` 26/26 and `check:composeredit` 48/48 and
`tools/composer-edit-redproof.js` 29/29
mutations caught, 1/1 neutral rewrite tolerated (new),
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
   looking for a proxy" above. The cause is fixed in the app. The *root* cause
   is still on the server: the DNS record `wpad.yatesframe.com`, and the
   `wpad` alias in front of it, point at the YunoHost box, where no vhost
   serves that name - so the host answers with a redirect to the admin login
   over HTTPS with a certificate that covers `yatesframe.com` and not `wpad`.
   The app no longer goes looking, so the app is quiet about it. **A browser
   that auto-discovers a proxy will still find it.** That is a DNS record to
   delete, on the DNS, and it is not in this repository.
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
   notices it is wrong. It was last refreshed with the v1.28.3 work.

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