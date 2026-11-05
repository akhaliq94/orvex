/**
 * Conversation memory. Every chat turn is stored locally so the Memory Browser
 * can search, tag and replay past sessions.
 */

export type StoredMessage = {
  role: 'user' | 'assistant'
  text: string
  at: number
}

export type Conversation = {
  id: string
  title: string
  agentId: string
  providerId: string | null
  model: string
  tags: string[]
  createdAt: number
  updatedAt: number
  messages: StoredMessage[]
}

const KEY = 'orvex-conversations'

export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Conversation[]) : []
  } catch {
    return []
  }
}

export function saveConversations(list: Conversation[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 200)))
  } catch {
    /* quota — drop silently rather than break the chat */
  }
}

export function upsertConversation(list: Conversation[], conv: Conversation): Conversation[] {
  const idx = list.findIndex((c) => c.id === conv.id)
  const next = idx >= 0 ? list.map((c) => (c.id === conv.id ? conv : c)) : [conv, ...list]
  return next.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return 'Untitled conversation'
  return t.length > 58 ? `${t.slice(0, 58)}…` : t
}

export function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = Date.now()
  const diff = now - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
