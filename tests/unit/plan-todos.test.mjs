import { beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const planTodos = require('../../electron/plan-todos.cjs')

beforeEach(() => planTodos._reset())

describe('plan todos', () => {
  it('adds items with compact ids and ignores duplicate open titles', () => {
    const first = planTodos.add('run_a', [{ title: '  Read the report ' }, { title: 'Summarise findings' }])
    expect(first.added.map((item) => item.title)).toEqual(['Read the report', 'Summarise findings'])
    expect(first.remaining).toBe(2)
    const again = planTodos.add('run_a', [{ title: 'read THE report' }])
    expect(again.added).toHaveLength(1)
    expect(again.total).toBe(2)
  })

  it('completes and removes items, reporting unknown ids instead of inventing them', () => {
    const added = planTodos.add('run_b', [{ title: 'a' }, { title: 'b' }])
    const done = planTodos.complete('run_b', { ids: [added.added[0].id, 999], reason: 'checked with fs_read' })
    expect(done.completed).toHaveLength(1)
    expect(done.completed[0].reason).toBe('checked with fs_read')
    expect(done.missing).toEqual([999])
    expect(done.remaining).toBe(1)
    const removed = planTodos.remove('run_b', { ids: [added.added[1].id] })
    expect(removed.removed).toHaveLength(1)
    expect(planTodos.list('run_b').total).toBe(1)
  })

  it('scopes items to one run and requires a run id', () => {
    planTodos.add('run_c', [{ title: 'only here' }])
    expect(planTodos.list('run_d').total).toBe(0)
    expect(() => planTodos.list('')).toThrow(/active agent run/i)
    expect(planTodos.clear('run_c')).toBe(true)
    expect(planTodos.list('run_c').total).toBe(0)
  })

  it('renders open items into the prompt and drops them when cleared', () => {
    const added = planTodos.add('run_e', [{ title: 'step one' }, { title: 'step two' }])
    planTodos.complete('run_e', { ids: [added.added[0].id], reason: 'done' })
    const prompt = planTodos.prompt('run_e')
    expect(prompt).toContain('## Current plan')
    expect(prompt).toContain('- [x]')
    expect(prompt).toContain('1 of 2 item(s) still open')
    expect(planTodos.prompt('run_empty')).toBe(planTodos.INSTRUCTIONS)
  })

  it('caps open items instead of growing without bound', () => {
    const many = Array.from({ length: planTodos.MAX_ITEMS }, (_, i) => ({ title: `item ${i}` }))
    planTodos.add('run_f', many)
    expect(() => planTodos.add('run_f', [{ title: 'one more' }])).toThrow(/at most/i)
  })

  it('rejects empty titles and malformed ids', () => {
    expect(() => planTodos.add('run_g', [{ title: '   ' }])).toThrow(/title is required/i)
    expect(() => planTodos.complete('run_g', { ids: ['x'] })).toThrow(/positive integers/i)
    expect(() => planTodos.complete('run_g', { ids: [] })).toThrow(/at least one/i)
  })
})
