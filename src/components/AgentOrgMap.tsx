import { useMemo, useRef } from 'react'
import ReactFlow, {
  Background,
  Controls,
  Handle,
  Position,
  type Edge,
  type Node,
  type NodeProps,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { AGENT_PROFILES, type AgentState } from '../data/agents'

type OrgNodeData = {
  label: string
  role: string
  accent: string
  status: AgentState
  initials: string
}

const STATUS_COLOR: Record<AgentState, string> = {
  Running: '#4ade80',
  Idle: '#4fc3ff',
  Paused: '#fbbf24',
}

function OrgNode({ data }: NodeProps<OrgNodeData>) {
  return (
    <div
      className="org-node"
      style={{ borderColor: `${data.accent}66`, boxShadow: `0 0 22px -6px ${data.accent}88` }}
    >
      <Handle type="target" position={Position.Top} className="org-handle" />
      <span className="org-avatar" style={{ background: `${data.accent}22`, color: data.accent, borderColor: `${data.accent}55` }}>
        {data.initials}
      </span>
      <span className="org-text">
        <span className="org-name">{data.label}</span>
        <span className="org-role">{data.role}</span>
      </span>
      <span className="org-status" style={{ color: STATUS_COLOR[data.status] }}>
        <span className="org-dot" style={{ background: STATUS_COLOR[data.status], boxShadow: `0 0 6px ${STATUS_COLOR[data.status]}` }} />
        {data.status}
      </span>
      <Handle type="source" position={Position.Bottom} className="org-handle" />
    </div>
  )
}

const nodeTypes = { org: OrgNode }

const initials = (name: string) =>
  name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

type Props = {
  states: Record<string, AgentState>
  selected: string
  onSelect: (id: string) => void
}

/**
 * Interactive org chart of the agent crew. The orchestrator sits on top, every
 * specialist reports into it, and clicking a node selects that agent.
 */
export default function AgentOrgMap({ states, selected, onSelect }: Props) {
  // Remember where the user dragged a node so a status refresh does not snap it back.
  const dragged = useRef<Record<string, { x: number; y: number }>>({})
  const { nodes, edges } = useMemo(() => {
    const ns: Node<OrgNodeData>[] = []
    const es: Edge[] = []

    const root = AGENT_PROFILES.find((a) => !a.reportsTo)
    const children = AGENT_PROFILES.filter((a) => a.reportsTo)

    if (root) {
      ns.push({
        id: root.id,
        type: 'org',
        position: dragged.current[root.id] ?? { x: 260, y: 0 },
        data: {
          label: root.name,
          role: root.role,
          accent: root.accent,
          status: states[root.id] ?? 'Idle',
          initials: initials(root.name),
        },
      })
    }

    const gap = 190
    children.forEach((c, i) => {
      ns.push({
        id: c.id,
        type: 'org',
        position: dragged.current[c.id] ?? { x: 20 + i * gap, y: 150 },
        data: {
          label: c.name,
          role: c.role,
          accent: c.accent,
          status: states[c.id] ?? 'Idle',
          initials: initials(c.name),
        },
      })
      if (c.reportsTo) {
        es.push({
          id: `${c.reportsTo}-${c.id}`,
          source: c.reportsTo,
          target: c.id,
          animated: (states[c.id] ?? 'Idle') === 'Running',
          style: { stroke: `${c.accent}88`, strokeWidth: 1.4 },
        })
      }
    })

    return { nodes: ns, edges: es }
  }, [states])

  return (
    <div className="orgmap panel">
      <ReactFlow
        nodes={nodes.map((n) => ({
          ...n,
          selected: n.id === selected,
          style: n.id === selected ? { border: `1px solid ${n.data.accent}` } : undefined,
          className: n.id === selected ? 'org-node-selected' : '',
        }))}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => onSelect(node.id)}
        onNodeDragStop={(_, node) => {
          dragged.current[node.id] = { ...node.position }
        }}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.4}
        maxZoom={1.6}
        className="orgflow"
      >
        <Background color="rgba(120, 190, 255, 0.09)" gap={22} size={1} />
        <Controls showInteractive={false} className="orgflow-controls" />
      </ReactFlow>
    </div>
  )
}
