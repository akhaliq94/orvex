import { createRequire } from 'node:module'
import { afterAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const advanced = require('../../electron/advanced.cjs')

afterAll(() => {
  try {
    advanced.stopRules()
  } catch {
    /* no ticker was started */
  }
})

const local = (over = {}) => ({
  id: 'ollama',
  presetId: 'ollama',
  name: 'Ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  apiKey: '',
  api: 'openai',
  model: 'qwen2.5:7b',
  ...over,
})

const hosted = (over = {}) => ({
  id: 'openai',
  presetId: 'openai',
  name: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  api: 'openai',
  model: 'gpt-4o',
  ...over,
})

describe('planCandidates', () => {
  it('keeps the configured order in cloud mode', () => {
    const plan = advanced.planCandidates([hosted(), local()], { task: 'agent' })
    expect(plan.mode).toBe('cloud')
    expect(plan.candidates.map((c) => c.id)).toEqual(['openai', 'ollama'])
  })

  it('drops entries without a base URL or model', () => {
    const plan = advanced.planCandidates([hosted({ baseUrl: '' }), hosted({ model: '' }), local()], { task: 'agent' })
    expect(plan.candidates.map((c) => c.id)).toEqual(['ollama'])
  })

  it('deduplicates the same provider and model', () => {
    const plan = advanced.planCandidates([hosted(), hosted(), hosted({ model: 'gpt-4o-mini' })], { task: 'agent' })
    expect(plan.candidates).toHaveLength(2)
  })

  it('reports why an empty chain cannot run', () => {
    const plan = advanced.planCandidates([], { task: 'agent' })
    expect(plan.candidates).toEqual([])
    expect(plan.reason).toMatch(/no model candidates/i)
  })

  it('detects local endpoints by host and by preset', () => {
    const byPreset = advanced.planCandidates([local({ baseUrl: 'https://example.com/v1' })], { task: 'agent' })
    expect(byPreset.candidates).toHaveLength(1)
    const lan = advanced.planCandidates([local({ presetId: 'custom', baseUrl: 'http://192.168.1.4:1234/v1' })], { task: 'agent' })
    expect(lan.candidates).toHaveLength(1)
  })
})

describe('evaluateRule', () => {
  const rule = (condition) => ({ condition })

  it('matches idle time against the configured minutes', () => {
    expect(advanced.evaluateRule(rule({ type: 'idle_minutes', minutes: 5 }), { idleSec: 301 }).match).toBe(true)
    expect(advanced.evaluateRule(rule({ type: 'idle_minutes', minutes: 5 }), { idleSec: 120 }).match).toBe(false)
    expect(advanced.evaluateRule(rule({ type: 'idle_minutes', minutes: 5 }), {}).detail).toMatch(/unavailable/)
  })

  it('matches clipboard text case-insensitively', () => {
    expect(advanced.evaluateRule(rule({ type: 'clipboard_contains', text: 'invoice' }), { clipboard: 'Latest INVOICE #4' }).match).toBe(true)
    expect(advanced.evaluateRule(rule({ type: 'clipboard_contains', text: 'invoice' }), { clipboard: 'receipt' }).match).toBe(false)
  })

  it('compares CPU, memory and disk thresholds', () => {
    expect(advanced.evaluateRule(rule({ type: 'cpu_above', percent: 80 }), { cpuPercent: 91 }).match).toBe(true)
    expect(advanced.evaluateRule(rule({ type: 'memory_above', percent: 80 }), { memoryPercent: 40 }).match).toBe(false)
    expect(advanced.evaluateRule(rule({ type: 'disk_above', percent: 70 }), { diskPercent: 76 }).match).toBe(true)
  })

  it('matches a time-of-day window', () => {
    const at = new Date(2026, 0, 2, 9, 4, 0).getTime()
    expect(advanced.evaluateRule(rule({ type: 'time_of_day', at: '09:00', windowMinutes: 5 }), { at }).match).toBe(true)
    expect(advanced.evaluateRule(rule({ type: 'time_of_day', at: '09:00', windowMinutes: 2 }), { at }).match).toBe(false)
  })

  it('wraps a time-of-day window across midnight', () => {
    const justAfterMidnight = new Date(2026, 0, 2, 0, 1, 0).getTime()
    const noon = new Date(2026, 0, 2, 12, 0, 0).getTime()
    expect(advanced.evaluateRule(rule({ type: 'time_of_day', at: '23:59', windowMinutes: 5 }), { at: justAfterMidnight }).match).toBe(true)
    expect(advanced.evaluateRule(rule({ type: 'time_of_day', at: '23:59', windowMinutes: 5 }), { at: noon }).match).toBe(false)
  })

  it('matches interrupted work only when something is waiting', () => {
    expect(advanced.evaluateRule(rule({ type: 'run_interrupted' }), { interrupted: 2 }).match).toBe(true)
    expect(advanced.evaluateRule(rule({ type: 'run_interrupted' }), { interrupted: 0 }).match).toBe(false)
  })

  it('never fires an unknown condition', () => {
    const result = advanced.evaluateRule(rule({ type: 'made_up' }), {})
    expect(result.match).toBe(false)
    expect(result.detail).toMatch(/unknown condition/)
  })
})

describe('heuristicEval', () => {
  it('passes structural, numeric and length criteria on a real answer', () => {
    const output = `1. Back up the database before upgrading.\n2. Restart the app on port 47821.\n3. Verify 12 health probes and the checksum.\n${'detail '.repeat(30)}`
    const result = advanced.heuristicEval('upgrade the app safely', output, ['step by step', 'contains numbers', 'is complete'])
    expect(result.score).toBe(1)
    expect(result.verdicts.every((v) => v.pass)).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('penalises placeholder text and empty output', () => {
    const result = advanced.heuristicEval('write a report', 'lorem ipsum', ['is complete', 'step by step'])
    expect(result.score).toBeLessThan(0.5)
    expect(result.issues.join(' ')).toMatch(/placeholder/i)
    expect(result.issues.join(' ')).toMatch(/shorter than 40/)
  })

  it('checks JSON only when the criterion asks for it', () => {
    expect(advanced.heuristicEval('json', '{"a":1}', ['valid json']).verdicts[0].pass).toBe(true)
    expect(advanced.heuristicEval('json', 'not json', ['valid json']).verdicts[0].pass).toBe(false)
  })

  it('checks citations by looking for real links', () => {
    expect(advanced.heuristicEval('cite sources', 'See https://example.com/report for the numbers.', ['cites sources']).verdicts[0].pass).toBe(true)
    expect(advanced.heuristicEval('cite sources', 'Trust me, this is well known.', ['cites sources']).verdicts[0].pass).toBe(false)
  })
})

describe('modelCapability', () => {
  it('scores vision models higher than text-only models for vision', () => {
    expect(advanced.modelCapability('vision', 'gpt-4o')).toBeGreaterThan(advanced.modelCapability('vision', 'qwen2.5:7b'))
  })

  it('prefers coding models for code tasks', () => {
    expect(advanced.modelCapability('code', 'deepseek-coder')).toBeGreaterThan(advanced.modelCapability('code', 'llama3'))
  })

  it('prefers small fast models for summaries', () => {
    expect(advanced.modelCapability('summarize', 'gemini-flash')).toBeGreaterThan(advanced.modelCapability('summarize', 'o1-pro'))
  })

  it('stays inside 0..1 for every task', () => {
    for (const task of ['agent', 'chat', 'code', 'research', 'memory', 'summarize', 'vision', 'plan', 'media']) {
      const score = advanced.modelCapability(task, 'gpt-4o')
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })
})

describe('mineSequences', () => {
  it('counts a repeated chain across distinct runs only', () => {
    const sequences = [
      ['web_search', 'read_page', 'summarize'],
      ['web_search', 'read_page', 'summarize'],
      ['web_search', 'read_page'],
      ['write_file'],
    ]
    const rows = advanced.mineSequences(sequences, 2)
    const chain = rows.find((r) => r.steps.join('>') === 'web_search>read_page>summarize')
    const pair = rows.find((r) => r.steps.join('>') === 'web_search>read_page')
    expect(chain && chain.support).toBe(2)
    expect(pair && pair.support).toBe(3)
  })

  it('orders by support and ignores one-off chains', () => {
    const rows = advanced.mineSequences([['a', 'b'], ['a', 'c']], 2)
    expect(rows).toEqual([])
  })

  it('caps the returned list', () => {
    const sequences = Array.from({ length: 30 }, (_, i) => [`t${i}`, 'common']).concat(Array.from({ length: 30 }, () => ['t1', 'common']))
    const rows = advanced.mineSequences(sequences, 2)
    expect(rows.length).toBeLessThanOrEqual(12)
  })
})
