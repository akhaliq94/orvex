import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, useTransform } from 'framer-motion'
import {
  AlertTriangle,
  AppWindow,
  Camera,
  ClipboardCopy,
  Cpu,
  Crosshair,
  Download,
  FileVideo,
  Focus,
  FolderOpen,
  Hand,
  Keyboard,
  ListTree,
  Loader2,
  Maximize2,
  Mic,
  MicOff,
  Minus,
  Monitor,
  MousePointer2,
  Play,
  RefreshCw,
  Rocket,
  RotateCcw,
  Save,
  ScanText,
  Search,
  SkipBack,
  SkipForward,
  Square,
  Sun,
  Trash2,
  Volume2,
  VolumeX,
  Wifi,
  X,
} from 'lucide-react'
import PageShell from './PageShell'
import AICore from '../components/AICore'
import type { Voice } from '../hooks/useVoice'
import { useLevelMotion } from '../hooks/useLevelMotion'
import type { IpcResult } from '../types/desktop'
import type {
  OrvexDesktopApp,
  OrvexDesktopCapture,
  OrvexDesktopClipboard,
  OrvexDesktopOcr,
  OrvexDesktopProcess,
  OrvexDesktopRecording,
  OrvexDesktopScreenInfo,
  OrvexDesktopStatus,
  OrvexDesktopUiTree,
  OrvexDesktopWindow,
  OrvexHandsStep,
  OrvexScreenFind,
} from '../types/desktop'

type Props = { onBack: () => void; voice: Voice; onToggleListening: () => void; notify: (msg: string) => void }

type Tab = 'screen' | 'input' | 'windows' | 'processes' | 'clipboard' | 'automation' | 'hands' | 'record'

const TABS: { id: Tab; label: string; icon: typeof Monitor }[] = [
  { id: 'screen', label: 'Screen & OCR', icon: Monitor },
  { id: 'input', label: 'Mouse & Keyboard', icon: MousePointer2 },
  { id: 'windows', label: 'Windows', icon: AppWindow },
  { id: 'processes', label: 'Processes', icon: Cpu },
  { id: 'clipboard', label: 'Clipboard', icon: ClipboardCopy },
  { id: 'automation', label: 'UI Automation', icon: ListTree },
  { id: 'hands', label: 'Hands & apps', icon: Hand },
  { id: 'record', label: 'Recording', icon: FileVideo },
]

const desk = typeof window !== 'undefined' ? window.orvex?.desktop : undefined
const handsBridge = typeof window !== 'undefined' ? window.orvex?.hands : undefined

async function call<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise
  if (!result.ok) throw new Error(result.error)
  return result.data
}

function messageOf(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function fmtBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

function fmtUptime(sec: number) {
  const total = Math.max(0, Math.round(Number(sec) || 0))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

const QUICK_KEYS = [
  { keys: 'ENTER', label: 'Enter' },
  { keys: 'TAB', label: 'Tab' },
  { keys: 'ESC', label: 'Esc' },
  { keys: 'BACKSPACE', label: 'Backspace' },
  { keys: 'CTRL+S', label: 'Ctrl+S' },
  { keys: 'CTRL+V', label: 'Ctrl+V' },
  { keys: 'CTRL+Z', label: 'Ctrl+Z' },
  { keys: 'ALT+TAB', label: 'Alt+Tab' },
  { keys: 'WIN+R', label: 'Win+R' },
  { keys: 'PRINTSCREEN', label: 'PrtScr' },
]

export default function ControlPcPage({ onBack, voice, onToggleListening, notify }: Props) {
  const listening = voice.status === 'listening' || voice.status === 'starting'
  const lv = useLevelMotion(voice.levelRef)
  const orbScale = useTransform(lv, [0, 1], [1, 1.12])

  const [tab, setTab] = useState<Tab>('screen')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [lastAction, setLastAction] = useState('')

  const [status, setStatus] = useState<OrvexDesktopStatus | null>(null)
  const [screenInfo, setScreenInfo] = useState<OrvexDesktopScreenInfo | null>(null)
  const [displayId, setDisplayId] = useState('')
  const [capture, setCapture] = useState<OrvexDesktopCapture | null>(null)
  const [autoShot, setAutoShot] = useState(false)
  const [ocr, setOcr] = useState<OrvexDesktopOcr | null>(null)

  const [mx, setMx] = useState(0)
  const [my, setMy] = useState(0)
  const [dragTo, setDragTo] = useState({ x: 0, y: 0 })
  const [typeText, setTypeText] = useState('')
  const [keyChord, setKeyChord] = useState('')

  const [windows, setWindows] = useState<OrvexDesktopWindow[]>([])
  const [winFilter, setWinFilter] = useState('')
  const [processes, setProcesses] = useState<OrvexDesktopProcess[]>([])
  const [procFilter, setProcFilter] = useState('')
  const [procSort, setProcSort] = useState<'memory' | 'cpu' | 'name' | 'pid'>('memory')

  const [clip, setClip] = useState<OrvexDesktopClipboard | null>(null)
  const [clipText, setClipText] = useState('')

  const [autoTarget, setAutoTarget] = useState('')
  const [uiDepth, setUiDepth] = useState(4)
  const [uiTree, setUiTree] = useState<OrvexDesktopUiTree | null>(null)
  const [uiPath, setUiPath] = useState('')
  const [uiAction, setUiAction] = useState('click')
  const [uiValue, setUiValue] = useState('')

  const [recording, setRecording] = useState<OrvexDesktopRecording | null>(null)
  const [recDisplay, setRecDisplay] = useState('')
  const [recFps, setRecFps] = useState(15)
  const [recAudio, setRecAudio] = useState<'none' | 'mic' | 'system'>('none')

  const [volume, setVolume] = useState(50)
  const [brightness, setBrightness] = useState(80)
  const [muted, setMuted] = useState(false)
  const volumeDragging = useRef(false)
  const brightnessDragging = useRef(false)
  const capturing = useRef(false)

  const [apps, setApps] = useState<OrvexDesktopApp[]>([])
  const [appFilter, setAppFilter] = useState('')
  const [appsLoaded, setAppsLoaded] = useState(false)
  const [findText, setFindText] = useState('')
  const [findResult, setFindResult] = useState<OrvexScreenFind | null>(null)
  const [goal, setGoal] = useState('')
  const [maxSteps, setMaxSteps] = useState(5)
  const [handSteps, setHandSteps] = useState<OrvexHandsStep[]>([])
  const [handRunning, setHandRunning] = useState(false)
  const [handNote, setHandNote] = useState('')

  const run = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setBusy(label)
      setError('')
      try {
        await fn()
      } catch (err) {
        const msg = messageOf(err)
        setError(msg)
        notify(msg)
      } finally {
        setBusy('')
      }
    },
    [notify],
  )

  const fail = useCallback(
    (err: unknown) => {
      const msg = messageOf(err)
      setError(msg)
    },
    [],
  )

  const refreshStatus = useCallback(async () => {
    if (!desk) return
    const next = await call(desk.system())
    setStatus(next)
    setMuted(next.muted)
    if (next.volume != null && !volumeDragging.current) setVolume(next.volume)
    if (next.brightness != null && !brightnessDragging.current) setBrightness(next.brightness)
  }, [])

  const refreshScreens = useCallback(async () => {
    if (!desk) return null
    const info = await call(desk.screenInfo())
    setScreenInfo(info)
    setMx((prev) => prev || info.cursor.x)
    setMy((prev) => prev || info.cursor.y)
    setDisplayId((prev) => {
      if (prev) return prev
      const primary = info.displays.find((d) => d.primary) || info.displays[0]
      return primary ? String(primary.id) : ''
    })
    setRecDisplay((prev) => {
      if (prev) return prev
      const primary = info.displays.find((d) => d.primary) || info.displays[0]
      return primary ? String(primary.id) : ''
    })
    return info
  }, [])

  const captureScreen = useCallback(
    async (display?: string) => {
      if (!desk || capturing.current) return
      capturing.current = true
      try {
        const shot = await call(desk.capture({ display: display || displayId || undefined }))
        setCapture(shot)
        setOcr(null)
      } finally {
        capturing.current = false
      }
    },
    [displayId],
  )

  const refreshRecord = useCallback(async () => {
    if (!desk) return
    const next = await call(desk.recordStatus())
    setRecording((prev) => {
      if (!next.active && prev?.file) return prev
      return next
    })
  }, [])

  useEffect(() => {
    if (!desk) return
    let live = true
    ;(async () => {
      try {
        const [info, rec] = await Promise.all([call(desk.screenInfo()), call(desk.recordStatus())])
        if (!live) return
        setScreenInfo(info)
        setMx(info.cursor.x)
        setMy(info.cursor.y)
        setRecording(rec)
        const primary = info.displays.find((d) => d.primary) || info.displays[0]
        if (primary) {
          setDisplayId(String(primary.id))
          setRecDisplay(String(primary.id))
          const shot = await call(desk.capture({ display: String(primary.id) }))
          if (live) setCapture(shot)
        }
        await refreshStatus()
      } catch (err) {
        if (live) fail(err)
      }
    })()
    const statusTimer = window.setInterval(() => {
      void refreshStatus().catch(() => {})
    }, 20000)
    return () => {
      live = false
      window.clearInterval(statusTimer)
    }
  }, [refreshStatus, fail])

  useEffect(() => {
    if (!autoShot || tab !== 'screen' || !desk) return
    const timer = window.setInterval(() => {
      void captureScreen().catch(() => {})
    }, 2500)
    return () => window.clearInterval(timer)
  }, [autoShot, tab, captureScreen])

  useEffect(() => {
    if (!desk || !recording?.active) return
    const timer = window.setInterval(() => {
      void refreshRecord().catch(() => {})
    }, 1500)
    return () => window.clearInterval(timer)
  }, [desk, recording?.active, refreshRecord])

  /* ---------------------------------------------------------------- windows */

  const loadWindows = useCallback(async () => {
    if (!desk) return
    const data = await call(desk.windows({ filter: winFilter.trim() || undefined, limit: 200 }))
    setWindows(data.windows)
  }, [winFilter])

  useEffect(() => {
    if (!desk || (tab !== 'windows' && tab !== 'automation')) return
    const timer = window.setTimeout(() => {
      void loadWindows().catch(fail)
    }, 200)
    return () => window.clearTimeout(timer)
  }, [tab, loadWindows, fail])

  /* -------------------------------------------------------------- processes */

  const loadProcesses = useCallback(async () => {
    if (!desk) return
    const data = await call(
      desk.processes({ filter: procFilter.trim() || undefined, sort: procSort, limit: 150 }),
    )
    setProcesses(data.processes)
  }, [procFilter, procSort])

  useEffect(() => {
    if (!desk || tab !== 'processes') return
    const timer = window.setTimeout(() => {
      void loadProcesses().catch(fail)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [tab, loadProcesses, fail])

  /* -------------------------------------------------------------- clipboard */

  const readClipboard = useCallback(async () => {
    if (!desk) return
    const next = await call(desk.clipboardRead())
    setClip(next)
    if (next.kind === 'text') setClipText(next.text)
  }, [])

  useEffect(() => {
    if (!desk || tab !== 'clipboard') return
    void readClipboard().catch(fail)
  }, [tab, readClipboard, fail])

  /* ------------------------------------------------------------------- OCR */

  const runOcr = () =>
    run('ocr', async () => {
      if (!desk) throw new Error('Desktop bridge unavailable.')
      const payload = capture?.file && capture.file.toLowerCase().endsWith('.png') ? { path: capture.file } : {}
      const next = await call(desk.ocr(payload))
      setOcr(next)
      notify(next.lines.length ? `Read ${next.lines.length} line${next.lines.length === 1 ? '' : 's'}.` : 'No text was recognised.')
    })

  /* --------------------------------------------------------------- actions */

  const press = (keys: string, label?: string) =>
    run('keys', async () => {
      if (!desk) throw new Error('Desktop bridge unavailable.')
      const result = await call(desk.keyPress(keys))
      setLastAction(`${label || keys} — ${result.output}`)
      if (keys.toUpperCase().startsWith('VOLUME')) await refreshStatus()
    })

  const typeIntoFocus = () =>
    run('type', async () => {
      if (!desk) throw new Error('Desktop bridge unavailable.')
      if (!typeText) throw new Error('Type some text first.')
      const result = await call(desk.keyType(typeText))
      setLastAction(result.output)
      notify(result.output)
      setTypeText('')
    })

  const commitVolume = () =>
    run('volume', async () => {
      if (!desk) return
      const result = await call(desk.volume({ level: volume }))
      notify(result.output)
      await refreshStatus()
    })

  const toggleMute = () =>
    run('mute', async () => {
      if (!desk) return
      const result = await call(desk.volume({ mute: !muted }))
      notify(result.output)
      await refreshStatus()
    })

  const commitBrightness = () =>
    run('brightness', async () => {
      if (!desk) return
      const result = await call(desk.brightness({ level: brightness }))
      notify(result.output)
      await refreshStatus()
    })

  /* ----------------------------------------------------------------- record */

  const startRecording = () =>
    run('record', async () => {
      if (!desk) throw new Error('Desktop bridge unavailable.')
      const rec = await call(
        desk.recordStart({ display: recDisplay || undefined, fps: recFps, audio: recAudio }),
      )
      setRecording(rec)
      notify('Recording started — it keeps running while you use the PC.')
    })

  const stopRecording = () =>
    run('record', async () => {
      if (!desk) throw new Error('Desktop bridge unavailable.')
      const rec = await call(desk.recordStop())
      setRecording(rec)
      notify(`Recording saved (${fmtBytes(rec.bytes || 0)}).`)
    })

  /* -------------------------------------------------------------------- UIA */

  const loadUiTree = () =>
    run('uia', async () => {
      if (!desk) throw new Error('Desktop bridge unavailable.')
      if (!autoTarget) throw new Error('Pick a window first.')
      const tree = await call(desk.uiTree({ title: autoTarget, depth: uiDepth, max: 700 }))
      setUiTree(tree)
      notify(`${tree.nodes} UI nodes.`)
    })

  const runUiAction = () =>
    run('uia', async () => {
      if (!desk) throw new Error('Desktop bridge unavailable.')
      if (!autoTarget) throw new Error('Pick a window first.')
      if (!uiPath.trim()) throw new Error('Enter an element path such as [0/1/2].')
      const result = await call(
        desk.uiAction({
          title: autoTarget,
          path: uiPath.trim(),
          action: uiAction as 'invoke' | 'click' | 'set_value' | 'toggle' | 'select' | 'expand' | 'collapse' | 'focus' | 'scroll',
          value: uiValue || undefined,
        }),
      )
      setLastAction(result.output)
      notify(result.output)
    })

  /* ------------------------------------------------------------------ hands */

  useEffect(() => {
    if (!handsBridge) return
    return handsBridge.onEvent((event) => {
      if (!event || event.type !== 'step') return
      setHandSteps((prev) => {
        const next = prev.filter((s) => s.step !== event.step)
        next.push({
          step: event.step,
          what: event.what,
          ok: event.ok,
          output: event.output,
          error: event.error,
          note: event.note,
          ms: event.ms,
        })
        return next.sort((a, b) => a.step - b.step)
      })
    })
  }, [])

  useEffect(() => {
    if (!desk || tab !== 'hands' || appsLoaded) return
    setAppsLoaded(true)
    void run('apps', async () => {
      const list = await call(desk.apps({ limit: 300 }))
      setApps(list.apps)
    })
  }, [tab, appsLoaded, run])

  const refreshApps = () =>
    run('apps', async () => {
      if (!desk) throw new Error('Desktop bridge unavailable.')
      const list = await call(desk.apps({ limit: 300, force: true }))
      setApps(list.apps)
      notify(`${list.total} Start-menu apps.`)
    })

  const launchApp = (name: string) =>
    run('launch', async () => {
      if (!desk) throw new Error('Desktop bridge unavailable.')
      const res = await call(desk.appLaunch({ name }))
      setLastAction(res.output)
      notify(res.output)
    })

  const locateText = () =>
    run('find', async () => {
      if (!desk) throw new Error('Desktop bridge unavailable.')
      if (!findText.trim()) throw new Error('Type the visible label first.')
      const res = await call(desk.screenFind({ text: findText.trim(), limit: 20 }))
      setFindResult(res)
      setLastAction(res.output)
      notify(res.found ? `${res.matches.length} match${res.matches.length === 1 ? '' : 'es'} on screen.` : 'Nothing matched on screen.')
    })

  const clickLocated = (occurrence = 0) =>
    run('clicktext', async () => {
      if (!desk) throw new Error('Desktop bridge unavailable.')
      if (!findText.trim()) throw new Error('Type the visible label first.')
      const res = await call(desk.screenClickText({ text: findText.trim(), occurrence }))
      setLastAction(res.output)
      notify(res.output)
    })

  const startHands = () =>
    run('hands', async () => {
      if (!handsBridge) throw new Error('Hands bridge unavailable.')
      if (goal.trim().length < 4) throw new Error('Describe what should be true when the task is done.')
      setHandSteps([])
      setHandNote('')
      setHandRunning(true)
      try {
        const res = await call(handsBridge.run({ goal: goal.trim(), maxSteps }))
        setHandSteps(res.steps || [])
        setHandNote(res.ok ? res.output || res.note || 'Completed.' : res.error || res.note || 'Did not finish.')
        notify(res.ok ? 'Hands finished the task.' : `Hands stopped: ${res.error || res.note || 'not completed'}`)
      } finally {
        setHandRunning(false)
      }
    })

  const stopHands = async () => {
    if (!handsBridge) return
    try {
      const res = await call(handsBridge.stop())
      notify(res.stopped ? 'Stop requested — the loop ends after the current action.' : 'No hands task is running.')
    } catch (err) {
      fail(err)
    }
  }

  /* ---------------------------------------------------------------- derived */

  const visibleApps = useMemo(() => {
    const needle = appFilter.trim().toLowerCase()
    const list = needle ? apps.filter((a) => a.name.toLowerCase().includes(needle)) : apps
    return list.slice(0, 24)
  }, [apps, appFilter])

  const visibleWindows = useMemo(() => {
    const needle = winFilter.trim().toLowerCase()
    if (!needle) return windows
    return windows.filter(
      (w) => w.title.toLowerCase().includes(needle) || (w.cls || '').toLowerCase().includes(needle),
    )
  }, [windows, winFilter])

  const ramPercent = status ? Math.round((status.memory.used / Math.max(1, status.memory.total)) * 100) : 0
  const brightSupported = status?.brightness != null
  const displays = screenInfo?.displays ?? []
  const cursor = screenInfo?.cursor

  return (
    <PageShell
      title="Control PC"
      sub="Real screen, input, windows, processes, clipboard and recording — every action runs on this machine"
      onBack={onBack}
      actions={
        <button
          className="btn-ghost dc-head-btn"
          onClick={() => run('refresh', async () => { await Promise.all([refreshStatus(), refreshScreens()]) })}
          disabled={!!busy}
        >
          {busy === 'refresh' ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
          Refresh
        </button>
      }
    >
      <div className="dc-page">
        <div className="dc-side">
          <div className="dc-card">
            <div className="dc-card-head">
              <Cpu size={14} />
              <h3>This machine</h3>
              <span className="dc-chip">{status ? 'live' : '…'}</span>
            </div>
            {!desk && <div className="dc-note">The desktop bridge is unavailable in a plain browser tab. Open the ORVEX desktop app.</div>}
            {status ? (
              <div className="dc-stack">
                <div className="dc-kv"><span>Host</span><b>{status.hostname}</b></div>
                <div className="dc-kv"><span>User</span><b>{status.user || '—'}</b></div>
                <div className="dc-kv"><span>OS</span><b>{status.platform} {status.release}</b></div>
                <div className="dc-kv"><span>CPU</span><b title={status.cpu}>{status.cpu || '—'} · {status.cores} threads</b></div>
                <div>
                  <div className="dc-kv"><span>RAM</span><b>{fmtBytes(status.memory.used)} / {fmtBytes(status.memory.total)}</b></div>
                  <div className="dc-bar"><i style={{ width: `${ramPercent}%` }} /></div>
                </div>
                <div className="dc-kv"><span>Uptime</span><b>{fmtUptime(status.uptimeSec)}</b></div>
                <div className="dc-kv">
                  <span>Power</span>
                  <b>{status.battery?.present ? `${status.battery.percent ?? '?'}% ${status.battery.charging ? 'charging' : 'on battery'}` : 'AC / desktop'}</b>
                </div>
                <div className="dc-kv"><span>Displays</span><b>{status.displays}</b></div>
                <div className="dc-net">
                  <Wifi size={11} />
                  <span>{status.addresses.length ? status.addresses.map((a) => a.address).join(', ') : 'No LAN address'}</span>
                </div>
              </div>
            ) : (
              <div className="dc-empty-inline"><Loader2 size={13} className="spin" /> Reading machine state…</div>
            )}
          </div>

          <div className="dc-card">
            <div className="dc-card-head">
              <Volume2 size={14} />
              <h3>Sound & light</h3>
              {status?.brightness == null && <span className="dc-chip dim">brightness n/a</span>}
            </div>

            <div className="dc-slider-row">
              <button className="dc-icon-btn" onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'} disabled={!!busy}>
                {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
              </button>
              <input
                type="range"
                min={0}
                max={100}
                value={volume}
                disabled={!status || status.volume == null}
                onChange={(e) => { volumeDragging.current = true; setVolume(Number(e.target.value)) }}
                onPointerUp={() => { volumeDragging.current = false; void commitVolume() }}
                onKeyUp={() => { volumeDragging.current = false; void commitVolume() }}
                aria-label="System volume"
              />
              <span className="dc-slider-val">{volume}%</span>
            </div>

            <div className="dc-slider-row">
              <Sun size={14} className="dc-slider-icon" />
              <input
                type="range"
                min={0}
                max={100}
                value={brightness}
                disabled={!brightSupported}
                onChange={(e) => { brightnessDragging.current = true; setBrightness(Number(e.target.value)) }}
                onPointerUp={() => { brightnessDragging.current = false; void commitBrightness() }}
                onKeyUp={() => { brightnessDragging.current = false; void commitBrightness() }}
                aria-label="Display brightness"
              />
              <span className="dc-slider-val">{brightSupported ? `${brightness}%` : 'n/a'}</span>
            </div>
            {!brightSupported && status && (
              <p className="dc-hint">Windows has no brightness method for this display; use the monitor buttons.</p>
            )}

            <div className="dc-keys">
              <button className="dc-key" onClick={() => press('MEDIAPREV', 'Previous track')} title="Previous track"><SkipBack size={14} /></button>
              <button className="dc-key main" onClick={() => press('MEDIAPLAY', 'Play / pause')} title="Play or pause"><Play size={15} /></button>
              <button className="dc-key" onClick={() => press('MEDIANEXT', 'Next track')} title="Next track"><SkipForward size={14} /></button>
              <button className="dc-key" onClick={() => press('MEDIASTOP', 'Stop media')} title="Stop media"><Square size={12} /></button>
            </div>
            <div className="dc-keys slim">
              <button className="dc-key" onClick={() => press('VOLUMEUP', 'Volume up')} title="Volume up">Vol +</button>
              <button className="dc-key" onClick={() => press('VOLUMEDOWN', 'Volume down')} title="Volume down">Vol −</button>
              <button className="dc-key" onClick={() => press('VOLUMEMUTE', 'Mute key')} title="Mute key">Mute</button>
            </div>
            <p className="dc-hint">Media keys are sent to whichever app owns playback right now.</p>
          </div>

          <div className="dc-card dc-voice-card">
            <div className="dc-card-head">
              <Mic size={14} />
              <h3>Voice control</h3>
              <span className={`dc-chip ${listening ? 'live' : ''}`}>{listening ? 'listening' : 'idle'}</span>
            </div>
            <div className="dc-orb">
              <AICore listening={listening} levelRef={voice.levelRef} />
            </div>
            <motion.button
              className={`voice-main-btn ${listening ? 'live' : ''}`}
              style={{ scale: orbScale }}
              onClick={onToggleListening}
            >
              {listening ? <MicOff size={14} /> : <Mic size={14} />}
              {listening ? 'Stop listening' : 'Talk to ORVEX'}
            </motion.button>
            <p className="dc-hint">Spoken commands reach the agent, which drives the same real controls through its tools.</p>
          </div>
        </div>

        <div className="dc-main">
          <div className="dc-tabs">
            {TABS.map((t) => {
              const Icon = t.icon
              return (
                <button key={t.id} className={`dc-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
                  <Icon size={13} />
                  {t.label}
                </button>
              )
            })}
            {busy && <span className="dc-tabs-busy"><Loader2 size={12} className="spin" /> {busy}</span>}
          </div>

          {error && (
            <div className="dc-error">
              <AlertTriangle size={13} />
              <span>{error}</span>
              <button onClick={() => setError('')} aria-label="Dismiss"><X size={12} /></button>
            </div>
          )}

          {lastAction && (
            <div className="dc-action-line">
              <Crosshair size={11} />
              <span>{lastAction}</span>
              <button onClick={() => setLastAction('')} aria-label="Clear"><X size={11} /></button>
            </div>
          )}

          {tab === 'screen' && (
            <div className="dc-tab-body">
              <div className="dc-card">
                <div className="dc-card-head">
                  <Monitor size={14} />
                  <h3>Live screen</h3>
                  <span className="dc-chip">{capture ? `${capture.width}×${capture.height}` : 'no shot'}</span>
                </div>
                <div className="dc-toolbar">
                  {displays.length > 1 && (
                    <select
                      className="select"
                      value={displayId}
                      onChange={(e) => {
                        setDisplayId(e.target.value)
                        void run('capture', () => captureScreen(e.target.value))
                      }}
                    >
                      {displays.map((d) => (
                        <option key={d.id} value={String(d.id)}>
                          Display {d.id} — {d.w}×{d.h}{d.primary ? ' (primary)' : ''}
                        </option>
                      ))}
                    </select>
                  )}
                  <button className="btn-ghost dc-btn" onClick={() => run('capture', () => captureScreen())} disabled={!!busy}>
                    <Camera size={13} /> Capture
                  </button>
                  <button
                    className={`btn-ghost dc-btn ${autoShot ? 'on' : ''}`}
                    onClick={() => setAutoShot((v) => !v)}
                  >
                    {autoShot ? <Square size={12} /> : <Play size={12} />}
                    {autoShot ? 'Stop live' : 'Live 2.5s'}
                  </button>
                  <button className="btn-ghost dc-btn" onClick={() => void runOcr()} disabled={!!busy}>
                    <ScanText size={13} /> Read text
                  </button>
                  <button
                    className="btn-ghost dc-btn"
                    onClick={() =>
                      run('export', async () => {
                        if (!capture) throw new Error('Capture the screen first.')
                        const res = await call(desk!.exportFile(capture.file || capture.image, `orvex-screen-${Date.now()}.png`))
                        if (!res.cancelled) notify(`Screenshot saved to ${res.path}`)
                      })
                    }
                  >
                    <Download size={13} /> Save
                  </button>
                  <button
                    className="btn-ghost dc-btn"
                    onClick={() =>
                      run('clipboard', async () => {
                        if (!capture) throw new Error('Capture the screen first.')
                        const res = await call(desk!.clipboardWrite({ imagePath: capture.file || capture.image }))
                        notify(res.output)
                      })
                    }
                  >
                    <ClipboardCopy size={13} /> Copy
                  </button>
                  <button
                    className="dc-icon-btn"
                    title="Show in Explorer"
                    onClick={() =>
                      run('reveal', async () => {
                        if (!capture) throw new Error('Capture the screen first.')
                        await call(desk!.reveal(capture.file || capture.image))
                      })
                    }
                  >
                    <FolderOpen size={13} />
                  </button>
                </div>

                <div className={`dc-shot ${capture ? 'has' : ''}`}>
                  {capture ? (
                    <img src={capture.url} alt="Current screen capture" />
                  ) : (
                    <div className="dc-empty-inline"><Loader2 size={14} className="spin" /> Capturing the screen…</div>
                  )}
                </div>
                {capture && (
                  <p className="dc-hint">
                    {capture.output.split('\n')[0]} · {displays.length} display{displays.length === 1 ? '' : 's'}
                  </p>
                )}
              </div>

              <div className="dc-split">
                <div className="dc-card">
                  <div className="dc-card-head"><Monitor size={13} /><h3>Displays</h3></div>
                  <div className="dc-rows">
                    {displays.map((d) => (
                      <div key={d.id} className="dc-row">
                        <span className={`dc-dot ${d.primary ? 'on' : ''}`} />
                        <div className="dc-grow">
                          <div className="dc-name">Display {d.id}{d.primary ? ' · primary' : ''}</div>
                          <div className="dc-meta">{d.w}×{d.h} px at {d.x},{d.y}</div>
                        </div>
                      </div>
                    ))}
                    {!displays.length && <div className="dc-muted">No display data yet.</div>}
                  </div>
                </div>

                <div className="dc-card">
                  <div className="dc-card-head"><Crosshair size={13} /><h3>Cursor & scale</h3></div>
                  <div className="dc-stack">
                    <div className="dc-kv"><span>Cursor</span><b>{cursor ? `${cursor.x}, ${cursor.y}` : '—'}</b></div>
                    <div className="dc-kv"><span>Virtual desktop</span><b>{screenInfo ? `${screenInfo.bounds.w}×${screenInfo.bounds.h}` : '—'}</b></div>
                    <button
                      className="btn-ghost dc-btn"
                      onClick={() => run('cursor', async () => {
                        await refreshScreens()
                        notify('Cursor position refreshed.')
                      })}
                    >
                      <RotateCcw size={12} /> Refresh position
                    </button>
                  </div>
                </div>
              </div>

              {ocr && (
                <div className="dc-card">
                  <div className="dc-card-head">
                    <ScanText size={14} />
                    <h3>Recognised text</h3>
                    <span className="dc-chip">{ocr.lines.length} lines · {ocr.lang || 'default'}</span>
                  </div>
                  {ocr.lines.length ? (
                    <div className="dc-ocr-lines">
                      {ocr.lines.map((line, i) => (
                        <div key={`${line.x}-${line.y}-${i}`} className="dc-ocr-line">
                          <span className="dc-ocr-coord">{line.x},{line.y}</span>
                          <span>{line.text}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="dc-hint">No text was recognised in this image.</p>
                  )}
                  <div className="dc-inline-actions">
                    <button className="btn-ghost dc-btn" onClick={() => run('clipboard', async () => {
                      await call(desk!.clipboardWrite({ text: ocr.text }))
                      notify('OCR text copied to the clipboard.')
                    })}><ClipboardCopy size={12} /> Copy text</button>
                    <button className="btn-ghost dc-btn" onClick={() => run('save', async () => {
                      const asset = await call(window.orvex!.media.saveText(`ocr-${Date.now()}`, ocr.text, 'txt'))
                      notify(`Saved ${asset.name} in the media library.`)
                    })}><Save size={12} /> Save to media</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === 'input' && (
            <div className="dc-tab-body">
              <div className="dc-card">
                <div className="dc-card-head"><MousePointer2 size={14} /><h3>Mouse</h3><span className="dc-chip">screen pixels</span></div>
                <div className="dc-field-row">
                  <label className="dc-field"><span>X</span><input className="text-input" type="number" value={mx} onChange={(e) => setMx(Number(e.target.value))} /></label>
                  <label className="dc-field"><span>Y</span><input className="text-input" type="number" value={my} onChange={(e) => setMy(Number(e.target.value))} /></label>
                  <button className="btn-ghost dc-btn" onClick={() => run('mouse', async () => {
                    const res = await call(desk!.mouseMove(mx, my))
                    setLastAction(res.output); notify(res.output)
                  })}><Crosshair size={12} /> Move</button>
                  <button className="btn-ghost dc-btn" onClick={() => run('mouse', async () => {
                    const res = await call(desk!.mouseClick({ x: mx, y: my, button: 'left' }))
                    setLastAction(res.output); notify(res.output)
                  })}><MousePointer2 size={12} /> Left click</button>
                  <button className="btn-ghost dc-btn" onClick={() => run('mouse', async () => {
                    const res = await call(desk!.mouseClick({ x: mx, y: my, button: 'right' }))
                    setLastAction(res.output); notify(res.output)
                  })}>Right click</button>
                  <button className="btn-ghost dc-btn" onClick={() => run('mouse', async () => {
                    const res = await call(desk!.mouseClick({ x: mx, y: my, button: 'left', count: 2 }))
                    setLastAction(res.output); notify(res.output)
                  })}>Double click</button>
                </div>
                <div className="dc-field-row">
                  <button className="btn-ghost dc-btn" onClick={() => run('mouse', async () => {
                    const res = await call(desk!.mouseScroll({ amount: 3, x: mx, y: my }))
                    setLastAction(res.output); notify(res.output)
                  })}>Scroll up</button>
                  <button className="btn-ghost dc-btn" onClick={() => run('mouse', async () => {
                    const res = await call(desk!.mouseScroll({ amount: -3, x: mx, y: my }))
                    setLastAction(res.output); notify(res.output)
                  })}>Scroll down</button>
                  <button className="btn-ghost dc-btn" onClick={() => run('cursor', async () => {
                    const info = await refreshScreens()
                    if (info) {
                      setMx(info.cursor.x); setMy(info.cursor.y); setDragTo({ x: info.cursor.x, y: info.cursor.y })
                    }
                    notify('Coordinates synced to the real cursor.')
                  })}><Crosshair size={12} /> Use cursor position</button>
                </div>
                <div className="dc-field-row">
                  <span className="dc-field-label">Drag to</span>
                  <label className="dc-field"><span>X</span><input className="text-input" type="number" value={dragTo.x} onChange={(e) => setDragTo((p) => ({ ...p, x: Number(e.target.value) }))} /></label>
                  <label className="dc-field"><span>Y</span><input className="text-input" type="number" value={dragTo.y} onChange={(e) => setDragTo((p) => ({ ...p, y: Number(e.target.value) }))} /></label>
                  <button className="btn-ghost dc-btn" onClick={() => run('mouse', async () => {
                    const res = await call(desk!.mouseDrag({ fromX: mx, fromY: my, toX: dragTo.x, toY: dragTo.y }))
                    setLastAction(res.output); notify(res.output)
                  })}>Drag</button>
                </div>
                <p className="dc-hint">Coordinates are physical screen pixels. Capture the screen and add each display origin for multi-monitor setups.</p>
              </div>

              <div className="dc-card">
                <div className="dc-card-head"><Keyboard size={14} /><h3>Keyboard</h3></div>
                <textarea
                  className="text-input dc-textarea"
                  rows={3}
                  placeholder="Text to type into the focused window…"
                  value={typeText}
                  onChange={(e) => setTypeText(e.target.value)}
                />
                <div className="dc-inline-actions">
                  <button className="btn-primary dc-btn" onClick={typeIntoFocus} disabled={!!busy}><Keyboard size={12} /> Type text</button>
                  <span className="dc-muted">{typeText.length} chars</span>
                </div>
                <div className="dc-field-row">
                  <input
                    className="text-input"
                    placeholder="Key or chord, e.g. CTRL+S"
                    value={keyChord}
                    onChange={(e) => setKeyChord(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void press(keyChord) }}
                  />
                  <button className="btn-ghost dc-btn" onClick={() => press(keyChord)} disabled={!keyChord.trim() || !!busy}>Press</button>
                </div>
                <div className="dc-quick-keys">
                  {QUICK_KEYS.map((k) => (
                    <button key={k.keys} className="dc-key" onClick={() => press(k.keys, k.label)}>{k.label}</button>
                  ))}
                </div>
                <p className="dc-hint">Keys go to the focused window. Media and volume keys work system-wide.</p>
              </div>
            </div>
          )}

          {tab === 'windows' && (
            <div className="dc-tab-body">
              <div className="dc-card dc-fill">
                <div className="dc-card-head">
                  <AppWindow size={14} />
                  <h3>Open windows</h3>
                  <span className="dc-chip">{visibleWindows.length}</span>
                  <button className="dc-icon-btn" onClick={() => run('windows', loadWindows)} title="Refresh"><RefreshCw size={12} /></button>
                </div>
                <div className="dc-search">
                  <Search size={12} />
                  <input className="text-input" placeholder="Filter by title or class…" value={winFilter} onChange={(e) => setWinFilter(e.target.value)} />
                </div>
                <div className="dc-rows dc-scroll">
                  {visibleWindows.map((w) => (
                    <div key={w.hwnd} className={`dc-row ${w.foreground ? 'fg' : ''}`}>
                      <div className="dc-grow">
                        <div className="dc-name" title={w.title}>{w.title}</div>
                        <div className="dc-meta">hwnd {w.hwnd} · pid {w.pid} · {w.state} · {w.w}×{w.h}</div>
                      </div>
                      <button className="dc-icon-btn" title="Focus" onClick={() => run('window', async () => {
                        const res = await call(desk!.windowAction({ handle: w.hwnd, action: 'focus' }))
                        setLastAction(res.output); await loadWindows()
                      })}><Focus size={12} /></button>
                      <button className="dc-icon-btn" title="Minimize" onClick={() => run('window', async () => {
                        const res = await call(desk!.windowAction({ handle: w.hwnd, action: 'minimize' }))
                        setLastAction(res.output); await loadWindows()
                      })}><Minus size={12} /></button>
                      <button className="dc-icon-btn" title="Maximize" onClick={() => run('window', async () => {
                        const res = await call(desk!.windowAction({ handle: w.hwnd, action: 'maximize' }))
                        setLastAction(res.output); await loadWindows()
                      })}><Maximize2 size={12} /></button>
                      <button className="dc-icon-btn" title="Restore" onClick={() => run('window', async () => {
                        const res = await call(desk!.windowAction({ handle: w.hwnd, action: 'restore' }))
                        setLastAction(res.output); await loadWindows()
                      })}><RotateCcw size={12} /></button>
                      <button className="dc-icon-btn" title="Inspect with UI Automation" onClick={() => {
                        setAutoTarget(w.title); setTab('automation')
                      }}><ListTree size={12} /></button>
                      <button className="dc-icon-btn danger" title="Close window" onClick={() => {
                        if (!window.confirm(`Close "${w.title}"? Unsaved work may prompt in that app.`)) return
                        void run('window', async () => {
                          const res = await call(desk!.windowAction({ handle: w.hwnd, action: 'close' }))
                          setLastAction(res.output); await loadWindows()
                        })
                      }}><X size={12} /></button>
                    </div>
                  ))}
                  {!visibleWindows.length && <div className="dc-muted">No window matches this filter.</div>}
                </div>
              </div>
            </div>
          )}

          {tab === 'processes' && (
            <div className="dc-tab-body">
              <div className="dc-card dc-fill">
                <div className="dc-card-head">
                  <Cpu size={14} />
                  <h3>Processes</h3>
                  <span className="dc-chip">{processes.length}</span>
                  <button className="dc-icon-btn" onClick={() => run('processes', loadProcesses)} title="Refresh"><RefreshCw size={12} /></button>
                </div>
                <div className="dc-field-row">
                  <div className="dc-search dc-grow">
                    <Search size={12} />
                    <input className="text-input" placeholder="Filter by process name or window title…" value={procFilter} onChange={(e) => setProcFilter(e.target.value)} />
                  </div>
                  <select className="select" value={procSort} onChange={(e) => setProcSort(e.target.value as 'memory' | 'cpu' | 'name' | 'pid')}>
                    <option value="memory">Sort: memory</option>
                    <option value="cpu">Sort: CPU time</option>
                    <option value="name">Sort: name</option>
                    <option value="pid">Sort: PID</option>
                  </select>
                </div>
                <div className="dc-rows dc-scroll">
                  {processes.map((p) => (
                    <div key={p.pid} className="dc-row">
                      <div className="dc-grow">
                        <div className="dc-name">{p.name} <span className="dc-pid">pid {p.pid}</span></div>
                        <div className="dc-meta">{p.memMB} MB · CPU {p.cpu}s{p.title ? ` · ${p.title}` : ''}</div>
                      </div>
                      <button className="dc-icon-btn danger" title="Stop process" onClick={() => {
                        if (!window.confirm(`Stop ${p.name} (pid ${p.pid})? Unsaved work in that app will be lost.`)) return
                        void run('kill', async () => {
                          const res = await call(desk!.processKill({ pid: p.pid }))
                          notify(res.output)
                          await loadProcesses()
                        })
                      }}><Trash2 size={12} /></button>
                    </div>
                  ))}
                  {!processes.length && <div className="dc-muted">No process matches this filter.</div>}
                </div>
                <p className="dc-hint">Core Windows processes and ORVEX itself are always refused by the backend.</p>
              </div>
            </div>
          )}

          {tab === 'clipboard' && (
            <div className="dc-tab-body">
              <div className="dc-card">
                <div className="dc-card-head">
                  <ClipboardCopy size={14} />
                  <h3>Clipboard</h3>
                  <span className="dc-chip">{clip ? clip.kind : '…'}</span>
                  <button className="dc-icon-btn" title="Read clipboard" onClick={() => run('clipboard', readClipboard)}><RefreshCw size={12} /></button>
                </div>
                {clip?.kind === 'image' && clip.url && (
                  <div className="dc-shot small"><img src={clip.url} alt="Clipboard image" /></div>
                )}
                <textarea
                  className="text-input dc-textarea"
                  rows={6}
                  value={clipText}
                  onChange={(e) => setClipText(e.target.value)}
                  placeholder="Clipboard text appears here; edit and copy it back."
                />
                <div className="dc-inline-actions">
                  <button className="btn-primary dc-btn" onClick={() => run('clipboard', async () => {
                    if (!clipText.trim()) throw new Error('Type some text first.')
                    const res = await call(desk!.clipboardWrite({ text: clipText }))
                    notify(res.output)
                    await readClipboard()
                  })}><ClipboardCopy size={12} /> Copy text</button>
                  <button className="btn-ghost dc-btn" onClick={() => run('clipboard', async () => {
                    const res = await call(desk!.clipboardWrite({ text: clipText }))
                    notify(res.output)
                  })}><Save size={12} /> Write without re-reading</button>
                  <button className="btn-ghost dc-btn" onClick={() => run('clipboard', async () => {
                    if (!capture) throw new Error('Capture the screen first.')
                    const res = await call(desk!.clipboardWrite({ imagePath: capture.file || capture.image }))
                    notify(res.output)
                  })}><Camera size={12} /> Copy last screenshot</button>
                </div>
                {clip && <p className="dc-hint">{clip.output}</p>}
              </div>
            </div>
          )}

          {tab === 'automation' && (
            <div className="dc-tab-body">
              <div className="dc-card">
                <div className="dc-card-head"><ListTree size={14} /><h3>UI Automation</h3><span className="dc-chip">Windows UIA</span></div>
                <div className="dc-field-row">
                  <label className="dc-field grow">
                    <span>Window</span>
                    <select className="select" value={autoTarget} onChange={(e) => setAutoTarget(e.target.value)}>
                      <option value="">Pick an open window…</option>
                      {windows.map((w) => <option key={w.hwnd} value={w.title}>{w.title}</option>)}
                    </select>
                  </label>
                  <label className="dc-field narrow">
                    <span>Depth</span>
                    <input className="text-input" type="number" min={1} max={12} value={uiDepth} onChange={(e) => setUiDepth(Number(e.target.value))} />
                  </label>
                  <button className="btn-ghost dc-btn" onClick={loadUiTree} disabled={!autoTarget || !!busy}>Read tree</button>
                </div>
                {uiTree ? (
                  <pre className="dc-pre">{uiTree.output}</pre>
                ) : (
                  <p className="dc-hint">Read the tree to see element paths, control types and supported actions.</p>
                )}
              </div>

              <div className="dc-card">
                <div className="dc-card-head"><Focus size={13} /><h3>Act on an element</h3></div>
                <div className="dc-field-row">
                  <label className="dc-field"><span>Path</span><input className="text-input" placeholder="[0/1/2]" value={uiPath} onChange={(e) => setUiPath(e.target.value)} /></label>
                  <label className="dc-field"><span>Action</span>
                    <select className="select" value={uiAction} onChange={(e) => setUiAction(e.target.value)}>
                      {['click', 'invoke', 'set_value', 'toggle', 'select', 'expand', 'collapse', 'focus', 'scroll'].map((a) => (
                        <option key={a} value={a}>{a}</option>
                      ))}
                    </select>
                  </label>
                  <label className="dc-field"><span>Value</span><input className="text-input" placeholder="for set_value / scroll" value={uiValue} onChange={(e) => setUiValue(e.target.value)} /></label>
                  <button className="btn-primary dc-btn" onClick={runUiAction} disabled={!autoTarget || !!busy}>Run action</button>
                </div>
                <p className="dc-hint">Paths come from the tree above. UI Automation is more reliable than blind clicks for native apps.</p>
              </div>
            </div>
          )}

          {tab === 'hands' && (
            <div className="dc-tab-body">
              <div className="dc-card">
                <div className="dc-card-head">
                  <Hand size={14} />
                  <h3>Hands task</h3>
                  <span className={`dc-chip ${handRunning ? 'live' : ''}`}>{handRunning ? 'running' : 'idle'}</span>
                </div>
                <div className="dc-stack">
                  <label className="dc-field grow">
                    <span>Goal</span>
                    <textarea
                      className="text-input dc-textarea dc-hands-goal"
                      placeholder="e.g. Open Notepad and type today's date"
                      value={goal}
                      onChange={(e) => setGoal(e.target.value)}
                      rows={2}
                    />
                  </label>
                  <div className="dc-field-row">
                    <label className="dc-field narrow">
                      <span>Max steps</span>
                      <input
                        className="text-input"
                        type="number"
                        min={1}
                        max={12}
                        value={maxSteps}
                        onChange={(e) => setMaxSteps(Math.max(1, Math.min(12, Number(e.target.value))))}
                      />
                    </label>
                    <button className="btn-primary dc-btn" onClick={startHands} disabled={handRunning || goal.trim().length < 4 || !!busy}>
                      {handRunning ? <Loader2 size={12} className="spin" /> : <Play size={12} />} Run hands
                    </button>
                    <button className="btn-ghost dc-btn" onClick={() => void stopHands()} disabled={!handRunning}>
                      <Square size={12} /> Stop
                    </button>
                  </div>
                </div>
                <p className="dc-hint">
                  The vision model looks at a screenshot each step, then ORVEX clicks, types or opens an app. Bounded to
                  12 steps. If no vision model is configured the task stops with an explanation instead of guessing.
                </p>
                {handNote && <p className={`dc-hands-note ${handRunning ? '' : handSteps.length ? 'done' : ''}`}>{handNote}</p>}
                {handSteps.length > 0 && (
                  <div className="dc-step-list">
                    {handSteps.map((step) => (
                      <div key={step.step} className={`dc-step ${step.ok ? 'ok' : 'bad'}`}>
                        <span className="dc-step-num">{step.step}</span>
                        <span className="dc-step-what">{step.what}</span>
                        <span className="dc-step-meta">{step.ms != null ? `${step.ms} ms` : ''}</span>
                        {(step.output || step.error || step.note) && (
                          <span className="dc-step-detail">{step.error || step.output || step.note}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="dc-card">
                <div className="dc-card-head">
                  <Search size={13} />
                  <h3>Find & click text</h3>
                  <span className="dc-chip">UIA + OCR</span>
                </div>
                <div className="dc-field-row">
                  <label className="dc-field grow">
                    <span>Visible label</span>
                    <input
                      className="text-input"
                      placeholder="e.g. Save"
                      value={findText}
                      onChange={(e) => setFindText(e.target.value)}
                    />
                  </label>
                  <button className="btn-ghost dc-btn" onClick={locateText} disabled={!!busy}>Find</button>
                  <button className="btn-primary dc-btn" onClick={() => clickLocated(0)} disabled={!!busy}>Click first match</button>
                </div>
                {findResult && (
                  <div className="dc-app-list">
                    {findResult.matches.length ? (
                      findResult.matches.slice(0, 10).map((m, i) => (
                        <button key={`${m.source}-${m.path}-${i}`} className="dc-app-row" onClick={() => clickLocated(i)} title="Click this match">
                          <span className="dc-app-name">{m.name}</span>
                          <span className="dc-app-meta">{m.source} · {Math.round(m.cx)},{Math.round(m.cy)}{m.window ? ` · ${m.window}` : ''}</span>
                        </button>
                      ))
                    ) : (
                      <p className="dc-hint">{findResult.output}</p>
                    )}
                  </div>
                )}
              </div>

              <div className="dc-card">
                <div className="dc-card-head">
                  <Rocket size={13} />
                  <h3>Installed apps</h3>
                  <span className="dc-chip">{apps.length ? `${apps.length}` : 'not loaded'}</span>
                </div>
                <div className="dc-field-row">
                  <label className="dc-field grow">
                    <span>Search</span>
                    <input className="text-input" placeholder="Type an app name…" value={appFilter} onChange={(e) => setAppFilter(e.target.value)} />
                  </label>
                  <button className="btn-ghost dc-btn" onClick={refreshApps} disabled={!!busy}>
                    <RefreshCw size={12} /> Rescan
                  </button>
                </div>
                <div className="dc-app-list">
                  {visibleApps.map((app) => (
                    <button key={app.appId} className="dc-app-row" onClick={() => launchApp(app.name)} disabled={!!busy} title={`Launch ${app.name}`}>
                      <span className="dc-app-name">{app.name}</span>
                      <span className="dc-app-meta"><Play size={10} /> launch</span>
                    </button>
                  ))}
                  {!visibleApps.length && <p className="dc-hint">{appsLoaded ? 'No app matches this search.' : 'Apps load when this tab opens.'}</p>}
                </div>
                <p className="dc-hint">Agent tools launch apps only after the user approves the call; this list is a direct manual launcher.</p>
              </div>
            </div>
          )}

          {tab === 'record' && (
            <div className="dc-tab-body">
              <div className="dc-card">
                <div className="dc-card-head">
                  <FileVideo size={14} />
                  <h3>Screen recording</h3>
                  <span className={`dc-chip ${recording?.active ? 'live' : ''}`}>{recording?.active ? `${recording.seconds || 0}s` : 'idle'}</span>
                </div>
                <div className="dc-field-row">
                  <label className="dc-field">
                    <span>Display</span>
                    <select className="select" value={recDisplay} onChange={(e) => setRecDisplay(e.target.value)} disabled={recording?.active}>
                      {displays.map((d) => <option key={d.id} value={String(d.id)}>Display {d.id}{d.primary ? ' (primary)' : ''}</option>)}
                    </select>
                  </label>
                  <label className="dc-field narrow">
                    <span>FPS</span>
                    <input className="text-input" type="number" min={5} max={30} value={recFps} onChange={(e) => setRecFps(Number(e.target.value))} disabled={recording?.active} />
                  </label>
                  <label className="dc-field">
                    <span>Audio</span>
                    <select className="select" value={recAudio} onChange={(e) => setRecAudio(e.target.value as 'none' | 'mic' | 'system')} disabled={recording?.active}>
                      <option value="none">No audio</option>
                      <option value="mic">Microphone</option>
                      <option value="system">System audio</option>
                    </select>
                  </label>
                  {recording?.active ? (
                    <button className="btn-primary dc-btn recording" onClick={stopRecording} disabled={!!busy}>
                      <Square size={12} /> Stop & save
                    </button>
                  ) : (
                    <button className="btn-primary dc-btn" onClick={startRecording} disabled={!!busy}>
                      <Play size={12} /> Start recording
                    </button>
                  )}
                </div>
                {recording?.active && (
                  <div className="dc-rec-status">
                    <span className="dc-rec-dot" />
                    Recording display {recording.display} · {recording.seconds || 0}s · {fmtBytes(recording.bytes || 0)} written
                  </div>
                )}
                {recording?.file && !recording.active && (
                  <>
                    <div className="dc-shot">
                      {recording.url ? <video src={recording.url} controls preload="metadata" /> : <span className="dc-muted">{recording.output}</span>}
                    </div>
                    <div className="dc-inline-actions">
                      <button className="btn-ghost dc-btn" onClick={() => run('export', async () => {
                        const res = await call(desk!.exportFile(recording.file!, `orvex-recording-${Date.now()}.webm`))
                        if (!res.cancelled) notify(`Recording saved to ${res.path}`)
                      })}><Download size={12} /> Export .webm</button>
                      <button className="btn-ghost dc-btn" onClick={() => run('reveal', async () => {
                        await call(desk!.reveal(recording.file!))
                      })}><FolderOpen size={12} /> Show in Explorer</button>
                      <span className="dc-muted">{recording.file}</span>
                    </div>
                  </>
                )}
                {!recording?.active && !recording?.file && (
                  <p className="dc-hint">Recordings are written as .webm to the ORVEX data folder and stop automatically after 10 minutes.</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </PageShell>
  )
}
