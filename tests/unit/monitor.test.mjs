import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const monitor = require('../../electron/monitor.cjs')
const { extractJson, validateCase, bucketFor, csvCell } = monitor._internals
const { evaluateChecks } = monitor

describe('extractJson', () => {
  it('reads plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
    expect(extractJson('  [1,2,3]  ')).toEqual([1, 2, 3])
  })

  it('reads fenced JSON', () => {
    expect(extractJson('Sure:\n```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('```\n[true]\n```')).toEqual([true])
  })

  it('recovers JSON from surrounding prose', () => {
    expect(extractJson('Here you go: {"ok":true} thanks')).toEqual({ ok: true })
    expect(extractJson('prefix [1,2] suffix')).toEqual([1, 2])
  })

  it('throws when there is no JSON', () => {
    expect(() => extractJson('not json at all')).toThrow(/not valid json/i)
    expect(() => extractJson('')).toThrow(/not valid json/i)
  })
})

describe('validateCase', () => {
  it('normalizes ids and check lists', () => {
    const out = validateCase({ id: 'my case!', prompt: ' Say PONG ', checks: { contains: 'PONG', maxMs: 999999 } }, 0)
    expect(out.id).toBe('my_case_')
    expect(out.prompt).toBe('Say PONG')
    expect(out.checks.contains).toEqual(['PONG'])
    expect(out.checks.maxMs).toBe(600000)
  })

  it('defaults ids by position', () => {
    expect(validateCase({ prompt: 'hi', checks: { notContains: ['bye'] } }, 3).id).toBe('case_4')
  })

  it('rejects unusable cases', () => {
    expect(() => validateCase(null, 0)).toThrow(/not an object/i)
    expect(() => validateCase({ prompt: '' }, 0)).toThrow(/no prompt/i)
    expect(() => validateCase({ prompt: 'x' }, 0)).toThrow(/no checks/i)
    expect(() => validateCase({ prompt: 'x', checks: { regex: ['['] } }, 0)).toThrow(/invalid regex/i)
    expect(() => validateCase({ prompt: 'x'.repeat(4001), checks: { contains: ['x'] } }, 0)).toThrow(/4,000 characters/i)
  })

  it('keeps an optional system prompt verbatim within its limit', () => {
    const out = validateCase({ prompt: 'x', system: ' be terse ', checks: { json: true } }, 0)
    expect(out.system).toBe(' be terse ')
    expect(validateCase({ prompt: 'x', system: 's'.repeat(5000), checks: { json: true } }, 0).system).toHaveLength(4000)
    expect(out.checks.json).toBe(true)
  })
})

describe('evaluateChecks', () => {
  it('scores a perfect reply', () => {
    const result = evaluateChecks('The answer is PONG.', { contains: ['pong'], notContains: ['error'], regex: ['answer\\s+is'] })
    expect(result.ok).toBe(true)
    expect(result.score).toBe(1)
    expect(result.checks).toHaveLength(3)
  })

  it('reports each failed check', () => {
    const result = evaluateChecks('nope', { contains: ['yes'], maxMs: 1000 }, { ms: 1500 })
    expect(result.ok).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks.find((c) => c.name.includes('yes')).ok).toBe(false)
    expect(result.checks.find((c) => c.name.includes('1000 ms')).ok).toBe(false)
  })

  it('accepts fenced JSON', () => {
    const result = evaluateChecks('```json\n{"status":"ok"}\n```', { json: true, contains: ['"status"'] })
    expect(result.ok).toBe(true)
  })

  it('treats an empty check list as a failure', () => {
    const result = evaluateChecks('anything', {})
    expect(result.ok).toBe(false)
    expect(result.score).toBe(0)
  })
})

describe('bucketFor', () => {
  it('chooses a bucket that keeps charts readable', () => {
    expect(bucketFor(1)).toBe(60_000)
    expect(bucketFor(60)).toBe(60_000)
    expect(bucketFor(61)).toBe(5 * 60_000)
    expect(bucketFor(360)).toBe(5 * 60_000)
    expect(bucketFor(361)).toBe(15 * 60_000)
    expect(bucketFor(1440)).toBe(15 * 60_000)
    expect(bucketFor(1441)).toBe(60 * 60_000)
  })
})

describe('csvCell', () => {
  it('quotes only when the value needs it', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell(7)).toBe('7')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
  })
})
