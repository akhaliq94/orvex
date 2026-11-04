import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const pricing = require('../../electron/pricing.cjs')
const { costOf, isLocalUrl } = pricing

describe('isLocalUrl', () => {
  it('recognises local model servers', () => {
    expect(isLocalUrl('http://localhost:11434/v1')).toBe(true)
    expect(isLocalUrl('http://127.0.0.1:1234/v1')).toBe(true)
    expect(isLocalUrl('http://0.0.0.0:8080')).toBe(true)
    expect(isLocalUrl('http://[::1]:11434/v1')).toBe(true)
    expect(isLocalUrl('http://my-box:11434/ollama')).toBe(true)
    expect(isLocalUrl('http://studio.local:1234')).toBe(true)
  })

  it('keeps hosted providers billable', () => {
    expect(isLocalUrl('https://api.openai.com/v1')).toBe(false)
    expect(isLocalUrl('https://openrouter.ai/api/v1')).toBe(false)
    expect(isLocalUrl('')).toBe(false)
    expect(isLocalUrl(undefined)).toBe(false)
  })
})

describe('costOf', () => {
  it('charges nothing for a local model', async () => {
    const result = await costOf({ candidate: { baseUrl: 'http://localhost:11434/v1' }, model: 'llama3.1', promptTokens: 5000, completionTokens: 5000 })
    expect(result).toEqual({ costUsd: 0, estimated: false, priced: true })
  })

  it('uses an exact provider-reported cost', async () => {
    const result = await costOf({
      candidate: { baseUrl: 'https://api.openai.com/v1' },
      model: 'gpt-4o',
      promptTokens: 1000,
      completionTokens: 1000,
      rawUsage: { cost: 0.0123 },
    })
    expect(result).toEqual({ costUsd: 0.0123, estimated: false, priced: true })
  })

  it('accepts a numeric string from the provider', async () => {
    const result = await costOf({
      candidate: { baseUrl: 'https://api.openai.com/v1' },
      model: 'gpt-4o',
      promptTokens: 1000,
      completionTokens: 1000,
      rawUsage: { cost: '0.5' },
    })
    expect(result).toEqual({ costUsd: 0.5, estimated: false, priced: true })
  })
})
