/**
 * Incremental transcription of one spoken turn.
 *
 * MediaRecorder emits small chunks; every interval the accumulated turn is
 * re-sent to the transcription endpoint and the returned text replaces the
 * partial view. Growing uploads overlap, so results are merged by word overlap
 * instead of being appended blindly.
 */

function normWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')
}

function normWords(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(normWord)
    .filter(Boolean)
}

export function mergePartial(prev: string, next: string): string {
  const prevRaw = prev.trim()
  const nextRaw = next.trim()
  if (!prevRaw) return nextRaw
  if (!nextRaw) return prevRaw
  const a = normWords(prevRaw)
  const b = normWords(nextRaw)
  if (!a.length) return nextRaw
  if (!b.length) return prevRaw
  if (b.join(' ').startsWith(a.join(' '))) return nextRaw
  if (a.join(' ').includes(b.join(' '))) return prevRaw

  const prevTokens = prevRaw.split(/\s+/)
  const nextTokens = nextRaw.split(/\s+/)
  const maxOverlap = Math.min(a.length, b.length, 16)
  for (let k = maxOverlap; k >= 2; k--) {
    if (a.slice(-k).join(' ') === b.slice(0, k).join(' ')) {
      return [...prevTokens, ...nextTokens.slice(k)].join(' ')
    }
  }
  // A single shared word is enough when it is distinctive ("brown" | "brown fox").
  const last = a[a.length - 1]
  if (last && last === b[0] && last.length >= 4) {
    return [...prevTokens, ...nextTokens.slice(1)].join(' ')
  }

  const setB = new Set(b)
  const shared = a.filter((w) => setB.has(w)).length
  const ratio = shared / Math.max(a.length, b.length)
  if (ratio >= 0.5) return b.length >= a.length ? nextRaw : prevRaw
  return `${prevRaw} ${nextRaw}`.replace(/\s+/g, ' ')
}

export type StreamingOptions = { intervalMs?: number; minBytes?: number }

/**
 * Tracks one recording turn. The caller owns the MediaRecorder; this class only
 * decides when an upload is due and merges what comes back.
 */
export class StreamingSession {
  private readonly intervalMs: number
  private readonly minBytes: number
  private accumulated = 0
  private lastRequestAt = 0
  private inFlight = false
  private text = ''

  constructor(opts: StreamingOptions = {}) {
    this.intervalMs = Math.max(200, opts.intervalMs ?? 900)
    this.minBytes = Math.max(1024, opts.minBytes ?? 6000)
  }

  get transcript(): string {
    return this.text
  }

  get busy(): boolean {
    return this.inFlight
  }

  noteChunk(size: number, now: number) {
    this.accumulated += Math.max(0, size)
    if (!this.lastRequestAt) this.lastRequestAt = now
  }

  shouldRequest(now: number): boolean {
    return !this.inFlight && this.accumulated >= this.minBytes && now - this.lastRequestAt >= this.intervalMs
  }

  beginRequest(now: number) {
    this.inFlight = true
    this.lastRequestAt = now
  }

  fail() {
    this.inFlight = false
  }

  applyPartial(text: string): string {
    this.inFlight = false
    const clean = text.trim()
    if (clean) this.text = mergePartial(this.text, clean)
    return this.text
  }

  /** Final upload wins when it succeeds; otherwise the merged partials stand. */
  finalize(fullText?: string): string {
    const clean = (fullText ?? '').trim()
    if (clean) this.text = mergePartial(this.text, clean)
    this.inFlight = false
    return this.text
  }

  reset() {
    this.accumulated = 0
    this.lastRequestAt = 0
    this.inFlight = false
    this.text = ''
  }
}
