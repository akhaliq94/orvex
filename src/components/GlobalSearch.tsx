import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowRight,
  Brain,
  Clock3,
  CornerDownLeft,
  MessageSquare,
  Search,
  SquareTerminal,
  Users,
} from 'lucide-react'
import { NAV_ITEMS } from '../data/nav'
import { AGENT_PROFILES } from '../data/agents'
import { loadConversations } from '../data/memory'
import type { OrvexMemoryHit } from '../types/desktop'

export type PaletteCommand = {
  id: string
  title: string
  sub: string
  hint?: string
  run: () => void | Promise<void>
}

type HitKind = 'page' | 'tab' | 'agent' | 'conversation' | 'memory' | 'command'

type Hit = {
  id: string
  kind: HitKind
  title: string
  sub: string
  hint?: string
  run: () => void | Promise<void>
}

type Props = {
  open: boolean
  onClose: () => void
  onNavigate: (id: string, tab?: string) => void
  onOpenConversation: (convId: string) => void
  commands: PaletteCommand[]
}

const RECENT_KEY = 'orvex-palette-recents'
const RECENT_LIMIT = 5

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string').slice(0, RECENT_LIMIT) : []
  } catch {
    return []
  }
}

function rememberCommand(id: string) {
  try {
    const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_LIMIT)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* storage full — recents are optional */
  }
}

const KIND_ICON: Record<HitKind, JSX.Element> = {
  page: <ArrowRight size={12} />,
  tab: <ArrowRight size={12} />,
  agent: <Users size={12} />,
  conversation: <MessageSquare size={12} />,
  memory: <Brain size={12} />,
  command: <SquareTerminal size={12} />,
}

const KIND_LABEL: Record<HitKind, string> = {
  page: 'Pages',
  tab: 'Page tabs',
  agent: 'Agents',
  conversation: 'Conversations',
  memory: 'Memory',
  command: 'Commands',
}

/** Command palette: pages, every page tab, agents, conversations, memory and real actions. */
export default function GlobalSearch({ open, onClose, onNavigate, onOpenConversation, commands }: Props) {
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const [memory, setMemory] = useState<OrvexMemoryHit[]>([])
  const [memoryQuery, setMemoryQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const requestSeq = useRef(0)

  useEffect(() => {
    if (open) {
      setQ('')
      setCursor(0)
      setMemory([])
      setMemoryQuery('')
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const bridge = typeof window !== 'undefined' ? window.orvex : undefined

  useEffect(() => {
    const term = q.trim()
    if (!open || !bridge?.memory || term.length < 3) {
      setMemory([])
      setMemoryQuery('')
      return
    }
    const seq = ++requestSeq.current
    const t = window.setTimeout(() => {
      void bridge.memory.search(term, { limit: 5 }).then((res) => {
        if (seq !== requestSeq.current) return
        setMemory(res.ok ? res.data : [])
        setMemoryQuery(term)
      })
    }, 220)
    return () => window.clearTimeout(t)
  }, [q, open, bridge?.memory])

  const hits = useMemo<Hit[]>(() => {
    const term = q.trim().toLowerCase()
    const matches = (text: string) => !term || text.toLowerCase().includes(term)
    const out: Hit[] = []
    const seen = new Set<string>()
    // The recents block repeats commands that also match below — keep one row
    // per id so the same action is not listed (and runnable) twice.
    const add = (hit: Hit) => {
      if (seen.has(hit.id)) return
      seen.add(hit.id)
      out.push(hit)
    }

    if (!term) {
      const byId = new Map(commands.map((c) => [c.id, c]))
      for (const id of readRecent()) {
        const c = byId.get(id)
        if (c) add({ id: `c-${c.id}`, kind: 'command', title: c.title, sub: c.sub, hint: c.hint, run: c.run })
      }
    }

    for (const c of commands) {
      if (!matches(`${c.title} ${c.sub} ${c.hint ?? ''}`)) continue
      add({ id: `c-${c.id}`, kind: 'command', title: c.title, sub: c.sub, hint: c.hint, run: c.run })
    }

    for (const n of NAV_ITEMS) {
      if (!matches(n.label)) continue
      add({
        id: `p-${n.id}`,
        kind: 'page',
        title: n.label,
        sub: 'Page',
        run: () => onNavigate(n.id),
      })
    }

    for (const n of NAV_ITEMS) {
      for (const s of n.submenu ?? []) {
        if (!matches(`${n.label} ${s.label} ${s.tab}`)) continue
        add({
          id: `t-${n.id}-${s.tab}`,
          kind: 'tab',
          title: `${n.label} · ${s.label}`,
          sub: 'Page tab',
          run: () => onNavigate(n.id, s.tab),
        })
      }
    }

    for (const a of AGENT_PROFILES) {
      if (!matches(`${a.name} ${a.role}`)) continue
      add({ id: `a-${a.id}`, kind: 'agent', title: a.name, sub: a.role, run: () => onNavigate('agents') })
    }

    if (term) {
      for (const c of loadConversations()) {
        if (!matches(c.title)) continue
        add({
          id: `conv-${c.id}`,
          kind: 'conversation',
          title: c.title,
          sub: 'Conversation',
          run: () => onOpenConversation(c.id),
        })
      }
    }

    if (term && memoryQuery === q.trim()) {
      for (const m of memory) {
        add({
          id: `m-${m.id}`,
          kind: 'memory',
          title: m.text.replace(/\s+/g, ' ').slice(0, 90),
          sub: `${m.kind} memory`,
          run: () => onNavigate('memory'),
        })
      }
    }

    // Commands first when searching by exact action name, otherwise keep the
    // natural page → tab → agent → conversation → memory order.
    return out.slice(0, 40)
  }, [q, commands, memory, memoryQuery, onNavigate, onOpenConversation])

  useEffect(() => {
    setCursor(0)
  }, [q])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'Tab') {
        // The palette is modal: focus must not escape behind the overlay.
        const root = panelRef.current
        if (!root) return
        const focusables = Array.from(root.querySelectorAll<HTMLElement>('input, button, a[href], [tabindex]:not([tabindex="-1"])'))
        if (focusables.length === 0) {
          e.preventDefault()
          return
        }
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement
        if (e.shiftKey) {
          if (active === first || !root.contains(active)) {
            e.preventDefault()
            last.focus()
          }
        } else if (active === last || !root.contains(active)) {
          e.preventDefault()
          first.focus()
        }
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor((c) => Math.min(hits.length - 1, c + 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor((c) => Math.max(0, c - 1))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const h = hits[cursor]
        if (h) {
          if (h.kind === 'command') rememberCommand(h.id.replace(/^c-/, ''))
          void h.run()
          onClose()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, hits, cursor, onClose])

  if (!open) return null

  const grouped = hits.reduce<{ kind: HitKind; items: Hit[] }[]>((acc, hit) => {
    const last = acc[acc.length - 1]
    if (last && last.kind === hit.kind) last.items.push(hit)
    else acc.push({ kind: hit.kind, items: [hit] })
    return acc
  }, [])

  let index = -1

  return createPortal(
    <div className="gs-overlay" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className="gs-panel panel"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="gs-inputrow">
          <Search size={15} style={{ color: 'var(--faint)' }} />
          <input
            ref={inputRef}
            className="gs-input"
            placeholder="Search pages, tabs, agents, memory or type a command…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Command palette query"
          />
          <kbd className="gs-kbd">Esc</kbd>
        </div>
        <div className="gs-results">
          {hits.length === 0 && <p className="gs-empty">No matches for “{q}”.</p>}
          {grouped.map((group) => (
            <div key={group.kind} className="gs-group">
              <div className="gs-group-head">{KIND_LABEL[group.kind]}</div>
              {group.items.map((h) => {
                index += 1
                const i = index
                return (
                  <button
                    key={h.id}
                    className={`gs-hit ${i === cursor ? 'active' : ''}`}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => {
                      if (h.kind === 'command') rememberCommand(h.id.replace(/^c-/, ''))
                      void h.run()
                      onClose()
                    }}
                  >
                    <span className="gs-ico">{KIND_ICON[h.kind]}</span>
                    <span className="gs-hit-title">{h.title}</span>
                    {h.hint && <span className="gs-hint">{h.hint}</span>}
                    <span className="gs-hit-sub">{h.sub}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        <div className="gs-foot">
          <span><CornerDownLeft size={10} /> open</span>
          <span><Clock3 size={10} /> recents</span>
          <span className="gs-count">{hits.length} results</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
