/** Microphone enumeration, selection and hot-plug watching. */

export type MicDevice = { id: string; label: string; isDefault: boolean }

export type MicPrefs = { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean }

const UNSUPPORTED = 'This build cannot enumerate audio devices.'

export async function listMicrophones(): Promise<{ devices: MicDevice[]; error: string | null }> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return { devices: [], error: UNSUPPORTED }
  }
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    const inputs = all.filter((d) => d.kind === 'audioinput')
    const devices = inputs.map((d, i) => ({
      id: d.deviceId,
      label: d.label?.trim() || `Microphone ${i + 1}`,
      isDefault: d.deviceId === 'default' || i === 0,
    }))
    return { devices, error: devices.length ? null : 'No microphone was found. Plug one in and refresh.' }
  } catch (e) {
    return { devices: [], error: e instanceof Error ? e.message : 'Could not list audio devices.' }
  }
}

/** Keeps the saved choice when it still exists, otherwise falls back to the default. */
export function resolveMic(devices: MicDevice[], chosen: string): string | null {
  if (chosen && devices.some((d) => d.id === chosen)) return chosen
  return devices[0]?.id ?? null
}

export function micConstraints(deviceId: string | null, prefs: MicPrefs): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    echoCancellation: prefs.echoCancellation,
    noiseSuppression: prefs.noiseSuppression,
    autoGainControl: prefs.autoGainControl,
  }
  if (deviceId) audio.deviceId = { exact: deviceId }
  return { audio }
}

export function watchDevices(cb: () => void): () => void {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
  if (!md?.addEventListener) return () => undefined
  md.addEventListener('devicechange', cb)
  return () => md.removeEventListener('devicechange', cb)
}
