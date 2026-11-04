import { useCallback, useEffect, useRef, useState } from 'react'
import type { OrvexSecurityStatus } from '../types/desktop'

/**
 * Mirrors the main-process security state and feeds activity pings back so the
 * idle auto-lock works. Touch only happens while a PIN exists, a timeout is
 * set and ORVEX is not already locked.
 */
export function useSecurity() {
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const [status, setStatus] = useState<OrvexSecurityStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!bridge) return
    const res = await bridge.security.status()
    if (res.ok) {
      setStatus(res.data)
      setError(null)
    } else {
      setError(res.error)
    }
  }, [bridge])

  useEffect(() => {
    void refresh()
    if (!bridge) return
    const off = bridge.security.onChange((event) => setStatus(event.status))
    const t = window.setInterval(() => void refresh(), 20_000)
    return () => {
      off()
      window.clearInterval(t)
    }
  }, [bridge, refresh])

  const hasPin = useRef(false)
  const locked = useRef(false)
  const autolock = useRef(0)
  hasPin.current = Boolean(status?.hasPin)
  locked.current = Boolean(status?.locked)
  autolock.current = status?.autolockMinutes ?? 0

  useEffect(() => {
    if (!bridge) return
    let last = 0
    const onActivity = () => {
      if (!hasPin.current || locked.current || !autolock.current) return
      const at = Date.now()
      if (at - last < 15_000) return
      last = at
      void bridge.security.touch().catch(() => {})
    }
    const events = ['pointerdown', 'keydown', 'wheel', 'mousemove'] as const
    for (const name of events) window.addEventListener(name, onActivity, { passive: true })
    return () => {
      for (const name of events) window.removeEventListener(name, onActivity)
    }
  }, [bridge])

  return { status, error, refresh, setStatus }
}
