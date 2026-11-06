import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const creative = require('../../electron/creative.cjs')
const testRoot = fileURLToPath(new URL('../', import.meta.url))
const options = { key: 'isolated-test-key', text: 'Hello world', voiceId: 'configured-voice', model: 'heygen-voice-1' }
const done = 'data: [DONE]\n\n'

function pcmFormat({ rate = 8000, channels = 1, bits = 16 } = {}) {
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0)
  fmt.writeUInt16LE(channels, 2)
  fmt.writeUInt32LE(rate, 4)
  fmt.writeUInt32LE(rate * channels * bits / 8, 8)
  fmt.writeUInt16LE(channels * bits / 8, 12)
  fmt.writeUInt16LE(bits, 14)
  return fmt
}

function riffChunk(id, data) {
  const chunk = Buffer.alloc(8 + data.length + (data.length & 1))
  chunk.write(id, 0)
  chunk.writeUInt32LE(data.length, 4)
  data.copy(chunk, 8)
  return chunk
}

function riff(chunks) {
  const body = Buffer.concat([Buffer.from('WAVE'), ...chunks])
  const header = Buffer.alloc(8)
  header.write('RIFF')
  header.writeUInt32LE(body.length, 4)
  return Buffer.concat([header, body])
}

function wav(data = Buffer.from([1, 0, 2, 0]), { fmt = pcmFormat(), extra = false, dataFirst = false } = {}) {
  const chunks = [riffChunk('fmt ', fmt), riffChunk('data', data)]
  if (dataFirst) chunks.reverse()
  if (extra) chunks.splice(1, 0, riffChunk('JUNK', Buffer.from([9, 8, 7])))
  return riff(chunks)
}

function audioEvent(index, audio = wav(), extra = {}) {
  return { type: 'audio', part_index: index, audio: Buffer.isBuffer(audio) ? audio.toString('base64') : audio, ...extra }
}

function sse(event, newline = '\n') {
  return `data: ${JSON.stringify(event)}${newline}${newline}`
}

function response(text, headers = {}) {
  return new Response(text, { headers: { 'content-type': 'text/event-stream', ...headers } })
}

function controlledResponse() {
  let controller
  const cancel = vi.fn()
  const stream = new ReadableStream({ start(c) { controller = c }, cancel })
  return {
    response: response(stream),
    push: (chunk) => controller.enqueue(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    end: () => controller.close(),
    fail: (err) => controller.error(err),
    cancel,
  }
}

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

function readChunks(buffer) {
  expect(buffer.toString('ascii', 0, 4)).toBe('RIFF')
  expect(buffer.toString('ascii', 8, 12)).toBe('WAVE')
  expect(buffer.readUInt32LE(4)).toBe(buffer.length - 8)
  const chunks = []
  for (let offset = 12; offset < buffer.length;) {
    const size = buffer.readUInt32LE(offset + 4)
    chunks.push({ id: buffer.toString('ascii', offset, offset + 4), data: buffer.subarray(offset + 8, offset + 8 + size) })
    offset += 8 + size + (size & 1)
  }
  return chunks
}

let dir
let fetchMock
let emitted

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(testRoot, '.heygen-stream-'))
  emitted = []
  fetchMock = vi.fn(() => { throw new Error('Unexpected fetch in isolated test') })
  vi.stubGlobal('fetch', fetchMock)
  expect((await creative.init({ dataDir: dir, emit: (event) => emitted.push(event) })).ready).toBe(true)
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await creative.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function noAsset() {
  expect((await creative.library()).assets).toEqual([])
  expect(fs.readdirSync(path.join(dir, 'media-library', 'files'))).toEqual([])
  expect(emitted).toEqual([])
}

async function savedWav(result) {
  const file = await creative.assetPath({ id: result.asset.id })
  expect(file.path.startsWith(dir + path.sep)).toBe(true)
  return fs.readFileSync(file.path)
}

describe('HeyGen SSE speech', () => {
  it('delivers fragmented UTF-8/CRLF audio before EOF or saving, then merges ordered PCM into one asset', async () => {
    const stream = controlledResponse()
    fetchMock.mockResolvedValueOnce(stream.response)
    const firstPcm = Buffer.from([1, 0, 255, 127])
    const secondPcm = Buffer.from([0, 128, 42, 0, 0, 0])
    const first = wav(firstPcm, { extra: true })
    const second = wav(secondPcm, { extra: true, dataFirst: true })
    const delivered = deferred()
    const onAudio = vi.fn((part) => {
      expect(emitted).toEqual([])
      if (part.index === 0) delivered.resolve()
    })
    let settled = false
    const pending = creative.heygenSpeakStream({ ...options, text: '  Hello\nworld  ', onAudio }).then((result) => {
      settled = true
      return result
    })
    // Every UTF-8 codepoint and CRLF boundary is split across network reads.
    const firstFrame = ': heartbeat\r\n\r\n' + sse(audioEvent(0, first, {
      character_alignment: { characters: ['é', '中'], character_start_times_seconds: [0, 0.1] },
    }), '\r\n')
    for (const byte of Buffer.from(firstFrame)) stream.push(Buffer.from([byte]))
    await delivered.promise
    expect(onAudio).toHaveBeenNthCalledWith(1, { index: 0, audio: first.toString('base64') })
    expect(settled).toBe(false)
    await noAsset()
    // SSE multi-line data, an ignored alignment event, and lone CR framing.
    stream.push(sse({ type: 'character_alignment', characters: ['é'] }, '\r'))
    const json = JSON.stringify(audioEvent(1, second)).replace(',"part_index"', ',\r\ndata: "part_index"')
    stream.push(`data: ${json}\r\n\r\ndata: [DONE]\r\n\r\n`)
    const result = await pending // Intentionally never close transport EOF.
    expect(stream.cancel).toHaveBeenCalledTimes(1)
    expect(onAudio).toHaveBeenNthCalledWith(2, { index: 1, audio: second.toString('base64') })
    expect(result).toMatchObject({ model: options.model, voiceId: options.voiceId, duration: 10 / 16000 })
    expect(result.asset).toMatchObject({ ext: 'wav', kind: 'audio', mime: 'audio/wav', source: 'tts', provider: 'heygen', model: options.model, prompt: 'Hello world' })
    expect(result.asset.name).toMatch(/^heygen-.*\.wav$/)
    expect((await creative.library()).assets).toHaveLength(1)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].type).toBe('add')
    const chunks = readChunks(await savedWav(result))
    expect(chunks.map((c) => c.id)).toEqual(['fmt ', 'data'])
    expect(chunks[0].data).toEqual(pcmFormat())
    expect(chunks[1].data).toEqual(Buffer.concat([firstPcm, secondPcm]))
    expect(result.asset.bytes).toBe(44 + firstPcm.length + secondPcm.length)
  })

  it.each(['heygen-voice-1', 'heygen-voice-1-turbo', 'heygen-voice-1-turbo-free'])('preserves configured engine %s, voice and every tuning parameter without retries', async (model) => {
    fetchMock.mockResolvedValueOnce(response(sse(audioEvent(0)) + done))
    const result = await creative.heygenSpeakStream({
      ...options, key: ' test-key ', model, voiceId: ' exact-voice ', language: 'fr', speed: 1.2, pitch: -3, expressiveness: 1.1, seed: 42,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, request] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.heygen.com/v3/models/audio/tts/stream')
    expect(request.method).toBe('POST')
    expect(request.headers).toEqual({ 'x-api-key': 'test-key', 'content-type': 'application/json', accept: 'text/event-stream' })
    expect(JSON.parse(request.body)).toEqual({ model, voice_id: 'exact-voice', text: 'Hello world', language: 'fr', speed: 1.2, pitch_shift: -3, expressiveness_boost: 1.1, seed: 42 })
    expect(result.model).toBe(model)
    expect(result.voiceId).toBe('exact-voice')
  })

  it('keeps the existing non-streaming API and uses exactly the same request validation', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { audio_url: 'https://cdn.heygen.com/test.wav', duration: 1.25 } })))
      .mockResolvedValueOnce(new Response(wav(), { headers: { 'content-type': 'audio/wav' } }))
      .mockResolvedValueOnce(response(sse(audioEvent(0)) + done))
    const input = { ...options, text: 'x'.repeat(5100), model: 'not-a-model', speed: 3, pitch: -30, expressiveness: 3, seed: 4.9 }
    const normal = await creative.heygenSpeak(input)
    // Keep the two API variants' saved libraries independent as well as their
    // fetch responses; both remain inside this test's disposable storage.
    await creative.close()
    await creative.init({ dataDir: path.join(dir, 'streamed'), emit: (event) => emitted.push(event) })
    const streamed = await creative.heygenSpeakStream(input)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.heygen.com/v3/models/audio/tts')
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual(JSON.parse(fetchMock.mock.calls[0][1].body))
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ model: 'heygen-voice-1-turbo-free', voice_id: options.voiceId, text: 'x'.repeat(5000), language: 'en', speed: 2, pitch_shift: -12, expressiveness_boost: 1.5, seed: 4 })
    expect(normal).toMatchObject({ duration: 1.25, voiceId: options.voiceId, model: 'heygen-voice-1-turbo-free' })
    expect(streamed.asset.prompt).toBe(normal.asset.prompt)
  })

  it('rebuilds padding for odd-length 8-bit PCM data instead of merging RIFF headers or part padding', async () => {
    const fmt = pcmFormat({ bits: 8 })
    const first = wav(Buffer.from([1, 2, 3]), { fmt, extra: true })
    const second = wav(Buffer.from([4, 5]), { fmt })
    fetchMock.mockResolvedValueOnce(response(sse(audioEvent(0, first)) + sse(audioEvent(1, second)) + done))
    const result = await creative.heygenSpeakStream(options)
    const merged = await savedWav(result)
    expect(readChunks(merged)[1].data).toEqual(Buffer.from([1, 2, 3, 4, 5]))
    expect(merged.length).toBe(50)
    expect(merged[49]).toBe(0)
    expect(result.duration).toBe(5 / 8000)
  })

  it.each([
    ['empty key', { key: ' ' }, /api key/i],
    ['empty text', { text: '\n ' }, /text to speak/i],
    ['empty voice', { voiceId: ' ' }, /pick a heygen voice/i],
    ['invalid callback', { onAudio: true }, /onAudio/i],
  ])('rejects %s before fetching', async (_name, override, error) => {
    await expect(creative.heygenSpeakStream({ ...options, ...override })).rejects.toThrow(error)
    expect(fetchMock).not.toHaveBeenCalled()
    await noAsset()
  })

  it('surfaces provider errors after partial audio, cancels upstream and never saves or retries', async () => {
    const stream = controlledResponse()
    fetchMock.mockResolvedValueOnce(stream.response)
    stream.push(sse(audioEvent(0)) + sse({ type: 'error', detail: 'Quota exhausted' }) + done)
    const onAudio = vi.fn()
    await expect(creative.heygenSpeakStream({ ...options, onAudio })).rejects.toThrow(/Quota exhausted/)
    expect(onAudio).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    expect(stream.cancel).toHaveBeenCalledTimes(1)
    await noAsset()
  })

  it.each([
    ['missing terminator', sse(audioEvent(0)), /before \[DONE\]/],
    ['truncated terminator', sse(audioEvent(0)) + 'data: [DONE]', /before \[DONE\]/],
    ['truncated frame', 'data: {"type":"audio"', /before \[DONE\]/],
    ['empty body', '', /before \[DONE\]/],
    ['no audio', done, /no audio parts/],
    ['malformed JSON', 'data: {broken}\n\n' + done, /malformed.*JSON/],
    ['unknown type', sse({ type: 'unexpected' }) + done, /unknown speech event/],
  ])('rejects an incomplete/invalid stream: %s', async (_name, body, error) => {
    fetchMock.mockResolvedValueOnce(response(body))
    await expect(creative.heygenSpeakStream(options)).rejects.toThrow(error)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await noAsset()
  })

  it.each([
    ['starts at one', [1]], ['duplicate', [0, 0]], ['gap', [0, 2]], ['negative', [-1]],
    ['fractional', [0.5]], ['string', ['0']], ['missing', [undefined]],
  ])('enforces zero-based consecutive part_index: %s', async (_name, indexes) => {
    fetchMock.mockResolvedValueOnce(response(indexes.map((index) => sse(audioEvent(index))).join('') + done))
    const onAudio = vi.fn()
    await expect(creative.heygenSpeakStream({ ...options, onAudio })).rejects.toThrow(/part_index/)
    expect(onAudio).toHaveBeenCalledTimes(indexes[0] === 0 ? 1 : 0)
    await noAsset()
  })

  it.each([
    ['empty', ''], ['non-string', null], ['invalid alphabet', '!!!!'], ['bad padding', 'YQ='],
    ['noncanonical padding bits', 'YR=='], ['not WAV', Buffer.from('not a WAV file').toString('base64')],
    ['empty PCM', wav(Buffer.alloc(0))], ['unaligned PCM', wav(Buffer.from([1]))],
    ['truncated RIFF', wav().subarray(0, 45)],
    ['missing fmt', riff([riffChunk('data', Buffer.from([1, 0]))])],
    ['missing data', riff([riffChunk('fmt ', pcmFormat())])],
    ['duplicate data', riff([riffChunk('fmt ', pcmFormat()), riffChunk('data', Buffer.from([1, 0])), riffChunk('data', Buffer.from([2, 0]))])],
    ['truncated chunk', riff([riffChunk('fmt ', pcmFormat()), Buffer.from('data\xff\xff\xff\x7f', 'latin1')])],
  ])('rejects malformed audio before emitting it: %s', async (_name, audio) => {
    fetchMock.mockResolvedValueOnce(response(sse(audioEvent(0, audio)) + done))
    const onAudio = vi.fn()
    await expect(creative.heygenSpeakStream({ ...options, onAudio })).rejects.toThrow(/base64|WAV/)
    expect(onAudio).not.toHaveBeenCalled()
    await noAsset()
  })

  it.each([{ rate: 16000 }, { channels: 2 }, { bits: 8 }])('rejects mismatched WAV formats (%j)', async (format) => {
    fetchMock.mockResolvedValueOnce(response(sse(audioEvent(0)) + sse(audioEvent(1, wav(undefined, { fmt: pcmFormat(format) }))) + done))
    const onAudio = vi.fn()
    await expect(creative.heygenSpeakStream({ ...options, onAudio })).rejects.toThrow(/mismatched WAV/)
    expect(onAudio).toHaveBeenCalledTimes(1)
    await noAsset()
  })

  it.each(['codec', 'byte rate', 'block alignment', 'bits'])('rejects invalid WAV %s', async (field) => {
    const fmt = pcmFormat()
    if (field === 'codec') fmt.writeUInt16LE(3, 0)
    if (field === 'byte rate') fmt.writeUInt32LE(1, 8)
    if (field === 'block alignment') fmt.writeUInt16LE(1, 12)
    if (field === 'bits') fmt.writeUInt16LE(0, 14)
    fetchMock.mockResolvedValueOnce(response(sse(audioEvent(0, wav(undefined, { fmt }))) + done))
    await expect(creative.heygenSpeakStream(options)).rejects.toThrow(/WAV/)
    await noAsset()
  })

  it.each(['RIFF', 'WAVE', 'fmt ', 'data'])('rejects high-bit lookalikes of the %s chunk identifier', async (id) => {
    const audio = wav()
    const offset = audio.indexOf(id)
    audio[offset] |= 0x80
    fetchMock.mockResolvedValueOnce(response(sse(audioEvent(0, audio)) + done))
    await expect(creative.heygenSpeakStream(options)).rejects.toThrow(/WAV/)
    await noAsset()
  })

  it.each(['extended PCM', 'extensible PCM'])('merges matching %s fmt chunks without changing them', async (type) => {
    const fmt = Buffer.alloc(type === 'extended PCM' ? 18 : 40)
    pcmFormat().copy(fmt)
    if (type === 'extensible PCM') {
      fmt.writeUInt16LE(0xfffe, 0)
      fmt.writeUInt16LE(22, 16)
      fmt.writeUInt16LE(16, 18)
      fmt.writeUInt32LE(4, 20)
      Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(fmt, 24)
    }
    const audio = wav(undefined, { fmt })
    fetchMock.mockResolvedValueOnce(response(sse(audioEvent(0, audio)) + sse(audioEvent(1, audio)) + done))
    const result = await creative.heygenSpeakStream(options)
    const chunks = readChunks(await savedWav(result))
    expect(chunks[0].data).toEqual(fmt)
    expect(chunks[1].data).toEqual(Buffer.from([1, 0, 2, 0, 1, 0, 2, 0]))
  })

  it('rejects invalid UTF-8 rather than replacing it silently', async () => {
    fetchMock.mockResolvedValueOnce(response(Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0xc3, 0x28])))
    await expect(creative.heygenSpeakStream(options)).rejects.toThrow()
    await noAsset()
  })

  it('rejects non-SSE and HTTP failures without downloading/falling back', async () => {
    fetchMock.mockResolvedValueOnce(new Response('denied', { status: 401 }))
    await expect(creative.heygenSpeakStream(options)).rejects.toThrow(/HTTP 401/)
    fetchMock.mockResolvedValueOnce(new Response('{}', { headers: { 'content-type': 'application/json' } }))
    await expect(creative.heygenSpeakStream(options)).rejects.toThrow(/event stream/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await noAsset()
  })

  it('rejects an oversized standalone base64 WAV before callback or allocation of a decoded part', async () => {
    const onAudio = vi.fn()
    fetchMock.mockResolvedValueOnce(response(sse(audioEvent(0, 'A'.repeat(Math.ceil(8 * 1024 * 1024 / 3) * 4 + 4))) + done))
    await expect(creative.heygenSpeakStream({ ...options, onAudio })).rejects.toThrow(/oversized base64/)
    expect(onAudio).not.toHaveBeenCalled()
    await noAsset()
  })

  it('bounds an unfinished SSE frame', async () => {
    fetchMock.mockResolvedValueOnce(response('data: ' + 'x'.repeat(12 * 1024 * 1024)))
    await expect(creative.heygenSpeakStream(options)).rejects.toThrow(/event is too large/)
    await noAsset()
  })

  it('bounds the actual body, even for an endless sequence of small comment frames without content-length', async () => {
    const chunk = Buffer.from(':' + 'x'.repeat(64 * 1024 - 3) + '\n\n')
    const cancel = vi.fn()
    fetchMock.mockResolvedValueOnce(response(new ReadableStream({ pull(c) { c.enqueue(chunk) }, cancel })))
    await expect(creative.heygenSpeakStream(options)).rejects.toThrow(/exceeded 100 MB/)
    expect(cancel).toHaveBeenCalledTimes(1)
    await noAsset()
  })

  it('rejects an excessive content-length without consuming the body', async () => {
    fetchMock.mockResolvedValueOnce(response('', { 'content-length': String(100 * 1024 * 1024 + 1) }))
    await expect(creative.heygenSpeakStream(options)).rejects.toThrow(/exceeded 100 MB/)
    await noAsset()
  })

  it('bounds the number of small audio parts', async () => {
    fetchMock.mockResolvedValueOnce(response(Array.from({ length: 4097 }, (_, index) => sse(audioEvent(index))).join('') + done))
    await expect(creative.heygenSpeakStream(options)).rejects.toThrow(/excessive audio part_index/)
    await noAsset()
  })

  it('does not fetch for an already aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(creative.heygenSpeakStream({ ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
    await noAsset()
  })

  it('aborts upstream while waiting for headers, even if fetch never settles', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementationOnce(() => new Promise(() => {}))
    const pending = creative.heygenSpeakStream({ ...options, signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    await noAsset()
  })

  it('aborts a stalled body after delivering audio, cancels the reader, and leaves no asset', async () => {
    const stream = controlledResponse()
    const controller = new AbortController()
    const delivered = deferred()
    fetchMock.mockResolvedValueOnce(stream.response)
    stream.push(sse(audioEvent(0)))
    const pending = creative.heygenSpeakStream({ ...options, signal: controller.signal, onAudio: () => delivered.resolve() })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await delivered.promise
    controller.abort()
    await rejected
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    expect(stream.cancel).toHaveBeenCalledTimes(1)
    await noAsset()
  })

  it('honors cancellation from the callback even when DONE is already buffered', async () => {
    const controller = new AbortController()
    fetchMock.mockResolvedValueOnce(response(sse(audioEvent(0)) + done))
    await expect(creative.heygenSpeakStream({ ...options, signal: controller.signal, onAudio: () => controller.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    await noAsset()
  })

  it.each(['audio file', 'index'])('rolls back cancellation during the final %s write, before publishing an asset', async (stage) => {
    const controller = new AbortController()
    fetchMock.mockResolvedValueOnce(response(sse(audioEvent(0)) + done))
    const writeFile = fsp.writeFile
    const spy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file, ...args) => {
      const result = await writeFile(file, ...args)
      const target = String(file)
      if (stage === 'audio file' ? target.endsWith('.wav') : target.includes('index.json.')) controller.abort()
      return result
    })
    try {
      await expect(creative.heygenSpeakStream({ ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      spy.mockRestore()
    }
    await noAsset()
    const index = path.join(dir, 'media-library', 'index.json')
    if (fs.existsSync(index)) expect(JSON.parse(fs.readFileSync(index, 'utf8')).assets).toEqual([])
  })

  it('cleans up an audio file if the final index write fails', async () => {
    fetchMock.mockResolvedValueOnce(response(sse(audioEvent(0)) + done))
    const writeFile = fsp.writeFile
    let failed = false
    const spy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file, ...args) => {
      if (!failed && String(file).includes('index.json.')) {
        failed = true
        throw new Error('isolated index write failed')
      }
      return writeFile(file, ...args)
    })
    try {
      await expect(creative.heygenSpeakStream(options)).rejects.toThrow(/index write failed/)
    } finally {
      spy.mockRestore()
    }
    await noAsset()
  })

  it('enforces the deadline even when ready reads/callbacks have not yielded to timers', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(response(sse(audioEvent(0)) + done))
    const start = Date.now()
    await expect(creative.heygenSpeakStream({ ...options, onAudio: () => vi.setSystemTime(start + 120001) })).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(vi.getTimerCount()).toBe(0)
    await noAsset()
  })

  it('does not save if a consumer callback fails', async () => {
    fetchMock.mockResolvedValueOnce(response(sse(audioEvent(0)) + done))
    await expect(creative.heygenSpeakStream({ ...options, onAudio: async () => { throw new Error('consumer failed') } })).rejects.toThrow(/consumer failed/)
    await noAsset()
  })

  it('does not save partial audio on a transport failure', async () => {
    const stream = controlledResponse()
    const delivered = deferred()
    fetchMock.mockResolvedValueOnce(stream.response)
    stream.push(sse(audioEvent(0)))
    const pending = creative.heygenSpeakStream({ ...options, onAudio: () => delivered.resolve() })
    const rejected = expect(pending).rejects.toThrow(/connection lost/)
    await delivered.promise
    stream.fail(new Error('connection lost'))
    await rejected
    await noAsset()
  })

  it.each(['headers', 'body', 'callback'])('enforces a total 120s deadline while waiting for %s', async (stage) => {
    vi.useFakeTimers()
    const started = deferred()
    const stream = controlledResponse()
    if (stage === 'headers') {
      fetchMock.mockImplementationOnce(() => { started.resolve(); return new Promise(() => {}) })
    } else {
      fetchMock.mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60000))
        stream.push(sse(audioEvent(0)))
        return stream.response
      })
    }
    const pending = creative.heygenSpeakStream({ ...options, onAudio: () => {
      started.resolve()
      if (stage === 'callback') return new Promise(() => {})
    } })
    const outcome = pending.then(() => null, (error) => error)
    if (stage !== 'headers') await vi.advanceTimersByTimeAsync(60000)
    await started.promise
    await vi.advanceTimersByTimeAsync(stage === 'headers' ? 120000 : 60000)
    expect(await outcome).toMatchObject({ name: 'TimeoutError', message: expect.stringMatching(/120s/) })
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    if (stage !== 'headers') expect(stream.cancel).toHaveBeenCalledTimes(1)
    await noAsset()
  })
})
