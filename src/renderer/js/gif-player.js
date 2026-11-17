/**
 * Playing an animated GIF ourselves, so that it can be stopped.
 *
 * Why this exists
 * ---------------
 * The browser plays an animated GIF inside an <img> and offers no way to
 * stop it. There is no API for pausing one, no way to ask which frame is
 * showing, and no way to photograph the frame that is showing: drawing a
 * playing GIF into a canvas always gives back the first frame, never the one
 * on screen. So a GIF in a message played for as long as the chat was open,
 * and there was no control that could say otherwise.
 *
 * What this does instead
 * ----------------------
 * The frames are decoded with ImageDecoder, which is the browser's own GIF
 * decoder, and drawn onto a canvas. That buys three things an <img> could
 * not do:
 *
 *  - the picture can be frozen on the frame that is showing;
 *  - the loops can be counted, because the decoder hands out the frames of
 *    the file once and then stops, so one pass over them is one loop;
 *  - the frames come back already composited, with the disposal methods and
 *    the transparent index applied, so what is drawn is what the browser
 *    would have drawn - a transparent GIF stays transparent.
 *
 * The decoder does not loop, so every loop makes a new one. Each frame
 * carries the timestamp it is due at, so the schedule is absolute rather
 * than a running total of delays, and a slow decode cannot make the
 * animation drift.
 *
 * There is no dependency here and no new IPC. The renderer can fetch an
 * attachment over the beeper-file scheme, so the bytes come from the same
 * place the <img> would have loaded them from.
 */

/** How many times a GIF plays before it stops on its own. */
export const DEFAULT_LOOPS = 3;

export class GifPlayer {
  /**
   * @param {object} options
   * @param {HTMLCanvasElement} options.canvas  where the frames are drawn
   * @param {string} options.url                 where the GIF's bytes are
   * @param {number} options.loops               how many loops before it stops
   */
  constructor({ canvas, url, loops = DEFAULT_LOOPS }) {
    this.canvas = canvas;
    this.url = url;
    this.limit = loops;

    // The bytes and what we know about the file. Filled in by load().
    this.bytes = null;
    this.frameCount = 0;
    this.animated = false;

    // Two states, because they answer different questions. `wanted` is what
    // the reader asked for: a GIF plays by default, so it starts true.
    // `playing` is what is actually running, which is also false when the
    // picture has scrolled out of sight - a GIF nobody can see has no
    // business decoding frames.
    this.wanted = true;
    this.playing = false;
    this.onScreen = true;

    // Counters, so a check can see what the player did rather than asking it.
    this.framesDrawn = 0;
    this.loops = 0;
    this.forever = false;

    this.stopped = false;
    this.running = false;
    this.wake = null;
    this.resume = null;
    this.observer = null;
    this.context = null;
  }

  /**
   * Fetch the file and find out whether it is an animation.
   *
   * Returns false for a file that is not a GIF, for a GIF with a single
   * frame, and for anything that cannot be decoded. In every one of those
   * cases the caller keeps the plain <img> and the reader gets a picture
   * with no button on it, which is the right answer: a play button over a
   * still picture would be a lie.
   */
  async load() {
    const response = await fetch(this.url);
    if (!response.ok) throw new Error(`the GIF answered ${response.status}`);
    const buffer = await response.arrayBuffer();
    this.bytes = new Uint8Array(buffer);

    const decoder = new ImageDecoder({ data: this.bytes, type: 'image/gif' });
    try {
      await decoder.tracks.ready;
      const track = decoder.tracks.selectedTrack;
      this.frameCount = track.frameCount;
      this.animated = track.animated === true && this.frameCount > 1;
    } finally {
      decoder.close();
    }
    return this.animated;
  }

  /**
   * Start the run loop, and let it wait until there is something to play.
   *
   * The loop is started once and then stays alive, suspended between plays.
   * A fresh loop would have to decode the file from the beginning again, and
   * a GIF that is paused in the middle of a loop has to be able to carry on
   * from the frame it was showing.
   */
  start() {
    if (this.running || this.stopped) return;
    this.running = true;
    this._run().catch(() => {
      // A decode that fails halfway is not worth a crash. The picture stays
      // on the last frame that was drawn, which is still a picture.
      this.playing = false;
    });
  }

  /**
   * The reader pressed play.
   *
   * Once the reader has pressed the button the GIF is theirs: it runs until
   * they press pause. The three loops are the default, not a rule the
   * reader cannot get out of.
   */
  play(options = {}) {
    if (options.forever === true) this.forever = true;
    this.wanted = true;
    this._sync();
  }

  /** The reader pressed pause, or the picture ran out of loops. */
  pause() {
    this.wanted = false;
    this._sync();
  }

  /** The button was pressed: do the other thing. */
  toggle() {
    if (this.wanted) this.pause();
    else this.play({ forever: true });
  }

  /**
   * Whether the reader has it paused.
   *
   * This is the reader's intent, not whether it happens to be running: a
   * picture that has scrolled out of sight is paused by the observer but the
   * reader has not asked for it to stop, and a menu that said "Play" for that
   * would be wrong.
   */
  get paused() {
    return !this.wanted;
  }

  /**
   * Whether the picture should be running right now.
   *
   * Off screen counts as not running. A GIF that has scrolled away is still
   * in the cache, and a chat that is not open is still in the cache, so
   * without this every GIF ever seen would keep decoding frames for as long
   * as the app is open.
   */
  _sync() {
    const shouldRun = this.wanted && this.onScreen && !this.stopped;
    if (shouldRun !== this.playing) {
      this.playing = shouldRun;
      this._wake();
    }
  }

  /**
   * Watch the canvas, so a GIF that has scrolled away stops costing
   * anything, and starts again when it comes back.
   */
  watchVisibility() {
    if (typeof IntersectionObserver !== 'function') return;
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        this.onScreen = entry.isIntersecting === true;
        this._sync();
      }
    });
    this.observer.observe(this.canvas);
  }

  /** Give up: stop decoding, stop watching, and let the canvas memory go. */
  dispose() {
    this.stopped = true;
    this.wanted = false;
    this.playing = false;
    this._wake();
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    // The canvas keeps its backing store until its size is set again, and a
    // cached GIF holds one of those. Zeroing the size frees the pixels.
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.bytes = null;
  }

  /**
   * The run loop.
   *
   * It draws frames until the reader stops it or the loops run out, and it
   * sits still in between. A decoder is made per loop, because the decoder
   * hands out the frames of the file once and then stops.
   */
  async _run() {
    let decoder = null;
    let index = 0;
    // When the loop's first frame was due. Every frame in the loop is timed
    // against this, so a slow decode cannot make the animation drift.
    let loopStart = performance.now();
    let loopLength = 0;

    try {
      while (!this.stopped) {
        if (!this.playing) {
          await this._suspend();
          continue;
        }

        if (!decoder) {
          decoder = new ImageDecoder({ data: this.bytes, type: 'image/gif' });
          await decoder.tracks.ready;
          index = 0;
          loopStart = performance.now();
        }

        const { image } = await decoder.decode({ frameIndex: index });
        // When the next frame is due. The frame's own timestamp and duration
        // are absolute within the loop, so the schedule is absolute.
        const next = loopStart + (image.timestamp + image.duration) / 1000;
        loopLength = (image.timestamp + image.duration) / 1000;

        this._draw(image);
        image.close();
        this.framesDrawn += 1;
        index += 1;

        await this._waitUntil(next);

        // The loop is over when the last frame has been shown for as long as
        // the file says it should be, not when it was drawn. A frame that is
        // held for 200ms is on screen for those 200ms, and stopping the
        // picture the moment it appears would cut that short.
        if (index >= this.frameCount) {
          // The loop is over. The next one starts a fresh decoder and is
          // timed from the moment this one was due to end.
          decoder.close();
          decoder = null;
          this.loops += 1;
          if (!this.forever && this.loops >= this.limit) {
            this.pause();
            continue;
          }
          loopStart += loopLength;
        }
      }
    } finally {
      if (decoder) decoder.close();
    }
  }

  /**
   * Draw one frame.
   *
   * The canvas is cleared first. A frame with holes in it has to show
   * through to the message bubble behind it, and a frame without holes must
   * not leave the last frame's pixels showing at the edges.
   */
  _draw(image) {
    const width = image.displayWidth;
    const height = image.displayHeight;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    if (!this.context) this.context = this.canvas.getContext('2d');
    this.context.clearRect(0, 0, width, height);
    this.context.drawImage(image, 0, 0);
  }

  /** Wait until a time, and give up the wait if the picture is stopped. */
  _waitUntil(target) {
    const delay = target - performance.now();
    if (delay <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, delay);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  /** Sit still until there is something to play again. */
  _suspend() {
    return new Promise((resolve) => {
      this.resume = resolve;
    });
  }

  /** Let a waiting player go back to work. */
  _wake() {
    if (this.wake) {
      const wake = this.wake;
      this.wake = null;
      wake();
    }
    if (this.resume) {
      const resume = this.resume;
      this.resume = null;
      resume();
    }
  }
}
