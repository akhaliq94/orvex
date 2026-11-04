import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  BarChart3,
  BellRing,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  Image as ImageIcon,
  KeyRound,
  ListPlus,
  Loader2,
  Mic,
  Monitor,
  Palette,
  Plug,
  Plus,
  RefreshCcw,
  Server,
  Sparkles,
  Trash2,
  Upload,
  Workflow,
  X,
} from 'lucide-react'
import PageShell from './PageShell'
import ThemePanel from '../components/ThemePanel'
import { onTablistKeyDown } from '../data/a11y'
import { useBackground, PRESET_WALLPAPERS, type BgKind } from '../hooks/useBackground'
import { useProviders } from '../hooks/useProviders'
import { PROVIDER_PRESETS, fetchRemoteModels, freeIdsFromCatalog, testProvider, type ProviderConfig, type RemoteModelList } from '../data/providers'
import { VOICE_ENGINES, VOICE_PRESETS, useVoiceSettings, type VoiceEngineId, speak } from '../data/voice'
import { discoverSpeech } from '../data/voicestudio'
import { hasSttKey, saveSttKey, sttTarget } from '../data/stt'
import { HEYGEN_MODELS, fetchHeygenVoices, hasHeygenKey, saveHeygenKey, type HeygenVoice } from '../data/heygen'
import type { Theme } from '../themes'
import type {
  OrvexAppPrefs,
  OrvexMcpServer,
  OrvexMcpStatus,
  OrvexRouteRef,
  OrvexUsageRow,
  OrvexUsageSummary,
  OrvexWindowAction,
  OrvexWindowState,
} from '../types/desktop'
import { TASKS, clearServerRoute, loadRoutes, persistRoute, saveRoutesLocal, type RouteMap, type TaskId } from '../data/routing'
import {
  clearNotifications,
  clearRead,
  markAllRead,
  notificationsStore,
  unreadCount,
  useStore,
} from '../data/stores'

type Tab = 'app' | 'theme' | 'background' | 'providers' | 'routing' | 'usage' | 'mcp' | 'voice'

const TABS: { id: Tab; label: string; icon: typeof Palette }[] = [
  { id: 'app', label: 'App', icon: Monitor },
  { id: 'theme', label: 'Theme', icon: Palette },
  { id: 'background', label: 'Background', icon: ImageIcon },
  { id: 'providers', label: 'Providers', icon: Server },
  { id: 'routing', label: 'Routing', icon: Workflow },
  { id: 'usage', label: 'Usage', icon: BarChart3 },
  { id: 'mcp', label: 'MCP', icon: Plug },
  { id: 'voice', label: 'Voice', icon: Mic },
]

type Props = {
  onBack: () => void
  notify: (m: string) => void
  themeId: string
  auto: boolean
  onSelectTheme: (t: Theme) => void
  onToggleAuto: () => void
}

export default function SettingsPage({
  onBack,
  notify,
  themeId,
  auto,
  onSelectTheme,
  onToggleAuto,
}: Props) {
  const [tab, setTab] = useState<Tab>('theme')

  return (
    <PageShell
      title="Settings"
      sub="App window, notifications, theme, background, model providers, routing, usage and cost, MCP servers and voice"
      onBack={onBack}
      actions={
        <div className="settings-tabs" role="tablist" aria-label="Settings sections" onKeyDown={onTablistKeyDown}>
          {TABS.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                tabIndex={tab === t.id ? 0 : -1}
                className={`settings-tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <Icon size={13} />
                {t.label}
              </button>
            )
          })}
        </div>
      }
    >
      {tab === 'app' && <AppTab notify={notify} />}
      {tab === 'theme' && (
        <div className="settings-section">
          <div className="settings-block">
            <h3 className="settings-h">Appearance</h3>
            <p className="settings-note">
              Twelve built-in themes. The active theme also drives the accent colour of the orb, panels and charts.
            </p>
            <div className="settings-theme-fit">
              <ThemePanel themeId={themeId} auto={auto} onSelect={onSelectTheme} onToggleAuto={onToggleAuto} />
            </div>
          </div>
        </div>
      )}

      {tab === 'background' && <BackgroundTab notify={notify} />}
      {tab === 'providers' && <ProvidersTab notify={notify} />}
      {tab === 'routing' && <RoutingTab notify={notify} />}
      {tab === 'usage' && <UsageTab notify={notify} />}
      {tab === 'mcp' && <McpTab notify={notify} />}
      {tab === 'voice' && <VoiceTab notify={notify} />}
    </PageShell>
  )
}

/* ------------------------------------------------------------------ background */

function BackgroundTab({ notify }: { notify: (m: string) => void }) {
  const { bg, setBg, reset } = useBackground()
  const fileRef = useRef<HTMLInputElement>(null)

  const onFile = (f: File | undefined) => {
    if (!f) return
    if (!f.type.startsWith('image/')) {
      notify('That file is not an image.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setBg({ kind: 'image', image: String(reader.result) })
      notify('Background image applied')
    }
    reader.readAsDataURL(f)
  }

  return (
    <div className="settings-section">
      <div className="settings-block">
        <div className="settings-block-head">
          <h3 className="settings-h">Background</h3>
          <button className="ghost-btn" onClick={() => { reset(); notify('Background reset to theme default') }}>
            <RefreshCcw size={11} /> Reset
          </button>
        </div>

        <div className="bg-kinds">
          {([
            ['theme', 'Theme', 'Use the theme gradient'],
            ['solid', 'Solid', 'Flat colour'],
            ['gradient', 'Gradient', 'Two-stop gradient'],
            ['image', 'Image', 'Upload or URL'],
          ] as [BgKind, string, string][]).map(([id, label, sub]) => (
            <button
              key={id}
              className={`bg-kind ${bg.kind === id ? 'active' : ''}`}
              onClick={() => setBg({ kind: id })}
            >
              <span className="bg-kind-name">{label}</span>
              <span className="bg-kind-sub">{sub}</span>
            </button>
          ))}
        </div>

        {bg.kind === 'solid' && (
          <div className="field-row">
            <label className="field-label" htmlFor="bg-color">Colour</label>
            <div className="field-inline">
              <input
                id="bg-color"
                type="color"
                value={bg.color}
                onChange={(e) => setBg({ color: e.target.value })}
                className="color-swatch"
              />
              <input className="text-input" value={bg.color} onChange={(e) => setBg({ color: e.target.value })} />
            </div>
          </div>
        )}

        {bg.kind === 'gradient' && (
          <>
            <div className="field-row">
              <label className="field-label">Stops</label>
              <div className="field-inline">
                <input
                  type="color"
                  value={bg.gradientA}
                  onChange={(e) => setBg({ gradientA: e.target.value })}
                  className="color-swatch"
                  aria-label="Gradient start colour"
                />
                <input
                  type="color"
                  value={bg.gradientB}
                  onChange={(e) => setBg({ gradientB: e.target.value })}
                  className="color-swatch"
                  aria-label="Gradient end colour"
                />
              </div>
            </div>
            <div className="field-row">
              <label className="field-label" htmlFor="bg-angle">Angle</label>
              <input
                id="bg-angle"
                type="range"
                min={0}
                max={360}
                value={bg.gradientAngle}
                onChange={(e) => setBg({ gradientAngle: Number(e.target.value) })}
                className="range"
              />
              <span className="range-val">{bg.gradientAngle}°</span>
            </div>
          </>
        )}

        {bg.kind === 'image' && (
          <>
            <div className="field-row">
              <label className="field-label" htmlFor="bg-url">Image URL</label>
              <input
                id="bg-url"
                className="text-input"
                placeholder="https://…/wallpaper.jpg"
                value={bg.image.startsWith('data:') ? '' : bg.image}
                onChange={(e) => setBg({ image: e.target.value })}
              />
            </div>
            <div className="field-row">
              <label className="field-label">Upload</label>
              <div className="field-inline">
                <button className="ghost-btn" onClick={() => fileRef.current?.click()}>
                  <Upload size={11} /> Choose file
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = '' }}
                />
                {bg.image.startsWith('data:') && (
                  <button className="ghost-btn" onClick={() => setBg({ image: '' })}>
                    <X size={11} /> Clear
                  </button>
                )}
              </div>
            </div>
            <div className="field-row">
              <label className="field-label" htmlFor="bg-fit">Fit</label>
              <select id="bg-fit" className="select" value={bg.fit} onChange={(e) => setBg({ fit: e.target.value as typeof bg.fit })}>
                <option value="cover">Cover</option>
                <option value="contain">Contain</option>
                <option value="repeat">Tile</option>
              </select>
            </div>
          </>
        )}

        {bg.kind !== 'theme' && (
          <>
            <div className="field-row">
              <label className="field-label" htmlFor="bg-opacity">Strength</label>
              <input
                id="bg-opacity"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={bg.opacity}
                onChange={(e) => setBg({ opacity: Number(e.target.value) })}
                className="range"
              />
              <span className="range-val">{Math.round(bg.opacity * 100)}%</span>
            </div>
            <div className="field-row">
              <label className="field-label" htmlFor="bg-blur">Blur</label>
              <input
                id="bg-blur"
                type="range"
                min={0}
                max={24}
                value={bg.blur}
                onChange={(e) => setBg({ blur: Number(e.target.value) })}
                className="range"
              />
              <span className="range-val">{bg.blur}px</span>
            </div>
            <div className="field-row">
              <label className="field-label" htmlFor="bg-veil">Veil</label>
              <input
                id="bg-veil"
                type="range"
                min={0}
                max={0.9}
                step={0.05}
                value={bg.veil}
                onChange={(e) => setBg({ veil: Number(e.target.value) })}
                className="range"
              />
              <span className="range-val">{Math.round(bg.veil * 100)}%</span>
            </div>
          </>
        )}

        <div className="settings-block-head mt-4">
          <h3 className="settings-h">Presets</h3>
        </div>
        <div className="bg-presets">
          {PRESET_WALLPAPERS.map((p) => (
            <button
              key={p.id}
              className="bg-preset"
              style={{ background: `linear-gradient(${p.angle}deg, ${p.a}, ${p.b})` }}
              onClick={() => { setBg({ kind: 'gradient', gradientA: p.a, gradientB: p.b, gradientAngle: p.angle }); notify(`${p.name} applied`) }}
            >
              <span>{p.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ providers */

type TestState = { id: string; status: 'testing' | 'ok' | 'fail'; detail: string } | null

const QUICK_CLOUD: { presetId: string; label: string; model: string; note: string }[] = [
  {
    presetId: 'groq',
    label: 'Groq',
    model: 'llama-3.3-70b-versatile',
    note: 'Fastest tool calls. Free tier key from console.groq.com.',
  },
  {
    presetId: 'google',
    label: 'Gemini',
    model: 'gemini-2.5-flash',
    note: 'Google AI Studio key. Generous free tier, strong on long tasks.',
  },
  {
    presetId: 'openrouter',
    label: 'OpenRouter',
    model: 'google/gemini-2.5-flash',
    note: 'One key, many models — ":free" models cost nothing.',
  },
]

function ProvidersTab({ notify }: { notify: (m: string) => void }) {
  const { providers, activeId, setActiveId, upsert, patch, remove, reset, clearKey, secureKeys } = useProviders()
  const [test, setTest] = useState<TestState>(null)
  const [showKey, setShowKey] = useState<Record<string, boolean>>({})
  const [modelDraft, setModelDraft] = useState<Record<string, string>>({})
  const [pulling, setPulling] = useState<string | null>(null)
  const [freeBusy, setFreeBusy] = useState<string | null>(null)
  const [cloudKey, setCloudKey] = useState<Record<string, string>>({})
  const [cloudBusy, setCloudBusy] = useState<string | null>(null)
  const fetchedRef = useRef<Record<string, string>>({})

  const active = providers.find((p) => p.id === activeId) ?? null

  /** Merge a live /models response, keeping the pricing flags we got from it. */
  const applyRemote = async (p: ProviderConfig, remote: RemoteModelList, updateModel: boolean) => {
    const ids = [...new Set(remote.models.map((m) => m.id))]
    let free = remote.models.filter((m) => m.free).map((m) => m.id)
    let known = remote.priced
    if (!remote.priced) {
      const cat = await freeIdsFromCatalog(p.presetId, ids)
      if (cat) {
        free = cat
        known = true
      }
    }
    patch(p.id, {
      models: ids,
      freeModels: [...new Set(free)],
      ...(updateModel && !ids.includes(p.model) ? { model: ids[0] ?? '' } : {}),
    })
    return { ids, free: [...new Set(free)], known }
  }

  /** Pull the live model list off the server (Ollama, LM Studio, vLLM all expose it). */
  const pullModels = async (p: ProviderConfig) => {
    setPulling(p.id)
    const remote = await fetchRemoteModels(p)
    if (!remote) {
      setPulling(null)
      notify(`${p.name}: no /models list available — type the model id manually`)
      return
    }
    const { ids, free } = await applyRemote(p, remote, true)
    setPulling(null)
    notify(`${p.name}: ${ids.length} models imported${free.length ? ` · ${free.length} free` : ''}`)
  }

  // A pasted API key should fill the model dropdown without an extra click.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      for (const p of providers) {
        if (!(p.apiKey || p.hasKey) || p.kind === 'local' || p.api === 'anthropic') continue
        const sig = `${p.baseUrl}|${p.apiKey || 'vault'}`
        if (fetchedRef.current[p.id] === sig) continue
        fetchedRef.current[p.id] = sig
        void (async () => {
          const remote = await fetchRemoteModels(p)
          if (!remote) return
          const ids = remote.models.map((m) => m.id)
          if (ids.length === p.models.length && ids.every((id, i) => id === p.models[i])) return
          const placeholder = !p.model || p.model === 'model-id'
          await applyRemote(p, remote, placeholder)
        })()
      }
    }, 900)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers])

  /** Fill the free list (first click) and let the model dropdown filter to it. */
  const toggleFreeOnly = async (p: ProviderConfig, on: boolean) => {
    patch(p.id, { freeOnly: on })
    if (!on) return
    if (p.freeModels !== undefined && p.freeModels.length) return
    setFreeBusy(p.id)
    const remote = await fetchRemoteModels(p)
    let free: string[] = p.freeModels ?? []
    let known = false
    if (remote) {
      const applied = await applyRemote(p, remote, false)
      free = applied.free
      known = applied.known
    } else {
      const cat = await freeIdsFromCatalog(p.presetId, p.models)
      if (cat) {
        free = cat
        known = true
        patch(p.id, { freeModels: cat })
      }
    }
    setFreeBusy(null)
    if (!free.length) {
      notify(
        known
          ? `${p.name}: no $0-priced models found`
          : `${p.name}: pricing data unavailable — add an API key for the live list`,
      )
    } else {
      notify(`${p.name}: ${free.length} free models — pick one below`)
    }
  }

  const runTest = async (p: ProviderConfig) => {
    setTest({ id: p.id, status: 'testing', detail: 'Contacting server…' })
    try {
      const r = await testProvider(p)
      setTest({ id: p.id, status: r.ok ? 'ok' : 'fail', detail: r.detail })
      notify(r.ok ? `${p.name}: ${r.detail}` : `${p.name} failed — ${r.detail}`)
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      setTest({ id: p.id, status: 'fail', detail })
      notify(`${p.name} failed — ${detail}`)
    }
  }

  /** Paste a key, make that hosted provider the brain, and pull its live model list. */
  const useCloud = async (q: (typeof QUICK_CLOUD)[number]) => {
    const key = (cloudKey[q.presetId] ?? '').trim()
    if (!key) {
      notify(`Paste your ${q.label} API key first`)
      return
    }
    const preset = PROVIDER_PRESETS.find((p) => p.id === q.presetId)
    if (!preset) return
    const existing = providers.find((p) => p.presetId === q.presetId || p.id === q.presetId)
    const id = existing?.id ?? q.presetId
    const model = existing?.model && existing.model !== 'model-id' ? existing.model : q.model
    const target: ProviderConfig = {
      id,
      presetId: preset.id,
      name: existing?.name ?? preset.name,
      baseUrl: preset.baseUrl,
      apiKey: key,
      api: preset.api,
      models: existing?.models ?? [...preset.models],
      model,
      enabled: true,
      kind: 'hosted',
      env: preset.env,
    }
    if (existing) patch(id, { apiKey: key, enabled: true, model })
    else upsert(target)
    setActiveId(id)
    setCloudKey((s) => ({ ...s, [q.presetId]: '' }))
    setCloudBusy(q.presetId)
    const remote = await fetchRemoteModels(target)
    setCloudBusy(null)
    if (!remote) {
      notify(`${q.label} is the brain now — model list unavailable, check the key if replies fail`)
      return
    }
    const ids = [...new Set(remote.models.map((m) => m.id))]
    const keep = ids.includes(model) ? model : ids.includes(q.model) ? q.model : ids[0]
    patch(id, { models: ids, freeModels: remote.models.filter((m) => m.free).map((m) => m.id), model: keep })
    notify(`${q.label} is the brain now · ${keep} · ${ids.length} models`)
  }

  const addProvider = () => {
    const id = `custom-${Date.now()}`
    const base = PROVIDER_PRESETS.find((p) => p.id === 'custom')!
    upsert({
      id,
      presetId: 'custom',
      name: 'New provider',
      baseUrl: base.baseUrl,
      apiKey: '',
      api: 'openai',
      models: [...base.models],
      model: base.models[0] ?? '',
      enabled: true,
      kind: 'custom',
      env: [],
    })
    setActiveId(id)
    notify('Provider added — set its base URL')
  }

  return (
    <div className="settings-section">
      <div className="settings-block">
        <div className="settings-block-head">
          <h3 className="settings-h">Model providers</h3>
          <div className="flex gap-2">
            <button className="ghost-btn" onClick={() => { reset(); notify('Provider list reset') }}>
              <RefreshCcw size={11} /> Reset
            </button>
            <button className="primary-btn !py-1 !px-2.5 !text-[10px]" onClick={addProvider}>
              <Plus size={12} /> Add provider
            </button>
          </div>
        </div>

        <p className="settings-note">
          ORVEX speaks the OpenAI chat-completions dialect, so any local server that exposes it works — Ollama, LM Studio,
          llama.cpp, vLLM, Jan. Base URL is the endpoint root, without <code>/chat/completions</code>. Paste an API key and
          the live model list loads into the dropdown automatically; the{' '}
          <ListPlus size={10} style={{ verticalAlign: -1 }} /> button re-syncs it.
          Catalogue shaped after <span style={{ color: 'var(--accent)' }}>models.dev</span>.
        </p>

        <div className="cloud-quick">
          <div className="cloud-quick-head">
            <Sparkles size={11} />
            <span>
              Fast cloud brain — this PC's local models answer at ~8 tokens/s. Paste a key and the same tasks finish in
              seconds.
            </span>
          </div>
          <div className="cloud-grid">
            {QUICK_CLOUD.map((q) => {
              const row = providers.find((p) => p.presetId === q.presetId)
              const isActive = !!row && row.id === activeId
              return (
                <div key={q.presetId} className={`cloud-card ${isActive ? 'on' : ''}`}>
                  <div className="cloud-card-head">
                    <strong>{q.label}</strong>
                    {isActive && <span className="kind-pill k-hosted">active</span>}
                  </div>
                  <span className="cloud-note">{q.note}</span>
                  <div className="cloud-row">
                    <input
                      className="text-input"
                      type="password"
                      placeholder="API key"
                      aria-label={`${q.label} API key`}
                      value={cloudKey[q.presetId] ?? ''}
                      onChange={(e) => setCloudKey((s) => ({ ...s, [q.presetId]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void useCloud(q)
                        }
                      }}
                    />
                    <button
                      className="primary-btn !py-1 !px-2 !text-[9.5px]"
                      onClick={() => void useCloud(q)}
                      disabled={cloudBusy === q.presetId}
                    >
                      {cloudBusy === q.presetId ? <Loader2 size={11} className="spin" /> : 'Use'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {active && (
          <div className="active-provider">
            <span className="live-dot" />
            <span>
              Active: <strong>{active.name}</strong> · <code>{active.model || 'no model set'}</code>
            </span>
            <span className="active-provider-url">{active.baseUrl}</span>
          </div>
        )}

        <div className="provider-list">
          {providers.map((p) => {
            const st = test?.id === p.id ? test : null
            const modelList = (p.freeOnly ? (p.freeModels ?? []) : p.models).slice()
            if (p.model && !modelList.includes(p.model)) modelList.unshift(p.model)
            return (
              <div key={p.id} className={`provider-row ${p.id === activeId ? 'active' : ''}`}>
                <div className="provider-head">
                  <button
                    className={`radio ${p.id === activeId ? 'on' : ''}`}
                    onClick={() => { setActiveId(p.id); notify(`${p.name} is now the active provider`) }}
                    aria-label={`Make ${p.name} active`}
                    aria-pressed={p.id === activeId}
                  >
                    {p.id === activeId && <Check size={10} />}
                  </button>
                  <input
                    className="provider-name"
                    value={p.name}
                    onChange={(e) => upsert({ ...p, name: e.target.value })}
                    aria-label="Provider name"
                  />
                  <span className={`kind-pill k-${p.kind}`}>{p.kind}</span>
                  <div className="ml-auto flex gap-1.5">
                    <button
                      className="icon-btn !w-[26px] !h-[26px]"
                      onClick={() => pullModels(p)}
                      disabled={pulling === p.id || p.api === 'anthropic'}
                      title={p.api === 'anthropic' ? 'Anthropic has no model listing' : 'Import the model list from this server'}
                      aria-label={`Import models from ${p.name}`}
                    >
                      {pulling === p.id ? <Loader2 size={12} className="spin" /> : <ListPlus size={12} />}
                    </button>
                    <button className="icon-btn !w-[26px] !h-[26px]" onClick={() => runTest(p)} title="Test connection" aria-label={`Test ${p.name}`}>
                      {st?.status === 'testing' ? <Loader2 size={12} className="spin" /> : <PlugIcon ok={st?.status === 'ok'} />}
                    </button>
                    {p.kind === 'custom' && (
                      <button className="icon-btn !w-[26px] !h-[26px]" onClick={() => remove(p.id)} title="Remove provider" aria-label={`Remove ${p.name}`}>
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>

                <div className="provider-fields">
                  <label className="pf">
                    <span>Base URL</span>
                    <input
                      className="text-input"
                      value={p.baseUrl}
                      onChange={(e) => upsert({ ...p, baseUrl: e.target.value })}
                      placeholder="http://localhost:11434/v1"
                    />
                  </label>
                  <label className="pf">
                    <span>API key</span>
                    <div className="key-wrap">
                      <KeyRound size={11} />
                      <input
                        className="text-input"
                        type={showKey[p.id] ? 'text' : 'password'}
                        value={p.apiKey}
                        onChange={(e) => upsert({ ...p, apiKey: e.target.value })}
                        placeholder={
                          p.hasKey
                            ? 'Saved in the OS vault — type a new key to replace it'
                            : p.env[0]
                              ? `optional — ${p.env[0]}`
                              : 'not needed for local servers'
                        }
                        autoComplete="off"
                      />
                      <button className="key-eye" onClick={() => setShowKey((s) => ({ ...s, [p.id]: !s[p.id] }))} aria-label="Toggle key visibility">
                        {showKey[p.id] ? <EyeOff size={11} /> : <Eye size={11} />}
                      </button>
                      {p.hasKey && (
                        <button
                          className="key-eye"
                          onClick={() => clearKey(p.id)}
                          title="Delete the stored key"
                          aria-label={`Delete the stored key for ${p.name}`}
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </div>
                  </label>
                  <label className="pf">
                    <span>API style</span>
                    <select className="select" value={p.api} onChange={(e) => upsert({ ...p, api: e.target.value as ProviderConfig['api'] })}>
                      <option value="openai">OpenAI compatible</option>
                      <option value="anthropic">Anthropic messages</option>
                    </select>
                  </label>
                  <div className="pf">
                    <span className="pf-label">
                      Model
                      {p.kind !== 'local' && (
                        <label
                          className="free-check"
                          title="Show only models this provider (or the models.dev price list) reports at $0 per token"
                        >
                          <input
                            type="checkbox"
                            checked={!!p.freeOnly}
                            onChange={(e) => void toggleFreeOnly(p, e.target.checked)}
                          />
                          {freeBusy === p.id && <Loader2 size={9} className="spin" />}
                          free only
                        </label>
                      )}
                    </span>
                    <select
                      className="select"
                      value={p.model}
                      onChange={(e) => patch(p.id, { model: e.target.value })}
                      aria-label={`Model for ${p.name}`}
                    >
                      {!p.model && <option value="">pick a model</option>}
                      {modelList.map((m) => (
                        <option key={m} value={m}>
                          {m}
                          {p.freeOnly && !(p.freeModels ?? []).includes(m) ? ' · not free' : ''}
                        </option>
                      ))}
                      {p.freeOnly && (p.freeModels?.length ?? 0) === 0 && (
                        <option value="">no free models yet</option>
                      )}
                    </select>
                  </div>
                </div>

                <div className="provider-extra">
                  <input
                    className="text-input"
                    placeholder="Add model id, then press Enter"
                    value={modelDraft[p.id] ?? ''}
                    onChange={(e) => setModelDraft((d) => ({ ...d, [p.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return
                      const v = (modelDraft[p.id] ?? '').trim()
                      if (!v) return
                      patch(p.id, { models: [...new Set([...p.models, v])], model: v })
                      setModelDraft((d) => ({ ...d, [p.id]: '' }))
                    }}
                  />
                  <button
                    className="ghost-btn"
                    onClick={() => {
                      const v = (modelDraft[p.id] ?? '').trim()
                      if (!v) return
                      patch(p.id, { models: [...new Set([...p.models, v])], model: v })
                      setModelDraft((d) => ({ ...d, [p.id]: '' }))
                      notify(`Model "${v}" added`)
                    }}
                  >
                    <Plus size={11} />
                  </button>
                  {p.models.length > 0 && (
                    <button className="ghost-btn" onClick={() => { navigator.clipboard?.writeText(p.models.join(', ')); notify('Model list copied') }}>
                      <Copy size={11} />
                    </button>
                  )}
                </div>

                {st && st.status !== 'testing' && (
                  <div className={`provider-test ${st.status}`}>
                    {st.status === 'ok' ? <Check size={11} /> : <AlertTriangle size={11} />}
                    <span>{st.detail}</span>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="settings-note mt-3">
          {secureKeys
            ? 'Keys live in the OS-encrypted store on this device (Electron safeStorage) and never in plain localStorage.'
            : "Keys are stored in this browser's localStorage on this device only."}
        </div>
      </div>
    </div>
  )
}

function PlugIcon({ ok }: { ok: boolean }) {
  if (ok) return <Check size={12} style={{ color: '#4ade80' }} />
  return <Server size={12} />
}

/* -------------------------------------------------------------------- routing */

const TASK_BY_ID = new Map(TASKS.map((t) => [t.id, t]))

function RoutingTab({ notify }: { notify: (m: string) => void }) {
  const { providers } = useProviders()
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const [routes, setRoutes] = useState<RouteMap>(() => loadRoutes())
  const [drafts, setDrafts] = useState<Partial<Record<TaskId, string>>>({})
  const [saving, setSaving] = useState<TaskId | null>(null)

  useEffect(() => {
    if (!bridge?.routing) return
    void bridge.routing
      .get()
      .then((res) => {
        if (!res.ok) return
        const merged = { ...loadRoutes(), ...((res.data.routing || {}) as RouteMap) }
        setRoutes(merged)
        saveRoutesLocal(merged)
      })
      .catch(() => undefined)
  }, [bridge])

  const models = useMemo(() => {
    const out: { key: string; label: string; ref: OrvexRouteRef }[] = []
    for (const p of providers) {
      for (const m of new Set([...(p.model ? [p.model] : []), ...p.models])) {
        if (!m) continue
        out.push({
          key: `${p.id}|${m}`,
          label: `${p.name} · ${m}`,
          ref: { providerId: p.id, id: p.id, presetId: p.presetId, model: m, name: p.name },
        })
      }
    }
    return out
  }, [providers])

  const chainFor = (task: TaskId) => routes[task] ?? []
  const setChain = (task: TaskId, chain: OrvexRouteRef[]) => setRoutes((r) => ({ ...r, [task]: chain }))

  const addModel = (task: TaskId) => {
    const m = models.find((x) => x.key === drafts[task])
    if (!m) return
    const chain = chainFor(task)
    if (chain.some((r) => String(r.providerId || r.id) === String(m.ref.providerId) && r.model === m.ref.model)) {
      notify('That model is already in this chain')
      return
    }
    setChain(task, [...chain, m.ref])
    setDrafts((d) => ({ ...d, [task]: '' }))
  }

  const move = (task: TaskId, index: number, delta: number) => {
    const chain = [...chainFor(task)]
    const to = index + delta
    if (to < 0 || to >= chain.length) return
    const [row] = chain.splice(index, 1)
    chain.splice(to, 0, row)
    setChain(task, chain)
  }

  const save = async (task: TaskId) => {
    setSaving(task)
    const res = await persistRoute(task, chainFor(task))
    setSaving(null)
    const label = TASK_BY_ID.get(task)?.label ?? task
    notify(res.ok ? `${label}: ${chainFor(task).length} models in the chain` : res.error || 'Could not save the chain')
  }

  const reset = async (task: TaskId) => {
    await clearServerRoute(task)
    setChain(task, [])
    notify(`${TASK_BY_ID.get(task)?.label ?? task}: back to the active-provider order`)
  }

  const labelFor = (ref: OrvexRouteRef) =>
    models.find((m) => String(m.ref.providerId) === String(ref.providerId || ref.id) && m.ref.model === ref.model)?.label ??
    `${ref.name || ref.providerId || ref.id}${ref.model ? ` · ${ref.model}` : ''}`

  return (
    <div className="settings-section">
      <div className="settings-block">
        <h3 className="settings-h">Task routing</h3>
        <p className="settings-note">
          Each task gets its own model chain: the first entry answers, the rest are fallbacks tried automatically when a
          provider is rate-limited, down or rejects the request. Leave a chain empty to use the active provider first, then
          every other enabled model. Chains are stored in the desktop database, and every call records real tokens and cost.
        </p>

        {!bridge && (
          <div className="settings-note" style={{ color: '#f59e0b' }}>
            Routing runs inside the desktop app. In browser dev, chat uses the active provider directly.
          </div>
        )}

        <div className="route-list">
          {TASKS.map((task) => {
            const chain = chainFor(task.id)
            const available = models.filter(
              (m) => !chain.some((r) => String(r.providerId || r.id) === String(m.ref.providerId) && r.model === m.ref.model),
            )
            return (
              <div key={task.id} className="route-task">
                <div className="route-task-head">
                  <div>
                    <strong>{task.label}</strong>
                    <span className="route-hint">{task.hint}</span>
                  </div>
                  <div className="flex gap-2">
                    <button className="ghost-btn" onClick={() => void reset(task.id)} disabled={!chain.length}>
                      Default
                    </button>
                    <button
                      className="primary-btn !py-1 !px-2.5 !text-[10px]"
                      onClick={() => void save(task.id)}
                      disabled={saving === task.id}
                    >
                      {saving === task.id ? <Loader2 size={11} className="spin" /> : 'Save'}
                    </button>
                  </div>
                </div>

                {chain.length === 0 ? (
                  <div className="route-empty">No override — active provider first, then other enabled models.</div>
                ) : (
                  <ol className="route-chain">
                    {chain.map((ref, i) => (
                      <li key={`${ref.providerId || ref.id}-${ref.model}-${i}`} className="route-chip">
                        <span className="route-index">{i === 0 ? 'primary' : `fallback ${i}`}</span>
                        <span className="route-model">{labelFor(ref)}</span>
                        <button
                          className="icon-btn !w-[22px] !h-[22px]"
                          onClick={() => move(task.id, i, -1)}
                          disabled={i === 0}
                          aria-label="Move up"
                        >
                          <ChevronUp size={11} />
                        </button>
                        <button
                          className="icon-btn !w-[22px] !h-[22px]"
                          onClick={() => move(task.id, i, 1)}
                          disabled={i === chain.length - 1}
                          aria-label="Move down"
                        >
                          <ChevronDown size={11} />
                        </button>
                        <button
                          className="icon-btn !w-[22px] !h-[22px]"
                          onClick={() => setChain(task.id, chain.filter((_, j) => j !== i))}
                          aria-label="Remove from chain"
                        >
                          <X size={11} />
                        </button>
                      </li>
                    ))}
                  </ol>
                )}

                <div className="route-add">
                  <select
                    className="select"
                    value={drafts[task.id] ?? ''}
                    onChange={(e) => setDrafts((d) => ({ ...d, [task.id]: e.target.value }))}
                    aria-label={`Add a model to ${task.label}`}
                  >
                    <option value="">Add a model…</option>
                    {available.map((m) => (
                      <option key={m.key} value={m.key}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <button className="ghost-btn" onClick={() => addModel(task.id)} disabled={!drafts[task.id]}>
                    <Plus size={11} /> Add
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------------- usage */

const USAGE_WINDOWS = [
  { id: '24h', label: '24 hours', ms: 24 * 3600 * 1000 },
  { id: '7d', label: '7 days', ms: 7 * 24 * 3600 * 1000 },
  { id: '30d', label: '30 days', ms: 30 * 24 * 3600 * 1000 },
  { id: 'all', label: 'All time', ms: 3650 * 24 * 3600 * 1000 },
]

const fmtInt = (n: number | null | undefined) => Number(n || 0).toLocaleString('en-US')
const fmtCost = (n: number | null | undefined) => {
  const v = Number(n || 0)
  if (v === 0) return '$0.00'
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`
}

function UsageTab({ notify }: { notify: (m: string) => void }) {
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const [win, setWin] = useState('24h')
  const [summary, setSummary] = useState<OrvexUsageSummary | null>(null)
  const [recent, setRecent] = useState<OrvexUsageRow[]>([])
  const [dbInfo, setDbInfo] = useState<{ ready: boolean; file: string | null; error: string | null } | null>(null)
  const [budget, setBudget] = useState<{ dailyUsd: number; todayUsd: number } | null>(null)
  const [budgetDraft, setBudgetDraft] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!bridge?.usage) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    const ms = USAGE_WINDOWS.find((w) => w.id === win)?.ms ?? 24 * 3600 * 1000
    void Promise.all([bridge.usage.summary(ms), bridge.usage.recent(40), bridge.db.info(), bridge.budget.get()])
      .then(([s, r, d, b]) => {
        if (cancelled) return
        setLoading(false)
        if (s.ok) setSummary(s.data)
        else notify(s.error)
        if (r.ok) setRecent(r.data)
        if (d.ok) setDbInfo(d.data)
        if (b.ok) {
          setBudget(b.data)
          setBudgetDraft(b.data.dailyUsd ? String(b.data.dailyUsd) : '')
        }
      })
      .catch((err) => {
        if (cancelled) return
        setLoading(false)
        notify(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, win])

  const saveBudget = async () => {
    if (!bridge?.budget) return
    const value = Number(budgetDraft)
    if (!Number.isFinite(value) || value < 0) {
      notify('Enter a USD amount per day (0 removes the limit)')
      return
    }
    const res = await bridge.budget.set(value)
    if (!res.ok) {
      notify(res.error)
      return
    }
    setBudget({ dailyUsd: res.data.dailyUsd, todayUsd: budget?.todayUsd ?? 0 })
    setBudgetDraft(res.data.dailyUsd ? String(res.data.dailyUsd) : '')
    notify(res.data.dailyUsd ? `Daily budget set to $${res.data.dailyUsd.toFixed(2)}` : 'Daily budget removed')
  }

  const clear = async () => {
    if (!bridge?.usage) return
    if (!window.confirm('Delete all usage history? Cost and token totals will reset to zero.')) return
    const res = await bridge.usage.clear()
    if (!res.ok) {
      notify(res.error)
      return
    }
    setSummary(null)
    setRecent([])
    notify('Usage history cleared')
  }

  const resetBreakers = async () => {
    if (!bridge?.health) return
    const res = await bridge.health.reset()
    notify(res.ok ? 'Provider circuit breakers reset' : res.error)
  }

  const totals = summary?.totals ?? null

  return (
    <div className="settings-section">
      <div className="settings-block">
        <div className="settings-block-head">
          <h3 className="settings-h">Model usage &amp; cost</h3>
          <div className="flex gap-1.5">
            {USAGE_WINDOWS.map((w) => (
              <button key={w.id} className={`ghost-btn ${win === w.id ? 'active' : ''}`} onClick={() => setWin(w.id)}>
                {w.label}
              </button>
            ))}
            <button className="ghost-btn" onClick={resetBreakers} title="Providers skipped after repeated failures resume immediately">
              <RefreshCcw size={11} /> Breakers
            </button>
            <button className="ghost-btn" onClick={() => void clear()} title="Delete usage history">
              <Trash2 size={11} />
            </button>
          </div>
        </div>

        <p className="settings-note">
          Every model call through the gateway is recorded here: prompt/completion tokens, duration, success and estimated
          cost. Prices come from the provider response when it reports them (OpenRouter) and from the models.dev catalogue
          otherwise; local endpoints are $0.
        </p>

        {!bridge && <div className="settings-note" style={{ color: '#f59e0b' }}>Usage history lives in the desktop app database.</div>}

        {loading ? (
          <div className="settings-note">
            <Loader2 size={11} className="spin" /> Reading the database…
          </div>
        ) : (
          <>
            <div className="usage-budget">
              <div className="usage-budget-row">
                <span>Daily budget (USD)</span>
                <input
                  className="text-input"
                  type="number"
                  min="0"
                  step="0.5"
                  value={budgetDraft}
                  onChange={(e) => setBudgetDraft(e.target.value)}
                  placeholder="No limit"
                  aria-label="Daily budget in USD"
                />
                <button className="primary-btn !py-1 !px-2.5 !text-[10px]" onClick={() => void saveBudget()}>
                  Save
                </button>
                <span className="usage-budget-spent">
                  Today: <strong>{fmtCost(budget?.todayUsd)}</strong>
                  {budget && budget.dailyUsd > 0 ? ` of ${fmtCost(budget.dailyUsd)}` : ' · no limit'}
                </span>
              </div>
              {budget && budget.dailyUsd > 0 && (
                <div className="usage-budget-bar">
                  <i style={{ width: `${Math.min(100, (budget.todayUsd / budget.dailyUsd) * 100)}%` }} />
                </div>
              )}
              <p className="usage-budget-note">
                At the limit, paid model calls stop and local models keep working. Set 0 for no limit.
              </p>
            </div>

            <div className="usage-stats">
              <div className="usage-stat">
                <span>Calls</span>
                <strong>{fmtInt(totals?.calls)}</strong>
              </div>
              <div className="usage-stat">
                <span>Tokens</span>
                <strong>{fmtInt(totals?.tokens)}</strong>
              </div>
              <div className="usage-stat">
                <span>Cost</span>
                <strong>{fmtCost(totals?.cost)}</strong>
              </div>
              <div className="usage-stat">
                <span>Est. calls</span>
                <strong>{fmtInt(totals?.estimated)}</strong>
              </div>
              <div className="usage-stat">
                <span>Failures</span>
                <strong>{fmtInt(totals?.failures)}</strong>
              </div>
              <div className="usage-stat">
                <span>Avg latency</span>
                <strong>{totals?.avgMs ? `${Math.round(Number(totals.avgMs))} ms` : '—'}</strong>
              </div>
            </div>

            <h4 className="usage-sub">By model</h4>
            {summary?.byModel?.length ? (
              <div className="usage-table">
                <div className="usage-row usage-head">
                  <span>Provider · model</span>
                  <span>Calls</span>
                  <span>Tokens</span>
                  <span>Cost</span>
                </div>
                {summary.byModel.map((row, i) => (
                  <div key={`${row.provider}-${row.model}-${i}`} className="usage-row">
                    <span className="usage-model">
                      {row.provider || 'unknown'} · <code>{row.model || '—'}</code>
                      {row.estimated ? ' · est.' : ''}
                    </span>
                    <span>{fmtInt(row.calls)}</span>
                    <span>{fmtInt(row.tokens)}</span>
                    <span>{fmtCost(row.cost)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="route-empty">No calls in this window yet.</div>
            )}

            <h4 className="usage-sub">By task</h4>
            {summary?.byTask?.length ? (
              <div className="usage-table">
                <div className="usage-row usage-head">
                  <span>Task</span>
                  <span>Calls</span>
                  <span>Tokens</span>
                  <span>Cost</span>
                </div>
                {summary.byTask.map((row) => (
                  <div key={row.task} className="usage-row">
                    <span className="usage-model">{row.task}</span>
                    <span>{fmtInt(row.calls)}</span>
                    <span>{fmtInt(row.tokens)}</span>
                    <span>{fmtCost(row.cost)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="route-empty">No task data yet.</div>
            )}

            <h4 className="usage-sub">Recent calls</h4>
            {recent.length ? (
              <div className="usage-recent">
                {recent.map((row) => (
                  <div key={row.id ?? `${row.ts}-${row.model}`} className={`usage-call ${row.ok === 0 ? 'failed' : ''}`}>
                    <span className="usage-call-time">{new Date(Number(row.ts)).toLocaleString()}</span>
                    <span className="usage-call-model">
                      {row.provider || '—'} · {row.model || '—'}
                      {row.task ? ` · ${row.task}` : ''}
                    </span>
                    <span className="usage-call-num">{fmtInt(row.tokens)} tok</span>
                    <span className="usage-call-num">{fmtCost(row.cost)}</span>
                    <span className="usage-call-ms">{row.ms ? `${row.ms} ms` : ''}</span>
                    {row.error && <span className="usage-call-err">{String(row.error).slice(0, 120)}</span>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="route-empty">Nothing recorded in this window.</div>
            )}

            {dbInfo && (
              <div className="settings-note mt-3">
                {dbInfo.ready ? (
                  <>
                    Database: <code>{dbInfo.file}</code>
                  </>
                ) : (
                  <>Database unavailable — {dbInfo.error || 'better-sqlite3 did not load'}. Usage is not being stored.</>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ mcp */

const MCP_EXAMPLE = `{
  "name": "Filesystem",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\Users\\\\you\\\\Documents"],
  "enabled": true,
  "autoApprove": false,
  "timeoutMs": 120000
}`

function McpTab({ notify }: { notify: (m: string) => void }) {
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const [servers, setServers] = useState<OrvexMcpServer[]>([])
  const [status, setStatus] = useState<OrvexMcpStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [jsonMode, setJsonMode] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [draft, setDraft] = useState({ name: '', command: '', args: '', autoApprove: false })

  const apply = (list: OrvexMcpServer[], st: OrvexMcpStatus[]) => {
    setServers(list)
    setStatus(st)
    setJsonText(JSON.stringify(list, null, 2))
  }

  useEffect(() => {
    if (!bridge) {
      setLoading(false)
      return
    }
    void bridge.mcp.get().then((res) => {
      setLoading(false)
      if (!res.ok) {
        notify(res.error)
        return
      }
      apply(res.data.servers, res.data.status)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge])

  const patch = (id: string, next: Partial<OrvexMcpServer>) => {
    setServers((list) => list.map((s) => (s.id === id ? { ...s, ...next } : s)))
    setDirty(true)
  }

  const remove = (id: string) => {
    setServers((list) => list.filter((s) => s.id !== id))
    setDirty(true)
  }

  const add = () => {
    const name = draft.name.trim()
    const command = draft.command.trim()
    if (!name || !command) {
      notify('Give the server a name and a command.')
      return
    }
    const id = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || `server-${servers.length + 1}`
    const next: OrvexMcpServer = {
      id,
      name,
      command,
      args: draft.args
        .split('\n')
        .map((a) => a.trim())
        .filter(Boolean),
      enabled: true,
      autoApprove: draft.autoApprove,
      timeoutMs: 120000,
    }
    setServers((list) => [...list, next])
    setDraft({ name: '', command: '', args: '', autoApprove: false })
    setDirty(true)
  }

  const save = async () => {
    if (!bridge) return
    let list = servers
    if (jsonMode) {
      try {
        const parsed = JSON.parse(jsonText) as OrvexMcpServer[]
        if (!Array.isArray(parsed)) throw new Error('The JSON must be an array of server objects.')
        list = parsed
      } catch (err) {
        notify(`MCP JSON: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
    }
    setBusy(true)
    const res = await bridge.mcp.set(list)
    setBusy(false)
    if (!res.ok) {
      notify(res.error)
      return
    }
    setDirty(false)
    const fresh = await bridge.mcp.get()
    if (fresh.ok) apply(fresh.data.servers, res.data.status)
    else setStatus(res.data.status)
    notify('MCP servers saved and connected.')
  }

  const reconnect = async () => {
    if (!bridge) return
    setBusy(true)
    const res = await bridge.mcp.reconnect()
    setBusy(false)
    if (!res.ok) {
      notify(res.error)
      return
    }
    setStatus(res.data.status)
    notify('MCP servers reconnected.')
  }

  if (!bridge) {
    return (
      <div className="settings-section">
        <div className="settings-block">
          <h3 className="settings-h">MCP servers</h3>
          <p className="settings-note">
            MCP servers are external processes, so this tab only works in the desktop app. Run <code>npm run desktop:dev</code> to
            manage them.
          </p>
        </div>
      </div>
    )
  }

  const statusOf = (id: string) => status.find((s) => s.id === id) ?? null

  return (
    <div className="settings-section">
      <div className="settings-block">
        <div className="settings-block-head">
          <h3 className="settings-h">MCP servers</h3>
          <div className="flex gap-2">
            <button className="ghost-btn" onClick={() => setJsonMode((v) => !v)}>
              {jsonMode ? 'Form view' : 'Edit JSON'}
            </button>
            <button className="ghost-btn" onClick={reconnect} disabled={busy || dirty}>
              {busy ? <Loader2 size={11} className="spin" /> : <RefreshCcw size={11} />} Reconnect
            </button>
            <button className="primary-btn !py-1 !px-2.5 !text-[10px]" onClick={save} disabled={busy || !dirty}>
              {busy ? <Loader2 size={12} className="spin" /> : <Check size={12} />} Save &amp; connect
            </button>
          </div>
        </div>

        <p className="settings-note">
          ORVEX speaks the Model Context Protocol directly: each server below is a real process it starts over stdio, and every
          tool it advertises becomes callable by the engine as <code>mcp__&lt;server&gt;__&lt;tool&gt;</code>. Small servers list
          their tools directly; servers with more than twenty tools stay compact and the engine reaches them through{' '}
          <code>mcp__orvex__search</code> and <code>mcp__orvex__call</code>, which keeps every prompt fast. Tools from MCP
          servers run outside ORVEX&rsquo;s guardrails, so each call asks for your Allow click unless you tick{' '}
          <strong>auto-approve</strong> on that server.
        </p>

        {loading && <p className="settings-note">Loading…</p>}

        {!jsonMode && (
          <div className="provider-list">
            {servers.length === 0 && !loading && (
              <p className="settings-note">
                No servers yet. Paste a command, e.g. <code>npx -y @modelcontextprotocol/server-filesystem C:\Users\you\Documents</code>{' '}
                or <code>npx -y @playwright/mcp@latest</code>. <code>npx</code> downloads the server the first time, so it needs
                Node.js. Use <strong>Edit JSON</strong> when you need env vars, a working folder or an image server.
              </p>
            )}

            {servers.map((s) => {
              const st = statusOf(s.id)
              return (
                <div key={s.id} className={`provider-row ${st?.state === 'ready' ? 'active' : ''}`}>
                  <div className="provider-head">
                    <input
                      className="provider-name"
                      value={s.name}
                      onChange={(e) => patch(s.id, { name: e.target.value })}
                      aria-label="Server name"
                    />
                    <span className={`kind-pill ${st?.state === 'ready' ? 'k-local' : st?.state === 'error' ? 'k-custom' : 'k-cloud'}`}>
                      {st ? st.state : 'not saved'}
                    </span>
                    <button className="icon-btn !w-[26px] !h-[26px] ml-auto" onClick={() => remove(s.id)} title="Remove server" aria-label={`Remove ${s.name}`}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                  <div className="mcp-cmd">
                    <code>
                      {s.command} {s.args.join(' ')}
                    </code>
                  </div>
                  <div className="mcp-row-meta">
                    <label className="free-check">
                      <input type="checkbox" checked={s.enabled} onChange={(e) => patch(s.id, { enabled: e.target.checked })} />
                      enabled
                    </label>
                    <label className="free-check" title="Skip the Allow click for this server's tools">
                      <input
                        type="checkbox"
                        checked={s.autoApprove}
                        onChange={(e) => patch(s.id, { autoApprove: e.target.checked })}
                      />
                      auto-approve
                    </label>
                    <span className="dim">timeout {Math.round(s.timeoutMs / 1000)}s</span>
                  </div>
                  {st?.state === 'ready' && (
                    <>
                      <p className="settings-note">
                        {st.toolCount} tool{st.toolCount === 1 ? '' : 's'} · {st.listedCount ?? st.toolCount} listed directly
                        {st.hubCount ? ` · ${st.hubCount} reachable through MCP search` : ''}
                        {st.blockedCount ? ` · ${st.blockedCount} blocked by the allowlist` : ''}
                      </p>
                      <p className="settings-note dim">
                        {st.tools.slice(0, 12).join(', ')}
                        {st.tools.length > 12 ? ` … +${st.tools.length - 12} more` : ''}
                      </p>
                      {!!st.missing?.length && (
                        <p className="settings-note mcp-error">Allowlist names this server does not advertise: {st.missing.join(', ')}</p>
                      )}
                    </>
                  )}
                  {st?.error && <p className="settings-note mcp-error">{st.error}</p>}
                  <label className="pf" style={{ marginTop: 6 }}>
                    <span>Tool allowlist — comma-separated; empty keeps all tools</span>
                    <input
                      className="text-input"
                      value={(s.tools || []).join(', ')}
                      onChange={(e) =>
                        patch(s.id, {
                          tools: e.target.value
                            .split(',')
                            .map((name) => name.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder="read_file, write_file"
                      aria-label={`Tool allowlist for ${s.name}`}
                    />
                  </label>
                </div>
              )
            })}
          </div>
        )}

        {jsonMode && (
          <div className="settings-block">
            <p className="settings-note">
              Edit the whole server list as JSON. Shape: <code>[{'{'}&quot;name&quot;, &quot;command&quot;, &quot;args&quot;,
              &quot;env&quot;, &quot;cwd&quot;, &quot;enabled&quot;, &quot;autoApprove&quot;, &quot;timeoutMs&quot;, &quot;tools&quot;{'}'}]</code>{' '}
              — <code>tools</code> is an optional allowlist of tool names.
            </p>
            <textarea
              className="mcp-json"
              value={jsonText}
              onChange={(e) => {
                setJsonText(e.target.value)
                setDirty(true)
              }}
              spellCheck={false}
              rows={14}
              aria-label="MCP servers JSON"
            />
            <button
              className="ghost-btn mt-2"
              onClick={() => {
                setJsonText(MCP_EXAMPLE)
                setDirty(true)
              }}
            >
              <Plus size={11} /> Insert example
            </button>
          </div>
        )}

        {!jsonMode && (
          <div className="settings-block mt-3">
            <div className="settings-block-head">
              <h3 className="settings-h">Add a server</h3>
            </div>
            <div className="provider-fields">
              <label className="pf">
                <span>Name</span>
                <input className="text-input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Filesystem" />
              </label>
              <label className="pf">
                <span>Command</span>
                <input className="text-input" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} placeholder="npx" />
              </label>
              <label className="pf" style={{ gridColumn: '1 / -1' }}>
                <span>Arguments — one per line</span>
                <textarea
                  className="mcp-json"
                  value={draft.args}
                  onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                  rows={4}
                  style={{ minHeight: 0 }}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\you\\Documents'}
                />
              </label>
            </div>
            <div className="mcp-row-meta">
              <label className="free-check">
                <input type="checkbox" checked={draft.autoApprove} onChange={(e) => setDraft({ ...draft, autoApprove: e.target.checked })} />
                auto-approve this server&rsquo;s tools
              </label>
              <button className="primary-btn !py-1 !px-2.5 !text-[10px]" onClick={add}>
                <Plus size={12} /> Add server
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------------- voice */

function VoiceTab({ notify }: { notify: (m: string) => void }) {
  const { cfg, setCfg } = useVoiceSettings()
  const fileRef = useRef<HTMLInputElement>(null)
  const [testing, setTesting] = useState<'tts' | 'asr' | null>(null)
  const [probe, setProbe] = useState<string | null>(null)
  const [sttKey, setSttKey] = useState('')
  const [sttSaved, setSttSaved] = useState(false)
  const [sttMsg, setSttMsg] = useState('')
  const [heygenKey, setHeygenKey] = useState('')
  const [heygenSaved, setHeygenSaved] = useState(false)
  const [heygenMsg, setHeygenMsg] = useState('')
  const [heygenVoices, setHeygenVoices] = useState<HeygenVoice[]>([])
  const [voicesBusy, setVoicesBusy] = useState(false)

  useEffect(() => {
    void hasSttKey().then(setSttSaved)
    void hasHeygenKey().then(setHeygenSaved)
  }, [])

  const saveHeygen = async () => {
    const res = await saveHeygenKey(heygenKey)
    setHeygenMsg(res.detail)
    if (res.ok) {
      setHeygenSaved(!!heygenKey.trim())
      setHeygenKey('')
    }
    notify(res.detail)
  }

  const pullHeygenVoices = async () => {
    setVoicesBusy(true)
    const res = await fetchHeygenVoices()
    setVoicesBusy(false)
    if (!res.ok) {
      notify(`HeyGen voices — ${res.detail}`)
      return
    }
    setHeygenVoices(res.voices)
    if (!res.voices.some((v) => v.voiceId === cfg.heygenVoiceId)) {
      setCfg({ heygenVoiceId: res.voices[0].voiceId })
    }
    notify(`HeyGen — ${res.voices.length} voices fetched`)
  }

  const heygenVoiceOptions = heygenVoices.length
    ? heygenVoices
    : cfg.heygenVoiceId
      ? [
          {
            voiceId: cfg.heygenVoiceId,
            name: cfg.heygenVoiceId === '83548de556df48ba8c09c42a57c51d85' ? 'Nadine (default)' : `${cfg.heygenVoiceId.slice(0, 8)}…`,
            language: cfg.heygenLanguage,
            gender: '',
            preview: '',
          },
        ]
      : []

  const saveKey = async () => {
    const endpoint = sttTarget(cfg)?.url || cfg.serverUrl.trim() || undefined
    const res = await saveSttKey(sttKey, endpoint)
    setSttMsg(res.detail)
    if (res.ok) {
      setSttSaved(!!sttKey.trim())
      setSttKey('')
    }
    notify(res.detail)
  }

  const testSpeak = async () => {
    setTesting('tts')
    const res = await speak(`Hi, this is ${cfg.preset} speaking through ${cfg.engine}.`, cfg)
    setTesting(null)
    notify(res.detail)
  }

  const probeServer = async () => {
    setTesting('asr')
    const d = await discoverSpeech(cfg.serverUrl)
    setTesting(null)
    if (!d) {
      setProbe('No /.well-known/voicestudio-speech on this server — it may still expose /v1/audio/transcriptions directly.')
      return
    }
    setProbe(`${d.api ?? 'unknown API'}${d.models?.length ? ` · models: ${d.models.slice(0, 6).join(', ')}` : ''}`)
  }

  const onClone = (f: File | undefined) => {
    if (!f) return
    if (!f.type.startsWith('audio/')) {
      notify('Pick an audio file to clone from.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setCfg({ cloneRef: String(reader.result), cloneName: f.name })
      notify(`Reference voice loaded: ${f.name}`)
    }
    reader.readAsDataURL(f)
  }

  return (
    <div className="settings-section">
      <div className="settings-block">
        <h3 className="settings-h">Text to speech</h3>
        <p className="settings-note">
          ORVEX can speak its replies through a local TTS server. Engines below are the open-source ElevenLabs-class
          projects — run one locally and point ORVEX at its HTTP endpoint.
        </p>

        <div className="engine-grid">
          {VOICE_ENGINES.map((e) => (
            <button
              key={e.id}
              className={`engine-card ${cfg.engine === e.id ? 'active' : ''}`}
              onClick={() => { setCfg({ engine: e.id as VoiceEngineId }); notify(`${e.name} selected`) }}
            >
              <span className="engine-name">
                {e.name}
                {cfg.engine === e.id && <Check size={12} />}
              </span>
              <span className="engine-repo">{e.repo}</span>
              <span className="engine-note">{e.note}</span>
            </button>
          ))}
        </div>

        <div className="settings-block-head mt-4">
          <h3 className="settings-h">HeyGen Voice Turbo</h3>
          <span className="sec-chip">{heygenSaved ? 'key saved' : 'no key'}</span>
        </div>
        <p className="settings-note">
          Cloud TTS. The key is stored in the OS-encrypted vault and bound to api.heygen.com — it never reaches this page.
        </p>
        <div className="field-row">
          <label className="field-label" htmlFor="heygen-key">API key</label>
          <div className="field-inline">
            <input
              id="heygen-key"
              className="text-input"
              type="password"
              autoComplete="off"
              placeholder={heygenSaved ? 'stored — paste a new key to replace' : 'paste your HeyGen API key'}
              value={heygenKey}
              onChange={(e) => setHeygenKey(e.target.value)}
            />
            <button className="ghost-btn" onClick={() => void saveHeygen()}>
              <KeyRound size={11} /> Save
            </button>
          </div>
        </div>
        {heygenMsg && <p className="settings-note">{heygenMsg}</p>}
        <div className="field-row">
          <label className="field-label" htmlFor="heygen-model">Model</label>
          <select
            id="heygen-model"
            className="select"
            value={cfg.heygenModel}
            onChange={(e) => setCfg({ heygenModel: e.target.value })}
          >
            {HEYGEN_MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
        <p className="settings-note" style={{ marginTop: -4 }}>
          {HEYGEN_MODELS.find((m) => m.id === cfg.heygenModel)?.note ?? ''}
        </p>
        <div className="field-row">
          <label className="field-label" htmlFor="heygen-voice">Voice</label>
          <div className="field-inline">
            <select
              id="heygen-voice"
              className="select"
              value={cfg.heygenVoiceId}
              onChange={(e) => setCfg({ heygenVoiceId: e.target.value })}
            >
              {heygenVoiceOptions.map((v) => (
                <option key={v.voiceId} value={v.voiceId}>
                  {v.name}{v.language ? ` · ${v.language}` : ''}{v.gender ? ` · ${v.gender}` : ''}
                </option>
              ))}
            </select>
            <button className="ghost-btn" disabled={voicesBusy || !heygenSaved} onClick={() => void pullHeygenVoices()}>
              {voicesBusy ? <Loader2 size={11} className="spin" /> : <RefreshCcw size={11} />} Fetch voices
            </button>
          </div>
        </div>
        <div className="field-row">
          <label className="field-label" htmlFor="heygen-language">Language</label>
          <input
            id="heygen-language"
            className="text-input"
            value={cfg.heygenLanguage}
            onChange={(e) => setCfg({ heygenLanguage: e.target.value })}
            placeholder="en"
          />
        </div>

        <div className="field-row mt-4">
          <label className="field-label" htmlFor="tts-url">TTS server URL</label>
          <input
            id="tts-url"
            className="text-input"
            value={cfg.serverUrl}
            onChange={(e) => setCfg({ serverUrl: e.target.value })}
            placeholder="http://localhost:8000"
          />
        </div>
        <div className="field-row">
          <label className="field-label" htmlFor="tts-path">Endpoint path</label>
          <input
            id="tts-path"
            className="text-input"
            value={cfg.synthPath}
            onChange={(e) => setCfg({ synthPath: e.target.value })}
            placeholder="/v1/audio/speech"
          />
        </div>
        <div className="field-row">
          <label className="field-label" htmlFor="tts-model">Model / voice id</label>
          <input
            id="tts-model"
            className="text-input"
            value={cfg.model}
            onChange={(e) => setCfg({ model: e.target.value })}
            placeholder="omni-voice-1"
          />
        </div>
        <div className="field-row">
          <label className="field-label" htmlFor="tts-speed">Speed</label>
          <input
            id="tts-speed"
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={cfg.speed}
            onChange={(e) => setCfg({ speed: Number(e.target.value) })}
            className="range"
          />
          <span className="range-val">{cfg.speed.toFixed(2)}×</span>
        </div>

        <div className="field-row" style={{ alignItems: 'flex-start' }}>
          <label className="field-label" htmlFor="tts-instruct">
            Voice design
          </label>
          <textarea
            id="tts-instruct"
            className="note-body-input"
            style={{ minHeight: 54 }}
            value={cfg.instruct}
            onChange={(e) => setCfg({ instruct: e.target.value })}
            placeholder="e.g. female, low pitch, british accent, calm and unhurried"
          />
        </div>
        <p className="settings-note" style={{ marginTop: -4 }}>
          A natural-language description of the voice. Sent to the engine as <code>instruct</code> — OmniVoice, XTTS v2 and
          Fish Speech S2 all accept a free-text style prompt this way.
        </p>
        <div className="field-row">
          <label className="field-label" htmlFor="tts-format">Format</label>
          <select id="tts-format" className="select" value={cfg.format} onChange={(e) => setCfg({ format: e.target.value })}>
            <option value="mp3">mp3</option>
            <option value="wav">wav</option>
            <option value="opus">opus</option>
          </select>
        </div>

        <div className="settings-block-head mt-4">
          <h3 className="settings-h">Voice presets</h3>
        </div>
        <div className="voice-preset-grid">
          {VOICE_PRESETS.map((v) => (
            <button
              key={v.id}
              className={`voice-preset ${cfg.preset === v.id ? 'active' : ''}`}
              onClick={() => { setCfg({ preset: v.id }); notify(`${v.name} voice selected`) }}
            >
              <span className="vp-name">{v.name}</span>
              <span className="vp-tags">{v.tags.join(' · ')}</span>
            </button>
          ))}
        </div>

        <div className="settings-block-head mt-4">
          <h3 className="settings-h">Voice cloning</h3>
        </div>
        <p className="settings-note">
          Give the engine a short clean reference clip (6–15 seconds) and it will clone that voice. The reference stays on
          this device and is only sent to the TTS server you configured above.
        </p>
        <div className="field-row">
          <label className="field-label">Reference clip</label>
          <div className="field-inline">
            <button className="ghost-btn" onClick={() => fileRef.current?.click()}>
              <Upload size={11} /> Choose audio
            </button>
            {cfg.cloneName && <span className="clone-name">{cfg.cloneName}</span>}
            {cfg.cloneRef && (
              <button className="ghost-btn" onClick={() => setCfg({ cloneRef: '', cloneName: '' })}>
                <Trash2 size={11} /> Clear
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => { onClone(e.target.files?.[0]); e.target.value = '' }}
            />
          </div>
        </div>

        <div className="field-row">
          <label className="field-label" htmlFor="tts-autoplay">Auto-speak replies</label>
          <input
            id="tts-autoplay"
            type="checkbox"
            className="switch"
            checked={cfg.autoSpeak}
            onChange={(e) => setCfg({ autoSpeak: e.target.checked })}
          />
        </div>

        <div className="settings-block-head mt-4">
          <h3 className="settings-h">Speech to text</h3>
        </div>
        <p className="settings-note">
          The desktop app has no built-in speech service, so voice input records each turn locally and sends it to an
          OpenAI-compatible transcription endpoint (<code>POST …/audio/transcriptions</code>, multipart). Any provider that
          offers Whisper works — for example Groq or OpenAI. Without an endpoint, voice input stays off and you type.
        </p>
        <div className="field-row">
          <label className="field-label" htmlFor="asr-url">STT endpoint URL</label>
          <input
            id="asr-url"
            className="text-input"
            value={cfg.asrUrl}
            onChange={(e) => setCfg({ asrUrl: e.target.value })}
            placeholder="https://api.groq.com/openai/v1/audio/transcriptions"
          />
        </div>
        <div className="field-row">
          <label className="field-label" htmlFor="asr-model">STT model</label>
          <input
            id="asr-model"
            className="text-input"
            value={cfg.asrModel}
            onChange={(e) => setCfg({ asrModel: e.target.value })}
            placeholder="whisper-1 / whisper-large-v3"
          />
        </div>
        <div className="field-row">
          <label className="field-label" htmlFor="asr-key">STT API key</label>
          <div className="field-inline">
            <input
              id="asr-key"
              type="password"
              className="text-input"
              value={sttKey}
              onChange={(e) => setSttKey(e.target.value)}
              placeholder={sttSaved ? '•••••• saved in the OS vault' : 'only if the endpoint needs auth'}
            />
            <button className="ghost-btn" onClick={() => void saveKey()}>
              Save key
            </button>
          </div>
        </div>
        {sttMsg && <div className="settings-note">{sttMsg}</div>}
        <div className="field-row">
          <label className="field-label" htmlFor="asr-path">ASR path (local server)</label>
          <input
            id="asr-path"
            className="text-input"
            value={cfg.asrPath}
            onChange={(e) => setCfg({ asrPath: e.target.value })}
            placeholder="/v1/audio/transcriptions"
          />
        </div>
        <p className="settings-note">
          For a local VoiceStudio-style server leave the endpoint URL blank: ORVEX then uses the server URL above plus
          this path. ASR and TTS can share the same server.
        </p>

        <div className="field-inline" style={{ marginTop: 10 }}>
          <button className="ghost-btn" onClick={testSpeak} disabled={testing !== null}>
            {testing === 'tts' ? <Loader2 size={11} className="spin" /> : <Sparkles size={11} />} Test voice
          </button>
          <button className="ghost-btn" onClick={probeServer} disabled={testing !== null}>
            {testing === 'asr' ? <Loader2 size={11} className="spin" /> : <Server size={11} />} Probe ASR server
          </button>
        </div>
        {probe && <div className="provider-test ok" style={{ marginTop: 8 }}>{probe}</div>}

        <div className="settings-note mt-3">
          <Sparkles size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
          ORVEX can always fall back to the browser's built-in speech synthesis when no local server is running.
        </div>
      </div>
    </div>
  )
}

function AppTab({ notify }: { notify: (m: string) => void }) {
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const [prefs, setPrefs] = useState<OrvexAppPrefs | null>(null)
  const [win, setWin] = useState<OrvexWindowState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const notifications = useStore(notificationsStore)
  const unread = useMemo(() => unreadCount(notifications), [notifications])
  const read = useMemo(() => notifications.filter((n) => n.read).length, [notifications])

  useEffect(() => {
    if (!bridge) return
    let live = true
    void bridge.app.prefs().then((res) => {
      if (live && res.ok) setPrefs(res.data)
    })
    void bridge.app.window('state').then((res) => {
      if (live && res.ok) setWin(res.data)
    })
    const off = bridge.app.onWindowState((next) => setWin(next))
    return () => {
      live = false
      off()
    }
  }, [bridge])

  const setPref = async (patch: { launchAtLogin?: boolean; closeToTray?: boolean }) => {
    if (!bridge) return
    setBusy('prefs')
    try {
      const res = await bridge.app.setPrefs(patch)
      if (res.ok) {
        setPrefs(res.data)
        notify('App preferences saved')
      } else {
        notify(res.error)
      }
    } finally {
      setBusy(null)
    }
  }

  const act = async (action: OrvexWindowAction) => {
    if (!bridge) return
    const res = await bridge.app.window(action)
    if (res.ok) setWin(res.data)
    else notify(res.error)
  }

  return (
    <div className="settings-section">
      <div className="settings-block">
        <h3 className="settings-h">Desktop shell</h3>
        <p className="settings-note">
          These are real Electron window preferences, saved to <code>prefs.json</code> in the ORVEX data directory and
          applied immediately.
        </p>
        {!bridge && (
          <p className="settings-note" style={{ color: '#f59e0b' }}>
            Window preferences are only editable in the desktop app.
          </p>
        )}
        <div className="field-row">
          <label className="field-label" htmlFor="close-to-tray">Close to tray</label>
          <input
            id="close-to-tray"
            type="checkbox"
            className="switch"
            checked={!!prefs?.closeToTray}
            disabled={!bridge || busy !== null}
            onChange={(e) => void setPref({ closeToTray: e.target.checked })}
          />
        </div>
        <p className="settings-note">
          With this on, the close button hides the window and keeps agent runs, workflows and the scheduler alive.
          Bring it back from the tray or with <code>{win?.hotkey ?? 'Ctrl+Shift+O'}</code>.
        </p>
        <div className="field-row">
          <label className="field-label" htmlFor="launch-login">Launch at login</label>
          <input
            id="launch-login"
            type="checkbox"
            className="switch"
            checked={!!prefs?.launchAtLogin}
            disabled={!bridge || !prefs?.packaged || busy !== null}
            onChange={(e) => void setPref({ launchAtLogin: e.target.checked })}
          />
        </div>
        {prefs && !prefs.packaged && (
          <p className="settings-note">Startup registration is available in the installed build, not the dev runner.</p>
        )}
        <div className="field-inline" style={{ marginTop: 10 }}>
          <button className="ghost-btn" onClick={() => void act('toggleMini')} disabled={!bridge}>
            <Monitor size={11} /> {win?.miniVisible ? 'Hide mini window' : 'Open mini window'}
          </button>
          <button className="ghost-btn" onClick={() => void act('minimize')} disabled={!bridge}>
            Minimize
          </button>
          <button className="ghost-btn" onClick={() => void act('showMain')} disabled={!bridge}>
            Bring to front
          </button>
        </div>
      </div>

      <div className="settings-block">
        <h3 className="settings-h">Notifications</h3>
        <p className="settings-note">
          {unread} unread · {notifications.length} stored. Agent runs, approvals and workflow alerts are delivered to
          Windows and to the in-app inbox.
        </p>
        <div className="field-inline">
          <button
            className="ghost-btn"
            disabled={unread === 0}
            onClick={() => {
              markAllRead()
              notify('All notifications marked read')
            }}
          >
            <BellRing size={11} /> Mark all read
          </button>
          <button
            className="ghost-btn"
            disabled={read === 0}
            onClick={() => {
              clearRead()
              notify('Read notifications cleared')
            }}
          >
            Clear read
          </button>
          <button
            className="ghost-btn"
            disabled={notifications.length === 0}
            onClick={() => {
              clearNotifications()
              notify('Notification inbox cleared')
            }}
          >
            Clear all
          </button>
        </div>
      </div>

      <div className="settings-block">
        <h3 className="settings-h">Build</h3>
        <p className="settings-note">
          Version <code>{prefs?.version ?? '—'}</code>
          <br />
          Data directory <code>{prefs?.userData ?? '—'}</code>
          <br />
          Global hotkey <code>{win?.hotkey ?? '—'}</code>
          <br />
          Main window {win ? (win.minimized ? 'minimized' : win.maximized ? 'maximized' : win.visible ? 'visible' : 'hidden') : '—'}
          {' · '}
          Mini window {win?.miniOpen ? (win.miniVisible ? 'open' : 'hidden') : 'closed'}
        </p>
      </div>
    </div>
  )
}
