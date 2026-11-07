import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MODEL,
  FRAME_BYTES,
  SAMPLE_RATE,
  TTS_MODELS,
  listModels,
  listVoices,
  speakStream,
} from '../../electron/eleven-tts.cjs'

/** A response whose body arrives in the given chunks, one per tick. */
function streamResponse(chunks, { status = 200, contentType = 'audio/pcm' } = {}) {
  const body = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
        await new Promise((r) => setTimeout(r, 0))
      }
      controller.close()
    },
  })
  return { ok: status >= 200 && status < 300, status, headers: new Map([['content-type', contentType]]), body, text: async () => '', json: async () => ({}) }
}

function jsonResponse(value, status = 200) {
  const raw = JSON.stringify(value)
  return { ok: status >= 200 && status < 300, status, headers: new Map(), body: null, text: async () => raw, json: async () => value }
}

const pcm = (bytes, fill = 1) => new Uint8Array(bytes).fill(fill)
const decode = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))

describe('ElevenLabs speech stream', () => {
  it('asks for raw PCM with the latency optimisation and the chosen model', async () => {
    const calls = []
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init })
      return streamResponse([pcm(FRAME_BYTES)])
    })
    const out = await speakStream({ key: 'K', text: 'Hello there', voiceId: 'voice123', model: 'eleven_turbo_v2_5', fetchImpl })
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice123/stream?output_format=pcm_24000&optimize_streaming_latency=3')
    expect(calls[0].init.headers['xi-api-key']).toBe('K')
    const body = JSON.parse(calls[0].init.body)
    expect(body.model_id).toBe('eleven_turbo_v2_5')
    expect(body.text).toBe('Hello there')
    expect(out).toMatchObject({ model: 'eleven_turbo_v2_5', voiceId: 'voice123', frames: 1, sampleRate: SAMPLE_RATE })
  })

  it('defaults to the low-latency model when none is chosen', async () => {
    const fetchImpl = vi.fn(async () => streamResponse([pcm(FRAME_BYTES)]))
    const out = await speakStream({ key: 'K', text: 'Hi', voiceId: 'v1', fetchImpl })
    expect(out.model).toBe(DEFAULT_MODEL)
    expect(DEFAULT_MODEL).toBe('eleven_flash_v2_5')
  })

  it('cuts the stream into 100 ms frames in order', async () => {
    const frames = []
    const total = FRAME_BYTES * 3 + 1000
    const fetchImpl = async () => streamResponse([pcm(total, 7)])
    const out = await speakStream({
      key: 'K',
      text: 'A longer sentence that spans several frames.',
      voiceId: 'v1',
      fetchImpl,
      onAudio: (part) => frames.push(part),
    })
    expect(frames.map((f) => f.index)).toEqual([0, 1, 2, 3])
    expect(decode(frames[0].audio).length).toBe(FRAME_BYTES)
    expect(decode(frames[3].audio).length).toBe(1000)
    expect(frames.every((f) => f.sampleRate === SAMPLE_RATE)).toBe(true)
    expect(out.bytes).toBe(total)
    expect(out.duration).toBeCloseTo(total / 2 / SAMPLE_RATE, 5)
  })

  it('hands over the first frame before the rest of the audio has arrived', async () => {
    let delivered = 0
    let closed = false
    const body = new ReadableStream({
      async start(controller) {
        controller.enqueue(pcm(FRAME_BYTES))
        // the consumer must already have been called by the time we continue
        await new Promise((r) => setTimeout(r, 5))
        expect(delivered).toBe(1)
        controller.enqueue(pcm(FRAME_BYTES))
        closed = true
        controller.close()
      },
    })
    const fetchImpl = async () => ({ ok: true, status: 200, headers: new Map(), body, text: async () => '' })
    await speakStream({
      key: 'K',
      text: 'Streaming',
      voiceId: 'v1',
      fetchImpl,
      onAudio: () => {
        delivered += 1
      },
    })
    expect(closed).toBe(true)
    expect(delivered).toBe(2)
  })

  it('pads an odd tail so every frame stays 16-bit aligned', async () => {
    const frames = []
    const fetchImpl = async () => streamResponse([pcm(FRAME_BYTES + 1, 3)])
    await speakStream({ key: 'K', text: 'Hi', voiceId: 'v1', fetchImpl, onAudio: (p) => frames.push(p) })
    expect(decode(frames[1].audio).length).toBe(2)
  })

  it('keeps the provider status on a refusal so the key pool can rotate', async () => {
    for (const status of [401, 402, 429]) {
      const fetchImpl = async () => ({
        ok: false,
        status,
        headers: new Map(),
        body: null,
        text: async () => JSON.stringify({ detail: { message: 'quota exceeded', status: 'quota_exceeded' } }),
      })
      await expect(speakStream({ key: 'K', text: 'Hi', voiceId: 'v1', fetchImpl })).rejects.toMatchObject({ status })
    }
  })

  it('reports a server failure without a status, so it is not treated as a dead key', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, headers: new Map(), body: null, text: async () => 'boom' })
    const err = await speakStream({ key: 'K', text: 'Hi', voiceId: 'v1', fetchImpl }).catch((e) => e)
    expect(err.status).toBe(500)
    expect(err.message).toContain('HTTP 500')
  })

  it('stops reading when the caller aborts', async () => {
    const controller = new AbortController()
    let pulled = 0
    const body = new ReadableStream({
      async pull(ctrl) {
        pulled += 1
        if (pulled === 2) controller.abort()
        ctrl.enqueue(pcm(FRAME_BYTES))
        await new Promise((r) => setTimeout(r, 1))
      },
    })
    const fetchImpl = async () => ({ ok: true, status: 200, headers: new Map(), body, text: async () => '' })
    const err = await speakStream({ key: 'K', text: 'Hi', voiceId: 'v1', signal: controller.signal, fetchImpl }).catch((e) => e)
    expect(err.name).toBe('AbortError')
    expect(pulled).toBeLessThan(6)
  })

  it('refuses to speak when nothing came back', async () => {
    const fetchImpl = async () => streamResponse([])
    await expect(speakStream({ key: 'K', text: 'Hi', voiceId: 'v1', fetchImpl })).rejects.toThrow(/no audio/i)
  })

  it('validates the key, voice, text and speed before calling the endpoint', async () => {
    const fetchImpl = vi.fn()
    await expect(speakStream({ text: 'Hi', voiceId: 'v1', fetchImpl })).rejects.toThrow(/key/i)
    await expect(speakStream({ key: 'K', text: 'Hi', voiceId: 'not a voice', fetchImpl })).rejects.toThrow(/voice id/i)
    await expect(speakStream({ key: 'K', text: '   ', voiceId: 'v1', fetchImpl })).rejects.toThrow(/nothing to say/i)
    await expect(speakStream({ key: 'K', text: 'x'.repeat(5001), voiceId: 'v1', fetchImpl })).rejects.toThrow(/5000 characters/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('clamps speed into the range the endpoint accepts', async () => {
    let body = null
    const fetchImpl = async (_url, init) => {
      body = JSON.parse(init.body)
      return streamResponse([pcm(FRAME_BYTES)])
    }
    await speakStream({ key: 'K', text: 'Hi', voiceId: 'v1', speed: 4, fetchImpl })
    expect(body.voice_settings.speed).toBe(1.2)
    await speakStream({ key: 'K', text: 'Hi', voiceId: 'v1', speed: 0.1, fetchImpl })
    expect(body.voice_settings.speed).toBe(0.7)
    await speakStream({ key: 'K', text: 'Hi', voiceId: 'v1', speed: 1, fetchImpl })
    expect(body.voice_settings.speed).toBe(1)
  })

  it('waits for the consumer before pulling the next frame', async () => {
    const order = []
    const fetchImpl = async () => streamResponse([pcm(FRAME_BYTES * 2)])
    await speakStream({
      key: 'K',
      text: 'Hi',
      voiceId: 'v1',
      fetchImpl,
      onAudio: async (part) => {
        order.push(`start${part.index}`)
        await new Promise((r) => setTimeout(r, 2))
        order.push(`end${part.index}`)
      },
    })
    expect(order).toEqual(['start0', 'end0', 'start1', 'end1'])
  })
})

describe('ElevenLabs voice and model listing', () => {
  it('maps the account voices and drops rows without an id', async () => {
    const fetchImpl = async () =>
      jsonResponse({
        voices: [
          { voice_id: 'abc', name: 'Rachel', category: 'premade', labels: { accent: 'american', gender: 'female' } },
          { name: 'no id' },
          { voice_id: 'def', name: 'Custom', category: 'cloned' },
        ],
      })
    const out = await listVoices({ key: 'K', fetchImpl })
    expect(out.voices).toHaveLength(2)
    expect(out.voices[0]).toMatchObject({ voiceId: 'abc', name: 'Rachel', category: 'premade' })
    expect(out.voices[0].labels.accent).toBe('american')
    expect(out.endpoint).toBe('https://api.elevenlabs.io/v1/voices')
  })

  it('keeps only models that can speak, and still offers the fast ones', async () => {
    const fetchImpl = async () =>
      jsonResponse([
        { model_id: 'eleven_flash_v2_5', can_do_text_to_speech: true },
        { model_id: 'scribe_v2', can_do_text_to_speech: false },
        { model_id: 'eleven_multilingual_v2', can_do_text_to_speech: true },
        { model_id: 'account_only_tts', can_do_text_to_speech: true },
      ])
    const out = await listModels({ key: 'K', fetchImpl })
    expect(out.models).toContain('eleven_flash_v2_5')
    expect(out.models).toContain('account_only_tts')
    expect(out.models).not.toContain('scribe_v2')
    expect(out.source).toBe('endpoint')
  })

  it('falls back to the built-in speech models when the listing is empty', async () => {
    const fetchImpl = async () => jsonResponse([])
    const out = await listModels({ key: 'K', fetchImpl })
    expect(out.models).toEqual(TTS_MODELS)
    expect(out.source).toBe('built-in list')
  })

  it('needs a key for both listings', async () => {
    await expect(listVoices({ fetchImpl: vi.fn() })).rejects.toThrow(/key/i)
    await expect(listModels({ fetchImpl: vi.fn() })).rejects.toThrow(/key/i)
  })
})