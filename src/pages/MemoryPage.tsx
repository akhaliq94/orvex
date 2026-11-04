import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Brain,
  Clock,
  Database,
  Download,
  Link2,
  Loader2,
  Pin,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import PageShell from './PageShell'
import { useProviders } from '../hooks/useProviders'
import { buildCandidates, orderForTask } from '../data/routing'
import type {
  OrvexMemoryConflict,
  OrvexMemoryHit,
  OrvexMemoryItem,
  OrvexMemoryProfile,
  OrvexMemoryRagResult,
  OrvexMemoryStats,
} from '../types/desktop'

type Props = { onBack: () => void; notify: (msg: string) => void }

type View = 'active' | 'pinned' | 'all'

type Draft = {
  id: string | null
  text: string
  kind: string
  project: string
  tags: string
  importance: number
  pinned: boolean
  expires: string
}

const bridge = typeof window !== 'undefined' ? window.orvex : undefined
const memoryApi = bridge?.memory
const KINDS = ['fact', 'preference', 'project', 'person', 'procedure', 'event', 'insight', 'legacy']
const EMPTY_PROFILE: OrvexMemoryProfile = {
  name: '',
  role: '',
  language: '',
  timezone: '',
  locations: '',
  notes: '',
  updatedAt: null,
}

function toDateInput(ts: number | null) {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function formatDate(ts: number | null) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function splitTags(raw: string) {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

function draftFor(item: OrvexMemoryItem | null, fallbackProject = ''): Draft {
  return {
    id: item?.id ?? null,
    text: item?.text ?? '',
    kind: item?.kind ?? 'fact',
    project: item?.project ?? fallbackProject,
    tags: item?.tags.join(', ') ?? '',
    importance: item?.importance ?? 0.5,
    pinned: item?.pinned ?? false,
    expires: toDateInput(item?.expiresAt ?? null),
  }
}

export default function MemoryPage({ onBack, notify }: Props) {
  const { providers, activeId } = useProviders()
  const [stats, setStats] = useState<OrvexMemoryStats | null>(null)
  const [items, setItems] = useState<OrvexMemoryItem[]>([])
  const [hits, setHits] = useState<OrvexMemoryHit[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [kind, setKind] = useState('')
  const [project, setProject] = useState('')
  const [view, setView] = useState<View>('active')
  const [selected, setSelected] = useState<OrvexMemoryItem | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [links, setLinks] = useState<(OrvexMemoryItem & { score: number })[]>([])
  const [conflicts, setConflicts] = useState<OrvexMemoryConflict[]>([])
  const [profile, setProfile] = useState<OrvexMemoryProfile>(EMPTY_PROFILE)
  const [profileDraft, setProfileDraft] = useState<OrvexMemoryProfile>(EMPTY_PROFILE)
  const [profileDirty, setProfileDirty] = useState(false)
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [rag, setRag] = useState<OrvexMemoryRagResult | null>(null)
  const [mergeFor, setMergeFor] = useState<{ id: string; text: string } | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 220)
    return () => window.clearTimeout(timer)
  }, [query])

  const loadLinks = useCallback(async (id: string) => {
    if (!memoryApi) return
    const res = await memoryApi.links(id, 6)
    setLinks(res.ok ? res.data : [])
  }, [])

  const refresh = useCallback(async () => {
    if (!memoryApi) return
    setLoading(true)
    try {
      const [s, prof, conf] = await Promise.all([memoryApi.stats(), memoryApi.profile(), memoryApi.conflicts('open')])
      if (s.ok) setStats(s.data)
      if (prof.ok) {
        setProfile(prof.data)
        if (!profileDirty) setProfileDraft(prof.data)
      }
      if (conf.ok) setConflicts(conf.data)
      const filters = { kind: kind || undefined, project: project || undefined }
      if (debounced.trim()) {
        const res = await memoryApi.search(debounced.trim(), { ...filters, limit: 100 })
        if (res.ok) setHits(res.data)
        setItems([])
      } else {
        const res = await memoryApi.list({
          ...filters,
          status: view === 'all' ? 'all' : 'active',
          pinned: view === 'pinned' ? true : undefined,
          limit: 200,
        })
        if (res.ok) setItems(res.data)
        setHits(null)
      }
    } finally {
      setLoading(false)
    }
  }, [kind, project, view, debounced, profileDirty])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const selectItem = (item: OrvexMemoryItem) => {
    setSelected(item)
    setDraft(draftFor(item, project))
    setMergeFor(null)
    void loadLinks(item.id)
  }

  const newDraft = () => {
    setSelected(null)
    setLinks([])
    setDraft(draftFor(null, project))
  }

  const patchDraft = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d))

  const save = async () => {
    if (!memoryApi || !draft) return
    const text = draft.text.trim()
    if (!text) {
      notify('Write something to remember first.')
      return
    }
    setBusy(true)
    const payload = {
      text,
      kind: draft.kind,
      project: draft.project,
      tags: splitTags(draft.tags),
      importance: draft.importance,
      pinned: draft.pinned,
      expiresAt: draft.expires ? new Date(`${draft.expires}T23:59:59`).getTime() : null,
    }
    const res = draft.id
      ? await memoryApi.update(draft.id, payload)
      : await memoryApi.add({ ...payload, source: 'user' })
    setBusy(false)
    if (!res.ok) {
      notify(res.error)
      return
    }
    const saved = res.data
    const duplicate = 'duplicate' in saved && saved.duplicate
    notify(draft.id ? 'Memory updated.' : duplicate ? 'Already remembered — importance raised.' : 'Memory saved.')
    setSelected(saved)
    setDraft(draftFor(saved, project))
    await refresh()
    await loadLinks(saved.id)
  }

  const removeSelected = async () => {
    if (!memoryApi || !draft?.id) return
    setBusy(true)
    const res = await memoryApi.remove(draft.id)
    setBusy(false)
    if (!res.ok) {
      notify(res.error)
      return
    }
    notify('Memory deleted.')
    setSelected(null)
    setDraft(null)
    setLinks([])
    setRag(null)
    await refresh()
  }

  const restoreSelected = async () => {
    if (!memoryApi || !draft?.id) return
    const res = await memoryApi.update(draft.id, { status: 'active' })
    if (!res.ok) {
      notify(res.error)
      return
    }
    setSelected(res.data)
    setDraft(draftFor(res.data, project))
    notify('Memory restored.')
    await refresh()
  }

  const importNotes = async () => {
    if (!memoryApi) return
    setBusy(true)
    const res = await memoryApi.importLegacy()
    setBusy(false)
    if (!res.ok) {
      notify(res.error)
      return
    }
    const { imported, skipped, unchanged } = res.data
    notify(unchanged ? 'Notes already imported.' : `Imported ${imported} note${imported === 1 ? '' : 's'}${skipped ? ` (${skipped} already present)` : ''}.`)
    await refresh()
  }

  const sweepExpired = async () => {
    if (!memoryApi) return
    const res = await memoryApi.sweep()
    if (!res.ok) {
      notify(res.error)
      return
    }
    notify(res.data.expired ? `Expired ${res.data.expired} memory item${res.data.expired === 1 ? '' : 's'}.` : 'Nothing has expired.')
    await refresh()
  }

  const ask = async () => {
    if (!memoryApi) return
    const q = question.trim()
    if (!q) {
      notify('Ask a question first.')
      return
    }
    setAsking(true)
    setRag(null)
    const candidates = orderForTask(buildCandidates(providers, activeId), 'memory')
    const res = await memoryApi.ask({ question: q, candidates, project: project || undefined, limit: 8 })
    setAsking(false)
    if (!res.ok) {
      notify(res.error)
      return
    }
    setRag(res.data)
    const top = res.data.hits[0]
    if (top) selectItem(top)
  }

  const saveProfile = async () => {
    if (!memoryApi) return
    setBusy(true)
    const res = await memoryApi.saveProfile({
      name: profileDraft.name,
      role: profileDraft.role,
      language: profileDraft.language,
      timezone: profileDraft.timezone,
      locations: profileDraft.locations,
      notes: profileDraft.notes,
    })
    setBusy(false)
    if (!res.ok) {
      notify(res.error)
      return
    }
    setProfile(res.data)
    setProfileDraft(res.data)
    setProfileDirty(false)
    notify('Profile saved.')
    await refresh()
  }

  const patchProfile = (patch: Partial<OrvexMemoryProfile>) => {
    setProfileDraft((p) => ({ ...p, ...patch }))
    setProfileDirty(true)
  }

  const resolve = async (conflict: OrvexMemoryConflict, action: 'keep_a' | 'keep_b' | 'merge' | 'dismiss') => {
    if (!memoryApi) return
    const mergedText = action === 'merge' ? mergeFor?.text : undefined
    setBusy(true)
    const res = await memoryApi.resolve(conflict.id, action, mergedText)
    setBusy(false)
    if (!res.ok) {
      notify(res.error)
      return
    }
    setMergeFor(null)
    notify(action === 'dismiss' ? 'Conflict dismissed.' : 'Conflict resolved.')
    await refresh()
    if (selected) {
      const item = await memoryApi.item(selected.id)
      if (item.ok) {
        setSelected(item.data)
        setDraft(draftFor(item.data, project))
        if (item.data.status !== 'active') {
          setSelected(null)
          setDraft(null)
          setLinks([])
        }
      }
    }
  }

  const display = useMemo(() => (hits ? hits : items), [hits, items])
  const showSearchScores = hits !== null
  const profileUpdated = profile.updatedAt

  return (
    <PageShell
      title="Memory"
      sub="Structured long-term memory — hybrid search, conflicts, expiry and grounded answers"
      onBack={onBack}
      actions={
        <>
          <button className="page-tool-btn" onClick={importNotes} disabled={!memoryApi || busy} title="Import legacy notes" aria-label="Import legacy notes">
            <Download size={14} />
          </button>
          <button className="page-tool-btn" onClick={sweepExpired} disabled={!memoryApi} title="Expire old memories" aria-label="Expire old memories">
            <Clock size={14} />
          </button>
          <button className="page-tool-btn" onClick={newDraft} disabled={!memoryApi} title="New memory" aria-label="New memory">
            <Plus size={14} />
          </button>
        </>
      }
    >
      {!memoryApi && (
        <div className="memory-banner">
          <AlertTriangle size={14} />
          <div>
            <strong>Browser mode.</strong> Memory lives in the desktop app&apos;s SQLite database. Run <code>npm run desktop:dev</code> to use it.
          </div>
        </div>
      )}

      <div className="memory-page">
        <div className="memory-stats">
          <div className="memory-stat">
            <span>Active</span>
            <b>{stats?.active ?? '—'}</b>
          </div>
          <div className="memory-stat">
            <span>Pinned</span>
            <b>{stats?.pinned ?? '—'}</b>
          </div>
          <div className="memory-stat">
            <span>Projects</span>
            <b>{stats?.projects.length ?? '—'}</b>
          </div>
          <div className={`memory-stat ${stats?.conflicts ? 'warn' : ''}`}>
            <span>Conflicts</span>
            <b>{stats?.conflicts ?? '—'}</b>
          </div>
          <div className={`memory-stat ${stats?.expiring ? 'warn' : ''}`}>
            <span>Expiring 7d</span>
            <b>{stats?.expiring ?? '—'}</b>
          </div>
          <div className="memory-stat">
            <span>Links</span>
            <b>{stats?.links ?? '—'}</b>
          </div>
        </div>

        <div className="memory-grid">
          <section className="panel memory-list-panel">
            <div className="memory-list-head">
              <Brain size={13} />
              <span>Memories</span>
              <span className="memory-count">{loading ? '…' : display.length}</span>
            </div>
            <div className="memory-filters">
              <label className="memory-search">
                <Search size={12} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Hybrid search…"
                  aria-label="Search memories"
                />
                {query && (
                  <button onClick={() => setQuery('')} aria-label="Clear search" title="Clear search">
                    <X size={11} />
                  </button>
                )}
              </label>
              <select className="select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by kind">
                <option value="">All kinds</option>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <select
                className="select"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                aria-label="Filter by project"
              >
                <option value="">All projects</option>
                {(stats?.projects ?? []).map((p) => (
                  <option key={p.project} value={p.project}>
                    {p.project || 'general'} ({p.count})
                  </option>
                ))}
              </select>
              {!query && (
                <div className="memory-view-tabs">
                  {(['active', 'pinned', 'all'] as View[]).map((v) => (
                    <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
                      {v === 'all' ? 'All' : v === 'pinned' ? 'Pinned' : 'Active'}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="memory-list">
              {display.length === 0 && (
                <p className="dim memory-empty">{loading ? 'Loading…' : debounced ? 'No memories matched that search.' : 'No memories yet — hit + or ask the agent to remember something.'}</p>
              )}
              {display.map((item) => (
                <button
                  key={item.id}
                  className={`memory-item ${selected?.id === item.id ? 'selected' : ''}`}
                  onClick={() => selectItem(item)}
                >
                  <span className="memory-item-head">
                    <span className="memory-kind">{item.kind}</span>
                    {item.pinned && <Pin size={9} />}
                    {item.project && <span className="memory-project">{item.project}</span>}
                    {showSearchScores && 'score' in item && (
                      <span className="memory-score">{Math.round((item as OrvexMemoryHit).score * 100)}%</span>
                    )}
                    <span className="memory-item-date">{formatDate(item.updatedAt)}</span>
                  </span>
                  <span className="memory-item-text">{item.text}</span>
                  {item.tags.length > 0 && (
                    <span className="memory-item-tags">
                      {item.tags.map((tag) => (
                        <span key={tag}>#{tag}</span>
                      ))}
                    </span>
                  )}
                  {item.status !== 'active' && <span className="memory-status">{item.status}</span>}
                </button>
              ))}
            </div>
          </section>

          <section className="panel memory-detail">
            {draft ? (
              <>
                <div className="memory-detail-head">
                  <Database size={13} />
                  <span>{draft.id ? 'Edit memory' : 'New memory'}</span>
                  {selected && selected.status !== 'active' && (
                    <>
                      <span className="chip warn">{selected.status}</span>
                      <button className="btn-ghost memory-restore" onClick={restoreSelected}>
                        Restore
                      </button>
                    </>
                  )}
                </div>
                <div className="memory-detail-body">
                  <textarea
                    className="memory-textarea"
                    value={draft.text}
                    onChange={(e) => patchDraft({ text: e.target.value })}
                    placeholder="What should ORVEX remember?"
                    aria-label="Memory text"
                  />
                  <div className="memory-form-row">
                    <label className="memory-field">
                      <span>Kind</span>
                      <select className="select" value={draft.kind} onChange={(e) => patchDraft({ kind: e.target.value })}>
                        {KINDS.map((k) => (
                          <option key={k} value={k}>
                            {k}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="memory-field">
                      <span>Project</span>
                      <input
                        className="text-input"
                        value={draft.project}
                        onChange={(e) => patchDraft({ project: e.target.value })}
                        placeholder="general"
                      />
                    </label>
                    <label className="memory-field">
                      <span>Importance · {Math.round(draft.importance * 100)}%</span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={draft.importance}
                        onChange={(e) => patchDraft({ importance: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                  <div className="memory-form-row">
                    <label className="memory-field memory-field-wide">
                      <span>Tags (comma separated)</span>
                      <input
                        className="text-input"
                        value={draft.tags}
                        onChange={(e) => patchDraft({ tags: e.target.value })}
                        placeholder="workflow, preferences"
                      />
                    </label>
                    <label className="memory-field">
                      <span>Expires</span>
                      <input
                        className="text-input"
                        type="date"
                        value={draft.expires}
                        onChange={(e) => patchDraft({ expires: e.target.value })}
                      />
                    </label>
                    <label className="memory-pin">
                      <input
                        type="checkbox"
                        checked={draft.pinned}
                        onChange={(e) => patchDraft({ pinned: e.target.checked })}
                      />
                      <Pin size={11} /> Pinned
                    </label>
                  </div>

                  {selected && (
                    <div className="memory-meta">
                      <span>{selected.source || 'user'}</span>
                      <span>created {formatDate(selected.createdAt)}</span>
                      <span>updated {formatDate(selected.updatedAt)}</span>
                      <span>recalled {selected.useCount}×</span>
                      {selected.expiresAt && <span>expires {formatDate(selected.expiresAt)}</span>}
                    </div>
                  )}

                  {links.length > 0 && (
                    <div className="memory-links">
                      <span className="memory-links-label">
                        <Link2 size={11} /> Related
                      </span>
                      {links.map((link) => (
                        <button key={link.id} className="memory-link-chip" onClick={() => selectItem(link)} title={link.text}>
                          {link.text.length > 48 ? `${link.text.slice(0, 48)}…` : link.text}
                          <span>{Math.round(link.score * 100)}%</span>
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="memory-actions">
                    <button className="btn-primary" onClick={save} disabled={busy || !draft.text.trim()}>
                      <Save size={12} /> Save
                    </button>
                    {draft.id && (
                      <button className="btn-ghost" onClick={removeSelected} disabled={busy}>
                        <Trash2 size={12} /> Delete
                      </button>
                    )}
                    <span className="dim">
                      {draft.id ? `id ${draft.id}` : 'Saved to SQLite with a local embedding'}
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <div className="memory-detail-empty">
                <Brain size={30} />
                <p>Select a memory or create a new one.</p>
                <button className="btn-primary" onClick={newDraft} disabled={!memoryApi}>
                  <Plus size={12} /> New memory
                </button>
              </div>
            )}
          </section>
        </div>

        <div className="memory-lower">
          <section className="panel memory-section memory-ask">
            <div className="memory-section-head">
              <Sparkles size={13} />
              <span>Ask your memory</span>
              {rag && (
                <span className={`chip ${rag.mode === 'llm' ? '' : 'warn'}`}>
                  {rag.mode === 'llm' ? 'AI answer' : rag.mode === 'extractive' ? 'extractive' : 'no match'}
                </span>
              )}
            </div>
            <div className="memory-ask-row">
              <input
                className="text-input"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !asking) void ask()
                }}
                placeholder="What do you know about my projects?"
                aria-label="Ask your memory"
              />
              <button className="btn-primary" onClick={ask} disabled={!memoryApi || asking || !question.trim()}>
                {asking ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />} Ask
              </button>
            </div>
            {rag && (
              <div className="memory-rag">
                {rag.warning && (
                  <div className="memory-warn">
                    <AlertTriangle size={11} /> {rag.warning}
                  </div>
                )}
                <pre className="memory-answer">{rag.answer}</pre>
                <div className="memory-rag-meta">
                  <span>{rag.mode === 'llm' ? `${rag.provider?.name || 'Model'} · ${rag.model || rag.provider?.model || ''}` : 'No model call'}</span>
                  <span>{rag.citations.length} citation{rag.citations.length === 1 ? '' : 's'}</span>
                </div>
                {rag.citations.length > 0 && (
                  <div className="memory-citations">
                    {rag.citations.map((cit) => (
                      <button
                        key={cit.id}
                        className="memory-citation"
                        title={cit.text}
                        onClick={() => {
                          const hit = rag.hits.find((h) => h.id === cit.id)
                          if (hit) selectItem(hit)
                        }}
                      >
                        [M{cit.n}] {cit.kind}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="panel memory-section memory-profile">
            <div className="memory-section-head">
              <UserRound size={13} />
              <span>User profile</span>
              <span className="dim memory-profile-meta">{profileUpdated ? `updated ${formatDate(profileUpdated)}` : 'injected into every agent run'}</span>
            </div>
            <div className="memory-profile-grid">
              <label className="memory-field">
                <span>Name</span>
                <input className="text-input" value={profileDraft.name} onChange={(e) => patchProfile({ name: e.target.value })} />
              </label>
              <label className="memory-field">
                <span>Role</span>
                <input className="text-input" value={profileDraft.role} onChange={(e) => patchProfile({ role: e.target.value })} />
              </label>
              <label className="memory-field">
                <span>Language</span>
                <input className="text-input" value={profileDraft.language} onChange={(e) => patchProfile({ language: e.target.value })} />
              </label>
              <label className="memory-field">
                <span>Timezone</span>
                <input className="text-input" value={profileDraft.timezone} onChange={(e) => patchProfile({ timezone: e.target.value })} />
              </label>
              <label className="memory-field memory-field-wide">
                <span>Where work lives</span>
                <input className="text-input" value={profileDraft.locations} onChange={(e) => patchProfile({ locations: e.target.value })} />
              </label>
              <label className="memory-field memory-field-wide">
                <span>Standing preferences</span>
                <textarea
                  className="memory-textarea memory-profile-notes"
                  value={profileDraft.notes}
                  onChange={(e) => patchProfile({ notes: e.target.value })}
                  placeholder="Reply style, recurring setup, things to always avoid…"
                />
              </label>
            </div>
            <div className="memory-actions">
              <button className="btn-primary" onClick={saveProfile} disabled={busy || !profileDirty}>
                <Save size={12} /> Save profile
              </button>
              {profileDirty && <span className="dim">Unsaved</span>}
            </div>
          </section>
        </div>

        <section className="panel memory-section memory-conflicts">
          <div className="memory-section-head">
            <AlertTriangle size={13} />
            <span>Conflicts needing a decision</span>
            <span className="memory-count">{conflicts.length}</span>
            <button className="memory-section-refresh" onClick={() => void refresh()} aria-label="Refresh" title="Refresh">
              <RefreshCw size={11} />
            </button>
          </div>
          {conflicts.length === 0 ? (
            <p className="dim memory-empty">No open conflicts — similar or contradictory memories appear here.</p>
          ) : (
            conflicts.map((conflict) => (
              <div key={conflict.id} className="memory-conflict">
                <div className="memory-conflict-items">
                  {(['a', 'b'] as const).map((side) => {
                    const item = side === 'a' ? conflict.itemA : conflict.itemB
                    return (
                      <div key={side} className="memory-conflict-side">
                        <span className="memory-kind">{item?.kind ?? conflict.kind}</span>
                        <p>{item?.text ?? '(deleted)'}</p>
                        <button className="btn-ghost" onClick={() => resolve(conflict, side === 'a' ? 'keep_a' : 'keep_b')} disabled={busy}>
                          Keep this
                        </button>
                      </div>
                    )
                  })}
                </div>
                <div className="memory-conflict-foot">
                  <span className="dim">
                    {Math.round(conflict.score * 100)}% overlap · {conflict.reason === 'negation' ? 'contradiction' : 'near-duplicate'}
                    {conflict.project ? ` · ${conflict.project}` : ''}
                  </span>
                  <button
                    className="btn-ghost"
                    onClick={() =>
                      setMergeFor({ id: conflict.id, text: `${conflict.itemA?.text ?? ''} ${conflict.itemB?.text ?? ''}`.trim() })
                    }
                    disabled={busy}
                  >
                    Merge…
                  </button>
                  <button className="btn-ghost" onClick={() => resolve(conflict, 'dismiss')} disabled={busy}>
                    Dismiss
                  </button>
                </div>
                {mergeFor?.id === conflict.id && (
                  <div className="memory-merge">
                    <textarea
                      className="memory-textarea"
                      value={mergeFor.text}
                      onChange={(e) => setMergeFor({ id: conflict.id, text: e.target.value })}
                      aria-label="Merged memory text"
                    />
                    <div>
                      <button className="btn-primary" onClick={() => resolve(conflict, 'merge')} disabled={busy || !mergeFor.text.trim()}>
                        Apply merge
                      </button>
                      <button className="btn-ghost" onClick={() => setMergeFor(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </section>
      </div>
    </PageShell>
  )
}
