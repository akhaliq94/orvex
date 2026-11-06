import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { writeJson } from './storage'
import { forSpeech } from './speech-text'
import { remainingSpeech, speakableSentences } from './speech-stream'

export { forSpeech }

export type VoiceEngineId =
  | 'browser'
  | 'heygen'
  | 'omnivoice'
  | 'xtts'
  | 'fish'
  | 'chatterbox'
  | 'cosyvoice'
  | 'qwen3tts'
  | 'voxcpm'
  | 'kokoro'

export type VoiceEngine = {
  id: VoiceEngineId
  name: string
  repo: string
  note: string
  /** does it support cloning from a reference clip */
  cloning: boolean
  /** does it stream audio */
  streaming: boolean
}

export const VOICE_ENGINES: VoiceEngine[] = [
  {
    id: 'browser',
    name: 'Browser speech synthesis',
    repo: 'built-in',
    note: 'Works with no setup. Quality depends on the voices your OS ships.',
    cloning: false,
    streaming: false,
  },
  {
    id: 'heygen',
    name: 'HeyGen Voice Turbo',
    repo: 'heygen.com',
    note: 'Cloud voices. Add your HeyGen API key in Settings → Voice, then fetch the voice list. Clips land in the Media library.',
    cloning: false,
    streaming: true,
  },
  {
    id: 'omnivoice',
    name: 'OmniVoice',
    repo: 'k2-fsa/OmniVoice',
    note: 'VoiceStudio default engine. 600+ languages, zero-shot cloning. No HTTP TTS API — needs the VoiceStudio backend in front of it.',
    cloning: true,
    streaming: true,
  },
  {
    id: 'xtts',
    name: 'XTTS v2',
    repo: 'coqui-ai/TTS',
    note: 'Clone from a 6-second clip, 17 languages, mature ecosystem.',
    cloning: true,
    streaming: true,
  },
  {
    id: 'fish',
    name: 'Fish Speech S2',
    repo: 'fishaudio/fish-speech',
    note: 'Zero-shot cloning, 80+ languages, rich prosody via natural-language tags.',
    cloning: true,
    streaming: true,
  },
  {
    id: 'chatterbox',
    name: 'Chatterbox Turbo',
    repo: 'resemble-ai/chatterbox',
    note: 'Low-latency variant with paralinguistic tags like [laugh] and [chuckle].',
    cloning: true,
    streaming: true,
  },
  {
    id: 'cosyvoice',
    name: 'CosyVoice 3',
    repo: 'FunAudioLLM/CosyVoice',
    note: 'Zero-shot multilingual cloning with pronunciation control.',
    cloning: true,
    streaming: true,
  },
  {
    id: 'qwen3tts',
    name: 'Qwen3-TTS',
    repo: 'QwenLM/Qwen3-TTS',
    note: 'Apache 2.0. Voice design from a text description, fast cloning, 10 languages.',
    cloning: true,
    streaming: true,
  },
  {
    id: 'voxcpm',
    name: 'VoxCPM 2',
    repo: 'OpenBMB/VoxCPM',
    note: '48 kHz output, 30 languages, controllable cloning.',
    cloning: true,
    streaming: true,
  },
  {
    id: 'kokoro',
    name: 'Kokoro',
    repo: 'hexgrad/kokoro',
    note: '82M params, Apache 2.0, CPU-friendly. Built-in voices, no cloning.',
    cloning: false,
    streaming: false,
  },
]

export type VoicePreset = {
  id: string
  name: string
  tags: string[]
  /** browser speechSynthesis voice name hint */
  hint: string
}

export const VOICE_PRESETS: VoicePreset[] = [
  { id: 'atlas', name: 'Atlas', tags: ['deep', 'steady', 'narration'], hint: 'Google UK English Male' },
  { id: 'nova', name: 'Nova', tags: ['bright', 'fast', 'assistant'], hint: 'Microsoft Aria' },
  { id: 'echo', name: 'Echo', tags: ['calm', 'soft', 'late night'], hint: 'Microsoft Jenny' },
  { id: 'cipher', name: 'Cipher', tags: ['crisp', 'technical', 'code'], hint: 'Google US English' },
  { id: 'sable', name: 'Sable', tags: ['warm', 'human', 'conversational'], hint: 'Microsoft Guy' },
  { id: 'wraith', name: 'Wraith', tags: ['low', 'intense', 'cyber'], hint: 'Daniel' },
]

export type VoiceConfig = {
  engine: VoiceEngineId
  serverUrl: string
  synthPath: string
  model: string
  preset: string
  speed: number
  format: string
  autoSpeak: boolean
  cloneRef: string
  cloneName: string
  /** natural-language voice design — OmniVoice/XTTS/Fish Speech all accept this */
  instruct: string
  /** HeyGen cloud engine settings */
  heygenModel: string
  heygenVoiceId: string
  heygenLanguage: string
  /** OpenAI-compatible ASR endpoint path (VoiceStudio: POST /v1/audio/transcriptions) */
  asrPath: string
  /** full URL of an OpenAI-compatible transcription endpoint (overrides serverUrl + asrPath) */
  asrUrl: string
  /** model name sent to the transcription endpoint */
  asrModel: string
  /** microphone device id ('' = system default) */
  micDeviceId: string
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  /** hands-free wake phrase over the live transcript */
  wakeEnabled: boolean
  wakePhrase: string
  wakeFuzzy: boolean
  /** stop speaking when the user starts talking */
  bargeIn: boolean
  bargeInThreshold: number
  /** upload ~1s partials while a turn is still being spoken */
  streaming: boolean
  /** fingerprint each finished turn and match it to an enrolled profile */
  speakerId: boolean
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  engine: 'browser',
  serverUrl: 'http://localhost:8000',
  synthPath: '/v1/audio/speech',
  model: 'omni-voice-1',
  preset: 'nova',
  speed: 1,
  format: 'mp3',
  autoSpeak: true,
  cloneRef: '',
  cloneName: '',
  instruct: '',
  heygenModel: 'heygen-voice-1-turbo-free',
  heygenVoiceId: '83548de556df48ba8c09c42a57c51d85',
  heygenLanguage: 'en',
  asrPath: '/v1/audio/transcriptions',
  asrUrl: '',
  asrModel: 'whisper-1',
  micDeviceId: '',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  wakeEnabled: false,
  wakePhrase: 'Hey Orvex',
  wakeFuzzy: true,
  bargeIn: true,
  bargeInThreshold: 0.18,
  streaming: true,
  speakerId: false,
}

const STORAGE_KEY = 'orvex-voice-config'
const SPEAK_ONCE_KEY = 'orvex-voice-speak-on'

function load(): VoiceConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const cfg: VoiceConfig = raw
      ? { ...DEFAULT_VOICE_CONFIG, ...(JSON.parse(raw) as Partial<VoiceConfig>) }
      : { ...DEFAULT_VOICE_CONFIG }
    // Older builds shipped with auto-speak off and saved that choice. Turn it on
    // once so an upgraded install actually talks; afterwards it is the user's call.
    if (!localStorage.getItem(SPEAK_ONCE_KEY)) {
      localStorage.setItem(SPEAK_ONCE_KEY, '1')
      cfg.autoSpeak = true
    }
    return cfg
  } catch {
    return { ...DEFAULT_VOICE_CONFIG }
  }
}

type Ctx = {
  cfg: VoiceConfig
  setCfg: (patch: Partial<VoiceConfig>) => void
  reset: () => void
}

const VoiceSettingsContext = createContext<Ctx | null>(null)

export function VoiceSettingsProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfgState] = useState<VoiceConfig>(() => load())

  useEffect(() => {
    writeJson(STORAGE_KEY, cfg)
    // Live microphone/wake/barge-in switches need to reach the running session,
    // which lives above this provider and reads config through a ref.
    window.dispatchEvent(new CustomEvent('orvex-voice-config', { detail: cfg }))
  }, [cfg])

  const setCfg = useCallback((patch: Partial<VoiceConfig>) => {
    setCfgState((c) => ({ ...c, ...patch }))
  }, [])

  const reset = useCallback(() => setCfgState({ ...DEFAULT_VOICE_CONFIG }), [])

  const value = useMemo<Ctx>(() => ({ cfg, setCfg, reset }), [cfg, setCfg, reset])
  return <VoiceSettingsContext.Provider value={value}>{children}</VoiceSettingsContext.Provider>
}

export function useVoiceSettings(): Ctx {
  const ctx = useContext(VoiceSettingsContext)
  if (!ctx) throw new Error('useVoiceSettings must be used inside VoiceSettingsProvider')
  return ctx
}

/* ------------------------------------------------------------------ synthesis */

export type SpeakResult = { ok: boolean; detail: string }

const STOPPED: SpeakResult = { ok: true, detail: 'stopped' }
let speechGeneration = 0

/** Set during browser or Audio playback so cancellation also settles the caller. */
let stopPlayback: (() => void) | null = null

/** Requests whose audio is still on its way; each can be cancelled in flight. */
const liveTracks = new Set<() => void>()

export function stopSpeaking() {
  // Invalidate pending synthesis before cancellation can dispatch playback events.
  speechGeneration += 1
  const stop = stopPlayback
  stopPlayback = null
  stop?.()
  for (const abort of [...liveTracks]) {
    try {
      abort()
    } catch {
      /* request already closed */
    }
  }
  liveTracks.clear()
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel()
}

/**
 * Speaks text using the configured engine.
 * Local engines POST to the user's TTS server; otherwise it falls back to the
 * browser's built-in speech synthesis. Either way the caller is told what happened.
 *
 * VoiceStudio-style natural-language voice design is sent as `instruct` when set
 * (OmniVoice, XTTS v2 and Fish Speech all accept a free-text style prompt). The
 * reference clip is sent as `reference_audio` when the engine supports cloning.
 */
export async function speak(text: string, cfg: VoiceConfig, onPlaybackStart?: () => void): Promise<SpeakResult> {
  stopSpeaking()
  const generation = speechGeneration
  const clean = forSpeech(text)
  if (!clean) return { ok: false, detail: 'Nothing to say.' }

  if (cfg.engine === 'browser') return speakWithBrowser(clean, cfg, generation, onPlaybackStart)
  if (cfg.engine === 'heygen') return speakHeygen(clean, cfg, generation, onPlaybackStart)

  const base = cfg.serverUrl.replace(/\/+$/, '')
  const path = cfg.synthPath.startsWith('/') ? cfg.synthPath : `/${cfg.synthPath}`
  const url = `${base}${path}`

  try {
    const body: Record<string, unknown> = {
      model: cfg.model,
      input: clean,
      voice: cfg.preset,
      speed: cfg.speed,
      response_format: cfg.format,
    }
    if (cfg.instruct.trim()) body.instruct = cfg.instruct.trim()
    if (cfg.cloneRef) body.reference_audio = cfg.cloneRef

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (generation !== speechGeneration) return STOPPED
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      if (generation !== speechGeneration) return STOPPED
      return { ok: false, detail: `TTS server returned HTTP ${res.status}${t ? ` — ${t.slice(0, 140)}` : ''}` }
    }

    const blob = await res.blob()
    if (generation !== speechGeneration) return STOPPED
    if (!blob.size) return { ok: false, detail: 'TTS server returned an empty audio body.' }
    await playBlob(blob, generation, onPlaybackStart)
    if (generation !== speechGeneration) return STOPPED
    return { ok: true, detail: `Spoken via ${cfg.engine} (${Math.round(blob.size / 1024)} kB)` }
  } catch (e) {
    if (generation !== speechGeneration) return STOPPED
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, detail: `Could not reach the TTS server — ${msg}` }
  }
}

const desktopMedia = () => (typeof window !== 'undefined' ? window.orvex?.media : undefined)
type MediaBridge = NonNullable<ReturnType<typeof desktopMedia>>

/** Shortest sentence worth its own synthesis request. */
const MIN_EARLY_SPEECH_CHARS = 28
/** One sentence plays while the next is already being synthesised. */
const MAX_LIVE_SPEECH_REQUESTS = 2

type HeygenSegment = {
  id: string
  /** Base64 WAV parts as the service sends them, each playable on its own. */
  parts: string[]
  ended: boolean
  failure: string | null
  summary: { model: string; duration: number | null } | null
  /** Resolves when the request is over, which can be before playback drains. */
  settled: Promise<void>
  close: () => void
}

type HeygenPlayer = {
  /** Starts one synthesis request; its audio plays in reply order. */
  request: (text: string) => HeygenSegment
  /** No more requests: resolves once everything already requested has played. */
  close: () => Promise<SpeakResult>
}

type HeygenPart = { ok: true; blob: Blob } | { ok: false; detail: string }

/**
 * Turns one streamed frame into a playable clip. Every part is a standalone
 * WAV, so a frame that cannot be decoded fails the reply instead of the loop.
 */
function decodePart(base64: string): HeygenPart {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    if (!bytes.length) return { ok: false, detail: 'HeyGen stream returned an empty audio chunk.' }
    return { ok: true, blob: new Blob([bytes], { type: 'audio/wav' }) }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Ordered HeyGen speech for one reply, made of any number of text segments.
 *
 * The service streams each segment as WAV parts while a later segment is still
 * being synthesised, and playback is driven straight from the part listener, so
 * the first sound lands the moment a part arrives. That is what lets a reply be
 * heard before the model has finished writing it.
 */
function createHeygenPlayer(bridge: MediaBridge, cfg: VoiceConfig, generation: number, onPlaybackStart?: () => void): HeygenPlayer {
  const segments: HeygenSegment[] = []
  /** Unsubscribes per request id, so a closed segment stops receiving parts. */
  const detach = new Map<string, () => void>()
  let cursor = 0
  let closed = false
  let playing = false
  let heard = false
  let result: SpeakResult | null = null
  let failure: SpeakResult | null = null
  let resolveClose = (_value: SpeakResult) => {}
  const finished = new Promise<SpeakResult>((resolve) => {
    resolveClose = resolve
  })

  const notify = () => {
    if (heard || generation !== speechGeneration) return
    heard = true
    onPlaybackStart?.()
  }
  const silence = () => {
    const stop = stopPlayback
    stopPlayback = null
    stop?.()
  }
  const success = (): SpeakResult => {
    const spoken = segments.find((s) => s.summary)
    if (!spoken) return { ok: false, detail: 'HeyGen speech failed — no audio returned.' }
    const seconds = segments.reduce((sum, s) => sum + (s.summary?.duration ?? 0), 0)
    return { ok: true, detail: `Spoken via HeyGen ${spoken.summary!.model}${seconds ? ` · ${seconds.toFixed(1)}s` : ''}` }
  }
  const settle = (value: SpeakResult) => {
    if (result) return
    result = value
    liveTracks.delete(cancel)
    for (const segment of segments) segment.close()
    resolveClose(value)
  }
  /** Cancellation has to settle the caller even with nothing currently playing. */
  const cancel = () => settle(STOPPED)

  /** A segment or playback error ends the reply and drops whatever is queued. */
  const fail = (message: string) => {
    failure = { ok: false, detail: `HeyGen speech failed — ${message}` }
    silence()
    settle(failure)
  }

  /**
   * Plays as much as it can right now. A part that lands while the player is
   * idle is heard in the same tick, which is what makes speech start inside a
   * reply that the model is still writing.
   */
  const step = () => {
    // Only one clip plays at a time; whenever one ends, step runs again.
    if (result || playing) return
    while (generation === speechGeneration) {
      const segment = segments[cursor]
      if (!segment) {
        if (closed && cursor >= segments.length) settle(failure ?? success())
        return
      }
      if (segment.parts.length) {
        const part = decodePart(segment.parts.shift()!)
        if (!part.ok) {
          fail(part.detail)
          return
        }
        playing = true
        void playBlob(part.blob, generation, notify).then(
          () => {
            playing = false
            step()
          },
          (e: unknown) => {
            playing = false
            fail(e instanceof Error ? e.message : String(e))
          },
        )
        return
      }
      if (segment.ended) {
        if (segment.failure) {
          fail(segment.failure)
          return
        }
        cursor += 1
        continue
      }
      return
    }
    settle(STOPPED)
  }

  liveTracks.add(cancel)

  return {
    request(text: string) {
      const id = crypto.randomUUID()
      let resolveSettled = () => {}
      const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve
      })
      const segment: HeygenSegment = {
        id,
        parts: [],
        ended: false,
        failure: null,
        summary: null,
        settled,
        close: () => {
          const off = detach.get(id)
          detach.delete(id)
          try {
            off?.()
          } catch {
            /* listener already detached */
          }
          // Only an archive that already played needs no stop on main.
          if (segment.ended && !segment.failure && !segment.parts.length) return
          segment.ended = true
          segment.parts.length = 0
          resolveSettled()
          try {
            void bridge.stopHeygenTts(id).catch(() => {})
          } catch {
            /* bridge closed */
          }
        },
      }
      segments.push(segment)
      if (result) segment.close()

      // Main emits monotonically ordered indices. A high-water mark rejects
      // duplicates and older parts in constant space, without a reorder buffer.
      let lastIndex = -1
      const off = bridge.onHeygenAudio((event) => {
        if (event.id !== id || segment.ended || generation !== speechGeneration) return
        if (!Number.isSafeInteger(event.index) || event.index <= lastIndex) return
        lastIndex = event.index
        segment.parts.push(event.audio)
        step()
      })
      detach.set(id, off)

      const complete = (error: string | null, summary: { model: string; duration: number | null } | null) => {
        if (segment.ended) return
        segment.failure = error
        segment.summary = summary
        if (error) segment.parts.length = 0
        segment.ended = true
        resolveSettled()
        // A broken stream stops the reply where it stands, mid-clip if needed.
        if (error) fail(error)
        else step()
      }

      try {
        void bridge
          .heygenTtsStream({
            id,
            text,
            voiceId: cfg.heygenVoiceId.trim(),
            model: cfg.heygenModel,
            language: cfg.heygenLanguage.trim() || 'en',
            speed: cfg.speed,
          })
          .then(
            (res) => {
              if (!res.ok) return complete(res.error, null)
              // Parts are already buffered; the last one can still be playing,
              // so the request is over without closing the segment.
              complete(lastIndex < 0 ? 'HeyGen stream returned no audio.' : null, { model: res.data.model, duration: res.data.duration })
            },
            (error: unknown) => complete(error instanceof Error ? error.message : String(error), null),
          )
      } catch (e) {
        complete(e instanceof Error ? e.message : String(e), null)
      }
      return segment
    },

    close() {
      closed = true
      step()
      return finished
    },
  }
}

async function speakHeygen(text: string, cfg: VoiceConfig, generation: number, onPlaybackStart?: () => void): Promise<SpeakResult> {
  const bridge = desktopMedia()
  if (!bridge?.heygenTtsStream || !bridge.onHeygenAudio || !bridge.stopHeygenTts) {
    return { ok: false, detail: 'HeyGen voice needs the desktop app.' }
  }
  if (!cfg.heygenVoiceId.trim()) return { ok: false, detail: 'Pick a HeyGen voice in Settings → Voice.' }
  const player = createHeygenPlayer(bridge, cfg, generation, onPlaybackStart)
  player.request(text)
  return player.close()
}

export type ReplySpeech = {
  /** Feed the reply as it grows; finished sentences start being spoken now. */
  push: (textSoFar: string) => void
  /** Speak whatever is left and resolve once the whole reply has been heard. */
  finish: (finalText: string) => Promise<SpeakResult>
}

/**
 * Speech for one reply. With a streaming engine the answer is cut into
 * sentences as it arrives, so the first sound lands while the model is still
 * writing; every other engine speaks the completed reply in one go.
 */
export function beginReplySpeech(cfg: VoiceConfig, onPlaybackStart?: () => void): ReplySpeech {
  const bridge = cfg.engine === 'heygen' ? desktopMedia() : undefined
  const streaming = !!bridge && !!cfg.heygenVoiceId.trim()
  const sentences: string[] = []
  let raw = ''
  let consumed = 0
  let anchor = ''
  /** A provider that rewrites its answer instead of appending cannot be split. */
  let rewound = false
  let requested = 0
  let live = 0
  let closed = false
  let player: HeygenPlayer | null = null

  const requestMore = () => {
    if (!player) return
    while (requested < sentences.length && live < MAX_LIVE_SPEECH_REQUESTS) {
      const segment = player.request(forSpeech(sentences[requested]))
      requested += 1
      live += 1
      void segment.settled.then(() => {
        live -= 1
        requestMore()
      })
    }
  }

  return {
    push(textSoFar: string) {
      raw = textSoFar
      if (closed || !streaming || rewound) return
      if (anchor && !textSoFar.startsWith(anchor)) {
        rewound = true
        return
      }
      const split = speakableSentences(textSoFar, consumed, MIN_EARLY_SPEECH_CHARS)
      consumed = split.consumed
      anchor = textSoFar.slice(0, consumed)
      if (!split.sentences.length) return
      sentences.push(...split.sentences)
      if (!player) {
        // This reply supersedes anything still talking from an earlier turn.
        stopSpeaking()
        player = createHeygenPlayer(bridge!, cfg, speechGeneration, onPlaybackStart)
      }
      requestMore()
    },

    async finish(finalText: string) {
      if (finalText) raw = finalText
      closed = true
      // Nothing was spoken early: say the whole reply in one request.
      if (!player || !streaming || rewound || !sentences.length) return speak(raw, cfg, onPlaybackStart)
      const tail = raw.startsWith(anchor) ? remainingSpeech(raw, consumed) : raw
      if (forSpeech(tail).trim()) sentences.push(tail)
      requestMore()
      return player.close()
    },
  }
}

type PlaybackControl = { stop: (() => void) | null }

function playUrl(url: string, generation: number, onPlaybackStart?: () => void, control?: PlaybackControl): Promise<void> {
  if (generation !== speechGeneration) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const audio = new Audio(url)
    let settled = false
    let started = false
    const finish = (fn: () => void, teardown = false) => {
      if (settled) return
      settled = true
      if (control) {
        if (control.stop === stop) control.stop = null
      } else if (stopPlayback === stop) stopPlayback = null
      // Settle before teardown, which may emit an error or reject play().
      fn()
      if (teardown) {
        try {
          audio.pause()
          audio.src = ''
        } catch {
          /* already torn down */
        }
      }
    }
    const stop = () => finish(resolve, true)
    const fail = (error: unknown) => finish(() => reject(error), true)
    audio.onplaying = () => {
      if (settled || started || generation !== speechGeneration) return
      started = true
      onPlaybackStart?.()
    }
    audio.onended = () => finish(resolve)
    audio.onerror = () => fail(new Error('Audio playback failed'))
    if (control) control.stop = stop
    else stopPlayback = stop
    try {
      void audio.play().catch(fail)
    } catch (error) {
      fail(error)
    }
  })
}

async function playBlob(blob: Blob, generation: number, onPlaybackStart?: () => void, control?: PlaybackControl): Promise<void> {
  if (generation !== speechGeneration) return
  const url = URL.createObjectURL(blob)
  try {
    await playUrl(url, generation, onPlaybackStart, control)
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function speakWithBrowser(text: string, cfg: VoiceConfig, generation: number, onPlaybackStart?: () => void): Promise<SpeakResult> {
  if (!('speechSynthesis' in window)) {
    return { ok: false, detail: 'This browser has no speech synthesis.' }
  }
  const synth = window.speechSynthesis
  try {
    const voices = await voiceList(synth)
    if (generation !== speechGeneration) return STOPPED
    const preset = VOICE_PRESETS.find((v) => v.id === cfg.preset)
    const hint = preset?.hint ?? ''
    // Windows names its voices "Microsoft Hazel - English (United Kingdom)", so the
    // catalogue hint only ever matches as a prefix — exact matching found nothing.
    const match =
      voices.find((v) => v.name === hint) ??
      voices.find((v) => hint && v.name.startsWith(hint)) ??
      voices.find((v) => hint && v.name.includes(hint)) ??
      voices.find((v) => v.default && v.lang.startsWith('en')) ??
      voices.find((v) => v.lang.startsWith('en')) ??
      voices[0]

    return await new Promise<SpeakResult>((resolve) => {
      const utter = new SpeechSynthesisUtterance(text)
      let timer = 0
      let settled = false
      let started = false
      const finish = (r: SpeakResult) => {
        if (settled) return
        settled = true
        if (stopPlayback === stop) stopPlayback = null
        window.clearTimeout(timer)
        resolve(generation === speechGeneration ? r : STOPPED)
      }
      const stop = () => finish(STOPPED)
      if (match) utter.voice = match
      utter.rate = Math.min(2, Math.max(0.5, cfg.speed))
      utter.onstart = () => {
        if (settled || started || generation !== speechGeneration) return
        started = true
        onPlaybackStart?.()
      }
      utter.onend = () => finish({ ok: true, detail: `Spoken by browser voice${match ? ` (${match.name})` : ''}` })
      utter.onerror = (e) => finish({ ok: false, detail: `Browser speech failed — ${e.error}` })
      // Without an audio device (or under automation) `onend` never fires and the
      // caller would wait forever, leaving the Test button spinning.
      timer = window.setTimeout(() => {
        finish(
          synth.speaking
            ? { ok: true, detail: 'Browser voice is speaking — this environment did not report completion.' }
            : { ok: false, detail: 'Browser speech did not start — this environment may have no audio output.' },
        )
      }, Math.max(4000, Math.min(60000, text.length * 90)))
      stopPlayback = stop
      synth.speak(utter)
    })
  } catch (e) {
    if (generation !== speechGeneration) return STOPPED
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, detail: `Browser speech failed — ${msg}` }
  }
}

/** Electron/Chromium fills the voice list asynchronously; the first call is empty. */
function voiceList(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const now = synth.getVoices()
  if (now.length) return Promise.resolve(now)
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve(synth.getVoices())
    }
    synth.addEventListener('voiceschanged', finish, { once: true })
    window.setTimeout(finish, 900)
  })
}
