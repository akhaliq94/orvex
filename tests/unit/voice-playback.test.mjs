import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginReplySpeech, DEFAULT_VOICE_CONFIG, speak, stopSpeaking } from '../../src/data/voice'

const STOPPED = { ok: true, detail: 'stopped' }
const voice = { name: 'Test voice', lang: 'en-US', default: true }
const config = (engine) => ({ ...DEFAULT_VOICE_CONFIG, engine })
const heygenResponse = (id = 'clip') => ({
  ok: true,
  data: { asset: { id }, model: 'test-model', voiceId: 'test-voice', duration: 1 },
})
const audioResponse = () => ({ ok: true, blob: vi.fn().mockResolvedValue(new Blob(['audio'])) })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const flush = () => vi.advanceTimersByTimeAsync(0)

// A standalone, mono PCM WAV with one sample; each chunk is independently playable.
const wavChunk = (sample = 1) => {
  const wav = Buffer.alloc(46)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(38, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(24000, 24)
  wav.writeUInt32LE(48000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(2, 40)
  wav.writeInt16LE(sample, 44)
  return wav.toString('base64')
}

let audios, synth, media, playResult, listeners

function emitChunk(index = 0, audio = wavChunk(), id = media.heygenTtsStream.mock.lastCall[0].id) {
  for (const listener of listeners) listener({ id, index, audio })
}

beforeEach(() => {
  vi.useFakeTimers()
  audios = []
  listeners = new Set()
  playResult = Promise.resolve()
  synth = Object.assign(new EventTarget(), {
    getVoices: vi.fn(() => [voice]),
    speak: vi.fn(),
    // Some browsers emit neither onend nor onerror when explicitly cancelled.
    cancel: vi.fn(),
    speaking: false,
  })
  media = {
    heygenTtsStream: vi.fn(({ id }) => {
      emitChunk(0, wavChunk(), id)
      return Promise.resolve(heygenResponse())
    }),
    onHeygenAudio: vi.fn((cb) => {
      listeners.add(cb)
      return vi.fn(() => listeners.delete(cb))
    }),
    stopHeygenTts: vi.fn().mockResolvedValue({ ok: true, data: { stopped: true } }),
    heygenTts: vi.fn(),
    assetUrl: vi.fn(),
  }
  vi.stubGlobal('crypto', { randomUUID: vi.fn(randomUUID) })
  vi.stubGlobal('window', {
    speechSynthesis: synth,
    orvex: { media },
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (id) => clearTimeout(id),
  })
  vi.stubGlobal('SpeechSynthesisUtterance', class {
    constructor(text) { this.text = text }
  })
  vi.stubGlobal('Audio', class {
    constructor(src) {
      this.src = src
      this.play = vi.fn(() => {
        if (playResult instanceof Error) throw playResult
        return playResult
      })
      this.pause = vi.fn()
      audios.push(this)
    }
  })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(audioResponse()))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-voice')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(() => {
  stopSpeaking()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function playback(engine, index = 0) {
  return engine === 'browser' ? synth.speak.mock.calls[index][0] : audios[index]
}

function start(engine, target) {
  if (engine === 'browser') target.onstart()
  else target.onplaying()
}

function end(engine, target) {
  if (engine === 'browser') target.onend()
  else target.onended()
}

function fail(engine, target) {
  if (engine === 'browser') target.onerror({ error: 'interrupted' })
  else target.onerror()
}

describe('speech synthesis cancellation', () => {
  it.each(['success', 'failure', 'rejection'])('ignores delayed HeyGen %s after stop', async (outcome) => {
    const request = deferred()
    media.heygenTtsStream.mockReturnValue(request.promise)
    const onPlaybackStart = vi.fn()
    const pending = speak('Old reply', config('heygen'), onPlaybackStart)

    const { id } = media.heygenTtsStream.mock.lastCall[0]
    const staleListener = media.onHeygenAudio.mock.lastCall[0]
    stopSpeaking()
    // Do not resolve main first: cancellation must settle independently of IPC.
    await expect(pending).resolves.toEqual(STOPPED)
    expect(media.stopHeygenTts).toHaveBeenCalledExactlyOnceWith(id)
    expect(listeners.size).toBe(0)
    staleListener({ id, index: 0, audio: wavChunk() })
    if (outcome === 'rejection') request.reject(new Error('late network error'))
    else request.resolve(outcome === 'success' ? heygenResponse() : { ok: false, error: 'late failure' })
    await flush()

    expect(audios).toHaveLength(0)
    expect(media.assetUrl).not.toHaveBeenCalled()
    expect(onPlaybackStart).not.toHaveBeenCalled()
  })

  it.each(['success', 'failure', 'rejection'])('a new speak survives old HeyGen %s cleanup', async (outcome) => {
    const oldRequest = deferred()
    const newRequest = deferred()
    media.heygenTtsStream.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise)
    const oldStart = vi.fn()
    const oldSpeech = speak('Old reply', config('heygen'), oldStart)
    const oldId = media.heygenTtsStream.mock.lastCall[0].id
    const oldListener = media.onHeygenAudio.mock.lastCall[0]
    const newSpeech = speak('New reply', config('heygen'))
    const newId = media.heygenTtsStream.mock.lastCall[0].id

    await expect(oldSpeech).resolves.toEqual(STOPPED)
    expect(oldId).not.toBe(newId)
    expect(crypto.randomUUID).toHaveBeenCalledTimes(2)
    emitChunk(0, wavChunk(), oldId)
    oldListener({ id: oldId, index: 0, audio: wavChunk() })
    expect(audios).toHaveLength(0)
    emitChunk()
    await flush()
    expect(audios).toHaveLength(1)
    if (outcome === 'rejection') oldRequest.reject(new Error('late failure'))
    else oldRequest.resolve(outcome === 'success' ? heygenResponse('old') : { ok: false, error: 'late failure' })
    await flush()
    expect(audios).toHaveLength(1)
    expect(audios[0].pause).not.toHaveBeenCalled()
    expect(oldStart).not.toHaveBeenCalled()
    expect(media.stopHeygenTts).toHaveBeenCalledExactlyOnceWith(oldId)
    expect(listeners.size).toBe(1)

    stopSpeaking()
    await expect(newSpeech).resolves.toEqual(STOPPED)
    expect(media.stopHeygenTts).toHaveBeenLastCalledWith(newId)
    expect(audios[0].pause).toHaveBeenCalledOnce()
    newRequest.resolve(heygenResponse('new'))
    await flush()
  })

  it.each(['success', 'failure', 'rejection'])('ignores a pending local fetch %s after stop', async (outcome) => {
    const request = deferred()
    fetch.mockReturnValue(request.promise)
    const pending = speak('Local reply', config('kokoro'))
    stopSpeaking()

    const response = audioResponse()
    if (outcome === 'rejection') request.reject(new Error('late fetch error'))
    else request.resolve(outcome === 'success' ? response : { ok: false, status: 500 })

    await expect(pending).resolves.toEqual(STOPPED)
    expect(response.blob).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(audios).toHaveLength(0)
  })

  it.each(['audio', 'empty', 'rejection'])('ignores a delayed local %s body after stop', async (outcome) => {
    const body = deferred()
    const response = { ok: true, blob: vi.fn(() => body.promise) }
    fetch.mockResolvedValue(response)
    const pending = speak('Local reply', config('kokoro'))
    await flush()
    expect(response.blob).toHaveBeenCalledOnce()
    stopSpeaking()

    if (outcome === 'rejection') body.reject(new Error('late body error'))
    else body.resolve(new Blob(outcome === 'empty' ? [] : ['audio']))

    await expect(pending).resolves.toEqual(STOPPED)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(audios).toHaveLength(0)
  })

  it('suppresses a local HTTP error whose body arrives after cancellation', async () => {
    const body = deferred()
    const response = { ok: false, status: 500, text: vi.fn(() => body.promise) }
    fetch.mockResolvedValue(response)
    const pending = speak('Local reply', config('kokoro'))
    await flush()
    expect(response.text).toHaveBeenCalledOnce()
    stopSpeaking()
    body.resolve('late server error')
    await expect(pending).resolves.toEqual(STOPPED)
  })

  it.each(['voiceschanged', 'timeout'])('does not speak after cancelled voice-list loading (%s)', async (event) => {
    synth.getVoices.mockReturnValue([])
    const onPlaybackStart = vi.fn()
    const pending = speak('Browser reply', config('browser'), onPlaybackStart)
    stopSpeaking()
    synth.getVoices.mockReturnValue([voice])
    if (event === 'voiceschanged') synth.dispatchEvent(new Event('voiceschanged'))
    else await vi.advanceTimersByTimeAsync(900)

    await expect(pending).resolves.toEqual(STOPPED)
    expect(synth.speak).not.toHaveBeenCalled()
    expect(onPlaybackStart).not.toHaveBeenCalled()
  })

  it('a new local speak supersedes a pending browser voice list', async () => {
    synth.getVoices.mockReturnValue([])
    const oldSpeech = speak('Old browser reply', config('browser'))
    const newSpeech = speak('New local reply', config('kokoro'))
    await flush()
    synth.getVoices.mockReturnValue([voice])
    synth.dispatchEvent(new Event('voiceschanged'))
    await expect(oldSpeech).resolves.toEqual(STOPPED)
    expect(synth.speak).not.toHaveBeenCalled()
    expect(audios).toHaveLength(1)
    expect(audios[0].pause).not.toHaveBeenCalled()
    stopSpeaking()
    await expect(newSpeech).resolves.toEqual(STOPPED)
  })
})

describe('HeyGen incremental WAV streaming', () => {
  it('subscribes before starting, plays before IPC resolves, and waits for the last ordered chunk', async () => {
    const request = deferred()
    media.heygenTtsStream.mockImplementation(({ id }) => {
      expect(listeners.size).toBe(1)
      emitChunk(0, wavChunk(1), id)
      return request.promise
    })
    const onPlaybackStart = vi.fn()
    const cfg = { ...config('heygen'), heygenVoiceId: ' configured-voice ', heygenModel: 'configured-model', heygenLanguage: ' ur ', speed: 1.2 }
    const pending = speak('Stream this reply', cfg, onPlaybackStart)
    const settled = vi.fn()
    void pending.then(settled)
    expect(media.heygenTtsStream).toHaveBeenCalledExactlyOnceWith({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      text: 'Stream this reply', voiceId: 'configured-voice', model: 'configured-model', language: 'ur', speed: 1.2,
    })
    expect(audios).toHaveLength(1)
    expect(audios[0].play).toHaveBeenCalledOnce()
    expect(onPlaybackStart).not.toHaveBeenCalled()
    audios[0].onplaying()
    audios[0].onplaying()
    emitChunk(1, wavChunk(2))
    await flush()
    expect(audios).toHaveLength(1)
    expect(settled).not.toHaveBeenCalled()

    request.resolve(heygenResponse())
    await flush()
    expect(audios).toHaveLength(1)
    expect(settled).not.toHaveBeenCalled()
    audios[0].onended()
    await flush()
    expect(audios).toHaveLength(2)
    expect(audios[1].play).toHaveBeenCalledOnce()
    audios[1].onplaying()
    expect(onPlaybackStart).toHaveBeenCalledOnce()
    expect(settled).not.toHaveBeenCalled()
    const blobs = URL.createObjectURL.mock.calls.map(([blob]) => blob)
    expect(blobs.map((blob) => blob.type)).toEqual(['audio/wav', 'audio/wav'])
    expect(await Promise.all(blobs.map(async (blob) => Buffer.from(await blob.arrayBuffer()).toString('base64'))))
      .toEqual([wavChunk(1), wavChunk(2)])

    audios[1].onended()
    await expect(pending).resolves.toEqual({ ok: true, detail: 'Spoken via HeyGen test-model · 1.0s' })
    const staleListener = media.onHeygenAudio.mock.lastCall[0]
    staleListener({ id: media.heygenTtsStream.mock.lastCall[0].id, index: 2, audio: wavChunk(3) })
    await flush()
    expect(audios).toHaveLength(2)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(listeners.size).toBe(0)
    expect(media.onHeygenAudio.mock.results[0].value).toHaveBeenCalledOnce()
    stopSpeaking()
    expect(media.stopHeygenTts).not.toHaveBeenCalled()
    expect(media.heygenTts).not.toHaveBeenCalled()
    expect(media.assetUrl).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(synth.speak).not.toHaveBeenCalled()
  })

  it('waits for archival after playback finishes and starts a later chunk across a gap', async () => {
    const request = deferred()
    media.heygenTtsStream.mockReturnValue(request.promise)
    const pending = speak('Reply', config('heygen'))
    const settled = vi.fn()
    void pending.then(settled)
    emitChunk()
    audios[0].onended()
    await flush()
    expect(settled).not.toHaveBeenCalled()
    emitChunk(1)
    expect(audios).toHaveLength(2)
    audios[1].onended()
    await flush()
    expect(settled).not.toHaveBeenCalled()
    request.resolve(heygenResponse())
    await expect(pending).resolves.toMatchObject({ ok: true, detail: expect.stringContaining('Spoken') })
    expect(media.stopHeygenTts).not.toHaveBeenCalled()
  })

  it('stops promptly between chunks or during archival even if both IPC promises never settle', async () => {
    const request = deferred()
    media.heygenTtsStream.mockReturnValue(request.promise)
    media.stopHeygenTts.mockReturnValue(new Promise(() => {}))
    const pending = speak('Reply', config('heygen'))
    const { id } = media.heygenTtsStream.mock.lastCall[0]
    const staleListener = media.onHeygenAudio.mock.lastCall[0]
    emitChunk()
    audios[0].onended()
    await flush()
    stopSpeaking()
    await expect(pending).resolves.toEqual(STOPPED)
    expect(media.stopHeygenTts).toHaveBeenCalledExactlyOnceWith(id)
    staleListener({ id, index: 1, audio: wavChunk() })
    await flush()
    expect(audios).toHaveLength(1)
    expect(listeners.size).toBe(0)
  })

  it.each(['streaming', 'archived'])('cancels active and queued chunks when %s', async (phase) => {
    const request = deferred()
    media.heygenTtsStream.mockReturnValue(request.promise)
    const onPlaybackStart = vi.fn()
    const pending = speak('Reply', config('heygen'), onPlaybackStart)
    const { id } = media.heygenTtsStream.mock.lastCall[0]
    emitChunk()
    emitChunk(1)
    emitChunk(2)
    audios[0].onplaying()
    if (phase === 'archived') request.resolve(heygenResponse())
    await flush()
    expect(audios).toHaveLength(1)
    stopSpeaking()
    await expect(pending).resolves.toEqual(STOPPED)
    expect(media.stopHeygenTts).toHaveBeenCalledExactlyOnceWith(id)
    expect(audios[0].pause).toHaveBeenCalledOnce()
    expect(audios[0].src).toBe('')
    audios[0].onended()
    emitChunk(3)
    if (phase === 'streaming') request.resolve(heygenResponse())
    await flush()
    expect(audios).toHaveLength(1)
    expect(onPlaybackStart).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
    expect(listeners.size).toBe(0)
  })

  it('stops between an ended event and the queued playback microtask', async () => {
    const request = deferred()
    media.heygenTtsStream.mockReturnValue(request.promise)
    const pending = speak('Reply', config('heygen'))
    emitChunk()
    emitChunk(1)
    audios[0].onended()
    stopSpeaking()
    await expect(pending).resolves.toEqual(STOPPED)
    await flush()
    expect(audios).toHaveLength(1)
    expect(media.stopHeygenTts).toHaveBeenCalledOnce()
  })

  it.each(['heygen', 'kokoro', 'browser'])('new %s speech wins over an active HeyGen queue and late failure', async (engine) => {
    const request = deferred()
    media.heygenTtsStream.mockReturnValueOnce(request.promise)
    const oldSpeech = speak('Old reply', config('heygen'))
    const { id } = media.heygenTtsStream.mock.lastCall[0]
    emitChunk()
    emitChunk(1)
    const oldAudio = audios[0]
    const newSpeech = speak('New reply', config(engine))
    await expect(oldSpeech).resolves.toEqual(STOPPED)
    await flush()
    const newPlayback = playback(engine, engine === 'browser' ? 0 : 1)
    request.reject(new Error('late incomplete stream'))
    oldAudio.onended()
    oldAudio.onerror()
    emitChunk(2, wavChunk(), id)
    await flush()
    expect(media.stopHeygenTts).toHaveBeenCalledExactlyOnceWith(id)
    if (engine !== 'browser') expect(newPlayback.pause).not.toHaveBeenCalled()
    stopSpeaking()
    await expect(newSpeech).resolves.toEqual(STOPPED)
    if (engine !== 'browser') expect(newPlayback.pause).toHaveBeenCalledOnce()
    expect(audios).toHaveLength(engine === 'browser' ? 1 : 2)
  })

  it.each(['failure', 'rejection'])('reports incomplete stream %s immediately and discards the queue', async (outcome) => {
    const request = deferred()
    media.heygenTtsStream.mockReturnValue(request.promise)
    const pending = speak('Reply', config('heygen'))
    emitChunk()
    emitChunk(1)
    audios[0].onplaying()
    if (outcome === 'rejection') request.reject(new Error('incomplete stream'))
    else request.resolve({ ok: false, error: 'incomplete stream' })
    await expect(pending).resolves.toMatchObject({ ok: false, detail: expect.stringContaining('incomplete stream') })
    expect(audios[0].pause).toHaveBeenCalledOnce()
    expect(audios[0].src).toBe('')
    expect(media.stopHeygenTts).toHaveBeenCalledOnce()
    expect(listeners.size).toBe(0)
    audios[0].onended()
    await flush()
    expect(audios).toHaveLength(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
  })

  it.each(['event', 'rejection', 'throw'])('reports player %s errors and cancels queued audio before main completes', async (outcome) => {
    const request = deferred()
    const play = deferred()
    media.heygenTtsStream.mockReturnValue(request.promise)
    const onPlaybackStart = vi.fn()
    const pending = speak('Reply', config('heygen'), onPlaybackStart)
    emitChunk()
    emitChunk(1)
    emitChunk(2)
    if (outcome === 'throw') playResult = new Error('Audio play threw')
    else if (outcome === 'rejection') playResult = play.promise
    audios[0].onended()
    await flush()
    if (outcome === 'event') audios[1].onerror()
    else if (outcome === 'rejection') play.reject(new Error('Audio play rejected'))
    await expect(pending).resolves.toMatchObject({ ok: false, detail: expect.stringContaining('Audio') })
    expect(audios[1].pause).toHaveBeenCalledOnce()
    expect(audios[1].src).toBe('')
    expect(media.stopHeygenTts).toHaveBeenCalledOnce()
    expect(onPlaybackStart).not.toHaveBeenCalled()
    expect(listeners.size).toBe(0)
    request.resolve(heygenResponse())
    audios[1].onended()
    await flush()
    expect(audios).toHaveLength(2)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  })

  it('ignores foreign, duplicate, invalid, and older indices without reordering or replaying', async () => {
    const request = deferred()
    media.heygenTtsStream.mockReturnValue(request.promise)
    const pending = speak('Reply', config('heygen'))
    emitChunk(100, wavChunk(), 'another-request')
    for (const index of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) emitChunk(index)
    expect(audios).toHaveLength(0)
    emitChunk(0, wavChunk(1))
    emitChunk(0, wavChunk(99))
    emitChunk(2, wavChunk(2))
    emitChunk(1, wavChunk(99))
    emitChunk(2, wavChunk(99))
    audios[0].onended()
    await flush()
    expect(audios).toHaveLength(2)
    emitChunk(0, wavChunk(99))
    audios[1].onended()
    await flush()
    expect(audios).toHaveLength(2)
    request.resolve(heygenResponse())
    await expect(pending).resolves.toMatchObject({ ok: true })
    const blobs = URL.createObjectURL.mock.calls.map(([blob]) => blob)
    expect(await Promise.all(blobs.map(async (blob) => Buffer.from(await blob.arrayBuffer()).toString('base64'))))
      .toEqual([wavChunk(1), wavChunk(2)])
  })

  it('notifies only on the first real start, even if an earlier chunk never reports playing', async () => {
    const request = deferred()
    media.heygenTtsStream.mockReturnValue(request.promise)
    const onPlaybackStart = vi.fn()
    const pending = speak('Reply', config('heygen'), onPlaybackStart)
    emitChunk()
    emitChunk(1)
    emitChunk(2)
    audios[0].onended()
    await flush()
    expect(onPlaybackStart).not.toHaveBeenCalled()
    audios[0].onplaying()
    expect(onPlaybackStart).not.toHaveBeenCalled()
    audios[1].onplaying()
    audios[1].onplaying()
    audios[1].onended()
    await flush()
    audios[2].onplaying()
    expect(onPlaybackStart).toHaveBeenCalledOnce()
    audios[2].onended()
    request.resolve(heygenResponse())
    await expect(pending).resolves.toMatchObject({ ok: true })
  })

  it.each(['', 'not base64!'])('reports invalid chunk data (%j) without playing the archive', async (audio) => {
    const request = deferred()
    media.heygenTtsStream.mockReturnValue(request.promise)
    const pending = speak('Reply', config('heygen'))
    emitChunk(0, audio)
    emitChunk(1)
    await expect(pending).resolves.toMatchObject({ ok: false })
    expect(audios).toHaveLength(0)
    expect(media.stopHeygenTts).toHaveBeenCalledOnce()
    request.resolve(heygenResponse())
    await flush()
    expect(media.assetUrl).not.toHaveBeenCalled()
  })

  it('reports successful IPC with no chunks as an error, without reading the asset', async () => {
    media.heygenTtsStream.mockResolvedValue(heygenResponse())
    await expect(speak('Reply', config('heygen'))).resolves.toMatchObject({ ok: false, detail: expect.stringContaining('no audio') })
    expect(audios).toHaveLength(0)
    expect(media.assetUrl).not.toHaveBeenCalled()
    expect(listeners.size).toBe(0)
  })

  it.each(['failure', 'rejection', 'throw'])('reports preaudio IPC %s without fallback requests', async (outcome) => {
    if (outcome === 'failure') media.heygenTtsStream.mockResolvedValue({ ok: false, error: 'model unavailable' })
    else if (outcome === 'rejection') media.heygenTtsStream.mockRejectedValue(new Error('model unavailable'))
    else media.heygenTtsStream.mockImplementation(() => { throw new Error('model unavailable') })
    await expect(speak('Reply', config('heygen'))).resolves.toMatchObject({ ok: false, detail: expect.stringContaining('model unavailable') })
    expect(media.heygenTtsStream).toHaveBeenCalledOnce()
    expect(media.heygenTts).not.toHaveBeenCalled()
    expect(media.assetUrl).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(synth.speak).not.toHaveBeenCalled()
    expect(listeners.size).toBe(0)
  })

  it.each(['missing bridge', 'missing voice'])('does not start streaming with %s', async (condition) => {
    const cfg = config('heygen')
    if (condition === 'missing bridge') media.heygenTtsStream = undefined
    else cfg.heygenVoiceId = ' '
    await expect(speak('Reply', cfg)).resolves.toMatchObject({ ok: false })
    expect(media.onHeygenAudio).not.toHaveBeenCalled()
    expect(media.heygenTts).not.toHaveBeenCalled()
    expect(media.stopHeygenTts).not.toHaveBeenCalled()
  })
})

describe.each(['heygen', 'kokoro', 'browser'])('%s playback lifecycle', (engine) => {
  it('notifies playback start only on the actual playing/start event', async () => {
    const request = deferred()
    if (engine === 'heygen') media.heygenTtsStream.mockReturnValue(request.promise)
    else if (engine === 'kokoro') fetch.mockReturnValue(request.promise)
    else synth.getVoices.mockReturnValue([])

    const onPlaybackStart = vi.fn()
    const pending = speak('Reply', config(engine), onPlaybackStart)
    await flush()
    expect(onPlaybackStart).not.toHaveBeenCalled()
    expect(audios).toHaveLength(0)
    expect(synth.speak).not.toHaveBeenCalled()

    if (engine === 'browser') {
      synth.getVoices.mockReturnValue([voice])
      synth.dispatchEvent(new Event('voiceschanged'))
    } else {
      if (engine === 'heygen') emitChunk()
      request.resolve(engine === 'heygen' ? heygenResponse() : audioResponse())
    }
    await flush()
    const target = playback(engine)
    expect(onPlaybackStart).not.toHaveBeenCalled()
    if (engine !== 'browser') expect(target.play).toHaveBeenCalledOnce()
    start(engine, target)
    start(engine, target)
    expect(onPlaybackStart).toHaveBeenCalledOnce()
    end(engine, target)
    await expect(pending).resolves.toMatchObject({ ok: true, detail: expect.stringContaining('Spoken') })
    if (engine === 'kokoro') expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-voice')
  })

  it('stop settles active playback even if no completion event arrives', async () => {
    const pending = speak('Reply', config(engine))
    await flush()
    const target = playback(engine)
    start(engine, target)
    stopSpeaking()

    await expect(pending).resolves.toEqual(STOPPED)
    if (engine !== 'browser') {
      expect(target.pause).toHaveBeenCalledOnce()
      expect(target.src).toBe('')
    } else expect(vi.getTimerCount()).toBe(0)
    if (engine === 'kokoro') expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
  })

  it('treats teardown errors as deliberate cancellation, not failures', async () => {
    const play = deferred()
    playResult = play.promise
    const onPlaybackStart = vi.fn()
    const pending = speak('Reply', config(engine), onPlaybackStart)
    await flush()
    const target = playback(engine)
    if (engine === 'browser') synth.cancel.mockImplementation(() => fail(engine, target))
    else target.pause.mockImplementation(() => fail(engine, target))

    stopSpeaking()
    if (engine !== 'browser') play.reject(new Error('play interrupted'))
    start(engine, target)
    await expect(pending).resolves.toEqual(STOPPED)
    expect(onPlaybackStart).not.toHaveBeenCalled()
    await flush()
  })

  it('old playback events cannot clear a newer playback stop handler', async () => {
    const oldStart = vi.fn()
    const oldSpeech = speak('Old reply', config(engine), oldStart)
    await flush()
    const oldPlayback = playback(engine)
    const newSpeech = speak('New reply', config(engine))
    await flush()
    await expect(oldSpeech).resolves.toEqual(STOPPED)
    const newPlayback = playback(engine, 1)

    end(engine, oldPlayback)
    fail(engine, oldPlayback)
    start(engine, oldPlayback)
    expect(oldStart).not.toHaveBeenCalled()
    stopSpeaking()
    await expect(newSpeech).resolves.toEqual(STOPPED)
    if (engine !== 'browser') expect(newPlayback.pause).toHaveBeenCalledOnce()
  })

  it('still reports real playback errors when not cancelled', async () => {
    const onPlaybackStart = vi.fn()
    const pending = speak('Reply', config(engine), onPlaybackStart)
    await flush()
    fail(engine, playback(engine))
    await expect(pending).resolves.toMatchObject({ ok: false })
    expect(onPlaybackStart).not.toHaveBeenCalled()
  })
})

describe('progressive reply speech', () => {
  const LONG = {
    a: 'The first sentence is long enough to be worth speaking on its own.',
    b: 'The second sentence is long enough to be worth speaking as well.',
    c: 'And the third one is long enough to follow the other two in order.',
  }

  /** Streams that answer only when the test says so, recording every request. */
  function pendingStreams() {
    const requests = []
    const open = []
    media.heygenTtsStream.mockImplementation((payload) => {
      const answer = deferred()
      requests.push(payload)
      open.push(answer)
      return answer.promise
    })
    return { requests, open }
  }

  /** Streams one clip for a request and plays it to the end. */
  async function hear(payload) {
    emitChunk(0, wavChunk(), payload.id)
    await flush()
    audios[audios.length - 1].onended()
    await flush()
  }

  it('speaks the first sentence while the model is still writing', async () => {
    const { requests, open } = pendingStreams()
    const onPlaybackStart = vi.fn()
    const speech = beginReplySpeech(config('heygen'), onPlaybackStart)

    speech.push(`${LONG.a} ${LONG.b.slice(0, 24)}`)
    expect(requests.map((r) => r.text)).toEqual([LONG.a])

    emitChunk(0, wavChunk(1), requests[0].id)
    expect(audios).toHaveLength(1)
    audios[0].onplaying()
    expect(onPlaybackStart).toHaveBeenCalledOnce()

    const pending = speech.finish(`${LONG.a} ${LONG.b}`)
    expect(requests.map((r) => r.text)).toEqual([LONG.a, LONG.b])

    audios[0].onended()
    await flush()
    expect(audios).toHaveLength(1)

    open[0].resolve(heygenResponse('first'))
    await flush()
    emitChunk(0, wavChunk(2), requests[1].id)
    expect(audios).toHaveLength(2)
    audios[1].onended()
    open[1].resolve(heygenResponse('second'))

    await expect(pending).resolves.toMatchObject({ ok: true, detail: expect.stringContaining('Spoken') })
    expect(requests).toHaveLength(2)
  })

  it('prefetches one sentence ahead and no further', async () => {
    const { requests, open } = pendingStreams()
    const speech = beginReplySpeech(config('heygen'))
    const reply = `${LONG.a} ${LONG.b} ${LONG.c}`

    speech.push(reply)
    expect(requests.map((r) => r.text)).toEqual([LONG.a, LONG.b])

    const pending = speech.finish(reply)
    expect(requests).toHaveLength(2)

    await hear(requests[0])
    open[0].resolve(heygenResponse())
    await flush()
    expect(requests.map((r) => r.text)).toEqual([LONG.a, LONG.b, LONG.c])

    await hear(requests[1])
    open[1].resolve(heygenResponse())
    await flush()
    await hear(requests[2])
    open[2].resolve(heygenResponse())

    await expect(pending).resolves.toMatchObject({ ok: true, detail: expect.stringContaining('Spoken') })
    expect(audios).toHaveLength(3)
  })

  it('cancels every sentence already in flight', async () => {
    const { requests, open } = pendingStreams()
    const speech = beginReplySpeech(config('heygen'))
    const reply = `${LONG.a} ${LONG.b}`

    speech.push(reply)
    emitChunk(0, wavChunk(), requests[0].id)
    expect(audios).toHaveLength(1)

    const pending = speech.finish(reply)
    stopSpeaking()

    await expect(pending).resolves.toEqual(STOPPED)
    expect(media.stopHeygenTts.mock.calls.map(([id]) => id).sort()).toEqual(requests.map((r) => r.id).sort())
    expect(listeners.size).toBe(0)
    expect(audios[0].pause).toHaveBeenCalledOnce()

    emitChunk(1, wavChunk(), requests[1].id)
    open[0].resolve(heygenResponse())
    open[1].resolve(heygenResponse())
    await flush()
    expect(audios).toHaveLength(1)
  })

  it('speaks a reply that never reaches a sentence boundary in one request', async () => {
    const speech = beginReplySpeech(config('heygen'))

    speech.push('Short partial answer')
    expect(media.heygenTtsStream).not.toHaveBeenCalled()

    const pending = speech.finish('Short partial answer that never ends.')
    expect(media.heygenTtsStream).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: 'Short partial answer that never ends.' }),
    )
    expect(audios).toHaveLength(1)

    audios[0].onended()
    await expect(pending).resolves.toMatchObject({ ok: true, detail: expect.stringContaining('Spoken') })
  })

  it('leaves a non-streaming engine to speak the finished reply', async () => {
    const speech = beginReplySpeech(config('kokoro'))

    speech.push('Any words at all here.')
    expect(fetch).not.toHaveBeenCalled()

    const pending = speech.finish('Any words at all here. More words follow it.')
    await flush()
    expect(fetch).toHaveBeenCalledOnce()
    expect(audios).toHaveLength(1)

    audios[0].onended()
    await expect(pending).resolves.toMatchObject({ ok: true })
  })

  it('falls back to one request when the provider rewrites its own answer', async () => {
    const { requests, open } = pendingStreams()
    const rewritten = 'A completely different answer that is also long enough to speak alone.'
    const speech = beginReplySpeech(config('heygen'))

    speech.push(LONG.a)
    expect(requests).toHaveLength(1)

    speech.push(rewritten)
    const pending = speech.finish(rewritten)

    expect(requests.map((r) => r.text)).toEqual([LONG.a, rewritten])
    expect(media.stopHeygenTts).toHaveBeenCalledExactlyOnceWith(requests[0].id)

    emitChunk(0, wavChunk(), requests[1].id)
    expect(audios).toHaveLength(1)
    audios[0].onended()
    open[1].resolve(heygenResponse())

    await expect(pending).resolves.toMatchObject({ ok: true, detail: expect.stringContaining('Spoken') })
    open[0].resolve(heygenResponse())
    await flush()
  })
})
