'use strict';

/**
 * ORVEX as an MCP server: a loopback Streamable-HTTP endpoint that exposes the
 * same tools the agent uses. Every call goes through the permission engine,
 * guardrails and audit log. Risky tools need either a human in ORVEX or the
 * explicit "allow risky tools" switch.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const vault = require('./vault.cjs');
const permissions = require('./permissions.cjs');

const PROTOCOL_VERSION = '2025-03-26';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_SESSIONS = 32;

let dataDir = null;
let configFile = null;
let emit = () => {};
let toolBridge = {
  definitions: () => [],
  runTool: async () => ({ ok: false, error: 'Tools are not wired yet.' }),
  approvalReason: () => null,
};

const server = {
  instance: null,
  port: null,
  startedAt: null,
  requests: 0,
  toolCalls: 0,
  lastError: null,
};
const sessions = new Map();

function init(opts = {}) {
  dataDir = opts.dataDir || dataDir;
  configFile = dataDir ? path.join(dataDir, 'mcp-server.json') : null;
  if (typeof opts.emit === 'function') emit = opts.emit;
  if (opts.bridge && typeof opts.bridge === 'object') toolBridge = { ...toolBridge, ...opts.bridge };
  return { config: loadConfig(), running: !!server.instance };
}

function loadConfig() {
  const base = { enabled: false, port: 47321, allowRisky: false, url: null };
  if (!configFile) return base;
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return {
      enabled: !!raw.enabled,
      port: Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : base.port,
      allowRisky: !!raw.allowRisky,
      url: raw.url || null,
    };
  } catch {
    return base;
  }
}

function saveConfig(patch) {
  const config = { ...loadConfig(), ...patch };
  if (!configFile) return config;
  try {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
  } catch {
    /* read-only profile */
  }
  return config;
}

async function serverToken() {
  let token = await vault.get('mcp-server:token');
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    await vault.set('mcp-server:token', token);
  }
  return token;
}

function status() {
  const config = loadConfig();
  const token = server.token || null;
  return {
    running: !!server.instance,
    enabled: config.enabled,
    port: server.port || config.port,
    url: server.instance ? `http://127.0.0.1:${server.port}/mcp` : null,
    endpoint: server.instance ? `http://127.0.0.1:${server.port}/mcp` : null,
    token,
    authHeader: token ? `Authorization: Bearer ${token}` : null,
    allowRisky: config.allowRisky,
    protocolVersion: PROTOCOL_VERSION,
    startedAt: server.startedAt,
    requests: server.requests,
    toolCalls: server.toolCalls,
    sessions: sessions.size,
    lastError: server.lastError,
  };
}

function clip(value, max = 20000) {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

function jsonRpc(id, result) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message, ...(data ? { data } : {}) } };
}

function toolList() {
  let defs = [];
  try {
    defs = toolBridge.definitions() || [];
  } catch {
    defs = [];
  }
  return defs
    .filter((d) => d && d.name)
    .map((d) => ({
      name: d.name,
      description: String(d.description || ''),
      inputSchema: d.parameters && typeof d.parameters === 'object' ? d.parameters : { type: 'object', properties: {} },
    }));
}

async function callTool(name, args) {
  const toolName = String(name || '').trim();
  if (!toolName) return { isError: true, text: 'Tool name is required.' };
  const known = toolList().some((t) => t.name === toolName);
  if (!known) return { isError: true, text: `Unknown tool "${toolName}". Call tools/list first.` };
  const denied = permissions.denialReason(toolName);
  if (denied) return { isError: true, text: denied };
  let reason = null;
  try {
    reason = toolBridge.approvalReason(toolName, args || {});
  } catch {
    reason = null;
  }
  const config = loadConfig();
  if (reason && !config.allowRisky) {
    return {
      isError: true,
      text: `${reason} This MCP call was not run. Approve it inside ORVEX, or enable "Allow risky tools" in Integrations → MCP server while you supervise the client.`,
      needsApproval: true,
    };
  }
  const result = await toolBridge.runTool(toolName, args || {}, { runId: `mcp-${Date.now()}`, source: 'mcp' });
  server.toolCalls += 1;
  const text = result.ok ? result.output || '(done)' : result.error || 'Tool failed.';
  return {
    isError: !result.ok,
    text,
    structured: { ok: !!result.ok, output: result.output || '', error: result.error || null, ms: result.ms || 0 },
  };
}

async function handleRpc(message, session) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    return jsonRpcError(message && message.id, -32600, 'Invalid Request: expected JSON-RPC 2.0.');
  }
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;
  server.requests += 1;

  if (!method || typeof method !== 'string') {
    return isNotification ? null : jsonRpcError(id, -32600, 'Invalid Request: method is missing.');
  }

  if (method.startsWith('notifications/')) return null;

  if (method === 'initialize') {
    const wanted = String(params?.protocolVersion || '');
    session.protocolVersion = PROTOCOL_VERSION;
    session.client = params?.clientInfo?.name ? String(params.clientInfo.name) : 'unknown client';
    return jsonRpc(id, {
      protocolVersion: '2025-03-26',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'orvex', title: 'ORVEX', version: '1.0.0' },
      instructions:
        'ORVEX exposes its real OS, file, browser, research, media, code and integration tools. Destructive tools ask for approval inside ORVEX unless the user enabled risky tools.',
    });
  }
  if (method === 'ping') return jsonRpc(id, {});
  if (method === 'tools/list') return jsonRpc(id, { tools: toolList() });
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const out = await callTool(name, args);
    return jsonRpc(id, {
      content: [{ type: 'text', text: clip(out.text) }],
      structuredContent: out.structured || { ok: !out.isError, output: out.text },
      isError: !!out.isError,
    });
  }
  if (method === 'resources/list') return jsonRpc(id, { resources: [] });
  if (method === 'resources/templates/list') return jsonRpc(id, { resourceTemplates: [] });
  if (method === 'prompts/list') return jsonRpc(id, { prompts: [] });
  if (method === 'logging/setLevel') return jsonRpc(id, {});
  if (method === 'completion/complete') return jsonRpc(id, { completion: { values: [], total: 0, hasMore: false } });

  return isNotification ? null : jsonRpcError(id, -32601, `Method not found: ${method}`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        reject(Object.assign(new Error(`Body is larger than ${MAX_BODY_BYTES} bytes.`), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function authorized(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !server.token) return false;
  const a = Buffer.from(match[1].trim());
  const b = Buffer.from(server.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function start({ port, allowRisky } = {}) {
  if (server.instance) return status();
  const config = loadConfig();
  if (allowRisky !== undefined) saveConfig({ allowRisky: !!allowRisky });
  server.token = await serverToken();
  const instance = http.createServer(async (req, res) => {
    const send = (code, payload, headers = {}) => {
      if (payload === undefined) {
        res.writeHead(code, headers);
        res.end();
        return;
      }
      const body = JSON.stringify(payload);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
      res.end(body);
    };
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/mcp' && url.pathname !== '/') {
      send(404, { error: 'Use POST /mcp for MCP Streamable HTTP.' });
      return;
    }
    if (!authorized(req)) {
      send(401, { error: 'A valid bearer token is required. Copy the token from Integrations → MCP server.' }, {
        'www-authenticate': 'Bearer realm="orvex"',
      });
      return;
    }
    if (req.method === 'GET') {
      send(405, undefined, { allow: 'POST, DELETE' });
      return;
    }
    if (req.method === 'DELETE') {
      const sid = String(req.headers['mcp-session-id'] || '');
      if (sid) sessions.delete(sid);
      send(204, undefined, { 'mcp-session-id': sid });
      return;
    }
    if (req.method !== 'POST') {
      send(405, undefined, { allow: 'POST, DELETE' });
      return;
    }
    let sessionId = String(req.headers['mcp-session-id'] || '');
    let session = sessions.get(sessionId);
    if (!session) {
      if (sessions.size >= MAX_SESSIONS) {
        const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
        if (oldest) sessions.delete(oldest[0]);
      }
      sessionId = crypto.randomUUID();
      session = { id: sessionId, createdAt: Date.now(), client: null, protocolVersion: null };
      sessions.set(sessionId, session);
    }
    const headers = { 'mcp-session-id': sessionId };
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      send(err.status || 400, { error: err && err.message ? err.message : 'Could not read the request body.' });
      return;
    }
    let parsed;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      send(400, jsonRpcError(null, -32700, 'Parse error: the body is not valid JSON.'));
      return;
    }
    if (parsed === null) {
      send(400, jsonRpcError(null, -32600, 'Empty request.'));
      return;
    }
    try {
      if (Array.isArray(parsed)) {
        const replies = [];
        for (const message of parsed) {
          const reply = await handleRpc(message, session);
          if (reply) replies.push(reply);
        }
        if (!replies.length) send(202, undefined, headers);
        else send(200, replies, headers);
        return;
      }
      const reply = await handleRpc(parsed, session);
      if (!reply) send(202, undefined, headers);
      else send(200, reply, headers);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      send(500, jsonRpcError(parsed && parsed.id, -32603, `Internal error: ${message}`), headers);
    }
  });
  instance.on('clientError', (err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {
      /* socket already gone */
    }
  });
  instance.on('error', (err) => {
    server.lastError = err && err.message ? err.message : String(err);
    emit('mcp-server', { kind: 'error', error: server.lastError });
  });

  const wanted = Number.isInteger(port) && port > 0 && port < 65536 ? port : config.port;
  await new Promise((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(wanted, '127.0.0.1', resolve);
  });
  server.instance = instance;
  server.port = instance.address().port;
  server.startedAt = new Date().toISOString();
  server.lastError = null;
  saveConfig({ enabled: true, port: server.port, url: `http://127.0.0.1:${server.port}/mcp` });
  emit('mcp-server', { kind: 'start', port: server.port });
  return status();
}

async function stop({ persist = true } = {}) {
  if (!server.instance) {
    if (persist) saveConfig({ enabled: false });
    return status();
  }
  const instance = server.instance;
  server.instance = null;
  sessions.clear();
  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(done, 3000);
    timer.unref?.();
    instance.close(() => {
      clearTimeout(timer);
      done();
    });
    // Keep-alive and SSE sockets would otherwise hold close() open forever.
    instance.closeAllConnections?.();
  });
  server.port = null;
  server.startedAt = null;
  if (persist) saveConfig({ enabled: false });
  emit('mcp-server', { kind: 'stop' });
  return status();
}

async function setAllowRisky(value) {
  const config = saveConfig({ allowRisky: !!value });
  emit('mcp-server', { kind: 'config', allowRisky: config.allowRisky });
  return status();
}

async function autostart() {
  const config = loadConfig();
  if (!config.enabled) return status();
  try {
    return await start({ port: config.port });
  } catch (err) {
    server.lastError = err && err.message ? err.message : String(err);
    saveConfig({ enabled: false });
    emit('mcp-server', { kind: 'error', error: server.lastError });
    return status();
  }
}

function notifyToolsChanged() {
  if (!server.instance) return false;
  emit('mcp-server', { kind: 'tools-changed' });
  return true;
}

module.exports = { init, start, stop, status, setAllowRisky, autostart, notifyToolsChanged, PROTOCOL_VERSION };
