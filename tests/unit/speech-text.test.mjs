import { describe, expect, it } from 'vitest'
import { forSpeech } from '../../src/data/speech-text'

describe('forSpeech', () => {
  it('removes emoji that a TTS engine would read as words', () => {
    expect(forSpeech('Hi! 😊 What can I do for you today?')).toBe('Hi! What can I do for you today?')
    expect(forSpeech('Done 🎉🚀')).toBe('Done')
    expect(forSpeech('Thanks 👍🏽')).toBe('Thanks')
  })

  it('removes joined, keycap and flag emoji without leaking pieces', () => {
    expect(forSpeech('family 👨‍👩‍👧‍👦 time')).toBe('family time')
    expect(forSpeech('press 1️⃣ now')).toBe('press now')
    expect(forSpeech('visit 🇵🇰 today')).toBe('visit today')
  })

  it('still strips markdown, links and code', () => {
    expect(forSpeech('**bold** and `code` see [docs](https://x.test)')).toBe('bold and code see docs')
    expect(forSpeech('```\nrm -rf x\n``` keep this')).toBe('keep this')
  })

  it('keeps ordinary punctuation and numbers', () => {
    expect(forSpeech('Step 3: cost is $4.50 (approx).')).toBe('Step 3: cost is $4.50 (approx).')
  })

  it('cuts long speech at a sentence boundary', () => {
    const text = `${'word '.repeat(180)}. Tail.`
    const out = forSpeech(text)
    expect(out.length).toBeLessThanOrEqual(701)
    expect(out.endsWith('…') || out.endsWith('.')).toBe(true)
  })
})
