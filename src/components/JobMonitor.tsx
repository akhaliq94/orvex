import { useMemo, useState } from 'react'
import { Ban, ChevronRight, CircleCheck, Loader2, Square, TriangleAlert } from 'lucide-react'
import type { OrvexDashboardSnapshot } from '../types/desktop'

type Row = {
  id: string
  name: string
  detail: string
  status: 'queued' | 'running' | 'approval' | 'succeeded' | 'failed' | 'cancelled'
  at: number
  steps: number
  target: string
  action: 'cancel' | 'stop' | null
  runId?: string
}

function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${Math.max(1, s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function statusOf(run: { status: string }): Row['status'] {
  if (run.status === 'awaiting_approval') return 'approval'
  if (['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(run.status)) return run.status as Row['status']
  if (run.status === 'interrupted') return 'failed'
  return 'succeeded'
}

function StatusIcon({ status }: { status: Row['status'] }) {
  if (status === 'succeeded') return <CircleCheck size={12} style={{ color: '#4ade80' }} />
  if (status === 'failed') return <TriangleAlert size={12} style={{ color: '#fb7185' }} />
  if (status === 'cancelled') return <Ban size={12} style={{ color: '#94a3b8' }} />
  if (status === 'running') return <Loader2 size={12} className="wf-spin" style={{ color: '#4fc3ff' }} />
  return null
}

function rowsOf(snapshot: OrvexDashboardSnapshot | null): Row[] {
  if (!snapshot) return []
  const rows: Row[] = []
  const liveAgent = snapshot.agent.running && snapshot.agent.runId
    ? snapshot.runs.find((r) => r.id === snapshot.agent.runId)
    : null
  if (snapshot.agent.running && snapshot.agent.runId) {
    rows.push({
      id: snapshot.agent.runId,
      name: 'Agent run',
      detail: snapshot.agent.goal || snapshot.agent.runId,
      status: snapshot.agent.paused ? 'queued' : 'running',
      at: snapshot.at,
      steps: liveAgent?.steps ?? 0,
      target: 'chat',
      action: 'stop',
    })
  }
  for (const run of snapshot.workflows.runs) {
    const live = ['queued', 'running', 'awaiting_approval'].includes(run.status)
    rows.push({
      id: run.id,
      name: run.workflowName,
      detail: `${run.trigger} · ${run.steps} step${run.steps === 1 ? '' : 's'}${run.error ? ` · ${run.error.slice(0, 48)}` : ''}`,
      status: statusOf(run),
      at: run.endedAt || run.startedAt || run.queuedAt,
      steps: run.steps,
      target: 'automation',
      action: live ? 'cancel' : null,
      runId: live ? run.id : undefined,
    })
  }
  for (const run of snapshot.runs) {
    const live = ['running', 'planning', 'working'].includes(String(run.status))
    rows.push({
      id: `o-${run.id}`,
      name: run.agentId ? `Orchestrator · ${run.agentId}` : 'Orchestrator',
      detail: `${run.goal || run.id}${run.steps ? ` · ${run.steps} step${run.steps === 1 ? '' : 's'}` : ''}`,
      status: live ? 'running' : run.status === 'failed' ? 'failed' : 'succeeded',
      at: run.endedAt || run.startedAt,
      steps: run.steps,
      target: 'monitoring',
      action: null,
    })
  }
  return rows.sort((a, b) => b.at - a.at)
}

const KIND_COLOR: Record<Row['status'], string> = {
  queued: '#fbbf24',
  running: '#4fc3ff',
  approval: '#fb923c',
  succeeded: '#4ade80',
  failed: '#fb7185',
  cancelled: '#94a3b8',
}

type Props = {
  snapshot: OrvexDashboardSnapshot | null
  compact?: boolean
  notify?: (m: string) => void
  onNavigate?: (id: string, tab?: string) => void
}

export default function JobMonitor({ snapshot, compact = false, notify, onNavigate }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const rows = useMemo(() => rowsOf(snapshot), [snapshot])
  const active = rows.filter((r) => ['queued', 'running', 'approval'].includes(r.status))
  const visible = compact ? active.slice(0, 4) : rows.slice(0, 12)

  const stopRow = async (row: Row) => {
    const bridge = typeof window !== 'undefined' ? window.orvex : undefined
    if (!bridge) return
    setBusy(row.id)
    try {
      if (row.action === 'stop') {
        const result = await bridge.agent.stop()
        notify?.(result.ok ? 'Stopping the agent run…' : result.error)
      } else if (row.action === 'cancel' && row.runId) {
        const result = await bridge.workflows.cancel(row.runId)
        notify?.(result.ok ? `Cancelling “${row.name}”…` : result.error)
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="job-monitor panel panel-hairline">
      <div className="panel-head">
        <h2 className="panel-title">Task dashboard</h2>
        <span className="jm-count">
          {active.length} active · {rows.length} recent
        </span>
      </div>

      <div className="jm-body">
        {visible.length === 0 && <p className="ac-empty">Nothing queued — run a workflow or an agent and it shows up here.</p>}
        {visible.map((r) => (
          <div
            key={r.id}
            className={`jm-row s-${r.status} ${onNavigate ? 'clickable' : ''}`}
            role={onNavigate ? 'button' : undefined}
            tabIndex={onNavigate ? 0 : undefined}
            onClick={() => onNavigate?.(r.target)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onNavigate?.(r.target)
              }
            }}
            title={onNavigate ? `Open ${r.target}` : undefined}
          >
            <span className="jm-kind" style={{ background: KIND_COLOR[r.status] }} />
            <div className="jm-main">
              <div className="jm-title-row">
                <span className="jm-name">{r.name}</span>
                <StatusIcon status={r.status} />
                {r.steps > 0 && <span className="jm-steps">{r.steps} step{r.steps === 1 ? '' : 's'}</span>}
                <span className="jm-time">{ago(r.at)}</span>
              </div>
              <div className="jm-msg">{r.detail}</div>
            </div>
            <div className="jm-actions">
              {r.action && (
                <button
                  className="icon-btn !w-[22px] !h-[22px]"
                  onClick={(e) => {
                    e.stopPropagation()
                    void stopRow(r)
                  }}
                  disabled={busy === r.id}
                  title={r.action === 'stop' ? 'Stop the agent run' : 'Cancel this workflow run'}
                  aria-label={r.action === 'stop' ? `Stop ${r.name}` : `Cancel ${r.name}`}
                >
                  {r.action === 'stop' ? <Square size={10} /> : <Ban size={11} />}
                </button>
              )}
              {onNavigate && <ChevronRight size={12} style={{ color: 'var(--faint)' }} />}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
