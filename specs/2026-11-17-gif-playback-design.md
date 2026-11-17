# Animated GIFs play three times, then stop

## What the app does now

An animated GIF in a message is an ordinary `<img class="att-image">`. The
browser plays it, and it plays for as long as the message is on screen: it
loops forever, or until the chat is closed. In a busy conversation that is a
row of small animations all running at once, and every one of them costs the
compositor work for as long as the thread is open.

The app already keeps the `<img>` element alive across re-renders, precisely
so a GIF does not restart every time a message arrives (see the note above
`imgCache` in `src/renderer/js/thread.js`).

## What is wanted

1. An animated GIF can be paused and played by hand.
2. The control is in the right-click menu on the picture, because a left click
   on a picture opens it in the viewer.
3. The GIF plays three times and then stops on its own.
4. The reader can press play and pause it by hand.

The decisions that were not obvious, and why they went the way they did:

- **Pause freezes on the frame that is showing.** Not on the first frame. The
  browser offers no way to pause an animated GIF in place, so the app draws
  the frames itself. The pictures come from the browser's own GIF decoder, so
  what the reader sees is what the browser would have drawn.
- **After the automatic stop, play runs until pause.** The three loops are the
  *default* behaviour, not a rule the reader cannot escape. Once the reader
  presses play, the GIF is theirs: it runs until they press pause.
- **The control is a menu item, not a button over the picture.** There was a
  button over the picture to begin with, and it fought with the picture's own
  left click: a left click opens the picture in the viewer, so a control
  sitting on top of that is a second thing to aim at for something that is
  not wanted most of the time. The right-click menu is already the place for
  the things that are not one click.
- **The full-screen viewer is untouched.** Opening a GIF in the viewer is a
  deliberate "I want to watch this", so it plays there as it always has.

## How a GIF can be paused at all

There is no API for pausing an animated GIF. What was tried, and what each
one does:

| approach | result |
|---|---|
| `img.src = img.src` | restarts the animation from the first frame |
| `drawImage(img, ...)` into a canvas | always yields the *first* frame, never the frame on screen, so it cannot snapshot the current one |
| `ImageDecoder` (WebCodecs) | works: gives every frame, already composited, with the browser's own timings |

`ImageDecoder` is the way in. It is available in this build (Electron 38,
Chromium 140), it accepts `image/gif`, and it reports the frame count and each
frame's duration. The frames it returns are the *composited* screen-sized
pictures, with the disposal methods and the transparent index already
applied, and with a real alpha channel: a GIF with holes in it comes back with
holes in it, so a transparent GIF still looks transparent over the message
bubble.

The decoder does not loop. It hands out the frames of the file once and then
is finished, which is what makes counting loops easy: one pass over the
frames is one loop, and a new decoder is made for the next one.

### Getting the bytes

The renderer cannot read the disk, but it can fetch the attachment: the
`beeper-file:` scheme is registered with `supportFetchAPI` and the handler
serves the file with a `Content-Type`. A `fetch()` of the attachment URL from
the renderer returns the bytes with no CORS problem, because the page and the
scheme are treated as the same origin for this request. That is what the
player uses, so **no new IPC channel is needed**.

### The policy that stopped it

The first version of this did not work, and the reason was the page's own
security policy rather than the scheme.

The app's `index.html` carries a Content Security Policy, and its `connect-src`
was `'self'`. `connect-src` is the directive that governs `fetch()`, so the
player's request for the attachment bytes was refused: "Refused to connect ...
violates Content Security Policy directive: connect-src 'self'". The player
then fell back to an ordinary `<img>`, which is an ordinary animated GIF: it
plays forever, it cannot be paused, and the right-click menu had no play item
on it, because there was no player behind it.

The scheme was never the problem. It was already in `img-src`, which is why
the picture itself loaded fine, and the same bytes were readable by the
renderer as an image. What was missing was permission to read them as
*data*. So `connect-src` is now `'self' beeper-file:`.

That is not a new door. The scheme is served by the main process, it only
reads the two folders that hold chat media, and the renderer could already
load those same files through `img-src`.

Two things followed from this, and both are now in the code:

- **A GIF that falls back to a picture still has to be a proper picture.** When
  the player gives up, the `<img>` it was drawn as stays in the document, and
  the right-click menu is built from the element under the pointer. So that
  `<img>` carries the attachment, exactly as the canvas does. Without it, a
  GIF that could not be played could not be saved either.
- **The check has to run under the app's own policy.** A check that served the
  fixture over `file://` would not have seen this at all, because `'self'`
  covers `file://`. The thread phase of the check now registers the
  `beeper-file` scheme the way `src/main/main.js` does and serves the fixture
  over it, so the page's real policy is what decides whether the player may
  read the file.

## The shape of the thing

A GIF attachment is drawn as a wrapper holding two parts:

```html
<div class="att-gif-wrap">
  <img class="att-image">        <!-- until the player takes over -->
  <canvas class="att-gif-canvas"> <!-- the frames the player draws -->
</div>
```

The `<img>` is still made first, and it is still what loads the file. It has
two jobs: it is the lazy-load trigger (the browser only loads it when it is
near the viewport), and it is the fallback if the file turns out not to be an
animated GIF at all, or cannot be decoded. Once the player has the first
frame, the `<img>` is taken out of the document so the browser does not also
play the same animation underneath, and the `<canvas>` is what the reader
sees.

The wrapper exists so the canvas can take the place of the picture. It is
sized so that the picture inside it is drawn at exactly the size it is drawn
today: the wrapper stretches like the bare `<img>` used to, and the picture
inside it is `width: 100%` with the same 340 pixel cap, so a GIF in a message
with long text is scaled the same way every other image in that message is.

The control is a line at the top of the picture's right-click menu, before
Open image, Save image, Copy image and Copy image address. The canvas carries
the player, so the menu can ask it whether the reader has it paused and say
what the press will do: "Play animation" for a picture that has stopped,
"Pause animation" for one that is still going. The item is only offered for a
GIF the app is playing itself, so a still picture never gets a control that
does nothing.

## The rules the player follows

- **Three loops, then stop.** A loop is one pass over every frame. The
  counter is the player's own, not the browser's, because the browser's
  animation is not ours to count.
- **The frame is shown for as long as the file says.** Each decoded frame
  carries the timestamp it should appear at, so the schedule is absolute
  rather than a sum of delays that drifts as the frames are decoded.
- **Pausing stops the clock.** The picture on the canvas is the frame that
  was showing, and it stays there until play is pressed.
- **Playing after the automatic stop runs until pause.** Once the reader has
  pressed play, the automatic stop does not come back.
- **A GIF that is not animated gets no control.** One frame is a picture, and
  a play item over a picture would be a lie.
- **A GIF that cannot be decoded stays a picture.** The `<img>` is left
  alone, so a broken file is still visible and still saveable.

## What is not done

- The full-screen viewer plays the GIF as it always has.
- The menu item is not offered for still images, for videos (which have their own
  controls), or for files that are not pictures at all.

## How it is proved

`npm run check:gifplayer` drives the real player in a real window against a
GIF built at run time, and asserts on the pixels on the canvas rather than on
the player's own opinion of what it did:

- the picture changes while it plays;
- it stops by itself after three loops, and the number of frames drawn is
  exactly three times the number of frames in the file;
- pressing pause freezes the picture, and the frozen frame is the frame that
  was showing;
- pressing play starts it again;
- the player says whether the reader has it paused, which is what the menu
  label is built from;
- a one frame GIF gets no player, and a file that is not a GIF gets no
  player.

The second phase also asks the page directly whether it may fetch the file at
all, because a refusal reads as "the picture did not move" and would be
reported as a broken player rather than as a broken policy.

The player on its own is half the feature, so the second phase drives the
**real `thread.js`** with a stubbed bridge against the real `index.html`
markup, and looks at what the thread drew: that it drew a wrapper with a
canvas and no button over it, that it handed the picture to the player, that
the `<img>` was taken out of the document once the player took over, that the
picture the thread drew really moves and really stops by itself, and that
right-clicking the canvas offers the same picture menu as any other image
plus an item that pauses it.

It also opens the chat a third time with a GIF that has one frame in it, so
the fallback path is walked as well: the picture stays an ordinary `<img>`,
gets no play item, and is still saveable from its menu.

The menu is proved by pressing it, not by reading the label: the picture is
watched across the press, and it has to stop changing and stay stopped. The
state is set rather than waited for, so a picture that had not yet finished
its three loops cannot change what the menu says.

`node tools/gif-player-redproof.js` breaks the player on purpose in a copy of
the tree and insists the check notices each break. Twelve mutations, twelve
caught, with an asserted baseline that the untouched tree passes first: a loop
limit that is one too small, a pause that does not pause, a play that does not
play, a one frame file treated as an animation, frames that are decoded and
thrown away instead of drawn, a thread that never hands the picture over, a
thread that never offers the menu item, a menu item that always says the same
thing, a menu item that does nothing, a cached canvas that keeps the
attachment it was first drawn with, a security policy that forbids the player
reading the file, and a GIF that is not an animation losing the attachment it
would be saved by.

The last of those breaks every path that can put the attachment onto a
picture, not just one of them. The thread draws the list more than once, so
the second draw hands back the same element and stamps it again on the way
out: break only the stamp at creation and the reuse puts it straight back,
which is the shape of hole the download proof found earlier. The rule being
proved is that the fallback picture carries its attachment, and every path
that can carry it has to go.

### One thing the check had to get right about itself

The check was dying on the way out. It destroyed both of its windows and then
ended the process, and destroying a window whose renderer is still busy tears
the renderer down underneath a callback that is on its way into V8. The
process died with `Invoke in DisallowJavascriptExecutionScope`, the exit code
was the crash code rather than 1, and the results that had just been printed
were lost.

The symptom looked like a check that had failed to notice a broken player,
which is the opposite of what had happened. Two things came out of it:

- the check exits through Electron now, the way the other window checks here
  do, and does not destroy the windows by hand;
- the red proof keeps the error output as well as the results and prints both,
  so "the case failed" and "the check died" are told apart in the output rather
  than guessed at.

A check that dies on the way out reports nothing, and it takes the evidence
with it.
