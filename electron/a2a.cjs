'use strict';

/**
 * Agent-to-agent (A2A) messaging.
 *
 * Two ORVEX installs — or any A2A-speaking client — can exchange tasks over
 * JSON-RPC 2.0. Inbound text is answered by the configured chat model; a remote
 * peer can ask questions or delegate reasoning, but it can never drive this
 * machine's desktop, tools, files or plugins. That boundary is deliberate: the
 * agent tool loop needs a human approval UI, which a remote caller cannot see.
 *
 * Every request needs a bearer token, the host only answers private LAN
 * addresses, and tasks are durable: an interrupted task is reported as failed
 * after a restart instead of pretending it is still running.
 */

const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const db = require('./db.cjs');

const DEFAULT_PORT = 47831;
const A2A_HEADER = 'x-orvex-a2a';
const MAX_BODY = 512 * 1024;
const MAX_GOAL = 8000;
const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 300_000;
const TOKEN_KEY = 'advanced.a2a.token';
const EXPOSE_KEY = 'advanced.a2a.expose';
const PORT_KEY = 'advanced.a2a.port';

const SYSTEM_PROMPT = `You are ORVEX, answering another AI agent over the A2A protocol.
Reply with the requested result only: no greeting, no preamble, no questions back.
You cannot take actions on the host machine on behalf of the caller; if the request needs
local files, desktop control or credentials, say plainly that this capability is not exposed
over A2A and describe what the caller should ask its own user to do.
Be concise, factual, and explicit about uncertainty.`;

const SKILLS = [
  {
    id: 'desktop-assistant',
    name: 'Desktop assistant',
    description: 'Advice and reasoning about Windows/macOS/Linux desktop tasks. Cannot control a remote desktop.',
    tags: ['desktop', 'automation', 'advice'],
    examples: ['How do I batch-rename files on Windows without a script?'],
  },
  {
    id: 'code-review',
    name: 'Code and build review',
    description: 'Reasoning about source code, build errors and architecture questions.',
    tags: ['code', 'build', 'review'],
    examples: ['Why would an Electron preload fail with contextIsolation enabled?'],
  },
  {
    id: 'research',
    name: 'Research synthesis',
    description: 'Summarising and comparing supplied information; no browsing is performed for peers.',
    tags: ['research', 'summary'],
    examples: ['Compare these two release notes and list the breaking changes.'],
  },
  {
    id: 'maker',
    name: 'Maker planning',
    description: 'Planning websites, tools and small applications from a short brief.',
    tags: ['maker', 'planning'],
    examples: ['Plan a two-page site for a local bakery with no backend.'],
  },
];

let ctx = { emit: () => {}, run: null, version: () => '1.0.0' };
let server = null;
let hostPort = 0;
let exposeLan = false;
const inflight = new Map();
const canceled = new Set();

function init(opts = {}) {
  ctx = { ...ctx, ...opts };
  resetInterrupted();
}

function now() {
  return Date.now();
}

function raw() {
  return db.raw();
}

function clip(text, max = 4000) {
  const s = String(text == null ? '' : text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function emit(event) {
  try {
    ctx.emit({ scope: 'a2a', ...event });
  } catch {
    /* window closed */
  }
}

function deviceId() {
  const id = String(db.getSetting('advanced.device.id', '') || '');
  return id || `dev_${crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 12)}`;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isPrivateAddress(address) {
  const a = String(address || '').replace(/^::ffff:/, '');
  if (a === '::1' || a === '127.0.0.1' || a.startsWith('127.')) return true;
  if (/^10\./.test(a)) return true;
  if (/^192\.168\./.test(a)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  if (/^169\.254\./.test(a)) return true;
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(a)) return true;
  if (/^fe80:/i.test(a)) return true;
  return false;
}

function lanAddress() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal && isPrivateAddress(net.address)) return net.address;
    }
  }
  return '127.0.0.1';
}

function token() {
  let value = String(db.getSetting(TOKEN_KEY, '') || '');
  if (!/^[a-f0-9]{64}$/.test(value)) {
    value = crypto.randomBytes(32).toString('hex');
    db.setSetting(TOKEN_KEY, value);
  }
  return value;
}

function rotateToken() {
  const value = crypto.randomBytes(32).toString('hex');
  db.setSetting(TOKEN_KEY, value);
  db.audit({ kind: 'a2a-token', tool: 'a2a', args: '{"action":"rotate"}', ok: true });
  emit({ type: 'a2a-token', at: now() });
  return { token: value };
}

function agentCard() {
  const base = exposeLan ? `http://${lanAddress()}:${hostPort || DEFAULT_PORT}` : `http://127.0.0.1:${hostPort || DEFAULT_PORT}`;
  return {
    protocolVersion: '0.3.0',
    name: 'ORVEX',
    description: 'Local-first desktop agent. Over A2A it answers text requests with the configured chat model; it does not expose desktop or file control to peers.',
    url: `${base}/a2a`,
    preferredTransport: 'JSONRPC',
    version: String(ctx.version()),
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: SKILLS,
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    security: [{ bearer: [] }],
    metadata: { host: os.hostname(), device: deviceId(), pcControlForPeers: false },
  };
}

function resetInterrupted() {
  try {
    raw()
      ?.prepare(
        `UPDATE adv_a2a_tasks SET status = 'failed', error = 'ORVEX restarted before this task finished.', ended_at = ?, updated_at = ?
         WHERE status IN ('submitted','working')`,
      )
      .run(now(), now());
  } catch {
    /* schema not ready */
  }
}

function rowToTask(row) {
  if (!row) return null;
  const base = {
    kind: 'task',
    id: row.id,
    contextId: row.context_id,
    status: { state: row.status, timestamp: new Date(row.updated_at).toISOString() },
    metadata: { direction: row.direction, peer: row.peer, created: new Date(row.created_at).toISOString(), ended: row.ended_at ? new Date(row.ended_at).toISOString() : null },
  };
  if (row.status === 'completed' && row.result) {
    base.artifacts = [{ artifactId: `art_${row.id.slice(4, 16)}`, name: 'reply', parts: [{ kind: 'text', text: row.result }] }];
  }
  if (row.status === 'failed' || row.status === 'canceled') {
    base.status.message = { role: 'agent', parts: [{ kind: 'text', text: String(row.error || row.status) }] };
  }
  return base;
}

function getTask(id) {
  return rowToTask(raw()?.prepare('SELECT * FROM adv_a2a_tasks WHERE id = ?').get(String(id || '')));
}

function listTasks({ limit = 50, direction } = {}) {
  const max = Math.min(Math.max(Math.round(Number(limit) || 50), 1), 200);
  const rows = direction
    ? raw()?.prepare('SELECT * FROM adv_a2a_tasks WHERE direction = ? ORDER BY created_at DESC LIMIT ?').all(String(direction), max)
    : raw()?.prepare('SELECT * FROM adv_a2a_tasks ORDER BY created_at DESC LIMIT ?').all(max);
  return (rows || []).map((row) => ({ ...rowToTask(row), goal: clip(row.goal, 300) }));
}

function peerView(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    tokenPreview: row.token ? `…${String(row.token).slice(-4)}` : '',
    hasToken: !!row.token,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
    lastError: row.last_error || null,
  };
}

function listPeers() {
  return (raw()?.prepare('SELECT * FROM adv_a2a_peers ORDER BY created_at DESC').all() || []).map(peerView);
}

function normalizeUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('Enter a full http(s) URL, for example http://192.168.1.20:47831.');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http and https peers are supported.');
  if (url.username || url.password) throw new Error('Put the token in the token field, not in the URL.');
  url.hash = '';
  url.search = '';
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/a2a')) path = path.slice(0, -4);
  url.pathname = path || '';
  return url.toString().replace(/\/$/, '');
}

function addPeer({ name, url, token: peerToken } = {}) {
  const cleanUrl = normalizeUrl(url);
  const cleanToken = String(peerToken || '').trim();
  if (!/^[a-f0-9]{32,128}$/i.test(cleanToken)) throw new Error('A peer token must be 32–128 hex characters. Copy it from the other ORVEX "Agent network" panel.');
  const id = `peer_${crypto.randomBytes(6).toString('hex')}`;
  const label = clip(String(name || '').trim() || new URL(cleanUrl).hostname, 60);
  raw()
    ?.prepare('INSERT INTO adv_a2a_peers(id, name, url, token, created_at, last_seen) VALUES(?, ?, ?, ?, ?, NULL)')
    .run(id, label, cleanUrl, cleanToken, now());
  db.audit({ kind: 'a2a-peer', tool: 'a2a', args: JSON.stringify({ peer: label }), ok: true });
  emit({ type: 'a2a-peer-added', name: label, at: now() });
  return peerView(raw()?.prepare('SELECT * FROM adv_a2a_peers WHERE id = ?').get(id));
}

function removePeer(id) {
  const removed = raw()?.prepare('DELETE FROM adv_a2a_peers WHERE id = ?').run(String(id || '')).changes || 0;
  if (removed) emit({ type: 'a2a-peer-removed', id, at: now() });
  return { removed };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('The A2A request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('The A2A body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id == null ? null : id, error: { code, message } };
}

function bearer(req) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  return match ? match[1].trim() : '';
}

function textFromMessage(message) {
  if (!message || typeof message !== 'object') throw new Error('params.message is required.');
  const parts = Array.isArray(message.parts) ? message.parts : [];
  if (!parts.length) throw new Error('The message has no parts.');
  const texts = [];
  for (const part of parts) {
    const kind = String(part && part.kind ? part.kind : '');
    if (kind === 'text' || (!kind && typeof part.text === 'string')) {
      texts.push(String(part.text || ''));
      continue;
    }
    throw new Error(`Only text parts are supported; received "${kind || 'unknown'}".`);
  }
  const goal = texts.join('\n').trim();
  if (!goal) throw new Error('The message text is empty.');
  if (goal.length > MAX_GOAL) throw new Error(`The message is longer than ${MAX_GOAL} characters.`);
  return goal;
}

function insertTask({ id, contextId, direction, peer, goal, status }) {
  raw()
    ?.prepare('INSERT INTO adv_a2a_tasks(id, context_id, direction, peer, goal, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, contextId, direction, peer, goal, status, now(), now());
}

function updateTask(id, status, { result = null, error = null } = {}) {
  raw()
    ?.prepare('UPDATE adv_a2a_tasks SET status = ?, result = COALESCE(?, result), error = ?, updated_at = ?, ended_at = ? WHERE id = ?')
    .run(status, result, error, now(), status === 'completed' || status === 'failed' || status === 'canceled' ? now() : null, id);
}

async function runInbound(goal, options) {
  const onStart = options || {};
  const id = `a2a_${crypto.randomBytes(6).toString('hex')}`;
  const contextId = `ctx_${crypto.randomBytes(6).toString('hex')}`;
  insertTask({ id, contextId, direction: 'inbound', peer: onStart.peer, goal, status: 'submitted' });
  const controller = new AbortController();
  inflight.set(id, controller);
  updateTask(id, 'working');
  emit({ type: 'a2a-task', id, direction: 'inbound', peer: onStart.peer, status: 'working', at: now() });
  const started = now();
  try {
    if (typeof ctx.run !== 'function') throw new Error('No chat model is configured, so ORVEX cannot answer A2A tasks. Open Engine and add a provider.');
    const timeout = setTimeout(() => controller.abort(), onStart.timeoutMs);
    const text = await ctx.run({ goal, signal: controller.signal, taskId: id });
    clearTimeout(timeout);
    const reply = clip(String(text || '').trim(), 40_000) || 'The model returned an empty reply.';
    updateTask(id, 'completed', { result: reply });
    db.audit({ kind: 'a2a-task', tool: 'a2a', args: JSON.stringify({ id, direction: 'inbound', peer: onStart.peer }), ok: true });
    emit({ type: 'a2a-task', id, direction: 'inbound', peer: onStart.peer, status: 'completed', at: now() });
    return { ...getTask(id), metadata: { ...getTask(id).metadata, durationMs: now() - started } };
  } catch (err) {
    const aborted = controller.signal.aborted;
    const localCancel = canceled.has(id);
    const message = localCancel ? 'Canceled locally.' : aborted ? 'The task timed out.' : err && err.message ? err.message : String(err);
    updateTask(id, aborted ? 'canceled' : 'failed', { error: message });
    db.audit({ kind: 'a2a-task', tool: 'a2a', args: JSON.stringify({ id, direction: 'inbound', peer: onStart.peer }), ok: false, error: message });
    emit({ type: 'a2a-task', id, direction: 'inbound', peer: onStart.peer, status: aborted ? 'canceled' : 'failed', at: now() });
    return getTask(id);
  } finally {
    inflight.delete(id);
    canceled.delete(id);
  }
}

async function handleRpc(entry) {
  const { id, method, params } = entry;
  if (method === 'message/send') {
    const message = params && params.message;
    const goal = textFromMessage(message);
    const meta = params && params.metadata && typeof params.metadata === 'object' ? params.metadata : {};
    const peer = clip(String(meta.peer || meta.agent || 'remote agent'), 60);
    const requested = Number(meta.timeoutMs) || DEFAULT_TIMEOUT;
    const task = await runInbound(goal, { peer, timeoutMs: Math.min(Math.max(requested, 5_000), MAX_TIMEOUT) });
    return { jsonrpc: '2.0', id, result: task };
  }
  if (method === 'tasks/get') {
    const taskId = params && (params.id || params.taskId);
    const task = getTask(taskId);
    if (!task) return rpcError(id, -32001, `No A2A task "${String(taskId || '')}" exists.`);
    return { jsonrpc: '2.0', id, result: task };
  }
  if (method === 'tasks/cancel') {
    const taskId = String((params && (params.id || params.taskId)) || '');
    const active = inflight.get(taskId);
    if (active) {
      active.abort();
      return { jsonrpc: '2.0', id, result: { kind: 'task', id: taskId, status: { state: 'canceled' } } };
    }
    const row = raw()?.prepare('SELECT * FROM adv_a2a_tasks WHERE id = ?').get(taskId);
    if (!row) return rpcError(id, -32001, `No A2A task "${taskId}" exists.`);
    if (row.status === 'completed' || row.status === 'failed' || row.status === 'canceled') {
      return rpcError(id, -32002, `Task "${taskId}" already finished as ${row.status}.`);
    }
    updateTask(taskId, 'canceled', { error: 'Canceled by the caller.' });
    return { jsonrpc: '2.0', id, result: getTask(taskId) };
  }
  if (method === 'agent/getAuthenticatedExtendedCard') {
    return { jsonrpc: '2.0', id, result: agentCard() };
  }
  return rpcError(id, -32601, `Unknown A2A method "${String(method || '')}". Supported: message/send, tasks/get, tasks/cancel.`);
}

async function handleRequest(req, res) {
  const remote = req.socket.remoteAddress;
  if (!isPrivateAddress(remote)) {
    sendJson(res, 403, { error: 'A2A only answers private LAN addresses.' });
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && (url.pathname === '/.well-known/agent-card.json' || url.pathname === '/.well-known/agent.json')) {
    sendJson(res, 200, agentCard());
    return;
  }
  if (url.pathname !== '/a2a' && url.pathname !== '/') {
    sendJson(res, 404, { error: 'Unknown endpoint. POST /a2a for JSON-RPC or GET /.well-known/agent-card.json.' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Use POST for A2A JSON-RPC.' });
    return;
  }
  if (String(req.headers[A2A_HEADER] || '') !== '1') {
    sendJson(res, 403, { error: 'This endpoint only accepts A2A clients (missing x-orvex-a2a header).' });
    return;
  }
  if (!safeEqual(bearer(req), token())) {
    sendJson(res, 401, { error: 'A valid Bearer token is required. Copy it from the host ORVEX "Agent network" panel.' });
    return;
  }
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    sendJson(res, 400, rpcError(null, -32700, err.message));
    return;
  }
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    sendJson(res, 400, rpcError(body && body.id, -32600, 'Expected a JSON-RPC 2.0 request with a method.'));
    return;
  }
  let result;
  try {
    result = await handleRpc({ id: body.id, method: body.method, params: body.params });
  } catch (err) {
    result = rpcError(body.id, -32602, err && err.message ? err.message : String(err));
  }
  sendJson(res, 200, result);
}

function hostStatus() {
  return {
    hosting: !!server,
    port: server && server.address() ? server.address().port : Number(db.getSetting(PORT_KEY, DEFAULT_PORT)) || DEFAULT_PORT,
    expose: String(db.getSetting(EXPOSE_KEY, 'loopback')) === 'lan' ? 'lan' : 'loopback',
    url: server ? agentCard().url : '',
    card: agentCard(),
    token: token(),
    peers: listPeers(),
    tasks: listTasks({ limit: 20 }),
    active: inflight.size,
  };
}

function hostStart({ port, expose } = {}) {
  if (server) return hostStatus();
  hostPort = Math.min(Math.max(Math.round(Number(port) || Number(db.getSetting(PORT_KEY, DEFAULT_PORT))) || DEFAULT_PORT, 1024), 65535);
  exposeLan = expose === 'lan' || (expose == null && String(db.getSetting(EXPOSE_KEY, 'loopback')) === 'lan');
  db.setSetting(EXPOSE_KEY, exposeLan ? 'lan' : 'loopback');
  db.setSetting(PORT_KEY, hostPort);
  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => sendJson(res, 500, rpcError(null, -32603, err && err.message ? err.message : String(err))));
  });
  server.on('error', (err) => {
    const message = err && err.message ? err.message : String(err);
    try {
      server.close();
    } catch {
      /* not listening */
    }
    server = null;
    emit({ type: 'a2a-host-error', error: message, at: now() });
  });
  server.listen(hostPort, exposeLan ? '0.0.0.0' : '127.0.0.1', () => {
    hostPort = server.address().port;
    emit({ type: 'a2a-host', port: hostPort, expose: exposeLan ? 'lan' : 'loopback', at: now() });
  });
  return hostStatus();
}

function hostStop() {
  for (const controller of inflight.values()) {
    controller.abort();
  }
  if (server) {
    try {
      server.close();
    } catch {
      /* already closed */
    }
    server = null;
  }
  return hostStatus();
}

function cancel(id) {
  const taskId = String(id || '');
  const task = getTask(taskId);
  if (!task) throw new Error(`No A2A task "${taskId}" exists.`);
  const controller = inflight.get(taskId);
  if (controller) {
    canceled.add(taskId);
    controller.abort();
    emit({ type: 'a2a-task', id: taskId, status: 'canceled', at: now() });
    return getTask(taskId);
  }
  if (task.status.state === 'completed' || task.status.state === 'failed' || task.status.state === 'canceled') {
    throw new Error(`That task already finished as ${task.status.state}.`);
  }
  updateTask(taskId, 'canceled', { error: 'Canceled locally.' });
  return getTask(taskId);
}

async function send(peerId, text, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const peer = raw()?.prepare('SELECT * FROM adv_a2a_peers WHERE id = ?').get(String(peerId || ''));
  if (!peer) throw new Error('That A2A peer is not saved.');
  const goal = String(text || '').trim();
  if (!goal) throw new Error('Write the message to send.');
  if (goal.length > MAX_GOAL) throw new Error(`The message is longer than ${MAX_GOAL} characters.`);
  const id = `a2a_${crypto.randomBytes(6).toString('hex')}`;
  const contextId = `ctx_${crypto.randomBytes(6).toString('hex')}`;
  insertTask({ id, contextId, direction: 'outbound', peer: peer.name, goal, status: 'submitted' });
  const controller = new AbortController();
  inflight.set(id, controller);
  const timer = setTimeout(() => controller.abort(), Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT, 5_000), MAX_TIMEOUT));
  updateTask(id, 'working');
  emit({ type: 'a2a-task', id, direction: 'outbound', peer: peer.name, status: 'working', at: now() });
  try {
    const res = await fetch(`${peer.url}/a2a`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${peer.token}`,
        [A2A_HEADER]: '1',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'message/send',
        params: {
          message: { kind: 'message', role: 'user', messageId: id, contextId, parts: [{ kind: 'text', text: goal }] },
          metadata: { peer: db.getSetting('advanced.device.name', '') || os.hostname(), timeoutMs },
        },
      }),
    });
    const payload = await res.json().catch(() => null);
    clearTimeout(timer);
    if (!res.ok) throw new Error(payload && payload.error ? payload.error.message || payload.error : `HTTP ${res.status} from ${peer.url}`);
    if (!payload || payload.error) throw new Error(payload && payload.error ? payload.error.message : 'The peer returned no JSON-RPC result.');
    const remote = payload.result || {};
    const state = remote.status && remote.status.state ? remote.status.state : 'completed';
    const textPart =
      (remote.artifacts || [])
        .flatMap((artifact) => artifact.parts || [])
        .filter((part) => part && part.kind === 'text')
        .map((part) => String(part.text || ''))
        .join('\n') || (remote.status && remote.status.message ? 'The peer failed the task.' : '');
    updateTask(id, state, { result: textPart || null, error: state === 'failed' || state === 'canceled' ? textPart || 'The peer reported a failure.' : null });
    raw()?.prepare('UPDATE adv_a2a_peers SET last_seen = ?, last_error = NULL WHERE id = ?').run(now(), peer.id);
    db.audit({ kind: 'a2a-task', tool: 'a2a', args: JSON.stringify({ id, direction: 'outbound', peer: peer.name }), ok: state === 'completed' });
    emit({ type: 'a2a-task', id, direction: 'outbound', peer: peer.name, status: state, at: now() });
    return { task: getTask(id), remoteId: remote.id || null };
  } catch (err) {
    clearTimeout(timer);
    const aborted = controller.signal.aborted;
    const localCancel = canceled.has(id);
    const message = localCancel ? 'Canceled locally.' : aborted ? 'The peer did not answer in time.' : err && err.message ? err.message : String(err);
    updateTask(id, localCancel ? 'canceled' : 'failed', { error: message });
    raw()?.prepare('UPDATE adv_a2a_peers SET last_seen = ?, last_error = ? WHERE id = ?').run(now(), clip(message, 300), peer.id);
    db.audit({ kind: 'a2a-task', tool: 'a2a', args: JSON.stringify({ id, direction: 'outbound', peer: peer.name }), ok: false, error: message });
    emit({ type: 'a2a-task', id, direction: 'outbound', peer: peer.name, status: 'failed', at: now() });
    return { task: getTask(id), error: message };
  } finally {
    inflight.delete(id);
    canceled.delete(id);
  }
}

async function fetchCard(url) {
  const cleanUrl = normalizeUrl(url);
  const res = await fetch(`${cleanUrl}/.well-known/agent-card.json`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from the peer card.`);
  const card = await res.json();
  if (!card || typeof card !== 'object' || !card.name) throw new Error('That URL did not return an A2A agent card.');
  return { url: cleanUrl, card: { name: clip(card.name, 80), description: clip(card.description || '', 300), version: clip(card.version || '', 40), protocolVersion: clip(card.protocolVersion || '', 20), skills: Array.isArray(card.skills) ? card.skills.slice(0, 12).map((s) => clip(String(s && s.name ? s.name : s), 80)) : [] } };
}

function status() {
  return hostStatus();
}

module.exports = {
  init,
  SYSTEM_PROMPT,
  SKILLS,
  A2A_HEADER,
  agentCard,
  hostStart,
  hostStop,
  status,
  token,
  rotateToken,
  addPeer,
  removePeer,
  listPeers,
  listTasks,
  getTask,
  cancel,
  send,
  fetchCard,
  _internals: { isPrivateAddress, normalizeUrl, textFromMessage, safeEqual, rowToTask },
};
