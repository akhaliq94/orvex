import { describe, expect, it } from 'vitest'
import { sttTarget } from '../../src/data/stt'
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
})
