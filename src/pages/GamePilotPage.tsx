import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Gamepad2,
  Keyboard,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Square,
  Trash2,
  Trophy,
  X,
} from 'lucide-react'
import PageShell from './PageShell'
import type {
  IpcResult,
  OrvexDesktopWindow,
  OrvexGameProfile,
  OrvexGameRegion,
  OrvexGameStatus,
} from '../types/desktop'

type Props = { onBack: () => void; notify: (msg: string) => void }

type Draft = {
  id: string | null
  name: string
  windowTitle: string
  goal: string
  policy: 'vision' | 'macro'
  actionsText: string
  macroText: string
  region: string
  scoreRegion: string
  scoreRegex: string
  targetScore: string
  intervalMs: string
  maxMinutes: string
  autoFocus: boolean
}

const EMPTY: Draft = {
  id: null,
  name: '',
  windowTitle: '',
  goal: 'Reach the highest score I can.',
  policy: 'vision',
  actionsText: 'W, A, S, D, SPACE',
  macroText: '',
  region: '',
  scoreRegion: '',
  scoreRegex: '',
  targetScore: '',
  intervalMs: '1500',
  maxMinutes: '30',
  autoFocus: true,
}

function msg(err: unknown): string {
  return err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err)
}

async function call<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const res = await promise
  if (!res.ok) throw new Error(res.error)
  return res.data
}

function regionText(region: OrvexGameRegion | null | undefined): string {
  return region ? `${region.x},${region.y},${region.width},${region.height}` : ''
}

function parseRegion(text: string, label: string): OrvexGameRegion | null {
  const raw = text.trim()
  if (!raw) return null
  const parts = raw.split(',').map((p) => Number(p.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`${label} must be four numbers: x,y,width,height.`)
  }
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
}

function parseActions(text: string): { key: string; label: string }[] {
  return text
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [keyPart, ...labelParts] = entry.split('=')
      return { key: keyPart.trim().toUpperCase(), label: labelParts.join('=').trim() }
    })
    .filter((action) => action.key)
}

function parseMacro(text: string): { keys: string; waitMs: number }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [keyPart, waitPart] = line.split('@')
      return { keys: keyPart.trim().toUpperCase(), waitMs: Math.max(0, Math.round(Number(waitPart) || 0)) }
    })
    .filter((step) => step.keys)
}

function toDraft(profile: OrvexGameProfile): Draft {
  return {
    id: profile.id,
    name: profile.name,
    windowTitle: profile.windowTitle,
    goal: profile.goal,
    policy: profile.policy,
    actionsText: profile.actions.map((a) => (a.label ? `${a.key}=${a.label}` : a.key)).join(', '),
    macroText: profile.macro.map((m) => (m.waitMs ? `${m.keys}@${m.waitMs}` : m.keys)).join('\n'),
    region: regionText(profile.region),
    scoreRegion: regionText(profile.scoreRegion),
    scoreRegex: profile.scoreRegex,
    targetScore: profile.targetScore === null ? '' : String(profile.targetScore),
    intervalMs: String(profile.intervalMs),
    maxMinutes: String(profile.maxMinutes),
    autoFocus: profile.autoFocus,
  }
}

function clock(ms: number | undefined): string {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000)
  const m = Math.floor(total / 60)
  const s = Math.floor(total % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function GamePilotPage({ onBack, notify }: Props) {
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const [profiles, setProfiles] = useState<OrvexGameProfile[]>([])
  const [status, setStatus] = useState<OrvexGameStatus | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [windows, setWindows] = useState<OrvexDesktopWindow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!bridge) return
    const [nextProfiles, nextStatus] = await Promise.all([
      call(bridge.gamePilot.profiles()),
      call(bridge.gamePilot.status()),
    ])
    setProfiles(nextProfiles)
    setStatus(nextStatus)
  }, [bridge])

  useEffect(() => {
    load()
      .catch((err) => setError(msg(err)))
      .finally(() => setLoading(false))
  }, [load])

  useEffect(() => {
    if (!bridge) return
    return bridge.gamePilot.onEvent((event) => {
      setStatus(event)
      if (event.type === 'finished') {
        setBusy(null)
        notify(`Game Pilot stopped — ${event.stopReasonLabel || 'finished'} (${event.ticks || 0} actions)`)
      }
    })
  }, [bridge, notify])

  const running = !!status?.running
  const record = useMemo(() => {
    if (!status) return []
    return [...(status.history || [])].reverse()
  }, [status])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current))
  }

  const reloadWindows = async () => {
    if (!bridge) return
    setBusy('windows')
    try {
      const result = await call(bridge.desktop.windows({ visibleOnly: true, limit: 60 }))
      setWindows(result.windows || [])
      if (!result.windows?.length) setError('No visible windows were found. Open the game first.')
    } catch (err) {
      setError(msg(err))
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    if (!bridge || !draft) return
    setBusy('save')
    setError(null)
    try {
      const saved = await call(
        bridge.gamePilot.saveProfile({
          ...(draft.id ? { id: draft.id } : {}),
          name: draft.name,
          windowTitle: draft.windowTitle,
          goal: draft.goal,
          policy: draft.policy,
          actions: parseActions(draft.actionsText),
          macro: parseMacro(draft.macroText),
          region: parseRegion(draft.region, 'Game region'),
          scoreRegion: parseRegion(draft.scoreRegion, 'Score region'),
          scoreRegex: draft.scoreRegex.trim(),
          targetScore: draft.targetScore.trim() === '' ? null : Number(draft.targetScore),
          intervalMs: Number(draft.intervalMs) || 1500,
          maxMinutes: Number(draft.maxMinutes) || 30,
          autoFocus: draft.autoFocus,
        }),
      )
      await load()
      setDraft(toDraft(saved))
      notify(`Saved pilot profile "${saved.name}".`)
    } catch (err) {
      setError(msg(err))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (profile: OrvexGameProfile) => {
    if (!bridge) return
    if (!window.confirm(`Delete the pilot profile "${profile.name}"?`)) return
    setBusy('delete')
    setError(null)
    try {
      await call(bridge.gamePilot.deleteProfile(profile.id))
      if (draft?.id === profile.id) setDraft(null)
      await load()
      notify('Pilot profile deleted.')
    } catch (err) {
      setError(msg(err))
    } finally {
      setBusy(null)
    }
  }

  const start = async (profile: OrvexGameProfile) => {
    if (!bridge) return
    setBusy('start')
    setError(null)
    try {
      const next = await call(bridge.gamePilot.start(profile.id))
      setStatus(next)
    } catch (err) {
      setError(msg(err))
    } finally {
      setBusy(null)
    }
  }

  const stop = async () => {
    if (!bridge) return
    setBusy('stop')
    try {
      await call(bridge.gamePilot.stop())
    } catch (err) {
      setError(msg(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <PageShell
      title="Game Pilot"
      sub="Plays a named game window with allow-listed keys, keeps the score honest through OCR, and records every run as a training episode"
      onBack={onBack}
      actions={
        <button
          className="adv-btn"
          onClick={() => {
            setDraft({ ...EMPTY })
            setWindows([])
          }}
        >
          <Plus size={13} /> New profile
        </button>
      }
    >
      <div className="adv game">
        {error && (
          <p className="adv-error">
            <AlertTriangle size={13} /> {error}
            <button className="adv-btn" style={{ marginLeft: 'auto' }} onClick={() => setError(null)}>
              <X size={12} />
            </button>
          </p>
        )}

        <p className="adv-note game-caveat">
          <Keyboard size={12} /> Keys are sent only while the configured window is in front, and only keys from the
          profile are ever pressed. A vision tick costs a screenshot plus a model call, so this is built for turn-based,
          puzzle, management and grinding loops — not fast shooters. Many online games treat automation as cheating;
          use it on games where that is your call.
        </p>

        <div className="adv-grid">
          <section className="adv-card">
            <div className="adv-card-head">
              <Gamepad2 size={13} />
              <b>Pilot profiles</b>
              <button className="adv-btn" onClick={() => void load().catch((err) => setError(msg(err)))} disabled={!!busy}>
                <RefreshCw size={12} /> Refresh
              </button>
            </div>
            {loading && <p className="adv-empty">Reading profiles…</p>}
            {!loading && !profiles.length && (
              <p className="adv-empty">No profiles yet. Create one with the game window and the keys it accepts.</p>
            )}
            {profiles.map((profile) => (
              <div className="game-profile" key={profile.id}>
                <div className="game-profile-main">
                  <b>
                    {profile.name}
                    {status?.running && status.profileId === profile.id ? ' · running' : ''}
                  </b>
                  <span>
                    {profile.policy} · {profile.windowTitle} · every {profile.intervalMs} ms · max {profile.maxMinutes} min
                  </span>
                </div>
                <button
                  className="adv-btn"
                  title="Edit profile"
                  onClick={() => setDraft(toDraft(profile))}
                  disabled={!!busy}
                >
                  <Pencil size={12} />
                </button>
                <button className="adv-btn adv-btn-primary" onClick={() => void start(profile)} disabled={running || !!busy}>
                  <Play size={12} /> Run
                </button>
                <button className="adv-btn adv-btn-danger" onClick={() => void remove(profile)} disabled={running || !!busy}>
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </section>

          <section className="adv-card">
            <div className="adv-card-head">
              <Trophy size={13} />
              <b>{running ? 'Live run' : 'Run panel'}</b>
              <span className="adv-hint">
                {running
                  ? `Stop key ${status?.hotkey || 'Ctrl+Alt+Shift+G'}${status?.hotkeyRegistered === false ? ' (unavailable — use Stop)' : ''}`
                  : status?.stopReasonLabel || ''}
              </span>
            </div>

            {status && (running || status.ticks !== undefined) ? (
              <>
                <div className="game-stats">
                  <div>
                    <span>Score</span>
                    <b>{status.lastScore ?? '—'}</b>
                  </div>
                  <div>
                    <span>Best</span>
                    <b>{status.bestScore ?? '—'}</b>
                  </div>
                  <div>
                    <span>Actions</span>
                    <b>{status.ticks ?? 0}</b>
                  </div>
                </div>
                <div className="game-live">
                  <span className={`game-dot${running ? ' live' : ''}`} />
                  <div className="game-live-main">
                    <b>{running ? status.name || 'Running' : status.stopReasonLabel || 'Finished'}</b>
                    <p className="adv-hint">
                      {status.lastAction ? `Last: ${status.lastAction}` : 'Waiting for the first action.'}
                      {running && status.startedAt ? ` · ${clock((status.endsAt || 0) - Date.now())} left` : ''}
                    </p>
                  </div>
                  {running && (
                    <button className="adv-btn adv-btn-danger" onClick={() => void stop()} disabled={busy === 'stop'}>
                      <Square size={12} /> Stop
                    </button>
                  )}
                </div>
                {status.lastNote && <p className="adv-hint">{status.lastNote}</p>}
                {status.error && <p className="adv-error">{status.error}</p>}
                <div className="game-history">
                  {record.length ? (
                    record.map((entry, index) => (
                      <div key={`${entry.at}-${index}`}>
                        <time>{new Date(entry.at).toLocaleTimeString()}</time>
                        <b>{entry.action || '—'}</b>
                        <span>{entry.note}</span>
                      </div>
                    ))
                  ) : (
                    <p className="adv-empty">No actions recorded yet.</p>
                  )}
                </div>
              </>
            ) : (
              <p className="adv-empty">
                {running ? 'Starting…' : 'No run yet. Pick a profile and press Run while the game is open.'}
              </p>
            )}
          </section>

          {draft && (
            <section className="adv-card adv-card-wide">
              <div className="adv-card-head">
                <Keyboard size={13} />
                <b>{draft.id ? 'Edit profile' : 'New profile'}</b>
                <button className="adv-btn" style={{ marginLeft: 'auto' }} onClick={() => setDraft(null)}>
                  <X size={12} /> Close
                </button>
              </div>

              <div className="game-form">
                <label className="adv-field">
                  <span>Name</span>
                  <input className="adv-input" value={draft.name} maxLength={80} onChange={(e) => set('name', e.target.value)} placeholder="Farming loop" />
                </label>
                <label className="adv-field">
                  <span>Game window title (must be in front)</span>
                  <input
                    className="adv-input"
                    value={draft.windowTitle}
                    maxLength={200}
                    onChange={(e) => set('windowTitle', e.target.value)}
                    placeholder="Exact or partial window title"
                  />
                </label>
                <div className="adv-field game-window-pick">
                  <span>Open windows</span>
                  <div className="adv-actions">
                    <button className="adv-btn" onClick={() => void reloadWindows()} disabled={busy === 'windows'}>
                      {busy === 'windows' ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} List windows
                    </button>
                    <select
                      className="adv-input"
                      value=""
                      onChange={(e) => {
                        if (e.target.value) set('windowTitle', e.target.value)
                      }}
                      disabled={!windows.length}
                    >
                      <option value="">{windows.length ? 'Pick a window…' : 'No windows listed yet'}</option>
                      {windows.map((w) => (
                        <option key={`${w.hwnd}-${w.title}`} value={w.title}>
                          {w.title}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <label className="adv-field">
                  <span>Goal</span>
                  <input className="adv-input" value={draft.goal} maxLength={300} onChange={(e) => set('goal', e.target.value)} placeholder="Clear wave 10" />
                </label>

                <label className="adv-field">
                  <span>Policy</span>
                  <select className="adv-input" value={draft.policy} onChange={(e) => set('policy', e.target.value as Draft['policy'])}>
                    <option value="vision">Vision — a model reads each screenshot</option>
                    <option value="macro">Macro — replay a fixed key sequence</option>
                  </select>
                </label>
                <label className="adv-field">
                  <span>Interval between actions (ms)</span>
                  <input className="adv-input" type="number" min={500} max={15000} step={100} value={draft.intervalMs} onChange={(e) => set('intervalMs', e.target.value)} />
                </label>

                {draft.policy === 'vision' ? (
                  <label className="adv-field">
                    <span>Allowed keys — comma separated, optional label with =</span>
                    <textarea
                      className="adv-input"
                      rows={3}
                      value={draft.actionsText}
                      onChange={(e) => set('actionsText', e.target.value)}
                      placeholder="W, A, S, D, SPACE, ENTER=confirm"
                    />
                  </label>
                ) : (
                  <label className="adv-field">
                    <span>Macro steps — one per line, KEY or KEY@waitMs</span>
                    <textarea
                      className="adv-input"
                      rows={3}
                      value={draft.macroText}
                      onChange={(e) => set('macroText', e.target.value)}
                      placeholder={'SPACE@800\nENTER\nSPACE@800'}
                    />
                  </label>
                )}

                <label className="adv-field">
                  <span>Game region — optional x,y,width,height</span>
                  <input className="adv-input" value={draft.region} onChange={(e) => set('region', e.target.value)} placeholder="leave empty for the whole screen" />
                </label>
                <label className="adv-field">
                  <span>Score region — optional x,y,width,height</span>
                  <input className="adv-input" value={draft.scoreRegion} onChange={(e) => set('scoreRegion', e.target.value)} placeholder="crop around the score" />
                </label>
                <label className="adv-field">
                  <span>Score pattern — optional regex, group 1 wins</span>
                  <input className="adv-input" value={draft.scoreRegex} onChange={(e) => set('scoreRegex', e.target.value)} placeholder="score\\D+(\\d[\\d,]*)" />
                </label>
                <label className="adv-field">
                  <span>Target score — stops the run</span>
                  <input className="adv-input" type="number" value={draft.targetScore} onChange={(e) => set('targetScore', e.target.value)} placeholder="empty = no target" />
                </label>
                <label className="adv-field">
                  <span>Maximum minutes</span>
                  <input className="adv-input" type="number" min={1} max={180} value={draft.maxMinutes} onChange={(e) => set('maxMinutes', e.target.value)} />
                </label>
                <label className="adv-field game-check">
                  <span>Focus the game window when it slips behind</span>
                  <input type="checkbox" checked={draft.autoFocus} onChange={(e) => set('autoFocus', e.target.checked)} />
                </label>
              </div>

              <div className="adv-actions">
                <button className="adv-btn adv-btn-primary" onClick={() => void save()} disabled={busy === 'save'}>
                  {busy === 'save' ? <Loader2 size={12} className="spin" /> : <Save size={12} />} Save profile
                </button>
                <span className="adv-hint">
                  Score fields only work when OCR can read the number — set a score region around the score for reliability.
                </span>
              </div>
            </section>
          )}
        </div>
      </div>
    </PageShell>
  )
}
