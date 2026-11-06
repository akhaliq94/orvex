import { useCallback, useEffect, useRef, useState } from 'react'
import AICore from './AICore'
import { setAppInert } from '../data/a11y'
import type { Voice } from '../hooks/useVoice'

/**
 * Hands-free focus mode. While a voice conversation is open the only thing on
 * screen is the enlarged ORVEX core; moving the mouse, pressing a key or a real
 * agent run brings the full app back, and it returns here after the idle beat.
 */

const IDLE_MS = 5200

export default function VoiceFocus({ voice }: { voice: Voice }) {
  const active = voice.status === 'listening'
  const [revealed, setRevealed] = useState(false)
  const workingRef = useRef(false)
  const hideTimer = useRef(0)
  const layerRef = useRef<HTMLDivElement>(null)

  const scheduleHide = useCallback((delay = IDLE_MS) => {
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      if (!workingRef.current) setRevealed(false)
    }, delay)
  }, [])

  const reveal = useCallback(() => {
    setRevealed(true)
    scheduleHide()
  }, [scheduleHide])

  useEffect(() => {
    if (!active) {
      setRevealed(false)
      window.clearTimeout(hideTimer.current)
      return
    }
    setRevealed(false)
    scheduleHide()
    const onMove = () => reveal()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        window.clearTimeout(hideTimer.current)
        setRevealed(true)
        return
      }
      reveal()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('pointerdown', onMove)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('pointerdown', onMove)
      window.removeEventListener('keydown', onKey)
      window.clearTimeout(hideTimer.current)
    }
  }, [active, reveal, scheduleHide])

  // A real goal running on the PC is work the user should watch, so the full UI
  // stays up for its duration instead of fading back to the core.
  useEffect(() => {
    if (!active) return
    const bridge = typeof window !== 'undefined' ? window.orvex : undefined
    if (!bridge) return
    const show = () => {
      workingRef.current = true
      setRevealed(true)
      window.clearTimeout(hideTimer.current)
    }
    void bridge.agent
      .status()
      .then((res) => {
        if (res.ok && res.data.running) show()
      })
      .catch(() => undefined)
    return bridge.agent.onEvent((ev) => {
      if (ev.type === 'run_start') show()
      else if (ev.type === 'run_end') {
        workingRef.current = false
        scheduleHide()
      }
    })
  }, [active, scheduleHide])

  // While the core is the only thing shown, the app underneath is inert so Tab
  // and screen readers cannot wander into hidden controls.
  useEffect(() => {
    setAppInert('voice-focus', active && !revealed)
    return () => setAppInert('voice-focus', false)
  }, [active, revealed])

  if (!active) return null

  const status = voice.error ? 'Voice needs attention'
    : voice.speaking ? 'ORVEX is speaking'
      : voice.replyPhase === 'preparing' ? 'Preparing voice…'
        : voice.replyPhase === 'thinking' ? 'Waiting for the model…'
          : voice.transcribing || voice.partial ? 'Transcribing…' : 'Listening'
  const detail = voice.error
    ? voice.error
    : voice.interim
      ? voice.interim
      : 'Move the mouse or press Esc to show the full app.'

  return (
    <div
      ref={layerRef}
      className={`voice-focus ${revealed ? 'revealed' : ''}`}
      data-inert-keep
      onPointerDown={reveal}
      aria-hidden={revealed || undefined}
    >
      <div className="voice-focus-core" aria-hidden>
        <AICore listening={!voice.speaking} levelRef={voice.levelRef} />
      </div>
      <div className="voice-focus-label" aria-live="polite">
        <strong>{status}</strong>
        <span className={voice.error ? 'voice-focus-detail bad' : 'voice-focus-detail'}>{detail}</span>
      </div>
      <button type="button" className="voice-focus-show" onClick={reveal}>
        Show ORVEX
      </button>
    </div>
  )
}
