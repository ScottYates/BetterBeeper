# Edit a previous message from the composer

Date: 2026-11-08
Status: approved, ready for an implementation plan

## Problem

Editing a message you already sent takes four clicks and a mental shift. The
context menu on the bubble has an `Edit` item, and choosing it replaces the
bubble with a small two-row textarea inside the thread. You edit there, and the
change is saved when you press Enter inside a box that is narrower than the
message it is editing.

There is a much more direct gesture, and it is the one people already expect
from a chat client: put the cursor in the composer and press the up arrow. The
message you last sent comes back to be edited, with the composer already
holding its text.

Better Beeper does not do this. The composer has exactly one key handler (Enter
sends) and no handler at all for the arrow keys.

## Goals

- Pressing the up arrow in an empty composer puts the app into edit mode for
  your most recent message that can still be edited.
- Pressing it again steps further back through your own editable messages.
- The edit happens in the composer, with the text already loaded, in the same
  way the Signal and WhatsApp desktop clients do it.
- The app never offers an edit the network will refuse.
- One edit mode, not two. The bubble editor goes away.

## Non-goals

- No change to how messages are sent, stored, deleted or hidden.
- No change to the reply preview, other than that a reply and an edit cannot
  both be pending.
- No new IPC channel. `messages:edit` already exists and already works.
- No editing of other people's messages. No editing of messages with
  attachments. No editing of deleted messages.
- No edit history inside a message, and no undo of an edit.

## What already exists

Most of the pieces are already in the app, which is why this is a feature and
not a project.

| Piece | Where | Note |
| --- | --- | --- |
| The composer | `src/renderer/index.html` | One `<textarea id="composer" rows="1">`, fixed height, Shift+Enter inserts a newline. |
| The composer key handler | `src/renderer/js/thread.js` | Enter sends, via `sendCurrent`. |
| The bubble editor | `src/renderer/js/thread.js` | `editingNode(message)` draws a textarea in the bubble. Enter saves, Escape cancels. |
| The edit call | `src/renderer/js/api.js` | `api.messages.edit(chatID, messageID, text)`, already exposed over `messages:edit`. |
| The reply preview row | `src/renderer/index.html` | `#reply-preview`, a row above the composer with a cancel button. The pattern the edit banner follows. |
| The chat record | `src/renderer/js/state.js` | `upsertChat` stores the whole chat object, so `capabilities` is already in the renderer's hands. |
| The message list | `src/renderer/js/state.js` | `state.messages` holds the chat's messages, oldest first, with their full payloads. |

## Measured behaviour of Beeper's editing

Measured against the live Beeper Desktop API on 2026-11-08 with a read-only
probe. The design depends on these numbers, so they are recorded here rather
than assumed.

`capabilities` is an object on the chat record. Each key is a capability name
and each value is a support level: `-2` rejected, `-1` dropped, `0`
unsupported, `1` partial, `2` full.

| Network | Chats | `edit` | `editMaxCount` | `editMaxAge` |
| --- | --- | --- | --- | --- |
| Signal | 3 | 2 | 10 | 86400 s (24 h) |
| Signal Note to Self | 1 | 2 | 10 | absent, so no limit |
| Facebook/Messenger | 3 | 2 | 5 | 900 s (15 min) |
| Google Voice | 91 | absent | absent | absent |
| Beeper (Matrix) | 2 | no `capabilities` object at all | | |

Three things follow from that table, and they are the reason the rules below
are shaped the way they are.

**A missing `capabilities` object is not the same as a missing `edit` key.**
Google Voice has a `capabilities` object (`attachments`, `maxTextLength`,
`deleteChat`) and no `edit` key: the bridge is telling us it cannot edit. A
Matrix chat has no `capabilities` object at all: the bridge is not telling us
anything. Those two states need different answers, so the rule reads the
object and the key separately.

**The edit window is per chat, and it is short on some of them.** Messenger
allows an edit for fifteen minutes after the message was sent. An edit offered
past that window is an edit the server will refuse, so the window is checked
before the arrow offers anything.

**The edit count cannot be checked.** Beeper's message payload carries no
per-message count of how many times a message has been edited, so the only
number the app could produce is one that counts the edits made on this device
and ignores the ones made on a phone. The app does not enforce `editMaxCount`
and lets the server's refusal speak for itself.

Beeper's own specification is also explicit that a message with an attachment
cannot be edited: *"Edit the text content of an existing message. Messages
with attachments cannot be edited."*

## What counts as editable

A message is a candidate for the up arrow when all of the following hold.

| Rule | Why |
| --- | --- |
| The chat allows editing. `capabilities.edit` is at least `1`. | A chat with a `capabilities` object and no `edit` key cannot edit. A chat with no `capabilities` object at all is treated as unknown and allowed, because that is what the app does today and Matrix supports edits. |
| It is your own message (`isSender`). | You cannot edit somebody else's message. |
| It is not deleted and not hidden. | A deleted message has no text left to edit. |
| It has no attachments. | Beeper forbids editing a message with attachments. |
| It is inside the chat's edit window. `now - timestamp <= editMaxAge` seconds, when the chat sets one. | Signal allows 24 hours, Messenger 15 minutes. A chat with no `editMaxAge` has no limit. |

The age is measured from the message's original timestamp, not from its last
edit, because that is what "message age" means and because the original
timestamp is the only one the app can be sure of.

The list of candidates is built from the messages the renderer holds for the
open chat, oldest first. Only the loaded window is reachable this way; a
message that has been scrolled out of memory is reached by scrolling up, and
then it is in the list.

## The interface

The edit lives in the composer, so it needs a banner above it. The banner
takes the slot the reply preview uses, and the two are never on screen at the
same time.

```
+------------------------------------------------------+
| Editing message: the text you are changing         x |
+------------------------------------------------------+
| [ Write a message...                          ] [^] |
+------------------------------------------------------+
```

| Element | Id | Behaviour |
| --- | --- | --- |
| Banner | `#edit-preview` | Hidden until an edit session starts. |
| Banner text | `#edit-preview-text` | `Editing message: <first 120 characters>`. |
| Cancel | `#btn-cancel-edit` | Ends the session and empties the composer. |
| Composer | `#composer` | Holds the message text. Placeholder reads `Edit your message...`. |
| Send | `#btn-send` | Saves the edit. Its tooltip reads `Save edit (Enter)`. |

The banner is styled like the reply preview row, with an accent colour to say
that what is in the box is a change to something that already exists.

While an edit session is open the attach buttons are hidden. An edit changes
text; there is no such thing as an edited attachment, and leaving the buttons
there invites a send that cannot work.

## The keyboard

The composer owns the arrow keys while it has focus. The thread search has its
own up and down buttons, but they belong to `#thread-search-input`, a different
field, so nothing collides. No other part of the app handles the arrow keys.

```
No edit session, composer empty
  ArrowUp     start editing the newest eligible message
  ArrowDown   nothing

Edit session open, composer holds the loaded text unchanged
  ArrowUp     step to the previous eligible message (older)
  ArrowDown   step to the next eligible message (newer)
  Enter       save the edit
  Escape      cancel the edit

Edit session open, composer text has been changed
  ArrowUp     ordinary caret movement
  ArrowDown   ordinary caret movement
  Enter       save the edit
  Escape      cancel the edit
```

Three rules in there need saying plainly.

**The arrow only starts an edit when the composer is empty.** Typing anything
first means the user is writing a message, and taking over the arrow key would
take the caret out of the text they are writing.

**Stepping only happens while the text is unchanged.** Once the user has
edited the loaded text, the up arrow is the caret again. Stepping would throw
away what they wrote.

**ArrowDown steps back toward the newest message.** Stepping one way only
would be a one-way door: a mis-step would leave no way back but cancelling.

**In a multi-line message the up arrow steps rather than moving the caret**,
until the text has been changed. That is the cost of the gesture, and it is
paid only while the loaded text is untouched. The mouse, Home and End still
place the caret.

**When there is nothing eligible to edit, the arrow does nothing.** No
session opens, no banner appears and no toast is shown: pressing the up arrow
in an empty box that has nothing to offer is not an error.

The keys are ignored when Ctrl, Alt or Meta is held, so a platform shortcut
that uses an arrow is not swallowed.

**Stepping skips everything that is not eligible**, silently. Somebody else's
message, a message with a picture, a message older than the edit window: the
arrow steps over it. The user sees the message that was loaded, and the banner
shows what it is.

## Starting an edit

Starting a session does three things:

1. The message's text is decoded and put in the composer, with the caret at
   the end.
2. The banner appears.
3. A pending reply is dropped, because a message cannot be a reply and an edit
   at the same time. The reply row visibly disappears, which is the signal
   that it is gone, and `state.replyTo` is cleared so the edit that follows
   carries no reply.

A pending **attachment** is a different matter. The upload has already
happened, and dropping it silently would throw away work. So if a file is
staged in the composer, the up arrow refuses and says so. Send the message
first, or remove the file.

## Saving an edit

`api.messages.edit(chatID, messageID, text)` sends the new text. On success:

- The bubble's text is replaced in place and the message is marked edited.
- The edited message is written through to the local store with
  `api.history.upsert`, so the new text survives a restart instead of
  reverting from disk.
- The composer is emptied, the banner is hidden, the session ends.
- A short toast says the message was edited.

## Failure handling

| Situation | Behaviour |
| --- | --- |
| Beeper refuses the edit | The text stays in the composer, the session stays open, and a toast carries the reason. Nothing is lost. |
| The text is empty | Refused before it is sent, with a toast. The API requires at least one character. |
| The message is no longer editable (it was deleted elsewhere, or the window closed) | The server refuses, and the refusal is shown as a toast. |
| The chat is read-only on Beeper | The edit is not offered. A read-only chat cannot be written to at all. |
| The composer has a staged attachment | The up arrow refuses with a toast rather than dropping the upload. |

## One edit mode

The bubble editor goes away. `editingNode(message)` is deleted, and the
context menu's `Edit` item opens the same composer session the up arrow opens.
Two editors in one chat would mean two rules about which message is being
edited, two places to look for the text, and two ways for the keyboard to
disagree with the screen.

The `Edit` item is shown only for a message that is eligible. Offering an edit
the app has already decided against would be a trap.

**The two menu items are decided separately.** Today one flag, `canEdit`,
decides both `Edit` and `Delete for everyone`. Only `Edit` moves to the new
rule. `Delete for everyone` keeps the rule it has today, your own message and
not deleted, because delete has its own capability and its own age limit that
this feature does not touch, and because narrowing it would quietly take away
the ability to delete a message that has an attachment or has aged out of its
edit window. Sharing one flag between the two is what made this worth
spelling out.

`state.editing` changes meaning: it was the id of the message with an open
bubble editor, and it becomes the id of the message the composer is editing.
`openChat` already clears it, so switching conversations ends the session.

The Escape handler in `main.js` already returns early when `state.editing` is
set, and it does so before the composer's own handler runs. That stays: Escape
cancels the edit, and it does not also close the conversation.

The message being edited gets a quiet marker on its bubble, so it is obvious
which one is being changed.

## Code shape

| File | Change |
| --- | --- |
| `src/renderer/js/composer-edit.js` | New. The eligibility rules as pure functions, plus the session: start, step, cancel, save, and the banner. Wired from `thread.js` with its dependencies passed in, the way `thread-search.js` is wired. |
| `src/renderer/js/thread.js` | The composer key handler gains the arrow keys. `sendCurrent` saves an edit instead of sending when a session is open. The context menu's `Edit` opens a session. `editingNode` is deleted. |
| `src/renderer/index.html` | The banner row, above the composer. |
| `src/renderer/styles.css` | The banner's style, and the composer in its editing state. |
| `src/renderer/js/state.js` | The comment on `state.editing` changes to say what it now means. |

The rules are pure functions over a chat and a list of messages, so they can
be checked without a window and without Electron.

## Testing

`check:composeredit`, a new suite, drives the real `src/renderer/index.html`,
the way `check:threadsearch` does, so the check's DOM cannot drift from the
app's. It covers:

- the up arrow on an empty composer opening a session on the newest eligible
  message, with the text in the composer and the banner showing
- the up arrow again stepping to the older message
- another person's message being skipped
- a message with an attachment being skipped
- a deleted message being skipped
- a message older than the chat's `editMaxAge` being skipped
- a chat whose `capabilities` object has no `edit` key doing nothing
- a chat with no `capabilities` object at all still working
- Enter saving an edit through `api.messages.edit` rather than sending a
  message, and the bubble's text changing
- Escape cancelling, leaving the composer empty and making no call
- the up arrow doing nothing when the composer holds text
- the up arrow not stepping once the loaded text has been changed
- the context menu's `Edit` opening the same session the arrow opens
- the context menu hiding `Edit` on a message that is not eligible, while
  still offering `Delete for everyone` on it
- switching conversation clearing the session
- the rules being pure: the same chat and the same messages always give the
  same list

`tools/composer-edit-redproof.js` mutates each rule away and shows the suite
goes red, so a rule that stops being enforced cannot pass unnoticed.

The full suite, `check:syntax` and `check:ascii` stay green.

## Known limitations

- The up arrow can only reach the messages this device has loaded. A chat
  opened a long time ago holds its last few hundred messages in memory;
  scrolling up loads more, and then they are reachable.
- `editMaxCount` is not enforced. A message edited more times than the network
  allows is refused by the network, and the refusal is shown as a toast.
- A Matrix chat is offered editing even though Beeper does not describe what
  Matrix supports. If the bridge refuses, the refusal is shown as a toast.
- The edit window is checked against the message's original timestamp. A
  message edited once near the end of its window cannot be edited again after
  it, which is how the networks describe it.
