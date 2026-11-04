import { useState } from 'react'
import { ArrowLeftRight, Calculator } from 'lucide-react'
import PageShell from './PageShell'

type Props = { onBack: () => void }

export default function ToolsPage({ onBack }: Props) {
  const [display, setDisplay] = useState('0')
  const [expr, setExpr] = useState('')

  const press = (key: string) => {
    if (key === 'C') {
      setDisplay('0')
      setExpr('')
      return
    }
    if (key === '⌫') {
      setDisplay((d) => (d.length > 1 ? d.slice(0, -1) : '0'))
      return
    }
    if (key === '=') {
      try {
        const safe = display.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/%/g, '/100')
        if (!/^[\d+\-*/.() ]+$/.test(safe)) throw new Error('bad')
        const val = Function(`"use strict"; return (${safe})`)() as number
        setExpr(display + ' =')
        setDisplay(String(Math.round(val * 1e10) / 1e10))
      } catch {
        setDisplay('Error')
      }
      return
    }
    if (key === '±') {
      setDisplay((d) => {
        if (d === '0' || d === 'Error') return d
        return d.startsWith('−(') && d.endsWith(')') ? d.slice(2, -1) : `−(${d})`
      })
      return
    }
    setDisplay((d) => (d === '0' || d === 'Error' ? key : d + key))
  }

  const KEYS = ['C', '⌫', '%', '÷', '7', '8', '9', '×', '4', '5', '6', '−', '1', '2', '3', '+', '±', '0', '.', '=']

  // converter
  const [convValue, setConvValue] = useState('1')
  const [convFrom, setConvFrom] = useState('km')
  const [convTo, setConvTo] = useState('mi')
  const LENGTH: Record<string, number> = { km: 1000, m: 1, cm: 0.01, mi: 1609.344, ft: 0.3048, in: 0.0254 }
  const convNum = parseFloat(convValue) || 0
  const converted = convNum * (LENGTH[convFrom] / LENGTH[convTo])

  return (
    <PageShell title="Tools" sub="Calculator & converter — fully functional, runs locally" onBack={onBack}>
      <div className="tools-page">
        <div className="calc panel">
          <div className="calc-head"><Calculator size={14} /> Calculator</div>
          <div className="calc-display">
            <div className="calc-expr">{expr}</div>
            <div className="calc-value">{display}</div>
          </div>
          <div className="calc-keys">
            {KEYS.map((k) => (
              <button key={k} className={`calc-key ${'÷×−+='.includes(k) ? 'op' : ''} ${k === '=' ? 'eq' : ''} ${k === 'C' ? 'clear' : ''}`} onClick={() => press(k)}>
                {k}
              </button>
            ))}
          </div>
        </div>

        <div className="converter panel">
          <div className="calc-head"><ArrowLeftRight size={14} /> Length converter</div>
          <div className="conv-row">
            <input className="conv-input" value={convValue} onChange={(e) => setConvValue(e.target.value.replace(/[^\d.]/g, ''))} aria-label="Value" />
            <select className="conv-select" value={convFrom} onChange={(e) => setConvFrom(e.target.value)} aria-label="From unit">
              {Object.keys(LENGTH).map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <div className="conv-swap">↓ equals ↓</div>
          <div className="conv-row">
            <div className="conv-result">{Number.isFinite(converted) ? String(Math.round(converted * 1e6) / 1e6) : '—'}</div>
            <select className="conv-select" value={convTo} onChange={(e) => setConvTo(e.target.value)} aria-label="To unit">
              {Object.keys(LENGTH).map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        </div>
      </div>
    </PageShell>
  )
}
