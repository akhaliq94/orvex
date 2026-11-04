import { THEMES, type Theme } from '../themes'

type Props = {
  themeId: string
  auto: boolean
  onSelect: (t: Theme) => void
  onToggleAuto: () => void
}

function Thumb({ t }: { t: Theme }) {
  const line = t.preview.line
  return (
    <div className="theme-thumb" style={{ background: t.preview.bg }}>
      <div className="theme-thumb-inner">
        <div
          className="tt-rail"
          style={{
            background: `linear-gradient(180deg, ${t.preview.panel}, rgba(255,255,255,.04))`,
            border: `1px solid ${line}44`,
            color: line,
          }}
        />
        <div className="tt-body">
          <div className="tt-top" style={{ background: `${line}55`, border: `1px solid ${line}33` }} />
          <div className="tt-grid">
            <div className="tt-cell" style={{ background: t.preview.panel, border: `1px solid ${line}22` }} />
            <div className="tt-cell" style={{ background: t.preview.panel, border: `1px solid ${line}22` }} />
            <div className="tt-cell" style={{ background: t.preview.panel, border: `1px solid ${line}22` }} />
            <div className="tt-cell" style={{ background: t.preview.panel, border: `1px solid ${line}22` }} />
          </div>
        </div>
      </div>
      <span className="tt-dot" style={{ color: line, background: line, opacity: 0.9 }} />
    </div>
  )
}

export default function ThemePanel({ themeId, auto, onSelect, onToggleAuto }: Props) {
  return (
    <section className="theme-panel panel panel-hairline" aria-label="Theme selection">
      <div className="panel-head">
        <h2 className="panel-title">Choose Theme</h2>
        <div className="flex items-center gap-2">
          <span className="text-[9.5px]" style={{ color: 'var(--muted)' }}>
            Auto (System)
          </span>
          <button className="switch" data-on={auto} onClick={onToggleAuto} aria-pressed={auto} aria-label="Auto theme">
            <span className="switch-knob" />
          </button>
        </div>
      </div>

      <div className="theme-grid">
        {THEMES.map((t) => (
          <button
            key={t.id}
            className={`theme-tile ${themeId === t.id ? 'active' : ''}`}
            onClick={() => onSelect(t)}
            aria-pressed={themeId === t.id}
          >
            <Thumb t={t} />
            <div className="theme-name">{t.name}</div>
            <div className="theme-sub">{t.sub}</div>
          </button>
        ))}
      </div>
    </section>
  )
}
