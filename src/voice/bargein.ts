/**
 * Barge-in detector: decides when live speech should interrupt playback.
 *
 * Fed the smoothed microphone level once per animation frame while ORVEX is
 * speaking. Speech must stay above the threshold for a short hold window so a
 * door slam or keyboard click does not cut the answer off.
 */

export type BargeInOptions = { threshold?: number; holdMs?: number; releaseMs?: number }

export class BargeInDetector {
  private readonly threshold: number
  private readonly holdMs: number
  private readonly releaseMs: number
  private aboveSince = 0
  private belowSince = 0
  private fired = false

  constructor(opts: BargeInOptions = {}) {
    this.threshold = Math.min(0.9, Math.max(0.02, opts.threshold ?? 0.18))
    this.holdMs = Math.max(60, opts.holdMs ?? 260)
    this.releaseMs = Math.max(120, opts.releaseMs ?? 700)
  }

  /** Returns true exactly once per sustained intrusion. */
  feed(level: number, enabled: boolean, now: number): boolean {
    if (!enabled) {
      this.reset()
      return false
    }
    if (level >= this.threshold) {
      this.belowSince = 0
      if (!this.aboveSince) this.aboveSince = now || 1
      if (!this.fired && now - this.aboveSince >= this.holdMs) {
        this.fired = true
        return true
      }
      return false
    }
    if (this.aboveSince) {
      if (!this.belowSince) this.belowSince = now || 1
      if (now - this.belowSince >= this.releaseMs) this.reset()
    }
    return false
  }

  get thresholdValue(): number {
    return this.threshold
  }

  reset() {
    this.aboveSince = 0
    this.belowSince = 0
    this.fired = false
  }
}
