import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const core = require('../../electron/game-core.cjs')
const gamePilot = require('../../electron/game-pilot.cjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const base = {
  name: 'Farming loop',
  windowTitle: 'Farming Simulator',
  goal: 'Reach 1000 coins',
  policy: 'macro',
  actions: [],
  macro: [{ keys: 'SPACE', waitMs: 800 }],
}

describe('pilot profile validation', () => {
  it('fills safe defaults and keeps the profile bounded', () => {
    const profile = core.normalizeProfile(base)
    expect(profile.id).toMatch(/^game_/)
    expect(profile.policy).toBe('macro')
    expect(profile.intervalMs).toBe(1500)
    expect(profile.maxMinutes).toBe(30)
    expect(profile.autoFocus).toBe(true)
    expect(profile.targetScore).toBeNull()
    expect(profile.actions.map((a) => a.key)).toEqual(['SPACE'])
  })

  it('requires a window title so keys can never go to an arbitrary window', () => {
    expect(() => core.normalizeProfile({ ...base, windowTitle: '' })).toThrow(/window title/i)
    expect(() => core.normalizeProfile({ ...base, name: '' })).toThrow(/name/i)
  })

  it('derives an action allow-list from the macro and dedupes keys', () => {
    const profile = core.normalizeProfile({
      ...base,
      actions: [{ key: 'space', label: 'jump' }, { key: 'SPACE' }, { key: 'A' }],
      macro: [{ keys: 'space@500' }, { keys: 'a@700' }],
    })
    expect(profile.actions.map((a) => a.key)).toEqual(['SPACE', 'A'])
    expect(profile.macro).toEqual([
      { keys: 'SPACE', waitMs: 500 },
      { keys: 'A', waitMs: 700 },
    ])
  })

  it('needs at least one step or key for the chosen policy', () => {
    expect(() => core.normalizeProfile({ ...base, policy: 'macro', macro: [] })).toThrow(/macro profile/i)
    expect(() => core.normalizeProfile({ name: 'V', windowTitle: 'Game', policy: 'vision', actions: [] })).toThrow(/vision profile/i)
  })

  it('clamps the interval and enforces the vision floor', () => {
    expect(core.normalizeProfile({ ...base, intervalMs: 10 }).intervalMs).toBe(100)
    expect(core.normalizeProfile({ ...base, intervalMs: 999999 }).intervalMs).toBe(15000)
    expect(
      core.normalizeProfile({ name: 'V', windowTitle: 'Game', policy: 'vision', actions: [{ key: 'W' }], intervalMs: 100 }).intervalMs,
    ).toBe(250)
    expect(core.normalizeProfile({ ...base, intervalMs: 250 }).intervalMs).toBe(250)
  })

  it('defaults the fast-run fields and clamps the gap between keys', () => {
    const profile = core.normalizeProfile({ ...base, actMs: 9999 })
    expect(profile.actMs).toBe(2000)
    expect(profile.reuseOnIdle).toBe(true)
    expect(core.normalizeProfile({ ...base, actMs: 1 }).actMs).toBe(40)
    expect(core.normalizeProfile({ ...base, reuseOnIdle: false }).reuseOnIdle).toBe(false)
  })

  it('validates regions and score settings', () => {
    expect(core.normalizeProfile({ ...base, region: '10,20,300,200' }).region).toEqual({ x: 10, y: 20, width: 300, height: 200 })
    expect(() => core.normalizeProfile({ ...base, region: 'x,y,z,w' })).toThrow(/four numbers/i)
    expect(() => core.normalizeProfile({ ...base, region: '0,0,10,10' })).toThrow(/40x30/i)
    expect(() => core.normalizeProfile({ ...base, scoreRegex: '(' })).toThrow(/regular expression/i)
    expect(() => core.normalizeProfile({ ...base, targetScore: 100 })).toThrow(/score pattern or a score region/i)
    expect(core.normalizeProfile({ ...base, targetScore: 100, scoreRegex: 'coins\\D+(\\d+)' }).targetScore).toBe(100)
  })

  it('caps the action and macro lists instead of growing without bound', () => {
    const actions = Array.from({ length: 30 }, (_, i) => ({ key: `K${i}` }))
    const macro = Array.from({ length: 30 }, (_, i) => ({ keys: `M${i}`, waitMs: 0 }))
    const profile = core.normalizeProfile({ ...base, actions, macro })
    expect(profile.actions.length).toBeLessThanOrEqual(core.MAX_ACTIONS)
    expect(profile.macro.length).toBe(core.MAX_MACRO_STEPS)
  })
})

describe('score parsing', () => {
  it('prefers the regex capture group over unrelated numbers', () => {
    expect(core.parseScore('Level 3 — score: 12,480 coins', 'score:\\s*([\\d,]+)')).toBe(12480)
  })

  it('falls back to the first number when the pattern does not match a number', () => {
    expect(core.parseScore('Coins 1,234', 'gold=(\\w+)')).toBe(1234)
    expect(core.parseScore('12.5 points')).toBe(12.5)
  })

  it('returns null when nothing numeric is on screen', () => {
    expect(core.parseScore('')).toBeNull()
    expect(core.parseScore('loading…')).toBeNull()
    expect(core.parseScore('abc', 'score=(\\d+)')).toBeNull()
  })
})

describe('decision parsing', () => {
  const allowed = ['W', 'A', 'SPACE', 'CTRL+S']

  it('accepts a fenced JSON action and canonicalises the key', () => {
    expect(core.parseDecision('```json\n{"action":"key","key":"space","reason":"jump"}\n```', allowed)).toMatchObject({
      type: 'key',
      key: 'SPACE',
    })
  })

  it('accepts combos only when the whole combo is allowed', () => {
    expect(core.parseDecision('{"key":"ctrl+s"}', allowed)).toMatchObject({ type: 'key', key: 'CTRL+S' })
    expect(core.parseDecision('{"key":"CTRL+X"}', allowed)).toBeNull()
  })

  it('rejects keys, actions and mouse input outside the allow-list', () => {
    expect(core.parseDecision('{"action":"key","key":"Q"}', allowed)).toBeNull()
    expect(core.parseDecision('{"action":"click","x":10,"y":10}', allowed)).toBeNull()
    expect(core.parseDecision('press W now', allowed)).toBeNull()
    expect(core.parseDecision('{"action":"key"}', allowed)).toBeNull()
  })

  it('bounds wait requests and surfaces stop reasons', () => {
    expect(core.parseDecision('{"action":"wait","ms":999999}', allowed)).toMatchObject({ type: 'wait', ms: 10000 })
    expect(core.parseDecision('{"action":"wait","ms":10}', allowed)).toMatchObject({ type: 'wait', ms: 250 })
    expect(core.parseDecision('{"action":"stop","reason":"game over"}', allowed)).toMatchObject({
      type: 'stop',
      reason: 'game over',
    })
  })

  it('extracts a balanced object out of surrounding prose', () => {
    const action = core.parseDecision('I think {"action":"key","key":"A","reason":"brace { in text"} is best.', allowed)
    expect(action).toMatchObject({ type: 'key', key: 'A' })
    expect(core.extractJson('no object here')).toBeNull()
  })
})

describe('fast batches', () => {
  const allowed = ['W', 'A', 'SPACE']

  it('keeps an ordered batch and drops keys outside the allow-list', () => {
    const batch = core.parseBatch(
      '{"actions":[{"key":"space","waitMs":50},{"key":"Q"},{"key":"A","waitMs":9999}]}',
      allowed,
      { actMs: 120 },
    )
    expect(batch.type).toBe('batch')
    expect(batch.actions.map((a) => a.key)).toEqual(['SPACE', 'A'])
    expect(batch.actions[0].waitMs).toBe(50)
    expect(batch.actions[1].waitMs).toBe(2000)
    expect(batch.stopAfter).toBe(false)
  })

  it('stops after the actions that precede a stop entry', () => {
    const batch = core.parseBatch('{"actions":[{"key":"W"},{"action":"stop","reason":"menu"}]}', allowed)
    expect(batch.actions.map((a) => a.key)).toEqual(['W'])
    expect(batch.stopAfter).toBe(true)
  })

  it('caps the batch size and returns null when nothing usable remains', () => {
    const many = JSON.stringify({ actions: Array.from({ length: 12 }, () => ({ key: 'W' })) })
    expect(core.parseBatch(many, allowed).actions).toHaveLength(core.MAX_BATCH)
    expect(core.parseBatch('{"actions":[{"key":"Q"},{"key":"Z"}]}', allowed)).toBeNull()
    expect(core.parseBatch('{"actions":[]}', allowed)).toBeNull()
    expect(core.parseBatch('no json here', allowed)).toBeNull()
  })

  it('accepts a single action, wait or stop through the same parser', () => {
    expect(core.parseBatch('{"key":"w"}', allowed)).toMatchObject({ type: 'batch', actions: [{ key: 'W' }] })
    expect(core.parseBatch('{"action":"wait","ms":10}', allowed)).toMatchObject({ actions: [{ type: 'wait', ms: 250 }] })
    expect(core.parseBatch('{"action":"stop","reason":"game over"}', allowed)).toMatchObject({ type: 'stop', reason: 'game over' })
    expect(core.parseBatch('{"key":"Q"}', allowed)).toBeNull()
  })

  it('runs a whole batch from one model call and reuses it while the frame is unchanged', async () => {
    const file = path.join(os.tmpdir(), `orvex-frame-${process.pid}-${Date.now()}.png`)
    fs.writeFileSync(file, 'identical-frame')
    const pressed = []
    let asked = 0
    gamePilot.init({
      platform: 'win32',
      desktop: {
        windowList: async () => ({ ok: true, windows: [{ title: 'Test Game', foreground: true, hwnd: 1, pid: 1 }] }),
        screenCapture: async () => ({ ok: true, file, width: 800, height: 600 }),
        keyPress: async ({ keys }) => {
          pressed.push(keys)
          return { ok: true }
        },
        windowAction: async () => ({ ok: true }),
      },
      ocr: async () => ({ ok: false }),
      ask: async () => {
        asked += 1
        return '{"actions":[{"key":"W"},{"key":"A"}]}'
      },
      emit: () => {},
      isStopped: () => false,
    })
    const profile = core.normalizeProfile({
      name: 'Fast vision',
      windowTitle: 'Test Game',
      policy: 'vision',
      actions: [{ key: 'W' }, { key: 'A' }],
      intervalMs: 250,
      actMs: 40,
      maxMinutes: 1,
    })
    const startedAt = Date.now()
    const run = {
      id: 'run_test',
      profile,
      startedAt,
      deadline: startedAt + 60_000,
      ticks: 0,
      bestScore: null,
      lastScore: null,
      lastAction: '',
      lastNote: '',
      stopReason: null,
      stopRequested: false,
      error: null,
      window: null,
      history: [],
      lastSig: '',
      lastBatch: null,
      idleRepeats: 0,
      reused: 0,
      macroIndex: 0,
      misses: 0,
      captureErrors: 0,
      inputErrors: 0,
      nextTickAt: startedAt,
      hotkeyRegistered: false,
      finished: false,
    }
    const running = gamePilot._internals.loop(run)
    await sleep(1000)
    run.stopRequested = true
    await Promise.race([running, sleep(4000)])
    fs.rmSync(file, { force: true })
    expect(asked).toBeLessThanOrEqual(3)
    expect(pressed.length).toBeGreaterThanOrEqual(4)
    expect(pressed.every((key) => key === 'W' || key === 'A')).toBe(true)
    expect(run.reused).toBeGreaterThan(0)
  })
})

describe('macro ordering', () => {
  it('wraps around the step list', () => {
    const profile = core.normalizeProfile({
      ...base,
      macro: [{ keys: 'A' }, { keys: 'B' }, { keys: 'C' }],
    })
    expect(core.nextMacroStep(profile, 0)).toEqual({ step: { keys: 'A', waitMs: 0 }, index: 0 })
    expect(core.nextMacroStep(profile, 2)).toEqual({ step: { keys: 'C', waitMs: 0 }, index: 2 })
    expect(core.nextMacroStep(profile, 3).index).toBe(0)
    expect(core.nextMacroStep(profile, -1).index).toBe(2)
    expect(core.nextMacroStep({ ...profile, macro: [] }, 0)).toBeNull()
  })

  it('labels stop reasons for the UI', () => {
    expect(core.stopReasonLabel('window')).toMatch(/foreground/i)
    expect(core.stopReasonLabel('target')).toMatch(/target/i)
    expect(core.stopReasonLabel('weird')).toBe('weird')
  })
})
