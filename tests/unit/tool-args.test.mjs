import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const tools = require('../../electron/tools.cjs')
const { coerceArgsFor } = require('../../electron/tool-args.cjs')

const def = (name, properties) => [{ name, parameters: { type: 'object', properties, required: [] } }]

describe('schema-guided tool argument repair', () => {
  it('repairs string numbers, integers and booleans the model typed as strings', () => {
    const r = tools.coerceArgs('screen_capture', { all: 'true', region: { x: '10', y: '20', width: '300', height: '200' } })
    expect(r.args).toEqual({ all: true, region: { x: 10, y: 20, width: 300, height: 200 } })
    expect(r.repairs).toEqual(expect.arrayContaining(['all', 'region.x', 'region.width']))
    expect(tools.coerceArgs('browser_scroll', { direction: 'down', amount: '700' }).args.amount).toBe(700)
  })

  it('parses JSON-encoded arrays and objects only where the schema expects them', () => {
    const defs = def('demo', {
      tags: { type: 'array', items: { type: 'string' } },
      config: { type: 'object', properties: { deep: { type: 'boolean' } } },
      raw: { type: 'string' },
    })
    const args = { tags: '["a","b"]', config: '{"deep":"true"}', raw: '{"not":"json parsed"}' }
    const r = coerceArgsFor('demo', args, defs)
    expect(r.args).toEqual({ tags: ['a', 'b'], config: { deep: true }, raw: '{"not":"json parsed"}' })
  })

  it('wraps a bare value in a one-element array instead of failing the handler', () => {
    const r = tools.coerceArgs('memory_append', { note: 'keep this', tags: 'work' })
    expect(r.args.tags).toEqual(['work'])
    expect(r.repairs).toContain('tags')
  })

  it('leaves values alone when the conversion is ambiguous or already correct', () => {
    expect(tools.coerceArgs('browser_scroll', { direction: 'down', amount: 700 }).repairs).toEqual([])
    expect(tools.coerceArgs('fs_list', { path: 42 }).args.path).toBe(42)
    expect(tools.coerceArgs('browser_scroll', { amount: '12 px' }).args.amount).toBe('12 px')
    const intDefs = def('demo', { count: { type: 'integer' } })
    expect(coerceArgsFor('demo', { count: '7.5' }, intDefs).args.count).toBe('7.5')
    const raw = tools.coerceArgs('fs_list', { _raw: '{oops' })
    expect(raw.args).toEqual({ _raw: '{oops' })
    expect(raw.repairs).toEqual([])
  })

  it('turns a nullable "null" into null and unknown tools are untouched', () => {
    const defs = def('demo', { note: { type: ['string', 'null'] } })
    expect(coerceArgsFor('demo', { note: 'null' }, defs).args.note).toBeNull()
    const args = { all: 'true' }
    expect(coerceArgsFor('nope', args, defs).args).toBe(args)
  })
})
