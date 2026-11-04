import { useState } from 'react'
import { motion, useTransform } from 'framer-motion'
import { Code2, Globe2, MessageSquare, Mic, Send, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import AICore from './AICore'
import type { Voice } from '../hooks/useVoice'
import { useLevelMotion } from '../hooks/useLevelMotion'

type Action = { id: string; title: string; sub: string; icon: LucideIcon; tone?: string }

const ACTIONS: Action[] = [
  { id: 'chat', title: 'Chat', sub: 'Ask anything', icon: MessageSquare, tone: 'blue' },
  { id: 'voice', title: 'Voice', sub: 'Speak naturally', icon: Mic, tone: 'blue' },
  { id: 'agents', title: 'Agents', sub: 'Multiple AI agents', icon: Users, tone: 'green' },
  { id: 'code', title: 'Code', sub: 'Build & fix', icon: Code2 },
  { id: 'browser', title: 'Browser', sub: 'Search & automate', icon: Globe2 },
]

/** Example commands that map to tools this build really ships. */
const SUGGESTIONS = [
  'Show my system status',
  'Take a screenshot and OCR it',
  'Search my memory for project notes',
  'List my workflows and run one',
  'Summarize this folder',
]

type Props = {
  voice: Voice
  user?: string | null
  onToggleListening: () => void
  onCommand: (text: string) => void
  onAction: (id: string) => void
}

function greetingFor(date: Date) {
  const h = date.getHours()
  if (h < 12) return 'Good Morning,'
  if (h < 17) return 'Good Afternoon,'
  return 'Good Evening,'
}

function Greeting({ name }: { name?: string | null }) {
  return (
    <div className="greeting">
      <div className="greeting-hi">{greetingFor(new Date())}</div>
      <div className="greeting-name">{name || 'there'}</div>
      <div className="greeting-sub">Type a command, speak, or pick an action below.</div>
      <div>
        <span className="signature">Your AI Partner</span>
        <svg className="signature-underline" width="118" height="9" viewBox="0 0 118 9" fill="none" aria-hidden>
          <path d="M1 6.5C19 1.8 38 8.2 57 4.6 76 1 96 6.6 117 2.4" stroke="var(--accent)" strokeOpacity="0.65" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  )
}

function ActionCard({ a, onClick }: { a: Action; onClick: () => void }) {
  const Icon = a.icon
  return (
    <button className="action-card panel" data-tone={a.tone} onClick={onClick}>
      <span className="action-icon">
        <Icon size={17} strokeWidth={1.8} />
      </span>
      <span className="min-w-0 text-left">
        <span className="action-title block">{a.title}</span>
        <span className="action-sub block">{a.sub}</span>
      </span>
    </button>
  )
}

export default function Hero({ voice, user, onToggleListening, onCommand, onAction }: Props) {
  const [value, setValue] = useState('')
  const listening = voice.status === 'listening' || voice.status === 'starting'
  const lv = useLevelMotion(voice.levelRef)
  const orbScale = useTransform(lv, [0, 1], [1, 1.22])

  const submit = (text: string) => {
    const t = text.trim()
    if (!t) return
    onCommand(t)
    setValue('')
  }

  return (
    <div className="hero-area">
      <div className="hero">
        <div className="orb-stage">
          <Greeting name={user} />
          <AICore listening={listening} levelRef={voice.levelRef} />
        </div>

        <div className="action-row">
          {ACTIONS.map((a) => (
            <ActionCard key={a.id} a={a} onClick={() => onAction(a.id)} />
          ))}
        </div>

        <div className="command-wrap">
          <form
            className="command-bar panel"
            onSubmit={(e) => {
              e.preventDefault()
              submit(value)
            }}
          >
            <motion.button
              type="button"
              className={`voice-orb ${listening ? 'is-live' : ''}`}
              style={{ scale: orbScale }}
              onClick={onToggleListening}
              aria-label="Toggle voice input"
              title={listening ? 'Stop voice input' : 'Talk to ORVEX — the core reacts to your voice'}
            >
              <Mic size={16} />
            </motion.button>
            <input
              className="command-input"
              placeholder="Ask ORVEX anything or give a command…"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-label="Command input"
            />
            <button type="submit" className="send-btn" aria-label="Send command">
              <Send size={16} />
            </button>
          </form>

          <div className="chip-row">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="chip" onClick={() => submit(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
