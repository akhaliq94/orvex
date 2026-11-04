import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { writeJson } from '../data/storage'

export type BgKind = 'theme' | 'solid' | 'gradient' | 'image'

export type BackgroundConfig = {
  kind: BgKind
  /** solid colour */
  color: string
  /** gradient — two stops + angle */
  gradientA: string
  gradientB: string
  gradientAngle: number
  /** image: data URL (uploaded) or http(s) URL */
  image: string
  /** 0 = hidden, 1 = full strength */
  opacity: number
  /** backdrop blur in px */
  blur: number
  /** extra darkening veil 0..1 */
  veil: number
  /** keep theme's own gradient underneath */
  fit: 'cover' | 'contain' | 'repeat'
  position: string
}

export const DEFAULT_BACKGROUND: BackgroundConfig = {
  kind: 'theme',
  color: '#061426',
  gradientA: '#0a2340',
  gradientB: '#123c6b',
  gradientAngle: 150,
  image: '',
  opacity: 1,
  blur: 0,
  veil: 0,
  fit: 'cover',
  position: 'center',
}

const STORAGE_KEY = 'orvex-background'

export const PRESET_WALLPAPERS = [
  { id: 'grid', name: 'Neon Grid', kind: 'gradient' as const, a: '#071a33', b: '#0d3a63', angle: 160 },
  { id: 'purple', name: 'Purple Haze', kind: 'gradient' as const, a: '#1a0b33', b: '#3a1a6b', angle: 140 },
  { id: 'ember', name: 'Ember', kind: 'gradient' as const, a: '#2a0d08', b: '#6b2410', angle: 135 },
  { id: 'forest', name: 'Deep Forest', kind: 'gradient' as const, a: '#04140d', b: '#0b3320', angle: 155 },
  { id: 'mono', name: 'Carbon', kind: 'gradient' as const, a: '#0a0c11', b: '#1c2230', angle: 150 },
  { id: 'ice', name: 'Ice', kind: 'gradient' as const, a: '#0b1c2e', b: '#1d4a70', angle: 150 },
]

function load(): BackgroundConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_BACKGROUND }
    return { ...DEFAULT_BACKGROUND, ...(JSON.parse(raw) as Partial<BackgroundConfig>) }
  } catch {
    return { ...DEFAULT_BACKGROUND }
  }
}

type Ctx = {
  bg: BackgroundConfig
  setBg: (patch: Partial<BackgroundConfig>) => void
  reset: () => void
  /** CSS custom properties applied to the app root */
  style: React.CSSProperties
}

const BackgroundContext = createContext<Ctx | null>(null)

export function BackgroundProvider({ children }: { children: ReactNode }) {
  const [bg, setBgState] = useState<BackgroundConfig>(() => load())

  useEffect(() => {
    writeJson(STORAGE_KEY, bg)
  }, [bg])

  const setBg = useCallback((patch: Partial<BackgroundConfig>) => {
    setBgState((b) => ({ ...b, ...patch }))
  }, [])

  const reset = useCallback(() => setBgState({ ...DEFAULT_BACKGROUND }), [])

  const style = useMemo<React.CSSProperties>(() => {
    const out: Record<string, string> = {}
    if (bg.kind === 'solid') {
      out['--bg-image'] = bg.color
      out['--bg-size'] = 'cover'
      out['--bg-repeat'] = 'no-repeat'
    } else if (bg.kind === 'gradient') {
      out['--bg-image'] = `linear-gradient(${bg.gradientAngle}deg, ${bg.gradientA}, ${bg.gradientB})`
      out['--bg-size'] = 'cover'
      out['--bg-repeat'] = 'no-repeat'
    } else if (bg.kind === 'image' && bg.image) {
      out['--bg-image'] = `url("${bg.image}")`
      out['--bg-size'] = bg.fit
      out['--bg-repeat'] = bg.fit === 'repeat' ? 'repeat' : 'no-repeat'
    } else {
      out['--bg-image'] = 'none'
    }
    out['--bg-opacity'] = String(bg.opacity)
    out['--bg-blur'] = `${bg.blur}px`
    out['--bg-veil-alpha'] = String(bg.veil)
    out['--bg-position'] = bg.position
    return out as React.CSSProperties
  }, [bg])

  const value = useMemo<Ctx>(() => ({ bg, setBg, reset, style }), [bg, setBg, reset, style])

  return <BackgroundContext.Provider value={value}>{children}</BackgroundContext.Provider>
}

export function useBackground(): Ctx {
  const ctx = useContext(BackgroundContext)
  if (!ctx) throw new Error('useBackground must be used inside BackgroundProvider')
  return ctx
}
