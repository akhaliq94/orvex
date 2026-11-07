import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const gateway = require('../../electron/model-gateway.cjs')

const reply = (headers) => ({ headers: new Headers(headers) })

describe('retry-after handling', () => {
  it('reads seconds', () => {
    expect(gateway.parseRetryAfter(reply({ 'retry-after': '7' }))).toBe(7000)
    expect(gateway.parseRetryAfter(reply({ 'retry-after': '2.5' }))).toBe(2500)
  })

  it('reads an HTTP date', () => {
    const at = new Date(Date.now() + 4000).toUTCString()
    const ms = gateway.parseRetryAfter(reply({ 'retry-after': at }))
    expect(ms).toBeGreaterThan(2500)
    expect(ms).toBeLessThanOrEqual(60000)
  })

  it('ignores a missing header and treats negatives as zero', () => {
    expect(gateway.parseRetryAfter(reply({}))).toBe(0)
    expect(gateway.parseRetryAfter(reply({ 'retry-after': '-5' }))).toBe(0)
    expect(gateway.parseRetryAfter(reply({ 'retry-after': 'nonsense' }))).toBe(0)
  })

  it('caps a long wait at a minute', () => {
    expect(gateway.parseRetryAfter(reply({ 'retry-after': '3600' }))).toBe(60000)
  })
})
