'use strict';

/**
 * Section 19 — plugin SDK and tool marketplace.
 *
 * A plugin is a folder with manifest.json and a CommonJS entry that exports
 * `run(tool, args, api)`. Plugin code never runs in the main process: each call
 * goes to a child ORVEX process started with Node's permission model, allowed
 * to read only the plugin folder and write only its own data folder. Child
 * process, worker and native-addon permissions stay denied. Plugins have no
 * network access unless their manifest declares permissions.network (a host
 * list or "any"); the sandbox host enforces that before loading plugin code.
 *
 * The marketplace reads a catalog URL you configure. Nothing is listed by
 * default, and every download must match a sha256 from the catalog before it is
 * unpacked. No hosted store is invented.
 */

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const db = require('./db.cjs');
const catalogCore = require('./catalog.cjs');

const CATALOG_KEY = 'advanced.marketplace.url';
const CATALOG_KEYS_KEY = 'advanced.marketplace.keys';
const CATALOG_REQUIRE_KEY = 'advanced.marketplace.requireSignature';
const CATALOG_TTL = 10 * 60 * 1000;
const MAX_PLUGIN_FILES = 300;
const MAX_PLUGIN_BYTES = 20 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const CALL_TIMEOUT = 20_000;
const ENTRY_TIMEOUT = 12_000;

let ctx = {
  dataDir: process.cwd(),
  emit: () => {},
  toolsChanged: () => {},
};

const children = new Map();
const queued = new Map();

const HOST_SOURCE = `'use strict';
const readline = require('node:readline');
const entryPath = process.env.ORVEX_PLUGIN_ENTRY;
const dataDir = process.env.ORVEX_PLUGIN_DATA;
const pluginDir = process.env.ORVEX_PLUGIN_DIR;
const networkPolicy = (() => {
  try {
    const parsed = JSON.parse(process.env.ORVEX_PLUGIN_NETWORK || '{"mode":"none","hosts":[]}');
    if (!parsed || typeof parsed !== 'object') return { mode: 'none', hosts: [] };
    return { mode: String(parsed.mode || 'none'), hosts: Array.isArray(parsed.hosts) ? parsed.hosts.map(String) : [] };
  } catch {
    return { mode: 'none', hosts: [] };
  }
})();
function hostAllowed(host) {
  if (networkPolicy.mode === 'any') return true;
  if (networkPolicy.mode !== 'hosts') return false;
  const name = String(host || '').toLowerCase();
  return networkPolicy.hosts.some((rule) => {
    const clean = String(rule || '').toLowerCase();
    if (!clean) return false;
    if (clean.startsWith('*.')) return name.endsWith(clean.slice(1)) && name.length > clean.length - 1;
    return name === clean;
  });
}
function networkDenied(target) {
  const err = new Error('Network access to "' + (target || 'unknown') + '" is not allowed for this plugin. Declare permissions.network in manifest.json.');
  err.code = 'ORVEX_NETWORK_DENIED';
  return err;
}
function checkHost(host) {
  if (!hostAllowed(host)) throw networkDenied(host);
}
function socketHost(args) {
  const first = args[0];
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    if (first.path) return 'unix-socket';
    return String(first.host || first.servername || 'localhost');
  }
  if (typeof first === 'string' && !/^[0-9]+$/.test(first)) return 'unix-socket';
  if (typeof args[1] === 'string') return args[1];
  return 'localhost';
}
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const http2 = require('node:http2');
const dgram = require('node:dgram');

const socketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  checkHost(socketHost(args));
  return socketConnect.apply(this, args);
};
for (const method of ['connect', 'createConnection']) {
  const original = net[method];
  net[method] = function (...args) {
    checkHost(socketHost(args));
    return original.apply(this, args);
  };
}

const tlsConnect = tls.connect;
tls.connect = function (...args) {
  const first = args[0];
  let host = 'localhost';
  if (first && typeof first === 'object' && !Array.isArray(first)) host = first.host || first.servername || (first.path ? 'unix-socket' : 'localhost');
  else if (typeof args[1] === 'string') host = args[1];
  checkHost(String(host));
  return tlsConnect.apply(this, args);
};

function requestHost(args) {
  const first = args[0];
  if (typeof first === 'string') {
    try { return new URL(first).hostname; } catch { return 'localhost'; }
  }
  if (first && typeof first === 'object' && !Array.isArray(first)) return first.hostname || first.host || 'localhost';
  return 'localhost';
}
for (const mod of [http, https]) {
  for (const method of ['request', 'get']) {
    const original = mod[method];
    if (typeof original !== 'function') continue;
    mod[method] = function (...args) {
      checkHost(String(requestHost(args)).split(':')[0]);
      return original.apply(this, args);
    };
  }
}

const h2Connect = http2.connect;
http2.connect = function (authority, ...rest) {
  let host = 'localhost';
  try { host = new URL(String(authority)).hostname; } catch { host = String(authority || '').split(':')[0] || 'localhost'; }
  checkHost(host);
  return h2Connect.call(this, authority, ...rest);
};

if (networkPolicy.mode !== 'any') {
  dgram.Socket.prototype.send = function () {
    throw networkDenied('UDP');
  };
}

const lookup = dns.lookup;
dns.lookup = function (hostname, ...rest) {
  checkHost(hostname);
  return lookup.call(this, hostname, ...rest);
};
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname']) {
  const original = dns.promises[name];
  if (typeof original !== 'function') continue;
  dns.promises[name] = function (hostname, ...rest) {
    checkHost(hostname);
    return original.call(this, hostname, ...rest);
  };
}

if (typeof globalThis.fetch === 'function' && networkPolicy.mode !== 'any') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (input, init) {
    let current;
    try {
      current = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input && input.url);
    } catch {
      throw networkDenied('invalid URL');
    }
    const options = Object.assign({}, init || {}, { redirect: 'manual' });
    const start = current;
    for (let hop = 0; hop < 5; hop += 1) {
      checkHost(current.hostname);
      const response = await originalFetch(current, options);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return response;
        current = new URL(location, current);
        continue;
      }
      return response;
    }
    throw networkDenied(start.hostname + ' (too many redirects)');
  };
}
for (const name of ['log', 'info', 'debug']) {
  console[name] = (...args) => process.stderr.write(args.map(String).join(' ') + '\\n');
}
let mod;
try {
  mod = require(entryPath);
} catch (err) {
  process.stderr.write('plugin load failed: ' + (err && err.message ? err.message : String(err)) + '\\n');
  process.exit(2);
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const api = {
    dataDir,
    pluginDir,
    env: { ...process.env },
    log: (...args) => process.stderr.write(args.map(String).join(' ') + '\\n'),
  };
  try {
    if (!mod || typeof mod.run !== 'function') throw new Error('the entry must export run(tool, args, api)');
    const result = await mod.run(String(msg.tool || ''), msg.args && typeof msg.args === 'object' ? msg.args : {}, api);
    const text = result && typeof result === 'object' ? result.output : result;
    process.stdout.write(JSON.stringify({ id: msg.id, ok: !(result && result.ok === false), output: text == null ? '' : String(text), error: result && result.error ? String(result.error) : null }) + '\\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({ id: msg.id, ok: false, output: '', error: err && err.message ? err.message : String(err) }) + '\\n');
  }
});
`;

function init(opts = {}) {
  ctx = { ...ctx, ...opts };
  return ensureHost().catch(() => null);
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

function pluginsDir() {
  return path.join(ctx.dataDir, 'plugins');
}

function pluginDataDir(id) {
  return path.join(ctx.dataDir, 'plugin-data', String(id));
}

function hostDir() {
  return path.join(ctx.dataDir, 'plugin-host');
}

async function ensureHost() {
  const dir = hostDir();
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'host.cjs');
  let current = '';
  try {
    current = await fsp.readFile(file, 'utf8');
  } catch {
    current = '';
  }
  if (current !== HOST_SOURCE) await fsp.writeFile(file, HOST_SOURCE, 'utf8');
  return { dir, file };
}

/* ------------------------------------------------------------ manifests */

function validateToolName(name) {
  return /^[a-z0-9][a-z0-9_-]{0,40}$/i.test(String(name || ''));
}

const HOST_RULE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** false/"none" = no network; true/"any" = unrestricted; a list = those hosts only. */
function normalizeNetworkPermission(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.mode === 'string') {
    if (value.mode === 'any') return { mode: 'any', hosts: [] };
    if (value.mode === 'none') return { mode: 'none', hosts: [] };
    value = value.hosts;
  }
  if (value == null || value === false || value === 'none') return { mode: 'none', hosts: [] };
  // Installs from before network permissions existed were disclosed as unrestricted.
  if (value === 'not restricted by the sandbox') return { mode: 'any', hosts: [] };
  if (value === true || value === 'any') return { mode: 'any', hosts: [] };
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : null;
  if (!list) throw new Error('permissions.network must be false, "none", true, "any" or a list of hostnames.');
  const hosts = [...new Set(list.map((host) => String(host || '').trim().toLowerCase()).filter(Boolean))];
  if (!hosts.length) throw new Error('permissions.network lists no hostnames.');
  if (hosts.length > 50) throw new Error('permissions.network may list at most 50 hostnames.');
  for (const host of hosts) {
    if (!HOST_RULE.test(host)) throw new Error(`permissions.network has an invalid hostname "${clip(host, 80)}".`);
  }
  return { mode: 'hosts', hosts };
}

function validateManifest(manifest, dir) {
  if (!manifest || typeof manifest !== 'object') throw new Error('manifest.json is missing or not an object.');
  const id = String(manifest.id || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,40}$/i.test(id)) throw new Error('manifest id must be 2-40 characters: letters, numbers, dot, dash, underscore.');
  if (id.includes('__')) throw new Error('manifest id must not contain a double underscore — it is the tool-name separator.');
  const name = String(manifest.name || '').trim();
  if (!name) throw new Error('manifest name is required.');
  const version = String(manifest.version || '').trim();
  if (!/^\d+\.\d+\.\d+([-+][0-9a-z.-]+)?$/i.test(version)) throw new Error('manifest version must be semver, e.g. 1.0.0.');
  const entryRel = String(manifest.entry || '').trim();
  if (!entryRel) throw new Error('manifest entry is required.');
  if (path.isAbsolute(entryRel) || entryRel.split(/[\\/]/).includes('..')) throw new Error('manifest entry must stay inside the plugin folder.');
  const entry = path.resolve(dir, entryRel);
  if (!entry.startsWith(path.resolve(dir) + path.sep)) throw new Error('manifest entry escapes the plugin folder.');
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  if (!tools.length) throw new Error('manifest tools must list at least one tool.');
  if (tools.length > 20) throw new Error('A plugin can expose at most 20 tools.');
  const seen = new Set();
  const cleanTools = tools.map((tool, i) => {
    const toolName = String(tool && tool.name || '').trim();
    if (!validateToolName(toolName)) throw new Error(`tools[${i}].name is invalid.`);
    if (toolName.includes('__')) throw new Error(`tools[${i}].name must not contain a double underscore.`);
    if (seen.has(toolName)) throw new Error(`Tool "${toolName}" is listed twice.`);
    seen.add(toolName);
    const description = String(tool && tool.description || '').trim();
    if (!description) throw new Error(`tools[${i}].description is required.`);
    return {
      name: toolName,
      description: clip(description, 400),
      parameters: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {}, required: [] },
    };
  });
  const network = normalizeNetworkPermission(
    manifest.permissions && typeof manifest.permissions === 'object' ? manifest.permissions.network : undefined,
  );
  return {
    id,
    name: clip(name, 80),
    version,
    description: clip(String(manifest.description || '').trim(), 400),
    author: clip(String(manifest.author || '').trim(), 80),
    homepage: clip(String(manifest.homepage || '').trim(), 300),
    entry: entryRel,
    entryPath: entry,
    tools: cleanTools,
    permissions: {
      fsRead: 'plugin folder',
      fsWrite: 'plugin data folder',
      childProcess: false,
      workers: false,
      nativeAddons: false,
      network: network.mode === 'any' ? 'any' : network.mode === 'hosts' ? network.hosts : 'none',
      networkMode: network.mode,
      networkHosts: network.hosts,
    },
  };
}

async function readManifest(dir) {
  const file = path.join(dir, 'manifest.json');
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    throw new Error('manifest.json was not found.');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('manifest.json is not valid JSON.');
  }
  const manifest = validateManifest(parsed, dir);
  await fsp.access(manifest.entryPath).catch(() => {
    throw new Error(`The entry file "${manifest.entry}" does not exist.`);
  });
  return manifest;
}

function fullToolName(pluginId, tool) {
  return `plugin__${pluginId}__${tool}`;
}

function splitToolName(name) {
  const text = String(name || '');
  if (!text.startsWith('plugin__')) return null;
  const rest = text.slice('plugin__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0 || sep + 2 >= rest.length) return null;
  return { pluginId: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/* ------------------------------------------------------------- listing */

function rows() {
  return raw()?.prepare('SELECT * FROM adv_plugins ORDER BY installed_at DESC').all() || [];
}

function rowView(row) {
  const manifest = (() => {
    try {
      return JSON.parse(row.manifest);
    } catch {
      return null;
    }
  })();
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    dir: row.dir,
    enabled: !!row.enabled,
    source: row.source || 'local',
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    tools: manifest && Array.isArray(manifest.tools) ? manifest.tools : [],
    description: manifest ? manifest.description || '' : '',
    permissions: manifest ? manifest.permissions || null : null,
  };
}

function listPlugins() {
  return rows().map(rowView);
}

function toolDefinitions() {
  const defs = [];
  for (const row of rows()) {
    if (!row.enabled) continue;
    let manifest;
    try {
      manifest = JSON.parse(row.manifest);
    } catch {
      continue;
    }
    for (const tool of manifest.tools || []) {
      defs.push({
        name: fullToolName(row.id, tool.name),
        description: `[${row.name} ${row.version}] ${tool.description}`,
        parameters: tool.parameters,
      });
    }
  }
  return defs;
}

function pluginApproval(name) {
  const parsed = splitToolName(name);
  if (!parsed) return null;
  const row = rows().find((r) => r.id === parsed.pluginId);
  if (!row) return `Plugin "${parsed.pluginId}" is not installed.`;
  if (!row.enabled) return `Plugin "${row.name}" is disabled.`;
  return `Runs "${parsed.tool}" inside the third-party plugin "${row.name}" (sandboxed child process).`;
}

/* -------------------------------------------------------------- sandbox */

async function ensureChild(row) {
  const manifest = validateManifest(JSON.parse(row.manifest), row.dir);
  const sandbox = await ensureHost();
  const dataDir = pluginDataDir(row.id);
  await fsp.mkdir(dataDir, { recursive: true });
  const args = [
    '--experimental-permission',
    `--allow-fs-read=${row.dir}`,
    `--allow-fs-read=${sandbox.dir}`,
    `--allow-fs-write=${dataDir}`,
    sandbox.file,
  ];
  const env = {
    ELECTRON_RUN_AS_NODE: '1',
    ORVEX_PLUGIN_ENTRY: manifest.entryPath,
    ORVEX_PLUGIN_DIR: row.dir,
    ORVEX_PLUGIN_DATA: dataDir,
    ORVEX_PLUGIN_NETWORK: JSON.stringify({
      mode: manifest.permissions.networkMode,
      hosts: manifest.permissions.networkHosts,
    }),
    PATH: process.env.PATH || '',
    SystemRoot: process.env.SystemRoot || process.env.WINDIR || '',
    TEMP: process.env.TEMP || '',
    TMP: process.env.TMP || '',
  };
  const child = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { child, buffer: '', stderr: '', pending: new Map(), ready: true };
  child.stdout.on('data', (chunk) => {
    state.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, idx);
      state.buffer = state.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = state.pending.get(msg.id);
      if (!entry) continue;
      state.pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.resolve({ ok: !!msg.ok, output: String(msg.output || ''), error: msg.error ? String(msg.error) : null });
    }
  });
  child.stderr.on('data', (chunk) => {
    state.stderr = clip(state.stderr + chunk.toString('utf8'), 4000);
  });
  child.on('exit', (code) => {
    state.ready = false;
    children.delete(row.id);
    for (const [, entry] of state.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, output: '', error: `Plugin process exited (${code})${state.stderr ? `: ${clip(state.stderr, 600)}` : ''}` });
    }
    state.pending.clear();
  });
  child.on('error', (err) => {
    state.ready = false;
    children.delete(row.id);
    for (const [, entry] of state.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, output: '', error: `Could not start the plugin process: ${err.message}` });
    }
    state.pending.clear();
  });
  return state;
}

async function callTool(name, args = {}) {
  const parsed = splitToolName(name);
  if (!parsed) return { ok: false, output: '', error: `Unknown plugin tool "${name}".` };
  const { pluginId, tool: toolName } = parsed;
  const row = rows().find((r) => r.id === pluginId);
  if (!row) return { ok: false, output: '', error: `Plugin "${pluginId}" is not installed.` };
  if (!row.enabled) return { ok: false, output: '', error: `Plugin "${row.name}" is disabled.` };
  let manifest;
  try {
    manifest = JSON.parse(row.manifest);
  } catch {
    return { ok: false, output: '', error: 'The stored manifest is corrupt.' };
  }
  if (!(manifest.tools || []).some((t) => t.name === toolName)) return { ok: false, output: '', error: `"${toolName}" is not declared by this plugin.` };

  if (queued.has(pluginId)) {
    return queued.get(pluginId).then((state) => sendRun(state, toolName, args));
  }
  let state = children.get(pluginId);
  if (!state || !state.ready) {
    const boot = ensureChild(row)
      .then((started) => {
        started.pluginId = pluginId;
        children.set(pluginId, started);
        return started;
      })
      .finally(() => queued.delete(pluginId));
    queued.set(pluginId, boot);
    state = await boot;
  }
  if (!state.ready) return { ok: false, output: '', error: state.stderr ? `The plugin process failed to start: ${clip(state.stderr, 600)}` : 'The plugin process failed to start.' };
  return sendRun(state, toolName, args);
}

function sendRun(state, toolName, args) {
  return new Promise((resolve) => {
    const id = `${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const timer = setTimeout(() => {
      state.pending.delete(id);
      try {
        state.child.kill();
      } catch {
        /* already gone */
      }
      if (state.pluginId) children.delete(state.pluginId);
      resolve({ ok: false, output: '', error: `The plugin did not answer within ${CALL_TIMEOUT / 1000}s and was stopped.` });
    }, CALL_TIMEOUT);
    state.pending.set(id, { resolve, timer });
    try {
      state.child.stdin.write(JSON.stringify({ id, tool: toolName, args: args || {} }) + '\n');
    } catch (err) {
      clearTimeout(timer);
      state.pending.delete(id);
      resolve({ ok: false, output: '', error: `Could not send the request: ${err.message}` });
    }
  });
}

function stopPlugin(id) {
  const state = children.get(String(id));
  if (!state) return { stopped: false };
  try {
    state.child.kill();
  } catch {
    /* already gone */
  }
  children.delete(String(id));
  return { stopped: true };
}

/* ------------------------------------------------------------- install */

async function copyTree(from, to, counter = { files: 0, bytes: 0 }) {
  await fsp.mkdir(to, { recursive: true });
  const entries = await fsp.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await copyTree(src, dest, counter);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fsp.stat(src);
    counter.files += 1;
    counter.bytes += stat.size;
    if (counter.files > MAX_PLUGIN_FILES) throw new Error(`A plugin may contain at most ${MAX_PLUGIN_FILES} files.`);
    if (counter.bytes > MAX_PLUGIN_BYTES) throw new Error(`A plugin may be at most ${MAX_PLUGIN_BYTES / 1024 / 1024} MB.`);
    await fsp.copyFile(src, dest);
  }
}

async function installFromDir(sourceDir, sourceLabel = 'local') {
  const source = path.resolve(String(sourceDir || ''));
  const stat = await fsp.stat(source).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error('Give a folder that contains manifest.json.');
  const manifest = await readManifest(source);
  const target = path.join(pluginsDir(), manifest.id);
  const existing = raw()?.prepare('SELECT id FROM adv_plugins WHERE id = ?').get(manifest.id);
  await fsp.mkdir(pluginsDir(), { recursive: true });
  const staging = path.join(pluginsDir(), `.staging-${manifest.id}-${Date.now()}`);
  try {
    await copyTree(source, staging);
    const installed = await readManifest(staging);
    if (installed.id !== manifest.id) throw new Error(`The staged copy contains "${installed.id}", not "${manifest.id}".`);
    if (existing) await fsp.rm(target, { recursive: true, force: true });
    await fsp.rename(staging, target);
    const finalManifest = await readManifest(target);
    stopPlugin(finalManifest.id);
    raw()
      ?.prepare(
        `INSERT INTO adv_plugins(id, name, version, dir, manifest, source, enabled, installed_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, dir = excluded.dir,
           manifest = excluded.manifest, source = excluded.source, updated_at = excluded.updated_at`,
      )
      .run(finalManifest.id, finalManifest.name, finalManifest.version, target, JSON.stringify(finalManifest), sourceLabel, now(), now());
    db.audit({ kind: 'plugin-install', tool: 'plugin', args: JSON.stringify({ id: finalManifest.id, version: finalManifest.version, source: sourceLabel }), ok: true });
    emit({ type: 'plugin-installed', id: finalManifest.id, version: finalManifest.version, at: now() });
    try {
      ctx.toolsChanged();
    } catch {
      /* the tool registry may not be ready in isolated tests */
    }
    return rowView(raw()?.prepare('SELECT * FROM adv_plugins WHERE id = ?').get(finalManifest.id));
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

function setEnabled(id, enabled) {
  const changes = raw()?.prepare('UPDATE adv_plugins SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, now(), String(id)).changes || 0;
  if (!changes) throw new Error('That plugin is not installed.');
  if (!enabled) stopPlugin(id);
  try {
    ctx.toolsChanged();
  } catch {
    /* ignore */
  }
  return { id: String(id), enabled: !!enabled };
}

async function uninstall(id) {
  const row = rows().find((r) => r.id === String(id));
  if (!row) throw new Error('That plugin is not installed.');
  stopPlugin(id);
  await fsp.rm(row.dir, { recursive: true, force: true });
  await fsp.rm(pluginDataDir(row.id), { recursive: true, force: true });
  raw()?.prepare('DELETE FROM adv_plugins WHERE id = ?').run(String(id));
  db.audit({ kind: 'plugin-uninstall', tool: 'plugin', args: JSON.stringify({ id: row.id }), ok: true });
  try {
    ctx.toolsChanged();
  } catch {
    /* ignore */
  }
  return { removed: 1 };
}

/* ----------------------------------------------------------- marketplace */

function catalogUrl() {
  return String(db.getSetting(CATALOG_KEY, '') || '').trim();
}

function setCatalogUrl(url) {
  const value = String(url || '').trim();
  if (value && !/^https?:\/\//i.test(value)) throw new Error('The catalog URL must start with http:// or https://.');
  db.setSetting(CATALOG_KEY, value);
  raw()?.prepare('DELETE FROM adv_market_cache WHERE url = ?').run(value);
  return { url: value };
}

function catalogKeys() {
  return catalogCore.parseTrustedKeys(db.getSetting(CATALOG_KEYS_KEY, ''));
}

function setCatalogKeys(text) {
  const value = String(text || '').trim();
  if (!value) {
    db.setSetting(CATALOG_KEYS_KEY, '');
    raw()?.prepare('DELETE FROM adv_market_cache').run();
    return { keys: [] };
  }
  const keys = catalogCore.parseTrustedKeys(value);
  if (!keys.length) throw new Error('No valid Ed25519 public key was found. Paste a PEM block that starts with "-----BEGIN PUBLIC KEY-----" or a JSON key list.');
  db.setSetting(CATALOG_KEYS_KEY, value);
  raw()?.prepare('DELETE FROM adv_market_cache').run();
  return { keys: catalogCore.publicKeyView(keys) };
}

function requireSignature() {
  return db.getSetting(CATALOG_REQUIRE_KEY, false) === true;
}

function setRequireSignature(value) {
  db.setSetting(CATALOG_REQUIRE_KEY, value === true);
  raw()?.prepare('DELETE FROM adv_market_cache').run();
  return { requireSignature: value === true };
}

async function fetchJson(url, timeout = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const text = await res.text();
    if (text.length > 2 * 1024 * 1024) throw new Error('The catalog is larger than 2 MB.');
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeCatalogItem(item) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id || '').trim();
  const version = String(item.version || '').trim();
  const url = String(item.url || item.download || '').trim();
  const sha256 = String(item.sha256 || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,40}$/i.test(id) || !/^\d+\.\d+\.\d+/.test(version) || !/^https?:\/\//i.test(url)) return null;
  if (!/^[a-f0-9]{64}$/.test(sha256)) return null;
  return {
    id,
    name: clip(String(item.name || id), 80),
    version,
    description: clip(String(item.description || ''), 400),
    author: clip(String(item.author || ''), 80),
    url,
    sha256,
    tools: Array.isArray(item.tools) ? item.tools.map((t) => clip(String(t), 60)).slice(0, 20) : [],
  };
}

function readCached(cached) {
  if (!cached) return null;
  try {
    const parsed = JSON.parse(cached.items);
    if (Array.isArray(parsed)) return { items: parsed, signed: false, keyId: null, fingerprint: null };
    if (parsed && Array.isArray(parsed.items)) return parsed;
    return null;
  } catch {
    return null;
  }
}

async function catalog({ refresh = false } = {}) {
  const url = catalogUrl();
  const keys = catalogKeys();
  const requireSig = requireSignature();
  const keyView = catalogCore.publicKeyView(keys);
  if (!url) {
    return {
      configured: false,
      url: '',
      items: [],
      cachedAt: null,
      note: 'No catalog URL is configured. Add one to discover compatible extensions.',
      signed: null,
      keyId: null,
      fingerprint: null,
      keys: keyView,
      requireSignature: requireSig,
    };
  }
  const cached = raw()?.prepare('SELECT * FROM adv_market_cache WHERE url = ?').get(url);
  const cachedState = readCached(cached);
  const fresh = cached && cachedState && now() - cached.fetched_at < CATALOG_TTL;
  if (fresh && !refresh) {
    return {
      configured: true,
      url,
      items: cachedState.items,
      cachedAt: cached.fetched_at,
      error: cached.error || null,
      signed: cachedState.signed,
      keyId: cachedState.keyId,
      fingerprint: cachedState.fingerprint,
      keys: keyView,
      requireSignature: requireSig,
    };
  }
  try {
    const rawCatalog = await fetchJson(url);
    const verified = catalogCore.verifyEnvelope(rawCatalog, keys);
    if (!verified.ok) throw new Error(verified.error);
    if (requireSig && !verified.signed) throw new Error('This catalog is unsigned, but signature verification is required in Settings.');
    const items = verified.plugins.map(normalizeCatalogItem).filter(Boolean);
    const installed = new Set(rows().map((r) => `${r.id}@${r.version}`));
    const withState = items.map((item) => ({ ...item, installed: installed.has(`${item.id}@${item.version}`) }));
    const stored = JSON.stringify({
      items: withState,
      signed: verified.signed,
      keyId: verified.keyId,
      fingerprint: verified.fingerprint,
    });
    raw()
      ?.prepare(
        `INSERT INTO adv_market_cache(url, fetched_at, items, error) VALUES(?, ?, ?, NULL)
         ON CONFLICT(url) DO UPDATE SET fetched_at = excluded.fetched_at, items = excluded.items, error = NULL`,
      )
      .run(url, now(), stored);
    return {
      configured: true,
      url,
      items: withState,
      cachedAt: now(),
      error: null,
      signed: verified.signed,
      keyId: verified.keyId,
      fingerprint: verified.fingerprint,
      generatedAt: verified.generatedAt || null,
      keys: keyView,
      requireSignature: requireSig,
      skipped: verified.plugins.length - items.length,
    };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    raw()
      ?.prepare(
        `INSERT INTO adv_market_cache(url, fetched_at, items, error) VALUES(?, ?, '[]', ?)
         ON CONFLICT(url) DO UPDATE SET fetched_at = excluded.fetched_at, error = excluded.error`,
      )
      .run(url, now(), clip(message, 500));
    return {
      configured: true,
      url,
      items: [],
      cachedAt: now(),
      error: message,
      signed: null,
      keyId: null,
      fingerprint: null,
      keys: keyView,
      requireSignature: requireSig,
    };
  }
}

async function download(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`Download failed with HTTP ${res.status}.`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      throw new Error(`The download is larger than ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`);
    }
    if (!res.body) throw new Error('The download returned no body.');
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > MAX_DOWNLOAD_BYTES) {
        try {
          await res.body.cancel();
        } catch {
          /* the socket may already be closed */
        }
        throw new Error(`The download is larger than ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`);
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

async function extractZip(buffer, target) {
  const unzipper = require('unzipper');
  const { pipeline } = require('node:stream/promises');
  const { Transform } = require('node:stream');
  const directory = await unzipper.Open.buffer(buffer);
  let files = 0;
  let bytes = 0;
  for (const entry of directory.files) {
    if (entry.type === 'Directory') continue;
    if (Number(entry.uncompressedSize) > MAX_PLUGIN_BYTES) throw new Error('An archive entry is larger than the plugin byte limit.');
    const rel = entry.path.replace(/\\/g, '/');
    if (rel.startsWith('/') || rel.split('/').includes('..')) throw new Error(`Unsafe path in the archive: ${rel}`);
    const dest = path.join(target, rel);
    if (!dest.startsWith(path.resolve(target) + path.sep)) throw new Error('The archive escapes its folder.');
    files += 1;
    if (files > MAX_PLUGIN_FILES) throw new Error(`The archive has more than ${MAX_PLUGIN_FILES} files.`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    // Count the bytes that actually arrive, not the size the archive claims.
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_PLUGIN_BYTES) {
          callback(new Error(`The archive expands past ${MAX_PLUGIN_BYTES / 1024 / 1024} MB.`));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(entry.stream(), meter, fs.createWriteStream(dest));
  }
  return { files, bytes };
}

async function installFromCatalog(id) {
  const state = await catalog({ refresh: true });
  if (!state.configured) throw new Error('Set a marketplace catalog URL first.');
  if (state.error) throw new Error(`The catalog could not be read: ${state.error}`);
  const item = state.items.find((i) => i.id === String(id));
  if (!item) throw new Error(`"${id}" is not in the catalog.`);
  const buffer = await download(item.url);
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  if (digest !== item.sha256) throw new Error(`sha256 mismatch for ${item.id}: expected ${item.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…. Nothing was installed.`);
  const temp = path.join(ctx.dataDir, 'plugin-tmp', `${item.id}-${Date.now()}`);
  await fsp.mkdir(temp, { recursive: true });
  try {
    await extractZip(buffer, temp);
    let root = temp;
    const entries = await fsp.readdir(temp);
    if (!entries.includes('manifest.json') && entries.length === 1) {
      const only = path.join(temp, entries[0]);
      const stat = await fsp.stat(only);
      if (stat.isDirectory()) root = only;
    }
    const manifest = await readManifest(root);
    if (manifest.id !== item.id) throw new Error(`The archive contains "${manifest.id}", not "${item.id}".`);
    if (manifest.version !== item.version) throw new Error(`The archive is version ${manifest.version}, but the catalog lists ${item.version}.`);
    const installed = await installFromDir(root, item.url);
    db.audit({
      kind: 'plugin-install-catalog',
      tool: 'plugin',
      args: JSON.stringify({ id: item.id, version: item.version, sha256: digest, signed: state.signed === true, keyId: state.keyId || null }),
      ok: true,
    });
    return installed;
  } finally {
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

function stopAll() {
  for (const id of [...children.keys()]) stopPlugin(id);
}

module.exports = {
  init,
  listPlugins,
  toolDefinitions,
  pluginApproval,
  callTool,
  installFromDir,
  installFromCatalog,
  catalog,
  setCatalogUrl,
  catalogUrl,
  catalogKeys,
  setCatalogKeys,
  requireSignature,
  setRequireSignature,
  setEnabled,
  uninstall,
  stopPlugin,
  stopAll,
  validateManifest,
  normalizeNetworkPermission,
};
