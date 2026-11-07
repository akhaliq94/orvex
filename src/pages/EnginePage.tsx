import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  AudioLines,
  Bot,
  Brain,
  CheckCircle2,
  Cpu,
  History,
  Layers,
  ListChecks,
  Loader2,
  Mic,
  MicOff,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Square,
  Terminal,
  XCircle,
} from 'lucide-react'
import PageShell from './PageShell'
import { useProviders } from '../hooks/useProviders'
import { fetchRemoteModels } from '../data/providers'
import { speak, useVoiceSettings } from '../data/voice'
import { buildCandidates, orderForTask } from '../data/routing'
import type { Voice } from '../hooks/useVoice'
import type { OrvexAgentEvent, OrvexAuditEntry, OrvexEnv, OrvexRunRecord } from '../types/desktop'

type Props = { onBack: () => void; notify: (msg: string) => void; voice: Voice }
type Summary = { ok: boolean; cancelled?: boolean; text: string; steps: number; ms: number }

const LOCAL_KEY = 'orvex-engine-local'
const FULL_AUTO_KEY = 'orvex-fullauto'
const ORCHESTRATE_KEY = 'orvex-orchestrate'

function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function argsPreview(args: Record<string, unknown>): string {
  const s = JSON.stringify(args ?? {})
  return s.length > 180 ? s.slice(0, 180) + '…' : s
}

function EventRow({
  ev,
  decision,
  onApprove,
}: {
  ev: OrvexAgentEvent
  decision?: boolean
  onApprove?: (id: string, allow: boolean, name: string) => void
}) {
  switch (ev.type) {
    case 'run_start':
      return (
        <div className="engine-ev info">
          Goal accepted · brain {ev.model ?? '—'}
          {ev.mode === 'orchestrator' ? ' · orchestrator' : ''}
          {ev.resumed ? ' · resumed' : ''}
          {ev.localModel ? ` · local ${ev.localModel}` : ''}
          {ev.maxSteps ? ` · up to ${ev.maxSteps} steps` : ''}
        </div>
      )
    case 'plan_created':
      return (
        <div className="engine-ev info">
          <ListChecks size={12} />
          <div>
            <strong>
              {ev.resumed ? 'Resumed plan' : 'Plan ready'} · {ev.plan.length} step(s)
            </strong>
            <ol className="engine-plan">
              {ev.plan.map((s) => (
                <li key={`${s.id}-${s.idx}`} className={`engine-plan-step ${s.status}`}>
                  <span className="engine-plan-dot" />
                  {s.title}
                  {s.readOnly ? <span className="dim"> · read-only</span> : null}
                  {s.parallelGroup ? <span className="dim"> · parallel {s.parallelGroup}</span> : null}
                  {s.status === 'done' ? <span className="dim"> · done</span> : null}
                </li>
              ))}
            </ol>
          </div>
        </div>
      )
    case 'plan_revised':
      return (
        <div className="engine-ev info">
          <RotateCcw size={12} />
          <div>
            <strong>Plan revised (replan {ev.replans})</strong>
            <p className="dim">{ev.reason}</p>
            <ol className="engine-plan">
              {ev.plan.map((s) => (
                <li key={`${s.id}-${s.idx}`} className={`engine-plan-step ${s.status}`}>
                  <span className="engine-plan-dot" />
                  {s.title}
                  {s.status !== 'pending' ? <span className="dim"> · {s.status}</span> : null}
                </li>
              ))}
            </ol>
          </div>
        </div>
      )
    case 'step_start':
      return (
        <div className="engine-ev info">
          <Layers size={12} />
          <span>
            Step {ev.position}/{ev.total} · <strong>{ev.title}</strong>
            {ev.attempt > 1 ? ` · attempt ${ev.attempt}` : ''}
            {ev.parallel ? ' · parallel' : ''}
          </span>
        </div>
      )
    case 'step_retry':
      return (
        <div className="engine-ev info">
          <RotateCcw size={12} />
          <span>
            Step {ev.idx + 1} failed validation — retrying (attempt {ev.attempt}): {ev.reason}
          </span>
        </div>
      )
    case 'validation':
      return (
        <div className={`engine-ev ${ev.ok ? 'result ok' : 'bad'}`}>
          {ev.ok ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />}
          <span>
            {ev.ok
              ? ev.unverified
                ? 'Accepted without a validator — '
                : 'Validated — '
              : 'Validation failed — '}
            {ev.reason}
          </span>
        </div>
      )
    case 'step_done':
      return (
        <div className={`engine-ev ${ev.ok ? 'result ok' : 'bad'}`}>
          {ev.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
          <span>
            {ev.skipped ? 'Skipped' : ev.ok ? 'Step done' : 'Step failed'} · {ev.title ?? `step ${ev.idx + 1}`}
            {ev.attempts ? ` · ${ev.attempts} attempt(s)` : ''}
          </span>
          {ev.summary && <pre>{ev.summary}</pre>}
        </div>
      )
    case 'paused':
      return (
        <div className="engine-ev info">
          <Pause size={12} /> Paused — the engine will hold before its next action.
        </div>
      )
    case 'resumed':
      return (
        <div className="engine-ev info">
          <Play size={12} /> Resumed.
        </div>
      )
    case 'approval_request':
      return (
        <div className="engine-ev approval">
          <ShieldAlert size={12} />
          <div className="engine-approval-body">
            <p>
              <strong>{ev.name}</strong> needs your approval — {ev.reason}
            </p>
            <code className="engine-approval-args">{argsPreview(ev.args)}</code>
            <div className="engine-approval-actions">
              {decision === undefined ? (
                <>
                  <button className="ghost-btn allow" onClick={() => onApprove?.(ev.id, true, ev.name)}>
                    Allow
                  </button>
                  <button className="ghost-btn" onClick={() => onApprove?.(ev.id, false, ev.name)}>
                    Deny
                  </button>
                </>
              ) : (
                <span className={decision ? 'ok' : 'bad'}>{decision ? 'Allowed by you' : 'Denied by you'}</span>
              )}
            </div>
          </div>
        </div>
      )
    case 'approval_result':
      return ev.auto ? (
        <div className="engine-ev approval">
          <ShieldAlert size={12} />
          <div className="engine-approval-body">
            <p>
              <strong>{ev.name}</strong> auto-approved — full auto is on.
            </p>
          </div>
        </div>
      ) : null
    case 'assistant':
      return (
        <div className="engine-ev assistant">
          <Bot size={12} />
          <p>{ev.text}</p>
        </div>
      )
    case 'tool_start':
      return (
        <div className="engine-ev tool">
          <Terminal size={12} />
          <code>{ev.name}</code>
          <span className="dim">{argsPreview(ev.args)}</span>
        </div>
      )
    case 'tool_result':
      return (
        <div className={`engine-ev result ${ev.ok ? 'ok' : 'bad'}`}>
          {ev.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
          <span>
            {ev.name} · {ev.ms} ms
          </span>
          <pre>{ev.output || ev.error || '(no output)'}</pre>
        </div>
      )
    case 'compact':
      return (
        <div className="engine-ev info">
          Local model {ev.model} compressed tool output {ev.chars} → {ev.to} chars
        </div>
      )
    case 'context_compacted':
      return (
        <div className="engine-ev info">
          Context compacted — {ev.removed} earlier steps summarized, {ev.kept} entries kept ({ev.chars} chars read)
        </div>
      )
    case 'error':
      return (
        <div className="engine-ev bad">
          <AlertTriangle size={12} />
          <p>{ev.message}</p>
        </div>
      )
    case 'run_end':
      return null
    default:
      return null
  }
}

export default function EnginePage({ onBack, notify, voice }: Props) {
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const { providers, active, activeId, setActiveId, upsert } = useProviders()
  const { cfg: voiceCfg } = useVoiceSettings()

  const [goal, setGoal] = useState('')
  const [running, setRunning] = useState(false)
  const [paused, setPaused] = useState(false)
  const [decisions, setDecisions] = useState<Record<string, boolean>>({})
  const [events, setEvents] = useState<OrvexAgentEvent[]>([])
  const [status, setStatus] = useState('')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [audit, setAudit] = useState<OrvexAuditEntry[]>([])
  const [env, setEnv] = useState<OrvexEnv | null>(null)
  const [probe, setProbe] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  const [localId, setLocalId] = useState(() => readPref(LOCAL_KEY, 'none'))
  const [memoryText, setMemoryText] = useState('')
  const [memoryBytes, setMemoryBytes] = useState(0)
  const [memoryDirty, setMemoryDirty] = useState(false)
  const [dictating, setDictating] = useState(false)
  const [voiceRun, setVoiceRun] = useState(false)
  const [fullAuto, setFullAuto] = useState(() => readPref(FULL_AUTO_KEY, '0') === '1')
  const [orchestrate, setOrchestrate] = useState(() => readPref(ORCHESTRATE_KEY, '0') === '1')
  const [autoResume, setAutoResume] = useState(true)
  const [resumable, setResumable] = useState<OrvexRunRecord[]>([])
  const [modelsBusy, setModelsBusy] = useState(false)

  const pullModels = async () => {
    if (!active) return
    setModelsBusy(true)
    const remote = await fetchRemoteModels(active)
    setModelsBusy(false)
    if (!remote) {
      notify(`${active.name}: no /models list — type the model id manually in Settings → Providers`)
      return
    }
    const ids = [...new Set(remote.models.map((m) => m.id))]
    const free = [...new Set(remote.models.filter((m) => m.free).map((m) => m.id))]
    upsert({
      ...active,
      models: ids,
      freeModels: free,
      model: ids.includes(active.model) ? active.model : ids[0] ?? active.model,
    })
    const skipped = remote.skipped?.length ?? 0
    notify(
      `${active.name}: ${ids.length} chat models imported${free.length ? ` · ${free.length} free` : ''}${skipped ? ` · ${skipped} speech/classifier skipped` : ''}`,
    )
  }

  const scrollRef = useRef<HTMLDivElement>(null)
  const goalElRef = useRef<HTMLTextAreaElement>(null)
  const memoryDirtyRef = useRef(false)
  const goalRef = useRef('')
  const runningRef = useRef(false)
  const dictatingRef = useRef(false)
  const voiceRunRef = useRef(false)
  const startingRef = useRef(false)
  const voiceCfgRef = useRef(voiceCfg)
  const voiceApiRef = useRef(voice)
  const startRef = useRef<(goalOverride?: string) => Promise<void>>(async () => {})

  useEffect(() => {
    voiceCfgRef.current = voiceCfg
    voiceApiRef.current = voice
  })

  useEffect(() => {
    runningRef.current = running
  }, [running])

  useEffect(() => {
    dictatingRef.current = dictating
  }, [dictating])

  useEffect(() => {
    voiceRunRef.current = voiceRun
  }, [voiceRun])

  const loadAudit = useCallback(async () => {
    if (!bridge) return
    const res = await bridge.audit.tail(80)
    if (res.ok) setAudit(res.data)
  }, [bridge])

  const loadMemory = useCallback(async () => {
    if (!bridge) return
    const res = await bridge.memory.get()
    if (res.ok) {
      setMemoryText(res.data.text)
      setMemoryBytes(res.data.bytes)
      setMemoryDirty(false)
      memoryDirtyRef.current = false
    }
  }, [bridge])

  const loadRuns = useCallback(async () => {
    if (!bridge?.orchestrator) return
    const res = await bridge.orchestrator.runs(8)
    if (res.ok) {
      setResumable(res.data.resumable)
      if (typeof res.data.autoResume === 'boolean') setAutoResume(res.data.autoResume)
    }
  }, [bridge])

  useEffect(() => {
    if (!bridge) return
    void bridge.env().then((res) => {
      if (res.ok) setEnv(res.data)
    })
    void bridge.agent.status().then((res) => {
      if (res.ok && res.data.running) {
        setRunning(true)
        setPaused(!!res.data.paused)
      }
    })
    void loadAudit()
    void loadMemory()
    void loadRuns()
    const off = bridge.agent.onEvent((ev) => {
      if (ev.type === 'status') {
        setStatus(ev.text)
        return
      }
      if (ev.type === 'paused') {
        setPaused(true)
        setStatus('Paused — the engine holds before its next action.')
      }
      if (ev.type === 'resumed') {
        setPaused(false)
        setStatus('Resuming…')
      }
      if (ev.type === 'approval_request') {
        setStatus('Waiting for your approval…')
      }
      if (ev.type === 'approval_result') {
        setStatus('')
        setDecisions((d) => (ev.id in d ? d : { ...d, [ev.id]: ev.allow }))
      }
      if (ev.type === 'run_start') {
        setEvents([ev])
        setStatus('Starting…')
        setSummary(null)
        setRunning(true)
        setPaused(false)
        setDecisions({})
        startingRef.current = false
        return
      }
      if (ev.type === 'run_end') {
        setStatus('')
        setRunning(false)
        setPaused(false)
        startingRef.current = false
        setSummary({ ok: ev.ok, cancelled: ev.cancelled, text: ev.summary, steps: ev.steps, ms: ev.ms })
        setEvents((list) => [...list, ev])
        void loadAudit()
        void loadRuns()
        if (!memoryDirtyRef.current) void loadMemory()
        // Voice run: read the result aloud, then re-arm the mic so the next goal
        // can be spoken without touching anything.
        if (voiceRunRef.current) {
          const api = voiceApiRef.current
          api.pauseListening()
          const resume = () => {
            if (dictatingRef.current) api.resumeListening()
          }
          const said = ev.summary?.trim()
          if (said) {
            const head = ev.ok ? 'Goal complete.' : ev.cancelled ? 'Stopped.' : 'Did not finish.'
            void Promise.resolve(speak(`${head} ${said}`.slice(0, 600), voiceCfgRef.current))
              .catch(() => undefined)
              .finally(resume)
          } else {
            resume()
          }
        } else if (dictatingRef.current) {
          voiceApiRef.current.resumeListening()
        }
        return
      }
      setEvents((list) => [...list.slice(-299), ev])
    })
    return off
  }, [bridge, loadAudit, loadMemory, loadRuns])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [events, status])

  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_KEY, localId)
    } catch {
      /* preference is optional */
    }
  }, [localId])

  useEffect(() => {
    try {
      localStorage.setItem(ORCHESTRATE_KEY, orchestrate ? '1' : '0')
    } catch {
      /* preference is optional */
    }
  }, [orchestrate])

  const start = async (goalOverride?: string) => {
    if (!bridge) return
    const g = (goalOverride ?? goalRef.current).trim()
    if (!g) {
      notify('Write a goal first.')
      return
    }
    if (!active || !active.model) {
      notify('No model selected — set one in Settings → Providers.')
      return
    }
    if (startingRef.current) return
    startingRef.current = true
    setGoal(g)
    goalRef.current = g
    // Do not let the mic transcribe the engine's own status updates.
    if (dictatingRef.current) voiceApiRef.current.pauseListening()
    const local = localId !== 'none' ? providers.find((p) => p.id === localId) : undefined
    setEvents([])
    setSummary(null)
    setStatus('Starting…')
    const res = await bridge.agent.start({
      goal: g,
      provider: { id: active.id, presetId: active.presetId, name: active.name, baseUrl: active.baseUrl, apiKey: active.apiKey, api: active.api, model: active.model },
      candidates: orderForTask(buildCandidates(providers, active.id), 'agent'),
      local: local
        ? { name: local.name, baseUrl: local.baseUrl, apiKey: local.apiKey, api: local.api, model: local.model }
        : null,
      autoApprove: fullAuto,
      task: 'agent',
      mode: orchestrate ? 'orchestrator' : 'agent',
    })
    if (!res.ok) {
      startingRef.current = false
      setStatus('')
      notify(res.error)
      if (dictatingRef.current) voiceApiRef.current.resumeListening()
      return
    }
    setRunning(true)
  }

  const resumeRun = async (run: OrvexRunRecord) => {
    if (!bridge || startingRef.current) return
    if (!active || !active.model) {
      notify('No model selected — set one in Settings → Providers.')
      return
    }
    startingRef.current = true
    if (dictatingRef.current) voiceApiRef.current.pauseListening()
    const local = localId !== 'none' ? providers.find((p) => p.id === localId) : undefined
    setGoal(run.goal ?? '')
    goalRef.current = run.goal ?? ''
    setEvents([])
    setSummary(null)
    setStatus(`Resuming ${run.id}…`)
    const res = await bridge.orchestrator.resume({
      runId: run.id,
      goal: run.goal ?? '',
      provider: { id: active.id, presetId: active.presetId, name: active.name, baseUrl: active.baseUrl, apiKey: active.apiKey, api: active.api, model: active.model },
      candidates: orderForTask(buildCandidates(providers, active.id), 'agent'),
      local: local
        ? { name: local.name, baseUrl: local.baseUrl, apiKey: local.apiKey, api: local.api, model: local.model }
        : null,
      autoApprove: fullAuto,
      task: 'agent',
      mode: 'orchestrator',
    })
    if (!res.ok) {
      startingRef.current = false
      setStatus('')
      notify(res.error)
      if (dictatingRef.current) voiceApiRef.current.resumeListening()
      return
    }
    setRunning(true)
  }

  const toggleAutoResume = async (enabled: boolean) => {
    setAutoResume(enabled)
    if (!bridge?.orchestrator.setAutoResume) return
    const res = await bridge.orchestrator.setAutoResume(enabled)
    if (!res.ok) notify(res.error)
    else setAutoResume(res.data.enabled)
  }

  useEffect(() => {
    startRef.current = start
  })

  // Voice → goal box. In voice-run mode a spoken turn replaces the goal and
  // launches the engine; otherwise it is appended so it can be edited first.
  useEffect(() => {
    const api = voiceApiRef.current
    if (!dictating) {
      api.setOnUtterance(null)
      return
    }
    api.setOnUtterance((text) => {
      const clean = text.replace(/\s+/g, ' ').trim()
      if (!clean) return
      if (voiceRunRef.current) {
        setGoal(clean)
        goalRef.current = clean
        if (!runningRef.current && !startingRef.current) void startRef.current(clean)
        return
      }
      const current = goalRef.current.trim()
      const next = current ? `${current} ${clean}` : clean
      setGoal(next)
      goalRef.current = next
    })
    return () => api.setOnUtterance(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dictating])

  // Leaving the engine must release the mic — but only if this page turned it on.
  useEffect(() => {
    return () => {
      voiceApiRef.current.setOnUtterance(null)
      if (dictatingRef.current) voiceApiRef.current.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleDictation = () => {
    if (dictating) {
      setDictating(false)
      setVoiceRun(false)
      voice.stop()
      return
    }
    if (!voice.speechSupported) {
      notify('Voice input is not set up — add a transcription endpoint in Settings → Voice.')
      return
    }
    setDictating(true)
    void voice.start()
  }

  const toggleVoiceRun = () => {
    if (voiceRun) {
      setVoiceRun(false)
      return
    }
    if (!voice.speechSupported) {
      notify('Voice input is not set up — add a transcription endpoint in Settings → Voice.')
      return
    }
    setVoiceRun(true)
    if (!dictating) {
      setDictating(true)
      void voice.start()
    }
  }

  const stop = async () => {
    if (!bridge) return
    setStatus('Stopping…')
    const res = await bridge.agent.stop()
    if (!res.ok) notify(res.error)
  }

  const togglePause = async () => {
    if (!bridge) return
    const res = paused ? await bridge.agent.resume() : await bridge.agent.pause()
    if (!res.ok) notify(res.error)
    else setPaused(res.data.paused)
  }

  const answerApproval = async (id: string, allow: boolean, name: string) => {
    setDecisions((d) => ({ ...d, [id]: allow }))
    if (!bridge) return
    const res = await bridge.agent.approve(id, allow)
    if (!res.ok) notify(`${name}: ${res.error}`)
  }

  // Tray icon / global hotkey wake: put the cursor in the goal box.
  useEffect(() => {
    if (!bridge) return
    return bridge.app.onWake(() => {
      window.setTimeout(() => goalElRef.current?.focus(), 120)
    })
  }, [bridge])

  const runProbe = async () => {
    if (!bridge) return
    setProbing(true)
    const res = await bridge.tools.run('sys_info', {})
    setProbing(false)
    if (res.ok && res.data.ok) setProbe(res.data.output)
    else setProbe(`Probe failed: ${res.ok ? res.data.error : res.error}`)
  }

  const saveMemory = async () => {
    if (!bridge) return
    const res = await bridge.memory.set(memoryText)
    if (!res.ok) {
      notify(res.error)
      return
    }
    setMemoryBytes(res.data.bytes)
    setMemoryDirty(false)
    memoryDirtyRef.current = false
    notify('Engine memory saved.')
  }

  const clearMemory = async () => {
    if (!bridge) return
    const res = await bridge.memory.clear()
    if (!res.ok) {
      notify(res.error)
      return
    }
    setMemoryText('')
    setMemoryBytes(0)
    setMemoryDirty(false)
    memoryDirtyRef.current = false
    notify('Engine memory cleared.')
  }

  const modelOptions = active ? (active.freeOnly ? (active.freeModels ?? []) : active.models).slice() : []
  if (active?.model && !modelOptions.includes(active.model)) modelOptions.unshift(active.model)
  const ready = !!bridge && !!active?.model

  return (
    <PageShell
      title="Engine"
      sub="Self-driving agent — real files, real commands, every action audited"
      onBack={onBack}
    >
      <div className="engine-page">
        {!bridge && (
          <div className="engine-banner panel">
            <AlertTriangle size={14} />
            <div>
              <strong>Browser mode.</strong> The engine needs OS access, which only exists in the desktop shell. Run{' '}
              <code>npm run desktop:dev</code> to open ORVEX as a desktop app. Everything on this page stays disabled here.
            </div>
          </div>
        )}

        <div className="engine-grid">
          <div className="engine-col">
            <section className="panel engine-card">
              <div className="agent-log-head">
                <Cpu size={14} /> Goal
                <span className="dim" style={{ fontSize: 9.5 }}>
                  {orchestrate ? 'plan → verify' : 'single loop'} · guardrails on
                </span>
                <div className="engine-voice">
                  <button
                    className={`engine-voice-btn ${voiceRun ? 'active' : ''}`}
                    onClick={toggleVoiceRun}
                    title="Voice run — speak a goal, the engine starts when you pause, and the result is read back"
                    aria-pressed={voiceRun}
                    aria-label="Toggle voice run"
                  >
                    <AudioLines size={12} />
                  </button>
                  <button
                    className={`engine-voice-btn ${dictating ? 'active' : ''}`}
                    onClick={toggleDictation}
                    title={dictating ? 'Stop dictation' : 'Dictate the goal'}
                    aria-pressed={dictating}
                    aria-label={dictating ? 'Stop dictation' : 'Dictate the goal'}
                  >
                    {dictating ? <MicOff size={12} /> : <Mic size={12} />}
                  </button>
                </div>
              </div>
              <div className="engine-form">
                <textarea
                  ref={goalElRef}
                  className="engine-goal"
                  placeholder="e.g. Check what's on my Desktop, summarize the files in a note on the Desktop, then open my Downloads folder."
                  value={goal}
                  onChange={(e) => {
                    setGoal(e.target.value)
                    goalRef.current = e.target.value
                  }}
                  disabled={running}
                  rows={3}
                  aria-label="Engine goal"
                />
                <div className="engine-meta">
                  <label className="engine-chip">
                    brain
                    <select
                      className="select"
                      value={activeId ?? ''}
                      onChange={(e) => setActiveId(e.target.value || null)}
                      disabled={running}
                    >
                      {!active && <option value="">no provider</option>}
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="engine-chip">
                    model
                    <select
                      className="select"
                      value={active?.model ?? ''}
                      onChange={(e) => active && upsert({ ...active, model: e.target.value })}
                      disabled={running || !active}
                    >
                      {modelOptions.map((m) => (
                        <option key={m} value={m}>
                          {m}
                          {active?.freeOnly && !(active.freeModels ?? []).includes(m) ? ' · not free' : ''}
                        </option>
                      ))}
                      {active && !active.model && <option value="">no model</option>}
                      {active?.freeOnly && modelOptions.length === 0 && <option value="">no free models</option>}
                    </select>
                    <button
                      className="ghost-btn"
                      onClick={() => void pullModels()}
                      disabled={running || !active || modelsBusy}
                      title="Fetch the live model list from this provider"
                    >
                      {modelsBusy ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}
                    </button>
                  </label>
                  <label className="engine-chip">
                    local
                    <select className="select" value={localId} onChange={(e) => setLocalId(e.target.value)} disabled={running}>
                      <option value="none">off</option>
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} · {p.model || 'no model'}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="engine-actions">
                  <button className="engine-run" onClick={() => void start()} disabled={!ready || running}>
                    {running ? paused ? <Pause size={13} /> : <Loader2 size={13} className="spin" /> : <Play size={13} />}
                    {running ? (paused ? 'Paused' : 'Running…') : orchestrate ? 'Plan & run' : 'Start engine'}
                  </button>
                  <button className="ghost-btn engine-stop" onClick={stop} disabled={!running}>
                    <Square size={11} />
                    Stop
                  </button>
                  {running && (
                    <button className="ghost-btn engine-pause" onClick={() => void togglePause()}>
                      {paused ? <Play size={11} /> : <Pause size={11} />}
                      {paused ? 'Resume' : 'Pause'}
                    </button>
                  )}
                </div>
                <label className="engine-fullauto">
                  <input
                    type="checkbox"
                    checked={orchestrate}
                    onChange={(e) => setOrchestrate(e.target.checked)}
                    disabled={running}
                  />
                  <span>
                    <strong>Plan → verify</strong> — split the goal into checked steps, retry failures, replan once, resume later
                  </span>
                </label>
                <label className="engine-fullauto">
                  <input
                    type="checkbox"
                    checked={autoResume}
                    onChange={(e) => void toggleAutoResume(e.target.checked)}
                  />
                  <span>
                    <strong>Auto-resume</strong> — after a restart, continue the last interrupted plan; verified steps are not repeated, and a step
                    that was mid-flight asks before running again
                  </span>
                </label>
                {!running && resumable.length > 0 && (
                  <div className="engine-resume">
                    <div className="engine-resume-head">
                      <History size={12} /> Unfinished plans
                    </div>
                    {resumable.slice(0, 4).map((run) => {
                      const plan = run.checkpoint?.plan ?? []
                      const done = plan.filter((s) => s.status === 'done').length
                      return (
                        <div key={run.id} className="engine-resume-row">
                          <div className="engine-resume-info">
                            <strong>{run.goal?.slice(0, 100) || run.id}</strong>
                            <span className="dim">
                              {run.status} · {new Date(run.startedAt).toLocaleString()}
                              {plan.length ? ` · ${done}/${plan.length} steps` : ''}
                            </span>
                          </div>
                          <button className="ghost-btn" onClick={() => void resumeRun(run)} disabled={!ready}>
                            Resume
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
                <p className={`engine-hint ${dictating && voice.error ? 'bad' : ''}`}>
                  {dictating
                    ? (voice.error ??
                      (voice.interim
                        ? `“${voice.interim}”`
                        : voiceRun
                          ? 'Voice run armed — speak, then pause.'
                          : 'Listening — pause to fill the goal.'))
                    : 'Local model compacts long tool output; the cloud brain decides.'}
                </p>
              </div>
            </section>

            <section className="panel engine-card">
              <div className="agent-log-head">
                <ShieldCheck size={14} /> Guardrails
              </div>
              <ul className="engine-guards">
                <li>System folders (Windows, Program Files, ProgramData) — blocked</li>
                <li>Passwords, browser login data, wallet files, private keys — blocked</li>
                <li>format / diskpart / recursive delete / registry / shutdown — blocked</li>
                <li>
                  {fullAuto
                    ? 'Deleting files, installers, installs and git push — auto-approved (full auto)'
                    : 'Deleting files, installers, installs and git push — need one Allow click'}
                </li>
                <li>No delete tool exists; writes need an explicit path</li>
                <li>Every tool call is appended to an on-disk audit log</li>
              </ul>
              <label className="engine-fullauto">
                <input
                  type="checkbox"
                  checked={fullAuto}
                  onChange={(e) => {
                    setFullAuto(e.target.checked)
                    try {
                      localStorage.setItem(FULL_AUTO_KEY, e.target.checked ? '1' : '0')
                    } catch {
                      /* preference is optional */
                    }
                  }}
                />
                <span>
                  <strong>Full auto</strong> — approve risky steps without asking
                </span>
              </label>
              {fullAuto && (
                <p className="engine-fullauto-warn">
                  Deleting, installing and publishing steps will run on their own. Hard blocks stay on.
                </p>
              )}
              <div className="engine-audit-foot">
                <button className="ghost-btn" onClick={runProbe} disabled={!bridge || probing}>
                  {probing ? <Loader2 size={11} className="spin" /> : <Terminal size={11} />}
                  Test OS access
                </button>
                {env && <span className="dim">Electron {env.versions.electron} · {env.platform}/{env.arch}</span>}
                {env?.hotkey && (
                  <span className="dim">Show/hide: {env.hotkey.replace('CommandOrControl', 'Ctrl')}</span>
                )}
              </div>
              {probe && <pre className="engine-probe">{probe}</pre>}
            </section>

            <section className="panel engine-card">
              <div className="agent-log-head">
                <Brain size={14} /> Long-term memory
                <span className="dim" style={{ marginLeft: 'auto', fontSize: 9.5 }}>
                  {memoryBytes} bytes{memoryDirty ? ' · edited' : ''}
                </span>
              </div>
              <div className="engine-memory">
                <textarea
                  className="engine-memory-text"
                  value={memoryText}
                  onChange={(e) => {
                    setMemoryText(e.target.value)
                    setMemoryDirty(true)
                    memoryDirtyRef.current = true
                  }}
                  placeholder={
                    bridge
                      ? 'Empty. The engine appends durable notes here after runs — you can edit them too.'
                      : 'Available in the desktop app.'
                  }
                  disabled={!bridge}
                  rows={2}
                  aria-label="Engine memory"
                />
                <div className="engine-memory-actions">
                  <button className="ghost-btn" onClick={saveMemory} disabled={!bridge || !memoryDirty}>
                    Save
                  </button>
                  <button className="ghost-btn" onClick={clearMemory} disabled={!bridge || (!memoryText && !memoryDirty)}>
                    Clear
                  </button>
                  <span className="dim">loaded into every run</span>
                </div>
              </div>
            </section>
          </div>

          <div className="engine-col wide">
            <section className="panel engine-card grow">
              <div className="agent-log-head">
                <Bot size={14} /> Timeline
                {status && (
                  <span className="engine-status">
                    {paused ? <Pause size={11} /> : <Loader2 size={11} className="spin" />} {status}
                  </span>
                )}
                <button className="ghost-btn ml-auto" onClick={() => setEvents([])} disabled={running} title="Clear timeline">
                  Clear
                </button>
              </div>
              <div className="engine-timeline" ref={scrollRef}>
                {events.length === 0 && !summary && (
                  <p className="dim engine-empty">
                    Nothing yet. Give the engine a goal — it will plan, call tools, and report back here step by step.
                  </p>
                )}
                {events.map((ev, i) => (
                  <EventRow
                    key={`${ev.type}-${i}`}
                    ev={ev}
                    decision={ev.type === 'approval_request' ? decisions[ev.id] : undefined}
                    onApprove={answerApproval}
                  />
                ))}
                {summary && (
                  <div className={`engine-summary ${summary.ok ? 'ok' : summary.cancelled ? '' : 'bad'}`}>
                    <strong>
                      {summary.ok ? 'Goal complete' : summary.cancelled ? 'Stopped' : 'Did not finish'}
                      <span className="dim"> · {summary.steps} steps · {(summary.ms / 1000).toFixed(1)}s</span>
                    </strong>
                    <p>{summary.text}</p>
                  </div>
                )}
              </div>
            </section>

            <section className="panel engine-card audit">
              <div className="agent-log-head">
                <ShieldCheck size={14} /> Audit log
                <button className="ghost-btn ml-auto" onClick={loadAudit} disabled={!bridge} title="Refresh audit log">
                  <RefreshCw size={11} />
                </button>
              </div>
              <div className="engine-audit-list">
                {audit.length === 0 && <p className="dim">No tool calls recorded yet.</p>}
                {audit
                  .slice()
                  .reverse()
                  .map((a, i) => (
                    <div key={`${a.ts}-${i}`} className="engine-audit-row">
                      <span className="dim">{new Date(a.ts).toLocaleTimeString('en-US', { hour12: false })}</span>
                      <span className={`engine-audit-tool ${a.ok === false ? 'bad' : ''}`}>{a.tool ?? a.kind}</span>
                      <span className="engine-audit-args">{a.error ?? a.args ?? ''}</span>
                      {typeof a.ms === 'number' && <span className="dim">{a.ms}ms</span>}
                    </div>
                  ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </PageShell>
  )
}
