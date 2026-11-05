import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { writeJson } from './storage'
import { forSpeech } from './speech-text'

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

export function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  stopPlayback?.()
}

/** Set while a server-rendered clip is playing so barge-in can cut it off. */
let stopPlayback: (() => void) | null = null

/**
 * Speaks text using the configured engine.
 * Local engines POST to the user's TTS server; otherwise it falls back to the
 * browser's built-in speech synthesis. Either way the caller is told what happened.
 *
 * VoiceStudio-style natural-language voice design is sent as `instruct` when set
 * (OmniVoice, XTTS v2 and Fish Speech all accept a free-text style prompt). The
 * reference clip is sent as `reference_audio` when the engine supports cloning.
 */
export async function speak(text: string, cfg: VoiceConfig): Promise<SpeakResult> {
  const clean = forSpeech(text)
  if (!clean) return { ok: false, detail: 'Nothing to say.' }

  if (cfg.engine === 'browser') return speakWithBrowser(clean, cfg)
  if (cfg.engine === 'heygen') return speakHeygen(clean, cfg)

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

    if (!res.ok) {
      const t = await res.text().catch(() => '')
      return { ok: false, detail: `TTS server returned HTTP ${res.status}${t ? ` — ${t.slice(0, 140)}` : ''}` }
    }

    const blob = await res.blob()
    if (!blob.size) return { ok: false, detail: 'TTS server returned an empty audio body.' }
    await playBlob(blob)
    return { ok: true, detail: `Spoken via ${cfg.engine} (${Math.round(blob.size / 1024)} kB)` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, detail: `Could not reach the TTS server — ${msg}` }
  }
}

async function speakHeygen(text: string, cfg: VoiceConfig): Promise<SpeakResult> {
  const bridge = typeof window !== 'undefined' ? window.orvex?.media : undefined
  if (!bridge?.heygenTts) return { ok: false, detail: 'HeyGen voice needs the desktop app.' }
  if (!cfg.heygenVoiceId.trim()) return { ok: false, detail: 'Pick a HeyGen voice in Settings → Voice.' }
  try {
    const res = await bridge.heygenTts({
      text,
      voiceId: cfg.heygenVoiceId.trim(),
      model: cfg.heygenModel,
      language: cfg.heygenLanguage.trim() || 'en',
      speed: cfg.speed,
    })
    if (!res.ok) return { ok: false, detail: `HeyGen — ${res.error}` }
    const url = bridge.assetUrl(res.data.asset.id)
    await playUrl(url)
    const seconds = res.data.duration ? ` · ${res.data.duration.toFixed(1)}s` : ''
    return { ok: true, detail: `Spoken via HeyGen ${res.data.model}${seconds}` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, detail: `HeyGen speech failed — ${msg}` }
  }
}

function playUrl(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url)
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      stopPlayback = null
      fn()
    }
    audio.onended = () => finish(resolve)
    audio.onerror = () => finish(() => reject(new Error('Audio playback failed')))
    stopPlayback = () => {
      try {
        audio.pause()
        audio.src = ''
      } catch {
        /* already torn down */
      }
      finish(resolve)
    }
    void audio.play().catch((err) => finish(() => reject(err)))
  })
}

function playBlob(blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      stopPlayback = null
      URL.revokeObjectURL(url)
      fn()
    }
    audio.onended = () => finish(resolve)
    audio.onerror = () => finish(() => reject(new Error('Audio playback failed')))
    // Stopping deliberately counts as a completed utterance — callers resume
    // listening instead of waiting on an `ended` event that never fires.
    stopPlayback = () => {
      try {
        audio.pause()
        audio.src = ''
      } catch {
        /* already torn down */
      }
      finish(resolve)
    }
    void audio.play().catch((err) => finish(() => reject(err)))
  })
}

async function speakWithBrowser(text: string, cfg: VoiceConfig): Promise<SpeakResult> {
  if (!('speechSynthesis' in window)) {
    return { ok: false, detail: 'This browser has no speech synthesis.' }
  }
  const synth = window.speechSynthesis
  const voices = await voiceList(synth)
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

  synth.cancel()
  return await new Promise<SpeakResult>((resolve) => {
    const utter = new SpeechSynthesisUtterance(text)
    let timer = 0
    let settled = false
    const finish = (r: SpeakResult) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      resolve(r)
    }
    if (match) utter.voice = match
    utter.rate = Math.min(2, Math.max(0.5, cfg.speed))
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
    synth.speak(utter)
  })
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
