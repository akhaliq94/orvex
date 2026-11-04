import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const training = require('../../electron/training.cjs')
const {
  parseBytes,
  clampQuota,
  quotaAdvice,
  pickDefaultRoot,
  scrubDeep,
  normalizeEpisode,
  isSecretKey,
  DEFAULT_QUOTA_BYTES,
  RESERVE_BYTES,
  MIN_QUOTA_BYTES,
  MAX_QUOTA_BYTES,
  LAYOUT,
} = training._internals

const GB = 1024 ** 3
const TB = 1024 ** 4

describe('parseBytes', () => {
  it('reads plain byte counts and unit strings', () => {
    expect(parseBytes(2048)).toBe(2048)
    expect(parseBytes('300GB')).toBe(300 * GB)
    expect(parseBytes('300 gb')).toBe(300 * GB)
    expect(parseBytes('1.5 TB')).toBe(1.5 * TB)
    expect(parseBytes('512mb')).toBe(512 * 1024 ** 2)
  })

  it('rejects empty and malformed sizes', () => {
    expect(() => parseBytes('')).toThrow()
    expect(() => parseBytes('lots')).toThrow()
    expect(() => parseBytes('-5GB')).toThrow()
    expect(() => parseBytes(0)).toThrow()
  })
})

describe('quota limits', () => {
  it('clamps to the supported range', () => {
    expect(clampQuota(0)).toBe(MIN_QUOTA_BYTES)
    expect(clampQuota(300 * GB)).toBe(300 * GB)
    expect(clampQuota(8 * 1024 * GB)).toBe(MAX_QUOTA_BYTES)
  })

  it('defaults to 300 GB and keeps a 20 GB reserve', () => {
    expect(DEFAULT_QUOTA_BYTES).toBe(300 * GB)
    expect(RESERVE_BYTES).toBe(20 * GB)
  })

  it('accepts a quota that fits and refuses one that does not', () => {
    const fits = quotaAdvice({ requestedBytes: 300 * GB, freeBytes: 330 * GB, usedBytes: 0 })
    expect(fits.ok).toBe(true)
    expect(fits.maxBytes).toBe(310 * GB)

    const tooBig = quotaAdvice({ requestedBytes: 320 * GB, freeBytes: 330 * GB, usedBytes: 0 })
    expect(tooBig.ok).toBe(false)
    expect(tooBig.note).toMatch(/can hold/i)
  })

  it('treats an unreadable free-space value as unknown, not zero', () => {
    const advice = quotaAdvice({ requestedBytes: 300 * GB, freeBytes: null })
    expect(advice.ok).toBe(true)
    expect(advice.maxBytes).toBeNull()
    expect(advice.note).toMatch(/logical/i)
  })
})

describe('default vault root', () => {
  it('uses F:\\Orvex space on Windows when it exists', () => {
    const root = pickDefaultRoot({
      platform: 'win32',
      dataDir: 'C:\\Users\\me\\AppData',
      exists: (value) => value === 'F:\\Orvex space',
    })
    expect(root).toBe('F:\\Orvex space')
  })

  it('falls back to a training folder inside userData', () => {
    const root = pickDefaultRoot({ platform: 'win32', dataDir: 'C:\\Users\\me\\AppData', exists: () => false })
    expect(root).toBe(path.join('C:\\Users\\me\\AppData', 'training'))
  })
})

describe('scrubDeep', () => {
  const redact = (value) => String(value).replace(/sk-[a-z0-9]+/gi, '[redacted]')

  it('drops credential-shaped keys and redacts strings', () => {
    const output = scrubDeep(
      {
        apiKey: 'sk-live-abc',
        token: 'very-secret',
        tokens: 42,
        completion_tokens: 9,
        text: 'the key is sk-abc123',
        nested: { password: 'hunter2', keep: 'visible' },
      },
      redact,
    )
    expect(output.apiKey).toBe('[redacted]')
    expect(output.token).toBe('[redacted]')
    expect(output.tokens).toBe(42)
    expect(output.completion_tokens).toBe(9)
    expect(output.text).toContain('[redacted]')
    expect(output.nested.password).toBe('[redacted]')
    expect(output.nested.keep).toBe('visible')
  })

  it('does not treat token *counts* as secrets', () => {
    expect(isSecretKey('token')).toBe(true)
    expect(isSecretKey('tokens')).toBe(false)
    expect(isSecretKey('prompt_tokens')).toBe(false)
    expect(isSecretKey('apiKey')).toBe(true)
    expect(isSecretKey('completionTokens')).toBe(false)
  })
})

describe('normalizeEpisode', () => {
  it('normalises unknown kinds, clamps scores and scrubs plans', () => {
    const episode = normalizeEpisode({
      goal: 'ship the report',
      kind: 'not-a-kind',
      status: 'not-a-status',
      score: 2,
      steps: -4,
      promptTokens: -1,
      plan: { apiKey: 'sk-secret', steps: ['read', 'write'] },
      outcome: 'done',
    })
    expect(episode.kind).toBe('agent')
    expect(episode.status).toBe('done')
    expect(episode.score).toBe(1)
    expect(episode.steps).toBe(0)
    expect(episode.promptTokens).toBe(0)
    const plan = JSON.parse(episode.plan)
    expect(plan.apiKey).toBe('[redacted]')
    expect(plan.steps).toEqual(['read', 'write'])
    expect(episode.createdAt).toBeGreaterThan(0)
  })

  it('keeps every layout folder', () => {
    expect(LAYOUT).toContain('models')
    expect(LAYOUT).toContain('episodes')
    expect(LAYOUT).toContain('datasets')
    expect(LAYOUT).toContain('checkpoints')
  })
})
