/**
 * ElevenLabs speech output.
 *
 * No key of its own: speech output uses the ElevenLabs key (and the backup key
 * list) already saved for speech input, attached in the main process. The
 * renderer only ever sees voice names and model ids.
 */

export const ELEVEN_ORIGIN = 'https://api.elevenlabs.io'

export type ElevenModel = { id: string; name: string; note: string }

export const ELEVEN_MODELS: ElevenModel[] = [
  {
    id: 'eleven_flash_v2_5',
    name: 'Flash v2.5 — live conversation',
    note: 'Built for low latency: the first sound lands in a few hundred milliseconds. 32 languages.',
  },
  {
    id: 'eleven_turbo_v2_5',
    name: 'Turbo v2.5',
    note: 'A little slower than Flash, a little richer. 32 languages.',
  },
  {
    id: 'eleven_multilingual_v2',
    name: 'Multilingual v2',
    note: 'Highest quality, slowest to start. 29 languages — use it for narration, not conversation.',
  },
]

export type ElevenVoice = {
  voiceId: string
  name: string
  category: string
  labels: Record<string, string>
}

export function elevenBridge() {
  return typeof window !== 'undefined' ? window.orvex?.media : undefined
}

/** True when a key saved for ElevenLabs can be used for speech output. */
export async function hasElevenKey(): Promise<boolean> {
  const desktop = typeof window !== 'undefined' ? window.orvex : undefined
  if (!desktop?.stt?.keys) return false
  try {
    const res = await desktop.stt.keys.list(`${ELEVEN_ORIGIN}/v1/speech-to-text`)
    return res.ok ? res.data.hasSingleKey || res.data.keys.length > 0 : false
  } catch {
    return false
  }
}

export type ElevenVoiceFetch = { ok: true; voices: ElevenVoice[] } | { ok: false; detail: string }

export async function fetchElevenVoices(): Promise<ElevenVoiceFetch> {
  const bridge = elevenBridge()
  if (!bridge?.elevenVoices) return { ok: false, detail: 'ElevenLabs voices need the desktop app.' }
  try {
    const res = await bridge.elevenVoices()
    if (!res.ok) return { ok: false, detail: res.error }
    return { ok: true, voices: res.data.voices }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

export type ElevenModelFetch = { ok: true; models: string[]; source: string } | { ok: false; detail: string }

export async function fetchElevenModels(): Promise<ElevenModelFetch> {
  const bridge = elevenBridge()
  if (!bridge?.elevenModels) return { ok: false, detail: 'ElevenLabs models need the desktop app.' }
  try {
    const res = await bridge.elevenModels()
    if (!res.ok) return { ok: false, detail: res.error }
    return { ok: true, models: res.data.models, source: res.data.source }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

/** "Rachel · american · young · female" — what the labels say, without the noise. */
export function voiceLabel(voice: ElevenVoice): string {
  const bits = [voice.name]
  const labels = voice.labels || {}
  for (const key of ['accent', 'gender', 'age', 'description', 'use_case']) {
    const value = String(labels[key] || '').trim()
    if (value) bits.push(value)
  }
  if (voice.category && voice.category !== 'premade') bits.push(voice.category)
  return bits.join(' · ')
}