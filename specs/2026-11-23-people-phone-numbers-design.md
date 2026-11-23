# The people in a chat show their phone number

## What was asked

The "People in this chat" list shows who is in a conversation. It should show
each person's phone number next to their name.

## What the list does now

The list is a modal, opened from the people button in the thread header
(`openParticipants` in `src/renderer/js/modals.js`). Each row is an avatar, a
name, the tags beside it (You, Admin, Pending, Bot) and a line underneath for
an identifier.

The line underneath has always been empty in practice. The row is built from
the chat's participants, and the naming rules in
`src/renderer/js/participants.js` look for a `phoneNumber` or a `username` on
the participant record to put there.

**There is no such field.** Beeper's bridge sends a chat's participants as:

    { id, fullName, imgURL, cannotMessage, isSelf, isAdmin, isPending, isNetworkBot }

Measured on the live account on 2026-11-23, over 200 chats and 492
participants: not one participant carried a `phoneNumber` or a `username`. The
bridge's own schema has both, on a `User`, but it documents the phone number
as "omit if unknown", and for the people who matter it is unknown.

So the list asked for a number that was never there, and the line underneath
every row stayed empty.

## Where the number actually is

Beeper Desktop's own store keeps it, in `participant_identifiers`:

    participant_id                                  identifier_type  identifier
    @YynP0amA7e30Yc3cN7-...:local-signal.localhost  phone            +15154916586

and the `participant_id` is exactly the `id` the bridge hands out. The join is
exact, not a guess by name. This is the same table Beeper Desktop itself
reads the number from.

The other routes were checked and do not work:

| route | result |
|---|---|
| `GET /v1/chats/{id}` participants | no number, ever |
| `GET /v1/accounts/{id}/contacts/list` | 44 entries for the Signal account, keyed by `pni_`; **empty** for the Google Voice account, where most of these chats live |
| `GET /v1/accounts/{id}/contacts?query=` | empty for Google Voice, with or without a query |
| `GET /v1/search` | chats, group matches and messages; no participant records |

Coverage of the store join, measured over the same 200 live chats: **478 of
492 participants, 97%**. Google Voice 462 of 462, Signal 8 of 8, Facebook 6 of
12. The ones without a number are the people who do not have one: Beeper
accounts such as `@eric:beeper.com`, and Facebook contacts whose number was
never given to us.

## The shape of the thing

- **The main process reads the store** (`src/main/participant-numbers.js`).
  Read-only, and quiet about it: the store belongs to another program, so a
  missing file, a locked file or a changed schema is reported as "no numbers"
  rather than as an error. The read is cached for a minute, because the people
  list is opened often and re-opening the database on every click is a lot of
  work for the same answer.
- **The renderer asks for the numbers by id** over one new IPC channel,
  `participants:numbers`. Only the ids asked for come back.
- **The list opens straight away and fills the numbers in afterwards.** Waiting
  for the read would mean a blank list for as long as it takes, and there is
  nothing in the names that the numbers change.
- **The number goes beside the name, on the same line.** The line underneath
  is for something else, and a number printed twice is noise: the rules leave
  out a number that the name already is.

## The rules the list follows

- **A person whose name is their own number is left alone.** Printing the
  number beside the number says nothing. This is the normal case for a phone
  network: of the 123 Google Voice contacts Beeper Desktop keeps, 68 have a
  number as their name.
- **A number is shown once.** Beside the name, or not at all.
- **A number that is not the name's is shown.** Two numbers are two numbers,
  whatever the name says.
- **Nobody without a number is given one.** Beeper accounts have no number,
  and the list says nothing rather than something wrong.

## What is not done

- The full-screen viewer is untouched.
- The number is not copied to the clipboard, and there is no action on it. It
  is a thing to read.
- A person whose number is not in the store is shown without one. There is no
  lookup on demand: the bridge cannot do it, and asking the store for one
  person at a time would be a request per row.

## How it is proved

Three checks, because the feature is in three places.

- `npm run check:participants` - the pure rules: the naming, the order, and
  the number. The fixtures are the real shapes, measured on the live account,
  and a chat participant in them carries **no** number, because the bridge
  does not send one. The numbers arrive as a map of id to number, and the
  check proves that a number in the map reaches the row and a number that is
  not in it does not.
- `npm run check:participantnumbers` - the read out of the store, against a
  store built to the same shape. The failures are half of it: a store that is
  not there, a store with no table, a file that is not a database, an id that
  is not the same id. None of them may throw.
- `npm run check:people` - the real list, opened by the real code in a real
  window, with only the IPC boundary replaced. It reads the DOM that comes
  back out and measures it: the number has to be in the row, on the same line
  as the name, and actually drawn beside it rather than wrapped onto a line
  of its own.

`node tools/people-redproof.js` breaks each of the three on purpose, one
thing at a time, and insists the named check notices: nine mutations, nine
caught, with an asserted baseline that the untouched tree passes first.
