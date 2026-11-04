import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Database,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import PageShell from './PageShell'
import LocalBrainPanel from './LocalBrainPanel'
import SkillsPanel from './SkillsPanel'
import TrainKitPanel from './TrainKitPanel'
import FineTunePanel from './FineTunePanel'
import { onTablistKeyDown } from '../data/a11y'
import type {
  IpcResult,
  OrvexLearnerStatus,
  OrvexTrainingEpisode,
  OrvexTrainingEpisodeDetail,
  OrvexTrainingEvalPack,
  OrvexTrainingScoreCurve,
  OrvexTrainingStats,
  OrvexTrainingStatus,
  OrvexTrainingUsage,
} from '../types/desktop'

type Notify = (msg: string) => void
type Props = { onBack: () => void; notify: Notify; initialTab?: string | null }
type Tab = 'overview' | 'vault' | 'episodes' | 'skills' | 'kit' | 'tune' | 'brain'

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'vault', label: 'Vault & quota' },
  { id: 'episodes', label: 'Episodes' },
  { id: 'skills', label: 'Skills & scorer' },
  { id: 'kit', label: 'Train kit' },
  { id: 'tune', label: 'Fine-tune' },
  { id: 'brain', label: 'Local brain' },
]

const KINDS = ['agent', 'orchestrator', 'workflow', 'job', 'chat', 'manual']
const STATUSES = ['running', 'done', 'failed', 'cancelled']
const CATEGORY_LABEL: Record<string, string> = {
  models: 'Models',
  episodes: 'Episode logs',
  datasets: 'Datasets',
  evals: 'Eval packs',
  skills: 'Compiled skills',
  exports: 'Exports',
  checkpoints: 'Checkpoints',
  cache: 'Cache',
}

function msg(err: unknown): string {
  return err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err)
}

async function call<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const res = await promise
  if (!res.ok) throw new Error(res.error)
  return res.data
}

function fmt(bytes: number | null | undefined): string {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${Math.round(n)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function time(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleString() : '—'
}

function scoreText(score: number | null): string {
  return score === null || score === undefined ? '—' : `${Math.round(score * 100)}%`
}

function pretty(value: unknown): string {
  if (value === null || value === undefined) return '—'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export default function TrainingPage({ onBack, notify, initialTab }: Props) {
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const [tab, setTab] = useState<Tab>(() => (TABS.some((t) => t.id === initialTab) ? (initialTab as Tab) : 'overview'))
  const [status, setStatus] = useState<OrvexTrainingStatus | null>(null)
  const [usage, setUsage] = useState<OrvexTrainingUsage | null>(null)
  const [stats, setStats] = useState<OrvexTrainingStats | null>(null)
  const [episodes, setEpisodes] = useState<OrvexTrainingEpisode[]>([])
  const [detail, setDetail] = useState<OrvexTrainingEpisodeDetail | null>(null)
  const [curve, setCurve] = useState<OrvexTrainingScoreCurve | null>(null)
  const [packs, setPacks] = useState<OrvexTrainingEvalPack[]>([])
  const [learner, setLearner] = useState<OrvexLearnerStatus | null>(null)
  const [filterKind, setFilterKind] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [query, setQuery] = useState('')
  const [quota, setQuota] = useState('300')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!bridge) return
    const [nextStatus, nextUsage, nextStats, nextEpisodes, nextCurve, nextPacks] = await Promise.all([
      call(bridge.training.status()),
      call(bridge.training.usage()),
      call(bridge.training.stats()),
      call(
        bridge.training.episodes({
          limit: 100,
          kind: (filterKind || undefined) as OrvexTrainingEpisode['kind'] | undefined,
          status: (filterStatus || undefined) as OrvexTrainingEpisode['status'] | undefined,
          query: query.trim() || undefined,
        }),
      ),
      call(bridge.training.scoreCurve({ days: 30 })),
      call(bridge.training.evalPacks(20)),
    ])
    const nextLearner = await call(bridge.learner.status()).catch(() => null)
    setStatus(nextStatus)
    setUsage(nextUsage)
    setStats(nextStats)
    setEpisodes(nextEpisodes)
    setCurve(nextCurve)
    setPacks(nextPacks.packs)
    setLearner(nextLearner)
    setQuota(String(Math.max(1, Math.round(nextStatus.quotaBytes / 1024 ** 3))))
  }, [bridge, filterKind, filterStatus, query])

  useEffect(() => {
    void load().catch((err) => setError(msg(err)))
  }, [load])

  useEffect(() => {
    if (!bridge) return
    return bridge.training.onChange(() => {
      void load().catch(() => {})
    })
  }, [bridge, load])

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key)
    setError(null)
    try {
      await task()
    } catch (err) {
      setError(msg(err))
    } finally {
      setBusy(null)
    }
  }

  const pickRoot = () =>
    run('root', async () => {
      if (!bridge) return
      const result = await call(bridge.training.pickRoot())
      if (!result.cancelled) notify(`Training vault set to ${result.status.root}`)
      await load()
    })

  const applyQuota = () =>
    run('quota', async () => {
      if (!bridge) return
      const gigabytes = Number(quota)
      if (!Number.isFinite(gigabytes) || gigabytes < 1) throw new Error('Quota must be at least 1 GB.')
      await call(bridge.training.setQuota(Math.round(gigabytes * 1024 ** 3)))
      notify(`Training quota set to ${Math.round(gigabytes)} GB`)
      await load()
    })

  const openRoot = () =>
    run('open', async () => {
      if (!bridge) return
      await call(bridge.training.openRoot())
    })

  const openEpisode = (id: string) =>
    run('detail', async () => {
      if (!bridge) return
      const row = await call(bridge.training.episode(id))
      setDetail(row)
    })

  const removeEpisode = (id: string) =>
    run('delete', async () => {
      if (!bridge || !window.confirm('Delete this episode from the training index?')) return
      await call(bridge.training.deleteEpisode(id))
      if (detail?.id === id) setDetail(null)
      notify('Episode deleted')
      await load()
    })

  const clearEpisodes = () =>
    run('clear', async () => {
      if (!bridge) return
      if (!window.confirm('Delete every episode and the daily JSONL logs? This cannot be undone.')) return
      const result = await call(bridge.training.clearEpisodes())
      setDetail(null)
      notify(`${result.removed} episode${result.removed === 1 ? '' : 's'} deleted`)
      await load()
    })

  const buildPack = () =>
    run('eval', async () => {
      if (!bridge) return
      const pack = await call(bridge.training.buildEvalPack({ limit: 100 }))
      notify(`Eval pack built with ${pack.cases.length} case${pack.cases.length === 1 ? '' : 's'}`)
      await load()
    })

  const learningCycle = () =>
    run('cycle', async () => {
      if (!bridge) return
      const report = await call(bridge.learner.cycle())
      const done = report.actions.map((action) => action.kind).join(', ')
      notify(done ? `Learning cycle: ${done}` : 'Learning cycle ran; nothing new to do yet')
      await load()
    })

  const usedRatio = useMemo(() => {
    if (!status || !status.quotaBytes) return 0
    return Math.min(100, (status.usedBytes / status.quotaBytes) * 100)
  }, [status])

  const categories = useMemo(() => {
    const source = usage?.categories ?? status?.categories ?? {}
    return Object.keys(CATEGORY_LABEL).map((key) => ({ key, label: CATEGORY_LABEL[key], bytes: source[key] ?? 0 }))
  }, [usage, status])

  return (
    <PageShell
      title="Training"
      sub="Local learning vault, quota and captured runs"
      onBack={onBack}
      actions={
        <button className="adv-btn" disabled={busy !== null} onClick={() => void run('refresh', load)}>
          {busy === 'refresh' ? <Loader2 size={13} className="adv-spin" /> : <RefreshCw size={13} />} Refresh
        </button>
      }
    >
      <div className="adv">
        <div className="settings-tabs adv-tabs" role="tablist" aria-label="Training sections" onKeyDown={onTablistKeyDown}>
          {TABS.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              className={`settings-tab ${tab === item.id ? 'active' : ''}`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {error && (
          <p className="adv-error" role="alert">
            <AlertTriangle size={13} /> {error}
          </p>
        )}

        {tab === 'overview' && (
          <>
            <div className="adv-grid">
              <section className="adv-card">
                <div className="adv-card-head">
                  <h3>Vault</h3>
                  <span className="adv-hint">experiences and artifacts</span>
                </div>
                {status ? (
                  <>
                    <div className="adv-tiles">
                      <div className="adv-tile">
                        <span>Quota</span>
                        <b>{fmt(status.quotaBytes)}</b>
                        <small>{fmt(status.reserveBytes)} disk reserve kept free</small>
                      </div>
                      <div className="adv-tile">
                        <span>Used</span>
                        <b>{fmt(status.usedBytes)}</b>
                        <small>{usedRatio.toFixed(1)}% of quota</small>
                      </div>
                      <div className="adv-tile">
                        <span>Drive free</span>
                        <b>{fmt(status.freeBytes)}</b>
                        <small>of {fmt(status.diskTotalBytes)} total</small>
                      </div>
                      <div className="adv-tile">
                        <span>Episodes</span>
                        <b>{status.episodes}</b>
                        <small>last {time(status.lastEpisodeAt)}</small>
                      </div>
                    </div>
                    <div className="training-bar" aria-label="Quota usage">
                      <span style={{ width: `${usedRatio}%` }} />
                    </div>
                    <div className="adv-kv">
                      <span>Folder</span>
                      <b className="adv-clip" title={status.root}>{status.root}</b>
                      <span>Status</span>
                      <b>{status.exists ? 'ready' : 'missing'}</b>
                      <span>Quota health</span>
                      <b>{status.overQuota ? 'over quota' : status.diskTight ? 'disk tight' : 'healthy'}</b>
                    </div>
                    {(status.overQuota || status.diskTight) && (
                      <p className="adv-note">
                        <AlertTriangle size={12} /> {status.overQuota ? 'The vault reached its quota; new files will be refused.' : 'Free space is below the safety reserve.'}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="adv-empty">Reading the training vault…</p>
                )}
              </section>

              <section className="adv-card">
                <div className="adv-card-head">
                  <h3>Captured runs</h3>
                  <span className="adv-hint">episode index</span>
                </div>
                {stats ? (
                  <>
                    <div className="adv-tiles">
                      <div className="adv-tile"><span>Episodes</span><b>{stats.count}</b><small>agent, job and workflow runs</small></div>
                      <div className="adv-tile"><span>Avg score</span><b>{stats.count ? `${Math.round(stats.avgScore * 100)}%` : '—'}</b><small>self-evaluation</small></div>
                      <div className="adv-tile"><span>Tokens</span><b>{stats.tokens.toLocaleString()}</b><small>{stats.steps} tool steps</small></div>
                      <div className="adv-tile"><span>Cost</span><b>${stats.cost.toFixed(3)}</b><small>measured usage</small></div>
                    </div>
                    {stats.byKind.length > 0 ? (
                      <div className="adv-kv">
                        {stats.byKind.map((row) => (
                          <span key={row.kind}>{row.kind}</span>
                        ))}
                        {stats.byKind.map((row) => (
                          <b key={`${row.kind}-count`}>{row.count}</b>
                        ))}
                      </div>
                    ) : (
                      <p className="adv-empty">No episodes recorded yet.</p>
                    )}
                  </>
                ) : (
                  <p className="adv-empty">Reading the episode index…</p>
                )}
              </section>
            </div>

            <section className="adv-card adv-card-wide">
              <div className="adv-card-head">
                <h3>Next actions</h3>
                <span className="adv-hint">
                  {learner?.lastCycleAt ? `last cycle ${time(learner.lastCycleAt)}` : 'learning loop has not run yet'}
                </span>
              </div>
              {learner && learner.suggestions.length > 0 ? (
                <div>
                  {learner.suggestions.map((item) => (
                    <div className="training-pack" key={item.id}>
                      <Sparkles size={12} />
                      <span className="adv-clip" title={item.detail}>{item.title} — {item.detail}</span>
                      <span className="ml-auto adv-hint">{item.kind}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="adv-empty">
                  Nothing to do yet. Finish a few agent, workflow or job runs and ORVEX will suggest eval packs, skills and a scorer.
                </p>
              )}
              <div className="adv-kv">
                <span>Nano scorer</span>
                <b>{learner?.nano.active ? `${Math.round((learner.nano.active.accuracy ?? 0) * 100)}% accuracy` : 'not trained'}</b>
                <span>Skills</span>
                <b>{learner ? `${learner.skills.active} active · ${learner.skills.suggested} suggested` : '—'}</b>
                <span>Train kits</span>
                <b>{learner?.kits ?? 0}</b>
                <span>Fine-tunes</span>
                <b>{learner ? `${learner.fineTunes.open} running · ${learner.fineTunes.total} total` : '—'}</b>
              </div>
              <div className="adv-actions">
                <button className="adv-btn adv-btn-primary" disabled={busy !== null} onClick={() => void learningCycle()}>
                  {busy === 'cycle' ? <Loader2 size={13} className="adv-spin" /> : <Sparkles size={13} />} Run learning cycle
                </button>
              </div>
              <p className="adv-note">
                The cycle freezes a new eval pack when enough runs arrived, trains the scorer when it has data, and compiles skills from successful runs. It never uploads anything.
              </p>
            </section>

            <section className="adv-card adv-card-wide">
              <div className="adv-card-head">
                <h3>Score curve</h3>
                <span className="adv-hint">
                  {curve ? `${curve.days} days · ${curve.overall.count} runs · pass ${curve.overall.passRate == null ? '—' : `${Math.round(curve.overall.passRate * 100)}%`}` : 'reading…'}
                </span>
              </div>
              {curve && curve.points.length > 0 ? (
                <>
                  {curve.points.map((point) => (
                    <div className="training-curve-row" key={point.day}>
                      <span>{point.day}</span>
                      <div className="training-bar">
                        <span style={{ width: `${Math.round((point.avgScore ?? point.passRate ?? 0) * 100)}%` }} />
                      </div>
                      <b>{point.avgScore == null ? '—' : `${Math.round(point.avgScore * 100)}%`}</b>
                      <span>pass {point.passRate == null ? '—' : `${Math.round(point.passRate * 100)}%`}</span>
                      <span>{point.done}✓ {point.failed}✕ {point.cancelled}⏹</span>
                    </div>
                  ))}
                </>
              ) : (
                <p className="adv-empty">No scored runs in this window. Finish an agent, workflow or job run to start the curve.</p>
              )}
              <div className="adv-actions">
                <button className="adv-btn adv-btn-primary" disabled={busy !== null || episodes.length === 0} onClick={() => void buildPack()}>
                  {busy === 'eval' ? <Loader2 size={13} className="adv-spin" /> : <Database size={13} />} Build eval pack
                </button>
              </div>
              {packs.length > 0 ? (
                <div>
                  {packs.map((pack) => (
                    <div className="training-pack" key={pack.id}>
                      <span className="adv-mono">{pack.id}</span>
                      <span className="adv-clip" title={pack.path}>{pack.name}</span>
                      <span className="ml-auto adv-hint">{pack.cases} cases · {time(pack.createdAt)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="adv-empty">No eval packs yet. A pack freezes recorded goals and outcomes into reproducible cases.</p>
              )}
            </section>
          </>
        )}

        {tab === 'vault' && (
          <div className="adv-grid">
            <section className="adv-card">
              <div className="adv-card-head">
                <h3>Folder</h3>
                <span className="adv-hint">where the vault lives</span>
              </div>
              <p className="adv-note adv-clip" title={status?.root}>{status?.root ?? '—'}</p>
              <div className="adv-actions">
                <button className="adv-btn adv-btn-primary" disabled={busy !== null} onClick={() => void pickRoot()}>
                  {busy === 'root' ? <Loader2 size={13} className="adv-spin" /> : <FolderOpen size={13} />} Choose folder
                </button>
                <button className="adv-btn" disabled={busy !== null} onClick={() => void openRoot()}>
                  {busy === 'open' ? <Loader2 size={13} className="adv-spin" /> : <HardDrive size={13} />} Open in Explorer
                </button>
              </div>
              <p className="adv-note">Changing the folder does not move existing files. Copy them yourself or keep the old folder as an archive.</p>
            </section>

            <section className="adv-card">
              <div className="adv-card-head">
                <h3>Quota</h3>
                <span className="adv-hint">hard limit</span>
              </div>
              <label className="adv-field">
                <span>Gigabytes</span>
                <input
                  className="adv-input"
                  inputMode="numeric"
                  value={quota}
                  onChange={(e) => setQuota(e.target.value)}
                  placeholder="300"
                />
              </label>
              <div className="adv-actions">
                <button className="adv-btn adv-btn-primary" disabled={busy !== null || !status} onClick={() => void applyQuota()}>
                  {busy === 'quota' ? <Loader2 size={13} className="adv-spin" /> : <Database size={13} />} Apply quota
                </button>
              </div>
              <div className="adv-kv">
                <span>Drive free</span><b>{fmt(status?.freeBytes)}</b>
                <span>Reserve</span><b>{fmt(status?.reserveBytes)}</b>
                <span>Used</span><b>{fmt(status?.usedBytes)}</b>
              </div>
            </section>

            <section className="adv-card adv-card-wide">
              <div className="adv-card-head">
                <h3>Categories</h3>
                <span className="adv-hint">measured on disk</span>
              </div>
              <div className="adv-table">
                <div className="adv-tr adv-th"><span>Folder</span><span>Size</span><span>Share</span></div>
                {categories.map((row) => (
                  <div key={row.key} className="adv-tr">
                    <span>{row.label}</span>
                    <span>{fmt(row.bytes)}</span>
                    <span>{status && status.usedBytes > 0 ? `${Math.round((row.bytes / status.usedBytes) * 100)}%` : '0%'}</span>
                  </div>
                ))}
              </div>
              <p className="adv-note">Layout: {status?.layout.join(' · ') ?? 'models · episodes · datasets · evals · skills · exports · checkpoints · cache'}</p>
            </section>
          </div>
        )}

        {tab === 'episodes' && (
          <>
            <div className="adv-form">
              <div className="adv-row-2">
                <label className="adv-field">
                  <span>Kind</span>
                  <select className="adv-input" value={filterKind} onChange={(e) => setFilterKind(e.target.value)}>
                    <option value="">All kinds</option>
                    {KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                  </select>
                </label>
                <label className="adv-field">
                  <span>Status</span>
                  <select className="adv-input" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
                    <option value="">All statuses</option>
                    {STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
              </div>
              <label className="adv-field">
                <span>Search</span>
                <input className="adv-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="goal, outcome or error" />
              </label>
              <div className="adv-actions">
                <button className="adv-btn adv-btn-danger" disabled={busy !== null || episodes.length === 0} onClick={() => void clearEpisodes()}>
                  {busy === 'clear' ? <Loader2 size={13} className="adv-spin" /> : <Trash2 size={13} />} Clear all
                </button>
              </div>
            </div>

            <div className="adv-card">
              <div className="adv-card-head">
                <h3>Episodes</h3>
                <span className="adv-hint">{episodes.length} shown</span>
              </div>
              {episodes.length === 0 ? (
                <p className="adv-empty">No episodes match. Agent, job and workflow runs are recorded automatically once the recorder is enabled in the next Phase 6 batch.</p>
              ) : (
                <div className="adv-table">
                  <div className="adv-tr adv-th"><span>When</span><span>Kind</span><span>Status</span><span>Goal</span><span>Score</span><span>Tokens</span><span /></div>
                  {episodes.map((row) => (
                    <div key={row.id} className="adv-tr">
                      <span>{time(row.createdAt)}</span>
                      <span>{row.kind}</span>
                      <span>{row.status}</span>
                      <span className="adv-clip" title={row.goal ?? ''}>{row.goal || '—'}</span>
                      <span>{scoreText(row.score)}</span>
                      <span>{(row.promptTokens + row.completionTokens).toLocaleString()}</span>
                      <span className="adv-row-actions">
                        <button className="adv-icon" title="Details" onClick={() => void openEpisode(row.id)}>…</button>
                        <button className="adv-icon" title="Delete" onClick={() => void removeEpisode(row.id)}><Trash2 size={13} /></button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {detail && (
              <div className="adv-card">
                <div className="adv-card-head">
                  <h3>Episode {detail.id}</h3>
                  <span className="adv-hint">{detail.kind} · {detail.status}</span>
                </div>
                <div className="adv-kv">
                  <span>Goal</span><b>{detail.goal || '—'}</b>
                  <span>Model</span><b>{detail.model || '—'} {detail.provider ? `(${detail.provider})` : ''}</b>
                  <span>Score</span><b>{scoreText(detail.score)}</b>
                  <span>Steps</span><b>{detail.steps}</b>
                  <span>Tokens</span><b>{(detail.promptTokens + detail.completionTokens).toLocaleString()}</b>
                  <span>Cost</span><b>${Number(detail.cost || 0).toFixed(4)}</b>
                  <span>Duration</span><b>{detail.ms ? `${detail.ms} ms` : '—'}</b>
                  <span>Log file</span><b>{detail.file || 'not written'}</b>
                  {detail.error && (<><span>Error</span><b>{detail.error}</b></>)}
                </div>
                <p className="adv-note">Plan</p>
                <pre className="training-json">{pretty(detail.plan)}</pre>
                <p className="adv-note">Actions</p>
                <pre className="training-json">{pretty(detail.actions)}</pre>
                <p className="adv-note">Outcome</p>
                <pre className="training-json">{pretty(detail.outcome)}</pre>
              </div>
            )}
          </>
        )}

        {tab === 'skills' && <SkillsPanel notify={notify} />}
        {tab === 'kit' && <TrainKitPanel notify={notify} />}
        {tab === 'tune' && <FineTunePanel notify={notify} />}
        {tab === 'brain' && <LocalBrainPanel notify={notify} />}
      </div>
    </PageShell>
  )
}
