import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const mcp = require('../../electron/mcp.cjs')
const { normalizeServer, quoteForCmd } = mcp._internals

describe('MCP command hardening', () => {
  it('rejects newlines in commands and arguments', () => {
    expect(() => normalizeServer({ command: 'node\ncalc' }, 0)).toThrow(/single program/i)
    expect(() => normalizeServer({ command: 'node', args: ['a\rb'] }, 0)).toThrow(/newline/i)
  })

  it('quotes .cmd arguments and refuses cmd.exe expansion characters', () => {
    expect(quoteForCmd('plain')).toBe('"plain"')
    expect(quoteForCmd('path with spaces')).toBe('"path with spaces"')
    expect(() => quoteForCmd('say "hi"')).toThrow(/quotes or newlines/i)
    expect(() => quoteForCmd('%PATH%')).toThrow(/% or !/i)
    expect(() => quoteForCmd('bang!')).toThrow(/% or !/i)
  })
})

describe('MCP progressive disclosure', () => {
  const { toolExposure } = mcp._internals

  it('lists small servers whole and hides large servers behind the hub', () => {
    expect(toolExposure(['a', 'b'], null)).toEqual({ mode: 'all', direct: ['a', 'b'], hidden: [] })
    const big = Array.from({ length: 25 }, (_, i) => `tool_${i}`)
    const exposed = toolExposure(big, null)
    expect(exposed.mode).toBe('hub')
    expect(exposed.direct).toEqual([])
    expect(exposed.hidden).toHaveLength(25)
  })

  it('keeps only the allowlist when one is set', () => {
    expect(toolExposure(['a', 'b', 'c'], ['b'])).toEqual({ mode: 'allowlist', direct: ['b'], hidden: ['a', 'c'] })
  })

  it('stores a de-duplicated allowlist and rejects the wrong shape', () => {
    expect(normalizeServer({ command: 'node', tools: ['read_file', ' write_file ', 'read_file'] }, 0).tools).toEqual([
      'read_file',
      'write_file',
    ])
    expect(normalizeServer({ command: 'node' }, 0).tools).toBeNull()
    expect(() => normalizeServer({ command: 'node', tools: 'read_file' }, 0)).toThrow(/list of tool names/i)
  })

  it('never asks for approval to search, and gates every hub call', () => {
    expect(mcp.approvalReason(mcp.HUB_SEARCH)).toBeNull()
    expect(mcp.approvalReason(mcp.HUB_CALL, { tool: 'nope' })).toMatch(/external MCP tool/i)
    expect(mcp.HUB_CALL).toBe('mcp__orvex__call')
    expect(mcp.HUB_SEARCH).toBe('mcp__orvex__search')
  })
})
