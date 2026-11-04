import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Clock,
  Inbox,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Users,
} from 'lucide-react'
import PageShell from './PageShell'
import { loadProviders } from '../data/providers'
import type {
  IpcResult,
  OrvexWorkforceAgent,
  OrvexWorkforceMessage,
  OrvexWorkforceModel,
  OrvexWorkforceShift,
  OrvexWorkforceStatus,
} from '../types/desktop'

type Notify = (msg: string) => void
type Props = { onBack: () => void; notify: Notify }

type Form = {
  name: string
  role: string
  mission: string
  modelKey: string
  schedule: string
  budget: string
}

const EMPTY: Form = { name: '', role: 'operator', mission: '', modelKey: 'local', schedule: '', budget: '0' }

function msg(err: unknown): string {
  return err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err)
}

async function call<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const res = await promise
  if (!res.ok) throw new Error(res.error)
  return res.data
}

function time(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleString() : '—'
}

function money(value: number): string {
  return `$${Number(value || 0).toFixed(2)}`
}

function modelLabel(model: OrvexWorkforceModel | null): string {
  return model ? `${model.name} · ${model.model}` : 'Local Brain'
}

export default function WorkforcePage({ onBack, notify }: Props) {
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const [status, setStatus] = useState<OrvexWorkforceStatus | null>(null)
  const [agents, setAgents] = useState<OrvexWorkforceAgent[]>([])
  const [shifts, setShifts] = useState<OrvexWorkforceShift[]>([])
  const [inbox, setInbox] = useState<OrvexWorkforceMessage[]>([])
  const [form, setForm] = useState<Form>(EMPTY)
  const [editId, setEditId] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const providerState = useMemo(() => loadProviders(), [])
  const modelOptions = useMemo(() => {
    const options: { key: string; label: string }[] = [{ key: 'local', label: 'Local Brain (running local model)' }]
    for (const provider of providerState.providers) {
      if (!provider.baseUrl) continue
      const models = provider.models.filter(Boolean)
      if (!models.length && provider.model) models.push(provider.model)
      for (const model of models) {
        options.push({ key: `${provider.id}::${model}`, label: `${provider.name} · ${model}` })
      }
    }
    return options
  }, [providerState])

  const load = useCallback(async () => {
    if (!bridge) return
    const [nextStatus, agentList, shiftList, inboxList] = await Promise.all([
      call(bridge.workforce.status()),
      call(bridge.workforce.agents()),
      call(bridge.workforce.shifts({ limit: 60 })),
      call(bridge.workforce.inbox({ limit: 40 })),
    ])
    setStatus(nextStatus)
    setAgents(agentList.agents)
    setShifts(shiftList.shifts)
    setInbox(inboxList.messages)
  }, [bridge])

  useEffect(() => {
    void load().catch((err) => setError(msg(err)))
  }, [load])

  useEffect(() => {
    if (!bridge) return
    return bridge.workforce.onChange(() => {
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

  const selectedAgent = useMemo(() => agents.find((agent) => agent.id === selected) ?? null, [agents, selected])
  const agentShifts = useMemo(
    () => (selected ? shifts.filter((shift) => shift.agentId === selected) : shifts),
    [shifts, selected],
  )

  const modelFromKey = (key: string): OrvexWorkforceModel | null => {
    if (!key || key === 'local') return null
    const [providerId, ...rest] = key.split('::')
    const model = rest.join('::')
    const provider = providerState.providers.find((p) => p.id === providerId)
    if (!provider || !model) return null
    return {
      providerId: provider.id,
      presetId: provider.presetId,
      name: provider.name,
      baseUrl: provider.baseUrl,
      model,
      api: provider.api,
    }
  }

  const beginEdit = (agent: OrvexWorkforceAgent) => {
    setEditId(agent.id)
    setSelected(agent.id)
    setForm({
      name: agent.name,
      role: agent.role,
      mission: agent.mission,
      modelKey: agent.model ? `${agent.model.providerId}::${agent.model.model}` : 'local',
      schedule: agent.schedule ?? '',
      budget: String(agent.budgetUsd || 0),
    })
  }

  const resetForm = () => {
    setEditId(null)
    setForm(EMPTY)
  }

  const submit = () =>
    run('save', async () => {
      if (!bridge) return
      const budget = Number(form.budget)
      if (!Number.isFinite(budget) || budget < 0) throw new Error('Budget must be 0 (unlimited) or a positive amount.')
      const payload = {
        name: form.name,
        role: form.role,
        mission: form.mission,
        model: modelFromKey(form.modelKey),
        schedule: form.schedule.trim() || null,
        budgetUsd: budget,
      }
      if (editId) {
        const agent = await call(bridge.workforce.updateAgent({ id: editId, ...payload }))
        notify(`${agent.name} updated`)
      } else {
        const agent = await call(bridge.workforce.createAgent(payload))
        setSelected(agent.id)
        notify(`${agent.name} is active`)
      }
      resetForm()
      await load()
    })

  const runShift = (agent: OrvexWorkforceAgent) =>
    run(`run-${agent.id}`, async () => {
      if (!bridge) return
      await call(bridge.workforce.startShift(agent.id))
      setSelected(agent.id)
      notify(`${agent.name} started a shift`)
      await load()
    })

  const toggleAgent = (agent: OrvexWorkforceAgent) =>
    run(`toggle-${agent.id}`, async () => {
      if (!bridge) return
      if (agent.status === 'active') await call(bridge.workforce.pauseAgent(agent.id))
      else await call(bridge.workforce.resumeAgent(agent.id))
      notify(`${agent.name} ${agent.status === 'active' ? 'paused' : 'resumed'}`)
      await load()
    })

  const removeAgent = (agent: OrvexWorkforceAgent) =>
    run(`delete-${agent.id}`, async () => {
      if (!bridge || !window.confirm(`Delete ${agent.name}, its shift history and inbox?`)) return
      await call(bridge.workforce.deleteAgent(agent.id))
      if (selected === agent.id) setSelected(null)
      if (editId === agent.id) resetForm()
      notify(`${agent.name} deleted`)
      await load()
    })

  const markRead = (message: OrvexWorkforceMessage) =>
    run(`read-${message.id}`, async () => {
      if (!bridge) return
      await call(bridge.workforce.readInbox({ id: message.id }))
      await load()
    })

  const readAll = () =>
    run('read-all', async () => {
      if (!bridge) return
      await call(bridge.workforce.readInbox({ all: true }))
      await load()
    })

  const clearInbox = () =>
    run('clear-inbox', async () => {
      if (!bridge || !window.confirm('Delete every workforce message? Shift history stays.')) return
      await call(bridge.workforce.clearInbox())
      await load()
    })

  const tick = () =>
    run('tick', async () => {
      if (!bridge) return
      const result = await call(bridge.workforce.tick())
      notify(result.started.length ? 'A due shift was started' : result.skipped ? `Skipped: ${result.skipped}` : 'No shift was due')
      await load()
    })

  return (
    <PageShell
      title="Workforce"
      sub="Persistent agents, scheduled shifts, budgets and an inbox of real reports"
      onBack={onBack}
      actions={
        <button className="adv-btn" disabled={busy !== null} onClick={() => void run('refresh', load)}>
          {busy === 'refresh' ? <Loader2 size={13} className="adv-spin" /> : <RefreshCw size={13} />} Refresh
        </button>
      }
    >
      <div className="adv">
        {error && (
          <p className="adv-error" role="alert">
            <AlertTriangle size={13} /> {error}
          </p>
        )}

        {status && (
          <section className="adv-card adv-card-wide">
            <div className="adv-card-head">
              <h3>Workforce</h3>
              <span className="adv-hint">
                scheduler {status.scheduler ? `on · every ${Math.round(status.tickMs / 1000)}s` : 'off'}
                {status.engineBusy ? ' · engine busy' : ''}
              </span>
            </div>
            <div className="adv-tiles">
              <div className="adv-tile"><span>Agents</span><b>{status.total}</b><small>{status.active} active · {status.paused} paused</small></div>
              <div className="adv-tile"><span>Scheduled</span><b>{status.scheduled}</b><small>next {time(status.nextRunAt)}</small></div>
              <div className="adv-tile"><span>In flight</span><b>{status.inFlight}</b><small>real engine runs</small></div>
              <div className="adv-tile"><span>Unread</span><b>{status.unread}</b><small>reports in the inbox</small></div>
              <div className="adv-tile"><span>Spent</span><b>{money(status.spent)}</b><small>{status.budget > 0 ? `of ${money(status.budget)} budget` : 'no budget set'}</small></div>
            </div>
            <div className="adv-actions">
              <button className="adv-btn" disabled={busy !== null} onClick={() => void tick()}>
                {busy === 'tick' ? <Loader2 size={13} className="adv-spin" /> : <Clock size={13} />} Run due shifts now
              </button>
              <span className="adv-hint">Shifts are real agent runs; approvals still wait for you and time out as denied.</span>
            </div>
          </section>
        )}

        <div className="adv-grid">
          <section className="adv-card">
            <div className="adv-card-head">
              <h3>{editId ? 'Edit agent' : 'New agent'}</h3>
              <span className="adv-hint">role, mission, model</span>
            </div>
            <div className="adv-form">
              <div className="adv-form-row">
                <label className="adv-field">
                  <span>Name</span>
                  <input className="adv-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Research scout" />
                </label>
                <label className="adv-field">
                  <span>Role</span>
                  <input className="adv-input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="operator" />
                </label>
              </div>
              <label className="adv-field">
                <span>Mission</span>
                <textarea
                  className="adv-textarea"
                  rows={3}
                  value={form.mission}
                  onChange={(e) => setForm({ ...form, mission: e.target.value })}
                  placeholder="Every weekday, check the project inbox and write a short status report with blockers."
                />
              </label>
              <label className="adv-field">
                <span>Model</span>
                <select className="adv-input" value={form.modelKey} onChange={(e) => setForm({ ...form, modelKey: e.target.value })}>
                  {modelOptions.map((option) => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                  {form.modelKey !== 'local' && !modelOptions.some((option) => option.key === form.modelKey) && (
                    <option value={form.modelKey}>{form.modelKey.replace('::', ' · ')} (saved)</option>
                  )}
                </select>
              </label>
              <div className="adv-form-row">
                <label className="adv-field">
                  <span>Cron schedule</span>
                  <input
                    className="adv-input"
                    value={form.schedule}
                    onChange={(e) => setForm({ ...form, schedule: e.target.value })}
                    placeholder="0 9 * * 1-5"
                  />
                </label>
                <label className="adv-field">
                  <span>Budget (USD, 0 = unlimited)</span>
                  <input
                    className="adv-input"
                    inputMode="decimal"
                    value={form.budget}
                    onChange={(e) => setForm({ ...form, budget: e.target.value })}
                    placeholder="0"
                  />
                </label>
              </div>
              <p className="adv-note">Leave the schedule empty for manual shifts. Keys stay in the vault; only the model assignment is stored.</p>
              <div className="adv-actions">
                <button className="adv-btn adv-btn-primary" disabled={busy !== null} onClick={() => void submit()}>
                  {busy === 'save' ? <Loader2 size={13} className="adv-spin" /> : editId ? <RefreshCw size={13} /> : <Plus size={13} />}
                  {editId ? 'Save changes' : 'Create agent'}
                </button>
                {editId && (
                  <button className="adv-btn" disabled={busy !== null} onClick={resetForm}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
          </section>

          <section className="adv-card adv-card-wide">
            <div className="adv-card-head">
              <h3>Agents</h3>
              <span className="adv-hint">{agents.length} configured</span>
            </div>
            {agents.length === 0 ? (
              <p className="adv-empty">No agents yet. Create one with a mission and a model, then start a shift.</p>
            ) : (
              agents.map((agent) => (
                <div
                  key={agent.id}
                  className={`wf-agent ${selected === agent.id ? 'active' : ''}`}
                  onClick={() => setSelected(agent.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') setSelected(agent.id)
                  }}
                >
                  <div className="wf-agent-head">
                    <Users size={13} />
                    <b>{agent.name}</b>
                    <span className={`adv-chip ${agent.status === 'active' ? 'adv-chip-ok' : 'adv-chip-warn'}`}>{agent.status}</span>
                    <span className="adv-hint">{agent.role}</span>
                    <span className="ml-auto adv-hint">
                      {agent.schedule ? `cron ${agent.schedule}` : 'manual'}
                      {agent.budgetBlocked ? ' · budget reached' : ''}
                    </span>
                    <div className="adv-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="adv-btn adv-btn-sm adv-btn-primary"
                        disabled={busy !== null || agent.status !== 'active' || agent.budgetBlocked}
                        onClick={() => void runShift(agent)}
                        title="Start a shift now"
                      >
                        {busy === `run-${agent.id}` ? <Loader2 size={12} className="adv-spin" /> : <Play size={12} />} Run
                      </button>
                      <button className="adv-btn adv-btn-sm" disabled={busy !== null} onClick={() => void toggleAgent(agent)}>
                        {agent.status === 'active' ? <Pause size={12} /> : <Play size={12} />}
                        {agent.status === 'active' ? 'Pause' : 'Resume'}
                      </button>
                      <button className="adv-btn adv-btn-sm" disabled={busy !== null} onClick={() => beginEdit(agent)}>
                        Edit
                      </button>
                      <button className="adv-btn adv-btn-sm adv-btn-danger" disabled={busy !== null} onClick={() => void removeAgent(agent)}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                  <p className="wf-mission">{agent.mission}</p>
                  <div className="adv-kv">
                    <span>Model</span><b>{modelLabel(agent.model)}</b>
                    <span>Next shift</span><b>{time(agent.nextRunAt)}</b>
                    <span>Last shift</span><b>{time(agent.lastRunAt)}</b>
                    <span>Runs</span><b>{agent.runs} · {agent.successes} done</b>
                    <span>Spent</span><b>{money(agent.spentUsd)}{agent.budgetUsd > 0 ? ` / ${money(agent.budgetUsd)}` : ' · unlimited'}</b>
                  </div>
                  {agent.budgetUsd > 0 && (
                    <div className="training-bar" aria-label="Budget usage">
                      <span style={{ width: `${Math.min(100, (agent.spentUsd / agent.budgetUsd) * 100)}%` }} />
                    </div>
                  )}
                </div>
              ))
            )}
          </section>

          <section className="adv-card adv-card-wide">
            <div className="adv-card-head">
              <h3>Shifts</h3>
              <span className="adv-hint">{selectedAgent ? `${selectedAgent.name} · ${agentShifts.length}` : 'all agents · newest first'}</span>
            </div>
            {agentShifts.length === 0 ? (
              <p className="adv-empty">No shifts recorded. A shift starts only when a model is reachable and the engine is idle.</p>
            ) : (
              <div className="adv-table wf-shifts">
                <div className="adv-tr adv-th">
                  <span>Started</span><span>Agent</span><span>Status</span><span>Goal</span><span>Summary</span><span>Steps</span>
                </div>
                {agentShifts.map((shift) => (
                  <div className="adv-tr" key={shift.id}>
                    <span title={time(shift.startedAt)}>{time(shift.startedAt)}</span>
                    <span>{shift.agentName ?? shift.agentId}</span>
                    <span>{shift.status}{shift.trigger === 'schedule' ? ' · cron' : ''}</span>
                    <span title={shift.goal}>{shift.goal}</span>
                    <span title={shift.error || shift.summary || ''}>{shift.error || shift.summary || '—'}</span>
                    <span>{shift.steps} · {shift.tokens.toLocaleString()} tok · {money(shift.costUsd)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="adv-card adv-card-wide">
            <div className="adv-card-head">
              <h3>Inbox</h3>
              <span className="adv-hint">{inbox.filter((m) => !m.read).length} unread</span>
              <div className="adv-actions" style={{ marginLeft: 'auto' }}>
                <button className="adv-btn adv-btn-sm" disabled={busy !== null || !inbox.length} onClick={() => void readAll()}>
                  Mark all read
                </button>
                <button className="adv-btn adv-btn-sm adv-btn-danger" disabled={busy !== null || !inbox.length} onClick={() => void clearInbox()}>
                  Clear
                </button>
              </div>
            </div>
            {inbox.length === 0 ? (
              <p className="adv-empty">Empty. Finished shifts drop their real summary here.</p>
            ) : (
              inbox.map((message) => (
                <div key={message.id} className={`wf-note ${message.read ? '' : 'unread'}`}>
                  <div className="wf-note-head">
                    <Inbox size={12} />
                    <b>{message.title}</b>
                    <span className="ml-auto adv-hint">{time(message.createdAt)}</span>
                  </div>
                  <pre className="wf-note-body">{message.body}</pre>
                  {!message.read && (
                    <button className="adv-btn adv-btn-sm" disabled={busy !== null} onClick={() => void markRead(message)}>
                      Mark read
                    </button>
                  )}
                </div>
              ))
            )}
          </section>
        </div>
      </div>
    </PageShell>
  )
}
