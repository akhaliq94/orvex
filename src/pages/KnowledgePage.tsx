import { useEffect, useState } from 'react'
import { NotebookPen, Plus, Trash2 } from 'lucide-react'
import PageShell from './PageShell'

type Props = { onBack: () => void; notify: (msg: string) => void }

type Note = { id: string; title: string; body: string; updated: string }

const KEY = 'orvex-notes'

function load(): Note[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((n): n is Note => !!n && typeof n === 'object' && typeof (n as Note).id === 'string')
      : []
  } catch {
    return []
  }
}

function save(notes: Note[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(notes))
  } catch {
    /* notes stay in memory for this session */
  }
}

export default function KnowledgePage({ onBack, notify }: Props) {
  const [notes, setNotes] = useState<Note[]>(load)
  const [selected, setSelected] = useState<string | null>(notes[0]?.id ?? null)

  useEffect(() => {
    save(notes)
  }, [notes])

  const current = notes.find((n) => n.id === selected) ?? null

  const add = () => {
    const note: Note = {
      id: `n-${Date.now()}`,
      title: 'Untitled note',
      body: '',
      updated: new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short' }),
    }
    setNotes((ns) => [note, ...ns])
    setSelected(note.id)
  }

  const update = (patch: Partial<Note>) => {
    if (!current) return
    setNotes((ns) =>
      ns.map((n) => (n.id === current.id ? { ...n, ...patch, updated: new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short' }) } : n)),
    )
  }

  const remove = (id: string) => {
    setNotes((ns) => ns.filter((n) => n.id !== id))
    if (selected === id) setSelected(null)
    notify('Note deleted')
  }

  return (
    <PageShell
      title="Knowledge"
      sub="Your notes — saved locally in this browser"
      onBack={onBack}
      actions={
        <button className="page-tool-btn" onClick={add} aria-label="New note" title="New note">
          <Plus size={14} />
        </button>
      }
    >
      <div className="notes-page">
        <div className="notes-list">
          {notes.length === 0 && <p className="dim" style={{ padding: '8px 4px' }}>No notes yet — hit + to create one.</p>}
          {notes.map((n) => (
            <div key={n.id} className={`note-item panel ${selected === n.id ? 'selected' : ''}`} onClick={() => setSelected(n.id)}>
              <span className="note-item-title">{n.title || 'Untitled'}</span>
              <span className="note-item-meta">{n.updated}</span>
              <button
                className="file-del"
                onClick={(e) => {
                  e.stopPropagation()
                  remove(n.id)
                }}
                aria-label={`Delete ${n.title}`}
                title="Delete"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
        <div className="note-editor panel">
          {current ? (
            <>
              <input
                className="note-title-input"
                value={current.title}
                onChange={(e) => update({ title: e.target.value })}
                placeholder="Note title"
                aria-label="Note title"
              />
              <textarea
                className="note-body-input"
                value={current.body}
                onChange={(e) => update({ body: e.target.value })}
                placeholder="Write something…"
                aria-label="Note body"
              />
            </>
          ) : (
            <div className="note-empty">
              <NotebookPen size={28} />
              <p>Select a note or create a new one.</p>
            </div>
          )}
        </div>
      </div>
    </PageShell>
  )
}
