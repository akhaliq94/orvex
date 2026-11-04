import { afterEach, describe, expect, it, vi } from 'vitest'
import { setAppInert } from '../../src/data/a11y'

const element = (keep = false) => ({
  inert: false,
  hasAttribute: (name) => keep && name === 'data-inert-keep',
})

function mount(children) {
  vi.stubGlobal('document', { querySelector: () => ({ children }) })
  return children
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('setAppInert', () => {
  it('inerts every sibling except the kept layer', () => {
    const [first, kept, last] = mount([element(), element(true), element()])
    setAppInert('test-lock', true)
    expect(first.inert).toBe(true)
    expect(last.inert).toBe(true)
    expect(kept.inert).toBe(false)
    setAppInert('test-lock', false)
  })

  it('stays inert while another overlay still holds it', () => {
    const [first] = mount([element()])
    setAppInert('test-lock', true)
    setAppInert('test-voice', true)
    setAppInert('test-lock', false)
    expect(first.inert).toBe(true)
    setAppInert('test-voice', false)
    expect(first.inert).toBe(false)
  })

  it('does nothing when the app root has not mounted yet', () => {
    vi.stubGlobal('document', { querySelector: () => null })
    expect(() => setAppInert('test-missing', true)).not.toThrow()
  })
})
