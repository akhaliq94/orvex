import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const workforce = require('../../electron/workforce.cjs')
const { cleanModel, cleanSchedule, cleanBudget, normalizeDefinition, mapAgent, MAX_MEMORY_NOTES, TICK_MS } = workforce._internals

const agent = {
  id: 'agent_1',
  name: 'Research scout',
  role: 'researcher',
  mission: 'Scan the project inbox every weekday and write a short report.',
  model: null,
  schedule: '0 9 * * 1-5',
  status: 'active',
  budgetUsd: 0,
  spentUsd: 0,
  runs: 0,
  successes: 0,
  lastRunAt: null,
  nextRunAt: null,
  memory: [],
  createdAt: 1,
  updatedAt: 1,
  budgetBlocked: false,
}

describe('workforce model assignment', () => {
  it('keeps the endpoint and model but never an API key', () => {
    const model = cleanModel({
      providerId: 'openai',
      presetId: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-should-not-be-stored',
      api: 'openai',
    })
    expect(model.baseUrl).toBe('https://api.openai.com/v1')
    expect(model.model).toBe('gpt-4o-mini')
    expect(model).not.toHaveProperty('apiKey')
    expect(JSON.stringify(model)).not.toContain('sk-should-not-be-stored')
  })

  it('treats an empty assignment as local', () => {
    expect(cleanModel(null)).toBeNull()
    expect(cleanModel('')).toBeNull()
    expect(cleanModel({ baseUrl: '', model: '' })).toBeNull()
  })

  it('refuses a non-http endpoint', () => {
    expect(() => cleanModel({ baseUrl: 'file:///etc/passwd', model: 'x' })).toThrow(/http/i)
  })

  it('refuses malformed URLs instead of storing them', () => {
    expect(() => cleanModel({ baseUrl: 'not a url', model: 'x' })).toThrow(/valid/i)
  })
})

describe('workforce definitions', () => {
  it('accepts a five-field cron expression', () => {
    expect(cleanSchedule('0 9 * * 1-5')).toBe('0 9 * * 1-5')
    expect(cleanSchedule('')).toBeNull()
  })

  it('refuses a cron expression with the wrong field count', () => {
    expect(() => cleanSchedule('9 * *')).toThrow(/5 fields/i)
  })

  it('normalises budgets to zero or a positive amount', () => {
    expect(cleanBudget(12.345)).toBe(12.35)
    expect(cleanBudget(-5)).toBe(0)
    expect(cleanBudget('nope')).toBe(0)
  })

  it('fills defaults and verifies the name and mission', () => {
    const definition = normalizeDefinition({ name: 'Scout', mission: 'Check the inbox every morning.' })
    expect(definition.role).toBe('operator')
    expect(definition.model).toBeNull()
    expect(definition.schedule).toBeNull()
    expect(definition.budgetUsd).toBe(0)
    expect(() => normalizeDefinition({ name: 'S', mission: 'Check the inbox every morning.' })).toThrow(/name/i)
    expect(() => normalizeDefinition({ name: 'Scout', mission: 'short' })).toThrow(/mission/i)
  })
})

describe('workforce rows', () => {
  it('flags a budget that is already spent', () => {
    const row = {
      id: 'agent_1',
      name: 'Scout',
      role: 'operator',
      mission: 'Do the thing every day.',
      model: JSON.stringify({ baseUrl: 'https://api.example.com', model: 'm' }),
      schedule: null,
      status: 'active',
      budget_usd: 5,
      spent_usd: 5,
      runs: 3,
      successes: 2,
      last_run_at: 10,
      next_run_at: null,
      memory: JSON.stringify([{ at: 1, note: 'first' }]),
      created_at: 1,
      updated_at: 2,
    }
    const mapped = mapAgent(row)
    expect(mapped.budgetBlocked).toBe(true)
    expect(mapped.model.baseUrl).toBe('https://api.example.com')
    expect(mapped.memory).toHaveLength(1)
    expect(mapped.runs).toBe(3)
  })

  it('tolerates a corrupt memory column', () => {
    expect(mapAgent({ ...mapAgentRow(), memory: '{not json' }).memory).toEqual([])
  })
})

function mapAgentRow() {
  return {
    id: 'x',
    name: 'x',
    role: 'operator',
    mission: 'x',
    model: null,
    schedule: null,
    status: 'active',
    budget_usd: 0,
    spent_usd: 0,
    runs: 0,
    successes: 0,
    memory: null,
    created_at: 0,
    updated_at: 0,
  }
}

describe('workforce prompt and memory', () => {
  it('puts the mission and recent notes into the shift prompt', () => {
    const prompt = workforce.systemAppendFor({
      ...agent,
      memory: [{ at: Date.now(), note: 'Report was blocked by a missing inbox permission.' }],
    })
    expect(prompt).toContain('Research scout')
    expect(prompt).toContain(agent.mission)
    expect(prompt).toContain('missing inbox permission')
    expect(prompt).toContain('verify')
  })

  it('caps notes at the configured maximum', () => {
    const notes = Array.from({ length: MAX_MEMORY_NOTES + 5 }, (_, i) => ({ at: i, note: `note ${i}` }))
    const kept = workforce.memoryNotes({ ...agent, memory: notes })
    expect(kept).toHaveLength(MAX_MEMORY_NOTES)
    expect(kept[0].note).toBe('note 5')
  })

  it('ignores malformed notes', () => {
    expect(workforce.memoryNotes({ ...agent, memory: [{ bad: true }, null, { note: 'ok' }] })).toEqual([{ note: 'ok' }])
  })

  it('runs the scheduler no faster than every 30 seconds', () => {
    expect(TICK_MS).toBeGreaterThanOrEqual(30_000)
  })
})
