import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Cpu,
  Download,
  FlaskConical,
  Gauge,
  HeartPulse,
  History,
  Layers,
  Network,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldAlert,
  Square,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react'
import PageShell from './PageShell'
import { onTablistKeyDown } from '../data/a11y'
import { useProviders } from '../hooks/useProviders'
import { buildCandidates, toCandidate } from '../data/routing'
import type {
  OrvexEvalCase,
  OrvexEvalRunResult,
  OrvexEvalSuite,
  OrvexEvalRow,
  OrvexMonitorCompare,
  OrvexMonitorHealth,
  OrvexMonitorOverview,
  OrvexMonitorRecoverables,
  OrvexMonitorSeries,
  OrvexMonitorTraceDetail,
  OrvexMonitorTraceRun,
  OrvexMonitorUsage,
} from '../types/desktop'

type Props = {
  onBack: () => void
  notify: (msg: string) => void
  initialTab?: string | null
}

type Tab = 'overview' | 'usage' | 'traces' | 'compare' | 'evals' | 'health' | 'recovery'

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'usage', label: 'Usage & cost' },
  { id: 'traces', label: 'Traces' },
  { id: 'compare', label: 'Compare' },
  { id: 'evals', label: 'Evals' },
  { id: 'health', label: 'Health' },
  { id: 'recovery', label: 'Recovery' },
]

const RANGES = [
  { label: '15m', minutes: 15 },
  { label: '1h', minutes: 60 },
  { label: '6h', minutes: 360 },
  { label: '24h', minutes: 1440 },
  { label: '7d', minutes: 10080 },
]

const USAGE_WINDOWS = [
  { label: '1h', ms: 3600_000 },
  { label: '24h', ms: 86400_000 },
  { label: '7d', ms: 7 * 86400_000 },
  { label: '30d', ms: 30 * 86400_000 },
]

const num = (n: number | null | undefined, digits = 1) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : 'n/a')

const pretty = (n: number | null | undefined) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a'
  if (Math.abs(n) < 1000) return String(Math.round(n))
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

const bytes = (n: number | null | undefined) => {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 'n/a'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`
}

const money = (n: number | null | undefined) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a'
  if (n === 0) return '$0'
  if (n < 0.00001) return '<$0.00001'
  return `$${n.toFixed(n < 0.01 ? 5 : n < 1 ? 4 : 2)}`
}

const duration = (ms: number | null | undefined) => {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'n/a'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  if (m < 60) return `${m}m ${s}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const when = (ts: number | string | null | undefined) => {
  if (!ts) return 'never'
  const at = typeof ts === 'number' ? ts : Date.parse(ts)
  if (!Number.isFinite(at)) return 'unknown'
  const diff = Date.now() - at
  if (diff < 45_000) return 'just now'
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`
  if (diff < 7 * 86400_000) return `${Math.round(diff / 86400_000)}d ago`
  return new Date(at).toLocaleDateString()
}

const clock = (ts: number | null | undefined) =>
  typeof ts === 'number' && Number.isFinite(ts)
    ? new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—'

type ChartRow = { t: number; [key: string]: number | null | undefined }

function LineChart({
  rows,
  series,
  height = 118,
  fixedMax,
}: {
  rows: ChartRow[]
  series: { key: string; label: string; color: string }[]
  height?: number
  fixedMax?: number
}) {
  const values = rows.flatMap((row) => series.map((s) => row[s.key])).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const max = fixedMax ?? Math.max(1, ...values) * 1.15
  const last = [...rows].reverse().find((row) => series.some((s) => typeof row[s.key] === 'number'))
  const segmentsFor = (key: string) => {
    const out: string[] = []
    let current = ''
    const step = rows.length > 1 ? 100 / (rows.length - 1) : 0
    rows.forEach((row, index) => {
      const value = row[key]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        if (current) out.push(current)
        current = ''
        return
      }
      const x = rows.length === 1 ? 50 : index * step
      const y = 100 - Math.min(100, Math.max(0, (value / max) * 100))
      current += `${current ? ' L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`
    })
    if (current) out.push(current)
    return out
  }
  return (
    <div className="mon-chart" style={{ height }}>
      <div className="mon-chart-legend">
        {series.map((s) => (
          <span key={s.key} className="mon-legend-item">
            <i style={{ background: s.color }} />
            {s.label}
            <b>{last && typeof last[s.key] === 'number' ? (fixedMax === 100 ? `${num(last[s.key] as number)}%` : pretty(last[s.key] as number)) : '—'}</b>
          </span>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className="mon-chart-empty">No samples in this window yet — the sampler writes every 15 seconds.</div>
      ) : (
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Time series chart">
          {[25, 50, 75].map((y) => (
            <line key={y} x1="0" y1={y} x2="100" y2={y} className="mon-grid" />
          ))}
          {series.map((s) =>
            segmentsFor(s.key).map((path, index) => (
              <path key={`${s.key}-${index}`} d={path} fill="none" stroke={s.color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
            )),
          )}
        </svg>
      )}
      <div className="mon-chart-axis">
        <span>{rows.length ? new Date(rows[0].t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
        <span>{rows.length ? new Date(rows[rows.length - 1].t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
      </div>
    </div>
  )
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className={`mon-tile ${tone ? `mon-${tone}` : ''}`}>
      <span className="mon-tile-label">{label}</span>
      <strong className="mon-tile-value">{value}</strong>
      {hint && <span className="mon-tile-hint">{hint}</span>}
    </div>
  )
}

const STATUS_CHIP: Record<string, string> = { ok: 'mon-chip ok', warn: 'mon-chip warn', fail: 'mon-chip bad' }

const CASES_TEMPLATE = JSON.stringify(
  [
    {
      id: 'json',
      prompt: 'Reply with ONLY a JSON object: {"ok":true}',
      checks: { json: true, contains: ['"ok"'] },
    },
  ],
  null,
  2,
)

export default function MonitoringPage({ onBack, notify, initialTab }: Props) {
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const { providers, activeId, active } = useProviders()
  const candidates = useMemo(() => buildCandidates(providers, activeId), [providers, activeId])

  const [tab, setTab] = useState<Tab>(() => (TABS.some((t) => t.id === initialTab) ? (initialTab as Tab) : 'overview'))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [minutes, setMinutes] = useState(60)

  const [overview, setOverview] = useState<OrvexMonitorOverview | null>(null)
  const [series, setSeries] = useState<OrvexMonitorSeries | null>(null)

  const [usage, setUsage] = useState<OrvexMonitorUsage | null>(null)
  const [usageWindow, setUsageWindow] = useState(86400_000)
  const [budget, setBudget] = useState('')

  const [traces, setTraces] = useState<OrvexMonitorTraceRun[]>([])
  const [trace, setTrace] = useState<OrvexMonitorTraceDetail | null>(null)
  const [traceError, setTraceError] = useState<string | null>(null)

  const [comparePrompt, setComparePrompt] = useState('')
  const [compareSystem, setCompareSystem] = useState('')
  const [compareIds, setCompareIds] = useState<string[]>([])
  const [compareMax, setCompareMax] = useState(400)
  const [compare, setCompare] = useState<OrvexMonitorCompare | null>(null)

  const [suites, setSuites] = useState<OrvexEvalSuite[]>([])
  const [suiteId, setSuiteId] = useState<string | null>(null)
  const [suiteName, setSuiteName] = useState('')
  const [casesText, setCasesText] = useState(CASES_TEMPLATE)
  const [evalIds, setEvalIds] = useState<string[]>([])
  const [evalResult, setEvalResult] = useState<OrvexEvalRunResult | null>(null)
  const [evalHistory, setEvalHistory] = useState<OrvexEvalRow[]>([])

  const [health, setHealth] = useState<OrvexMonitorHealth | null>(null)
  const [recover, setRecover] = useState<OrvexMonitorRecoverables | null>(null)

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (initialTab && TABS.some((t) => t.id === initialTab)) setTab(initialTab as Tab)
  }, [initialTab])

  const loadOverview = useCallback(async () => {
    if (!bridge) {
      setError('Desktop bridge unavailable — monitoring needs the ORVEX app.')
      return
    }
    const [snap, range] = await Promise.all([bridge.monitor.overview(), bridge.monitor.series(minutes)])
    if (!alive.current) return
    if (snap.ok) {
      setOverview(snap.data)
      if (snap.data.latest) setError(null)
    } else {
      setError(snap.error)
    }
    if (range.ok) setSeries(range.data)
  }, [bridge, minutes])

  const loadUsage = useCallback(async () => {
    if (!bridge) return
    const res = await bridge.monitor.usage(usageWindow)
    if (!alive.current) return
    if (res.ok) {
      setUsage(res.data)
      if (res.data.budget.dailyUsd > 0) setBudget(String(res.data.budget.dailyUsd))
    } else {
      setError(res.error)
    }
  }, [bridge, usageWindow])

  const loadTraces = useCallback(async () => {
    if (!bridge) return
    const res = await bridge.monitor.traces(60)
    if (!alive.current) return
    if (res.ok) setTraces(res.data.runs)
    else setError(res.error)
  }, [bridge])

  const loadHealth = useCallback(async () => {
    if (!bridge) return
    const res = await bridge.monitor.health(candidates)
    if (!alive.current) return
    if (res.ok) setHealth(res.data)
    else setError(res.error)
  }, [bridge, candidates])

  const loadRecovery = useCallback(async () => {
    if (!bridge) return
    const res = await bridge.monitor.recoverables()
    if (!alive.current) return
    if (res.ok) setRecover(res.data)
    else setError(res.error)
  }, [bridge])

  const loadSuites = useCallback(
    async (prefer?: string | null) => {
      if (!bridge) return
      const res = await bridge.monitor.evalSuites()
      if (!alive.current) return
      if (!res.ok) {
        setError(res.error)
        return
      }
      setSuites(res.data.suites)
      const next = res.data.suites.find((suite) => suite.id === (prefer ?? suiteId)) || res.data.suites[0] || null
      setSuiteId(next ? next.id : null)
      if (next) {
        setSuiteName(next.name)
        setCasesText(JSON.stringify(next.cases, null, 2))
      }
    },
    [bridge, suiteId],
  )

  const loadEvalHistory = useCallback(async () => {
    if (!bridge || !suiteId) {
      setEvalHistory([])
      return
    }
    const res = await bridge.monitor.evalHistory(suiteId, 80)
    if (!alive.current) return
    if (res.ok) setEvalHistory(res.data.rows)
  }, [bridge, suiteId])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  useEffect(() => {
    if (tab !== 'overview') return
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadOverview()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [tab, loadOverview])

  useEffect(() => {
    if (tab === 'usage') void loadUsage()
  }, [tab, loadUsage])

  useEffect(() => {
    if (tab === 'traces') void loadTraces()
  }, [tab, loadTraces])

  useEffect(() => {
    if (tab === 'health') void loadHealth()
  }, [tab, loadHealth])

  useEffect(() => {
    if (tab === 'recovery') void loadRecovery()
  }, [tab, loadRecovery])

  useEffect(() => {
    if (tab === 'evals') void loadSuites()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  useEffect(() => {
    void loadEvalHistory()
  }, [loadEvalHistory])

  useEffect(() => {
    setCompareIds((current) => {
      const valid = current.filter((id) => candidates.some((c) => String(c.id || c.presetId) === id))
      if (valid.length) return valid
      return candidates.slice(0, 2).map((c) => String(c.id || c.presetId))
    })
    setEvalIds((current) => {
      const valid = current.filter((id) => candidates.some((c) => String(c.id || c.presetId) === id))
      if (valid.length) return valid
      return candidates.slice(0, 1).map((c) => String(c.id || c.presetId))
    })
  }, [candidates])

  const candidateById = useMemo(() => {
    const map = new Map<string, (typeof candidates)[number]>()
    for (const candidate of candidates) map.set(String(candidate.id || candidate.presetId), candidate)
    return map
  }, [candidates])

  const openTrace = async (runId: string) => {
    if (!bridge) return
    setTraceError(null)
    const res = await bridge.monitor.trace(runId)
    if (res.ok) setTrace(res.data)
    else {
      setTrace(null)
      setTraceError(res.error)
    }
  }

  const exportCsv = async () => {
    if (!bridge) return
    const res = await bridge.monitor.usageCsv(usageWindow)
    if (!res.ok) {
      notify(res.error)
      return
    }
    const blob = new Blob([res.data.csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = res.data.name
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    notify(`Exported ${res.data.rows} usage row${res.data.rows === 1 ? '' : 's'}`)
  }

  const saveBudget = async () => {
    if (!bridge) return
    const value = Number(budget)
    if (!Number.isFinite(value) || value < 0) {
      notify('Enter a daily budget in USD (0 turns the guard off).')
      return
    }
    const res = await bridge.budget.set(value)
    if (res.ok) {
      notify(value > 0 ? `Daily budget set to $${value.toFixed(2)}` : 'Daily budget guard turned off')
      await loadUsage()
    } else {
      notify(res.error)
    }
  }

  const runCompare = async () => {
    if (!bridge) return
    const chosen = compareIds.map((id) => candidateById.get(id)).filter((c): c is NonNullable<typeof c> => !!c)
    if (chosen.length < 2) {
      notify('Pick at least two models to compare.')
      return
    }
    if (!comparePrompt.trim()) {
      notify('Write a prompt first.')
      return
    }
    setBusy(true)
    setCompare(null)
    try {
      const res = await bridge.monitor.compare({
        prompt: comparePrompt,
        system: compareSystem || undefined,
        candidates: chosen,
        maxTokens: compareMax,
        timeoutMs: 90000,
      })
      if (res.ok) {
        setCompare(res.data)
        notify(`Compared ${res.data.summary.candidates} models · ${res.data.summary.ok} replied`)
      } else {
        notify(res.error)
      }
    } finally {
      setBusy(false)
    }
  }

  const saveSuite = async () => {
    if (!bridge) return
    let cases: unknown
    try {
      cases = JSON.parse(casesText)
    } catch (err) {
      notify(`Cases JSON is invalid: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    setBusy(true)
    try {
      const res = await bridge.monitor.evalSave({ id: suiteId || undefined, name: suiteName, cases: cases as OrvexEvalCase[] })
      if (res.ok) {
        notify(`Saved "${res.data.name}" · ${res.data.caseCount} case${res.data.caseCount === 1 ? '' : 's'}`)
        await loadSuites(res.data.id)
      } else {
        notify(res.error)
      }
    } finally {
      setBusy(false)
    }
  }

  const newSuite = () => {
    setSuiteId(null)
    setSuiteName('New suite')
    setCasesText(CASES_TEMPLATE)
    setEvalResult(null)
    setEvalHistory([])
  }

  const deleteSuite = async () => {
    if (!bridge || !suiteId) return
    setBusy(true)
    try {
      const res = await bridge.monitor.evalDelete(suiteId)
      if (res.ok) {
        notify('Suite deleted')
        setSuiteId(null)
        await loadSuites()
      } else {
        notify(res.error)
      }
    } finally {
      setBusy(false)
    }
  }

  const runEvals = async () => {
    if (!bridge || !suiteId) {
      notify('Save the suite before running it.')
      return
    }
    const chosen = evalIds.map((id) => candidateById.get(id)).filter((c): c is NonNullable<typeof c> => !!c)
    if (!chosen.length) {
      notify('Pick at least one model for the eval run.')
      return
    }
    setBusy(true)
    setEvalResult(null)
    try {
      const res = await bridge.monitor.evalRun({ suiteId, candidates: chosen, timeoutMs: 90000 })
      if (res.ok) {
        setEvalResult(res.data)
        notify(`${res.data.summary.passed}/${res.data.summary.runs} checks passed · score ${(res.data.summary.score * 100).toFixed(0)}%`)
        await loadEvalHistory()
      } else {
        notify(res.error)
      }
    } finally {
      setBusy(false)
    }
  }

  const clearEvalHistory = async () => {
    if (!bridge || !suiteId) return
    const res = await bridge.monitor.evalClear(suiteId)
    if (res.ok) {
      notify(`Cleared ${res.data.removed} eval result${res.data.removed === 1 ? '' : 's'}`)
      setEvalHistory([])
      setEvalResult(null)
    } else {
      notify(res.error)
    }
  }

  const resumeRun = async (runId: string, goal: string | null) => {
    if (!bridge) return
    if (!active) {
      notify('Pick a provider in Settings before resuming a run.')
      return
    }
    setBusy(true)
    try {
      const res = await bridge.orchestrator.resume({
        runId,
        goal: goal || '',
        provider: toCandidate(active),
        candidates,
        task: 'agent',
      })
      if (res.ok) {
        notify(`Resuming ${runId}`)
        await loadRecovery()
      } else {
        notify(res.error)
      }
    } finally {
      setBusy(false)
    }
  }

  const abandonRun = async (runId: string) => {
    if (!bridge) return
    const res = await bridge.monitor.abandon(runId)
    if (res.ok) {
      notify(`Marked ${runId} as abandoned`)
      await loadRecovery()
    } else {
      notify(res.error)
    }
  }

  const resumeWorkflow = async (runId: string) => {
    if (!bridge) return
    const res = await bridge.workflows.resume(runId)
    if (res.ok) {
      notify('Workflow run resumed')
      await loadRecovery()
    } else {
      notify(res.error)
    }
  }

  const cancelWorkflow = async (runId: string) => {
    if (!bridge) return
    const res = await bridge.workflows.cancel(runId)
    if (res.ok) {
      notify('Workflow run cancelled')
      await loadRecovery()
    } else {
      notify(res.error)
    }
  }

  const clearCrashes = async () => {
    if (!bridge) return
    const res = await bridge.monitor.clearCrashes()
    if (res.ok) {
      notify(`Cleared ${res.data.removed} crash record${res.data.removed === 1 ? '' : 's'}`)
      await loadRecovery()
    } else {
      notify(res.error)
    }
  }

  const latest = overview?.latest || null
  const chartRows: ChartRow[] = (series?.points || overview?.series.points || []) as unknown as ChartRow[]

  return (
    <PageShell
      title="Monitoring"
      sub="Real hardware samples, token and cost accounting, run traces, model comparison, evals, health probes and crash recovery"
      onBack={onBack}
      actions={
        <>
          <button className="ghost-btn" onClick={() => void loadOverview()} title="Refresh monitoring">
            <RefreshCw size={12} /> Refresh
          </button>
        </>
      }
    >
      <div className="settings-tabs mon-tabs" role="tablist" aria-label="Monitoring sections" onKeyDown={onTablistKeyDown}>
        {TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            tabIndex={tab === item.id ? 0 : -1}
            className={`settings-tab ${tab === item.id ? 'active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error && <div className="sec-notice mon-notice">{error}</div>}

      {tab === 'overview' && (
        <div className="mon-stack">
          <div className="mon-tiles">
            <Tile
              label="CPU"
              value={latest && latest.cpu != null ? `${num(latest.cpu)}%` : 'n/a'}
              hint={latest ? `System · sampled ${when(latest.ts)}` : 'Waiting for the first sample'}
            />
            <Tile
              label="RAM"
              value={latest && latest.mem != null ? `${num(latest.mem)}%` : 'n/a'}
              hint={overview?.db.ready ? `ORVEX ${num(overview?.appTotals.memMB)} MB across ${overview?.appTotals.processes ?? 0} processes` : 'Memory pressure'}
            />
            <Tile label="Disk" value={latest && latest.disk != null ? `${num(latest.disk)}%` : 'n/a'} hint="System volume usage" />
            <Tile
              label="GPU"
              value={latest && latest.gpu != null ? `${num(latest.gpu)}%` : 'n/a'}
              hint={latest && latest.gpu == null ? 'Not exposed by this machine' : 'Utilisation from the vendor driver'}
            />
            <Tile
              label="Network"
              value={latest && latest.netIn != null ? `${pretty(latest.netIn)} B/s` : 'n/a'}
              hint={latest && latest.netOut != null ? `Out ${pretty(latest.netOut)} B/s · OS counters` : 'First sample establishes the baseline'}
            />
            <Tile
              label="ORVEX CPU"
              value={latest && latest.appCpu != null ? `${num(latest.appCpu)}%` : overview?.appTotals.cpu != null ? `${num(overview.appTotals.cpu)}%` : 'n/a'}
              hint={`${overview?.appTotals.processes ?? 0} Electron process${overview?.appTotals.processes === 1 ? '' : 'es'}`}
            />
          </div>

          <div className="mon-card">
            <div className="mon-card-head">
              <span><Activity size={14} /> Resource history</span>
              <div className="mon-range">
                {RANGES.map((range) => (
                  <button key={range.minutes} className={minutes === range.minutes ? 'active' : ''} onClick={() => setMinutes(range.minutes)}>
                    {range.label}
                  </button>
                ))}
              </div>
            </div>
            <LineChart
              rows={chartRows}
              fixedMax={100}
              series={[
                { key: 'cpu', label: 'CPU', color: '#4fc3ff' },
                { key: 'mem', label: 'RAM', color: '#a78bfa' },
                { key: 'disk', label: 'Disk', color: '#fbbf24' },
                { key: 'gpu', label: 'GPU', color: '#4ade80' },
                { key: 'appCpu', label: 'ORVEX', color: '#f472b6' },
              ]}
            />
            <p className="mon-note">
              Samples are written every {Math.round((overview?.sampleMs || 15000) / 1000)}s and kept for 7 days. CPU is a real delta between two OS reads;
              a null GPU line means the driver exposes no utilisation.
            </p>
          </div>

          <div className="mon-grid-2">
            <div className="mon-card">
              <div className="mon-card-head"><span><Network size={14} /> Network throughput</span></div>
              <LineChart
                rows={chartRows}
                series={[
                  { key: 'netIn', label: 'In', color: '#38bdf8' },
                  { key: 'netOut', label: 'Out', color: '#fb7185' },
                ]}
              />
            </div>
            <div className="mon-card">
              <div className="mon-card-head"><span><Server size={14} /> ORVEX processes</span></div>
              {overview && overview.app.length ? (
                <div className="mon-table">
                  <div className="mon-row mon-head"><span>Type</span><span>PID</span><span>CPU %</span><span>Memory</span></div>
                  {overview.app.map((proc) => (
                    <div key={proc.pid} className="mon-row">
                      <span className="mon-mono">{proc.type}</span>
                      <span>{proc.pid}</span>
                      <span>{num(proc.cpu)}</span>
                      <span>{num(proc.memMB)} MB</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="dim">Electron did not report process metrics for this session.</p>
              )}
            </div>
          </div>

          <div className="mon-grid-2">
            <div className="mon-card">
              <div className="mon-card-head"><span><Gauge size={14} /> Session</span></div>
              <div className="mon-kv">
                <span>App version</span><b>{overview?.session.version || 'dev'}</b>
                <span>Session uptime</span><b>{duration((overview?.session.uptimeSec || 0) * 1000)}</b>
                <span>Database</span><b>{overview?.db.ready ? `${bytes(overview.db.bytes)} · ${overview.db.file ? overview.db.file.split(/[\\/]/).pop() : 'orvex.db'}` : 'not open'}</b>
                <span>Today</span><b>{overview?.today ? `${overview.today.calls} calls · ${pretty(overview.today.tokens)} tokens · ${money(overview.today.cost)}` : 'no calls'}</b>
                <span>Last crash</span><b>{overview?.crashes ? when(overview.crashes.at) : 'none recorded'}</b>
              </div>
            </div>
            <div className="mon-card">
              <div className="mon-card-head"><span><Cpu size={14} /> Diagnostics</span></div>
              <p className="mon-note">
                The sampler runs in the main process, so it keeps recording while this page is closed. If the GPU row stays n/a the
                driver does not publish utilisation — ORVEX reports the gap instead of inventing a number.
              </p>
              <div className="mon-actions">
                <button className="ghost-btn" onClick={() => void loadHealth()} disabled={!bridge}>
                  <HeartPulse size={12} /> Run health check
                </button>
                <button className="ghost-btn" onClick={() => void loadTraces()}>
                  <Layers size={12} /> Recent traces
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'usage' && (
        <div className="mon-stack">
          <div className="mon-toolbar">
            <div className="mon-range">
              {USAGE_WINDOWS.map((win) => (
                <button key={win.ms} className={usageWindow === win.ms ? 'active' : ''} onClick={() => setUsageWindow(win.ms)}>
                  {win.label}
                </button>
              ))}
            </div>
            <button className="ghost-btn" onClick={() => void exportCsv()} disabled={!bridge}>
              <Download size={12} /> Export CSV
            </button>
            <button className="ghost-btn" onClick={() => void loadUsage()} disabled={!bridge}>
              <RefreshCw size={12} /> Refresh
            </button>
          </div>

          <div className="mon-tiles">
            <Tile label="Calls" value={usage?.totals ? String(usage.totals.calls) : '0'} hint={`Window ${USAGE_WINDOWS.find((w) => w.ms === usageWindow)?.label}`} />
            <Tile label="Tokens" value={usage?.totals ? pretty(usage.totals.tokens) : '0'} hint="Prompt + completion, provider-reported when available" />
            <Tile label="Cost" value={money(usage?.totals?.cost)} hint={usage?.totals?.estimated ? `${usage.totals.estimated} call(s) priced from a catalogue estimate` : 'Provider-reported or catalogue priced'} />
            <Tile label="Failures" value={usage?.totals ? String(usage.totals.failures) : '0'} tone={usage?.totals?.failures ? 'warn' : undefined} hint="Failed model attempts in this window" />
            <Tile label="Avg latency" value={usage?.totals ? `${Math.round(usage.totals.avgMs)} ms` : 'n/a'} hint="Mean wall time per call" />
            <Tile
              label="Today vs budget"
              value={usage ? `${money(usage.budget.todayUsd)}${usage.budget.dailyUsd ? ` / ${money(usage.budget.dailyUsd)}` : ''}` : 'n/a'}
              hint={usage?.budget.remainingUsd != null ? `${money(usage.budget.remainingUsd)} left today` : 'No daily cap set'}
              tone={usage && usage.budget.dailyUsd > 0 && usage.budget.todayUsd > usage.budget.dailyUsd ? 'warn' : undefined}
            />
          </div>

          <div className="mon-card">
            <div className="mon-card-head"><span><Gauge size={14} /> Daily budget guard</span></div>
            <div className="mon-inline">
              <label>Daily limit (USD)</label>
              <input className="mon-input" value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" placeholder="0 = off" />
              <button className="ghost-btn" onClick={() => void saveBudget()} disabled={!bridge}>
                Save
              </button>
              <span className="mon-hint">The gateway warns when today's spend passes this line. Set 0 to disable.</span>
            </div>
          </div>

          <div className="mon-grid-2">
            <div className="mon-card">
              <div className="mon-card-head"><span>Tokens per bucket</span></div>
              <LineChart rows={(usage?.series.points || []) as unknown as ChartRow[]} series={[{ key: 'tokens', label: 'Tokens', color: '#4fc3ff' }]} />
            </div>
            <div className="mon-card">
              <div className="mon-card-head"><span>Cost per bucket</span></div>
              <LineChart rows={(usage?.series.points || []) as unknown as ChartRow[]} series={[{ key: 'cost', label: 'USD', color: '#fbbf24' }]} />
            </div>
          </div>

          <div className="mon-card">
            <div className="mon-card-head"><span>By provider</span></div>
            {usage && usage.byProvider.length ? (
              <div className="mon-table">
                <div className="mon-row mon-head"><span>Provider</span><span>Calls</span><span>Tokens</span><span>Cost</span><span>Failures</span></div>
                {usage.byProvider.map((row) => (
                  <div key={row.provider} className="mon-row">
                    <span>{row.provider}</span>
                    <span>{row.calls}</span>
                    <span>{pretty(row.tokens)}</span>
                    <span>{money(row.cost)}</span>
                    <span>{row.failures}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="dim">No usage has been recorded yet. Chat with a model and it will appear here.</p>
            )}
          </div>

          <div className="mon-grid-2">
            <div className="mon-card">
              <div className="mon-card-head"><span>By model</span></div>
              <div className="mon-table">
                <div className="mon-row mon-head"><span>Model</span><span>Calls</span><span>Tokens</span><span>Cost</span></div>
                {(usage?.byModel || []).slice(0, 12).map((row) => (
                  <div key={`${row.provider}-${row.model}`} className="mon-row">
                    <span className="mon-mono">{row.model || 'unknown'}</span>
                    <span>{row.calls}</span>
                    <span>{pretty(row.tokens)}</span>
                    <span>{money(row.cost)}</span>
                  </div>
                ))}
                {!usage?.byModel.length && <p className="dim">No calls in this window.</p>}
              </div>
            </div>
            <div className="mon-card">
              <div className="mon-card-head"><span>By task</span></div>
              <div className="mon-table">
                <div className="mon-row mon-head"><span>Task</span><span>Calls</span><span>Tokens</span><span>Cost</span></div>
                {(usage?.byTask || []).map((row) => (
                  <div key={row.task} className="mon-row">
                    <span>{row.task}</span>
                    <span>{row.calls}</span>
                    <span>{pretty(row.tokens)}</span>
                    <span>{money(row.cost)}</span>
                  </div>
                ))}
                {!usage?.byTask.length && <p className="dim">No calls in this window.</p>}
              </div>
            </div>
          </div>

          <div className="mon-card">
            <div className="mon-card-head"><span><History size={14} /> Recent calls</span></div>
            {usage?.recent.length ? (
              <div className="mon-table mon-table-wide">
                <div className="mon-row mon-head"><span>When</span><span>Provider · model</span><span>Task</span><span>Tokens</span><span>Cost</span><span>ms</span><span>Result</span></div>
                {usage.recent.slice(0, 25).map((row, index) => (
                  <div key={`${row.ts}-${index}`} className="mon-row">
                    <span>{clock(row.ts)}</span>
                    <span className="mon-mono">{row.provider || '—'} · {row.model || '—'}</span>
                    <span>{row.task || '—'}</span>
                    <span>{pretty(row.tokens)}</span>
                    <span>{money(row.cost)}</span>
                    <span>{row.ms ?? '—'}</span>
                    <span className={row.ok ? 'mon-ok' : 'mon-bad'}>{row.ok ? 'ok' : row.error || 'failed'}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="dim">No recorded calls yet.</p>
            )}
          </div>
        </div>
      )}

      {tab === 'traces' && (
        <div className="mon-split">
          <div className="mon-card mon-traces">
            <div className="mon-card-head">
              <span><Layers size={14} /> Runs</span>
              <button className="ghost-btn" onClick={() => void loadTraces()}>
                <RefreshCw size={12} />
              </button>
            </div>
            {traces.length === 0 && <p className="dim">No runs recorded yet. Start a goal on the Engine page and its trace appears here.</p>}
            <div className="mon-trace-list">
              {traces.map((run) => (
                <button key={run.id} className={`mon-trace-item ${trace?.run.id === run.id ? 'active' : ''}`} onClick={() => void openTrace(run.id)}>
                  <div className="mon-trace-top">
                    <span className="mon-mono">{run.id}</span>
                    <span className={`mon-chip ${run.status === 'done' || run.status === 'completed' ? 'ok' : run.status === 'failed' ? 'bad' : ''}`}>{run.status}</span>
                  </div>
                  <div className="mon-trace-goal">{run.goal || 'Untitled run'}</div>
                  <div className="mon-trace-meta">
                    <span>{run.toolCalls} tools</span>
                    <span>{run.modelCalls} model calls</span>
                    <span>{pretty(run.tokens)} tok</span>
                    <span>{money(run.cost)}</span>
                    <span>{when(run.startedAt)}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="mon-card mon-trace-detail">
            <div className="mon-card-head"><span><ArrowRight size={14} /> Timeline</span></div>
            {traceError && <p className="dim">{traceError}</p>}
            {!trace && !traceError && <p className="dim">Select a run to see its steps, tool calls and model spans on one timeline.</p>}
            {trace && (
              <>
                <div className="mon-trace-summary">
                  <span className={`mon-chip ${trace.run.status === 'failed' ? 'bad' : 'ok'}`}>{trace.run.status}</span>
                  <b>{trace.run.goal || 'Untitled run'}</b>
                  <span>{trace.run.provider ? `${trace.run.provider} · ${trace.run.model}` : trace.run.model || 'no model'}</span>
                  <span>{duration(trace.run.endedAt ? trace.run.endedAt - trace.run.startedAt : Date.now() - trace.run.startedAt)}</span>
                </div>
                <div className="mon-totals">
                  <span>{trace.totals.steps} steps</span>
                  <span>{trace.totals.tools} tool calls · {trace.totals.toolFailures} failed</span>
                  <span>{trace.totals.models} model calls · {trace.totals.modelFailures} failed</span>
                  <span>{pretty(trace.totals.tokens)} tokens</span>
                  <span>{money(trace.totals.cost)}</span>
                </div>
                <div className="mon-spans">
                  {trace.spans.map((span) => {
                    const runStart = trace.run.startedAt || trace.spans[0]?.start || Date.now()
                    const runEnd = trace.run.endedAt || Date.now()
                    const spanLength = Math.max(1, runEnd - runStart)
                    const left = Math.min(99, Math.max(0, ((span.start - runStart) / spanLength) * 100))
                    const width = Math.min(100 - left, Math.max(0.4, (span.ms / spanLength) * 100))
                    return (
                      <div key={span.id} className="mon-span">
                        <div className="mon-span-head">
                          <span className={`mon-kind mon-kind-${span.kind}`}>{span.kind}</span>
                          <span className="mon-span-label" title={span.detail}>{span.label}</span>
                          <span className="mon-span-time">{clock(span.start)}</span>
                          <span className="mon-span-ms">{duration(span.ms)}</span>
                          <span className={span.ok === null ? 'mon-dim' : span.ok ? 'mon-ok' : 'mon-bad'}>{span.ok === null ? 'open' : span.ok ? 'ok' : 'failed'}</span>
                        </div>
                        <div className="mon-span-track">
                          <i className={`mon-span-bar mon-kind-${span.kind}`} style={{ left: `${left}%`, width: `${Math.max(width, 0.6)}%` }} />
                        </div>
                        {span.detail && <div className="mon-span-detail">{span.detail}</div>}
                      </div>
                    )
                  })}
                  {trace.spans.length === 0 && <p className="dim">This run has no tool or model spans recorded.</p>}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'compare' && (
        <div className="mon-stack">
          <div className="mon-card">
            <div className="mon-card-head"><span><Zap size={14} /> Compare models</span></div>
            <p className="mon-note">
              One prompt goes to every selected model in order, through the same gateway the app uses. The calls are real and are billed by your
              providers, so keep the prompt short.
            </p>
            <div className="mon-inline mon-wrap">
              {candidates.length === 0 && <span className="mon-hint">No provider is configured yet. Add one in Settings → Providers.</span>}
              {candidates.map((candidate) => {
                const id = String(candidate.id || candidate.presetId)
                const checked = compareIds.includes(id)
                return (
                  <label key={id} className={`mon-check ${checked ? 'on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setCompareIds((current) => (checked ? current.filter((x) => x !== id) : [...current, id].slice(0, 5)))
                      }
                    />
                    {candidate.name || candidate.model} <em>{candidate.model}</em>
                  </label>
                )
              })}
            </div>
            <textarea
              className="mon-textarea"
              value={comparePrompt}
              onChange={(e) => setComparePrompt(e.target.value)}
              placeholder="Ask something the models should answer differently — a coding task, a rewrite, a reasoning puzzle…"
              rows={5}
            />
            <div className="mon-inline mon-wrap">
              <label>System prompt (optional)</label>
              <input className="mon-input mon-input-wide" value={compareSystem} onChange={(e) => setCompareSystem(e.target.value)} placeholder="You are a precise assistant." />
              <label>Max tokens</label>
              <input className="mon-input mon-input-sm" value={compareMax} onChange={(e) => setCompareMax(Math.max(16, Math.min(4000, Number(e.target.value) || 400)))} inputMode="numeric" />
              <button className="engine-run mon-run" onClick={() => void runCompare()} disabled={busy || candidates.length < 2}>
                <Play size={13} /> {busy ? 'Calling models…' : 'Run comparison'}
              </button>
            </div>
          </div>

          {compare && (
            <div className="mon-card">
              <div className="mon-card-head">
                <span>Results · {when(compare.at)}</span>
                <span className="mon-hint">{compare.summary.ok} replied · {compare.summary.failed} failed · {pretty(compare.summary.tokens)} tokens · {money(compare.summary.cost)}</span>
              </div>
              <div className="mon-compare-grid">
                {compare.results.map((result) => (
                  <div key={`${result.id}-${result.model}`} className={`mon-compare ${result.ok ? '' : 'failed'}`}>
                    <div className="mon-compare-head">
                      <b>{result.name}</b>
                      <span className="mon-mono">{result.model}</span>
                      <span className={`mon-chip ${result.ok ? 'ok' : 'bad'}`}>{result.ok ? `${result.ms} ms` : 'failed'}</span>
                    </div>
                    {result.usage && (
                      <div className="mon-compare-stats">
                        <span>{pretty(result.usage.totalTokens)} tokens</span>
                        <span>{money(result.usage.costUsd)}</span>
                        {result.usage.estimated && <span className="mon-chip warn">estimated</span>}
                      </div>
                    )}
                    {result.ok ? <pre className="mon-output">{result.text}</pre> : <p className="mon-bad">{result.error}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'evals' && (
        <div className="mon-split mon-eval-split">
          <div className="mon-card">
            <div className="mon-card-head">
              <span><FlaskConical size={14} /> Suites</span>
              <button className="ghost-btn" onClick={newSuite}>
                <Play size={12} /> New
              </button>
            </div>
            <div className="mon-trace-list">
              {suites.map((suite) => (
                <button
                  key={suite.id}
                  className={`mon-trace-item ${suite.id === suiteId ? 'active' : ''}`}
                  onClick={() => {
                    setSuiteId(suite.id)
                    setSuiteName(suite.name)
                    setCasesText(JSON.stringify(suite.cases, null, 2))
                    setEvalResult(null)
                  }}
                >
                  <div className="mon-trace-top">
                    <span className="mon-mono">{suite.id}</span>
                    <span className="mon-chip">{suite.caseCount} case{suite.caseCount === 1 ? '' : 's'}</span>
                  </div>
                  <div className="mon-trace-goal">{suite.name}</div>
                  <div className="mon-trace-meta"><span>updated {when(suite.updatedAt)}</span></div>
                </button>
              ))}
              {!suites.length && <p className="dim">No suite yet. Press New to start one.</p>}
            </div>
          </div>

          <div className="mon-stack">
            <div className="mon-card">
              <div className="mon-card-head">
                <span><FlaskConical size={14} /> {suiteId ? 'Edit suite' : 'New suite'}</span>
                <div className="mon-actions">
                  <button className="ghost-btn" onClick={() => void saveSuite()} disabled={busy}>Save</button>
                  {suiteId && (
                    <button className="ghost-btn danger" onClick={() => void deleteSuite()} disabled={busy}>
                      <Trash2 size={12} /> Delete
                    </button>
                  )}
                </div>
              </div>
              <div className="mon-inline">
                <label>Name</label>
                <input className="mon-input mon-input-wide" value={suiteName} onChange={(e) => setSuiteName(e.target.value)} />
              </div>
              <label className="mon-label">Cases (JSON)</label>
              <textarea className="mon-textarea mon-code" value={casesText} onChange={(e) => setCasesText(e.target.value)} rows={14} spellCheck={false} />
              <p className="mon-note">
                Each case needs a <code>prompt</code> and at least one check: <code>contains</code>, <code>notContains</code>, <code>regex</code>,{' '}
                <code>json</code> or <code>maxMs</code>. Checks run against the real reply and the score is the share that passed.
              </p>
              <div className="mon-inline mon-wrap">
                {candidates.map((candidate) => {
                  const id = String(candidate.id || candidate.presetId)
                  const checked = evalIds.includes(id)
                  return (
                    <label key={id} className={`mon-check ${checked ? 'on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => setEvalIds((current) => (checked ? current.filter((x) => x !== id) : [...current, id].slice(0, 3)))}
                      />
                      {candidate.name || candidate.model}
                    </label>
                  )
                })}
                <button className="engine-run mon-run" onClick={() => void runEvals()} disabled={busy || !suiteId || !candidates.length}>
                  <Play size={13} /> {busy ? 'Running…' : 'Run suite'}
                </button>
              </div>
              {candidates.length === 0 && <p className="mon-hint">Configure a provider in Settings before running evals.</p>}
            </div>

            {evalResult && (
              <div className="mon-card">
                <div className="mon-card-head">
                  <span>Latest run · {when(evalResult.at)}</span>
                  <span className="mon-hint">
                    {evalResult.summary.passed}/{evalResult.summary.runs} passed · score {(evalResult.summary.score * 100).toFixed(0)}% · avg {duration(evalResult.summary.avgMs)}
                  </span>
                </div>
                <div className="mon-eval-rows">
                  {evalResult.rows.map((row, index) => (
                    <div key={`${row.caseId}-${index}`} className="mon-eval-row">
                      <div className="mon-eval-head">
                        <span className={`mon-chip ${row.ok ? 'ok' : 'bad'}`}>{row.ok ? 'pass' : 'fail'}</span>
                        <b>{row.caseId}</b>
                        <span className="mon-mono">{row.provider} · {row.model}</span>
                        <span>{duration(row.ms)}</span>
                        <span>{(row.score * 100).toFixed(0)}%</span>
                      </div>
                      <div className="mon-eval-checks">
                        {row.detail.checks.map((check, checkIndex) => (
                          <span key={checkIndex} className={`mon-chip ${check.ok ? 'ok' : 'bad'}`} title={check.detail}>{check.name}</span>
                        ))}
                        {row.detail.error && <span className="mon-chip bad">{row.detail.error}</span>}
                      </div>
                      {row.detail.output && <pre className="mon-output mon-output-sm">{row.detail.output}</pre>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mon-card">
              <div className="mon-card-head">
                <span><History size={14} /> History</span>
                <button className="ghost-btn" onClick={() => void clearEvalHistory()} disabled={!suiteId || !evalHistory.length}>
                  Clear
                </button>
              </div>
              {evalHistory.length ? (
                <div className="mon-table mon-table-wide">
                  <div className="mon-row mon-head"><span>When</span><span>Case</span><span>Model</span><span>Score</span><span>Result</span></div>
                  {evalHistory.slice(0, 25).map((row) => (
                    <div key={row.id} className="mon-row">
                      <span>{when(row.at)}</span>
                      <span className="mon-mono">{row.caseId}</span>
                      <span className="mon-mono">{row.detail ? row.detail.model : '—'}</span>
                      <span>{(row.score * 100).toFixed(0)}%</span>
                      <span className={row.ok ? 'mon-ok' : 'mon-bad'}>{row.ok ? 'pass' : 'fail'}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="dim">No runs recorded for this suite yet.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'health' && (
        <div className="mon-stack">
          <div className="mon-toolbar">
            <div className="mon-health-summary">
              <span className="mon-chip ok">{health?.summary.ok ?? 0} ok</span>
              <span className="mon-chip warn">{health?.summary.warn ?? 0} warnings</span>
              <span className="mon-chip bad">{health?.summary.fail ?? 0} failures</span>
              <span className="mon-hint">Checked {health ? when(health.at) : 'not yet'}</span>
            </div>
            <button className="ghost-btn" onClick={() => void loadHealth()} disabled={!bridge}>
              <RefreshCw size={12} /> Run checks
            </button>
          </div>
          <div className="mon-card">
            <div className="mon-card-head"><span><HeartPulse size={14} /> Health checks</span></div>
            {!health && <p className="dim">Running the first probe…</p>}
            {health?.checks.map((check) => (
              <div key={check.id} className={`mon-health-row ${check.status}`}>
                <span className={STATUS_CHIP[check.status]}>{check.status === 'ok' ? <CheckCircle2 size={11} /> : check.status === 'warn' ? <AlertTriangle size={11} /> : <XCircle size={11} />}</span>
                <b>{check.label}</b>
                <span className="mon-health-detail">{check.detail}</span>
              </div>
            ))}
          </div>
          <p className="mon-note">
            Probes read the real store, folder, disk counters, encryption availability, provider circuits, workflow queue, security state and backup
            list. A warning is information, not a failure — for example an emergency stop is correctly reported as a warning.
          </p>
        </div>
      )}

      {tab === 'recovery' && (
        <div className="mon-stack">
          <div className="mon-toolbar">
            <div className="mon-health-summary">
              <span className={`mon-chip ${recover?.interrupted ? 'warn' : 'ok'}`}>{recover?.interrupted ?? 0} interrupted</span>
              <span className="mon-chip">{recover?.crashes.length ?? 0} crash record{(recover?.crashes.length ?? 0) === 1 ? '' : 's'}</span>
              <span className="mon-hint">Last crash {recover?.lastCrash ? when(recover.lastCrash.at) : 'none'}</span>
            </div>
            <div className="mon-actions">
              <button className="ghost-btn" onClick={() => void loadRecovery()} disabled={!bridge}>
                <RefreshCw size={12} /> Refresh
              </button>
              <button className="ghost-btn danger" onClick={() => void clearCrashes()} disabled={!bridge || !recover?.crashes.length}>
                Clear crash log
              </button>
            </div>
          </div>

          <div className="mon-card">
            <div className="mon-card-head"><span><ShieldAlert size={14} /> Interrupted agent runs</span></div>
            {recover?.runs.length ? (
              <div className="mon-recovery-list">
                {recover.runs.map((run) => (
                  <div key={run.id} className="mon-recovery-row">
                    <div className="mon-trace-top">
                      <span className="mon-mono">{run.id}</span>
                      <span className="mon-chip warn">{run.status}</span>
                      <span className="mon-hint">{when(run.startedAt)} · {run.steps} steps</span>
                    </div>
                    <div className="mon-trace-goal">{run.goal || 'Untitled run'}</div>
                    <div className="mon-actions">
                      <button className="ghost-btn" onClick={() => void resumeRun(run.id, run.goal)} disabled={busy}>
                        <RotateCcw size={12} /> Resume
                      </button>
                      <button className="ghost-btn danger" onClick={() => void abandonRun(run.id)} disabled={busy}>
                        <Square size={12} /> Mark abandoned
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="dim">No interrupted runs with a saved plan. Nothing to recover.</p>
            )}
          </div>

          <div className="mon-card">
            <div className="mon-card-head"><span><Layers size={14} /> Interrupted workflow runs</span></div>
            {recover?.workflows.length ? (
              <div className="mon-recovery-list">
                {recover.workflows.map((run) => (
                  <div key={run.id} className="mon-recovery-row">
                    <div className="mon-trace-top">
                      <span className="mon-mono">{run.id}</span>
                      <span className={`mon-chip ${run.status === 'interrupted' ? 'warn' : ''}`}>{run.status}</span>
                      <span className="mon-hint">{run.workflowName} · {run.steps} steps</span>
                    </div>
                    <div className="mon-actions">
                      {run.canResume && (
                        <button className="ghost-btn" onClick={() => void resumeWorkflow(run.id)}>
                          <RotateCcw size={12} /> Resume
                        </button>
                      )}
                      <button className="ghost-btn danger" onClick={() => void cancelWorkflow(run.id)}>
                        <Square size={12} /> Cancel
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="dim">No queued or interrupted workflow runs.</p>
            )}
          </div>

          <div className="mon-card">
            <div className="mon-card-head"><span><AlertTriangle size={14} /> Crash log</span></div>
            {recover?.crashes.length ? (
              <div className="mon-table">
                <div className="mon-row mon-head"><span>When</span><span>PID</span><span>Session</span><span>Reason</span></div>
                {recover.crashes.map((crash) => (
                  <div key={crash.id} className="mon-row">
                    <span>{new Date(crash.at).toLocaleString()}</span>
                    <span>{crash.pid ?? '—'}</span>
                    <span className="mon-mono">{crash.sessionId || '—'}</span>
                    <span>{crash.reason || 'unclean shutdown'}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="dim">No unclean shutdown has been recorded. The session marker is removed on a normal quit.</p>
            )}
          </div>
          <p className="mon-note">
            Crash detection uses a session marker written on boot and removed on a clean quit. Resuming an agent run replays its saved plan through
            the orchestrator with the provider selected in Settings.
          </p>
        </div>
      )}
    </PageShell>
  )
}
