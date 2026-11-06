import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  asrPresetFor,
  asrPresetPatch,
  hasSpeech,
  isLocalWhisper,
  LOCAL_WHISPER_URL,
  reportSttEndpoint,
  sttTarget,
  transcribeClip,
} from '../../src/data/stt'
import { DEFAULT_VOICE_CONFIG } from '../../src/data/voice'

const cfg = (patch) => ({ ...DEFAULT_VOICE_CONFIG, ...patch })

describe('sttTarget', () => {
  it('prefers an explicit transcription URL over everything else', () => {
    expect(sttTarget(cfg({ engine: 'heygen', asrUrl: 'https://asr.example/v1/audio/transcriptions' }))).toEqual({
      url: 'https://asr.example/v1/audio/transcriptions',
      model: 'whisper-1',
    })
  })

  it('derives the path from a local speech server for local engines', () => {
    expect(sttTarget(cfg({ engine: 'xtts', serverUrl: 'http://localhost:8000/', asrPath: '/v1/audio/transcriptions' }))).toEqual({
      url: 'http://localhost:8000/v1/audio/transcriptions',
      model: 'whisper-1',
    })
  })

  it('does not treat a cloud TTS engine as a transcription endpoint', () => {
    expect(sttTarget(cfg({ engine: 'heygen', serverUrl: 'http://localhost:8000', asrUrl: '' }))).toBeNull()
    expect(sttTarget(cfg({ engine: 'browser', serverUrl: 'http://localhost:8000', asrUrl: '' }))).toBeNull()
  })

  it('returns null when nothing is configured', () => {
    expect(sttTarget(cfg({ engine: 'kokoro', serverUrl: '' }))).toBeNull()
  })

  it('keeps a custom ASR model', () => {
    expect(sttTarget(cfg({ asrUrl: 'http://localhost:9000/transcribe', asrModel: ' whisper-large-v3 ' }))?.model).toBe('whisper-large-v3')
  })

  it('defaults the model to the host, since ElevenLabs has no whisper-1', () => {
    expect(sttTarget(cfg({ asrUrl: 'https://api.elevenlabs.io/v1/speech-to-text', asrModel: '' }))).toEqual({
      url: 'https://api.elevenlabs.io/v1/speech-to-text',
      model: 'scribe_v2',
    })
    expect(sttTarget(cfg({ asrUrl: 'https://api.us.elevenlabs.io/v1/speech-to-text', asrModel: 'scribe_v1' }))?.model).toBe('scribe_v1')
    expect(sttTarget(cfg({ asrUrl: 'https://api.openai.com/v1/audio/transcriptions', asrModel: '' }))?.model).toBe('whisper-1')
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('local Whisper transcription', () => {
  it('only identifies the app-owned loopback service', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      expect(isLocalWhisper({ url: `http://${host}:8079/v1/audio/transcriptions`, model: 'base' })).toBe(true)
    }
    for (const url of ['http://localhost:8000/transcribe', 'https://example.com:8079/transcribe', 'invalid']) {
      expect(isLocalWhisper({ url, model: 'base' })).toBe(false)
    }
  })

  it('gives CPU inference time to finish without changing other endpoints', async () => {
    const transcribe = vi.fn(async () => ({ ok: true, data: { text: 'Hello' } }))
    vi.stubGlobal('window', { orvex: { stt: { transcribe } } })
    const audio = new Blob(['audio'], { type: 'audio/wav' })
    await transcribeClip({ url: 'http://127.0.0.1:8079/v1/audio/transcriptions', model: 'base' }, audio)
    expect(transcribe.mock.calls[0][0].timeoutMs).toBe(120000)
    await transcribeClip({ url: 'https://asr.example/transcribe', model: 'whisper-1' }, audio)
    expect(transcribe.mock.calls[1][0].timeoutMs).toBe(45000)
    await transcribeClip({ url: 'http://localhost:8079/v1/audio/transcriptions', model: 'base' }, audio, { timeoutMs: 9000 })
    expect(transcribe.mock.calls[2][0].timeoutMs).toBe(9000)
  })
})

describe('speech or silence', () => {
  it('accepts any transcript holding letters or digits', () => {
    for (const text of ['hello', 'Open Chrome', '2 plus 2', 'کیسے ہو', 'مر 7']) {
      expect(hasSpeech(text)).toBe(true)
    }
  })

  it('rejects the markers engines use for a quiet clip', () => {
    for (const text of ['', '   ', '[BLANK_AUDIO]', '[Blank Audio]', '(no speech)', '< silence >', '«audio»', '...  , !']) {
      expect(hasSpeech(text)).toBe(false)
    }
  })

  it('keeps a real sentence that merely contains a bracketed aside', () => {
    expect(hasSpeech('Open the [downloads] folder for me')).toBe(true)
  })

  it('reports silence as a clean result, not a failed transcription', async () => {
    const transcribe = vi.fn(async () => ({ ok: true, data: { text: '[BLANK_AUDIO]' } }))
    vi.stubGlobal('window', { orvex: { stt: { transcribe } } })
    const out = await transcribeClip({ url: 'http://127.0.0.1:8079/v1/audio/transcriptions', model: 'base' }, new Blob(['a'], { type: 'audio/wav' }))
    expect(out).toEqual({ ok: true, text: '', detail: 'No speech in that clip.' })
  })
})

describe('speech input presets', () => {
  const GROQ = 'https://api.groq.com/openai/v1/audio/transcriptions'
  const OPENAI = 'https://api.openai.com/v1/audio/transcriptions'
  const ELEVENLABS = 'https://api.elevenlabs.io/v1/speech-to-text'

  it('names the preset a configured endpoint came from', () => {
    expect(asrPresetFor(cfg({ engine: 'browser', asrUrl: '' }))).toBe('local')
    expect(asrPresetFor(cfg({ asrUrl: LOCAL_WHISPER_URL, asrModel: 'tiny.en' }))).toBe('local')
    expect(asrPresetFor(cfg({ asrUrl: `${GROQ}/`, asrModel: 'whisper-large-v3-turbo' }))).toBe('groq')
    expect(asrPresetFor(cfg({ asrUrl: OPENAI, asrModel: 'whisper-1' }))).toBe('openai')
    expect(asrPresetFor(cfg({ asrUrl: ELEVENLABS, asrModel: 'scribe_v2' }))).toBe('elevenlabs')
  })

  it('treats anything hand-tuned as custom', () => {
    expect(asrPresetFor(cfg({ asrUrl: GROQ, asrModel: 'whisper-large-v3' }))).toBe('custom')
    expect(asrPresetFor(cfg({ asrUrl: 'https://asr.example/v1/audio/transcriptions' }))).toBe('custom')
    // derived from a TTS server, so not the app's own transcription service
    expect(asrPresetFor(cfg({ engine: 'xtts', serverUrl: 'http://localhost:8000', asrUrl: '' }))).toBe('custom')
  })

  it('applies an endpoint and its model together', () => {
    expect(asrPresetPatch('groq')).toEqual({ asrUrl: GROQ, asrModel: 'whisper-large-v3-turbo' })
    expect(asrPresetPatch('openai')).toEqual({ asrUrl: OPENAI, asrModel: 'whisper-1' })
    expect(asrPresetPatch('elevenlabs')).toEqual({ asrUrl: ELEVENLABS, asrModel: 'scribe_v2' })
    expect(asrPresetPatch('local')).toEqual({ asrUrl: LOCAL_WHISPER_URL, asrModel: 'base' })
    expect(asrPresetPatch('custom')).toEqual({})
  })

  it('reads back every preset it just wrote', () => {
    for (const id of ['local', 'groq', 'openai', 'elevenlabs']) expect(asrPresetFor(cfg(asrPresetPatch(id)))).toBe(id)
  })
})

describe('reporting the endpoint to the main process', () => {
  it('sends the resolved URL so local Whisper can stand down', () => {
    const setEndpoint = vi.fn(async () => ({ ok: true, data: { local: false } }))
    vi.stubGlobal('window', { orvex: { stt: { setEndpoint } } })
    reportSttEndpoint(cfg({ engine: 'heygen', asrUrl: 'https://api.groq.com/openai/v1/audio/transcriptions' }))
    expect(setEndpoint).toHaveBeenCalledWith('https://api.groq.com/openai/v1/audio/transcriptions')
  })

  it('sends an empty URL when speech input has nowhere to go', () => {
    const setEndpoint = vi.fn(async () => ({ ok: true, data: { local: true } }))
    vi.stubGlobal('window', { orvex: { stt: { setEndpoint } } })
    reportSttEndpoint(cfg({ engine: 'browser', serverUrl: '', asrUrl: '' }))
    expect(setEndpoint).toHaveBeenCalledWith('')
  })

  it('stays quiet outside the desktop build and on a refused endpoint', () => {
    vi.stubGlobal('window', {})
    expect(() => reportSttEndpoint(cfg({ asrUrl: 'https://api.openai.com/v1/audio/transcriptions' }))).not.toThrow()
    const setEndpoint = vi.fn(async () => {
      throw new Error('blocked')
    })
    vi.stubGlobal('window', { orvex: { stt: { setEndpoint } } })
    expect(() => reportSttEndpoint(cfg({ asrUrl: 'https://169.254.169.254/x' }))).not.toThrow()
  })
})
