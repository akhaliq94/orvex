import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SILENCE_SECS,
  MAX_CHUNK_BYTES,
  MODEL,
  SAMPLE_RATE,
  isKeyRefusal,
  openSession,
  realtimeUrl,
} from '../../electron/eleven-realtime.cjs'

const ORIGIN = 'https://api.elevenlabs.io'

/** Minimal stand-in for the `ws` client so the protocol can be driven by hand. */
class FakeSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 3

  constructor(url, options) {
    this.url = url
    this.options = options
    this.readyState = FakeSocket.CONNECTING
    this.handlers = {}
    this.sent = []
    this.closedWith = null
    this.closedCount = 0
    this.terminated = false
    FakeSocket.last = this
  }

  on(event, handler) {
    this.handlers[event] = handler
  }

  open() {
    this.readyState = FakeSocket.OPEN
  }

  send(raw) {
    this.sent.push(JSON.parse(raw))
  }

  close(code, reason) {
    this.closedWith = { code, reason }
    this.closedCount += 1
    this.readyState = FakeSocket.CLOSED
  }

  terminate() {
    this.terminated = true
    this.readyState = FakeSocket.CLOSED
  }

  message(value) {
    this.handlers.message?.(JSON.stringify(value))
  }
}

function startSession(overrides = {}) {
  const events = []
  const session = openSession({
    key: 'K',
    origin: ORIGIN,
    socketImpl: FakeSocket,
    onEvent: (event) => events.push(event),
    ...overrides,
  })
  session.ready.catch(() => {})
  const socket = FakeSocket.last
  socket.open()
  return { session, socket, events }
}

function begin() {
  const context = startSession()
  context.socket.message({ message_type: 'session_started', session_id: 'sess_1', config: { sample_rate: 16000, model_id: MODEL, commit_strategy: 'vad' } })
  return context
}

describe('realtime speech endpoint', () => {
  it('opens the Scribe realtime socket with 16 kHz PCM and VAD commits', () => {
    const url = new URL(realtimeUrl(ORIGIN))
    expect(url.protocol).toBe('wss:')
    expect(`${url.origin}${url.pathname}`).toBe('wss://api.elevenlabs.io/v1/speech-to-text/realtime')
    expect(url.searchParams.get('model_id')).toBe(MODEL)
    expect(url.searchParams.get('audio_format')).toBe('pcm_16000')
    expect(url.searchParams.get('commit_strategy')).toBe('vad')
    expect(Number(url.searchParams.get('vad_silence_threshold_secs'))).toBe(DEFAULT_SILENCE_SECS)
    expect(SAMPLE_RATE).toBe(16000)
  })

  it('refuses an endpoint that is not https', () => {
    expect(() => realtimeUrl('http://localhost:8000')).toThrow(/https/)
  })

  it('passes timing knobs through and clamps the silence window', () => {
    const url = new URL(
      realtimeUrl(ORIGIN, { silenceSecs: 99, threshold: 0.4, minSpeechMs: 120.6, minSilenceMs: 300, language: 'en', commitStrategy: 'manual' }),
    )
    expect(url.searchParams.get('vad_silence_threshold_secs')).toBe('5')
    expect(url.searchParams.get('vad_threshold')).toBe('0.4')
    expect(url.searchParams.get('min_speech_duration_ms')).toBe('121')
    expect(url.searchParams.get('min_silence_duration_ms')).toBe('300')
    expect(url.searchParams.get('language_code')).toBe('en')
    expect(url.searchParams.get('commit_strategy')).toBe('manual')
  })

  it('sends the key as a header, never in the URL', () => {
    const { socket } = startSession()
    expect(socket.options.headers['xi-api-key']).toBe('K')
    expect(socket.url).not.toContain('K')
    expect(socket.options.maxPayload).toBe(1024 * 1024)
  })

  it('needs a key before it opens anything', () => {
    expect(() => openSession({ key: '  ', origin: ORIGIN, socketImpl: FakeSocket })).toThrow(/ElevenLabs key/)
  })
})

describe('realtime session protocol', () => {
  it('resolves ready with the service config', async () => {
    const { session, events } = begin()
    await expect(session.ready).resolves.toEqual({ sessionId: 'sess_1', config: { sample_rate: 16000, model_id: MODEL, commit_strategy: 'vad' } })
    expect(events[0]).toEqual({ type: 'ready', sessionId: 'sess_1', sampleRate: 16000, model: MODEL, commitStrategy: 'vad' })
    expect(session.open).toBe(true)
  })

  it('forwards partial and committed transcripts', () => {
    const { socket, events } = begin()
    socket.message({ message_type: 'partial_transcript', text: 'what is the' })
    socket.message({ message_type: 'committed_transcript', text: 'what is the weather' })
    socket.message({ message_type: 'committed_transcript_with_timestamps', text: 'what is the weather' })
    expect(events.slice(1)).toEqual([
      { type: 'partial', text: 'what is the' },
      { type: 'committed', text: 'what is the weather' },
      { type: 'committed', text: 'what is the weather' },
    ])
  })

  it('turns warnings into non-fatal events', async () => {
    const { session, socket, events } = begin()
    await session.ready
    socket.message({ message_type: 'warning', warning: 'audio ahead of realtime' })
    expect(events.at(-1)).toEqual({ type: 'warning', message: 'audio ahead of realtime' })
    expect(session.open).toBe(true)
  })

  it('keeps the HTTP status of a refusal so the key pool can rotate', async () => {
    const { session, socket, events } = startSession()
    socket.message({ message_type: 'auth_error', error: 'invalid api key' })
    await expect(session.ready).rejects.toMatchObject({ status: 401, code: 'auth_error' })
    expect(events.at(-1)).toMatchObject({ type: 'error', error: 'auth_error' })
    expect(socket.closedWith).toEqual({ code: 1000, reason: 'refused' })
    expect(session.open).toBe(false)
  })

  it('maps quota and rate refusals', async () => {
    const quota = startSession()
    quota.socket.message({ message_type: 'quota_exceeded', error: 'no credits' })
    await expect(quota.session.ready).rejects.toMatchObject({ status: 402 })

    const slow = startSession()
    slow.socket.message({ message_type: 'rate_limited', error: 'too fast' })
    await expect(slow.session.ready).rejects.toMatchObject({ status: 429 })

    expect(isKeyRefusal('auth_error')).toBe(true)
    expect(isKeyRefusal('quota_exceeded')).toBe(true)
    expect(isKeyRefusal('rate_limited')).toBe(true)
    expect(isKeyRefusal('transcriber_error')).toBe(false)
  })

  it('rejects an unrecognised error without a key status', async () => {
    const { session, socket } = startSession()
    socket.message({ message_type: 'transcriber_error', error: 'engine hiccup' })
    await expect(session.ready).rejects.toMatchObject({ code: 'transcriber_error', status: 0 })
  })
})

describe('sending microphone audio', () => {
  it('base64-encodes each chunk with the commit flag and rate', async () => {
    const { session, socket } = begin()
    await session.ready
    const pcm = Buffer.alloc(3200, 7)
    expect(session.send(pcm)).toEqual({ sent: true, bytes: 3200 })
    expect(socket.sent[0]).toEqual({
      message_type: 'input_audio_chunk',
      audio_base_64: pcm.toString('base64'),
      commit: false,
      sample_rate: 16000,
    })
  })

  it('carries a manual commit on a frame of silence', async () => {
    const { session, socket } = begin()
    await session.ready
    session.commit()
    expect(socket.sent[0].commit).toBe(true)
    expect(Buffer.from(socket.sent[0].audio_base_64, 'base64').length).toBe(640)
  })

  it('refuses an oversized chunk', async () => {
    const { session } = begin()
    await session.ready
    expect(() => session.send(Buffer.alloc(MAX_CHUNK_BYTES + 1))).toThrow(/too large/)
  })

  it('refuses to send after close', async () => {
    const { session } = begin()
    await session.ready
    session.close()
    expect(session.open).toBe(false)
    expect(() => session.send(Buffer.alloc(320))).toThrow(/not open/)
  })
})

describe('lifecycle', () => {
  it('reports a socket that closes before the session starts', async () => {
    const { session, socket, events } = startSession()
    socket.handlers.close(1006, 'abnormal')
    await expect(session.ready).rejects.toMatchObject({ code: 'closed' })
    expect(events).toContainEqual({ type: 'closed', code: 1006, message: 'abnormal' })
  })

  it('reports socket errors', async () => {
    const { session, socket, events } = startSession()
    socket.handlers.error(new Error('ECONNRESET'))
    await expect(session.ready).rejects.toMatchObject({ code: 'socket', status: 0 })
    expect(events.at(-1)).toMatchObject({ type: 'error', error: 'socket' })
  })

  it('closes on abort', () => {
    const controller = new AbortController()
    const { session, socket } = startSession({ signal: controller.signal })
    controller.abort()
    expect(socket.closedWith).toEqual({ code: 1000, reason: 'cancelled' })
    expect(session.open).toBe(false)
  })

  it('closes the socket once, however many times close is asked for', async () => {
    const { session, socket } = begin()
    await session.ready
    session.close()
    session.close()
    expect(socket.closedWith).toEqual({ code: 1000, reason: 'client finished' })
    expect(socket.closedCount).toBe(1)
  })
})
