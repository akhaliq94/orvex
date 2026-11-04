import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Download, FileArchive, Loader2, PackagePlus, Trash2 } from 'lucide-react'
import type { IpcResult, OrvexLearnerKit, OrvexLearnerModel } from '../types/desktop'

type Props = { notify: (msg: string) => void }

function msg(err: unknown): string {
  return err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err)
}

async function call<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const res = await promise
  if (!res.ok) throw new Error(res.error)
  return res.data
}

function fmt(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export default function TrainKitPanel({ notify }: Props) {
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const [kits, setKits] = useState<OrvexLearnerKit[]>([])
  const [models, setModels] = useState<OrvexLearnerModel[]>([])
  const [name, setName] = useState('')
  const [limit, setLimit] = useState('200')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!bridge) return
    const [nextKits, nextModels] = await Promise.all([call(bridge.learner.trainKits(50)), call(bridge.learner.models())])
    setKits(nextKits.kits)
    setModels(nextModels.models)
  }, [bridge])

  useEffect(() => {
    void load().catch((err) => setError(msg(err)))
  }, [load])

  useEffect(() => {
    if (!bridge) return
    return bridge.learner.onChange(() => {
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

  const build = () =>
    run('build', async () => {
      if (!bridge) return
      const items = Number(limit)
      if (!Number.isFinite(items) || items < 1) throw new Error('Limit must be at least 1.')
      const kit = await call(bridge.learner.buildTrainKit({ limit: Math.round(items), name: name.trim() || undefined }))
      notify(`Train Kit built with ${kit.items} run${kit.items === 1 ? '' : 's'}`)
      setName('')
      await load()
    })

  const pickAndImport = () =>
    run('import', async () => {
      if (!bridge) return
      const picked = await call(bridge.learner.pickGguf())
      if (picked.cancelled || !picked.file) return
      const result = await call(bridge.learner.importGguf({ source: picked.file }))
      notify(result.duplicate ? 'That GGUF is already in the vault' : `Imported ${result.path}`)
      await load()
    })

  const removeModel = (model: OrvexLearnerModel) =>
    run(`model-${model.id}`, async () => {
      if (!bridge || !window.confirm(`Delete ${model.name} from the vault? The file is removed from disk.`)) return
      await call(bridge.learner.deleteModel(model.id))
      notify('Model removed from the vault')
      await load()
    })

  return (
    <div className="adv-grid">
      <section className="adv-card">
        <div className="adv-card-head">
          <h3>Build a Train Kit</h3>
          <span className="adv-hint">for a free GPU</span>
        </div>
        <label className="adv-field">
          <span>Name</span>
          <input className="adv-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ops recipes v1" />
        </label>
        <label className="adv-field">
          <span>Runs to include</span>
          <input className="adv-input" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="200" />
        </label>
        <div className="adv-actions">
          <button className="adv-btn adv-btn-primary" disabled={busy !== null} onClick={() => void build()}>
            {busy === 'build' ? <Loader2 size={13} className="adv-spin" /> : <FileArchive size={13} />} Build kit
          </button>
        </div>
        <p className="adv-note">
          The kit contains a chat-format dataset, a Kaggle/Colab notebook and a manifest. It only packages real recorded runs — training happens on an external GPU.
        </p>
      </section>

      <section className="adv-card">
        <div className="adv-card-head">
          <h3>GGUF models</h3>
          <span className="adv-hint">{models.length} in the vault</span>
        </div>
        <div className="adv-actions">
          <button className="adv-btn adv-btn-primary" disabled={busy !== null} onClick={() => void pickAndImport()}>
            {busy === 'import' ? <Loader2 size={13} className="adv-spin" /> : <PackagePlus size={13} />} Import GGUF
          </button>
        </div>
        {models.length === 0 ? (
          <p className="adv-empty">No GGUF models imported yet. Local Brain sees imported files in its model list.</p>
        ) : (
          <div className="adv-table">
            <div className="adv-tr adv-th"><span>File</span><span>Size</span><span>Source</span><span /></div>
            {models.map((model) => (
              <div key={model.id} className="adv-tr">
                <span className="adv-clip" title={model.path || model.name}>{model.name}</span>
                <span>{fmt(model.bytes)}</span>
                <span>{model.source || model.role}</span>
                <span className="adv-row-actions">
                  <button className="adv-icon" title="Delete" disabled={busy !== null} onClick={() => void removeModel(model)}>
                    {busy === `model-${model.id}` ? <Loader2 size={13} className="adv-spin" /> : <Trash2 size={13} />}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="adv-note">Only files inside the vault models folder can be deleted here.</p>
      </section>

      <section className="adv-card adv-card-wide">
        <div className="adv-card-head">
          <h3>Train kits</h3>
          <span className="adv-hint">{kits.length} exported</span>
        </div>
        {kits.length === 0 ? (
          <p className="adv-empty">No kits yet. Build one after a few successful runs.</p>
        ) : (
          <div className="adv-table">
            <div className="adv-tr adv-th"><span>Name</span><span>Runs</span><span>Dataset</span><span>Base model</span><span>Folder</span><span>Status</span></div>
            {kits.map((kit) => (
              <div key={kit.id} className="adv-tr">
                <span className="adv-clip" title={kit.name}>{kit.name}</span>
                <span>{kit.items}</span>
                <span>{fmt(kit.bytes)}</span>
                <span className="adv-clip" title={kit.meta?.baseModel}>{kit.meta?.baseModel || '—'}</span>
                <span className="adv-clip adv-mono" title={`${kit.dir}/dataset.jsonl`}>
                  <Download size={11} /> {kit.id}/dataset.jsonl
                </span>
                <span>{kit.exists ? 'ready' : 'files missing'}</span>
              </div>
            ))}
          </div>
        )}
        <p className="adv-note">Full paths appear in the manifest inside each kit folder. Upload the dataset yourself; ORVEX never sends it anywhere on its own.</p>
      </section>

      {error && (
        <p className="adv-error adv-card-wide" role="alert">
          <AlertTriangle size={13} /> {error}
        </p>
      )}
    </div>
  )
}
