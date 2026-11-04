'use strict';

/**
 * No-progress watchdog for one streamed model response.
 *
 * A provider can accept the request, send a chunk or two and then go silent with
 * the socket still open. Without a watchdog the step waits for the whole request
 * timeout (3 min hosted, 10 min for a local model) and then fails looking like a
 * slow model. The watchdog is armed by the first chunk and re-armed by every
 * later one, so a slow prefill or a reasoning model thinking before its first
 * token is still covered by the normal request timeout.
 */
class StreamWatchdog {
  constructor({ windowMs, onStall } = {}) {
    this.windowMs = Math.max(1000, Number(windowMs) || 0);
    this.onStall = typeof onStall === 'function' ? onStall : null;
    this.fired = false;
    this._timer = null;
    this._done = false;
  }

  progress() {
    if (this._done || !this.windowMs) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._done) return;
      this.fired = true;
      try {
        this.onStall?.();
      } catch {
        /* the abort callback must never throw back into the timer */
      }
    }, this.windowMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  finish() {
    this._done = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }
}

module.exports = { StreamWatchdog };
