import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const hands = require('../../electron/hands.cjs')

function fakeDesktop(overrides = {}) {
  return {
    screenCapture: async () => ({ ok: true, image: 'shot.png' }),
    mouseClick: async () => ({ ok: true, output: 'clicked' }),
    screenClickText: async () => ({ ok: true, output: 'clicked label' }),
    keyType: async () => ({ ok: true, output: 'typed' }),
    keyPress: async () => ({ ok: true, output: 'pressed' }),
    mouseScroll: async () => ({ ok: true, output: 'scrolled' }),
    waitFor: async () => ({ ok: true, output: 'waited' }),
    appLaunch: async () => ({ ok: true, output: 'launched' }),
    ...overrides,
  }
}

function answerOnce(raw) {
  let used = false
  return async () => {
    if (used) throw new Error('the model was asked again after it finished')
    used = true
    return raw
  }
}

function controls(count) {
  return Array.from({ length: count }, (_, i) => ({
    name: `Button ${i}`,
    patterns: ['InvokePattern'],
    offscreen: false,
    w: 90,
    h: 28,
  }))
}

function treeResult(count) {
  const root = { name: 'Window', patterns: [], offscreen: false, w: 800, h: 600, children: controls(count) }
  return { ok: true, output: `[0] Window\n${controls(count).map((c, i) => `  [0/${i}] ${c.name}`).join('\n')}`, tree: root }
}

describe('action parsing', () => {
  it('reads plain, fenced and surrounded JSON', () => {
    expect(hands._internals.extractJson('{"action":"done"}')).toEqual({ action: 'done' })
    expect(hands._internals.extractJson('```json\n{"action":"wait","ms":10}\n```')).toEqual({ action: 'wait', ms: 10 })
    expect(hands._internals.extractJson('I will click now: {"action":"click","x":1,"y":2} ok')).toEqual({ action: 'click', x: 1, y: 2 })
  })

  it('rejects empty and non-JSON replies', () => {
    expect(() => hands._internals.extractJson('')).toThrow(/empty/i)
    expect(() => hands._internals.extractJson('no object here')).toThrow(/not a JSON action/i)
  })

  it('normalizes a click and clamps the button and count', () => {
    const action = hands.parseAction('{"action":"click","x":10.4,"y":20.6,"button":"nope","count":9}')
    expect(action).toMatchObject({ action: 'click', x: 10, y: 21, button: 'left', count: 3 })
    expect(hands.parseAction('{"action":"click","x":1,"y":2,"button":"right","count":0}').count).toBe(1)
  })

  it('refuses clicks outside the screen and non-numeric coordinates', () => {
    expect(() => hands.parseAction('{"action":"click","x":-1,"y":3}')).toThrow(/outside/i)
    expect(() => hands.parseAction('{"action":"click","x":30000,"y":3}')).toThrow(/outside/i)
    expect(() => hands.parseAction('{"action":"click","x":"abc","y":3}')).toThrow(/number/i)
  })

  it('validates the other actions and clamps numeric ranges', () => {
    expect(() => hands.parseAction('{"action":"click_text","text":""}')).toThrow(/visible label/i)
    expect(hands.parseAction('{"action":"type","text":"hello"}').text).toBe('hello')
    expect(() => hands.parseAction('{"action":"type","text":""}')).toThrow(/needs text/i)
    expect(() => hands.parseAction(`{"action":"type","text":"${'x'.repeat(2001)}"}`)).toThrow(/2000/)
    expect(() => hands.parseAction('{"action":"key","keys":"  "}')).toThrow(/needs a key/i)
    expect(hands.parseAction('{"action":"scroll","amount":99}').amount).toBe(20)
    expect(hands.parseAction('{"action":"scroll","amount":-99}').amount).toBe(-20)
    expect(hands.parseAction('{"action":"wait","ms":5}').ms).toBe(100)
    expect(hands.parseAction('{"action":"wait","ms":99999}').ms).toBe(5000)
    expect(() => hands.parseAction('{"action":"open_app","name":""}')).toThrow(/app name/i)
    expect(() => hands.parseAction('{"action":"format_disk"}')).toThrow(/Unsupported action/i)
  })

  it('turns done and fail into safe actions', () => {
    expect(hands.parseAction('{"action":"done"}')).toMatchObject({ action: 'done', summary: 'Done.' })
    expect(hands.parseAction('{"action":"fail"}')).toMatchObject({ action: 'fail', reason: 'The model stopped without a reason.' })
  })

  it('summarizes each action for the step log', () => {
    const summarize = hands._internals.summarizeAction
    expect(summarize({ action: 'click', x: 4, y: 5 })).toBe('click 4,5')
    expect(summarize({ action: 'click_text', text: 'Save' })).toBe('click "Save"')
    expect(summarize({ action: 'key', keys: 'CTRL+S' })).toBe('press CTRL+S')
    expect(summarize({ action: 'open_app', name: 'Notepad' })).toBe('open Notepad')
    expect(summarize({ action: 'ui_click', path: '[0/1]' })).toBe('click path [0/1]')
    expect(summarize({ action: 'ui_toggle', match: 'Bold' })).toBe('toggle "Bold"')
  })

  it('accepts path-based UI actions and requires a target', () => {
    expect(hands.parseAction('{"action":"ui_click","path":"[0/1/2]"}')).toMatchObject({ action: 'ui_click', path: '[0/1/2]' })
    expect(hands.parseAction('{"action":"ui_click","match":"Save"}').match).toBe('Save')
    expect(() => hands.parseAction('{"action":"ui_click"}')).toThrow(/needs a path/i)
    expect(hands.parseAction('{"action":"ui_set_value","path":"[0]","value":"hello"}').value).toBe('hello')
    expect(() => hands.parseAction('{"action":"ui_set_value","path":"[0]"}')).toThrow(/needs a value/i)
    expect(() => hands.parseAction(`{"action":"ui_set_value","path":"[0]","value":"${'x'.repeat(2001)}"}`)).toThrow(/2000/)
    expect(hands.parseAction('{"action":"ui_focus","path":"[0]","type":"Edit"}')).toMatchObject({ type: 'Edit' })
  })

  it('describes approval in plain language', () => {
    const reason = hands.approvalReason({ goal: 'open notepad', maxSteps: 99 })
    expect(reason).toMatch(/up to 12 steps/)
    expect(reason).toMatch(/open notepad/)
    expect(hands.definitions.map((d) => d.name)).toContain('hands_run')
    expect(typeof hands.handlers.hands_run).toBe('function')
    expect(hands.MAX_STEPS).toBe(12)
  })
})

describe('hands loop', () => {
  afterEach(() => {
    hands.init({ desktop: null, ask: null, emit: () => {}, isStopped: () => false })
  })

  beforeEach(() => {
    hands.init({ desktop: fakeDesktop(), ask: null, emit: () => {}, isStopped: () => false })
  })

  it('needs a goal and a vision model', async () => {
    await expect(hands.runTask({ goal: 'hi' })).rejects.toThrow(/clear goal/i)
    await expect(hands.runTask({ goal: 'open notepad' })).rejects.toThrow(/vision-capable model/i)
  })

  it('needs the desktop bridge to capture the screen', async () => {
    hands.init({ desktop: null, ask: answerOnce('{"action":"done"}') })
    await expect(hands.runTask({ goal: 'open notepad' })).rejects.toThrow(/Desktop control is not connected/i)
  })

  it('finishes without acting when the model says done', async () => {
    const events = []
    hands.init({ desktop: fakeDesktop(), ask: answerOnce('{"action":"done","summary":"Notepad is open"}'), emit: (e) => events.push(e) })
    const result = await hands.runTask({ goal: 'open notepad' })
    expect(result.ok).toBe(true)
    expect(result.completed).toBe(true)
    expect(result.note).toBe('Notepad is open')
    expect(result.steps).toHaveLength(1)
    expect(events.some((e) => e.type === 'step' && e.what === 'done')).toBe(true)
  })

  it('executes a real action then finishes', async () => {
    const calls = []
    const ask = (() => {
      const replies = ['{"action":"open_app","name":"Notepad"}', '{"action":"done","summary":"opened"}']
      return async () => replies.shift()
    })()
    hands.init({
      desktop: fakeDesktop({
        appLaunch: async (args) => {
          calls.push(args)
          return { ok: true, output: 'Launched Notepad' }
        },
      }),
      ask,
    })
    const result = await hands.runTask({ goal: 'open notepad' })
    expect(result.ok).toBe(true)
    expect(calls).toEqual([{ name: 'Notepad' }])
    expect(result.steps[0]).toMatchObject({ what: 'open Notepad', ok: true })
    expect(result.done).toBe(2)
  })

  it('clicks text through the desktop bridge', async () => {
    let clicked = null
    const ask = (() => {
      const replies = ['{"action":"click_text","text":"Save"}', '{"action":"done"}']
      return async () => replies.shift()
    })()
    hands.init({
      desktop: fakeDesktop({
        screenClickText: async (args) => {
          clicked = args
          return { ok: true, output: 'clicked' }
        },
      }),
      ask,
    })
    const result = await hands.runTask({ goal: 'save the document' })
    expect(result.ok).toBe(true)
    expect(clicked).toMatchObject({ text: 'Save', limit: 10 })
  })

  it('stops after two failing actions in a row', async () => {
    hands.init({
      desktop: fakeDesktop({ mouseClick: async () => ({ ok: false, error: 'no window here' }) }),
      ask: async () => '{"action":"click","x":5,"y":5}',
    })
    const result = await hands.runTask({ goal: 'press the button', maxSteps: 6 })
    expect(result.ok).toBe(false)
    expect(result.completed).toBe(false)
    expect(result.steps).toHaveLength(2)
    expect(result.note).toMatch(/Two actions failed/i)
  })

  it('stops when the model reports failure', async () => {
    hands.init({ desktop: fakeDesktop(), ask: answerOnce('{"action":"fail","reason":"the dialog is missing"}') })
    const result = await hands.runTask({ goal: 'close the dialog' })
    expect(result.ok).toBe(false)
    expect(result.note).toBe('the dialog is missing')
    expect(result.output).toMatch(/did not finish/i)
  })

  it('records a bad model reply instead of guessing', async () => {
    hands.init({ desktop: fakeDesktop(), ask: answerOnce('I cannot do that') })
    const result = await hands.runTask({ goal: 'close the dialog' })
    expect(result.ok).toBe(false)
    expect(result.steps[0]).toMatchObject({ what: 'model reply', ok: false })
    expect(result.steps[0].error).toMatch(/not a JSON action/i)
  })

  it('honours the stop signal before the first step', async () => {
    const controller = new AbortController()
    controller.abort()
    hands.init({ desktop: fakeDesktop(), ask: answerOnce('{"action":"done"}') })
    const result = await hands.runTask({ goal: 'open notepad', signal: controller.signal })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/stopped by the user/i)
  })

  it('honours the emergency stop hook', async () => {
    hands.init({ desktop: fakeDesktop(), ask: answerOnce('{"action":"done"}'), isStopped: () => true })
    const result = await hands.runTask({ goal: 'open notepad' })
    expect(result.ok).toBe(false)
    expect(result.steps).toHaveLength(0)
  })

  it('reports a failed screenshot instead of acting blind', async () => {
    hands.init({ desktop: fakeDesktop({ screenCapture: async () => ({ ok: false, error: 'no display' }) }), ask: async () => '{"action":"done"}' })
    const result = await hands.runTask({ goal: 'open notepad' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('no display')
  })
})

describe('tree-first loop', () => {
  afterEach(() => {
    hands.init({ desktop: null, ask: null, emit: () => {}, isStopped: () => false })
  })

  it('sends the tree instead of a screenshot when controls exist', async () => {
    const seen = []
    const ask = (() => {
      const replies = ['{"action":"ui_click","path":"[0/1]"}', '{"action":"done","summary":"clicked"}']
      return async (args) => {
        seen.push(args)
        return replies.shift()
      }
    })()
    const calls = []
    hands.init({
      desktop: fakeDesktop({
        uiTree: async () => treeResult(4),
        uiAction: async (args) => {
          calls.push(args)
          return { ok: true, output: 'invoked' }
        },
      }),
      ask,
    })
    const result = await hands.runTask({ goal: 'press Button 1' })
    expect(result.ok).toBe(true)
    expect(seen[0].shot).toBeNull()
    expect(seen[0].tree).toMatch(/Button 1/)
    expect(calls[0]).toEqual({ action: 'click', path: '[0/1]', match: undefined, type: undefined, value: undefined })
    expect(result.steps[0]).toMatchObject({ what: 'click path [0/1]', ok: true, mode: 'tree' })
  })

  it('refuses pixel clicks when only the tree was shown', async () => {
    hands.init({
      desktop: fakeDesktop({ uiTree: async () => treeResult(4), uiAction: async () => ({ ok: true }) }),
      ask: answerOnce('{"action":"click","x":10,"y":10}'),
    })
    const result = await hands.runTask({ goal: 'press the button' })
    expect(result.ok).toBe(false)
    expect(result.steps[0]).toMatchObject({ what: 'model reply', mode: 'tree' })
    expect(result.steps[0].error).toMatch(/pixel coordinates are unsafe/i)
  })

  it('falls back to the screenshot when the tree has too few controls', async () => {
    const seen = []
    hands.init({
      desktop: fakeDesktop({ uiTree: async () => treeResult(1) }),
      ask: (() => {
        const replies = ['{"action":"click_text","text":"Save"}', '{"action":"done"}']
        return async (args) => {
          seen.push(args)
          return replies.shift()
        }
      })(),
    })
    const result = await hands.runTask({ goal: 'save the document' })
    expect(result.ok).toBe(true)
    expect(seen[0].tree).toBe('')
    expect(seen[0].shot).toMatchObject({ ok: true, image: 'shot.png' })
    expect(result.steps[0].mode).toBe('vision')
  })

  it('falls back to the screenshot when the tree read fails', async () => {
    const seen = []
    hands.init({
      desktop: fakeDesktop({
        uiTree: async () => {
          throw new Error('uia host died')
        },
      }),
      ask: (() => {
        const replies = ['{"action":"done"}']
        return async (args) => {
          seen.push(args)
          return replies.shift()
        }
      })(),
    })
    const result = await hands.runTask({ goal: 'look at the window' })
    expect(result.ok).toBe(true)
    expect(seen[0].shot).toMatchObject({ ok: true })
    expect(result.steps[0].mode).toBe('vision')
  })

  it('reports a node with no UIA bridge instead of inventing an action', async () => {
    hands.init({
      desktop: fakeDesktop({ uiTree: async () => treeResult(4) }),
      ask: async () => '{"action":"ui_click","path":"[0/1]"}',
    })
    const result = await hands.runTask({ goal: 'press the button' })
    expect(result.ok).toBe(false)
    expect(result.steps[0].error).toMatch(/UI Automation is not connected/i)
    expect(result.note).toMatch(/Two actions failed/i)
  })
})
