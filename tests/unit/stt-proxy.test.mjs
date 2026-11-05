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
