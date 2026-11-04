'use strict';

/**
 * Section 19 — multi-device support.
 *
 * Two ORVEX installs on the same LAN can pair with a 6-digit code and then
 * exchange configuration: routing chains, prompts, workflows, custom agents and
 * the privacy mode. Secrets, vault entries, provider API keys, usage and audit
 * data are never part of a bundle — the serializer only reads the whitelisted
 * tables, so a token cannot leak through this path.
 *
 * Pairing is explicit, tokens are required on every data call, only private
 * (LAN) addresses are served, and both host and client are user-started.
 */

const http = require('node:http');
const dgram = require('node:dgram');
const os = require('node:os');
const crypto = require('node:crypto');
const db = require('./db.cjs');

const DEFAULT_PORT = 47821;
const DISCOVERY_PORT = 47822;
const CODE_TTL = 10 * 60 * 1000;
const MAX_BODY = 2 * 1024 * 1024;
const PAIR_ATTEMPTS = 5;
const PAIR_LOCK_MS = 5 * 60 * 1000;
const MODES = ['cloud', 'local-first', 'hybrid', 'offline'];
// A custom header forces a CORS preflight, so a web page the user happens to
// visit cannot silently POST pairing codes to a LAN host.
const SYNC_HEADER = 'x-orvex-sync';

let ctx = { emit: () => {}, version: () => '1.0.0' };
let server = null;
let udp = null;
let pairCode = null;
let pairCodeAt = 0;
let hostPort = DEFAULT_PORT;
const pairFailures = new Map();

function init(opts = {}) {
  ctx = { ...ctx, ...opts };
  ensureDeviceId();
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
    ctx.emit(event);
  } catch {
    /* window closed */
  }
}

function ensureDeviceId() {
  let id = String(db.getSetting('advanced.device.id', '') || '');
  if (!/^dev_[a-f0-9]{12}$/.test(id)) {
    id = `dev_${crypto.randomBytes(6).toString('hex')}`;
    db.setSetting('advanced.device.id', id);
    db.setSetting('advanced.device.name', os.hostname());
  }
  if (!db.getSetting('advanced.device.name', '')) db.setSetting('advanced.device.name', os.hostname());
  return id;
}

function deviceId() {
  return ensureDeviceId();
}

function deviceName() {
  return String(db.getSetting('advanced.device.name', os.hostname()) || os.hostname());
}

function setName(name) {
  const value = clip(String(name || '').trim(), 60);
  if (!value) throw new Error('Device name cannot be empty.');
  db.setSetting('advanced.device.name', value);
  return { name: value };
}

function localInfo() {
  return { id: deviceId(), name: deviceName(), platform: process.platform, version: ctx.version(), port: hostPort };
}

/* ------------------------------------------------------------- pairing */

function codes() {
  const saved = db.getSetting('advanced.device.pairs', {}) || {};
  // A null-prototype map makes inherited keys ("__proto__", "constructor")
  // impossible to mistake for a paired token.
  return Object.assign(Object.create(null), saved);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function pairLock(remote) {
  const entry = pairFailures.get(remote);
  if (!entry) return 0;
  const wait = entry.lockedUntil - now();
  if (wait <= 0) {
    pairFailures.delete(remote);
    return 0;
  }
  return wait;
}

function notePairFailure(remote) {
  const entry = pairFailures.get(remote) || { attempts: 0, lockedUntil: 0 };
  entry.attempts += 1;
  if (entry.attempts >= PAIR_ATTEMPTS) {
    entry.attempts = 0;
    entry.lockedUntil = now() + PAIR_LOCK_MS;
  }
  pairFailures.set(remote, entry);
}

function saveCodes(map) {
  db.setSetting('advanced.device.pairs', map);
}

function newPairCode() {
  pairCode = String(crypto.randomInt(100000, 1000000));
  pairCodeAt = now();
  return { code: pairCode, expiresAt: pairCodeAt + CODE_TTL };
}

function currentCode() {
  if (!pairCode || now() - pairCodeAt > CODE_TTL) return null;
  return { code: pairCode, expiresAt: pairCodeAt + CODE_TTL };
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Body is not valid JSON.'));
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

function tokenFor(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : '';
}

async function handleRequest(req, res) {
  const remote = req.socket.remoteAddress;
  if (!isPrivateAddress(remote)) {
    sendJson(res, 403, { error: 'Multi-device sync only answers private LAN addresses.' });
    return;
  }
  if (String(req.headers[SYNC_HEADER] || '') !== '1') {
    sendJson(res, 403, { error: 'This endpoint only accepts ORVEX sync clients.' });
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/orvex/hello') {
      sendJson(res, 200, { ok: true, device: localInfo() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/orvex/pair') {
      const wait = pairLock(remote);
      if (wait > 0) {
        sendJson(res, 429, { error: `Too many wrong pairing codes. Try again in ${Math.ceil(wait / 1000)}s.` });
        return;
      }
      const body = (await readBody(req)) || {};
      const code = String(body.code || '').trim();
      const active = currentCode();
      if (!active || !safeEqual(code, active.code)) {
        notePairFailure(remote);
        sendJson(res, 401, { error: 'That pairing code is wrong or expired. Ask the host to show a fresh one.' });
        return;
      }
      pairFailures.delete(remote);
      const peerName = clip(String(body.name || 'ORVEX device').trim(), 60) || 'ORVEX device';
      const token = crypto.randomBytes(24).toString('hex');
      const map = codes();
      map[token] = { deviceId: String(body.deviceId || ''), name: peerName, pairedAt: now() };
      saveCodes(map);
      pairCode = null;
      db.audit({ kind: 'device-pair', tool: 'devices', args: JSON.stringify({ peer: peerName }), ok: true });
      emit({ type: 'device-paired', name: peerName, at: now() });
      sendJson(res, 200, { ok: true, token, host: localInfo() });
      return;
    }
    if (url.pathname === '/orvex/bundle') {
      const token = tokenFor(req);
      const pairs = codes();
      const pair = token && Object.prototype.hasOwnProperty.call(pairs, token) ? pairs[token] : null;
      if (!pair) {
        sendJson(res, 401, { error: 'Pair this device first.' });
        return;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, bundle: buildBundle() });
        return;
      }
      if (req.method === 'POST') {
        const body = (await readBody(req)) || {};
        const result = applyBundle(body.bundle);
        raw()?.prepare('INSERT INTO adv_sync_log(at, direction, device, items, ok, error) VALUES(?, ?, ?, ?, 1, NULL)').run(
          now(),
          'received',
          pair.name,
          JSON.stringify(result),
        );
        emit({ type: 'device-sync', direction: 'received', device: pair.name, items: result, at: now() });
        sendJson(res, 200, { ok: true, applied: result });
        return;
      }
    }
    sendJson(res, 404, { error: 'Unknown endpoint.' });
  } catch (err) {
    sendJson(res, 400, { error: err && err.message ? err.message : String(err) });
  }
}

function startHost({ port } = {}) {
  if (server) return hostStatus();
  hostPort = Math.min(Math.max(Math.round(Number(port) || DEFAULT_PORT), 1024), 65535);
  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => sendJson(res, 500, { error: err && err.message ? err.message : String(err) }));
  });
  server.on('error', (err) => {
    const message = err && err.message ? err.message : String(err);
    try {
      server.close();
    } catch {
      /* not listening */
    }
    server = null;
    emit({ type: 'device-host-error', error: message, at: now() });
  });
  server.listen(hostPort, '0.0.0.0', () => {
    hostPort = server.address().port;
    startDiscovery();
    emit({ type: 'device-host', port: hostPort, at: now() });
  });
  const pair = newPairCode();
  return { ...hostStatus(), code: pair };
}

function stopHost() {
  if (udp) {
    try {
      udp.close();
    } catch {
      /* already closed */
    }
    udp = null;
  }
  if (server) {
    try {
      server.close();
    } catch {
      /* already closed */
    }
    server = null;
  }
  pairCode = null;
  pairFailures.clear();
  return hostStatus();
}

function hostStatus() {
  return {
    hosting: !!server,
    port: server && server.address() ? server.address().port : hostPort,
    discoveryPort: DISCOVERY_PORT,
    code: currentCode(),
    device: localInfo(),
    paired: Object.values(codes()).map((p) => ({ name: p.name, pairedAt: p.pairedAt })),
  };
}

function startDiscovery() {
  if (udp) return;
  udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('message', (msg, rinfo) => {
    if (String(msg.toString('utf8')).trim() !== 'ORVEX_DISCOVER_V1') return;
    // Only answer machines on this LAN, never a spoofed public source.
    if (!isPrivateAddress(rinfo.address)) return;
    const reply = Buffer.from(JSON.stringify({ orvex: 1, device: localInfo(), port: hostPort }));
    try {
      udp.send(reply, rinfo.port, rinfo.address);
    } catch {
      /* the peer vanished */
    }
  });
  udp.on('error', () => {
    try {
      udp.close();
    } catch {
      /* ignore */
    }
    udp = null;
  });
  try {
    udp.bind(DISCOVERY_PORT);
  } catch {
    udp = null;
  }
}

function discover({ timeoutMs = 1800 } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve({ devices: [...found.values()], note: found.size ? null : 'No ORVEX host answered on the LAN. Start hosting on the other device, or pair by address.' });
    }, Math.min(Math.max(Number(timeoutMs) || 1800, 400), 8000));
    socket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString('utf8'));
        if (!data || data.orvex !== 1 || !data.device || data.device.id === deviceId()) return;
        found.set(data.device.id, { ...data.device, host: rinfo.address, port: data.port || rinfo.port });
      } catch {
        /* not our reply */
      }
    });
    socket.on('error', () => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve({ devices: [], note: 'UDP discovery is unavailable on this machine.' });
    });
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        const packet = Buffer.from('ORVEX_DISCOVER_V1');
        socket.send(packet, DISCOVERY_PORT, '255.255.255.255');
        for (const address of broadcastCandidates()) {
          try {
            socket.send(packet, DISCOVERY_PORT, address);
          } catch {
            /* interface refused broadcast */
          }
        }
      } catch {
        /* broadcast blocked by the firewall */
      }
    });
  });
}

function broadcastCandidates() {
  const out = new Set(['127.0.0.1']);
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list || []) {
        if (net.family !== 'IPv4' || net.internal) continue;
        const ip = net.address.split('.').map(Number);
        const mask = (net.netmask || '255.255.255.0').split('.').map(Number);
        out.add(ip.map((part, i) => (part & mask[i]) | (~mask[i] & 255)).join('.'));
      }
    }
  } catch {
    /* interface enumeration failed */
  }
  return [...out];
}

/* -------------------------------------------------------------- bundle */

const SAFE_SETTINGS = ['advanced.mode'];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
}

function buildBundle() {
  const rawDb = raw();
  const settings = {};
  for (const key of SAFE_SETTINGS) {
    const value = db.getSetting(key, undefined);
    if (value !== undefined) settings[key] = value;
  }
  const routing = db.getRouting ? db.getRouting() : {};
  const prompts = rawDb?.prepare('SELECT id, title, body, tags, created_at AS createdAt FROM prompts ORDER BY created_at ASC').all() || [];
  const workflows = rawDb?.prepare('SELECT id, name, graph, enabled, created_at AS createdAt, updated_at AS updatedAt FROM workflows ORDER BY created_at ASC').all() || [];
  const agents = rawDb?.prepare('SELECT id, name, role, prompt, created_at AS createdAt FROM adv_agents ORDER BY created_at ASC').all() || [];
  const body = {
    version: 1,
    from: localInfo(),
    generatedAt: now(),
    settings,
    routing,
    prompts,
    workflows: workflows.map((w) => ({ ...w, enabled: !!w.enabled })),
    agents,
  };
  body.sha256 = crypto.createHash('sha256').update(JSON.stringify(stable(body))).digest('hex');
  return body;
}

function applyBundle(bundle) {
  if (!bundle || bundle.version !== 1) throw new Error('Unsupported bundle version.');
  const copy = { ...bundle };
  delete copy.sha256;
  const digest = crypto.createHash('sha256').update(JSON.stringify(stable(copy))).digest('hex');
  if (!bundle.sha256 || !safeEqual(digest, bundle.sha256)) {
    throw new Error('The bundle failed its integrity check. An unsigned or altered bundle was refused.');
  }
  const rawDb = raw();
  if (!rawDb) throw new Error('The database is not ready.');
  const counts = { settings: 0, routing: 0, prompts: 0, workflows: 0, agents: 0 };
  if (bundle.settings && typeof bundle.settings === 'object') {
    for (const key of SAFE_SETTINGS) {
      if (bundle.settings[key] === undefined) continue;
      // Never let a peer write a mode this build cannot operate.
      if (key === 'advanced.mode' && !MODES.includes(String(bundle.settings[key]))) continue;
      db.setSetting(key, bundle.settings[key]);
      counts.settings += 1;
    }
  }
  if (bundle.routing && typeof bundle.routing === 'object') {
    for (const [task, chain] of Object.entries(bundle.routing)) {
      if (!Array.isArray(chain) || chain.length > 8) continue;
      const clean = chain
        .filter((c) => c && typeof c === 'object' && c.model)
        .slice(0, 8)
        .map((c) => ({ providerId: String(c.providerId || c.id || ''), model: String(c.model) }));
      if (!clean.length) continue;
      db.setRouting(String(task).slice(0, 40), clean);
      counts.routing += 1;
    }
  }
  for (const prompt of Array.isArray(bundle.prompts) ? bundle.prompts.slice(0, 200) : []) {
    const id = String(prompt && prompt.id || '').slice(0, 80);
    const title = String(prompt && prompt.title || '').slice(0, 200);
    const body = String(prompt && prompt.body || '').slice(0, 20000);
    if (!id || !title) continue;
    rawDb
      .prepare(
        `INSERT INTO prompts(id, title, body, tags, created_at) VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body, tags = excluded.tags`,
      )
      .run(id, title, body, prompt.tags ? String(prompt.tags).slice(0, 400) : null, Number(prompt.createdAt) || now());
    counts.prompts += 1;
  }
  for (const wf of Array.isArray(bundle.workflows) ? bundle.workflows.slice(0, 100) : []) {
    const id = String(wf && wf.id || '').slice(0, 80);
    const name = String(wf && wf.name || '').slice(0, 200);
    let graph = wf && wf.graph;
    if (typeof graph !== 'string') graph = JSON.stringify(graph || {});
    if (!id || !name) continue;
    try {
      JSON.parse(graph);
    } catch {
      continue;
    }
    rawDb
      .prepare(
        `INSERT INTO workflows(id, name, graph, enabled, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, graph = excluded.graph,
           enabled = excluded.enabled, updated_at = excluded.updated_at`,
      )
      .run(id, name, graph, wf.enabled === false ? 0 : 1, Number(wf.createdAt) || now(), now());
    counts.workflows += 1;
  }
  for (const agent of Array.isArray(bundle.agents) ? bundle.agents.slice(0, 100) : []) {
    const id = String(agent && agent.id || '').slice(0, 80);
    const name = String(agent && agent.name || '').slice(0, 80);
    const prompt = String(agent && agent.prompt || '').slice(0, 4000);
    if (!id || !name || prompt.length < 20) continue;
    rawDb
      .prepare(
        `INSERT INTO adv_agents(id, name, role, prompt, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, prompt = excluded.prompt, updated_at = excluded.updated_at`,
      )
      .run(id, name, String(agent.role || 'worker').slice(0, 40), prompt, Number(agent.createdAt) || now(), now());
    counts.agents += 1;
  }
  db.audit({ kind: 'device-sync-apply', tool: 'devices', args: JSON.stringify(counts), ok: true });
  return counts;
}

/* --------------------------------------------------------------- client */

function listDevices() {
  return (raw()?.prepare('SELECT id, name, host, port, paired_at AS pairedAt, last_seen AS lastSeen FROM adv_devices ORDER BY created_at DESC').all() || []).map((d) => ({
    ...d,
    paired: !!d.pairedAt,
  }));
}

function syncLog(limit = 30) {
  const n = Math.min(Math.max(Number(limit) || 30, 1), 200);
  return raw()?.prepare('SELECT id, at, direction, device, items, ok, error FROM adv_sync_log ORDER BY id DESC LIMIT ?').all(n) || [];
}

async function jsonFetch(url, { method = 'GET', body, token, timeout = 10_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        [SYNC_HEADER]: '1',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data && data.error ? data.error : `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function pair({ host, port, code, name } = {}) {
  const target = String(host || '').trim();
  if (!/^[a-z0-9.:\-\[\]]+$/i.test(target)) throw new Error('Enter the host IP or name of the other device.');
  const p = Math.min(Math.max(Math.round(Number(port) || DEFAULT_PORT), 1024), 65535);
  const result = await jsonFetch(`http://${target}:${p}/orvex/pair`, {
    method: 'POST',
    body: { code: String(code || '').trim(), name: deviceName(), deviceId: deviceId() },
  });
  if (!result.token || !result.host) throw new Error('The host did not return a token.');
  raw()
    ?.prepare(
      `INSERT INTO adv_devices(id, name, host, port, token, paired_at, last_seen, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, host = excluded.host, port = excluded.port,
         token = excluded.token, paired_at = excluded.paired_at, last_seen = excluded.last_seen`,
    )
    .run(result.host.id, result.host.name || target, target, p, result.token, now(), now(), now());
  db.audit({ kind: 'device-paired-out', tool: 'devices', args: JSON.stringify({ host: target, name: result.host.name }), ok: true });
  emit({ type: 'device-linked', id: result.host.id, name: result.host.name, at: now() });
  return { device: { ...result.host, host: target, port: p }, pairedAt: now() };
}

async function check(deviceIdIn) {
  const row = raw()?.prepare('SELECT * FROM adv_devices WHERE id = ?').get(String(deviceIdIn));
  if (!row) throw new Error('That device is not paired.');
  const result = await jsonFetch(`http://${row.host}:${row.port}/orvex/hello`);
  raw()?.prepare('UPDATE adv_devices SET last_seen = ? WHERE id = ?').run(now(), row.id);
  return { ok: true, device: result.device };
}

async function pull(deviceIdIn) {
  const row = raw()?.prepare('SELECT * FROM adv_devices WHERE id = ?').get(String(deviceIdIn));
  if (!row) throw new Error('That device is not paired.');
  try {
    const result = await jsonFetch(`http://${row.host}:${row.port}/orvex/bundle`, { token: row.token, timeout: 20_000 });
    if (!result.bundle) throw new Error('The host returned no bundle.');
    const applied = applyBundle(result.bundle);
    raw()?.prepare('INSERT INTO adv_sync_log(at, direction, device, items, ok, error) VALUES(?, ?, ?, ?, 1, NULL)').run(now(), 'pull', row.name, JSON.stringify(applied));
    raw()?.prepare('UPDATE adv_devices SET last_seen = ? WHERE id = ?').run(now(), row.id);
    emit({ type: 'device-sync', direction: 'pull', device: row.name, items: applied, at: now() });
    return { applied, from: result.bundle.from || null };
  } catch (err) {
    raw()?.prepare('INSERT INTO adv_sync_log(at, direction, device, items, ok, error) VALUES(?, ?, ?, NULL, 0, ?)').run(now(), 'pull', row.name, clip(err.message, 500));
    throw err;
  }
}

async function push(deviceIdIn) {
  const row = raw()?.prepare('SELECT * FROM adv_devices WHERE id = ?').get(String(deviceIdIn));
  if (!row) throw new Error('That device is not paired.');
  try {
    const bundle = buildBundle();
    const result = await jsonFetch(`http://${row.host}:${row.port}/orvex/bundle`, { method: 'POST', body: { bundle }, token: row.token, timeout: 20_000 });
    raw()?.prepare('INSERT INTO adv_sync_log(at, direction, device, items, ok, error) VALUES(?, ?, ?, ?, 1, NULL)').run(now(), 'push', row.name, JSON.stringify(result.applied || {}));
    raw()?.prepare('UPDATE adv_devices SET last_seen = ? WHERE id = ?').run(now(), row.id);
    emit({ type: 'device-sync', direction: 'push', device: row.name, items: result.applied || {}, at: now() });
    return { applied: result.applied || {} };
  } catch (err) {
    raw()?.prepare('INSERT INTO adv_sync_log(at, direction, device, items, ok, error) VALUES(?, ?, ?, NULL, 0, ?)').run(now(), 'push', row.name, clip(err.message, 500));
    throw err;
  }
}

function unpair(id) {
  const changes = raw()?.prepare('DELETE FROM adv_devices WHERE id = ?').run(String(id)).changes || 0;
  return { removed: changes };
}

function stop() {
  stopHost();
}

module.exports = {
  init,
  deviceId,
  deviceName,
  setName,
  localInfo,
  startHost,
  stopHost,
  hostStatus,
  newPairCode,
  discover,
  listDevices,
  syncLog,
  pair,
  check,
  pull,
  push,
  unpair,
  buildBundle,
  applyBundle,
  stop,
  _internals: { isPrivateAddress, safeEqual, stable, tokenFor, MODES, SYNC_HEADER },
};
