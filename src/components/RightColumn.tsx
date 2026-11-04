import { ChevronRight, Folder } from 'lucide-react'
import FuelBar from './FuelBar'
import JobMonitor from './JobMonitor'
import type { OrvexDashboardSnapshot } from '../types/desktop'

type Props = {
  snapshot: OrvexDashboardSnapshot | null
  notify: (m: string) => void
  onNavigate: (id: string) => void
}

export default function RightColumn({ snapshot, notify, onNavigate }: Props) {
  const counts = snapshot?.counts
  const tiles = [
    { label: 'Memory', value: counts?.memory ? `${counts.memory.active} active` : '—', target: 'memory' },
    { label: 'Media', value: counts?.media ? `${counts.media.assets} assets` : '—', target: 'media' },
    { label: 'Reports', value: counts?.research != null ? `${counts.research} saved` : '—', target: 'research' },
    { label: 'Connections', value: counts?.connections != null ? `${counts.connections} added` : '—', target: 'integrations' },
  ]

  return (
    <div className="rightcol-area">
      <div className="rightcol">
        <FuelBar snapshot={snapshot} />
        <JobMonitor snapshot={snapshot} compact notify={notify} onNavigate={onNavigate} />

        <button className="files-card panel" onClick={() => onNavigate('files')}>
          <span className="files-icon">
            <Folder size={16} fill="currentColor" fillOpacity={0.25} />
          </span>
          <span className="flex-1 text-left">
            <span className="block text-[11.5px] font-medium" style={{ color: 'var(--text)' }}>
              Files
            </span>
            <span className="block text-[9px]" style={{ color: 'var(--faint)', marginTop: 1 }}>
              Browse & search
            </span>
          </span>
          <ChevronRight size={13} style={{ color: 'var(--faint)' }} />
        </button>

        <div className="spacer" />

        <section className="notebook-card panel panel-hairline">
          <div className="panel-head">
            <h2 className="panel-title">Workspace</h2>
          </div>
          {tiles.map((tile) => (
            <button key={tile.label} className="note-row w-full" onClick={() => onNavigate(tile.target)}>
              <span className="flex-1 min-w-0 text-left">
                <span className="note-title block">{tile.label}</span>
                <span className="note-sub block">{tile.value}</span>
              </span>
              <ChevronRight size={12} style={{ color: 'var(--faint)' }} />
            </button>
          ))}
        </section>
      </div>
    </div>
  )
}
