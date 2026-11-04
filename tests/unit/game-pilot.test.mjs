import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const core = require('../../electron/game-core.cjs')

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

  it('clamps the interval and enforces the slower vision floor', () => {
    expect(core.normalizeProfile({ ...base, intervalMs: 10 }).intervalMs).toBe(500)
    expect(core.normalizeProfile({ ...base, intervalMs: 999999 }).intervalMs).toBe(15000)
    expect(
      core.normalizeProfile({ name: 'V', windowTitle: 'Game', policy: 'vision', actions: [{ key: 'W' }], intervalMs: 500 }).intervalMs,
    ).toBe(1000)
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
