import { useState } from 'react'
import { CircleCheck, Plus, Trash2 } from 'lucide-react'
import { goalsStore, removeGoal, upsertGoal, useStore, type Goal } from '../data/stores'

/** Renders goals as a nested hierarchy — one parent goal can own sub-goals. */
export default function GoalTree() {
  const goals = useStore(goalsStore)
  const [title, setTitle] = useState('')
  const [parent, setParent] = useState('')
  const roots = goals.filter((g) => !g.parentId)

  const add = () => {
    const t = title.trim()
    if (!t) return
    upsertGoal({
      id: `g-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: t,
      outcome: '',
      parentId: parent || null,
      done: false,
      createdAt: Date.now(),
    })
    setTitle('')
  }

  const renderNode = (g: Goal, depth: number) => {
    const children = goals.filter((c) => c.parentId === g.id)
    return (
      <div key={g.id} className="goal-node" style={{ marginLeft: depth * 15 }}>
        <div className={`goal-row ${g.done ? 'done' : ''}`}>
          <span className="goal-chev-spacer" />
          <button
            className={`eis-check ${g.done ? 'on' : ''}`}
            onClick={() => upsertGoal({ ...g, done: !g.done })}
            aria-label={g.done ? `Reopen ${g.title}` : `Complete ${g.title}`}
          >
            {g.done && <CircleCheck size={11} />}
          </button>
          <span className="goal-title">{g.title}</span>
          <button className="eis-del" onClick={() => removeGoal(g.id)} aria-label={`Delete ${g.title}`} title="Delete">
            <Trash2 size={10} />
          </button>
        </div>
        {children.map((c) => renderNode(c, depth + 1))}
      </div>
    )
  }

  return (
    <section className="goals panel panel-hairline">
      <div className="panel-head">
        <h2 className="panel-title">Goal Hierarchy</h2>
        <span className="dim" style={{ fontSize: 9 }}>
          {goals.filter((g) => g.done).length}/{goals.length} complete
        </span>
      </div>

      <div className="goal-add">
        <input
          className="eis-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          placeholder="New goal…"
          aria-label="New goal title"
        />
        <select className="select goal-parent" value={parent} onChange={(e) => setParent(e.target.value)} aria-label="Parent goal">
          <option value="">top level</option>
          {goals.map((g) => (
            <option key={g.id} value={g.id}>
              ↳ {g.title}
            </option>
          ))}
        </select>
        <button className="icon-btn !w-[26px] !h-[26px]" onClick={add} aria-label="Add goal">
          <Plus size={12} />
        </button>
      </div>

      <div className="goal-tree">
        {roots.length === 0 && <p className="ac-empty">No goals yet — add one above, then nest sub-goals under it.</p>}
        {roots.map((g) => renderNode(g, 0))}
      </div>
    </section>
  )
}
