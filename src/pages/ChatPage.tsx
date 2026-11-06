import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AudioLines,
  Bot,
  Brain,
  CheckCircle2,
  Loader2,
  MessageSquare,
  Mic,
  Send,
  ShieldAlert,
  Sparkles,
  Tag,
  Trash2,
  User,
  Volume2,
  XCircle,
} from 'lucide-react'
import PageShell from './PageShell'
import { useProviders } from '../hooks/useProviders'
import { useHumanAgent } from '../hooks/useHumanAgent'
import { useLLM, type LLMMessage } from '../hooks/useLLM'
import { loadConversations, saveConversations, upsertConversation, formatTime, titleFrom, type Conversation } from '../data/memory'
import { buildCandidates, orderForTask, pickLocal } from '../data/routing'
import { AGENT_PROFILES, HUMANITY_PROMPT } from '../data/agents'
import { beginReplySpeech, speak, stopSpeaking, useVoiceSettings } from '../data/voice'
import type { ReplySpeech } from '../data/voice'
import { logFailure, pushNotification } from '../data/stores'
import type { Voice } from '../hooks/useVoice'
import type { OrvexAgentEvent } from '../types/desktop'

type Msg = { role: 'user' | 'assistant'; text: string }
type TurnMeta = { agentId: string; providerId: string | null; model: string; tags: string[] }

type Props = {
  onBack: () => void
  initialPrompt?: string | null
  initialConvId?: string | null
  initialAgentId?: string | null
  initialDraft?: string | null
  voice: Voice
  handsFree: boolean
  onHandsFreeChange: (enabled: boolean) => void
}

const greetingFor = (p: { name: string; model: string } | null) =>
  p
    ? `Connected to ${p.name} (${p.model}). Agent mode is on — tell me what to do on your PC: open apps, drive the browser, work with files. Tap the brain icon to switch to plain chat.`
    : 'No provider yet. Add one in Settings → Providers so I can act on your PC — or keep chatting on the local offline brain.'

const AGENT_MODE_KEY = 'orvex-chat-agent'
const FULL_AUTO_KEY = 'orvex-fullauto'

function readFlag(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

type AgentStep = { id: string; name: string; ok: boolean | null; ms?: number }

export default function ChatPage({
  onBack,
  initialPrompt,
  initialConvId,
  initialAgentId,
  initialDraft,
  voice,
  handsFree,
  onHandsFreeChange,
}: Props) {
  const { providers, activeId, active } = useProviders()
  const [activeAgentId, setActiveAgentId] = useState(initialAgentId ?? 'general')
  const { respondLocally } = useHumanAgent(activeAgentId)
  const { send, stop: stopLLM } = useLLM()
  const { cfg: voiceCfg, setCfg: setVoiceCfg } = useVoiceSettings()

  const [messages, setMessages] = useState<Msg[]>(() => [{ role: 'assistant', text: greetingFor(active) }])
  const [input, setInput] = useState('')
  const [typing, setTypingState] = useState(false)
  const typingRef = useRef(false)
  const setTyping = useCallback((value: boolean) => {
    typingRef.current = value
    setTypingState(value)
  }, [])
  const [statusLine, setStatusLine] = useState<string>('')
  const [agentMode, setAgentMode] = useState(() => readFlag(AGENT_MODE_KEY, '1') !== '0')
  const [fullAuto, setFullAuto] = useState(() => readFlag(FULL_AUTO_KEY, '0') === '1')
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([])
  const [approval, setApproval] = useState<{ id: string; name: string; reason: string } | null>(null)
  // A goal started elsewhere (Engine page, or left running before this page mounted).
  const [externalRun, setExternalRun] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [history, setHistory] = useState<Conversation[]>([])
  const [tagDraft, setTagDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<Msg[]>(messages)
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const agentRunRef = useRef<string | null>(null)
  const awaitingAgentRef = useRef(false)
  const agentActiveRef = useRef(false)
  const fullAutoRef = useRef(fullAuto)
  const handsFreeRef = useRef(handsFree)
  const voiceCfgRef = useRef(voiceCfg)
  const voiceApiRef = useRef(voice)
  /**
   * A turn (LLM stream, offline reply or agent goal) owns one conversation.
   * Switching to another history entry mid-turn must not write the reply into
   * the chat on screen or save it under the wrong id.
   */
  const turnConvRef = useRef<string | null>(null)
  const turnHistoryRef = useRef<Msg[] | null>(null)
  const turnMetaRef = useRef<TurnMeta | null>(null)
  const turnCancelledRef = useRef(false)
  const turnSequenceRef = useRef(0)
  const speechSequenceRef = useRef(0)
  /** speech for the reply that is still streaming, or null for one-shot speech */
  const turnSpeechRef = useRef<{ sequence: number; stream: ReplySpeech } | null>(null)
  const viewingConvRef = useRef<string | null>(null)
  /** set when the turn came in through the wake word, so the mic re-arms after it */
  const wakeTurnRef = useRef(false)

  /**
   * All message writes go through here so `messagesRef` stays in sync
   * synchronously — saving a conversation needs the current list, not the
   * value React has not re-rendered yet.
   */
  const applyMessages = useCallback((updater: (m: Msg[]) => Msg[]) => {
    const next = updater(messagesRef.current)
    messagesRef.current = next
    setMessages(next)
  }, [])


  useEffect(() => {
    const list = loadConversations()
    setHistory(list)
    // An agent handoff or a command from elsewhere owns the composer; do not
    // overwrite it with the most recent conversation.
    if (list.length > 0 && !conversationId && !initialPrompt && !initialConvId && !initialAgentId && !initialDraft) loadConv(list[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (initialAgentId) setActiveAgentId(initialAgentId)
  }, [initialAgentId])

  useEffect(() => {
    if (initialDraft) setInput(initialDraft)
  }, [initialDraft])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, typing])

  useEffect(() => {
    if (initialPrompt) sendMsg(initialPrompt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt])

  useEffect(() => {
    if (!initialConvId) return
    const c = loadConversations().find((x) => x.id === initialConvId)
    if (c) loadConv(c)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialConvId])

  // While a voice session is live, mirror the final transcript into the composer
  // so speaking actually fills the message instead of just lighting the orb.
  const voiceSeen = useRef('')
  useEffect(() => {
    if (!voice.transcript) {
      voiceSeen.current = ''
      return
    }
    if (voice.transcript === voiceSeen.current) return
    voiceSeen.current = voice.transcript
    setInput(voice.transcript)
  }, [voice.transcript])

  const sendRef = useRef<(raw: string) => Promise<void>>(async () => {})

  // Hands-free: the voice hook fires once the speaker pauses, and that turn is
  // sent without anyone touching the keyboard. A wake-word turn is always sent,
  // even with hands-free off, because the user explicitly addressed ORVEX.
  useEffect(() => {
    voice.setOnUtterance((text, meta) => {
      if (!handsFreeRef.current && !meta?.wake) return
      if (!text) {
        if (meta?.wake) setStatusLine('Wake word heard — say your command')
        return
      }
      if (typingRef.current) return
      wakeTurnRef.current = !!meta?.wake
      voice.pauseListening()
      void sendRef.current(text)
    })
    return () => voice.setOnUtterance(null)
  }, [voice])

  // Hands-free survives reloads, so re-open the mic when the page comes back.
  useEffect(() => {
    if (handsFree) void voice.start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handsFree])

  // Talking back through the speakers while the mic is open feeds ORVEX its own
  // voice, so the mic always wins.
  useEffect(() => {
    if (voice.status === 'listening') stopSpeaking()
  }, [voice.status])

  // Leaving the chat must release the microphone and stop the running turn —
  // hands-free is not a hot mic that keeps recording while you are elsewhere.
  useEffect(() => {
    return () => {
      turnCancelledRef.current = true
      turnSequenceRef.current += 1
      speechSequenceRef.current += 1
      stopSpeaking()
      stopLLM()
      if ((awaitingAgentRef.current || agentActiveRef.current) && bridge) void bridge.agent.stop()
      voice.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadConv = (c: Conversation) => {
    viewingConvRef.current = c.id
    setConversationId(c.id)
    setActiveAgentId(c.agentId)
    setTagDraft(c.tags.join(', '))
    // Reopening the chat that owns the running turn shows its live transcript,
    // not the version stored before the turn started.
    const live = turnConvRef.current === c.id ? turnHistoryRef.current : null
    const restored = live ?? c.messages.map((m) => ({ role: m.role, text: m.text }))
    messagesRef.current = restored
    setMessages(restored)
  }

  const newConversation = () => {
    viewingConvRef.current = null
    setConversationId(null)
    setActiveAgentId('general')
    setTagDraft('')
    messagesRef.current = [{ role: 'assistant', text: greetingFor(active) }]
    setMessages(messagesRef.current)
  }

  /** Saves a turn under the metadata it started with, not whatever is selected now. */
  const persistTurn = useCallback((convId: string, finalMessages: Msg[], meta: TurnMeta) => {
    const list = loadConversations()
    const existing = list.find((c) => c.id === convId)
    const conv: Conversation = {
      id: convId,
      title: existing?.title ?? titleFrom(finalMessages.find((m) => m.role === 'user')?.text ?? ''),
      agentId: meta.agentId,
      providerId: meta.providerId,
      model: meta.model,
      tags: meta.tags,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      messages: finalMessages.map((m) => ({ role: m.role, text: m.text, at: Date.now() })),
    }
    const next = upsertConversation(list, conv)
    saveConversations(next)
    setHistory(next)
  }, [])

  const deleteConv = (id: string) => {
    if (turnConvRef.current === id) {
      turnCancelledRef.current = true
      turnSequenceRef.current += 1
      speechSequenceRef.current += 1
      stopSpeaking()
      stopLLM()
      if (agentActiveRef.current && bridge) void bridge.agent.stop()
      setTyping(false)
      setStatusLine('')
      turnConvRef.current = null
      turnHistoryRef.current = null
    }
    const next = loadConversations().filter((c) => c.id !== id)
    saveConversations(next)
    setHistory(next)
    if (conversationId === id) newConversation()
  }

  // ---- agent mode: typed or spoken messages run on the real tool runtime ----

  useEffect(() => {
    fullAutoRef.current = fullAuto
  }, [fullAuto])

  useEffect(() => {
    handsFreeRef.current = handsFree
  }, [handsFree])

  useEffect(() => {
    voiceApiRef.current = voice
    voiceCfgRef.current = voiceCfg
  })

  /** Speak a reply and report failures instead of swallowing them. */
  const speakReply = useCallback((text: string, then?: () => void) => {
    const sequence = ++speechSequenceRef.current
    voiceApiRef.current.markSpeaking(false)
    voiceApiRef.current.setReplyPhase('preparing')
    void speak(text, voiceCfgRef.current, () => {
      if (speechSequenceRef.current !== sequence) return
      voiceApiRef.current.setReplyPhase(null)
      voiceApiRef.current.markSpeaking(true)
    })
      .then((r) => {
        if (r.ok || speechSequenceRef.current !== sequence) return
        logFailure('Chat · speak', r.detail)
        pushNotification({ title: 'Speech failed', body: r.detail, kind: 'voice' })
      })
      .finally(() => {
        if (speechSequenceRef.current !== sequence) return
        voiceApiRef.current.markSpeaking(false)
        voiceApiRef.current.setReplyPhase(null)
        then?.()
      })
  }, [])

  /**
   * Open speech for a reply that is still arriving. Each finished sentence is
   * spoken as it lands, so the answer is heard before the model has written
   * the last word; `completeSpeech` says whatever is left.
   */
  const beginTurnSpeech = useCallback(() => {
    turnSpeechRef.current = null
    if (!voiceCfgRef.current.autoSpeak) return
    const sequence = ++speechSequenceRef.current
    const api = voiceApiRef.current
    let heard = false
    turnSpeechRef.current = {
      sequence,
      stream: beginReplySpeech(voiceCfgRef.current, () => {
        if (speechSequenceRef.current !== sequence || heard) return
        heard = true
        api.setReplyPhase(null)
        api.markSpeaking(true)
      }),
    }
  }, [])

  const feedTurnSpeech = useCallback((textSoFar: string) => {
    if (speechSequenceRef.current !== turnSpeechRef.current?.sequence) return
    turnSpeechRef.current?.stream.push(textSoFar)
  }, [])

  /** Write live model text into the assistant slot this turn opened. */
  const streamTurnText = useCallback((text: string) => {
    const conv = turnConvRef.current
    const snap = turnHistoryRef.current
    if (!conv || !snap) return
    const next: Msg[] = [...snap.slice(0, -1), { role: 'assistant', text }]
    turnHistoryRef.current = next
    if (viewingConvRef.current === conv) {
      messagesRef.current = next
      setMessages(next)
    }
  }, [])

  /** Resolve the turn's early speech, or start one-shot speech instead. */
  const completeSpeech = useCallback((text: string, then?: () => void) => {
    const turn = turnSpeechRef.current
    turnSpeechRef.current = null
    if (!turn) {
      speakReply(text, then)
      return
    }
    const api = voiceApiRef.current
    api.markSpeaking(false)
    api.setReplyPhase('preparing')
    void turn.stream
      .finish(text)
      .then((r) => {
        if (r.ok || speechSequenceRef.current !== turn.sequence) return
        logFailure('Chat · speak', r.detail)
        pushNotification({ title: 'Speech failed', body: r.detail, kind: 'voice' })
      })
      .finally(() => {
        if (speechSequenceRef.current !== turn.sequence) return
        api.markSpeaking(false)
        api.setReplyPhase(null)
        then?.()
      })
  }, [speakReply])

  /** Speak the reply, then put the mic back the way this turn found it. */
  const finishTurnVoice = useCallback(
    (text: string) => {
      const api = voiceApiRef.current
      api.setReplyPhase(null)
      const handsFreeOn = handsFreeRef.current
      const wasWake = wakeTurnRef.current
      wakeTurnRef.current = false
      const early = turnSpeechRef.current !== null
      if (early) {
        // Sentences are already being heard; keep the mic closed until they end.
        api.pauseListening()
        completeSpeech(text, handsFreeOn || wasWake ? () => api.resumeListening() : undefined)
        return
      }
      if (handsFreeOn) {
        // Speak the reply, then reopen the mic so the next turn needs no click.
        api.pauseListening()
        speakReply(text, () => api.resumeListening())
        return
      }
      if (wasWake) {
        // A wake-word turn with hands-free off still borrowed the mic.
        if (voiceCfgRef.current.autoSpeak) speakReply(text, () => api.resumeListening())
        else api.resumeListening()
        return
      }
      if (voiceCfgRef.current.autoSpeak) speakReply(text)
    },
    [speakReply, completeSpeech],
  )

  /** Give the mic back after a turn that failed before producing a reply. */
  const resumeMicAfterTurn = useCallback(() => {
    voiceApiRef.current.setReplyPhase(null)
    // Anything this turn had started saying is stale from here on.
    if (turnSpeechRef.current) {
      speechSequenceRef.current += 1
      turnSpeechRef.current = null
      stopSpeaking()
    }
    const wasWake = wakeTurnRef.current
    wakeTurnRef.current = false
    if (handsFreeRef.current || wasWake) voiceApiRef.current.resumeListening()
  }, [])

  useEffect(() => {
    if (!bridge) return
    // Only one goal can run at a time — if one is already going, show it and
    // offer Stop instead of letting the next send fail with "already running".
    void bridge.agent
      .status()
      .then((res) => {
        if (res.ok && res.data.running) setExternalRun(true)
      })
      .catch(() => undefined)
  }, [bridge])

  useEffect(() => {
    if (!bridge) return
    const off = bridge.agent.onEvent((ev: OrvexAgentEvent) => {
      // Runs started elsewhere: track only lifecycle so the banner is accurate.
      if (!awaitingAgentRef.current && ev.runId !== agentRunRef.current) {
        if (ev.type === 'run_start') setExternalRun(true)
        else if (ev.type === 'run_end') setExternalRun(false)
        return
      }
      if (ev.type === 'run_start') {
        awaitingAgentRef.current = false
        agentRunRef.current = ev.runId
        agentActiveRef.current = true
        setAgentSteps([])
        setApproval(null)
        setTyping(true)
        setStatusLine('Planning…')
        // The run answers as it goes from here, so speech opens now too.
        beginTurnSpeech()
        return
      }
      if (ev.type === 'answer_delta') {
        if (turnCancelledRef.current) return
        setStatusLine('Receiving…')
        streamTurnText(ev.text)
        feedTurnSpeech(ev.text)
        return
      }
      if (ev.type === 'status') {
        setStatusLine(ev.text)
        return
      }
      if (ev.type === 'context_compacted') {
        setStatusLine(`Compressed ${ev.removed} earlier steps into a summary — context kept at ${ev.kept} entries`)
        return
      }
      if (ev.type === 'compact') {
        setStatusLine(`${ev.model} compressed a tool result ${ev.chars} → ${ev.to} chars`)
        return
      }
      if (ev.type === 'todos') {
        setStatusLine(`Plan: ${ev.remaining} open of ${ev.total} item${ev.total === 1 ? '' : 's'}`)
        return
      }
      if (ev.type === 'delegate_start') {
        setStatusLine(`Sub-agent ${ev.task.agent} started (${ev.task.id})`)
        return
      }
      if (ev.type === 'delegate_end') {
        setStatusLine(`Sub-agent ${ev.task.id} ${ev.task.status}`)
        return
      }
      if (ev.type === 'delegate_progress') {
        if (ev.event && ev.event.type === 'status' && typeof ev.event.text === 'string') {
          setStatusLine(`${ev.agent} sub-agent: ${ev.event.text}`)
        }
        return
      }
      if (ev.type === 'tool_start') {
        setAgentSteps((list) => [...list.slice(-19), { id: ev.id, name: ev.name, ok: null }])
        return
      }
      if (ev.type === 'tool_result') {
        setAgentSteps((list) => list.map((s) => (s.id === ev.id ? { ...s, ok: ev.ok, ms: ev.ms } : s)))
        return
      }
      if (ev.type === 'approval_request') {
        setApproval({ id: ev.id, name: ev.name, reason: ev.reason })
        setStatusLine('Waiting for your approval…')
        return
      }
      if (ev.type === 'approval_result') {
        setApproval(null)
        setStatusLine('')
        return
      }
      if (ev.type === 'run_end') {
        const text = ev.ok
          ? ev.summary || 'Done.'
          : ev.cancelled
            ? 'Stopped.'
            : `Could not finish — ${ev.summary}`
        setTyping(false)
        setStatusLine('')
        setApproval(null)
        agentActiveRef.current = false
        const conv = turnConvRef.current
        const snap = turnHistoryRef.current
        if (conv && snap) {
          const next: Msg[] = [...snap.slice(0, -1), { role: 'assistant', text }]
          turnHistoryRef.current = next
          if (viewingConvRef.current === conv) {
            messagesRef.current = next
            setMessages(next)
          }
          if (turnMetaRef.current) persistTurn(conv, next, turnMetaRef.current)
        } else if (!turnCancelledRef.current) {
          applyMessages((m) => [...m.slice(0, -1), { role: 'assistant', text }])
        }
        if (turnCancelledRef.current || ev.cancelled) resumeMicAfterTurn()
        else finishTurnVoice(text)
      }
    })
    return off
  }, [bridge, applyMessages, speakReply, persistTurn, finishTurnVoice, resumeMicAfterTurn, beginTurnSpeech, feedTurnSpeech, streamTurnText])

  const answerApproval = async (allow: boolean) => {
    if (!bridge || !approval) return
    const id = approval.id
    setApproval(null)
    await bridge.agent.approve(id, allow)
  }

  const stopExternalRun = async () => {
    if (!bridge) return
    setExternalRun(false)
    await bridge.agent.stop()
  }

  const toggleAgentMode = () => {
    const next = !agentMode
    setAgentMode(next)
    try {
      localStorage.setItem(AGENT_MODE_KEY, next ? '1' : '0')
    } catch {
      /* preference is optional */
    }
  }

  const toggleFullAuto = () => {
    const next = !fullAuto
    setFullAuto(next)
    try {
      localStorage.setItem(FULL_AUTO_KEY, next ? '1' : '0')
    } catch {
      /* preference is optional */
    }
  }

  const sendMsg = async (raw: string) => {
    const text = raw.trim()
    if (!text || typingRef.current) return

    typingRef.current = true
    const sequence = ++turnSequenceRef.current
    speechSequenceRef.current += 1
    turnSpeechRef.current = null
    stopSpeaking()
    voice.markSpeaking(false)
    voice.setReplyPhase('thinking')
    if (handsFreeRef.current || wakeTurnRef.current) voice.pauseListening()
    turnCancelledRef.current = false
    let convId = conversationId
    if (!convId) {
      convId = `conv-${Date.now()}`
      setConversationId(convId)
    }
    // Snapshot the transcript before appending — the history payload must not
    // see the user turn or the streaming slot we are about to create.
    const priorMsgs = messagesRef.current
    // The streaming slot is what every later slice(0, -1) writes into. Without it
    // the assistant reply overwrites the user turn and the transcript loses it.
    applyMessages((m) => [...m, { role: 'user', text }, { role: 'assistant', text: '' }])
    // The turn writes through its own snapshot: switching history mid-stream
    // neither leaks the reply into another chat nor saves it under the wrong id.
    viewingConvRef.current = convId
    turnConvRef.current = convId
    turnHistoryRef.current = messagesRef.current
    turnMetaRef.current = {
      agentId: activeAgentId,
      providerId: activeId,
      model: active?.model ?? '',
      tags: parseTags(tagDraft),
    }
    setInput('')
    setTyping(true)
    setStatusLine('')

    const currentAgent = AGENT_PROFILES.find((a) => a.id === activeAgentId) ?? AGENT_PROFILES[0]
    const voicePrompt = handsFreeRef.current || wakeTurnRef.current
      ? 'This is a live voice conversation. Match the user’s language. For ordinary conversation, answer naturally in one or two short sentences without markdown unless they ask for detail. Use tools only when the request needs an action or current information.'
      : ''
    const sysPrompt = `${currentAgent.persona}\n\n${HUMANITY_PROMPT}\n\n${voicePrompt}`

    const historyMsgs: LLMMessage[] = priorMsgs
      .slice(-10)
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
    historyMsgs.push({ role: 'user', content: text })

    /** Replace the assistant slot of this turn, on screen only when it is shown. */
    const writeTurn = (assistantText: string) => {
      const snap = turnHistoryRef.current
      if (!snap || turnConvRef.current !== convId) return
      const next: Msg[] = [...snap.slice(0, -1), { role: 'assistant', text: assistantText }]
      turnHistoryRef.current = next
      if (viewingConvRef.current === convId) {
        messagesRef.current = next
        setMessages(next)
      }
    }

    const persistCurrentTurn = () => {
      if (turnCancelledRef.current) return
      const snap = turnHistoryRef.current
      const meta = turnMetaRef.current
      if (snap && meta) persistTurn(convId, snap, meta)
    }

    if (agentMode && bridge && active && active.model) {
      const context = priorMsgs
        .filter((m) => m.text.trim())
        .slice(-6)
        .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.text.replace(/\s+/g, ' ').slice(0, 500)}`)
        .join('\n')
      const goal = `${voicePrompt ? `${voicePrompt}\n\n` : ''}${context ? `Conversation so far:\n${context}\n\nNow do this: ` : ''}${text}`
      awaitingAgentRef.current = true
      agentRunRef.current = null
      agentActiveRef.current = true
      setAgentSteps([])
      setApproval(null)
      setStatusLine('Starting the agent…')
      const agentCandidates = orderForTask(buildCandidates(providers, activeId), 'agent')
      const res = await bridge.agent.start({
        goal: goal.slice(0, 6000),
        agentId: activeAgentId,
        provider: { id: active.id, presetId: active.presetId, name: active.name, baseUrl: active.baseUrl, apiKey: active.apiKey, api: active.api, model: active.model },
        candidates: agentCandidates,
        local: pickLocal(providers, activeId),
        autoApprove: fullAutoRef.current,
        task: 'agent',
      })
      if (!res.ok) {
        awaitingAgentRef.current = false
        agentActiveRef.current = false
        setTyping(false)
        setStatusLine('')
        const busy = /already running/i.test(res.error)
        if (busy) setExternalRun(true)
        writeTurn(
          busy
            ? 'Another goal is still running — ORVEX only runs one at a time. Stop it with the red banner above, then send this again.'
            : `Could not start the agent — ${res.error}`,
        )
        persistCurrentTurn()
        resumeMicAfterTurn()
      } else if (turnCancelledRef.current) {
        // Stopped while the goal was still opening.
        awaitingAgentRef.current = false
        agentActiveRef.current = false
        setTyping(false)
        setStatusLine('')
        void bridge.agent.stop()
      }
      return
    }

    if (!active) {
      setTyping(false)
      const local = respondLocally(text)
      writeTurn(local)
      persistCurrentTurn()
      finishTurnVoice(local)
      return
    }

    let streamedText = ''
    setStatusLine('Waiting for the model…')
    beginTurnSpeech()

    await send({
      provider: active,
      candidates: orderForTask(buildCandidates(providers, activeId), 'chat'),
      task: 'chat',
      messages: historyMsgs,
      system: sysPrompt,
      onDelta: (delta) => {
        if (turnCancelledRef.current || turnSequenceRef.current !== sequence) return
        setStatusLine('Receiving…')
        streamedText += delta
        writeTurn(streamedText)
        feedTurnSpeech(streamedText)
      },
      onDone: (done) => {
        if (turnCancelledRef.current || turnSequenceRef.current !== sequence) return
        writeTurn(done)
        setStatusLine('')
        persistCurrentTurn()
        setTyping(false)
        finishTurnVoice(done)
      },
      onError: (msg) => {
        if (turnCancelledRef.current || turnSequenceRef.current !== sequence) return
        setTyping(false)
        writeTurn(`Error: ${msg}`)
        persistCurrentTurn()
        logFailure(`Chat · ${active.name}`, msg)
        pushNotification({
          title: 'Model request failed',
          body: msg.slice(0, 160),
          kind: 'model',
        })
        resumeMicAfterTurn()
      },
      onReasoning: (sofar) => {
        // Thinking models stream their chain of thought before any answer. Show a
        // live tail of it so the wait reads as work in progress, not a hang.
        if (viewingConvRef.current !== convId) return
        setStatusLine(`Reasoning · ${sofar.slice(-58).replace(/\s+/g, ' ')}`)
      },
      onFirstToken: () => {
        /* handled inline in onDelta */
      },
    })
  }

  useEffect(() => {
    sendRef.current = sendMsg
  })

  const toggleHandsFree = () => onHandsFreeChange(!handsFree)

  const stopStream = () => {
    speechSequenceRef.current += 1
    turnSequenceRef.current += 1
    turnSpeechRef.current = null
    stopSpeaking()
    voice.markSpeaking(false)
    voice.setReplyPhase(null)
    turnCancelledRef.current = true
    if (agentActiveRef.current && bridge) {
      void bridge.agent.stop()
      return
    }
    // Also covers a turn stopped while the provider is still connecting.
    stopLLM()
    setTyping(false)
    setStatusLine('')
    // Nothing streamed yet: drop the empty assistant slot so the transcript
    // neither keeps a blank bubble nor saves one.
    const conv = turnConvRef.current
    const snap = turnHistoryRef.current
    if (conv && snap) {
      const last = snap[snap.length - 1]
      const cleaned: Msg[] = last && last.role === 'assistant' && !last.text.trim() ? snap.slice(0, -1) : snap
      turnHistoryRef.current = cleaned
      if (viewingConvRef.current === conv) {
        messagesRef.current = cleaned
        setMessages(cleaned)
      }
      const meta = turnMetaRef.current
      if (meta && cleaned.some((m) => m.role === 'user')) persistTurn(conv, cleaned, meta)
    }
    wakeTurnRef.current = false
    if (handsFree) voice.resumeListening()
  }

  const previousHandsFree = useRef(handsFree)
  useEffect(() => {
    if (previousHandsFree.current && !handsFree) stopStream()
    previousHandsFree.current = handsFree
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handsFree])

  const speakLast = () => {
    const last = [...messagesRef.current].reverse().find((m) => m.role === 'assistant')
    if (!last) return
    if (handsFree) voice.pauseListening()
    speakReply(last.text, handsFree ? () => voice.resumeListening() : undefined)
  }

  const toggleSpeak = () => {
    const next = !voiceCfg.autoSpeak
    setVoiceCfg({ autoSpeak: next })
    if (!next) {
      stopSpeaking()
      voice.markSpeaking(false)
      return
    }
    speakReply('Voice replies on. I will read my answers out loud.')
  }

  const saveTags = () => {
    if (!conversationId) return
    const list = loadConversations()
    const existing = list.find((c) => c.id === conversationId)
    if (!existing) return
    const conv: Conversation = { ...existing, tags: parseTags(tagDraft), updatedAt: Date.now() }
    const next = upsertConversation(list, conv)
    saveConversations(next)
    setHistory(next)
  }

  const current = history.find((c) => c.id === conversationId)

  return (
    <PageShell
      title="Chat"
      sub={
        active
          ? `${active.name} · ${active.model}${agentMode ? ' · agent' : ''}`
          : 'No provider — local offline brain'
      }
      onBack={onBack}
      actions={
        <div className="chat-actions">
          <div className="agent-picker">
            <select
              value={activeAgentId}
              onChange={(e) => setActiveAgentId(e.target.value)}
              className="agent-select"
              aria-label="Active agent"
            >
              {AGENT_PROFILES.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <button
            className={`icon-btn ${agentMode ? 'active' : ''}`}
            onClick={toggleAgentMode}
            aria-pressed={agentMode}
            aria-label="Agent mode"
            title={
              agentMode
                ? 'Agent mode on — messages can use your PC, apps and browser'
                : 'Agent mode off — plain chat, no PC access'
            }
          >
            <Brain size={14} />
          </button>
          {agentMode && (
            <button
              className={`icon-btn ${fullAuto ? 'active' : ''}`}
              onClick={toggleFullAuto}
              aria-pressed={fullAuto}
              aria-label="Full auto"
              title={
                fullAuto
                  ? 'Full auto on — risky steps run without asking'
                  : 'Full auto off — risky steps ask first'
              }
            >
              <ShieldAlert size={14} />
            </button>
          )}
          <button className="icon-btn" onClick={newConversation} aria-label="New conversation" title="New conversation">
            <MessageSquare size={14} />
          </button>
          <button
            className={`icon-btn ${handsFree ? 'active' : ''}`}
            onClick={toggleHandsFree}
            aria-pressed={handsFree}
            aria-label="Hands-free conversation"
            disabled={!voice.speechSupported && !handsFree}
            title={
              !voice.speechSupported
                ? 'Hands-free needs speech recognition — use Chrome or Edge'
                : handsFree
                  ? 'Hands-free on — speak, pause to send'
                  : 'Hands-free conversation'
            }
          >
            <AudioLines size={14} />
          </button>
          <button
            className={`icon-btn ${voiceCfg.autoSpeak ? 'active' : ''}`}
            onClick={(e) => {
              if (e.shiftKey) void speakLast()
              else toggleSpeak()
            }}
            aria-pressed={voiceCfg.autoSpeak}
            aria-label="Speak replies out loud"
            title={
              voiceCfg.autoSpeak
                ? 'Voice replies on — click to mute, Shift+click to repeat the last one'
                : 'Voice replies off — click to have answers read out loud (Shift+click repeats the last)'
            }
          >
            <Volume2 size={14} />
          </button>
        </div>
      }
    >
      <div className="chat-wrap">
        <div className="chat-scroll" ref={scrollRef}>
          {externalRun && (
            <div className="chat-agent-banner alert">
              <Loader2 size={11} className="spin" />
              <span>Another goal is still running — ORVEX runs one at a time.</span>
              <button className="ghost-btn" onClick={() => void stopExternalRun()}>
                Stop it
              </button>
            </div>
          )}
          {agentMode && fullAuto && (
            <div className="chat-agent-banner">
              <ShieldAlert size={11} /> Full auto is on — risky steps run without asking. System folders and credentials
              stay blocked.
            </div>
          )}
          {messages.filter((m) => m.text.trim()).map((m, i) => (
            <div key={i} className={`chat-row ${m.role}`}>
              <span className="chat-avatar">
                {m.role === 'assistant' ? <Bot size={14} /> : <User size={13} />}
              </span>
              <div className="chat-bubble">{m.text}</div>
            </div>
          ))}
          {typing && turnConvRef.current === conversationId && (
            <div className="chat-row assistant">
              <span className="chat-avatar"><Bot size={14} /></span>
              <div className="chat-bubble typing">
                <span className="thinking-label">{statusLine || 'Waiting for the model…'}</span>
                {agentMode && agentSteps.length > 0 && (
                  <span className="chat-agent-steps">
                    {agentSteps.slice(-8).map((s) => (
                      <span key={s.id} className={`chat-agent-step ${s.ok === null ? 'run' : s.ok ? 'ok' : 'bad'}`}>
                        {s.ok === null ? (
                          <Loader2 size={10} className="spin" />
                        ) : s.ok ? (
                          <CheckCircle2 size={10} />
                        ) : (
                          <XCircle size={10} />
                        )}
                        {s.name}
                      </span>
                    ))}
                  </span>
                )}
                {approval && (
                  <span className="chat-approval">
                    <span className="chat-approval-text">
                      <strong>{approval.name}</strong> — {approval.reason}
                    </span>
                    <button className="ghost-btn allow" onClick={() => void answerApproval(true)}>
                      Allow
                    </button>
                    <button className="ghost-btn" onClick={() => void answerApproval(false)}>
                      Deny
                    </button>
                  </span>
                )}
                <i /><i /><i />
              </div>
            </div>
          )}
        </div>

        <div className="history-sidebar">
          <div className="history-head">
            <span className="history-title">History</span>
          </div>

          {conversationId && (
            <div className="history-tags">
              <Tag size={10} style={{ color: 'var(--faint)', flex: 'none' }} />
              <input
                className="history-tag-input"
                value={tagDraft}
                placeholder="tag, tag2"
                onChange={(e) => setTagDraft(e.target.value)}
                onBlur={saveTags}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    saveTags()
                  }
                }}
                aria-label="Conversation tags"
              />
            </div>
          )}

          <div className="history-list">
            {history.slice(0, 50).map((c) => (
              <div key={c.id} className={`history-item-wrap ${conversationId === c.id ? 'active' : ''}`}>
                <button className="history-item" onClick={() => loadConv(c)}>
                  <span className="hi-title">{c.title}</span>
                  <span className="hi-meta">
                    <span>{formatTime(c.updatedAt)}</span>
                    <span className="hi-agent">{AGENT_PROFILES.find((a) => a.id === c.agentId)?.name ?? c.agentId}</span>
                  </span>
                  {c.tags.length > 0 && (
                    <span className="hi-tags">
                      {c.tags.map((t) => (
                        <span key={t} className="hi-tag">{t}</span>
                      ))}
                    </span>
                  )}
                </button>
                <button
                  className="history-del"
                  onClick={() => deleteConv(c.id)}
                  aria-label={`Delete conversation ${c.title}`}
                  title="Delete conversation"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
            {history.length === 0 && (
              <div className="history-empty">No conversations yet — start chatting to create one.</div>
            )}
          </div>

          {current && (
            <div className="history-foot dim">
              {current.messages.length} messages · {current.model || 'no model'} · {current.tags.length ? current.tags.join(', ') : 'untagged'}
            </div>
          )}
        </div>

        <form
          className="chat-inputbar"
          onSubmit={(e) => {
            e.preventDefault()
            sendMsg(input)
          }}
        >
          <input
            className="command-input"
            placeholder={
              handsFree && !voice.error
                ? 'Listening — speak, then pause to send'
                : agentMode && active
                  ? 'Tell ORVEX what to do on your PC…'
                  : active
                    ? 'Message ORVEX…'
                    : 'Connect a provider in Settings → Providers'
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-label="Chat message"
          />
          {handsFree && (
            <span className={`hf-hint ${voice.error ? 'bad' : ''}`}>
              {voice.error ?? (voice.status === 'listening' ? 'Hands-free · pause to send' : 'Hands-free · starting mic…')}
            </span>
          )}
          <button
            type="button"
            className="icon-btn !w-[34px] !h-[34px] !border-0 !bg-transparent"
            onClick={() => onHandsFreeChange(voice.status !== 'listening' && voice.status !== 'starting')}
            aria-label={voice.status === 'listening' ? 'Stop voice input' : 'Voice input'}
            title={voice.status === 'listening' ? 'Stop voice input' : 'Voice input'}
          >
            <Mic size={15} />
          </button>
          <button
            type="submit"
            className={typing ? 'send-btn sending' : 'send-btn'}
            onClick={typing ? stopStream : undefined}
            aria-label={typing ? 'Stop generation' : 'Send message'}
          >
            {typing ? <Sparkles size={15} className="spin" /> : <Send size={15} />}
          </button>
        </form>
      </div>
    </PageShell>
  )
}

function parseTags(raw: string): string[] {
  return [...new Set(raw.split(',').map((t) => t.trim()).filter(Boolean))].slice(0, 8)
}
