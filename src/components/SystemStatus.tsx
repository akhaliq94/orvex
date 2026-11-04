import { ChevronRight } from 'lucide-react'
import type { MetricHistory } from '../hooks/useDashboard'
import type { OrvexDashboardSnapshot } from '../types/desktop'

const R = 25
const C = 2 * Math.PI * R

function Gauge({ label, value, color, hint }: { label: string; value: number | null; color: string; hint?: string }) {
  const has = value != null && Number.isFinite(value)
  const v = has ? Math.max(0, Math.min(100, Math.round(value!))) : 0
  return (
    <div className="gauge" title={has ? `${label} ${v}%` : hint || `${label} is not reported by this machine`}>
      <div className="gauge-ring">
        <svg viewBox="0 0 62 62" width="100%" height="100%">
          <circle cx="31" cy="31" r={R} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="5.2" strokeDasharray="2 3" />
          {has && (
            <circle
              cx="31"
              cy="31"
              r={R}
              fill="none"
              stroke={color}
              strokeWidth="5.2"
              strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - v / 100)}
              style={{ transition: 'stroke-dashoffset .8s ease', filter: `drop-shadow(0 0 5px ${color})` }}
            />
          )}
          <circle cx="31" cy="31" r="18" fill={color} opacity="0.06" />
        </svg>
        <span className="gauge-val" style={{ color: has ? color : 'var(--faint)' }}>
          {has ? `${v}%` : 'n/a'}
        </span>
      </div>
      <span className="gauge-label">{label}</span>
    </div>
  )
}

const COLORS = { cpu: '#4fc3ff', ram: '#a78bfa', gpu: '#4ade80', disk: '#fbbf24' }

function toPath(values: number[], w = 300, h = 44) {
  if (values.length < 2) return ''
  const n = values.length
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = Math.max(max - min, 1)
  const pts = values.map((v, i) => {
    const x = (i / (n - 1)) * w
    const y = h - 5 - ((v - min) / range) * (h - 10)
    return [x, y] as const
  })
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]
    const [x1, y1] = pts[i]
    const cx = (x0 + x1) / 2
    d += ` Q${x0.toFixed(1)} ${y0.toFixed(1)} ${cx.toFixed(1)} ${((y0 + y1) / 2).toFixed(1)}`
  }
  const last = pts[pts.length - 1]
  d += ` L${last[0].toFixed(1)} ${last[1].toFixed(1)}`
  return d
}

type Props = {
  snapshot: OrvexDashboardSnapshot | null
  history: MetricHistory
  error: string | null
  onOpenSystem: () => void
}

export default function SystemStatus({ snapshot, history, error, onOpenSystem }: Props) {
  const m = snapshot?.metrics ?? null
  const gpu = m?.gpu
  const gpuValue = gpu?.available ? gpu.percent ?? null : null
  const cpuPath = toPath(history.cpu)
  const ramPath = toPath(history.ram)
  const diskPath = toPath(history.disk)
  const gpuPath = toPath(history.gpu)

  return (
    <section className="system-card panel panel-hairline">
      <div className="panel-head">
        <h2 className="panel-title">System Status</h2>
        <span
          className="live-badge"
          title={
            error
              ? error
              : m
                ? `Sampled ${new Date(m.at).toLocaleTimeString('en-US', { hour12: false })} · CPU, RAM and disk are real readings`
                : 'Waiting for the first sample'
          }
          style={error ? { color: '#ff9b9b' } : undefined}
        >
          <span className="live-dot" style={error ? { background: '#ff7b7b' } : undefined} />
          {error ? 'Offline' : 'Live'}
        </span>
      </div>

      <div className="gauges">
        <Gauge label="CPU" value={m?.cpuPercent ?? null} color={COLORS.cpu} hint="CPU utilisation is still sampling" />
        <Gauge label="RAM" value={m?.memory.percent ?? null} color={COLORS.ram} />
        <Gauge
          label="GPU"
          value={gpuValue}
          color={COLORS.gpu}
          hint={gpu?.reason || 'GPU utilisation is not exposed by this machine'}
        />
        <Gauge label="DISK" value={m?.disk?.percent ?? null} color={COLORS.disk} hint="No disk statistics available" />
      </div>

      <div className="sparkline">
        <svg viewBox="0 0 300 44" preserveAspectRatio="none" aria-hidden>
          <defs>
            <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--accent)" stopOpacity="0.22" />
              <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
            <filter id="spark-glow" x="-20%" y="-60%" width="140%" height="240%">
              <feGaussianBlur stdDeviation="1.8" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {cpuPath && <path d={`${cpuPath} L300 44 L0 44 Z`} fill="url(#spark-fill)" opacity="0.7" />}
          <g filter="url(#spark-glow)" fill="none" strokeLinecap="round" strokeLinejoin="round">
            {ramPath && <path d={ramPath} stroke={COLORS.ram} strokeWidth="1.15" opacity="0.8" />}
            {gpuPath && <path d={gpuPath} stroke={COLORS.gpu} strokeWidth="1.1" opacity="0.75" />}
            {cpuPath && <path d={cpuPath} stroke={COLORS.cpu} strokeWidth="1.45" />}
            {diskPath && <path d={diskPath} stroke={COLORS.disk} strokeWidth="1.05" opacity="0.6" />}
          </g>
        </svg>
        <button className="spark-expand" onClick={onOpenSystem} aria-label="Open system monitor" title="Open the System monitor">
          <ChevronRight size={11} />
        </button>
      </div>
    </section>
  )
}
