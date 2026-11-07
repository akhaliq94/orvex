import { useCallback, useEffect, useRef, useState } from 'react'
import {
  floatToPcm16,
  hasSpeech,
  isElevenLabsHost,
  isLocalWhisper,
  onRealtimeEvent,
  pcmChunksToWav,
  readVoiceConfig,
  realtimeSupported,
  reportSttEndpoint,
  sendRealtimeAudio,
  startRealtimeStt,
  stopRealtimeStt,
  sttTarget,
  transcribeClip,
  type RealtimeSession,
  type SttTarget,
} from '../data/stt'
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

/**
 * Web Speech wants a full locale. The hosted engines take the bare ISO code
 * from the same setting, so both paths stay in step with the user's choice.
 */
function speechLocale(language: string): string {
  const code = String(language || '').trim().toLowerCase()
  if (code === 'ur' || code === 'urd') return 'ur-PK'
  if (code === 'hi' || code === 'hin') return 'hi-IN'
  if (code === 'en' || code === 'eng') return 'en-US'
  return 'en-US'
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
  transcribing: boolean
  replyPhase: 'thinking' | 'preparing' | null
  setReplyPhase: (phase: 'thinking' | 'preparing' | null) => void
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
  const [transcribing, setTranscribing] = useState(false)
  const [replyPhase, setReplyPhase] = useState<'thinking' | 'preparing' | null>(null)

  const levelRef = useRef(0)
  const ctxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef(0)
  const srRef = useRef<SpeechRecognitionLike | null>(null)
  const activeRef = useRef(false)
  const micSequenceRef = useRef(0)
  /** true while the assistant is speaking — mic stays open but nothing is sent */
  const holdRef = useRef(false)
  const speakingRef = useRef(false)
  const transcriptRef = useRef('')
  const interimRef = useRef('')
  const silenceTimer = useRef(0)
  const onUtteranceRef = useRef<((text: string, meta?: { wake: boolean }) => void) | null>(null)
  const wakeHandlerRef = useRef<((command: string) => void) | null>(null)
  /** 'speech' = browser recognition, 'recorder' = record the turn and POST it, 'realtime' = stream the mic */
  const modeRef = useRef<'speech' | 'recorder' | 'realtime' | null>(null)
  const realtimeRef = useRef<RealtimeSession | null>(null)
  const offRealtimeRef = useRef<(() => void) | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const muteRef = useRef<GainNode | null>(null)
  /** PCM of the turn being spoken, kept so speaker identification still works. */
  const turnChunksRef = useRef<Uint8Array[]>([])
  const turnBytesRef = useRef(0)
  const lastChunkVoiceRef = useRef(0)
  /** Last few quiet frames, sent when speech starts so the onset is not cut. */
  const prerollRef = useRef<Uint8Array[]>([])
  /** Consecutive live-socket drops; a session that produces a transcript resets it. */
  const reconnectRef = useRef(0)
  const lastRealtimeErrorRef = useRef('')
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

  /**
   * How long the speaker must stay quiet before the turn is considered
   * finished. Urdu and Hindi speakers pause mid-sentence to breathe or find a
   * word; a short gap treated the pause as the end and ORVEX answered half a
   * question. ~2 s of quiet is a real end of turn.
   */
  const SILENCE_MS = 2000
  /**
   * The live socket runs its own voice-activity detector. Six hundred
   * milliseconds committed while the speaker was still thinking; the service
   * accepts up to 5 s, so this holds the turn open through a normal pause.
   */
  const REALTIME_SILENCE_SECS = 1.6
  const REALTIME_RATE = 16000
  /** Keep streaming this long after the voice stops so the service can commit. */
  const REALTIME_TAIL_MS = 2200
  /** Below this a chunk is room noise, not speech. */
  const REALTIME_VOICE_RMS = 0.012
  /** Chunks of quiet kept so the first syllable of a turn is not clipped. */
  const REALTIME_PREROLL_CHUNKS = 4
  /** 45 s of 16 kHz PCM is the most a single turn keeps for fingerprinting. */
  const REALTIME_MAX_TURN_BYTES = REALTIME_RATE * 2 * 45
  /** Longest a hands-free turn is allowed to run before it is cut. */
  const MAX_TURN_MS = 45000

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
    const processor = processorRef.current
    processorRef.current = null
    if (processor) {
      processor.onaudioprocess = null
      try {
        processor.disconnect()
      } catch {
        /* already detached */
      }
    }
    const mute = muteRef.current
    muteRef.current = null
    if (mute) {
      try {
        mute.disconnect()
      } catch {
        /* already detached */
      }
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (ctxRef.current) {
      void ctxRef.current.close().catch(() => undefined)
      ctxRef.current = null
    }
    levelRef.current = 0
  }, [])

  /**
   * Streams the microphone to the live transcription session.
   *
   * Only voiced audio is sent, plus a short tail so the service can hear the
   * pause and commit the turn: streaming an idle room all day would bill for
   * silence. Partials update the transcript while the speaker is still talking,
   * and a commit ends the turn immediately — no local silence timer.
   */
  const attachRealtime = useCallback(
    (session: RealtimeSession, ctx: AudioContext, source: MediaStreamAudioSourceNode) => {
      const previous = offRealtimeRef.current
      offRealtimeRef.current = null
      try {
        previous?.()
      } catch {
        /* listener already detached */
      }
      turnChunksRef.current = []
      turnBytesRef.current = 0
      lastChunkVoiceRef.current = 0
      prerollRef.current = []

      /**
       * The service drops a socket after ~15 s without audio and the network can
       * drop it at any time. Reopening in place keeps the microphone armed, like
       * the hosted assistants do, instead of ending the conversation.
       */
      const reopen = async (attempt: number): Promise<void> => {
        await new Promise((resolve) => window.setTimeout(resolve, Math.min(2500, 250 * 2 ** (attempt - 1))))
        if (!activeRef.current || realtimeRef.current) return
        const opened = await startRealtimeStt({ silenceSecs: REALTIME_SILENCE_SECS, language: cfgRef.current.sttLanguage })
        if (!activeRef.current) {
          if (opened.ok) void stopRealtimeStt(opened.session.id)
          return
        }
        if (opened.ok) {
          realtimeRef.current = opened.session
          turnChunksRef.current = []
          turnBytesRef.current = 0
          lastChunkVoiceRef.current = 0
          prerollRef.current = []
          setSttUnavailable(null)
          attachRealtime(opened.session, ctx, source)
          return
        }
        lastRealtimeErrorRef.current = opened.detail
        if (attempt >= 3) {
          setError(`Live speech input stopped — ${opened.detail} Tap the mic to try again.`)
          activeRef.current = false
          try {
            offRealtimeRef.current?.()
          } catch {
            /* already detached */
          }
          offRealtimeRef.current = null
          cleanupAudio()
          setStatus('idle')
          setInterim('')
          return
        }
        await reopen(attempt + 1)
      }

      let dropped = false
      const lost = (detail: string) => {
        if (dropped || !activeRef.current) return
        dropped = true
        // A newer session may already have taken over; leave it alone.
        if (realtimeRef.current !== session) return
        realtimeRef.current = null
        turnChunksRef.current = []
        turnBytesRef.current = 0
        if (detail) lastRealtimeErrorRef.current = detail
        reconnectRef.current += 1
        void reopen(reconnectRef.current)
      }

      offRealtimeRef.current = onRealtimeEvent((event) => {
        const live = realtimeRef.current
        if (!live || event.id !== live.id || !activeRef.current) return
        if (event.type === 'partial') {
          if (holdRef.current) return
          reconnectRef.current = 0
          const text = (event.text || '').trim()
          interimRef.current = text
          setInterim(text)
          return
        }
        if (event.type === 'committed') {
          const text = (event.text || '').trim()
          const chunks = turnChunksRef.current
          turnChunksRef.current = []
          turnBytesRef.current = 0
          if (holdRef.current || !hasSpeech(text)) {
            interimRef.current = ''
            setInterim('')
            return
          }
          reconnectRef.current = 0
          failCountRef.current = 0
          setError(null)
          interimRef.current = ''
          setInterim('')
          transcriptRef.current = text
          setTranscript(text)
          feedWake(text)
          emitTurn(text, chunks.length ? pcmChunksToWav(chunks, session.sampleRate || REALTIME_RATE) : new Blob([], { type: 'audio/wav' }))
          return
        }
        if (event.type === 'error') {
          // The credential may have died; the main process parks it and the
          // reopen below walks on to the next saved key.
          lost(event.message || event.error || '')
          return
        }
        if (event.type === 'closed') lost(event.message || '')
      })

      // ScriptProcessor is the one capture path that needs no extra module URL
      // inside the packaged app; its output is muted so the mic is never echoed.
      const processor = ctx.createScriptProcessor(2048, 1, 1)
      const mute = ctx.createGain()
      mute.gain.value = 0
      processorRef.current = processor
      muteRef.current = mute
      source.connect(processor)
      processor.connect(mute)
      mute.connect(ctx.destination)
      processor.onaudioprocess = (e) => {
        const live = realtimeRef.current
        if (!live || !activeRef.current || holdRef.current) return
        const input = e.inputBuffer.getChannelData(0)
        let sum = 0
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
        const rms = Math.sqrt(sum / input.length)
        const now = performance.now()
        const voiced = rms > REALTIME_VOICE_RMS
        if (voiced) lastChunkVoiceRef.current = now
        const pcm = floatToPcm16(input)
        // Idle room: send nothing, so an open mic does not spend the quota, but
        // keep the last few frames. Speech usually starts below the gate and
        // the first word lost its opening consonant when only voiced frames
        // were streamed.
        if (!voiced && now - lastChunkVoiceRef.current > REALTIME_TAIL_MS) {
          prerollRef.current.push(pcm)
          if (prerollRef.current.length > REALTIME_PREROLL_CHUNKS) prerollRef.current.shift()
          return
        }
        const send = (chunk: Uint8Array) => {
          if (turnBytesRef.current + chunk.length <= REALTIME_MAX_TURN_BYTES) {
            turnChunksRef.current.push(chunk)
            turnBytesRef.current += chunk.length
          }
          void sendRealtimeAudio(live.id, chunk)
        }
        if (voiced && prerollRef.current.length) {
          const pre = prerollRef.current
          prerollRef.current = []
          for (const chunk of pre) send(chunk)
        }
        send(pcm)
      }
    },
    [cleanupAudio, emitTurn, feedWake],
  )

  const teardownRealtime = useCallback(() => {
    const off = offRealtimeRef.current
    offRealtimeRef.current = null
    try {
      off?.()
    } catch {
      /* listener already detached */
    }
    const live = realtimeRef.current
    realtimeRef.current = null
    turnChunksRef.current = []
    turnBytesRef.current = 0
    prerollRef.current = []
    reconnectRef.current = 0
    lastRealtimeErrorRef.current = ''
    if (live) void stopRealtimeStt(live.id)
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
    const sequence = ++segmentSeqRef.current
    const chunks: Blob[] = []
    sessionRef.current = session
    chunksRef.current = chunks
    rec.ondataavailable = (e) => {
      if (segmentSeqRef.current !== sequence) return
      if (e.data.size) {
        chunks.push(e.data)
        session.noteChunk(e.data.size, performance.now())
      }
    }
    rec.onerror = () => {
      if (segmentSeqRef.current !== sequence) return
      recordingRef.current = false
      recRef.current = null
      sessionRef.current = null
      setError('Recording failed — check that the microphone is still connected.')
    }
    rec.onstop = () => {
      if (segmentSeqRef.current !== sequence) return
      recRef.current = null
      chunksRef.current = []
      const captured = session
      const finalSequence = ++segmentSeqRef.current
      setPartial(false)
      if (discardRef.current || !activeRef.current || holdRef.current) {
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
      setTranscribing(true)
      setInterim(captured.transcript || 'Transcribing…')
      void transcribeClip(cfgTarget, blob, { language: cfgRef.current.sttLanguage }).then((out) => {
        if (segmentSeqRef.current !== finalSequence || !activeRef.current) return
        transcribingRef.current = false
        setTranscribing(false)
        setInterim('')
        if (holdRef.current) return
        const partialText = captured?.transcript ?? ''
        sessionRef.current = null
        if (!out.ok) {
          // A merged partial is still a real transcript — keep it instead of
          // throwing the turn away just because the final upload failed.
          if (hasSpeech(partialText)) {
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
        // A quiet clip is not a turn. Silence markers survive the partial merge
        // as text, and sending one makes ORVEX answer a question nobody asked.
        if (!hasSpeech(finalText)) return
        setTranscript(finalText)
        feedWake(finalText)
        emitTurn(finalText, blob)
      })
    }
    discardRef.current = false
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
    void transcribeClip(target, blob, { timeoutMs: 20000, language: cfgRef.current.sttLanguage })
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
    micSequenceRef.current += 1
    activeRef.current = false
    holdRef.current = false
    modeRef.current = null
    targetRef.current = null
    teardownRealtime()
    window.clearTimeout(silenceTimer.current)
    transcriptRef.current = ''
    interimRef.current = ''
    stopSegRef.current(true)
    sessionRef.current = null
    recRef.current = null
    chunksRef.current = []
    transcribingRef.current = false
    segmentSeqRef.current += 1
    setPartial(false)
    setTranscribing(false)
    setReplyPhase(null)
    speakingRef.current = false
    setSpeaking(false)
    stopSpeaking()
    try {
      srRef.current?.stop()
    } catch {
      /* already stopped */
    }
    srRef.current = null
    cleanupAudio()
    setStatus('idle')
    setInterim('')
  }, [cleanupAudio, teardownRealtime])

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
    if (modeRef.current === 'realtime') {
      // The session stayed open while ORVEX talked; drop what it heard of its own
      // voice and start counting the next turn from silence.
      turnChunksRef.current = []
      turnBytesRef.current = 0
      lastChunkVoiceRef.current = 0
      return
    }
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
    const sequence = ++micSequenceRef.current
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
        if (micSequenceRef.current !== sequence || !activeRef.current) return
        const name = e instanceof DOMException ? e.name : ''
        if (cfg.micDeviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
          stream = await navigator.mediaDevices.getUserMedia(micConstraints(null, cfg))
          if (micSequenceRef.current === sequence && activeRef.current) {
            setDeviceError('The selected microphone is unavailable — using the system default.')
          }
        } else {
          throw e
        }
      }
      if (micSequenceRef.current !== sequence || !activeRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      // Labels are only exposed after permission, so refresh now.
      void refreshDevices()

      const speechTarget = sttTarget(cfg)
      const desktopReady = typeof window !== 'undefined' && !!(window as unknown as { orvex?: unknown }).orvex
      const wantRealtime = !!(
        speechTarget &&
        desktopReady &&
        cfg.realtimeStt &&
        isElevenLabsHost(speechTarget.url) &&
        realtimeSupported()
      )
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      // Live input is specified as 16 kHz PCM, so capture at that rate instead of
      // resampling every chunk on its way out.
      const ctx = wantRealtime ? new Ctx({ sampleRate: REALTIME_RATE }) : new Ctx()
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
            (now - lastVoiceRef.current > SILENCE_MS || now - segmentStartRef.current > MAX_TURN_MS)
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
          turnChunksRef.current = []
          turnBytesRef.current = 0
          lastChunkVoiceRef.current = 0
          prerollRef.current = []
          if (modeRef.current === 'speech') restartRecognition()
        }

        rafRef.current = requestAnimationFrame(loop)
      }
      rafRef.current = requestAnimationFrame(loop)

      // Speech input. Electron ships without Chromium's cloud speech service, so
      // when a transcription endpoint is configured we record each turn locally
      // and POST it there instead of failing on `network`.
      const target = speechTarget
      const mime = pickMime()
      // CPU Whisper serializes inference; partial uploads delay the final turn.
      streamingRef.current = !!(cfg.streaming && target && mime && !isLocalWhisper(target))
      const desktop = desktopReady
      if (!target && desktop) {
        // Chromium's cloud speech service is not part of the desktop runtime;
        // saying "armed" without a real transcription source would be a lie.
        setSttUnavailable('The desktop build has no cloud speech service — add a transcription endpoint in Settings → Voice to use the wake word.')
      }
      if (wantRealtime && target) {
        const opened = await startRealtimeStt({ silenceSecs: REALTIME_SILENCE_SECS, language: cfgRef.current.sttLanguage })
        if (micSequenceRef.current !== sequence || !activeRef.current) {
          if (opened.ok) void stopRealtimeStt(opened.session.id)
          return
        }
        if (opened.ok) {
          realtimeRef.current = opened.session
          modeRef.current = 'realtime'
          targetRef.current = target
          failCountRef.current = 0
          setSttUnavailable(null)
          attachRealtime(opened.session, ctx, src)
          setStatus('listening')
          return
        }
        // Recorded turns still work with the same key, so a refused socket is a
        // downgrade rather than a dead microphone.
        setSttUnavailable(`Live speech input could not start — ${opened.detail} Recording each turn instead.`)
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
          sr.lang = speechLocale(cfg.sttLanguage)
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
      if (micSequenceRef.current !== sequence) return
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
  }, [armSilence, attachRealtime, cleanupAudio, feedWake, fingerprint, refreshDevices, restartRecognition])

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

  // Settings changes reach a running session through this event. The main
  // process learns the transcription endpoint here too, so its own Whisper
  // server stops the moment speech input moves to a hosted one.
  useEffect(() => {
    reportSttEndpoint(cfgRef.current)
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
      reportSttEndpoint(cfgRef.current)
    }
    window.addEventListener('orvex-voice-config', onCfg)
    return () => window.removeEventListener('orvex-voice-config', onCfg)
  }, [])

  useEffect(() => {
    return () => {
      micSequenceRef.current += 1
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
    transcribing,
    replyPhase,
    setReplyPhase,
    setWakeHandler,
    markSpeaking,
  }
}
