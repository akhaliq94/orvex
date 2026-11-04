import { useMemo } from 'react'
import { Activity, Bot, ShieldCheck, Workflow } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { OrvexDashboardSnapshot } from '../types/desktop'

type Row = {
  id: string
  name: string
  detail: string
  status: 'Running' | 'Paused' | 'Queued' | 'Needs approval'
  icon: LucideIcon
  color: string
}

const STATUS_COLOR: Record<Row['status'], string> = {
  Running: '#4ade80',
  Paused: '#94a3b8',
  Queued: '#fbbf24',
  'Needs approval': '#fb923c',
}

function rowsOf(snapshot: OrvexDashboardSnapshot | null): Row[] {
  if (!snapshot) return []
  const rows: Row[] = []
  if (snapshot.agent.running) {
    rows.push({
      id: snapshot.agent.runId || 'agent',
      name: 'Agent runtime',
      detail: snapshot.agent.goal || snapshot.agent.runId || 'working',
      status: snapshot.agent.paused ? 'Paused' : 'Running',
      icon: Bot,
      color: '#4fc3ff',
    })
  }
  for (const run of snapshot.runs) {
    if (!['running', 'paused', 'planning', 'working'].includes(String(run.status))) continue
    rows.push({
      id: run.id,
      name: 'Orchestrator run',
      detail: run.goal || `${run.steps} step${run.steps === 1 ? '' : 's'}`,
      status: run.status === 'paused' ? 'Paused' : 'Running',
      icon: Activity,
      color: '#a78bfa',
    })
  }
  for (const run of snapshot.workflows.runs) {
    if (!['queued', 'running', 'awaiting_approval'].includes(run.status)) continue
    rows.push({
      id: run.id,
      name: run.workflowName,
      detail: `${run.trigger} · ${run.steps} step${run.steps === 1 ? '' : 's'}`,
      status: run.status === 'queued' ? 'Queued' : run.status === 'running' ? 'Running' : 'Needs approval',
      icon: run.status === 'awaiting_approval' ? ShieldCheck : Workflow,
      color: run.status === 'awaiting_approval' ? '#fb923c' : '#38bdf8',
    })
  }
  return rows.slice(0, 6)
}

type Props = { snapshot: OrvexDashboardSnapshot | null; onOpenAgents: () => void }

export default function AgentsPanel({ snapshot, onOpenAgents }: Props) {
  const rows = useMemo(() => rowsOf(snapshot), [snapshot])

  return (
    <section className="agents-card panel panel-hairline">
      <div className="panel-head">
        <h2 className="panel-title">Active Work</h2>
        <button className="ghost-btn" onClick={onOpenAgents}>
          Manage
        </button>
      </div>

      <div className="agents-list">
        {rows.length === 0 && (
          <p className="ac-empty">Nothing is running — start an agent run or a workflow and it shows up here.</p>
        )}
        {rows.map((row) => {
          const Icon = row.icon
          return (
            <div className="agent-row" key={`${row.name}:${row.id}`} title={row.detail}>
              <span className="agent-ico">
                <Icon size={11} strokeWidth={1.9} />
              </span>
              <span className="agent-name min-w-0">
                <span className="block truncate">{row.name}</span>
                <span className="block truncate text-[9px]" style={{ color: 'var(--faint)' }}>
                  {row.detail}
                </span>
              </span>
              <span className="agent-status">
                <span
                  className="status-dot"
                  style={{
                    background: STATUS_COLOR[row.status],
                    color: STATUS_COLOR[row.status],
                    animation: row.status === 'Running' ? 'pulse-dot 1.8s infinite' : undefined,
                  }}
                />
                {row.status}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
