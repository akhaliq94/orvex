import { useEffect, useRef, useState } from 'react'
import { Lock, Unlock } from 'lucide-react'
import { setAppInert } from '../data/a11y'
import type { OrvexSecurityStatus } from '../types/desktop'

type Props = {
  status: OrvexSecurityStatus
  onStatus: (status: OrvexSecurityStatus) => void
}

const REASONS: Record<string, string> = {
  manual: 'Locked manually.',
  idle: 'Locked automatically after inactivity.',
  'windows-session': 'Windows was locked, so ORVEX locked too.',
  'screen-lock': 'Windows was locked, so ORVEX locked too.',
  boot: 'ORVEX was locked when it last closed.',
}

const reasonText = (reason: string | null) => {
  if (!reason) return 'ORVEX is locked.'
  const key = reason.toLowerCase()
  return REASONS[key] ?? reason
}

const seconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000))

export default function LockScreen({ status, onStatus }: Props) {
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  const inputRef = useRef<HTMLInputElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // While locked, everything behind the overlay is inert (shared, reference
  // counted with the voice-focus overlay) and Tab stays inside the card.
  useEffect(() => {
    setAppInert('lock', true)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const root = cardRef.current
      if (!root) return
      const focusables = Array.from(root.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)'))
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
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      setAppInert('lock', false)
    }
  }, [])

  useEffect(() => {
    if (!status.lockedUntil || status.lockedUntil <= Date.now()) return
    const t = window.setInterval(() => {
      const at = Date.now()
      setNow(at)
      if (at >= (status.lockedUntil || 0)) window.clearInterval(t)
    }, 500)
    return () => window.clearInterval(t)
  }, [status.lockedUntil])

  const wait = seconds((status.lockedUntil || 0) - now)
  const blocked = wait > 0

  const submit = async () => {
    if (!bridge || busy || blocked || pin.length < 1) return
    setBusy(true)
    setError(null)
    const res = await bridge.security.unlock(pin)
    setBusy(false)
    if (res.ok) {
      setPin('')
      onStatus(res.data.status)
    } else {
      setPin('')
      setError(res.error)
      inputRef.current?.focus()
    }
  }

  return (
    <div ref={screenRef} className="lock-screen" data-inert-keep role="dialog" aria-modal="true" aria-label="ORVEX is locked">
      <div className="lock-card" ref={cardRef}>
        <div className="lock-icon">
          <Lock size={20} />
        </div>
        <h2 className="lock-title">ORVEX is locked</h2>
        <p className="lock-sub">{reasonText(status.lockReason)}</p>

        <form
          className="lock-form"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <input
            ref={inputRef}
            className="lock-input"
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="PIN"
            aria-label="PIN"
            autoComplete="current-password"
            disabled={busy || blocked}
          />
          <button className="lock-btn" type="submit" disabled={busy || blocked || pin.length < 1}>
            <Unlock size={12} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            {busy ? 'Checking…' : blocked ? `Wait ${wait}s` : 'Unlock'}
          </button>
        </form>

        {error && <p className="lock-error">{error}</p>}
        {status.attempts > 0 && !blocked && (
          <p className="lock-hint">
            {status.attempts} wrong {status.attempts === 1 ? 'attempt' : 'attempts'} · {status.maxAttempts - status.attempts} left
            before a lockout
          </p>
        )}
        {blocked && (
          <p className="lock-hint">
            Too many wrong attempts. The wait doubles after each lockout, up to 30 minutes.
          </p>
        )}
        <p className="lock-hint">Your PIN is checked locally. Nothing leaves this PC.</p>
      </div>
    </div>
  )
}
