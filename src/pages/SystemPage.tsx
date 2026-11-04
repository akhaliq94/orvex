import { useEffect, useMemo, useState } from 'react'
import { Activity, HardDrive, Lock, Monitor, Power, Target, TriangleAlert } from 'lucide-react'
import PageShell from './PageShell'
import { onTablistKeyDown } from '../data/a11y'
import GoalTree from '../components/GoalTree'
import FailureLog from '../components/FailureLog'
import type { OrvexAppPrefs, OrvexDashboardSnapshot, OrvexDesktopProcess } from '../types/desktop'

type Props = {
  onBack: () => void
  notify: (msg: string) => void
  snapshot: OrvexDashboardSnapshot | null
  initialTab?: string | null
}

type Tab = 'monitor' | 'goals' | 'failures'

const TAB_IDS: Tab[] = ['monitor', 'goals', 'failures']

const bytes = (n: number | null | undefined) => {
  if (n == null) return 'n/a'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

const duration = (sec: number) => {
  const s = Math.max(0, Math.floor(sec))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${s % 60}s`
  return `${m}m ${s % 60}s`
}

function BigBar({ label, value, color, hint }: { label: string; value: number | null; color: string; hint?: string }) {
  const pct = value == null ? null : Math.max(0, Math.min(100, value))
  return (
    <div className="bigbar" title={hint}>
      <div className="bigbar-head">
        <span>{label}</span>
        <span>{pct == null ? 'n/a' : `${pct.toFixed(1)}%`}</span>
      </div>
      <div className="bigbar-track">
        {pct != null && (
          <div className="bigbar-fill" style={{ width: `${pct}%`, background: color, boxShadow: `0 0 12px ${color}` }} />
        )}
      </div>
    </div>
  )
}

export default function SystemPage({ onBack, notify, snapshot, initialTab }: Props) {
  const [tab, setTab] = useState<Tab>(() => (TAB_IDS.includes(initialTab as Tab) ? (initialTab as Tab) : 'monitor'))
  const [now, setNow] = useState(Date.now())
  const [procs, setProcs] = useState<OrvexDesktopProcess[]>([])
  const [procsError, setProcsError] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<OrvexAppPrefs | null>(null)
  const [prefsError, setPrefsError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const bridge = typeof window !== 'undefined' ? window.orvex : undefined

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    if (initialTab && TAB_IDS.includes(initialTab as Tab)) setTab(initialTab as Tab)
  }, [initialTab])

  useEffect(() => {
    if (!bridge) {
      setPrefsError('Desktop bridge unavailable — preferences need the ORVEX app.')
      return
    }
    void (async () => {
      const res = await bridge.app.prefs()
      if (res.ok) {
        setPrefs(res.data)
        setPrefsError(null)
      } else {
        setPrefsError(res.error)
      }
    })()
  }, [bridge])

  useEffect(() => {
    if (tab !== 'monitor' || !bridge) return
    let dead = false
    const load = async () => {
      if (document.hidden) return
      const res = await bridge.desktop.processes({ sort: 'cpu', limit: 10 })
      if (dead) return
      if (res.ok) {
        setProcs(res.data.processes)
        setProcsError(null)
      } else {
        setProcsError(res.error)
      }
    }
    void load()
    const t = window.setInterval(load, 5000)
    return () => {
      dead = true
      window.clearInterval(t)
    }
  }, [tab, bridge])

  const metrics = snapshot?.metrics ?? null
  const system = snapshot?.system ?? null
  const gpu = metrics?.gpu ?? null
  const gpuPercent = gpu?.available && typeof gpu.percent === 'number' ? gpu.percent : null
  const gpuHint =
    gpu == null
      ? 'Waiting for the first metrics sample.'
      : gpu.available
        ? `${gpu.name ?? 'GPU'}${gpu.memoryUsed != null && gpu.memoryTotal != null ? ` · ${bytes(gpu.memoryUsed * 1024 * 1024)} / ${bytes(gpu.memoryTotal * 1024 * 1024)}` : ''}`
        : gpu.reason ?? 'GPU usage is not available on this machine.'

  const diskHint = metrics?.disk
    ? `${bytes(metrics.disk.free)} free of ${bytes(metrics.disk.total)} on ${metrics.disk.mount}`
    : 'Disk usage is not readable on this platform.'

  const sessionSec = snapshot ? (now - snapshot.startedAt) / 1000 : 0

  const setPref = async (key: 'launchAtLogin' | 'closeToTray') => {
    if (!bridge || !prefs || busy) return
    setBusy(true)
    const res = await bridge.app.setPrefs({ [key]: !prefs[key] })
    setBusy(false)
    if (!res.ok) {
      notify(res.error)
      return
    }
    setPrefs(res.data)
    notify(
      key === 'closeToTray'
        ? `Close to tray: ${res.data.closeToTray ? 'on' : 'off'}`
        : `Launch at login: ${res.data.launchAtLogin ? 'on' : 'off'}`,
    )
  }

  const lock = async () => {
    if (!bridge) {
      notify('Desktop bridge unavailable — lock needs the ORVEX app.')
      return
    }
    const res = await bridge.desktop.power('lock')
    if (!res.ok) notify(res.error)
  }

  const hardware = useMemo(
    () =>
      system
        ? [
            ['Host', system.hostname],
            ['User', system.user],
            ['OS', `${system.platform} ${system.release} (${system.arch})`],
            ['CPU', `${system.cpu} · ${system.cores} cores`],
            ['Displays', String(system.displays)],
            [
              'Battery',
              system.battery?.present ? `${system.battery.percent ?? 'n/a'}%${system.battery.charging ? ' · charging' : ''}` : 'No battery',
            ],
            ['Volume', system.volume == null ? 'n/a' : `${system.volume}%${system.muted ? ' · muted' : ''}`],
            ['Brightness', system.brightness == null ? 'n/a' : `${system.brightness}%`],
          ]
        : [],
    [system],
  )

  const TABS: { id: Tab; label: string; icon: typeof Activity }[] = [
    { id: 'monitor', label: 'Monitor', icon: Activity },
    { id: 'goals', label: 'Goals', icon: Target },
    { id: 'failures', label: 'Failures', icon: TriangleAlert },
  ]

  return (
    <PageShell
      title="System"
      sub="Live hardware metrics, processes and app preferences"
      onBack={onBack}
      actions={
        <div className="settings-tabs" role="tablist" aria-label="System sections" onKeyDown={onTablistKeyDown}>
          {TABS.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                tabIndex={tab === t.id ? 0 : -1}
                className={`settings-tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <Icon size={13} />
                {t.label}
              </button>
            )
          })}
        </div>
      }
    >
      {tab === 'monitor' && (
        <div className="system-page">
          <div className="panel sys-col">
            <div className="agent-log-head"><HardDrive size={14} /> Resources</div>
            {!metrics && <p className="dim">Waiting for the first metrics sample…</p>}
            <div className="sys-bars">
              <BigBar
                label="CPU"
                value={metrics?.cpuPercent ?? null}
                color="#4fc3ff"
                hint={metrics?.cpuPercent == null ? 'CPU usage could not be sampled on this machine.' : 'Usage since the previous sample.'}
              />
              <BigBar
                label="RAM"
                value={metrics?.memory.percent ?? null}
                color="#a78bfa"
                hint={metrics ? `${bytes(metrics.memory.used)} of ${bytes(metrics.memory.total)} in use` : undefined}
              />
              <BigBar label="GPU" value={gpuPercent} color="#4ade80" hint={gpuHint} />
              <BigBar
                label="Disk"
                value={metrics?.disk ? metrics.disk.percent : null}
                color="#fbbf24"
                hint={diskHint}
              />
            </div>
            <div className="sys-uptime">Machine uptime · {system ? duration(system.uptimeSec) : 'n/a'}</div>
            <div className="sys-uptime">ORVEX session · {snapshot ? duration(sessionSec) : 'n/a'}</div>
            {metrics && (
              <div className="sys-uptime">
                Load average · {metrics.load.map((n) => n.toFixed(2)).join(' / ')}
                {metrics.at ? ` · sampled ${new Date(metrics.at).toLocaleTimeString('en-US', { hour12: false })}` : ''}
              </div>
            )}
            {hardware.length > 0 && (
              <div className="sys-procs">
                <div className="sys-proc sys-proc-head"><span>Hardware</span><span style={{ textAlign: 'right' }}>Value</span></div>
                {hardware.map(([k, v]) => (
                  <div key={k} className="sys-proc" style={{ gridTemplateColumns: '74px 1fr' }}>
                    <span style={{ color: 'var(--muted)' }}>{k}</span>
                    <span style={{ textAlign: 'right', wordBreak: 'break-word' }}>{v}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel sys-col">
            <div className="agent-log-head"><Monitor size={14} /> Processes · top CPU</div>
            {procsError && <p className="dim">{procsError}</p>}
            <div className="sys-procs">
              <div className="sys-proc sys-proc-head"><span>Process</span><span>CPU %</span><span>Mem MB</span></div>
              {procs.length === 0 && !procsError && <p className="dim">Reading the process table…</p>}
              {procs.map((p) => (
                <div key={p.pid} className="sys-proc" title={`PID ${p.pid}${p.title ? ` · ${p.title}` : ''}`}>
                  <span className="sys-proc-name">{p.name}</span>
                  <span>{p.cpu.toFixed(1)}</span>
                  <span>{p.memMB}</span>
                </div>
              ))}
            </div>
            <p className="dim">Sampled every 5 seconds. Kill processes from Control PC, where the action asks for confirmation.</p>
          </div>

          <div className="panel sys-col">
            <div className="agent-log-head">Preferences</div>
            {prefsError && <p className="dim">{prefsError}</p>}
            <div className="sys-prefs">
              <div className="sys-pref">
                <span>Launch ORVEX at startup</span>
                <button
                  className="switch"
                  data-on={prefs?.launchAtLogin ?? false}
                  onClick={() => void setPref('launchAtLogin')}
                  aria-pressed={prefs?.launchAtLogin ?? false}
                  aria-label="Launch ORVEX at startup"
                  disabled={!prefs || busy}
                >
                  <span className="switch-knob" />
                </button>
              </div>
              <div className="sys-pref">
                <span>Keep running in system tray</span>
                <button
                  className="switch"
                  data-on={prefs?.closeToTray ?? false}
                  onClick={() => void setPref('closeToTray')}
                  aria-pressed={prefs?.closeToTray ?? false}
                  aria-label="Keep running in system tray"
                  disabled={!prefs || busy}
                >
                  <span className="switch-knob" />
                </button>
              </div>
            </div>
            {prefs && (
              <div className="sys-uptime">
                ORVEX {prefs.version ?? ''} · {prefs.packaged ? 'installed build' : 'dev runner'}
                {prefs.userData ? ` · ${prefs.userData}` : ''}
              </div>
            )}

            <div className="agent-log-head" style={{ borderTop: '1px solid rgba(var(--border-rgb), 0.14)', paddingTop: 10 }}>
              <Power size={14} /> Power
            </div>
            <div className="sys-powers">
              <button className="sys-power" onClick={() => void lock()}>
                <Lock size={13} /> Lock screen
              </button>
            </div>
            <p className="dim">
              Sleep, restart and shutdown are not exposed from ORVEX — locking is the only power action the app performs,
              and it hands straight off to Windows. Use the Start menu for the rest.
            </p>
          </div>
        </div>
      )}

      {tab === 'goals' && <GoalTree />}
      {tab === 'failures' && <FailureLog snapshot={snapshot} />}
    </PageShell>
  )
}
