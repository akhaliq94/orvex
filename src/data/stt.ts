import { DEFAULT_VOICE_CONFIG, type VoiceConfig } from './voice'

/**
 * Speech input for the desktop build.
 *
 * Electron ships without Chromium's cloud speech service, so the Web Speech API
 * answers every request with `network`. When the user configures a transcription
 * endpoint we record the turn locally and POST it to that endpoint instead.
 */

export type SttTarget = { url: string; model: string }

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

/** The endpoint speech input should use, or null when the user has not set one up. */
export function sttTarget(cfg: VoiceConfig): SttTarget | null {
  const model = (cfg.asrModel || 'whisper-1').trim() || 'whisper-1'
  const url = (cfg.asrUrl || '').trim()
  if (url) return { url, model }
  // A locally-run speech server (VoiceStudio) also exposes transcription.
  const server = (cfg.serverUrl || '').trim()
  if (!CLOUD_ENGINES.has(cfg.engine) && server) {
    const path = cfg.asrPath.startsWith('/') ? cfg.asrPath : `/${cfg.asrPath}`
    return { url: `${server.replace(/\/+$/, '')}${path}`, model }
  }
  return null
}

/** Whether a transcription key is saved. The value itself never reaches the renderer. */
export async function hasSttKey(): Promise<boolean> {
  const desktop = typeof window !== 'undefined' ? window.orvex : undefined
  if (!desktop) return !!sessionStorage.getItem(KEY_SESSION)
  try {
    const res = await desktop.secrets.get()
    return res.ok ? !!res.data.keys.stt : false
  } catch {
    return false
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

export async function transcribeClip(
  target: SttTarget,
  audio: Blob,
  opts: { timeoutMs?: number } = {},
): Promise<TranscribeOutcome> {
  const desktop = typeof window !== 'undefined' ? window.orvex : undefined
  if (desktop?.stt) {
    try {
      const res = await desktop.stt.transcribe({
        url: target.url,
        model: target.model,
        audio: await audio.arrayBuffer(),
        type: audio.type,
        timeoutMs: opts.timeoutMs ?? 45000,
      })
      if (!res.ok) return { ok: false, text: '', detail: `Transcription failed — ${res.error}` }
      const text = (res.data.text ?? '').trim()
      if (!text) return { ok: false, text: '', detail: 'The endpoint returned an empty transcript.' }
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

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45000)
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
    if (!text) return { ok: false, text: '', detail: 'The endpoint returned an empty transcript.' }
    return { ok: true, text, detail: `Heard ${text.length} characters` }
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError'
    const msg = aborted ? 'The transcription request timed out.' : e instanceof Error ? e.message : String(e)
    return { ok: false, text: '', detail: `Could not reach the transcription endpoint — ${msg}` }
  } finally {
    clearTimeout(timer)
  }
}
