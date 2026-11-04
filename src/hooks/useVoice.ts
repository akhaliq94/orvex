import { useCallback, useEffect, useRef, useState } from 'react'
import { readVoiceConfig, sttTarget, transcribeClip, type SttTarget } from '../data/stt'
import { stopSpeaking } from '../data/voice'
import { BargeInDetector } from '../voice/bargein'
import { listMicrophones, micConstraints, watchDevices, type MicDevice } from '../voice/devices'
import { identify, loadProfiles, vectorFromBlob } from '../voice/speaker'
import { StreamingSession } from '../voice/stream'
import { matchWake, WakeGate } from '../voice/wake'

export type VoiceStatus = 'idle' | 'starting' | 'listening' | 'denied' | 'unsupported'
export type VoiceWakeEvent = { phrase: string; command: string; at: number }
export type VoiceSpeakerHit = { name: string; score: number }

type LevelRef = { current: number }

interface SRResult {
  isFinal: boolean
  length: number
  0: { transcript: string }
}
interface SREvent {
  resultIndex: number
  results: { length: number; [i: number]: SRResult }
}
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: SREvent) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

function getSR(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>
  const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as (new () => SpeechRecognitionLike) | undefined
  return Ctor ?? null
}

function pickMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  return types.find((t) => MediaRecorder.isTypeSupported(t)) ?? null
}

export type Voice = {
  status: VoiceStatus
  /** smoothed microphone amplitude 0..1, updated every frame — read inside rAF loops */
  levelRef: LevelRef
  /** final transcript segments collected since listening started */
  transcript: string
  /** current interim (not yet final) text */
  interim: string
  /** true when the browser exposes speech-to-text or a transcription endpoint is set */
  speechSupported: boolean
  /** non-null when speech recognition exists but the platform refuses to run it */
  sttUnavailable: string | null
  error: string | null
  start: () => Promise<void>
  stop: () => void
  clearTranscript: () => void
  /** fires once the speaker goes quiet — hands-free send hook */
  setOnUtterance: (fn: ((text: string, meta?: { wake: boolean }) => void) | null) => void
  /** hold recognition while the assistant is talking, so it does not hear itself */
  pauseListening: () => void
  /** re-arm recognition after the assistant finishes */
  resumeListening: () => void
  /** microphones visible to the renderer */
  devices: MicDevice[]
  deviceError: string | null
  refreshDevices: () => Promise<void>
  /** reopen the stream (used after picking a different microphone) */
  restartMic: () => Promise<void>
  /** last wake-word hit */
  wake: VoiceWakeEvent | null
  /** unix ms of the last spoken interruption */
  bargeInAt: number | null
  /** true while ORVEX is speaking through the configured voice */
  speaking: boolean
  /** best matching enrolled speaker for the last finished turn */
  speaker: VoiceSpeakerHit | null
  /** true while a partial transcript upload is in flight */
  partial: boolean
  setWakeHandler: (fn: ((command: string) => void) | null) => void
  /** Chat/Engine call this around playback so barge-in can interrupt it */
  markSpeaking: (on: boolean) => void
}

export function useVoice(): Voice {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [transcript, setTranscript] = useState('')
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sttUnavailable, setSttUnavailable] = useState<string | null>(null)
  const [devices, setDevices] = useState<MicDevice[]>([])
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const [wake, setWake] = useState<VoiceWakeEvent | null>(null)
  const [bargeInAt, setBargeInAt] = useState<number | null>(null)
  const [speaking, setSpeaking] = useState(false)
  const [speaker, setSpeaker] = useState<VoiceSpeakerHit | null>(null)
  const [partial, setPartial] = useState(false)

  const levelRef = useRef(0)
  const ctxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef(0)
  const srRef = useRef<SpeechRecognitionLike | null>(null)
  const activeRef = useRef(false)
  /** true while the assistant is speaking — mic stays open but nothing is sent */
  const holdRef = useRef(false)
  const speakingRef = useRef(false)
  const transcriptRef = useRef('')
  const interimRef = useRef('')
  const silenceTimer = useRef(0)
  const onUtteranceRef = useRef<((text: string, meta?: { wake: boolean }) => void) | null>(null)
  const wakeHandlerRef = useRef<((command: string) => void) | null>(null)
  /** 'speech' = browser recognition, 'recorder' = record the turn and POST it */
  const modeRef = useRef<'speech' | 'recorder' | null>(null)
  const targetRef = useRef<SttTarget | null>(null)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recordingRef = useRef(false)
  const transcribingRef = useRef(false)
  const discardRef = useRef(false)
  const segmentStartRef = useRef(0)
  const lastVoiceRef = useRef(0)
  const failCountRef = useRef(0)
  const startSegRef = useRef<() => void>(() => {})
  const stopSegRef = useRef<(discard: boolean) => void>(() => {})
  const streamTickRef = useRef<() => void>(() => {})
  const cfgRef = useRef(readVoiceConfig())
  const streamingRef = useRef(false)
  const sessionRef = useRef<StreamingSession | null>(null)
  const segmentSeqRef = useRef(0)
  const wakeGateRef = useRef<WakeGate | null>(null)
  const bargeRef = useRef(new BargeInDetector({ threshold: 0.18, holdMs: 260 }))
  const restartMicRef = useRef<() => Promise<void>>(async () => {})

  /** How long the speaker must stay quiet before the turn is considered finished. */
  const SILENCE_MS = 1400

  const refreshDevices = useCallback(async () => {
    const res = await listMicrophones()
    setDevices(res.devices)
    setDeviceError(res.error)
  }, [])

  const armSilence = useCallback(() => {
    if (holdRef.current) return
    window.clearTimeout(silenceTimer.current)
    silenceTimer.current = window.setTimeout(() => {
      if (holdRef.current) return
      const text = `${transcriptRef.current} ${interimRef.current}`.replace(/\s+/g, ' ').trim()
      if (!text) return
      transcriptRef.current = ''
      interimRef.current = ''
      setTranscript('')
      setInterim('')
      const cfg = cfgRef.current
      if (cfg.wakeEnabled) {
        const m = matchWake(text, cfg.wakePhrase, cfg.wakeFuzzy)
        if (m.matched) {
          onUtteranceRef.current?.(m.command, { wake: true })
          return
        }
      }
      onUtteranceRef.current?.(text)
    }, SILENCE_MS)
  }, [])

  const feedWake = useCallback((text: string) => {
    const gate = wakeGateRef.current
    const cfg = cfgRef.current
    if (!gate || !text || !cfg.wakeEnabled) return
    const hit = gate.feed(text, performance.now())
    if (!hit.triggered) return
    setWake({ phrase: cfg.wakePhrase, command: hit.command, at: Date.now() })
    wakeHandlerRef.current?.(hit.command)
  }, [])

  const fingerprint = useCallback((blob: Blob) => {
    if (!cfgRef.current.speakerId) return
    void vectorFromBlob(blob).then((vec) => {
      if (!vec.length) {
        setSpeaker(null)
        return
      }
      const hit = identify(vec, loadProfiles(), 0.8)
      setSpeaker(hit ? { name: hit.profile.name, score: hit.score } : null)
    })
  }, [])

  /** Emits a finished turn, stripping the wake phrase when it matched. */
  const emitTurn = useCallback((text: string, blob: Blob) => {
    const cfg = cfgRef.current
    const hit = cfg.wakeEnabled ? matchWake(text, cfg.wakePhrase, cfg.wakeFuzzy) : { matched: false, command: '' }
    onUtteranceRef.current?.(hit.matched ? hit.command : text, hit.matched ? { wake: true } : undefined)
    fingerprint(blob)
  }, [fingerprint])

  const cleanupAudio = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (ctxRef.current) {
      void ctxRef.current.close().catch(() => undefined)
      ctxRef.current = null
    }
    levelRef.current = 0
  }, [])

  const stopSegment = useCallback((discard: boolean) => {
    const rec = recRef.current
    recordingRef.current = false
    if (!rec || rec.state === 'inactive') {
      recRef.current = null
      return
    }
    discardRef.current = discard || !activeRef.current || holdRef.current
    try {
      rec.stop()
    } catch {
      recRef.current = null
    }
  }, [])

  const startSegment = useCallback(() => {
    const stream = streamRef.current
    const target = targetRef.current
    if (!stream || !target || recordingRef.current || transcribingRef.current || holdRef.current) return
    const mime = pickMime()
    if (!mime) {
      setError('This build cannot record audio for transcription.')
      return
    }
    let rec: MediaRecorder
    try {
      rec = new MediaRecorder(stream, { mimeType: mime })
    } catch {
      setError('This build cannot record audio for transcription.')
      return
    }
    const session = new StreamingSession({ intervalMs: 900, minBytes: 6000 })
    sessionRef.current = session
    chunksRef.current = []
    rec.ondataavailable = (e) => {
      if (e.data.size) {
        chunksRef.current.push(e.data)
        session.noteChunk(e.data.size, performance.now())
      }
    }
    rec.onerror = () => {
      recordingRef.current = false
      recRef.current = null
      sessionRef.current = null
      setError('Recording failed — check that the microphone is still connected.')
    }
    rec.onstop = () => {
      recRef.current = null
      const chunks = chunksRef.current
      chunksRef.current = []
      const captured = sessionRef.current
      segmentSeqRef.current += 1
      setPartial(false)
      if (discardRef.current) {
        discardRef.current = false
        sessionRef.current = null
        return
      }
      const size = chunks.reduce((n, c) => n + c.size, 0)
      const cfgTarget = targetRef.current
      if (size < 1200 || !cfgTarget) {
        sessionRef.current = null
        return
      }
      const blob = new Blob(chunks, { type: chunks[0]?.type || mime })
      transcribingRef.current = true
      setInterim(captured?.transcript ? captured.transcript : 'Transcribing…')
      void transcribeClip(cfgTarget, blob).then((out) => {
        transcribingRef.current = false
        setInterim('')
        const partialText = captured?.transcript ?? ''
        sessionRef.current = null
        if (!out.ok) {
          // A merged partial is still a real transcript — keep it instead of
          // throwing the turn away just because the final upload failed.
          if (partialText) {
            failCountRef.current = 0
            setError(null)
            setTranscript(partialText)
            feedWake(partialText)
            emitTurn(partialText, blob)
            return
          }
          failCountRef.current += 1
          setError(out.detail)
          if (failCountRef.current >= 3) {
            activeRef.current = false
            cleanupAudio()
            setStatus('idle')
          }
          return
        }
        failCountRef.current = 0
        setError(null)
        const finalText = captured ? captured.finalize(out.text) : out.text
        if (!finalText) return
        setTranscript(finalText)
        feedWake(finalText)
        emitTurn(finalText, blob)
      })
    }
    try {
      rec.start(streamingRef.current ? 250 : undefined)
    } catch {
      recRef.current = null
      sessionRef.current = null
      setError('Could not start recording.')
      return
    }
    recRef.current = rec
    recordingRef.current = true
    segmentStartRef.current = performance.now()
    lastVoiceRef.current = segmentStartRef.current
  }, [cleanupAudio, emitTurn, feedWake])

  /** Uploads the turn so far while the user is still speaking. */
  const streamTick = useCallback(() => {
    const session = sessionRef.current
    const rec = recRef.current
    const target = targetRef.current
    if (!session || !rec || !target || rec.state !== 'recording') return
    const now = performance.now()
    if (!session.shouldRequest(now)) return
    session.beginRequest(now)
    const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
    if (blob.size < 1500) {
      session.fail()
      return
    }
    const seq = segmentSeqRef.current
    setPartial(true)
    void transcribeClip(target, blob, { timeoutMs: 20000 })
      .then((out) => {
        if (segmentSeqRef.current !== seq) return
        setPartial(false)
        if (!out.ok) {
          session.fail()
          return
        }
        const merged = session.applyPartial(out.text)
        if (merged && !holdRef.current) {
          interimRef.current = merged
          setInterim(merged)
        }
      })
      .catch(() => {
        if (segmentSeqRef.current === seq) {
          setPartial(false)
          session.fail()
        }
      })
  }, [feedWake])

  startSegRef.current = startSegment
  stopSegRef.current = stopSegment
  streamTickRef.current = streamTick

  const restartRecognition = useCallback(() => {
    let tries = 0
    const restart = () => {
      if (!activeRef.current || holdRef.current) return
      try {
        srRef.current?.start()
      } catch {
        if (++tries < 5) window.setTimeout(restart, 300)
      }
    }
    restart()
  }, [])

  const stop = useCallback(() => {
    activeRef.current = false
    holdRef.current = false
    modeRef.current = null
    targetRef.current = null
    window.clearTimeout(silenceTimer.current)
    transcriptRef.current = ''
    interimRef.current = ''
    stopSegRef.current(true)
    sessionRef.current = null
    segmentSeqRef.current += 1
    setPartial(false)
    try {
      srRef.current?.stop()
    } catch {
      /* already stopped */
    }
    srRef.current = null
    cleanupAudio()
    setStatus('idle')
    setInterim('')
  }, [cleanupAudio])

  const pauseListening = useCallback(() => {
    holdRef.current = true
    window.clearTimeout(silenceTimer.current)
    stopSegRef.current(true)
    try {
      srRef.current?.stop()
    } catch {
      /* not running */
    }
  }, [])

  const resumeListening = useCallback(() => {
    holdRef.current = false
    transcriptRef.current = ''
    interimRef.current = ''
    setTranscript('')
    setInterim('')
    if (!activeRef.current) return
    if (modeRef.current === 'recorder') {
      // Segments restart on the next detected voice, nothing to kick off here.
      segmentStartRef.current = 0
      lastVoiceRef.current = 0
      return
    }
    restartRecognition()
  }, [restartRecognition])

  const setOnUtterance = useCallback((fn: ((text: string) => void) | null) => {
    onUtteranceRef.current = fn
  }, [])

  const setWakeHandler = useCallback((fn: ((command: string) => void) | null) => {
    wakeHandlerRef.current = fn
  }, [])

  const markSpeaking = useCallback((on: boolean) => {
    speakingRef.current = on
    setSpeaking(on)
    if (!on) bargeRef.current.reset()
  }, [])

  const start = useCallback(async () => {
    if (activeRef.current) return
    activeRef.current = true
    setError(null)
    setSttUnavailable(null)
    setTranscript('')
    setInterim('')
    setSpeaker(null)
    setStatus('starting')

    const cfg = readVoiceConfig()
    cfgRef.current = cfg
    bargeRef.current = new BargeInDetector({ threshold: cfg.bargeInThreshold, holdMs: 260 })
    wakeGateRef.current = cfg.wakeEnabled ? new WakeGate({ phrase: cfg.wakePhrase, fuzzy: cfg.wakeFuzzy }) : null

    try {
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia(micConstraints(cfg.micDeviceId || null, cfg))
      } catch (e) {
        const name = e instanceof DOMException ? e.name : ''
        if (cfg.micDeviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
          stream = await navigator.mediaDevices.getUserMedia(micConstraints(null, cfg))
          setDeviceError('The selected microphone is unavailable — using the system default.')
        } else {
          throw e
        }
      }
      if (!activeRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      // Labels are only exposed after permission, so refresh now.
      void refreshDevices()

      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctx()
      ctxRef.current = ctx
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.75
      src.connect(analyser)
      const buf = new Uint8Array(analyser.frequencyBinCount)

      const loop = () => {
        if (!activeRef.current) return
        analyser.getByteTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / buf.length)
        // smooth + amplify so speech sits in the upper half of the range
        const target = Math.min(1, rms * 4.5)
        levelRef.current = levelRef.current * 0.65 + target * 0.35
        const now = performance.now()

        if (modeRef.current === 'recorder') {
          if (levelRef.current > 0.08) {
            lastVoiceRef.current = now
            if (!recordingRef.current && !transcribingRef.current && !holdRef.current) {
              startSegRef.current()
            }
          }
          if (
            recordingRef.current &&
            (now - lastVoiceRef.current > SILENCE_MS || now - segmentStartRef.current > 20000)
          ) {
            stopSegRef.current(false)
          }
          if (recordingRef.current && streamingRef.current) streamTickRef.current()
        }

        if (bargeRef.current.feed(levelRef.current, cfgRef.current.bargeIn && speakingRef.current, now)) {
          stopSpeaking()
          speakingRef.current = false
          setSpeaking(false)
          holdRef.current = false
          transcriptRef.current = ''
          interimRef.current = ''
          setTranscript('')
          setInterim('')
          setBargeInAt(Date.now())
          if (modeRef.current === 'speech') restartRecognition()
        }

        rafRef.current = requestAnimationFrame(loop)
      }
      rafRef.current = requestAnimationFrame(loop)

      // Speech input. Electron ships without Chromium's cloud speech service, so
      // when a transcription endpoint is configured we record each turn locally
      // and POST it there instead of failing on `network`.
      const target = sttTarget(cfg)
      const mime = pickMime()
      streamingRef.current = !!(cfg.streaming && target && mime)
      const desktop = typeof window !== 'undefined' && !!(window as unknown as { orvex?: unknown }).orvex
      if (!target && desktop) {
        // Chromium's cloud speech service is not part of the desktop runtime;
        // saying "armed" without a real transcription source would be a lie.
        setSttUnavailable('The desktop build has no cloud speech service — add a transcription endpoint in Settings → Voice to use the wake word.')
      }
      if (target && mime) {
        modeRef.current = 'recorder'
        targetRef.current = target
        failCountRef.current = 0
        setStatus('listening')
      } else {
        const Ctor = getSR()
        if (Ctor) {
          modeRef.current = 'speech'
          const sr = new Ctor()
          sr.lang = 'en-US'
          sr.continuous = true
          sr.interimResults = true
          sr.onresult = (e) => {
            let interimText = ''
            let finalText = ''
            for (let i = e.resultIndex; i < e.results.length; i++) {
              const r = e.results[i]
              if (r.isFinal) finalText += r[0].transcript
              else interimText += r[0].transcript
            }
            if (finalText) {
              const joined = (transcriptRef.current ? `${transcriptRef.current} ` : '') + finalText.trim()
              transcriptRef.current = joined
              setTranscript(joined)
            }
            interimRef.current = interimText
            setInterim(interimText)
            // Every fresh chunk re-arms the timer, so a turn ends after a real pause
            // rather than mid-sentence.
            // Wake matching waits for a final chunk so the command that follows
            // the phrase is complete rather than a half-recognised word.
            if (finalText) feedWake(transcriptRef.current)
            if (finalText || interimText) armSilence()
          }
          sr.onerror = (e) => {
            if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
              setError('Speech recognition blocked — check mic permission in browser/OS settings.')
              holdRef.current = true
            } else if (e.error === 'network') {
              // Electron (and offline Chromium builds) ship without a speech service.
              const msg = 'Speech-to-text is unavailable in the desktop build — add a transcription endpoint in Settings → Voice, or type the goal instead.'
              setError(msg)
              setSttUnavailable(msg)
              holdRef.current = true
            } else if (e.error === 'audio-capture') {
              setError('No microphone input — check that a mic is connected and not in use.')
              holdRef.current = true
            }
          }
          sr.onend = () => {
            // keep the session alive while the mic is active (but stay quiet while
            // the assistant is speaking, otherwise it transcribes its own voice)
            if (activeRef.current && !holdRef.current) {
              try {
                sr.start()
              } catch {
                /* restarted too quickly */
              }
            }
          }
          try {
            sr.start()
            srRef.current = sr
          } catch {
            srRef.current = null
          }
        }
        setStatus('listening')
        if (cfg.wakeEnabled && !Ctor) {
          setError('Wake word needs speech-to-text — add a transcription endpoint in Settings → Voice.')
        }
      }
    } catch (e) {
      activeRef.current = false
      cleanupAudio()
      const name = e instanceof DOMException ? e.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setStatus('denied')
        setError('Microphone blocked — allow mic access in the browser to talk to ORVEX.')
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setStatus('unsupported')
        setError('No microphone found on this device.')
      } else {
        setStatus('unsupported')
        setError('Could not start the microphone.')
      }
    }
  }, [armSilence, cleanupAudio, feedWake, fingerprint, refreshDevices, restartRecognition])

  restartMicRef.current = async () => {
    if (!activeRef.current) return
    stop()
    await start()
  }
  const restartMic = useCallback(async () => {
    await restartMicRef.current()
  }, [])

  // Microphone hot-plug: refresh the list and reopen on the fallback device when
  // the explicitly selected one disappears.
  useEffect(() => {
    void refreshDevices()
    return watchDevices(() => {
      void listMicrophones().then((r) => {
        setDevices(r.devices)
        if (!activeRef.current) {
          setDeviceError(r.error)
          return
        }
        const chosen = cfgRef.current.micDeviceId
        if (chosen && !r.devices.some((d) => d.id === chosen)) {
          setDeviceError(`Selected microphone disconnected — switching to ${r.devices[0]?.label ?? 'the system default'}.`)
          void restartMicRef.current()
        } else {
          setDeviceError(r.error)
        }
      })
    })
  }, [refreshDevices])

  // Settings changes reach a running session through this event.
  useEffect(() => {
    const onCfg = (e: Event) => {
      const next = (e as CustomEvent).detail
      if (!next) return
      const prev = cfgRef.current
      cfgRef.current = next
      if (next.wakeEnabled) {
        if (!wakeGateRef.current || prev.wakePhrase !== next.wakePhrase || prev.wakeFuzzy !== next.wakeFuzzy) {
          wakeGateRef.current = new WakeGate({ phrase: next.wakePhrase, fuzzy: next.wakeFuzzy })
        }
      } else {
        wakeGateRef.current = null
      }
      if (prev.bargeInThreshold !== next.bargeInThreshold) {
        bargeRef.current = new BargeInDetector({ threshold: next.bargeInThreshold, holdMs: 260 })
      }
      if (
        activeRef.current &&
        (prev.micDeviceId !== next.micDeviceId ||
          prev.echoCancellation !== next.echoCancellation ||
          prev.noiseSuppression !== next.noiseSuppression ||
          prev.autoGainControl !== next.autoGainControl)
      ) {
        void restartMicRef.current()
      }
    }
    window.addEventListener('orvex-voice-config', onCfg)
    return () => window.removeEventListener('orvex-voice-config', onCfg)
  }, [])

  useEffect(() => {
    return () => {
      activeRef.current = false
      try {
        srRef.current?.abort()
      } catch {
        /* noop */
      }
      cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      if (ctxRef.current) void ctxRef.current.close().catch(() => undefined)
    }
  }, [])

  const clearTranscript = useCallback(() => {
    transcriptRef.current = ''
    interimRef.current = ''
    setTranscript('')
    setInterim('')
  }, [])

  return {
    status,
    levelRef,
    transcript,
    interim,
    speechSupported: getSR() !== null || sttTarget(readVoiceConfig()) !== null,
    sttUnavailable,
    error,
    start,
    stop,
    clearTranscript,
    setOnUtterance,
    pauseListening,
    resumeListening,
    devices,
    deviceError,
    refreshDevices,
    restartMic,
    wake,
    bargeInAt,
    speaking,
    speaker,
    partial,
    setWakeHandler,
    markSpeaking,
  }
}
