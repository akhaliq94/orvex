import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const keys = require('../../electron/stt-keys.cjs')

const pool = [
  { id: 'a', label: 'first', addedAt: 1, key: 'KEY-A' },
  { id: 'b', label: 'second', addedAt: 2, key: 'KEY-B' },
  { id: 'c', label: '', addedAt: 3, key: 'KEY-C' },
]

describe('stt key pool ordering', () => {
  it('tries every key when nothing has failed', () => {
    expect(keys.pickOrder(pool, {})).toEqual([{ id: 'a', until: 0 }, { id: 'b', until: 0 }, { id: 'c', until: 0 }])
  })

  it('pushes a parked key to the back and keeps the chosen order otherwise', () => {
    const health = { a: { kind: 'quota', at: Date.now(), fails: 1 } }
    expect(keys.pickOrder(pool, health).map((row) => row.id)).toEqual(['b', 'c', 'a'])
  })

  it('sends a parked key to the back and tries the soonest returning one first', () => {
    const now = Date.now()
    const health = {
      a: { kind: 'key', at: now - 60 * 60 * 1000, fails: 2 },
      b: { kind: 'quota', at: now - 60 * 60 * 1000, fails: 1 },
      c: { kind: 'quota', at: now - 5 * 60 * 1000, fails: 1 },
    }
    expect(keys.pickOrder(pool, health, now).map((row) => row.id)).toEqual(['b', 'c', 'a'])
  })

  it('lets a cooled-out key be first again', () => {
    const now = Date.now()
    const health = { a: { kind: 'quota', at: now - keys.COOLDOWN_MS.quota - 1, fails: 1 } }
    expect(keys.pickOrder(pool, health, now)[0].id).toBe('a')
  })
})

describe('stt key pool health bookkeeping', () => {
  it('records which key was refused and how often', () => {
    const health = keys.withFailure({}, 'b', 'quota', 1000, 'HTTP 429: out of quota for this user')
    expect(health.b).toEqual({ kind: 'quota', at: 1000, detail: 'HTTP 429: out of quota for this user', fails: 1 })
    expect(keys.withFailure(health, 'b', 'quota', 2000).b.fails).toBe(2)
  })

  it('keeps a long refusal message out of the row it shows in settings', () => {
    const health = keys.withFailure({}, 'a', 'key', 1000, 'x'.repeat(400))
    expect(health.a.detail).toHaveLength(200)
  })

  it('clears only the key that answered and leaves the rest waiting', () => {
    const parked = keys.withFailure(keys.withFailure({}, 'a', 'quota', 1000), 'b', 'key', 2000)
    const healed = keys.withSuccess(parked, 'c', 3000)
    expect(healed.c).toEqual({ okAt: 3000 })
    expect(healed.a.kind).toBe('quota')
    expect(healed.b.kind).toBe('key')
    expect(keys.pickOrder(pool, healed, 3000).map((row) => row.id)).toEqual(['c', 'a', 'b'])
  })

  it('describes a key without ever naming its value', () => {
    const now = Date.now()
    const health = { a: { kind: 'quota', at: now, detail: 'HTTP 429', fails: 3 } }
    const row = keys.describe(pool[0], health, now)
    expect(row).toMatchObject({ id: 'a', label: 'first', state: 'quota', stateLabel: 'Out of quota', fails: 3, detail: 'HTTP 429' })
    expect(row.retryInMs).toBeGreaterThan(keys.COOLDOWN_MS.quota - 5000)
    expect(JSON.stringify(row)).not.toContain('KEY-A')
  })

  it('shows a key the endpoint rejected and one merely waiting differently', () => {
    const now = Date.now()
    expect(keys.describe(pool[0], { a: { kind: 'key', at: now, fails: 1 } }, now).state).toBe('key')
    expect(keys.describe(pool[0], { a: { kind: 'quota', at: now - keys.COOLDOWN_MS.quota, fails: 1 } }, now).state).toBe('working')
    expect(keys.describe(pool[0], {}, now).stateLabel).toBe('Working')
  })
})

describe('stt key pool storage', () => {
  it('keeps the key values so a later turn can send them', () => {
    const stored = keys.normalisePool([{ id: 'a', key: 'KEY-A', label: 'lap' }])
    expect(stored).toEqual([{ id: 'a', label: 'lap', addedAt: expect.any(Number), key: 'KEY-A' }])
  })

  it('drops blank and duplicate keys and invents ids for anonymous entries', () => {
    const stored = keys.normalisePool([{ key: '  ' }, { key: 'KEY-A' }, { key: 'KEY-A' }, { key: 'KEY-B' }])
    expect(stored.map((row) => row.key)).toEqual(['KEY-A', 'KEY-B'])
    expect(stored.every((row) => /^k[a-z0-9]+$/i.test(row.id))).toBe(true)
  })

  it('holds at most the documented number of keys', () => {
    const many = Array.from({ length: keys.MAX_KEYS + 12 }, (_, i) => ({ key: `KEY-${i}` }))
    expect(keys.normalisePool(many)).toHaveLength(keys.MAX_KEYS)
  })

  it('survives junk read back from the vault', () => {
    expect(keys.normalisePool(null)).toEqual([])
    expect(keys.normalisePool('nope')).toEqual([])
    expect(keys.normalisePool([null, 7, {}, { key: 'ok' }])).toHaveLength(1)
  })

  it('caps the label so a pasted key cannot become one', () => {
    expect(keys.normalisePool([{ key: 'KEY-A', label: 'l'.repeat(200) }])[0].label).toHaveLength(60)
  })
})

describe('stt failure classification', () => {
  it('reads the status off the error and out of its message', () => {
    expect(keys.classifyError(Object.assign(new Error('boom'), { status: 429 }))).toBe('quota')
    expect(keys.classifyError(new Error('HTTP 401: bad xi-api-key'))).toBe('key')
    expect(keys.classifyError(new Error('HTTP 404: no such model'))).toBe('request')
    expect(keys.classifyError(new Error('HTTP 503'))).toBe('server')
  })

  it('calls an unreachable endpoint a network problem, not a dead key', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    expect(keys.classifyError(err)).toBe('network')
    expect(keys.classifyError(undefined)).toBe('network')
  })

  it('rotates only on refusals aimed at the credential', () => {
    expect(keys.shouldRotate('quota')).toBe(true)
    expect(keys.shouldRotate('key')).toBe(true)
    expect(keys.shouldRotate('server')).toBe(false)
    expect(keys.shouldRotate('request')).toBe(false)
    expect(keys.shouldRotate('network')).toBe(false)
  })
})
