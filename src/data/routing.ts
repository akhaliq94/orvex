/**
 * Task → model-chain routing shared by Chat, Engine and Settings.
 * The desktop app persists the official copy in SQLite; localStorage mirrors it
 * so this module stays synchronous for the send path and works in browser dev.
 */

import type { OrvexAgentProvider, OrvexRouteRef } from '../types/desktop'
import type { ProviderConfig } from './providers'

export type TaskId = 'agent' | 'chat' | 'code' | 'research' | 'memory' | 'summarize' | 'vision' | 'plan' | 'media'

export const TASKS: { id: TaskId; label: string; hint: string }[] = [
  { id: 'agent', label: 'Agent runs', hint: 'Goals executed with tools in the main process.' },
  { id: 'chat', label: 'Chat', hint: 'Plain conversation replies streamed through the gateway.' },
  { id: 'code', label: 'Coding', hint: 'Code generation, review and repair tasks.' },
  { id: 'research', label: 'Research', hint: 'Web reading, extraction and report writing.' },
  { id: 'memory', label: 'Memory Q&A', hint: 'Answers grounded in your stored memories.' },
  { id: 'summarize', label: 'Summarize', hint: 'Tool-output compression and context compaction.' },
  { id: 'vision', label: 'Vision', hint: 'Screenshot and image understanding steps.' },
  { id: 'plan', label: 'Planning', hint: 'Task decomposition and step planning.' },
  { id: 'media', label: 'Media', hint: 'Image, video and speech generation calls.' },
]

export const ROUTING_KEY = 'orvex-routing'

export type RouteMap = Partial<Record<TaskId, OrvexRouteRef[]>>

export function loadRoutes(): RouteMap {
  try {
    const raw = localStorage.getItem(ROUTING_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as RouteMap
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function saveRoutesLocal(routes: RouteMap) {
  try {
    localStorage.setItem(ROUTING_KEY, JSON.stringify(routes))
  } catch {
    /* the in-memory route still applies for this session */
  }
}

export function toCandidate(p: ProviderConfig): OrvexAgentProvider {
  return {
    id: p.id,
    presetId: p.presetId,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    api: p.api,
    model: p.model,
  }
}

function usable(p: ProviderConfig) {
  return p.enabled && !!p.baseUrl && !!p.model
}

/**
 * Every model ORVEX may fail over to for a run: the active provider first, then
 * enabled local servers and keyed hosted providers. Keyless hosted providers are
 * skipped as fallbacks because they can only fail with a 401.
 */
export function buildCandidates(providers: ProviderConfig[], activeId: string | null): OrvexAgentProvider[] {
  const active = providers.find((p) => p.id === activeId) ?? null
  const out: ProviderConfig[] = []
  if (active && active.baseUrl && active.model) out.push(active)
  for (const p of providers) {
    if (p.id === active?.id) continue
    if (!usable(p)) continue
    if (p.kind !== 'local' && !p.apiKey && !p.hasKey) continue
    out.push(p)
  }
  return out.map(toCandidate)
}

/** The local model used for hybrid compression, kept separate from the main chain. */
export function pickLocal(providers: ProviderConfig[], activeId: string | null): OrvexAgentProvider | null {
  const p = providers.find((x) => x.id !== activeId && x.enabled && x.kind === 'local' && x.baseUrl && x.model)
  return p ? toCandidate(p) : null
}

/** Re-order candidates using the saved route for a task; unmatched entries stay at the end. */
export function orderForTask<T extends { id?: string; presetId?: string; model?: string }>(candidates: T[], task: TaskId): T[] {
  const refs = loadRoutes()[task]
  if (!Array.isArray(refs) || !refs.length) return candidates
  const pick: T[] = []
  for (const ref of refs) {
    const id = String(ref.id || ref.providerId || ref.presetId || '')
    const model = ref.model ? String(ref.model) : ''
    const match = candidates.find((c) => String(c.id || c.presetId || '') === id && (!model || String(c.model) === model) && !pick.includes(c))
    if (match) pick.push(match)
  }
  return pick.length ? [...pick, ...candidates.filter((c) => !pick.includes(c))] : candidates
}

export function routeLabel(ref: OrvexRouteRef, candidates: { id?: string; presetId?: string; name?: string; model?: string }[]): string {
  const id = String(ref.id || ref.providerId || ref.presetId || '')
  const found = candidates.find((c) => String(c.id || c.presetId || '') === id && (!ref.model || c.model === ref.model))
  if (found) return `${found.name || id} · ${found.model || ref.model || ''}`
  return ref.name ? `${ref.name}${ref.model ? ` · ${ref.model}` : ''}` : `${id}${ref.model ? ` · ${ref.model}` : ''}`
}

/** Persist one task's chain locally and, in the desktop app, to the gateway DB. */
export async function persistRoute(task: TaskId, chain: OrvexRouteRef[]): Promise<{ ok: boolean; error?: string }> {
  const next = { ...loadRoutes(), [task]: chain }
  saveRoutesLocal(next)
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  if (!bridge?.routing) return { ok: true }
  const res = await bridge.routing.set(task, chain)
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

export async function clearServerRoute(task: TaskId): Promise<void> {
  saveRoutesLocal({ ...loadRoutes(), [task]: [] })
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  if (bridge?.routing) await bridge.routing.clear(task)
}
