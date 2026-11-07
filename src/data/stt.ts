import { DEFAULT_VOICE_CONFIG, type VoiceConfig } from './voice'

/**
 * Speech input for the desktop build.
 *
 * Electron ships without Chromium's cloud speech service, so the Web Speech API
 * answers every request with `network`. When the user configures a transcription
 * endpoint we record the turn locally and POST it to that endpoint instead.
 */

export type SttTarget = { url: string; model: string }

export function isLocalWhisper(target: SttTarget): boolean {
  try {
    const url = new URL(target.url)
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.port === '8079'
  } catch {
    return false
  }
}

const CONFIG_STORAGE = 'orvex-voice-config'
const KEY_SESSION = 'orvex-stt-key'

export function readVoiceConfig(): VoiceConfig {
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE)
    if (!raw) return { ...DEFAULT_VOICE_CONFIG }
    return { ...DEFAULT_VOICE_CONFIG, ...(JSON.parse(raw) as Partial<VoiceConfig>) }
  } catch {
    return { ...DEFAULT_VOICE_CONFIG }
  }
}

/** TTS engines that are not a local HTTP speech server, so they never imply an ASR endpoint. */
const CLOUD_ENGINES = new Set(['browser', 'heygen'])

/** The transcription endpoint the app-managed local Whisper server answers on. */
export const LOCAL_WHISPER_URL = 'http://127.0.0.1:8079/v1/audio/transcriptions'

export type AsrPresetId = 'local' | 'groq' | 'openai' | 'elevenlabs' | 'custom'

/**
 * One-click speech-input endpoints. Local transcription costs nothing but eats
 * this machine's four cores — a hosted endpoint answers a turn in about a
 * second instead, which is the difference between a conversation and a wait.
 */
export const ASR_PRESETS: { id: AsrPresetId; label: string; url: string; model: string }[] = [
  { id: 'local', label: 'Local Whisper — free, slow on this PC', url: LOCAL_WHISPER_URL, model: 'base' },
  { id: 'groq', label: 'Groq Whisper — fast, free tier then paid', url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo' },
  { id: 'openai', label: 'OpenAI Whisper — fast, billed per minute', url: 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1' },
  { id: 'elevenlabs', label: 'ElevenLabs Scribe — accurate, billed per minute', url: 'https://api.elevenlabs.io/v1/speech-to-text', model: 'scribe_v2' },
  { id: 'custom', label: 'Custom endpoint', url: '', model: '' },
]

/** Which preset the currently configured endpoint matches. */
export function asrPresetFor(cfg: VoiceConfig): AsrPresetId {
  const url = (cfg.asrUrl || '').trim().replace(/\/+$/, '')
  // Nothing typed: an endpoint inferred from a TTS server is a hand-set source,
  // while no endpoint at all is the app's own local transcription.
  if (!url) return sttTarget(cfg) ? 'custom' : 'local'
  const hit = ASR_PRESETS.find((p) => p.url.replace(/\/+$/, '') === url)
  if (!hit) return 'custom'
  // Groq and OpenAI accept other model names too; only the stock pairing counts
  // as the preset, anything else is a hand-tuned endpoint.
  if (hit.id !== 'local' && (cfg.asrModel || '').trim() !== hit.model) return 'custom'
  return hit.id
}

/** The endpoint and model a preset stands for; `custom` keeps whatever is set. */
export function asrPresetPatch(id: AsrPresetId): Partial<VoiceConfig> {
  const preset = ASR_PRESETS.find((p) => p.id === id)
  if (!preset || id === 'custom') return {}
  return { asrUrl: preset.url, asrModel: preset.model }
}

/** The endpoint speech input should use, or null when the user has not set one up. */
export function sttTarget(cfg: VoiceConfig): SttTarget | null {
  const typed = (cfg.asrModel || '').trim()
  let url = (cfg.asrUrl || '').trim()
  if (!url) {
    // A locally-run speech server (VoiceStudio) also exposes transcription.
    const server = (cfg.serverUrl || '').trim()
    if (CLOUD_ENGINES.has(cfg.engine) || !server) return null
    const path = cfg.asrPath.startsWith('/') ? cfg.asrPath : `/${cfg.asrPath}`
    url = `${server.replace(/\/+$/, '')}${path}`
  }
  // A model name belongs to the service behind the URL: whisper-1 is refused by
  // ElevenLabs and scribe_v2 by everything else, so the default follows the host.
  return { url, model: typed || (isElevenLabsHost(url) ? 'scribe_v2' : 'whisper-1') }
}

export function isElevenLabsHost(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith('elevenlabs.io')
  } catch {
    return false
  }
}

/**
 * Tell the main process which endpoint speech input will use. Local Whisper
 * shares this machine's few cores with the model, so main stops its own server
 * as soon as the endpoint points somewhere else. Only the URL is sent.
 */
export function reportSttEndpoint(cfg: VoiceConfig): void {
  const desktop = typeof window !== 'undefined' ? window.orvex : undefined
  if (!desktop?.stt) return
  void desktop.stt.setEndpoint(sttTarget(cfg)?.url || '').catch(() => undefined)
}

/** Whether a transcription key is saved (one key or the pool). The values never reach the renderer. */
export async function hasSttKey(): Promise<boolean> {
  const desktop = typeof window !== 'undefined' ? window.orvex : undefined
  if (!desktop) return !!sessionStorage.getItem(KEY_SESSION)
  try {
    const res = await desktop.secrets.get()
    return res.ok ? !!(res.data.keys.stt || res.data.keys[POOL_VAULT_ID]) : false
  } catch {
    return false
  }
}

const POOL_VAULT_ID = 'stt.pool'

export type SttKeyRow = {
  id: string
  label: string
  addedAt: number
  state: 'working' | 'quota' | 'key' | 'cooling'
  stateLabel: string
  fails: number
  detail: string
  retryInMs: number
}

export type SttKeyList = {
  limit: number
  keys: SttKeyRow[]
  savedFor: string
  others: number
  hasSingleKey: boolean
}

type Bridge = NonNullable<typeof window.orvex>

function desktopStt(): Bridge['stt'] | null {
  const desktop = typeof window !== 'undefined' ? window.orvex : undefined
  return desktop?.stt?.keys ? desktop.stt : null
}

/** Labels and status for every extra key saved for this endpoint. */
export async function listSttKeys(url: string): Promise<SttKeyList | null> {
  const stt = desktopStt()
  if (!stt) return null
  try {
    const res = await stt.keys.list(url)
    return res.ok ? res.data : null
  } catch {
    return null
  }
}

export async function addSttKey(
  key: string,
  label: string,
  url: string,
): Promise<{ ok: boolean; detail: string; count: number }> {
  const stt = desktopStt()
  if (!stt) return { ok: false, detail: 'Key pools need the desktop app.', count: 0 }
  try {
    const res = await stt.keys.add(key.trim(), label.trim(), url)
    if (!res.ok) return { ok: false, detail: res.error, count: 0 }
    return {
      ok: true,
      detail: res.data.added ? `Key ${res.data.count} added for this endpoint.` : res.data.reason || 'Already saved.',
      count: res.data.count,
    }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e), count: 0 }
  }
}

export async function removeSttKey(id: string, url = ''): Promise<{ ok: boolean; detail: string }> {
  const stt = desktopStt()
  if (!stt) return { ok: false, detail: 'Key pools need the desktop app.' }
  try {
    const res = await stt.keys.remove(id, url)
    return res.ok ? { ok: true, detail: `Removed. ${res.data.count} key(s) left for this endpoint.` } : { ok: false, detail: res.error }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

/** Puts every parked key back in line without touching the stored values. */
export async function resetSttKeys(): Promise<{ ok: boolean; detail: string }> {
  const stt = desktopStt()
  if (!stt) return { ok: false, detail: 'Key pools need the desktop app.' }
  try {
    const res = await stt.keys.reset()
    return res.ok ? { ok: true, detail: 'All keys will be tried again on the next turn.' } : { ok: false, detail: res.error }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

/** Model names the endpoint itself reports, so the picker is never a guess. */
export async function fetchSttModels(url: string): Promise<{ ok: boolean; detail: string; models: string[] }> {
  const stt = typeof window !== 'undefined' ? window.orvex?.stt : undefined
  if (!stt) return { ok: false, detail: 'Model listing needs the desktop app.', models: [] }
  try {
    const res = await stt.models(url)
    if (!res.ok) return { ok: false, detail: res.error, models: [] }
    return { ok: true, detail: `${res.data.models.length} models from ${res.data.source}`, models: res.data.models }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e), models: [] }
  }
}

/** Desktop keys live in the OS vault (bound to the endpoint); the web build keeps them per tab. */
export async function saveSttKey(key: string, baseUrl?: string): Promise<{ ok: boolean; detail: string }> {
  const value = key.trim()
  const desktop = typeof window !== 'undefined' ? window.orvex : undefined
  if (!desktop) {
    if (value) sessionStorage.setItem(KEY_SESSION, value)
    else sessionStorage.removeItem(KEY_SESSION)
    return { ok: true, detail: value ? 'Stored for this browser session.' : 'Cleared.' }
  }
  try {
    const res = await desktop.secrets.set('stt', value, baseUrl)
    if (!res.ok) return { ok: false, detail: res.error }
    return { ok: true, detail: value ? 'Stored in the OS-encrypted vault.' : 'Cleared from the vault.' }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

export type TranscribeOutcome = { ok: boolean; text: string; detail: string }

/**
 * Engines do not return silence as an empty string. whisper.cpp answers a quiet
 * clip with markers like `[BLANK_AUDIO]`, `(no speech)` or `«no audio»`, and
 * mergePartial keeps any of those as real text, so a silent pause would be sent
 * to the model as a turn. Bracketed-only output and anything without letters or
 * digits is not speech.
 */
export function hasSpeech(text: string): boolean {
  const bare = text
    .replace(/\s+/g, '')
    .replace(/\[[^\]]*\]|<[^>]*>|«[^»]*»|\([^)]*\)|\{[^}]*\}/g, '')
  return /[\p{L}\p{N}]/u.test(bare)
}

export async function transcribeClip(
  target: SttTarget,
  audio: Blob,
  opts: { timeoutMs?: number; language?: string } = {},
): Promise<TranscribeOutcome> {
  const timeoutMs = opts.timeoutMs ?? (isLocalWhisper(target) ? 120000 : 45000)
  const language = String(opts.language || '').trim()
  const desktop = typeof window !== 'undefined' ? window.orvex : undefined
  if (desktop?.stt) {
    try {
      const res = await desktop.stt.transcribe({
        url: target.url,
        model: target.model,
        audio: await audio.arrayBuffer(),
        type: audio.type,
        timeoutMs: timeoutMs,
        language: language || undefined,
      })
      if (!res.ok) return { ok: false, text: '', detail: `Transcription failed — ${res.error}` }
      const text = (res.data.text ?? '').trim()
      if (!hasSpeech(text)) return { ok: true, text: '', detail: 'No speech in that clip.' }
      return { ok: true, text, detail: `Heard ${text.length} characters` }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, text: '', detail: `Could not reach the transcription endpoint — ${msg}` }
    }
  }

  const form = new FormData()
  const ext = audio.type.includes('wav') ? 'wav' : audio.type.includes('ogg') ? 'ogg' : 'webm'
  form.append('file', audio, `clip.${ext}`)
  form.append('model', target.model)
  // Whisper-family engines take a bare ISO code; unsupported values are
  // ignored by the server, and an empty hint leaves detection on.
  if (language) form.append('language', language)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = {}
    const key = sessionStorage.getItem(KEY_SESSION) ?? ''
    if (key) headers.authorization = `Bearer ${key}`
    const res = await fetch(target.url, { method: 'POST', headers, body: form, signal: controller.signal })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, text: '', detail: `Transcription failed — HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}` }
    }
    const json = (await res.json()) as { text?: string }
    const text = (json.text ?? '').trim()
    if (!hasSpeech(text)) return { ok: true, text: '', detail: 'No speech in that clip.' }
    return { ok: true, text, detail: `Heard ${text.length} characters` }
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError'
    const msg = aborted ? 'The transcription request timed out.' : e instanceof Error ? e.message : String(e)
    return { ok: false, text: '', detail: `Could not reach the transcription endpoint — ${msg}` }
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ live input */

export type RealtimeSession = { id: string; sampleRate: number; model: string; commitStrategy: string }

export type RealtimeStart =
  | { ok: true; session: RealtimeSession }
  | { ok: false; detail: string }

const realtimeBridge = () => (typeof window !== 'undefined' ? window.orvex?.stt?.realtime : undefined)

export function realtimeSupported(): boolean {
  return !!realtimeBridge()
}

/** Opens the live microphone session; the key stays in the main process. */
export async function startRealtimeStt(opts: { silenceSecs?: number; language?: string } = {}): Promise<RealtimeStart> {
  const bridge = realtimeBridge()
  if (!bridge) return { ok: false, detail: 'Live speech input needs the desktop app.' }
  try {
    const res = await bridge.start({ silenceSecs: opts.silenceSecs, language: opts.language })
    if (!res.ok) return { ok: false, detail: res.error }
    return { ok: true, session: { id: res.data.id, sampleRate: res.data.sampleRate, model: res.data.model, commitStrategy: res.data.commitStrategy } }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

export type RealtimeEvent = {
  id: string
  type: 'ready' | 'partial' | 'committed' | 'warning' | 'error' | 'closed'
  text?: string
  message?: string
  error?: string
}

export function onRealtimeEvent(cb: (event: RealtimeEvent) => void): () => void {
  const bridge = realtimeBridge()
  if (!bridge) return () => {}
  return bridge.onEvent(cb)
}

/** Base64 in slices, so a long chunk cannot blow the argument limit. */
export function pcmToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

export function floatToPcm16(input: Float32Array): Uint8Array {
  const out = new Uint8Array(input.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < input.length; i++) {
    const v = Math.max(-1, Math.min(1, input[i]))
    view.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true)
  }
  return out
}

/** Wraps collected PCM in a WAV header so the turn can be fingerprinted or replayed. */
export function pcmChunksToWav(chunks: Uint8Array[], sampleRate: number): Blob {
  const bytes = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(44 + bytes)
  const view = new DataView(out.buffer)
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i)
  }
  tag(0, 'RIFF')
  view.setUint32(4, 36 + bytes, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  tag(36, 'data')
  view.setUint32(40, bytes, true)
  let at = 44
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return new Blob([out], { type: 'audio/wav' })
}

export async function sendRealtimeAudio(id: string, pcm: Uint8Array, commit = false): Promise<boolean> {
  const bridge = realtimeBridge()
  if (!bridge) return false
  try {
    const res = await bridge.audio(id, pcmToBase64(pcm), commit)
    return res.ok
  } catch {
    return false
  }
}

export async function stopRealtimeStt(id?: string): Promise<void> {
  const bridge = realtimeBridge()
  if (!bridge) return
  try {
    await bridge.stop(id)
  } catch {
    /* session already gone */
  }
}
