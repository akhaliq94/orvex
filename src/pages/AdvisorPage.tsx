import { useCallback, useEffect, useState } from 'react'
import {
  ArrowUpCircle,
  Download,
  ExternalLink,
  FolderOpen,
  Lightbulb,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Wallet,
  X,
} from 'lucide-react'
import PageShell from './PageShell'
import type {
  IpcResult,
  OrvexAdvisorBrief,
  OrvexAdvisorSuggestion,
  OrvexUpdaterState,
} from '../types/desktop'
import './advisor.css'

type Notify = (msg: string) => void
type Props = {
  onBack: () => void
  notify: Notify
  onNavigate?: (id: string, label?: string, tab?: string) => void
}

function msg(err: unknown): string {
  return err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err)
}

async function call<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const res = await promise
  if (!res.ok) throw new Error(res.error)
  return res.data
}

function money(value: number | null | undefined): string {
  return `$${Number(value || 0).toFixed(2)}`
}

function time(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleString() : '—'
}

function barWidth(pct: number | null): string {
  return `${Math.max(0, Math.min(100, Number(pct) || 0))}%`
}

export default function AdvisorPage({ onBack, notify, onNavigate }: Props) {
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const [brief, setBrief] = useState<OrvexAdvisorBrief | null>(null)
  const [updater, setUpdater] = useState<OrvexUpdaterState | null>(null)
  const [repoInput, setRepoInput] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [daily, setDaily] = useState('')
  const [monthly, setMonthly] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(
    async (announce = false) => {
      if (!bridge?.advisor || !bridge.updater) return
      try {
        const [nextBrief, nextUpdater] = await Promise.all([call(bridge.advisor.brief()), call(bridge.updater.state())])
        setBrief(nextBrief)
        setUpdater(nextUpdater)
        setRepoInput(nextUpdater.repo || '')
        setDaily(nextBrief.budget.dailyUsd ? String(nextBrief.budget.dailyUsd) : '')
        setMonthly(nextBrief.budget.monthlyUsd ? String(nextBrief.budget.monthlyUsd) : '')
        setError(null)
        if (announce) notify('Advisor refreshed from current state')
      } catch (err) {
        setError(msg(err))
      } finally {
        setLoading(false)
      }
    },
    [bridge, notify],
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!bridge?.updater) return
    return bridge.updater.onEvent((event) => {
      if (event.phase === 'download') {
        setProgress(event.pct ?? null)
        return
      }
      if (event.phase === 'ready') {
        setProgress(null)
        void load(false)
        notify('Update downloaded and SHA-256 verified')
        return
      }
      if (event.phase === 'available') {
        void load(false)
        notify(`ORVEX ${event.result?.latest || ''} is available`)
        return
      }
      if (event.phase === 'install') notify('Installer started; ORVEX is closing')
    })
  }, [bridge, load, notify])

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    try {
      await fn()
    } catch (err) {
      setError(msg(err))
    } finally {
      setBusy(null)
    }
  }

  const dismiss = (item: OrvexAdvisorSuggestion) =>
    run(`dismiss:${item.id}`, async () => {
      if (!bridge?.advisor) return
      await call(bridge.advisor.dismiss(item.id, 24))
      await load()
      notify('Suggestion dismissed for 24 hours')
    })

  const restoreAll = () =>
    run('restore', async () => {
      if (!bridge?.advisor) return
      await call(bridge.advisor.restore())
      await load()
      notify('Dismissed suggestions restored')
    })

  const saveBudget = () =>
    run('budget', async () => {
      if (!bridge?.advisor) return
      const parse = (text: string) => (text.trim() === '' ? 0 : Number(text))
      const dailyUsd = parse(daily)
      const monthlyUsd = parse(monthly)
      if (!Number.isFinite(dailyUsd) || !Number.isFinite(monthlyUsd) || dailyUsd < 0 || monthlyUsd < 0) {
        throw new Error('Budgets must be zero or a positive number of USD.')
      }
      await call(bridge.advisor.setBudget({ dailyUsd, monthlyUsd }))
      await load()
      notify('Budgets saved')
    })

  const checkNow = () =>
    run('updateCheck', async () => {
      if (!bridge?.updater) return
      const result = await call(bridge.updater.check(repoInput.trim() || undefined))
      await load()
      if (!result.configured) notify('Set the GitHub repository as owner/name first')
      else if (!result.ok) notify(`Update check failed: ${result.error || 'unknown error'}`)
      else if (result.available) notify(`ORVEX ${result.latest} is available`)
      else notify(`ORVEX ${result.current} is up to date`)
    })

  const toggleAutoCheck = () =>
    run('updateAuto', async () => {
      if (!bridge?.updater) return
      const next = await call(bridge.updater.setAutoCheck(!(updater?.autoCheck ?? true)))
      setUpdater(next)
    })

  const downloadUpdate = () =>
    run('updateDownload', async () => {
      if (!bridge?.updater) return
      setProgress(0)
      const result = await call(bridge.updater.download())
      setUpdater(result.state)
      setProgress(null)
      notify(`Downloaded ${result.download.name} and verified its SHA-256`)
    })

  const installUpdate = () =>
    run('updateInstall', async () => {
      if (!bridge?.updater) return
      const latest = updater?.last?.latest || 'the new version'
      if (!window.confirm(`Install ORVEX ${latest} now? ORVEX closes so the signed-out installer can replace the files.`)) return
      const result = await call(bridge.updater.install())
      notify(result.note)
    })

  const revealDownload = () =>
    run('updateReveal', async () => {
      if (!bridge?.updater) return
      await call(bridge.updater.reveal())
    })

  const openRelease = () =>
    run('updateOpen', async () => {
      if (!bridge?.updater) return
      await call(bridge.updater.openRelease())
    })

  const createBackup = () =>
    run('backup', async () => {
      if (!bridge?.security) return
      await call(bridge.security.createBackup({ note: 'Created from Advisor' }))
      await load()
      notify('Backup created')
    })

  const openExternal = (url: string) =>
    run('open', async () => {
      if (!bridge?.research) return
      await call(bridge.research.openExternal(url))
    })

  const openTarget = (item: OrvexAdvisorSuggestion) => {
    if (!item.action || !onNavigate) return
    onNavigate(item.action.target, undefined, item.action.tab)
  }

  const suggestions = brief?.top ?? []
  const dismissed = brief?.stats.dismissed ?? 0
  const last = updater?.last ?? null

  return (
    <PageShell
      title="Advisor"
      sub="Ranked suggestions and a daily brief built from real runs, spend, inbox, backups, training and update signals"
      onBack={onBack}
      actions={
        <button className="adv-btn" onClick={() => void load(true)} disabled={loading || !!busy}>
          {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
          Refresh
        </button>
      }
    >
      <div className="adv advisor">
        {error && (
          <p className="adv-error">
            <X size={13} /> {error}
          </p>
        )}

        {loading && !brief && (
          <section className="adv-card">
            <p className="adv-empty">Reading real signals…</p>
          </section>
        )}

        {brief && (
          <>
            <section className="adv-card advisor-brief">
              <div className="advisor-brief-head">
                <div className="min-w-0">
                  <p className="adv-hint">
                    {brief.date} · ORVEX {brief.version}
                  </p>
                  <h3>{brief.headline}</h3>
                </div>
                <div className="advisor-rate">
                  <b>{brief.stats.successRate == null ? '—' : `${brief.stats.successRate}%`}</b>
                  <span>run success</span>
                </div>
              </div>

              <div className="advisor-stats">
                <div>
                  <span>Runs today</span>
                  <b>{brief.stats.runsToday}</b>
                </div>
                <div>
                  <span>Failed</span>
                  <b className={brief.stats.runsFailed > 0 ? 'warn' : ''}>{brief.stats.runsFailed}</b>
                </div>
                <div>
                  <span>Spend today</span>
                  <b>{money(brief.stats.spendToday)}</b>
                </div>
                <div>
                  <span>This month</span>
                  <b>{money(brief.stats.spendMonth)}</b>
                </div>
                <div>
                  <span>Unread reports</span>
                  <b className={brief.stats.unread > 0 ? 'warn' : ''}>{brief.stats.unread}</b>
                </div>
                <div>
                  <span>Backups</span>
                  <b>{brief.stats.backups == null ? '—' : brief.stats.backups}</b>
                </div>
              </div>

              <div className="advisor-bars">
                <div className="advisor-bar">
                  <div className="advisor-bar-head">
                    <span>Daily budget</span>
                    <span>
                      {money(brief.budget.todayUsd)}
                      {brief.budget.dailyUsd > 0 ? ` of ${money(brief.budget.dailyUsd)}` : ' · no limit'}
                    </span>
                  </div>
                  <div className="advisor-bar-track">
                    <i
                      className={brief.budget.dailyReached ? 'over' : brief.budget.dailyNear ? 'near' : ''}
                      style={{ width: barWidth(brief.budget.dailyPct) }}
                    />
                  </div>
                </div>
                <div className="advisor-bar">
                  <div className="advisor-bar-head">
                    <span>Monthly budget</span>
                    <span>
                      {money(brief.budget.monthUsd)}
                      {brief.budget.monthlyUsd > 0 ? ` of ${money(brief.budget.monthlyUsd)}` : ' · no limit'}
                    </span>
                  </div>
                  <div className="advisor-bar-track">
                    <i
                      className={brief.budget.monthlyReached ? 'over' : brief.budget.monthlyNear ? 'near' : ''}
                      style={{ width: barWidth(brief.budget.monthlyPct) }}
                    />
                  </div>
                </div>
              </div>

              <ul className="advisor-highlights">
                {brief.highlights.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>

            <div className="advisor-grid">
              <section className="adv-card">
                <div className="adv-card-head">
                  <Lightbulb size={14} />
                  <b>Ranked suggestions</b>
                  <span className="adv-hint">
                    {suggestions.length} active
                    {dismissed > 0 ? ` · ${dismissed} dismissed` : ''}
                  </span>
                  {dismissed > 0 && (
                    <button className="adv-btn" onClick={() => void restoreAll()} disabled={!!busy}>
                      <RotateCcw size={12} /> Restore
                    </button>
                  )}
                </div>
                {suggestions.length === 0 ? (
                  <p className="adv-empty">You are all caught up. Nothing needs attention right now.</p>
                ) : (
                  <ul className="advisor-list">
                    {suggestions.map((item) => (
                      <li key={item.id} className={`advisor-item sev-${item.severity}`}>
                        <div className="advisor-item-main">
                          <div className="advisor-item-top">
                            <span className={`advisor-sev sev-${item.severity}`}>
                              {item.severity[0].toUpperCase() + item.severity.slice(1)}
                            </span>
                            <strong>{item.title}</strong>
                            <span className="advisor-rank">#{item.rank}</span>
                          </div>
                          <p>{item.detail}</p>
                        </div>
                        <div className="advisor-item-actions">
                          {item.url && (
                            <button className="adv-btn" onClick={() => void openExternal(item.url as string)} disabled={!!busy}>
                              <ExternalLink size={12} /> Release
                            </button>
                          )}
                          {item.action && onNavigate && (
                            <button className="adv-btn" onClick={() => openTarget(item)} disabled={!!busy}>
                              {item.action.label}
                            </button>
                          )}
                          <button
                            className="adv-btn advisor-dismiss"
                            onClick={() => void dismiss(item)}
                            disabled={!!busy}
                            title="Hide this suggestion for 24 hours"
                          >
                            <X size={12} /> Dismiss
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {suggestions.length > 0 && brief.itemsCount > suggestions.length && (
                  <p className="adv-hint">
                    Showing the top {suggestions.length} of {brief.itemsCount}. Dismiss or fix one to see the rest.
                  </p>
                )}
              </section>

              <aside className="advisor-side">
                <section className="adv-card">
                  <div className="adv-card-head">
                    <Wallet size={14} />
                    <b>Budgets</b>
                    <span className="adv-hint">0 disables a limit</span>
                  </div>
                  <div className="advisor-fields">
                    <label className="advisor-field">
                      <span>Daily (USD)</span>
                      <input
                        className="text-input"
                        inputMode="decimal"
                        value={daily}
                        placeholder="0"
                        onChange={(e) => setDaily(e.target.value)}
                      />
                    </label>
                    <label className="advisor-field">
                      <span>Monthly (USD)</span>
                      <input
                        className="text-input"
                        inputMode="decimal"
                        value={monthly}
                        placeholder="0"
                        onChange={(e) => setMonthly(e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="adv-actions">
                    <button className="adv-btn adv-btn-primary" onClick={() => void saveBudget()} disabled={!!busy}>
                      {busy === 'budget' ? <Loader2 size={12} className="spin" /> : null} Save budgets
                    </button>
                  </div>
                  <p className="adv-note">
                    Spend is read from the usage ledger; the daily limit is the same one the agent budget guard uses.
                  </p>
                </section>

                <section className="adv-card">
                  <div className="adv-card-head">
                    <ArrowUpCircle size={14} />
                    <b>Updates</b>
                    <span className="adv-hint">Current {updater?.current || brief.version}</span>
                  </div>
                  <label className="advisor-field">
                    <span>GitHub repository (owner/name)</span>
                    <input
                      className="text-input"
                      value={repoInput}
                      placeholder="your-org/orvex-releases"
                      onChange={(e) => setRepoInput(e.target.value)}
                    />
                  </label>
                  <div className="adv-actions">
                    <button className="adv-btn adv-btn-primary" onClick={() => void checkNow()} disabled={!!busy}>
                      {busy === 'updateCheck' ? <Loader2 size={12} className="spin" /> : null} Check releases
                    </button>
                    <button className="adv-btn" onClick={() => void toggleAutoCheck()} disabled={!!busy}>
                      {busy === 'updateAuto' ? <Loader2 size={12} className="spin" /> : null}
                      {updater?.autoCheck ?? true ? 'Auto-check: on' : 'Auto-check: off'}
                    </button>
                    {last?.url && (
                      <button className="adv-btn" onClick={() => void openRelease()} disabled={!!busy}>
                        <ExternalLink size={12} /> Release page
                      </button>
                    )}
                  </div>
                  {!updater?.repo && !last && (
                    <p className="adv-hint">No repository set. Nothing is contacted until you add the public owner/name that hosts releases.</p>
                  )}
                  {last && (
                    <div className="advisor-update">
                      <p className="adv-note">
                        Last checked {time(last.checkedAt)} ·{' '}
                        {last.ok ? (last.available ? `ORVEX ${last.latest} available` : 'up to date') : last.error}
                      </p>
                      {last.ok && last.asset && (
                        <p className="adv-note">
                          {last.asset.name} · {last.asset.size ? `${(last.asset.size / 1048576).toFixed(1)} MB` : 'size unknown'} ·{' '}
                          {last.asset.digest ? 'SHA-256 in release digest' : last.checksums ? 'SHA-256SUMS published' : 'no checksum, install disabled'}
                        </p>
                      )}
                      {last.ok && !last.asset && last.missing && <p className="adv-note">{last.missing}</p>}
                      {last.notes && <p className="advisor-notes">{last.notes}</p>}
                      {last.download?.status === 'ready' && (
                        <p className="adv-note">
                          Downloaded {last.download.name} · SHA-256 verified ({last.download.hashSource})
                        </p>
                      )}
                      {progress !== null && (
                        <div className="advisor-bar">
                          <div className="advisor-bar-head">
                            <span>Downloading</span>
                            <span>{Math.round(progress)}%</span>
                          </div>
                          <div className="advisor-bar-track">
                            <i style={{ width: barWidth(progress) }} />
                          </div>
                        </div>
                      )}
                      {last.available && last.asset && last.download?.status !== 'ready' && (
                        <div className="adv-actions">
                          <button className="adv-btn adv-btn-primary" onClick={() => void downloadUpdate()} disabled={!!busy || progress !== null}>
                            {busy === 'updateDownload' ? <Loader2 size={12} className="spin" /> : <Download size={12} />} Download &amp; verify
                          </button>
                        </div>
                      )}
                      {last.download?.status === 'ready' && (
                        <div className="adv-actions">
                          <button className="adv-btn adv-btn-primary" onClick={() => void installUpdate()} disabled={!!busy}>
                            {busy === 'updateInstall' ? <Loader2 size={12} className="spin" /> : <ArrowUpCircle size={12} />}
                            {last.asset?.kind === 'portable' ? 'Show portable file' : 'Install & restart'}
                          </button>
                          <button className="adv-btn" onClick={() => void revealDownload()} disabled={!!busy}>
                            <FolderOpen size={12} /> Show file
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  <p className="adv-hint">
                    Reads the public GitHub release API, downloads only the {updater?.portable ? 'portable' : 'NSIS setup'} build,
                    and refuses to install unless the published SHA-256 matches.
                  </p>
                </section>

                <section className="adv-card">
                  <div className="adv-card-head">
                    <ShieldCheck size={14} />
                    <b>Backups</b>
                    <span className="adv-hint">
                      {brief.stats.backups == null ? 'unavailable' : `${brief.stats.backups} on disk`}
                    </span>
                  </div>
                  <p className="adv-note">Last backup: {time(brief.stats.lastBackupAt)}</p>
                  <div className="adv-actions">
                    <button className="adv-btn adv-btn-primary" onClick={() => void createBackup()} disabled={!!busy}>
                      {busy === 'backup' ? <Loader2 size={12} className="spin" /> : null} Create backup
                    </button>
                    {onNavigate && (
                      <button className="adv-btn" onClick={() => onNavigate('security', undefined, 'backup')} disabled={!!busy}>
                        Restore options
                      </button>
                    )}
                  </div>
                  <p className="adv-hint">Restore and delete stay on Security → Backup so a backup is never overwritten by accident.</p>
                </section>
              </aside>
            </div>
          </>
        )}
      </div>
    </PageShell>
  )
}
