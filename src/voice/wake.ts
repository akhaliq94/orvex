/**
 * Wake-word matching over a live speech transcript.
 *
 * There is no always-on local acoustic model here: wake detection runs on the
 * text the configured transcription endpoint already produces, so a phrase is
 * only matched once the recogniser has emitted words. That keeps the feature
 * honest — no phrase spotting is claimed when no transcription source exists.
 */

export type WakeMatch = { matched: boolean; command: string; index: number }

export function normalizeSpeech(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function words(input: string): string[] {
  const clean = input.trim()
  return clean ? clean.split(/\s+/) : []
}

export function tokenDistance(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (Math.abs(m - n) > 2) return 3
  let prev = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1)
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/** One transcription slip is fine for words of four letters or more. */
function sameWord(spoken: string, target: string, fuzzy: boolean): boolean {
  const a = normalizeSpeech(spoken)
  const b = normalizeSpeech(target)
  if (!a || !b) return false
  if (a === b) return true
  return fuzzy && Math.min(a.length, b.length) >= 4 && tokenDistance(a, b) <= 1
}

export function matchWake(transcript: string, phrase: string, fuzzy = true): WakeMatch {
  const said = words(transcript)
  const want = words(phrase)
  if (!want.length || said.length < want.length) return { matched: false, command: '', index: -1 }
  for (let start = 0; start + want.length <= said.length; start++) {
    let ok = true
    for (let k = 0; k < want.length; k++) {
      if (!sameWord(said[start + k], want[k], fuzzy)) {
        ok = false
        break
      }
    }
    if (ok) {
      return {
        matched: true,
        command: said.slice(start + want.length).join(' ').trim(),
        index: start,
      }
    }
  }
  return { matched: false, command: '', index: -1 }
}

export type WakeGateOptions = { phrase: string; fuzzy?: boolean; cooldownMs?: number }

/**
 * Fires once per utterance of the phrase. Interim transcripts keep growing
 * ("hey", "hey orvex", "hey orvex open"), so the cooldown is what stops the
 * same phrase from triggering on every update; it re-arms on its own.
 */
export class WakeGate {
  private lastAt = -Infinity
  private lastCommand = ''
  private readonly phrase: string
  private readonly fuzzy: boolean
  private readonly cooldownMs: number

  constructor(opts: WakeGateOptions) {
    this.phrase = opts.phrase || 'Hey Orvex'
    this.fuzzy = opts.fuzzy ?? true
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? 2500)
  }

  get phraseText(): string {
    return this.phrase
  }

  feed(transcript: string, now: number): { triggered: boolean; command: string } {
    const m = matchWake(transcript, this.phrase, this.fuzzy)
    if (!m.matched) return { triggered: false, command: '' }
    if (now - this.lastAt < this.cooldownMs) return { triggered: false, command: '' }
    this.lastAt = now
    this.lastCommand = m.command
    return { triggered: true, command: m.command }
  }

  reset() {
    this.lastAt = -Infinity
    this.lastCommand = ''
  }

  get lastMatchedCommand(): string {
    return this.lastCommand
  }
}
