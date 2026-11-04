import { useCallback, useEffect, useRef, useState } from 'react'
import type { OrvexDashboardSnapshot } from '../types/desktop'

const bridge = typeof window !== 'undefined' ? window.orvex : undefined

export type MetricHistory = { cpu: number[]; ram: number[]; disk: number[]; gpu: number[] }

const HISTORY = 40

function messageOf(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function push(list: number[], value: number | null | undefined) {
  const next = Number.isFinite(Number(value)) ? [...list, Number(value)] : list
  return next.slice(-HISTORY)
}

/**
 * One poller for the whole home cockpit. Everything it returns comes from the
 * main process: real CPU/RAM/disk samples, audit rows, workflow runs, agent
 * runtime and session usage. Nothing is generated here.
 */
export function useDashboard(pollMs = 2500) {
  const [snapshot, setSnapshot] = useState<OrvexDashboardSnapshot | null>(null)
  const [history, setHistory] = useState<MetricHistory>({ cpu: [], ram: [], disk: [], gpu: [] })
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const alive = useRef(true)
  const seq = useRef(0)
  const inFlight = useRef(false)

  const load = useCallback(async (quiet = false) => {
    if (!bridge?.dashboard) {
      if (!quiet) {
        setLoading(false)
        setError('The desktop bridge is not available — run ORVEX as the desktop app.')
      }
      return
    }
    // A slow snapshot must not stack up behind the interval or overwrite a
    // newer answer with an older one.
    if (inFlight.current) return
    inFlight.current = true
    const id = ++seq.current
    if (!quiet) setLoading(true)
    try {
      const result = await bridge.dashboard.snapshot()
      if (!result.ok) throw new Error(result.error)
      if (!alive.current || id !== seq.current) return
      const snap = result.data
      setSnapshot(snap)
      setError(null)
      setHistory((prev) => ({
        cpu: push(prev.cpu, snap.metrics.cpuPercent),
        ram: push(prev.ram, snap.metrics.memory.percent),
        disk: push(prev.disk, snap.metrics.disk?.percent),
        gpu: push(prev.gpu, snap.metrics.gpu.available ? snap.metrics.gpu.percent : undefined),
      }))
    } catch (err) {
      if (alive.current && id === seq.current) setError(messageOf(err))
    } finally {
      inFlight.current = false
      if (alive.current && id === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    const timer = window.setInterval(() => void load(true), pollMs)
    return () => {
      alive.current = false
      window.clearInterval(timer)
    }
  }, [load, pollMs])

  return { snapshot, history, error, loading, reload: () => load(true) }
}
