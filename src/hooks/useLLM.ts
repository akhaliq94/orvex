import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderConfig } from '../data/providers'
import type { OrvexAgentProvider } from '../types/desktop'

export type LLMMessage = { role: 'user' | 'assistant' | 'system'; content: string }

export type StreamState = 'idle' | 'thinking' | 'streaming' | 'error'

export type StreamHandle = {
  abort: () => void
}

type Options = {
  provider: ProviderConfig | null
  /** Ordered fallback chain (active provider first); desktop streams through the gateway. */
  candidates?: OrvexAgentProvider[]
  task?: string
  messages: LLMMessage[]
  temperature?: number
  maxTokens?: number
  system?: string
  onDelta: (text: string, full: string) => void
  onDone: (full: string) => void
  onError: (message: string) => void
  /** called once the first token arrives */
  onFirstToken?: () => void
  /**
   * Called with the running chain-of-thought for models that stream it separately
   * (Ollama qwen3 / deepseek-r1 put it in `delta.reasoning`). Surfacing it keeps the
   * UI alive while the model thinks instead of showing a bare spinner.
   */
  onReasoning?: (fullReasoning: string) => void
}

/**
 * Streams a chat completion from the active provider.
 * OpenAI-compatible endpoints are consumed as SSE; Anthropic uses its /messages stream.
 */
export function useLLM() {
  const [state, setState] = useState<StreamState>('idle')
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<StreamHandle | null>(null)

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setState('idle')
  }, [])

  // A stream must not keep running (or keep firing callbacks) after the page
  // that started it is gone.
  useEffect(
    () => () => {
      abortRef.current?.abort()
      abortRef.current = null
    },
    [],
  )

  const send = useCallback(
    async (opts: Options): Promise<StreamHandle> => {
      const { provider, messages, temperature = 0.7, maxTokens = 2048, system, onDelta, onDone, onError, onFirstToken, onReasoning, candidates, task } = opts

      if (!provider) {
        const msg = 'No provider is active. Open Settings → Providers and pick one.'
        setError(msg)
        onError(msg)
        return { abort: stop }
      }

      // Desktop: stream through the main-process gateway so retries, fallback,
      // routing and real token/cost accounting apply to plain chat too.
      const bridge = typeof window !== 'undefined' ? window.orvex : undefined
      if (bridge?.llm) {
        setError(null)
        setState('thinking')
        const requestId = `llm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
        let settled = false
        let unsub: (() => void) | null = null
        let handle: StreamHandle | null = null

        const settle = () => {
          if (settled) return false
          settled = true
          unsub?.()
          unsub = null
          if (abortRef.current === handle) abortRef.current = null
          return true
        }

        handle = {
          abort: () => {
            if (!settle()) return
            void bridge.llm.abort(requestId)
            setState('idle')
          },
        }
        // Registered before the gateway finishes connecting so Stop works while
        // the request is still opening.
        abortRef.current = handle

        unsub = bridge.llm.onEvent((evt) => {
          if (!evt || evt.requestId !== requestId) return
          if (evt.type === 'first') {
            setState('streaming')
            onFirstToken?.()
          } else if (evt.type === 'delta') {
            setState('streaming')
            onDelta(evt.text, evt.full)
          } else if (evt.type === 'reasoning') {
            onReasoning?.(evt.text)
          } else if (evt.type === 'done') {
            if (!settle()) return
            setState('idle')
            onDone(evt.text)
          } else if (evt.type === 'aborted') {
            if (!settle()) return
            setState('idle')
          } else if (evt.type === 'error') {
            if (!settle()) return
            setError(evt.message)
            setState('error')
            onError(evt.message)
          }
        })

        const started = await bridge.llm.start({
          requestId,
          provider: {
            // The identity is what lets the main process attach the stored key:
            // without it every turn is sent unauthenticated, refused with 401 and
            // only answered by the fallback copy of the same provider.
            id: provider.id,
            presetId: provider.presetId,
            name: provider.name,
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            api: provider.api,
            model: provider.model,
          },
          candidates,
          messages,
          system,
          temperature,
          maxTokens,
          task: task ?? 'chat',
        })

        if (!started.ok) {
          if (settle()) {
            setError(started.error)
            setState('error')
            onError(started.error)
          }
          return handle
        }

        return handle
      }

      const base = provider.baseUrl.replace(/\/+$/, '')
      const controller = new AbortController()
      abortRef.current = controller
      setError(null)
      setState('thinking')

      const history = system
        ? [{ role: 'system' as const, content: system }, ...messages]
        : messages

      try {
        const url = provider.api === 'anthropic' ? `${base}/messages` : `${base}/chat/completions`
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (provider.api === 'anthropic') {
          if (provider.apiKey) headers['x-api-key'] = provider.apiKey
          headers['anthropic-version'] = '2023-06-01'
        } else if (provider.apiKey) {
          headers.authorization = `Bearer ${provider.apiKey}`
        }

        const body =
          provider.api === 'anthropic'
            ? JSON.stringify({
                model: provider.model,
                max_tokens: maxTokens,
                temperature,
                stream: true,
                messages: history.filter((m) => m.role !== 'system'),
                ...(system ? { system } : {}),
              })
            : JSON.stringify({
                model: provider.model,
                temperature,
                max_tokens: maxTokens,
                stream: true,
                messages: history,
              })

        const res = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        })

        if (!res.ok) {
          const text = await res.text().catch(() => '')
          const msg = `HTTP ${res.status} — ${text.slice(0, 240) || res.statusText}`
          abortRef.current = null
          setError(msg)
          setState('error')
          onError(msg)
          return { abort: stop }
        }

        if (!res.body) {
          const msg = 'Response had no body stream.'
          abortRef.current = null
          setError(msg)
          setState('error')
          onError(msg)
          return { abort: stop }
        }

        setState('streaming')
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let full = ''
        let reasoning = ''
        let first = true

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          const parts = buffer.split('\n')
          buffer = parts.pop() ?? ''

          for (const part of parts) {
            const line = part.trim()
            if (!line || !line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '[DONE]') continue

            let json: unknown
            try {
              json = JSON.parse(payload)
            } catch {
              continue
            }

            let delta = ''
            if (provider.api === 'anthropic') {
              const evt = json as { type?: string; delta?: { text?: string } }
              if (evt.type === 'content_block_delta' && evt.delta?.text) delta = evt.delta.text
            } else {
              const evt = json as { choices?: { delta?: { content?: string; reasoning?: string; reasoning_content?: string } }[] }
              delta = evt.choices?.[0]?.delta?.content ?? ''
              const r = evt.choices?.[0]?.delta?.reasoning ?? evt.choices?.[0]?.delta?.reasoning_content ?? ''
              if (r) {
                reasoning += r
                onReasoning?.(reasoning)
              }
            }

            if (delta) {
              if (first) {
                first = false
                onFirstToken?.()
              }
              full += delta
              onDelta(delta, full)
            }
          }
        }

        abortRef.current = null
        setState('idle')
        onDone(full)
      } catch (e) {
        abortRef.current = null
        if ((e as Error).name === 'AbortError') {
          setState('idle')
          return { abort: stop }
        }
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg)
        setState('error')
        onError(msg)
      }

      return { abort: stop }
    },
    [stop],
  )

  return { state, error, send, stop }
}
