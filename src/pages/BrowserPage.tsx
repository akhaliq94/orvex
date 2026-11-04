import { useState } from 'react'
import { ExternalLink, Globe2, Search, Trash2 } from 'lucide-react'
import PageShell from './PageShell'

type Props = { onBack: () => void; notify: (msg: string) => void }

type Bookmark = { name: string; url: string; hue: string }

const BOOKMARKS: Bookmark[] = [
  { name: 'Google', url: 'https://www.google.com', hue: '#4fc3ff' },
  { name: 'YouTube', url: 'https://www.youtube.com', hue: '#ff5c5c' },
  { name: 'GitHub', url: 'https://github.com', hue: '#b6c6d8' },
  { name: 'Gmail', url: 'https://mail.google.com', hue: '#ff9d4d' },
  { name: 'Drive', url: 'https://drive.google.com', hue: '#4ade80' },
  { name: 'Maps', url: 'https://maps.google.com', hue: '#7ef0c0' },
]

const HISTORY_KEY = 'orvex-browser-history'

function loadHistory(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function saveHistory(next: string[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
  } catch {
    /* history is optional */
  }
}

function toUrl(query: string): string {
  const q = query.trim()
  if (/^https?:\/\//i.test(q)) return q
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(q)) return 'https://' + q
  return 'https://www.google.com/search?q=' + encodeURIComponent(q)
}

export default function BrowserPage({ onBack, notify }: Props) {
  const [value, setValue] = useState('')
  const [history, setHistory] = useState<string[]>(loadHistory)

  const go = (raw: string) => {
    const url = toUrl(raw)
    if (!raw.trim()) return
    window.open(url, '_blank', 'noopener')
    setValue('')
    setHistory((h) => {
      const next = [raw.trim(), ...h.filter((x) => x !== raw.trim())].slice(0, 8)
      saveHistory(next)
      return next
    })
    notify('Opened in a new browser tab.')
  }

  const clear = () => {
    setHistory([])
    try {
      localStorage.removeItem(HISTORY_KEY)
    } catch {
      /* storage unavailable */
    }
  }

  return (
    <PageShell title="Browser" sub="Searches open in your real browser — history stays local" onBack={onBack}>
      <div className="browser-page">
        <form
          className="browser-bar panel"
          onSubmit={(e) => {
            e.preventDefault()
            go(value)
          }}
        >
          <Globe2 size={15} style={{ color: 'var(--accent)', flex: 'none' }} />
          <input
            className="command-input"
            placeholder="Search or type a URL…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="Address bar"
          />
          <button type="submit" className="send-btn" aria-label="Search">
            <Search size={15} />
          </button>
        </form>

        <div className="browser-tiles">
          {BOOKMARKS.map((b) => (
            <button key={b.name} className="browser-tile panel" onClick={() => go(b.url)}>
              <span className="browser-tile-dot" style={{ background: b.hue, boxShadow: `0 0 12px ${b.hue}` }} />
              <span>{b.name}</span>
              <ExternalLink size={11} style={{ opacity: 0.5 }} />
            </button>
          ))}
        </div>

        <div className="browser-history">
          <div className="voice-side-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            Recent
            {history.length > 0 && (
              <button className="page-tool-btn" onClick={clear} aria-label="Clear history" title="Clear history" style={{ marginLeft: 'auto' }}>
                <Trash2 size={12} />
              </button>
            )}
          </div>
          {history.length === 0 && <p className="dim">Nothing yet — searches will show up here.</p>}
          {history.map((h, i) => (
            <button key={i} className="browser-history-item panel" onClick={() => go(h)}>
              <Search size={11} />
              <span className="truncate">{h}</span>
            </button>
          ))}
        </div>
      </div>
    </PageShell>
  )
}
