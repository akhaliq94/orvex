'use strict';

/**
 * OpenAPI / Swagger connectors: import a real spec, store it locally, and let
 * the agent call its operations as one guarded tool. Credentials live in the
 * encrypted vault under a per-connector key; they never appear in connectors.json.
 * Specs may be JSON or YAML; YAML is parsed with the JSON schema so no custom
 * tags or implicit types can sneak into a stored connector.
 */

const yaml = require('js-yaml');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL, URLSearchParams } = require('node:url');
const vault = require('./vault.cjs');
const security = require('./security.cjs');

const MAX_SPEC_BYTES = 5 * 1024 * 1024;
const MAX_OPERATIONS = 120;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT = 30000;
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const AUTH_TYPES = ['none', 'bearer', 'header', 'query'];
const BLOCKED_HEADERS = new Set(['authorization', 'cookie', 'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade']);

let connectorsFile = null;
let emit = () => {};
const store = { connectors: [] };

function nowIso() {
  return new Date().toISOString();
}

function slug(text, fallback) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

function clip(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function secretKey(id) {
  return `connector:${id}:secret`;
}

function persist() {
  if (!connectorsFile) return Promise.resolve();
  const text = JSON.stringify({ connectors: store.connectors }, null, 2);
  return fsp
    .mkdir(path.dirname(connectorsFile), { recursive: true })
    .then(() => fsp.writeFile(connectorsFile, text, 'utf8'))
    .catch(() => {});
}

function changed(extra) {
  try {
    emit({ kind: 'connectors-changed', ...(extra || {}) });
  } catch {
    /* renderer gone */
  }
}

function load() {
  store.connectors = [];
  if (!connectorsFile) return;
  let text;
  try {
    text = require('node:fs').readFileSync(connectorsFile, 'utf8');
  } catch {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  const list = Array.isArray(parsed && parsed.connectors) ? parsed.connectors : [];
  store.connectors = list
    .filter((c) => c && typeof c === 'object' && c.id && c.baseUrl && Array.isArray(c.ops))
    .map((c) => ({
      id: String(c.id),
      label: clip(c.label || c.id, 80),
      sourceUrl: String(c.sourceUrl || ''),
      specTitle: clip(c.specTitle || '', 120),
      specVersion: clip(c.specVersion || '', 40),
      baseUrl: String(c.baseUrl),
      auth: AUTH_TYPES.includes(c.auth && c.auth.type) ? { type: c.auth.type, name: clip(c.auth.name || '', 60) } : { type: 'none', name: '' },
      secretSet: !!c.secretSet,
      ops: c.ops.filter((op) => op && METHODS.includes(String(op.method || '').toLowerCase()) && op.id && op.path),
      truncated: !!c.truncated,
      createdAt: c.createdAt || nowIso(),
      updatedAt: c.updatedAt || nowIso(),
    }));
}

async function init(opts = {}) {
  const dataDir = opts.dataDir || '';
  connectorsFile = dataDir ? path.join(dataDir, 'connectors.json') : null;
  emit = typeof opts.emit === 'function' ? opts.emit : () => {};
  load();
  return { connectors: store.connectors.length };
}

/* ------------------------------------------------------------ spec parsing */

function deref(spec, node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return node;
  if (typeof node.$ref === 'string') {
    if (!node.$ref.startsWith('#/')) return null;
    let cur = spec;
    for (const raw of node.$ref.slice(2).split('/')) {
      const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
      if (!cur || typeof cur !== 'object' || !(key in cur)) return null;
      cur = cur[key];
    }
    return deref(spec, cur, depth + 1);
  }
  return node;
}

function typeOf(schema) {
  if (!schema || typeof schema !== 'object') return 'string';
  if (schema.type) return Array.isArray(schema.type) ? schema.type.join('|') : String(schema.type);
  if (schema.oneOf || schema.anyOf || schema.allOf) return 'object';
  if (schema.properties) return 'object';
  if (schema.items) return 'array';
  return 'string';
}

function serverUrlOf(spec, sourceUrl) {
  let base = '';
  if (spec.openapi && Array.isArray(spec.servers) && spec.servers[0]) {
    const server = spec.servers[0];
    base = String(server.url || '');
    const vars = server.variables && typeof server.variables === 'object' ? server.variables : {};
    base = base.replace(/\{([^}]+)\}/g, (whole, name) => {
      const v = vars[name];
      return v && v.default != null ? String(v.default) : whole;
    });
  } else if (spec.swagger) {
    const scheme = Array.isArray(spec.schemes) && spec.schemes[0] ? spec.schemes[0] : 'https';
    base = `${scheme}://${spec.host || ''}${spec.basePath || ''}`;
  }
  if (base && !/^https?:\/\//i.test(base)) {
    if (!sourceUrl) throw new Error('The spec uses a relative server URL but no source URL was given. Enter a base URL.');
    base = new URL(base, sourceUrl).href;
  }
  if (base && !/^https?:\/\//i.test(base)) throw new Error('The spec server URL must be http(s).');
  return base.replace(/\/+$/, '');
}

function collectParams(spec, item, op) {
  const merged = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])];
  const seen = new Set();
  const params = [];
  for (const raw of merged.slice(0, 40)) {
    const p = deref(spec, raw);
    if (!p || typeof p !== 'object' || !p.name) continue;
    const where = String(p.in || '');
    if (!['path', 'query', 'header'].includes(where)) continue;
    const key = `${where}:${p.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (where === 'header' && BLOCKED_HEADERS.has(String(p.name).toLowerCase())) continue;
    const schema = deref(spec, p.schema) || {};
    params.push({
      name: clip(p.name, 80),
      in: where,
      required: where === 'path' ? true : !!p.required,
      type: typeOf(schema),
      description: clip(p.description || schema.description || '', 200),
    });
  }
  return params;
}

function bodyOf(spec, op) {
  if (spec.openapi) {
    const requestBody = deref(spec, op.requestBody);
    const content = requestBody && requestBody.content && typeof requestBody.content === 'object' ? requestBody.content : null;
    if (!content) return null;
    const chosen = content['application/json'] || Object.values(content)[0];
    const schema = chosen && deref(spec, chosen.schema);
    if (!schema) return { required: !!requestBody.required, properties: [] };
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    return {
      required: !!requestBody.required,
      properties: Object.entries(props)
        .slice(0, 40)
        .map(([name, prop]) => {
          const p = deref(spec, prop) || {};
          return { name: clip(name, 80), type: typeOf(p), required: required.includes(name), description: clip(p.description || '', 160) };
        }),
    };
  }
  const bodyParam = (Array.isArray(op.parameters) ? op.parameters : []).map((p) => deref(spec, p)).find((p) => p && p.in === 'body');
  if (!bodyParam) return null;
  const schema = deref(spec, bodyParam.schema);
  const props = schema && schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema && schema.required) ? schema.required.map(String) : [];
  return {
    required: !!bodyParam.required,
    properties: Object.entries(props)
      .slice(0, 40)
      .map(([name, prop]) => {
        const p = deref(spec, prop) || {};
        return { name: clip(name, 80), type: typeOf(p), required: required.includes(name), description: clip(p.description || '', 160) };
      }),
  };
}

function extractOps(spec) {
  const paths = spec.paths && typeof spec.paths === 'object' ? spec.paths : null;
  if (!paths) throw new Error('The document has no "paths" object, so it is not an OpenAPI or Swagger spec.');
  const ops = [];
  const used = new Set();
  let truncated = false;
  for (const [rawPath, itemRaw] of Object.entries(paths)) {
    if (!rawPath.startsWith('/')) continue;
    const item = deref(spec, itemRaw);
    if (!item || typeof item !== 'object') continue;
    for (const method of METHODS) {
      const opRaw = item[method];
      if (!opRaw || typeof opRaw !== 'object') continue;
      if (ops.length >= MAX_OPERATIONS) {
        truncated = true;
        break;
      }
      const op = deref(spec, opRaw) || opRaw;
      const summary = clip(op.summary || op.description || `${method.toUpperCase()} ${rawPath}`, 180);
      let id = String(op.operationId || '').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
      if (!id) id = `${method}_${rawPath}`.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
      id = clip(id, 80);
      let unique = id;
      let n = 2;
      while (used.has(unique)) unique = clip(`${id}_${n++}`, 80);
      used.add(unique);
      const params = collectParams(spec, item, op);
      for (const m of rawPath.matchAll(/\{([^}]+)\}/g)) {
        if (!params.some((p) => p.in === 'path' && p.name === m[1])) params.push({ name: m[1], in: 'path', required: true, type: 'string', description: '' });
      }
      ops.push({
        id: unique,
        method: method.toUpperCase(),
        path: clip(rawPath, 300),
        summary,
        description: clip(op.description || '', 400),
        deprecated: !!op.deprecated,
        params,
        body: bodyOf(spec, op),
      });
    }
    if (truncated) break;
  }
  if (!ops.length) throw new Error('The spec contains no HTTP operations.');
  return { ops: ops.slice(0, MAX_OPERATIONS), truncated };
}

function specMeta(spec) {
  return {
    title: clip((spec.info && spec.info.title) || '', 120),
    version: clip((spec.info && spec.info.version) || spec.version || (spec.openapi ? `OpenAPI ${spec.openapi}` : 'Swagger 2'), 40),
    format: spec.openapi ? 'openapi' : spec.swagger ? 'swagger' : 'unknown',
  };
}

function parseSpec(raw, sourceUrl) {
  let spec = raw;
  if (typeof spec === 'string') {
    const text = spec.trim();
    if (!text) throw new Error('The spec is empty.');
    try {
      spec = JSON.parse(text);
    } catch {
      try {
        spec = yaml.load(text, { schema: yaml.JSON_SCHEMA, json: true });
      } catch (err) {
        throw new Error(`The spec is neither valid JSON nor valid YAML — ${err && err.message ? err.message : 'parse failed'}`);
      }
    }
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('The spec must be a JSON object.');
  if (!spec.openapi && !spec.swagger) throw new Error('This is not an OpenAPI 3 or Swagger 2 document (missing "openapi" or "swagger").');
  const baseUrl = serverUrlOf(spec, sourceUrl);
  if (!baseUrl) throw new Error('The spec has no server URL. Enter a base URL before saving.');
  const { ops, truncated } = extractOps(spec);
  return { ...specMeta(spec), baseUrl, ops, truncated };
}

/* ------------------------------------------------------------- fetching */

async function fetchSpec(url) {
  const raw = String(url || '').trim();
  if (!/^https?:\/\//i.test(raw)) throw new Error('The spec URL must start with http:// or https://.');
  const block = security.networkPolicyBlock(raw);
  if (block) throw new Error(block);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  let res;
  try {
    res = await fetch(raw, { redirect: 'follow', signal: controller.signal, headers: { accept: 'application/json' } });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Could not fetch the spec: ${err && err.name === 'AbortError' ? 'timed out' : (err && err.message) || String(err)}`);
  }
  clearTimeout(timer);
  if (!res.ok) throw new Error(`Spec download failed: HTTP ${res.status} ${res.statusText || ''}`.trim());
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_SPEC_BYTES) throw new Error(`The spec is ${(buffer.length / 1048576).toFixed(1)} MB — larger than the 5 MB limit.`);
  return { text: buffer.toString('utf8'), sourceUrl: res.url || raw };
}

/* ------------------------------------------------------------------ CRUD */

function publicConnector(c) {
  return {
    id: c.id,
    label: c.label,
    sourceUrl: c.sourceUrl,
    specTitle: c.specTitle,
    specVersion: c.specVersion,
    baseUrl: c.baseUrl,
    auth: { ...c.auth },
    secretSet: !!c.secretSet,
    truncated: !!c.truncated,
    operationCount: c.ops.length,
    ops: c.ops.map((op) => ({ ...op })),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function listConnectors() {
  return { connectors: store.connectors.map(publicConnector) };
}

function connectorById(id) {
  const conn = store.connectors.find((c) => c.id === String(id || ''));
  if (!conn) throw new Error(`No connector with id "${id}". Use connector_list.`);
  return conn;
}

function cleanAuth(auth) {
  const type = String((auth && auth.type) || 'none');
  if (!AUTH_TYPES.includes(type)) throw new Error('auth.type must be none, bearer, header or query.');
  if (type === 'header') {
    const name = String((auth && auth.name) || '').trim();
    if (!/^[a-zA-Z0-9-]{1,60}$/.test(name) || BLOCKED_HEADERS.has(name.toLowerCase())) {
      throw new Error('auth.name must be a header name that is not Authorization, Cookie or a transport header.');
    }
    return { type, name };
  }
  if (type === 'query') {
    const name = String((auth && auth.name) || '').trim();
    if (!/^[a-zA-Z0-9_.-]{1,60}$/.test(name)) throw new Error('auth.name must be a query parameter name.');
    return { type, name };
  }
  return { type, name: '' };
}

async function previewSpec(payload = {}) {
  const source = payload.spec !== undefined && payload.spec !== null ? payload.spec : null;
  if (source !== null) {
    const parsed = parseSpec(source, payload.sourceUrl || '');
    return { ok: true, ...parsed, sourceUrl: String(payload.sourceUrl || '') };
  }
  const url = String(payload.url || payload.sourceUrl || '').trim();
  if (!url) throw new Error('Provide a spec URL or paste a JSON spec.');
  const fetched = await fetchSpec(url);
  const parsed = parseSpec(fetched.text, fetched.sourceUrl);
  return { ok: true, ...parsed, sourceUrl: fetched.sourceUrl };
}

async function saveConnector(payload = {}) {
  const existing = payload.id ? store.connectors.find((c) => c.id === String(payload.id)) : null;
  if (payload.id && !existing) throw new Error(`No connector with id "${payload.id}".`);
  const label = String(payload.label || (existing && existing.label) || '').trim();
  if (!label) throw new Error('A connector label is required.');

  let parsed;
  if (payload.spec !== undefined && payload.spec !== null) parsed = parseSpec(payload.spec, payload.sourceUrl || '');
  else if (payload.url) {
    const fetched = await fetchSpec(payload.url);
    parsed = parseSpec(fetched.text, fetched.sourceUrl);
    payload.sourceUrl = fetched.sourceUrl;
  } else if (existing) parsed = { title: existing.specTitle, version: existing.specVersion, baseUrl: existing.baseUrl, ops: existing.ops, truncated: existing.truncated };
  else throw new Error('Provide a spec URL or paste a JSON spec.');

  const baseOverride = String(payload.baseUrl || '').trim();
  const baseUrl = (baseOverride || parsed.baseUrl).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('The connector base URL must start with http:// or https://.');
  const block = security.networkPolicyBlock(baseUrl);
  if (block) throw new Error(block);

  const auth = cleanAuth(payload.auth || (existing && existing.auth) || { type: 'none' });
  const id = existing ? existing.id : slug(payload.id || label, `connector-${crypto.randomBytes(3).toString('hex')}`);
  if (!existing && store.connectors.some((c) => c.id === id)) throw new Error(`Connector id "${id}" is already used.`);

  let secretSet = existing ? !!existing.secretSet : false;
  const secret = payload.secret;
  if (secret != null && String(secret) !== '' && String(secret) !== '__KEEP__') {
    await vault.set(secretKey(id), String(secret));
    secretSet = true;
  } else if (auth.type === 'none') {
    await vault.remove(secretKey(id)).catch(() => {});
    secretSet = false;
  }
  if (payload.clearSecret === true) {
    await vault.remove(secretKey(id)).catch(() => {});
    secretSet = false;
  }

  const record = {
    id,
    label: clip(label, 80),
    sourceUrl: String(payload.sourceUrl || (existing && existing.sourceUrl) || ''),
    specTitle: parsed.title,
    specVersion: parsed.version,
    baseUrl,
    auth,
    secretSet,
    ops: parsed.ops,
    truncated: !!parsed.truncated,
    createdAt: existing ? existing.createdAt : nowIso(),
    updatedAt: nowIso(),
  };
  if (existing) Object.assign(existing, record);
  else store.connectors.push(record);
  await persist();
  changed({ id });
  return publicConnector(record);
}

async function deleteConnector(id) {
  const conn = connectorById(id);
  store.connectors = store.connectors.filter((c) => c.id !== conn.id);
  await vault.remove(secretKey(conn.id)).catch(() => {});
  await persist();
  changed({ id: conn.id, deleted: true });
  return { deleted: conn.id };
}

/* ------------------------------------------------------------- execution */

function pick(args, bucket, name) {
  const scoped = args && args[bucket] && typeof args[bucket] === 'object' ? args[bucket] : {};
  if (scoped[name] !== undefined && scoped[name] !== null) return scoped[name];
  const params = args && args.params && typeof args.params === 'object' ? args.params : {};
  if (params[name] !== undefined && params[name] !== null) return params[name];
  if (args && ['path', 'query', 'headers', 'header', 'body', 'params'].includes(name)) return undefined;
  if (args && args[name] !== undefined && args[name] !== null) return args[name];
  return undefined;
}

async function buildRequest(conn, op, args = {}) {
  const values = args && typeof args === 'object' ? args : {};
  let rel = op.path;
  for (const param of op.params.filter((p) => p.in === 'path')) {
    const value = pick(values, 'path', param.name);
    if (value === undefined || value === '') throw new Error(`Missing path parameter "${param.name}".`);
    rel = rel.split(`{${param.name}}`).join(encodeURIComponent(String(value)));
  }
  const url = new URL(`${conn.baseUrl.replace(/\/+$/, '')}${rel.startsWith('/') ? rel : `/${rel}`}`);
  const baseOrigin = new URL(conn.baseUrl).origin;
  if (url.origin !== baseOrigin) throw new Error('The resolved request URL leaves the connector base origin.');
  const query = new URLSearchParams(url.search);
  for (const param of op.params.filter((p) => p.in === 'query')) {
    const value = pick(values, 'query', param.name);
    if (value === undefined) {
      if (param.required) throw new Error(`Missing required query parameter "${param.name}".`);
      continue;
    }
    if (Array.isArray(value)) value.forEach((v) => query.append(param.name, String(v)));
    else query.set(param.name, String(value));
  }
  const headers = {};
  const headerBag = values.headers && typeof values.headers === 'object' ? values.headers : values.header && typeof values.header === 'object' ? values.header : {};
  for (const [k, v] of Object.entries(headerBag)) {
    if (!/^[a-zA-Z0-9-]+$/.test(k) || BLOCKED_HEADERS.has(k.toLowerCase())) continue;
    headers[k] = String(v);
  }
  for (const param of op.params.filter((p) => p.in === 'header')) {
    const value = pick(values, 'header', param.name);
    if (value === undefined) {
      if (param.required) throw new Error(`Missing required header "${param.name}".`);
      continue;
    }
    headers[param.name] = String(value);
  }
  let body;
  if (!['GET', 'HEAD'].includes(op.method)) {
    const supplied = values.body !== undefined ? values.body : values.json;
    if (supplied !== undefined) {
      body = typeof supplied === 'string' ? supplied : JSON.stringify(supplied);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
    } else if (op.body && op.body.required) {
      body = '{}';
      headers['content-type'] = 'application/json';
    }
  }
  if (conn.auth.type !== 'none') {
    if (!conn.secretSet) throw new Error(`Connector "${conn.label}" expects ${conn.auth.type} auth but no secret is saved. Add it in Integrations → Connectors.`);
    const secret = await vault.get(secretKey(conn.id));
    if (!secret) throw new Error('The connector secret is unavailable. Re-enter it in Integrations → Connectors.');
    if (conn.auth.type === 'bearer') headers.authorization = `Bearer ${secret}`;
    else if (conn.auth.type === 'header' && conn.auth.name) headers[conn.auth.name] = secret;
    else if (conn.auth.type === 'query' && conn.auth.name) query.set(conn.auth.name, secret);
  }
  url.search = query.toString();
  const block = security.networkPolicyBlock(url.toString());
  if (block) throw new Error(block);
  return { url: url.toString(), method: op.method, headers, body };
}

async function callConnector(payload = {}) {
  const conn = connectorById(payload.connector);
  const opId = String(payload.operation || '').trim();
  const op = conn.ops.find((o) => o.id === opId);
  if (!op) throw new Error(`Operation "${opId}" is not in connector "${conn.id}". Use connector_list to see its operations.`);
  const request = await buildRequest(conn, op, payload.args || {});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  const started = Date.now();
  let res;
  try {
    res = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: 'follow', signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const reason = err && err.name === 'AbortError' ? `timed out after ${FETCH_TIMEOUT} ms` : (err && err.message) || String(err);
    return { ok: false, output: '', error: `Request failed: ${reason}`, url: request.url, method: request.method, ms: Date.now() - started };
  }
  let buffer;
  try {
    buffer = Buffer.from(await res.arrayBuffer());
  } catch {
    buffer = Buffer.alloc(0);
  } finally {
    clearTimeout(timer);
  }
  const ms = Date.now() - started;
  const truncated = buffer.length > MAX_RESPONSE_BYTES;
  const text = (truncated ? buffer.subarray(0, MAX_RESPONSE_BYTES) : buffer).toString('utf8');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const shown = text.length > 4000 ? `${text.slice(0, 4000)}\n…[${text.length - 4000} more characters]` : text;
  const output = `${request.method} ${request.url} → ${res.status} ${res.statusText || ''} (${buffer.length} bytes, ${ms} ms)\n\n${shown || '(empty body)'}`;
  return {
    ok: res.ok,
    output,
    error: res.ok ? null : `HTTP ${res.status} ${res.statusText || ''}`.trim(),
    status: res.status,
    url: request.url,
    method: request.method,
    body: text,
    json,
    bytes: buffer.length,
    truncated,
    ms,
  };
}

async function testConnector(id) {
  const conn = connectorById(id);
  const candidate =
    conn.ops.find((op) => op.method === 'GET' && op.params.every((p) => !p.required) && !op.deprecated) ||
    conn.ops.find((op) => (op.method === 'GET' || op.method === 'HEAD') && op.params.every((p) => !p.required)) ||
    null;
  if (candidate) {
    const result = await callConnector({ connector: conn.id, operation: candidate.id, args: {} });
    return {
      ...result,
      output: `${conn.label} — test called ${candidate.id}.\n${result.output}`,
    };
  }
  const url = conn.baseUrl.replace(/\/+$/, '') || conn.baseUrl;
  const block = security.networkPolicyBlock(url);
  if (block) throw new Error(block);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    return {
      ok: res.ok,
      output: `${conn.label} — no parameter-free GET operation, so this tested the base URL.\nGET ${url} → ${res.status} ${res.statusText || ''}`,
      error: res.ok ? null : `HTTP ${res.status} ${res.statusText || ''}`.trim(),
      status: res.status,
      url,
      method: 'GET',
    };
  } catch (err) {
    return { ok: false, output: '', error: `Request failed: ${(err && err.message) || String(err)}`, url, method: 'GET' };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------- approvals + tools */

function approvalReason(name, args = {}) {
  if (name !== 'connector_call') return null;
  try {
    const conn = connectorById(args.connector);
    const op = conn.ops.find((o) => o.id === String(args.operation || ''));
    if (!op) return null;
    if (!['GET', 'HEAD'].includes(op.method)) return `This calls ${conn.label} with ${op.method} ${op.path}, which may change data on the external service.`;
  } catch {
    return null;
  }
  return null;
}

const definitions = [
  {
    name: 'connector_list',
    description:
      'List imported OpenAPI / Swagger connectors with their base URL, auth type and every operation (method, path, parameters and JSON body fields). Use connector_call to run one.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'connector_call',
    description:
      'Call one operation of an imported OpenAPI / Swagger connector. Provide connector id and operation id from connector_list, plus args {path, query, headers, body}. Non-GET operations need approval. The final URL is checked against the network policy.',
    parameters: {
      type: 'object',
      properties: {
        connector: { type: 'string', description: 'Connector id from connector_list.' },
        operation: { type: 'string', description: 'Operation id from connector_list.' },
        args: {
          type: 'object',
          description: 'Request values: {path: {...}, query: {...}, headers: {...}, body: {...}}. Flat keys are also accepted.',
        },
      },
      required: ['connector', 'operation'],
    },
  },
];

const handlers = {
  async connector_list() {
    if (!store.connectors.length) {
      return { ok: true, output: 'No API connectors yet. Open Integrations → Connectors to import an OpenAPI or Swagger JSON spec.' };
    }
    const lines = [];
    for (const conn of store.connectors) {
      lines.push(`[${conn.id}] ${conn.label} — ${conn.baseUrl} (${conn.ops.length} ops, auth: ${conn.auth.type}${conn.secretSet ? ', secret set' : ''})`);
      for (const op of conn.ops) {
        const path = op.params.filter((p) => p.in === 'path').map((p) => `${p.name}`).join(', ');
        const query = op.params.filter((p) => p.in === 'query').map((p) => `${p.name}${p.required ? '*' : ''}`).join(', ');
        const body = op.body ? op.body.properties.map((p) => `${p.name}${p.required ? '*' : ''}`).join(', ') : '';
        lines.push(
          `  ${op.id} — ${op.method} ${op.path}${path ? ` path: ${path}` : ''}${query ? ` query: ${query}` : ''}${body ? ` body: ${body}` : ''}${op.deprecated ? ' (deprecated)' : ''}`,
        );
      }
    }
    return { ok: true, output: lines.join('\n'), connectors: store.connectors.map(publicConnector) };
  },
  async connector_call(args) {
    const result = await callConnector(args);
    return { ok: result.ok, output: result.output, error: result.error || null };
  },
};

module.exports = {
  init,
  listConnectors,
  previewSpec,
  saveConnector,
  deleteConnector,
  callConnector,
  testConnector,
  approvalReason,
  definitions,
  handlers,
  _test: { parseSpec, buildRequest, cleanAuth, pick, slug },
};
