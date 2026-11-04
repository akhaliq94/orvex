import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const desktop = require('../../electron/desktop.cjs')

const win32 = process.platform === 'win32'

describe('UI automation control surface', () => {
  it('registers ui_wait and ui_sequence with real handlers', () => {
    const names = desktop.definitions.map((d) => d.name)
    expect(names).toContain('ui_wait')
    expect(names).toContain('ui_sequence')
    expect(typeof desktop.handlers.ui_wait).toBe('function')
    expect(typeof desktop.handlers.ui_sequence).toBe('function')
  })

  it('ui_action advertises the pre-flight force and overlay switches', () => {
    const def = desktop.definitions.find((d) => d.name === 'ui_action')
    expect(def.parameters.properties.force.type).toBe('boolean')
    expect(def.parameters.properties.overlay.type).toBe('boolean')
    expect(def.description).toMatch(/checks that the element is enabled and reachable/i)
  })

  it.skipIf(!win32)('ui_sequence rejects an empty list', async () => {
    const r = await desktop.handlers.ui_sequence({ steps: [] })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/non-empty array/)
  })

  it.skipIf(!win32)('ui_sequence caps the number of steps', async () => {
    const steps = Array.from({ length: 13 }, () => ({ path: '0/0', action: 'focus' }))
    const r = await desktop.handlers.ui_sequence({ steps })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/12 steps/)
  })

  it.skipIf(!win32)('ui_wait validates the state and the target', async () => {
    const badState = await desktop.handlers.ui_wait({ path: '0/0', state: 'sparkle' })
    expect(badState.ok).toBe(false)
    expect(badState.error).toMatch(/state must be one of/)
    const noTarget = await desktop.handlers.ui_wait({ state: 'exists' })
    expect(noTarget.ok).toBe(false)
    expect(noTarget.error).toMatch(/element path/i)
  })
})
