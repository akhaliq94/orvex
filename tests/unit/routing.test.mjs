import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCandidates, orderForTask, pickLocal, routeLabel, TASKS } from '../../src/data/routing'

const provider = (over = {}) => ({
  id: 'openai',
  presetId: 'openai',
  name: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  api: 'openai',
  models: ['gpt-4o'],
  model: 'gpt-4o',
  enabled: true,
  kind: 'hosted',
  env: [],
  ...over,
})

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  })
  return map
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildCandidates', () => {
  const active = provider()
  const ollama = provider({ id: 'ollama', presetId: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3.1', kind: 'local' })
  const keylessHosted = provider({ id: 'groq', presetId: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: '', model: 'llama-3.3-70b-versatile' })
  const disabled = provider({ id: 'anthropic', presetId: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant', model: 'claude-sonnet-4', enabled: false, api: 'anthropic' })
  const incomplete = provider({ id: 'google', presetId: 'google', name: 'Google', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'k', model: '' })
  const all = [active, ollama, keylessHosted, disabled, incomplete]

  it('puts the active provider first and keeps keyed/local fallbacks', () => {
    expect(buildCandidates(all, 'openai').map((p) => p.id)).toEqual(['openai', 'ollama'])
  })

  it('skips disabled, incomplete and keyless hosted providers', () => {
    const ids = buildCandidates(all, null).map((p) => p.id)
    expect(ids).toEqual(['openai', 'ollama'])
    expect(ids).not.toContain('groq')
    expect(ids).not.toContain('anthropic')
    expect(ids).not.toContain('google')
  })

  it('returns a single usable provider chain when only one is configured', () => {
    expect(buildCandidates([active], 'openai').map((p) => p.id)).toEqual(['openai'])
  })
})

describe('pickLocal', () => {
  const local = provider({ id: 'ollama', presetId: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3.1', kind: 'local' })
  const other = provider({ id: 'lmstudio', presetId: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', apiKey: '', model: 'qwen', kind: 'local' })

  it('finds a local model that is not the active one', () => {
    expect(pickLocal([local, other], 'lmstudio')?.id).toBe('ollama')
    expect(pickLocal([local, other], 'openai')?.id).toBe('ollama')
  })

  it('returns null when no local model is enabled', () => {
    expect(pickLocal([provider()], 'openai')).toBeNull()
    expect(pickLocal([{ ...local, enabled: false }], 'openai')).toBeNull()
  })
})

describe('orderForTask', () => {
  const candidates = [
    { id: 'openai', model: 'gpt-4o' },
    { id: 'ollama', model: 'llama3.1' },
    { id: 'groq', model: 'llama-3.3-70b-versatile' },
  ]

  it('moves routed models to the front and keeps the rest behind', () => {
    memoryStorage({ 'orvex-routing': JSON.stringify({ code: [{ id: 'groq', model: 'llama-3.3-70b-versatile' }, { id: 'openai' }] }) })
    expect(orderForTask(candidates, 'code').map((c) => c.id)).toEqual(['groq', 'openai', 'ollama'])
  })

  it('ignores routes that match nothing', () => {
    memoryStorage({ 'orvex-routing': JSON.stringify({ code: [{ id: 'ghost' }] }) })
    expect(orderForTask(candidates, 'code')).toEqual(candidates)
  })

  it('leaves the list alone when no route is saved', () => {
    memoryStorage()
    expect(orderForTask(candidates, 'agent')).toEqual(candidates)
  })
})

describe('routeLabel', () => {
  const candidates = [{ id: 'openai', name: 'OpenAI', model: 'gpt-4o' }]

  it('prefers live provider metadata', () => {
    expect(routeLabel({ id: 'openai' }, candidates)).toBe('OpenAI · gpt-4o')
    expect(routeLabel({ providerId: 'openai', model: 'gpt-4o' }, candidates)).toBe('OpenAI · gpt-4o')
  })

  it('falls back to the saved route label', () => {
    expect(routeLabel({ name: 'Saved', model: 'm1' }, candidates)).toBe('Saved · m1')
    expect(routeLabel({ id: 'ghost' }, candidates)).toBe('ghost')
    expect(routeLabel({ id: 'ghost', model: 'm2' }, [])).toBe('ghost · m2')
  })
})

describe('task table', () => {
  it('lists nine unique routing tasks', () => {
    expect(TASKS).toHaveLength(9)
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(9)
    expect(TASKS.every((t) => t.label && t.hint)).toBe(true)
  })
})
