import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Calculator,
  Check,
  ClipboardList,
  Code2,
  Copy,
  Database,
  FileDiff,
  FileText,
  Languages,
  ListChecks,
  NotebookPen,
  Pencil,
  PieChart,
  Play,
  Plus,
  Presentation,
  RefreshCw,
  Save,
  Search,
  Sheet,
  Sparkles,
  SquarePen,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import PageShell from './PageShell'
import { onTablistKeyDown } from '../data/a11y'
import type {
  OrvexBridge,
  OrvexMemoryRagResult,
  OrvexProductivityAnalysis,
  OrvexProductivityBlock,
  OrvexProductivityCalc,
  OrvexProductivityCapabilities,
  OrvexProductivityChart,
  OrvexProductivityCompare,
  OrvexProductivityMeeting,
  OrvexProductivityNote,
  OrvexProductivityPythonInfo,
  OrvexProductivityPythonRun,
  OrvexProductivityReport,
  OrvexProductivitySheet,
  OrvexProductivitySlides,
  OrvexProductivitySqlResult,
  OrvexProductivityTask,
  OrvexProductivityTaskStats,
  OrvexProductivityTextFile,
  OrvexProductivityTranslation,
} from '../types/desktop'

type Bridge = OrvexBridge
type Notify = (msg: string) => void

type Props = {
  onBack: () => void
  notify: Notify
  initialTab?: string | null
}

type Tab =
  | 'calc'
  | 'data'
  | 'sheet'
  | 'sql'
  | 'reports'
  | 'meetings'
  | 'notes'
  | 'tasks'
  | 'translate'
  | 'text'
  | 'slides'
  | 'compare'

const TABS: { id: Tab; label: string }[] = [
  { id: 'calc', label: 'Calculator & Python' },
  { id: 'data', label: 'Data analyzer' },
  { id: 'sheet', label: 'Spreadsheet' },
  { id: 'sql', label: 'SQL' },
  { id: 'reports', label: 'Reports' },
  { id: 'meetings', label: 'Meetings' },
  { id: 'notes', label: 'Notes' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'translate', label: 'Translate' },
  { id: 'text', label: 'Text editor' },
  { id: 'slides', label: 'Slides' },
  { id: 'compare', label: 'Compare' },
]

const LANGUAGES = [
  'English',
  'Urdu',
  'Hindi',
  'Arabic',
  'Persian',
  'Punjabi',
  'Sindhi',
  'Pashto',
  'Bengali',
  'Chinese',
  'Japanese',
  'Korean',
  'Spanish',
  'French',
  'German',
  'Portuguese',
  'Russian',
  'Turkish',
  'Indonesian',
  'Italian',
]

const CHART_COLORS = ['#4fc3ff', '#a78bfa', '#fbbf24', '#4ade80', '#f472b6', '#38bdf8', '#fb7185', '#c084fc', '#34d399', '#facc15']

const number = (n: number | null | undefined, digits = 2) =>
  typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—'

const compact = (n: number | null | undefined) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  if (Math.abs(n) < 1000) return number(n, 2)
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

const bytes = (n: number | null | undefined) => {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = n
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

const when = (ts: number | null | undefined) => {
  if (!ts || !Number.isFinite(ts)) return '—'
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return new Date(ts).toLocaleDateString()
}

const dateValue = (ts: number | null | undefined) => {
  if (!ts || !Number.isFinite(ts)) return ''
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function ErrorLine({ text }: { text: string | null }) {
  return text ? <p className="prod-error" role="alert">{text}</p> : null
}

function Chip({ tone, children }: { tone?: 'ok' | 'bad'; children: ReactNode }) {
  return <span className={`prod-chip ${tone ? `prod-chip-${tone}` : ''}`}>{children}</span>
}

/* ------------------------------------------------------------------ chart */

function ChartView({ chart }: { chart: OrvexProductivityChart }) {
  const points = chart.points
  const values = points.map((p) => Math.abs(p.value ?? p.y ?? 0))
  const max = Math.max(1, ...values)

  if (chart.kind === 'scatter') {
    const xs = points.map((p) => (typeof p.x === 'number' ? p.x : 0))
    const ys = points.map((p) => (typeof p.y === 'number' ? p.y : p.value ?? 0))
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const spanX = maxX - minX || 1
    const spanY = maxY - minY || 1
    return (
      <svg viewBox="0 0 100 100" className="prod-scatter" role="img" aria-label="Scatter chart">
        {[25, 50, 75].map((y) => (
          <line key={`h${y}`} x1="0" y1={y} x2="100" y2={y} className="prod-grid-line" />
        ))}
        {points.map((p, i) => {
          const x = (((typeof p.x === 'number' ? p.x : 0) - minX) / spanX) * 92 + 4
          const y = 96 - (((typeof p.y === 'number' ? p.y : p.value ?? 0) - minY) / spanY) * 92
          return <circle key={i} cx={x} cy={y} r="1.6" fill={CHART_COLORS[i % CHART_COLORS.length]} />
        })}
      </svg>
    )
  }

  if (chart.kind === 'line') {
    const step = points.length > 1 ? 92 / (points.length - 1) : 0
    const path = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${(4 + i * step).toFixed(2)},${(96 - (Math.abs(p.value ?? 0) / max) * 92).toFixed(2)}`)
      .join(' ')
    return (
      <div className="prod-line-wrap">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="prod-line" role="img" aria-label="Line chart">
          {[25, 50, 75].map((y) => (
            <line key={y} x1="0" y1={y} x2="100" y2={y} className="prod-grid-line" />
          ))}
          <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="prod-axis"><span>{points[0]?.label}</span><span>{points[points.length - 1]?.label}</span></div>
      </div>
    )
  }

  if (chart.kind === 'pie') {
    const total = values.reduce((sum, v) => sum + v, 0) || 1
    let acc = 0
    const stops = points.map((p, i) => {
      const start = (acc / total) * 360
      acc += Math.abs(p.value ?? 0)
      const end = (acc / total) * 360
      return `${CHART_COLORS[i % CHART_COLORS.length]} ${start.toFixed(2)}deg ${end.toFixed(2)}deg`
    })
    return (
      <div className="prod-pie">
        <div className="prod-pie-donut" style={{ background: `conic-gradient(${stops.join(', ')})` }} />
        <div className="prod-pie-legend">
          {points.map((p, i) => (
            <span key={`${p.label}-${i}`}>
              <i style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
              {p.label}
              <b>{compact(p.value)}</b>
            </span>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="prod-bars">
      {points.map((p, i) => (
        <div key={`${p.label}-${i}`} className="prod-bar-row">
          <span className="prod-bar-label" title={p.label}>{p.label}</span>
          <span className="prod-bar-track">
            <span style={{ width: `${Math.max(1, (Math.abs(p.value ?? 0) / max) * 100)}%`, background: CHART_COLORS[i % CHART_COLORS.length] }} />
          </span>
          <span className="prod-bar-value">{compact(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------ calculator */

function CalcPanel({ bridge, caps }: { bridge: Bridge; caps: OrvexProductivityCapabilities | null }) {
  const [expr, setExpr] = useState('')
  const [history, setHistory] = useState<OrvexProductivityCalc[]>([])
  const [calcError, setCalcError] = useState<string | null>(null)
  const [python, setPython] = useState<OrvexProductivityPythonInfo | null>(caps?.python ?? null)
  const [code, setCode] = useState('')
  const [timeoutMs, setTimeoutMs] = useState('8000')
  const [running, setRunning] = useState(false)
  const [run, setRun] = useState<OrvexProductivityPythonRun | null>(null)
  const [pyError, setPyError] = useState<string | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (caps?.python) {
      setPython(caps.python)
      return
    }
    void bridge.productivity.pythonInfo().then((res) => {
      if (!alive.current) return
      if (res.ok) setPython(res.data)
      else setPyError(res.error)
    })
  }, [bridge, caps])

  const evaluate = async () => {
    if (!expr.trim()) return
    const res = await bridge.productivity.calc(expr)
    if (!alive.current) return
    if (res.ok) {
      setHistory((current) => [res.data, ...current].slice(0, 40))
      setCalcError(null)
    } else {
      setCalcError(res.error)
    }
  }

  const runPython = async () => {
    if (!code.trim()) {
      setPyError('Write a Python script first.')
      return
    }
    setRunning(true)
    setPyError(null)
    const res = await bridge.productivity.runPython({ code, timeoutMs: Number(timeoutMs) || 8000 })
    if (!alive.current) return
    setRunning(false)
    if (res.ok) setRun(res.data)
    else {
      setRun(null)
      setPyError(res.error)
    }
  }

  return (
    <div className="settings-section">
      <div className="prod-grid-2">
        <div className="settings-block">
          <div className="settings-block-head">
            <h4 className="settings-h"><Calculator size={14} /> Calculator</h4>
            {history.length > 0 && (
              <button className="btn-ghost" onClick={() => setHistory([])}>Clear history</button>
            )}
          </div>
          <p className="settings-note">
            A real recursive-descent evaluator — no <code>eval</code>. Supports <code>+ - * / % ^</code>, parentheses, factorial, <code>pi</code>, <code>e</code>,
            <code>sqrt</code>, <code>cbrt</code>, <code>abs</code>, <code>round</code>, <code>floor</code>, <code>ceil</code>, <code>min</code>, <code>max</code>, <code>pow</code>,
            <code>log</code>, <code>log2</code>, <code>ln</code>, <code>exp</code>, trig and hyperbolic functions.
          </p>
          <form
            className="prod-row"
            onSubmit={(event) => {
              event.preventDefault()
              void evaluate()
            }}
          >
            <input
              id="prod-calc-expr"
              className="text-input prod-grow prod-mono"
              value={expr}
              onChange={(event) => setExpr(event.target.value)}
              placeholder="(1250*0.18)+sqrt(144)"
              spellCheck={false}
            />
            <button className="btn-primary" id="prod-calc-run" type="submit" disabled={!expr.trim()}>
              <Play size={12} /> Evaluate
            </button>
          </form>
          <ErrorLine text={calcError} />
          {history[0] && (
            <div id="prod-calc-result" className="prod-result prod-result-inline">
              <span className="prod-mono prod-result-expr">{history[0].expression} =</span>
              <strong>{history[0].display}</strong>
            </div>
          )}
          {history.length > 0 && (
            <div id="prod-calc-history" className="prod-history">
              {history.map((row, i) => (
                <button key={`${row.expression}-${i}`} className="prod-history-row" onClick={() => setExpr(row.expression)} title="Load this expression">
                  <span className="prod-mono">{row.expression}</span>
                  <b>{row.display}</b>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="settings-block">
          <div className="settings-block-head">
            <h4 className="settings-h"><Code2 size={14} /> Python executor</h4>
            {python && <Chip tone={python.available ? 'ok' : 'bad'}>{python.available ? python.version || 'Python ready' : 'Python not found'}</Chip>}
          </div>
          <p className="settings-note" id="prod-py-info">
            {python?.available
              ? `Runs through ${python.command} in a temporary folder with a hard timeout. This is process isolation, not a hostile-code sandbox.`
              : python?.error || 'Looking for a Python 3 interpreter on PATH…'}
          </p>
          <textarea
            id="prod-py-code"
            className="text-input prod-textarea prod-mono"
            rows={9}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder={'import platform\nprint(platform.python_version())'}
            spellCheck={false}
          />
          <div className="prod-row">
            <label className="field-label" htmlFor="prod-py-timeout">Timeout (ms)</label>
            <input id="prod-py-timeout" className="text-input prod-num" value={timeoutMs} onChange={(event) => setTimeoutMs(event.target.value)} />
            <button className="btn-primary" id="prod-py-run" onClick={() => void runPython()} disabled={running || !python?.available}>
              <Play size={12} /> {running ? 'Running…' : 'Run script'}
            </button>
          </div>
          <ErrorLine text={pyError} />
          {run && (
            <div id="prod-py-out" className="prod-run">
              <div className="prod-row prod-run-meta">
                <Chip tone={run.exitCode === 0 && !run.timedOut ? 'ok' : 'bad'}>
                  {run.timedOut ? 'timed out' : `exit ${run.exitCode ?? run.signal ?? '?'}`}
                </Chip>
                <span className="prod-hint">{run.version} · {run.ms} ms · {run.command}</span>
              </div>
              {run.stdout && <pre className="prod-result">{run.stdout}</pre>}
              {run.stderr && <pre className="prod-result prod-result-bad">{run.stderr}</pre>}
              {!run.stdout && !run.stderr && <p className="prod-hint">The script produced no output.</p>}
              {run.truncated && <p className="prod-hint">Output was truncated at the capture limit.</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- data tab */

function DataPanel({ bridge }: { bridge: Bridge }) {
  const [path, setPath] = useState('')
  const [sheet, setSheet] = useState('')
  const [analysis, setAnalysis] = useState<OrvexProductivityAnalysis | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [x, setX] = useState('')
  const [y, setY] = useState('')
  const [kind, setKind] = useState<'bar' | 'line' | 'pie' | 'scatter'>('bar')
  const [agg, setAgg] = useState<'sum' | 'avg' | 'count' | 'min' | 'max'>('sum')
  const [chart, setChart] = useState<OrvexProductivityChart | null>(null)
  const [chartError, setChartError] = useState<string | null>(null)
  const [chartBusy, setChartBusy] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const numeric = useMemo(() => (analysis ? analysis.columns.filter((c) => c.type === 'number') : []), [analysis])

  const analyze = async (sheetName?: string) => {
    if (!path.trim()) {
      setError('Enter the path of a CSV or XLSX file.')
      return
    }
    setBusy(true)
    setError(null)
    setChart(null)
    const res = await bridge.productivity.dataAnalyze({ path: path.trim(), sheet: sheetName || undefined })
    if (!alive.current) return
    setBusy(false)
    if (!res.ok) {
      setAnalysis(null)
      setError(res.error)
      return
    }
    setAnalysis(res.data)
    setSheet(res.data.sheet)
    const numericColumns = res.data.columns.filter((c) => c.type === 'number')
    const nextY = y && res.data.headers.includes(y) && numericColumns.some((c) => c.name === y) ? y : numericColumns[0]?.name || ''
    const nextX = x && res.data.headers.includes(x) ? x : ''
    setY(nextY)
    setX(nextX)
  }

  const buildChart = async () => {
    if (!analysis) {
      setChartError('Analyze a file first.')
      return
    }
    if (!y) {
      setChartError('Choose a numeric Y column.')
      return
    }
    setChartBusy(true)
    setChartError(null)
    const res = await bridge.productivity.dataChart({ path: analysis.path, sheet: analysis.sheet, x: x || undefined, y, kind, agg })
    if (!alive.current) return
    setChartBusy(false)
    if (res.ok) setChart(res.data)
    else {
      setChart(null)
      setChartError(res.error)
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-block">
        <div className="settings-block-head"><h4 className="settings-h"><Sheet size={14} /> Data analyzer</h4></div>
        <p className="settings-note">
          Reads CSV or XLSX directly from disk, then profiles every column (type, missing values, unique counts, numeric statistics and top values).
          Files are opened read-only; the OS guardrails block system folders.
        </p>
        <form
          className="prod-row"
          onSubmit={(event) => {
            event.preventDefault()
            void analyze()
          }}
        >
          <input
            id="prod-data-path"
            className="text-input prod-grow prod-mono"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="C:\\data\\sales.xlsx"
            spellCheck={false}
          />
          {analysis && analysis.sheets.length > 1 && (
            <select className="select" value={sheet} onChange={(event) => void analyze(event.target.value)}>
              {analysis.sheets.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          )}
          <button className="btn-primary" id="prod-data-run" type="submit" disabled={busy}>
            <Search size={12} /> {busy ? 'Analyzing…' : 'Analyze'}
          </button>
        </form>
        <ErrorLine text={error} />
        {analysis && (
          <div id="prod-data-result">
            <div className="prod-row prod-meta-row">
              <Chip tone="ok">{analysis.rows.toLocaleString()} rows</Chip>
              <Chip>{analysis.columns.length} columns</Chip>
              <Chip>{analysis.sheet}</Chip>
              <span className="prod-hint prod-mono prod-ellipsis" title={analysis.path}>{analysis.path}</span>
              <span className="prod-hint">{bytes(analysis.bytes)}</span>
              {analysis.truncated && <Chip tone="bad">preview truncated</Chip>}
            </div>
            <div className="prod-scroll">
              <table className="prod-table">
                <thead>
                  <tr>
                    <th>Column</th><th>Type</th><th>Non-empty</th><th>Missing</th><th>Unique</th>
                    <th>Min</th><th>Max</th><th>Sum</th><th>Mean</th><th>Median</th><th>Std dev</th><th>Top values</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.columns.map((column) => (
                    <tr key={`${column.index}-${column.name}`}>
                      <td className="prod-strong">{column.name || `(column ${column.index + 1})`}</td>
                      <td><Chip>{column.type}</Chip></td>
                      <td>{number(column.nonEmpty, 0)}</td>
                      <td className={column.missing ? 'prod-warn-text' : ''}>{number(column.missing, 0)}</td>
                      <td>{number(column.unique, 0)}</td>
                      <td>{number(column.min)}</td>
                      <td>{number(column.max)}</td>
                      <td>{number(column.sum)}</td>
                      <td>{number(column.mean)}</td>
                      <td>{number(column.median)}</td>
                      <td>{number(column.stddev)}</td>
                      <td className="prod-top-values">
                        {column.top.length
                          ? column.top.map((top) => <span key={`${top.value}-${top.count}`} className="prod-top">{top.value} ×{top.count}</span>)
                          : <span className="prod-hint">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {analysis.sample.length > 0 && (
              <div className="prod-scroll prod-sample">
                <table className="prod-table">
                  <thead>
                    <tr>{analysis.headers.map((header, i) => <th key={`${header}-${i}`}>{header || `(${i + 1})`}</th>)}</tr>
                  </thead>
                  <tbody>
                    {analysis.sample.map((row, r) => (
                      <tr key={r}>
                        {analysis.headers.map((_header, i) => <td key={i}>{String(row[i] ?? '')}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="settings-block">
        <div className="settings-block-head"><h4 className="settings-h"><PieChart size={14} /> Chart builder</h4></div>
        <p className="settings-note">Groups rows by the X column and aggregates the numeric Y column. Leave X empty to chart row order.</p>
        <div className="prod-row">
          <select className="select prod-grow" id="prod-chart-x" value={x} onChange={(event) => setX(event.target.value)} disabled={!analysis}>
            <option value="">X · (row order)</option>
            {analysis?.headers.map((header) => <option key={header} value={header}>{header}</option>)}
          </select>
          <select className="select prod-grow" id="prod-chart-y" value={y} onChange={(event) => setY(event.target.value)} disabled={!analysis}>
            <option value="">Y · numeric column</option>
            {numeric.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
          </select>
          <select className="select" id="prod-chart-kind" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            <option value="bar">Bar</option>
            <option value="line">Line</option>
            <option value="pie">Pie</option>
            <option value="scatter">Scatter</option>
          </select>
          <select className="select" id="prod-chart-agg" value={agg} onChange={(event) => setAgg(event.target.value as typeof agg)} disabled={kind === 'scatter'}>
            <option value="sum">Sum</option>
            <option value="avg">Average</option>
            <option value="count">Count</option>
            <option value="min">Min</option>
            <option value="max">Max</option>
          </select>
          <button className="btn-primary" id="prod-chart-run" onClick={() => void buildChart()} disabled={!analysis || chartBusy}>
            <Sparkles size={12} /> {chartBusy ? 'Building…' : 'Build chart'}
          </button>
        </div>
        <ErrorLine text={chartError} />
        {chart && (
          <div id="prod-chart-result" className="prod-chart">
            <div className="prod-row prod-meta-row">
              <Chip>{chart.kind}</Chip>
              <span className="prod-hint">{chart.y} by {chart.x}{chart.agg ? ` · ${chart.agg}` : ''} · {chart.points.length} point{chart.points.length === 1 ? '' : 's'}</span>
              {chart.truncated && <Chip tone="bad">showing first {chart.points.length}</Chip>}
            </div>
            <ChartView chart={chart} />
          </div>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- sheet tab */

function SheetPanel({ bridge }: { bridge: Bridge }) {
  const [path, setPath] = useState('')
  const [sheet, setSheet] = useState('Sheet1')
  const [headers, setHeaders] = useState<string[]>(['Column 1'])
  const [rows, setRows] = useState<(string | number)[][]>([['']])
  const [sheets, setSheets] = useState<string[]>([])
  const [info, setInfo] = useState<OrvexProductivitySheet | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = (data: OrvexProductivitySheet) => {
    setInfo(data)
    setSheet(data.sheet)
    setSheets(data.sheets)
    setHeaders(data.headers.length ? data.headers : ['Column 1'])
    setRows(data.rows.length ? data.rows.map((row) => data.headers.map((_h, i) => row[i] ?? '')) : [data.headers.map(() => '')])
  }

  const open = async (sheetName?: string) => {
    if (!path.trim()) {
      setError('Enter the path of an existing XLSX or CSV file.')
      return
    }
    setBusy(true)
    setError(null)
    setMessage(null)
    const res = await bridge.productivity.sheetOpen({ path: path.trim(), sheet: sheetName || sheet || undefined })
    if (!alive.current) return
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    load(res.data)
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    setMessage(null)
    const res = await bridge.productivity.sheetSave({
      path: path.trim() || undefined,
      sheet,
      headers,
      rows,
    })
    if (!alive.current) return
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setPath(res.data.path)
    setSheets(res.data.sheets)
    setMessage(`Saved ${res.data.rows ?? rows.length} rows × ${res.data.columns ?? headers.length} columns to ${res.data.path} (sheets: ${res.data.sheets.join(', ')})`)
    setInfo((current) => (current ? { ...current, path: res.data.path, bytes: res.data.bytes, sheets: res.data.sheets } : current))
  }

  const create = async () => {
    setBusy(true)
    setError(null)
    setMessage(null)
    const res = await bridge.productivity.sheetCreate({
      path: path.trim() || undefined,
      sheets: [{ name: sheet, headers, rows }],
    })
    if (!alive.current) return
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setPath(res.data.path)
    setSheets(res.data.sheets)
    setMessage(`Created ${res.data.path} with sheets: ${res.data.sheets.join(', ')}`)
  }

  const setCell = (r: number, c: number, value: string) => {
    setRows((current) => current.map((row, ri) => (ri === r ? headers.map((_h, ci) => (ci === c ? value : row[ci] ?? '')) : row)))
  }
  const setHeader = (c: number, value: string) => {
    setHeaders((current) => current.map((h, i) => (i === c ? value : h)))
  }

  return (
    <div className="settings-section">
      <div className="settings-block">
        <div className="settings-block-head">
          <h4 className="settings-h"><Sheet size={14} /> Spreadsheet editor</h4>
          {info && <span className="prod-hint">{bytes(info.bytes)} · {info.totalRows.toLocaleString()} source rows</span>}
        </div>
        <p className="settings-note">
          Open an existing workbook, edit cells, then save back or write a new file. Other sheets in the same workbook are preserved;
          numbers are written as numeric cells. Save with an empty path to use the ORVEX sheets folder.
        </p>
        <div className="prod-row">
          <input
            id="prod-sheet-path"
            className="text-input prod-grow prod-mono"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="Leave blank to use the ORVEX sheets folder"
            spellCheck={false}
          />
          <input
            id="prod-sheet-name"
            className="text-input prod-num"
            value={sheet}
            onChange={(event) => setSheet(event.target.value)}
            placeholder="Sheet1"
            title="Sheet name"
          />
          {sheets.length > 0 && (
            <select className="select" value={sheet} onChange={(event) => { setSheet(event.target.value); void open(event.target.value) }}>
              {sheets.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          )}
          <button className="btn-ghost" id="prod-sheet-open" onClick={() => void open()} disabled={busy}>Open</button>
        </div>
        <ErrorLine text={error} />
        {message && <p className="prod-success" id="prod-sheet-status">{message}</p>}
        <div className="prod-row prod-toolbar">
          <button className="btn-ghost" id="prod-sheet-add-row" onClick={() => setRows((current) => [...current, headers.map(() => '')])}>
            <Plus size={12} /> Row
          </button>
          <button className="btn-ghost" onClick={() => { setHeaders((current) => [...current, `Column ${current.length + 1}`]); setRows((current) => current.map((row) => [...row, ''])) }}>
            <Plus size={12} /> Column
          </button>
          <button className="btn-ghost" onClick={() => { setHeaders((current) => (current.length > 1 ? current.slice(0, -1) : current)); setRows((current) => current.map((row) => row.slice(0, Math.max(1, headers.length - 1)))) }}>
            <X size={12} /> Last column
          </button>
          <span className="prod-hint">{rows.length} rows × {headers.length} columns</span>
          <button className="btn-primary" id="prod-sheet-save" onClick={() => void save()} disabled={busy}>
            <Save size={12} /> Save sheet
          </button>
          <button className="btn-primary" id="prod-sheet-create" onClick={() => void create()} disabled={busy}>
            <FileText size={12} /> New workbook
          </button>
        </div>
        <div className="prod-grid-wrap" id="prod-sheet-grid">
          <table className="prod-grid">
            <thead>
              <tr>
                <th className="prod-grid-gutter">#</th>
                {headers.map((header, c) => (
                  <th key={c}>
                    <input className="text-input prod-cell prod-cell-head" value={header} onChange={(event) => setHeader(c, event.target.value)} placeholder={`Column ${c + 1}`} />
                  </th>
                ))}
                <th className="prod-grid-gutter" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  <td className="prod-grid-gutter">{r + 1}</td>
                  {headers.map((_header, c) => (
                    <td key={c}>
                      <input className="text-input prod-cell" value={String(row[c] ?? '')} onChange={(event) => setCell(r, c, event.target.value)} spellCheck={false} />
                    </td>
                  ))}
                  <td className="prod-grid-gutter">
                    <button className="prod-icon-btn" title="Remove row" onClick={() => setRows((current) => (current.length > 1 ? current.filter((_row, ri) => ri !== r) : current.map((item) => item.map(() => ''))))}>
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- sql tab */

function SqlPanel({ bridge }: { bridge: Bridge }) {
  const [sql, setSql] = useState('')
  const [result, setResult] = useState<OrvexProductivitySqlResult | null>(null)
  const [tables, setTables] = useState<{ name: string; type: string; rows: number | null }[]>([])
  const [dbPath, setDbPath] = useState('')
  const [schema, setSchema] = useState<{ table: string; sql: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const loadTables = useCallback(async () => {
    const res = await bridge.productivity.sqlTables()
    if (!alive.current) return
    if (res.ok) {
      setTables(res.data.tables)
      setDbPath(res.data.path)
    } else {
      setError(res.error)
    }
  }, [bridge])

  useEffect(() => {
    void loadTables()
  }, [loadTables])

  const run = async () => {
    if (!sql.trim()) {
      setError('Write a SQL statement first.')
      return
    }
    setBusy(true)
    setError(null)
    const res = await bridge.productivity.sqlRun({ sql, limit: 200 })
    if (!alive.current) return
    setBusy(false)
    if (res.ok) {
      setResult(res.data)
      void loadTables()
    } else {
      setResult(null)
      setError(res.error)
    }
  }

  const showSchema = async (table: string) => {
    const res = await bridge.productivity.sqlSchema(table)
    if (!alive.current) return
    if (res.ok) setSchema(res.data)
    else setError(res.error)
  }

  return (
    <div className="settings-section">
      <div className="prod-grid-2 prod-grid-sql">
        <div className="settings-block">
          <div className="settings-block-head"><h4 className="settings-h"><Database size={14} /> Query console</h4></div>
          <p className="settings-note">
            Real SQLite statements on an ORVEX scratch database (<code>{dbPath || 'productivity/scratch.db'}</code>). ATTACH and DETACH are blocked so a query cannot
            reach other files. Reads return up to 200 rows.
          </p>
          <textarea
            id="prod-sql-text"
            className="text-input prod-textarea prod-mono"
            rows={7}
            value={sql}
            onChange={(event) => setSql(event.target.value)}
            placeholder={'CREATE TABLE demo(id INTEGER PRIMARY KEY, name TEXT)\nSELECT * FROM sqlite_master'}
            spellCheck={false}
          />
          <div className="prod-row">
            <button className="btn-primary" id="prod-sql-run" onClick={() => void run()} disabled={busy}>
              <Play size={12} /> {busy ? 'Running…' : 'Run statement'}
            </button>
            <button className="btn-ghost" onClick={() => void loadTables()}>
              <RefreshCw size={12} /> Refresh tables
            </button>
          </div>
          <ErrorLine text={error} />
          {result && (
            <div id="prod-sql-result" className="prod-sql-result">
              <div className="prod-row prod-meta-row">
                <Chip tone="ok">{result.kind}</Chip>
                <span className="prod-hint">{result.ms} ms</span>
                {typeof result.changes === 'number' && <span className="prod-hint">{result.changes} changes</span>}
                {typeof result.lastInsertRowid === 'number' && <span className="prod-hint">rowid {result.lastInsertRowid}</span>}
                {result.rows.length > 0 && <span className="prod-hint">{result.rows.length} row{result.rows.length === 1 ? '' : 's'}</span>}
                {result.truncated && <Chip tone="bad">truncated</Chip>}
              </div>
              {result.columns.length > 0 && (
                <div className="prod-scroll">
                  <table className="prod-table">
                    <thead><tr>{result.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
                    <tbody>
                      {result.rows.map((row, r) => (
                        <tr key={r}>{row.map((value, c) => <td key={c}>{value === null ? <span className="prod-mono prod-hint">NULL</span> : String(value)}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="settings-block">
          <div className="settings-block-head"><h4 className="settings-h"><ListChecks size={14} /> Tables</h4></div>
          <p className="settings-note">Click a table to inspect its DDL. Row counts are read live from the scratch database.</p>
          <div id="prod-sql-tables" className="prod-table-list">
            {tables.length === 0 && <p className="prod-hint">No tables yet — create one with a statement.</p>}
            {tables.map((table) => (
              <button key={`${table.type}-${table.name}`} className={`prod-table-item ${schema?.table === table.name ? 'active' : ''}`} onClick={() => void showSchema(table.name)}>
                <span className="prod-mono prod-strong">{table.name}</span>
                <span className="prod-hint">{table.type} · {table.rows === null ? '?' : table.rows.toLocaleString()} rows</span>
              </button>
            ))}
          </div>
          {schema && (
            <div id="prod-sql-schema">
              <div className="prod-row prod-meta-row"><Chip>{schema.table}</Chip></div>
              <pre className="prod-result prod-mono">{schema.sql}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- reports tab */

const BLOCK_TYPES: { id: OrvexProductivityBlock['type']; label: string }[] = [
  { id: 'heading', label: 'Heading' },
  { id: 'text', label: 'Paragraph' },
  { id: 'list', label: 'Bullet list' },
  { id: 'kv', label: 'Key / value' },
  { id: 'table', label: 'Table' },
  { id: 'chart', label: 'Bar chart' },
  { id: 'code', label: 'Code block' },
  { id: 'divider', label: 'Divider' },
]

function defaultBlock(type: OrvexProductivityBlock['type']): OrvexProductivityBlock {
  if (type === 'heading') return { type, text: '', level: 2 }
  if (type === 'text') return { type, text: '' }
  if (type === 'list') return { type, items: [] }
  if (type === 'kv') return { type, items: [] }
  if (type === 'table') return { type, headers: [], rows: [] }
  if (type === 'chart') return { type, kind: 'bar', points: [] }
  if (type === 'code') return { type, text: '' }
  return { type: 'divider' }
}

function BlockFields({ block, update }: { block: OrvexProductivityBlock; update: (next: OrvexProductivityBlock) => void }) {
  if (block.type === 'heading') {
    return (
      <>
        <input className="text-input prod-grow" value={block.text} onChange={(event) => update({ ...block, text: event.target.value })} placeholder="Heading text" />
        <select className="select" value={block.level ?? 2} onChange={(event) => update({ ...block, level: Number(event.target.value) })}>
          <option value={2}>Level 2</option>
          <option value={3}>Level 3</option>
          <option value={4}>Level 4</option>
        </select>
      </>
    )
  }
  if (block.type === 'text' || block.type === 'code') {
    return (
      <textarea
        className="text-input prod-textarea prod-mono"
        rows={block.type === 'code' ? 5 : 3}
        value={block.text}
        onChange={(event) => update({ ...block, text: event.target.value })}
        placeholder={block.type === 'code' ? 'Code…' : 'Paragraph text…'}
        spellCheck={false}
      />
    )
  }
  if (block.type === 'divider') {
    return <p className="prod-hint">A horizontal rule.</p>
  }
  if (block.type === 'list') {
    return (
      <textarea
        className="text-input prod-textarea"
        rows={4}
        value={block.items.join('\n')}
        onChange={(event) => update({ ...block, items: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) })}
        placeholder={'One item per line'}
      />
    )
  }
  if (block.type === 'kv') {
    return (
      <textarea
        className="text-input prod-textarea"
        rows={4}
        value={block.items.map((item) => `${item.label}=${item.value}`).join('\n')}
        onChange={(event) =>
          update({
            ...block,
            items: event.target.value
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
              .map((line) => {
                const at = line.indexOf('=')
                return at < 0 ? { label: line, value: '' } : { label: line.slice(0, at).trim(), value: line.slice(at + 1).trim() }
              }),
          })
        }
        placeholder={'Owner=Ops\nStatus=Open'}
      />
    )
  }
  if (block.type === 'table') {
    return (
      <>
        <input
          className="text-input"
          value={block.headers.join(', ')}
          onChange={(event) => update({ ...block, headers: event.target.value.split(',').map((h) => h.trim()) })}
          placeholder="Headers, comma separated"
        />
        <textarea
          className="text-input prod-textarea prod-mono"
          rows={4}
          value={block.rows.map((row) => row.join(', ')).join('\n')}
          onChange={(event) =>
            update({
              ...block,
              rows: event.target.value
                .split('\n')
                .filter((line) => line.trim().length > 0)
                .map((line) => line.split(',').map((cell) => cell.trim())),
            })
          }
          placeholder={'A, 1\nB, 2'}
          spellCheck={false}
        />
      </>
    )
  }
  if (block.type === 'chart') {
    return (
      <>
        <select className="select" value={block.kind || 'bar'} onChange={(event) => update({ ...block, kind: event.target.value })}>
          <option value="bar">Bar</option>
          <option value="line">Line</option>
          <option value="pie">Pie</option>
        </select>
        <textarea
          className="text-input prod-textarea prod-mono"
          rows={4}
          value={block.points.map((point) => `${point.label}, ${point.value}`).join('\n')}
          onChange={(event) =>
            update({
              ...block,
              points: event.target.value
                .split('\n')
                .filter((line) => line.trim().length > 0)
                .map((line) => {
                  const at = line.lastIndexOf(',')
                  const label = at < 0 ? line.trim() : line.slice(0, at).trim()
                  const value = at < 0 ? 0 : Number(line.slice(at + 1).trim())
                  return { label, value: Number.isFinite(value) ? value : 0 }
                }),
            })
          }
          placeholder={'Q1, 120\nQ2, 180'}
          spellCheck={false}
        />
      </>
    )
  }
  return null
}

function ArtifactsCard({ bridge, notify }: { bridge: Bridge; notify: Notify }) {
  const [items, setItems] = useState<{ name: string; path: string; kind: string; bytes: number; mtime: number }[]>([])
  const [dirs, setDirs] = useState<Record<string, string>>({})
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async () => {
    const res = await bridge.productivity.artifacts({ limit: 60 })
    if (!alive.current) return
    if (res.ok) {
      setItems(res.data.artifacts)
      setDirs(res.data.dirs)
      setTotal(res.data.total)
      setError(null)
    } else {
      setError(res.error)
    }
  }, [bridge])

  useEffect(() => {
    void load()
  }, [load])

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path)
      notify('Path copied to clipboard')
    } catch {
      notify('Clipboard is not available — select the path manually.')
    }
  }

  return (
    <div className="settings-block">
      <div className="settings-block-head">
        <h4 className="settings-h"><FileText size={14} /> Generated artifacts</h4>
        <button className="btn-ghost" onClick={() => void load()}><RefreshCw size={12} /> Refresh</button>
      </div>
      <p className="settings-note">
        Every report, deck, workbook, text file and meeting summary ORVEX has written. {total > items.length ? `Showing ${items.length} of ${total}.` : `${total} file${total === 1 ? '' : 's'}.`}
      </p>
      <ErrorLine text={error} />
      <div id="prod-artifacts" className="prod-artifacts">
        {items.length === 0 && <p className="prod-hint">Nothing generated yet. Build a report, deck or workbook above.</p>}
        {items.map((item) => (
          <div key={item.path} className="prod-artifact">
            <Chip>{item.kind}</Chip>
            <span className="prod-artifact-name prod-ellipsis" title={item.path}>{item.name}</span>
            <span className="prod-hint">{bytes(item.bytes)} · {when(item.mtime)}</span>
            <button className="prod-icon-btn" title="Copy full path" onClick={() => void copyPath(item.path)}><Copy size={12} /></button>
          </div>
        ))}
      </div>
      {dirs.root && <p className="prod-hint prod-mono prod-ellipsis" title={dirs.root}>Workspace: {dirs.root}</p>}
    </div>
  )
}

function ReportsPanel({ bridge, notify }: { bridge: Bridge; notify: Notify }) {
  const [title, setTitle] = useState('')
  const [format, setFormat] = useState<'md' | 'html' | 'docx'>('md')
  const [blocks, setBlocks] = useState<OrvexProductivityBlock[]>([])
  const [typeToAdd, setTypeToAdd] = useState<OrvexProductivityBlock['type']>('heading')
  const [report, setReport] = useState<OrvexProductivityReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const update = (index: number, next: OrvexProductivityBlock) => setBlocks((current) => current.map((block, i) => (i === index ? next : block)))
  const move = (index: number, delta: number) =>
    setBlocks((current) => {
      const target = index + delta
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })

  const build = async () => {
    if (!title.trim()) {
      setError('Give the report a title.')
      return
    }
    if (!blocks.length) {
      setError('Add at least one block.')
      return
    }
    setBusy(true)
    setError(null)
    const res = await bridge.productivity.reportBuild({ title, format, blocks })
    if (!alive.current) return
    setBusy(false)
    if (res.ok) {
      setReport(res.data)
      notify(`Report written to ${res.data.path}`)
    } else {
      setReport(null)
      setError(res.error)
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-block">
        <div className="settings-block-head"><h4 className="settings-h"><NotebookPen size={14} /> Report builder</h4></div>
        <p className="settings-note">
          Compose a report from structured blocks and write real Markdown, standalone HTML (with CSS bar charts) or a DOCX document.
          Files are saved under the ORVEX reports folder and automatically added to memory as artifacts.
        </p>
        <div className="prod-row">
          <input id="prod-report-title" className="text-input prod-grow" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Report title" />
          <select className="select" id="prod-report-format" value={format} onChange={(event) => setFormat(event.target.value as typeof format)}>
            <option value="md">Markdown</option>
            <option value="html">HTML</option>
            <option value="docx">DOCX</option>
          </select>
          <button className="btn-primary" id="prod-report-build" onClick={() => void build()} disabled={busy}>
            <Save size={12} /> {busy ? 'Writing…' : 'Build report'}
          </button>
        </div>
        <ErrorLine text={error} />
        {report && (
          <div id="prod-report-result" className="prod-result-block">
            <div className="prod-row prod-meta-row">
              <Chip tone="ok">{report.format}</Chip>
              <span className="prod-hint">{report.blocks} blocks · {bytes(report.bytes)}</span>
              <span className="prod-mono prod-hint prod-ellipsis" title={report.path}>{report.path}</span>
            </div>
            <pre className="prod-result prod-preview">{report.preview}</pre>
          </div>
        )}
      </div>

      <div className="settings-block">
        <div className="settings-block-head">
          <h4 className="settings-h"><SquarePen size={14} /> Blocks</h4>
          <div className="prod-row">
            <select className="select" id="prod-report-block-type" value={typeToAdd} onChange={(event) => setTypeToAdd(event.target.value as OrvexProductivityBlock['type'])}>
              {BLOCK_TYPES.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}
            </select>
            <button className="btn-ghost" id="prod-report-add-block" onClick={() => setBlocks((current) => [...current, defaultBlock(typeToAdd)])}>
              <Plus size={12} /> Add block
            </button>
          </div>
        </div>
        <div id="prod-report-blocks" className="prod-blocks">
          {blocks.length === 0 && <p className="prod-hint">No blocks yet. Add a heading or paragraph to begin.</p>}
          {blocks.map((block, index) => (
            <div key={index} className="prod-block">
              <div className="prod-block-head">
                <Chip>{block.type}</Chip>
                <span className="prod-hint">Block {index + 1}</span>
                <div className="prod-row prod-block-actions">
                  <button className="prod-icon-btn" title="Move up" onClick={() => move(index, -1)} disabled={index === 0}><ArrowUp size={12} /></button>
                  <button className="prod-icon-btn" title="Move down" onClick={() => move(index, 1)} disabled={index === blocks.length - 1}><ArrowDown size={12} /></button>
                  <button className="prod-icon-btn" title="Remove block" onClick={() => setBlocks((current) => current.filter((_item, i) => i !== index))}><Trash2 size={12} /></button>
                </div>
              </div>
              <BlockFields block={block} update={(next) => update(index, next)} />
            </div>
          ))}
        </div>
      </div>

      <ArtifactsCard bridge={bridge} notify={notify} />
    </div>
  )
}

/* ------------------------------------------------------------- meetings tab */

function MeetingsPanel({ bridge, caps }: { bridge: Bridge; caps: OrvexProductivityCapabilities | null }) {
  const [source, setSource] = useState<'transcript' | 'audio'>('transcript')
  const [title, setTitle] = useState('')
  const [transcript, setTranscript] = useState('')
  const [audioPath, setAudioPath] = useState('')
  const [language, setLanguage] = useState('')
  const [asrUrl, setAsrUrl] = useState('')
  const [asrKey, setAsrKey] = useState('')
  const [asrModel, setAsrModel] = useState('')
  const [meeting, setMeeting] = useState<OrvexProductivityMeeting | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const summarize = async () => {
    setBusy(true)
    setError(null)
    const asr = source === 'audio' ? { url: asrUrl.trim() || undefined, key: asrKey.trim() || undefined, model: asrModel.trim() || undefined } : undefined
    const res = await bridge.productivity.meetingSummarize({
      title: title.trim() || undefined,
      transcript: source === 'transcript' ? transcript : undefined,
      audioPath: source === 'audio' ? audioPath.trim() : undefined,
      language: language.trim() || undefined,
      asr,
    })
    if (!alive.current) return
    setBusy(false)
    if (res.ok) {
      setMeeting(res.data)
      setTranscript(res.data.transcript)
    } else {
      setMeeting(null)
      setError(res.error)
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-block">
        <div className="settings-block-head">
          <h4 className="settings-h"><ClipboardList size={14} /> Meeting summarizer</h4>
          <div className="prod-row">
            <Chip tone={caps?.model ? 'ok' : 'bad'}>{caps?.model ? 'model configured' : 'no model'}</Chip>
            <Chip tone={caps?.stt ? 'ok' : 'bad'}>{caps?.stt ? 'ASR available' : 'ASR unavailable'}</Chip>
          </div>
        </div>
        <p className="settings-note">
          Paste a transcript or point at an audio file. Audio is transcribed through the configured speech endpoint, then the transcript is summarized by your
          configured model into decisions, action items and topics. The summary is written to disk and stored in memory. A speaker-diarized, minutes-perfect
          transcript is not guaranteed — the model output is what it is.
        </p>
        <div className="prod-row">
          <label className="field-label" htmlFor="prod-meet-source">Source</label>
          <select id="prod-meet-source" className="select" value={source} onChange={(event) => setSource(event.target.value as typeof source)}>
            <option value="transcript">Transcript text</option>
            <option value="audio">Audio file</option>
          </select>
          <input id="prod-meet-title" className="text-input prod-grow" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Meeting title (optional)" />
          <input id="prod-meet-lang" className="text-input prod-num-wide" value={language} onChange={(event) => setLanguage(event.target.value)} placeholder="Language (optional)" />
        </div>
        {source === 'transcript' ? (
          <textarea
            id="prod-meet-transcript"
            className="text-input prod-textarea"
            rows={10}
            value={transcript}
            onChange={(event) => setTranscript(event.target.value)}
            placeholder="Paste the meeting transcript here…"
          />
        ) : (
          <>
            <div className="prod-row">
              <input id="prod-meet-audio" className="text-input prod-grow prod-mono" value={audioPath} onChange={(event) => setAudioPath(event.target.value)} placeholder="C:\\recordings\\meeting.mp3" spellCheck={false} />
            </div>
            <div className="prod-row">
              <input id="prod-meet-asr-url" className="text-input prod-grow prod-mono" value={asrUrl} onChange={(event) => setAsrUrl(event.target.value)} placeholder="ASR endpoint (optional — uses Media settings)" spellCheck={false} />
              <input id="prod-meet-asr-model" className="text-input prod-num-wide" value={asrModel} onChange={(event) => setAsrModel(event.target.value)} placeholder="ASR model" />
              <input id="prod-meet-asr-key" type="password" className="text-input prod-num-wide" value={asrKey} onChange={(event) => setAsrKey(event.target.value)} placeholder="ASR key (session only)" autoComplete="off" />
            </div>
          </>
        )}
        <div className="prod-row">
          <button className="btn-primary" id="prod-meet-run" onClick={() => void summarize()} disabled={busy}>
            <Wand2 size={12} /> {busy ? 'Summarizing…' : 'Summarize meeting'}
          </button>
          <span className="prod-hint">{transcript.length.toLocaleString()} characters</span>
        </div>
        <ErrorLine text={error} />
        {meeting && (
          <div id="prod-meet-result" className="prod-meeting">
            <div className="prod-row prod-meta-row">
              <Chip tone="ok">{meeting.transcriptChars.toLocaleString()} chars</Chip>
              {meeting.language && <Chip>{meeting.language}</Chip>}
              {meeting.duration ? <Chip>{Math.round(meeting.duration)}s audio</Chip> : null}
              {meeting.model && <span className="prod-hint">{meeting.model}</span>}
              {meeting.remembered && <Chip tone="ok">stored in memory</Chip>}
            </div>
            <h5 className="prod-meeting-title">{meeting.title}</h5>
            <p className="prod-meeting-summary">{meeting.summary}</p>
            {meeting.decisions.length > 0 && (
              <>
                <h6 className="prod-h">Decisions</h6>
                <ul className="prod-ul">{meeting.decisions.map((item, i) => <li key={i}>{item}</li>)}</ul>
              </>
            )}
            {meeting.actionItems.length > 0 && (
              <>
                <h6 className="prod-h">Action items</h6>
                <table className="prod-table">
                  <thead><tr><th>Task</th><th>Owner</th><th>Due</th></tr></thead>
                  <tbody>
                    {meeting.actionItems.map((item, i) => <tr key={i}><td>{item.task}</td><td>{item.owner || '—'}</td><td>{item.due || '—'}</td></tr>)}
                  </tbody>
                </table>
              </>
            )}
            {meeting.topics.length > 0 && (
              <>
                <h6 className="prod-h">Topics</h6>
                <div className="prod-row">{meeting.topics.map((topic, i) => <Chip key={i}>{topic}</Chip>)}</div>
              </>
            )}
            {meeting.warnings.length > 0 && (
              <div className="prod-warnings">
                {meeting.warnings.map((warning, i) => <p key={i} className="prod-error">⚠ {warning}</p>)}
              </div>
            )}
            <p className="prod-hint prod-ellipsis" title={meeting.reportPath}>Summary file: {meeting.reportPath}</p>
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- notes tab */

function NotesPanel({ bridge, caps }: { bridge: Bridge; caps: OrvexProductivityCapabilities | null }) {
  const [query, setQuery] = useState('')
  const [notes, setNotes] = useState<OrvexProductivityNote[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [form, setForm] = useState({ title: '', body: '', tags: '', project: '' })
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<OrvexMemoryRagResult | null>(null)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(
    async (searchText?: string) => {
      const res = await bridge.productivity.noteList({ query: (searchText ?? query).trim() || undefined, limit: 200 })
      if (!alive.current) return
      if (res.ok) {
        setNotes(res.data.notes)
        setTotal(res.data.total)
        setError(null)
      } else {
        setError(res.error)
      }
    },
    [bridge, query],
  )

  useEffect(() => {
    void load('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const select = (note: OrvexProductivityNote) => {
    setSelected(note.id)
    setForm({ title: note.title, body: note.body, tags: note.tags.filter((tag) => tag !== 'note').join(', '), project: note.project })
    setError(null)
  }

  const reset = () => {
    setSelected(null)
    setForm({ title: '', body: '', tags: '', project: '' })
    setError(null)
  }

  const save = async () => {
    if (!form.title.trim()) {
      setError('Give the note a title.')
      return
    }
    if (!form.body.trim()) {
      setError('Write something in the note.')
      return
    }
    setBusy(true)
    setError(null)
    const payload = { title: form.title.trim(), body: form.body, tags: form.tags, project: form.project.trim() || undefined }
    const res = selected
      ? await bridge.productivity.noteUpdate({ id: selected, ...payload })
      : await bridge.productivity.noteCreate(payload)
    if (!alive.current) return
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    const note = res.data.note
    setSelected(note.id)
    setForm({ title: note.title, body: note.body, tags: note.tags.filter((tag) => tag !== 'note').join(', '), project: note.project })
    await load(query)
    if (!selected && 'duplicate' in res.data && res.data.duplicate) setError('That note already existed — the existing copy was returned.')
  }

  const remove = async () => {
    if (!selected) return
    setBusy(true)
    const res = await bridge.productivity.noteDelete(selected)
    if (!alive.current) return
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    reset()
    await load(query)
  }

  const ask = async () => {
    if (!question.trim()) {
      setError('Ask a question first.')
      return
    }
    setAsking(true)
    setError(null)
    const res = await bridge.productivity.noteAsk({ question: question.trim(), limit: 6 })
    if (!alive.current) return
    setAsking(false)
    if (res.ok) setAnswer(res.data)
    else {
      setAnswer(null)
      setError(res.error)
    }
  }

  return (
    <div className="settings-section">
      <div className="prod-grid-2 prod-grid-notes">
        <div className="settings-block">
          <div className="settings-block-head">
            <h4 className="settings-h"><NotebookPen size={14} /> Notes</h4>
            <button className="btn-ghost" id="prod-notes-new" onClick={reset}><Plus size={12} /> New note</button>
          </div>
          <p className="settings-note">
            Notes are stored in the same SQLite knowledge base the agent uses, tagged <code>note</code>, so they are searchable by the agent and by memory RAG.
          </p>
          <form
            className="prod-row"
            onSubmit={(event) => {
              event.preventDefault()
              void load(query)
            }}
          >
            <input id="prod-notes-query" className="text-input prod-grow" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes…" />
            <button className="btn-primary" id="prod-notes-search" type="submit"><Search size={12} /> Search</button>
          </form>
          <ErrorLine text={error} />
          <div className="prod-row prod-meta-row">
            <span className="prod-hint">{total} note{total === 1 ? '' : 's'}</span>
            {query.trim() && <Chip>matching “{query.trim()}”</Chip>}
            {!caps?.memory && <Chip tone="bad">memory store unavailable</Chip>}
          </div>
          <div id="prod-notes-list" className="prod-note-list">
            {notes.length === 0 && <p className="prod-hint">No notes yet. Write the first one on the right.</p>}
            {notes.map((note) => (
              <button key={note.id} className={`prod-note ${selected === note.id ? 'active' : ''}`} onClick={() => select(note)}>
                <span className="prod-strong">{note.title}</span>
                <span className="prod-note-body">{note.body.replace(/\s+/g, ' ').slice(0, 140)}</span>
                <span className="prod-hint">
                  {when(note.updatedAt)}
                  {note.project ? ` · ${note.project}` : ''}
                  {note.tags.filter((tag) => tag !== 'note').length ? ` · ${note.tags.filter((tag) => tag !== 'note').join(', ')}` : ''}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="settings-block">
          <div className="settings-block-head">
            <h4 className="settings-h"><Pencil size={14} /> {selected ? 'Edit note' : 'New note'}</h4>
            <div className="prod-row">
              <button className="btn-primary" id="prod-note-save" onClick={() => void save()} disabled={busy}><Save size={12} /> Save</button>
              <button className="btn-ghost" id="prod-note-delete" onClick={() => void remove()} disabled={busy || !selected}><Trash2 size={12} /> Delete</button>
            </div>
          </div>
          <input id="prod-note-title" className="text-input" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Note title" />
          <textarea id="prod-note-body" className="text-input prod-textarea" rows={12} value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} placeholder="Write the note…" />
          <div className="prod-row">
            <input id="prod-note-tags" className="text-input prod-grow" value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} placeholder="Tags, comma separated" />
            <input id="prod-note-project" className="text-input prod-num-wide" value={form.project} onChange={(event) => setForm({ ...form, project: event.target.value })} placeholder="Project" />
          </div>

          <div className="prod-divider" />
          <h5 className="prod-h"><Sparkles size={13} /> Ask your notes</h5>
          <p className="settings-note">Retrieval-augmented answer grounded in stored notes and memories, with citations. Uses the Memory Q&amp;A routing chain.</p>
          <form
            className="prod-row"
            onSubmit={(event) => {
              event.preventDefault()
              void ask()
            }}
          >
            <input id="prod-notes-ask-q" className="text-input prod-grow" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="What did I decide about the release date?" />
            <button className="btn-primary" id="prod-notes-ask" type="submit" disabled={asking}>{asking ? 'Thinking…' : 'Ask'}</button>
          </form>
          {answer && (
            <div id="prod-notes-answer" className="prod-answer">
              <div className="prod-row prod-meta-row">
                <Chip tone={answer.mode === 'llm' ? 'ok' : undefined}>{answer.mode}</Chip>
                {answer.model && <span className="prod-hint">{answer.model}</span>}
                {answer.warning && <span className="prod-warn-text">{answer.warning}</span>}
              </div>
              <p className="prod-answer-text">{answer.answer}</p>
              {answer.citations.length > 0 && (
                <ul className="prod-ul">
                  {answer.citations.slice(0, 8).map((citation) => <li key={citation.id}>{citation.text.slice(0, 220)}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- tasks tab */

function TasksPanel({ bridge }: { bridge: Bridge }) {
  const [status, setStatus] = useState<'open' | 'done' | 'all'>('open')
  const [tasks, setTasks] = useState<OrvexProductivityTask[]>([])
  const [stats, setStats] = useState<OrvexProductivityTaskStats | null>(null)
  const [form, setForm] = useState({ title: '', notes: '', priority: '2', due: '', project: '' })
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState({ title: '', notes: '', priority: '2', due: '', project: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(
    async (nextStatus?: 'open' | 'done' | 'all') => {
      const [list, statsRes] = await Promise.all([
        bridge.productivity.taskList({ status: nextStatus ?? status, limit: 300 }),
        bridge.productivity.taskStats(),
      ])
      if (!alive.current) return
      if (list.ok) setTasks(list.data.tasks)
      else setError(list.error)
      if (statsRes.ok) setStats(statsRes.data)
    },
    [bridge, status],
  )

  useEffect(() => {
    void load(status)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  const create = async () => {
    if (!form.title.trim()) {
      setError('Give the task a title.')
      return
    }
    setBusy(true)
    setError(null)
    const res = await bridge.productivity.taskCreate({
      title: form.title,
      notes: form.notes,
      priority: Number(form.priority),
      due: form.due || undefined,
      project: form.project.trim() || undefined,
    })
    if (!alive.current) return
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setForm({ title: '', notes: '', priority: '2', due: '', project: '' })
    await load(status)
  }

  const toggle = async (task: OrvexProductivityTask) => {
    const res = await bridge.productivity.taskToggle(task.id)
    if (!alive.current) return
    if (res.ok) await load(status)
    else setError(res.error)
  }

  const remove = async (task: OrvexProductivityTask) => {
    const res = await bridge.productivity.taskRemove(task.id)
    if (!alive.current) return
    if (res.ok) await load(status)
    else setError(res.error)
  }

  const startEdit = (task: OrvexProductivityTask) => {
    setEditing(task.id)
    setDraft({ title: task.title, notes: task.notes, priority: String(task.priority), due: dateValue(task.dueAt), project: task.project })
  }

  const saveEdit = async (task: OrvexProductivityTask) => {
    const dueAt = draft.due ? new Date(`${draft.due}T00:00:00`).getTime() : null
    const res = await bridge.productivity.taskUpdate({
      id: task.id,
      patch: { title: draft.title, notes: draft.notes, priority: Number(draft.priority), dueAt, project: draft.project },
    })
    if (!alive.current) return
    if (res.ok) {
      setEditing(null)
      await load(status)
    } else {
      setError(res.error)
    }
  }

  return (
    <div className="settings-section">
      <div className="prod-tiles" id="prod-task-stats">
        {(
          [
            { label: 'Open', value: stats?.open, hint: 'waiting' },
            { label: 'Done', value: stats?.done, hint: 'completed' },
            { label: 'Overdue', value: stats?.overdue, hint: 'past due date', tone: stats?.overdue ? 'bad' : undefined },
            { label: 'Due soon', value: stats?.dueSoon, hint: 'next 7 days' },
          ] as { label: string; value?: number; hint: string; tone?: 'bad' }[]
        ).map((tile) => (
          <div key={tile.label} className={`prod-tile ${tile.tone ? `prod-tile-${tile.tone}` : ''}`}>
            <span className="prod-tile-label">{tile.label}</span>
            <strong className="prod-tile-value">{typeof tile.value === 'number' ? tile.value : '—'}</strong>
            <span className="prod-tile-hint">{tile.hint}</span>
          </div>
        ))}
      </div>

      <div className="settings-block">
        <div className="settings-block-head">
          <h4 className="settings-h"><ListChecks size={14} /> Task manager</h4>
          <select className="select" id="prod-task-status" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
            <option value="open">Open</option>
            <option value="done">Done</option>
            <option value="all">All</option>
          </select>
        </div>
        <p className="settings-note">Tasks live in the ORVEX SQLite database, survive restarts, and are exposed to the agent as tools.</p>
        <div className="prod-row prod-task-form">
          <input id="prod-task-title" className="text-input prod-grow" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Task title" />
          <select id="prod-task-priority" className="select" value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}>
            <option value="1">High</option>
            <option value="2">Normal</option>
            <option value="3">Low</option>
          </select>
          <input id="prod-task-due" type="date" className="text-input prod-num-wide" value={form.due} onChange={(event) => setForm({ ...form, due: event.target.value })} title="Due date" />
          <input id="prod-task-project" className="text-input prod-num-wide" value={form.project} onChange={(event) => setForm({ ...form, project: event.target.value })} placeholder="Project" />
          <input id="prod-task-notes" className="text-input prod-grow" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Notes (optional)" />
          <button className="btn-primary" id="prod-task-create" onClick={() => void create()} disabled={busy}><Plus size={12} /> Add task</button>
        </div>
        <ErrorLine text={error} />
        <div id="prod-tasks-list" className="prod-task-list">
          {tasks.length === 0 && <p className="prod-hint">No {status === 'all' ? '' : `${status} `}tasks.</p>}
          {tasks.map((task) => (
            <div key={task.id} className={`prod-task ${task.status === 'done' ? 'done' : ''}`}>
              {editing === task.id ? (
                <div className="prod-task-edit">
                  <div className="prod-row">
                    <input className="text-input prod-grow" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
                    <select className="select" value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value })}>
                      <option value="1">High</option><option value="2">Normal</option><option value="3">Low</option>
                    </select>
                    <input type="date" className="text-input prod-num-wide" value={draft.due} onChange={(event) => setDraft({ ...draft, due: event.target.value })} />
                    <input className="text-input prod-num-wide" value={draft.project} onChange={(event) => setDraft({ ...draft, project: event.target.value })} placeholder="Project" />
                  </div>
                  <div className="prod-row">
                    <input className="text-input prod-grow" value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="Notes" />
                    <button className="btn-primary" onClick={() => void saveEdit(task)}><Check size={12} /> Save</button>
                    <button className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <button className="prod-check" onClick={() => void toggle(task)} title={task.status === 'done' ? 'Reopen task' : 'Complete task'}>
                    {task.status === 'done' ? <Check size={12} /> : null}
                  </button>
                  <div className="prod-task-main" onClick={() => startEdit(task)}>
                    <span className="prod-task-title">{task.title}</span>
                    {task.notes && <span className="prod-task-notes">{task.notes}</span>}
                    <span className="prod-hint">
                      {task.project || 'no project'} · priority {task.priority === 1 ? 'high' : task.priority === 3 ? 'low' : 'normal'}
                      {task.dueAt ? ` · due ${dateValue(task.dueAt)}` : ''}
                      {task.completedAt ? ` · done ${when(task.completedAt)}` : ''}
                    </span>
                  </div>
                  <button className="prod-icon-btn" title="Edit task" onClick={() => startEdit(task)}><Pencil size={12} /></button>
                  <button className="prod-icon-btn" title="Delete task" onClick={() => void remove(task)}><Trash2 size={12} /></button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ translate tab */

function TranslatePanel({ bridge }: { bridge: Bridge }) {
  const [text, setText] = useState('')
  const [source, setSource] = useState('auto')
  const [target, setTarget] = useState('Urdu')
  const [result, setResult] = useState<OrvexProductivityTranslation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const run = async () => {
    if (!text.trim()) {
      setError('Type something to translate.')
      return
    }
    setBusy(true)
    setError(null)
    const res = await bridge.productivity.translate({ text, source, target })
    if (!alive.current) return
    setBusy(false)
    if (res.ok) setResult(res.data)
    else {
      setResult(null)
      setError(res.error)
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-block">
        <div className="settings-block-head"><h4 className="settings-h"><Languages size={14} /> Translation</h4></div>
        <p className="settings-note">Provider-backed translation with formatting preserved. Requires a configured model provider; nothing is translated locally.</p>
        <div className="prod-row">
          <select className="select" id="prod-translate-source" value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="auto">Auto-detect</option>
            {LANGUAGES.map((language) => <option key={language} value={language}>{language}</option>)}
          </select>
          <span className="prod-hint">→</span>
          <select className="select" id="prod-translate-target" value={target} onChange={(event) => setTarget(event.target.value)}>
            {LANGUAGES.map((language) => <option key={language} value={language}>{language}</option>)}
          </select>
          <span className="prod-hint prod-grow">{text.length.toLocaleString()} / 20,000 characters</span>
          <button className="btn-primary" id="prod-translate-run" onClick={() => void run()} disabled={busy}>
            <Languages size={12} /> {busy ? 'Translating…' : 'Translate'}
          </button>
        </div>
        <div className="prod-grid-2">
          <textarea id="prod-translate-text" className="text-input prod-textarea" rows={12} value={text} onChange={(event) => setText(event.target.value)} placeholder="Text to translate…" />
          <div>
            <ErrorLine text={error} />
            {result ? (
              <div id="prod-translate-result">
                <textarea className="text-input prod-textarea" rows={12} readOnly value={result.text} />
                <p className="prod-hint">{result.source} → {result.target} · {result.ms} ms{result.model ? ` · ${result.model}` : ''}</p>
              </div>
            ) : (
              <div className="prod-placeholder">The translation appears here.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- text editor */

function TextPanel({ bridge }: { bridge: Bridge }) {
  const [files, setFiles] = useState<OrvexProductivityTextFile[]>([])
  const [dir, setDir] = useState('')
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [newName, setNewName] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async () => {
    const res = await bridge.productivity.textList()
    if (!alive.current) return
    if (res.ok) {
      setFiles(res.data.files)
      setDir(res.data.dir)
    } else {
      setError(res.error)
    }
  }, [bridge])

  useEffect(() => {
    void load()
  }, [load])

  const open = async (fileName: string) => {
    setError(null)
    setStatus(null)
    const res = await bridge.productivity.textOpen(fileName)
    if (!alive.current) return
    if (res.ok) {
      setName(res.data.name)
      setText(res.data.text ?? '')
      setNewName('')
    } else {
      setError(res.error)
    }
  }

  const save = async () => {
    if (!name.trim()) {
      setError('Give the file a name.')
      return
    }
    setBusy(true)
    setError(null)
    const res = await bridge.productivity.textSave({ name: name.trim(), text })
    if (!alive.current) return
    setBusy(false)
    if (res.ok) {
      setStatus(`Saved ${res.data.name} · ${bytes(res.data.bytes)} · ${when(res.data.mtime)}`)
      await load()
    } else {
      setError(res.error)
    }
  }

  const remove = async () => {
    if (!name.trim()) return
    const res = await bridge.productivity.textRemove(name.trim())
    if (!alive.current) return
    if (res.ok) {
      setStatus(`Removed ${res.data.removed}`)
      setName('')
      setText('')
      await load()
    } else {
      setError(res.error)
    }
  }

  const rename = async () => {
    if (!name.trim() || !newName.trim()) {
      setError('Enter the current file and a new name.')
      return
    }
    const res = await bridge.productivity.textRename(name.trim(), newName.trim())
    if (!alive.current) return
    if (res.ok) {
      setStatus(`Renamed ${res.data.from} → ${res.data.to}`)
      setName(res.data.to)
      setNewName('')
      await load()
    } else {
      setError(res.error)
    }
  }

  return (
    <div className="settings-section">
      <div className="prod-grid-2 prod-grid-text">
        <div className="settings-block">
          <div className="settings-block-head">
            <h4 className="settings-h"><FileText size={14} /> Text workspace</h4>
            <button className="btn-ghost" onClick={() => { setName(''); setText(''); setNewName(''); setStatus(null); setError(null) }}><Plus size={12} /> New file</button>
          </div>
          <p className="settings-note prod-ellipsis" title={dir}>Plain-text files under <code>{dir || 'productivity/texts'}</code>. Names are sandboxed to that folder; the 2 MB limit keeps the editor responsive.</p>
          <div id="prod-text-list" className="prod-note-list">
            {files.length === 0 && <p className="prod-hint">No files yet.</p>}
            {files.map((file) => (
              <button key={file.name} className={`prod-note ${name === file.name ? 'active' : ''}`} onClick={() => void open(file.name)}>
                <span className="prod-strong prod-ellipsis">{file.name}</span>
                <span className="prod-hint">{bytes(file.bytes)} · {when(file.mtime)}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="settings-block">
          <div className="settings-block-head">
            <h4 className="settings-h"><Pencil size={14} /> Editor</h4>
            <span className="prod-hint">{new TextEncoder().encode(text).length.toLocaleString()} bytes</span>
          </div>
          <div className="prod-row">
            <input id="prod-text-name" className="text-input prod-grow" value={name} onChange={(event) => setName(event.target.value)} placeholder="notes.txt" />
            <button className="btn-primary" id="prod-text-save" onClick={() => void save()} disabled={busy}><Save size={12} /> Save</button>
          </div>
          <textarea id="prod-text-body" className="text-input prod-textarea prod-mono" rows={15} value={text} onChange={(event) => setText(event.target.value)} placeholder="Write plain text…" spellCheck={false} />
          <div className="prod-row">
            <input className="text-input prod-grow" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="New name for rename" />
            <button className="btn-ghost" id="prod-text-rename" onClick={() => void rename()}>Rename</button>
            <button className="btn-ghost" id="prod-text-delete" onClick={() => void remove()}><Trash2 size={12} /> Delete</button>
          </div>
          {status && <p className="prod-success" id="prod-text-status">{status}</p>}
          <ErrorLine text={error} />
        </div>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- slides */

type SlideDraft = { title: string; bullets: string; notes: string }

function SlidesPanel({ bridge }: { bridge: Bridge }) {
  const [title, setTitle] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [slides, setSlides] = useState<SlideDraft[]>([])
  const [built, setBuilt] = useState<OrvexProductivitySlides | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const update = (index: number, patch: Partial<SlideDraft>) => setSlides((current) => current.map((slide, i) => (i === index ? { ...slide, ...patch } : slide)))
  const move = (index: number, delta: number) =>
    setSlides((current) => {
      const target = index + delta
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })

  const build = async () => {
    if (!title.trim()) {
      setError('Give the presentation a title.')
      return
    }
    if (!slides.length) {
      setError('Add at least one content slide.')
      return
    }
    setBusy(true)
    setError(null)
    const res = await bridge.productivity.slidesBuild({
      title,
      subtitle: subtitle.trim() || undefined,
      theme,
      slides: slides.map((slide) => ({
        title: slide.title,
        bullets: slide.bullets.split('\n').map((line) => line.trim()).filter(Boolean),
        notes: slide.notes.trim() || undefined,
      })),
    })
    if (!alive.current) return
    setBusy(false)
    if (res.ok) setBuilt(res.data)
    else {
      setBuilt(null)
      setError(res.error)
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-block">
        <div className="settings-block-head"><h4 className="settings-h"><Presentation size={14} /> Presentation generator</h4></div>
        <p className="settings-note">
          Builds a real 16:9 PPTX with a cover slide, one slide per entry and speaker notes, written with pptxgenjs into the ORVEX slides folder.
        </p>
        <div className="prod-row">
          <input id="prod-slides-title" className="text-input prod-grow" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Deck title" />
          <input id="prod-slides-subtitle" className="text-input prod-grow" value={subtitle} onChange={(event) => setSubtitle(event.target.value)} placeholder="Subtitle (optional)" />
          <select className="select" id="prod-slides-theme" value={theme} onChange={(event) => setTheme(event.target.value as typeof theme)}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
          <button className="btn-ghost" id="prod-slides-add" onClick={() => setSlides((current) => [...current, { title: '', bullets: '', notes: '' }])}>
            <Plus size={12} /> Slide
          </button>
          <button className="btn-primary" id="prod-slides-build" onClick={() => void build()} disabled={busy}>
            <Presentation size={12} /> {busy ? 'Building…' : 'Build PPTX'}
          </button>
        </div>
        <ErrorLine text={error} />
        {built && (
          <div id="prod-slides-result" className="prod-result-block">
            <div className="prod-row prod-meta-row">
              <Chip tone="ok">{built.slides} slides</Chip>
              <Chip>{built.theme}</Chip>
              <span className="prod-hint">{bytes(built.bytes)}</span>
              <span className="prod-mono prod-hint prod-ellipsis" title={built.path}>{built.path}</span>
            </div>
          </div>
        )}
        <div id="prod-slides-editor" className="prod-blocks">
          {slides.length === 0 && <p className="prod-hint">No content slides yet. Add one, then fill in the title and bullets.</p>}
          {slides.map((slide, index) => (
            <div key={index} className="prod-block">
              <div className="prod-block-head">
                <Chip>slide {index + 1}</Chip>
                <div className="prod-row prod-block-actions">
                  <button className="prod-icon-btn" title="Move up" onClick={() => move(index, -1)} disabled={index === 0}><ArrowUp size={12} /></button>
                  <button className="prod-icon-btn" title="Move down" onClick={() => move(index, 1)} disabled={index === slides.length - 1}><ArrowDown size={12} /></button>
                  <button className="prod-icon-btn" title="Remove slide" onClick={() => setSlides((current) => current.filter((_slide, i) => i !== index))}><Trash2 size={12} /></button>
                </div>
              </div>
              <input className="text-input" value={slide.title} onChange={(event) => update(index, { title: event.target.value })} placeholder="Slide title" />
              <textarea className="text-input prod-textarea" rows={4} value={slide.bullets} onChange={(event) => update(index, { bullets: event.target.value })} placeholder={'One bullet per line'} />
              <input className="text-input" value={slide.notes} onChange={(event) => update(index, { notes: event.target.value })} placeholder="Speaker notes (optional)" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- compare */

function ComparePanel({ bridge }: { bridge: Bridge }) {
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [result, setResult] = useState<OrvexProductivityCompare | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const run = async () => {
    if (!a.trim() || !b.trim()) {
      setError('Enter both document paths.')
      return
    }
    setBusy(true)
    setError(null)
    const res = await bridge.productivity.compareDocs({ a: a.trim(), b: b.trim() })
    if (!alive.current) return
    setBusy(false)
    if (res.ok) setResult(res.data)
    else {
      setResult(null)
      setError(res.error)
    }
  }

  const shown = result ? result.lines.slice(0, 1200) : []

  return (
    <div className="settings-section">
      <div className="settings-block">
        <div className="settings-block-head"><h4 className="settings-h"><FileDiff size={14} /> Document comparison</h4></div>
        <p className="settings-note">
          Line diff between two text-like documents: plain text, Markdown, JSON, logs, CSV/XLSX (every sheet is rendered to CSV), HTML, DOCX and PDF.
          Documents are read-only and capped at 200,000 characters each.
        </p>
        <div className="prod-row">
          <input id="prod-compare-a" className="text-input prod-grow prod-mono" value={a} onChange={(event) => setA(event.target.value)} placeholder="First document path" spellCheck={false} />
          <input id="prod-compare-b" className="text-input prod-grow prod-mono" value={b} onChange={(event) => setB(event.target.value)} placeholder="Second document path" spellCheck={false} />
          <button className="btn-primary" id="prod-compare-run" onClick={() => void run()} disabled={busy}>
            <FileDiff size={12} /> {busy ? 'Comparing…' : 'Compare'}
          </button>
        </div>
        <ErrorLine text={error} />
        {result && (
          <div id="prod-compare-result">
            <div className="prod-row prod-meta-row">
              <Chip tone={result.changed ? 'bad' : 'ok'}>{result.changed ? 'different' : 'identical'}</Chip>
              <Chip>+{result.added}</Chip>
              <Chip>−{result.removed}</Chip>
              <Chip>{result.same} unchanged</Chip>
              <span className="prod-hint prod-mono prod-ellipsis" title={result.a.path}>{result.a.name}</span>
              <span className="prod-hint">vs</span>
              <span className="prod-hint prod-mono prod-ellipsis" title={result.b.path}>{result.b.name}</span>
            </div>
            {(result.a.truncated || result.b.truncated) && <p className="prod-hint">One or both documents exceeded the compare cap and were truncated.</p>}
            {!result.changed ? (
              <p className="prod-success">The documents are line-for-line identical.</p>
            ) : (
              <pre className="prod-diff">
                {shown.map((line, i) => (
                  <span key={i} className={`prod-diff-line ${line.type}`}>{line.type === 'add' ? '+ ' : line.type === 'remove' ? '- ' : '  '}{line.text}</span>
                ))}
                {result.lines.length > shown.length && <span className="prod-diff-line same">… {result.lines.length - shown.length} more lines hidden in the view (full diff is in the export).</span>}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- page */

export default function ProductivityPage({ onBack, notify, initialTab }: Props) {
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const [tab, setTab] = useState<Tab>(() => (TABS.some((item) => item.id === initialTab) ? (initialTab as Tab) : 'calc'))
  const [caps, setCaps] = useState<OrvexProductivityCapabilities | null>(null)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (initialTab && TABS.some((item) => item.id === initialTab)) setTab(initialTab as Tab)
  }, [initialTab])

  const loadCaps = useCallback(async () => {
    if (!bridge) {
      setError('The desktop bridge is unavailable — productivity needs the ORVEX app.')
      return
    }
    const res = await bridge.productivity.capabilities()
    if (!alive.current) return
    if (res.ok) {
      setCaps(res.data)
      setError(null)
    } else {
      setError(res.error)
    }
  }, [bridge])

  useEffect(() => {
    void loadCaps()
  }, [loadCaps])

  return (
    <PageShell
      title="Productivity"
      sub="Calculator, Python, data analysis, spreadsheets, SQL, reports, meetings, notes, tasks, translation, text, slides and document comparison"
      onBack={onBack}
      actions={
        <button className="ghost-btn" onClick={() => void loadCaps()} title="Refresh capability status">
          <RefreshCw size={12} /> Refresh
        </button>
      }
    >
      <div className="prod" data-page="productivity">
        <div className="settings-tabs prod-tabs" role="tablist" aria-label="Productivity sections" onKeyDown={onTablistKeyDown}>
          {TABS.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              tabIndex={tab === item.id ? 0 : -1}
              className={`settings-tab ${tab === item.id ? 'active' : ''}`}
              data-testid={`prod-tab-${item.id}`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {error && <div className="sec-notice prod-notice" id="prod-error">{error}</div>}

        {caps && (
          <div className="prod-caps" id="prod-caps">
            <Chip tone={caps.python.available ? 'ok' : 'bad'}>{caps.python.available ? `Python · ${caps.python.version || 'ready'}` : 'Python missing'}</Chip>
            <Chip tone={caps.model ? 'ok' : 'bad'}>{caps.model ? 'Model configured' : 'No model'}</Chip>
            <Chip tone={caps.memory ? 'ok' : 'bad'}>{caps.memory ? 'Memory ready' : 'Memory unavailable'}</Chip>
            <Chip tone={caps.stt ? 'ok' : 'bad'}>{caps.stt ? 'ASR ready' : 'ASR unavailable'}</Chip>
            <Chip tone={caps.xlsx ? 'ok' : 'bad'}>XLSX</Chip>
            <Chip tone={caps.docx ? 'ok' : 'bad'}>DOCX</Chip>
            <Chip tone={caps.pptx ? 'ok' : 'bad'}>PPTX</Chip>
            <Chip tone={caps.sqlite ? 'ok' : 'bad'}>SQLite</Chip>
            <span className="prod-hint prod-mono prod-ellipsis" title={caps.dirs.root}>{caps.dirs.root}</span>
          </div>
        )}

        {bridge && tab === 'calc' && <CalcPanel bridge={bridge} caps={caps} />}
        {bridge && tab === 'data' && <DataPanel bridge={bridge} />}
        {bridge && tab === 'sheet' && <SheetPanel bridge={bridge} />}
        {bridge && tab === 'sql' && <SqlPanel bridge={bridge} />}
        {bridge && tab === 'reports' && <ReportsPanel bridge={bridge} notify={notify} />}
        {bridge && tab === 'meetings' && <MeetingsPanel bridge={bridge} caps={caps} />}
        {bridge && tab === 'notes' && <NotesPanel bridge={bridge} caps={caps} />}
        {bridge && tab === 'tasks' && <TasksPanel bridge={bridge} />}
        {bridge && tab === 'translate' && <TranslatePanel bridge={bridge} />}
        {bridge && tab === 'text' && <TextPanel bridge={bridge} />}
        {bridge && tab === 'slides' && <SlidesPanel bridge={bridge} />}
        {bridge && tab === 'compare' && <ComparePanel bridge={bridge} />}
      </div>
    </PageShell>
  )
}
