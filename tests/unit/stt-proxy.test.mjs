import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const proxy = require('../../electron/stt-proxy.cjs')

const audio = new Uint8Array([1, 2, 3, 4, 5, 6])
const fail = (code, message = 'fetch failed') =>
  Object.assign(new TypeError(message), { cause: { code } })
const ok = (text) => new Response(JSON.stringify({ text }), { status: 200, headers: { 'content-type': 'application/json' } })

describe('stt proxy', () => {
  it('returns the transcript from the endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok('hello world'))
    const result = await proxy.transcribeAudio({ url: 'http://127.0.0.1:8000/v1/audio/transcriptions', audio, fetchImpl })
    expect(result).toEqual({ text: 'hello world' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://127.0.0.1:8000/v1/audio/transcriptions')
  })

  it('retries localhost on 127.0.0.1 when the IPv6 attempt is refused', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(fail('ECONNREFUSED'))
      .mockResolvedValueOnce(ok('from ipv4'))
    const result = await proxy.transcribeAudio({ url: 'http://localhost:8000/v1/audio/transcriptions', audio, fetchImpl })
    expect(result.text).toBe('from ipv4')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(String(fetchImpl.mock.calls[1][0])).toBe('http://127.0.0.1:8000/v1/audio/transcriptions')
  })

  it('explains a refused local server instead of saying "fetch failed"', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(fail('ECONNREFUSED'))
    await expect(
      proxy.transcribeAudio({ url: 'http://localhost:8000/v1/audio/transcriptions', audio, fetchImpl }),
    ).rejects.toThrow(/nothing is listening.*127\.0\.0\.1:8000/)
  })

  it('names a DNS failure for a remote host', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(fail('ENOTFOUND'))
    await expect(proxy.transcribeAudio({ url: 'https://asr.invalid/v1/audio/transcriptions', audio, fetchImpl })).rejects.toThrow(
      /host name does not resolve/,
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('passes an HTTP error through without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('bad key', { status: 401 }))
    await expect(proxy.transcribeAudio({ url: 'http://localhost:8000/asr', audio, fetchImpl })).rejects.toThrow(/HTTP 401/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects missing audio and bad URLs before any request', async () => {
    const fetchImpl = vi.fn()
    await expect(proxy.transcribeAudio({ url: 'http://localhost:8000/asr', audio: new Uint8Array(), fetchImpl })).rejects.toThrow(/No audio/i)
    await expect(proxy.transcribeAudio({ url: 'not a url', audio, fetchImpl })).rejects.toThrow(/not valid/i)
    await expect(proxy.transcribeAudio({ url: 'ftp://example.com/asr', audio, fetchImpl })).rejects.toThrow(/http\(s\)/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('speech input dialects', () => {
  it('names the endpoint family by host so the request shape matches', () => {
    expect(proxy.sttProfile('https://api.elevenlabs.io/v1/speech-to-text')).toBe('elevenlabs')
    expect(proxy.sttProfile('https://api.eu.residency.elevenlabs.io/v1/speech-to-text')).toBe('elevenlabs')
    expect(proxy.sttProfile('https://api.groq.com/openai/v1/audio/transcriptions')).toBe('openai')
    expect(proxy.sttProfile('http://127.0.0.1:8079/v1/audio/transcriptions')).toBe('openai')
    expect(proxy.sttProfile('')).toBe('openai')
  })

  it('posts model_id and xi-api-key to ElevenLabs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok('yo'))
    await proxy.transcribeAudio({
      url: 'https://api.elevenlabs.io/v1/speech-to-text',
      key: 'ELV-KEY',
      model: 'scribe_v2_medical',
      audio,
      fetchImpl,
    })
    const [, opts] = fetchImpl.mock.calls[0]
    expect(opts.headers).toEqual({ 'xi-api-key': 'ELV-KEY' })
    expect(opts.body.get('model_id')).toBe('scribe_v2_medical')
    expect(opts.body.get('model')).toBeNull()
  })

  it('keeps the chosen model on an OpenAI-shaped endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok('yo'))
    await proxy.transcribeAudio({
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      key: 'GQ',
      model: 'whisper-large-v3-turbo',
      audio,
      fetchImpl,
    })
    const [, opts] = fetchImpl.mock.calls[0]
    expect(opts.headers).toEqual({ authorization: 'Bearer GQ' })
    expect(opts.body.get('model')).toBe('whisper-large-v3-turbo')
    expect(opts.body.get('model_id')).toBeNull()
  })

  it('sends the language hint under each family\'s field name', async () => {
    const eleven = vi.fn().mockResolvedValue(ok('a'))
    await proxy.transcribeAudio({
      url: 'https://api.elevenlabs.io/v1/speech-to-text',
      audio,
      language: 'ur',
      fetchImpl: eleven,
    })
    expect(eleven.mock.calls[0][1].body.get('language_code')).toBe('ur')
    expect(eleven.mock.calls[0][1].body.get('language')).toBeNull()

    const openai = vi.fn().mockResolvedValue(ok('a'))
    await proxy.transcribeAudio({
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      audio,
      language: 'ur',
      fetchImpl: openai,
    })
    expect(openai.mock.calls[0][1].body.get('language')).toBe('ur')
    expect(openai.mock.calls[0][1].body.get('language_code')).toBeNull()

    // No hint means auto-detect: neither field is sent.
    const bare = vi.fn().mockResolvedValue(ok('a'))
    await proxy.transcribeAudio({
      url: 'https://api.openai.com/v1/audio/transcriptions',
      audio,
      language: '   ',
      fetchImpl: bare,
    })
    expect(bare.mock.calls[0][1].body.get('language')).toBeNull()
  })

  it('falls back to each family default only when no model was typed', async () => {    const eleven = vi.fn().mockResolvedValue(ok('a'))
    await proxy.transcribeAudio({ url: 'https://api.elevenlabs.io/v1/speech-to-text', audio, fetchImpl: eleven })
    expect(eleven.mock.calls[0][1].body.get('model_id')).toBe('scribe_v2')
    expect(eleven.mock.calls[0][1].headers).toEqual({})

    const openai = vi.fn().mockResolvedValue(ok('a'))
    await proxy.transcribeAudio({ url: 'https://api.openai.com/v1/audio/transcriptions', audio, fetchImpl: openai })
    expect(openai.mock.calls[0][1].body.get('model')).toBe('whisper-1')
  })

  it('puts the HTTP status on the error so a dead key is told from a bad request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('quota exceeded', { status: 429 }))
    const err = await proxy
      .transcribeAudio({ url: 'https://api.elevenlabs.io/v1/speech-to-text', key: 'k', audio, fetchImpl })
      .catch((e) => e)
    expect(err.status).toBe(429)
    expect(err.message).toContain('quota exceeded')
  })
})

describe('speech model listing', () => {
  const list = (models) => new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), { status: 200 })

  it('asks the endpoint itself for OpenAI-shaped servers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(list(['whisper-large-v3-turbo', 'llama-3.3-70b']))
    const res = await proxy.listModels({ url: 'https://api.groq.com/openai/v1/audio/transcriptions', key: 'GQ', fetchImpl })
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://api.groq.com/openai/v1/models')
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer GQ')
    expect(res.models).toEqual(['whisper-large-v3-turbo'])
    expect(res.source).toBe('endpoint')
  })

  it('finds /models on a server that is not under /v1', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(['parakeet-tdt']), { status: 200 }))
    const res = await proxy.listModels({ url: 'http://127.0.0.1:8000/asr', fetchImpl })
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://127.0.0.1:8000/models')
    expect(res.models).toEqual(['parakeet-tdt'])
  })

  it('offers the documented Scribe models even when ElevenLabs lists only synthesis voices', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(list(['eleven_turbo_v2', 'eleven_monolingual_v1']))
    const res = await proxy.listModels({ url: 'https://api.elevenlabs.io/v1/speech-to-text', key: 'ELV', fetchImpl })
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://api.elevenlabs.io/v1/models')
    expect(fetchImpl.mock.calls[0][1].headers['xi-api-key']).toBe('ELV')
    expect(res.models).toEqual(proxy.ELEVENLABS_MODELS)
    expect(res.source).toBe('endpoint')
  })

  it('merges what the endpoint reports with the Scribe list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ model_id: 'scribe_v2' }, { id: 'whisper-ish' }] }), { status: 200 }))
    const res = await proxy.listModels({ url: 'https://api.us.elevenlabs.io/v1/speech-to-text', fetchImpl })
    expect(res.models).toEqual(['scribe_v2', 'scribe_v2_medical', 'scribe_v2_realtime', 'scribe_v1', 'whisper-ish'])
  })

  it('returns the full list rather than an empty picker when nothing looks like speech', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(list(['gpt-4o', 'tts-1']))
    const res = await proxy.listModels({ url: 'http://127.0.0.1:8000/v1/audio/transcriptions', fetchImpl })
    expect(res.models).toEqual(['gpt-4o', 'tts-1'])
  })

  it('keeps the status on a listing failure so the pool can rotate keys for it too', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('no', { status: 401 }))
    const err = await proxy.listModels({ url: 'https://api.elevenlabs.io/v1/speech-to-text', key: 'bad', fetchImpl }).catch((e) => e)
    expect(err.status).toBe(401)
  })

  it('refuses a bad URL before asking anything', async () => {
    const fetchImpl = vi.fn()
    await expect(proxy.listModels({ url: 'not a url', fetchImpl })).rejects.toThrow(/not valid/i)
    await expect(proxy.listModels({ url: 'ftp://example.com/v1/models', fetchImpl })).rejects.toThrow(/http\(s\)/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
