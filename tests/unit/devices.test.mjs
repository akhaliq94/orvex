import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const devices = require('../../electron/devices.cjs')
const { isPrivateAddress, safeEqual, stable, tokenFor, MODES, SYNC_HEADER } = devices._internals

describe('device address gate', () => {
  it('accepts loopback and LAN ranges', () => {
    for (const address of [
      '127.0.0.1',
      '127.15.2.3',
      '::1',
      '::ffff:127.0.0.1',
      '10.0.0.4',
      '192.168.1.20',
      '172.16.0.1',
      '172.31.255.254',
      '169.254.10.2',
      'fd12:3456::1',
      'fe80::d4a0',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true)
    }
  })

  it('refuses public and malformed addresses', () => {
    for (const address of [
      '8.8.8.8',
      '172.32.0.1',
      '172.15.0.1',
      '1.1.1.1',
      '2001:4860:4860::8888',
      '',
      undefined,
      'not-an-ip',
    ]) {
      expect(isPrivateAddress(address), String(address)).toBe(false)
    }
  })
})

describe('pairing helpers', () => {
  it('compares codes without leaking length mismatches', () => {
    expect(safeEqual('123456', '123456')).toBe(true)
    expect(safeEqual('123456', '123457')).toBe(false)
    expect(safeEqual('123456', '1234567')).toBe(false)
    expect(safeEqual('', '')).toBe(false)
    expect(safeEqual(undefined, '123456')).toBe(false)
  })

  it('requires a non-empty bearer token', () => {
    expect(tokenFor({ headers: { authorization: 'Bearer abc123' } })).toBe('abc123')
    expect(tokenFor({ headers: { authorization: 'bearer  abc123  ' } })).toBe('abc123')
    expect(tokenFor({ headers: { authorization: 'Basic abc123' } })).toBe('')
    expect(tokenFor({ headers: {} })).toBe('')
  })

  it('keeps the sync header and mode list pinned', () => {
    expect(SYNC_HEADER).toBe('x-orvex-sync')
    expect(MODES).toEqual(['cloud', 'local-first', 'hybrid', 'offline'])
  })
})

describe('bundle hashing', () => {
  it('sorts object keys so the integrity hash is stable', () => {
    const a = { b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } }
    const b = { a: { c: 3, d: [2, { y: 2, z: 1 }] }, b: 1 }
    expect(JSON.stringify(stable(a))).toBe(JSON.stringify(stable(b)))
  })

  it('leaves arrays in their declared order', () => {
    expect(stable({ items: [3, 1, 2] })).toEqual({ items: [3, 1, 2] })
  })

  it('refuses a bundle whose hash is missing or wrong', () => {
    expect(() => devices.applyBundle({ version: 1 })).toThrow(/integrity check/)
    expect(() => devices.applyBundle({ version: 1, sha256: 'a'.repeat(64) })).toThrow(/integrity check/)
  })

  it('refuses unknown bundle versions before hashing', () => {
    expect(() => devices.applyBundle({ version: 2, sha256: 'a'.repeat(64) })).toThrow(/Unsupported bundle version/)
    expect(() => devices.applyBundle(null)).toThrow(/Unsupported bundle version/)
  })
})
