import { useMemo } from 'react'
import { TriangleAlert, Trash2 } from 'lucide-react'
import { failuresStore, useStore } from '../data/stores'
import type { OrvexDashboardSnapshot } from '../types/desktop'

const KEY = 'orvex-failures'

function clearFailures() {
  failuresStore.set([])
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

type Row = { id: string; where: string; reason: string; at: number }

/**
 * Two real sources, merged: failures the UI recorded directly (chat and voice
 * errors) and failed rows from the persistent audit log.
 */
export default function FailureLog({ snapshot }: { snapshot?: OrvexDashboardSnapshot | null }) {
  const failures = useStore(failuresStore)

  const rows = useMemo<Row[]>(() => {
    const local = failures.map((f) => ({ id: f.id, where: f.where, reason: f.reason, at: f.at }))
    const audited = (snapshot?.activity ?? [])
      .filter((a) => a.error || a.ok === 0)
      .map((a) => ({
        id: `audit-${a.ts}-${a.tool ?? a.kind}`,
        where: `${a.kind}${a.tool ? ` · ${a.tool}` : ''}${a.runId ? ` · ${a.runId}` : ''}`,
        reason: a.error || 'The tool reported a failure.',
        at: a.ts,
      }))
    return [...local, ...audited].sort((a, b) => b.at - a.at).slice(0, 20)
  }, [failures, snapshot])

  return (
    <section className="failures panel panel-hairline">
      <div className="panel-head">
        <h2 className="panel-title">Failure Log</h2>
        <div className="ml-auto flex items-center gap-2">
          <span className="jm-count">{rows.length} entries</span>
          {failures.length > 0 && (
            <button className="ghost-btn !h-[20px] !text-[9px]" onClick={clearFailures} title="Clears the local log; the audit log stays">
              <Trash2 size={10} /> Clear local
            </button>
          )}
        </div>
      </div>
      <div className="fail-list">
        {rows.length === 0 && <p className="ac-empty">Clean run — no failures recorded.</p>}
        {rows.map((f) => (
          <div key={f.id} className="fail-row">
            <TriangleAlert size={12} style={{ color: '#fb7185', flex: 'none' }} />
            <div className="fail-main">
              <div className="fail-where">{f.where}</div>
              <div className="fail-reason">{f.reason}</div>
            </div>
            <span className="fail-time">{timeAgo(f.at)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
