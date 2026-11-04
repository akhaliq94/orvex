import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Cpu, Code2, FolderOpen, Globe2, Mic, MessageSquare, Network, FileCode2, Terminal, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import PageShell from './PageShell'
import AgentOrgMap from '../components/AgentOrgMap'
import { AGENT_BY_ID, AGENT_PROFILES, type AgentProfile, type AgentState } from '../data/agents'
import type { OrvexDashboardSnapshot, OrvexRunRecord } from '../types/desktop'

type Props = {
  onBack: () => void
  notify: (m: string) => void
  snapshot: OrvexDashboardSnapshot | null
  onOpenChat: (agentId: string, draft?: string) => void
  initialTab?: string | null
}

const TABS: Tab[] = ['overview', 'soul', 'tools']

const ICONS: Record<AgentProfile['icon'], LucideIcon> = {
  mic: Mic,
  code: Code2,
  globe: Globe2,
  folder: FolderOpen,
  cpu: Cpu,
  research: BookOpen,
}

type Tab = 'overview' | 'soul' | 'tools'

type LogLine = { at: number; text: string; tone: 'ok' | 'err' | 'live' | null }

const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour12: false })

const statusLabel = (status: string) =>
  status === 'ok' ? 'succeeded' : status === 'cancelled' ? 'cancelled' : status

export default function AgentsPage({ onBack, notify, snapshot, onOpenChat, initialTab }: Props) {
  const [selected, setSelected] = useState<string>('general')
  const [tab, setTab] = useState<Tab>(() => (TABS.includes(initialTab as Tab) ? (initialTab as Tab) : 'overview'))

  useEffect(() => {
    if (initialTab && TABS.includes(initialTab as Tab)) setTab(initialTab as Tab)
  }, [initialTab])
  const [runs, setRuns] = useState<OrvexRunRecord[]>([])
  const [runsError, setRunsError] = useState<string | null>(null)

  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const agent = snapshot?.agent ?? null
  const activeRunId = agent?.runId ?? null

  // Refresh the run log whenever the active goal starts or stops.
  useEffect(() => {
    let dead = false
    if (!bridge) {
      setRunsError('Desktop bridge unavailable — run history needs the ORVEX app.')
      return
    }
    void (async () => {
      const res = await bridge.orchestrator.runs(100)
      if (dead) return
      if (!res.ok) {
        setRunsError(res.error)
        return
      }
      setRunsError(null)
      setRuns(res.data.runs)
    })()
    return () => {
      dead = true
    }
  }, [bridge, activeRunId])

  const stateOf = (id: string): AgentState => {
    if (!agent?.running) return 'Idle'
    if (agent.agentId !== id) return 'Idle'
    return agent.paused ? 'Paused' : 'Running'
  }

  const states = useMemo(
    () => Object.fromEntries(AGENT_PROFILES.map((a) => [a.id, stateOf(a.id)])) as Record<string, AgentState>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent?.running, agent?.paused, agent?.agentId],
  )

  const profile = AGENT_BY_ID[selected]
  const manager = profile?.reportsTo ? AGENT_BY_ID[profile.reportsTo] : null
  const agentRuns = useMemo(() => runs.filter((r) => r.agentId === selected), [runs, selected])

  const logLines = useMemo<LogLine[]>(() => {
    const out: LogLine[] = []
    if (agent?.running && agent.agentId === selected) {
      if (agent.goal) out.push({ at: snapshot?.at ?? Date.now(), text: `goal → ${agent.goal}`, tone: 'live' })
      for (const a of snapshot?.activity ?? []) {
        if (!a.runId || a.runId !== agent.runId) continue
        const outcome = a.ok === null ? '·' : a.ok ? '✓' : '✕'
        const ms = a.ms === null ? '' : ` ${a.ms}ms`
        const tail = a.error ? ` — ${a.error}` : ''
        out.push({
          at: a.ts,
          text: `${a.kind}${a.tool ? ` ${a.tool}` : ''} ${outcome}${ms}${tail}`,
          tone: a.ok === 0 ? 'err' : 'ok',
        })
      }
    }
    for (const r of agentRuns) {
      if (r.id === activeRunId) continue
      const steps = `${r.steps} step${r.steps === 1 ? '' : 's'}`
      const tail = r.summary ? ` → ${r.summary}` : ''
      out.push({
        at: r.startedAt,
        text: `${statusLabel(r.status)} · ${steps} — ${r.goal ?? 'no goal recorded'}${tail}`,
        tone: r.status === 'failed' ? 'err' : null,
      })
    }
    return out.sort((a, b) => b.at - a.at).slice(0, 60)
  }, [agent, agentRuns, activeRunId, snapshot])

  const openChat = (id: string, draft?: string) => {
    const target = AGENT_BY_ID[id]
    notify(draft ? `Chat opened with ${target?.name ?? id} — message pre-filled` : `Chat opened with ${target?.name ?? id}`)
    onOpenChat(id, draft)
  }

  return (
    <PageShell
      title="Agents"
      sub="Personas, org map and run history from the live agent runtime"
      onBack={onBack}
      actions={
        <div className="page-tabbar">
          {(['overview', 'soul', 'tools'] as Tab[]).map((t) => (
            <button key={t} className={`page-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t === 'soul' ? 'SOUL.md' : t === 'tools' ? 'Tools' : 'Overview'}
            </button>
          ))}
        </div>
      }
    >
      <div className="agents-page">
        {agent?.running && (
          <p className="dim">
            Runtime busy: <strong>{AGENT_BY_ID[agent.agentId ?? '']?.name ?? agent.agentId ?? 'unknown agent'}</strong>
            {agent.paused ? ' is paused' : ' is working'} on “{agent.goal ?? agent.runId}”
            {agent.mode === 'orchestrator' ? ' (orchestrator mode)' : ''}.
          </p>
        )}
        {runsError && <p className="dim">Run history: {runsError}</p>}

        <AgentOrgMap states={states} selected={selected} onSelect={setSelected} />

        <div className="agents-grid">
          {AGENT_PROFILES.map((a) => {
            const Icon = ICONS[a.icon]
            const status = states[a.id]
            const active = selected === a.id
            return (
              <button
                key={a.id}
                className={`agent-card panel ${active ? 'selected' : ''}`}
                onClick={() => setSelected(a.id)}
              >
                <span className="agent-card-icon"><Icon size={17} /></span>
                <span className="agent-card-name">{a.name}</span>
                <span className={`agent-status-dot ${status.toLowerCase()}`} />
                <span className="agent-card-status">{status}</span>
                <span
                  className="agent-card-toggle"
                  role="button"
                  tabIndex={0}
                  aria-label={`Open chat with ${a.name}`}
                  title={`Open chat with ${a.name}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    openChat(a.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation()
                      openChat(a.id)
                    }
                  }}
                >
                  <MessageSquare size={13} />
                </span>
              </button>
            )
          })}
        </div>

        {tab === 'overview' && (
          <div className="agent-log panel">
            <div className="agent-log-head">
              <Terminal size={14} />
              <span>{profile?.name ?? selected} — run history</span>
              <span className={`agent-status-dot ${stateOf(selected).toLowerCase()}`} style={{ marginLeft: 'auto' }} />
            </div>
            <div className="agent-log-body">
              {logLines.length === 0 && (
                <p className="dim">
                  No runs recorded for {profile?.name ?? selected} yet. Every goal this agent runs from Chat or the Engine
                  is written here from the local database.
                </p>
              )}
              {logLines.map((l, i) => (
                <p key={`${l.at}-${i}`} className={`agent-log-line ${l.tone ? `log-${l.tone}` : ''}`}>
                  <span className="log-time">[{clock(l.at)}]</span> {l.text}
                </p>
              ))}
            </div>
            {profile && (
              <div className="agent-meta">
                <span className="meta-chip">
                  <Network size={10} /> Reports to: {manager?.name ?? 'top of org'}
                </span>
                <span className="meta-chip">
                  <Wrench size={10} /> {profile.tools.length} tools
                </span>
                <span className="meta-chip">{agentRuns.length} recorded runs</span>
                <span className="meta-chip">Mood: {profile.traits.mood}</span>
              </div>
            )}
          </div>
        )}

        {tab === 'soul' && profile && (
          <div className="agent-soul panel">
            <div className="agent-log-head">
              <FileCode2 size={14} />
              <span>{profile.name}/SOUL.md</span>
              <span className="meta-chip" style={{ marginLeft: 'auto' }}>{profile.role}</span>
            </div>
            <pre className="soul-body">{profile.soul}</pre>
          </div>
        )}

        {tab === 'tools' && profile && (
          <div className="agent-tools panel">
            <div className="agent-log-head">
              <Wrench size={14} />
              <span>{profile.name} — tools this persona reaches for</span>
            </div>
            <div className="tools-grid">
              {profile.tools.map((t) => (
                <button
                  key={t}
                  className="tool-chip"
                  title={`Open Chat with ${profile.name} and pre-fill a ${t} request`}
                  onClick={() => openChat(profile.id, `Use the ${t} tool to `)}
                >
                  {t} →
                </button>
              ))}
            </div>
            <p className="dim mt-3">
              Each chip opens Chat with {profile.name} and pre-fills a request. The agent calls these tools through the
              runtime — anything risky pauses for your approval first.
            </p>
          </div>
        )}
      </div>
    </PageShell>
  )
}
