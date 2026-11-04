/**
 * Speaker identification from a short recording.
 *
 * This is a compact timbre fingerprint — log-energy across 24 mel-spaced bands
 * (mean and spread over voiced frames) plus pitch statistics. It is not a
 * neural speaker-embedding model, and the UI says so: it distinguishes voices
 * recorded through the same microphone, it does not claim forensic accuracy.
 */

const FRAME = 1024
const HOP = 512
const BANDS = 24
const MIN_RMS = 0.006

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let j = 0; j < len / 2; j++) {
        const aRe = re[i + j]
        const aIm = im[i + j]
        const bRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm
        const bIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe
        re[i + j] = aRe + bRe
        im[i + j] = aIm + bIm
        re[i + j + len / 2] = aRe - bRe
        im[i + j + len / 2] = aIm - bIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700)
const melToHz = (mel: number) => 700 * (10 ** (mel / 2595) - 1)

function bandEdges(sampleRate: number): number[] {
  const low = 80
  const high = Math.min(7600, (sampleRate / 2) * 0.95)
  const loMel = hzToMel(low)
  const hiMel = hzToMel(high)
  const bins: number[] = []
  for (let i = 0; i <= BANDS + 1; i++) {
    const hz = melToHz(loMel + ((hiMel - loMel) * i) / (BANDS + 1))
    bins.push(Math.round((hz / sampleRate) * FRAME))
  }
  return bins
}

function framePitch(frame: Float32Array, sampleRate: number): number | null {
  let energy = 0
  for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i]
  if (energy / frame.length < MIN_RMS * MIN_RMS) return null
  const minLag = Math.max(2, Math.floor(sampleRate / 400))
  const maxLag = Math.min(frame.length - 2, Math.ceil(sampleRate / 70))
  let bestLag = 0
  let best = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    for (let i = 0; i + lag < frame.length; i++) sum += frame[i] * frame[i + lag]
    const norm = sum / (frame.length - lag)
    if (norm > best) {
      best = norm
      bestLag = lag
    }
  }
  if (!bestLag || best / (energy / frame.length) < 0.25) return null
  return sampleRate / bestLag
}

/**
 * Returns a 50-dimension fingerprint, or [] when the clip has too little voiced
 * audio to describe a voice.
 */
export function extractFeatures(samples: Float32Array, sampleRate: number): number[] {
  if (!samples.length || !Number.isFinite(sampleRate) || sampleRate < 4000) return []
  const bins = bandEdges(sampleRate)
  const bandMean = new Array<number>(BANDS).fill(0)
  const bandSq = new Array<number>(BANDS).fill(0)
  const pitches: number[] = []
  let frames = 0

  const window = new Float32Array(FRAME)
  for (let i = 0; i < FRAME; i++) window[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1))

  for (let start = 0; start + FRAME <= samples.length; start += HOP) {
    let rms = 0
    for (let i = 0; i < FRAME; i++) rms += samples[start + i] * samples[start + i]
    rms = Math.sqrt(rms / FRAME)
    if (rms < MIN_RMS) continue

    const frame = samples.subarray(start, start + FRAME)
    const pitch = framePitch(frame, sampleRate)
    if (pitch) pitches.push(pitch)

    const re = new Float64Array(FRAME)
    const im = new Float64Array(FRAME)
    for (let i = 0; i < FRAME; i++) re[i] = frame[i] * window[i]
    fft(re, im)

    const values = new Array<number>(BANDS)
    for (let b = 0; b < BANDS; b++) {
      let energy = 0
      for (let k = bins[b]; k <= bins[b + 1]; k++) energy += re[k] * re[k] + im[k] * im[k]
      values[b] = Math.log10(energy + 1e-9)
    }
    let mean = 0
    for (const v of values) mean += v
    mean /= BANDS
    for (let b = 0; b < BANDS; b++) {
      const v = values[b] - mean
      bandMean[b] += v
      bandSq[b] += v * v
    }
    frames++
  }

  if (frames < 2) return []
  const vector: number[] = []
  for (let b = 0; b < BANDS; b++) vector.push(bandMean[b] / frames)
  for (let b = 0; b < BANDS; b++) vector.push(Math.sqrt(Math.max(0, bandSq[b] / frames)))
  if (pitches.length) {
    const mean = pitches.reduce((a, b) => a + b, 0) / pitches.length
    const variance = pitches.reduce((a, b) => a + (b - mean) * (b - mean), 0) / pitches.length
    vector.push(mean / 1000, Math.sqrt(variance) / 500)
  } else {
    vector.push(0, 0)
  }
  return l2(vector)
}

function l2(v: number[]): number[] {
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm)
  return norm > 1e-9 ? v.map((x) => x / norm) : []
}

export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return Math.max(-1, Math.min(1, dot))
}

export type SpeakerProfile = { id: string; name: string; vector: number[]; createdAt: number; clips: number }

export function mergeVector(prev: number[], next: number[], prevClips = 1): number[] {
  if (!prev.length) return next.slice()
  if (!next.length) return prev.slice()
  const total = prevClips + 1
  const mixed = prev.map((v, i) => (v * prevClips + (next[i] ?? 0)) / total)
  return l2(mixed)
}

export function identify(
  vector: number[],
  profiles: SpeakerProfile[],
  threshold = 0.8,
): { profile: SpeakerProfile; score: number } | null {
  let best: SpeakerProfile | null = null
  let bestScore = -Infinity
  for (const p of profiles) {
    const score = cosine(vector, p.vector)
    if (score > bestScore) {
      best = p
      bestScore = score
    }
  }
  return best && bestScore >= threshold ? { profile: best, score: bestScore } : null
}

const STORAGE = 'orvex-speaker-profiles'

export function loadProfiles(): SpeakerProfile[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE)
    const list = raw ? (JSON.parse(raw) as SpeakerProfile[]) : []
    return Array.isArray(list) ? list.filter((p) => p && Array.isArray(p.vector) && p.vector.length) : []
  } catch {
    return []
  }
}

export function saveProfiles(list: SpeakerProfile[]) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE, JSON.stringify(list))
  } catch {
    /* quota — the profile stays in memory for this session */
  }
}

export function addProfile(name: string, vector: number[]): SpeakerProfile[] {
  const clean = name.trim() || 'Speaker'
  const list = loadProfiles()
  const existing = list.find((p) => p.name.toLowerCase() === clean.toLowerCase())
  if (existing) {
    existing.vector = mergeVector(existing.vector, vector, existing.clips)
    existing.clips += 1
  } else {
    list.unshift({
      id: `spk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: clean,
      vector,
      createdAt: Date.now(),
      clips: 1,
    })
  }
  saveProfiles(list)
  return list
}

export function removeProfile(id: string): SpeakerProfile[] {
  const list = loadProfiles().filter((p) => p.id !== id)
  saveProfiles(list)
  return list
}

/** Renderer-only: decode a recorded clip to mono samples and fingerprint it. */
export async function vectorFromBlob(blob: Blob): Promise<number[]> {
  const Ctx =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) return []
  const ctx = new Ctx()
  try {
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer())
    const mono = new Float32Array(buffer.length)
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch)
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels
    }
    return extractFeatures(mono, buffer.sampleRate)
  } catch {
    return []
  } finally {
    void ctx.close().catch(() => undefined)
  }
}
