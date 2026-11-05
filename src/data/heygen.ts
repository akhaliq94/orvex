/**
 * HeyGen Voice Turbo — cloud TTS.
 *
 * The key never reaches the renderer: it is stored in the OS vault bound to
 * https://api.heygen.com and attached in the main process.
 */

export type HeygenModel = 'heygen-voice-1' | 'heygen-voice-1-turbo' | 'heygen-voice-1-turbo-free'

export const HEYGEN_MODELS: { id: HeygenModel; name: string; note: string }[] = [
  { id: 'heygen-voice-1-turbo-free', name: 'Turbo (free tier)', note: 'Free until 2026-11-30 · may answer 429 under load' },
  { id: 'heygen-voice-1-turbo', name: 'Turbo', note: 'Paid · lowest latency' },
  { id: 'heygen-voice-1', name: 'Voice 1', note: 'Paid · standard quality' },
]

export type HeygenVoice = { voiceId: string; name: string; language: string; gender: string; preview: string }

const ORIGIN = 'https://api.heygen.com'

export function heygenBridge() {
  return typeof window !== 'undefined' ? window.orvex?.media : undefined
}

/** Presence only — the key value stays in the vault. */
export async function hasHeygenKey(): Promise<boolean> {
  const desktop = typeof window !== 'undefined' ? window.orvex : undefined
  if (!desktop?.secrets) return false
  try {
    const res = await desktop.secrets.get()
    return res.ok ? !!res.data.keys.heygen : false
  } catch {
    return false
  }
}

export async function saveHeygenKey(key: string): Promise<{ ok: boolean; detail: string }> {
  const desktop = typeof window !== 'undefined' ? window.orvex : undefined
  if (!desktop?.secrets) return { ok: false, detail: 'HeyGen needs the desktop app — the key is stored in the OS vault.' }
  try {
    const res = await desktop.secrets.set('heygen', key.trim(), ORIGIN)
    if (!res.ok) return { ok: false, detail: res.error }
    return { ok: true, detail: key.trim() ? 'HeyGen key stored in the OS-encrypted vault.' : 'HeyGen key cleared.' }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

export type VoiceFetch =
  | { ok: true; voices: HeygenVoice[] }
  | { ok: false; detail: string }

export async function fetchHeygenVoices(type: 'public' | 'private' = 'public'): Promise<VoiceFetch> {
  const bridge = heygenBridge()
  if (!bridge?.heygenVoices) return { ok: false, detail: 'HeyGen voices need the desktop app.' }
  try {
    const res = await bridge.heygenVoices({ type })
    if (!res.ok) return { ok: false, detail: res.error }
    return { ok: true, voices: res.data.voices }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}
