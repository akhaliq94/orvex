import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  ArrowDownToLine,
  Boxes,
  Check,
  Copy,
  Database,
  Globe2,
  KeyRound,
  Loader2,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Send,
  Server,
  Shield,
  ShieldAlert,
  Square,
  Trash2,
  Webhook,
  X,
} from 'lucide-react'
import PageShell from './PageShell'
import type {
  IpcResult,
  OrvexConnector,
  OrvexConnectorPreview,
  OrvexConnectorResult,
  OrvexHttpResult,
  OrvexIntegrationConnection,
  OrvexIntegrationHealth,
  OrvexIntegrationKind,
  OrvexIntegrationRun,
  OrvexMcpServerStatus,
  OrvexOAuthAccount,
  OrvexOAuthFlow,
  OrvexOAuthState,
  OrvexPermissionsState,
  OrvexWebhookEvent,
  OrvexWebhookStatus,
  OrvexWsResult,
} from '../types/desktop'
import './integrations.css'

type Props = { onBack: () => void; notify: (msg: string) => void }

type Tab = 'connections' | 'connectors' | 'rest' | 'websocket' | 'webhooks' | 'oauth' | 'mcp' | 'permissions'

const TABS: { id: Tab; label: string; icon: typeof Plug }[] = [
  { id: 'connections', label: 'Connections', icon: Plug },
  { id: 'connectors', label: 'API connectors', icon: Boxes },
  { id: 'rest', label: 'REST', icon: Globe2 },
  { id: 'websocket', label: 'WebSocket', icon: Activity },
  { id: 'webhooks', label: 'Webhooks', icon: Webhook },
  { id: 'oauth', label: 'OAuth', icon: KeyRound },
  { id: 'mcp', label: 'MCP server', icon: Server },
  { id: 'permissions', label: 'Permissions', icon: Shield },
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

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      document.body.removeChild(area)
      return true
    } catch {
      return false
    }
  }
}

const METHOD_OPTIONS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

export default function IntegrationsPage({ onBack, notify }: Props) {
  const [tab, setTab] = useState<Tab>('connections')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [connections, setConnections] = useState<OrvexIntegrationConnection[]>([])
  const [kinds, setKinds] = useState<OrvexIntegrationKind[]>([])
  const [health, setHealth] = useState<OrvexIntegrationHealth | null>(null)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [formKind, setFormKind] = useState('github')
  const [formLabel, setFormLabel] = useState('')
  const [formConfig, setFormConfig] = useState<Record<string, string>>({})
  const [formSecrets, setFormSecrets] = useState<Record<string, string>>({})

  const [activeId, setActiveId] = useState<string | null>(null)
  const [actionId, setActionId] = useState('')
  const [actionArgs, setActionArgs] = useState<Record<string, string>>({})
  const [runResult, setRunResult] = useState<OrvexIntegrationRun | null>(null)
  const [runError, setRunError] = useState<string | null>(null)

  const [restMethod, setRestMethod] = useState('GET')
  const [restUrl, setRestUrl] = useState('https://api.github.com/zen')
  const [restHeaders, setRestHeaders] = useState('')
  const [restBody, setRestBody] = useState('')
  const [restResult, setRestResult] = useState<OrvexHttpResult | null>(null)
  const [restError, setRestError] = useState<string | null>(null)

  const [wsUrl, setWsUrl] = useState('')
  const [wsMessage, setWsMessage] = useState('')
  const [wsCount, setWsCount] = useState('20')
  const [wsTimeout, setWsTimeout] = useState('15000')
  const [wsResult, setWsResult] = useState<OrvexWsResult | null>(null)
  const [wsError, setWsError] = useState<string | null>(null)

  const [hook, setHook] = useState<OrvexWebhookStatus | null>(null)
  const [hookEvents, setHookEvents] = useState<OrvexWebhookEvent[]>([])

  const [oauthState, setOauthState] = useState<OrvexOAuthState | null>(null)
  const [oauthMode, setOauthMode] = useState<'device' | 'pkce'>('device')
  const [oauthProvider, setOauthProvider] = useState('google')
  const [oauthClientId, setOauthClientId] = useState('')
  const [oauthClientSecret, setOauthClientSecret] = useState('')
  const [oauthScopes, setOauthScopes] = useState('')
  const [oauthLabel, setOauthLabel] = useState('')
  const [oauthAuthUrl, setOauthAuthUrl] = useState('')
  const [oauthTokenUrl, setOauthTokenUrl] = useState('')
  const [oauthDeviceUrl, setOauthDeviceUrl] = useState('')
  const [oauthUserinfoUrl, setOauthUserinfoUrl] = useState('')
  const [oauthFlow, setOauthFlow] = useState<OrvexOAuthFlow | null>(null)
  const [oauthError, setOauthError] = useState<string | null>(null)
  const [oauthChecks, setOauthChecks] = useState<Record<string, string>>({})

  const [mcp, setMcp] = useState<OrvexMcpServerStatus | null>(null)

  const [perms, setPerms] = useState<OrvexPermissionsState | null>(null)
  const [permFilter, setPermFilter] = useState('')
  const [permSource, setPermSource] = useState('all')

  const [connectors, setConnectors] = useState<OrvexConnector[]>([])
  const [connEditor, setConnEditor] = useState(false)
  const [connEditId, setConnEditId] = useState<string | null>(null)
  const [connLabel, setConnLabel] = useState('')
  const [connUrl, setConnUrl] = useState('')
  const [connSpec, setConnSpec] = useState('')
  const [connBase, setConnBase] = useState('')
  const [connAuthType, setConnAuthType] = useState<'none' | 'bearer' | 'header' | 'query'>('none')
  const [connAuthName, setConnAuthName] = useState('')
  const [connSecret, setConnSecret] = useState('')
  const [connPreview, setConnPreview] = useState<OrvexConnectorPreview | null>(null)
  const [connOpen, setConnOpen] = useState<string | null>(null)
  const [connRun, setConnRun] = useState<{ connector: string; operation: string; args: string } | null>(null)
  const [connResult, setConnResult] = useState<OrvexConnectorResult | null>(null)

  const loadConnections = useCallback(async () => {
    if (!bridge?.integrations) return
    const data = await required(bridge.integrations.list())
    setConnections(data.connections)
    setKinds(data.schema.kinds)
  }, [])

  const loadHealth = useCallback(async () => {
    if (!bridge?.integrations) return
    setHealth(await required(bridge.integrations.health()))
  }, [])

  const loadHook = useCallback(async () => {
    if (!bridge?.integrations) return
    const status = await required(bridge.integrations.webhook({ op: 'status' })) as OrvexWebhookStatus
    setHook(status)
    const events = await required(bridge.integrations.webhook({ op: 'events', limit: 30 })) as OrvexWebhookStatus & { events?: OrvexWebhookEvent[] }
    setHookEvents(events.events || [])
  }, [])

  const loadOauth = useCallback(async () => {
    if (!bridge?.oauth) return
    const state = await required(bridge.oauth.state())
    setOauthState(state)
    const pending = state.flows.find((f) => f.status === 'pending')
    if (pending) setOauthFlow(pending)
  }, [])

  const loadMcp = useCallback(async () => {
    if (!bridge?.mcpServer) return
    setMcp(await required(bridge.mcpServer.status()))
  }, [])

  const loadPerms = useCallback(async () => {
    if (!bridge?.permissions) return
    setPerms(await required(bridge.permissions.state()))
  }, [])

  const loadConnectors = useCallback(async () => {
    if (!bridge?.connectors) return
    const data = await required(bridge.connectors.list())
    setConnectors(data.connectors)
  }, [])

  const refreshAll = useCallback(async () => {
    setBusy('refresh')
    setError(null)
    try {
      await Promise.all([loadConnections(), loadHealth(), loadOauth(), loadMcp(), loadPerms(), loadConnectors()])
      await loadHook()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }, [loadConnections, loadHealth, loadHook, loadMcp, loadOauth, loadPerms, loadConnectors])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  useEffect(() => {
    if (!bridge) return
    const offs = [
      bridge.integrations?.onChange(() => {
        void loadConnections()
        void loadHealth()
        void loadHook()
      }),
      bridge.oauth?.onChange(() => void loadOauth()),
      bridge.mcpServer?.onChange(() => void loadMcp()),
      bridge.connectors?.onChange(() => void loadConnectors()),
    ]
    return () => offs.forEach((off) => off && off())
  }, [loadConnections, loadHealth, loadHook, loadMcp, loadOauth, loadConnectors])

  useEffect(() => {
    const flow = oauthFlow
    if (!flow || flow.status !== 'pending') return
    const timer = window.setInterval(async () => {
      try {
        const next = await required(bridge?.oauth?.flow(flow.id))
        setOauthFlow(next)
        if (next.status !== 'pending') {
          setOauthFlow(next)
          void loadOauth()
          void loadMcp()
        }
      } catch {
        setOauthFlow((prev) => (prev && prev.id === flow.id ? { ...prev, status: 'error', error: 'The flow could not be checked.' } : prev))
      }
    }, 1800)
    return () => window.clearInterval(timer)
  }, [oauthFlow, loadOauth, loadMcp])

  useEffect(() => {
    if (tab !== 'webhooks') return
    void loadHook().catch((err) => setError(messageOf(err)))
  }, [tab, loadHook])

  const kindOf = (id: string) => kinds.find((k) => k.id === id)
  const formKindMeta = kindOf(formKind)

  const openCreate = () => {
    const first = kinds[0]
    setEditId(null)
    setFormKind(first?.id || 'github')
    setFormLabel('')
    setFormConfig({})
    setFormSecrets({})
    setEditorOpen(true)
  }

  const openEdit = (conn: OrvexIntegrationConnection) => {
    setEditId(conn.id)
    setFormKind(conn.kind)
    setFormLabel(conn.label)
    setFormConfig({ ...conn.config })
    setFormSecrets({})
    setEditorOpen(true)
  }

  const saveConnection = async () => {
    if (!formKindMeta) return
    setBusy('save')
    setError(null)
    try {
      await required(
        bridge?.integrations?.save({
          id: editId || undefined,
          kind: formKind,
          label: formLabel.trim() || formKindMeta.label,
          config: formConfig,
          secrets: formSecrets,
        }),
      )
      setEditorOpen(false)
      await loadConnections()
      await loadHealth()
      notify(editId ? 'Connection updated.' : 'Connection saved.')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const removeConnection = async (conn: OrvexIntegrationConnection) => {
    if (!window.confirm(`Delete the "${conn.label}" connection and its saved secrets?`)) return
    setBusy(`delete-${conn.id}`)
    try {
      await required(bridge?.integrations?.remove(conn.id))
      if (activeId === conn.id) setActiveId(null)
      await loadConnections()
      await loadHealth()
      notify('Connection deleted.')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const testConnection = async (conn: OrvexIntegrationConnection) => {
    setBusy(`test-${conn.id}`)
    setError(null)
    try {
      const result = await required(bridge?.integrations?.test(conn.id))
      notify(result.output)
      await loadConnections()
      await loadHealth()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const startAction = (conn: OrvexIntegrationConnection) => {
    const meta = kindOf(conn.kind)
    setActiveId(conn.id)
    setActionId(meta?.actions[0]?.id || '')
    setActionArgs({})
    setRunResult(null)
    setRunError(null)
  }

  const runAction = async () => {
    if (!activeId || !actionId) return
    setBusy('run')
    setRunError(null)
    try {
      const result = await required(bridge?.integrations?.run({ id: activeId, action: actionId, args: actionArgs }))
      setRunResult(result)
    } catch (err) {
      setRunError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const sendRest = async () => {
    setBusy('rest')
    setRestError(null)
    try {
      let headers: Record<string, string> = {}
      if (restHeaders.trim()) {
        try {
          headers = JSON.parse(restHeaders) as Record<string, string>
        } catch {
          throw new Error('Headers must be a JSON object, for example {"accept":"application/json"}.')
        }
      }
      const result = await required(
        bridge?.integrations?.http({
          method: restMethod,
          url: restUrl,
          headers,
          body: ['GET', 'HEAD'].includes(restMethod) ? undefined : restBody,
        }),
      )
      setRestResult(result)
    } catch (err) {
      setRestError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const sendWs = async () => {
    setBusy('ws')
    setWsError(null)
    try {
      const result = await required(
        bridge?.integrations?.ws({
          url: wsUrl,
          message: wsMessage.trim() || undefined,
          messages: Number(wsCount) || 20,
          timeoutMs: Number(wsTimeout) || 15000,
        }),
      )
      setWsResult(result)
    } catch (err) {
      setWsError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const hookOp = async (op: 'start' | 'stop' | 'clear' | 'test') => {
    setBusy(`hook-${op}`)
    setError(null)
    try {
      const result = await required(bridge?.integrations?.webhook({ op, port: undefined }))
      if (op === 'test') notify((result as { output?: string }).output || 'Test delivery received.')
      await loadHook()
      await loadHealth()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const startOauth = async () => {
    const provider = oauthState?.providers.find((p) => p.id === oauthProvider)
    if (!provider) return
    setBusy('oauth')
    setOauthError(null)
    setOauthFlow(null)
    try {
      const scopes = oauthScopes.trim() ? oauthScopes.split(/[\s,]+/).filter(Boolean) : undefined
      const base = {
        provider: oauthProvider,
        clientId: oauthClientId.trim(),
        clientSecret: oauthClientSecret || undefined,
        scopes,
        label: oauthLabel.trim() || undefined,
        userinfoUrl: oauthUserinfoUrl.trim() || undefined,
      }
      const flow =
        oauthMode === 'device'
          ? await required(
              bridge?.oauth?.device({
                ...base,
                deviceUrl: oauthDeviceUrl.trim() || undefined,
                tokenUrl: oauthTokenUrl.trim() || undefined,
              }),
            )
          : await required(
              bridge?.oauth?.pkce({
                ...base,
                authUrl: oauthAuthUrl.trim() || undefined,
                tokenUrl: oauthTokenUrl.trim() || undefined,
              }),
            )
      setOauthFlow(flow)
      await loadOauth()
    } catch (err) {
      setOauthError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const cancelOauth = async (id: string) => {
    try {
      const flow = await required(bridge?.oauth?.cancel(id))
      setOauthFlow(flow)
      await loadOauth()
    } catch (err) {
      setOauthError(messageOf(err))
    }
  }

  const removeAccount = async (account: OrvexOAuthAccount) => {
    if (!window.confirm(`Remove the OAuth account "${account.label}" and its tokens?`)) return
    try {
      await required(bridge?.oauth?.remove(account.id))
      await loadOauth()
      notify('OAuth account removed.')
    } catch (err) {
      setOauthError(messageOf(err))
    }
  }

  const checkAccount = async (account: OrvexOAuthAccount) => {
    setBusy(`check:${account.id}`)
    setOauthError(null)
    try {
      const result = await required(bridge?.oauth?.check(account.id))
      const mins = result.expiresIn != null ? Math.round(result.expiresIn / 60) : null
      setOauthChecks((prev) => ({
        ...prev,
        [account.id]: result.refreshed
          ? `Token refreshed${mins ? `, valid for ~${mins} min` : ''}.`
          : `Token is valid${mins ? ` for ~${mins} min` : ''}.`,
      }))
      await loadOauth()
    } catch (err) {
      setOauthChecks((prev) => ({ ...prev, [account.id]: messageOf(err) }))
    } finally {
      setBusy(null)
    }
  }

  const toggleMcp = async (start: boolean) => {
    setBusy('mcp')
    setError(null)
    try {
      if (start) await required(bridge?.mcpServer?.start({}))
      else await required(bridge?.mcpServer?.stop())
      await loadMcp()
      notify(start ? 'MCP server started on 127.0.0.1.' : 'MCP server stopped.')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const setAllowRisky = async (allow: boolean) => {
    try {
      setMcp(await required(bridge?.mcpServer?.setAllowRisky(allow)))
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const setPolicy = async (tool: string, policy: 'allow' | 'ask' | 'deny' | 'default') => {
    try {
      setPerms(await required(bridge?.permissions?.set(tool, policy)))
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const resetPolicies = async () => {
    if (!window.confirm('Reset every tool permission back to its default?')) return
    try {
      setPerms(await required(bridge?.permissions?.reset()))
      notify('Tool permissions reset.')
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const resetConnForm = () => {
    setConnEditId(null)
    setConnLabel('')
    setConnUrl('')
    setConnSpec('')
    setConnBase('')
    setConnAuthType('none')
    setConnAuthName('')
    setConnSecret('')
    setConnPreview(null)
  }

  const openConnCreate = () => {
    resetConnForm()
    setConnEditor(true)
  }

  const openConnEdit = (conn: OrvexConnector) => {
    setConnEditId(conn.id)
    setConnLabel(conn.label)
    setConnUrl('')
    setConnSpec('')
    setConnBase(conn.baseUrl)
    setConnAuthType(conn.auth.type)
    setConnAuthName(conn.auth.name)
    setConnSecret('')
    setConnPreview(null)
    setConnEditor(true)
  }

  const previewConn = async () => {
    setBusy('conn-preview')
    setError(null)
    try {
      const payload = connSpec.trim() ? { spec: connSpec, sourceUrl: connUrl.trim() } : { url: connUrl.trim() }
      const data = await required(bridge?.connectors?.preview(payload))
      setConnPreview(data)
      if (!connLabel.trim() && data.title) setConnLabel(data.title)
      if (!connBase.trim() && data.baseUrl) setConnBase(data.baseUrl)
      notify(`${data.ops.length} operation(s) found in ${data.format === 'openapi' ? 'OpenAPI' : 'Swagger'} ${data.version}.`)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const saveConn = async () => {
    setBusy('conn-save')
    setError(null)
    try {
      const payload: Parameters<NonNullable<typeof bridge>['connectors']['save']>[0] = {
        id: connEditId || undefined,
        label: connLabel.trim(),
        baseUrl: connBase.trim() || undefined,
        auth: { type: connAuthType, name: connAuthName.trim() },
      }
      if (connSecret.trim()) payload.secret = connSecret
      if (connSpec.trim()) payload.spec = connSpec
      else if (connUrl.trim()) payload.url = connUrl.trim()
      const saved = await required(bridge?.connectors?.save(payload))
      await loadConnectors()
      setConnEditor(false)
      resetConnForm()
      notify(`Saved connector "${saved.label}" with ${saved.operationCount} operation(s).`)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const removeConn = async (conn: OrvexConnector) => {
    if (!window.confirm(`Delete the connector "${conn.label}" and its stored secret?`)) return
    try {
      await required(bridge?.connectors?.remove(conn.id))
      await loadConnectors()
      notify('Connector deleted.')
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const testConn = async (conn: OrvexConnector) => {
    setBusy(`conn-test:${conn.id}`)
    setError(null)
    try {
      const result = await required(bridge?.connectors?.test(conn.id))
      setConnResult(result)
      notify(result.ok ? `${conn.label} responded.` : `${conn.label} test failed.`)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const runConnOp = async () => {
    if (!connRun) return
    setBusy('conn-run')
    setError(null)
    try {
      let args: Record<string, unknown> = {}
      if (connRun.args.trim()) {
        try {
          args = JSON.parse(connRun.args)
        } catch {
          throw new Error('Arguments must be valid JSON, e.g. {"path":{"id":"42"},"query":{"limit":10}}.')
        }
      }
      const result = await required(bridge?.connectors?.call({ connector: connRun.connector, operation: connRun.operation, args }))
      setConnResult(result)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const copy = async (text: string, what: string) => {
    const ok = await copyText(text)
    notify(ok ? `${what} copied.` : 'Could not copy to the clipboard.')
  }

  const active = connections.find((c) => c.id === activeId) || null
  const activeMeta = active ? kindOf(active.kind) : null
  const activeAction = activeMeta?.actions.find((a) => a.id === actionId) || null
  const healthOf = (id: string) => health?.connections.find((h) => h.id === id) || null

  const filteredTools = (perms?.tools || []).filter((t) => {
    if (permSource !== 'all' && t.source !== permSource) return false
    const q = permFilter.trim().toLowerCase()
    return !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
  })

  return (
    <PageShell
      title="Integrations"
      sub="Real GitHub, email, calendar, database, storage and OAuth connections, REST/WebSocket tools, webhooks, an MCP server and per-tool permissions"
      onBack={onBack}
      actions={
        <>
          <button className="btn-ghost ig-head-btn" onClick={() => void refreshAll()} disabled={!!busy} title="Reload everything">
            {busy === 'refresh' ? <Loader2 size={13} className="ig-spin" /> : <RefreshCw size={13} />} Refresh
          </button>
        </>
      }
    >
      <div className="ig-page">
        <div className="dc-tabs ig-tabs">
          {TABS.map((t) => {
            const Icon = t.icon
            return (
              <button key={t.id} className={`dc-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
                <Icon size={13} /> {t.label}
              </button>
            )
          })}
        </div>

        {error && (
          <div className="dc-error">
            <ShieldAlert size={13} />
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss error"><X size={12} /></button>
          </div>
        )}

        {tab === 'connections' && (
          <div className="dc-tab-body">
            <div className="dc-toolbar">
              <button className="btn-primary dc-btn" onClick={openCreate} disabled={!kinds.length}>
                <Plus size={12} /> New connection
              </button>
              <span className="dc-muted">
                {connections.length} saved · {health?.connections.filter((c) => c.state === 'ok').length || 0} healthy ·{' '}
                {health?.connections.filter((c) => c.state === 'error').length || 0} failing
              </span>
            </div>

            {editorOpen && formKindMeta && (
              <div className="ig-editor">
                <div className="ig-editor-head">
                  <strong>{editId ? 'Edit connection' : 'New connection'}</strong>
                  <button className="ig-icon-btn" onClick={() => setEditorOpen(false)} aria-label="Close editor"><X size={13} /></button>
                </div>
                {!editId && (
                  <div className="ig-kind-row">
                    {kinds.map((k) => (
                      <button
                        key={k.id}
                        className={`ig-kind ${formKind === k.id ? 'on' : ''}`}
                        onClick={() => {
                          setFormKind(k.id)
                          setFormConfig({})
                          setFormSecrets({})
                          setFormLabel('')
                        }}
                      >
                        {k.id === 'postgres' || k.id === 'sqlite' ? <Database size={13} /> : k.id === 's3' ? <ArrowDownToLine size={13} /> : <Plug size={13} />}
                        {k.label}
                      </button>
                    ))}
                  </div>
                )}
                <p className="dc-hint">{formKindMeta.hint}</p>
                <label className="ig-field">
                  <span>Label</span>
                  <input value={formLabel} onChange={(e) => setFormLabel(e.target.value)} placeholder={formKindMeta.label} />
                </label>
                <div className="ig-grid-2">
                  {formKindMeta.fields.map((field) => (
                    <label className="ig-field" key={field.key}>
                      <span>{field.label}</span>
                      <input
                        value={formConfig[field.key] ?? field.default ?? ''}
                        onChange={(e) => setFormConfig((prev) => ({ ...prev, [field.key]: e.target.value }))}
                        placeholder={field.placeholder || field.default || ''}
                      />
                    </label>
                  ))}
                  {formKindMeta.secrets.map((secret) => (
                    <label className="ig-field" key={secret.key}>
                      <span>
                        {secret.label}
                        {secret.required && !editId ? ' *' : ''}
                      </span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={formSecrets[secret.key] ?? ''}
                        onChange={(e) => setFormSecrets((prev) => ({ ...prev, [secret.key]: e.target.value }))}
                        placeholder={editId ? 'Leave blank to keep the saved value' : secret.required ? 'Required' : 'Optional'}
                      />
                    </label>
                  ))}
                </div>
                <div className="dc-toolbar">
                  <button className="btn-primary dc-btn" onClick={() => void saveConnection()} disabled={busy === 'save'}>
                    {busy === 'save' ? <Loader2 size={12} className="ig-spin" /> : <Check size={12} />} Save
                  </button>
                  <button className="btn-ghost dc-btn" onClick={() => setEditorOpen(false)}>Cancel</button>
                </div>
              </div>
            )}

            {!connections.length && !editorOpen && (
              <div className="ig-empty">
                <Plug size={22} />
                <strong>No connections yet</strong>
                <p>Add GitHub, email, a CalDAV calendar, PostgreSQL, SQLite, S3-compatible storage or Google Drive. Credentials are encrypted with Windows DPAPI.</p>
              </div>
            )}

            <div className="ig-conn-grid">
              {connections.map((conn) => {
                const meta = kindOf(conn.kind)
                const h = healthOf(conn.id)
                return (
                  <div key={conn.id} className={`ig-conn ${activeId === conn.id ? 'on' : ''}`}>
                    <div className="ig-conn-head">
                      <strong>{conn.label}</strong>
                      <span className={`dc-chip ${h?.state === 'ok' ? 'live' : h?.state === 'error' ? 'bad' : 'dim'}`}>
                        {h?.state || 'untested'}
                      </span>
                    </div>
                    <div className="ig-conn-meta">
                      <span>{meta?.label || conn.kind}</span>
                      <span className="ig-conn-id">{conn.id}</span>
                    </div>
                    {conn.lastTest && <p className="ig-conn-test">{String(conn.lastTest.output).slice(0, 180)}</p>}
                    <div className="dc-toolbar">
                      <button className="btn-ghost dc-btn" onClick={() => void testConnection(conn)} disabled={!!busy}>
                        {busy === `test-${conn.id}` ? <Loader2 size={11} className="ig-spin" /> : <Activity size={11} />} Test
                      </button>
                      <button className="btn-ghost dc-btn" onClick={() => startAction(conn)}>
                        <Play size={11} /> Actions
                      </button>
                      <button className="btn-ghost dc-btn" onClick={() => openEdit(conn)}>Edit</button>
                      <button className="btn-ghost dc-btn ig-danger" onClick={() => void removeConnection(conn)} disabled={busy === `delete-${conn.id}`}>
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>

            {active && activeMeta && (
              <div className="ig-action-panel">
                <div className="ig-editor-head">
                  <strong>{active.label} · actions</strong>
                  <button className="ig-icon-btn" onClick={() => setActiveId(null)} aria-label="Close actions"><X size={13} /></button>
                </div>
                <div className="ig-action-row">
                  {activeMeta.actions.map((action) => (
                    <button
                      key={action.id}
                      className={`ig-kind ${actionId === action.id ? 'on' : ''}`}
                      onClick={() => {
                        setActionId(action.id)
                        setActionArgs({})
                        setRunResult(null)
                        setRunError(null)
                      }}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
                {activeAction?.fields && activeAction.fields.length > 0 && (
                  <div className="ig-grid-2">
                    {activeAction.fields.map((field) =>
                      field.type === 'textarea' ? (
                        <label className="ig-field ig-span-2" key={field.key}>
                          <span>{field.label}</span>
                          <textarea
                            rows={4}
                            value={actionArgs[field.key] ?? field.default ?? ''}
                            onChange={(e) => setActionArgs((prev) => ({ ...prev, [field.key]: e.target.value }))}
                            placeholder={field.placeholder || ''}
                          />
                        </label>
                      ) : (
                        <label className="ig-field" key={field.key}>
                          <span>{field.label}</span>
                          <input
                            value={actionArgs[field.key] ?? field.default ?? ''}
                            onChange={(e) => setActionArgs((prev) => ({ ...prev, [field.key]: e.target.value }))}
                            placeholder={field.placeholder || ''}
                          />
                        </label>
                      ),
                    )}
                  </div>
                )}
                <div className="dc-toolbar">
                  <button className="btn-primary dc-btn" onClick={() => void runAction()} disabled={busy === 'run' || !actionId}>
                    {busy === 'run' ? <Loader2 size={12} className="ig-spin" /> : <Play size={12} />} Run action
                  </button>
                </div>
                {runError && <div className="ig-output bad">{runError}</div>}
                {runResult && (
                  <div className="ig-output">
                    <div className="ig-output-head">
                      <span>{runResult.output?.split('\n')[0]?.slice(0, 140) || 'Done.'}</span>
                      <button className="ig-icon-btn" onClick={() => void copy(runResult.output || '', 'Output')} aria-label="Copy output">
                        <Copy size={11} />
                      </button>
                    </div>
                    <pre>{String(runResult.output || '').slice(0, 4000)}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {tab === 'connectors' && (
          <div className="dc-tab-body">
            <div className="dc-toolbar">
              <button className="btn-primary dc-btn" onClick={openConnCreate}>
                <Plus size={12} /> Import connector
              </button>
              <span className="dc-muted">
                {connectors.length} saved · {connectors.reduce((n, c) => n + c.operationCount, 0)} operations · the agent can call them with connector_list / connector_call
              </span>
            </div>

            {connEditor && (
              <div className="ig-editor">
                <div className="ig-editor-head">
                  <strong>{connEditId ? 'Edit connector' : 'Import OpenAPI / Swagger spec'}</strong>
                  <button className="ig-icon-btn" onClick={() => { setConnEditor(false); resetConnForm() }} aria-label="Close editor"><X size={13} /></button>
                </div>
                <p className="dc-hint">
                  Paste a spec URL or the document itself — JSON and YAML both work. The secret is stored in the encrypted vault, never in the connector file.
                </p>
                <div className="ig-grid-2">
                  <label className="ig-field">
                    <span>Label</span>
                    <input value={connLabel} onChange={(e) => setConnLabel(e.target.value)} placeholder="Stripe, Weather, Internal API…" />
                  </label>
                  <label className="ig-field">
                    <span>Spec URL</span>
                    <input value={connUrl} onChange={(e) => setConnUrl(e.target.value)} placeholder="https://example.com/openapi.json or .yaml" />
                  </label>
                </div>
                <label className="ig-field">
                  <span>Or paste the spec (JSON or YAML)</span>
                  <textarea rows={5} value={connSpec} onChange={(e) => setConnSpec(e.target.value)} placeholder='{"openapi":"3.0.0", …}' />
                </label>
                <div className="ig-grid-2">
                  <label className="ig-field">
                    <span>Base URL override (optional)</span>
                    <input value={connBase} onChange={(e) => setConnBase(e.target.value)} placeholder="https://api.example.com/v1" />
                  </label>
                  <label className="ig-field">
                    <span>Auth</span>
                    <select value={connAuthType} onChange={(e) => setConnAuthType(e.target.value as typeof connAuthType)}>
                      <option value="none">None</option>
                      <option value="bearer">Bearer token</option>
                      <option value="header">Custom header</option>
                      <option value="query">Query parameter</option>
                    </select>
                  </label>
                </div>
                {connAuthType !== 'none' && (
                  <div className="ig-grid-2">
                    <label className="ig-field">
                      <span>{connAuthType === 'header' ? 'Header name (e.g. X-API-Key)' : connAuthType === 'query' ? 'Query parameter name' : 'Token header'}</span>
                      <input value={connAuthType === 'bearer' ? 'Authorization' : connAuthName} onChange={(e) => setConnAuthName(e.target.value)} disabled={connAuthType === 'bearer'} placeholder={connAuthType === 'bearer' ? 'Authorization' : 'X-API-Key'} />
                    </label>
                    <label className="ig-field">
                      <span>{connEditId ? 'New secret (blank keeps the saved one)' : 'Secret'}</span>
                      <input type="password" value={connSecret} onChange={(e) => setConnSecret(e.target.value)} placeholder="Stored in the encrypted vault" autoComplete="off" />
                    </label>
                  </div>
                )}
                {connPreview && (
                  <div className="ig-editor">
                    <div className="ig-editor-head">
                      <strong>{connPreview.title || 'Untitled spec'}</strong>
                      <span className="dc-muted">{connPreview.format} {connPreview.version} · {connPreview.ops.length} ops{connPreview.truncated ? ' · truncated' : ''} · {connPreview.baseUrl}</span>
                    </div>
                    <div className="ig-conn-ops">
                      {connPreview.ops.slice(0, 12).map((op) => (
                        <div className="ig-conn-op" key={op.id}>
                          <span className={`ig-method ${op.method.toLowerCase()}`}>{op.method}</span>
                          <code>{op.path}</code>
                          <span className="dc-muted">{op.summary}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="dc-toolbar">
                  <button className="btn-ghost dc-btn" onClick={() => void previewConn()} disabled={busy === 'conn-preview' || (!connUrl.trim() && !connSpec.trim())}>
                    {busy === 'conn-preview' ? <Loader2 size={12} className="ig-spin" /> : <Search size={12} />} Preview
                  </button>
                  <button className="btn-primary dc-btn" onClick={() => void saveConn()} disabled={busy === 'conn-save' || !connLabel.trim() || (!connSpec.trim() && !connUrl.trim() && !connEditId)}>
                    {busy === 'conn-save' ? <Loader2 size={12} className="ig-spin" /> : <Check size={12} />} {connEditId ? 'Save changes' : 'Import & save'}
                  </button>
                </div>
              </div>
            )}

            {connRun && (() => {
              const conn = connectors.find((c) => c.id === connRun.connector)
              const op = conn?.ops.find((o) => o.id === connRun.operation)
              return (
                <div className="ig-editor">
                  <div className="ig-editor-head">
                    <strong>Run {conn?.label} · {connRun.operation}</strong>
                    <button className="ig-icon-btn" onClick={() => setConnRun(null)} aria-label="Close runner"><X size={13} /></button>
                  </div>
                  {op && (
                    <p className="dc-hint">
                      <b>{op.method}</b> {op.path}{op.params.length ? ` · params: ${op.params.map((p) => `${p.name}${p.required ? '*' : ''} (${p.in})`).join(', ')}` : ''}{op.body ? ` · body: ${op.body.properties.map((p) => `${p.name}${p.required ? '*' : ''}`).join(', ') || 'JSON'}` : ''}
                    </p>
                  )}
                  <label className="ig-field">
                    <span>Arguments (JSON)</span>
                    <textarea rows={5} value={connRun.args} onChange={(e) => setConnRun({ ...connRun, args: e.target.value })} placeholder='{"path":{"id":"42"},"query":{"limit":10},"body":{"name":"demo"}}' />
                  </label>
                  <div className="dc-toolbar">
                    <button className="btn-primary dc-btn" onClick={() => void runConnOp()} disabled={busy === 'conn-run'}>
                      {busy === 'conn-run' ? <Loader2 size={12} className="ig-spin" /> : <Play size={12} />} Call endpoint
                    </button>
                    {op && !['GET', 'HEAD'].includes(op.method) && <span className="dc-muted">Non-GET calls need approval when the agent runs them.</span>}
                  </div>
                </div>
              )
            })()}

            <div className="ig-conn-list">
              {connectors.map((conn) => (
                <div className="ig-editor" key={conn.id}>
                  <div className="ig-editor-head">
                    <strong>{conn.label}</strong>
                    <span className="dc-muted">{conn.operationCount} ops · {conn.auth.type}{conn.secretSet ? ' · secret set' : ''} · {conn.baseUrl}</span>
                  </div>
                  <div className="dc-toolbar">
                    <button className="btn-ghost dc-btn" onClick={() => void testConn(conn)} disabled={busy === `conn-test:${conn.id}`}>
                      {busy === `conn-test:${conn.id}` ? <Loader2 size={12} className="ig-spin" /> : <Activity size={12} />} Test
                    </button>
                    <button className="btn-ghost dc-btn" onClick={() => setConnOpen(connOpen === conn.id ? null : conn.id)}>
                      {connOpen === conn.id ? 'Hide operations' : 'Show operations'}
                    </button>
                    <button className="btn-ghost dc-btn" onClick={() => openConnEdit(conn)}>Edit</button>
                    <button className="btn-ghost dc-btn" onClick={() => void removeConn(conn)}><Trash2 size={11} /> Delete</button>
                  </div>
                  {connOpen === conn.id && (
                    <div className="ig-conn-ops">
                      {conn.ops.map((op) => (
                        <button className="ig-conn-op ig-conn-op-btn" key={op.id} onClick={() => { setConnRun({ connector: conn.id, operation: op.id, args: '{}' }); setConnResult(null) }}>
                          <span className={`ig-method ${op.method.toLowerCase()}`}>{op.method}</span>
                          <code>{op.id}</code>
                          <span className="dc-muted">{op.path} — {op.summary}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {!connectors.length && !connEditor && (
                <div className="ig-empty">
                  <Boxes size={20} />
                  <strong>No API connectors</strong>
                  <p>Import an OpenAPI 3 or Swagger 2 JSON spec to expose it to you and the agent as a real, guarded API.</p>
                </div>
              )}
            </div>

            {connResult && (
              <div className={`ig-output ${connResult.ok ? '' : 'bad'}`}>
                <pre>{connResult.output || connResult.error || (connResult.ok ? 'Request completed.' : 'Request failed.')}</pre>
              </div>
            )}
          </div>
        )}

        {tab === 'rest' && (
          <div className="dc-tab-body">
            <div className="ig-editor">
              <div className="ig-editor-head">
                <strong>HTTP request</strong>
                <span className="dc-muted">Real request from this PC · 4 MB response cap</span>
              </div>
              <div className="ig-rest-line">
                <select value={restMethod} onChange={(e) => setRestMethod(e.target.value)}>
                  {METHOD_OPTIONS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <input value={restUrl} onChange={(e) => setRestUrl(e.target.value)} placeholder="https://api.example.com/items" />
                <button className="btn-primary dc-btn" onClick={() => void sendRest()} disabled={busy === 'rest' || !restUrl.trim()}>
                  {busy === 'rest' ? <Loader2 size={12} className="ig-spin" /> : <Send size={12} />} Send
                </button>
              </div>
              <div className="ig-grid-2">
                <label className="ig-field">
                  <span>Headers (JSON)</span>
                  <textarea
                    rows={4}
                    value={restHeaders}
                    onChange={(e) => setRestHeaders(e.target.value)}
                    placeholder={'{"accept": "application/json"}'}
                  />
                </label>
                <label className="ig-field">
                  <span>Body</span>
                  <textarea
                    rows={4}
                    value={restBody}
                    onChange={(e) => setRestBody(e.target.value)}
                    placeholder={'{"name": "value"}'}
                    disabled={['GET', 'HEAD'].includes(restMethod)}
                  />
                </label>
              </div>
            </div>
            {restError && <div className="ig-output bad">{restError}</div>}
            {restResult && (
              <div className="ig-editor">
                <div className="ig-editor-head">
                  <strong>
                    <span className={`ig-status ${restResult.ok ? 'ok' : 'bad'}`}>{restResult.status}</span> {restResult.statusText || ''}
                  </strong>
                  <span className="dc-muted">{restResult.bytes} bytes · {restResult.ms} ms{restResult.truncated ? ' · truncated' : ''}</span>
                </div>
                <div className="ig-kv-table">
                  {Object.entries(restResult.headers).map(([k, v]) => (
                    <div key={k}><b>{k}</b><span>{v}</span></div>
                  ))}
                </div>
                <pre className="ig-pre">{restResult.json ? JSON.stringify(restResult.json, null, 2).slice(0, 20000) : restResult.body.slice(0, 20000)}</pre>
              </div>
            )}
          </div>
        )}

        {tab === 'websocket' && (
          <div className="dc-tab-body">
            <div className="ig-editor">
              <div className="ig-editor-head">
                <strong>WebSocket session</strong>
                <span className="dc-muted">Connects, sends one message (optional) and collects replies</span>
              </div>
              <label className="ig-field">
                <span>URL</span>
                <input value={wsUrl} onChange={(e) => setWsUrl(e.target.value)} placeholder="wss://echo.websocket.events" />
              </label>
              <div className="ig-grid-2">
                <label className="ig-field">
                  <span>Message to send (optional)</span>
                  <textarea rows={3} value={wsMessage} onChange={(e) => setWsMessage(e.target.value)} placeholder={'{"ping": true}'} />
                </label>
                <div className="ig-grid-2">
                  <label className="ig-field">
                    <span>Messages to collect</span>
                    <input value={wsCount} onChange={(e) => setWsCount(e.target.value)} inputMode="numeric" />
                  </label>
                  <label className="ig-field">
                    <span>Timeout (ms)</span>
                    <input value={wsTimeout} onChange={(e) => setWsTimeout(e.target.value)} inputMode="numeric" />
                  </label>
                </div>
              </div>
              <div className="dc-toolbar">
                <button className="btn-primary dc-btn" onClick={() => void sendWs()} disabled={busy === 'ws' || !wsUrl.trim()}>
                  {busy === 'ws' ? <Loader2 size={12} className="ig-spin" /> : <Activity size={12} />} Connect
                </button>
              </div>
            </div>
            {wsError && <div className="ig-output bad">{wsError}</div>}
            {wsResult && (
              <div className="ig-editor">
                <div className="ig-editor-head">
                  <strong>{wsResult.messages.length} message(s)</strong>
                  <span className="dc-muted">{wsResult.ms} ms · closed: {wsResult.closedBy}</span>
                </div>
                <pre className="ig-pre">{wsResult.messages.map((m) => (typeof m === 'string' ? m : JSON.stringify(m, null, 2))).join('\n\n').slice(0, 20000)}</pre>
              </div>
            )}
          </div>
        )}

        {tab === 'webhooks' && (
          <div className="dc-tab-body">
            <div className="ig-editor">
              <div className="ig-editor-head">
                <strong>Loopback webhook receiver</strong>
                <span className={`dc-chip ${hook?.running ? 'live' : 'dim'}`}>{hook?.running ? 'running' : 'stopped'}</span>
              </div>
              <p className="dc-hint">
                Any service on this PC can POST to the URL below. Every delivery is recorded and the last 100 stay in memory; events are also appended to webhook-events.jsonl.
              </p>
              {hook?.url && (
                <div className="ig-copy-row">
                  <code>{hook.url}</code>
                  <button className="btn-ghost dc-btn" onClick={() => void copy(hook.url || '', 'Webhook URL')}><Copy size={11} /> Copy URL</button>
                </div>
              )}
              <div className="dc-toolbar">
                {!hook?.running ? (
                  <button className="btn-primary dc-btn" onClick={() => void hookOp('start')} disabled={busy === 'hook-start'}>
                    {busy === 'hook-start' ? <Loader2 size={12} className="ig-spin" /> : <Play size={12} />} Start
                  </button>
                ) : (
                  <>
                    <button className="btn-ghost dc-btn" onClick={() => void hookOp('stop')} disabled={busy === 'hook-stop'}><Square size={11} /> Stop</button>
                    <button className="btn-ghost dc-btn" onClick={() => void hookOp('test')} disabled={busy === 'hook-test'}>
                      {busy === 'hook-test' ? <Loader2 size={12} className="ig-spin" /> : <Send size={11} />} Send test
                    </button>
                    <button className="btn-ghost dc-btn" onClick={() => void hookOp('clear')}><Trash2 size={11} /> Clear</button>
                  </>
                )}
                <span className="dc-muted">
                  {hook?.requests || 0} request(s) · port {hook?.port || '—'} · autostart {hook?.autostart ? 'on' : 'off'}
                </span>
              </div>
            </div>
            <div className="ig-editor">
              <div className="ig-editor-head"><strong>Recent deliveries</strong><span className="dc-muted">{hookEvents.length} shown</span></div>
              {!hookEvents.length && <div className="ig-empty"><Webhook size={20} /><strong>No deliveries yet</strong><p>Start the receiver, then POST to the URL.</p></div>}
              {hookEvents.map((event) => (
                <details className="ig-event" key={event.id}>
                  <summary>
                    <span className={`ig-method ${event.method}`}>{event.method}</span>
                    <span className="ig-event-path">{event.path}{Object.keys(event.query).length ? `?${new URLSearchParams(event.query).toString()}` : ''}</span>
                    <span className="dc-muted">{event.bytes} B · {new Date(event.ts).toLocaleTimeString()}</span>
                  </summary>
                  <div className="ig-event-body">
                    <div className="dc-muted">from {event.remote} · {event.id}</div>
                    <pre className="ig-pre">{typeof event.body === 'string' ? event.body : JSON.stringify(event.body, null, 2)}</pre>
                  </div>
                </details>
              ))}
            </div>
          </div>
        )}

        {tab === 'oauth' && (
          <div className="dc-tab-body">
            <div className="ig-editor">
              <div className="ig-editor-head">
                <strong>Sign in with OAuth</strong>
                <span className="dc-muted">Device flow (RFC 8628) or PKCE loopback · tokens in the encrypted vault</span>
              </div>
              <div className="ig-action-row">
                {oauthState?.providers.map((p) => (
                  <button key={p.id} className={`ig-kind ${oauthProvider === p.id ? 'on' : ''}`} onClick={() => setOauthProvider(p.id)}>
                    {p.label}
                  </button>
                ))}
              </div>
              <p className="dc-hint">{oauthState?.providers.find((p) => p.id === oauthProvider)?.hint}</p>
              <div className="ig-grid-2">
                <label className="ig-field">
                  <span>Flow</span>
                  <select value={oauthMode} onChange={(e) => setOauthMode(e.target.value as 'device' | 'pkce')}>
                    <option value="device">Device code</option>
                    <option value="pkce">PKCE loopback</option>
                  </select>
                </label>
                <label className="ig-field">
                  <span>Account label (optional)</span>
                  <input value={oauthLabel} onChange={(e) => setOauthLabel(e.target.value)} placeholder="Work Google Drive" />
                </label>
                <label className="ig-field">
                  <span>Client id</span>
                  <input value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} placeholder="From your provider's OAuth app" />
                </label>
                <label className="ig-field">
                  <span>Client secret (if required)</span>
                  <input type="password" autoComplete="off" value={oauthClientSecret} onChange={(e) => setOauthClientSecret(e.target.value)} />
                </label>
                <label className="ig-field ig-span-2">
                  <span>Scopes (space or comma separated; blank uses the defaults)</span>
                  <input value={oauthScopes} onChange={(e) => setOauthScopes(e.target.value)} placeholder={oauthState?.providers.find((p) => p.id === oauthProvider)?.scopes.join(' ')} />
                </label>
              </div>
              {oauthProvider === 'custom' && (
                <div className="ig-grid-2">
                  <label className="ig-field">
                    <span>Authorization URL</span>
                    <input value={oauthAuthUrl} onChange={(e) => setOauthAuthUrl(e.target.value)} placeholder="https://provider.example.com/oauth/authorize" />
                  </label>
                  <label className="ig-field">
                    <span>Token URL</span>
                    <input value={oauthTokenUrl} onChange={(e) => setOauthTokenUrl(e.target.value)} placeholder="https://provider.example.com/oauth/token" />
                  </label>
                  <label className="ig-field">
                    <span>Device authorization URL</span>
                    <input value={oauthDeviceUrl} onChange={(e) => setOauthDeviceUrl(e.target.value)} placeholder="https://provider.example.com/oauth/device/code" />
                  </label>
                  <label className="ig-field">
                    <span>Userinfo URL</span>
                    <input value={oauthUserinfoUrl} onChange={(e) => setOauthUserinfoUrl(e.target.value)} placeholder="https://provider.example.com/oauth/userinfo" />
                  </label>
                </div>
              )}
              <div className="dc-toolbar">
                <button className="btn-primary dc-btn" onClick={() => void startOauth()} disabled={busy === 'oauth' || !oauthClientId.trim()}>
                  {busy === 'oauth' ? <Loader2 size={12} className="ig-spin" /> : <KeyRound size={12} />} Start sign-in
                </button>
                {oauthFlow?.status === 'pending' && (
                  <button className="btn-ghost dc-btn" onClick={() => void cancelOauth(oauthFlow.id)}><X size={11} /> Cancel</button>
                )}
              </div>
              {oauthError && <div className="ig-output bad">{oauthError}</div>}
              {oauthFlow && (
                <div className={`ig-flow ${oauthFlow.status}`}>
                  <div className="ig-flow-head">
                    <strong>{oauthFlow.status === 'pending' ? 'Waiting for approval' : oauthFlow.status}</strong>
                    <span className="dc-muted">{oauthFlow.kind === 'device' ? 'device code' : 'PKCE loopback'} · {oauthFlow.provider}</span>
                  </div>
                  {oauthFlow.status === 'pending' && oauthFlow.userCode && (
                    <>
                      <p className="dc-hint">Open <a href={oauthFlow.verificationUrl || '#'} target="_blank" rel="noreferrer">{oauthFlow.verificationUrl}</a> and enter this code:</p>
                      <div className="ig-user-code">
                        <code>{oauthFlow.userCode}</code>
                        <button className="btn-ghost dc-btn" onClick={() => void copy(oauthFlow.userCode || '', 'Code')}><Copy size={11} /></button>
                      </div>
                    </>
                  )}
                  {oauthFlow.status === 'pending' && oauthFlow.authUrl && (
                    <div className="ig-copy-row">
                      <code>{oauthFlow.authUrl}</code>
                      <button className="btn-ghost dc-btn" onClick={() => void copy(oauthFlow.authUrl || '', 'Authorization URL')}><Copy size={11} /> Copy</button>
                    </div>
                  )}
                  {oauthFlow.status === 'done' && <p className="dc-hint">Connected as account {oauthFlow.accountId}.</p>}
                  {oauthFlow.error && <p className="dc-hint bad-text">{oauthFlow.error}</p>}
                </div>
              )}
            </div>

            <div className="ig-editor">
              <div className="ig-editor-head"><strong>Connected accounts</strong><span className="dc-muted">{oauthState?.accounts.length || 0}</span></div>
              {!oauthState?.accounts.length && <div className="ig-empty"><KeyRound size={20} /><strong>No OAuth accounts</strong><p>Connect Google Drive or any OAuth provider, then use the account id in a Google Drive connection.</p></div>}
              {oauthState?.accounts.map((account) => (
                <div className="ig-account" key={account.id}>
                  <div>
                    <strong>{account.label}</strong>
                    <div className="dc-muted">{account.providerLabel} · {account.email || 'no email'} · {account.authType}</div>
                  </div>
                  <code className="ig-account-id">{account.id}</code>
                  {oauthChecks[account.id] && <span className="dc-muted">{oauthChecks[account.id]}</span>}
                  <button className="btn-ghost dc-btn" onClick={() => void checkAccount(account)} disabled={busy === `check:${account.id}`}>
                    {busy === `check:${account.id}` ? <Loader2 size={11} className="ig-spin" /> : <Shield size={11} />} Check token
                  </button>
                  <button className="btn-ghost dc-btn ig-danger" onClick={() => void removeAccount(account)}><Trash2 size={11} /> Remove</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'mcp' && (
          <div className="dc-tab-body">
            <div className="ig-editor">
              <div className="ig-editor-head">
                <strong>ORVEX as an MCP server</strong>
                <span className={`dc-chip ${mcp?.running ? 'live' : 'dim'}`}>{mcp?.running ? 'running' : 'stopped'}</span>
              </div>
              <p className="dc-hint">
                A loopback Streamable-HTTP endpoint that exposes ORVEX's real tools to another MCP client. Every call passes the permission engine, guardrails and audit log. Destructive calls are refused unless you either approve them in ORVEX or enable risky tools here.
              </p>
              {mcp?.running && (
                <>
                  <div className="ig-copy-row">
                    <span className="ig-copy-label">Endpoint</span>
                    <code>{mcp.endpoint}</code>
                    <button className="btn-ghost dc-btn" onClick={() => void copy(mcp.endpoint || '', 'Endpoint')}><Copy size={11} /></button>
                  </div>
                  <div className="ig-copy-row">
                    <span className="ig-copy-label">Bearer token</span>
                    <code className="ig-token">{mcp.token}</code>
                    <button className="btn-ghost dc-btn" onClick={() => void copy(mcp.token || '', 'Token')}><Copy size={11} /></button>
                  </div>
                  <p className="dc-hint">Client config: URL {mcp.endpoint} · header <code>{mcp.authHeader}</code></p>
                </>
              )}
              <div className="dc-toolbar">
                {!mcp?.running ? (
                  <button className="btn-primary dc-btn" onClick={() => void toggleMcp(true)} disabled={busy === 'mcp'}>
                    {busy === 'mcp' ? <Loader2 size={12} className="ig-spin" /> : <Play size={12} />} Start server
                  </button>
                ) : (
                  <button className="btn-ghost dc-btn" onClick={() => void toggleMcp(false)} disabled={busy === 'mcp'}>
                    {busy === 'mcp' ? <Loader2 size={12} className="ig-spin" /> : <Square size={11} />} Stop server
                  </button>
                )}
                <label className="ig-check">
                  <input type="checkbox" checked={!!mcp?.allowRisky} onChange={(e) => void setAllowRisky(e.target.checked)} />
                  Allow risky tools without a human in ORVEX
                </label>
              </div>
            </div>
            <div className="ig-editor">
              <div className="ig-editor-head"><strong>Live counters</strong></div>
              <div className="ig-stat-grid">
                <div><b>{mcp?.requests ?? 0}</b><span>JSON-RPC requests</span></div>
                <div><b>{mcp?.toolCalls ?? 0}</b><span>tool calls</span></div>
                <div><b>{mcp?.sessions ?? 0}</b><span>active sessions</span></div>
                <div><b>{mcp?.protocolVersion || '—'}</b><span>protocol</span></div>
              </div>
              {mcp?.lastError && <div className="ig-output bad">{mcp.lastError}</div>}
              <p className="dc-hint">
                Point Claude Desktop, Cursor or any MCP client at the endpoint with the bearer header. Tools: sys_info, file tools, browser, research, memory, media, code, desktop, integrations and every MCP tool ORVEX itself connects to.
              </p>
            </div>
          </div>
        )}

        {tab === 'permissions' && (
          <div className="dc-tab-body">
            <div className="ig-editor">
              <div className="ig-editor-head">
                <strong>Per-tool permissions</strong>
                <span className="dc-muted">
                  {perms?.counts.allow || 0} allow · {perms?.counts.ask || 0} ask · {perms?.counts.deny || 0} deny · {perms?.counts.total || 0} tools
                </span>
              </div>
              <p className="dc-hint">
                <b>Allow</b> runs a tool without a prompt, <b>Ask</b> always asks even for safe tools, and <b>Deny</b> blocks it everywhere including MCP clients. Guardrails still hard-block dangerous shell commands and system folders.
              </p>
              <div className="ig-filter-row">
                <div className="ig-search">
                  <Search size={13} />
                  <input value={permFilter} onChange={(e) => setPermFilter(e.target.value)} placeholder="Filter tools" />
                </div>
                <select value={permSource} onChange={(e) => setPermSource(e.target.value)}>
                  <option value="all">All sources</option>
                  <option value="builtin">Built-in</option>
                  <option value="mcp">MCP</option>
                </select>
                <button className="btn-ghost dc-btn" onClick={() => void resetPolicies()}><Trash2 size={11} /> Reset all</button>
              </div>
              <div className="ig-perm-list">
                {filteredTools.map((tool) => (
                  <div className="ig-perm" key={tool.name}>
                    <div className="ig-perm-name">
                      <code>{tool.name}</code>
                      <span className="dc-muted">{tool.source}</span>
                    </div>
                    <p className="ig-perm-desc">{tool.description.slice(0, 160)}</p>
                    <select
                      value={tool.policy}
                      className={`ig-policy ${tool.policy}`}
                      onChange={(e) => void setPolicy(tool.name, e.target.value as 'allow' | 'ask' | 'deny' | 'default')}
                    >
                      <option value="default">Default</option>
                      <option value="allow">Allow</option>
                      <option value="ask">Ask</option>
                      <option value="deny">Deny</option>
                    </select>
                  </div>
                ))}
                {!filteredTools.length && <div className="ig-empty"><Search size={20} /><strong>No tools match</strong><p>Change the filter or reconnect an MCP server.</p></div>}
              </div>
            </div>
          </div>
        )}
      </div>
    </PageShell>
  )
}
