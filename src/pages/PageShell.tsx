import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'

type Props = {
  title: string
  sub?: string
  onBack: () => void
  actions?: ReactNode
  children: ReactNode
}

export default function PageShell({ title, sub, onBack, actions, children }: Props) {
  return (
    <div className="page-area">
      <div className="page panel">
        <div className="page-head">
          <button className="page-back" onClick={onBack} aria-label="Back to dashboard" title="Back to dashboard">
            <ArrowLeft size={15} />
          </button>
          <div className="page-head-main">
            <h2 className="page-title">{title}</h2>
            {sub && <p className="page-sub">{sub}</p>}
          </div>
          <div className="page-head-actions">{actions}</div>
        </div>
        <div className="page-body">{children}</div>
      </div>
    </div>
  )
}
