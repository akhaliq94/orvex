import { describe, expect, it } from 'vitest'
import { remainingSpeech, speakableSentences } from '../../src/data/speech-stream'

describe('speakable sentence splitting', () => {
  it('releases a finished sentence and keeps the unfinished rest buffered', () => {
    const first = 'I have found three matching files inside your downloads folder.'
    const partial = 'The largest one is the video'
    const text = `${first} ${partial}`

    const split = speakableSentences(text)

    expect(split.sentences).toEqual([first])
    expect(remainingSpeech(text, split.consumed)).toBe(partial)
  })

  it('releases nothing until a boundary exists', () => {
    expect(speakableSentences('Thinking about your request')).toEqual({ sentences: [], consumed: 0 })
    expect(speakableSentences('')).toEqual({ sentences: [], consumed: 0 })
  })

  it('splits every sentence of a complete reply', () => {
    const text =
      'I opened the settings file and read it. The voice engine is already set to HeyGen, so nothing changed there. Want me to restart the app now?'

    const split = speakableSentences(text)

    expect(split.sentences).toEqual([
      'I opened the settings file and read it.',
      'The voice engine is already set to HeyGen, so nothing changed there.',
      'Want me to restart the app now?',
    ])
    expect(split.consumed).toBe(text.length)
    expect(remainingSpeech(text, split.consumed)).toBe('')
  })

  it('keeps abbreviation dots inside the sentence that owns them', () => {
    const text = 'Please open the file named e.g. report.csv and read the first ten rows. Then tell me what you found.'

    expect(speakableSentences(text).sentences).toEqual([
      'Please open the file named e.g. report.csv and read the first ten rows.',
      'Then tell me what you found.',
    ])
  })

  it.each([
    ['a title and decimals', 'The invoice from Dr. Ahmed lists 1.5 hours of work at 90.00 per hour, which is a fair price.'],
    ['an initialism', 'I checked the U.S. price for the same laptop and it is cheaper here than in our local store.'],
  ])('speaks a sentence holding %s as one piece', (_case, text) => {
    expect(speakableSentences(text).sentences).toEqual([text])
  })

  it('merges a chunk that is too short to be worth its own request', () => {
    const text = 'Yes. I will start the download for you right now.'

    expect(speakableSentences(text, 0, 28).sentences).toEqual([text])
    expect(speakableSentences(text, 0, 4).sentences).toEqual(['Yes.', 'I will start the download for you right now.'])
  })

  it('treats a line break as a boundary', () => {
    const text = 'Here are the files you asked for:\n- report.pdf from last week\n- notes.txt'

    const split = speakableSentences(text)

    expect(split.sentences).toEqual(['Here are the files you asked for:'])
    expect(remainingSpeech(text, split.consumed)).toBe('- report.pdf from last week\n- notes.txt')
  })

  it('walks a growing reply without dropping or repeating words', () => {
    const full =
      'I will open the settings file first. Then I will switch the engine to HeyGen and restart the app for you. Say the word if you want me to keep going.'

    let consumed = 0
    let spoken = ''
    for (let size = 12; size <= full.length; size += 7) {
      const split = speakableSentences(full.slice(0, size), consumed)
      spoken += split.sentences.join('')
      consumed = split.consumed
    }
    spoken += remainingSpeech(full, consumed)

    expect(spoken.replace(/\s+/g, '')).toBe(full.replace(/\s+/g, ''))
  })

  it('clamps the buffered remainder to the reply', () => {
    expect(remainingSpeech('short text', -4)).toBe('short text')
    expect(remainingSpeech('short text', 90)).toBe('')
  })
})
