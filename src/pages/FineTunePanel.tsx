import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw, Rocket, Square } from 'lucide-react'
import type { IpcResult, OrvexLearnerFinetune, OrvexLearnerKit } from '../types/desktop'

type Props = { notify: (msg: string) => void }

function msg(err: unknown): string {
  return err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err)
}

async function call<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const res = await promise
  if (!res.ok) throw new Error(res.error)
  return res.data
}

export default function FineTunePanel({ notify }: Props) {
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const [runs, setRuns] = useState<OrvexLearnerFinetune[]>([])
  const [kits, setKits] = useState<OrvexLearnerKit[]>([])
  const [providerId, setProviderId] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1')
  const [model, setModel] = useState('')
  const [kitId, setKitId] = useState('')
  const [suffix, setSuffix] = useState('orvex')
  const [epochs, setEpochs] = useState('1')
  const [batchSize, setBatchSize] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!bridge) return
    const [nextRuns, nextKits] = await Promise.all([call(bridge.learner.finetunes(50)), call(bridge.learner.trainKits(50))])
    setRuns(nextRuns.runs)
    setKits(nextKits.kits)
    if (!kitId && nextKits.kits.length) setKitId(nextKits.kits[0].id)
  }, [bridge, kitId])

  useEffect(() => {
    void load().catch((err) => setError(msg(err)))
  }, [load])

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

  const submit = () =>
    run('submit', async () => {
      if (!bridge) return
      if (!providerId.trim() || !baseUrl.trim() || !model.trim() || !kitId) {
        throw new Error('Provider id, base URL, base model and a Train Kit are required.')
      }
      const result = await call(
        bridge.learner.finetune({
          providerId: providerId.trim(),
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          trainKitId: kitId,
          suffix: suffix.trim() || undefined,
          epochs: Number(epochs) || undefined,
          batchSize: Number(batchSize) || undefined,
        }),
      )
      notify(`Fine-tune submitted · ${result.remoteId}`)
      await load()
    })

  const refresh = (item: OrvexLearnerFinetune) =>
    run(`status-${item.id}`, async () => {
      if (!bridge) return
      const result = await call(bridge.learner.finetuneStatus(item.id))
      notify(`Fine-tune ${result.id}: ${result.status}`)
      await load()
    })

  const cancel = (item: OrvexLearnerFinetune) =>
    run(`cancel-${item.id}`, async () => {
      if (!bridge || !window.confirm('Ask the provider to cancel this fine-tune job?')) return
      await call(bridge.learner.finetuneCancel(item.id))
      notify('Cancellation requested')
      await load()
    })

  return (
    <div className="adv-grid">
      <section className="adv-card">
        <div className="adv-card-head">
          <h3>Submit a fine-tune</h3>
          <span className="adv-hint">OpenAI-compatible endpoints</span>
        </div>
        <label className="adv-field">
          <span>Provider id (matches the saved key)</span>
          <input className="adv-input" value={providerId} onChange={(e) => setProviderId(e.target.value)} placeholder="openai" />
        </label>
        <label className="adv-field">
          <span>Base URL</span>
          <input className="adv-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
        </label>
        <label className="adv-field">
          <span>Base model</span>
          <input className="adv-input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4.1-mini-2025-04-14" />
        </label>
        <label className="adv-field">
          <span>Train Kit</span>
          <select className="adv-input" value={kitId} onChange={(e) => setKitId(e.target.value)}>
            <option value="">Choose a kit</option>
            {kits.map((kit) => (
              <option key={kit.id} value={kit.id}>{kit.name} · {kit.items} runs</option>
            ))}
          </select>
        </label>
        <div className="adv-row-2">
          <label className="adv-field">
            <span>Suffix</span>
            <input className="adv-input" value={suffix} onChange={(e) => setSuffix(e.target.value)} placeholder="orvex" />
          </label>
          <label className="adv-field">
            <span>Epochs</span>
            <input className="adv-input" inputMode="numeric" value={epochs} onChange={(e) => setEpochs(e.target.value)} placeholder="1" />
          </label>
        </div>
        <label className="adv-field">
          <span>Batch size (optional)</span>
          <input className="adv-input" inputMode="numeric" value={batchSize} onChange={(e) => setBatchSize(e.target.value)} placeholder="provider default" />
        </label>
        <div className="adv-actions">
          <button className="adv-btn adv-btn-primary" disabled={busy !== null || kits.length === 0} onClick={() => void submit()}>
            {busy === 'submit' ? <Loader2 size={13} className="adv-spin" /> : <Rocket size={13} />} Submit
          </button>
        </div>
        <p className="adv-note">
          The key must already be saved and bound to this exact endpoint. ORVEX never prints keys; a request without a matching key is refused before anything is uploaded.
        </p>
      </section>

      <section className="adv-card adv-card-wide">
        <div className="adv-card-head">
          <h3>Remote jobs</h3>
          <span className="adv-hint">{runs.length} submitted</span>
        </div>
        {runs.length === 0 ? (
          <p className="adv-empty">No fine-tune jobs yet. Build a Train Kit first, then submit it when you choose to spend GPU time.</p>
        ) : (
          <div className="adv-table">
            <div className="adv-tr adv-th"><span>Job</span><span>Status</span><span>Model</span><span>Dataset</span><span>Started</span><span /></div>
            {runs.map((item) => (
              <div key={item.id} className="adv-tr">
                <span className="adv-mono adv-clip" title={item.remoteId || item.id}>{item.remoteId || item.id}</span>
                <span>{item.status}</span>
                <span className="adv-clip" title={item.model || ''}>{item.model || '—'}</span>
                <span className="adv-clip" title={item.dataset || ''}>{item.dataset || '—'}</span>
                <span>{new Date(item.startedAt).toLocaleString()}</span>
                <span className="adv-row-actions">
                  <button className="adv-icon" title="Refresh status" disabled={busy !== null} onClick={() => void refresh(item)}>
                    {busy === `status-${item.id}` ? <Loader2 size={13} className="adv-spin" /> : <RefreshCw size={13} />}
                  </button>
                  <button
                    className="adv-icon"
                    title="Cancel"
                    disabled={busy !== null || ['succeeded', 'failed', 'cancelled'].includes(item.status)}
                    onClick={() => void cancel(item)}
                  >
                    {busy === `cancel-${item.id}` ? <Loader2 size={13} className="adv-spin" /> : <Square size={13} />}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="adv-note">Status is read from the provider. A finished fine-tuned model id appears here when the endpoint reports one.</p>
      </section>

      {error && (
        <p className="adv-error adv-card-wide" role="alert">
          <AlertTriangle size={13} /> {error}
        </p>
      )}
    </div>
  )
}
