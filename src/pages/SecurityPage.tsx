import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertOctagon,
  Database,
  FileArchive,
  Fingerprint,
  KeyRound,
  Lock,
  RefreshCw,
  ScanEye,
  ShieldCheck,
  ShieldAlert,
  Trash2,
  Unlock,
  UserCog,
} from 'lucide-react'
import PageShell from './PageShell'
import { onTablistKeyDown } from '../data/a11y'
import type {
  OrvexApprovalAdvisorState,
  OrvexAuditEntry,
  OrvexEscalationRule,
  OrvexSecretSummary,
  OrvexSecurityBackup,
  OrvexSecurityRole,
  OrvexSecurityStatus,
} from '../types/desktop'

type Props = {
  onBack: () => void
  notify: (msg: string) => void
  initialTab?: string | null
}

type Tab = 'overview' | 'permissions' | 'secrets' | 'policy' | 'audit' | 'backup' | 'privacy'

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'secrets', label: 'Secrets' },
  { id: 'policy', label: 'Policy' },
  { id: 'audit', label: 'Audit' },
  { id: 'backup', label: 'Backup' },
  { id: 'privacy', label: 'Privacy' },
]

const ROLES: { id: OrvexSecurityRole; label: string; detail: string }[] = [
  { id: 'owner', label: 'Owner', detail: 'Everything, including security settings, secrets and policies.' },
  { id: 'operator', label: 'Operator', detail: 'Runs every agent tool, but cannot change security settings or secrets.' },
  { id: 'viewer', label: 'Viewer', detail: 'Only read-only agent tools — no writes, launches, deletes or purchases.' },
]

type PermissionRow = { name: string; description: string; source: string; policy: string }

const bytes = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

const when = (ts: number | string | null) => {
  if (!ts) return 'never'
  const at = typeof ts === 'number' ? ts : Date.parse(ts)
  if (!Number.isFinite(at)) return 'unknown'
  const diff = Date.now() - at
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return new Date(at).toLocaleString()
}

const splitList = (text: string) =>
  text
    .split(/[\n,]+/)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)

export default function SecurityPage({ onBack, notify, initialTab }: Props) {
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined
  const [tab, setTab] = useState<Tab>(() => (TABS.some((t) => t.id === initialTab) ? (initialTab as Tab) : 'overview'))
  const [status, setStatus] = useState<OrvexSecurityStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!bridge) return setError('Desktop bridge unavailable — security needs the ORVEX app.')
    const res = await bridge.security.status()
    if (res.ok) {
      setStatus(res.data)
      setError(null)
    } else {
      setError(res.error)
    }
  }, [bridge])

  useEffect(() => {
    if (initialTab && TABS.some((t) => t.id === initialTab)) setTab(initialTab as Tab)
  }, [initialTab])

  useEffect(() => {
    void refresh()
    if (!bridge) return
    const off = bridge.security.onChange(() => void refresh())
    return off
  }, [bridge, refresh])

  const run = async (action: () => Promise<{ ok: boolean; error?: string }>, done?: string) => {
    setBusy(true)
    try {
      const res = await action()
      if (!res.ok) {
        setError(res.error || 'That did not work.')
        notify(res.error || 'That did not work.')
      } else if (done) {
        notify(done)
      }
      await refresh()
      return res
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageShell
      title="Security"
      sub="PIN lock, roles, per-tool permissions, secrets, policy, audit, backups and privacy — all local"
      onBack={onBack}
      actions={
        <button className="ghost-btn" onClick={() => void refresh()} title="Refresh">
          <RefreshCw size={12} />
        </button>
      }
    >
      <div className="settings-tabs sec-tabs" role="tablist" aria-label="Security sections" onKeyDown={onTablistKeyDown}>
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            tabIndex={tab === t.id ? 0 : -1}
            className={`settings-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <p className="dc-error">{error}</p>}
      {!status && !error && <p className="dim">Reading the local security state…</p>}

      {status && bridge && (
        <>
          {tab === 'overview' && <Overview status={status} run={run} busy={busy} bridge={bridge} />}
          {tab === 'permissions' && <Permissions bridge={bridge} notify={notify} />}
          {tab === 'secrets' && <Secrets bridge={bridge} run={run} busy={busy} />}
          {tab === 'policy' && <Policy status={status} run={run} busy={busy} notify={notify} />}
          {tab === 'audit' && <Audit bridge={bridge} />}
          {tab === 'backup' && <Backup bridge={bridge} run={run} busy={busy} />}
          {tab === 'privacy' && <Privacy bridge={bridge} run={run} busy={busy} notify={notify} />}
        </>
      )}
    </PageShell>
  )
}

type RunFn = (action: () => Promise<{ ok: boolean; error?: string }>, done?: string) => Promise<{ ok: boolean; error?: string }>

function Overview({ status, run, busy, bridge }: { status: OrvexSecurityStatus; run: RunFn; busy: boolean; bridge: NonNullable<Window['orvex']> }) {
  const [newPin, setNewPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [currentPin, setCurrentPin] = useState('')
  const [stopReason, setStopReason] = useState('')
  const [rolePin, setRolePin] = useState('')
  const [askingRolePin, setAskingRolePin] = useState(false)

  const owner = status.role === 'owner'
  const rank: Record<OrvexSecurityRole, number> = { viewer: 0, operator: 1, owner: 2 }

  const chooseRole = (role: (typeof ROLES)[number]) => {
    if (rank[role.id] > rank[status.role] && status.hasPin) {
      setAskingRolePin(true)
      return
    }
    void run(() => bridge.security.setRole(role.id), `Role set to ${role.label}`)
  }

  const confirmRolePin = () => {
    void run(async () => {
      const res = await bridge.security.setRole('owner', rolePin)
      if (res.ok) {
        setRolePin('')
        setAskingRolePin(false)
      }
      return res
    }, 'Role set to Owner')
  }

  return (
    <div className="sec-grid">
      <section className="sec-card">
        <div className="sec-card-head">
          <UserCog size={14} />
          <h3>Role</h3>
          <span className="sec-chip">{status.roleLabel}</span>
        </div>
        <p className="dim">The role applies to agent tool calls. The app UI itself stays available to you.</p>
        <div className="sec-roles">
          {ROLES.map((role) => (
            <button
              key={role.id}
              className={`sec-role ${status.role === role.id ? 'active' : ''}`}
              disabled={busy || (!owner && role.id !== 'owner')}
              onClick={() => chooseRole(role)}
            >
              <strong>{role.label}</strong>
              <span>{role.detail}</span>
            </button>
          ))}
        </div>
        {!owner && (
          <p className="dim">
            {status.hasPin
              ? 'Switching back to Owner asks for the PIN set above.'
              : 'Switching back to Owner is allowed; the other roles need Owner first.'}
          </p>
        )}
        {askingRolePin && (
          <div className="sec-form" style={{ marginTop: 10 }}>
            <label>
              PIN to return to Owner
              <input
                type="password"
                value={rolePin}
                onChange={(e) => setRolePin(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && rolePin) confirmRolePin()
                }}
                autoComplete="current-password"
                aria-label="Role PIN"
                autoFocus
              />
            </label>
            <div className="sec-row">
              <button className="ghost-btn" disabled={busy || !rolePin} onClick={confirmRolePin}>
                <Unlock size={12} /> Confirm
              </button>
              <button
                className="ghost-btn"
                disabled={busy}
                onClick={() => {
                  setRolePin('')
                  setAskingRolePin(false)
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="sec-card">
        <div className="sec-card-head">
          <KeyRound size={14} />
          <h3>PIN lock</h3>
          <span className={`sec-chip ${status.hasPin ? 'ok' : ''}`}>{status.hasPin ? 'Set' : 'Not set'}</span>
        </div>
        <p className="dim">
          The PIN is hashed with scrypt (N=16384) and only the hash is stored. {status.maxAttempts} wrong tries lock entry for a
          minute, doubling each time after that.
        </p>
        {!status.hasPin ? (
          <div className="sec-form">
            <label>
              New PIN
              <input type="password" value={newPin} onChange={(e) => setNewPin(e.target.value)} autoComplete="new-password" />
            </label>
            <label>
              Repeat PIN
              <input type="password" value={confirmPin} onChange={(e) => setConfirmPin(e.target.value)} autoComplete="new-password" />
            </label>
            <button
              className="ghost-btn"
              disabled={busy || newPin.length < 4 || newPin !== confirmPin}
              onClick={() =>
                void run(async () => {
                  const res = await bridge.security.setPin(null, newPin)
                  if (res.ok) {
                    setNewPin('')
                    setConfirmPin('')
                  }
                  return res
                }, 'PIN set — lock when you step away')
              }
            >
              Set PIN
            </button>
            {newPin && newPin !== confirmPin && <p className="dim">The two PINs do not match yet.</p>}
          </div>
        ) : (
          <div className="sec-form">
            <label>
              Current PIN
              <input type="password" value={currentPin} onChange={(e) => setCurrentPin(e.target.value)} autoComplete="current-password" />
            </label>
            <label>
              New PIN
              <input type="password" value={newPin} onChange={(e) => setNewPin(e.target.value)} autoComplete="new-password" />
            </label>
            <div className="sec-row">
              <button
                className="ghost-btn"
                disabled={busy || !currentPin || newPin.length < 4}
                onClick={() =>
                  void run(async () => {
                    const res = await bridge.security.setPin(currentPin, newPin)
                    if (res.ok) {
                      setCurrentPin('')
                      setNewPin('')
                    }
                    return res
                  }, 'PIN changed')
                }
              >
                Change PIN
              </button>
              <button
                className="ghost-btn"
                disabled={busy || !currentPin}
                onClick={() =>
                  void run(async () => {
                    const res = await bridge.security.removePin(currentPin)
                    if (res.ok) setCurrentPin('')
                    return res
                  }, 'PIN removed')
                }
              >
                Remove PIN
              </button>
              <button className="ghost-btn" disabled={busy} onClick={() => void run(() => bridge.security.lock(), 'ORVEX locked')}>
                <Lock size={12} /> Lock now
              </button>
            </div>
            <p className="dim">
              Removing the PIN needs the current one. {status.locked ? `Currently locked: ${status.lockReason ?? 'yes'}.` : 'Not locked.'}
            </p>
          </div>
        )}
        <label className="sec-inline">
          Auto-lock after
          <select
            value={status.autolockMinutes}
            disabled={!owner || busy || !status.hasPin}
            onChange={(e) => void run(() => bridge.security.setSettings({ autolockMinutes: Number(e.target.value) }), 'Auto-lock updated')}
          >
            {[0, 5, 15, 30, 60, 120].map((m) => (
              <option key={m} value={m}>
                {m === 0 ? 'Off' : `${m} minutes`}
              </option>
            ))}
          </select>
        </label>
        <p className="dim">Windows session lock also locks ORVEX when a PIN is set.</p>
      </section>

      <section className={`sec-card ${status.emergency.stopped ? 'bad' : ''}`}>
        <div className="sec-card-head">
          <AlertOctagon size={14} />
          <h3>Emergency stop</h3>
          <span className={`sec-chip ${status.emergency.stopped ? 'bad' : ''}`}>{status.emergency.stopped ? 'Active' : 'Clear'}</span>
        </div>
        <p className="dim">
          Aborts the running agent, every workflow run and all open model streams, then blocks new tool calls until you clear it.
        </p>
        {status.emergency.stopped ? (
          <>
            <p className="sec-stop-reason">
              Stopped {when(status.emergency.at)} — {status.emergency.reason || 'no reason given'}
            </p>
            <button className="ghost-btn" disabled={busy} onClick={() => void run(() => bridge.security.emergencyClear(), 'Emergency stop cleared')}>
              <Unlock size={12} /> Clear stop
            </button>
          </>
        ) : (
          <div className="sec-form">
            <label>
              Reason (optional)
              <input value={stopReason} onChange={(e) => setStopReason(e.target.value)} placeholder="Why are you stopping?" />
            </label>
            <button
              className="sec-danger"
              disabled={!owner || busy}
              onClick={() => void run(() => bridge.security.emergencyStop(stopReason || 'Emergency stop pressed'), 'Emergency stop active')}
            >
              <AlertOctagon size={12} /> Stop everything
            </button>
          </div>
        )}
      </section>

      <section className="sec-card">
        <div className="sec-card-head">
          <Database size={14} />
          <h3>Encryption at rest</h3>
          <span className={`sec-chip ${status.atRest.available ? 'ok' : 'bad'}`}>{status.atRest.available ? 'Available' : 'Unavailable'}</span>
        </div>
        <dl className="sec-kv">
          <div>
            <dt>Secret store</dt>
            <dd>{status.atRest.storeFile || 'not configured'}</dd>
          </div>
          <div>
            <dt>Encryption</dt>
            <dd>{status.atRest.label}</dd>
          </div>
          <div>
            <dt>Stored secrets</dt>
            <dd>{status.secretCount}</dd>
          </div>
          <div>
            <dt>Permissions</dt>
            <dd>
              {status.permissionCounts.allow} allow · {status.permissionCounts.ask} ask · {status.permissionCounts.deny} deny
            </dd>
          </div>
          <div>
            <dt>Data folder</dt>
            <dd className="sec-mono">{status.dataDir || 'unknown'}</dd>
          </div>
          <div>
            <dt>Policy updated</dt>
            <dd>{when(status.updatedAt)}</dd>
          </div>
        </dl>
        {!status.atRest.available && (
          <p className="dim">The OS refused encryption for this Windows user — secrets cannot be stored until it is available.</p>
        )}
      </section>
    </div>
  )
}

function Permissions({ bridge, notify }: { bridge: NonNullable<Window['orvex']>; notify: (m: string) => void }) {
  const [rows, setRows] = useState<PermissionRow[]>([])
  const [floors, setFloors] = useState<{ id: string; tool: string; pattern: string; note: string }[]>([])
  const [counts, setCounts] = useState({ allow: 0, ask: 0, deny: 0, floors: 0, total: 0 })
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('all')
  const [loading, setLoading] = useState(true)
  const [floorTool, setFloorTool] = useState('*')
  const [floorPattern, setFloorPattern] = useState('')
  const [floorNote, setFloorNote] = useState('')
  const [escalations, setEscalations] = useState<OrvexEscalationRule[]>([])
  const [escalationTool, setEscalationTool] = useState('*')
  const [escalationPattern, setEscalationPattern] = useState('.*')
  const [escalationReason, setEscalationReason] = useState('')
  const [scanning, setScanning] = useState(false)

  const apply = (data: { tools: PermissionRow[]; counts: typeof counts; floors: { id: string; tool: string; pattern: string; note: string }[] }) => {
    setRows(data.tools)
    setCounts(data.counts)
    setFloors(data.floors)
  }

  const applyAdvisor = (data: OrvexApprovalAdvisorState) => setEscalations(data.rules)

  const load = useCallback(async () => {
    const [res, advisor] = await Promise.all([bridge.permissions.state(), bridge.approvalAdvisor.state()])
    if (res.ok) {
      apply(res.data)
    } else {
      notify(res.error)
    }
    if (advisor.ok) applyAdvisor(advisor.data)
    else notify(advisor.error)
    setLoading(false)
  }, [bridge, notify])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows
      .filter((r) => (source === 'all' ? true : r.source === source))
      .filter((r) => (q ? r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q) : true))
      .slice(0, 300)
  }, [rows, query, source])

  const setPolicy = async (tool: string, policy: 'default' | 'allow' | 'ask' | 'deny') => {
    const res = await bridge.permissions.set(tool, policy)
    if (res.ok) {
      apply(res.data)
    } else notify(res.error)
  }

  const addFloor = async () => {
    const res = await bridge.permissions.addFloor({ tool: floorTool, pattern: floorPattern.trim(), note: floorNote.trim() })
    if (res.ok) {
      apply(res.data)
      setFloorPattern('')
      setFloorNote('')
      notify('Approval floor added')
    } else notify(res.error)
  }

  const removeFloor = async (id: string) => {
    const res = await bridge.permissions.removeFloor(id)
    if (res.ok) apply(res.data)
    else notify(res.error)
  }

  const addEscalation = async () => {
    const res = await bridge.approvalAdvisor.add({
      tool: escalationTool,
      pattern: escalationPattern.trim() || '.*',
      reason: escalationReason.trim() || 'Needs explicit approval.',
    })
    if (res.ok) {
      applyAdvisor(res.data)
      setEscalationReason('')
      notify('Escalation rule added')
    } else notify(res.error)
  }

  const acceptEscalation = async (id: string) => {
    const res = await bridge.approvalAdvisor.accept(id)
    if (res.ok) applyAdvisor(res.data)
    else notify(res.error)
  }

  const removeEscalation = async (id: string) => {
    const res = await bridge.approvalAdvisor.remove(id)
    if (res.ok) applyAdvisor(res.data)
    else notify(res.error)
  }

  const scanEscalations = async () => {
    setScanning(true)
    const res = await bridge.approvalAdvisor.learn()
    setScanning(false)
    if (res.ok) {
      applyAdvisor(res.data)
      notify(res.data.created.length ? `Found ${res.data.created.length} escalation suggestion(s)` : 'No repeated refusals found in the audit log')
    } else notify(res.error)
  }

  const suggestedCount = escalations.filter((rule) => rule.status === 'suggested').length

  return (
    <div className="sec-stack">
      <section className="sec-card">
        <div className="sec-card-head">
          <div>
            <h3>Approval floors</h3>
            <p className="dim">
              A case-insensitive regular expression matched against the tool name and its JSON arguments. A matching call is always blocked —
              auto-approve and full-auto cannot skip a floor.
            </p>
          </div>
        </div>
        <div className="sec-toolbar">
          <select value={floorTool} onChange={(e) => setFloorTool(e.target.value)} aria-label="Floor tool">
            <option value="*">All tools</option>
            {rows.map((row) => (
              <option key={row.name} value={row.name}>{row.name}</option>
            ))}
          </select>
          <input
            className="sec-search"
            placeholder="regex, e.g. rm\\s+-rf"
            value={floorPattern}
            onChange={(e) => setFloorPattern(e.target.value)}
            aria-label="Floor pattern"
          />
          <input placeholder="note (optional)" value={floorNote} onChange={(e) => setFloorNote(e.target.value)} aria-label="Floor note" />
          <button className="ghost-btn" disabled={!floorPattern.trim()} onClick={() => void addFloor()}>
            Add floor
          </button>
          <span className="sec-chip">{floors.length} floors</span>
        </div>
        <div className="sec-perm-list">
          {floors.map((floor) => (
            <div className="sec-perm" key={floor.id}>
              <div className="sec-perm-main">
                <strong>{floor.note || floor.pattern}</strong>
                <span className="sec-perm-desc">
                  {floor.tool === '*' ? 'all tools' : floor.tool} · /{floor.pattern}/i
                </span>
              </div>
              <button className="ghost-btn" onClick={() => void removeFloor(floor.id)}>
                Remove
              </button>
            </div>
          ))}
          {!floors.length && <p className="dim">No approval floors yet.</p>}
        </div>
      </section>
      <section className="sec-card">
        <div className="sec-card-head">
          <div>
            <h3>Escalation rules</h3>
            <p className="dim">
              Escalation only ever makes a call stricter: a match forces an explicit yes even in auto-approve, and is refused
              outright in background sub-agents. It can never approve or relax a call.
            </p>
          </div>
          <button className="ghost-btn" disabled={scanning} onClick={() => void scanEscalations()}>
            {scanning ? 'Scanning…' : 'Scan audit log'}
          </button>
        </div>
        <div className="sec-toolbar">
          <select value={escalationTool} onChange={(e) => setEscalationTool(e.target.value)} aria-label="Escalation tool">
            <option value="*">All tools</option>
            {rows.map((row) => (
              <option key={row.name} value={row.name}>{row.name}</option>
            ))}
          </select>
          <input
            className="sec-search"
            placeholder="regex over tool + arguments"
            value={escalationPattern}
            onChange={(e) => setEscalationPattern(e.target.value)}
            aria-label="Escalation pattern"
          />
          <input
            placeholder="why it needs approval"
            value={escalationReason}
            onChange={(e) => setEscalationReason(e.target.value)}
            aria-label="Escalation reason"
          />
          <button className="ghost-btn" onClick={() => void addEscalation()}>
            Add rule
          </button>
          <span className="sec-chip">{escalations.length - suggestedCount} active</span>
          <span className="sec-chip">{suggestedCount} suggested</span>
        </div>
        <div className="sec-perm-list">
          {escalations.map((rule) => (
            <div className="sec-perm" key={rule.id}>
              <div className="sec-perm-main">
                <strong>{rule.reason}</strong>
                <span className="sec-perm-desc">
                  {rule.tool === '*' ? 'all tools' : rule.tool} · /{rule.pattern}/i · {rule.status}
                  {rule.hits ? ` · ${rule.hits} hit(s)` : ''}
                  {rule.status === 'suggested' && rule.evidence ? ` · from ${rule.evidence} audit event(s)` : ''}
                </span>
              </div>
              {rule.status === 'suggested' && (
                <button className="ghost-btn" onClick={() => void acceptEscalation(rule.id)}>
                  Accept
                </button>
              )}
              <button className="ghost-btn" onClick={() => void removeEscalation(rule.id)}>
                Remove
              </button>
            </div>
          ))}
          {!escalations.length && (
            <p className="dim">
              No escalation rules yet. Scan the audit log after some refusals, or add a rule for a tool you never want
              auto-approved.
            </p>
          )}
        </div>
      </section>
      <div className="sec-toolbar">
        <input className="sec-search sec-search-tools" placeholder="Search tools…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search tools" />
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="all">All sources</option>
          <option value="builtin">Built-in</option>
          <option value="mcp">MCP</option>
        </select>
        <span className="sec-chip">{counts.total} tools</span>
        <span className="sec-chip ok">{counts.allow} allow</span>
        <span className="sec-chip">{counts.ask} ask</span>
        <span className="sec-chip bad">{counts.deny} deny</span>
        <button
          className="ghost-btn ml-auto"
          onClick={async () => {
            const res = await bridge.permissions.reset()
            if (res.ok) {
              apply(res.data)
              notify('Every tool policy reset to the default (approval floors are unchanged)')
            } else notify(res.error)
          }}
        >
          Reset all
        </button>
      </div>
      <p className="dim">
        Default means the built-in guardrails decide. Ask always confirms. Deny never runs — deny wins over every other setting.
      </p>
      {loading && <p className="dim">Loading tools…</p>}
      <div className="sec-perm-list">
        {filtered.map((row) => (
          <div className="sec-perm" key={row.name}>
            <div className="sec-perm-main">
              <strong>{row.name}</strong>
              <span className="sec-perm-desc">{row.description || 'No description.'}</span>
            </div>
            <span className="sec-chip">{row.source}</span>
            <select
              value={row.policy}
              onChange={(e) => void setPolicy(row.name, e.target.value as 'default' | 'allow' | 'ask' | 'deny')}
              aria-label={`Policy for ${row.name}`}
            >
              <option value="default">default</option>
              <option value="allow">allow</option>
              <option value="ask">ask</option>
              <option value="deny">deny</option>
            </select>
          </div>
        ))}
        {!loading && filtered.length === 0 && <p className="dim">No tool matches that search.</p>}
      </div>
    </div>
  )
}

function Secrets({ bridge, run, busy }: { bridge: NonNullable<Window['orvex']>; run: RunFn; busy: boolean }) {
  const [info, setInfo] = useState<OrvexSecretSummary | null>(null)
  const [id, setId] = useState('')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await bridge.security.secrets()
    if (res.ok) setInfo(res.data)
    else setError(res.error)
  }, [bridge])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="sec-stack">
      <section className="sec-card">
        <div className="sec-card-head">
          <Fingerprint size={14} />
          <h3>Secret manager</h3>
          <span className={`sec-chip ${info?.encrypted ? 'ok' : 'bad'}`}>{info?.encrypted ? 'Encrypted' : 'Unavailable'}</span>
        </div>
        <p className="dim">
          Values are write-only: ORVEX encrypts them with the OS and never prints them again, here or in logs. Provider keys and
          integration tokens live in the same store.
        </p>
        {error && <p className="dc-error">{error}</p>}
        {info && (
          <dl className="sec-kv">
            <div>
              <dt>Store</dt>
              <dd>{info.storeFile || info.file || 'none'}</dd>
            </div>
            <div>
              <dt>Encryption</dt>
              <dd>{info.encryption}</dd>
            </div>
            <div>
              <dt>Entries</dt>
              <dd>{info.count}</dd>
            </div>
            <div>
              <dt>File size</dt>
              <dd>{bytes(info.bytes)}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{when(info.updatedAt)}</dd>
            </div>
          </dl>
        )}
        <div className="sec-form">
          <label>
            Secret id
            <input value={id} onChange={(e) => setId(e.target.value)} placeholder="e.g. provider.openai.key" />
          </label>
          <label>
            Value
            <input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" placeholder="Write-only" />
          </label>
          <button
            className="ghost-btn"
            disabled={busy || !id.trim() || value.length < 4}
            onClick={() =>
              void run(async () => {
                const res = await bridge.security.setSecret(id.trim(), value)
                if (res.ok) {
                  setValue('')
                  setId('')
                  await load()
                }
                return res
              }, 'Secret stored (value not shown again)')
            }
          >
            Save secret
          </button>
        </div>
      </section>

      <section className="sec-card">
        <div className="sec-card-head">
          <KeyRound size={14} />
          <h3>Stored ids</h3>
          <span className="sec-chip">{info?.count ?? 0}</span>
        </div>
        {!info || info.ids.length === 0 ? (
          <p className="dim">No secrets stored. Provider keys you add in Settings appear here by id only.</p>
        ) : (
          <div className="sec-secret-list">
            {info.ids.map((secretId) => (
              <div className="sec-secret" key={secretId}>
                <span className="sec-mono">{secretId}</span>
                <span className="sec-chip">value hidden</span>
                <button
                  className="ghost-btn"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const res = await bridge.security.deleteSecret(secretId)
                      if (res.ok) await load()
                      return res
                    }, `Deleted ${secretId}`)
                  }
                >
                  <Trash2 size={11} /> Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function Policy({
  status,
  run,
  busy,
  notify,
}: {
  status: OrvexSecurityStatus
  run: RunFn
  busy: boolean
  notify: (m: string) => void
}) {
  const [cmdMode, setCmdMode] = useState(status.command.mode)
  const [cmdList, setCmdList] = useState(status.command.allow.join('\n'))
  const [netMode, setNetMode] = useState(status.network.mode)
  const [netList, setNetList] = useState(status.network.hosts.join('\n'))
  const [sandbox, setSandbox] = useState(status.sandbox.shell)
  const [rateOn, setRateOn] = useState(status.rate.enabled)
  const [perMinute, setPerMinute] = useState(status.rate.perMinute)
  const [perTool, setPerTool] = useState(status.rate.perToolPerMinute)
  const [probe, setProbe] = useState('')
  const [scan, setScan] = useState<{ suspicious: boolean; reasons: string[] } | null>(null)
  const bridge = typeof window !== 'undefined' ? window.orvex : undefined

  const save = () =>
    void run(
      () =>
        bridge!.security.setSettings({
          command: { mode: cmdMode, allow: splitList(cmdList) },
          network: { mode: netMode, hosts: splitList(netList) },
          sandbox: { shell: sandbox },
          rate: { enabled: rateOn, perMinute: Number(perMinute), perToolPerMinute: Number(perTool) },
        }),
      'Security policy saved',
    )

  return (
    <div className="sec-grid">
      <section className="sec-card">
        <div className="sec-card-head">
          <ShieldCheck size={14} />
          <h3>Command policy</h3>
          <span className="sec-chip">{status.command.mode}</span>
        </div>
        <p className="dim">The dangerous-command blocklist always applies. In allowlist mode, only these executables may run.</p>
        <div className="sec-row">
          <label className="sec-inline">
            <input type="radio" checked={cmdMode === 'blocklist'} onChange={() => setCmdMode('blocklist')} /> Blocklist
          </label>
          <label className="sec-inline">
            <input type="radio" checked={cmdMode === 'allowlist'} onChange={() => setCmdMode('allowlist')} /> Allowlist only
          </label>
        </div>
        <textarea
          className="sec-textarea"
          rows={4}
          value={cmdList}
          onChange={(e) => setCmdList(e.target.value)}
          placeholder={'node\nnpm\ngit'}
          disabled={cmdMode !== 'allowlist'}
        />
        <p className="dim">One executable per line, without the .exe extension.</p>
      </section>

      <section className="sec-card">
        <div className="sec-card-head">
          <ShieldCheck size={14} />
          <h3>Network policy</h3>
          <span className="sec-chip">{status.network.mode}</span>
        </div>
        <p className="dim">Controls URLs passed to agent tools that fetch or open things. Wildcards like *.github.com are supported.</p>
        <div className="sec-row">
          <label className="sec-inline">
            <input type="radio" checked={netMode === 'all'} onChange={() => setNetMode('all')} /> Any host
          </label>
          <label className="sec-inline">
            <input type="radio" checked={netMode === 'allowlist'} onChange={() => setNetMode('allowlist')} /> Allowlist
          </label>
        </div>
        <textarea
          className="sec-textarea"
          rows={4}
          value={netList}
          onChange={(e) => setNetList(e.target.value)}
          placeholder={'api.openai.com\n*.github.com'}
          disabled={netMode !== 'allowlist'}
        />
      </section>

      <section className="sec-card">
        <div className="sec-card-head">
          <Lock size={14} />
          <h3>Shell sandbox</h3>
          <span className={`sec-chip ${sandbox ? 'ok' : ''}`}>{sandbox ? 'On' : 'Off'}</span>
        </div>
        <label className="sec-inline">
          <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} /> Run shell commands in the
          sandbox
        </label>
        <p className="dim">
          Best effort, not a VM: commands start in a dedicated folder with a scrubbed environment (no tokens or API keys from the
          app process) and the usual timeout. Only enable it if you want those limits.
        </p>
      </section>

      <section className="sec-card">
        <div className="sec-card-head">
          <RefreshCw size={14} />
          <h3>Rate limiter</h3>
          <span className={`sec-chip ${rateOn ? 'ok' : ''}`}>{rateOn ? 'On' : 'Off'}</span>
        </div>
        <label className="sec-inline">
          <input type="checkbox" checked={rateOn} onChange={(e) => setRateOn(e.target.checked)} /> Limit agent tool calls
        </label>
        <div className="sec-row">
          <label className="sec-inline">
            Calls / minute
            <input
              type="number"
              min={10}
              max={10000}
              value={perMinute}
              onChange={(e) => setPerMinute(Number(e.target.value))}
              disabled={!rateOn}
            />
          </label>
          <label className="sec-inline">
            Per tool / minute
            <input type="number" min={5} max={10000} value={perTool} onChange={(e) => setPerTool(Number(e.target.value))} disabled={!rateOn} />
          </label>
        </div>
        <p className="dim">A blocked call fails with a retry time instead of running. The window is a sliding minute.</p>
      </section>

      <section className="sec-card">
        <div className="sec-card-head">
          <ScanEye size={14} />
          <h3>Prompt-injection check</h3>
        </div>
        <p className="dim">
          Every tool result is scanned. Suspicious text is wrapped in an untrusted-data notice and recorded in the audit trail.
          Paste a sample to see what the scanner notices.
        </p>
        <textarea className="sec-textarea" rows={3} value={probe} onChange={(e) => setProbe(e.target.value)} placeholder="Paste fetched text…" />
        <button
          className="ghost-btn"
          disabled={!probe.trim()}
          onClick={async () => {
            if (!bridge) return
            const res = await bridge.security.scan(probe)
            if (res.ok) setScan(res.data)
            else notify(res.error)
          }}
        >
          Scan
        </button>
        {scan && (
          <p className={scan.suspicious ? 'sec-stop-reason' : 'dim'}>
            {scan.suspicious ? `Suspicious: ${scan.reasons.join('; ')}` : 'No injection patterns found.'}
          </p>
        )}
      </section>

      <div className="sec-save-row">
        <button className="ghost-btn" onClick={save} disabled={busy}>
          Save policy
        </button>
      </div>
    </div>
  )
}

function Audit({ bridge }: { bridge: NonNullable<Window['orvex']> }) {
  const [rows, setRows] = useState<OrvexAuditEntry[]>([])
  const [kind, setKind] = useState('')
  const [tool, setTool] = useState('')
  const [ok, setOk] = useState('all')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await bridge.security.audit({
      limit: 300,
      kind: kind || undefined,
      tool: tool || undefined,
      ok: ok === 'all' ? undefined : ok === 'ok',
      query: query || undefined,
    })
    if (res.ok) {
      setRows(res.data)
      setError(null)
    } else setError(res.error)
  }, [bridge, kind, tool, ok, query])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="sec-stack">
      <div className="sec-toolbar">
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Audit kind">
          <option value="">All kinds</option>
          {['tool', 'tool-denied', 'tool-blocked', 'injection-suspected', 'emergency', 'privacy-clear', 'secret-set', 'secret-delete', 'backup-restored', 'workflow-step', 'workflow-run'].map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select value={ok} onChange={(e) => setOk(e.target.value)} aria-label="Audit result">
          <option value="all">Any result</option>
          <option value="ok">Succeeded</option>
          <option value="fail">Failed</option>
        </select>
        <input className="sec-search" placeholder="Tool name…" value={tool} onChange={(e) => setTool(e.target.value)} />
        <input className="sec-search" placeholder="Search text…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="ghost-btn ml-auto" onClick={() => void load()}>
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
      <p className="dim">Arguments and errors are redacted here: API keys, tokens, passwords and stored secret values never appear.</p>
      {error && <p className="dc-error">{error}</p>}
      <div className="sec-audit">
        {rows.map((row, i) => (
          <div className={`sec-audit-row ${row.ok === false ? 'bad' : ''}`} key={`${row.ts}-${row.kind}-${i}`}>
            <span className="sec-audit-time">{new Date(row.ts).toLocaleTimeString('en-US', { hour12: false })}</span>
            <span className="sec-audit-kind">{row.kind}</span>
            <span className="sec-audit-tool">{row.tool || '—'}</span>
            <span className="sec-audit-detail" title={row.error || row.args || ''}>
              {row.error || row.args || ''}
            </span>
            <span className="sec-chip">{row.ms != null ? `${row.ms} ms` : row.ok === false ? 'failed' : row.ok ? 'ok' : '—'}</span>
          </div>
        ))}
        {rows.length === 0 && <p className="dim">No audit rows match these filters yet.</p>}
      </div>
    </div>
  )
}

function Backup({ bridge, run, busy }: { bridge: NonNullable<Window['orvex']>; run: RunFn; busy: boolean }) {
  const [items, setItems] = useState<OrvexSecurityBackup[]>([])
  const [note, setNote] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [restorePass, setRestorePass] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await bridge.security.backups()
    if (res.ok) setItems(res.data)
  }, [bridge])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="sec-stack">
      <section className="sec-card">
        <div className="sec-card-head">
          <FileArchive size={14} />
          <h3>Create a backup</h3>
        </div>
        <p className="dim">
          Copies the database (taken with SQLite's own backup call), preferences, permissions, workflow definitions and run
          history, integrations, MCP config and the encrypted secret store into one zip.
        </p>
        <div className="sec-form">
          <label>
            Note
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Before a big change" />
          </label>
          <label>
            Passphrase (optional)
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Encrypts the zip with AES-256-GCM"
              autoComplete="new-password"
            />
          </label>
          <button
            className="ghost-btn"
            disabled={busy || (passphrase.length > 0 && passphrase.length < 8)}
            onClick={() =>
              void run(async () => {
                const res = await bridge.security.createBackup({ note: note || undefined, passphrase: passphrase || undefined })
                if (res.ok) {
                  setNote('')
                  setPassphrase('')
                  setNotice(`Backup created: ${res.data.name} (${bytes(res.data.size)}${res.data.encrypted ? ', encrypted' : ''})`)
                  await load()
                }
                return res
              }, 'Backup created')
            }
          >
            Create backup
          </button>
          {passphrase && passphrase.length < 8 && <p className="dim">A passphrase needs at least 8 characters.</p>}
        </div>
      </section>

      <section className="sec-card">
        <div className="sec-card-head">
          <Database size={14} />
          <h3>Backups</h3>
          <span className="sec-chip">{items.length}</span>
        </div>
        {notice && <p className="sec-notice">{notice}</p>}
        <p className="dim">Restoring stages the files and applies them the next time ORVEX starts. The current files are kept in a pre-restore folder first.</p>
        {items.length === 0 && <p className="dim">No backups yet.</p>}
        <div className="sec-backups">
          {items.map((b) => (
            <div className="sec-backup" key={b.id}>
              <div className="sec-backup-main">
                <strong>{b.name}</strong>
                <span className="dim">
                  {bytes(b.size)} · {new Date(b.at).toLocaleString()}
                </span>
              </div>
              <span className={`sec-chip ${b.encrypted ? 'ok' : ''}`}>{b.encrypted ? 'encrypted' : 'plain zip'}</span>
              {b.encrypted && (
                <input
                  type="password"
                  className="sec-restore-pass"
                  placeholder="Passphrase"
                  value={restorePass[b.id] || ''}
                  onChange={(e) => setRestorePass({ ...restorePass, [b.id]: e.target.value })}
                  autoComplete="off"
                />
              )}
              <button
                className="ghost-btn"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const res = await bridge.security.restoreBackup(b.id, restorePass[b.id] || undefined)
                    if (res.ok) {
                      setRestorePass({ ...restorePass, [b.id]: '' })
                      setNotice(`Restore staged (${res.data.files} files). Restart ORVEX to apply it.`)
                    }
                    return res
                  }, 'Restore staged — restart ORVEX to apply')
                }
              >
                Restore
              </button>
              {confirmDelete === b.id ? (
                <button
                  className="sec-danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const res = await bridge.security.deleteBackup(b.id)
                      if (res.ok) {
                        setConfirmDelete(null)
                        await load()
                      }
                      return res
                    }, 'Backup deleted')
                  }
                >
                  Confirm delete
                </button>
              ) : (
                <button className="ghost-btn" disabled={busy} onClick={() => setConfirmDelete(b.id)}>
                  <Trash2 size={11} /> Delete
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function Privacy({ bridge, run, busy, notify }: { bridge: NonNullable<Window['orvex']>; run: RunFn; busy: boolean; notify: (m: string) => void }) {
  const [confirm, setConfirm] = useState<string | null>(null)
  const [last, setLast] = useState<string | null>(null)

  const clearData = (what: 'audit' | 'runs' | 'usage' | 'memory' | 'media' | 'research' | 'workflows' | 'chat') => {
    setConfirm(null)
    if (what === 'chat') {
      localStorage.removeItem('orvex-conversations')
      localStorage.removeItem('orvex-notifications')
      localStorage.removeItem('orvex-goals')
      localStorage.removeItem('orvex-failures')
      setLast('Chat history and notifications cleared on this device.')
      notify('Chat history cleared')
      return
    }
    void run(async () => {
      const res = await bridge.security.clearData(what)
      if (res.ok) {
        const detail = Object.entries(res.data.removed)
          .map(([key, value]) => `${key} ${typeof value === 'number' ? value : String(value)}`)
          .join(' · ')
        setLast(`${what} cleared${detail ? ` — ${detail}` : ''}`)
      }
      return res
    }, `${what} cleared`)
  }

  const cards: { id: 'audit' | 'runs' | 'usage' | 'memory' | 'media' | 'research' | 'workflows' | 'chat'; title: string; detail: string }[] = [
    { id: 'audit', title: 'Audit trail', detail: 'Every recorded tool call and security event (the JSONL copy too).' },
    { id: 'chat', title: 'Chat history', detail: 'Conversations and notifications stored by this window.' },
    { id: 'usage', title: 'Usage and cost', detail: 'Token and cost rows recorded by the model gateway.' },
    { id: 'runs', title: 'Run history', detail: 'Persisted agent runs, steps and checkpoints.' },
    { id: 'memory', title: 'Memory', detail: 'Memory items, the search index, links, conflicts and the profile.' },
    { id: 'media', title: 'Media library', detail: 'Generated media files, the library index and saved prompts.' },
    { id: 'research', title: 'Research library', detail: 'Saved research reports.' },
    { id: 'workflows', title: 'Workflow runs', detail: 'Run history; workflow definitions are kept.' },
  ]

  return (
    <div className="sec-stack">
      <p className="dim">
        ORVEX has no telemetry and no analytics. Everything below lives in this app's data folder on this PC; clearing it is a real
        delete, not a hidden flag.
      </p>
      {last && <p className="sec-notice">{last}</p>}
      <div className="sec-grid">
        {cards.map((card) => (
          <section className="sec-card" key={card.id}>
            <div className="sec-card-head">
              <Trash2 size={14} />
              <h3>{card.title}</h3>
            </div>
            <p className="dim">{card.detail}</p>
            {confirm === card.id ? (
              <div className="sec-row">
                <button className="sec-danger" disabled={busy} onClick={() => clearData(card.id)}>
                  Yes, delete it
                </button>
                <button className="ghost-btn" onClick={() => setConfirm(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button className="ghost-btn" disabled={busy} onClick={() => setConfirm(card.id)}>
                Clear {card.title.toLowerCase()}
              </button>
            )}
          </section>
        ))}
      </div>
      <section className="sec-card">
        <div className="sec-card-head">
          <ShieldAlert size={14} />
          <h3>What ORVEX keeps off this PC</h3>
        </div>
        <p className="dim">
          Nothing is uploaded to us: there is no ORVEX account and no sync. Model requests go only to the providers you configure,
          and integration calls go only to the servers you add. Remote MCP tools receive what you ask them to run.
        </p>
      </section>
    </div>
  )
}
