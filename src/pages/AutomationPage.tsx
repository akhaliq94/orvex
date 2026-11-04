import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import ReactFlow, {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from 'reactflow'
import 'reactflow/dist/style.css'
import {
  AlertTriangle,
  Bell,
  Braces,
  CalendarClock,
  CheckCircle2,
  Clock3,
  GitBranch,
  History,
  LayoutTemplate,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Repeat,
  Save,
  ShieldCheck,
  Square,
  Timer,
  Trash2,
  Workflow,
  Wrench,
  X,
  XCircle,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import PageShell from './PageShell'
import type {
  IpcResult,
  OrvexWorkflow,
  OrvexWorkflowDraft,
  OrvexWorkflowEdge,
  OrvexWorkflowNode,
  OrvexWorkflowNodeConfig,
  OrvexWorkflowNodeType,
  OrvexWorkflowRun,
  OrvexWorkflowRunStatus,
  OrvexWorkflowState,
  OrvexWorkflowTemplate,
  OrvexWorkflowToolMeta,
} from '../types/desktop'
import './automation.css'

type Props = { onBack: () => void; notify: (msg: string) => void }

type Tab = 'workflows' | 'runs' | 'schedule' | 'templates'

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'workflows', label: 'Workflows', icon: Workflow },
  { id: 'runs', label: 'Runs', icon: History },
  { id: 'schedule', label: 'Schedule', icon: CalendarClock },
  { id: 'templates', label: 'Templates', icon: LayoutTemplate },
]

const NODE_META: Record<OrvexWorkflowNodeType, { label: string; icon: LucideIcon; accent: string; hint: string }> = {
  trigger: { label: 'Trigger', icon: Zap, accent: '#4fc3ff', hint: 'Starts the workflow manually or on a cron schedule.' },
  tool: { label: 'Tool', icon: Wrench, accent: '#7dd3fc', hint: 'Runs a real ORVEX tool with the arguments below.' },
  condition: { label: 'Condition', icon: GitBranch, accent: '#c084fc', hint: 'Branches on a comparison of two values.' },
  loop: { label: 'Loop', icon: Repeat, accent: '#38bdf8', hint: 'Repeats the body branch a number of times or once per line.' },
  delay: { label: 'Wait', icon: Timer, accent: '#94a3b8', hint: 'Pauses the run for a number of milliseconds.' },
  notify: { label: 'Notify', icon: Bell, accent: '#facc15', hint: 'Shows a real Windows notification.' },
  approval: { label: 'Approval', icon: ShieldCheck, accent: '#fb923c', hint: 'Stops the run until you approve or reject it.' },
  transform: { label: 'Set value', icon: Braces, accent: '#a3e635', hint: 'Renders a template and records it as this step’s output.' },
}

const NODE_ORDER: OrvexWorkflowNodeType[] = ['trigger', 'tool', 'condition', 'loop', 'delay', 'notify', 'approval', 'transform']

const EDGE_META: Record<OrvexWorkflowEdge['when'], { label: string; color: string }> = {
  next: { label: 'next', color: '#7f93ad' },
  true: { label: 'true', color: '#4ade80' },
  false: { label: 'false', color: '#ff7b7b' },
  body: { label: 'body', color: '#4fc3ff' },
  done: { label: 'done', color: '#fbbf24' },
}

const STATUS_META: Record<OrvexWorkflowRunStatus, { label: string; color: string }> = {
  queued: { label: 'Queued', color: '#fbbf24' },
  running: { label: 'Running', color: '#4fc3ff' },
  awaiting_approval: { label: 'Needs approval', color: '#fb923c' },
  succeeded: { label: 'Succeeded', color: '#4ade80' },
  failed: { label: 'Failed', color: '#ff7b7b' },
  cancelled: { label: 'Cancelled', color: '#94a3b8' },
  interrupted: { label: 'Interrupted', color: '#c084fc' },
}

const OPERATORS = [
  { id: 'truthy', label: 'is not empty' },
  { id: 'falsy', label: 'is empty' },
  { id: 'equals', label: 'equals' },
  { id: 'notEquals', label: 'does not equal' },
  { id: 'contains', label: 'contains' },
  { id: 'notContains', label: 'does not contain' },
  { id: 'startsWith', label: 'starts with' },
  { id: 'endsWith', label: 'ends with' },
  { id: 'matches', label: 'matches regex' },
  { id: 'gt', label: 'greater than' },
  { id: 'gte', label: 'greater or equal' },
  { id: 'lt', label: 'less than' },
  { id: 'lte', label: 'less or equal' },
]

const bridge = typeof window !== 'undefined' ? window.orvex : undefined

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

function truncate(text: string, max: number) {
  const s = String(text || '').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function fmtTime(ms: number | null | undefined) {
  if (!ms) return '—'
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function ago(ms: number | null | undefined) {
  if (!ms) return '—'
  const diff = Date.now() - ms
  if (diff < 0) {
    const ahead = -diff
    if (ahead < 60000) return `in ${Math.max(1, Math.round(ahead / 1000))}s`
    if (ahead < 3600000) return `in ${Math.round(ahead / 60000)}m`
    if (ahead < 86400000) return `in ${Math.round(ahead / 3600000)}h`
    return `in ${Math.round(ahead / 86400000)}d`
  }
  if (diff < 60000) return `${Math.max(1, Math.round(diff / 1000))}s ago`
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`
  return `${Math.round(diff / 86400000)}d ago`
}

function fmtMs(ms: number) {
  const n = Number(ms) || 0
  if (n < 1000) return `${Math.round(n)} ms`
  if (n < 60000) return `${(n / 1000).toFixed(1)} s`
  return `${Math.floor(n / 60000)}m ${Math.round((n % 60000) / 1000)}s`
}

function runDuration(run: { startedAt: number | null; endedAt: number | null }) {
  if (!run.startedAt) return '—'
  return fmtMs((run.endedAt || Date.now()) - run.startedAt)
}

function defaultConfig(type: OrvexWorkflowNodeType): OrvexWorkflowNodeConfig {
  switch (type) {
    case 'trigger':
      return { type: 'manual' }
    case 'tool':
      return { tool: '', args: {}, retry: { attempts: 1, delayMs: 1000 }, onError: 'stop' }
    case 'condition':
      return { left: '', operator: 'contains', right: '' }
    case 'loop':
      return { mode: 'count', count: 3, itemVar: 'item' }
    case 'delay':
      return { ms: 1000 }
    case 'notify':
      return { title: 'ORVEX workflow', message: '' }
    case 'approval':
      return { title: 'Approval needed', message: 'Continue with this workflow?' }
    case 'transform':
      return { template: '' }
    default:
      return {}
  }
}

function summaryOf(node: OrvexWorkflowNode) {
  const c = node.config
  switch (node.type) {
    case 'trigger':
      return c.type === 'schedule' ? `cron ${c.cron || '—'}` : 'manual start'
    case 'tool':
      return c.tool ? `${c.tool}` : 'pick a tool'
    case 'condition':
      return `${c.operator || 'contains'}${c.right ? ` “${truncate(c.right, 18)}”` : ''}`
    case 'loop':
      return c.mode === 'lines' ? 'each line' : `${c.count ?? 0}× body`
    case 'delay':
      return `${c.ms ?? 0} ms`
    case 'notify':
    case 'approval':
      return truncate(c.title || '', 24) || '—'
    case 'transform':
      return truncate(c.template || '', 24) || 'empty template'
    default:
      return ''
  }
}

function cloneNode(node: OrvexWorkflowNode): OrvexWorkflowNode {
  return {
    ...node,
    position: { ...node.position },
    config: {
      ...node.config,
      args: node.config.args ? JSON.parse(JSON.stringify(node.config.args)) : {},
      retry: node.config.retry ? { ...node.config.retry } : undefined,
    },
  }
}

function freshId(prefix: string, taken: { id: string }[]) {
  let id = ''
  do {
    id = `${prefix}_${Math.random().toString(36).slice(2, 7)}`
  } while (taken.some((x) => x.id === id))
  return id
}

function freshEdgeId(taken: { id: string }[]) {
  let id = ''
  do {
    id = `e_${Math.random().toString(36).slice(2, 8)}`
  } while (taken.some((x) => x.id === id))
  return id
}

type WfNodeData = { node: OrvexWorkflowNode; summary: string; selected: boolean }

function WfNodeView({ data }: NodeProps<WfNodeData>) {
  const meta = NODE_META[data.node.type]
  const Icon = meta.icon
  const condition = data.node.type === 'condition'
  const loop = data.node.type === 'loop'
  return (
    <div
      className={`wf-node ${data.selected ? 'selected' : ''}`}
      data-type={data.node.type}
      style={{ '--wf-accent': meta.accent } as CSSProperties}
    >
      <Handle type="target" position={Position.Top} id="in" className="wf-handle" />
      <div className="wf-node-top">
        <span className="wf-node-icon">
          <Icon size={12} />
        </span>
        <span className="wf-node-label">{data.node.label}</span>
        <span className="wf-node-type">{meta.label}</span>
      </div>
      <div className="wf-node-sub">{data.summary}</div>
      {condition && (
        <>
          <Handle type="source" position={Position.Bottom} id="true" className="wf-handle wf-handle-true" style={{ left: '30%' }} />
          <Handle type="source" position={Position.Bottom} id="false" className="wf-handle wf-handle-false" style={{ left: '70%' }} />
        </>
      )}
      {loop && (
        <>
          <Handle type="source" position={Position.Bottom} id="body" className="wf-handle wf-handle-body" style={{ left: '30%' }} />
          <Handle type="source" position={Position.Bottom} id="done" className="wf-handle wf-handle-done" style={{ left: '70%' }} />
        </>
      )}
      {!condition && !loop && <Handle type="source" position={Position.Bottom} id="next" className="wf-handle" />}
    </div>
  )
}

const nodeTypes = { wf: WfNodeView }

function StatusChip({ status }: { status: OrvexWorkflowRunStatus }) {
  const meta = STATUS_META[status] || STATUS_META.queued
  return (
    <span className="wf-chip" data-status={status} style={{ color: meta.color, borderColor: `${meta.color}55`, background: `${meta.color}14` }}>
      {status === 'running' ? <Loader2 size={9} className="wf-spin" /> : <span className="wf-chip-dot" style={{ background: meta.color }} />}
      {meta.label}
    </span>
  )
}

export default function AutomationPage({ onBack, notify }: Props) {
  const [tab, setTab] = useState<Tab>('workflows')
  const [state, setState] = useState<OrvexWorkflowState | null>(null)
  const [tools, setTools] = useState<OrvexWorkflowToolMeta[]>([])
  const [templates, setTemplates] = useState<OrvexWorkflowTemplate[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [draft, setDraft] = useState<OrvexWorkflowDraft | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [argsText, setArgsText] = useState('{}')
  const [argsError, setArgsError] = useState<string | null>(null)
  const [cronPreview, setCronPreview] = useState<{ expr: string; text: string; ok: boolean } | null>(null)

  const [detail, setDetail] = useState<OrvexWorkflowRun | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [cronExpr, setCronExpr] = useState('*/15 * * * *')
  const [cronRuns, setCronRuns] = useState<string[]>([])
  const [cronError, setCronError] = useState<string | null>(null)

  const loadAll = useCallback(async (quiet = false) => {
    if (!bridge?.workflows) return
    if (!quiet) setBusy('load')
    try {
      const data = await required(bridge.workflows.list())
      setState(data)
    } catch (err) {
      if (!quiet) setError(messageOf(err))
    } finally {
      if (!quiet) setBusy(null)
    }
  }, [])

  useEffect(() => {
    if (!bridge?.workflows) return
    void loadAll()
    void required(bridge.workflows.tools())
      .then((data) => setTools(data.tools))
      .catch((err) => setError(messageOf(err)))
    void required(bridge.workflows.templates())
      .then((data) => setTemplates(data.templates))
      .catch((err) => setError(messageOf(err)))
  }, [loadAll])

  useEffect(() => {
    if (!bridge?.workflows) return
    const off = bridge.workflows.onChange(() => void loadAll(true))
    const timer = window.setInterval(() => void loadAll(true), 4000)
    return () => {
      off()
      window.clearInterval(timer)
    }
  }, [loadAll])

  const openRun = useCallback(async (id: string, quiet = false) => {
    if (!bridge?.workflows) return
    if (!quiet) setDetailBusy(true)
    try {
      const data = await required(bridge.workflows.runDetail(id))
      setDetail(data)
    } catch (err) {
      if (!quiet) setError(messageOf(err))
    } finally {
      if (!quiet) setDetailBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!detail || !['queued', 'running', 'awaiting_approval'].includes(detail.status)) return
    const timer = window.setInterval(() => void openRun(detail.id, true), 2000)
    return () => window.clearInterval(timer)
  }, [detail, openRun])

  const selectedNode = draft?.nodes.find((n) => n.id === selectedNodeId) || null
  const selectedEdge = draft?.edges.find((e) => e.id === selectedEdgeId) || null
  // Measured node sizes live here so every draft edit keeps the edges valid;
  // dropping them makes reactflow re-measure and briefly hides connections.
  const measured = useRef(new Map<string, { width: number; height: number }>())

  useEffect(() => {
    const node = draft?.nodes.find((n) => n.id === selectedNodeId)
    if (node?.type === 'tool') {
      setArgsText(JSON.stringify(node.config.args || {}, null, 2))
      setArgsError(null)
    }
  }, [selectedNodeId, draft?.id])

  const cronExprForNode = selectedNode?.type === 'trigger' && selectedNode.config.type === 'schedule' ? String(selectedNode.config.cron || '') : ''

  useEffect(() => {
    if (!bridge?.workflows || !cronExprForNode) {
      setCronPreview(null)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(async () => {
      try {
        const data = await required(bridge.workflows!.cron(cronExprForNode))
        if (!cancelled) setCronPreview({ expr: cronExprForNode, text: fmtTime(data.nextAt), ok: true })
      } catch (err) {
        if (!cancelled) setCronPreview({ expr: cronExprForNode, text: messageOf(err), ok: false })
      }
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [cronExprForNode])

  const openEditor = (wf: OrvexWorkflow) => {
    measured.current.clear()
    setDraft({
      id: wf.id,
      name: wf.name,
      description: wf.description,
      enabled: wf.enabled,
      nodes: wf.nodes.map(cloneNode),
      edges: wf.edges.map((e) => ({ ...e })),
    })
    setSelectedNodeId(wf.nodes.find((n) => n.type === 'trigger')?.id || wf.nodes[0]?.id || null)
    setSelectedEdgeId(null)
    setArgsError(null)
    setCronPreview(null)
    setError(null)
  }

  const newWorkflow = () => {
    measured.current.clear()
    setDraft({
      name: '',
      description: '',
      enabled: true,
      nodes: [{ id: 'trigger', type: 'trigger', label: 'Run manually', position: { x: 120, y: 60 }, config: { type: 'manual' } }],
      edges: [],
    })
    setSelectedNodeId('trigger')
    setSelectedEdgeId(null)
    setArgsError(null)
    setCronPreview(null)
    setError(null)
  }

  const patchNode = (id: string, patch: Partial<Omit<OrvexWorkflowNode, 'config'>> & { config?: Partial<OrvexWorkflowNodeConfig> }) => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            nodes: prev.nodes.map((n) =>
              n.id === id ? { ...n, ...patch, config: patch.config ? { ...n.config, ...patch.config } : n.config } : n,
            ),
          }
        : prev,
    )
  }

  const patchRetry = (id: string, patch: Partial<{ attempts: number; delayMs: number }>) => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            nodes: prev.nodes.map((n) =>
              n.id === id
                ? { ...n, config: { ...n.config, retry: { attempts: 1, delayMs: 1000, ...(n.config.retry || {}), ...patch } } }
                : n,
            ),
          }
        : prev,
    )
  }

  const addNode = (type: OrvexWorkflowNodeType) => {
    if (!draft) return
    if (type === 'trigger' && draft.nodes.some((n) => n.type === 'trigger')) {
      setError('A workflow can only have one trigger node.')
      return
    }
    const id = freshId(type, draft.nodes)
    const source = type === 'trigger' ? null : draft.nodes.find((n) => n.id === selectedNodeId) || null
    const position = source
      ? { x: source.position.x + (draft.nodes.length % 2 === 0 ? -40 : 40), y: source.position.y + 150 }
      : { x: 120 + draft.nodes.length * 18, y: 60 + draft.nodes.length * 18 }
    let when: OrvexWorkflowEdge['when'] = 'next'
    if (source?.type === 'condition') {
      when = draft.edges.some((e) => e.source === source.id && e.when === 'true') ? 'false' : 'true'
    } else if (source?.type === 'loop') {
      when = draft.edges.some((e) => e.source === source.id && e.when === 'body') ? 'done' : 'body'
    }
    const edges = source ? [...draft.edges, { id: freshEdgeId(draft.edges), source: source.id, target: id, when }] : draft.edges
    setDraft({
      ...draft,
      nodes: [...draft.nodes, { id, type, label: NODE_META[type].label, position, config: defaultConfig(type) }],
      edges,
    })
    setSelectedNodeId(id)
    setSelectedEdgeId(null)
  }

  const deleteNode = (id: string) => {
    measured.current.delete(id)
    setDraft((prev) =>
      prev ? { ...prev, nodes: prev.nodes.filter((n) => n.id !== id), edges: prev.edges.filter((e) => e.source !== id && e.target !== id) } : prev,
    )
    if (selectedNodeId === id) setSelectedNodeId(null)
  }

  const deleteEdge = (id: string) => {
    setDraft((prev) => (prev ? { ...prev, edges: prev.edges.filter((e) => e.id !== id) } : prev))
    if (selectedEdgeId === id) setSelectedEdgeId(null)
  }

  const setEdgeWhen = (id: string, when: OrvexWorkflowEdge['when']) => {
    setDraft((prev) => (prev ? { ...prev, edges: prev.edges.map((e) => (e.id === id ? { ...e, when } : e)) } : prev))
  }

  const onNodesChange = (changes: NodeChange[]) => {
    const removed = new Set<string>()
    const moves = new Map<string, { x: number; y: number }>()
    for (const change of changes) {
      if (change.type === 'dimensions' && change.dimensions) {
        measured.current.set(change.id, { width: change.dimensions.width, height: change.dimensions.height })
      } else if (change.type === 'position' && change.position) {
        moves.set(change.id, change.position)
      } else if (change.type === 'remove') {
        removed.add(change.id)
        measured.current.delete(change.id)
      }
    }
    if (!removed.size && !moves.size) return
    setDraft((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        nodes: prev.nodes
          .filter((n) => !removed.has(n.id))
          .map((n) => {
            const position = moves.get(n.id)
            return position ? { ...n, position } : n
          }),
        edges: prev.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target)),
      }
    })
    if (selectedNodeId && removed.has(selectedNodeId)) setSelectedNodeId(null)
  }

  const onEdgesChange = (changes: EdgeChange[]) => {
    const removed = new Set<string>()
    for (const change of changes) if (change.type === 'remove') removed.add(change.id)
    if (!removed.size) return
    setDraft((prev) => (prev ? { ...prev, edges: prev.edges.filter((e) => !removed.has(e.id)) } : prev))
    if (selectedEdgeId && removed.has(selectedEdgeId)) setSelectedEdgeId(null)
  }

  const onConnect = (connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return
    const when = (connection.sourceHandle || 'next') as OrvexWorkflowEdge['when']
    if (!EDGE_META[when]) return
    setDraft((prev) => {
      if (!prev) return prev
      if (prev.edges.some((e) => e.source === connection.source && e.target === connection.target && e.when === when)) return prev
      return {
        ...prev,
        edges: [...prev.edges, { id: freshEdgeId(prev.edges), source: connection.source!, target: connection.target!, when }],
      }
    })
  }

  const persistDraft = async (): Promise<OrvexWorkflow | null> => {
    if (!draft || !bridge?.workflows) return null
    if (argsError) {
      setError('Fix the JSON arguments in the tool inspector before saving.')
      return null
    }
    setBusy('save')
    setError(null)
    try {
      const saved = await required(
        bridge.workflows.save({
          id: draft.id,
          name: draft.name.trim(),
          description: draft.description || '',
          enabled: draft.enabled,
          nodes: draft.nodes,
          edges: draft.edges,
        }),
      )
      await loadAll()
      return saved
    } catch (err) {
      setError(messageOf(err))
      return null
    } finally {
      setBusy(null)
    }
  }

  const saveAndClose = async () => {
    const saved = await persistDraft()
    if (!saved) return
    setDraft(null)
    notify(`Saved “${saved.name}”.`)
  }

  const saveAndRun = async () => {
    const saved = await persistDraft()
    if (!saved) return
    setDraft(null)
    await runWorkflow(saved.id)
  }

  const runWorkflow = async (id: string) => {
    if (!bridge?.workflows) return
    setBusy(`run:${id}`)
    setError(null)
    try {
      const run = await required(bridge.workflows.run(id))
      notify(`Queued “${run.workflowName}” as ${run.id}.`)
      setTab('runs')
      await loadAll()
      await openRun(run.id)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const toggleWorkflow = async (wf: OrvexWorkflow) => {
    if (!bridge?.workflows) return
    try {
      const next = await required(bridge.workflows.setEnabled(wf.id, !wf.enabled))
      notify(`“${next.name}” is now ${next.enabled ? 'enabled' : 'paused'}.`)
      await loadAll()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const removeWorkflow = async (wf: { id: string; name: string }) => {
    if (!bridge?.workflows) return
    if (!window.confirm(`Delete “${wf.name}” and cancel its active runs?`)) return
    setBusy(`delete:${wf.id}`)
    try {
      await required(bridge.workflows.remove(wf.id))
      if (draft?.id === wf.id) setDraft(null)
      await loadAll()
      notify('Workflow deleted.')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const runAction = async (kind: 'approve' | 'reject' | 'cancel' | 'resume', runId: string) => {
    if (!bridge?.workflows) return
    setBusy(`${kind}:${runId}`)
    setError(null)
    try {
      if (kind === 'approve') await required(bridge.workflows.approve(runId, true))
      else if (kind === 'reject') await required(bridge.workflows.approve(runId, false))
      else if (kind === 'cancel') await required(bridge.workflows.cancel(runId))
      else await required(bridge.workflows.resume(runId))
      notify(
        kind === 'approve'
          ? 'Approved — the run continues.'
          : kind === 'reject'
            ? 'Rejected — the run stopped.'
            : kind === 'cancel'
              ? 'Run cancelled.'
              : 'Run resumed.',
      )
      await loadAll()
      await openRun(runId, true)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const useTemplate = async (template: OrvexWorkflowTemplate) => {
    if (!bridge?.workflows) return
    setBusy(`template:${template.id}`)
    setError(null)
    try {
      const wf = await required(bridge.workflows.fromTemplate(template.id))
      await loadAll()
      openEditor(wf)
      setTab('workflows')
      notify(`Created “${wf.name}” from the template. Review the nodes, then save or run.`)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const clearHistory = async () => {
    if (!bridge?.workflows) return
    if (!window.confirm('Remove every finished run from the history? Active runs are kept.')) return
    setBusy('clear')
    setError(null)
    try {
      const result = await required(bridge.workflows.clearRuns())
      setDetail(null)
      await loadAll()
      notify(`Cleared ${result.removed} finished run(s).`)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const previewCron = async () => {    if (!bridge?.workflows) return
    setCronError(null)
    setBusy('cron')
    try {
      const out: string[] = []
      let from = Date.now()
      for (let i = 0; i < 5; i += 1) {
        const data = await required(bridge.workflows.cron(cronExpr.trim(), from))
        out.push(fmtTime(data.nextAt))
        from = data.nextAt
      }
      setCronRuns(out)
    } catch (err) {
      setCronRuns([])
      setCronError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const stats = state?.stats
  const runs = state?.runs || []
  const workflows = state?.workflows || []
  const hasTrigger = !!draft?.nodes.some((n) => n.type === 'trigger')
  const toolMeta = selectedNode?.type === 'tool' ? tools.find((t) => t.name === selectedNode.config.tool) : null

  const rfNodes = useMemo<Node<WfNodeData>[]>(
    () =>
      (draft?.nodes || []).map((n) => {
        const size = measured.current.get(n.id)
        return {
          id: n.id,
          type: 'wf',
          position: n.position,
          data: { node: n, summary: summaryOf(n), selected: n.id === selectedNodeId },
          ...(size ? { width: size.width, height: size.height } : {}),
        }
      }),
    [draft?.nodes, selectedNodeId],
  )

  const rfEdges = useMemo<Edge[]>(
    () =>
      (draft?.edges || []).map((e) => {
        const meta = EDGE_META[e.when]
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.when,
          targetHandle: 'in',
          type: 'smoothstep',
          label: meta.label,
          labelStyle: { fill: meta.color, fontSize: 8, fontFamily: 'ui-monospace, Consolas, monospace' },
          labelBgStyle: { fill: 'rgba(8,16,28,0.9)', fillOpacity: 0.9 },
          labelBgPadding: [4, 2] as [number, number],
          labelBgBorderRadius: 4,
          markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: meta.color },
          style: { stroke: meta.color, strokeWidth: e.id === selectedEdgeId ? 2 : 1.3, opacity: e.id === selectedEdgeId ? 1 : 0.72 },
        }
      }),
    [draft?.edges, selectedEdgeId],
  )

  const renderInspector = () => {
    if (selectedEdge) {
      const edge = selectedEdge
      const source = draft?.nodes.find((n) => n.id === edge.source)
      const target = draft?.nodes.find((n) => n.id === edge.target)
      const options: { id: OrvexWorkflowEdge['when']; label: string }[] =
        source?.type === 'condition'
          ? [
              { id: 'true', label: 'true branch' },
              { id: 'false', label: 'false branch' },
            ]
          : source?.type === 'loop'
            ? [
                { id: 'body', label: 'body (each iteration)' },
                { id: 'done', label: 'done (after the loop)' },
              ]
            : [{ id: 'next', label: 'next' }]
      return (
        <>
          <div className="wf-side-head">
            <strong>Connection</strong>
            <button className="ig-icon-btn" onClick={() => deleteEdge(edge.id)} title="Delete connection" aria-label="Delete connection">
              <Trash2 size={12} />
            </button>
          </div>
          <p className="wf-hint">
            {source?.label || edge.source} → {target?.label || edge.target}
          </p>
          <label className="wf-field">
            <span>Follow this branch</span>
            <select value={edge.when} onChange={(e) => setEdgeWhen(edge.id, e.target.value as OrvexWorkflowEdge['when'])}>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <p className="wf-hint">Selection is saved with the workflow. Delete the connection to stop this branch.</p>
        </>
      )
    }
    if (!selectedNode) {
      return <p className="wf-hint">Select a node to edit it, or a connection to change its branch label.</p>
    }
    const node = selectedNode
    const setConfig = (config: Partial<OrvexWorkflowNodeConfig>) => patchNode(node.id, { config })
    return (
      <>
        <div className="wf-side-head">
          <strong>{NODE_META[node.type].label}</strong>
          <button className="ig-icon-btn" onClick={() => deleteNode(node.id)} title="Delete node" aria-label="Delete node">
            <Trash2 size={12} />
          </button>
        </div>
        <p className="wf-hint">{NODE_META[node.type].hint}</p>
        <label className="wf-field">
          <span>Label</span>
          <input value={node.label} onChange={(e) => patchNode(node.id, { label: e.target.value })} />
        </label>

        {node.type === 'trigger' && (
          <>
            <label className="wf-field">
              <span>Start</span>
              <select
                value={node.config.type || 'manual'}
                onChange={(e) =>
                  setConfig({
                    type: e.target.value as 'manual' | 'schedule',
                    ...(e.target.value === 'schedule' && !node.config.cron ? { cron: '0 9 * * *' } : {}),
                  })
                }
              >
                <option value="manual">Manually, from this page or the agent</option>
                <option value="schedule">On a cron schedule</option>
              </select>
            </label>
            {node.config.type === 'schedule' && (
              <>
                <label className="wf-field">
                  <span>Cron (minute hour day month weekday)</span>
                  <input
                    className="wf-mono"
                    value={node.config.cron || ''}
                    onChange={(e) => setConfig({ cron: e.target.value })}
                    placeholder="0 9 * * *"
                  />
                </label>
                <p className={`wf-hint ${cronPreview && !cronPreview.ok ? 'wf-hint-bad' : ''}`}>
                  {!cronPreview ? 'Checking the schedule…' : cronPreview.expr === (node.config.cron || '') ? (cronPreview.ok ? `Next run ${cronPreview.text}` : cronPreview.text) : 'Checking the schedule…'}
                </p>
              </>
            )}
          </>
        )}

        {node.type === 'tool' && (
          <>
            <label className="wf-field">
              <span>Tool</span>
              <select value={node.config.tool || ''} onChange={(e) => setConfig({ tool: e.target.value })}>
                <option value="">Pick a tool…</option>
                {tools.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            {toolMeta && <p className="wf-hint">{truncate(toolMeta.description, 180)}</p>}
            <label className="wf-field">
              <span>Arguments (JSON object, supports {'{{input.x}}'} and {'{{steps.id.output}}'})</span>
              <textarea className="wf-mono" value={argsText} spellCheck={false} onChange={(e) => {
                const text = e.target.value
                setArgsText(text)
                try {
                  const parsed = text.trim() ? JSON.parse(text) : {}
                  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Arguments must be a JSON object.')
                  setArgsError(null)
                  setConfig({ args: parsed as Record<string, unknown> })
                } catch (err) {
                  setArgsError(messageOf(err))
                }
              }} />
            </label>
            {argsError && <p className="wf-hint wf-hint-bad">{argsError}</p>}
            <div className="wf-inline">
              <label className="wf-field wf-grow">
                <span>Attempts</span>
                <input type="number" min={1} max={5} value={node.config.retry?.attempts ?? 1} onChange={(e) => patchRetry(node.id, { attempts: Number(e.target.value) })} />
              </label>
              <label className="wf-field wf-grow">
                <span>Retry delay (ms)</span>
                <input type="number" min={0} max={60000} value={node.config.retry?.delayMs ?? 1000} onChange={(e) => patchRetry(node.id, { delayMs: Number(e.target.value) })} />
              </label>
            </div>
            <label className="wf-field">
              <span>When the tool fails</span>
              <select value={node.config.onError || 'stop'} onChange={(e) => setConfig({ onError: e.target.value as 'stop' | 'continue' })}>
                <option value="stop">Stop the run</option>
                <option value="continue">Continue to the next node</option>
              </select>
            </label>
          </>
        )}

        {node.type === 'condition' && (
          <>
            <label className="wf-field">
              <span>Left value</span>
              <input className="wf-mono" value={node.config.left || ''} onChange={(e) => setConfig({ left: e.target.value })} placeholder="{{steps.fetch.output}}" />
            </label>
            <label className="wf-field">
              <span>Operator</span>
              <select value={node.config.operator || 'truthy'} onChange={(e) => setConfig({ operator: e.target.value })}>
                {OPERATORS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="wf-field">
              <span>Right value</span>
              <input value={node.config.right || ''} onChange={(e) => setConfig({ right: e.target.value })} placeholder="200" />
            </label>
            <p className="wf-hint">Both sides are rendered with {'{{…}}'} placeholders first, then compared.</p>
          </>
        )}

        {node.type === 'loop' && (
          <>
            <label className="wf-field">
              <span>Repeat</span>
              <select value={node.config.mode || 'count'} onChange={(e) => setConfig({ mode: e.target.value as 'count' | 'lines' })}>
                <option value="count">A fixed number of times</option>
                <option value="lines">Once per line of some text</option>
              </select>
            </label>
            {node.config.mode === 'lines' ? (
              <label className="wf-field">
                <span>Text to split (one item per line)</span>
                <textarea className="wf-mono" value={node.config.source || ''} onChange={(e) => setConfig({ source: e.target.value })} placeholder="{{steps.fetch.output}}" />
              </label>
            ) : (
              <label className="wf-field">
                <span>Iterations (1-50)</span>
                <input type="number" min={0} max={50} value={node.config.count ?? 3} onChange={(e) => setConfig({ count: Number(e.target.value) })} />
              </label>
            )}
            <label className="wf-field">
              <span>Item variable</span>
              <input value={node.config.itemVar || 'item'} onChange={(e) => setConfig({ itemVar: e.target.value })} />
            </label>
            <p className="wf-hint">
              Inside the body use {'{{loop.n}}'}, {'{{loop.total}}'}, {'{{loop.item}}'}. The body edge comes back to this node for the next iteration.
            </p>
          </>
        )}

        {node.type === 'delay' && (
          <label className="wf-field">
            <span>Pause (milliseconds, max 300000)</span>
            <input type="number" min={0} max={300000} step={100} value={node.config.ms ?? 1000} onChange={(e) => setConfig({ ms: Number(e.target.value) })} />
          </label>
        )}

        {(node.type === 'notify' || node.type === 'approval') && (
          <>
            <label className="wf-field">
              <span>Title</span>
              <input value={node.config.title || ''} onChange={(e) => setConfig({ title: e.target.value })} />
            </label>
            <label className="wf-field">
              <span>Message</span>
              <textarea value={node.config.message || ''} onChange={(e) => setConfig({ message: e.target.value })} />
            </label>
            <p className="wf-hint">
              {node.type === 'notify'
                ? 'Delivered as a real Windows notification by the desktop app.'
                : 'The run pauses here until you approve or reject it on the Runs tab.'}
            </p>
          </>
        )}

        {node.type === 'transform' && (
          <>
            <label className="wf-field">
              <span>Template</span>
              <textarea className="wf-mono" value={node.config.template || ''} onChange={(e) => setConfig({ template: e.target.value })} placeholder="Result: {{steps.fetch.output}}" />
            </label>
            <p className="wf-hint">
              The rendered text becomes this step’s output, available to later nodes as {'{{steps.'}
              {node.id}
              {'.output}}'}.
            </p>
          </>
        )}

        <p className="wf-hint wf-mono">node id {node.id}</p>
      </>
    )
  }

  return (
    <PageShell
      title="Automation"
      sub="Real cron-scheduled workflows, queued runs, approvals, retries and resumable history — every step runs a real ORVEX tool"
      onBack={onBack}
      actions={
        <>
          <button className="btn-ghost dc-btn wf-head-btn" onClick={() => void loadAll()} disabled={!!busy} title="Reload workflows and runs">
            {busy === 'load' ? <Loader2 size={12} className="wf-spin" /> : <RefreshCw size={12} />} Refresh
          </button>
          {tab === 'workflows' && !draft && (
            <button className="btn-primary dc-btn wf-head-btn" onClick={newWorkflow}>
              <Plus size={12} /> New workflow
            </button>
          )}
        </>
      }
    >
      <div className="wf-page">
        <div className="dc-tabs">
          {TABS.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.id}
                className={`dc-tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => {
                  setTab(t.id)
                }}
              >
                <Icon size={13} /> {t.label}
              </button>
            )
          })}
        </div>

        {error && (
          <div className="dc-error">
            <AlertTriangle size={13} />
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss error">
              <X size={12} />
            </button>
          </div>
        )}

        {!bridge?.workflows && <div className="dc-note">Open ORVEX as the desktop app to build and run workflows.</div>}

        {tab === 'workflows' && !draft && (
          <div className="wf-list-area">
            <div className="wf-stats">
              <div className="wf-stat">
                <b>{stats?.workflows ?? 0}</b>
                <span>Workflows</span>
              </div>
              <div className="wf-stat">
                <b>{stats?.enabled ?? 0}</b>
                <span>Enabled</span>
              </div>
              <div className="wf-stat">
                <b>{stats?.scheduled ?? 0}</b>
                <span>Scheduled</span>
              </div>
              <div className="wf-stat">
                <b>{stats?.running ?? 0}</b>
                <span>Running</span>
              </div>
              <div className="wf-stat">
                <b>{stats?.queued ?? 0}</b>
                <span>Queued</span>
              </div>
              <div className="wf-stat">
                <b>{stats?.awaiting ?? 0}</b>
                <span>Approvals</span>
              </div>
              <div className="wf-stat">
                <b>{stats?.failed ?? 0}</b>
                <span>Failed runs</span>
              </div>
            </div>

            <div className="dc-toolbar">
              <span className="dc-muted">{workflows.length ? `${workflows.length} workflow(s) · ${state?.concurrency ?? 2} run slots` : 'No workflows yet'}</span>
            </div>

            {!workflows.length && !busy && (
              <div className="wf-empty panel">
                <Workflow size={22} />
                <strong>No workflows yet</strong>
                <p>Build one from a blank trigger, or start with a working template that schedules a real tool.</p>
                <div className="wf-inline">
                  <button className="btn-primary dc-btn" onClick={newWorkflow}>
                    <Plus size={12} /> New workflow
                  </button>
                  <button className="btn-ghost dc-btn" onClick={() => setTab('templates')}>
                    <LayoutTemplate size={12} /> Browse templates
                  </button>
                </div>
              </div>
            )}

            <div className="wf-list">
              {workflows.map((wf) => (
                <div
                  key={wf.id}
                  className={`wf-row ${wf.enabled ? '' : 'off'}`}
                  onClick={() => openEditor(wf)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') openEditor(wf)
                  }}
                >
                  <span className="wf-row-icon" data-kind={wf.trigger.type}>
                    {wf.trigger.type === 'schedule' ? <CalendarClock size={14} /> : <Zap size={14} />}
                  </span>
                  <div className="wf-row-main">
                    <div className="wf-row-name">
                      {wf.name}
                      {wf.trigger.type === 'schedule' && <span className="wf-tag">cron {wf.trigger.cron}</span>}
                      {!wf.enabled && <span className="wf-tag off">paused</span>}
                    </div>
                    <div className="wf-row-sub">
                      <span>{wf.trigger.type === 'schedule' ? (wf.enabled ? `Next ${wf.nextRunAt ? fmtTime(wf.nextRunAt) : '—'}` : 'Schedule paused') : 'Manual start'}</span>
                      <span>
                        {wf.nodes.length} node(s) · {wf.edges.length} link(s)
                      </span>
                      {wf.lastRun && (
                        <span>
                          Last run {wf.lastRun.status.replace('_', ' ')} · {ago(wf.lastRun.queuedAt)}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    className="page-tool-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      void runWorkflow(wf.id)
                    }}
                    disabled={!!busy}
                    title="Run now"
                    aria-label={`Run ${wf.name} now`}
                  >
                    {busy === `run:${wf.id}` ? <Loader2 size={12} className="wf-spin" /> : <Play size={12} />}
                  </button>
                  <button
                    className="switch"
                    data-on={wf.enabled}
                    onClick={(e) => {
                      e.stopPropagation()
                      void toggleWorkflow(wf)
                    }}
                    aria-pressed={wf.enabled}
                    aria-label={`Toggle ${wf.name}`}
                    title={wf.enabled ? 'Pause this workflow' : 'Enable this workflow'}
                  >
                    <span className="switch-knob" />
                  </button>
                  <button
                    className="page-tool-btn danger"
                    onClick={(e) => {
                      e.stopPropagation()
                      void removeWorkflow(wf)
                    }}
                    disabled={!!busy}
                    title="Delete workflow"
                    aria-label={`Delete ${wf.name}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'workflows' && draft && (
          <div className="wf-editor">
            <div className="wf-editor-head">
              <input className="wf-input wf-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Workflow name" aria-label="Workflow name" />
              <input className="wf-input wf-desc" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="What this workflow does" aria-label="Workflow description" />
              <span className="wf-enable">
                <span>Enabled</span>
                <button className="switch" data-on={draft.enabled} onClick={() => setDraft({ ...draft, enabled: !draft.enabled })} aria-pressed={draft.enabled} aria-label="Enable workflow">
                  <span className="switch-knob" />
                </button>
              </span>
              <button className="btn-primary dc-btn" onClick={() => void saveAndClose()} disabled={busy === 'save'}>
                {busy === 'save' ? <Loader2 size={12} className="wf-spin" /> : <Save size={12} />} Save
              </button>
              <button className="btn-ghost dc-btn" onClick={() => void saveAndRun()} disabled={busy === 'save'}>
                <Play size={12} /> Save & run
              </button>
              <button className="btn-ghost dc-btn" onClick={() => setDraft(null)}>
                <X size={12} /> Close
              </button>
              {draft.id && (
                <button className="btn-ghost dc-btn wf-danger" onClick={() => void removeWorkflow({ id: draft.id!, name: draft.name || draft.id! })}>
                  <Trash2 size={12} /> Delete
                </button>
              )}
            </div>

            <div className="wf-palette">
              <span className="dc-muted">Add node</span>
              {NODE_ORDER.map((type) => {
                const meta = NODE_META[type]
                const Icon = meta.icon
                return (
                  <button
                    key={type}
                    className="wf-add"
                    onClick={() => addNode(type)}
                    disabled={type === 'trigger' && hasTrigger}
                    title={type === 'trigger' && hasTrigger ? 'A workflow already has its trigger' : `${meta.label} — ${meta.hint}`}
                  >
                    <Icon size={11} /> {meta.label}
                  </button>
                )
              })}
              <span className="wf-hint wf-palette-hint">
                A new node connects to the selected node. Drag between handles to link nodes, click a connection to label its branch, and press Delete to remove the selection.
              </span>
            </div>

            <div className="wf-builder">
              <div className="wf-canvas">
                <ReactFlow
                  key={draft.id || 'new'}
                  nodes={rfNodes}
                  edges={rfEdges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onNodeClick={(_, node) => {
                    setSelectedNodeId(node.id)
                    setSelectedEdgeId(null)
                  }}
                  onEdgeClick={(_, edge) => {
                    setSelectedEdgeId(edge.id)
                    setSelectedNodeId(null)
                  }}
                  onPaneClick={() => {
                    setSelectedNodeId(null)
                    setSelectedEdgeId(null)
                  }}
                  fitView
                  fitViewOptions={{ padding: 0.25 }}
                  minZoom={0.3}
                  maxZoom={1.6}
                  deleteKeyCode={['Backspace', 'Delete']}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background gap={18} size={1} color="rgba(255,255,255,0.07)" />
                  <Controls showInteractive={false} />
                </ReactFlow>
              </div>
              <div className="wf-side">{renderInspector()}</div>
            </div>
          </div>
        )}

        {tab === 'runs' && (
          <div className="wf-runs-split">
            <div className="wf-runs">
              <div className="dc-toolbar">
                <span className="dc-muted">{runs.length} recent run(s) · newest first</span>
                <button className="btn-ghost dc-btn" onClick={() => void clearHistory()} disabled={!!busy}>
                  <Trash2 size={11} /> Clear finished
                </button>
                {detail && (
                  <button className="btn-ghost dc-btn" onClick={() => setDetail(null)}>
                    <X size={11} /> Close detail
                  </button>
                )}
              </div>
              {runs.length === 0 && (
                <div className="wf-empty panel">
                  <History size={20} />
                  <strong>No runs yet</strong>
                  <p>Run a workflow manually or wait for its schedule. Every step is recorded here.</p>
                </div>
              )}
              {runs.map((run) => (
                <button
                  key={run.id}
                  className={`wf-run-row ${detail?.id === run.id ? 'active' : ''}`}
                  onClick={() => void openRun(run.id)}
                >
                  <div className="wf-run-top">
                    <span className="wf-run-name">{run.workflowName}</span>
                    <StatusChip status={run.status} />
                  </div>
                  <div className="wf-run-sub">
                    <span>{run.trigger}</span>
                    <span>{run.steps} step(s)</span>
                    <span>{runDuration(run)}</span>
                    <span>{ago(run.queuedAt)}</span>
                  </div>
                  {run.error && <div className="wf-run-err">{truncate(run.error, 120)}</div>}
                </button>
              ))}
            </div>

            <div className="wf-run-detail panel">
              {!detail && !detailBusy && (
                <div className="wf-empty">
                  <Clock3 size={20} />
                  <strong>Select a run</strong>
                  <p>Its timeline, step outputs and approval gate appear here.</p>
                </div>
              )}
              {detailBusy && !detail && (
                <div className="wf-empty">
                  <Loader2 size={18} className="wf-spin" />
                  <p>Loading the run…</p>
                </div>
              )}
              {detail && (
                <>
                  <div className="wf-detail-head">
                    <div className="min-w-0">
                      <div className="wf-detail-title">{detail.workflowName}</div>
                      <div className="wf-hint wf-mono">
                        {detail.id} · {detail.trigger} · queued {fmtTime(detail.queuedAt)}
                      </div>
                    </div>
                    <StatusChip status={detail.status} />
                  </div>

                  <div className="wf-detail-stats">
                    <span>Started {fmtTime(detail.startedAt)}</span>
                    <span>Ended {fmtTime(detail.endedAt)}</span>
                    <span>{runDuration(detail)}</span>
                    <span>{detail.steps.length} step(s)</span>
                  </div>

                  {detail.suspended && detail.status === 'awaiting_approval' && (
                    <div className="wf-approval">
                      <div className="wf-approval-head">
                        <ShieldCheck size={13} />
                        <strong>{detail.suspended.title}</strong>
                      </div>
                      <p className="wf-hint">
                        {detail.suspended.reason}
                        {detail.suspended.tool ? ` · tool ${detail.suspended.tool}` : ''}
                      </p>
                      <div className="wf-inline">
                        <button className="btn-primary dc-btn" onClick={() => void runAction('approve', detail.id)} disabled={!!busy}>
                          <CheckCircle2 size={12} /> Approve & continue
                        </button>
                        <button className="btn-ghost dc-btn wf-danger" onClick={() => void runAction('reject', detail.id)} disabled={!!busy}>
                          <XCircle size={12} /> Reject
                        </button>
                      </div>
                    </div>
                  )}

                  {detail.error && (
                    <div className="dc-error">
                      <AlertTriangle size={12} />
                      <span>{detail.error}</span>
                    </div>
                  )}

                  <div className="wf-inline">
                    <button className="btn-ghost dc-btn" onClick={() => void runAction('cancel', detail.id)} disabled={!!busy || ['succeeded', 'failed', 'cancelled'].includes(detail.status)}>
                      <Square size={11} /> Cancel
                    </button>
                    <button className="btn-ghost dc-btn" onClick={() => void runAction('resume', detail.id)} disabled={!!busy || !['interrupted', 'queued'].includes(detail.status)}>
                      <RefreshCw size={11} /> Resume
                    </button>
                    {detail.workflow && (
                      <button className="btn-ghost dc-btn" onClick={() => { openEditor(detail.workflow!); setTab('workflows') }}>
                        <Workflow size={11} /> Open workflow
                      </button>
                    )}
                  </div>

                  <div className="wf-steps">
                    {detail.steps.map((step, index) => (
                      <div key={`${step.nodeId}-${step.at}-${index}`} className={`wf-step ${step.ok ? 'ok' : 'bad'}`}>
                        <span className="wf-dot" />
                        <span className="wf-step-label">
                          {step.label}
                          <em>{step.type}</em>
                        </span>
                        <span className="wf-step-out">{step.error || step.output || '—'}</span>
                        <span className="wf-step-ms">{fmtMs(step.ms)}</span>
                      </div>
                    ))}
                  </div>

                  {detail.output && (
                    <>
                      <span className="wf-section-title">Final output</span>
                      <pre className="wf-pre">{detail.output}</pre>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {tab === 'schedule' && (
          <div className="wf-schedule">
            <div className="wf-cron-card panel">
              <div className="wf-side-head">
                <strong>Cron helper</strong>
                <span className="dc-muted">5 fields: minute hour day month weekday</span>
              </div>
              <div className="wf-cron-line">
                <input className="wf-input wf-mono" value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} aria-label="Cron expression" placeholder="0 9 * * *" />
                <button className="btn-primary dc-btn" onClick={() => void previewCron()} disabled={busy === 'cron'}>
                  {busy === 'cron' ? <Loader2 size={12} className="wf-spin" /> : <CalendarClock size={12} />} Preview next 5
                </button>
              </div>
              {cronError && <p className="wf-hint wf-hint-bad">{cronError}</p>}
              {!!cronRuns.length && (
                <div className="wf-cron-list">
                  {cronRuns.map((label, index) => (
                    <span key={`${label}-${index}`}>
                      <em>{index + 1}</em>
                      {label}
                    </span>
                  ))}
                </div>
              )}
              <p className="wf-hint">
                Day-of-month and day-of-week are OR-ed when both are restricted, matching cron. Schedule ticks run every 30 seconds and catch up a missed slot once.
              </p>
            </div>

            <div className="wf-list">
              <div className="dc-toolbar">
                <span className="dc-muted">Scheduled workflows</span>
              </div>
              {workflows.filter((wf) => wf.trigger.type === 'schedule').length === 0 && (
                <div className="wf-empty panel">
                  <CalendarClock size={20} />
                  <strong>No scheduled workflows</strong>
                  <p>Open a workflow, set its trigger to “On a cron schedule” and save it here.</p>
                </div>
              )}
              {workflows
                .filter((wf) => wf.trigger.type === 'schedule')
                .map((wf) => (
                  <div key={wf.id} className={`wf-row ${wf.enabled ? '' : 'off'}`}>
                    <span className="wf-row-icon" data-kind="schedule">
                      <CalendarClock size={14} />
                    </span>
                    <div className="wf-row-main">
                      <div className="wf-row-name">
                        {wf.name} <span className="wf-tag">cron {wf.trigger.cron}</span>
                      </div>
                      <div className="wf-row-sub">
                        <span>{wf.enabled ? `Next ${wf.nextRunAt ? fmtTime(wf.nextRunAt) : '—'}` : 'Paused — no runs will be queued'}</span>
                        {wf.lastRun && <span>Last {wf.lastRun.status.replace('_', ' ')} · {ago(wf.lastRun.queuedAt)}</span>}
                      </div>
                    </div>
                    <button className="page-tool-btn" onClick={() => void runWorkflow(wf.id)} disabled={!!busy} title="Run now" aria-label={`Run ${wf.name} now`}>
                      <Play size={12} />
                    </button>
                    <button className="switch" data-on={wf.enabled} onClick={() => void toggleWorkflow(wf)} aria-pressed={wf.enabled} aria-label={`Toggle ${wf.name}`}>
                      <span className="switch-knob" />
                    </button>
                    <button className="page-tool-btn" onClick={() => openEditor(wf)} title="Edit schedule" aria-label={`Edit ${wf.name}`}>
                      <Workflow size={12} />
                    </button>
                  </div>
                ))}
            </div>
          </div>
        )}

        {tab === 'templates' && (
          <div className="wf-templates">
            {templates.map((template) => (
              <div key={template.id} className="wf-template panel">
                <div className="wf-template-head">
                  <LayoutTemplate size={13} />
                  <strong>{template.name}</strong>
                </div>
                <p className="wf-hint">{template.description}</p>
                <div className="wf-template-meta">
                  {template.workflow.nodes.length} node(s) · {template.workflow.trigger.type === 'schedule' ? `cron ${template.workflow.trigger.cron}` : 'manual'}
                </div>
                <button className="btn-primary dc-btn" onClick={() => void useTemplate(template)} disabled={!!busy}>
                  {busy === `template:${template.id}` ? <Loader2 size={12} className="wf-spin" /> : <Plus size={12} />} Use template
                </button>
              </div>
            ))}
            {!templates.length && (
              <div className="wf-empty panel">
                <LayoutTemplate size={20} />
                <strong>Templates unavailable</strong>
                <p>The desktop bridge supplies the templates. Open ORVEX as the desktop app.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </PageShell>
  )
}
