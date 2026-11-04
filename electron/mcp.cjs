'use strict';

/**
 * Real MCP (Model Context Protocol) client for ORVEX.
 * Spawns the configured servers as stdio processes, speaks JSON-RPC 2.0 over
 * newline-delimited JSON, and exposes their tools to the agent as
 * `mcp__<server>__<tool>`.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'orvex', version: '1.0.0' };
const INIT_TIMEOUT_MS = 90000;
const LIST_TIMEOUT_MS = 20000;
const MAX_TOOL_NAME = 64;
// Every listed tool costs prompt tokens on every agent turn. Small servers are
// listed directly; a large server (or one with an explicit allowlist) is
// reached through the compact mcp__orvex__search / mcp__orvex__call pair.
const DIRECT_TOOL_LIMIT = 20;
const HUB_SEARCH = 'mcp__orvex__search';
const HUB_CALL = 'mcp__orvex__call';

let dataDir = null;
let configFile = null;
let vaultModule;

/** @type {Map<string, {cfg: any, client: any, state: string, tools: any[], error: string|null}>} */
const active = new Map();

function vault() {
  if (vaultModule === undefined) {
    try {
      vaultModule = require('./vault.cjs');
    } catch {
      vaultModule = null;
    }
  }
  return vaultModule;
}

function envKey(id) {
  return `mcp.env.${id}`;
}

function init(opts) {
  dataDir = opts && opts.dataDir ? opts.dataDir : null;
  configFile = dataDir ? path.join(dataDir, 'mcp.json') : null;
}

function slug(text, fallback) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

function sanitizeTool(text) {
  return String(text || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function normalizeAllowlist(value) {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new Error('"tools" must be a list of tool names.');
  const names = [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
  return names.length ? names : null;
}

function normalizeServer(raw, index) {
  if (!raw || typeof raw !== 'object') throw new Error(`Server #${index + 1} is not an object.`);
  const command = String(raw.command || '').trim();
  if (!command) throw new Error(`Server #${index + 1} has no command.`);
  if (/[\r\n]/.test(command) || /[|&;<>]/.test(command)) {
    throw new Error(`Server #${index + 1}: the command must be a single program (put extra arguments in "args").`);
  }
  const args = Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : [];
  if (args.some((a) => /[\r\n]/.test(a))) {
    throw new Error(`Server #${index + 1}: an argument contains a newline.`);
  }
  const env = raw.env && typeof raw.env === 'object' ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)])) : {};
  const name = String(raw.name || raw.id || command).trim();
  const id = slug(raw.id || name, `server-${index + 1}`);
  const timeoutMs = Math.min(Math.max(Number(raw.timeoutMs) || 120000, 5000), 900000);
  return {
    id,
    name,
    command,
    args,
    env,
    cwd: raw.cwd ? String(raw.cwd) : '',
    enabled: raw.enabled !== false,
    autoApprove: raw.autoApprove === true,
    timeoutMs,
    tools: normalizeAllowlist(raw.tools),
  };
}

function publicConfig(server) {
  const out = {
    id: server.id,
    name: server.name,
    command: server.command,
    args: server.args,
    enabled: server.enabled,
    autoApprove: server.autoApprove,
    timeoutMs: server.timeoutMs,
  };
  if (server.cwd) out.cwd = server.cwd;
  if (server.tools && server.tools.length) out.tools = server.tools;
  // Environment values can be API tokens. They stay in the encrypted vault and
  // never travel to the renderer.
  return out;
}

async function loadConfig() {
  if (!configFile) return [];
  let raw;
  try {
    raw = JSON.parse(await fsp.readFile(configFile, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw new Error(`mcp.json could not be read: ${err.message}`);
  }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw.servers) ? raw.servers : [];
  const seen = new Set();
  const servers = list.map((entry, i) => {
    const server = normalizeServer(entry, i);
    let id = server.id;
    let n = 2;
    while (seen.has(id)) id = `${server.id}-${n++}`;
    seen.add(id);
    return { ...server, id };
  });
  const store = vault();
  if (store) {
    for (const server of servers) {
      try {
        const saved = await store.getJson(envKey(server.id));
        if (saved && typeof saved === 'object') server.env = { ...server.env, ...saved };
      } catch {
        /* vault unavailable — fall back to whatever mcp.json held */
      }
    }
  }
  return servers;
}

async function saveConfig(list) {
  if (!configFile) throw new Error('MCP config path is not initialised.');
  const clean = [];
  const seen = new Set();
  const store = vault();
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    const server = normalizeServer(entry, i);
    let id = server.id;
    let n = 2;
    while (seen.has(id)) id = `${server.id}-${n++}`;
    seen.add(id);
    if (store) {
      const declaresEnv = entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'env');
      try {
        const existing = await store.getJson(envKey(id));
        // An explicit env field replaces the stored values (an empty object or
        // null clears them). Leaving the field out keeps the vault untouched.
        if (declaresEnv) await store.setJson(envKey(id), Object.keys(server.env).length ? server.env : null);
        else if ((!existing || typeof existing !== 'object') && Object.keys(server.env).length) {
          await store.setJson(envKey(id), server.env);
        }
        const saved = await store.getJson(envKey(id));
        server.env = saved && typeof saved === 'object' ? { ...saved } : {};
      } catch {
        /* vault unavailable — keep the plaintext values below so the server still runs */
      }
    }
    clean.push({ ...server, id });
  }
  await fsp.mkdir(path.dirname(configFile), { recursive: true });
  const persisted = clean.map((server) => {
    const out = publicConfig(server);
    if (!store && Object.keys(server.env).length) out.env = server.env;
    return out;
  });
  await fsp.writeFile(configFile, JSON.stringify({ servers: persisted }, null, 2), 'utf8');
  return clean;
}

/**
 * cmd.exe /s /c takes the whole command line in one quoted argument. Quoting
 * every token keeps `&`, `|`, `>`, `<` and `^` literal; `%` and `!` would still
 * be expanded inside quotes, so they are refused rather than silently changed.
 */
function quoteForCmd(arg) {
  const s = String(arg);
  if (/["\r\n]/.test(s)) throw new Error('MCP arguments used with a .cmd/.bat server may not contain quotes or newlines.');
  if (/[%!]/.test(s)) throw new Error('MCP arguments used with a .cmd/.bat server may not contain % or ! (cmd.exe would expand them).');
  return `"${s}"`;
}

/** Resolves a bare `npx`/`uvx` through PATHEXT so cmd shims are found without a shell. */
function resolveWindowsCommand(command) {
  const raw = String(command);
  if (/[\\/]/.test(raw) || /\.(exe|com|cmd|bat)$/i.test(raw)) return raw;
  const exts = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, raw + ext.toLowerCase());
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* try the next extension */
      }
    }
  }
  return raw;
}

class StdioClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.child = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.closed = false;
    this.exitInfo = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      let child;
      try {
        const options = {
          cwd: this.cfg.cwd || undefined,
          env: { ...process.env, ...this.cfg.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        };
        if (process.platform === 'win32') {
          const command = resolveWindowsCommand(this.cfg.command);
          if (/\.(cmd|bat)$/i.test(command)) {
            // .cmd/.bat cannot be executed by CreateProcess directly, so cmd.exe
            // runs exactly one quoted command line — never a raw shell string.
            const line = [command, ...this.cfg.args].map(quoteForCmd).join(' ');
            const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
            child = spawn(comspec, ['/d', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true });
          } else {
            child = spawn(command, this.cfg.args, options);
          }
        } else {
          child = spawn(this.cfg.command, this.cfg.args, options);
        }
      } catch (err) {
        reject(new Error(`Could not start "${this.cfg.command}": ${err.message}`));
        return;
      }
      this.child = child;

      const fail = (err) => {
        if (!this.closed) {
          this.closed = true;
          this.rejectAll(err);
        }
      };

      child.on('error', (err) => fail(new Error(`Server "${this.cfg.name}" failed to start: ${err.message}`)));
      child.on('exit', (code, signal) => {
        this.exitInfo = { code, signal };
        fail(new Error(`Server "${this.cfg.name}" exited (${signal || code || 'unknown'}).${this.stderr ? ` ${this.stderr.slice(-400)}` : ''}`));
      });
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.onData(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        this.stderr = (this.stderr + chunk).slice(-4000);
      });

      this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, INIT_TIMEOUT_MS)
        .then((result) => {
          this.notify('notifications/initialized', {});
          resolve(result);
        })
        .catch(reject);
    });
  }

  rejectAll(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '').trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.onMessage(msg);
    }
    if (this.buf.length > 8 * 1024 * 1024) this.buf = ''; // a server flooding without newlines
  }

  onMessage(msg) {
    if (msg && typeof msg === 'object' && msg.id !== undefined && msg.method) {
      this.onServerRequest(msg);
      return;
    }
    if (!msg || msg.id === undefined) return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(msg.error.message || `MCP error ${msg.error.code ?? ''}`.trim()));
    else entry.resolve(msg.result);
  }

  onServerRequest(msg) {
    let result = null;
    let error = null;
    switch (msg.method) {
      case 'ping':
        result = {};
        break;
      case 'roots/list':
        result = { roots: [] };
        break;
      default:
        error = { code: -32601, message: `ORVEX does not implement "${msg.method}".` };
    }
    this.write({ jsonrpc: '2.0', id: msg.id, ...(error ? { error } : { result }) });
  }

  write(msg) {
    if (!this.child || this.closed || !this.child.stdin.writable) return false;
    try {
      this.child.stdin.write(JSON.stringify(msg) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error(`Server "${this.cfg.name}" is not running.`));
        return;
      }
      const id = this.nextId;
      this.nextId += 1;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Server "${this.cfg.name}" did not answer ${method} within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.write({ jsonrpc: '2.0', id, method, params: params || {} })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Could not write to "${this.cfg.name}" — the process is gone.`));
      }
    });
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params: params || {} });
  }

  async listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, LIST_TIMEOUT_MS);
      for (const tool of (result && result.tools) || []) {
        if (!tool || !tool.name) continue;
        tools.push(tool);
      }
      cursor = result && result.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name, args) {
    return await this.request('tools/call', { name, arguments: args || {} }, this.cfg.timeoutMs);
  }

  close() {
    this.closed = true;
    this.rejectAll(new Error(`Server "${this.cfg.name}" was disconnected.`));
    if (this.child && !this.child.killed) {
      try {
        this.child.stdin.end();
      } catch {
        /* already closed */
      }
      const child = this.child;
      const timer = setTimeout(() => {
        try {
          if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
          else child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 1500);
      timer.unref?.();
      child.once('exit', () => clearTimeout(timer));
      if (process.platform === 'win32') {
        // MCP servers started through cmd.exe keep running after stdin closes.
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        } catch {
          /* ignore */
        }
      }
    }
    this.child = null;
  }
}

/* ------------------------------------------------------------------ registry */

let connectedDefinitions = [];
let connectedOwners = new Map(); // listed tool name -> server id
let knownTools = new Map(); // every callable tool, listed or behind the hub
let serversById = new Map();
let hubRegistered = false;

async function saveImage(serverId, block, index) {
  if (!dataDir) return null;
  const mime = String(block.mimeType || 'image/png');
  const ext = /jpe?g/i.test(mime) ? '.jpg' : /webp/i.test(mime) ? '.webp' : '.png';
  const dir = path.join(dataDir, 'mcp-images');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${serverId}-${Date.now()}-${index}${ext}`);
  await fsp.writeFile(file, Buffer.from(String(block.data || ''), 'base64'));
  return file;
}

async function formatResult(serverId, result) {
  const texts = [];
  let image = null;
  let i = 0;
  for (const block of (result && result.content) || []) {
    i += 1;
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      texts.push(String(block.text ?? ''));
    } else if (block.type === 'image') {
      if (!image && block.data) {
        image = await saveImage(serverId, block, i).catch(() => null);
        texts.push(`[image ${block.mimeType || 'image'}${image ? ` saved to ${image}` : ''}]`);
      } else {
        texts.push('[another image]');
      }
    } else if (block.type === 'resource') {
      const res = block.resource || {};
      if (typeof res.text === 'string') texts.push(`[resource ${res.uri || ''}]\n${res.text}`);
      else texts.push(`[resource ${res.uri || ''} — binary ${res.blob ? 'data' : 'content'}]`);
    } else if (block.type === 'resource_link') {
      texts.push(`[link] ${block.name || ''} ${block.uri || ''}`.trim());
    } else {
      texts.push(`[${block.type || 'content'}]`);
    }
  }
  if (result && result.structuredContent && !texts.length) {
    texts.push('```json\n' + JSON.stringify(result.structuredContent, null, 2) + '\n```');
  }
  const text = texts.join('\n').trim();
  const failed = !!(result && result.isError);
  return {
    ok: !failed,
    output: failed ? '' : text || '(empty result)',
    error: failed ? text || 'The MCP tool reported an error.' : null,
    image,
  };
}

function toolNameFor(serverId, toolName) {
  const name = `mcp__${serverId}__${sanitizeTool(toolName)}`;
  return name.length > MAX_TOOL_NAME ? name.slice(0, MAX_TOOL_NAME) : name;
}

/** Decide which server tools earn a permanent slot in the model's tool list. */
function toolExposure(toolNames, allowlist) {
  const names = Array.isArray(toolNames) ? toolNames : [];
  if (Array.isArray(allowlist) && allowlist.length) {
    const allowed = new Set(allowlist);
    const direct = names.filter((name) => allowed.has(name));
    const hidden = names.filter((name) => !allowed.has(name));
    return { mode: 'allowlist', direct, hidden };
  }
  if (names.length <= DIRECT_TOOL_LIMIT) return { mode: 'all', direct: names.slice(), hidden: [] };
  return { mode: 'hub', direct: [], hidden: names.slice() };
}

const HUB_DEFINITIONS = [
  {
    name: HUB_SEARCH,
    description:
      'Search the tools of every connected MCP server when a tool is not already listed. Returns full tool names, their server and a one-line description. Use this before mcp__orvex__call.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words from the tool name or description. Leave empty to list everything.' },
        server: { type: 'string', description: 'Only search one server, by id or name.' },
        limit: { type: 'number', description: 'How many matches to return, 1-100 (default 20).' },
      },
      required: [],
    },
  },
  {
    name: HUB_CALL,
    description:
      'Call a connected MCP tool by its full name from mcp__orvex__search (or "server:tool"). Arguments go in the "arguments" object. External tools run outside ORVEX guardrails and usually need approval.',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Full tool name such as mcp__filesystem__read_file, or server:tool.' },
        arguments: { type: 'object', description: 'Arguments for the tool, matching the schema shown by its server.' },
      },
      required: ['tool'],
    },
  },
];

function clipText(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function resolveTool(tool) {
  const name = String(tool || '').trim();
  if (!name) return null;
  if (knownTools.has(name)) return { name, ...knownTools.get(name) };
  const parts = name.includes('::') ? name.split('::') : name.includes(':') ? name.split(':') : [];
  if (parts.length === 2) {
    const server = parts[0].trim().toLowerCase();
    const raw = parts[1].trim();
    for (const [full, owner] of knownTools) {
      if ((owner.serverId.toLowerCase() === server || owner.serverName.toLowerCase() === server) && owner.toolName === raw) {
        return { name: full, ...owner };
      }
    }
  }
  const bare = [...knownTools.entries()].filter(([, owner]) => owner.toolName === name);
  return bare.length === 1 ? { name: bare[0][0], ...bare[0][1] } : null;
}

function allowlisted(owner) {
  const cfg = serversById.get(owner.serverId);
  return !cfg || !Array.isArray(cfg.tools) || !cfg.tools.length || cfg.tools.includes(owner.toolName);
}

async function searchTools(args = {}) {
  const query = String(args.query || '').toLowerCase().trim();
  const server = String(args.server || '').toLowerCase().trim();
  const limit = Math.min(Math.max(Math.round(Number(args.limit) || 20), 1), 100);
  const matches = [];
  for (const [name, owner] of knownTools) {
    if (!allowlisted(owner)) continue;
    if (server && owner.serverId.toLowerCase() !== server && owner.serverName.toLowerCase() !== server) continue;
    const haystack = `${name} ${owner.toolName} ${owner.description}`.toLowerCase();
    if (query && !haystack.includes(query)) continue;
    matches.push({ name, owner });
    if (matches.length >= limit) break;
  }
  if (!matches.length) {
    return { ok: true, output: query ? `No MCP tool matched "${clipText(query, 80)}".` : 'No MCP tools are connected right now.' };
  }
  const lines = matches.map(({ name, owner }) => `${name} — ${owner.serverName}: ${clipText(owner.description || owner.toolName, 160)}`);
  return { ok: true, output: `${matches.length} tool${matches.length === 1 ? '' : 's'}:\n${lines.join('\n')}` };
}

async function startServer(cfg) {
  const entry = { cfg, client: null, state: 'connecting', tools: [], error: null };
  active.set(cfg.id, entry);
  try {
    const client = new StdioClient(cfg);
    entry.client = client;
    await client.start();
    entry.tools = await client.listTools();
    entry.state = 'ready';
  } catch (err) {
    entry.state = 'error';
    entry.error = err && err.message ? err.message : String(err);
    try {
      entry.client?.close();
    } catch {
      /* ignore */
    }
    entry.client = null;
  }
  return entry;
}

async function connectAll() {
  const list = await loadConfig();
  await disconnectAll();

  const definitions = [];
  const listed = new Map();
  const known = new Map();
  const started = await Promise.all(
    list.map(async (cfg) => {
      if (!cfg.enabled) {
        active.set(cfg.id, { cfg, client: null, state: 'disabled', tools: [], error: null });
        return { cfg, entry: null };
      }
      return { cfg, entry: await startServer(cfg) };
    }),
  );
  for (const { cfg, entry } of started) {
    if (!entry || entry.state !== 'ready') continue;
    const exposure = toolExposure(entry.tools.map((tool) => tool.name), cfg.tools);
    const direct = new Set(exposure.direct);
    for (const tool of entry.tools) {
      let name = toolNameFor(cfg.id, tool.name);
      if (known.has(name)) {
        const short = name.slice(0, MAX_TOOL_NAME - 3) + `_${known.size}`;
        name = short;
      }
      const owner = {
        serverId: cfg.id,
        serverName: cfg.name,
        toolName: tool.name,
        description: String(tool.description || tool.title || tool.name),
      };
      known.set(name, owner);
      if (!direct.has(tool.name)) continue;
      listed.set(name, owner);
      definitions.push({
        name,
        description: `${owner.description.slice(0, 900)} (MCP server: ${cfg.name})`,
        parameters: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {}, required: [] },
      });
    }
  }

  const hub = HUB_DEFINITIONS.filter((definition) => !known.has(definition.name));
  if (known.size && hub.length) definitions.push(...hub);
  connectedDefinitions = definitions;
  connectedOwners = listed;
  knownTools = known;
  hubRegistered = known.size > 0 && hub.length > 0;
  serversById = new Map(list.map((cfg) => [cfg.id, cfg]));
  return { definitions, status: status() };
}

async function disconnectAll() {
  for (const [, entry] of active) {
    try {
      entry.client?.close();
    } catch {
      /* ignore */
    }
  }
  active.clear();
  connectedDefinitions = [];
  connectedOwners = new Map();
  knownTools = new Map();
  serversById = new Map();
  hubRegistered = false;
}

function status() {
  return [...active.values()].map((entry) => {
    const names = entry.tools.map((t) => t.name);
    const exposure = toolExposure(names, entry.cfg.tools);
    return {
      id: entry.cfg.id,
      name: entry.cfg.name,
      state: entry.state,
      toolCount: entry.tools.length,
      tools: names,
      listedCount: exposure.direct.length,
      hubCount: exposure.mode === 'hub' ? names.length : 0,
      blockedCount: exposure.mode === 'allowlist' ? exposure.hidden.length : 0,
      missing: exposure.mode === 'allowlist' ? entry.cfg.tools.filter((name) => !names.includes(name)) : [],
      error: entry.error,
      autoApprove: entry.cfg.autoApprove,
    };
  });
}

function isMcpTool(name) {
  return (
    connectedOwners.has(name) ||
    (hubRegistered && (knownTools.has(name) || name === HUB_SEARCH || name === HUB_CALL))
  );
}

async function callMcpTool(name, args) {
  if (name === HUB_SEARCH) return searchTools(args || {});
  if (name === HUB_CALL) {
    const target = resolveTool(args && args.tool);
    if (!target) return { ok: false, output: '', error: `No MCP tool matched "${clipText(args && args.tool, 120)}". Use mcp__orvex__search first.` };
    const callArgs = args && args.arguments && typeof args.arguments === 'object' ? args.arguments : {};
    return callMcpTool(target.name, callArgs);
  }
  const owner = knownTools.get(name) || connectedOwners.get(name);
  if (!owner) throw new Error(`Unknown MCP tool "${name}".`);
  if (!allowlisted(owner)) {
    const cfg = serversById.get(owner.serverId);
    return {
      ok: false,
      output: '',
      error: `"${owner.toolName}" is not on the allowlist for "${cfg ? cfg.name : owner.serverId}". Add it in Settings → MCP servers.`,
    };
  }
  const entry = active.get(owner.serverId);
  if (!entry || !entry.client || entry.state !== 'ready') {
    throw new Error(`MCP server "${serversById.get(owner.serverId)?.name || owner.serverId}" is not connected.`);
  }
  try {
    const result = await entry.client.callTool(owner.toolName, args || {});
    return await formatResult(owner.serverId, result);
  } catch (err) {
    return { ok: false, output: '', error: err && err.message ? err.message : String(err) };
  }
}

function approvalReason(name, args) {
  if (name === HUB_SEARCH) return null;
  if (name === HUB_CALL) {
    const target = resolveTool(args && args.tool);
    const cfg = target ? serversById.get(target.serverId) : null;
    if (cfg && cfg.autoApprove) return null;
    return cfg
      ? `This calls "${target.toolName}" on the external MCP server "${cfg.name}" — it runs outside ORVEX's built-in guardrails.`
      : 'This calls an external MCP tool that runs outside ORVEX’s built-in guardrails.';
  }
  const owner = connectedOwners.get(name);
  const cfg = owner ? serversById.get(owner.serverId) : null;
  if (!cfg || cfg.autoApprove) return null;
  return `This is an external MCP tool from "${cfg.name}" — it runs outside ORVEX's built-in guardrails.`;
}

async function getConfig() {
  return { servers: (await loadConfig()).map(publicConfig), status: status() };
}

async function setConfig(servers) {
  if (!Array.isArray(servers)) throw new Error('Servers must be a list.');
  await saveConfig(servers);
  return await connectAll();
}

module.exports = {
  init,
  connectAll,
  disconnectAll,
  getConfig,
  setConfig,
  status,
  isMcpTool,
  callMcpTool,
  approvalReason,
  get definitions() {
    return connectedDefinitions;
  },
  DIRECT_TOOL_LIMIT,
  HUB_SEARCH,
  HUB_CALL,
  _internals: { quoteForCmd, resolveWindowsCommand, normalizeServer, toolExposure, resolveTool },
};
