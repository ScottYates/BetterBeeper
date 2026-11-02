# Search inside a conversation

Date: 2026-11-02
Status: approved, ready for an implementation plan

## Problem

Better Beeper has one search box and it is in the wrong place for the question
people ask most often in a chat app.

The sidebar's `Search chats and messages` searches every conversation at once.
That is the right tool for "where did I talk about the invoice" and the wrong
tool for "what did she say about Saturday". Answering the second question today
means scrolling a long thread by hand, or reading a list of hits that each name
a different chat, when the user is already looking at the one chat they mean.

## Goals

- Find a message inside the conversation that is open, without leaving it.
- Match the way people type: a fragment of a word finds the word.
- Reach the whole of the conversation, not just the part that happens to be on
  screen.
- Keep the existing sidebar search exactly as it is. It answers a different
  question and it is not being replaced.

## Non-goals

- No change to the sidebar search, its input, its scope selector or its results.
- No new search syntax. A query is text, and every term in it must appear.
- No change to how messages are sent, stored or deleted.
- No separate keyboard shortcut. The header button opens it.

## What already exists

Most of the pieces are already in the app, which is why this is a feature and
not a project.

| Piece | Where | Note |
| --- | --- | --- |
| Local full-text search | `src/main/message-store.js` | FTS5 over every stored message, scoped by `chatIDs`. Word based. |
| Beeper's own search | `src/main/beeper-client.js` | `GET /v1/messages/search`, capped at 20 results. |
| Jump to a message | `src/renderer/js/thread.js` | `scrollToMessage` scrolls and flashes a bubble. `openChat` takes a `focusMessageID`. |
| Paging backwards | `src/main/message-store.js` | `page` and `pageWithMore` read older messages from disk. |
| Fetch one message | `src/main/beeper-client.js` | `getMessage(chatID, messageID)`, not currently exposed to the renderer. |
| Re-walk a chat | `src/main/history-sync.js` | `refresh` re-checks the tail and walks back from the oldest message held. |

## Measured behaviour of Beeper's search

These were measured against the live Beeper Desktop API on 2026-11-02, with the
read-only probe now in `tools/probe-search-shape.js`. The design depends on
them, so they are recorded here rather than assumed.

| Question | Answer |
| --- | --- |
| Does `chatIDs` narrow the result? | Yes. The same query returned 20 hits unscoped and 1 hit scoped, and no hit from another chat. |
| Does a hit carry the message text? | Yes. Hits carry `text`, `timestamp`, `id` and `chatID`, so a hit can be drawn as a real bubble. |
| Does a match have to be a whole word? | No. `stro` found the same message as `strong`. |
| What does a two-word query do? | It behaves like a phrase. `strong code` returned 0 items where the single words returned hits. |
| Can one message be fetched by id? | Yes. `GET /v1/chats/{chatID}/messages/{messageID}` returns the full message with its text. |

The phrase behaviour is the one that constrains the design. Beeper's search is
asked for single-word queries only. Anything longer is the local store's job.

## The interface

A magnifier button joins the thread header's action buttons, next to the
existing refresh and mute buttons. Clicking it reveals a search row directly
under the header, in the same place and in the same style as the sidebar's
search row, so the app has one search idiom rather than two.

```
+------------------------------------------------------+
| [ search this conversation .......]  3 of 12   ^ v x |
+------------------------------------------------------+
```

| Element | Id | Behaviour |
| --- | --- | --- |
| Button | `#btn-thread-search` | Opens the row and focuses the input. |
| Row | `#thread-search-row` | Hidden until the button is used. |
| Input | `#thread-search-input` | Searches as you type, debounced. |
| Counter | `#thread-search-count` | `3 of 12`, `No matches`, or `Searching...`. |
| Previous | `#thread-search-prev` | Steps to the previous hit. |
| Next | `#thread-search-next` | Steps to the next hit. |
| Note | `#thread-search-note` | Says so when the answer is partial. |
| Close | `#thread-search-close` | Closes the row, clears the highlights, returns the cursor to the composer. |

Enter steps to the next hit and Shift+Enter to the previous one, which is what
the arrow buttons do. Escape closes the row. The counter counts hits in
reading order, oldest first, so stepping forward walks down the thread the way
it is read.

The row is closed when the chat changes or closes, and the highlights are
cleared. Searching one conversation and then opening another must not leave the
first conversation's highlights behind.

## Matching

A query matches a message when the message text contains the query, ignoring
case. Every whitespace-separated term must be found.

This is a substring rule, not a word rule, because that is what a search box is
expected to do. `batt` finds `battery`. The local store's FTS5 index cannot
answer that, because FTS5 matches tokens: `batt` finds nothing. So the store
gains a chat-scoped substring scan for this feature, alongside the existing
word search, which the sidebar keeps using.

The scan is `LIKE` over one chat's rows. The store already indexes
`(chatID, ts, id)`, and a single conversation holds thousands of messages at
most, so the scan is a few milliseconds.

Beeper's server search is asked only when the query is a single word, because
of the phrase behaviour measured above. Its hits are then re-tested against the
same substring rule, so a hit the local search would not have counted cannot
inflate the counter. The counter and the highlighting always agree.

## The two sources

| Source | Answers for | Limit |
| --- | --- | --- |
| Local store | Everything this device has stored for the chat. | The number of messages in the chat. |
| Beeper's search | History this device has never synced. | 20 results, single-word queries only. |

They are merged by message id, local first, and sorted oldest first. A message
both sides know about appears once.

## Landing on a hit

**A hit that is on screen** is scrolled to and flashed, which is what
`scrollToMessage` already does for a search result in the sidebar.

**A hit that is older than the loaded window** is reached by paging backwards
through the store until the hit's timestamp is inside the window, then
re-rendering and scrolling to it. This reuses the paging the thread already
does when the user scrolls up, with a cap of 20 pages so a runaway loop cannot
happen. The scroll position is not preserved across those pages, because the
user asked to be put on the hit, not left where they were.

**A hit that only Beeper knows about** is fetched by id, written to the local
store and rendered. It lands in the right place in time, but the messages
around it may be missing until the backfill reaches that date.

To close that gap, a search that finds hits the local store does not have
queues a history refresh for the chat. The refresh already re-walks a chat from
the oldest message held, so the missing context arrives on its own and later
searches find those hits locally. The refresh shows in the jobs panel like any
other, so nothing happens quietly.

## Highlighting

Message text is drawn as rich HTML, because Beeper sends markup. Highlighting
therefore works on the rendered DOM rather than on the raw string: the
highlighter walks the text nodes inside a bubble and wraps the matches in a
`mark` element. Working on the DOM is what makes a match survive across the
tags in a pasted document.

The thread rebuilds itself whenever a message arrives, so the active search
lives in its own module and the highlights are re-applied after every render.
The current hit is marked apart from the others and is the one the flash
animation runs on.

## Failure handling

| Situation | Behaviour |
| --- | --- |
| Beeper unreachable | The local search still works. The note says the answer covers only what is on this device. |
| Local store unreadable | Beeper's hits still work. |
| Both fail | `Could not search this conversation.` |
| No hits | `No matches`. The thread is left alone. |
| The query is cleared | Every highlight is removed and the counter resets. |
| A hit cannot be fetched | The step is skipped rather than stalling on it. |

## Testing

The logic goes in a module of its own so it can be tested without Electron:
merging two sources, the substring rule, whether a query is a single word, the
step order, and the DOM highlighter.

`check:threadsearch`, a new suite, drives that module against the real
`src/renderer/index.html`, the way `check:paste` does, so the check's DOM
cannot drift from the app's. It covers:

- the counter reading `3 of 12`, and `No matches` when there are none
- Enter and Shift+Enter stepping forwards and backwards, and wrapping
- highlights appearing, and every highlight being removed when the query is
  cleared
- Escape closing the row and returning the cursor to the composer
- a server hit that the local store does not have
- a hit older than the loaded window being paged into view

Every case has a control that proves it can fail. The suite's helper compares
strictly against `true`, because a helper that coerces with `!!` cannot tell a
pass from a failure reason.

`check:history` gains cases for the new store scan: a substring match that the
FTS index would miss, a tombstoned message staying out of the results, and a
chat's search never reaching into another chat.

The new IPC channel gets the source-level check the repo already uses, reading
the channel name out of both sides rather than hard-coding it.

## Known limitations

- Beeper's search is capped at 20 results, so a conversation with more than 20
  matches on Beeper's side shows the first 20 of them plus everything the
  local store knows. The local store is the one that goes further back.
- A hit only Beeper knows about renders as a single bubble with a gap around
  it until the refresh brings the surrounding messages home. This is honest
  about what is on the machine, and the gap is temporary.
- The substring scan is a scan, not an index lookup. It is bounded to one
  conversation, which is what keeps it fast.
- A search cannot reach a conversation that has never been opened on this
  device, because the local store has never seen it. Beeper's search can, and
  those hits are fetched and stored when the conversation is opened.
