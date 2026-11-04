import { useEffect, useState } from 'react'
import { motion, useTransform } from 'framer-motion'
import {
  Bell,
  Cpu,
  Maximize2,
  MemoryStick,
  Mic,
  Minus,
  Minimize2,
  PictureInPicture2,
  Search,
  Settings2,
  X,
} from 'lucide-react'
import OrvexMark from './OrvexMark'
import type { Voice } from '../hooks/useVoice'
import { useLevelMotion } from '../hooks/useLevelMotion'
import type { OrvexDashboardSnapshot, OrvexWindowAction, OrvexWindowState } from '../types/desktop'

const bridge = typeof window !== 'undefined' ? window.orvex : undefined

type Props = {
  voice: Voice
  snapshot: OrvexDashboardSnapshot | null
  onToggleListening: () => void
  onOpenSettings: () => void
  onOpenSystem: () => void
  onOpenNotifications: () => void
  onOpenSearch: () => void
  onNotice: (message: string) => void
  hasUnread: boolean
}

const BARS = [7, 12, 17, 11, 15, 9, 14, 18, 8, 12, 6]

function Brand() {
  return (
    <div className="brand">
      <OrvexMark className="brand-mark" size={34} />
      <div>
        <div className="brand-word">ORVEX</div>
        <div className="brand-sub">AI BEYOND LIMITS</div>
      </div>
    </div>
  )
}

function VoiceBar({ voice, onToggleListening, onOpenSettings }: { voice: Voice; onToggleListening: () => void; onOpenSettings: () => void }) {
  const listening = voice.status === 'listening' || voice.status === 'starting'
  const lv = useLevelMotion(voice.levelRef)
  const barScale = useTransform(lv, [0, 0.5, 1], [0.45, 1.1, 2])
  const orbScale = useTransform(lv, [0, 1], [1, 1.18])

  const heard = voice.interim || voice.transcript

  return (
    <div className="voice-bar panel panel-hairline">
      <motion.button
        className={`voice-orb ${listening ? 'is-live' : ''}`}
        style={{ scale: orbScale }}
        onClick={onToggleListening}
        aria-label={listening ? 'Stop listening' : 'Start listening'}
        title={
          voice.status === 'denied'
            ? 'Microphone blocked — allow mic access to talk to ORVEX'
            : listening
              ? 'Live microphone — audio stays on this device'
              : 'Tap to talk — orb reacts to your voice'
        }
      >
        <span className="wave">
          {BARS.map((h, i) => (
            <span key={i} className="wave-wrap">
              <motion.i style={{ scaleY: barScale }}>
                <span className="wave-inner" style={{ height: h, animationDelay: `${i * 0.07}s` }} />
              </motion.i>
            </span>
          ))}
        </span>
      </motion.button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-medium" style={{ color: 'var(--text)' }}>
            {voice.status === 'starting'
              ? 'Starting microphone…'
              : listening
                ? 'I’m listening…'
                : voice.status === 'denied'
                  ? 'Microphone blocked'
                  : voice.status === 'unsupported'
                    ? 'Mic unavailable'
                    : 'Voice assistant ready'}
          </span>
          <span
            className="inline-flex items-center gap-1 text-[8px] tracking-[0.14em] px-1.5 py-[2px] rounded-full"
            style={{
              color: listening ? '#7ef0c0' : voice.status === 'denied' || voice.status === 'unsupported' ? '#ffb1a0' : 'var(--muted)',
              border: `1px solid ${listening ? 'rgba(94,235,170,.45)' : 'rgba(140,180,215,.22)'}`,
              background: listening ? 'rgba(30,120,80,.25)' : 'transparent',
            }}
          >
            <span
              className="w-[4px] h-[4px] rounded-full"
              style={{
                background: listening ? '#5eeb9e' : voice.status === 'denied' || voice.status === 'unsupported' ? '#ff8f7a' : '#7d94ab',
                boxShadow: listening ? '0 0 6px #5eeb9e' : 'none',
              }}
            />
            {listening ? 'LIVE' : voice.status === 'denied' || voice.status === 'unsupported' ? 'BLOCKED' : 'IDLE'}
          </span>
        </div>
        <div className="text-[10px] truncate" style={{ color: 'var(--muted)', marginTop: 2 }} title={heard || voice.error || undefined}>
          {listening && heard
            ? heard
            : listening
              ? 'Say something — the core reacts to your voice…'
              : voice.error ?? (voice.speechSupported ? 'Tap the orb to start a voice session' : 'Tap the orb — voice input works, speech-to-text needs Chrome/Edge')}
        </div>
      </div>
      <button className={`icon-btn ${listening ? 'active' : ''}`} onClick={onToggleListening} aria-label="Microphone">
        <Mic size={16} />
      </button>
      <button className="icon-btn" onClick={onOpenSettings} aria-label="Settings">
        <Settings2 size={16} />
      </button>
    </div>
  )
}

function SystemChip({ snapshot, onOpen }: { snapshot: OrvexDashboardSnapshot | null; onOpen: () => void }) {
  const cpu = snapshot?.metrics.cpuPercent ?? null
  const ram = snapshot?.metrics.memory.percent ?? null
  return (
    <button
      className="sys-chip"
      onClick={onOpen}
      title={snapshot ? `CPU ${cpu ?? '—'}% · RAM ${ram ?? '—'}% — open the System monitor` : 'Open the System monitor'}
      aria-label="Live CPU and memory — open System"
    >
      <Cpu size={13} />
      <span>{cpu == null ? '—' : `${Math.round(cpu)}%`}</span>
      <span className="sys-sep" />
      <MemoryStick size={13} />
      <span>{ram == null ? '—' : `${Math.round(ram)}%`}</span>
    </button>
  )
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const value = parts.slice(0, 2).map((p) => p[0]).join('')
  return value ? value.toUpperCase() : 'ME'
}

function UserAvatar({
  snapshot,
  onOpen,
}: {
  snapshot: OrvexDashboardSnapshot | null
  onOpen: () => void
}) {
  const user = snapshot?.system.user || 'local user'
  const running = !!snapshot?.agent.running
  return (
    <button
      className="user-avatar"
      onClick={onOpen}
      title={`${user}${snapshot ? ` on ${snapshot.system.hostname}` : ''} — ${running ? 'ORVEX is working' : 'ORVEX is idle'}`}
      aria-label={`Profile for ${user}`}
    >
      <span>{initials(user)}</span>
      <i className={running ? 'busy' : ''} />
    </button>
  )
}

function useWindowState(onNotice: (m: string) => void) {
  const [state, setState] = useState<OrvexWindowState | null>(null)

  useEffect(() => {
    if (!bridge) return
    let live = true
    void bridge.app.window('state').then((res) => {
      if (live && res.ok) setState(res.data)
    })
    const off = bridge.app.onWindowState((next) => setState(next))
    return () => {
      live = false
      off()
    }
  }, [])

  const run = async (action: OrvexWindowAction) => {
    if (!bridge) {
      onNotice('Window controls run in the ORVEX desktop app — this browser preview cannot move the OS window.')
      return
    }
    const res = await bridge.app.window(action)
    if (!res.ok) onNotice(res.error)
    else setState(res.data)
  }

  return { state, run }
}

function ClockPanel({
  onOpenNotifications,
  onOpenSearch,
  onOpenSettings,
  onOpenSystem,
  onNotice,
  snapshot,
  hasUnread,
}: {
  onOpenNotifications: () => void
  onOpenSearch: () => void
  onOpenSettings: () => void
  onOpenSystem: () => void
  onNotice: (m: string) => void
  snapshot: OrvexDashboardSnapshot | null
  hasUnread: boolean
}) {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 20000)
    return () => window.clearInterval(t)
  }, [])

  const time = now
    .toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
    .toUpperCase()
  const date = now.toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
  const { state, run } = useWindowState(onNotice)

  return (
    <div className="clock-panel panel">
      <div className="min-w-0">
        <div className="clock-time">{time}</div>
        <div className="clock-date">{date}</div>
      </div>
      <div className="clock-sep" />
      <SystemChip snapshot={snapshot} onOpen={onOpenSystem} />
      <div className="ml-auto flex items-center gap-1.5">
        <button
          className="icon-btn !w-[26px] !h-[26px] !border-0 !bg-transparent"
          onClick={onOpenSearch}
          aria-label="Search"
          title="Search (Ctrl+K)"
        >
          <Search size={15} />
        </button>
        <button
          className="icon-btn !w-[26px] !h-[26px] !border-0 !bg-transparent"
          onClick={onOpenNotifications}
          aria-label="Notifications"
          title="Notifications"
        >
          <span className="relative">
            <Bell size={15} />
            {hasUnread && (
              <span className="absolute -right-1 -top-1 w-[5px] h-[5px] rounded-full" style={{ background: '#ff5c7a', boxShadow: '0 0 6px #ff5c7a' }} />
            )}
          </span>
        </button>
        <button
          className="icon-btn !w-[26px] !h-[26px] !border-0 !bg-transparent"
          onClick={() => void run('toggleMini')}
          aria-label={state?.miniVisible ? 'Hide mini window' : 'Open mini window'}
          title={state?.miniVisible ? 'Hide mini window' : 'Open mini window'}
        >
          <PictureInPicture2 size={15} />
        </button>
        <UserAvatar snapshot={snapshot} onOpen={onOpenSettings} />
      </div>
    </div>
  )
}

export default function Header(props: Props) {
  return (
    <div className="header-area">
      <header className="app-header">
        <Brand />
        <VoiceBar voice={props.voice} onToggleListening={props.onToggleListening} onOpenSettings={props.onOpenSettings} />
        <div className="header-right">
          <WindowControls onNotice={props.onNotice} />
          <ClockPanel
            onOpenNotifications={props.onOpenNotifications}
            onOpenSearch={props.onOpenSearch}
            onOpenSettings={props.onOpenSettings}
            onOpenSystem={props.onOpenSystem}
            onNotice={props.onNotice}
            snapshot={props.snapshot}
            hasUnread={props.hasUnread}
          />
        </div>
      </header>
    </div>
  )
}

function WindowControls({ onNotice }: { onNotice: (m: string) => void }) {
  const { state, run } = useWindowState(onNotice)
  const maximized = !!state?.maximized
  return (
    <div className="window-controls">
      <button className="win-btn" onClick={() => void run('minimize')} aria-label="Minimize" title="Minimize">
        <Minus size={12} strokeWidth={1.6} />
      </button>
      <button
        className="win-btn"
        onClick={() => void run('maximize')}
        aria-label={maximized ? 'Restore window' : 'Maximize'}
        title={maximized ? 'Restore window' : 'Maximize'}
      >
        {maximized ? <Minimize2 size={11} strokeWidth={1.6} /> : <Maximize2 size={10} strokeWidth={1.5} />}
      </button>
      <button
        className="win-btn close"
        onClick={() => void run('close')}
        aria-label="Close to tray"
        title={state?.closeToTray === false ? 'Close ORVEX' : 'Close to tray — runs keep going'}
      >
        <X size={12} strokeWidth={1.6} />
      </button>
    </div>
  )
}
