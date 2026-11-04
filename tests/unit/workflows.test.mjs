import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const workflows = require('../../electron/workflows.cjs')
const { parseCron, normalizeDefinition, evaluateCondition, render } = workflows._internals
const { cronNext, cronLabel } = workflows

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0)

describe('cron parser', () => {
  it('expands steps, ranges and lists', () => {
    const every15 = parseCron('*/15 * * * *')
    expect([...every15.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45])
    const list = parseCron('5,10,20-22 9 * * 1-5')
    expect([...list.minute].sort((a, b) => a - b)).toEqual([5, 10, 20, 21, 22])
    expect([...list.hour]).toEqual([9])
    expect(list.weekday.has(1) && list.weekday.has(5) && !list.weekday.has(6)).toBe(true)
    expect(list.dayStar).toBe(true)
    expect(list.weekdayStar).toBe(false)
  })

  it('rejects malformed expressions', () => {
    expect(() => parseCron('* * * *')).toThrow(/5 fields/i)
    expect(() => parseCron('60 * * * *')).toThrow(/outside 0-59/i)
    expect(() => parseCron('0 24 * * *')).toThrow(/outside 0-23/i)
    expect(() => parseCron('0 0 0 * *')).toThrow(/outside 1-31/i)
    expect(() => parseCron('*/0 * * * *')).toThrow(/step/i)
    expect(() => parseCron('1,,2 * * * *')).toThrow(/empty/i)
  })
})

describe('cronNext', () => {
  it('finds the next matching minute', () => {
    const from = new Date(2026, 0, 7, 12, 34, 30)
    const next = new Date(cronNext('* * * * *', from.getTime()))
    expect(next.getSeconds()).toBe(0)
    expect(next.getMinutes()).toBe(35)
    expect(next.getHours()).toBe(12)
  })

  it('respects weekday ranges', () => {
    const from = at(2026, 1, 7, 10, 0) // Wednesday morning, 09:00 already gone
    const next = new Date(cronNext('0 9 * * 1-5', from.getTime()))
    expect(next.getDay()).toBe(4) // Thursday
    expect(next.getDate()).toBe(8)
    expect(next.getHours()).toBe(9)
    expect(next.getMinutes()).toBe(0)
  })

  it('handles day-of-month schedules', () => {
    const from = at(2026, 1, 7, 10, 0)
    const next = new Date(cronNext('0 0 1 * *', from.getTime()))
    expect(next.getMonth()).toBe(1) // February
    expect(next.getDate()).toBe(1)
    expect(next.getHours()).toBe(0)
  })

  it('treats weekday 7 as Sunday', () => {
    const from = at(2026, 1, 9, 12, 0) // Friday
    const next = new Date(cronNext('30 8 * * 7', from.getTime()))
    expect(next.getDay()).toBe(0)
    expect(next.getDate()).toBe(11)
    expect(next.getHours()).toBe(8)
    expect(next.getMinutes()).toBe(30)
  })

  it('refuses an impossible schedule', () => {
    expect(() => cronNext('0 0 31 2 *')).toThrow(/never matches/i)
    expect(cronLabel('0 0 31 2 *')).toBe('Invalid schedule')
  })
})

describe('evaluateCondition', () => {
  it('covers the truthy/falsy family', () => {
    expect(evaluateCondition('yes', 'truthy')).toBe(true)
    expect(evaluateCondition('', 'truthy')).toBe(false)
    expect(evaluateCondition('FALSE', 'falsy')).toBe(true)
    expect(evaluateCondition('0', 'falsy')).toBe(true)
  })

  it('compares strings and substrings', () => {
    expect(evaluateCondition('abc', 'equals', 'abc')).toBe(true)
    expect(evaluateCondition('abc', 'equals', 'ABC')).toBe(false)
    expect(evaluateCondition('Hello World', 'contains', 'world')).toBe(true)
    expect(evaluateCondition('Hello World', 'notContains', 'mars')).toBe(true)
    expect(evaluateCondition('deploy.log', 'startsWith', 'deploy')).toBe(true)
    expect(evaluateCondition('deploy.log', 'endsWith', '.log')).toBe(true)
  })

  it('matches regular expressions case-insensitively', () => {
    expect(evaluateCondition('ABC-123', 'matches', '^[a-z]+-\\d+$')).toBe(true)
    expect(() => evaluateCondition('x', 'matches', '[')).toThrow(/not a valid regular expression/i)
  })

  it('compares numbers and refuses non-numbers', () => {
    expect(evaluateCondition('10', 'gt', '9')).toBe(true)
    expect(evaluateCondition('10', 'gte', '10')).toBe(true)
    expect(evaluateCondition('10', 'lt', '11')).toBe(true)
    expect(evaluateCondition('10', 'lte', '9')).toBe(false)
    expect(() => evaluateCondition('ten', 'gt', '9')).toThrow(/not numbers/i)
  })

  it('rejects unknown operators', () => {
    expect(() => evaluateCondition('a', 'fuzzy', 'b')).toThrow(/unknown condition operator/i)
  })
})

describe('template rendering', () => {
  it('replaces known paths and leaves unknown placeholders intact', () => {
    const ctx = { run: { output: 'hello', meta: { count: 3 } }, empty: null }
    expect(render('{{ run.output }} / {{run.meta}}', ctx)).toBe('hello / {"count":3}')
    expect(render('{{ empty }}!', ctx)).toBe('!')
    expect(render('{{ missing }}', ctx)).toBe('{{ missing }}')
  })

  it('passes non-strings through untouched', () => {
    expect(render(42, {})).toBe(42)
  })
})

describe('workflow definition validation', () => {
  const trigger = { id: 'start', type: 'trigger', config: { type: 'manual' } }
  const delay = { id: 'wait', type: 'delay', config: { ms: 1000 } }

  it('accepts a minimal valid graph', () => {
    const def = normalizeDefinition({ name: 'Morning', nodes: [trigger, delay], edges: [{ source: 'start', target: 'wait' }] })
    expect(def.name).toBe('Morning')
    expect(def.nodes).toHaveLength(2)
    expect(def.edges).toEqual([{ id: 'e1', source: 'start', target: 'wait', when: 'next' }])
  })

  it('requires a name, nodes and exactly one trigger', () => {
    expect(() => normalizeDefinition({ name: '', nodes: [trigger] })).toThrow(/name/i)
    expect(() => normalizeDefinition({ name: 'X', nodes: [] })).toThrow(/at least a trigger/i)
    expect(() => normalizeDefinition({ name: 'X', nodes: [trigger, { ...trigger, id: 'second' }] })).toThrow(/exactly one trigger/i)
  })

  it('rejects duplicate node ids and unknown types', () => {
    expect(() => normalizeDefinition({ name: 'X', nodes: [trigger, { ...delay, id: 'start' }] })).toThrow(/duplicate node id/i)
    expect(() => normalizeDefinition({ name: 'X', nodes: [{ id: 'a', type: 'teleport' }] })).toThrow(/unknown node type/i)
  })

  it('rejects edges that do not connect real nodes or loop onto themselves', () => {
    expect(() => normalizeDefinition({ name: 'X', nodes: [trigger, delay], edges: [{ source: 'start', target: 'ghost' }] })).toThrow(/two nodes/i)
    expect(() => normalizeDefinition({ name: 'X', nodes: [trigger, delay], edges: [{ source: 'start', target: 'start' }] })).toThrow(/itself/i)
  })

  it('rejects unreachable nodes', () => {
    expect(() => normalizeDefinition({ name: 'X', nodes: [trigger, delay] })).toThrow(/unconnected/i)
  })

  it('labels condition edges true/false only', () => {
    const condition = { id: 'check', type: 'condition', config: { operator: 'truthy', left: '{{run.ok}}' } }
    expect(() =>
      normalizeDefinition({ name: 'X', nodes: [trigger, condition, delay], edges: [{ source: 'start', target: 'check' }, { source: 'check', target: 'wait', when: 'nope' }] }),
    ).toThrow(/true or false/i)
  })

  it('requires a body edge for loops', () => {
    const loop = { id: 'loop', type: 'loop', config: { count: 2 } }
    expect(() =>
      normalizeDefinition({ name: 'X', nodes: [trigger, loop, delay], edges: [{ source: 'start', target: 'loop' }] }),
    ).toThrow(/body edge/i)
  })

  it('validates scheduled triggers at save time', () => {
    const scheduled = { id: 'start', type: 'trigger', config: { type: 'schedule', cron: '0 25 * * *' } }
    expect(() => normalizeDefinition({ name: 'X', nodes: [scheduled, delay], edges: [{ source: 'start', target: 'wait' }] })).toThrow(/outside 0-23/i)
  })
})
