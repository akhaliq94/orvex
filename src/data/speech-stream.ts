/**
 * Cutting a growing reply into sentences that are safe to speak early.
 *
 * Only text that ends on a finished sentence boundary is released; the rest
 * stays buffered so a half-written word or an abbreviation like "e.g." never
 * reaches the synthesiser as its own utterance.
 */

const TERMINATORS = '.!?…'
/** A dot after one of these is an abbreviation, not the end of a sentence. */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'vs', 'etc', 'inc', 'ltd', 'co', 'no', 'approx',
  'fig', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
  'al', 'dept', 'est', 'min', 'max', 'gov', 'ave', 'blvd', 'rd', 'mt',
])
/** What may legally follow a boundary before we treat it as a real stop. */
const BOUNDARY_TAIL = new Set([' ', '\t', '\n', '\r', '"', "'", '”', '’', ')', ']', '*', '_', '`', '#'])

function previousWord(text: string, end: number): string {
  let i = end - 1
  while (i >= 0 && /[a-zA-Z]/.test(text[i])) i -= 1
  return text.slice(i + 1, end).toLowerCase()
}

function isAbbreviation(text: string, dot: number): boolean {
  const before = text[dot - 1] ?? ''
  const after = text[dot + 1] ?? ''
  // "1.5" and "v2.0" are numbers, not sentence ends.
  if (/[\d]/.test(before) && /[\d]/.test(after)) return true
  if (!/[a-zA-Z]/.test(before)) return false
  // "e.g." and "U.S." hold letters together with no space between them.
  if (/[a-zA-Z]/.test(after)) return true
  const word = previousWord(text, dot)
  if (ABBREVIATIONS.has(word)) return true
  // A single letter after a dot is the tail of an initialism: "the U.S. Navy".
  return word.length === 1 && text[dot - 2] === '.'
}

function boundaryAt(text: string, i: number): boolean {
  const ch = text[i]
  if (ch === '\n') return true
  if (!TERMINATORS.includes(ch)) return false
  if (ch === '.' && isAbbreviation(text, i)) return false
  // Consecutive marks ("!?", "...") belong to the same sentence end.
  let j = i + 1
  while (j < text.length && (TERMINATORS.includes(text[j]) || text[j] === ')' || text[j] === '"' || text[j] === '”')) j += 1
  const tail = j < text.length ? text[j] : ''
  return tail === '' || BOUNDARY_TAIL.has(tail)
}

export type SpeakableSplit = {
  /** Whole sentences that are ready to synthesise, in reply order. */
  sentences: string[]
  /** How much of `text` has been accounted for; pass back on the next call. */
  consumed: number
}

/**
 * @param text the reply as it has arrived so far
 * @param consumed offset already released by an earlier call
 * @param minChars shortest chunk worth a request of its own
 */
export function speakableSentences(text: string, consumed = 0, minChars = 28): SpeakableSplit {
  const sentences: string[] = []
  let start = Math.max(0, Math.min(consumed, text.length))
  let i = start
  while (i < text.length) {
    if (boundaryAt(text, i)) {
      const chunk = text.slice(start, i + 1).trim()
      if (chunk.length >= minChars) {
        sentences.push(chunk)
        // Space around a boundary is not speech, so the next sentence starts clean.
        start = i + 1
        while (start < text.length && /\s/.test(text[start])) start += 1
      }
    }
    i = Math.max(i + 1, start)
  }
  return { sentences, consumed: start }
}

/** Everything still buffered once the reply is finished. */
export function remainingSpeech(text: string, consumed: number): string {
  return text.slice(Math.min(Math.max(consumed, 0), text.length))
}
