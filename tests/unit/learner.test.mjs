import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const learner = require('../../electron/learner.cjs')
const {
  FEATURE_SIZE,
  HASH_FEATURES,
  tokenize,
  featureVector,
  trainLogistic,
  scoreVector,
  accuracy,
  splitRows,
  skillFromEpisode,
  compactArgs,
  datasetLine,
  notebookCells,
  normalizeBaseUrl,
  bumpVersion,
  safeName,
  JOB_STATES,
} = learner._internals

function rowsForSuccess() {
  return Array.from({ length: 20 }, (_, i) => ({
    id: `${i % 2 ? 'a' : 'b'}_${String(i).padStart(2, '0')}`,
    y: i % 2 ? 1 : 0,
    x: featureVector({ goal: i % 2 ? 'write a status report' : 'delete system files', kind: 'agent', steps: i % 2 ? 3 : 0 }),
  }))
}

describe('nano features', () => {
  it('drops stopwords and keeps useful tokens', () => {
    const tokens = tokenize('Write a report from the logs and the drive')
    expect(tokens).toContain('write')
    expect(tokens).toContain('report')
    expect(tokens).not.toContain('the')
    expect(tokens).not.toContain('a')
  })

  it('builds a fixed-size sparse vector', () => {
    const vector = featureVector({ goal: 'write a status report', kind: 'agent', steps: 3, promptTokens: 100, completionTokens: 50 })
    expect(vector).toHaveLength(FEATURE_SIZE)
    expect(vector.some((value) => value > 0)).toBe(true)
    expect(vector.slice(HASH_FEATURES).filter((value) => value > 0).length).toBeGreaterThan(0)
  })

  it('is deterministic for the same input', () => {
    const a = featureVector({ goal: 'build a landing page', kind: 'workflow', steps: 7 })
    const b = featureVector({ goal: 'build a landing page', kind: 'workflow', steps: 7 })
    expect(a).toEqual(b)
  })
})

describe('nano trainer', () => {
  it('separates a clean two-class dataset', () => {
    const rows = rowsForSuccess()
    const model = trainLogistic(rows, { epochs: 200 })
    expect(accuracy(model, rows)).toBeGreaterThan(0.9)
    expect(model.curve.length).toBeGreaterThan(3)
    expect(model.curve[model.curve.length - 1].loss).toBeLessThan(model.curve[0].loss)
  })

  it('scores the two classes in opposite directions', () => {
    const rows = rowsForSuccess()
    const model = trainLogistic(rows, { epochs: 200 })
    const good = scoreVector(model, featureVector({ goal: 'write a status report', kind: 'agent', steps: 3 }))
    const bad = scoreVector(model, featureVector({ goal: 'delete system files', kind: 'agent', steps: 0 }))
    expect(good).toBeGreaterThan(0.5)
    expect(bad).toBeLessThan(0.5)
  })

  it('keeps a mixed holdout split', () => {
    const split = splitRows(rowsForSuccess())
    expect(split.validation).not.toBeNull()
    expect(split.validation.some((row) => row.y === 1)).toBe(true)
    expect(split.validation.some((row) => row.y === 0)).toBe(true)
  })

  it('falls back to the full set when a holdout is not representative', () => {
    const rows = rowsForSuccess().slice(0, 6)
    const split = splitRows(rows)
    if (split.validation) {
      expect(split.validation.length).toBeGreaterThanOrEqual(4)
    } else {
      expect(split.train).toHaveLength(rows.length)
    }
  })
})

describe('skill compiler', () => {
  const episode = {
    id: 'ep_1',
    runId: 'run_1',
    kind: 'agent',
    goal: 'write a status report from the logs',
    status: 'done',
    score: 0.9,
    actions: [
      { type: 'tool', name: 'fs_read', args: { path: 'logs/app.txt', apiKey: 'sk-never' }, ok: true, ms: 8 },
      { type: 'tool', name: 'fs_write', args: { path: 'report.md' }, ok: false, ms: 12 },
    ],
    outcome: { summary: 'report.md written' },
  }

  it('turns a recorded run into ordered steps', () => {
    const skill = skillFromEpisode(episode)
    expect(skill.steps).toHaveLength(2)
    expect(skill.steps[0].tool).toBe('fs_read')
    expect(skill.steps[1].ok).toBe(false)
    expect(skill.successCheck).toContain('report.md written')
  })

  it('never keeps credential arguments', () => {
    const skill = skillFromEpisode(episode)
    expect(JSON.stringify(skill)).not.toContain('sk-never')
    expect(compactArgs({ apiKey: 'x', token: 'y', path: 'z' })).toEqual({ path: 'z' })
  })

  it('notes failed tools in the avoid list', () => {
    const skill = skillFromEpisode(episode)
    expect(skill.avoid.length).toBe(1)
    expect(skill.avoid[0]).toContain('fs_write')
  })

  it('warns when the source run failed', () => {
    const skill = skillFromEpisode({ ...episode, status: 'failed', outcome: { summary: 'boom' } })
    expect(skill.successCheck).toMatch(/did not finish successfully/i)
  })

  it('bumps versions by patch', () => {
    expect(bumpVersion('1.0.0')).toBe('1.0.1')
    expect(bumpVersion('2.3.9')).toBe('2.3.10')
    expect(bumpVersion(null)).toBe('1.0.1')
  })
})

describe('progressive skill disclosure', () => {
  it('registers a read-only skill_load tool', () => {
    const def = learner.definitions.find((d) => d.name === 'skill_load')
    expect(def).toBeTruthy()
    expect(def.parameters.required).toEqual(['id'])
    expect(typeof learner.handlers.skill_load).toBe('function')
    expect(learner.approvalReason('skill_load')).toBeNull()
  })

  it('returns an empty catalog when the database is not ready', () => {
    expect(learner.skillCatalog()).toEqual([])
  })
})

describe('train kit', () => {
  const detail = {
    goal: 'write a status report',
    status: 'done',
    steps: 2,
    plan: { steps: ['collect logs', 'write report'] },
    actions: [{ type: 'tool', name: 'fs_write', args: { path: 'report.md' }, ok: true }],
    outcome: { summary: 'report.md written' },
    error: null,
  }

  it('emits chat-format rows', () => {
    const row = JSON.parse(datasetLine(detail))
    expect(row.messages).toHaveLength(3)
    expect(row.messages[0].role).toBe('system')
    expect(row.messages[1].content).toBe('write a status report')
    expect(row.messages[2].content).toContain('fs_write')
    expect(row.messages[2].content).toContain('report.md written')
  })

  it('renders a valid notebook with honest GPU notes', () => {
    const notebook = notebookCells({ datasetName: 'dataset.jsonl', baseModel: 'unsloth/Qwen2.5-1.5B-Instruct', episodes: 12 })
    expect(notebook.nbformat).toBe(4)
    expect(notebook.cells.length).toBeGreaterThanOrEqual(6)
    const text = JSON.stringify(notebook)
    expect(text).toContain('T4')
    expect(text).toContain('dataset.jsonl')
    expect(text).toContain('save_pretrained_gguf')
  })
})

describe('fine-tune guards', () => {
  it('normalizes HTTPS endpoints', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1')
    expect(normalizeBaseUrl('http://127.0.0.1:8000/v1')).toBe('http://127.0.0.1:8000/v1')
    expect(normalizeBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1')
  })

  it('refuses plain HTTP and embedded credentials', () => {
    expect(() => normalizeBaseUrl('http://example.com/v1')).toThrow(/HTTPS/i)
    expect(() => normalizeBaseUrl('https://user:pass@example.com/v1')).toThrow(/credentials/i)
    expect(() => normalizeBaseUrl('not a url')).toThrow(/not valid/i)
  })

  it('maps provider states onto its own', () => {
    expect(JOB_STATES.get('validating_files')).toBe('queued')
    expect(JOB_STATES.get('succeeded')).toBe('succeeded')
    expect(JOB_STATES.get('cancelled')).toBe('cancelled')
  })

  it('sanitizes file names for the vault', () => {
    expect(safeName('../evil name.gguf', 'fallback')).toBe('.. evil name.gguf')
    expect(safeName('', 'fallback')).toBe('fallback')
  })
})
