import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const creative = require('../../electron/creative.cjs')

const voice = (n) => ({ voice_id: `voice-${n}`, name: `Voice ${n}`, language: 'en', gender: 'female' })
const page = (rows, { hasMore = false, token = '' } = {}) =>
  new Response(JSON.stringify({ data: rows, has_more: hasMore, next_token: token }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

let fetchMock

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-heygen-'))
  await creative.init({ dataDir: dir })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('heygen voice listing', () => {
  it('follows next_token until has_more is false and returns every voice', async () => {
    fetchMock
      .mockResolvedValueOnce(page(Array.from({ length: 100 }, (_, i) => voice(i)), { hasMore: true, token: 'p2' }))
      .mockResolvedValueOnce(page(Array.from({ length: 100 }, (_, i) => voice(100 + i)), { hasMore: true, token: 'p3' }))
      .mockResolvedValueOnce(page(Array.from({ length: 50 }, (_, i) => voice(200 + i))))

    const result = await creative.heygenVoices({ key: 'test-key', type: 'public' })

    expect(result.voices).toHaveLength(250)
    expect(result.pages).toBe(3)
    expect(result.complete).toBe(true)
    expect(result.type).toBe('public')
    expect(fetchMock).toHaveBeenCalledTimes(3)

    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls[0]).toContain('type=public')
    expect(urls[0]).toContain('limit=100')
    expect(urls[0]).not.toContain('token=')
    expect(urls[1]).toContain('token=p2')
    expect(urls[2]).toContain('token=p3')
  })

  it('drops duplicate ids across pages instead of listing a voice twice', async () => {
    fetchMock
      .mockResolvedValueOnce(page([voice(1), voice(2)], { hasMore: true, token: 'next' }))
      .mockResolvedValueOnce(page([voice(2), voice(3)]))

    const result = await creative.heygenVoices({ key: 'test-key' })
    expect(result.voices.map((v) => v.voiceId)).toEqual(['voice-1', 'voice-2', 'voice-3'])
  })

  it('asks for the private scope when requested', async () => {
    fetchMock.mockResolvedValueOnce(page([voice(1)]))
    const result = await creative.heygenVoices({ key: 'test-key', type: 'private' })
    expect(String(fetchMock.mock.calls[0][0])).toContain('type=private')
    expect(result.type).toBe('private')
  })

  it('reports a clear error when the key returns nothing', async () => {
    fetchMock.mockResolvedValueOnce(page([]))
    await expect(creative.heygenVoices({ key: 'test-key' })).rejects.toThrow(/no voices/i)
  })

  it('requires a key instead of calling HeyGen anonymously', async () => {
    await expect(creative.heygenVoices({ key: '  ' })).rejects.toThrow(/api key/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
