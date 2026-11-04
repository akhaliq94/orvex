import { useEffect, useRef, useState } from 'react'
import { Lock, Monitor, Volume2, VolumeX } from 'lucide-react'
import type { OrvexDashboardSnapshot } from '../types/desktop'

const bridge = typeof window !== 'undefined' ? window.orvex : undefined

function fmtUptime(sec: number) {
  const total = Math.max(0, Math.round(sec))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

type Props = { snapshot: OrvexDashboardSnapshot | null; notify: (m: string) => void }

export default function BottomStrip({ snapshot, notify }: Props) {
  const [volume, setVolume] = useState(50)
  const [muted, setMuted] = useState(false)
  const [brightness, setBrightness] = useState<number | null>(null)
  const dragging = useRef<'volume' | 'brightness' | null>(null)
  const timers = useRef<Record<string, number>>({})
  const lastVolume = useRef(50)

  useEffect(() => {
    if (!snapshot) return
    if (!dragging.current && snapshot.system.volume != null) setVolume(snapshot.system.volume)
    if (!dragging.current) setMuted(!!snapshot.system.muted)
    if (!dragging.current) setBrightness(snapshot.system.brightness)
  }, [snapshot])

  useEffect(() => {
    const current = timers.current
    return () => Object.values(current).forEach((t) => window.clearTimeout(t))
  }, [])

  const applyVolume = (level: number, mute?: boolean) => {
    if (level > 0 && mute !== true) lastVolume.current = level
    setVolume(level)
    if (mute != null) setMuted(mute)
    window.clearTimeout(timers.current.volume)
    timers.current.volume = window.setTimeout(() => {
      void bridge?.desktop
        .volume({ level, ...(mute != null ? { mute } : {}) })
        .then((r) => {
          if (!r.ok) notify(r.error)
        })
    }, 140)
  }

  const applyBrightness = (level: number) => {
    setBrightness(level)
    window.clearTimeout(timers.current.brightness)
    timers.current.brightness = window.setTimeout(() => {
      void bridge?.desktop.brightness({ level }).then((r) => {
        if (!r.ok) notify(r.error)
        else if (r.data.supported === false) {
          setBrightness(null)
          notify(r.data.output)
        }
      })
    }, 140)
  }

  const lock = async () => {
    if (!bridge?.desktop.power) {
      notify('Lock is unavailable in this window — run ORVEX in the desktop app.')
      return
    }
    try {
      const result = await bridge.desktop.power('lock')
      if (!result.ok) notify(result.error)
      else notify('Workstation locked.')
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not lock the workstation.')
    }
  }

  const system = snapshot?.system
  const volumeSupported = system?.volume != null
  const brightnessSupported = brightness != null

  return (
    <div className="strip-area">
      <div className="strip">
        <section className="focus-card panel panel-hairline">
          <div className="focus-main">
            <div className="focus-top">
              <div>
                <div className="focus-title">Machine</div>
                <div className="focus-sub">
                  {system ? `${system.hostname} · up ${fmtUptime(system.uptimeSec)}` : 'Reading system state…'}
                </div>
              </div>
              <div className="focus-ctrl">
                <button
                  onClick={() => (muted ? applyVolume(lastVolume.current || 50, false) : applyVolume(volume, true))}
                  aria-label={muted ? 'Unmute' : 'Mute'}
                  title={muted ? 'Unmute' : 'Mute'}
                  disabled={!volumeSupported}
                >
                  {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                </button>
                <button onClick={() => void lock()} aria-label="Lock workstation" title="Lock the workstation">
                  <Lock size={13} />
                </button>
              </div>
            </div>

            <div className="focus-track">
              <Volume2 size={11} style={{ color: 'var(--faint)' }} />
              <input
                type="range"
                min={0}
                max={100}
                value={volume}
                disabled={!volumeSupported}
                aria-label="System volume"
                className="deck-slider"
                onPointerDown={() => (dragging.current = 'volume')}
                onPointerUp={() => (dragging.current = null)}
                onChange={(e) => applyVolume(Number(e.target.value))}
                style={{ flex: 1 }}
              />
              <span className="dim" style={{ width: 34, textAlign: 'right' }}>
                {volumeSupported ? `${volume}%` : 'n/a'}
              </span>
              <Monitor size={11} style={{ color: 'var(--faint)' }} />
              <input
                type="range"
                min={0}
                max={100}
                value={brightness ?? 0}
                disabled={!brightnessSupported}
                aria-label="Display brightness"
                className="deck-slider"
                onPointerDown={() => (dragging.current = 'brightness')}
                onPointerUp={() => (dragging.current = null)}
                onChange={(e) => applyBrightness(Number(e.target.value))}
                style={{ flex: 1 }}
              />
              <span className="dim" style={{ width: 34, textAlign: 'right' }}>
                {brightnessSupported ? `${brightness}%` : 'n/a'}
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
