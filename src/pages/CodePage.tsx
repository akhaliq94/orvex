import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronRight,
  FileCode2,
  FilePlus,
  FolderOpen,
  GitBranch,
  Loader2,
  Pencil,
  Play,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react'
import PageShell from './PageShell'
import { useProviders } from '../hooks/useProviders'
import { useLLM } from '../hooks/useLLM'
import { buildCandidates, orderForTask } from '../data/routing'
import type {
  OrvexCodeEntry,
  OrvexCodeRunEvent,
  OrvexCodeWorkspace,
  OrvexGitLogEntry,
  OrvexGitStatus,
} from '../types/desktop'

type Props = { onBack: () => void; notify: (msg: string) => void }

type OpenFile = { path: string; content: string; original: string; binary: boolean; size: number }
type RunState = {
  runId: string
  label: string
  kind: 'script' | 'terminal'
  output: string
  status: 'running' | 'done' | 'stopped'
  code?: number | null
  ms?: number
}
type SearchHit = { path: string; line: number; column: number; text: string }
type RightTab = 'git' | 'run' | 'review'

const bridge = typeof window !== 'undefined' ? window.orvex : undefined
const codeApi = bridge?.code
const LINE_HEIGHT = 18

function dirname(p: string) {
  const i = p.replace(/\\/g, '/').lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}

function basename(p: string) {
  const parts = p.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || p
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function TreeBranch(props: {
  pathKey: string
  depth: number
  tree: Record<string, OrvexCodeEntry[]>
  expanded: Set<string>
  active: string | null
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}) {
  const { pathKey, depth, tree, expanded, active, onToggle, onOpen } = props
  const entries = tree[pathKey]
  if (!entries) return null
  if (!entries.length) {
    return <p className="code-tree-empty" style={{ paddingLeft: 12 + depth * 12 }}>empty</p>
  }
  return (
    <>
      {entries.map((entry) => {
        const isOpen = expanded.has(entry.path)
        return (
          <div key={entry.path}>
            <button
              className={`code-file-row ${active === entry.path ? 'active' : ''}`}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => (entry.dir ? onToggle(entry.path) : onOpen(entry.path))}
              title={entry.path}
            >
              {entry.dir ? (
                <ChevronRight size={12} className={`code-chevron ${isOpen ? 'open' : ''}`} />
              ) : (
                <FileCode2 size={12} />
              )}
              <span className="truncate">{entry.name}</span>
              {!entry.dir && entry.size > 0 && <span className="code-file-size">{formatBytes(entry.size)}</span>}
            </button>
            {entry.dir && isOpen && (
              <TreeBranch
                pathKey={entry.path}
                depth={depth + 1}
                tree={tree}
                expanded={expanded}
                active={active}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <p className="dim code-pad">No diff for this file.</p>
  return (
    <pre className="code-diff">
      {diff.split('\n').map((line, i) => {
        const cls = line.startsWith('+++') || line.startsWith('---')
          ? 'meta'
          : line.startsWith('@@')
            ? 'hunk'
            : line.startsWith('+')
              ? 'add'
              : line.startsWith('-')
                ? 'del'
                : ''
        return (
          <span key={i} className={cls}>
            {line || ' '}
            {'\n'}
          </span>
        )
      })}
    </pre>
  )
}

export default function CodePage({ onBack, notify }: Props) {
  const { providers, activeId, active } = useProviders()
  const llm = useLLM()

  const [ws, setWs] = useState<OrvexCodeWorkspace | null>(null)
  const [booting, setBooting] = useState(!!codeApi)
  const [error, setError] = useState<string | null>(null)

  const [tree, setTree] = useState<Record<string, OrvexCodeEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const [files, setFiles] = useState<OpenFile[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [pending, setPending] = useState<{ line: number; column: number } | null>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)

  const [searchText, setSearchText] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [searchNote, setSearchNote] = useState('')
  const [searching, setSearching] = useState(false)

  const [tab, setTab] = useState<RightTab>('git')
  const [git, setGit] = useState<OrvexGitStatus | null>(null)
  const [gitLog, setGitLog] = useState<OrvexGitLogEntry[]>([])
  const [gitBusy, setGitBusy] = useState(false)
  const [diff, setDiff] = useState('')
  const [diffLabel, setDiffLabel] = useState('')
  const [commitMsg, setCommitMsg] = useState('')

  const [runs, setRuns] = useState<RunState[]>([])
  const [runId, setRunId] = useState<string | null>(null)
  const [command, setCommand] = useState('')
  const [runBusy, setRunBusy] = useState(false)

  const [review, setReview] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const reviewHandle = useRef<{ abort: () => void } | null>(null)

  const current = files.find((f) => f.path === activePath) ?? null
  const dirty = !!current && !current.binary && current.content !== current.original
  const activeRun = runs.find((r) => r.runId === runId) ?? null
  const stagedCount = git?.entries.filter((e) => e.staged).length ?? 0
  const changesCount = git?.entries.length ?? 0

  const refreshTree = useCallback(async (rel: string) => {
    if (!codeApi) return
    const res = await codeApi.list(rel)
    if (!res.ok) {
      setError(res.error)
      return
    }
    const key = res.data.path === '.' ? '' : res.data.path
    setTree((prev) => ({ ...prev, [key]: res.data.entries }))
  }, [])

  const refreshGit = useCallback(async () => {
    if (!codeApi) return
    const [status, log] = await Promise.all([codeApi.gitStatus(), codeApi.gitLog(12)])
    if (status.ok) setGit(status.data)
    else setError(status.error)
    if (log.ok) setGitLog(log.data.entries)
  }, [])

  useEffect(() => {
    try {
      localStorage.removeItem('orvex-code-files')
    } catch {
      /* storage can be unavailable in sandboxed profiles */
    }
  }, [])

  useEffect(() => {
    if (!codeApi) return
    void (async () => {
      const res = await codeApi.info()
      if (res.ok) setWs(res.data)
      else setError(res.error)
      setBooting(false)
    })()
    return codeApi.onChange((info) => setWs(info))
  }, [])

  const root = ws?.root ?? null

  useEffect(() => {
    setTree({})
    setExpanded(new Set())
    setFiles([])
    setActivePath(null)
    setHits(null)
    setDiff('')
    setDiffLabel('')
    setRuns([])
    setRunId(null)
    setReview('')
    if (!root) {
      setGit(null)
      setGitLog([])
      return
    }
    void refreshTree('')
    void refreshGit()
  }, [root, refreshTree, refreshGit])

  useEffect(() => {
    if (!codeApi) return
    return codeApi.onOutput((evt: OrvexCodeRunEvent) => {
      setRuns((prev) => {
        if (evt.type === 'start') {
          if (prev.some((r) => r.runId === evt.runId)) return prev
          return [
            ...prev,
            {
              runId: evt.runId,
              label: evt.command || 'command',
              kind: evt.kind === 'script' ? 'script' : 'terminal',
              output: '',
              status: 'running',
            },
          ]
        }
        return prev.map((run) => {
          if (run.runId !== evt.runId) return run
          if (evt.type === 'data') {
            const next = run.output + (evt.chunk || '')
            return { ...run, output: next.length > 200000 ? next.slice(-200000) : next }
          }
          return {
            ...run,
            status: evt.stopped ? 'stopped' : 'done',
            code: evt.code ?? null,
            ms: evt.ms,
          }
        })
      })
      if (evt.type === 'start') setRunId(evt.runId)
    })
  }, [])

  useEffect(() => {
    const el = document.getElementById('code-run-console')
    if (el) el.scrollTop = el.scrollHeight
  }, [activeRun?.output])

  const toggleDir = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else {
          next.add(path)
          if (!tree[path]) void refreshTree(path)
        }
        return next
      })
    },
    [tree, refreshTree],
  )

  const openFile = useCallback(
    async (path: string, jump?: { line: number; column: number }) => {
      if (!codeApi) return
      setActivePath(path)
      setPending(jump ?? null)
      if (files.some((f) => f.path === path)) return
      const res = await codeApi.read(path)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setFiles((prev) =>
        prev.some((f) => f.path === path)
          ? prev
          : [
              ...prev,
              {
                path,
                content: res.data.content,
                original: res.data.content,
                binary: res.data.binary,
                size: res.data.size,
              },
            ],
      )
    },
    [files],
  )

  useEffect(() => {
    if (!pending || !current || current.binary || !editorRef.current) return
    const lines = current.content.split('\n')
    const line = Math.min(Math.max(pending.line - 1, 0), lines.length - 1)
    let offset = 0
    for (let i = 0; i < line; i += 1) offset += lines[i].length + 1
    offset += Math.max(0, pending.column - 1)
    const end = Math.min(offset + (lines[line]?.length ?? 0), current.content.length)
    const ta = editorRef.current
    ta.focus()
    ta.setSelectionRange(offset, end)
    const scroller = ta.parentElement
    if (scroller) scroller.scrollTop = Math.max(0, line * LINE_HEIGHT - 60)
    setPending(null)
  }, [pending, current])

  const saveFile = useCallback(
    async (path: string) => {
      if (!codeApi) return
      const file = files.find((f) => f.path === path)
      if (!file || file.binary) return
      const res = await codeApi.write(path, file.content)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, original: f.content, size: res.data.bytes } : f)))
      notify(`Saved ${path}`)
      void refreshTree(dirname(path))
      void refreshGit()
    },
    [files, notify, refreshTree, refreshGit],
  )

  const closeTab = useCallback(
    (path: string) => {
      const file = files.find((f) => f.path === path)
      if (file && !file.binary && file.content !== file.original) {
        if (!window.confirm(`${basename(path)} has unsaved changes. Close it anyway?`)) return
      }
      setFiles((prev) => {
        const next = prev.filter((f) => f.path !== path)
        if (activePath === path) setActivePath(next.length ? next[next.length - 1].path : null)
        return next
      })
    },
    [files, activePath],
  )

  const newFile = useCallback(async () => {
    if (!codeApi || !root) return
    const name = window.prompt('New file path (relative to the workspace):')
    if (!name || !name.trim()) return
    const path = name.trim()
    const res = await codeApi.write(path, '')
    if (!res.ok) {
      setError(res.error)
      return
    }
    await refreshTree(dirname(path))
    await openFile(path)
    notify(`Created ${path}`)
    void refreshGit()
  }, [root, notify, refreshTree, openFile, refreshGit])

  const deleteFile = useCallback(async () => {
    if (!codeApi || !current) return
    if (!window.confirm(`Delete ${current.path}? This removes it from disk and cannot be undone.`)) return
    const res = await codeApi.remove(current.path)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setFiles((prev) => prev.filter((f) => f.path !== current.path))
    setActivePath(null)
    await refreshTree(dirname(current.path))
    void refreshGit()
    notify(`Deleted ${current.path}`)
  }, [current, notify, refreshTree, refreshGit])

  const renameFile = useCallback(async () => {
    if (!codeApi || !current) return
    const to = window.prompt('New path for this file:', current.path)
    if (!to || !to.trim() || to.trim() === current.path) return
    const res = await codeApi.rename(current.path, to.trim())
    if (!res.ok) {
      setError(res.error)
      return
    }
    setFiles((prev) =>
      prev.map((f) => (f.path === current.path ? { ...f, path: res.data.to, original: f.content } : f)),
    )
    setActivePath(res.data.to)
    await refreshTree(dirname(current.path))
    await refreshTree(dirname(res.data.to))
    void refreshGit()
    notify(`Renamed to ${res.data.to}`)
  }, [current, notify, refreshTree, refreshGit])

  const openFolder = useCallback(async () => {
    if (!codeApi) return
    const res = await codeApi.open()
    if (!res.ok) {
      setError(res.error)
      return
    }
    if (!res.data.cancelled) {
      setWs(res.data.info)
      notify(`Workspace: ${res.data.info.name}`)
    }
  }, [notify])

  const closeWorkspace = useCallback(async () => {
    if (!codeApi) return
    if (!window.confirm('Close this workspace? Running commands will be stopped.')) return
    await codeApi.close()
    setWs({ root: null, name: null, isGit: false, scripts: [], branch: null })
  }, [])

  const runSearch = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault()
      if (!codeApi || !root) return
      if (searchText.trim().length < 2) {
        setHits(null)
        setSearchNote('')
        return
      }
      setSearching(true)
      const res = await codeApi.search(searchText.trim())
      setSearching(false)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setHits(res.data.matches)
      setSearchNote(
        res.data.matches.length
          ? `${res.data.matches.length} match${res.data.matches.length === 1 ? '' : 'es'} in ${res.data.scanned} files${res.data.limited ? ' (capped)' : ''}`
          : `No matches in ${res.data.scanned} scanned files.`,
      )
    },
    [searchText, root],
  )

  const showDiff = useCallback(async (path: string, staged: boolean) => {
    if (!codeApi) return
    setDiffLabel(`${path}${staged ? ' (staged)' : ''}`)
    const res = await codeApi.gitDiff(path, staged)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setDiff(res.data.diff)
  }, [])

  const stage = useCallback(
    async (path: string, wantStage: boolean) => {
      if (!codeApi) return
      setGitBusy(true)
      const res = wantStage ? await codeApi.gitStage([path]) : await codeApi.gitUnstage([path])
      setGitBusy(false)
      if (!res.ok) {
        setError(res.error)
        return
      }
      await refreshGit()
    },
    [refreshGit],
  )

  const stageAll = useCallback(
    async (wantStage: boolean) => {
      if (!codeApi || !git) return
      const paths = [
        ...new Set(git.entries.filter((e) => (wantStage ? e.unstaged : e.staged)).map((e) => e.path)),
      ]
      if (!paths.length) return
      setGitBusy(true)
      const res = wantStage ? await codeApi.gitStage(paths) : await codeApi.gitUnstage(paths)
      setGitBusy(false)
      if (!res.ok) {
        setError(res.error)
        return
      }
      await refreshGit()
    },
    [git, refreshGit],
  )

  const commit = useCallback(async () => {
    if (!codeApi) return
    setGitBusy(true)
    const res = await codeApi.gitCommit(commitMsg)
    setGitBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setCommitMsg('')
    notify(`Committed ${res.data.hash}`)
    await refreshGit()
    setTab('git')
  }, [commitMsg, notify, refreshGit])

  const initRepo = useCallback(async () => {
    if (!codeApi) return
    setGitBusy(true)
    const res = await codeApi.gitInit()
    setGitBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    notify('Git repository initialized')
    setWs((prev) => (prev ? { ...prev, isGit: true } : prev))
    await refreshGit()
  }, [notify, refreshGit])

  const startScript = useCallback(
    async (name: string) => {
      if (!codeApi) return
      setRunBusy(true)
      const res = await codeApi.run(name)
      setRunBusy(false)
      if (!res.ok) {
        setError(res.error)
        setTab('run')
        return
      }
      setRuns((prev) =>
        prev.some((r) => r.runId === res.data.runId)
          ? prev
          : [
              ...prev,
              { runId: res.data.runId, label: res.data.command, kind: 'script', output: '', status: 'running' },
            ],
      )
      setRunId(res.data.runId)
      setTab('run')
    },
    [],
  )

  const startTerminal = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!codeApi || !command.trim()) return
      setRunBusy(true)
      const res = await codeApi.terminal(command.trim())
      setRunBusy(false)
      if (!res.ok) {
        setError(res.error)
        setTab('run')
        return
      }
      setCommand('')
      setRuns((prev) =>
        prev.some((r) => r.runId === res.data.runId)
          ? prev
          : [
              ...prev,
              { runId: res.data.runId, label: res.data.command, kind: 'terminal', output: '', status: 'running' },
            ],
      )
      setRunId(res.data.runId)
      setTab('run')
    },
    [command],
  )

  const stopRun = useCallback(async () => {
    if (!codeApi || !runId) return
    const res = await codeApi.stop(runId)
    if (!res.ok) setError(res.error)
  }, [runId])

  const reviewDiff = useCallback(async () => {
    if (!codeApi) return
    if (!active) {
      setReview('No provider is active. Add one in Settings → Providers to get an AI review.')
      return
    }
    setReviewing(true)
    setReview('')
    const worktree = await codeApi.gitDiff(undefined, false)
    let text = worktree.ok ? worktree.data.diff : ''
    if (!text.trim()) {
      const staged = await codeApi.gitDiff(undefined, true)
      text = staged.ok ? staged.data.diff : ''
    }
    if (!text.trim()) {
      setReviewing(false)
      setReview('Nothing to review — the working tree and index are clean.')
      return
    }
    const clipped = text.length > 60000 ? `${text.slice(0, 60000)}\n… diff clipped for review` : text
    const candidates = orderForTask(buildCandidates(providers, activeId), 'chat')
    reviewHandle.current = await llm.send({
      provider: active,
      candidates,
      task: 'chat',
      temperature: 0.2,
      maxTokens: 1400,
      system:
        'You are a senior code reviewer. Review only the provided diff. Point out real bugs, security problems, ' +
        'regressions and missing edge cases, referencing file names and line context. Be concise and concrete. ' +
        'End with a short verdict (ship / fix first).',
      messages: [{ role: 'user', content: `Review this git diff:\n\n${clipped}` }],
      onDelta: (_t, full) => setReview(full),
      onDone: () => setReviewing(false),
      onError: (message) => {
        setReviewing(false)
        setReview(`Review failed: ${message}`)
      },
    })
  }, [active, activeId, providers, llm])

  const stopReview = useCallback(() => {
    reviewHandle.current?.abort()
    setReviewing(false)
  }, [])

  const lines = useMemo(() => (current && !current.binary ? current.content.split('\n') : []), [current])

  const scripts = ws?.scripts ?? []

  return (
    <PageShell
      title="Code"
      sub={
        root
          ? `${ws?.name} — real workspace, git and terminal on your machine`
          : 'Open a folder to edit, search, run scripts and review diffs'
      }
      onBack={onBack}
      actions={
        <>
          <button className="page-tool-btn" onClick={() => void openFolder()} disabled={!codeApi} title="Open folder">
            <FolderOpen size={14} />
          </button>
          <button className="page-tool-btn" onClick={() => void newFile()} disabled={!root} title="New file">
            <FilePlus size={14} />
          </button>
          <button
            className="page-tool-btn"
            onClick={() => {
              void refreshTree('')
              void refreshGit()
            }}
            disabled={!root}
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        </>
      }
    >
      <div className="code-page">
        {!codeApi && (
          <div className="code-empty panel">
            <TerminalSquare size={30} />
            <h3>Coding workspace needs the desktop app</h3>
            <p className="dim">
              The browser preview can’t touch your filesystem. Launch ORVEX desktop and this page opens real folders,
              runs your package.json scripts and streams the output.
            </p>
          </div>
        )}

        {codeApi && booting && (
          <div className="code-empty panel">
            <Loader2 size={24} className="spin" />
            <p className="dim">Checking the workspace…</p>
          </div>
        )}

        {codeApi && !booting && !root && (
          <div className="code-empty panel">
            <FolderOpen size={30} />
            <h3>No folder open</h3>
            <p className="dim">
              Pick any project folder. ORVEX reads and writes inside it only, detects your npm scripts, drives the real
              git binary and streams a guarded terminal — nothing is simulated.
            </p>
            <button className="btn-primary" onClick={() => void openFolder()}>
              <FolderOpen size={14} /> Open folder
            </button>
          </div>
        )}

        {root && (
          <>
            <div className="code-workspace">
              <span className="code-root" title={root}>
                {root}
              </span>
              {(git?.branch || ws?.branch) && (
                <span className="code-chip">
                  <GitBranch size={11} /> {git?.branch || ws?.branch}
                </span>
              )}
              {git?.git && changesCount > 0 && <span className="code-chip warn">{changesCount} changed</span>}
              {git?.git && changesCount === 0 && <span className="code-chip">clean</span>}
              {git?.ahead ? <span className="code-chip">↑{git.ahead}</span> : null}
              {git?.behind ? <span className="code-chip">↓{git.behind}</span> : null}
              <button className="code-chip-btn" onClick={() => void closeWorkspace()} title="Close workspace">
                <X size={12} /> close
              </button>
            </div>

            {error && (
              <div className="code-error">
                <AlertTriangle size={13} />
                <span>{error}</span>
                <button onClick={() => setError(null)} aria-label="Dismiss error">
                  <X size={12} />
                </button>
              </div>
            )}

            <div className="code-layout">
              <aside className="code-side panel">
                <form className="code-search" onSubmit={(e) => void runSearch(e)}>
                  <Search size={12} />
                  <input
                    value={searchText}
                    onChange={(e) => {
                      setSearchText(e.target.value)
                      if (!e.target.value.trim()) {
                        setHits(null)
                        setSearchNote('')
                      }
                    }}
                    placeholder="Search in files…"
                    aria-label="Search workspace"
                  />
                  {searchText && (
                    <button type="button" onClick={() => { setSearchText(''); setHits(null) }} aria-label="Clear search">
                      <X size={11} />
                    </button>
                  )}
                </form>
                <div className="code-side-body">
                  {hits ? (
                    <>
                      <p className="code-side-note">{searchNote || (searching ? 'Searching…' : '')}</p>
                      {hits.map((hit) => (
                        <button
                          key={`${hit.path}:${hit.line}:${hit.column}`}
                          className="code-hit"
                          onClick={() => void openFile(hit.path, { line: hit.line, column: hit.column })}
                          title={`${hit.path}:${hit.line}`}
                        >
                          <span className="code-hit-path">
                            {hit.path}:{hit.line}
                          </span>
                          <span className="code-hit-text">{hit.text}</span>
                        </button>
                      ))}
                    </>
                  ) : (
                    <TreeBranch
                      pathKey=""
                      depth={0}
                      tree={tree}
                      expanded={expanded}
                      active={activePath}
                      onToggle={toggleDir}
                      onOpen={(p) => void openFile(p)}
                    />
                  )}
                </div>
              </aside>

              <section className="code-main panel">
                <div className="code-tabs">
                  {files.map((f) => (
                    <div
                      key={f.path}
                      className={`code-tab ${activePath === f.path ? 'active' : ''}`}
                      onClick={() => setActivePath(f.path)}
                      title={f.path}
                    >
                      <FileCode2 size={12} />
                      <span className="truncate">{basename(f.path)}</span>
                      {!f.binary && f.content !== f.original && <span className="code-dirty" />}
                      <button
                        className="code-tab-x"
                        onClick={(e) => {
                          e.stopPropagation()
                          closeTab(f.path)
                        }}
                        aria-label={`Close ${f.path}`}
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                  {!files.length && <span className="dim code-tab-hint">Pick a file from the tree</span>}
                </div>

                {!current && (
                  <div className="code-blank">
                    <FileCode2 size={26} />
                    <p className="dim">Open a file, create one, or run a search. Changes are written to disk only when you save.</p>
                  </div>
                )}

                {current && current.binary && (
                  <div className="code-blank">
                    <FileCode2 size={26} />
                    <p className="dim">
                      {current.path} looks binary ({formatBytes(current.size)}). The text editor won’t touch it.
                    </p>
                    <button className="btn-ghost" onClick={() => void deleteFile()}>
                      <Trash2 size={12} /> Delete file
                    </button>
                  </div>
                )}

                {current && !current.binary && (
                  <>
                    <div className="code-editor-bar">
                      <span className="code-path" title={current.path}>{current.path}</span>
                      <span className="dim">{lines.length} lines · {formatBytes(current.size)}</span>
                      <div className="ml-auto flex items-center gap-1">
                        <button className="page-tool-btn" onClick={() => void renameFile()} title="Rename file">
                          <Pencil size={12} />
                        </button>
                        <button className="page-tool-btn" onClick={() => void deleteFile()} title="Delete file">
                          <Trash2 size={12} />
                        </button>
                        <button
                          className="page-tool-btn"
                          onClick={() => void saveFile(current.path)}
                          disabled={!dirty}
                          title="Save (Ctrl+S)"
                        >
                          <Save size={13} />
                        </button>
                      </div>
                    </div>
                    <div className="code-edit-scroll">
                      <div className="code-lines" aria-hidden>
                        {lines.map((_, i) => (
                          <span key={i}>{i + 1}</span>
                        ))}
                      </div>
                      <textarea
                        ref={editorRef}
                        className="code-textarea"
                        value={current.content}
                        spellCheck={false}
                        style={{ height: Math.max(lines.length * LINE_HEIGHT + 24, 200) }}
                        onChange={(e) =>
                          setFiles((prev) =>
                            prev.map((f) => (f.path === current.path ? { ...f, content: e.target.value } : f)),
                          )
                        }
                        onKeyDown={(e) => {
                          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                            e.preventDefault()
                            void saveFile(current.path)
                          }
                        }}
                        aria-label={`Edit ${current.path}`}
                      />
                    </div>
                  </>
                )}
              </section>

              <aside className="code-right panel">
                <div className="code-right-tabs">
                  <button className={tab === 'git' ? 'active' : ''} onClick={() => setTab('git')}>
                    <GitBranch size={12} /> Git{changesCount ? ` ${changesCount}` : ''}
                  </button>
                  <button className={tab === 'run' ? 'active' : ''} onClick={() => setTab('run')}>
                    <Play size={12} /> Run
                  </button>
                  <button className={tab === 'review' ? 'active' : ''} onClick={() => setTab('review')}>
                    <Sparkles size={12} /> Review
                  </button>
                </div>

                {tab === 'git' && (
                  <div className="code-panel-body">
                    {git && !git.git && (
                      <div className="code-git-empty">
                        <p className="dim">This folder is not a git repository.</p>
                        <button className="btn-ghost" onClick={() => void initRepo()} disabled={gitBusy}>
                          <GitBranch size={12} /> Initialize git
                        </button>
                      </div>
                    )}

                    {git?.git && (
                      <>
                        <div className="code-git-head">
                          <span className="dim">
                            {stagedCount} staged · {changesCount - stagedCount} unstaged
                          </span>
                          <div className="flex items-center gap-1">
                            {git.entries.some((e) => e.unstaged) && (
                              <button className="code-mini-btn" onClick={() => void stageAll(true)} disabled={gitBusy}>
                                stage all
                              </button>
                            )}
                            {git.entries.some((e) => e.staged) && (
                              <button className="code-mini-btn" onClick={() => void stageAll(false)} disabled={gitBusy}>
                                unstage all
                              </button>
                            )}
                            <button className="code-mini-btn" onClick={() => void refreshGit()} disabled={gitBusy}>
                              <RefreshCw size={11} /> refresh
                            </button>
                          </div>
                        </div>
                        <div className="code-changes">
                          {git.entries.length === 0 && <p className="dim code-pad">Working tree clean.</p>}
                          {git.entries.map((entry) => (
                            <div key={`${entry.path}:${entry.staged}`} className="code-change">
                              <button
                                className="code-change-name"
                                onClick={() => void showDiff(entry.path, entry.staged)}
                                title="Show diff"
                              >
                                <span className={`code-status ${entry.untracked ? 'untracked' : entry.unstaged ? 'modified' : 'staged'}`}>
                                  {entry.untracked ? '?' : entry.unstaged ? entry.worktree : entry.index}
                                </span>
                                <span className="truncate">{entry.path}</span>
                              </button>
                              <div className="code-change-actions">
                                {entry.unstaged && (
                                  <button className="code-mini-btn" onClick={() => void stage(entry.path, true)} disabled={gitBusy}>
                                    stage
                                  </button>
                                )}
                                {entry.staged && (
                                  <button className="code-mini-btn" onClick={() => void stage(entry.path, false)} disabled={gitBusy}>
                                    unstage
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                        <form
                          className="code-commit"
                          onSubmit={(e) => {
                            e.preventDefault()
                            void commit()
                          }}
                        >
                          <textarea
                            value={commitMsg}
                            onChange={(e) => setCommitMsg(e.target.value)}
                            placeholder="Commit message"
                            rows={2}
                            aria-label="Commit message"
                          />
                          <button className="btn-primary" type="submit" disabled={gitBusy || !commitMsg.trim()}>
                            Commit {stagedCount ? `(${stagedCount})` : ''}
                          </button>
                        </form>
                        {diffLabel && (
                          <div className="code-diff-wrap">
                            <div className="code-diff-head">
                              <span className="truncate">{diffLabel}</span>
                              <button className="code-mini-btn" onClick={() => { setDiff(''); setDiffLabel('') }}>
                                <X size={10} />
                              </button>
                            </div>
                            <DiffView diff={diff} />
                          </div>
                        )}
                        <div className="code-log">
                          <p className="code-side-note">Recent commits</p>
                          {!gitLog.length && <p className="dim code-pad">No commits yet.</p>}
                          {gitLog.map((entry) => (
                            <div key={entry.hash} className="code-log-row" title={entry.subject}>
                              <span className="code-hash">{entry.hash}</span>
                              <span className="truncate">{entry.subject}</span>
                              <span className="code-log-meta">{entry.author} · {entry.date}</span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {tab === 'run' && (
                  <div className="code-panel-body">
                    <div className="code-scripts">
                      <p className="code-side-note">package.json scripts</p>
                      {!scripts.length && (
                        <p className="dim code-pad">No scripts found in the root package.json.</p>
                      )}
                      {scripts.map((script) => (
                        <div key={script.name} className="code-script">
                          <button className="code-script-name" onClick={() => void startScript(script.name)} disabled={runBusy}>
                            <Play size={11} /> {script.name}
                          </button>
                          <span className="code-script-cmd" title={script.command}>{script.command}</span>
                        </div>
                      ))}
                    </div>

                    <form className="code-terminal" onSubmit={(e) => void startTerminal(e)}>
                      <TerminalSquare size={12} />
                      <input
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        placeholder="Command in workspace root (danger guard active)"
                        aria-label="Terminal command"
                        spellCheck={false}
                      />
                      <button type="submit" disabled={runBusy || !command.trim()} className="code-mini-btn">
                        run
                      </button>
                    </form>

                    {runs.length > 0 && (
                      <div className="code-run-tabs">
                        {runs.map((run) => (
                          <button
                            key={run.runId}
                            className={`code-run-tab ${runId === run.runId ? 'active' : ''}`}
                            onClick={() => setRunId(run.runId)}
                            title={run.label}
                          >
                            <span className={`code-run-dot ${run.status}`} />
                            <span className="truncate">{run.label}</span>
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="code-console-head">
                      <span className="dim truncate">{activeRun ? activeRun.label : 'No command selected'}</span>
                      {activeRun && (
                        <span className={`code-run-state ${activeRun.status}`}>
                          {activeRun.status === 'running'
                            ? 'running'
                            : activeRun.status === 'stopped'
                              ? 'stopped'
                              : `exit ${activeRun.code ?? '?'}${activeRun.ms ? ` · ${(activeRun.ms / 1000).toFixed(1)}s` : ''}`}
                        </span>
                      )}
                      <div className="ml-auto flex items-center gap-1">
                        {activeRun?.status === 'running' && (
                          <button className="code-mini-btn danger" onClick={() => void stopRun()} title="Stop command">
                            <Square size={10} /> stop
                          </button>
                        )}
                        {activeRun && (
                          <button
                            className="code-mini-btn"
                            onClick={() =>
                              setRuns((prev) => prev.map((r) => (r.runId === activeRun.runId ? { ...r, output: '' } : r)))
                            }
                          >
                            clear
                          </button>
                        )}
                      </div>
                    </div>
                    <pre id="code-run-console" className="code-console">
                      {activeRun ? activeRun.output || '…' : 'Start a script or a command.'}
                    </pre>
                  </div>
                )}

                {tab === 'review' && (
                  <div className="code-panel-body">
                    <p className="dim code-pad">
                      Sends the current git diff to {active ? `${active.name} · ${active.model}` : 'your active provider'}.
                      Nothing leaves your machine unless a provider is configured.
                    </p>
                    <div className="code-review-actions">
                      <button className="btn-primary" onClick={() => void reviewDiff()} disabled={reviewing}>
                        {reviewing ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />} Review diff
                      </button>
                      {reviewing && (
                        <button className="btn-ghost" onClick={stopReview}>
                          <Square size={11} /> Stop
                        </button>
                      )}
                    </div>
                    <pre className="code-review">{review || 'No review yet.'}</pre>
                  </div>
                )}
              </aside>
            </div>
          </>
        )}
      </div>
    </PageShell>
  )
}
