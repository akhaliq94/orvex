import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import {
  AlertTriangle,
  BookOpen,
  Check,
  Copy,
  Download,
  ExternalLink,
  FileSearch,
  FileText,
  Globe2,
  Loader2,
  Plus,
  Search,
  Square,
  Trash2,
  Upload,
} from 'lucide-react'
import PageShell from './PageShell'
import { useProviders } from '../hooks/useProviders'
import { buildCandidates, orderForTask } from '../data/routing'
import type {
  OrvexResearchDocument,
  OrvexResearchEvent,
  OrvexResearchPlan,
  OrvexResearchReport,
  OrvexResearchSource,
  OrvexResearchSummary,
} from '../types/desktop'

type Props = { onBack: () => void; notify: (msg: string) => void }

type Depth = 'quick' | 'standard' | 'deep'
type Mode = 'new' | 'report' | 'reader'

type LiveRun = {
  runId: string
  entry: OrvexResearchSummary
  plan: OrvexResearchPlan | null
  sources: OrvexResearchSource[]
  searches: { query: string; count: number; error?: string; followup?: boolean }[]
  text: string
  phase: string
  error: string | null
}

type ReaderState = {
  mode: 'url' | 'file'
  url: string
  loading: boolean
  doc: OrvexResearchDocument | null
  sourceUrl: string
  error: string | null
}

const bridge = typeof window !== 'undefined' ? window.orvex : undefined
const researchApi = bridge?.research
const DEPTH_LABEL: Record<Depth, string> = { quick: 'Quick', standard: 'Standard', deep: 'Deep' }
const DEPTH_DEFAULT_SOURCES: Record<Depth, number> = { quick: 4, standard: 8, deep: 14 }
const PHASES = [
  { id: 'plan', label: 'Plan' },
  { id: 'search', label: 'Search' },
  { id: 'reading', label: 'Read sources' },
  { id: 'writing', label: 'Write report' },
]
const PHASE_ORDER = ['plan', 'search', 'followup', 'reading', 'writing', 'done']

function formatDate(ts: number | null) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function formatChars(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k chars`
  return `${n} chars`
}

function linkifyCitations(markdown: string, sources: OrvexResearchSource[]) {
  const known = new Set(sources.map((s) => s.n))
  return markdown.replace(/(^|[^\w\]])\[(\d{1,2})\](?!\()/g, (match, lead: string, num: string) => {
    const n = Number(num)
    return known.has(n) ? `${lead}[${num}](#research-src-${n})` : match
  })
}

function MarkdownView({
  markdown,
  sources = [],
  className = '',
}: {
  markdown: string
  sources?: OrvexResearchSource[]
  className?: string
}) {
  const body = sources.length ? linkifyCitations(markdown, sources) : markdown
  const components: Components = {
    a: ({ href, children }) => (
      <a
        href={href}
        onClick={(event) => {
          if (!href) return
          if (href.startsWith('http')) {
            event.preventDefault()
            void researchApi?.openExternal(href)
          } else if (href.startsWith('#research-src-')) {
            event.preventDefault()
            document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        }}
      >
        {children}
      </a>
    ),
    table: ({ children }) => (
      <div className="research-md-table">
        <table>{children}</table>
      </div>
    ),
    pre: ({ children }) => <pre className="research-md-pre">{children}</pre>,
    code: ({ className: codeClass, children }) => {
      const block = /language-/.test(codeClass || '')
      return block ? <code className={`research-md-codeblock ${codeClass || ''}`}>{children}</code> : <code className="research-md-code">{children}</code>
    },
    img: () => null,
  }
  return (
    <div className={`research-md ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  )
}

function StatusDot({ status }: { status: OrvexResearchSource['status'] }) {
  return <i className={`research-dot ${status}`} aria-hidden="true" />
}

function SourceList({
  sources,
  onOpen,
  idPrefix = 'research-src',
}: {
  sources: OrvexResearchSource[]
  onOpen: (url: string) => void
  idPrefix?: string
}) {
  if (!sources.length) return <p className="dim">No sources yet.</p>
  return (
    <div className="research-sources">
      {sources.map((source) => (
        <div key={`${source.id}-${source.n}`} id={`${idPrefix}-${source.n}`} className={`research-source ${source.used ? 'used' : ''}`}>
          <div className="research-source-top">
            <span className="research-source-n">{source.n}</span>
            <button className="research-source-title" onClick={() => onOpen(source.url)} title={source.url}>
              {source.title || source.host}
            </button>
            {source.used && (
              <span className="research-used" title="Cited in the report">
                <Check size={11} />
              </span>
            )}
          </div>
          <div className="research-source-meta">
            <StatusDot status={source.status} />
            <span>{source.host || 'source'}</span>
            {source.status === 'ok' && <span>· {formatChars(source.chars)}</span>}
            {source.kind && source.status === 'ok' && <span>· {source.kind.toUpperCase()}</span>}
            {source.tables > 0 && <span>· {source.tables} table{source.tables === 1 ? '' : 's'}</span>}
            {source.status === 'error' && source.error && <span className="research-source-error">· {source.error}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

function MetaChip({ children, tone }: { children: ReactNode; tone?: 'ok' | 'warn' }) {
  return <span className={`research-chip ${tone || ''}`}>{children}</span>
}

export default function ResearchPage({ onBack, notify }: Props) {
  const { providers, activeId, active } = useProviders()
  const [reports, setReports] = useState<OrvexResearchSummary[]>([])
  const [mode, setMode] = useState<Mode>('new')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [report, setReport] = useState<OrvexResearchReport | null>(null)
  const [reportBusy, setReportBusy] = useState(false)

  const [query, setQuery] = useState('')
  const [depth, setDepth] = useState<Depth>('standard')
  const [maxSources, setMaxSources] = useState(DEPTH_DEFAULT_SOURCES.standard)
  const [run, setRun] = useState<LiveRun | null>(null)
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const [reader, setReader] = useState<ReaderState>({ mode: 'url', url: '', loading: false, doc: null, sourceUrl: '', error: null })
  const [savingDoc, setSavingDoc] = useState(false)
  const [libraryFilter, setLibraryFilter] = useState('')

  const runIdRef = useRef<string | null>(null)
  const startingRef = useRef(false)
  const pendingEvents = useRef<OrvexResearchEvent[]>([])
  const notifyRef = useRef(notify)
  notifyRef.current = notify

  const refresh = useCallback(async () => {
    if (!researchApi) {
      setLoading(false)
      return
    }
    const res = await researchApi.list()
    if (res.ok) setReports(res.data)
    else setError(res.error)
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openReport = useCallback(async (id: string) => {
    if (!researchApi) return
    setSelectedId(id)
    setReportBusy(true)
    setError(null)
    const res = await researchApi.get(id)
    setReportBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setReport(res.data)
    setMode('report')
  }, [])

  const openExternal = useCallback((url: string) => {
    if (!url) return
    if (researchApi) void researchApi.openExternal(url)
    else window.open(url, '_blank', 'noopener')
  }, [])

  const applyEvent = useCallback(
    (event: OrvexResearchEvent) => {
      if (event.type === 'saved') {
        void refresh()
        return
      }
      if (event.type === 'entry' || event.type === 'done' || event.type === 'error' || event.type === 'cancelled') {
        if (event.runId !== runIdRef.current) return
        if (event.type === 'done') {
          setRun((prev) => (prev ? { ...prev, entry: event.entry, phase: 'done' } : prev))
          setStopping(false)
          runIdRef.current = null
          void refresh()
          void openReport(event.entry.id)
          notifyRef.current('Research report ready')
          return
        }
        if (event.type === 'error' || event.type === 'cancelled') {
          setRun((prev) => (prev ? { ...prev, phase: 'done', error: event.message } : prev))
          setRunError(event.message)
          setStopping(false)
          runIdRef.current = null
          void refresh()
          return
        }
        if (event.type === 'entry') setRun((prev) => (prev ? { ...prev, entry: event.entry } : prev))
        return
      }
      if (event.runId !== runIdRef.current) return
      switch (event.type) {
        case 'plan':
          setRun((prev) => (prev ? { ...prev, plan: event.plan, phase: 'search' } : prev))
          break
        case 'search_start':
          setRun((prev) =>
            prev
              ? { ...prev, searches: [...prev.searches, { query: event.query, count: -1 }] }
              : prev,
          )
          break
        case 'search':
          setRun((prev) => {
            if (!prev) return prev
            const searches = prev.searches.slice()
            const index = searches.findIndex((item) => item.query === event.query && item.count === -1)
            const next = { query: event.query, count: event.count, error: event.error, followup: event.followup }
            if (index >= 0) searches[index] = next
            else searches.push(next)
            return { ...prev, searches }
          })
          break
        case 'sources':
          setRun((prev) => (prev ? { ...prev, sources: event.sources, phase: 'reading' } : prev))
          break
        case 'source':
          setRun((prev) => {
            if (!prev) return prev
            const sources = prev.sources.slice()
            const index = sources.findIndex((item) => item.n === event.source.n)
            if (index >= 0) sources[index] = { ...sources[index], ...event.source }
            else sources.push(event.source)
            return { ...prev, sources }
          })
          break
        case 'progress':
          setRun((prev) => (prev ? { ...prev, phase: event.phase } : prev))
          break
        case 'delta':
          setRun((prev) => (prev ? { ...prev, text: prev.text + event.text, phase: 'writing' } : prev))
          break
        default:
          break
      }
    },
    [openReport, refresh],
  )

  const applyRef = useRef(applyEvent)
  applyRef.current = applyEvent

  useEffect(() => {
    if (!researchApi) return
    return researchApi.onEvent((event) => {
      if (!event) return
      if (!runIdRef.current) {
        if (startingRef.current && event.runId) pendingEvents.current.push(event)
        else if (event.type === 'saved') applyRef.current(event)
        return
      }
      applyRef.current(event)
    })
  }, [])

  const startRun = useCallback(async () => {
    if (!researchApi) return
    const text = query.trim()
    if (text.length < 3) {
      setRunError('Write a research question (at least 3 characters).')
      return
    }
    setRunError(null)
    setError(null)
    setStarting(true)
    startingRef.current = true
    pendingEvents.current = []
    runIdRef.current = null
    setStopping(false)
    setRun(null)
    setMode('new')

    const candidates = orderForTask(buildCandidates(providers, activeId), 'research')
    const res = await researchApi.start({ query: text, depth, maxSources, candidates })
    setStarting(false)
    startingRef.current = false
    if (!res.ok) {
      setRunError(res.error)
      return
    }
    runIdRef.current = res.data.runId
    setRun({
      runId: res.data.runId,
      entry: res.data.entry,
      plan: null,
      sources: [],
      searches: [],
      text: '',
      phase: 'plan',
      error: null,
    })
    const buffered = pendingEvents.current
    pendingEvents.current = []
    for (const event of buffered) applyRef.current(event)
    await refresh()
  }, [activeId, depth, maxSources, providers, query, refresh])

  const stopRun = useCallback(async () => {
    if (!researchApi || !runIdRef.current) return
    setStopping(true)
    await researchApi.stop(runIdRef.current)
  }, [])

  const removeReport = useCallback(
    async (id: string) => {
      if (!researchApi) return
      const res = await researchApi.remove(id)
      if (!res.ok) {
        setError(res.error)
        return
      }
      if (selectedId === id) {
        setSelectedId(null)
        setReport(null)
        setMode('new')
      }
      notifyRef.current('Report deleted')
      await refresh()
    },
    [refresh, selectedId],
  )

  const exportReport = useCallback(async () => {
    if (!researchApi || !report) return
    const res = await researchApi.exportReport(report.id)
    if (!res.ok) {
      setError(res.error)
      return
    }
    if (!res.data.cancelled && res.data.path) notifyRef.current(`Saved to ${res.data.path}`)
  }, [report])

  const copyReport = useCallback(async () => {
    if (!report) return
    try {
      await navigator.clipboard.writeText(report.report)
      setCopied(true)
      notifyRef.current('Report copied')
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setError('Could not copy — the clipboard is unavailable.')
    }
  }, [report])

  const changeDepth = useCallback((next: Depth) => {
    setDepth(next)
    setMaxSources(DEPTH_DEFAULT_SOURCES[next])
  }, [])

  const readUrl = useCallback(async () => {
    if (!researchApi) return
    const url = reader.url.trim()
    if (!url) {
      setReader((prev) => ({ ...prev, error: 'Paste an http(s) URL first.' }))
      return
    }
    setReader((prev) => ({ ...prev, loading: true, error: null, doc: null }))
    const res = await researchApi.readUrl(url, 30000)
    if (!res.ok) {
      setReader((prev) => ({ ...prev, loading: false, error: res.error }))
      return
    }
    const document = res.data
    if (!document.ok) {
      const message = document.error
      setReader((prev) => ({ ...prev, loading: false, error: message }))
      return
    }
    setReader((prev) => ({ ...prev, loading: false, doc: document, sourceUrl: url }))
  }, [reader.url])

  const readFile = useCallback(async () => {
    if (!researchApi) return
    const res = await researchApi.readFile()
    if (!res.ok) {
      setReader((prev) => ({ ...prev, error: res.error }))
      return
    }
    if (res.data.cancelled || !res.data.document) return
    const doc = res.data.document
    if (!doc.ok) {
      const message = doc.error
      setReader((prev) => ({ ...prev, error: message, doc: null, sourceUrl: '', mode: 'file' }))
      return
    }
    setReader((prev) => ({ ...prev, mode: 'file', loading: false, doc, sourceUrl: '', error: null }))
  }, [])

  const saveDoc = useCallback(async () => {
    if (!researchApi || !reader.doc || !reader.doc.ok) return
    const doc = reader.doc
    setSavingDoc(true)
    const res = await researchApi.saveDocument({
      title: doc.title,
      url: reader.sourceUrl || undefined,
      kind: doc.kind,
      text: doc.text,
      mode: doc.mode,
      tables: doc.tables.length,
      warnings: doc.warnings,
    })
    setSavingDoc(false)
    if (!res.ok) {
      setReader((prev) => ({ ...prev, error: res.error }))
      return
    }
    notifyRef.current('Saved to the research library')
    await refresh()
    await openReport(res.data.id)
  }, [openReport, reader.doc, reader.sourceUrl, refresh])

  const filtered = reports.filter((item) => {
    const q = libraryFilter.trim().toLowerCase()
    if (!q) return true
    return item.title.toLowerCase().includes(q) || item.query.toLowerCase().includes(q)
  })

  const running = !!run && !run.error && run.phase !== 'done'
  const phaseIndex = run ? Math.max(0, PHASE_ORDER.indexOf(run.phase)) : -1
  const providerLabel = active ? `${active.name} · ${active.model}` : 'No provider — extractive brief'

  return (
    <PageShell
      title="Research"
      sub="Search, read PDFs and DOCX, verify citations and keep a cited report library"
      onBack={onBack}
      actions={
        <>
          <button
            className="page-tool-btn"
            onClick={() => {
              setMode('reader')
              setError(null)
            }}
            title="Read a URL or file"
          >
            <FileSearch size={14} />
          </button>
          <button
            className="page-tool-btn"
            onClick={() => {
              setMode('new')
              setError(null)
            }}
            title="New research"
          >
            <Plus size={14} />
          </button>
        </>
      }
    >
      <div className="research-page">
        {error && (
          <div className="research-error" role="alert">
            <AlertTriangle size={14} />
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}
        <div className="research-layout">
          <aside className="research-lib panel">
            <div className="research-lib-head">
              <BookOpen size={14} />
              <span>Library</span>
              <span className="research-lib-count">{reports.length}</span>
            </div>
            <div className="research-search">
              <Search size={12} />
              <input
                value={libraryFilter}
                onChange={(event) => setLibraryFilter(event.target.value)}
                placeholder="Filter reports…"
                aria-label="Filter reports"
              />
            </div>
            <div className="research-lib-list">
              {loading && <p className="dim">Loading library…</p>}
              {!loading && !filtered.length && (
                <p className="dim">{reports.length ? 'No report matches that filter.' : 'No reports yet — start one on the right.'}</p>
              )}
              {filtered.map((item) => (
                <div
                  key={item.id}
                  className={`research-lib-item ${selectedId === item.id && mode === 'report' ? 'active' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => void openReport(item.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void openReport(item.id)
                  }}
                >
                  <div className="research-lib-title">{item.title || item.query}</div>
                  <div className="research-lib-meta">
                    <span className={`research-status ${item.status}`}>{item.status}</span>
                    <span>{item.kind === 'document' ? 'document' : DEPTH_LABEL[(item.depth as Depth) || 'standard']}</span>
                    {item.kind === 'research' && <span>{item.readable}/{item.sources} source{item.sources === 1 ? '' : 's'}</span>}
                    {item.kind === 'research' && <span>{item.citations} cite{item.citations === 1 ? '' : 's'}</span>}
                    <span className="research-lib-date">{formatDate(item.createdAt)}</span>
                  </div>
                  <button
                    className="research-lib-del"
                    onClick={(event) => {
                      event.stopPropagation()
                      void removeReport(item.id)
                    }}
                    title="Delete report"
                    aria-label={`Delete ${item.title}`}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          </aside>

          <section className="research-main panel">
            <div className="research-tabs">
              <button className={`research-tab ${mode === 'new' ? 'active' : ''}`} onClick={() => setMode('new')}>
                <Search size={12} /> New research
              </button>
              <button className={`research-tab ${mode === 'reader' ? 'active' : ''}`} onClick={() => setMode('reader')}>
                <FileText size={12} /> Reader
              </button>
              {report && (
                <button className={`research-tab ${mode === 'report' ? 'active' : ''}`} onClick={() => setMode('report')} title={report.title}>
                  <BookOpen size={12} /> {report.title.length > 30 ? `${report.title.slice(0, 30)}…` : report.title}
                </button>
              )}
              <span className="research-tabs-hint">{providerLabel}</span>
            </div>

            <div className="research-body">
              {mode === 'new' && (
                <div className="research-new">
                  <div className="research-form">
                    <label className="research-field">
                      Question
                      <textarea
                        className="text-input research-question"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="e.g. How do solid-state batteries compare with lithium-ion for grid storage?"
                        aria-label="Research question"
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void startRun()
                        }}
                      />
                    </label>
                    <div className="research-form-row">
                      <label className="research-field">
                        Depth
                        <div className="research-depth">
                          {(['quick', 'standard', 'deep'] as Depth[]).map((item) => (
                            <button
                              key={item}
                              className={`research-depth-btn ${depth === item ? 'active' : ''}`}
                              onClick={() => changeDepth(item)}
                              disabled={running}
                            >
                              {DEPTH_LABEL[item]}
                            </button>
                          ))}
                        </div>
                      </label>
                      <label className="research-field">
                        Sources
                        <input
                          className="text-input research-sources-input"
                          type="number"
                          min={3}
                          max={24}
                          value={maxSources}
                          onChange={(event) => setMaxSources(Math.min(24, Math.max(3, Number(event.target.value) || 3)))}
                          disabled={running}
                          aria-label="Maximum sources"
                        />
                      </label>
                      <button className="btn-primary" onClick={() => void startRun()} disabled={!researchApi || running || starting}>
                        {starting ? <Loader2 size={13} className="spin" /> : <Search size={13} />}
                        {starting ? 'Starting…' : 'Run research'}
                      </button>
                      {running && (
                        <button className="btn-ghost" onClick={() => void stopRun()} disabled={stopping}>
                          {stopping ? <Loader2 size={13} className="spin" /> : <Square size={12} />}
                          {stopping ? 'Stopping…' : 'Stop'}
                        </button>
                      )}
                    </div>
                    <p className="research-hint">
                      {active
                        ? `Planning and synthesis use ${active.name} · ${active.model}. Sources are searched, fetched and read locally.`
                        : 'No AI provider is configured. The report will be an extractive brief with numbered citations — add a provider in Settings → Providers for a synthesised answer.'}
                    </p>
                    {runError && (
                      <div className="research-error inline" role="alert">
                        <AlertTriangle size={13} />
                        <span>{runError}</span>
                        <button onClick={() => setRunError(null)} aria-label="Dismiss">
                          ×
                        </button>
                      </div>
                    )}
                  </div>

                  {run && (
                    <div className="research-run">
                      <div className="research-phases">
                        {PHASES.map((phase) => {
                          const idx = PHASE_ORDER.indexOf(phase.id)
                          const state = run.phase === 'done' ? 'done' : idx < phaseIndex ? 'done' : idx === phaseIndex ? 'active' : ''
                          return (
                            <span key={phase.id} className={`research-phase ${state}`}>
                              {state === 'done' ? <Check size={10} /> : state === 'active' ? <Loader2 size={10} className="spin" /> : null}
                              {phase.label}
                            </span>
                          )
                        })}
                        {run.entry.status === 'running' && <span className="research-run-id">{run.runId}</span>}
                      </div>

                      {run.plan && (
                        <div className="research-plan">
                          <div className="research-plan-head">
                            <span>Plan</span>
                            <MetaChip>{run.plan.engine === 'llm' ? 'model' : 'heuristic'}</MetaChip>
                          </div>
                          {run.plan.questions.length > 0 && (
                            <ul className="research-questions">
                              {run.plan.questions.map((question) => (
                                <li key={question}>{question}</li>
                              ))}
                            </ul>
                          )}
                          <div className="research-searches">
                            {run.plan.queries.map((item) => {
                              const found = run.searches.find((search) => search.query === item)
                              return (
                                <span key={item} className={`research-chip query ${found && found.count >= 0 ? 'ok' : ''}`}>
                                  <Search size={10} />
                                  {item}
                                  {found && found.count >= 0 && <b>{found.count}</b>}
                                </span>
                              )
                            })}
                            {run.searches
                              .filter((item) => !run.plan?.queries.includes(item.query))
                              .map((item) => (
                                <span key={`follow-${item.query}`} className={`research-chip query ${item.count >= 0 ? 'ok' : ''}`}>
                                  <Globe2 size={10} />
                                  {item.query}
                                  {item.count >= 0 && <b>{item.count}</b>}
                                </span>
                              ))}
                          </div>
                        </div>
                      )}

                      {run.sources.length > 0 && (
                        <div className="research-run-sources">
                          <div className="research-plan-head">
                            <span>Sources</span>
                            <span className="dim">
                              {run.sources.filter((s) => s.status === 'ok').length} readable · {run.sources.length} found
                            </span>
                          </div>
                          <SourceList sources={run.sources} onOpen={openExternal} idPrefix="research-live-src" />
                        </div>
                      )}

                      {run.text && (
                        <div className="research-live-report">
                          <div className="research-plan-head">
                            <span>Draft</span>
                            <span className="dim">{formatChars(run.text.length)}</span>
                          </div>
                          <MarkdownView markdown={run.text} sources={run.sources} />
                        </div>
                      )}

                      {!run.text && running && (
                        <div className="research-thinking">
                          <Loader2 size={14} className="spin" />
                          <span>
                            {run.phase === 'plan' && 'Planning the research…'}
                            {run.phase === 'search' && 'Searching the web…'}
                            {run.phase === 'followup' && 'Filling gaps with follow-up searches…'}
                            {run.phase === 'reading' && 'Reading and extracting sources…'}
                            {run.phase === 'writing' && 'Writing the report…'}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {mode === 'reader' && (
                <div className="research-reader">
                  <div className="research-form">
                    <div className="research-reader-row">
                      <div className="research-reader-toggle">
                        <button
                          className={`research-depth-btn ${reader.mode === 'url' ? 'active' : ''}`}
                          onClick={() => setReader((prev) => ({ ...prev, mode: 'url' }))}
                        >
                          URL
                        </button>
                        <button
                          className={`research-depth-btn ${reader.mode === 'file' ? 'active' : ''}`}
                          onClick={() => setReader((prev) => ({ ...prev, mode: 'file' }))}
                        >
                          File
                        </button>
                      </div>
                      {reader.mode === 'url' ? (
                        <>
                          <input
                            className="text-input research-url-input"
                            value={reader.url}
                            onChange={(event) => setReader((prev) => ({ ...prev, url: event.target.value }))}
                            placeholder="https://example.com/paper.pdf"
                            aria-label="URL to read"
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void readUrl()
                            }}
                          />
                          <button className="btn-primary" onClick={() => void readUrl()} disabled={reader.loading || !researchApi}>
                            {reader.loading ? <Loader2 size={13} className="spin" /> : <Globe2 size={13} />}
                            Read
                          </button>
                        </>
                      ) : (
                        <button className="btn-primary" onClick={() => void readFile()} disabled={reader.loading || !researchApi}>
                          <Upload size={13} /> Choose file…
                        </button>
                      )}
                    </div>
                    <p className="research-hint">Reads HTML, PDF, DOCX, CSV/TSV, plain text and images (OCR). Tables are kept as Markdown.</p>
                    {reader.error && (
                      <div className="research-error inline" role="alert">
                        <AlertTriangle size={13} />
                        <span>{reader.error}</span>
                        <button onClick={() => setReader((prev) => ({ ...prev, error: null }))} aria-label="Dismiss">
                          ×
                        </button>
                      </div>
                    )}
                  </div>

                  {reader.doc && reader.doc.ok && (
                    <div className="research-document">
                      <div className="research-document-head">
                        <div className="min-w-0">
                          <h3>{reader.doc.title || 'Untitled document'}</h3>
                          <div className="research-document-meta">
                            <MetaChip>{reader.doc.kind.toUpperCase()}</MetaChip>
                            {reader.doc.pageCount ? (
                              <MetaChip>
                                {reader.doc.pageCount} page{reader.doc.pageCount === 1 ? '' : 's'}
                              </MetaChip>
                            ) : null}
                            {reader.doc.tables.length > 0 ? (
                              <MetaChip>
                                {reader.doc.tables.length} table{reader.doc.tables.length === 1 ? '' : 's'}
                              </MetaChip>
                            ) : null}
                            <MetaChip>{formatChars(reader.doc.chars)}</MetaChip>
                            {reader.doc.truncated && <MetaChip tone="warn">truncated</MetaChip>}
                            {reader.sourceUrl && (
                              <button className="research-link-btn" onClick={() => openExternal(reader.sourceUrl)}>
                                <ExternalLink size={10} /> open
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="research-document-actions">
                          <button className="btn-ghost" onClick={() => void copyDocument()} title="Copy extracted text">
                            <Copy size={12} /> Copy
                          </button>
                          <button className="btn-primary" onClick={() => void saveDoc()} disabled={savingDoc}>
                            {savingDoc ? <Loader2 size={12} className="spin" /> : <BookOpen size={12} />}
                            Save to library
                          </button>
                        </div>
                      </div>
                      {reader.doc.warnings.length > 0 && (
                        <div className="research-warnings">
                          {reader.doc.warnings.map((warning) => (
                            <div key={warning} className="research-warning">
                              <AlertTriangle size={11} /> {warning}
                            </div>
                          ))}
                        </div>
                      )}
                      {reader.doc.mode === 'markdown' ? (
                        <MarkdownView markdown={reader.doc.text} />
                      ) : (
                        <pre className="research-doc-pre">{reader.doc.text}</pre>
                      )}
                    </div>
                  )}
                </div>
              )}

              {mode === 'report' && (
                <div className="research-report-view">
                  {reportBusy && (
                    <div className="research-thinking">
                      <Loader2 size={14} className="spin" /> Loading report…
                    </div>
                  )}
                  {!reportBusy && !report && (
                    <div className="research-empty">
                      <BookOpen size={26} />
                      <p>Pick a report from the library or run a new question.</p>
                    </div>
                  )}
                  {!reportBusy && report && (
                    <>
                      <div className="research-report-head">
                        <div className="min-w-0">
                          <h3>{report.title || report.query}</h3>
                          <div className="research-document-meta">
                            <MetaChip>{report.kind === 'document' ? 'Document' : DEPTH_LABEL[(report.depth as Depth) || 'standard']}</MetaChip>
                            <MetaChip tone={report.mode === 'extractive' ? 'warn' : undefined}>
                              {report.mode === 'llm' ? 'AI synthesis' : report.mode === 'document' ? 'saved read' : 'extractive brief'}
                            </MetaChip>
                            {report.provider && <MetaChip>{report.provider.name} · {report.provider.model}</MetaChip>}
                            <MetaChip>{report.sources.length} source{report.sources.length === 1 ? '' : 's'}</MetaChip>
                            <MetaChip>{report.citations.length} citation{report.citations.length === 1 ? '' : 's'}</MetaChip>
                            <MetaChip>{formatDate(report.createdAt)}</MetaChip>
                            {report.status !== 'done' && <MetaChip tone="warn">{report.status}</MetaChip>}
                          </div>
                        </div>
                        <div className="research-document-actions">
                          <button className="btn-ghost" onClick={() => void copyReport()} title="Copy Markdown">
                            {copied ? <Check size={12} /> : <Copy size={12} />} Copy
                          </button>
                          <button className="btn-ghost" onClick={() => void exportReport()} title="Export Markdown">
                            <Download size={12} /> Export
                          </button>
                          <button className="btn-ghost" onClick={() => void removeReport(report.id)} title="Delete report">
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>

                      {report.error && (
                        <div className="research-error inline" role="alert">
                          <AlertTriangle size={13} />
                          <span>{report.error}</span>
                        </div>
                      )}
                      {report.warnings.length > 0 && (
                        <div className="research-warnings">
                          {report.warnings.map((warning) => (
                            <div key={warning} className="research-warning">
                              <AlertTriangle size={11} /> {warning}
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="research-report">
                        <div className="research-report-main">
                          <MarkdownView markdown={report.report || '_No report content._'} sources={report.sources} />
                        </div>
                        <aside className="research-report-side">
                          <div className="research-plan-head">
                            <span>Sources</span>
                            <span className="dim">{report.sources.filter((s) => s.used).length} cited</span>
                          </div>
                          <SourceList sources={report.sources} onOpen={openExternal} />
                        </aside>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </PageShell>
  )

  async function copyDocument() {
    if (!reader.doc || !reader.doc.ok) return
    try {
      await navigator.clipboard.writeText(reader.doc.text)
      notifyRef.current('Document text copied')
    } catch {
      setReader((prev) => ({ ...prev, error: 'Could not copy — the clipboard is unavailable.' }))
    }
  }
}
