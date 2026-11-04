import { Zap, DollarSign } from 'lucide-react'
import type { OrvexDashboardSnapshot } from '../types/desktop'

const fmt = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

/**
 * Session usage straight from the usage table. Token counts and cost are the
 * values the gateway recorded for every call since launch; nothing is estimated
 * in the renderer.
 */
export default function FuelBar({ snapshot }: { snapshot: OrvexDashboardSnapshot | null }) {
  const usage = snapshot?.usage
  const totals = usage?.totals
  const tokensIn = (usage?.byModel || []).reduce((sum, m) => sum + (Number(m.promptTokens) || 0), 0)
  const tokensOut = (usage?.byModel || []).reduce((sum, m) => sum + (Number(m.completionTokens) || 0), 0)
  const peak = Math.max(tokensIn, tokensOut, 1)
  const calls = totals?.calls || 0
  const model = usage?.byModel?.[0]

  return (
    <div className="fuel-card panel panel-hairline">
      <div className="panel-head">
        <h2 className="panel-title">
          <Zap size={13} style={{ verticalAlign: -1, marginRight: 4 }} />
          Fuel Gauge
        </h2>
        <span
          className="live-badge"
          title={
            calls
              ? `${calls} provider call${calls === 1 ? '' : 's'} recorded since launch · costs use the prices the gateway stored`
              : 'No provider calls yet in this session'
          }
        >
          {calls > 0 && <span className="live-dot" />}
          Session
        </span>
      </div>

      <div className="fuel-main">
        <div className="fuel-meters">
          <div className="fuel-meter">
            <span className="fuel-label">IN</span>
            <div className="fuel-bar-wrap">
              <div className="fuel-bar">
                <div className="fuel-fill" style={{ background: 'var(--accent)', width: `${(tokensIn / peak) * 100}%` }} />
              </div>
            </div>
            <span className="fuel-val">{fmt(tokensIn)}</span>
          </div>
          <div className="fuel-meter">
            <span className="fuel-label">OUT</span>
            <div className="fuel-bar-wrap">
              <div className="fuel-bar">
                <div className="fuel-fill" style={{ background: 'var(--accent-2)', width: `${(tokensOut / peak) * 100}%` }} />
              </div>
            </div>
            <span className="fuel-val">{fmt(tokensOut)}</span>
          </div>
        </div>

        <div className="fuel-cost">
          <DollarSign size={13} style={{ verticalAlign: -1, marginRight: 3 }} />
          <span className="fuel-cost-val">${(Number(totals?.cost) || 0).toFixed(4)}</span>
          <span className="fuel-cost-sub">{totals?.estimated ? 'est.' : 'billed'}</span>
        </div>
      </div>

      <div className="fuel-foot">
        <span className="dim">
          {model ? `${model.model || 'model'} · ${calls} call${calls === 1 ? '' : 's'}` : 'No provider calls this session'}
        </span>
        {totals?.failures ? (
          <span className="dim" style={{ color: '#ff9b9b' }}>
            {totals.failures} failed
          </span>
        ) : null}
      </div>
    </div>
  )
}
