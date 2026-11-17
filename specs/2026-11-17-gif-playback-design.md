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

1. An animated GIF gets a play/pause button over it.
2. The button is hidden until the picture is hovered, so a still frame is not
   permanently marked up by a control nobody is reaching for.
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

## The shape of the thing

A GIF attachment is drawn as a wrapper holding three parts:

```html
<div class="att-gif-wrap">
  <img class="att-image">        <!-- until the player takes over -->
  <canvas class="att-gif-canvas"> <!-- the frames the player draws -->
  <button class="att-gif-toggle"> <!-- play or pause, hidden until hover -->
</div>
```

The `<img>` is still made first, and it is still what loads the file. It has
two jobs: it is the lazy-load trigger (the browser only loads it when it is
near the viewport), and it is the fallback if the file turns out not to be an
animated GIF at all, or cannot be decoded. Once the player has the first
frame, the `<img>` is taken out of the document so the browser does not also
play the same animation underneath, and the `<canvas>` is what the reader
sees.

The wrapper exists so the button has something to sit on. It is sized so that
the picture inside it is drawn at exactly the size it is drawn today: the
wrapper stretches like the bare `<img>` used to, and the picture inside it is
`width: 100%` with the same 340 pixel cap, so a GIF in a message with long
text is scaled the same way every other image in that message is.

The button is the same shape as the one the video attachment already has
(`.att-download`): 28 pixels square, in the corner, transparent until the
wrapper is hovered or the button itself is focused. `pointer-events` follows
`opacity`, so a button nobody can see is not a button that swallows clicks.

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
  pressed the button, the automatic stop does not come back.
- **A GIF that is not animated gets no button.** One frame is a picture, and
  a play button over a picture would be a lie.
- **A GIF that cannot be decoded stays a picture.** The `<img>` is left
  alone, so a broken file is still visible and still saveable.

## What is not done

- The full-screen viewer plays the GIF as it always has.
- The button is not drawn for still images, for videos (which have their own
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
- the button is invisible until the picture is hovered;
- a one frame GIF gets no button, and a file that is not a GIF gets no
  player.

The player on its own is half the feature, so the second phase drives the
**real `thread.js`** with a stubbed bridge against the real `index.html`
markup, and looks at what the thread drew: that it drew a wrapper with a
canvas and a button, that it handed the picture to the player, that the
`<img>` was taken out of the document once the player took over, that the
picture the thread drew really moves and really stops by itself, and that
right-clicking the canvas offers the same picture menu as any other image.

`node tools/gif-player-redproof.js` breaks the player on purpose in a copy of
the tree and insists the check notices each break. Eight mutations, eight
caught, with an asserted baseline that the untouched tree passes first: a loop
limit that is one too small, a pause that does not pause, a play that does not
play, a one frame file treated as an animation, a button that is always
visible, frames that are decoded and thrown away instead of drawn, a thread
that never hands the picture over, and a thread that leaves the button out.

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
