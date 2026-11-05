/**
 * Provider catalog modelled on models.dev (https://models.dev).
 * Base URLs and model ids mirror the public models.dev registry so ORVEX can talk
 * to hosted APIs and to local OpenAI-compatible servers (Ollama, LM Studio, llama.cpp).
 */

export type ProviderKind = 'hosted' | 'local' | 'custom'

export type ProviderPreset = {
  id: string
  name: string
  kind: ProviderKind
  /** OpenAI-compatible endpoint root; no trailing /chat/completions */
  baseUrl: string
  /** API style — ORVEX currently speaks the OpenAI chat-completions dialect */
  api: 'openai' | 'anthropic'
  /** env var models.dev lists for this provider */
  env: string[]
  models: string[]
  note: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'ollama',
    name: 'Ollama (local)',
    kind: 'local',
    baseUrl: 'http://localhost:11434/v1',
    api: 'openai',
    env: [],
    models: ['llama3.1', 'qwen3:8b', 'qwen2.5-coder', 'mistral-nemo', 'phi4', 'gemma3'],
    note: 'Local runner. Base URL must be reachable from the browser (CORS on).',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    kind: 'local',
    baseUrl: 'http://localhost:1234/v1',
    api: 'openai',
    env: [],
    models: ['local-model'],
    note: 'LM Studio local server. Turn on the developer server first.',
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp server (local)',
    kind: 'local',
    baseUrl: 'http://localhost:8080/v1',
    api: 'openai',
    env: [],
    models: ['local-model'],
    note: 'Any OpenAI-compatible server: llama.cpp, vLLM, Jan, GPT4All, text-generation-webui.',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'hosted',
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai',
    env: ['OPENAI_API_KEY'],
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'gpt-4.1'],
    note: 'Hosted API. The key is stored in the OS-encrypted vault on desktop.',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'hosted',
    baseUrl: 'https://api.anthropic.com/v1',
    api: 'anthropic',
    env: ['ANTHROPIC_API_KEY'],
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    note: 'Anthropic native API — ORVEX uses its /messages dialect for this provider.',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    kind: 'hosted',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    api: 'openai',
    env: ['GEMINI_API_KEY'],
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    note: 'OpenAI-compatible endpoint is also exposed by Google for Gemini.',
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'hosted',
    baseUrl: 'https://api.groq.com/openai/v1',
    api: 'openai',
    env: ['GROQ_API_KEY'],
    models: ['llama-3.3-70b-versatile', 'whisper-large-v3-turbo'],
    note: 'Very fast inference on open models.',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    kind: 'hosted',
    baseUrl: 'https://api.mistral.ai/v1',
    api: 'openai',
    env: ['MISTRAL_API_KEY'],
    models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
    note: 'Hosted Mistral platform.',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'hosted',
    baseUrl: 'https://api.deepseek.com/v1',
    api: 'openai',
    env: ['DEEPSEEK_API_KEY'],
    models: ['deepseek-chat', 'deepseek-reasoner'],
    note: 'Reasoning model support via the OpenAI-compatible route.',
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    kind: 'hosted',
    baseUrl: 'https://api.x.ai/v1',
    api: 'openai',
    env: ['XAI_API_KEY'],
    models: ['grok-4', 'grok-3-mini'],
    note: 'Grok models.',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'hosted',
    baseUrl: 'https://openrouter.ai/api/v1',
    api: 'openai',
    env: ['OPENROUTER_API_KEY'],
    models: ['anthropic/claude-sonnet-4.6', 'openai/gpt-4o', 'google/gemini-2.5-pro'],
    note: 'Aggregator — one key, many models.',
  },
  {
    id: 'together',
    name: 'Together AI',
    kind: 'hosted',
    baseUrl: 'https://api.together.xyz/v1',
    api: 'openai',
    env: ['TOGETHER_API_KEY'],
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo'],
    note: 'Hosted open-model inference.',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    kind: 'hosted',
    baseUrl: 'https://api.cerebras.ai/v1',
    api: 'openai',
    env: ['CEREBRAS_API_KEY'],
    models: ['llama-3.3-70b', 'llama3.1-8b'],
    note: 'Wafer-scale inference, very low latency.',
  },
  {
    id: 'custom',
    name: 'Custom / OpenAI-compatible',
    kind: 'custom',
    baseUrl: 'http://localhost:8000/v1',
    api: 'openai',
    env: [],
    models: ['model-id'],
    note: 'Anything speaking the OpenAI chat-completions dialect. Paste your own base URL.',
  },
]

export type ProviderConfig = {
  id: string
  presetId: string
  name: string
  baseUrl: string
  /** a key typed in this session only — stored keys never come back from the vault */
  apiKey: string
  /** true when the OS vault already holds a key for this provider */
  hasKey?: boolean
  api: 'openai' | 'anthropic'
  models: string[]
  model: string
  enabled: boolean
  kind: ProviderKind
  /** env var names this provider conventionally uses */
  env: string[]
  /** model ids the API/catalogue reports at $0 per token (free-only filter) */
  freeModels?: string[]
  /** choose models from the free list only */
  freeOnly?: boolean
}

export type ProviderState = {
  providers: ProviderConfig[]
  activeId: string | null
}

export const DEFAULT_PROVIDERS: ProviderConfig[] = PROVIDER_PRESETS.map((p) => ({
  id: p.id,
  presetId: p.id,
  name: p.name,
  baseUrl: p.baseUrl,
  apiKey: '',
  api: p.api,
  models: p.models,
  model: p.models[0] ?? '',
  enabled: p.kind === 'local' || p.id === 'custom',
  kind: p.kind,
  env: p.env,
}))

export const STORAGE_KEY = 'orvex-providers'

export function loadProviders(): ProviderState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { providers: DEFAULT_PROVIDERS, activeId: 'ollama' }
    const parsed = JSON.parse(raw) as Partial<ProviderState>
    if (!Array.isArray(parsed.providers) || parsed.providers.length === 0) {
      return { providers: DEFAULT_PROVIDERS, activeId: 'ollama' }
    }
    return {
      providers: parsed.providers.map((p) => ({
        ...p,
        env: p.env ?? PROVIDER_PRESETS.find((r) => r.id === p.presetId)?.env ?? [],
      })),
      activeId: parsed.activeId ?? parsed.providers[0].id,
    }
  } catch {
    return { providers: DEFAULT_PROVIDERS, activeId: 'ollama' }
  }
}

export function saveProviders(state: ProviderState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* quota or private mode — the running session keeps its settings */
  }
}

export type ProviderTestResult =
  | { ok: true; label: string; detail: string }
  | { ok: false; label: string; detail: string }

/**
 * Reads the live model list from an OpenAI-compatible server (`GET /models`).
 * Returns null when the endpoint is missing or blocked, so callers can fall back
 * to manual model ids.
 */
export async function fetchModelIds(p: ProviderConfig): Promise<string[] | null> {
  const remote = await fetchRemoteModels(p)
  return remote ? remote.models.map((m) => m.id) : null
}

export type RemoteModel = { id: string; free: boolean }
export type RemoteModelList = {
  models: RemoteModel[]
  /** true when the server returned pricing, so `free` is authoritative */
  priced: boolean
}

function isZeroPrice(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '' && Number(v) === 0
}

/**
 * Like fetchModelIds, but keeps each model's pricing. OpenRouter and a few
 * aggregators return a `pricing` block per model; when they do, a $0 in/out
 * price is the only thing we label free — no guessing from model names alone.
 */
export async function fetchRemoteModels(p: ProviderConfig): Promise<RemoteModelList | null> {
  const bridge = typeof window !== 'undefined' ? window.orvex?.providers : undefined
  if (bridge) {
    const res = await bridge.models({
      id: p.id,
      presetId: p.presetId,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      api: p.api,
      model: p.model,
    })
    if (res.ok) return res.data
  }
  const base = p.baseUrl.replace(/\/+$/, '')
  try {
    const res = await fetch(`${base}/models`, {
      method: 'GET',
      headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {},
    })
    if (!res.ok) return null
    const data = (await res.json()) as { data?: Record<string, unknown>[] }
    const rows = Array.isArray(data.data) ? data.data : []
    const models: RemoteModel[] = []
    let priced = false
    for (const row of rows) {
      const id = typeof row?.id === 'string' ? row.id : ''
      if (!id) continue
      let free = /:free$/i.test(id)
      const pricing = row.pricing as Record<string, unknown> | undefined
      if (pricing && typeof pricing === 'object') {
        const pin = pricing.prompt ?? pricing.input
        const pout = pricing.completion ?? pricing.output
        if (pin !== undefined || pout !== undefined) {
          priced = true
          free = isZeroPrice(pin) && isZeroPrice(pout)
        }
      }
      models.push({ id, free })
    }
    return models.length ? { models, priced } : null
  } catch {
    return null
  }
}

type CatalogModel = { cost?: { input?: number; output?: number } }
let catalogPromise: Promise<Record<string, { models?: Record<string, CatalogModel> }> | null> | null = null

/** models.dev catalogue — gives pricing for providers whose /models omits it. */
function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch('https://models.dev/api.json')
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, { models?: Record<string, CatalogModel> }>>) : null))
      .catch(() => null)
  }
  return catalogPromise
}

const CATALOG_PROVIDER_IDS: Record<string, string> = { together: 'togetherai' }

/**
 * Cross-checks model ids against the models.dev price list. Returns null when
 * the catalogue is unreachable, otherwise the ids listed at $0 in and out.
 */
export async function freeIdsFromCatalog(presetId: string, ids: string[]): Promise<string[] | null> {
  const catalog = await loadCatalog()
  if (!catalog) return null
  const provider = catalog[CATALOG_PROVIDER_IDS[presetId] ?? presetId]
  if (!provider?.models) return null
  const free: string[] = []
  for (const id of ids) {
    const cost = provider.models[id]?.cost
    if (cost && Number(cost.input) === 0 && Number(cost.output) === 0) free.push(id)
  }
  return free
}

/** Real network check against the configured endpoint. */
export async function testProvider(p: ProviderConfig): Promise<ProviderTestResult> {
  const bridge = typeof window !== 'undefined' ? window.orvex?.providers : undefined
  if (bridge) {
    const res = await bridge.test({
      id: p.id,
      presetId: p.presetId,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      api: p.api,
      model: p.model,
    })
    if (res.ok) return res.data
    return { ok: false, label: p.name, detail: res.error }
  }
  const base = p.baseUrl.replace(/\/+$/, '')
  const started = performance.now()

  if (p.api === 'anthropic') {
    const res = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': p.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: p.model || 'claude-sonnet-4-6',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })
    const ms = Math.round(performance.now() - started)
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, label: p.name, detail: `HTTP ${res.status} — ${body.slice(0, 160) || res.statusText}` }
    }
    const data = (await res.json()) as { content?: { text?: string }[] }
    return { ok: true, label: p.name, detail: `Connected in ${ms}ms — replied "${data.content?.[0]?.text?.slice(0, 40) ?? 'ok'}"` }
  }

  const res = await fetch(`${base}/models`, {
    method: 'GET',
    headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {},
  })
  const ms = Math.round(performance.now() - started)

  if (!res.ok) {
    // Some servers disable /models; fall back to a minimal completion probe.
    if (res.status === 404 || res.status === 405) {
      const probe = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: p.model || 'local-model',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      })
      const pms = Math.round(performance.now() - started)
      if (!probe.ok) {
        const body = await probe.text().catch(() => '')
        return { ok: false, label: p.name, detail: `HTTP ${probe.status} — ${body.slice(0, 160) || probe.statusText}` }
      }
      return { ok: true, label: p.name, detail: `Connected in ${pms}ms (chat probe)` }
    }
    const body = await res.text().catch(() => '')
    return { ok: false, label: p.name, detail: `HTTP ${res.status} — ${body.slice(0, 160) || res.statusText}` }
  }

  const data = (await res.json()) as { data?: { id?: string }[] }
  const ids = (data.data ?? []).map((m) => m.id).filter(Boolean) as string[]
  return {
    ok: true,
    label: p.name,
    detail: `Connected in ${ms}ms — ${ids.length ? `${ids.length} models (${ids.slice(0, 3).join(', ')})` : 'server reachable'}`,
  }
}
