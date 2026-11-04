'use strict';

/**
 * Real integrations for ORVEX: REST + WebSocket calls, a loopback webhook
 * receiver, and vault-backed connections for GitHub, email (SMTP/IMAP),
 * CalDAV calendars, PostgreSQL, SQLite, S3-compatible storage and Google Drive.
 * Nothing here is simulated: every action performs the network or database
 * operation it reports, and credentials live in the encrypted Electron vault.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { URL, URLSearchParams } = require('node:url');
const { WebSocket } = require('ws');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const Database = require('better-sqlite3');
const { checkPath } = require('./guardrails.cjs');
const vault = require('./vault.cjs');

const MAX_HTTP_BYTES = 4 * 1024 * 1024;
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_DB_ROWS = 200;
const MAX_EVENTS = 100;
const CONNECT_TIMEOUT = 15000;

let dataDir = null;
let connectionsFile = null;
let emit = () => {};
let oauthToken = async () => {
  throw new Error('OAuth is not available.');
};

const store = { connections: [] };

const KINDS = {
  github: {
    label: 'GitHub',
    hint: 'REST API with a personal access token. Reads repos, issues and pull requests; creates issues and comments.',
    fields: [{ key: 'apiBase', label: 'API base', placeholder: 'https://api.github.com', default: 'https://api.github.com' }],
    secrets: [{ key: 'token', label: 'Personal access token', required: true }],
    actions: [
      { id: 'me', label: 'Who am I' },
      { id: 'repos', label: 'List repositories', fields: [{ key: 'limit', label: 'Limit', default: '20' }] },
      { id: 'issues', label: 'List issues', fields: [{ key: 'repo', label: 'owner/repo' }, { key: 'state', label: 'State', default: 'open' }] },
      { id: 'pulls', label: 'List pull requests', fields: [{ key: 'repo', label: 'owner/repo' }] },
      { id: 'create_issue', label: 'Create issue', fields: [{ key: 'repo', label: 'owner/repo' }, { key: 'title', label: 'Title' }, { key: 'body', label: 'Body', type: 'textarea' }] },
      { id: 'comment', label: 'Comment on issue', fields: [{ key: 'repo', label: 'owner/repo' }, { key: 'number', label: 'Issue number' }, { key: 'body', label: 'Comment', type: 'textarea' }] },
    ],
  },
  email: {
    label: 'Email',
    hint: 'Real SMTP sending and IMAP reading. Uses the TLS ports you provide (465/993 by default).',
    fields: [
      { key: 'host', label: 'SMTP host', default: 'smtp.gmail.com' },
      { key: 'port', label: 'SMTP port', default: '465' },
      { key: 'secure', label: 'SMTP TLS', default: 'true' },
      { key: 'user', label: 'Account / from address' },
      { key: 'imapHost', label: 'IMAP host', default: 'imap.gmail.com' },
      { key: 'imapPort', label: 'IMAP port', default: '993' },
      { key: 'fromName', label: 'Display name' },
    ],
    secrets: [
      { key: 'password', label: 'SMTP password / app password', required: true },
      { key: 'imapPassword', label: 'IMAP password (if different)' },
    ],
    actions: [
      { id: 'folders', label: 'List folders' },
      { id: 'inbox', label: 'Latest messages', fields: [{ key: 'limit', label: 'Limit', default: '10' }] },
      { id: 'search', label: 'Search', fields: [{ key: 'query', label: 'Subject or sender' }, { key: 'limit', label: 'Limit', default: '10' }] },
      { id: 'read', label: 'Read message', fields: [{ key: 'uid', label: 'UID' }] },
      { id: 'send', label: 'Send email', fields: [{ key: 'to', label: 'To' }, { key: 'subject', label: 'Subject' }, { key: 'body', label: 'Body', type: 'textarea' }] },
    ],
  },
  calendar: {
    label: 'Calendar (CalDAV)',
    hint: 'Works with Nextcloud, Fastmail, iCloud app passwords, Radicale and Google via CalDAV.',
    fields: [{ key: 'url', label: 'CalDAV base URL', placeholder: 'https://example.com/remote.php/dav' }, { key: 'user', label: 'Username' }, { key: 'calendarUrl', label: 'Calendar URL (optional)' }],
    secrets: [{ key: 'password', label: 'Password / app password', required: true }],
    actions: [
      { id: 'calendars', label: 'List calendars' },
      { id: 'events', label: 'List events', fields: [{ key: 'from', label: 'From (YYYY-MM-DD)' }, { key: 'to', label: 'To (YYYY-MM-DD)' }] },
      { id: 'create', label: 'Create event', fields: [{ key: 'summary', label: 'Summary' }, { key: 'start', label: 'Start', placeholder: '2026-05-01T10:00:00' }, { key: 'end', label: 'End', placeholder: '2026-05-01T11:00:00' }, { key: 'location', label: 'Location' }, { key: 'description', label: 'Description', type: 'textarea' }] },
      { id: 'delete', label: 'Delete event', fields: [{ key: 'href', label: 'Event href from list' }] },
    ],
  },
  postgres: {
    label: 'PostgreSQL',
    hint: 'Runs SQL against a Postgres server. Reads return up to 200 rows; writes need confirmation.',
    fields: [
      { key: 'host', label: 'Host', default: 'localhost' },
      { key: 'port', label: 'Port', default: '5432' },
      { key: 'database', label: 'Database' },
      { key: 'user', label: 'User' },
      { key: 'ssl', label: 'SSL (true/false)', default: 'false' },
      { key: 'sslCa', label: 'CA certificate file (optional)', placeholder: 'C:\\certs\\ca.pem' },
    ],
    secrets: [{ key: 'password', label: 'Password' }],
    actions: [
      { id: 'tables', label: 'List tables' },
      { id: 'query', label: 'Run SQL', fields: [{ key: 'sql', label: 'SQL', type: 'textarea' }, { key: 'write', label: 'Allow writes (true/false)', default: 'false' }] },
    ],
  },
  sqlite: {
    label: 'SQLite',
    hint: 'Opens a local .db file. System folders are blocked; writes need confirmation.',
    fields: [{ key: 'file', label: 'Database file', placeholder: 'C:\\Users\\you\\data.db' }],
    secrets: [],
    actions: [
      { id: 'tables', label: 'List tables' },
      { id: 'query', label: 'Run SQL', fields: [{ key: 'sql', label: 'SQL', type: 'textarea' }, { key: 'write', label: 'Allow writes (true/false)', default: 'false' }] },
    ],
  },
  s3: {
    label: 'S3 storage',
    hint: 'SigV4-signed requests to S3, MinIO, Cloudflare R2 or any compatible endpoint.',
    fields: [
      { key: 'endpoint', label: 'Endpoint', placeholder: 'https://s3.eu-central-1.amazonaws.com' },
      { key: 'region', label: 'Region', default: 'us-east-1' },
      { key: 'bucket', label: 'Bucket' },
      { key: 'accessKeyId', label: 'Access key id' },
    ],
    secrets: [{ key: 'secretAccessKey', label: 'Secret access key', required: true }, { key: 'sessionToken', label: 'Session token (optional)' }],
    actions: [
      { id: 'list', label: 'List objects', fields: [{ key: 'prefix', label: 'Prefix' }, { key: 'limit', label: 'Limit', default: '50' }] },
      { id: 'get', label: 'Download object', fields: [{ key: 'key', label: 'Object key' }] },
      { id: 'put', label: 'Upload object', fields: [{ key: 'key', label: 'Object key' }, { key: 'content', label: 'Content', type: 'textarea' }, { key: 'contentType', label: 'Content type', default: 'text/plain' }] },
      { id: 'delete', label: 'Delete object', fields: [{ key: 'key', label: 'Object key' }] },
    ],
  },
  gdrive: {
    label: 'Google Drive',
    hint: 'Uses a Google OAuth account from the OAuth tab (drive.file scope).',
    fields: [{ key: 'accountId', label: 'OAuth account id' }],
    secrets: [],
    actions: [
      { id: 'about', label: 'Account & quota' },
      { id: 'list', label: 'List files', fields: [{ key: 'query', label: 'Search query', placeholder: "name contains 'report'" }, { key: 'limit', label: 'Limit', default: '25' }] },
      { id: 'upload', label: 'Upload file', fields: [{ key: 'name', label: 'File name' }, { key: 'content', label: 'Content', type: 'textarea' }, { key: 'mimeType', label: 'MIME type', default: 'text/plain' }] },
      { id: 'download', label: 'Download file', fields: [{ key: 'fileId', label: 'File id' }] },
      { id: 'delete', label: 'Delete file', fields: [{ key: 'fileId', label: 'File id' }] },
    ],
  },
};

/* ------------------------------------------------------------------ helpers */

function slug(text, fallback) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function publicConnection(conn) {
  const kind = KINDS[conn.kind];
  return {
    id: conn.id,
    kind: conn.kind,
    label: conn.label,
    config: { ...conn.config },
    secretSet: Object.fromEntries((kind?.secrets || []).map((s) => [s.key, !!conn.secretSet[s.key]])),
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
    lastTest: conn.lastTest || null,
  };
}

function schema() {
  return {
    kinds: Object.entries(KINDS).map(([id, k]) => ({ id, label: k.label, hint: k.hint, fields: k.fields, secrets: k.secrets, actions: k.actions })),
    limits: { httpBytes: MAX_HTTP_BYTES, webhookBytes: MAX_WEBHOOK_BYTES, dbRows: MAX_DB_ROWS },
  };
}

function persist() {
  if (!connectionsFile) return Promise.resolve();
  const text = JSON.stringify({ connections: store.connections }, null, 2);
  return fsp.mkdir(path.dirname(connectionsFile), { recursive: true }).then(() => fsp.writeFile(connectionsFile, text, 'utf8')).catch(() => {});
}

function changed(kind, extra) {
  try {
    emit({ kind, ...(extra || {}) });
  } catch {
    /* renderer gone */
  }
}

function load() {
  store.connections = [];
  if (!connectionsFile) return;
  try {
    const raw = JSON.parse(fs.readFileSync(connectionsFile, 'utf8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw.connections) ? raw.connections : [];
    for (const entry of list) {
      if (!entry || !KINDS[entry.kind] || !entry.id) continue;
      store.connections.push({
        id: String(entry.id),
        kind: entry.kind,
        label: String(entry.label || KINDS[entry.kind].label),
        config: entry.config && typeof entry.config === 'object' ? { ...entry.config } : {},
        secretSet: entry.secretSet && typeof entry.secretSet === 'object' ? { ...entry.secretSet } : {},
        createdAt: entry.createdAt || nowIso(),
        updatedAt: entry.updatedAt || entry.createdAt || nowIso(),
        lastTest: entry.lastTest || null,
      });
    }
  } catch {
    /* first run */
  }
}

function init(opts = {}) {
  dataDir = opts.dataDir || dataDir;
  connectionsFile = dataDir ? path.join(dataDir, 'integrations.json') : null;
  if (typeof opts.emit === 'function') emit = opts.emit;
  if (typeof opts.oauthToken === 'function') oauthToken = opts.oauthToken;
  load();
}

function connectionById(id) {
  const hit = store.connections.find((c) => c.id === String(id || ''));
  if (!hit) throw new Error(`No integration connection with id "${id}".`);
  return hit;
}

function secretKey(id, field) {
  return `integration:${id}:${field}`;
}

async function secretOf(conn, field) {
  return await vault.get(secretKey(conn.id, field));
}

async function requireSecrets(conn) {
  const kind = KINDS[conn.kind];
  for (const s of kind.secrets) {
    if (!s.required) continue;
    const value = await secretOf(conn, s.key);
    if (!value) throw new Error(`Connection "${conn.label}" is missing ${s.label}. Edit it and add the value.`);
  }
}

function assertHttpUrl(raw, label = 'URL') {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`${label} must start with http:// or https://.`);
  return u;
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function textBlock(title, lines) {
  return `${title}\n${lines.filter((l) => l != null && l !== '').join('\n')}`;
}

async function saveDownload(name, buffer) {
  const dir = path.join(dataDir || process.cwd(), 'integration-downloads');
  await fsp.mkdir(dir, { recursive: true });
  const safe = String(name || 'download.bin').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-120) || 'download.bin';
  const file = path.join(dir, `${Date.now()}-${safe}`);
  await fsp.writeFile(file, buffer);
  return file;
}

/* ---------------------------------------------------------------- REST calls */

async function httpRequest(args = {}) {
  const method = String(args.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) throw new Error('method must be GET, HEAD, POST, PUT, PATCH, DELETE or OPTIONS.');
  const url = assertHttpUrl(args.url, 'url');
  const headers = {};
  for (const [k, v] of Object.entries(args.headers && typeof args.headers === 'object' ? args.headers : {})) {
    if (/^[a-zA-Z0-9-]+$/.test(k)) headers[k] = String(v);
  }
  let body;
  if (args.json !== undefined && args.json !== null) {
    body = typeof args.json === 'string' ? args.json : JSON.stringify(args.json);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  } else if (args.body !== undefined && args.body !== null) {
    body = String(args.body);
  }
  if (method === 'GET' || method === 'HEAD') {
    if (args.body !== undefined || args.json !== undefined) throw new Error(`${method} requests cannot carry a body.`);
  }
  const timeoutMs = clampInt(args.timeoutMs, 1000, 180000, 30000);
  const maxBytes = clampInt(args.maxBytes, 1024, MAX_HTTP_BYTES, MAX_HTTP_BYTES);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, { method, headers, body, redirect: 'follow', signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const reason = err && err.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : (err && err.message) || String(err);
    throw new Error(`Request failed: ${reason}`);
  }
  let buffer = Buffer.alloc(0);
  try {
    buffer = Buffer.from(await res.arrayBuffer());
  } catch {
    /* HEAD responses have no body */
  } finally {
    clearTimeout(timer);
  }
  const ms = Date.now() - started;
  const truncated = buffer.length > maxBytes;
  const clipped = truncated ? buffer.subarray(0, maxBytes) : buffer;
  const isText = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|ld\+json))/i.test(res.headers.get('content-type') || '') || !res.headers.get('content-type');
  const text = isText ? clipped.toString('utf8') : '';
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  const shown = text.length > 4000 ? `${text.slice(0, 4000)}\n…[${text.length - 4000} more characters]` : text;
  const headerLines = [...res.headers.entries()].slice(0, 30).map(([k, v]) => `${k}: ${v}`);
  const output = textBlock(
    `${method} ${url.toString()} → ${res.status} ${res.statusText || ''} (${buffer.length} bytes, ${ms} ms)`,
    [headerLines.join('\n'), shown || (isText ? '(empty body)' : '(binary body — use an integration to save it)')],
  );
  return {
    ok: res.ok,
    output,
    error: res.ok ? null : `HTTP ${res.status} ${res.statusText || ''}`.trim(),
    status: res.status,
    statusText: res.statusText || '',
    headers: Object.fromEntries([...res.headers.entries()]),
    body: text,
    json,
    bytes: buffer.length,
    truncated,
    ms,
  };
}

/* ----------------------------------------------------------- WebSocket calls */

function wsRequest(args = {}) {
  const raw = String(args.url || '').trim();
  if (!/^wss?:\/\//i.test(raw)) throw new Error('url must start with ws:// or wss://.');
  const limit = clampInt(args.messages, 1, 100, 20);
  const timeoutMs = clampInt(args.timeoutMs, 1000, 180000, 15000);
  const protocols = Array.isArray(args.protocols) ? args.protocols.map(String) : undefined;
  const headers = args.headers && typeof args.headers === 'object' ? Object.fromEntries(Object.entries(args.headers).map(([k, v]) => [k, String(v)])) : undefined;
  const outbound = args.message === undefined || args.message === null ? null : typeof args.message === 'string' ? args.message : JSON.stringify(args.message);
  return new Promise((resolve) => {
    let settled = false;
    const messages = [];
    const started = Date.now();
    let ws;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* already closed */
      }
      resolve(extra);
    };
    const timer = setTimeout(() => {
      finish({
        ok: messages.length > 0,
        output: `WebSocket ${raw} — ${messages.length} message(s) in ${timeoutMs} ms.${messages.length ? `\n${messages.join('\n')}` : ' No message arrived before the timeout.'}`,
        error: messages.length ? null : `No message arrived within ${timeoutMs} ms.`,
        messages,
      });
    }, timeoutMs);
    try {
      ws = new WebSocket(raw, protocols, { headers, handshakeTimeout: CONNECT_TIMEOUT });
    } catch (err) {
      finish({ ok: false, output: '', error: err && err.message ? err.message : String(err), messages });
      return;
    }
    ws.on('open', () => {
      if (outbound != null) ws.send(outbound);
    });
    ws.on('message', (data) => {
      const text = data.toString();
      messages.push(text.length > 2000 ? `${text.slice(0, 2000)}…` : text);
      if (messages.length >= limit) finish({ ok: true, output: `WebSocket ${raw} — ${messages.length} message(s).\n${messages.join('\n')}`, error: null, messages, ms: Date.now() - started });
    });
    ws.on('error', (err) => {
      finish({ ok: false, output: '', error: `WebSocket error: ${err && err.message ? err.message : String(err)}`, messages, ms: Date.now() - started });
    });
    ws.on('close', (code, reason) => {
      const why = reason ? reason.toString() : '';
      finish({
        ok: messages.length > 0,
        output: `WebSocket closed (${code}${why ? ` ${why}` : ''}) after ${messages.length} message(s).${messages.length ? `\n${messages.join('\n')}` : ''}`,
        error: messages.length ? null : `The socket closed before sending a message (code ${code}).`,
        messages,
        closed: true,
        ms: Date.now() - started,
      });
    });
  });
}

/* --------------------------------------------------------------- connections */

async function saveConnection(payload = {}) {
  const kind = String(payload.kind || '');
  if (!KINDS[kind]) throw new Error('kind must be one of ' + Object.keys(KINDS).join(', ') + '.');
  const config = {};
  for (const field of KINDS[kind].fields) {
    const value = payload.config && payload.config[field.key] != null ? String(payload.config[field.key]).trim() : '';
    if (value) config[field.key] = value;
  }
  const existing = payload.id ? store.connections.find((c) => c.id === String(payload.id)) : null;
  if (payload.id && !existing) throw new Error(`No connection with id "${payload.id}".`);
  if (existing && existing.kind !== kind) throw new Error('A connection cannot change its kind. Delete it and create a new one.');
  const id = existing ? existing.id : slug(payload.label || KINDS[kind].label, `${kind}-${Date.now().toString(36)}`);
  if (store.connections.some((c) => c.id === id && (!existing || c.id !== existing.id))) throw new Error(`Connection id "${id}" is already used.`);
  const entered = payload.secrets && typeof payload.secrets === 'object' ? payload.secrets : {};
  const secretSet = existing ? { ...existing.secretSet } : {};
  for (const field of KINDS[kind].secrets) {
    const value = entered[field.key];
    if (value != null && String(value) !== '') {
      if (field.key === 'imapPassword' && config.imapHost === config.host) {
        /* explicit IMAP password still wins when given */
      }
      if (value === '__KEEP__') continue;
      await vault.set(secretKey(id, field.key), String(value));
      secretSet[field.key] = true;
    }
  }
  if (!existing) {
    for (const field of KINDS[kind].secrets) {
      if (field.required && !secretSet[field.key]) throw new Error(`${field.label} is required.`);
    }
  }
  const record = {
    id,
    kind,
    label: String(payload.label || (existing && existing.label) || KINDS[kind].label).trim().slice(0, 80),
    config,
    secretSet,
    createdAt: existing ? existing.createdAt : nowIso(),
    updatedAt: nowIso(),
    lastTest: existing ? existing.lastTest : null,
  };
  if (existing) Object.assign(existing, record);
  else store.connections.push(record);
  await persist();
  changed('connection', { id });
  return publicConnection(record);
}

async function deleteConnection(id) {
  const conn = connectionById(id);
  store.connections = store.connections.filter((c) => c.id !== conn.id);
  for (const field of KINDS[conn.kind].secrets) await vault.remove(secretKey(conn.id, field.key)).catch(() => {});
  await persist();
  changed('connection', { id: conn.id, deleted: true });
  return { deleted: conn.id };
}

/* ------------------------------------------------------------------ GitHub */

function githubHeaders(conn, token) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'ORVEX/1.0',
    'x-github-api-version': '2022-11-28',
  };
}

async function githubCall(conn, suffix, init) {
  const base = (conn.config.apiBase || 'https://api.github.com').replace(/\/+$/, '');
  const token = await secretOf(conn, 'token');
  if (!token) throw new Error('GitHub connection has no token.');
  const url = assertHttpUrl(suffix.startsWith('http') ? suffix : `${base}${suffix}`, 'GitHub URL');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch(url, { ...(init || {}), headers: { ...githubHeaders(conn, token), ...((init && init.headers) || {}) }, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`GitHub request failed: ${err && err.name === 'AbortError' ? 'timed out' : (err && err.message) || String(err)}`);
  }
  clearTimeout(timer);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = data && data.message ? data.message : text.slice(0, 300);
    throw new Error(`GitHub API ${res.status}: ${message || res.statusText}`);
  }
  return data;
}

async function githubTest(conn) {
  const me = await githubCall(conn, '/user');
  const remaining = await githubCall(conn, '/rate_limit').catch(() => null);
  const core = remaining && remaining.resources && remaining.resources.core;
  return {
    ok: true,
    output: `Signed in as ${me.login}${me.name ? ` (${me.name})` : ''}. ${me.public_repos} public repo(s).${core ? ` GitHub API quota: ${core.remaining}/${core.limit}.` : ''}`,
  };
}

async function githubAction(conn, action, args) {
  switch (action) {
    case 'me': {
      const me = await githubCall(conn, '/user');
      return { ok: true, output: textBlock(`${me.login}${me.name ? ` — ${me.name}` : ''}`, [`Profile: ${me.html_url}`, `Public repos: ${me.public_repos}`, `Followers: ${me.followers}`, me.company ? `Company: ${me.company}` : '', me.email ? `Email: ${me.email}` : '']) };
    }
    case 'repos': {
      const limit = clampInt(args.limit, 1, 100, 20);
      const repos = await githubCall(conn, `/user/repos?per_page=${limit}&sort=updated`);
      const list = (Array.isArray(repos) ? repos : []).map((r) => `${r.full_name} — ${r.private ? 'private' : 'public'}${r.description ? ` — ${r.description}` : ''} (${r.html_url})`);
      return { ok: true, output: list.length ? `${list.length} repositories:\n${list.join('\n')}` : 'No repositories.', repos: repos || [] };
    }
    case 'issues': {
      const repo = String(args.repo || '').trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repo must look like owner/name.');
      const state = ['open', 'closed', 'all'].includes(String(args.state || 'open')) ? String(args.state || 'open') : 'open';
      const issues = await githubCall(conn, `/repos/${repo}/issues?state=${state}&per_page=50`);
      const list = (Array.isArray(issues) ? issues : []).filter((i) => !i.pull_request).map((i) => `#${i.number} [${i.state}] ${i.title}${i.user ? ` — ${i.user.login}` : ''}`);
      return { ok: true, output: list.length ? `${list.length} issue(s) in ${repo}:\n${list.join('\n')}` : `No ${state} issues in ${repo}.`, issues: issues || [] };
    }
    case 'pulls': {
      const repo = String(args.repo || '').trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repo must look like owner/name.');
      const prs = await githubCall(conn, `/repos/${repo}/pulls?state=open&per_page=50`);
      const list = (Array.isArray(prs) ? prs : []).map((p) => `#${p.number} ${p.title} — ${p.head?.ref} → ${p.base?.ref} (${p.user?.login})`);
      return { ok: true, output: list.length ? `${list.length} open pull request(s) in ${repo}:\n${list.join('\n')}` : `No open pull requests in ${repo}.`, pulls: prs || [] };
    }
    case 'create_issue': {
      const repo = String(args.repo || '').trim();
      const title = String(args.title || '').trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repo must look like owner/name.');
      if (!title) throw new Error('title is required.');
      const issue = await githubCall(conn, `/repos/${repo}/issues`, { method: 'POST', body: JSON.stringify({ title, body: String(args.body || '') }), headers: { 'content-type': 'application/json' } });
      return { ok: true, output: `Created ${repo}#${issue.number}: ${issue.title}\n${issue.html_url}`, issue };
    }
    case 'comment': {
      const repo = String(args.repo || '').trim();
      const number = clampInt(args.number, 1, 100000000, 0);
      const body = String(args.body || '').trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repo must look like owner/name.');
      if (!number) throw new Error('number is required.');
      if (!body) throw new Error('body is required.');
      const comment = await githubCall(conn, `/repos/${repo}/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body }), headers: { 'content-type': 'application/json' } });
      return { ok: true, output: `Commented on ${repo}#${number}: ${comment.html_url}`, comment };
    }
    default:
      throw new Error(`Unknown GitHub action "${action}".`);
  }
}

/* ------------------------------------------------------------------- email */

async function emailTransport(conn) {
  const password = await secretOf(conn, 'password');
  if (!password) throw new Error('Email connection has no password.');
  const port = clampInt(conn.config.port, 1, 65535, 465);
  return nodemailer.createTransport({
    host: conn.config.host,
    port,
    secure: String(conn.config.secure ?? 'true') !== 'false',
    auth: { user: conn.config.user, pass: password },
    connectionTimeout: CONNECT_TIMEOUT,
    greetingTimeout: CONNECT_TIMEOUT,
    socketTimeout: 30000,
  });
}

async function withImap(conn, fn) {
  const password = (await secretOf(conn, 'imapPassword')) || (await secretOf(conn, 'password'));
  if (!password) throw new Error('Email connection has no IMAP password.');
  const client = new ImapFlow({
    host: conn.config.imapHost || conn.config.host,
    port: clampInt(conn.config.imapPort, 1, 65535, 993),
    secure: true,
    auth: { user: conn.config.user, pass: password },
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT,
    greetingTimeout: CONNECT_TIMEOUT,
    socketTimeout: 45000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

function envelopeLine(msg) {
  const env = msg.envelope || {};
  const from = (env.from || []).map((a) => a.name || a.address).join(', ') || '(unknown sender)';
  const subject = env.subject || '(no subject)';
  const when = env.date ? new Date(env.date).toLocaleString() : '';
  return `UID ${msg.uid} — ${when} — ${from}\n  ${subject}`;
}

async function emailTest(conn) {
  const transport = await emailTransport(conn);
  await transport.verify();
  const info = await withImap(conn, async (client) => {
    const list = await client.list();
    return list.map((m) => m.name).slice(0, 8);
  });
  return { ok: true, output: `SMTP login works for ${conn.config.user}. IMAP is reachable — ${info.length ? `${info.length} folder(s): ${info.join(', ')}` : 'no folders returned'}.` };
}

async function emailAction(conn, action, args) {
  if (action === 'send') {
    const to = String(args.to || '').trim();
    const subject = String(args.subject || '').trim();
    const body = String(args.body || '');
    if (!to) throw new Error('to is required.');
    if (!subject) throw new Error('subject is required.');
    if (!body) throw new Error('body is required.');
    const transport = await emailTransport(conn);
    const info = await transport.sendMail({
      from: conn.config.fromName ? `"${conn.config.fromName}" <${conn.config.user}>` : conn.config.user,
      to,
      subject,
      text: body,
    });
    return { ok: true, output: `Sent "${subject}" to ${to}. Message id: ${info.messageId || '(none)'}. Accepted: ${(info.accepted || []).join(', ') || '(none)'}.` };
  }
  if (action === 'folders') {
    return await withImap(conn, async (client) => {
      const list = await client.list();
      return { ok: true, output: `${list.length} folder(s):\n${list.map((m) => `${m.path}${m.specialUse ? ` (${m.specialUse})` : ''}`).join('\n')}`, folders: list.map((m) => m.path) };
    });
  }
  if (action === 'inbox' || action === 'search') {
    const limit = clampInt(args.limit, 1, 50, 10);
    return await withImap(conn, async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        let uids;
        if (action === 'search') {
          const query = String(args.query || '').trim();
          if (!query) throw new Error('query is required.');
          uids = await client.search({ or: [{ subject: query }, { from: query }, { to: query }] }, { uid: true });
        } else {
          const status = await client.status('INBOX', { messages: true });
          const total = Number(status.messages) || 0;
          const start = Math.max(1, total - limit + 1);
          uids = total ? await client.search({ seq: `${start}:*` }, { uid: true }) : [];
        }
        const wanted = (uids || []).slice(-limit);
        if (!wanted.length) return { ok: true, output: action === 'search' ? `Nothing matched "${args.query}".` : 'The inbox is empty.', messages: [] };
        const messages = [];
        for await (const msg of client.fetch(wanted.join(','), { envelope: true, uid: true, flags: true }, { uid: true })) {
          messages.push({ uid: msg.uid, subject: msg.envelope?.subject || '', from: (msg.envelope?.from || []).map((a) => a.name || a.address).join(', '), date: msg.envelope?.date || null });
        }
        messages.sort((a, b) => (a.date && b.date ? new Date(a.date) - new Date(b.date) : 0));
        return { ok: true, output: `${messages.length} message(s):\n${messages.map((m) => `UID ${m.uid} — ${m.date ? new Date(m.date).toLocaleString() : ''} — ${m.from || '(unknown)'}\n  ${m.subject}`).join('\n')}`, messages };
      } finally {
        lock.release();
      }
    });
  }
  if (action === 'read') {
    const uid = clampInt(args.uid, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!uid) throw new Error('uid is required (use the inbox action to find it).');
    return await withImap(conn, async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        let found = null;
        for await (const msg of client.fetch(String(uid), { envelope: true, source: true, uid: true }, { uid: true })) found = msg;
        if (!found) throw new Error(`No message with UID ${uid}.`);
        const parsed = await simpleParser(found.source);
        const text = (parsed.text || '').trim() || String(parsed.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return {
          ok: true,
          output: textBlock(`UID ${uid} — ${parsed.subject || '(no subject)'}`, [
            `From: ${parsed.from ? parsed.from.text : '(unknown)'}`,
            `To: ${parsed.to ? parsed.to.text : ''}`,
            `Date: ${parsed.date ? parsed.date.toISOString() : ''}`,
            parsed.attachments && parsed.attachments.length ? `Attachments: ${parsed.attachments.map((a) => a.filename).join(', ')}` : '',
            '',
            text.slice(0, 4000),
          ]),
          subject: parsed.subject || '',
          text,
        };
      } finally {
        lock.release();
      }
    });
  }
  throw new Error(`Unknown email action "${action}".`);
}

/* ---------------------------------------------------------------- CalDAV */

function basicAuth(conn) {
  return 'Basic ' + Buffer.from(`${conn.config.user || ''}:${''}`).toString('base64');
}

async function caldavFetch(conn, url, init = {}) {
  const password = await secretOf(conn, 'password');
  if (!password) throw new Error('Calendar connection has no password.');
  const auth = 'Basic ' + Buffer.from(`${conn.config.user || ''}:${password}`).toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch(url, { ...init, headers: { authorization: auth, 'user-agent': 'ORVEX/1.0', ...(init.headers || {}) }, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`CalDAV request failed: ${err && err.name === 'AbortError' ? 'timed out' : (err && err.message) || String(err)}`);
  }
  clearTimeout(timer);
  const text = await res.text();
  if (!res.ok) throw new Error(`CalDAV ${res.status}: ${text.slice(0, 300) || res.statusText}`);
  return { status: res.status, text, url };
}

function xmlHrefs(text) {
  return [...String(text).matchAll(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/gi)].map((m) => m[1].trim());
}

async function acquireCalendarUrl(conn) {
  if (conn.config.calendarUrl) return conn.config.calendarUrl;
  const base = conn.config.url;
  if (!base) throw new Error('Calendar connection has no URL.');
  const principal = await caldavFetch(conn, base, {
    method: 'PROPFIND',
    headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>',
  });
  const principalHref = xmlHrefs(principal.text)[0];
  if (!principalHref) throw new Error('CalDAV did not return a current-user-principal.');
  const principalUrl = new URL(principalHref, base).toString();
  const home = await caldavFetch(conn, principalUrl, {
    method: 'PROPFIND',
    headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:calendar-home-set xmlns:d="urn:ietf:params:xml:ns:caldav"/></d:prop></d:propfind>',
  });
  const homeHref = xmlHrefs(home.text)[0];
  if (!homeHref) throw new Error('CalDAV did not return a calendar-home-set.');
  const homeUrl = new URL(homeHref, principalUrl).toString();
  const list = await calendarList(conn, homeUrl);
  if (!list.length) throw new Error('No calendars were found on this account.');
  return list[0].url;
}

async function calendarList(conn, homeUrl) {
  const url = homeUrl || conn.config.url;
  const res = await caldavFetch(conn, url, {
    method: 'PROPFIND',
    headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>',
  });
  const blocks = res.text.split(/<(?:d:)?response[\s>]/i).slice(1);
  const calendars = [];
  for (const block of blocks) {
    const hrefMatch = /<(?:d:)?href[^>]*>([^<]+)<\/(?:d:)?href>/i.exec(block);
    if (!hrefMatch) continue;
    const isCalendar = /<(?:c:)?calendar\s*\/>|calendartype/i.test(block);
    const nameMatch = /<(?:d:)?displayname[^>]*>([^<]*)<\/(?:d:)?displayname>/i.exec(block);
    if (!isCalendar) continue;
    calendars.push({ url: new URL(hrefMatch[1].trim(), url).toString(), name: nameMatch ? nameMatch[1].trim() : hrefMatch[1] });
  }
  return calendars;
}

function unescapeXml(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseIcsEvents(text) {
  const events = [];
  const raw = String(text || '').replace(/\r?\n[ \t]/g, '');
  for (const block of raw.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0];
    const get = (name) => {
      const m = new RegExp(`^${name}[^:\\n]*:(.*)$`, 'mi').exec(body);
      return m ? unescapeXml(m[1].trim()) : '';
    };
    if (!get('UID') && !get('SUMMARY')) continue;
    events.push({
      uid: get('UID'),
      summary: get('SUMMARY'),
      start: get('DTSTART'),
      end: get('DTEND'),
      location: get('LOCATION'),
      description: get('DESCRIPTION').slice(0, 300),
    });
  }
  return events;
}

function icsDate(value) {
  const clean = String(value || '').trim();
  if (/^\d{8}$/.test(clean)) return `${clean}T000000`;
  const d = new Date(clean);
  if (Number.isNaN(d.getTime())) throw new Error(`"${value}" is not a valid date/time.`);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

async function calendarTest(conn) {
  const calendars = await calendarList(conn);
  return { ok: true, output: `CalDAV login works — ${calendars.length} calendar(s): ${calendars.map((c) => c.name).join(', ') || '(none)'}.` };
}

async function calendarAction(conn, action, args) {
  if (action === 'calendars') {
    const calendars = await calendarList(conn);
    return { ok: true, output: calendars.length ? `${calendars.length} calendar(s):\n${calendars.map((c) => `${c.name} — ${c.url}`).join('\n')}` : 'No calendars found.', calendars };
  }
  if (action === 'events') {
    const calUrl = await acquireCalendarUrl(conn);
    const from = args.from ? icsDate(args.from) : icsDate(new Date(Date.now() - 30 * 86400000).toISOString());
    const to = args.to ? icsDate(args.to) : icsDate(new Date(Date.now() + 90 * 86400000).toISOString());
    const body = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${from}" end="${to}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const res = await caldavFetch(conn, calUrl, { method: 'REPORT', headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' }, body });
    const cdata = [...res.text.matchAll(/<c:calendar-data[^>]*>([\s\S]*?)<\/c:calendar-data>|<calendar-data[^>]*>([\s\S]*?)<\/calendar-data>/gi)].map((m) => unescapeXml(m[1] || m[2] || ''));
    const events = cdata.flatMap((ics) => parseIcsEvents(ics));
    return {
      ok: true,
      output: events.length ? `${events.length} event(s) between ${from} and ${to}:\n${events.map((e) => `${e.start} — ${e.summary}${e.location ? ` @ ${e.location}` : ''} (uid ${e.uid})`).join('\n')}` : `No events between ${from} and ${to}.`,
      events,
    };
  }
  if (action === 'create') {
    const summary = String(args.summary || '').trim();
    if (!summary) throw new Error('summary is required.');
    const start = icsDate(args.start || new Date().toISOString());
    const end = icsDate(args.end || new Date(Date.now() + 3600000).toISOString());
    if (end <= start) throw new Error('end must be after start.');
    const calUrl = await acquireCalendarUrl(conn);
    const uid = `${crypto.randomUUID()}@orvex`;
    const stamp = icsDate(new Date().toISOString());
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//ORVEX//Integrations//EN',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SUMMARY:${String(summary).replace(/[\r\n]/g, ' ')}`,
      args.location ? `LOCATION:${String(args.location).replace(/[\r\n]/g, ' ')}` : '',
      args.description ? `DESCRIPTION:${String(args.description).replace(/\r?\n/g, '\\n')}` : '',
      'END:VEVENT',
      'END:VCALENDAR',
    ].filter(Boolean).join('\r\n');
    const href = new URL(`${uid}.ics`, calUrl.endsWith('/') ? calUrl : `${calUrl}/`).toString();
    await caldavFetch(conn, href, { method: 'PUT', headers: { 'content-type': 'text/calendar; charset=utf-8', 'if-none-match': '*' }, body: ics });
    return { ok: true, output: `Created "${summary}" ${start} → ${end}.\n${href}`, href, uid };
  }
  if (action === 'delete') {
    const href = String(args.href || '').trim();
    if (!/^https?:\/\//.test(href)) throw new Error('href must be the full event URL from the list action.');
    await caldavFetch(conn, href, { method: 'DELETE' });
    return { ok: true, output: `Deleted ${href}.` };
  }
  throw new Error(`Unknown calendar action "${action}".`);
}

/* --------------------------------------------------------------- databases */

function isWriteSql(sql) {
  const head = String(sql || '').trim().replace(/^(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/g, '').split(/\s+/)[0] || '';
  return !/^(select|with|pragma|explain|show|describe|values|table)\b/i.test(head);
}

function formatRows(rows) {
  const list = Array.isArray(rows) ? rows.slice(0, MAX_DB_ROWS) : [];
  if (!list.length) return { text: '(0 rows)', rows: list };
  const columns = [...new Set(list.flatMap((r) => Object.keys(r || {})))];
  const cell = (v) => {
    if (v == null) return 'NULL';
    if (Buffer.isBuffer(v)) return `[${v.length} bytes]`;
    if (typeof v === 'object') return JSON.stringify(v);
    const s = String(v);
    return s.length > 80 ? `${s.slice(0, 77)}…` : s;
  };
  const lines = [`${columns.join(' | ')}`, columns.map((c) => '-'.repeat(Math.min(24, c.length))).join('-|-')];
  for (const row of list) lines.push(columns.map((c) => cell(row[c])).join(' | '));
  if (Array.isArray(rows) && rows.length > MAX_DB_ROWS) lines.push(`… ${rows.length - MAX_DB_ROWS} more row(s) not shown`);
  return { text: lines.join('\n'), rows: list, columns };
}

async function pgClient(conn) {
  const { Client } = require('pg');
  const password = await secretOf(conn, 'password');
  let ssl = false;
  if (String(conn.config.ssl || 'false') === 'true') {
    // Certificates are always verified. A private CA can be supplied as a file.
    ssl = { rejectUnauthorized: true };
    const caFile = String(conn.config.sslCa || '').trim();
    if (caFile) {
      const blocked = checkPath(caFile, 'read');
      if (blocked) throw new Error(blocked);
      ssl.ca = fs.readFileSync(caFile, 'utf8');
    }
  }
  const client = new Client({
    host: conn.config.host || 'localhost',
    port: clampInt(conn.config.port, 1, 65535, 5432),
    database: conn.config.database || undefined,
    user: conn.config.user || undefined,
    password: password || undefined,
    ssl,
    connectionTimeoutMillis: CONNECT_TIMEOUT,
    query_timeout: 30000,
    statement_timeout: 30000,
  });
  await client.connect();
  return client;
}

async function postgresTest(conn) {
  const client = await pgClient(conn);
  try {
    const { rows } = await client.query('select version() as version, current_database() as db');
    return { ok: true, output: `${rows[0].db}: ${String(rows[0].version).slice(0, 120)}` };
  } finally {
    await client.end().catch(() => {});
  }
}

async function postgresAction(conn, action, args) {
  const client = await pgClient(conn);
  try {
    if (action === 'tables') {
      const { rows } = await client.query("select table_schema, table_name from information_schema.tables where table_schema not in ('pg_catalog','information_schema') order by 1,2");
      return { ok: true, output: rows.length ? `${rows.length} table(s):\n${rows.map((r) => `${r.table_schema}.${r.table_name}`).join('\n')}` : 'No user tables.', tables: rows };
    }
    if (action === 'query') {
      const sql = String(args.sql || '').trim();
      if (!sql) throw new Error('sql is required.');
      const write = String(args.write || 'false') === 'true' || isWriteSql(sql);
      if (write && String(args.write || 'false') !== 'true') throw new Error('This statement writes; set write to "true" (the agent asks for approval first).');
      const result = await client.query({ text: sql, rowMode: 'object' });
      if (Array.isArray(result.rows)) {
        const formatted = formatRows(result.rows);
        return { ok: true, output: `${result.command} — ${result.rowCount ?? result.rows.length} row(s)\n${formatted.text}`, rows: formatted.rows, columns: formatted.columns };
      }
      return { ok: true, output: `${result.command} — done.` };
    }
    throw new Error(`Unknown PostgreSQL action "${action}".`);
  } finally {
    await client.end().catch(() => {});
  }
}

function sqliteOpen(conn, write) {
  const file = String(conn.config.file || '').trim();
  if (!file) throw new Error('SQLite connection has no file path.');
  const blocked = checkPath(file, write ? 'write' : 'read');
  if (blocked) throw new Error(blocked);
  if (!fs.existsSync(file)) throw new Error(`Database file not found: ${file}`);
  return new Database(file, { readonly: !write, fileMustExist: true });
}

async function sqliteTest(conn) {
  const db = sqliteOpen(conn, false);
  try {
    const row = db.prepare("select count(*) as tables from sqlite_master where type='table'").get();
    return { ok: true, output: `Opened ${conn.config.file} — ${row.tables} table(s).` };
  } finally {
    db.close();
  }
}

async function sqliteAction(conn, action, args) {
  if (action === 'tables') {
    const db = sqliteOpen(conn, false);
    try {
      const rows = db.prepare("select name, type from sqlite_master where type in ('table','view') order by name").all();
      return { ok: true, output: rows.length ? `${rows.length} table/view(s):\n${rows.map((r) => `${r.type}: ${r.name}`).join('\n')}` : 'No tables.', tables: rows };
    } finally {
      db.close();
    }
  }
  if (action === 'query') {
    const sql = String(args.sql || '').trim();
    if (!sql) throw new Error('sql is required.');
    const write = String(args.write || 'false') === 'true';
    if (!write && isWriteSql(sql)) throw new Error('This statement writes; set write to "true" (the agent asks for approval first).');
    const db = sqliteOpen(conn, write);
    try {
      const stmt = db.prepare(sql);
      if (stmt.reader) {
        const rows = stmt.all();
        const formatted = formatRows(rows);
        return { ok: true, output: `${rows.length} row(s)\n${formatted.text}`, rows: formatted.rows, columns: formatted.columns };
      }
      const info = stmt.run();
      return { ok: true, output: `Done — ${info.changes} row(s) changed.` };
    } finally {
      db.close();
    }
  }
  throw new Error(`Unknown SQLite action "${action}".`);
}

/* ------------------------------------------------------------------ S3 */

function rfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hmac(key, text) {
  return crypto.createHmac('sha256', key).update(text, 'utf8').digest();
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data || '').digest('hex');
}

function s3Endpoints(conn) {
  const region = conn.config.region || 'us-east-1';
  const endpoint = (conn.config.endpoint || `https://s3.${region}.amazonaws.com`).replace(/\/+$/, '');
  const bucket = String(conn.config.bucket || '').trim();
  if (!bucket) throw new Error('S3 connection has no bucket.');
  return { region, endpoint, bucket };
}

function s3SignedUrl(conn, { method = 'GET', key = '', query = {}, body = '', contentType = '' } = {}) {
  const { region, endpoint, bucket } = s3Endpoints(conn);
  const u = new URL(endpoint);
  const basePath = u.pathname.replace(/\/+$/, '');
  const encodedKey = String(key || '').split('/').map((seg) => rfc3986(seg)).join('/');
  const pathname = `${basePath}/${rfc3986(bucket)}${encodedKey ? `/${encodedKey}` : ''}`;
  const params = Object.entries(query)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => [rfc3986(k), rfc3986(String(v))])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQuery = params.map(([k, v]) => `${k}=${v}`).join('&');
  const host = u.host;
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (contentType) headers['content-type'] = contentType;
  const sessionToken = conn.sessionToken;
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;
  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((h) => `${h}:${String(headers[h]).trim()}\n`).join('');
  const signedHeaders = signedNames.join(';');
  const canonicalRequest = [method, pathname || '/', canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${conn.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${conn.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `${u.origin}${pathname}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
  const outHeaders = { ...headers, authorization };
  delete outHeaders.host;
  return { url, headers: outHeaders, method };
}

async function s3Config(conn) {
  const secretAccessKey = await secretOf(conn, 'secretAccessKey');
  if (!secretAccessKey) throw new Error('S3 connection has no secret access key.');
  const sessionToken = (await secretOf(conn, 'sessionToken')) || undefined;
  if (!conn.config.accessKeyId) throw new Error('S3 connection has no access key id.');
  return { ...conn, secretAccessKey, sessionToken, accessKeyId: conn.config.accessKeyId };
}

async function s3Fetch(signed, { body, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(signed.url, { method: signed.method, headers: signed.headers, body, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`S3 request failed: ${err && err.name === 'AbortError' ? 'timed out' : (err && err.message) || String(err)}`);
  }
  clearTimeout(timer);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`S3 ${res.status}: ${buffer.toString('utf8').slice(0, 400) || res.statusText}`);
  return { res, buffer };
}

async function s3Test(conn) {
  const signed = s3SignedUrl(await s3Config(conn), { method: 'GET', query: { 'list-type': '2', 'max-keys': 1 } });
  const { res, buffer } = await s3Fetch(signed);
  const count = (buffer.toString('utf8').match(/<Key>/g) || []).length;
  return { ok: true, output: `Bucket is reachable (HTTP ${res.status}, ${count} key preview).` };
}

async function s3Action(conn, action, args) {
  const cfg = await s3Config(conn);
  if (action === 'list') {
    const signed = s3SignedUrl(cfg, { method: 'GET', query: { 'list-type': '2', prefix: args.prefix || '', 'max-keys': clampInt(args.limit, 1, 1000, 50) } });
    const { buffer } = await s3Fetch(signed);
    const text = buffer.toString('utf8');
    const keys = [...text.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    const sizes = [...text.matchAll(/<Size>([^<]+)<\/Size>/g)].map((m) => Number(m[1]));
    const objects = keys.map((k, i) => ({ key: k, size: sizes[i] || 0 }));
    return { ok: true, output: objects.length ? `${objects.length} object(s):\n${objects.map((o) => `${o.key} — ${o.size} bytes`).join('\n')}` : 'No objects.', objects };
  }
  if (action === 'get') {
    const key = String(args.key || '').trim();
    if (!key) throw new Error('key is required.');
    const signed = s3SignedUrl(cfg, { method: 'GET', key });
    const { buffer } = await s3Fetch(signed, { timeoutMs: 60000 });
    const file = await saveDownload(path.basename(key), buffer);
    const preview = buffer.length <= 512 * 1024 && /^[\x09\x0A\x0D\x20-\x7E]*$/.test(buffer.subarray(0, 2000).toString('binary')) ? buffer.toString('utf8').slice(0, 3000) : '(binary object)';
    return { ok: true, output: `Downloaded ${key} (${buffer.length} bytes) to ${file}.\n${preview}`, file, bytes: buffer.length };
  }
  if (action === 'put') {
    const key = String(args.key || '').trim();
    const content = args.content != null ? String(args.content) : '';
    if (!key) throw new Error('key is required.');
    if (args.content == null) throw new Error('content is required.');
    const contentType = String(args.contentType || 'text/plain');
    const signed = s3SignedUrl(cfg, { method: 'PUT', key, body: content, contentType });
    await s3Fetch(signed, { body: content });
    return { ok: true, output: `Uploaded ${Buffer.byteLength(content)} bytes to ${key}.` };
  }
  if (action === 'delete') {
    const key = String(args.key || '').trim();
    if (!key) throw new Error('key is required.');
    const signed = s3SignedUrl(cfg, { method: 'DELETE', key });
    await s3Fetch(signed);
    return { ok: true, output: `Deleted ${key}.` };
  }
  throw new Error(`Unknown S3 action "${action}".`);
}

/* ------------------------------------------------------------- Google Drive */

async function driveToken(conn) {
  const accountId = String(conn.config.accountId || '').trim();
  if (!accountId) throw new Error('Google Drive connection needs an OAuth account id from the OAuth tab.');
  const token = await oauthToken(accountId);
  if (!token) throw new Error(`OAuth account "${accountId}" has no usable access token.`);
  return token;
}

async function driveFetch(conn, url, init = {}) {
  const token = await driveToken(conn);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let res;
  try {
    res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, 'user-agent': 'ORVEX/1.0', ...(init.headers || {}) }, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Drive request failed: ${err && err.name === 'AbortError' ? 'timed out' : (err && err.message) || String(err)}`);
  }
  clearTimeout(timer);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Drive ${res.status}: ${text.slice(0, 300) || res.statusText}`);
  }
  return res;
}

async function driveTest(conn) {
  const res = await driveFetch(conn, 'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress),storageQuota(limit,usage)');
  const data = await res.json();
  const user = data.user || {};
  const quota = data.storageQuota || {};
  return { ok: true, output: `Signed in as ${user.displayName || user.emailAddress || 'a Drive account'}. ${quota.limit ? `Storage ${quota.usage}/${quota.limit} bytes.` : 'Storage quota not reported.'}` };
}

async function driveAction(conn, action, args) {
  if (action === 'about') {
    const res = await driveFetch(conn, 'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress),storageQuota(limit,usage),importFormats');
    const data = await res.json();
    return { ok: true, output: JSON.stringify(data, null, 2).slice(0, 3000), about: data };
  }
  if (action === 'list') {
    const q = args.query ? `&q=${encodeURIComponent(String(args.query))}` : '';
    const limit = clampInt(args.limit, 1, 100, 25);
    const res = await driveFetch(conn, `https://www.googleapis.com/drive/v3/files?pageSize=${limit}&fields=files(id,name,mimeType,size,modifiedTime,webViewLink)${q}`);
    const data = await res.json();
    const files = data.files || [];
    return { ok: true, output: files.length ? `${files.length} file(s):\n${files.map((f) => `${f.name} — ${f.mimeType}${f.size ? ` — ${f.size} bytes` : ''} (id ${f.id})`).join('\n')}` : 'No files matched.', files };
  }
  if (action === 'upload') {
    const name = String(args.name || '').trim() || `orvex-${Date.now()}.txt`;
    const content = String(args.content ?? '');
    if (args.content == null) throw new Error('content is required.');
    const mimeType = String(args.mimeType || 'text/plain');
    const boundary = `orvex${crypto.randomBytes(8).toString('hex')}`;
    const payload = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify({ name, mimeType }),
      `--${boundary}`,
      `Content-Type: ${mimeType}`,
      '',
      content,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const res = await driveFetch(conn, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
      method: 'POST',
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      body: payload,
    });
    const data = await res.json();
    return { ok: true, output: `Uploaded "${data.name}" (id ${data.id})${data.webViewLink ? `\n${data.webViewLink}` : ''}`, file: data };
  }
  if (action === 'download') {
    const fileId = String(args.fileId || '').trim();
    if (!fileId) throw new Error('fileId is required.');
    const metaRes = await driveFetch(conn, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=name,mimeType,size`);
    const meta = await metaRes.json();
    const res = await driveFetch(conn, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {});
    const buffer = Buffer.from(await res.arrayBuffer());
    const file = await saveDownload(meta.name || fileId, buffer);
    return { ok: true, output: `Downloaded "${meta.name}" (${buffer.length} bytes, ${meta.mimeType || 'unknown type'}) to ${file}.`, file, bytes: buffer.length, meta };
  }
  if (action === 'delete') {
    const fileId = String(args.fileId || '').trim();
    if (!fileId) throw new Error('fileId is required.');
    await driveFetch(conn, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    return { ok: true, output: `Deleted Drive file ${fileId}.` };
  }
  throw new Error(`Unknown Drive action "${action}".`);
}

/* --------------------------------------------------------------- connection */

async function testConnection(id) {
  const conn = connectionById(id);
  await requireSecrets(conn);
  let result;
  if (conn.kind === 'github') result = await githubTest(conn);
  else if (conn.kind === 'email') result = await emailTest(conn);
  else if (conn.kind === 'calendar') result = await calendarTest(conn);
  else if (conn.kind === 'postgres') result = await postgresTest(conn);
  else if (conn.kind === 'sqlite') result = await sqliteTest(conn);
  else if (conn.kind === 's3') result = await s3Test(conn);
  else if (conn.kind === 'gdrive') result = await driveTest(conn);
  else throw new Error(`Unknown integration kind "${conn.kind}".`);
  conn.lastTest = { ok: true, output: result.output, ts: nowIso() };
  await persist();
  changed('test', { id: conn.id });
  return result;
}

async function runConnectionAction({ id, action, args } = {}) {
  const conn = connectionById(id);
  await requireSecrets(conn);
  const act = String(action || '').trim();
  if (!act) throw new Error('action is required.');
  const payload = args && typeof args === 'object' ? args : {};
  let result;
  if (conn.kind === 'github') result = await githubAction(conn, act, payload);
  else if (conn.kind === 'email') result = await emailAction(conn, act, payload);
  else if (conn.kind === 'calendar') result = await calendarAction(conn, act, payload);
  else if (conn.kind === 'postgres') result = await postgresAction(conn, act, payload);
  else if (conn.kind === 'sqlite') result = await sqliteAction(conn, act, payload);
  else if (conn.kind === 's3') result = await s3Action(conn, act, payload);
  else if (conn.kind === 'gdrive') result = await driveAction(conn, act, payload);
  else throw new Error(`Unknown integration kind "${conn.kind}".`);
  changed('action', { id: conn.id, action: act });
  return { ...result, connection: publicConnection(conn) };
}

function listConnections() {
  return { connections: store.connections.map(publicConnection), schema: schema() };
}

function health() {
  const connections = store.connections.map((c) => ({
    id: c.id,
    label: c.label,
    kind: c.kind,
    state: !c.lastTest ? 'untested' : c.lastTest.ok ? 'ok' : 'error',
    lastTest: c.lastTest,
    secretsMissing: Object.entries(c.secretSet || {}).filter(([, v]) => !v).map(([k]) => k),
  }));
  return { connections, webhook: webhookStatus(), checkedAt: nowIso() };
}

/* ------------------------------------------------------------ webhook server */

let hook = { server: null, port: null, token: null, startedAt: null, events: [], requestCount: 0 };

function webhookConfigFile() {
  return dataDir ? path.join(dataDir, 'webhook.json') : null;
}

function loadWebhookConfig() {
  try {
    return JSON.parse(fs.readFileSync(webhookConfigFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveWebhookConfig(patch) {
  const file = webhookConfigFile();
  if (!file) return;
  const data = { ...loadWebhookConfig(), ...patch };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* read-only profile */
  }
}

async function webhookToken() {
  let token = await vault.get('webhook:token');
  if (!token) {
    token = crypto.randomBytes(18).toString('hex');
    await vault.set('webhook:token', token);
  }
  return token;
}

function recordEvent(event) {
  hook.events.push(event);
  if (hook.events.length > MAX_EVENTS) hook.events.splice(0, hook.events.length - MAX_EVENTS);
  hook.requestCount += 1;
  if (dataDir) {
    const file = path.join(dataDir, 'webhook-events.jsonl');
    fsp.appendFile(file, JSON.stringify(event) + '\n', 'utf8').catch(() => {});
  }
  changed('webhook', { event });
}

function webhookStatus() {
  const base = hook.port ? `http://127.0.0.1:${hook.port}/hook/${hook.token}` : null;
  return {
    running: !!hook.server,
    port: hook.port,
    url: base,
    startedAt: hook.startedAt,
    events: hook.events.length,
    requests: hook.requestCount,
    autostart: !!loadWebhookConfig().autostart,
  };
}

async function startWebhook({ port, autostart } = {}) {
  if (hook.server) return webhookStatus();
  const token = await webhookToken();
  const wanted = clampInt(port, 1, 65535, 0);
  const server = http.createServer(async (req, res) => {
    const send = (status, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const expected = `/hook/${token}`;
    if (url.pathname !== expected) return send(404, { ok: false, error: 'Unknown webhook path.' });
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_WEBHOOK_BYTES) {
        tooLarge = true;
        break;
      }
      chunks.push(chunk);
    }
    if (tooLarge) return send(413, { ok: false, error: `Body is larger than ${MAX_WEBHOOK_BYTES} bytes.` });
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = raw;
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
      if (json) body = json;
    } catch {
      json = null;
    }
    const id = crypto.randomUUID();
    const event = {
      id,
      ts: nowIso(),
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)])),
      body,
      bytes: Buffer.byteLength(raw),
      remote: req.socket.remoteAddress || '',
    };
    recordEvent(event);
    send(200, { ok: true, received: true, id });
  });
  server.on('error', (err) => {
    hook.server = null;
    hook.port = null;
    changed('webhook-error', { error: err && err.message ? err.message : String(err) });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(wanted, '127.0.0.1', resolve);
  });
  hook.server = server;
  hook.port = server.address().port;
  hook.token = token;
  hook.startedAt = nowIso();
  saveWebhookConfig({ autostart: autostart === undefined ? true : !!autostart, port: hook.port });
  changed('webhook-start', { port: hook.port });
  return webhookStatus();
}

async function autostartWebhook() {
  const cfg = loadWebhookConfig();
  if (!cfg.autostart) return webhookStatus();
  try {
    return await startWebhook({ port: cfg.port, autostart: true });
  } catch (err) {
    changed('webhook-error', { error: err && err.message ? err.message : String(err) });
    return webhookStatus();
  }
}

async function stopWebhook({ persist = true } = {}) {
  if (!hook.server) {
    if (persist) saveWebhookConfig({ autostart: false });
    return webhookStatus();
  }
  const server = hook.server;
  hook.server = null;
  hook.port = null;
  hook.startedAt = null;
  await new Promise((resolve) => server.close(() => resolve()));
  if (persist) saveWebhookConfig({ autostart: false });
  changed('webhook-stop', {});
  return webhookStatus();
}

function webhookEvents(limit = 20) {
  const n = clampInt(limit, 1, MAX_EVENTS, 20);
  return { events: hook.events.slice(-n).reverse(), status: webhookStatus() };
}

function clearWebhookEvents() {
  hook.events = [];
  hook.requestCount = 0;
  changed('webhook-clear', {});
  return webhookStatus();
}

async function webhookTest() {
  const status = webhookStatus();
  if (!status.running || !status.url) throw new Error('The webhook server is not running.');
  const body = JSON.stringify({ event: 'orvex.test', at: nowIso(), note: 'Sent by ORVEX from this machine.' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(status.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`Webhook test returned HTTP ${res.status}: ${text.slice(0, 200)}`);
    return { ok: true, output: `Webhook accepted the test delivery (HTTP ${res.status}): ${text}`, delivery: webhookEvents(1).events[0] || null };
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------------------------------- approval + tools */

function actionNeedsApproval(kind, action, args) {
  const a = action || '';
  if (kind === 'github') return ['create_issue', 'comment'].includes(a) ? 'This writes to GitHub with your account.' : null;
  if (kind === 'email') return a === 'send' ? 'This sends an email from your account.' : null;
  if (kind === 'calendar') return ['create', 'delete'].includes(a) ? 'This changes events in your calendar.' : null;
  if (kind === 'postgres' || kind === 'sqlite') {
    if (a !== 'query') return null;
    const writeArg = String((args && args.write) || 'false') === 'true';
    return writeArg || isWriteSql(args && args.sql) ? 'This runs a write statement on your database.' : null;
  }
  if (kind === 's3') return ['put', 'delete'].includes(a) ? 'This writes to your object storage.' : null;
  if (kind === 'gdrive') return ['upload', 'delete'].includes(a) ? 'This writes to your Google Drive.' : null;
  return null;
}

function approvalReason(name, args = {}) {
  if (name === 'http_request') {
    const method = String(args.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) return `This sends a ${method} request to an external service.`;
    return null;
  }
  if (name === 'integration_call') {
    const conn = store.connections.find((c) => c.id === String(args.connection || ''));
    if (!conn) return null;
    return actionNeedsApproval(conn.kind, args.action, args.args);
  }
  if (name === 'webhook_server') {
    const op = String(args.op || 'status');
    if (op === 'start' || op === 'stop') return 'This opens or closes a local webhook endpoint on this PC.';
  }
  return null;
}

const definitions = [
  {
    name: 'http_request',
    description: 'Call a real HTTP(S) API. Returns status, headers and a body preview; set json for a JSON body. Non-GET methods need approval. This is how you reach REST APIs that have no built-in integration.',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], description: 'HTTP method (default GET).' },
        url: { type: 'string', description: 'Full http(s) URL.' },
        headers: { type: 'object', description: 'Optional request headers.' },
        body: { type: 'string', description: 'Raw request body.' },
        json: { description: 'JSON body (object or string); sets content-type automatically.' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 30000, max 180000).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'ws_request',
    description: 'Open a real WebSocket, optionally send one message, and collect the replies. Returns every received message.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'ws:// or wss:// URL.' },
        message: { description: 'Message to send after connecting (string or JSON).' },
        messages: { type: 'number', description: 'How many messages to collect before closing (default 20).' },
        timeoutMs: { type: 'number', description: 'Overall timeout in ms (default 15000).' },
        headers: { type: 'object', description: 'Optional handshake headers.' },
        protocols: { type: 'array', items: { type: 'string' }, description: 'Optional subprotocols.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'integration_list',
    description: 'List the integration connections configured in ORVEX with their kind, config and last health test. Use integration_call to run an action.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'integration_call',
    description: 'Run an action on a configured integration connection: GitHub (me, repos, issues, pulls, create_issue, comment), email (inbox, search, read, send, folders), calendar (calendars, events, create, delete), postgres/sqlite (tables, query), s3 (list, get, put, delete), gdrive (about, list, upload, download, delete). Writes need approval.',
    parameters: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: 'Connection id from integration_list.' },
        action: { type: 'string', description: 'Action id from the connection schema.' },
        args: { type: 'object', description: 'Action arguments (repo, title, query, sql, key, fileId…).' },
      },
      required: ['connection', 'action'],
    },
  },
  {
    name: 'webhook_server',
    description: 'Control the loopback webhook receiver: status, start, stop, events, clear or test. External services on this PC can POST to the returned URL; each delivery is recorded.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['status', 'start', 'stop', 'events', 'clear', 'test'], description: 'Operation.' },
        limit: { type: 'number', description: 'How many recent events to return.' },
        port: { type: 'number', description: 'Preferred port for start (default random).' },
      },
      required: ['op'],
    },
  },
  {
    name: 'integration_health',
    description: 'Report the real health of every connection, the webhook receiver and the MCP server, including the last test output.',
    parameters: { type: 'object', properties: {} },
  },
];

const handlers = {
  async http_request(args) {
    return await httpRequest(args);
  },
  async ws_request(args) {
    return await wsRequest(args);
  },
  async integration_list() {
    const { connections } = listConnections();
    if (!connections.length) return { ok: true, output: 'No integration connections yet. Open Integrations to add GitHub, email, calendar, a database or storage.' };
    return {
      ok: true,
      output: connections
        .map((c) => `[${c.id}] ${c.label} (${c.kind}) — ${c.lastTest ? (c.lastTest.ok ? 'healthy' : `error: ${c.lastTest.output.slice(0, 80)}`) : 'untested'}`)
        .join('\n'),
      connections,
    };
  },
  async integration_call(args) {
    const result = await runConnectionAction({ id: args.connection, action: args.action, args: args.args });
    return { ok: true, output: result.output };
  },
  async webhook_server(args) {
    const op = String(args.op || 'status');
    if (op === 'status') {
      const status = webhookStatus();
      return { ok: true, output: status.running ? `Webhook receiver is running at ${status.url} (${status.events} event(s) in memory).` : 'The webhook receiver is stopped.' };
    }
    if (op === 'start') {
      const status = await startWebhook({ port: args.port, autostart: true });
      return { ok: true, output: `Webhook receiver is running at ${status.url}. Point a service at this URL; ORVEX records every delivery.` };
    }
    if (op === 'stop') {
      await stopWebhook();
      return { ok: true, output: 'Webhook receiver stopped.' };
    }
    if (op === 'events') {
      const data = webhookEvents(args.limit);
      if (!data.events.length) return { ok: true, output: 'No webhook deliveries yet.' };
      return {
        ok: true,
        output: data.events.map((e) => `${e.ts} ${e.method} ${e.path} — ${e.bytes} bytes${typeof e.body === 'object' && e.body ? ` — ${JSON.stringify(e.body).slice(0, 200)}` : ''}`).join('\n'),
        events: data.events,
      };
    }
    if (op === 'clear') {
      clearWebhookEvents();
      return { ok: true, output: 'Webhook delivery history cleared.' };
    }
    if (op === 'test') {
      return await webhookTest();
    }
    return { ok: false, error: 'op must be status, start, stop, events, clear or test.' };
  },
  async integration_health() {
    const h = health();
    const lines = h.connections.map((c) => `${c.label} (${c.kind}) — ${c.state}${c.lastTest ? `: ${String(c.lastTest.output).slice(0, 160)}` : ''}`);
    lines.push(`Webhook receiver — ${h.webhook.running ? `running at ${h.webhook.url}` : 'stopped'}`);
    return { ok: true, output: lines.join('\n'), health: h };
  },
};

async function requestPermission() {
  return null;
}

module.exports = {
  init,
  schema,
  listConnections,
  saveConnection,
  deleteConnection,
  testConnection,
  runConnectionAction,
  health,
  httpRequest,
  wsRequest,
  startWebhook,
  autostartWebhook,
  stopWebhook,
  webhookStatus,
  webhookEvents,
  clearWebhookEvents,
  webhookTest,
  approvalReason,
  definitions,
  handlers,
  KINDS,
  _test: { s3SignedUrl, parseIcsEvents, icsDate, isWriteSql, formatRows, actionNeedsApproval },
};
