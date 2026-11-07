import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { leanTools, tooLarge, LEAN_TOOL_NAMES } = require('../../electron/agent.cjs')
const { definitions } = require('../../electron/tools.cjs')

describe('lean tool budget', () => {
  it('shrinks the registry to the essential tools', () => {
    const lean = leanTools(definitions)
    expect(lean.length).toBeGreaterThan(15)
    expect(lean.length).toBeLessThan(definitions.length)
    const names = lean.map((d) => d.name)
    for (const must of ['web_search', 'web_fetch', 'browser_task', 'fs_read', 'shell_exec', 'memory_search']) {
      expect(names).toContain(must)
    }
    // The lean payload is what a per-minute token cap can accept.
    expect(JSON.stringify(lean).length).toBeLessThan(14000)
  })

  it('keeps every tool when none of the lean names exist', () => {
    const odd = [{ name: 'mystery_tool', description: 'x', parameters: { type: 'object' } }]
    expect(leanTools(odd)).toBe(odd)
  })

  it('recognises a provider refusing the payload as too large', () => {
    expect(tooLarge('Groq: HTTP 413 — {"error":{"message":"Request too large for model"}}')).toBe(true)
    expect(tooLarge('This model\'s maximum context length is 8192 tokens')).toBe(true)
    expect(tooLarge('rate limit exceeded: tokens per minute')).toBe(true)
    expect(tooLarge('401 unauthorized')).toBe(false)
    expect(tooLarge('The endpoint returned 500')).toBe(false)
  })

  it('only lists names the registry actually defines', () => {
    const known = new Set(definitions.map((d) => d.name))
    expect(LEAN_TOOL_NAMES.filter((n) => !known.has(n))).toEqual([])
  })
})
