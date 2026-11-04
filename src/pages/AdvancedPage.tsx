import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  CircleDashed,
  Download,
  FolderDown,
  Laptop,
  Layers,
  ListChecks,
  Loader2,
  Network,
  Play,
  Plus,
  RefreshCw,
  Route,
  ScanText,
  ShieldAlert,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Users,
  XCircle,
  Zap,
} from 'lucide-react'
import PageShell from './PageShell'
import { onTablistKeyDown } from '../data/a11y'
import { useProviders } from '../hooks/useProviders'
import { buildCandidates, clearServerRoute, orderForTask, persistRoute, TASKS, toCandidate } from '../data/routing'
import type { TaskId } from '../data/routing'
import type {
  IpcResult,
  OrvexAdvancedContext,
  OrvexAdvancedJob,
  OrvexAdvancedMode,
  OrvexAdvancedStatus,
  OrvexAdvancedSuggestion,
  OrvexCollabAgent,
  OrvexCollabSession,
  OrvexCollabSessionDetail,
  OrvexA2aStatus,
  OrvexDeviceHostStatus,
  OrvexDeviceInfo,
  OrvexDeviceLink,
  OrvexCatalogKey,
  OrvexLearningSuggestion,
  OrvexMarketCatalog,
  OrvexPluginInfo,
  OrvexProactiveRule,
  OrvexProactiveRuleEvent,
  OrvexRecoveryOverview,
  OrvexRouteRecommendResult,
  OrvexRouteStat,
  OrvexRouteRef,
  OrvexSelfEval,
  OrvexSyncLogRow,
  OrvexVisionResult,
} from '../types/desktop'

type Notify = (msg: string) => void

type Props = {
  onBack: () => void
  notify: Notify
  initialTab?: string | null
}

type Tab = 'overview' | 'teams' | 'vision' | 'assist' | 'jobs' | 'routing' | 'devices' | 'learning' | 'plugins' | 'recovery'

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview & modes' },
  { id: 'teams', label: 'Agent teams' },
  { id: 'vision', label: 'Vision' },
  { id: 'assist', label: 'Context & rules' },
  { id: 'jobs', label: 'Autonomous jobs' },
  { id: 'routing', label: 'Adaptive routing' },
  { id: 'devices', label: 'Devices' },
  { id: 'learning', label: 'Learning' },
  { id: 'plugins', label: 'Plugins & market' },
  { id: 'recovery', label: 'Recovery' },
]

const MODE_INFO: { id: OrvexAdvancedMode; label: string; hint: string }[] = [
  { id: 'cloud', label: 'Cloud', hint: 'Configured order — hosted models may serve every task.' },
  { id: 'local-first', label: 'Local-first', hint: 'Local endpoints are tried first; sensitive tasks never leave the machine.' },
  { id: 'hybrid', label: 'Hybrid', hint: 'Simple prompts stay local; heavy, code and research tasks escalate to cloud first.' },
  { id: 'offline', label: 'Offline', hint: 'Only local endpoints are called. No hosted request is made.' },
]

const CONDITION_TYPES = ['idle_minutes', 'clipboard_contains', 'cpu_above', 'memory_above', 'disk_above', 'time_of_day', 'run_interrupted'] as const
const ACTION_TYPES = ['notify', 'run_workflow', 'run_job', 'run_tool'] as const

type RuleDraft = {
  id?: string
  name: string
  conditionType: (typeof CONDITION_TYPES)[number]
  minutes: string
  text: string
  percent: string
  at: string
  windowMinutes: string
  actionType: (typeof ACTION_TYPES)[number]
  workflowId: string
  jobId: string
  tool: string
  args: string
  cooldownSec: string
}

const EMPTY_RULE: RuleDraft = {
  name: '',
  conditionType: 'idle_minutes',
  minutes: '10',
  text: '',
  percent: '80',
  at: '09:00',
  windowMinutes: '1',
  actionType: 'notify',
  workflowId: '',
  jobId: '',
  tool: '',
  args: '{}',
  cooldownSec: '900',
}

const EMPTY_JOB_STEPS = `[
  { "tool": "window_list", "args": {} },
  { "tool": "system_status", "args": {} },
  { "tool": "clipboard_read", "args": {} }
]`

function msg(err: unknown): string {
  return err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err)
}

async function call<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const res = await promise
  if (!res.ok) throw new Error(res.error)
  return res.data
}

function time(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

function ago(ts: number | null | undefined): string {
  if (!ts) return 'never'
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

function tone(status: string): string {
  if (['done', 'ok', 'enabled', 'approved', 'applied'].includes(status)) return 'ok'
  if (['failed', 'error', 'cancelled', 'denied'].includes(status)) return 'bad'
  if (['running', 'queued', 'paused', 'interrupted'].includes(status)) return 'warn'
  return 'idle'
}

function Card({ title, hint, actions, children }: { title: string; hint?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="adv-card">
      <div className="adv-card-head">
        <span>{title}</span>
        {hint && <span className="adv-hint">{hint}</span>}
        {actions && <div className="adv-actions">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

function Chip({ children, kind }: { children: ReactNode; kind?: string }) {
  return <span className={`adv-chip ${kind ? `adv-chip-${kind}` : ''}`}>{children}</span>
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="adv-empty">{children}</p>
}

function pluginNetworkLabel(permissions: Record<string, unknown> | null): string {
  const value = permissions?.network
  if (value === 'any') return 'unrestricted (declared)'
  if (Array.isArray(value) && value.length) return `allowlist: ${value.join(', ')}`
  return 'blocked'
}

export default function AdvancedPage({ onBack, notify, initialTab }: Props) {
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const { providers, activeId, active } = useProviders()
  const candidates = useMemo(() => orderForTask(buildCandidates(providers, activeId), 'agent'), [providers, activeId])
  const provider = useMemo(() => (active ? toCandidate(active) : undefined), [active])
  const [tab, setTab] = useState<Tab>(() => (TABS.some((t) => t.id === initialTab) ? (initialTab as Tab) : 'overview'))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [eventTick, setEventTick] = useState(0)
  const [approval, setApproval] = useState<{ id: string; tool: string; reason: string } | null>(null)

  const [status, setStatus] = useState<OrvexAdvancedStatus | null>(null)
  const [mode, setMode] = useState<OrvexAdvancedMode | null>(null)

  const [evalGoal, setEvalGoal] = useState('')
  const [evalOutput, setEvalOutput] = useState('')
  const [evalCriteria, setEvalCriteria] = useState('addresses the goal, is complete, is specific')
  const [evalResult, setEvalResult] = useState<OrvexSelfEval | null>(null)
  const [evalHistory, setEvalHistory] = useState<OrvexSelfEval[]>([])

  const [context, setContext] = useState<OrvexAdvancedContext | null>(null)
  const [suggestions, setSuggestions] = useState<{ items: OrvexAdvancedSuggestion[]; method: string; note?: string | null } | null>(null)
  const [rules, setRules] = useState<OrvexProactiveRule[]>([])
  const [ruleEvents, setRuleEvents] = useState<OrvexProactiveRuleEvent[]>([])
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(EMPTY_RULE)
  const [tools, setTools] = useState<{ name: string; description: string }[]>([])

  const [jobs, setJobs] = useState<OrvexAdvancedJob[]>([])
  const [jobTitle, setJobTitle] = useState('')
  const [jobSteps, setJobSteps] = useState(EMPTY_JOB_STEPS)
  const [openJob, setOpenJob] = useState<string | null>(null)

  const [routeTask, setRouteTask] = useState<TaskId>('agent')
  const [routeResult, setRouteResult] = useState<OrvexRouteRecommendResult | null>(null)
  const [routes, setRoutes] = useState<Record<string, OrvexRouteRef[]>>({})
  const [routeStats, setRouteStats] = useState<OrvexRouteStat[]>([])

  const [learning, setLearning] = useState<OrvexLearningSuggestion[]>([])
  const [recovery, setRecovery] = useState<OrvexRecoveryOverview | null>(null)

  const [agents, setAgents] = useState<OrvexCollabAgent[]>([])
  const [caps, setCaps] = useState({ maxAgents: 5, maxRounds: 3 })
  const [agentDraft, setAgentDraft] = useState({ id: '', name: '', role: 'worker', prompt: '' })
  const [sessions, setSessions] = useState<OrvexCollabSession[]>([])
  const [sessionDetail, setSessionDetail] = useState<OrvexCollabSessionDetail | null>(null)
  const [teamGoal, setTeamGoal] = useState('')
  const [teamRounds, setTeamRounds] = useState('2')
  const [teamIds, setTeamIds] = useState<string[]>([])

  const [visionPrompt, setVisionPrompt] = useState('Describe this screen and list the visible controls.')
  const [visionPath, setVisionPath] = useState('')
  const [visionResult, setVisionResult] = useState<OrvexVisionResult | null>(null)

  const [plugins, setPlugins] = useState<OrvexPluginInfo[]>([])
  const [catalogUrl, setCatalogUrl] = useState('')
  const [catalog, setCatalog] = useState<OrvexMarketCatalog | null>(null)
  const [trustedKeys, setTrustedKeys] = useState<OrvexCatalogKey[]>([])
  const [keyDraft, setKeyDraft] = useState('')
  const [requireSignature, setRequireSignature] = useState(false)

  const [device, setDevice] = useState<OrvexDeviceInfo | null>(null)
  const [host, setHost] = useState<OrvexDeviceHostStatus | null>(null)
  const [paired, setPaired] = useState<OrvexDeviceLink[]>([])
  const [syncLog, setSyncLog] = useState<OrvexSyncLogRow[]>([])
  const [deviceName, setDeviceName] = useState('')
  const [hostCode, setHostCode] = useState<{ code: string; expiresAt: number } | null>(null)
  const [pairForm, setPairForm] = useState({ host: '', port: '47821', code: '' })
  const [discovered, setDiscovered] = useState<(OrvexDeviceInfo & { host: string; port: number })[]>([])

  const [a2aState, setA2aState] = useState<OrvexA2aStatus | null>(null)
  const [a2aPortDraft, setA2aPortDraft] = useState('47831')
  const [a2aExpose, setA2aExpose] = useState<'loopback' | 'lan'>('loopback')
  const [peerForm, setPeerForm] = useState({ name: '', url: '', token: '' })
  const [a2aPeer, setA2aPeer] = useState('')
  const [a2aMessage, setA2aMessage] = useState('')
  const [a2aReply, setA2aReply] = useState('')

  const run = useCallback(
    async (label: string, task: () => Promise<void>) => {
      if (busy) return
      setBusy(label)
      setError(null)
      try {
        await task()
      } catch (err) {
        setError(msg(err))
      } finally {
        setBusy(null)
      }
    },
    [busy],
  )

  useEffect(() => {
    if (!bridge) return
    return bridge.advanced.onEvent((event) => {
      if (event.type === 'job-approval') {
        setApproval({
          id: `${String(event.id)}:${Number(event.index) || 0}`,
          tool: String(event.tool || 'tool'),
          reason: String(event.reason || 'This step changes the machine.'),
        })
      }
      setEventTick((n) => n + 1)
    })
  }, [bridge])

  const loadStatus = useCallback(async () => {
    if (!bridge) return
    const data = await call(bridge.advanced.status())
    setStatus(data)
    setMode(data.mode.mode)
  }, [bridge])

  useEffect(() => {
    if (tab !== 'overview' || !bridge) return
    let live = true
    void (async () => {
      try {
        const data = await call(bridge.advanced.status())
        if (!live) return
        setStatus(data)
        setMode(data.mode.mode)
        setEvalHistory(await call(bridge.advanced.evalHistory(10)))
      } catch (err) {
        if (live) setError(msg(err))
      }
    })()
    return () => {
      live = false
    }
  }, [tab, bridge, eventTick])

  useEffect(() => {
    if (tab !== 'assist' || !bridge) return
    let live = true
    void (async () => {
      try {
        const [ctx, ruleData, toolData] = await Promise.all([
          call(bridge.advanced.context()),
          call(bridge.advanced.rules()),
          call(bridge.workflows.tools()),
        ])
        if (!live) return
        setContext(ctx)
        setRules(ruleData.rules)
        setRuleEvents(ruleData.events)
        setTools(toolData.tools.map((t) => ({ name: t.name, description: t.description })))
      } catch (err) {
        if (live) setError(msg(err))
      }
    })()
    return () => {
      live = false
    }
  }, [tab, bridge, eventTick])

  useEffect(() => {
    if (tab !== 'jobs' || !bridge) return
    let live = true
    void (async () => {
      try {
        const rows = await call(bridge.advanced.jobs(40))
        if (live) setJobs(rows)
      } catch (err) {
        if (live) setError(msg(err))
      }
    })()
    return () => {
      live = false
    }
  }, [tab, bridge, eventTick])

  useEffect(() => {
    if (tab !== 'routing' || !bridge) return
    let live = true
    void (async () => {
      try {
        const [data, stats] = await Promise.all([call(bridge.routing.get()), call(bridge.advanced.routeStats(routeTask, 30))])
        if (!live) return
        setRoutes(data.routing)
        setRouteStats(stats)
      } catch (err) {
        if (live) setError(msg(err))
      }
    })()
    return () => {
      live = false
    }
  }, [tab, bridge, eventTick, routeTask])

  useEffect(() => {
    if (tab !== 'learning' || !bridge) return
    let live = true
    void (async () => {
      try {
        const rows = await call(bridge.advanced.learning())
        if (live) setLearning(rows)
      } catch (err) {
        if (live) setError(msg(err))
      }
    })()
    return () => {
      live = false
    }
  }, [tab, bridge, eventTick])

  useEffect(() => {
    if (tab !== 'recovery' || !bridge) return
    let live = true
    void (async () => {
      try {
        const data = await call(bridge.advanced.recovery())
        if (live) setRecovery(data)
      } catch (err) {
        if (live) setError(msg(err))
      }
    })()
    return () => {
      live = false
    }
  }, [tab, bridge, eventTick])

  useEffect(() => {
    if (tab !== 'teams' || !bridge) return
    let live = true
    void (async () => {
      try {
        const [roster, list] = await Promise.all([call(bridge.advanced.collab.agents()), call(bridge.advanced.collab.sessions(20))])
        if (!live) return
        setAgents(roster.agents)
        setCaps(roster.caps)
        setSessions(list)
        setTeamIds((current) => {
          const valid = current.filter((id) => roster.agents.some((a) => a.id === id))
          if (valid.length) return valid
          return roster.agents.filter((a) => a.role !== 'synthesizer').slice(0, 2).map((a) => a.id)
        })
      } catch (err) {
        if (live) setError(msg(err))
      }
    })()
    return () => {
      live = false
    }
  }, [tab, bridge, eventTick])

  useEffect(() => {
    if (tab !== 'teams' || !sessionDetail || !bridge) return
    let live = true
    void (async () => {
      try {
        const detail = await call(bridge.advanced.collab.session(sessionDetail.id))
        if (live && detail) setSessionDetail(detail)
      } catch {
        /* the session may have been deleted */
      }
    })()
    return () => {
      live = false
    }
  }, [tab, bridge, eventTick, sessionDetail?.id])

  useEffect(() => {
    if (tab !== 'devices' || !bridge) return
    let live = true
    void (async () => {
      try {
        const data = await call(bridge.advanced.devices.info())
        if (!live) return
        setDevice(data.device)
        setHost(data.host)
        setHostCode(data.host.code || null)
        setPaired(data.devices)
        setSyncLog(data.log)
        setDeviceName((current) => current || data.device.name)
        const net = await call(bridge.advanced.a2a.status())
        if (live) {
          setA2aState(net)
          setA2aPortDraft(String(net.port))
          setA2aExpose(net.expose)
          setA2aPeer((current) => current || net.peers[0]?.id || '')
        }
      } catch (err) {
        if (live) setError(msg(err))
      }
    })()
    return () => {
      live = false
    }
  }, [tab, bridge, eventTick])

  useEffect(() => {
    if (tab !== 'plugins' || !bridge) return
    let live = true
    void (async () => {
      try {
        const data = await call(bridge.advanced.plugins.list())
        const keys = await call(bridge.advanced.plugins.catalogKeys())
        if (!live) return
        setPlugins(data.plugins)
        setCatalogUrl(data.catalogUrl)
        setTrustedKeys(keys.keys)
        setRequireSignature(keys.requireSignature)
      } catch (err) {
        if (live) setError(msg(err))
      }
    })()
    return () => {
      live = false
    }
  }, [tab, bridge, eventTick])

  if (!bridge) {
    return (
      <PageShell title="Advanced" sub="Only available in the ORVEX desktop app" onBack={onBack}>
        <Empty>Open ORVEX as a desktop app to use autonomous jobs, agent teams, plugins and device sync.</Empty>
      </PageShell>
    )
  }

  const respondApproval = async (allow: boolean) => {
    if (!approval) return
    const id = approval.id
    setApproval(null)
    try {
      await call(bridge.advanced.approve(id, allow))
      notify(allow ? 'Step approved' : 'Step denied')
    } catch (err) {
      setError(msg(err))
    }
  }

  const changeMode = (next: OrvexAdvancedMode) =>
    run('mode', async () => {
      const data = await call(bridge.advanced.mode(next))
      setMode(data.mode)
      notify(`Mode: ${data.mode}`)
      await loadStatus()
    })

  const cancelJob = (id: string) =>
    run(`cancel:${id}`, async () => {
      await call(bridge.advanced.cancelJob(id))
      setJobs(await call(bridge.advanced.jobs(40)))
      notify('Job cancelled')
    })

  const startJob = (id: string) =>
    run(`start:${id}`, async () => {
      await call(bridge.advanced.startJob(id))
      notify('Job started')
      setJobs(await call(bridge.advanced.jobs(40)))
    })

  const resumeJob = (id: string) =>
    run(`resume:${id}`, async () => {
      await call(bridge.advanced.resumeJob(id))
      notify('Job resumed')
      setJobs(await call(bridge.advanced.jobs(40)))
    })

  const pauseJob = (id: string) =>
    run(`pause:${id}`, async () => {
      await call(bridge.advanced.pauseJob(id))
      notify('Job paused after the current step')
      setJobs(await call(bridge.advanced.jobs(40)))
    })

  const modeLocked = busy !== null

  return (
    <PageShell
      title="Advanced"
      sub="Autonomous execution, agent teams, vision, proactive rules, routing, sync, plugins and recovery — all backed by live state"
      onBack={onBack}
      actions={<Chip kind={status?.mode.online ? 'ok' : 'warn'}>{status?.mode.online ? 'online' : 'offline'}</Chip>}
    >
      <div className="adv">
        <div className="settings-tabs adv-tabs" role="tablist" aria-label="Advanced sections" onKeyDown={onTablistKeyDown}>
          {TABS.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              tabIndex={tab === item.id ? 0 : -1}
              className={`settings-tab ${tab === item.id ? 'active' : ''}`}
              onClick={() => {
                setError(null)
                setTab(item.id)
              }}
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

        {approval && (
          <div className="adv-approval" role="alert">
            <ShieldAlert size={16} />
            <div>
              <b>{approval.tool}</b>
              <p>{approval.reason}</p>
            </div>
            <button className="adv-btn adv-btn-primary" onClick={() => void respondApproval(true)}>
              Allow
            </button>
            <button className="adv-btn" onClick={() => void respondApproval(false)}>
              Deny
            </button>
          </div>
        )}

        {tab === 'overview' && (
          <div className="adv-grid">
            <Card title="Privacy & connectivity mode" hint="Applies to every model call, not just this page">
              <div className="adv-modes">
                {MODE_INFO.map((m) => (
                  <button
                    key={m.id}
                    className={`adv-mode ${mode === m.id ? 'active' : ''}`}
                    disabled={modeLocked}
                    onClick={() => void changeMode(m.id)}
                  >
                    <span className="adv-mode-label">{m.label}</span>
                    <span className="adv-mode-hint">{m.hint}</span>
                    {mode === m.id && <Chip kind="ok">active</Chip>}
                  </button>
                ))}
              </div>
              <p className="adv-note">
                Local-first, hybrid and offline filter the candidate chain in the main process. Offline refuses hosted endpoints entirely — if no local
                model is configured, the request is refused instead of silently going to the cloud.
              </p>
            </Card>

            <Card
              title="Live status"
              hint={status ? `updated ${ago(status.mode.updatedAt)}` : 'loading'}
              actions={
                <button className="adv-btn" disabled={busy !== null} onClick={() => void run('status', loadStatus)}>
                  <RefreshCw size={12} /> Refresh
                </button>
              }
            >
              {!status ? (
                <Empty>Reading the advanced store…</Empty>
              ) : (
                <>
                  <div className="adv-tiles">
                    <div className="adv-tile"><span>Rules</span><b>{status.rules}</b><small>{status.rulesFired} fired</small></div>
                    <div className="adv-tile"><span>Jobs</span><b>{status.jobs}</b><small>{status.interruptedJobs} need attention</small></div>
                    <div className="adv-tile"><span>Suggestions</span><b>{status.suggestions}</b><small>personal workflow learning</small></div>
                    <div className="adv-tile"><span>Self-evals</span><b>{status.selfEvals}</b><small>stored reviews</small></div>
                  </div>
                  <div className="adv-kv">
                    <span>Mode</span><b>{status.mode.mode}</b>
                    <span>Hosted allowed</span><b>{status.mode.hostedAllowed ? 'yes' : 'no'}</b>
                    <span>Local only</span><b>{status.mode.localOnly ? 'yes' : 'no'}</b>
                    <span>Last rule tick</span><b>{status.lastTick ? `${ago(status.lastTick.at)} · ${status.lastTick.fired} fired / ${status.lastTick.rules} rules` : 'not run yet'}</b>
                  </div>
                  <button className="adv-btn" disabled={busy !== null} onClick={() => void run('tick', async () => { await call(bridge.advanced.tickRules()); await loadStatus() })}>
                    <Zap size={12} /> Evaluate proactive rules now
                  </button>
                </>
              )}
            </Card>

            <Card title="Self-evaluation" hint="Scores the actual output against your criteria — model review when configured, deterministic checks otherwise">
              <label className="adv-field">
                <span>Goal</span>
                <input className="adv-input" value={evalGoal} onChange={(e) => setEvalGoal(e.target.value)} placeholder="What the output was supposed to achieve" />
              </label>
              <label className="adv-field">
                <span>Output</span>
                <textarea className="adv-input adv-textarea" rows={5} value={evalOutput} onChange={(e) => setEvalOutput(e.target.value)} placeholder="Paste the answer, report or plan to review" />
              </label>
              <label className="adv-field">
                <span>Criteria (comma separated)</span>
                <input className="adv-input" value={evalCriteria} onChange={(e) => setEvalCriteria(e.target.value)} />
              </label>
              <button
                className="adv-btn adv-btn-primary"
                disabled={busy !== null || !evalOutput.trim()}
                onClick={() =>
                  void run('eval', async () => {
                    const data = await call(
                      bridge.advanced.selfEval({
                        goal: evalGoal,
                        output: evalOutput,
                        criteria: evalCriteria.split(',').map((c) => c.trim()).filter(Boolean),
                        provider,
                        candidates,
                      }),
                    )
                    setEvalResult(data)
                    setEvalHistory(await call(bridge.advanced.evalHistory(10)))
                  })
                }
              >
                {busy === 'eval' ? <Loader2 size={13} className="adv-spin" /> : <Sparkles size={13} />} Evaluate output
              </button>
              {evalResult && (
                <div className="adv-eval">
                  <div className={`adv-score ${evalResult.score >= 0.75 ? 'ok' : evalResult.score >= 0.45 ? 'warn' : 'bad'}`}>
                    {Math.round(evalResult.score * 100)}%
                  </div>
                  <div>
                    <b>{evalResult.method === 'model' ? 'Model review' : 'Deterministic review'}</b>
                    <small>{evalResult.model || 'No model configured — local checks only'}</small>
                  </div>
                  <ul>
                    {(evalResult.verdicts || []).map((v, i) => (
                      <li key={i} className={v.pass ? 'ok' : 'bad'}>
                        {v.pass ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {v.criterion} — {v.reason}
                      </li>
                    ))}
                  </ul>
                  {evalResult.issues && evalResult.issues.length > 0 && <p className="adv-note">Issues: {evalResult.issues.join(' · ')}</p>}
                  {evalResult.note && <p className="adv-note">{evalResult.note}</p>}
                </div>
              )}
              {evalHistory.length > 0 && (
                <div className="adv-table">
                  <div className="adv-tr adv-th"><span>When</span><span>Goal</span><span>Score</span><span>Model</span></div>
                  {evalHistory.map((row) => (
                    <div key={row.id} className="adv-tr">
                      <span>{time(row.createdAt)}</span>
                      <span className="adv-clip">{row.goal}</span>
                      <span>{Math.round(row.score * 100)}%</span>
                      <span className="adv-clip">{row.model || 'local checks'}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}

        {tab === 'teams' && (
          <div className="adv-grid">
            <Card title="Agent roster" hint={`${agents.length} agent(s) · max ${caps.maxAgents} per session`}>
              {agents.length === 0 ? (
                <Empty>No agents yet. The backend seeds planner, researcher, builder, critic and synthesizer on first boot.</Empty>
              ) : (
                <div className="adv-list">
                  {agents.map((agent) => (
                    <div key={agent.id} className="adv-row">
                      <div className="adv-row-main">
                        <b>
                          {agent.name} {agent.builtin && <Chip>built-in</Chip>} <Chip>{agent.role}</Chip>
                        </b>
                        <small className="adv-clip">{agent.prompt}</small>
                      </div>
                      <div className="adv-row-actions">
                        <button
                          className="adv-icon"
                          title="Edit agent"
                          onClick={() =>
                            setAgentDraft({ id: agent.id, name: agent.name, role: agent.role, prompt: agent.prompt })
                          }
                        >
                          <Layers size={13} />
                        </button>
                        <button
                          className="adv-icon"
                          title="Delete agent"
                          onClick={() =>
                            void run(`agent-del:${agent.id}`, async () => {
                              await call(bridge.advanced.collab.deleteAgent(agent.id))
                              const roster = await call(bridge.advanced.collab.agents())
                              setAgents(roster.agents)
                              notify('Agent deleted')
                            })
                          }
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="adv-form">
                <div className="adv-row-2">
                  <label className="adv-field">
                    <span>Name</span>
                    <input className="adv-input" value={agentDraft.name} onChange={(e) => setAgentDraft({ ...agentDraft, name: e.target.value })} />
                  </label>
                  <label className="adv-field">
                    <span>Role</span>
                    <input className="adv-input" value={agentDraft.role} onChange={(e) => setAgentDraft({ ...agentDraft, role: e.target.value })} placeholder="planner, researcher, builder…" />
                  </label>
                </div>
                <label className="adv-field">
                  <span>System prompt (20+ characters)</span>
                  <textarea className="adv-input adv-textarea" rows={4} value={agentDraft.prompt} onChange={(e) => setAgentDraft({ ...agentDraft, prompt: e.target.value })} />
                </label>
                <div className="adv-toolbar">
                  <button
                    className="adv-btn adv-btn-primary"
                    disabled={busy !== null}
                    onClick={() =>
                      void run('agent-save', async () => {
                        await call(bridge.advanced.collab.saveAgent(agentDraft))
                        const roster = await call(bridge.advanced.collab.agents())
                        setAgents(roster.agents)
                        setAgentDraft({ id: '', name: '', role: 'worker', prompt: '' })
                        notify('Agent saved')
                      })
                    }
                  >
                    <Plus size={13} /> {agentDraft.id ? 'Update agent' : 'Add agent'}
                  </button>
                  {agentDraft.id && (
                    <button className="adv-btn" onClick={() => setAgentDraft({ id: '', name: '', role: 'worker', prompt: '' })}>
                      Cancel edit
                    </button>
                  )}
                </div>
              </div>
            </Card>

            <Card title="Start a team session" hint={`max ${caps.maxRounds} rounds`}>
              <label className="adv-field">
                <span>Goal</span>
                <textarea className="adv-input adv-textarea" rows={3} value={teamGoal} onChange={(e) => setTeamGoal(e.target.value)} placeholder="What should the team deliver?" />
              </label>
              <label className="adv-field">
                <span>Rounds</span>
                <input className="adv-input" type="number" min={1} max={caps.maxRounds} value={teamRounds} onChange={(e) => setTeamRounds(e.target.value)} />
              </label>
              <div className="adv-field">
                <span>Agents</span>
                <div className="adv-checks">
                  {agents.map((agent) => (
                    <label key={agent.id} className="adv-check">
                      <input
                        type="checkbox"
                        checked={teamIds.includes(agent.id)}
                        disabled={agent.role === 'synthesizer'}
                        onChange={(e) =>
                          setTeamIds((current) => (e.target.checked ? [...current, agent.id] : current.filter((id) => id !== agent.id)))
                        }
                      />
                      {agent.name}
                    </label>
                  ))}
                </div>
                <p className="adv-note">The synthesizer always runs last and merges the workers' findings. Sensitive mode keeps every call on local models.</p>
              </div>
              <button
                className="adv-btn adv-btn-primary"
                disabled={busy !== null || !teamGoal.trim() || teamIds.length === 0}
                onClick={() =>
                  void run('team-start', async () => {
                    const session = await call(
                      bridge.advanced.collab.start({ goal: teamGoal, agentIds: teamIds, rounds: Number(teamRounds), provider, candidates }),
                    )
                    setSessions(await call(bridge.advanced.collab.sessions(20)))
                    setSessionDetail(await call(bridge.advanced.collab.session(session.id)))
                    notify('Team session started')
                  })
                }
              >
                {busy === 'team-start' ? <Loader2 size={13} className="adv-spin" /> : <Users size={13} />} Start collaboration
              </button>
            </Card>

            <Card title="Sessions" hint="live messages arrive through the event stream">
              {sessions.length === 0 ? (
                <Empty>No collaboration sessions yet.</Empty>
              ) : (
                <div className="adv-list">
                  {sessions.map((session) => (
                    <div key={session.id} className="adv-row">
                      <button className="adv-row-main adv-row-button" onClick={() => void run('session-open', async () => setSessionDetail(await call(bridge.advanced.collab.session(session.id))))}>
                        <b className="adv-clip">{session.goal}</b>
                        <small>
                          {session.agents.length} agents · {session.rounds} rounds · {time(session.createdAt)}
                        </small>
                      </button>
                      <div className="adv-row-actions">
                        <Chip kind={tone(session.status)}>{session.status}</Chip>
                        {session.status === 'running' && (
                          <button className="adv-icon" title="Stop session" onClick={() => void run(`session-stop:${session.id}`, async () => { await call(bridge.advanced.collab.stop(session.id)); setSessions(await call(bridge.advanced.collab.sessions(20))) })}>
                            <Square size={13} />
                          </button>
                        )}
                        <button className="adv-icon" title="Delete session" onClick={() => void run(`session-del:${session.id}`, async () => { await call(bridge.advanced.collab.deleteSession(session.id)); setSessions(await call(bridge.advanced.collab.sessions(20))); if (sessionDetail?.id === session.id) setSessionDetail(null) })}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {sessionDetail && (
                <div className="adv-transcript">
                  <div className="adv-transcript-head">
                    <b>{sessionDetail.goal}</b>
                    <Chip kind={tone(sessionDetail.status)}>{sessionDetail.status}</Chip>
                  </div>
                  {sessionDetail.messages.length === 0 ? (
                    <Empty>Waiting for the first agent message…</Empty>
                  ) : (
                    sessionDetail.messages.map((m, i) => (
                      <div key={i} className="adv-message">
                        <span className="adv-message-head">
                          <b>{m.agent}</b> <Chip>{m.role}</Chip> <small>round {m.round} · {ago(m.at)}</small>
                        </span>
                        <p>{m.text}</p>
                      </div>
                    ))
                  )}
                  {sessionDetail.result && (
                    <div className="adv-message adv-message-final">
                      <span className="adv-message-head"><b>Synthesized result</b></span>
                      <p>{sessionDetail.result}</p>
                    </div>
                  )}
                  {sessionDetail.error && <p className="adv-error">{sessionDetail.error}</p>}
                </div>
              )}
            </Card>
          </div>
        )}

        {tab === 'vision' && (
          <div className="adv-grid">
            <Card title="Computer-vision agent" hint="real screen capture + Windows OCR + a multimodal model when configured">
              <label className="adv-field">
                <span>Prompt</span>
                <textarea className="adv-input adv-textarea" rows={3} value={visionPrompt} onChange={(e) => setVisionPrompt(e.target.value)} />
              </label>
              <label className="adv-field">
                <span>Image path (optional — leave empty to capture the screen)</span>
                <div className="adv-row-2">
                  <input className="adv-input" value={visionPath} onChange={(e) => setVisionPath(e.target.value)} placeholder="C:\\path\\image.png" />
                  <button
                    className="adv-btn"
                    disabled={busy !== null}
                    onClick={() =>
                      void run('vision-pick', async () => {
                        const picked = await call(bridge.files.pickFile([{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]))
                        if (!picked.cancelled && picked.path) setVisionPath(picked.path)
                      })
                    }
                  >
                    <FolderDown size={13} /> Pick
                  </button>
                </div>
              </label>
              <div className="adv-toolbar">
                <button
                  className="adv-btn adv-btn-primary"
                  disabled={busy !== null}
                  onClick={() =>
                    void run('vision-analyze', async () => {
                      const data = await call(
                        bridge.advanced.vision.analyze({
                          prompt: visionPrompt,
                          path: visionPath.trim() || undefined,
                          provider,
                          candidates,
                        }),
                      )
                      setVisionResult(data)
                    })
                  }
                >
                  {busy === 'vision-analyze' ? <Loader2 size={13} className="adv-spin" /> : <Camera size={13} />} {visionPath.trim() ? 'Analyze image' : 'Capture & analyze screen'}
                </button>
                <button
                  className="adv-btn"
                  disabled={busy !== null}
                  onClick={() =>
                    void run('vision-ocr', async () => {
                      const ocr = await call(bridge.advanced.vision.ocr(visionPath.trim() ? { path: visionPath.trim() } : {}))
                      setVisionResult({
                        source: visionPath.trim() ? 'file' : 'screen',
                        file: ocr.file,
                        mime: 'image/png',
                        bytes: 0,
                        width: ocr.width,
                        height: ocr.height,
                        url: ocr.url,
                        ocr: { ...ocr, text: ocr.text, lines: ocr.lines as never },
                        ocrError: null,
                        analysis: null,
                        model: null,
                        note: 'OCR only — no model was called.',
                      })
                    })
                  }
                >
                  <ScanText size={13} /> Read text (OCR)
                </button>
              </div>
              <p className="adv-note">
                OCR runs locally through Windows. Model descriptions require a multimodal provider; without one the OCR text is returned with an explicit note
                instead of a fabricated description.
              </p>
            </Card>

            <Card title="Result" hint={visionResult?.model || 'no model yet'}>
              {!visionResult ? (
                <Empty>Capture the screen or pick an image, then analyze it.</Empty>
              ) : (
                <div className="adv-vision">
                  {visionResult.url && <img className="adv-vision-image" src={visionResult.url} alt="Analyzed capture" />}
                  <div className="adv-kv">
                    <span>Source</span><b>{visionResult.source}</b>
                    <span>Image</span><b className="adv-clip">{visionResult.file || '—'}</b>
                    <span>Size</span><b>{visionResult.width ? `${visionResult.width}×${visionResult.height}` : '—'}</b>
                    <span>Model</span><b>{visionResult.model || 'not configured'}</b>
                  </div>
                  {visionResult.note && <p className="adv-note">{visionResult.note}</p>}
                  {visionResult.ocrError && <p className="adv-note">OCR error: {visionResult.ocrError}</p>}
                  {visionResult.ocr && visionResult.ocr.text && (
                    <div>
                      <b className="adv-label">OCR text</b>
                      <pre className="adv-pre">{visionResult.ocr.text}</pre>
                    </div>
                  )}
                  {visionResult.analysis && (
                    <div>
                      <b className="adv-label">Model analysis</b>
                      <pre className="adv-pre">{visionResult.analysis}</pre>
                    </div>
                  )}
                </div>
              )}
            </Card>
          </div>
        )}

        {tab === 'assist' && (
          <div className="adv-grid">
            <Card
              title="Context snapshot"
              hint="live window, clipboard, metrics and interrupted work"
              actions={
                <button
                  className="adv-btn"
                  disabled={busy !== null}
                  onClick={() => void run('context', async () => setContext(await call(bridge.advanced.context())))}
                >
                  <RefreshCw size={12} /> Refresh
                </button>
              }
            >
              {!context ? (
                <Empty>Reading the current context…</Empty>
              ) : (
                <>
                  <div className="adv-kv">
                    <span>Mode</span><b>{context.mode}</b>
                    <span>Foreground window</span><b className="adv-clip">{context.activeWindow ? context.activeWindow.title : context.windowError || 'unavailable'}</b>
                    <span>Clipboard</span><b className="adv-clip">{context.clipboard ? context.clipboard.kind : context.clipboardError || 'empty'}</b>
                    <span>CPU</span><b>{context.metrics?.cpuPercent != null ? `${Math.round(context.metrics.cpuPercent)}%` : '—'}</b>
                    <span>Memory</span><b>{context.metrics?.memoryPercent != null ? `${context.metrics.memoryPercent}%` : '—'}</b>
                    <span>Disk</span><b>{context.metrics?.diskPercent != null ? `${context.metrics.diskPercent}%` : '—'}</b>
                    <span>Interrupted jobs</span><b>{context.interrupted}</b>
                  </div>
                  {context.clipboard && context.clipboard.text && <pre className="adv-pre adv-pre-short">{context.clipboard.text.slice(0, 600)}</pre>}
                  <button
                    className="adv-btn adv-btn-primary"
                    disabled={busy !== null}
                    onClick={() =>
                      void run('suggest', async () => {
                        const data = await call(bridge.advanced.suggest({ provider, candidates }))
                        setSuggestions({ items: data.suggestions, method: data.method, note: data.note || null })
                      })
                    }
                  >
                    {busy === 'suggest' ? <Loader2 size={13} className="adv-spin" /> : <Sparkles size={13} />} Suggest next actions
                  </button>
                  {suggestions && (
                    <div className="adv-suggestions">
                      <p className="adv-note">
                        Source: {suggestions.method === 'model' ? 'model + local rules' : 'local rules'}
                        {suggestions.note ? ` — ${suggestions.note}` : ''}
                      </p>
                      {suggestions.items.length === 0 ? (
                        <Empty>No suggestion matched the current signals.</Empty>
                      ) : (
                        suggestions.items.map((s) => (
                          <div key={s.id} className="adv-row">
                            <div className="adv-row-main">
                              <b>{s.title}</b>
                              <small>{s.why}</small>
                            </div>
                            {s.action.page && (
                              <button className="adv-btn" onClick={() => void bridge.app.window('navigate', { id: String(s.action.page) })}>
                                Open
                              </button>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </>
              )}
            </Card>

            <Card title="Proactive rules" hint={`${rules.length} rule(s) · ticker every 30s`}>
              {rules.length === 0 ? (
                <Empty>No proactive rules yet. Add one below — nothing fires until you create it.</Empty>
              ) : (
                <div className="adv-list">
                  {rules.map((rule) => (
                    <div key={rule.id} className="adv-row">
                      <div className="adv-row-main">
                        <b>
                          {rule.name} <Chip kind={rule.enabled ? 'ok' : 'idle'}>{rule.enabled ? 'enabled' : 'disabled'}</Chip>
                        </b>
                        <small>
                          when <code>{rule.condition.type}</code> → <code>{rule.action.type}</code> · cooldown {rule.cooldownSec}s · fired {rule.firedCount}× · last {ago(rule.lastFired)}
                        </small>
                      </div>
                      <div className="adv-row-actions">
                        <button
                          className="adv-btn"
                          onClick={() =>
                            void run(`rule-toggle:${rule.id}`, async () => {
                              await call(bridge.advanced.enableRule(rule.id, !rule.enabled))
                              const data = await call(bridge.advanced.rules())
                              setRules(data.rules)
                            })
                          }
                        >
                          {rule.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          className="adv-icon"
                          title="Delete rule"
                          onClick={() =>
                            void run(`rule-del:${rule.id}`, async () => {
                              await call(bridge.advanced.deleteRule(rule.id))
                              const data = await call(bridge.advanced.rules())
                              setRules(data.rules)
                            })
                          }
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="adv-form">
                <label className="adv-field">
                  <span>Rule name</span>
                  <input className="adv-input" value={ruleDraft.name} onChange={(e) => setRuleDraft({ ...ruleDraft, name: e.target.value })} />
                </label>
                <div className="adv-row-2">
                  <label className="adv-field">
                    <span>Condition</span>
                    <select className="adv-input" value={ruleDraft.conditionType} onChange={(e) => setRuleDraft({ ...ruleDraft, conditionType: e.target.value as RuleDraft['conditionType'] })}>
                      {CONDITION_TYPES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </label>
                  {ruleDraft.conditionType === 'idle_minutes' && (
                    <label className="adv-field"><span>Idle minutes</span><input className="adv-input" type="number" min={1} value={ruleDraft.minutes} onChange={(e) => setRuleDraft({ ...ruleDraft, minutes: e.target.value })} /></label>
                  )}
                  {ruleDraft.conditionType === 'clipboard_contains' && (
                    <label className="adv-field"><span>Text</span><input className="adv-input" value={ruleDraft.text} onChange={(e) => setRuleDraft({ ...ruleDraft, text: e.target.value })} /></label>
                  )}
                  {(['cpu_above', 'memory_above', 'disk_above'] as string[]).includes(ruleDraft.conditionType) && (
                    <label className="adv-field"><span>Percent</span><input className="adv-input" type="number" min={1} max={100} value={ruleDraft.percent} onChange={(e) => setRuleDraft({ ...ruleDraft, percent: e.target.value })} /></label>
                  )}
                  {ruleDraft.conditionType === 'time_of_day' && (
                    <>
                      <label className="adv-field"><span>At (HH:MM)</span><input className="adv-input" value={ruleDraft.at} onChange={(e) => setRuleDraft({ ...ruleDraft, at: e.target.value })} /></label>
                      <label className="adv-field"><span>Window (minutes)</span><input className="adv-input" type="number" min={1} value={ruleDraft.windowMinutes} onChange={(e) => setRuleDraft({ ...ruleDraft, windowMinutes: e.target.value })} /></label>
                    </>
                  )}
                </div>
                <div className="adv-row-2">
                  <label className="adv-field">
                    <span>Action</span>
                    <select className="adv-input" value={ruleDraft.actionType} onChange={(e) => setRuleDraft({ ...ruleDraft, actionType: e.target.value as RuleDraft['actionType'] })}>
                      {ACTION_TYPES.map((a) => <option key={a} value={a}>{a}</option>)}
                    </select>
                  </label>
                  {ruleDraft.actionType === 'run_workflow' && (
                    <label className="adv-field"><span>Workflow id</span><input className="adv-input" value={ruleDraft.workflowId} onChange={(e) => setRuleDraft({ ...ruleDraft, workflowId: e.target.value })} placeholder="wf_…" /></label>
                  )}
                  {ruleDraft.actionType === 'run_job' && (
                    <label className="adv-field"><span>Job id</span><input className="adv-input" value={ruleDraft.jobId} onChange={(e) => setRuleDraft({ ...ruleDraft, jobId: e.target.value })} placeholder="job_…" /></label>
                  )}
                  {ruleDraft.actionType === 'run_tool' && (
                    <label className="adv-field">
                      <span>Read-only tool</span>
                      <select className="adv-input" value={ruleDraft.tool} onChange={(e) => setRuleDraft({ ...ruleDraft, tool: e.target.value })}>
                        <option value="">pick a tool…</option>
                        {tools.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                      </select>
                    </label>
                  )}
                  <label className="adv-field"><span>Cooldown (seconds)</span><input className="adv-input" type="number" min={30} value={ruleDraft.cooldownSec} onChange={(e) => setRuleDraft({ ...ruleDraft, cooldownSec: e.target.value })} /></label>
                </div>
                {ruleDraft.actionType === 'run_tool' && (
                  <label className="adv-field">
                    <span>Tool args (JSON)</span>
                    <textarea className="adv-input adv-textarea" rows={3} value={ruleDraft.args} onChange={(e) => setRuleDraft({ ...ruleDraft, args: e.target.value })} />
                  </label>
                )}
                <button
                  className="adv-btn adv-btn-primary"
                  disabled={busy !== null || !ruleDraft.name.trim()}
                  onClick={() =>
                    void run('rule-save', async () => {
                      const condition: Record<string, unknown> =
                        ruleDraft.conditionType === 'idle_minutes'
                          ? { type: 'idle_minutes', minutes: Number(ruleDraft.minutes) }
                          : ruleDraft.conditionType === 'clipboard_contains'
                            ? { type: 'clipboard_contains', text: ruleDraft.text }
                            : ['cpu_above', 'memory_above', 'disk_above'].includes(ruleDraft.conditionType)
                              ? { type: ruleDraft.conditionType, percent: Number(ruleDraft.percent) }
                              : ruleDraft.conditionType === 'time_of_day'
                                ? { type: 'time_of_day', at: ruleDraft.at, windowMinutes: Number(ruleDraft.windowMinutes) }
                                : { type: 'run_interrupted' }
                      const action: Record<string, unknown> =
                        ruleDraft.actionType === 'run_workflow'
                          ? { type: 'run_workflow', workflowId: ruleDraft.workflowId }
                          : ruleDraft.actionType === 'run_job'
                            ? { type: 'run_job', jobId: ruleDraft.jobId }
                            : ruleDraft.actionType === 'run_tool'
                              ? { type: 'run_tool', tool: ruleDraft.tool, args: JSON.parse(ruleDraft.args || '{}') }
                              : { type: 'notify' }
                      await call(
                        bridge.advanced.saveRule({
                          name: ruleDraft.name,
                          condition: condition as OrvexProactiveRule['condition'],
                          action: action as OrvexProactiveRule['action'],
                          enabled: true,
                          cooldownSec: Number(ruleDraft.cooldownSec),
                        }),
                      )
                      const data = await call(bridge.advanced.rules())
                      setRules(data.rules)
                      setRuleDraft(EMPTY_RULE)
                      notify('Rule saved')
                    })
                  }
                >
                  <Plus size={13} /> Add rule
                </button>
                <p className="adv-note">Proactive actions only run read-only tools. Mutating tools are refused by the backend, and every fire is recorded in the audit trail.</p>
              </div>

              <div>
                <b className="adv-label">Recent rule events</b>
                {ruleEvents.length === 0 ? (
                  <Empty>No rule has fired yet.</Empty>
                ) : (
                  <div className="adv-table">
                    <div className="adv-tr adv-th"><span>When</span><span>Rule</span><span>OK</span><span>Detail</span></div>
                    {ruleEvents.map((e) => (
                      <div key={e.id} className="adv-tr">
                        <span>{ago(e.at)}</span>
                        <span className="adv-clip">{rules.find((r) => r.id === e.ruleId)?.name || e.ruleId}</span>
                        <span>{e.ok ? 'yes' : 'no'}</span>
                        <span className="adv-clip">{e.detail}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          </div>
        )}

        {tab === 'jobs' && (
          <div className="adv-grid">
            <Card title="Autonomous job builder" hint="bounded steps · per-step approval · checkpoint after every step">
              <label className="adv-field">
                <span>Title</span>
                <input className="adv-input" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="Nightly maintenance" />
              </label>
              <label className="adv-field">
                <span>Steps (JSON array, max 50)</span>
                <textarea className="adv-input adv-textarea adv-mono" rows={8} value={jobSteps} onChange={(e) => setJobSteps(e.target.value)} />
              </label>
              <div className="adv-toolbar">
                <button
                  className="adv-btn adv-btn-primary"
                  disabled={busy !== null}
                  onClick={() =>
                    void run('job-create', async () => {
                      const steps = JSON.parse(jobSteps) as { tool: string; args: Record<string, unknown>; label?: string }[]
                      if (!Array.isArray(steps)) throw new Error('Steps must be a JSON array.')
                      await call(bridge.advanced.createJob({ title: jobTitle.trim() || undefined, steps: steps.map((s) => ({ ...s, args: s.args || {} })), stopOnError: true }))
                      setJobs(await call(bridge.advanced.jobs(40)))
                      notify('Job saved')
                    })
                  }
                >
                  <Plus size={13} /> Save job
                </button>
                <button className="adv-btn" onClick={() => setJobSteps(EMPTY_JOB_STEPS)}>
                  <ListChecks size={13} /> Read-only template
                </button>
              </div>
              <p className="adv-note">
                Jobs run inside the same permission engine as the agent. A step that needs approval pauses the job and asks here; denying it fails the job honestly.
                Each completed step is checkpointed so a restart can resume it.
              </p>
            </Card>

            <Card title="Jobs" hint={`${jobs.length} stored`}>
              {jobs.length === 0 ? (
                <Empty>No jobs yet. Save one above, then start it.</Empty>
              ) : (
                <div className="adv-list">
                  {jobs.map((job) => (
                    <div key={job.id} className="adv-job">
                      <div className="adv-row">
                        <div className="adv-row-main">
                          <b>
                            {job.title} <Chip kind={tone(job.status)}>{job.status}</Chip>
                          </b>
                          <small>
                            {job.checkpoint}/{job.spec.steps.length} steps · created {ago(job.createdAt)} · {job.id}
                          </small>
                        </div>
                        <div className="adv-row-actions">
                          {['queued', 'interrupted', 'failed'].includes(job.status) && (
                            <button className="adv-btn" disabled={busy !== null} onClick={() => void startJob(job.id)}><Play size={11} /> Start</button>
                          )}
                          {job.status === 'running' && (
                            <button className="adv-btn" disabled={busy !== null} onClick={() => void pauseJob(job.id)}><CircleDashed size={11} /> Pause</button>
                          )}
                          {job.status === 'paused' && (
                            <button className="adv-btn" disabled={busy !== null} onClick={() => void resumeJob(job.id)}><Play size={11} /> Resume</button>
                          )}
                          {['running', 'paused', 'queued'].includes(job.status) && (
                            <button className="adv-btn" disabled={busy !== null} onClick={() => void cancelJob(job.id)}><Square size={11} /> Cancel</button>
                          )}
                          <button className="adv-icon" title="Show steps" onClick={() => setOpenJob(openJob === job.id ? null : job.id)}>
                            <Layers size={13} />
                          </button>
                          <button
                            className="adv-icon"
                            title="Delete job"
                            onClick={() =>
                              void run(`job-del:${job.id}`, async () => {
                                await call(bridge.advanced.deleteJob(job.id))
                                setJobs(await call(bridge.advanced.jobs(40)))
                              })
                            }
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                      {openJob === job.id && (
                        <div className="adv-job-steps">
                          {job.spec.steps.map((step, index) => {
                            const result = job.results.find((r) => r.index === index)
                            return (
                              <div key={index} className={`adv-step ${result ? (result.ok ? 'ok' : 'bad') : ''}`}>
                                <span>{index + 1}</span>
                                <b>{step.label || step.tool}</b>
                                <code>{JSON.stringify(step.args).slice(0, 120)}</code>
                                <small>{result ? (result.ok ? `${result.ms}ms` : result.error) : 'not run'}</small>
                              </div>
                            )
                          })}
                          {job.error && <p className="adv-error">{job.error}</p>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <p className="adv-note">Stop conditions: the step limit, per-step approval, the emergency stop and the app quitting. No job can run unbounded.</p>
            </Card>
          </div>
        )}

        {tab === 'routing' && (
          <div className="adv-grid">
            <Card title="Adaptive model routing" hint="capability 55% · measured reliability 30% · latency 15%">
              <div className="adv-row-2">
                <label className="adv-field">
                  <span>Task</span>
                  <select className="adv-input" value={routeTask} onChange={(e) => { setRouteTask(e.target.value as TaskId); setRouteResult(null) }}>
                    {TASKS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                </label>
                <div className="adv-field">
                  <span>&nbsp;</span>
                  <button
                    className="adv-btn adv-btn-primary"
                    disabled={busy !== null}
                    onClick={() =>
                      void run('route-recommend', async () => {
                        const data = await call(bridge.advanced.recommendRoute({ task: routeTask, provider, candidates }))
                        setRouteResult(data)
                      })
                    }
                  >
                    {busy === 'route-recommend' ? <Loader2 size={13} className="adv-spin" /> : <Route size={13} />} Rank candidates
                  </button>
                </div>
              </div>
              <p className="adv-note">
                Reliability and latency come from real gateway calls recorded in SQLite. With no measured calls yet, capability alone drives the ordering — the
                reason lines say so.
              </p>
              {!routeResult ? (
                <Empty>Pick a task and rank the providers configured in Settings.</Empty>
              ) : routeResult.ranked.length === 0 ? (
                <Empty>{routeResult.note || 'No provider matched this task.'}</Empty>
              ) : (
                <div className="adv-list">
                  {routeResult.ranked.map((row, index) => (
                    <div key={`${row.id}-${row.model}`} className="adv-row">
                      <div className="adv-row-main">
                        <b>#{index + 1} {row.name} · {row.model}</b>
                        <small>{row.reasons.join(' · ')}</small>
                      </div>
                      <Chip kind="ok">{Math.round(row.score * 100)}%</Chip>
                    </div>
                  ))}
                </div>
              )}
              {routeResult && routeResult.ranked.length > 0 && (
                <button
                  className="adv-btn"
                  disabled={busy !== null}
                  onClick={() =>
                    void run('route-apply', async () => {
                      const chain = routeResult.ranked.map((r) => ({ id: r.id, model: r.model }))
                      const saved = await persistRoute(routeTask, chain)
                      if (!saved.ok) throw new Error(saved.error || 'Could not save the route.')
                      const data = await call(bridge.routing.get())
                      setRoutes(data.routing)
                      notify(`Route saved for ${routeTask}`)
                    })
                  }
                >
                  <Download size={13} /> Apply this chain to {routeTask}
                </button>
              )}
            </Card>

            <Card title="Saved chains" hint="SQLite is authoritative; the renderer mirrors it for the send path">
              {Object.keys(routes).filter((key) => routes[key]?.length).length === 0 ? (
                <Empty>No custom route is saved. Every task uses the configured provider order.</Empty>
              ) : (
                <div className="adv-list">
                  {Object.entries(routes).filter(([, chain]) => chain && chain.length).map(([task, chain]) => (
                    <div key={task} className="adv-row">
                      <div className="adv-row-main">
                        <b>{task}</b>
                        <small className="adv-clip">{chain!.map((c) => `${c.providerId || c.id || ''} · ${c.model || ''}`).join(' → ')}</small>
                      </div>
                      <button
                        className="adv-btn"
                        onClick={() =>
                          void run(`route-clear:${task}`, async () => {
                            await clearServerRoute(task as TaskId)
                            const data = await call(bridge.routing.get())
                            setRoutes(data.routing)
                            notify(`Cleared ${task}`)
                          })
                        }
                      >
                        Clear
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <b className="adv-label">Measured outcomes · {routeTask} · last 30 days</b>
              {routeStats.length === 0 ? (
                <Empty>No gateway call has been measured for {routeTask} yet.</Empty>
              ) : (
                <div className="adv-table">
                  <div className="adv-tr adv-th"><span>Provider</span><span>Model</span><span>Calls</span><span>OK</span><span>p50</span></div>
                  {routeStats.map((row) => (
                    <div key={`${row.providerId}-${row.model}`} className="adv-tr">
                      <span className="adv-clip">{row.providerId || '—'}</span>
                      <span className="adv-clip">{row.model}</span>
                      <span>{row.calls}</span>
                      <span>{row.okRate == null ? '—' : `${Math.round(row.okRate * 100)}%`}</span>
                      <span>{row.p50Ms == null ? '—' : `${row.p50Ms}ms`}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="adv-kv">
                <span>Saved tasks</span><b>{new Set(Object.keys(routes)).size}</b>
                <span>Providers available</span><b>{candidates.length}</b>
                <span>Active provider</span><b>{active ? `${active.name} · ${active.model}` : 'none'}</b>
              </div>
            </Card>
          </div>
        )}

        {tab === 'devices' && (
          <div className="adv-grid">
            <Card title="This device" hint={device ? `${device.platform} · v${device.version}` : 'loading'}>
              {!device ? (
                <Empty>Reading the device identity…</Empty>
              ) : (
                <>
                  <div className="adv-kv">
                    <span>Device id</span><b className="adv-mono">{device.id}</b>
                    <span>Name</span><b>{device.name}</b>
                    <span>Hosting</span><b>{host?.hosting ? `port ${host.port}` : 'stopped'}</b>
                    <span>Discovery</span><b>UDP {host?.discoveryPort || 47822}</b>
                  </div>
                  <div className="adv-row-2">
                    <label className="adv-field">
                      <span>Device name</span>
                      <input className="adv-input" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
                    </label>
                    <div className="adv-field">
                      <span>&nbsp;</span>
                      <button
                        className="adv-btn"
                        disabled={busy !== null || !deviceName.trim()}
                        onClick={() =>
                          void run('device-name', async () => {
                            await call(bridge.advanced.devices.setName(deviceName))
                            notify('Device name saved')
                            const data = await call(bridge.advanced.devices.info())
                            setDevice(data.device)
                            setHost(data.host)
                          })
                        }
                      >
                        Save name
                      </button>
                    </div>
                  </div>
                  <div className="adv-toolbar">
                    {!host?.hosting ? (
                      <button
                        className="adv-btn adv-btn-primary"
                        disabled={busy !== null}
                        onClick={() =>
                          void run('host-start', async () => {
                            const data = await call(bridge.advanced.devices.hostStart())
                            setHost(data)
                            setHostCode(data.code)
                            notify(`Hosting on port ${data.port} — pair code ${data.code.code}`)
                          })
                        }
                      >
                        <Network size={13} /> Start hosting this device
                      </button>
                    ) : (
                      <button
                        className="adv-btn"
                        disabled={busy !== null}
                        onClick={() =>
                          void run('host-stop', async () => {
                            setHost(await call(bridge.advanced.devices.hostStop()))
                            setHostCode(null)
                            notify('Hosting stopped')
                          })
                        }
                      >
                        <Square size={13} /> Stop hosting
                      </button>
                    )}
                    <button
                      className="adv-btn"
                      disabled={busy !== null || !host?.hosting}
                      onClick={() =>
                        void run('pair-code', async () => {
                          const code = await call(bridge.advanced.devices.pairCode())
                          setHostCode(code)
                          notify(`Pair code ${code.code} — valid for 10 minutes`)
                        })
                      }
                    >
                      <RefreshCw size={12} /> New pair code
                    </button>
                    <button
                      className="adv-btn"
                      disabled={busy !== null}
                      onClick={() =>
                        void run('discover', async () => {
                          const data = await call(bridge.advanced.devices.discover(1800))
                          setDiscovered(data.devices)
                          if (data.note) notify(data.note)
                        })
                      }
                    >
                      {busy === 'discover' ? <Loader2 size={12} className="adv-spin" /> : <Laptop size={12} />} Discover LAN
                    </button>
                  </div>
                  {hostCode && (
                    <div className="adv-code-pill">
                      Pair code <b>{hostCode.code}</b> <small>expires {time(hostCode.expiresAt)}</small>
                      <button className="adv-btn" onClick={() => void navigator.clipboard.writeText(hostCode.code).then(() => notify('Pair code copied'))}>Copy</button>
                    </div>
                  )}
                  <p className="adv-note">
                    Pairing accepts LAN/private addresses only. The sync bundle contains settings, routing, prompts, workflows and agents — never provider keys,
                    secrets, vault entries, audit rows or usage history.
                  </p>
                </>
              )}
            </Card>

            <Card title="Pair another device" hint="enter the pair code shown on the host">
              <div className="adv-row-3">
                <label className="adv-field"><span>Host</span><input className="adv-input" value={pairForm.host} onChange={(e) => setPairForm({ ...pairForm, host: e.target.value })} placeholder="192.168.1.10" /></label>
                <label className="adv-field"><span>Port</span><input className="adv-input" value={pairForm.port} onChange={(e) => setPairForm({ ...pairForm, port: e.target.value })} /></label>
                <label className="adv-field"><span>Code</span><input className="adv-input" value={pairForm.code} onChange={(e) => setPairForm({ ...pairForm, code: e.target.value })} placeholder="6 digits" /></label>
              </div>
              <button
                className="adv-btn adv-btn-primary"
                disabled={busy !== null || !pairForm.host.trim() || !pairForm.code.trim()}
                onClick={() =>
                  void run('pair', async () => {
                    await call(bridge.advanced.devices.pair({ host: pairForm.host, port: Number(pairForm.port), code: pairForm.code }))
                    const data = await call(bridge.advanced.devices.info())
                    setPaired(data.devices)
                    setSyncLog(data.log)
                    setPairForm({ host: '', port: '47821', code: '' })
                    notify('Device paired')
                  })
                }
              >
                <Download size={13} /> Pair
              </button>
              {discovered.length > 0 && (
                <div className="adv-list">
                  {discovered.map((d) => (
                    <div key={d.id} className="adv-row">
                      <div className="adv-row-main"><b>{d.name}</b><small className="adv-mono">{d.host}:{d.port} · {d.platform}</small></div>
                      <button className="adv-btn" onClick={() => setPairForm({ host: d.host, port: String(d.port), code: pairForm.code })}>Use address</button>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="Paired devices" hint={`${paired.length} linked`}>
              {paired.length === 0 ? (
                <Empty>No other device is paired yet.</Empty>
              ) : (
                <div className="adv-list">
                  {paired.map((d) => (
                    <div key={d.id} className="adv-row">
                      <div className="adv-row-main">
                        <b>{d.name} <Chip>{d.host}:{d.port}</Chip></b>
                        <small>paired {ago(d.pairedAt)} · last seen {ago(d.lastSeen)}</small>
                      </div>
                      <div className="adv-row-actions">
                        <button className="adv-btn" disabled={busy !== null} onClick={() => void run(`check:${d.id}`, async () => { await call(bridge.advanced.devices.check(d.id)); notify(`${d.name} answered`) })}>Check</button>
                        <button className="adv-btn" disabled={busy !== null} onClick={() => void run(`pull:${d.id}`, async () => { const r = await call(bridge.advanced.devices.pull(d.id)); notify(`Pulled ${Object.values(r.applied).reduce((a, b) => a + b, 0)} items`); setSyncLog((await call(bridge.advanced.devices.info())).log) })}><Download size={11} /> Pull</button>
                        <button className="adv-btn" disabled={busy !== null} onClick={() => void run(`push:${d.id}`, async () => { const r = await call(bridge.advanced.devices.push(d.id)); notify(`Pushed ${Object.values(r.applied).reduce((a, b) => a + b, 0)} items`); setSyncLog((await call(bridge.advanced.devices.info())).log) })}><Upload size={11} /> Push</button>
                        <button className="adv-icon" title="Unpair" onClick={() => void run(`unpair:${d.id}`, async () => { await call(bridge.advanced.devices.unpair(d.id)); setPaired((await call(bridge.advanced.devices.info())).devices) })}><Trash2 size={13} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <b className="adv-label">Sync log</b>
              {syncLog.length === 0 ? (
                <Empty>No sync has run yet.</Empty>
              ) : (
                <div className="adv-table">
                  <div className="adv-tr adv-th"><span>When</span><span>Direction</span><span>Device</span><span>Result</span></div>
                  {syncLog.map((row) => (
                    <div key={row.id} className="adv-tr">
                      <span>{ago(row.at)}</span>
                      <span>{row.direction}</span>
                      <span>{row.device}</span>
                      <span className={row.ok ? 'adv-ok' : 'adv-bad'}>{row.ok ? row.items || 'ok' : row.error}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="Agent network (A2A)" hint="JSON-RPC peers get text replies only — never your desktop">
              {!a2aState ? (
                <Empty>Reading the agent card…</Empty>
              ) : (
                <>
                  <div className="adv-kv">
                    <span>Endpoint</span><b className="adv-mono adv-clip">{a2aState.hosting ? a2aState.url : 'not hosting'}</b>
                    <span>Exposure</span><b>{a2aState.expose === 'lan' ? 'private LAN' : 'loopback only'}</b>
                    <span>Active</span><b>{a2aState.active} task(s)</b>
                    <span>Protocol</span><b>A2A {a2aState.card.protocolVersion}</b>
                  </div>
                  <div className="adv-row-3">
                    <label className="adv-field">
                      <span>Port</span>
                      <input className="adv-input" value={a2aPortDraft} onChange={(e) => setA2aPortDraft(e.target.value)} disabled={a2aState.hosting} />
                    </label>
                    <label className="adv-field">
                      <span>Exposure</span>
                      <select className="adv-input" value={a2aExpose} onChange={(e) => setA2aExpose(e.target.value === 'lan' ? 'lan' : 'loopback')} disabled={a2aState.hosting}>
                        <option value="loopback">Loopback (this machine)</option>
                        <option value="lan">Private LAN</option>
                      </select>
                    </label>
                    <div className="adv-field">
                      <span>&nbsp;</span>
                      <div className="adv-toolbar">
                        {!a2aState.hosting ? (
                          <button
                            className="adv-btn adv-btn-primary"
                            disabled={busy !== null}
                            onClick={() =>
                              void run('a2a-start', async () => {
                                const next = await call(bridge.advanced.a2a.hostStart({ port: Number(a2aPortDraft), expose: a2aExpose }))
                                await new Promise((resolve) => setTimeout(resolve, 250))
                                const fresh = await call(bridge.advanced.a2a.status())
                                setA2aState(fresh)
                                setA2aPortDraft(String(fresh.port))
                                notify(next.port ? `A2A listening on ${next.url}` : 'A2A host started')
                              })
                            }
                          >
                            <Network size={13} /> Start A2A
                          </button>
                        ) : (
                          <button
                            className="adv-btn"
                            disabled={busy !== null}
                            onClick={() =>
                              void run('a2a-stop', async () => {
                                setA2aState(await call(bridge.advanced.a2a.hostStop()))
                                notify('A2A host stopped')
                              })
                            }
                          >
                            <Square size={13} /> Stop A2A
                          </button>
                        )}
                        <button
                          className="adv-btn"
                          disabled={busy !== null}
                          onClick={() =>
                            void run('a2a-token', async () => {
                              const rotated = await call(bridge.advanced.a2a.rotateToken())
                              setA2aState(await call(bridge.advanced.a2a.status()))
                              notify(`New token ready — peers must be updated. It ends in ${rotated.token.slice(-4)}`)
                            })
                          }
                        >
                          <RefreshCw size={12} /> Rotate token
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="adv-toolbar">
                    <small className="adv-mono adv-clip">Bearer {a2aState.token}</small>
                    <button className="adv-btn" onClick={() => void navigator.clipboard.writeText(a2aState.token).then(() => notify('A2A token copied'))}>Copy token</button>
                  </div>
                  <div className="adv-toolbar">
                    {a2aState.card.skills.map((skill) => (
                      <Chip key={skill.id}>{skill.name}</Chip>
                    ))}
                    <small>streaming: {a2aState.card.capabilities.streaming ? 'on' : 'off'} · PC control for peers: no</small>
                  </div>
                  <b className="adv-label">Saved peers</b>
                  {a2aState.peers.length === 0 ? (
                    <Empty>No peer is saved. Add the other ORVEX endpoint and its token below.</Empty>
                  ) : (
                    <div className="adv-list">
                      {a2aState.peers.map((peer) => (
                        <div key={peer.id} className="adv-row">
                          <div className="adv-row-main">
                            <b>{peer.name}</b>
                            <small className="adv-mono adv-clip">{peer.url} · token {peer.tokenPreview}</small>
                            <small className={peer.lastError ? 'adv-bad' : undefined}>{peer.lastError || (peer.lastSeen ? `answered ${ago(peer.lastSeen)}` : 'not contacted yet')}</small>
                          </div>
                          <div className="adv-row-actions">
                            <button className="adv-btn" disabled={busy !== null} onClick={() => setA2aPeer(peer.id)}>{a2aPeer === peer.id ? 'Selected' : 'Select'}</button>
                            <button
                              className="adv-btn"
                              disabled={busy !== null}
                              onClick={() =>
                                void run(`a2a-card:${peer.id}`, async () => {
                                  const card = await call(bridge.advanced.a2a.peerCard(peer.url))
                                  notify(`${card.card.name} v${card.card.version} · ${card.card.skills.slice(0, 3).join(', ') || 'no skills listed'}`)
                                })
                              }
                            >
                              Check card
                            </button>
                            <button
                              className="adv-icon"
                              title="Remove peer"
                              onClick={() => void run(`a2a-remove:${peer.id}`, async () => { await call(bridge.advanced.a2a.peerRemove(peer.id)); setA2aState(await call(bridge.advanced.a2a.status())) })}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="adv-row-3">
                    <label className="adv-field"><span>Name</span><input className="adv-input" value={peerForm.name} onChange={(e) => setPeerForm({ ...peerForm, name: e.target.value })} placeholder="office PC" /></label>
                    <label className="adv-field"><span>URL</span><input className="adv-input" value={peerForm.url} onChange={(e) => setPeerForm({ ...peerForm, url: e.target.value })} placeholder="http://192.168.1.20:47831" /></label>
                    <label className="adv-field"><span>Token</span><input className="adv-input" value={peerForm.token} onChange={(e) => setPeerForm({ ...peerForm, token: e.target.value })} placeholder="64 hex characters" /></label>
                  </div>
                  <div className="adv-toolbar">
                    <button
                      className="adv-btn"
                      disabled={busy !== null || !peerForm.url.trim() || !peerForm.token.trim()}
                      onClick={() =>
                        void run('a2a-peer-add', async () => {
                          const saved = await call(bridge.advanced.a2a.peerAdd({ name: peerForm.name, url: peerForm.url, token: peerForm.token }))
                          const next = await call(bridge.advanced.a2a.status())
                          setA2aState(next)
                          setA2aPeer(saved.peer.id)
                          setPeerForm({ name: '', url: '', token: '' })
                          notify(`Peer ${saved.peer.name} saved`)
                        })
                      }
                    >
                      <Plus size={13} /> Add peer
                    </button>
                  </div>
                  <div className="adv-row-2">
                    <label className="adv-field">
                      <span>Message</span>
                      <textarea
                        className="adv-input adv-textarea"
                        rows={3}
                        value={a2aMessage}
                        onChange={(e) => setA2aMessage(e.target.value)}
                        placeholder="A question or task for the selected peer"
                      />
                    </label>
                    <div className="adv-field">
                      <span>&nbsp;</span>
                      <button
                        className="adv-btn adv-btn-primary"
                        disabled={busy !== null || !a2aPeer || !a2aMessage.trim()}
                        onClick={() =>
                          void run('a2a-send', async () => {
                            const result = await call(bridge.advanced.a2a.send({ peerId: a2aPeer, text: a2aMessage }))
                            const text = (result.task.artifacts || []).flatMap((artifact) => artifact.parts).map((part) => part.text || '').join('\n')
                            setA2aReply(result.error || text || `Task ${result.task.id} finished as ${result.task.status.state}.`)
                            setA2aState(await call(bridge.advanced.a2a.status()))
                          })
                        }
                      >
                        {busy === 'a2a-send' ? <Loader2 size={12} className="adv-spin" /> : <Route size={13} />} Send task
                      </button>
                    </div>
                  </div>
                  {a2aReply && <pre className="adv-pre">{a2aReply}</pre>}
                  <b className="adv-label">Recent tasks</b>
                  {a2aState.tasks.length === 0 ? (
                    <Empty>No A2A task has been exchanged yet.</Empty>
                  ) : (
                    <div className="adv-list">
                      {a2aState.tasks.slice(0, 10).map((task) => (
                        <div key={task.id} className="adv-row">
                          <div className="adv-row-main">
                            <b>
                              <Chip kind={tone(task.status.state === 'completed' ? 'done' : task.status.state === 'failed' ? 'bad' : task.status.state === 'canceled' ? 'warn' : 'info')}>{task.status.state}</Chip>{' '}
                              {task.metadata?.direction || 'task'} · {task.metadata?.peer || 'peer'}
                            </b>
                            <small className="adv-clip">{task.goal || task.id}</small>
                          </div>
                          {(task.status.state === 'working' || task.status.state === 'submitted') && (
                            <button
                              className="adv-btn"
                              disabled={busy !== null}
                              onClick={() => void run(`a2a-cancel:${task.id}`, async () => { await call(bridge.advanced.a2a.cancel(task.id)); setA2aState(await call(bridge.advanced.a2a.status())) })}
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="adv-note">
                    A peer can ask the configured chat model for text and nothing more: no tools, files, desktop input or plugins are reachable over A2A. Every call
                    needs the bearer token, the host answers private LAN addresses only, and each task is stored in SQLite — a task cut off by a restart is shown as
                    failed instead of pretending to still run. Exposing the LAN option makes this port reachable from your network; the token is the only gate.
                  </p>
                </>
              )}
            </Card>
          </div>
        )}

        {tab === 'learning' && (
          <div className="adv-grid">
            <Card
              title="Personal workflow learning"
              hint="mined from the real audit trail and usage table"
              actions={
                <button
                  className="adv-btn adv-btn-primary"
                  disabled={busy !== null}
                  onClick={() =>
                    void run('learn-mine', async () => {
                      const result = await call(bridge.advanced.mineLearning())
                      setLearning(result.items)
                      notify(`${result.suggested} new suggestion(s)`)
                    })
                  }
                >
                  {busy === 'learn-mine' ? <Loader2 size={13} className="adv-spin" /> : <Sparkles size={13} />} Mine now
                </button>
              }
            >
              <p className="adv-note">
                Sequences are tool chains that repeated across distinct runs. Routing suggestions come from at least 3 calls with a 75%+ success rate. Nothing
                is auto-applied — approving a workflow suggestion only marks it approved; approving a routing suggestion writes that chain.
              </p>
              {learning.length === 0 ? (
                <Empty>No suggestions yet. Run goals or workflows so there is a trail to learn from, then mine again.</Empty>
              ) : (
                <div className="adv-list">
                  {learning.map((item) => (
                    <div key={item.id} className="adv-row">
                      <div className="adv-row-main">
                        <b>
                          {item.kind === 'routing' ? 'Route' : 'Workflow'} · <Chip kind={tone(item.status)}>{item.status}</Chip>
                        </b>
                        <small className="adv-clip">
                          {item.kind === 'routing'
                            ? `${item.detail.task} → ${(item.detail.chain || []).map((c) => c.model).join(' → ')} · ${item.detail.calls || 0} calls · ${Math.round((item.detail.okRate || 0) * 100)}% ok`
                            : `${(item.detail.steps || []).join(' → ')} · seen in ${item.detail.runs || 0} run(s)`}
                        </small>
                      </div>
                      <div className="adv-row-actions">
                        {item.status === 'suggested' && (
                          <>
                            <button className="adv-btn adv-btn-primary" onClick={() => void run(`learn-ok:${item.id}`, async () => { await call(bridge.advanced.approveLearning(item.id)); setLearning(await call(bridge.advanced.learning())); notify('Suggestion approved') })}>Approve</button>
                            <button className="adv-btn" onClick={() => void run(`learn-no:${item.id}`, async () => { await call(bridge.advanced.dismissLearning(item.id)); setLearning(await call(bridge.advanced.learning())) })}>Dismiss</button>
                          </>
                        )}
                        <Chip>{item.support}×</Chip>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}

        {tab === 'plugins' && (
          <div className="adv-grid">
            <Card title="Installed plugins" hint={`${plugins.length} installed · each call needs approval`}>
              {plugins.length === 0 ? (
                <Empty>No plugin is installed. Install from a folder below, or configure a catalog you trust.</Empty>
              ) : (
                <div className="adv-list">
                  {plugins.map((p) => (
                    <div key={p.id} className="adv-row">
                      <div className="adv-row-main">
                        <b>{p.name} <Chip>{p.version}</Chip> <Chip kind={p.enabled ? 'ok' : 'idle'}>{p.enabled ? 'enabled' : 'disabled'}</Chip></b>
                        <small className="adv-clip">{p.description || p.id}</small>
                        <small className="adv-clip">Tools: {p.tools.map((t) => t.name).join(', ') || 'none'} · source {p.source}</small>
                        <small className="adv-clip">Network: {pluginNetworkLabel(p.permissions)} · sandboxed child, no shell, no workers</small>
                      </div>
                      <div className="adv-row-actions">
                        <button className="adv-btn" onClick={() => void run(`plugin-toggle:${p.id}`, async () => { await call(bridge.advanced.plugins.enable(p.id, !p.enabled)); setPlugins((await call(bridge.advanced.plugins.list())).plugins) })}>{p.enabled ? 'Disable' : 'Enable'}</button>
                        <button className="adv-icon" title="Uninstall" onClick={() => void run(`plugin-del:${p.id}`, async () => { await call(bridge.advanced.plugins.uninstall(p.id)); setPlugins((await call(bridge.advanced.plugins.list())).plugins) })}><Trash2 size={13} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <button
                className="adv-btn adv-btn-primary"
                disabled={busy !== null}
                onClick={() =>
                  void run('plugin-install-dir', async () => {
                    const result = await call(bridge.advanced.plugins.installDir())
                    if (result.cancelled) return
                    setPlugins((await call(bridge.advanced.plugins.list())).plugins)
                    notify(`Installed ${result.plugin?.name || 'plugin'}`)
                  })
                }
              >
                <FolderDown size={13} /> Install from folder
              </button>
              <p className="adv-note">
                Plugin code runs in a child ORVEX process under Node's permission model: it can read only its own folder and write only its data folder, with no
                child processes, workers or native addons. Network access is blocked unless the manifest declares <code>permissions.network</code> as a host
                allowlist or <code>"any"</code>, so installing a plugin is still an explicit trust decision.
              </p>
            </Card>

            <Card title="Tool marketplace" hint="no hosted store is bundled — you choose the catalog URL">
              <div className="adv-row-2">
                <label className="adv-field">
                  <span>Catalog URL</span>
                  <input className="adv-input" value={catalogUrl} onChange={(e) => setCatalogUrl(e.target.value)} placeholder="https://example.com/orvex-plugins.json" />
                </label>
                <div className="adv-field">
                  <span>&nbsp;</span>
                  <div className="adv-toolbar">
                    <button className="adv-btn" disabled={busy !== null} onClick={() => void run('catalog-url', async () => { await call(bridge.advanced.plugins.setCatalogUrl(catalogUrl)); notify('Catalog URL saved') })}>Save</button>
                    <button
                      className="adv-btn"
                      disabled={busy !== null || !catalogUrl.trim()}
                      onClick={() =>
                        void run('catalog-load', async () => {
                          const data = await call(bridge.advanced.plugins.catalog(true))
                          setCatalog(data)
                        })
                      }
                    >
                      {busy === 'catalog-load' ? <Loader2 size={12} className="adv-spin" /> : <RefreshCw size={12} />} Load
                    </button>
                  </div>
                </div>
              </div>
              <label className="adv-field">
                <span>Trusted catalog keys</span>
                <textarea
                  className="adv-input adv-textarea"
                  rows={3}
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder={'-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA…\n-----END PUBLIC KEY-----'}
                />
              </label>
              <div className="adv-toolbar">
                <button
                  className="adv-btn"
                  disabled={busy !== null || !keyDraft.trim()}
                  onClick={() =>
                    void run('catalog-keys', async () => {
                      const saved = await call(bridge.advanced.plugins.setCatalogKeys(keyDraft))
                      setTrustedKeys(saved.keys)
                      setKeyDraft('')
                      setCatalog(null)
                      notify(`${saved.keys.length} trusted key${saved.keys.length === 1 ? '' : 's'} saved`)
                    })
                  }
                >
                  Save keys
                </button>
                <button
                  className="adv-btn"
                  disabled={busy !== null || trustedKeys.length === 0}
                  onClick={() =>
                    void run('catalog-keys-clear', async () => {
                      const saved = await call(bridge.advanced.plugins.setCatalogKeys(''))
                      setTrustedKeys(saved.keys)
                      setRequireSignature(false)
                      setCatalog(null)
                      notify('Trusted keys cleared')
                    })
                  }
                >
                  Clear keys
                </button>
                <label className="adv-check">
                  <input
                    type="checkbox"
                    checked={requireSignature}
                    disabled={busy !== null || trustedKeys.length === 0}
                    onChange={(e) => {
                      const value = e.target.checked
                      void run('catalog-require', async () => {
                        const saved = await call(bridge.advanced.plugins.setRequireSignature(value))
                        setRequireSignature(saved.requireSignature)
                        setCatalog(null)
                        notify(saved.requireSignature ? 'Only signed catalogs will be accepted' : 'Unsigned catalogs allowed again')
                      })
                    }}
                  />
                  Require signed catalog
                </label>
              </div>
              {trustedKeys.length > 0 && (
                <div className="adv-list">
                  {trustedKeys.map((key) => (
                    <div key={key.fingerprint} className="adv-row">
                      <div className="adv-row-main">
                        <b>{key.keyId}</b>
                        <small className="adv-mono adv-clip">fingerprint {key.fingerprint}</small>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {catalog && catalog.signed !== null && (
                <div className="adv-toolbar">
                  <Chip>{catalog.signed ? 'signed catalog' : 'unsigned catalog'}</Chip>
                  {catalog.signed && catalog.fingerprint && <small className="adv-mono adv-clip">key {catalog.keyId || 'unknown'} · {catalog.fingerprint}</small>}
                  {catalog.generatedAt && <small>built {catalog.generatedAt}</small>}
                  {typeof catalog.skipped === 'number' && catalog.skipped > 0 && <small>{catalog.skipped} invalid entries skipped</small>}
                </div>
              )}
              {!catalog ? (
                <Empty>Load a catalog to see compatible extensions.</Empty>
              ) : catalog.items.length === 0 ? (
                <Empty>{catalog.note || catalog.error || 'The catalog returned no compatible plugin.'}</Empty>
              ) : (
                <div className="adv-list">
                  {catalog.items.map((item) => (
                    <div key={`${item.id}@${item.version}`} className="adv-row">
                      <div className="adv-row-main">
                        <b>{item.name} <Chip>{item.version}</Chip> {item.author && <Chip>{item.author}</Chip>}</b>
                        <small>{item.description}</small>
                        <small className="adv-mono adv-clip">sha256 {item.sha256}</small>
                      </div>
                      <button
                        className="adv-btn adv-btn-primary"
                        disabled={busy !== null || item.installed}
                        onClick={() =>
                          void run(`catalog-install:${item.id}`, async () => {
                            await call(bridge.advanced.plugins.installCatalog(item.id))
                            setPlugins((await call(bridge.advanced.plugins.list())).plugins)
                            setCatalog(await call(bridge.advanced.plugins.catalog(false)))
                            notify(`Installed ${item.name}`)
                          })
                        }
                      >
                        {item.installed ? 'Installed' : 'Install'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <p className="adv-note">
                Every download must match the catalog's 64-character sha256 before it is unpacked, and the manifest id/version is checked against the catalog.
                A catalog with missing or malformed hashes is rejected. For stronger authenticity, sign the catalog with Ed25519 (<code>npm run catalog:keygen</code>,{' '}
                <code>npm run catalog:build</code>) and add its public key above — with “Require signed catalog” on, an unsigned or tampered catalog is refused
                before any plugin URL is offered.
              </p>
              <div>
                <b className="adv-label">Plugin SDK</b>
                <pre className="adv-pre">{`plugin-folder/
  manifest.json
  index.cjs

manifest.json:
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "entry": "index.cjs",
  "permissions": { "network": ["api.example.com"] },
  "tools": [
    { "name": "hello", "description": "Say hello", "parameters": { "type": "object", "properties": {} } }
  ]
}

index.cjs:
exports.run = async (tool, args, api) => {
  if (tool === 'hello') return { output: 'hello ' + (args.name || 'world') }
  return { ok: false, error: 'unknown tool' }
}`}</pre>
              </div>
            </Card>
          </div>
        )}

        {tab === 'recovery' && (
          <div className="adv-grid">
            <Card
              title="Recovery manager"
              hint="unfinished engine runs, workflows and jobs, plus recorded crashes"
              actions={
                <button className="adv-btn" disabled={busy !== null} onClick={() => void run('recovery', async () => setRecovery(await call(bridge.advanced.recovery())))}>
                  <RefreshCw size={12} /> Refresh
                </button>
              }
            >
              {!recovery ? (
                <Empty>Scanning for recoverable work…</Empty>
              ) : (
                <>
                  <b className="adv-label">Engine runs</b>
                  {recovery.runs.length === 0 ? (
                    <Empty>No run with a checkpoint is unfinished.</Empty>
                  ) : (
                    <div className="adv-list">
                      {recovery.runs.map((row) => (
                        <div key={row.id} className="adv-row">
                          <div className="adv-row-main">
                            <b className="adv-clip">{row.goal}</b>
                            <small>{row.steps} steps · {row.status} · started {ago(row.startedAt)}</small>
                          </div>
                          <div className="adv-row-actions">
                            <button
                              className="adv-btn"
                              disabled={busy !== null || !provider}
                              title={provider ? 'Resume with the active provider' : 'Pick a provider in Settings first'}
                              onClick={() => void run(`rec-run:${row.id}`, async () => { await call(bridge.advanced.resumeRecovery({ kind: 'run', id: row.id, provider, candidates })); notify('Run resumed'); setRecovery(await call(bridge.advanced.recovery())) })}
                            >
                              <Play size={11} /> Resume
                            </button>
                            <button className="adv-btn" disabled={busy !== null} onClick={() => void run(`rec-run-x:${row.id}`, async () => { await call(bridge.advanced.discardRecovery('run', row.id)); setRecovery(await call(bridge.advanced.recovery())) })}>Discard</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <b className="adv-label">Workflow runs</b>
                  {recovery.workflows.length === 0 ? (
                    <Empty>No interrupted or queued workflow run.</Empty>
                  ) : (
                    <div className="adv-list">
                      {recovery.workflows.map((row) => (
                        <div key={row.id} className="adv-row">
                          <div className="adv-row-main"><b>{row.name || row.workflowId}</b><small>{row.status} · started {ago(row.startedAt)}</small></div>
                          <div className="adv-row-actions">
                            <button className="adv-btn" disabled={busy !== null} onClick={() => void run(`rec-wf:${row.id}`, async () => { await call(bridge.advanced.resumeRecovery({ kind: 'workflow', id: row.id })); notify('Workflow resumed'); setRecovery(await call(bridge.advanced.recovery())) })}><Play size={11} /> Resume</button>
                            <button className="adv-btn" disabled={busy !== null} onClick={() => void run(`rec-wf-x:${row.id}`, async () => { await call(bridge.advanced.discardRecovery('workflow', row.id)); setRecovery(await call(bridge.advanced.recovery())) })}>Discard</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <b className="adv-label">Autonomous jobs</b>
                  {recovery.jobs.length === 0 ? (
                    <Empty>No interrupted, paused or failed job.</Empty>
                  ) : (
                    <div className="adv-list">
                      {recovery.jobs.map((row) => (
                        <div key={row.id} className="adv-row">
                          <div className="adv-row-main"><b>{row.title}</b><small>{row.checkpoint}/{row.steps} steps · {row.status} · created {ago(row.createdAt)}</small></div>
                          <div className="adv-row-actions">
                            {['paused', 'interrupted', 'failed'].includes(row.status) && (
                              <button className="adv-btn" disabled={busy !== null} onClick={() => void run(`rec-job:${row.id}`, async () => { await call(bridge.advanced.resumeRecovery({ kind: 'job', id: row.id })); notify('Job resumed'); setRecovery(await call(bridge.advanced.recovery())) })}><Play size={11} /> Resume</button>
                            )}
                            <button className="adv-btn" disabled={busy !== null} onClick={() => void run(`rec-job-x:${row.id}`, async () => { await call(bridge.advanced.discardRecovery('job', row.id)); setRecovery(await call(bridge.advanced.recovery())) })}>Discard</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <b className="adv-label">Recorded crashes</b>
                  {recovery.crashes.length === 0 ? (
                    <Empty>No crash was recorded in this profile.</Empty>
                  ) : (
                    <div className="adv-table">
                      <div className="adv-tr adv-th"><span>When</span><span>PID</span><span>Reason</span></div>
                      {recovery.crashes.map((row) => (
                        <div key={`${row.id}`} className="adv-tr">
                          <span>{ago(row.at)}</span>
                          <span>{row.pid}</span>
                          <span className="adv-clip">{row.reason}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </Card>
          </div>
        )}
      </div>
    </PageShell>
  )
}
