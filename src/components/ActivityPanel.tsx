import { useMemo, useState } from 'react'
import { Chrome, Code2, Folder, Package, Search, Workflow } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { OrvexDashboardSnapshot } from '../types/desktop'

type Kind = 'browser' | 'search' | 'folder' | 'code' | 'package' | 'workflow'

const KIND: Record<Kind, { icon: LucideIcon; color: string }> = {
  browser: { icon: Chrome, color: '#4fc3ff' },
  search: { icon: Search, color: '#4fc3ff' },
  folder: { icon: Folder, color: '#fbbf3f' },
  code: { icon: Code2, color: '#a78bfa' },
  package: { icon: Package, color: '#4ade80' },
  workflow: { icon: Workflow, color: '#38bdf8' },
}

type Row = { id: string; label: string; at: number; kind: Kind; failed?: boolean }

function kindOf(tool: string | null, kind: string): Kind {
  const name = String(tool || '')
  if (/^browser|^web_|^page_|^http/i.test(name)) return 'browser'
  if (/^code|^git_|^terminal|^shell|^run_|^process/i.test(name)) return 'code'
  if (/^file|^fs_|^folder|^zip|^backup/i.test(name)) return 'folder'
  if (/^memory|^search|^research|^doc_|^read_/i.test(name)) return 'search'
  if (kind === 'workflow') return 'workflow'
  return 'package'
}

function ago(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 15000) return 'just now'
  if (diff < 60000) return `${Math.max(1, Math.round(diff / 1000))}s ago`
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`
  return `${Math.round(diff / 86400000)}d ago`
}

function buildRows(snapshot: OrvexDashboardSnapshot | null): Row[] {
  if (!snapshot) return []
  const rows: Row[] = []
  for (const a of snapshot.activity) {
    const label = a.tool
      ? `${a.tool}${a.error ? ` — ${a.error.slice(0, 60)}` : a.ms != null ? ` · ${a.ms} ms` : ''}`
      : `${a.kind}${a.runId ? ` · ${a.runId}` : ''}`
    rows.push({
      id: `a-${a.ts}-${a.tool || a.kind}-${a.ms ?? 0}`,
      label,
      at: Number(a.ts) || 0,
      kind: kindOf(a.tool, a.kind),
      failed: a.ok === 0,
    })
  }
  for (const run of snapshot.workflows.runs) {
    rows.push({
      id: `w-${run.id}`,
      label: `${run.workflowName} — ${run.status.replace(/_/g, ' ')}`,
      at: run.endedAt || run.startedAt || run.queuedAt,
      kind: 'workflow',
      failed: run.status === 'failed',
    })
  }
  return rows.sort((a, b) => b.at - a.at).slice(0, 24)
}

export default function ActivityPanel({ snapshot }: { snapshot: OrvexDashboardSnapshot | null }) {
  const [expanded, setExpanded] = useState(false)
  const rows = useMemo(() => buildRows(snapshot), [snapshot])
  const visible = expanded ? rows.slice(0, 24) : rows.slice(0, 5)

  return (
    <section className="activity-card panel panel-hairline">
      <div className="panel-head">
        <h2 className="panel-title">Recent Activity</h2>
        <button className="ghost-btn" onClick={() => setExpanded((v) => !v)} disabled={rows.length <= 5}>
          {expanded ? 'Collapse' : 'View All'}
        </button>
      </div>
      <div className="activity-list" style={expanded ? { overflowY: 'auto', maxHeight: 148 } : undefined}>
        {visible.length === 0 && <p className="ac-empty">No activity yet — every tool run and workflow lands here.</p>}
        {visible.map((a) => {
          const { icon: Icon, color } = KIND[a.kind]
          const tone = a.failed ? '#ff7b7b' : color
          return (
            <div className="activity-row" key={a.id} title={a.label}>
              <span className="activity-ico" style={{ color: tone, filter: `drop-shadow(0 0 5px ${tone}66)` }}>
                <Icon size={13} strokeWidth={1.9} />
              </span>
              <span className="activity-label">{a.label}</span>
              <span className="activity-time">{a.at ? ago(a.at) : '—'}</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
