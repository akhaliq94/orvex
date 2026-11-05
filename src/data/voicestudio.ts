/**
 * VoiceStudio-compatible speech API client.
 *
 * Endpoints follow the VoiceStudio speech platform surface:
 *   GET  /.well-known/voicestudio-speech   — capability discovery
 *   POST /v1/audio/transcriptions          — OpenAI-compatible ASR (multipart)
 *   WS   /v1/audio/transcriptions/stream   — streaming ASR frames
 *
 * OmniVoice itself exposes no HTTP TTS API — it is a Python/CLI engine. The
 * VoiceStudio backend is what puts an HTTP surface in front of it, so a TTS
 * endpoint here means "a VoiceStudio-style server", not "OmniVoice directly".
 */

export type SpeechDiscovery = {
  /** API id, e.g. voicestudio.speech.v1 */
  api?: string
  /** which ASR dialects the server speaks */
  asr?: string[]
  tts?: string[]
  models?: string[]
  [k: string]: unknown
}

export type TranscribeResult = {
  ok: boolean
  text: string
  detail: string
}

/** Normalises a server URL into a websocket URL. */
export function toWsUrl(httpUrl: string, path: string): string {
  const base = httpUrl.replace(/\/+$/, '')
  const wsBase = base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
  const p = path.startsWith('/') ? path : `/${path}`
  return `${wsBase}${p}`
}

/** Queries the discovery endpoint. Returns null when the server has none. */
export async function discoverSpeech(baseUrl: string): Promise<SpeechDiscovery | null> {
  const base = baseUrl.replace(/\/+$/, '')
  try {
    const res = await fetch(`${base}/.well-known/voicestudio-speech`)
    if (!res.ok) return null
    return (await res.json()) as SpeechDiscovery
  } catch {
    return null
  }
}

/**
 * Transcribes an audio blob through the OpenAI-compatible endpoint.
 * `file` should be a WAV/WebM blob captured from the microphone.
 */
export async function transcribeAudio(
  baseUrl: string,
  path: string,
  audio: Blob,
  opts: { model?: string; language?: string; apiKey?: string } = {},
): Promise<TranscribeResult> {
  const base = baseUrl.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  const form = new FormData()
  const ext = audio.type.includes('wav') ? 'wav' : audio.type.includes('webm') ? 'webm' : 'ogg'
  form.append('file', audio, `clip.${ext}`)
  form.append('model', opts.model || 'whisper-1')
  if (opts.language) form.append('language', opts.language)

  try {
    const headers: Record<string, string> = {}
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`
    const res = await fetch(`${base}${p}`, { method: 'POST', headers, body: form })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      return { ok: false, text: '', detail: `ASR server returned HTTP ${res.status}${t ? ` — ${t.slice(0, 140)}` : ''}` }
    }
    const json = (await res.json()) as { text?: string }
    const text = (json.text ?? '').trim()
    if (!text) return { ok: false, text: '', detail: 'ASR server returned an empty transcript.' }
    return { ok: true, text, detail: `Transcribed ${text.length} characters` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, text: '', detail: `Could not reach the ASR server — ${msg}` }
  }
}

export type StreamHandlers = {
  onSession?: () => void
  /** partial (interim) hypothesis */
  onPartial?: (text: string) => void
  /** final text; `kind` is "summary" or "utterance" */
  onFinal?: (text: string, kind: 'summary' | 'utterance') => void
  onError?: (detail: string) => void
  onClose?: () => void
}

/**
 * Opens the streaming ASR socket.
 *
 * Frame contract (from the VoiceStudio speech platform):
 *   server → {"type":"session.started"}
 *   server → {"type":"partial","text":"..."}
 *   server → {"type":"final","text":"...","final_kind":"summary"|"utterance"}
 *   client → {"type":"input_audio.end"}
 */
export function openSpeechStream(
  baseUrl: string,
  path: string,
  handlers: StreamHandlers,
  opts: { sampleRate?: number; apiKey?: string } = {},
): { sendAudio: (chunk: ArrayBuffer) => void; end: () => void; close: () => void } {
  const sr = opts.sampleRate ?? 16000
  const q = `?pcm=1&sr=${sr}`
  const url = `${toWsUrl(baseUrl, path)}${q}`
  let ws: WebSocket
  try {
    ws = new WebSocket(url)
  } catch (e) {
    handlers.onError?.(`Could not open the speech socket — ${e instanceof Error ? e.message : String(e)}`)
    return { sendAudio: () => {}, end: () => {}, close: () => {} }
  }

  ws.binaryType = 'arraybuffer'

  ws.onopen = () => {
    handlers.onSession?.()
  }

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return
    let msg: { type?: string; text?: string; final_kind?: string }
    try {
      msg = JSON.parse(ev.data) as typeof msg
    } catch {
      return
    }
    if (msg.type === 'partial' && msg.text) handlers.onPartial?.(msg.text)
    else if (msg.type === 'final' && msg.text) {
      const kind = msg.final_kind === 'utterance' ? 'utterance' : 'summary'
      handlers.onFinal?.(msg.text, kind)
    }
  }

  ws.onerror = () => handlers.onError?.('Speech socket error — check the server URL and that it allows WebSocket connections.')

  ws.onclose = () => handlers.onClose?.()

  return {
    sendAudio: (chunk: ArrayBuffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk)
    },
    end: () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input_audio.end' }))
    },
    close: () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
    },
  }
}
