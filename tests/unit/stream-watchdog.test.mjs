import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { StreamWatchdog } = require('../../electron/stream-watchdog.cjs')

afterEach(() => {
  vi.useRealTimers()
})

describe('stream stall watchdog', () => {
  it('fires only after real silence following the first chunk', () => {
    vi.useFakeTimers()
    const onStall = vi.fn()
    const wd = new StreamWatchdog({ windowMs: 5000, onStall })
    wd.progress()
    vi.advanceTimersByTime(4999)
    expect(onStall).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onStall).toHaveBeenCalledTimes(1)
    expect(wd.fired).toBe(true)
  })

  it('re-arms on every later chunk, so steady output never trips it', () => {
    vi.useFakeTimers()
    const onStall = vi.fn()
    const wd = new StreamWatchdog({ windowMs: 5000, onStall })
    for (let i = 0; i < 6; i += 1) {
      wd.progress()
      vi.advanceTimersByTime(4000)
    }
    expect(onStall).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1001)
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('stays quiet once finished and never re-fires', () => {
    vi.useFakeTimers()
    const onStall = vi.fn()
    const wd = new StreamWatchdog({ windowMs: 1000, onStall })
    wd.progress()
    wd.finish()
    vi.advanceTimersByTime(5000)
    expect(onStall).not.toHaveBeenCalled()
    wd.progress()
    vi.advanceTimersByTime(5000)
    expect(onStall).not.toHaveBeenCalled()
    expect(wd.fired).toBe(false)
  })

  it('does not arm when the window is disabled or a callback throws', () => {
    const quiet = new StreamWatchdog({ windowMs: 0 })
    quiet.progress()
    expect(quiet.fired).toBe(false)
    quiet.finish()
    vi.useFakeTimers()
    const wd = new StreamWatchdog({ windowMs: 1000, onStall: () => { throw new Error('boom') } })
    wd.progress()
    expect(() => vi.advanceTimersByTime(1001)).not.toThrow()
    expect(wd.fired).toBe(true)
  })
})
