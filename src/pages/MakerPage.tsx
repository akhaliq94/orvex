import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Code2,
  Download,
  ExternalLink,
  Eye,
  FileCode2,
  FolderOpen,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Square,
  Trash2,
} from 'lucide-react'
import PageShell from './PageShell'
import type {
  IpcResult,
  OrvexMakerFile,
  OrvexMakerProject,
  OrvexMakerRun,
  OrvexMakerTemplate,
} from '../types/desktop'
import './maker.css'

type Props = { onBack: () => void; notify: (msg: string) => void }

const bridge = typeof window !== 'undefined' ? window.orvex : undefined

const TEMPLATE_ICON: Record<string, typeof Eye> = {
  website: Eye,
  landing: Eye,
  'design-kit': Code2,
  'node-cli': Play,
  'python-cli': Play,
  'react-vite': Code2,
}

function required<T>(promise: Promise<IpcResult<T>> | undefined): Promise<T> {
  if (!promise) throw new Error('The desktop bridge is not available. Run ORVEX as the desktop app.')
  return promise.then((result) => {
    if (!result.ok) throw new Error(result.error)
    return result.data
  })
}

function messageOf(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function bytes(value: number | null | undefined): string {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function when(iso: string | null | undefined) {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

function kindLabel(kind: string) {
  if (kind === 'static') return 'static site'
  if (kind === 'react') return 'React app'
  if (kind === 'node-cli') return 'Node CLI'
  if (kind === 'python-cli') return 'Python CLI'
  return kind
}

export default function MakerPage({ onBack, notify }: Props) {
  const [templates, setTemplates] = useState<OrvexMakerTemplate[]>([])
  const [projects, setProjects] = useState<OrvexMakerProject[]>([])
  const [root, setRoot] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [entries, setEntries] = useState<OrvexMakerFile[]>([])
  const [filePath, setFilePath] = useState('')
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [binary, setBinary] = useState(false)
  const [fileSize, setFileSize] = useState(0)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewNonce, setPreviewNonce] = useState(0)
  const [runArgs, setRunArgs] = useState('')
  const [runResult, setRunResult] = useState<OrvexMakerRun | null>(null)
  const [exported, setExported] = useState<{ file: string; bytes: number } | null>(null)
  const [form, setForm] = useState({ template: 'website', name: '', title: '', description: '' })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const selected = useMemo(
    () => projects.find((project) => project.id === selectedId) || null,
    [projects, selectedId],
  )
  const template = useMemo(
    () => templates.find((item) => item.id === form.template) || null,
    [templates, form.template],
  )
  const dirty = !binary && content !== savedContent

  const loadFiles = useCallback(async (projectId: string) => {
    const result = await required(bridge?.maker.files(projectId))
    setEntries(result.files)
    return result.project
  }, [])

  const load = useCallback(async () => {
    if (!bridge) throw new Error('The desktop bridge is not available. Run ORVEX as the desktop app.')
    const [list, nextTemplates] = await Promise.all([
      required(bridge.maker.list()),
      required(bridge.maker.templates()),
    ])
    setProjects(list.projects)
    setRoot(list.root)
    setTemplates(nextTemplates)
    setForm((current) => {
      if (nextTemplates.some((item) => item.id === current.template)) return current
      return { ...current, template: nextTemplates[0]?.id || 'website' }
    })
    setSelectedId((current) => {
      if (current && list.projects.some((project) => project.id === current)) return current
      return list.projects[0]?.id || null
    })
  }, [])

  useEffect(() => {
    void load().catch((err) => setError(messageOf(err)))
  }, [load])

  useEffect(() => {
    if (!bridge) return
    return bridge.maker.onChange(() => {
      void load().catch(() => {})
    })
  }, [load])

  useEffect(() => {
    if (!selectedId) {
      setEntries([])
      setFilePath('')
      setContent('')
      setSavedContent('')
      setBinary(false)
      setPreviewUrl(null)
      setRunResult(null)
      setExported(null)
      return
    }
    let cancelled = false
    setPreviewUrl(selected?.previewUrl ?? null)
    required(bridge?.maker.files(selectedId))
      .then((result) => {
        if (cancelled) return
        setEntries(result.files)
        setRunResult(null)
        setExported(null)
      })
      .catch((err) => {
        if (!cancelled) setError(messageOf(err))
      })
    return () => {
      cancelled = true
    }
    // selected?.previewUrl is refreshed by the project list; only the id drives the reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key)
    setError(null)
    try {
      await task()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const select = (project: OrvexMakerProject) => {
    if (project.id === selectedId) return
    if (dirty && !window.confirm('Discard unsaved edits to this file?')) return
    setSelectedId(project.id)
    setFilePath('')
    setContent('')
    setSavedContent('')
    setBinary(false)
  }

  const createProject = () =>
    run('create', async () => {
      if (!bridge) return
      const name = form.name.trim()
      if (name.length < 2) throw new Error('Give the project a name (2-60 characters).')
      const project = await required(
        bridge.maker.create({
          template: form.template,
          name,
          title: form.title.trim() || undefined,
          description: form.description.trim() || undefined,
        }),
      )
      setForm((current) => ({ ...current, name: '', title: '', description: '' }))
      setSelectedId(project.id)
      setEntries([])
      setFilePath('')
      setContent('')
      setSavedContent('')
      notify(`Created ${project.name} in ${project.dir}`)
      await load()
    })

  const openFile = (path: string) =>
    run('open-file', async () => {
      if (!bridge || !selected) return
      if (dirty && !window.confirm('Discard unsaved edits to this file?')) return
      const file = await required(bridge.maker.read(selected.id, path))
      setFilePath(file.path)
      setContent(file.content ?? '')
      setSavedContent(file.content ?? '')
      setBinary(file.binary)
      setFileSize(file.size)
    })

  const saveFile = () =>
    run('save-file', async () => {
      if (!bridge || !selected) return
      const path = filePath.trim().replace(/\\/g, '/')
      if (!path) throw new Error('Enter a file path such as index.html or src/app.js.')
      if (binary) throw new Error('Binary files cannot be edited here.')
      const result = await required(bridge.maker.write(selected.id, path, content))
      setFilePath(result.path)
      setSavedContent(content)
      setFileSize(result.bytes)
      setBinary(false)
      notify(`Saved ${result.path} (${bytes(result.bytes)})`)
      await loadFiles(selected.id)
      await load()
      if (result.project.kind === 'static') setPreviewNonce((n) => n + 1)
    })

  const startPreview = () =>
    run('preview', async () => {
      if (!bridge || !selected) return
      const result = await required(bridge.maker.preview(selected.id))
      setPreviewUrl(result.url)
      setPreviewNonce((n) => n + 1)
      notify(`Preview running at ${result.url}`)
    })

  const stopPreview = () =>
    run('preview', async () => {
      if (!bridge || !selected) return
      await required(bridge.maker.stopPreview(selected.id))
      setPreviewUrl(null)
      notify('Preview server stopped')
    })

  const exportProject = () =>
    run('export', async () => {
      if (!bridge || !selected) return
      const result = await required(bridge.maker.export(selected.id))
      setExported({ file: result.file, bytes: result.bytes })
      notify(`Exported ${result.project.slug}.zip (${bytes(result.bytes)})`)
      await load()
    })

  const openFolder = () =>
    run('open-folder', async () => {
      if (!bridge || !selected) return
      await required(bridge.maker.open(selected.id))
    })

  const revealFolder = () =>
    run('reveal-folder', async () => {
      if (!bridge || !selected) return
      await required(bridge.maker.reveal(selected.id))
    })

  const removeProject = () =>
    run('remove', async () => {
      if (!bridge || !selected) return
      if (!window.confirm(`Delete "${selected.name}" and every file in ${selected.dir}? This cannot be undone.`)) return
      await required(bridge.maker.remove(selected.id))
      setSelectedId(null)
      setPreviewUrl(null)
      setEntries([])
      setFilePath('')
      setContent('')
      setSavedContent('')
      notify('Project deleted')
      await load()
    })

  const runTool = () =>
    run('run', async () => {
      if (!bridge || !selected) return
      const args = runArgs
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      const result = await required(bridge.maker.run(selected.id, args))
      setRunResult(result)
      if (result.ok) notify('The tool finished successfully')
    })

  const canEdit = Boolean(selected && filePath.trim())
  const canPreview = Boolean(selected && (selected.kind === 'static' || selected.kind === 'react'))

  return (
    <PageShell
      title="Maker"
      sub="Scaffold real websites, tools and design systems, then edit and run them"
      onBack={onBack}
      actions={
        <>
          <button className="adv-btn" disabled={busy !== null} onClick={() => void run('refresh', load)}>
            {busy === 'refresh' ? <Loader2 size={13} className="adv-spin" /> : <RefreshCw size={13} />} Refresh
          </button>
          <button className="adv-btn adv-btn-primary" onClick={() => document.getElementById('maker-name')?.focus()}>
            <Plus size={13} /> New project
          </button>
        </>
      }
    >
      <div className="adv">
        {error && (
          <p className="adv-error" role="alert">
            <AlertTriangle size={13} /> {error}
          </p>
        )}

        <section className="adv-card adv-card-wide">
          <div className="adv-card-head">
            <h3>Create a project</h3>
            <span className="adv-hint">{root || 'Maker projects folder'}</span>
          </div>
          <div className="maker-create">
            <label className="maker-field">
              <span>Template</span>
              <select
                className="select"
                value={form.template}
                onChange={(event) => setForm((current) => ({ ...current, template: event.target.value }))}
              >
                {templates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="maker-field maker-field-grow">
              <span>Name</span>
              <input
                id="maker-name"
                className="text-input"
                maxLength={60}
                placeholder="e.g. Nimbus portfolio"
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void createProject()
                }}
              />
            </label>
            <label className="maker-field maker-field-grow">
              <span>Headline (optional)</span>
              <input
                className="text-input"
                maxLength={120}
                placeholder="Used in page copy and the README"
                value={form.title}
                onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
              />
            </label>
            <button className="adv-btn adv-btn-primary" disabled={busy !== null || !form.name.trim()} onClick={() => void createProject()}>
              {busy === 'create' ? <Loader2 size={13} className="adv-spin" /> : <Plus size={13} />} Create
            </button>
          </div>
          {template && <p className="maker-template-note">{template.description}</p>}
        </section>

        <div className="maker-grid">
          <section className="adv-card maker-side">
            <div className="adv-card-head">
              <h3>Projects</h3>
              <span className="adv-hint">{projects.length}</span>
            </div>
            {projects.length === 0 ? (
              <p className="adv-empty">No projects yet. Pick a template above and create the first one.</p>
            ) : (
              <div className="maker-list">
                {projects.map((project) => {
                  const Icon = TEMPLATE_ICON[project.template] || Eye
                  return (
                    <button
                      key={project.id}
                      className={`maker-row ${project.id === selectedId ? 'active' : ''}`}
                      onClick={() => select(project)}
                    >
                      <span className="maker-row-icon">
                        <Icon size={13} />
                      </span>
                      <span className="maker-row-body">
                        <span className="maker-row-name">{project.name}</span>
                        <span className="maker-row-meta">
                          {kindLabel(project.kind)} · {project.files.length} file{project.files.length === 1 ? '' : 's'}
                          {project.previewUrl ? ' · live' : ''}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </section>

          <section className="adv-card maker-main">
            {!selected ? (
              <p className="adv-empty">Select a project or create a new one to see its files and preview.</p>
            ) : (
              <>
                <div className="adv-card-head">
                  <h3>{selected.name}</h3>
                  <span className="adv-hint">{kindLabel(selected.kind)} · {when(selected.updatedAt)}</span>
                </div>
                <div className="maker-actions">
                  {canPreview && (previewUrl ? (
                    <button className="adv-btn" disabled={busy !== null} onClick={() => void stopPreview()}>
                      {busy === 'preview' ? <Loader2 size={13} className="adv-spin" /> : <Square size={13} />} Stop preview
                    </button>
                  ) : (
                    <button className="adv-btn adv-btn-primary" disabled={busy !== null} onClick={() => void startPreview()}>
                      {busy === 'preview' ? <Loader2 size={13} className="adv-spin" /> : <Eye size={13} />} Preview
                    </button>
                  ))}
                  {(selected.kind === 'node-cli' || selected.kind === 'python-cli') && (
                    <button className="adv-btn" disabled={busy !== null} onClick={() => void runTool()}>
                      {busy === 'run' ? <Loader2 size={13} className="adv-spin" /> : <Play size={13} />} Run tool
                    </button>
                  )}
                  <button className="adv-btn" disabled={busy !== null} onClick={() => void exportProject()}>
                    {busy === 'export' ? <Loader2 size={13} className="adv-spin" /> : <Download size={13} />} Export zip
                  </button>
                  <button className="adv-btn" disabled={busy !== null} onClick={() => void openFolder()}>
                    <FolderOpen size={13} /> Open folder
                  </button>
                  <button className="adv-btn" disabled={busy !== null} onClick={() => void revealFolder()}>
                    <ExternalLink size={13} /> Reveal
                  </button>
                  <button className="adv-btn adv-btn-danger" disabled={busy !== null} onClick={() => void removeProject()}>
                    <Trash2 size={13} /> Delete
                  </button>
                </div>
                <div className="adv-kv">
                  <span>Folder</span>
                  <b className="adv-clip" title={selected.dir}>{selected.dir}</b>
                  <span>Template</span>
                  <b>{selected.template}</b>
                  <span>Palette</span>
                  <b className="maker-swatches">
                    {(['brand', 'accent', 'paper', 'ink'] as const).map((key) => (
                      <i key={key} title={`${key} ${selected.palette[key]}`} style={{ background: selected.palette[key] }} />
                    ))}
                  </b>
                </div>
                {selected.kind === 'react' && !previewUrl && (
                  <p className="adv-note">
                    <AlertTriangle size={12} /> React projects preview only after you run{' '}
                    <code>npm install</code> and <code>npm run build</code> in this folder.
                  </p>
                )}
                {exported && (
                  <p className="adv-note">
                    <Download size={12} /> Exported {bytes(exported.bytes)} to{' '}
                    <span className="adv-clip" title={exported.file}>{exported.file}</span>
                  </p>
                )}

                {previewUrl && (
                  <div className="maker-preview">
                    <div className="maker-preview-bar">
                      <span className="adv-clip" title={previewUrl}>{previewUrl}</span>
                      <button className="adv-btn" onClick={() => setPreviewNonce((n) => n + 1)} title="Reload the preview">
                        <RefreshCw size={12} /> Reload
                      </button>
                    </div>
                    <iframe
                      key={previewNonce}
                      src={previewUrl}
                      title={`${selected.name} preview`}
                      sandbox="allow-scripts allow-forms allow-modals allow-popups"
                    />
                  </div>
                )}

                {(selected.kind === 'node-cli' || selected.kind === 'python-cli') && (
                  <div className="maker-run">
                    <label className="maker-field">
                      <span>Arguments — one per line</span>
                      <input
                        className="text-input"
                        placeholder="e.g. README.md then --json"
                        value={runArgs}
                        onChange={(event) => setRunArgs(event.target.value)}
                      />
                    </label>
                    {runResult && (
                      <div className="maker-out">
                        <p className={runResult.ok ? 'maker-out-head' : 'maker-out-head maker-out-bad'}>
                          {runResult.ok ? `Exit ${runResult.code ?? 0}` : runResult.error || 'The tool failed'}
                        </p>
                        {runResult.stdout && <pre>{runResult.stdout}</pre>}
                        {runResult.stderr && <pre className="maker-out-bad">{runResult.stderr}</pre>}
                      </div>
                    )}
                  </div>
                )}

                <div className="maker-files">
                  <div className="maker-file-list">
                    <div className="maker-file-head">
                      <span>Files</span>
                      <span className="adv-hint">{entries.length}</span>
                    </div>
                    {entries.length === 0 ? (
                      <p className="adv-empty">Reading the project folder…</p>
                    ) : (
                      entries.map((file) => (
                        <button
                          key={file.path}
                          className={`maker-file ${file.path === filePath ? 'active' : ''}`}
                          disabled={file.dir}
                          onClick={() => void openFile(file.path)}
                          title={file.path}
                        >
                          <FileCode2 size={12} />
                          <span className="adv-clip">{file.path}</span>
                          {!file.dir && <small>{bytes(file.size)}</small>}
                        </button>
                      ))
                    )}
                  </div>
                  <div className="maker-editor">
                    <div className="maker-editor-head">
                      <input
                        className="text-input maker-path"
                        placeholder="Path — e.g. styles.css or src/new.js"
                        value={filePath}
                        onChange={(event) => setFilePath(event.target.value)}
                      />
                      <span className="adv-hint">{binary ? 'binary' : `${content.length.toLocaleString()} chars · ${bytes(fileSize)}`}</span>
                      <button
                        className="adv-btn adv-btn-primary"
                        disabled={!canEdit || binary || !dirty || busy !== null}
                        onClick={() => void saveFile()}
                      >
                        {busy === 'save-file' ? <Loader2 size={13} className="adv-spin" /> : <Save size={13} />} Save
                      </button>
                    </div>
                    {binary ? (
                      <p className="adv-empty">This file is binary and cannot be edited as text here.</p>
                    ) : canEdit ? (
                      <>
                        <textarea
                          className="text-input dc-textarea maker-code"
                          spellCheck={false}
                          value={content}
                          onChange={(event) => setContent(event.target.value)}
                        />
                        {dirty && <p className="adv-note"><AlertTriangle size={12} /> Unsaved changes.</p>}
                      </>
                    ) : (
                      <p className="adv-empty">Pick a file on the left, or type a new path to create one.</p>
                    )}
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </PageShell>
  )
}
