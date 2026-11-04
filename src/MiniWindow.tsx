import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Bot, Play, Square, Workflow, X } from 'lucide-react'
import OrvexMark from './components/OrvexMark'
import { THEMES, themeVars } from './themes'
import type { OrvexDashboardSnapshot } from './types/desktop'

const bridge = typeof window !== 'undefined' ? window.orvex : undefined

function ago(ts: number) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

export default function MiniWindow() {
  const [snap, setSnap] = useState<OrvexDashboardSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const timer = useRef(0)

  const load = useCallback(async () => {
    if (!bridge) {
      setError('Mini window runs inside the ORVEX desktop app.')
      return
    }
    const res = await bridge.dashboard.snapshot()
    if (res.ok) {
      setSnap(res.data)
      setError(null)
    } else {
      setError(res.error)
    }
  }, [])

  useEffect(() => {
    void load()
    timer.current = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 2500)
    return () => window.clearInterval(timer.current)
  }, [load])

  const windowAction = async (action: 'showMain' | 'closeMini' | 'navigate', extra?: { id?: string }) => {
    if (!bridge) return
    const res = await bridge.app.window(action, extra)
    if (!res.ok) setError(res.error)
  }

  const stopRun = async () => {
    if (!bridge || !snap?.agent.running) return
    setBusy('stop')
    try {
      const res = await bridge.agent.stop()
      if (!res.ok) throw new Error(res.error)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const activeTasks = useMemo(() => {
    if (!snap) return 0
    const workflowRuns = snap.workflows.runs.filter((r) =>
      ['queued', 'running', 'awaiting_approval'].includes(r.status),
    ).length
    const orchestrator = snap.runs.filter((r) => ['running', 'planning', 'working'].includes(String(r.status))).length
    return workflowRuns + orchestrator + (snap.agent.running ? 1 : 0)
  }, [snap])

  const agent = snap?.agent
  const status = !agent ? 'connecting' : agent.running ? (agent.paused ? 'paused' : 'running') : 'idle'
  const cpu = snap?.metrics.cpuPercent ?? null
  const ram = snap?.metrics.memory.percent ?? null
  const latestWorkflow = snap?.workflows.runs[0] ?? null

  return (
    <div className="mini-app" style={themeVars(THEMES[0])}>
      <header className="mini-head">
        <span className="mini-brand">
          <OrvexMark size={18} />
          <span>ORVEX</span>
        </span>
        <span className={`mini-status s-${status}`}>
          <i />
          {status}
        </span>
        <button className="mini-icon" onClick={() => void windowAction('showMain')} title="Open ORVEX" aria-label="Open ORVEX">
          <Activity size={13} />
        </button>
        <button className="mini-icon" onClick={() => void windowAction('closeMini')} title="Close mini window" aria-label="Close mini window">
          <X size={13} />
        </button>
      </header>

      <div className="mini-body">
        <div className="mini-goal">
          <span className="mini-label">{agent?.running ? (agent.paused ? 'Paused goal' : 'Running goal') : 'No active goal'}</span>
          <p>{agent?.goal || 'Open the app to give ORVEX a task.'}</p>
        </div>

        <div className="mini-metrics">
          <span className="mini-metric">
            <b>{cpu == null ? '—' : `${Math.round(cpu)}%`}</b>
            <em>CPU</em>
          </span>
          <span className="mini-metric">
            <b>{ram == null ? '—' : `${Math.round(ram)}%`}</b>
            <em>RAM</em>
          </span>
          <span className="mini-metric">
            <b>{activeTasks}</b>
            <em>Active tasks</em>
          </span>
        </div>

        <div className="mini-latest">
          {latestWorkflow ? (
            <>
              <Workflow size={12} />
              <span className="mini-latest-name">{latestWorkflow.workflowName}</span>
              <span className={`mini-chip s-${latestWorkflow.status}`}>{latestWorkflow.status.replace('_', ' ')}</span>
              <span className="mini-latest-time">{ago(latestWorkflow.endedAt || latestWorkflow.startedAt || latestWorkflow.queuedAt)} ago</span>
            </>
          ) : (
            <>
              <Workflow size={12} />
              <span className="mini-latest-name">No workflow runs yet</span>
            </>
          )}
        </div>

        <div className="mini-actions">
          <button className="mini-action" onClick={() => void windowAction('showMain')}>
            <Bot size={14} />
            Open
          </button>
          <button className="mini-action" onClick={() => void windowAction('navigate', { id: 'chat' })}>
            <Play size={14} />
            Chat
          </button>
          <button className="mini-action" onClick={() => void windowAction('navigate', { id: 'automation' })}>
            <Workflow size={14} />
            Automate
          </button>
          <button
            className="mini-action danger"
            onClick={() => void stopRun()}
            disabled={!agent?.running || busy === 'stop'}
            title={agent?.running ? 'Stop the active agent run' : 'Nothing is running'}
          >
            <Square size={13} />
            {busy === 'stop' ? 'Stopping…' : 'Stop'}
          </button>
        </div>

        {error && <p className="mini-error">{error}</p>}
      </div>

      <footer className="mini-foot">
        <span>{snap ? `${snap.system.user} · ${snap.system.hostname}` : 'Waiting for the desktop bridge…'}</span>
        <span className="mini-hint">always on top</span>
      </footer>
    </div>
  )
}
