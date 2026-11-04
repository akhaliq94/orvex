import { useCallback, useEffect, useRef, useState } from 'react'
import { AGENT_BY_ID, FILLERS, THINKING_LINES, type AgentProfile } from '../data/agents'

/**
 * Makes an agent answer the way a person does: a beat of silence while it thinks,
 * a natural opener, then words that land at an uneven pace instead of appearing at once.
 *
 * Works two ways:
 *  - `typeOut` reveals an already-generated string word by word (used when a real
 *    LLM provider answered — the text is real, only the pacing is humanised).
 *  - `respond` produces a local reply when no provider is configured. The wording is
 *    template-based and is always labelled as an offline reply.
 */

const rand = (min: number, max: number) => min + Math.random() * (max - min)
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]

export function useHumanAgent(agentId: string) {
  const agent: AgentProfile = AGENT_BY_ID[agentId] ?? AGENT_BY_ID.general
  const timers = useRef<number[]>([])
  /** Let a pending think()/typeOut() settle when it is cancelled, instead of hanging. */
  const thinkResolve = useRef<(() => void) | null>(null)
  const typeResolve = useRef<(() => void) | null>(null)
  const [thinking, setThinking] = useState(false)

  // Drop every pending timer and settle any awaited promise when the caller
  // unmounts, so a chat that navigates away does not keep typing in the dark.
  useEffect(
    () => () => {
      timers.current.forEach((t) => window.clearTimeout(t))
      timers.current = []
      thinkResolve.current?.()
      typeResolve.current?.()
      thinkResolve.current = null
      typeResolve.current = null
    },
    [],
  )

  const clear = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t))
    timers.current = []
    const settleThink = thinkResolve.current
    thinkResolve.current = null
    settleThink?.()
    const settleType = typeResolve.current
    typeResolve.current = null
    settleType?.()
    setThinking(false)
  }, [])

  const after = useCallback((ms: number, fn: () => void) => {
    const id = window.setTimeout(fn, ms)
    timers.current.push(id)
    return id
  }, [])

  /** Reveals text at an uneven, word-by-word pace. Resolves when finished. */
  const typeOut = useCallback(
    (text: string, onChunk: (full: string) => void, onDone?: () => void): Promise<void> => {
      clear()
      const [lo, hi] = agent.traits.wordMs
      const words = text.split(/(\s+)/)
      let i = 0
      let acc = ''

      return new Promise((resolve) => {
        typeResolve.current = resolve
        const finish = () => {
          if (typeResolve.current === resolve) typeResolve.current = null
          resolve()
        }
        const step = () => {
          if (i >= words.length) {
            onChunk(acc)
            onDone?.()
            finish()
            return
          }
          const word = words[i++]
          acc += word
          onChunk(acc)
          // pauses read as thought breaks
          const pause = Math.random() < agent.traits.pauseChance ? rand(120, 420) : 0
          after(rand(lo, hi) + pause, step)
        }
        after(rand(lo, hi) * 0.6, step)
      })
    },
    [agent, after, clear],
  )

  /** Waits out the agent's thinking beat, showing a status line meanwhile. */
  const think = useCallback(
    (onStatus?: (line: string) => void): Promise<void> => {
      clear()
      setThinking(true)
      const [lo, hi] = agent.traits.thinkMs
      const delay = rand(lo, hi)
      onStatus?.(pick(THINKING_LINES))
      return new Promise((resolve) => {
        thinkResolve.current = resolve
        after(delay, () => {
          if (thinkResolve.current === resolve) thinkResolve.current = null
          setThinking(false)
          resolve()
        })
      })
    },
    [agent, after, clear],
  )

  /**
   * Offline reply used when no LLM provider is configured. Honest wording: it says
   * it is running locally and cannot reach a model.
   */
  const respondLocally = useCallback(
    (input: string): string => {
      const q = input.toLowerCase().trim()
      const filler = Math.random() < 0.45 ? `${pick(FILLERS)} ` : ''

      const ask = q.match(/\b(what|who|when|where|why|how)\b/)
      const name = q.match(/\b(name|call you|who are you|your name)\b/)
      const greet = /^(hi|hey|hello|salam|assalam|yo|good (morning|evening|afternoon))\b/.test(q)
      const help = /\b(help|what can you do|commands|capabilities)\b/.test(q)
      const thanks = /\b(thanks|thank you|shukriya|shukriya)\b/.test(q)
      const code = /\b(code|function|bug|error|typescript|javascript|python|react)\b/.test(q)
      const file = /\b(file|folder|directory|document)\b/.test(q)
      const web = /\b(search|google|web|internet|find online|latest)\b/.test(q)
      const run = /\b(run|execute|automate|schedule|cron)\b/.test(q)

      const head = (body: string) =>
        `${filler}${body}\n\n_Note: I am answering from ORVEX's local offline brain. Connect a model in **Settings → Providers** for a real answer._`

      if (greet) return head(`Hey. ${pick(agent.sampleGreetings)}`)
      if (name) return head(`I am ${agent.name}, the ${agent.role.toLowerCase()} here. I am running locally right now.`)
      if (thanks) return head(`Anytime. Ping me when you need the next thing done.`)
      if (help) {
        return head(
          `Here is what I can do from this screen:\n\n` +
            `- **Chat** — talk to a model once you connect one in Settings → Providers\n` +
            `- **Voice** — real microphone input, with the core reacting to your voice\n` +
            `- **Agents** — this crew, their org map and their individual profiles\n` +
            `- **Code** — a scratch editor with a console\n` +
            `- **Browser** — quick links, bookmarks and history\n` +
            `- **Files** — a browsable file tree with notes\n` +
            `- **Automation** — a real workflow builder with cron schedules, tool steps, conditions, loops, approvals and run history\n` +
            `- **Knowledge** — notes plus a searchable memory browser\n` +
            `- **Tools** — calculator and unit conversion\n` +
            `- **System** — resource gauges and preferences\n` +
            `- **Control PC** — real screen capture and OCR, mouse/keyboard, windows, processes, clipboard, UI Automation, system volume/brightness/media keys and screen recording`,
        )
      }
      if (code) {
        return head(
          `For "${input.slice(0, 60)}" I would want to see the actual file first — the **Code** tab has a scratch editor, and ` +
            `**Files** has the project tree. Share the snippet or the error text and I will work through the fix with you.`,
        )
      }
      if (file) {
        return head(
          `I can browse the workspace tree from the **Files** page and keep notes in **Knowledge**. ` +
            `Tell me the folder name you care about and I will map it out.`,
        )
      }
      if (web) {
        return head(
          `**Scout** handles web research — open the **Browser** page and give Scout the query. ` +
            `Right now I have no search backend wired in, so I will not pretend I found anything.`,
        )
      }
      if (run) {
        return head(
          `**Rigger** builds the routine. Open **Automation**, select a workflow and press Run — ` +
            `each step executes a real tool, cron workflows run themselves, and risky steps wait for your approval on the Runs tab.`,
        )
      }
      if (ask) {
        return head(
          `That is a good question, and I want to answer it properly rather than guess. ` +
            `Connect a model in Settings → Providers and I will give you a real answer; until then I can point you at the ` +
            `right ORVEX panel for "${input.slice(0, 40)}".`,
        )
      }
      return head(
        `Got it — "${input.slice(0, 60)}". I am ${agent.name}, and I am running on ORVEX's local offline brain right now, ` +
          `so I can route it but not reason about it fully. Plug in a provider in Settings → Providers and I will take it from there.`,
      )
    },
    [agent],
  )

  return { agent, thinking, think, typeOut, respondLocally, clear }
}

/**
 * Human-paced reveal of text that is being generated live.
 *
 * Feed it chunks as they arrive from a real provider and it releases them at a
 * human cadence — uneven word timing, occasional mid-sentence pauses — so a live
 * stream reads like someone typing rather than a wall of text appearing at once.
 * The content itself is untouched; only the reveal timing is humanised.
 */
export function useHumanStream(agentId: string, onReveal: (text: string) => void) {
  const agent: AgentProfile = AGENT_BY_ID[agentId] ?? AGENT_BY_ID.general
  const buffer = useRef('')
  const revealed = useRef('')
  const timer = useRef<number | null>(null)
  const [lo, hi] = agent.traits.wordMs

  const revealRef = useRef(onReveal)
  revealRef.current = onReveal

  const pump = useCallback(() => {
    if (buffer.current.length === 0) {
      timer.current = null
      return
    }
    const m = buffer.current.match(/^\S+\s*/)
    const chunk = m ? m[0] : buffer.current.slice(0, 1)
    buffer.current = buffer.current.slice(chunk.length)
    revealed.current += chunk
    revealRef.current(revealed.current)

    // Someone typing pauses at punctuation and sometimes mid-thought. Match that
    // so a live stream reads like speech rather than a marquee.
    const tail = chunk.trimEnd()
    let pause = 0
    if (/[.!?…]$/.test(tail)) pause = rand(220, 520)
    else if (/[,;:—–]$/.test(tail)) pause = rand(90, 240)
    else if (Math.random() < agent.traits.pauseChance) pause = rand(120, 420)

    timer.current = window.setTimeout(pump, lo + Math.random() * (hi - lo) + pause)
  }, [agent, lo, hi])

  const feed = useCallback(
    (delta: string) => {
      buffer.current += delta
      if (timer.current === null) timer.current = window.setTimeout(pump, 0)
    },
    [pump],
  )

  const flush = useCallback((rest: string) => {
    buffer.current = ''
    revealed.current += rest
    revealRef.current(revealed.current)
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const reset = useCallback(() => {
    buffer.current = ''
    revealed.current = ''
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  useEffect(() => reset, [reset])

  return { feed, flush, reset }
}
