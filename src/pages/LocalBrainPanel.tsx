import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Cpu, Loader2, Play, RefreshCw, Square } from 'lucide-react'
import type {
  IpcResult,
  OrvexBrainConfig,
  OrvexBrainFit,
  OrvexBrainScan,
  OrvexBrainStatus,
} from '../types/desktop'

type Props = { notify: (msg: string) => void }

function msg(err: unknown): string {
  return err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err)
}

async function call<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const res = await promise
  if (!res.ok) throw new Error(res.error)
  return res.data
}

function fmt(bytes: number | null | undefined): string {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${Math.round(n)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function fitLabel(fit: OrvexBrainFit | null): string {
  if (!fit || !fit.ok) return 'unknown'
  if (fit.verdict === 'gpu-full') return 'GPU · full'
  if (fit.verdict === 'gpu-partial') return `GPU · ${fit.gpuLayers}/${fit.layerCount} layers`
  return 'CPU'
}

type Draft = {
  prefer: OrvexBrainConfig['prefer']
  offline: boolean
  port: string
  context: string
  threads: string
  gpuLayers: string
  vramGb: string
  idleMinutes: string
  runtimePath: string
  modelsDir: string
}

function toDraft(config: OrvexBrainConfig): Draft {
  return {
    prefer: config.prefer,
    offline: config.offline,
    port: String(config.port),
    context: String(config.context),
    threads: String(config.threads),
    gpuLayers: String(config.gpuLayers),
    vramGb: config.vramGb == null ? '' : String(config.vramGb),
    idleMinutes: String(config.idleMinutes),
    runtimePath: config.runtimePath,
    modelsDir: config.modelsDir,
  }
}

export default function LocalBrainPanel({ notify }: Props) {
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const [status, setStatus] = useState<OrvexBrainStatus | null>(null)
  const [scan, setScan] = useState<OrvexBrainScan | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!bridge) return
    const [nextStatus, nextScan] = await Promise.all([call(bridge.localBrain.status()), call(bridge.localBrain.models())])
    setStatus(nextStatus)
    setScan(nextScan)
    setDraft((current) => current ?? toDraft(nextStatus.config))
  }, [bridge])

  useEffect(() => {
    void load().catch((err) => setError(msg(err)))
  }, [load])

  useEffect(() => {
    if (!bridge) return
    return bridge.localBrain.onChange(() => {
      void load().catch(() => {})
    })
  }, [bridge, load])

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key)
    setError(null)
    try {
      await task()
    } catch (err) {
      setError(msg(err))
    } finally {
      setBusy(null)
    }
  }

  const saveConfig = () =>
    run('config', async () => {
      if (!bridge || !draft) return
      const patch: Partial<OrvexBrainConfig> = {
        prefer: draft.prefer,
        offline: draft.offline,
        port: Number(draft.port),
        context: Number(draft.context),
        threads: Number(draft.threads),
        gpuLayers: draft.gpuLayers === 'auto' ? 'auto' : Number(draft.gpuLayers),
        vramGb: draft.vramGb.trim() ? Number(draft.vramGb) : null,
        idleMinutes: Number(draft.idleMinutes),
        runtimePath: draft.runtimePath.trim(),
        modelsDir: draft.modelsDir.trim(),
      }
      const next = await call(bridge.localBrain.config(patch))
      setDraft(toDraft(next))
      notify('Local brain settings saved')
      await load()
    })

  const refresh = () =>
    run('scan', async () => {
      if (!bridge) return
      const next = await call(bridge.localBrain.refresh(false))
      setScan(next)
      notify(`${next.count} model${next.count === 1 ? '' : 's'} found`)
      await load()
    })

  const selectModel = (id: string) =>
    run('select', async () => {
      if (!bridge) return
      const next = await call(bridge.localBrain.config({ modelId: id }))
      setDraft((current) => (current ? { ...current, ...toDraft(next) } : toDraft(next)))
      await load()
    })

  const start = (id?: string) =>
    run('start', async () => {
      if (!bridge) return
      const next = await call(bridge.localBrain.start(id))
      setStatus(next)
      notify(`Local model ready on port ${next.server.port}`)
      await load()
    })

  const stop = () =>
    run('stop', async () => {
      if (!bridge) return
      const next = await call(bridge.localBrain.stop())
      setStatus(next)
      notify('Local model stopped')
      await load()
    })

  const hashModel = (id: string) =>
    run('hash', async () => {
      if (!bridge) return
      const result = await call(bridge.localBrain.hash(id))
      notify(`SHA-256 ${result.sha256.slice(0, 16)}…`)
      await load()
    })

  const runtime = status?.runtime
  const server = status?.server
  const models = useMemo(() => (scan?.models ?? []).filter((m) => m.kind === 'model'), [scan])
  const projectors = useMemo(() => (scan?.models ?? []).filter((m) => m.kind === 'projector'), [scan])
  const selectedId = status?.config.modelId || ''

  return (
    <div className="adv-grid">
      {error && (
        <p className="adv-error" role="alert">
          <AlertTriangle size={13} /> {error}
        </p>
      )}
      <section className="adv-card adv-card-wide">
        <div className="adv-card-head">
          <h3>Runtime</h3>
          <span className="adv-hint">managed llama.cpp server</span>
        </div>
        <div className="adv-kv">
          <span>llama-server</span>
          <strong>{runtime?.found ? runtime.path : 'not found'}</strong>
        </div>
        {!runtime?.found && <p className="adv-note">{runtime?.reason}</p>}
        <div className="adv-kv">
          <span>Server</span>
          <strong>
            {server?.state || 'stopped'}
            {server?.state === 'running' ? ` · port ${server.port}` : ''}
            {server?.state === 'running' && server.uptimeMs ? ` · ${Math.round(server.uptimeMs / 60000)} min` : ''}
          </strong>
        </div>
        {server?.error && <p className="adv-error"><AlertTriangle size={13} /> {server.error}</p>}
        <div className="adv-kv">
          <span>VRAM budget</span>
          <strong>
            {fmt(status?.vram.bytes)} · {status?.vram.source || 'unknown'}
          </strong>
        </div>
        {status?.vram.reason && <p className="adv-hint">{status.vram.reason}</p>}
        <div className="adv-actions">
          <button className="adv-btn adv-btn-primary" disabled={busy !== null || !runtime?.found || server?.state === 'running'} onClick={() => void start()}>
            {busy === 'start' ? <Loader2 size={13} className="adv-spin" /> : <Play size={13} />} Load selected
          </button>
          <button className="adv-btn" disabled={busy !== null || server?.state !== 'running'} onClick={() => void stop()}>
            {busy === 'stop' ? <Loader2 size={13} className="adv-spin" /> : <Square size={13} />} Unload
          </button>
          <button className="adv-btn" disabled={busy !== null} onClick={() => void refresh()}>
            {busy === 'scan' ? <Loader2 size={13} className="adv-spin" /> : <RefreshCw size={13} />} Rescan models
          </button>
        </div>
        <div className="adv-chips">
          {Object.entries(status?.capabilities ?? {}).map(([key, cap]) => (
            <span key={key} className={`adv-chip ${cap.available ? 'adv-chip-ok' : 'adv-chip-bad'}`} title={cap.reason || ''}>
              {key}: {cap.available ? 'ready' : 'unavailable'}
            </span>
          ))}
        </div>
      </section>

      <section className="adv-card">
        <div className="adv-card-head">
          <h3>Routing</h3>
          <span className="adv-hint">local vs cloud</span>
        </div>
        {draft && (
          <div className="adv-form">
            <label className="adv-field">
              <span className="adv-label">Preference</span>
              <select className="adv-select" value={draft.prefer} onChange={(e) => setDraft({ ...draft, prefer: e.target.value as Draft['prefer'] })}>
                <option value="local-first">Local first</option>
                <option value="cloud-first">Cloud first</option>
                <option value="offline-only">Offline only</option>
              </select>
            </label>
            <label className="adv-check">
              <input type="checkbox" checked={draft.offline} onChange={(e) => setDraft({ ...draft, offline: e.target.checked })} />
              Offline mode (never call a hosted provider)
            </label>
            <div className="adv-form-row">
              <label className="adv-field">
                <span className="adv-label">Context tokens</span>
                <input className="adv-input" value={draft.context} onChange={(e) => setDraft({ ...draft, context: e.target.value })} />
              </label>
              <label className="adv-field">
                <span className="adv-label">Threads</span>
                <input className="adv-input" value={draft.threads} onChange={(e) => setDraft({ ...draft, threads: e.target.value })} />
              </label>
            </div>
            <div className="adv-form-row">
              <label className="adv-field">
                <span className="adv-label">GPU layers</span>
                <input className="adv-input" value={draft.gpuLayers} onChange={(e) => setDraft({ ...draft, gpuLayers: e.target.value })} placeholder="auto" />
              </label>
              <label className="adv-field">
                <span className="adv-label">VRAM (GB)</span>
                <input className="adv-input" value={draft.vramGb} onChange={(e) => setDraft({ ...draft, vramGb: e.target.value })} placeholder="auto" />
              </label>
            </div>
            <div className="adv-form-row">
              <label className="adv-field">
                <span className="adv-label">Port</span>
                <input className="adv-input" value={draft.port} onChange={(e) => setDraft({ ...draft, port: e.target.value })} />
              </label>
              <label className="adv-field">
                <span className="adv-label">Idle unload (min)</span>
                <input className="adv-input" value={draft.idleMinutes} onChange={(e) => setDraft({ ...draft, idleMinutes: e.target.value })} />
              </label>
            </div>
            <label className="adv-field">
              <span className="adv-label">Runtime path</span>
              <input className="adv-input" value={draft.runtimePath} onChange={(e) => setDraft({ ...draft, runtimePath: e.target.value })} placeholder="auto-detect" />
            </label>
            <label className="adv-field">
              <span className="adv-label">Models folder</span>
              <input className="adv-input" value={draft.modelsDir} onChange={(e) => setDraft({ ...draft, modelsDir: e.target.value })} placeholder="training vault /models" />
            </label>
            <button className="adv-btn adv-btn-primary" disabled={busy !== null} onClick={() => void saveConfig()}>
              {busy === 'config' ? <Loader2 size={13} className="adv-spin" /> : <Cpu size={13} />} Save settings
            </button>
          </div>
        )}
      </section>

      <section className="adv-card adv-card-wide">
        <div className="adv-card-head">
          <h3>Models</h3>
          <span className="adv-hint">{scan ? `${scan.count} model${scan.count === 1 ? '' : 's'} · ${fmt(scan.totalBytes)} · ${scan.dir}` : 'scanning…'}</span>
        </div>
        {models.length === 0 ? (
          <p className="adv-empty">No GGUF models in the folder yet. Download one into {scan?.dir || 'the vault models folder'} and rescan.</p>
        ) : (
          <table className="adv-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Facts</th>
                <th>Fit</th>
                <th>SHA-256</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {models.map((model) => (
                <tr key={model.id}>
                  <td>
                    <button className={`adv-row-button ${selectedId === model.id ? 'active' : ''}`} onClick={() => void selectModel(model.id)}>
                      {model.name}
                    </button>
                    <div className="adv-hint">{fmt(model.size)}</div>
                  </td>
                  <td>
                    {model.arch || 'unknown arch'} · {model.quant || 'quant ?'}
                    {model.params ? ` · ${model.params}B` : ''}
                    {model.contextLength ? ` · ${model.contextLength} ctx` : ''}
                    {!model.headerOk && <span className="adv-chip adv-chip-warn"> header unreadable</span>}
                  </td>
                  <td>
                    <span className={`adv-chip ${model.fit?.fitsFully ? 'adv-chip-ok' : model.fit?.ok ? 'adv-chip-warn' : 'adv-chip-bad'}`}>
                      {fitLabel(model.fit)}
                    </span>
                    {model.fit?.ok && (
                      <div className="adv-hint">
                        VRAM {fmt(model.fit.estimatedVramBytes)} · RAM {fmt(model.fit.estimatedRamBytes)}
                      </div>
                    )}
                  </td>
                  <td>
                    {model.sha256 ? (
                      <span className="adv-mono">{model.sha256.slice(0, 12)}…</span>
                    ) : (
                      <button className="adv-btn" disabled={busy !== null} onClick={() => void hashModel(model.id)}>
                        {busy === 'hash' ? <Loader2 size={12} className="adv-spin" /> : null} Hash
                      </button>
                    )}
                  </td>
                  <td>
                    <button
                      className="adv-btn"
                      disabled={busy !== null || !runtime?.found || (server?.state === 'running' && selectedId === model.id)}
                      onClick={() => void start(model.id)}
                    >
                      <Play size={12} /> {server?.state === 'running' && selectedId === model.id ? 'Loaded' : 'Load'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {projectors.length > 0 && (
          <p className="adv-note">
            Vision projectors found: {projectors.map((p) => p.name).join(', ')}. A projector in the same folder as the model is attached automatically.
          </p>
        )}
      </section>

      <section className="adv-card adv-card-wide">
        <div className="adv-card-head">
          <h3>Server log</h3>
          <span className="adv-hint">last {status?.logs.length ?? 0} lines</span>
        </div>
        {status?.logs.length ? (
          <pre className="adv-pre training-json">{status.logs.map((l) => `${new Date(l.at).toLocaleTimeString()} ${l.line}`).join('\n')}</pre>
        ) : (
          <p className="adv-empty">No server output yet.</p>
        )}
      </section>
    </div>
  )
}
