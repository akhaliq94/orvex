import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, CameraOff, Cpu, Hand, Pause, Play, Square, RotateCcw, Crosshair } from 'lucide-react'
import type { HandLandmarker, HandLandmarkerResult } from '@mediapipe/tasks-vision'
import PageShell from './PageShell'
import {
  DEFAULT_SETTINGS,
  DwellTracker,
  FIST_STOP_MS,
  GestureHold,
  PALM_PAUSE_MS,
  PinchTracker,
  classifyGesture,
  mapToScreen,
  pinchRatio,
  smoothPoint,
  type AirSettings,
  type Gesture,
  type Pt,
} from '../airtouch/engine'

type Props = { onBack: () => void; notify: (msg: string) => void }
type Phase = 'idle' | 'starting' | 'live' | 'paused' | 'stopped' | 'error'
type Bounds = { x: number; y: number; w: number; h: number }

const CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
]

const STORE_KEY = 'orvex.air.settings'
const UI_EVERY_MS = 150
const MOVE_EVERY_MS = 38

function loadSettings(): AirSettings {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<AirSettings>
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return DEFAULT_SETTINGS
  }
}

const bridge = () => (typeof window !== 'undefined' ? window.orvex : undefined)

async function createLandmarker(baseUrl: string): Promise<{ landmarker: HandLandmarker; gpu: boolean }> {
  const vision = await import('@mediapipe/tasks-vision')
  const fileset = await vision.FilesetResolver.forVisionTasks(`${baseUrl}/wasm`)
  const modelAssetPath = `${baseUrl}/hand_landmarker.task`
  const common = {
    runningMode: 'VIDEO' as const,
    numHands: 1,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.6,
    minTrackingConfidence: 0.6,
  }
  try {
    const landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate: 'GPU' },
      ...common,
    })
    return { landmarker, gpu: true }
  } catch {
    const landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate: 'CPU' },
      ...common,
    })
    return { landmarker, gpu: false }
  }
}

async function tool(name: string, args: Record<string, unknown> = {}) {
  const api = bridge()
  if (!api) return { ok: false, error: 'Desktop bridge is unavailable.', data: undefined as unknown }
  const res = await api.tools.run(name, args)
  if (!res || !res.ok) return { ok: false, error: res && 'error' in res ? res.error : 'Tool failed.', data: undefined as unknown }
  const data = res.data as { ok?: boolean; error?: string } | undefined
  if (data && data.ok === false) return { ok: false, error: data.error || 'Tool failed.', data }
  return { ok: true, error: '', data }
}

export default function AirTouchPage({ onBack, notify }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  const [settings, setSettings] = useState<AirSettings>(() => loadSettings())
  const [dwellEnabled, setDwellEnabled] = useState(true)
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [cameraId, setCameraId] = useState('')
  const [gesture, setGesture] = useState<Gesture>('none')
  const [ratio, setRatio] = useState(0)
  const [fps, setFps] = useState(0)
  const [clicks, setClicks] = useState(0)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [stopReason, setStopReason] = useState('')
  const [modelNote, setModelNote] = useState('')
  const [testing, setTesting] = useState(false)
  const [bounds, setBounds] = useState<Bounds>({ x: 0, y: 0, w: 1920, h: 1080 })

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const landmarkerRef = useRef<HandLandmarker | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef(0)
  const dwellRef = useRef(new DwellTracker(settings))
  const pinchRef = useRef(new PinchTracker(settings))
  const holdRef = useRef(new GestureHold())
  const settingsRef = useRef(settings)
  const dwellEnabledRef = useRef(dwellEnabled)
  const phaseRef = useRef<Phase>('idle')
  const handleFrameRef = useRef<(t: number, result: HandLandmarkerResult) => void>(() => {})
  const fitRef = useRef<(() => void) | null>(null)
  const stateRef = useRef({
    running: false,
    paused: false,
    dragging: false,
    palmFiredAt: -1,
    lastVideoTime: -1,
    lastMoveAt: 0,
    lastUiAt: 0,
    lastSent: { x: -1, y: -1 },
    pointer: null as { x: number; y: number } | null,
    scrollY: null as number | null,
    scrollAccum: 0,
    bounds: { x: 0, y: 0, w: 1920, h: 1080 } as Bounds,
    fpsFrames: 0,
    fpsAt: 0,
    clicks: 0,
  })

  settingsRef.current = settings
  dwellEnabledRef.current = dwellEnabled
  phaseRef.current = phase

  useEffect(() => {
    dwellRef.current.configure(settings)
    pinchRef.current.configure(settings)
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(settings))
    } catch {
      /* storage can be full or blocked */
    }
  }, [settings])

  const setSetting = <K extends keyof AirSettings>(key: K, value: AirSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  const draw = useCallback((lm: Pt[] | null, ring: number, pinched: boolean) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)
    if (!lm) return
    const mirror = settingsRef.current.mirror
    const px = (p: Pt) => ({ x: (mirror ? 1 - p.x : p.x) * w, y: p.y * h })
    ctx.lineWidth = 3
    ctx.strokeStyle = pinched ? 'rgba(255,120,120,0.95)' : 'rgba(120,220,255,0.9)'
    ctx.beginPath()
    for (const [a, b] of CONNECTIONS) {
      const pa = px(lm[a])
      const pb = px(lm[b])
      ctx.moveTo(pa.x, pa.y)
      ctx.lineTo(pb.x, pb.y)
    }
    ctx.stroke()
    ctx.fillStyle = 'rgba(190,245,255,0.95)'
    for (const p of lm) {
      const q = px(p)
      ctx.beginPath()
      ctx.arc(q.x, q.y, 3, 0, Math.PI * 2)
      ctx.fill()
    }
    const tip = px(lm[8])
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(tip.x, tip.y, 12, 0, Math.PI * 2)
    ctx.stroke()
    if (ring > 0) {
      ctx.strokeStyle = 'rgba(255,200,80,0.95)'
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.arc(tip.x, tip.y, 22, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, ring))
      ctx.stroke()
    }
  }, [])

  const stopStream = useCallback(() => {
    stateRef.current.running = false
    cancelAnimationFrame(rafRef.current)
    const stream = streamRef.current
    streamRef.current = null
    if (stream) stream.getTracks().forEach((t) => t.stop())
    const landmarker = landmarkerRef.current
    landmarkerRef.current = null
    try {
      landmarker?.close()
    } catch {
      /* already closed */
    }
    const video = videoRef.current
    if (video) {
      video.srcObject = null
      if (fitRef.current) video.removeEventListener('loadedmetadata', fitRef.current)
      fitRef.current = null
    }
  }, [])

  const releaseDrag = useCallback(() => {
    if (!stateRef.current.dragging) return
    stateRef.current.dragging = false
    setDragging(false)
    void tool('mouse_up', { button: 'left' })
  }, [])

  const emergencyStop = useCallback(
    (reason: string) => {
      stateRef.current.paused = true
      releaseDrag()
      stopStream()
      setStopReason(reason)
      setPhase('stopped')
      notify(`Air Touch stopped: ${reason}`)
    },
    [notify, releaseDrag, stopStream],
  )

  const clickAtCursor = useCallback((count: number) => {
    const p = stateRef.current.pointer
    if (!p) return
    stateRef.current.clicks += 1
    setClicks(stateRef.current.clicks)
    void tool('mouse_click', { x: Math.round(p.x), y: Math.round(p.y), button: 'left', count })
  }, [])

  const handleFrame = useCallback(
    (t: number, result: HandLandmarkerResult) => {
      const st = stateRef.current
      const cfg = settingsRef.current
      const lm = result.landmarks && result.landmarks[0] ? (result.landmarks[0] as Pt[]) : null
      const publish = (g: Gesture, r: number, p: { x: number; y: number } | null) => {
        if (t - st.lastUiAt < UI_EVERY_MS) return
        st.lastUiAt = t
        setGesture(g)
        setRatio(Number.isFinite(r) ? Math.round(r * 100) / 100 : 0)
        setCursor(p)
      }
      if (!lm) {
        st.pointer = null
        publish('none', 0, null)
        draw(null, 0, false)
        return
      }

      const r = pinchRatio(lm)
      const pinch = pinchRef.current.update(r, t, !st.paused)
      const g = classifyGesture(lm, pinch.pinching)
      const hold = holdRef.current.update(g, t)

      if (!st.paused) {
        if (g === 'fist' && hold.heldMs >= FIST_STOP_MS) {
          emergencyStop('fist held — emergency stop')
          return
        }
        if (g === 'open' && hold.heldMs >= PALM_PAUSE_MS && st.palmFiredAt !== hold.since) {
          st.palmFiredAt = hold.since
          st.paused = true
          releaseDrag()
          pinchRef.current.reset()
          setPhase('paused')
          publish(g, r, st.pointer)
          draw(lm, 0, false)
          notify('Paused by open palm. Press Resume to continue.')
          return
        }
      }

      const index = lm[8]
      const thumb = lm[4]
      const raw = pinch.pinching ? { x: (index.x + thumb.x) / 2, y: (index.y + thumb.y) / 2 } : index
      const mapped = mapToScreen(raw, st.bounds, cfg)
      st.pointer = smoothPoint(st.pointer, mapped, cfg.sensitivity)
      const pointer = { x: Math.round(st.pointer.x), y: Math.round(st.pointer.y) }

      let ring = 0
      if (!st.paused) {
        if (t - st.lastMoveAt >= MOVE_EVERY_MS && (pointer.x !== st.lastSent.x || pointer.y !== st.lastSent.y)) {
          st.lastMoveAt = t
          st.lastSent = pointer
          void tool('mouse_move', pointer)
        }

        if (g === 'peace' && !pinch.pinching) {
          if (st.scrollY == null) st.scrollY = raw.y
          st.scrollAccum += raw.y - st.scrollY
          st.scrollY = raw.y
          const step = 0.025
          while (Math.abs(st.scrollAccum) >= step) {
            const amount = st.scrollAccum < 0 ? 1 : -1
            st.scrollAccum += st.scrollAccum < 0 ? step : -step
            void tool('mouse_scroll', { amount })
          }
        } else {
          st.scrollY = null
          st.scrollAccum = 0
        }

        if (pinch.event === 'click' || pinch.event === 'double-click') {
          clickAtCursor(pinch.event === 'double-click' ? 2 : 1)
        } else if (pinch.event === 'drag-start') {
          st.dragging = true
          setDragging(true)
          void tool('mouse_down', { button: 'left' })
        } else if (pinch.event === 'drag-end') {
          releaseDrag()
        }

        const dwell = dwellRef.current.update(
          pointer.x,
          pointer.y,
          t,
          dwellEnabledRef.current && !pinch.pinching && !st.dragging && g !== 'fist' && g !== 'open' && g !== 'peace',
        )
        ring = dwell.progress
        if (dwell.fire) clickAtCursor(1)
      }

      publish(g, r, pointer)
      draw(lm, ring, pinch.pinching)

      st.fpsFrames += 1
      if (!st.fpsAt) st.fpsAt = t
      if (t - st.fpsAt >= 500) {
        setFps(Math.round((st.fpsFrames * 1000) / (t - st.fpsAt)))
        st.fpsFrames = 0
        st.fpsAt = t
      }
    },
    [clickAtCursor, draw, emergencyStop, notify, releaseDrag],
  )

  handleFrameRef.current = handleFrame

  const start = useCallback(async () => {
    const st = stateRef.current
    if (!bridge()) {
      setError('Air Touch needs the ORVEX desktop app.')
      setPhase('error')
      return
    }
    if (st.running || phaseRef.current === 'starting') return
    setError('')
    setModelNote('')
    setStopReason('')
    setPhase('starting')
    st.running = false
    st.paused = false
    st.dragging = false
    st.palmFiredAt = -1
    st.lastVideoTime = -1
    st.lastMoveAt = 0
    st.lastUiAt = 0
    st.lastSent = { x: -1, y: -1 }
    st.pointer = null
    st.scrollY = null
    st.scrollAccum = 0
    st.fpsFrames = 0
    st.fpsAt = 0
    st.clicks = 0
    pinchRef.current.reset()
    dwellRef.current.reset()
    holdRef.current.reset()
    setClicks(0)
    setCursor(null)

    try {
      const assetsRes = await bridge()!.media.assets()
      const baseUrl = assetsRes.ok ? assetsRes.data.baseUrl : ''
      if (!baseUrl) throw new Error('The bundled hand model is unavailable. Reinstall ORVEX to restore it.')

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('This build has no camera API (getUserMedia is missing).')
      }

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: cameraId
            ? { deviceId: { exact: cameraId }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }
            : { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
          audio: false,
        })
      } catch (err) {
        const name = err instanceof DOMException ? err.name : ''
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          throw new Error('Camera permission was denied. Allow camera access for ORVEX in Windows Settings → Privacy → Camera, then retry.')
        }
        if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          throw new Error('No camera was found on this machine. Plug in a webcam and retry.')
        }
        if (name === 'NotReadableError') {
          throw new Error('The camera is busy in another app. Close that app and retry.')
        }
        throw err
      }
      streamRef.current = stream

      const video = videoRef.current
      if (!video) throw new Error('The camera preview element is missing.')
      video.srcObject = stream
      await video.play()

      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        setCameras(devices.filter((d) => d.kind === 'videoinput'))
      } catch {
        /* labels unavailable */
      }

      const screenRes = await bridge()!.tools.run('screen_info', {})
      if (screenRes.ok && screenRes.data && typeof screenRes.data === 'object') {
        const b = (screenRes.data as { bounds?: Bounds }).bounds
        if (b && b.w > 0 && b.h > 0) {
          st.bounds = b
          setBounds(b)
        }
      }

      const vision = await createLandmarker(baseUrl)
      if (!vision.gpu) setModelNote('GPU delegate failed — running the hand model on CPU.')
      landmarkerRef.current = vision.landmarker

      st.running = true
      st.paused = false
      setPhase('live')
      notify('Air Touch is live. Move your index finger to steer, pinch to click.')

      const canvas = canvasRef.current
      const fit = () => {
        if (!canvas || !video) return
        canvas.width = video.videoWidth || 640
        canvas.height = video.videoHeight || 480
      }
      fitRef.current = fit
      fit()
      video.addEventListener('loadedmetadata', fit)

      const loop = () => {
        const s = stateRef.current
        if (!s.running) return
        rafRef.current = requestAnimationFrame(loop)
        const v = videoRef.current
        const l = landmarkerRef.current
        if (!v || !l || v.readyState < 2) return
        if (v.currentTime === s.lastVideoTime) return
        s.lastVideoTime = v.currentTime
        const now = performance.now()
        try {
          const result = l.detectForVideo(v, now)
          handleFrameRef.current(now, result)
        } catch (err) {
          emergencyStop(`tracking error — ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      rafRef.current = requestAnimationFrame(loop)
    } catch (err) {
      stopStream()
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }, [cameraId, emergencyStop, notify, stopStream])

  const testModel = useCallback(async () => {
    if (testing) return
    setTesting(true)
    setModelNote('Loading the hand model…')
    try {
      const assetsRes = await bridge()?.media.assets()
      const baseUrl = assetsRes && assetsRes.ok ? assetsRes.data.baseUrl : ''
      if (!baseUrl) throw new Error('The bundled hand model is unavailable.')
      const loaded = await createLandmarker(baseUrl)
      loaded.landmarker.close()
      setModelNote(`Model OK — wasm and hand model loaded locally (${loaded.gpu ? 'GPU' : 'CPU'} delegate).`)
      notify('Hand model loaded successfully.')
    } catch (err) {
      setModelNote(`Model test failed — ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setTesting(false)
    }
  }, [notify, testing])

  const resume = useCallback(() => {    const st = stateRef.current
    if (st.running) {
      st.paused = false
      st.palmFiredAt = -1
      st.scrollY = null
      st.scrollAccum = 0
      holdRef.current.reset()
      pinchRef.current.reset()
      setPhase('live')
      notify('Air Touch resumed.')
      return
    }
    void start()
  }, [notify, start])

  const pause = () => {
    stateRef.current.paused = true
    releaseDrag()
    pinchRef.current.reset()
    setPhase('paused')
  }

  const restart = async () => {
    releaseDrag()
    stopStream()
    stateRef.current.paused = false
    setPhase('idle')
    await new Promise((r) => setTimeout(r, 120))
    void start()
  }

  useEffect(() => {
    const off = bridge()?.air.onStop(() => {
      if (stateRef.current.running) emergencyStop('global shortcut Ctrl+Alt+Shift+X')
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stateRef.current.running) emergencyStop('Escape pressed')
    }
    window.addEventListener('keydown', onKey)
    return () => {
      off?.()
      window.removeEventListener('keydown', onKey)
      releaseDrag()
      stopStream()
    }
  }, [emergencyStop, releaseDrag, stopStream])

  const live = phase === 'live'
  const busy = phase === 'starting'
  const canRestart = phase === 'stopped' || phase === 'error' || phase === 'idle'

  return (
    <PageShell
      title="Air Touch"
      sub="Camera hand tracking — pinch, dwell, drag and gestures control the real mouse"
      onBack={onBack}
      actions={
        <span className={`air-chip ${live ? 'live' : phase}`}>
          {live ? 'LIVE' : phase === 'paused' ? 'PAUSED' : phase === 'stopped' ? 'STOPPED' : phase === 'starting' ? 'STARTING' : phase === 'error' ? 'ERROR' : 'IDLE'}
        </span>
      }
    >
      <div className="air-page">
        <div className="air-stage panel">
          <div className="air-video-wrap">
            <video
              ref={videoRef}
              className={`air-video ${settings.mirror ? 'mirrored' : ''}`}
              muted
              playsInline
              aria-label="Camera preview"
            />
            <canvas ref={canvasRef} className="air-overlay" aria-hidden="true" />
            {!live && phase !== 'paused' && (
              <div className="air-stage-empty">
                <Hand size={44} strokeWidth={1.3} />
                <p>
                  {phase === 'starting'
                    ? 'Loading the hand model and camera…'
                    : phase === 'error'
                      ? error
                      : phase === 'stopped'
                        ? `Stopped: ${stopReason || 'emergency stop'}`
                        : 'Start Air Touch to control the cursor with your hand. The model runs locally and nothing is uploaded.'}
                </p>
                {phase === 'error' && <span className="air-dim">{error}</span>}
              </div>
            )}
          </div>

          <div className="air-stage-bar">
            <button className="air-btn primary" onClick={() => (live ? pause() : resume())} disabled={busy}>
              {live ? <Pause size={15} /> : <Play size={15} />}
              {live ? 'Pause' : phase === 'paused' ? 'Resume' : 'Start'}
            </button>
            <button className="air-btn danger" onClick={() => emergencyStop('Stop button pressed')} disabled={!live && phase !== 'paused'}>
              <Square size={14} /> Emergency stop
            </button>
            <button className="air-btn" onClick={() => void restart()} disabled={busy || !canRestart} title="Restart with the current camera and settings">
              <RotateCcw size={14} /> Restart
            </button>
            <span className="air-hint">
              <Crosshair size={13} /> Esc or Ctrl+Alt+Shift+X stops instantly
            </span>
          </div>

          <div className="air-readout">
            <span>Gesture <b>{gesture}</b></span>
            <span>Pinch <b>{ratio.toFixed(2)}</b></span>
            <span>FPS <b>{fps}</b></span>
            <span>Clicks <b>{clicks}</b></span>
            <span>Cursor <b>{cursor ? `${cursor.x}, ${cursor.y}` : '—'}</b></span>
            <span>Mode <b>{dragging ? 'dragging' : live ? 'tracking' : phase}</b></span>
          </div>
          {modelNote && <p className="air-note">{modelNote}</p>}
        </div>

        <div className="air-side">
          <div className="panel air-card">
            <div className="agent-log-head"><Hand size={14} /> Gestures</div>
            <ul className="air-list">
              <li><b>Point</b> — move your index finger to steer the cursor</li>
              <li><b>Pinch</b> — thumb + index: click (quick double pinch double-clicks)</li>
              <li><b>Pinch and hold</b> — drags, release to drop (real mouse down/up)</li>
              <li><b>Two fingers</b> — move up or down to scroll</li>
              <li><b>Dwell</b> — hold still to click without pinching</li>
              <li><b>Fist 0.5 s</b> — emergency stop</li>
              <li><b>Open palm 0.7 s</b> — pause tracking (Resume with the button)</li>
            </ul>
          </div>

          <div className="panel air-card">
            <div className="agent-log-head"><Camera size={14} /> Camera</div>
            <select value={cameraId} onChange={(e) => setCameraId(e.target.value)} disabled={live || busy} aria-label="Camera device">
              <option value="">Default camera</option>
              {cameras.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label || `Camera ${c.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
            <label className="air-row">
              <span>Mirror preview</span>
              <input type="checkbox" checked={settings.mirror} onChange={(e) => setSetting('mirror', e.target.checked)} />
            </label>
            <button className="air-btn" onClick={() => void testModel()} disabled={testing || busy}>
              <Cpu size={14} /> {testing ? 'Testing model…' : 'Test model'}
            </button>
            <p className="air-note"><CameraOff size={12} /> Video stays on this machine. Only hand points are processed.</p>
          </div>

          <div className="panel air-card">
            <div className="agent-log-head"><Crosshair size={14} /> Feel</div>
            <label className="air-slider">
              <span>Sensitivity <b>{Math.round(settings.sensitivity * 100)}%</b></span>
              <input type="range" min={10} max={95} value={Math.round(settings.sensitivity * 100)} onChange={(e) => setSetting('sensitivity', Number(e.target.value) / 100)} />
            </label>
            <label className="air-slider">
              <span>Dwell time <b>{settings.dwellMs} ms</b></span>
              <input type="range" min={300} max={2000} step={50} value={settings.dwellMs} onChange={(e) => setSetting('dwellMs', Number(e.target.value))} />
            </label>
            <label className="air-slider">
              <span>Dwell radius <b>{settings.dwellRadius} px</b></span>
              <input type="range" min={6} max={40} step={1} value={settings.dwellRadius} onChange={(e) => setSetting('dwellRadius', Number(e.target.value))} />
            </label>
            <label className="air-slider">
              <span>Drag hold <b>{settings.dragMs} ms</b></span>
              <input type="range" min={250} max={1500} step={50} value={settings.dragMs} onChange={(e) => setSetting('dragMs', Number(e.target.value))} />
            </label>
            <label className="air-row">
              <span>Dwell to click</span>
              <input type="checkbox" checked={dwellEnabled} onChange={(e) => setDwellEnabled(e.target.checked)} />
            </label>
          </div>

          <p className="air-foot">
            Screen bounds: {bounds.w} × {bounds.h} at {bounds.x}, {bounds.y}. Hover a control and hold still until the ring closes.
          </p>
        </div>
      </div>
    </PageShell>
  )
}
