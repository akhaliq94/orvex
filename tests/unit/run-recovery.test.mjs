import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const db = require('../../electron/db.cjs')
const recovery = require('../../electron/run-recovery.cjs')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-runs-'))
// better-sqlite3 is built for Electron's ABI; under plain Node it cannot load.
// The same SQL path is exercised by scripts/smoke-advanced.cjs in Electron.
let dbOk = false
try {
  dbOk = !!db.init({ file: path.join(dir, 'runs.db') })
} catch {
  dbOk = false
}

const sql = () => db.raw()

function insertRun(id, status, checkpoint, { goal = `goal ${id}`, startedAt = Date.now() } = {}) {
  sql()
    .prepare('INSERT INTO runs(id, goal, status, steps, started_at, checkpoint) VALUES(?, ?, ?, ?, ?, ?)')
    .run(id, goal, status, 0, startedAt, checkpoint ? JSON.stringify(checkpoint) : null)
}

function insertStep(runId, idx, status) {
  sql().prepare('INSERT INTO run_steps(run_id, idx, status) VALUES(?, ?, ?)').run(runId, idx, status)
}

const plan = [{ id: 's1', title: 'One', goal: 'do one', status: 'done' }]
const checkpoint = (over = {}) => ({
  mode: 'orchestrator',
  status: 'running',
  plan,
  nextIdx: 1,
  provider: { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'openai', model: 'gpt-4o' },
  candidates: [],
  ...over,
})

afterAll(() => {
  if (dbOk) db.close()
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* temp cleanup is best-effort */
  }
})

describe.skipIf(!dbOk)('runsMarkStale', () => {
  it('turns rows left by a dead process into interrupted runs and steps', () => {
    insertRun('stale-running', 'running', checkpoint())
    insertRun('stale-paused', 'paused', checkpoint({ status: 'paused' }))
    insertRun('finished', 'ok', null)
    insertStep('stale-running', 0, 'done')
    insertStep('stale-running', 1, 'running')

    const changed = db.runsMarkStale(1234)
    expect(changed).toEqual({ runs: 2, steps: 1 })

    const rows = sql().prepare('SELECT id, status, ended_at AS endedAt FROM runs ORDER BY id').all()
    expect(rows.find((r) => r.id === 'stale-running')).toMatchObject({ status: 'interrupted', endedAt: 1234 })
    expect(rows.find((r) => r.id === 'stale-paused').status).toBe('interrupted')
    expect(rows.find((r) => r.id === 'finished').status).toBe('ok')

    const steps = sql().prepare('SELECT idx, status FROM run_steps WHERE run_id = ? ORDER BY idx').all('stale-running')
    expect(steps).toEqual([
      { idx: 0, status: 'done' },
      { idx: 1, status: 'interrupted' },
    ])
  })

  it('lists interrupted runs with a parsed checkpoint', () => {
    const unfinished = db.runsUnfinished(20)
    const ids = unfinished.map((run) => run.id)
    expect(ids).toContain('stale-running')
    expect(ids).toContain('stale-paused')
    expect(ids).not.toContain('finished')
    const target = unfinished.find((run) => run.id === 'stale-running')
    expect(target.checkpoint.plan).toHaveLength(1)
    expect(target.checkpoint.provider.model).toBe('gpt-4o')
  })
})

describe('autoResumeTarget', () => {
  const run = (over = {}) => ({
    id: 'run_1',
    goal: 'write the report',
    status: 'interrupted',
    checkpoint: checkpoint(),
    ...over,
  })

  it('builds a resume payload without the API key', () => {
    const target = recovery.autoResumeTarget([
      run({ checkpoint: checkpoint({ provider: { ...checkpoint().provider, apiKey: 'sk-never-save' } }) }),
    ])
    expect(target).toMatchObject({ runId: 'run_1', goal: 'write the report', task: 'agent' })
    expect(target.provider).toMatchObject({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' })
    expect(target.provider.apiKey).toBeUndefined()
  })

  it('keeps the checkpoint task and de-duplicates candidates', () => {
    const target = recovery.autoResumeTarget([
      run({
        checkpoint: checkpoint({
          task: 'code',
          candidates: [
            { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
            { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
            { baseUrl: '', model: 'broken' },
          ],
        }),
      }),
    ])
    expect(target.task).toBe('code')
    expect(target.candidates).toEqual([
      { id: undefined, presetId: undefined, name: undefined, baseUrl: 'https://api.openai.com/v1', api: 'openai', model: 'gpt-4o' },
    ])
  })

  it('ignores paused, failed, agent-mode and provider-less runs', () => {
    expect(recovery.autoResumeTarget([run({ checkpoint: checkpoint({ status: 'paused' }) })])).toBeNull()
    expect(recovery.autoResumeTarget([run({ status: 'failed' })])).toBeNull()
    expect(recovery.autoResumeTarget([run({ checkpoint: checkpoint({ mode: 'agent' }) })])).toBeNull()
    expect(recovery.autoResumeTarget([run({ checkpoint: checkpoint({ plan: [] }) })])).toBeNull()
    expect(recovery.autoResumeTarget([run({ checkpoint: checkpoint({ provider: null }) })])).toBeNull()
  })

  it('picks the first eligible run so the newest one wins', () => {
    const target = recovery.autoResumeTarget([
      run({ id: 'older', checkpoint: checkpoint({ status: 'paused' }) }),
      run({ id: 'newer' }),
      run({ id: 'oldest' }),
    ])
    expect(target.runId).toBe('newer')
  })
})
