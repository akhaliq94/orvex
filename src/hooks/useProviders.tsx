import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DEFAULT_PROVIDERS,
  loadProviders,
  saveProviders,
  type ProviderConfig,
  type ProviderState,
} from '../data/providers'

type Ctx = {
  providers: ProviderConfig[]
  activeId: string | null
  active: ProviderConfig | null
  setActiveId: (id: string | null) => void
  upsert: (p: ProviderConfig) => void
  /** merge fields into one provider — safe against stale async copies */
  patch: (id: string, fields: Partial<ProviderConfig>) => void
  remove: (id: string) => void
  reset: () => void
  /** delete the stored key for one provider */
  clearKey: (id: string) => void
  /** true when API keys live in the OS-encrypted store instead of localStorage */
  secureKeys: boolean
}

const ProvidersContext = createContext<Ctx | null>(null)

export function ProvidersProvider({ children }: { children: ReactNode }) {
  const desktop = typeof window !== 'undefined' ? window.orvex : undefined
  const [state, setState] = useState<ProviderState>(() => loadProviders())
  const [secure, setSecure] = useState(false)
  const [hydrated, setHydrated] = useState(!desktop)

  // Desktop: the vault reports which provider ids have a key, never the values.
  // Keys still sitting in localStorage from an earlier build are migrated once
  // (together with their endpoint binding), then stripped from the state.
  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    void (async () => {
      const res = await desktop.secrets.get()
      if (cancelled) return
      const available = res.ok && res.data.available
      const saved: Record<string, boolean> = available && res.ok ? { ...res.data.keys } : {}
      setSecure(available)
      if (available && res.ok) {
        for (const p of state.providers) {
          if (p.apiKey && !saved[p.id]) {
            const stored = await desktop.secrets.set(p.id, p.apiKey, p.baseUrl)
            if (stored.ok) saved[p.id] = true
          }
        }
      }
      if (cancelled) return
      setState((s) => ({
        ...s,
        providers: s.providers.map((p) => ({
          ...p,
          // A key only leaves memory once the vault confirmed it wrote it.
          apiKey: available && saved[p.id] ? '' : p.apiKey,
          hasKey: !!saved[p.id],
        })),
      }))
      setHydrated(true)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop])

  useEffect(() => {
    if (!hydrated) return
    const id = window.setTimeout(() => {
      void (async () => {
        if (desktop && secure) {
          const failed = new Set<string>()
          for (const p of state.providers) {
            if (!p.apiKey) continue
            const stored = await desktop.secrets.set(p.id, p.apiKey, p.baseUrl)
            if (!stored.ok) failed.add(p.id)
          }
          if (failed.size) {
            // The vault refused the key; keep it in the local store so the
            // provider still works and the user is not silently locked out.
            saveProviders({
              ...state,
              providers: state.providers.map((p) => (failed.has(p.id) ? p : { ...p, apiKey: '' })),
            })
          } else {
            saveProviders({ ...state, providers: state.providers.map((p) => ({ ...p, apiKey: '' })) })
          }
        } else {
          saveProviders(state)
        }
      })()
    }, 400)
    return () => window.clearTimeout(id)
  }, [state, hydrated, secure, desktop])

  const setActiveId = useCallback((id: string | null) => {
    setState((s) => ({ ...s, activeId: id }))
  }, [])

  const upsert = useCallback((p: ProviderConfig) => {
    setState((s) => {
      const idx = s.providers.findIndex((x) => x.id === p.id)
      const providers = idx >= 0
        ? s.providers.map((x) => (x.id === p.id ? p : x))
        : [...s.providers, p]
      return { ...s, providers }
    })
  }, [])

  const patch = useCallback((id: string, fields: Partial<ProviderConfig>) => {
    setState((s) => ({
      ...s,
      providers: s.providers.map((p) => (p.id === id ? { ...p, ...fields } : p)),
    }))
  }, [])

  const remove = useCallback((id: string) => {
    if (desktop && secure) void desktop.secrets.set(id, '')
    setState((s) => {
      const providers = s.providers.filter((x) => x.id !== id)
      const activeId = s.activeId === id ? (providers[0]?.id ?? null) : s.activeId
      return { ...s, providers, activeId }
    })
  }, [desktop, secure])

  const clearKey = useCallback((id: string) => {
    if (desktop && secure) void desktop.secrets.set(id, '')
    setState((s) => ({
      ...s,
      providers: s.providers.map((p) => (p.id === id ? { ...p, apiKey: '', hasKey: false } : p)),
    }))
  }, [desktop, secure])

  const reset = useCallback(() => {
    if (desktop && secure) {
      for (const p of state.providers) void desktop.secrets.set(p.id, '')
    }
    setState({ providers: DEFAULT_PROVIDERS, activeId: 'ollama' })
  }, [desktop, secure, state.providers])

  const active = useMemo(
    () => state.providers.find((p) => p.id === state.activeId) ?? null,
    [state.providers, state.activeId],
  )

  const value = useMemo<Ctx>(
    () => ({
      providers: state.providers,
      activeId: state.activeId,
      active,
      setActiveId,
      upsert,
      patch,
      remove,
      reset,
      clearKey,
      secureKeys: secure,
    }),
    [state.providers, state.activeId, active, setActiveId, upsert, patch, remove, reset, clearKey, secure],
  )

  return <ProvidersContext.Provider value={value}>{children}</ProvidersContext.Provider>
}

export function useProviders(): Ctx {
  const ctx = useContext(ProvidersContext)
  if (!ctx) throw new Error('useProviders must be used inside ProvidersProvider')
  return ctx
}
