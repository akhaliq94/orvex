import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, BrainCircuit, Download, Loader2, Play, Plus, RefreshCw, Sparkles, Trash2, Undo2, Upload } from 'lucide-react'
import type {
  IpcResult,
  OrvexLearnerNanoActive,
  OrvexLearnerNanoModel,
  OrvexLearnerSkill,
  OrvexLearnerStatus,
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

function when(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleString() : '—'
}

export default function SkillsPanel({ notify }: Props) {
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const [skills, setSkills] = useState<OrvexLearnerSkill[]>([])
  const [nanos, setNanos] = useState<OrvexLearnerNanoModel[]>([])
  const [active, setActive] = useState<OrvexLearnerNanoActive | null>(null)
  const [status, setStatus] = useState<OrvexLearnerStatus | null>(null)
  const [prompt, setPrompt] = useState<{ id: string; text: string | null } | null>(null)
  const [goal, setGoal] = useState('')
  const [prediction, setPrediction] = useState<{ probability: number; verdict: string; accuracy: number | null; holdout: boolean; modelId: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [manual, setManual] = useState({ id: '', name: '', when: '', steps: '', successCheck: '', avoid: '', activate: false })
  const [importText, setImportText] = useState('')
  const [importName, setImportName] = useState('')
  const skillFileRef = useRef<HTMLInputElement | null>(null)

  const load = useCallback(async () => {
    if (!bridge) return
    const [nextSkills, nextNanos, nextStatus] = await Promise.all([
      call(bridge.learner.skills({ limit: 100 })),
      call(bridge.learner.nanos()),
      call(bridge.learner.status()),
    ])
    setSkills(nextSkills.skills)
    setNanos(nextNanos.models)
    setActive(nextNanos.active)
    setStatus(nextStatus)
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

  const compile = (episodeId: string) =>
    run(`compile-${episodeId}`, async () => {
      if (!bridge) return
      const skill = await call(bridge.learner.compileSkill({ episodeId }))
      notify(`Skill "${skill.name}" compiled`)
      await load()
    })

  const toggle = (skill: OrvexLearnerSkill) =>
    run(`skill-${skill.id}`, async () => {
      if (!bridge) return
      const next = skill.status === 'active' ? 'disabled' : 'active'
      await call(bridge.learner.setSkillStatus({ id: skill.id, status: next }))
      await load()
    })

  const remove = (skill: OrvexLearnerSkill) =>
    run(`delete-${skill.id}`, async () => {
      if (!bridge || !window.confirm(`Delete the compiled skill "${skill.name}"?`)) return
      await call(bridge.learner.deleteSkill(skill.id))
      if (prompt?.id === skill.id) setPrompt(null)
      notify('Skill deleted')
      await load()
    })

  const showPrompt = (skill: OrvexLearnerSkill) =>
    run(`prompt-${skill.id}`, async () => {
      if (!bridge) return
      const result = await call(bridge.learner.skillPrompt(skill.id))
      setPrompt({ id: skill.id, text: result.prompt })
    })

  const parseSteps = (text: string) => {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (!lines.length) throw new Error('Add at least one step, one tool per line.')
    return lines.map((line, index) => {
      const match = line.match(/^([a-zA-Z0-9_.-]+)\s*(.*)$/)
      if (!match) throw new Error(`Step ${index + 1} must start with a tool name.`)
      let args: Record<string, unknown> = {}
      if (match[2].trim()) {
        try {
          args = JSON.parse(match[2])
        } catch {
          throw new Error(`Step ${index + 1}: arguments must be JSON, e.g. web_search {"query":"x"}`)
        }
      }
      return { tool: match[1], args }
    })
  }

  const emptyManual = { id: '', name: '', when: '', steps: '', successCheck: '', avoid: '', activate: false }

  const saveManual = () =>
    run('manual-save', async () => {
      if (!bridge) return
      const steps = parseSteps(manual.steps)
      const saved = await call(
        bridge.learner.saveSkill({
          id: manual.id || undefined,
          name: manual.name.trim(),
          when: manual.when.trim(),
          steps,
          successCheck: manual.successCheck.trim(),
          avoid: manual.avoid
            .split(',')
            .map((line) => line.trim())
            .filter(Boolean),
          activate: manual.activate,
        }),
      )
      setManual(emptyManual)
      notify(`Skill "${saved.name}" ${saved.updated ? 'updated' : 'saved'} (${saved.status})`)
      await load()
    })

  const editManual = (skill: OrvexLearnerSkill) =>
    run(`edit-${skill.id}`, async () => {
      if (!bridge) return
      const { bundle } = await call(bridge.learner.exportSkill(skill.id))
      setManual({
        id: skill.id,
        name: bundle.skill.name,
        when: bundle.skill.when,
        steps: bundle.skill.steps.map((step) => `${step.tool}${Object.keys(step.args || {}).length ? ` ${JSON.stringify(step.args)}` : ''}`).join('\n'),
        successCheck: bundle.skill.successCheck,
        avoid: bundle.skill.avoid.join(', '),
        activate: false,
      })
    })

  const downloadJson = (name: string, data: unknown) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const exportOne = (skill: OrvexLearnerSkill) =>
    run(`export-${skill.id}`, async () => {
      if (!bridge) return
      const { bundle } = await call(bridge.learner.exportSkill(skill.id))
      downloadJson(`${skill.name.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}.orvex-skill.json`, bundle)
      notify(`Exported "${skill.name}".`)
    })

  const exportAll = () =>
    run('export-all', async () => {
      if (!bridge) return
      const pack = await call(bridge.learner.exportSkills())
      downloadJson('orvex-skills.json', pack)
      notify(`${pack.skills.length} skill(s) exported.`)
    })

  const importPack = () =>
    run('import', async () => {
      if (!bridge) return
      const text = importText.trim()
      if (!text) return
      let result
      if (text.startsWith('{') || text.startsWith('[')) {
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          throw new Error('Paste a valid ORVEX skill or skill pack JSON, or a SKILL.md file.')
        }
        result = await call(bridge.learner.importSkill({ skill: parsed, activate: false }))
      } else {
        result = await call(bridge.learner.importSkill({ text: importText, filename: importName || undefined, activate: false }))
      }
      setImportText('')
      setImportName('')
      notify(result.count != null ? `Imported ${result.count} skill(s).` : `Imported "${result.name}".`)
      await load()
    })

  const loadSkillFile = (file?: File | null) => {
    if (!file) return
    if (file.size > 512 * 1024) {
      setError('SKILL.md files are limited to 512 KB.')
      return
    }
    void file.text().then((text) => {
      setImportText(text)
      setImportName(file.name)
      setError(null)
    }, (err) => setError(msg(err)))
  }

  const train = () =>
    run('train', async () => {
      if (!bridge) return
      const result = await call(bridge.learner.trainNano())
      notify(
        result.promoted
          ? `Nano scorer promoted · ${Math.round(result.metrics.accuracy * 100)}% accuracy`
          : `Nano scorer trained · ${Math.round(result.metrics.accuracy * 100)}% (active model kept)`,
      )
      await load()
    })

  const rollback = () =>
    run('rollback', async () => {
      if (!bridge || !window.confirm('Switch the active nano scorer back to the previous model?')) return
      const result = await call(bridge.learner.rollbackNano())
      notify(result.to ? `Rolled back to ${result.to}` : 'Nano scorer disabled')
      await load()
    })

  const predict = () =>
    run('predict', async () => {
      if (!bridge || !goal.trim()) return
      const result = await call(bridge.learner.predict({ goal: goal.trim() }))
      setPrediction(result)
    })

  const suggestions = (status?.suggestions ?? []).filter((item) => item.kind === 'skill')

  return (
    <div className="adv-grid">
      <section className="adv-card">
        <div className="adv-card-head">
          <h3>Nano scorer</h3>
          <span className="adv-hint">trained on recorded runs</span>
        </div>
        {active ? (
          <>
            <div className="adv-tiles">
              <div className="adv-tile">
                <span>Accuracy</span>
                <b>{active.model.metrics ? `${Math.round(active.model.metrics.accuracy * 100)}%` : '—'}</b>
                <small>{active.model.metrics?.holdout ? 'held-out split' : 'training split (no holdout)'}</small>
              </div>
              <div className="adv-tile">
                <span>Baseline</span>
                <b>{active.model.metrics ? `${Math.round(active.model.metrics.baseline * 100)}%` : '—'}</b>
                <small>majority class</small>
              </div>
              <div className="adv-tile">
                <span>Models</span>
                <b>{nanos.length}</b>
                <small>last {when(nanos[0]?.createdAt)}</small>
              </div>
            </div>
            <p className="adv-note">
              Promoted only when it beats the previous model on held-out episodes. Weights live in the vault and rollback is one click.
            </p>
          </>
        ) : (
          <p className="adv-empty">
            No nano scorer is active. It needs at least 12 scored episodes with both successful and failed runs — it predicts whether a goal is likely to finish.
          </p>
        )}
        <div className="adv-actions">
          <button className="adv-btn adv-btn-primary" disabled={busy !== null} onClick={() => void train()}>
            {busy === 'train' ? <Loader2 size={13} className="adv-spin" /> : <BrainCircuit size={13} />} Train scorer
          </button>
          <button className="adv-btn" disabled={busy !== null || !active} onClick={() => void rollback()}>
            {busy === 'rollback' ? <Loader2 size={13} className="adv-spin" /> : <Undo2 size={13} />} Rollback
          </button>
          <button className="adv-btn" disabled={busy !== null} onClick={() => void load()}>
            {busy === null ? <RefreshCw size={13} /> : <Loader2 size={13} className="adv-spin" />} Refresh
          </button>
        </div>
        {active && (
          <>
            <label className="adv-field">
              <span>Predict a goal</span>
              <input className="adv-input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="build a status report from the logs" />
            </label>
            <div className="adv-actions">
              <button className="adv-btn" disabled={busy !== null || !goal.trim()} onClick={() => void predict()}>
                {busy === 'predict' ? <Loader2 size={13} className="adv-spin" /> : <Play size={13} />} Predict
              </button>
            </div>
            {prediction && (
              <p className="adv-note">
                {prediction.verdict === 'likely-success' ? 'Likely success' : 'Likely failure'} · {Math.round(prediction.probability * 100)}% probability
                {prediction.accuracy != null ? ` · model ${Math.round(prediction.accuracy * 100)}% on ${prediction.holdout ? 'holdout' : 'training data'}` : ''}
                . A hint only — it never replaces a real run.
              </p>
            )}
          </>
        )}
      </section>

      <section className="adv-card">
        <div className="adv-card-head">
          <h3>Skill suggestions</h3>
          <span className="adv-hint">from successful runs</span>
        </div>
        {suggestions.length === 0 ? (
          <p className="adv-empty">No new recipes to compile. Finish a run with at least one tool step.</p>
        ) : (
          <div>
            {suggestions.map((item) => (
              <div className="training-pack" key={item.id}>
                <Sparkles size={12} />
                <span className="adv-clip" title={item.detail}>{item.detail}</span>
                <button
                  className="adv-btn adv-btn-sm ml-auto"
                  disabled={busy !== null || !item.episodeId}
                  onClick={() => item.episodeId && void compile(item.episodeId)}
                >
                  {item.episodeId && busy === `compile-${item.episodeId}` ? <Loader2 size={12} className="adv-spin" /> : 'Compile'}
                </button>
              </div>
            ))}
          </div>
        )}
        <p className="adv-note">Compiled skills stay suggested until you enable them. Enabled skills are added to the agent prompt, and disabling one removes it immediately.</p>
      </section>

      <section className="adv-card adv-card-wide">
        <div className="adv-card-head">
          <h3>Skill studio</h3>
          <span className="adv-hint">{manual.id ? 'editing an existing skill' : 'write, import or export skills'}</span>
        </div>
        <div className="adv-form-row">
          <label className="adv-field">
            <span>Name</span>
            <input className="adv-input" value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} placeholder="Weekly report from logs" />
          </label>
          <label className="adv-field">
            <span>When it applies</span>
            <input className="adv-input" value={manual.when} onChange={(e) => setManual({ ...manual, when: e.target.value })} placeholder="when the user asks for a weekly summary of system logs" />
          </label>
        </div>
        <label className="adv-field">
          <span>Steps · one tool per line, optional JSON args</span>
          <textarea
            className="adv-input"
            rows={4}
            value={manual.steps}
            onChange={(e) => setManual({ ...manual, steps: e.target.value })}
            placeholder={'fs_list {"path":"C:\\\\logs"}\nfs_read {"path":"C:\\\\logs\\\\app.log"}\nfs_write {"path":"reports\\\\week.md","content":"…"}'}
          />
        </label>
        <div className="adv-form-row">
          <label className="adv-field">
            <span>Success check</span>
            <input className="adv-input" value={manual.successCheck} onChange={(e) => setManual({ ...manual, successCheck: e.target.value })} placeholder="The report file exists and mentions today's errors." />
          </label>
          <label className="adv-field">
            <span>Avoid (comma separated)</span>
            <input className="adv-input" value={manual.avoid} onChange={(e) => setManual({ ...manual, avoid: e.target.value })} placeholder="Do not read binary files, keep the report under 2 MB" />
          </label>
        </div>
        <div className="adv-actions">
          <label className="adv-check">
            <input type="checkbox" checked={manual.activate} onChange={(e) => setManual({ ...manual, activate: e.target.checked })} />
            Enable immediately
          </label>
          <button
            className="adv-btn adv-btn-primary"
            disabled={busy !== null || !manual.name.trim() || !manual.when.trim() || !manual.steps.trim()}
            onClick={() => void saveManual()}
          >
            {busy === 'manual-save' ? <Loader2 size={13} className="adv-spin" /> : <Plus size={13} />} {manual.id ? 'Update skill' : 'Save skill'}
          </button>
          {manual.id && (
            <button className="adv-btn" disabled={busy !== null} onClick={() => setManual(emptyManual)}>
              Cancel edit
            </button>
          )}
          <button className="adv-btn ml-auto" disabled={busy !== null || !skills.length} onClick={() => void exportAll()}>
            {busy === 'export-all' ? <Loader2 size={13} className="adv-spin" /> : <Download size={13} />} Export all
          </button>
        </div>
        <label className="adv-field">
          <span>Import skill JSON, skill pack or Claude SKILL.md {importName ? `· ${importName}` : ''}</span>
          <textarea className="adv-input" rows={5} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder={'---\nname: pdf-report\ndescription: Turn a PDF into a reviewed summary report.\nallowed-tools: fs_read, doc_extract\n---\n# PDF report\nSteps:\n1. tool: doc_extract {"path":"C:/docs/report.pdf"}\n2. tool: fs_write {"path":"C:/docs/summary.md"}\n\nSuccess check: The summary file exists and quotes the source.\nAvoid: Do not edit the source PDF.'} />
        </label>
        <input
          ref={skillFileRef}
          type="file"
          accept=".md,.markdown,text/markdown"
          hidden
          onChange={(e) => {
            loadSkillFile(e.target.files && e.target.files[0])
            e.target.value = ''
          }}
        />
        <div className="adv-actions">
          <button className="adv-btn" disabled={busy !== null || !importText.trim()} onClick={() => void importPack()}>
            {busy === 'import' ? <Loader2 size={13} className="adv-spin" /> : <Upload size={13} />} Import
          </button>
          <button className="adv-btn" disabled={busy !== null} onClick={() => skillFileRef.current?.click()}>
            Load SKILL.md file
          </button>
          <span className="adv-hint">Frontmatter becomes the name, trigger and allowed tools; explicit <code>tool:</code> steps stay executable, the rest is kept as instructions.</span>
        </div>
      </section>

      <section className="adv-card adv-card-wide">
        <div className="adv-card-head">
          <h3>Compiled skills</h3>
          <span className="adv-hint">{skills.length} stored</span>
        </div>
        {skills.length === 0 ? (
          <p className="adv-empty">No compiled skills yet. Compile one from a recorded run above.</p>
        ) : (
          <div className="adv-table">
            <div className="adv-tr adv-th"><span>Name</span><span>Status</span><span>Steps</span><span>Tools</span><span>Score</span><span>Updated</span><span /></div>
            {skills.map((skill) => (
              <div key={skill.id} className="adv-tr">
                <span className="adv-clip" title={skill.when || skill.name}>{skill.name}</span>
                <span>{skill.status}</span>
                <span>{skill.steps}</span>
                <span className="adv-clip" title={skill.tools.join(', ')}>{skill.tools.join(', ') || '—'}</span>
                <span>{skill.score == null ? '—' : `${Math.round(skill.score * 100)}%`}</span>
                <span>{new Date(skill.updatedAt).toLocaleDateString()}</span>
                <span className="adv-row-actions">
                  <button className="adv-btn adv-btn-sm" disabled={busy !== null} onClick={() => void showPrompt(skill)}>
                    {busy === `prompt-${skill.id}` ? <Loader2 size={12} className="adv-spin" /> : 'Prompt'}
                  </button>
                  <button className="adv-btn adv-btn-sm" disabled={busy !== null} onClick={() => void toggle(skill)}>
                    {skill.status === 'active' ? 'Disable' : 'Enable'}
                  </button>
                  <button className="adv-btn adv-btn-sm" disabled={busy !== null} onClick={() => void editManual(skill)}>
                    {busy === `edit-${skill.id}` ? <Loader2 size={12} className="adv-spin" /> : 'Edit'}
                  </button>
                  <button className="adv-icon" title="Export" disabled={busy !== null} onClick={() => void exportOne(skill)}>
                    {busy === `export-${skill.id}` ? <Loader2 size={13} className="adv-spin" /> : <Download size={13} />}
                  </button>
                  <button className="adv-icon" title="Delete" disabled={busy !== null} onClick={() => void remove(skill)}>
                    {busy === `delete-${skill.id}` ? <Loader2 size={13} className="adv-spin" /> : <Trash2 size={13} />}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        {prompt && (
          <>
            <p className="adv-note">Prompt preview · {prompt.id}</p>
            <pre className="training-json">{prompt.text || 'That skill has no body any more.'}</pre>
          </>
        )}
      </section>

      {error && (
        <p className="adv-error adv-card-wide" role="alert">
          <AlertTriangle size={13} /> {error}
        </p>
      )}
    </div>
  )
}
