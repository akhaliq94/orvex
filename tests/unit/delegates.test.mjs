import { beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const delegates = require('../../electron/delegates.cjs')
const tools = require('../../electron/tools.cjs')

const chain = [{ baseUrl: 'https://example.test/v1', model: 'test-model' }]

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  delegates._reset()
  delegates._setSpawnForTests(null)
})

describe('background delegation', () => {
  it('refuses to start when no spawner is connected', () => {
    expect(() => delegates.start({ goal: 'check logs', parentRunId: 'run_a', chain })).toThrow(/not available/i)
  })

  it('runs a child to completion and reports its summary', async () => {
    const events = []
    delegates._setSpawnForTests(async ({ goal, agent, signal }) => {
      expect(goal).toBe('find the build notes')
      expect(agent).toBe('researcher')
      expect(signal instanceof AbortSignal).toBe(true)
      return { ok: true, summary: 'Found 2 notes in D:\\docs.' }
    })
    const task = delegates.start({ goal: 'find the build notes', agent: 'researcher', parentRunId: 'run_a', chain, emit: (event) => events.push(event) })
    expect(task.status).toBe('running')
    const finished = await delegates.wait(task.id, 'run_a', 5000)
    expect(finished.status).toBe('done')
    expect(finished.result).toContain('2 notes')
    expect(events.some((event) => event.type === 'delegate_start')).toBe(true)
    expect(events.some((event) => event.type === 'delegate_end')).toBe(true)
  })

  it('records a failed child without throwing in the parent', async () => {
    delegates._setSpawnForTests(async () => ({ ok: false, summary: 'model refused the task' }))
    const task = delegates.start({ goal: 'do it', parentRunId: 'run_a', chain })
    const finished = await delegates.wait(task.id, 'run_a', 5000)
    expect(finished.status).toBe('failed')
    expect(finished.error).toMatch(/refused/)
  })

  it('caps concurrent children and frees the slot after completion', async () => {
    const pending = [deferred(), deferred(), deferred()]
    let calls = 0
    delegates._setSpawnForTests(() => pending[calls++].promise)
    const first = delegates.start({ goal: 'one', parentRunId: 'run_a', chain })
    const second = delegates.start({ goal: 'two', parentRunId: 'run_a', chain })
    expect(() => delegates.start({ goal: 'three', parentRunId: 'run_a', chain })).toThrow(/at most 2/i)
    pending[0].resolve({ ok: true, summary: 'one done' })
    await delegates.wait(first.id, 'run_a', 5000)
    const third = delegates.start({ goal: 'three', parentRunId: 'run_a', chain })
    pending[1].resolve({ ok: true, summary: 'two done' })
    await delegates.wait(second.id, 'run_a', 5000)
    expect(third.status).toBe('running')
    delegates.cancel(third.id, 'run_a')
    pending[2].resolve({ cancelled: true, summary: 'Stopped' })
  })

  it('returns a timeout note instead of blocking forever', async () => {
    const pending = deferred()
    delegates._setSpawnForTests(() => pending.promise)
    const task = delegates.start({ goal: 'slow', parentRunId: 'run_a', chain })
    const view = await delegates.wait(task.id, 'run_a', 1000)
    expect(view.status).toBe('running')
    expect(view.note).toMatch(/still running/i)
    delegates.cancel(task.id, 'run_a')
    pending.resolve({ cancelled: true })
  })

  it('cancels a child and aborts its signal', async () => {
    let childSignal = null
    const pending = deferred()
    delegates._setSpawnForTests(({ signal }) => {
      childSignal = signal
      return pending.promise
    })
    const task = delegates.start({ goal: 'stop me', parentRunId: 'run_a', chain })
    await new Promise((resolve) => setImmediate(resolve))
    const stopped = delegates.cancel(task.id, 'run_a')
    expect(stopped.status).toBe('cancelled')
    expect(childSignal.aborted).toBe(true)
    pending.resolve({ cancelled: true })
    await delegates.wait(task.id, 'run_a', 1000)
  })

  it('keeps tasks scoped to the run that started them', () => {
    delegates._setSpawnForTests(() => new Promise(() => {}))
    const task = delegates.start({ goal: 'private', parentRunId: 'run_a', chain })
    expect(() => delegates.status(task.id, 'run_b')).toThrow(/different run/i)
    expect(() => delegates.cancel(task.id, 'run_b')).toThrow(/different run/i)
    delegates.cancel(task.id, 'run_a')
  })

  it('cancels every running child when the parent aborts', async () => {
    const controller = new AbortController()
    delegates._setSpawnForTests(
      ({ signal }) =>
        new Promise((resolve) => {
          const stop = () => resolve({ cancelled: true, summary: 'Stopped by parent.' })
          if (signal.aborted) stop()
          else signal.addEventListener('abort', stop, { once: true })
        }),
    )
    const task = delegates.start({ goal: 'child', parentRunId: 'run_a', chain, signal: controller.signal })
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort()
    const finished = await delegates.wait(task.id, 'run_a', 5000)
    expect(finished.status).toBe('cancelled')
  })

  it('denies approval-bound tools for unattended children', () => {
    expect(tools.unattendedDenial('fs_read', { path: 'C:/notes.txt' })).toBeNull()
    expect(tools.unattendedDenial('process_kill', { pid: 1 })).toMatch(/cannot ask the user for approval/i)
  })
})

function fakeStore(rows = []) {
  const saved = new Map(rows.map((row) => [row.id, { ...row }]))
  return {
    saved,
    save: (task) => saved.set(task.id, { ...task }),
    get: (id) => saved.get(id) || null,
    list: (limit) => [...saved.values()].slice(0, limit),
    markResumed: (id, resumedAs) => {
      const row = saved.get(id)
      if (row) row.resumedAs = resumedAs
    },
    interruptOpen: () => 0,
    prune: () => 0,
  }
}

describe('durable delegation queue', () => {
  it('persists a task when it starts and when it finishes', async () => {
    const store = fakeStore()
    delegates.init({ store, spawn: async () => ({ ok: true, summary: 'queued work done' }) })
    const task = delegates.start({ goal: 'draft the changelog', parentRunId: 'run_a', chain })
    expect(store.saved.get(task.id).status).toBe('running')
    await delegates.wait(task.id, 'run_a', 5000)
    expect(store.saved.get(task.id).status).toBe('done')
    expect(store.saved.get(task.id).result).toContain('queued work done')
  })

  it('resumes an interrupted durable task as a new child and links both rows', async () => {
    const old = {
      id: 'sub_old_1',
      agent: 'researcher',
      goal: 'finish the price table',
      status: 'interrupted',
      error: 'ORVEX stopped before this sub-agent finished.',
      createdAt: Date.now() - 60_000,
    }
    const store = fakeStore([old])
    let seenGoal = null
    delegates.init({ store, spawn: async ({ goal }) => {
      seenGoal = goal
      return { ok: true, summary: 'table finished' }
    } })
    const out = delegates.resume({ id: 'sub_old_1', parentRunId: 'run_b', chain })
    expect(out.previousStatus).toBe('interrupted')
    expect(out.task.resumeOf).toBe('sub_old_1')
    expect(store.saved.get('sub_old_1').resumedAs).toBe(out.task.id)
    const finished = await delegates.wait(out.task.id, 'run_b', 5000)
    expect(seenGoal).toBe('finish the price table')
    expect(finished.status).toBe('done')
  })

  it('refuses to resume an unknown or already finished task', () => {
    const store = fakeStore([{ id: 'sub_done_1', agent: 'worker', goal: 'x', status: 'done', createdAt: 1 }])
    delegates.init({ store, spawn: async () => ({ ok: true }) })
    expect(() => delegates.resume({ id: 'nope', parentRunId: 'run_b', chain })).toThrow(/no durable sub-agent task/i)
    expect(() => delegates.resume({ id: 'sub_done_1', parentRunId: 'run_b', chain })).toThrow(/only interrupted, failed or cancelled/i)
    expect(() => delegates.resume({ id: 'sub_done_1' })).toThrow(/no durable sub-agent task|only interrupted/i)
  })

  it('reports when the durable queue is unavailable', () => {
    delegates._setSpawnForTests(async () => ({ ok: true }))
    expect(delegates.queue()).toEqual({ available: false, tasks: [] })
    expect(() => delegates.resume({ id: 'x', parentRunId: 'run_a', chain })).toThrow(/not available/i)
  })
})
