'use strict';

/**
 * Phase 6.2 — the Local Brain.
 *
 * Manages a llama.cpp server that ORVEX owns: it finds the binary and GGUF
 * models, estimates how many layers fit in VRAM, starts/stops the server,
 * proxies chat calls and routes traffic locally when the user prefers that.
 * Every capability that needs a piece that is not installed reports
 * unavailable with the exact missing piece instead of pretending.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');

const db = require('./db.cjs');
const training = require('./training.cjs');
const security = require('./security.cjs');

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const CONFIG_KEY = 'localbrain.config';
const PORT_MIN = 41000;
const PORT_MAX = 48999;
const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_POLL_MS = 1_000;
const IDLE_CHECK_MS = 30_000;
const LOG_LIMIT = 400;
const SCAN_DEPTH = 4;
const MODEL_EXTS = new Set(['.gguf']);
const DEFAULT_CONFIG = {
  enabled: true,
  prefer: 'local-first',
  offline: false,
  port: 47830,
  context: 4096,
  threads: Math.max(2, Math.min(8, os.cpus().length - 1)),
  gpuLayers: 'auto',
  vramGb: null,
  idleMinutes: 20,
  runtimePath: '',
  modelsDir: '',
  modelId: '',
};

let ctx = { dataDir: process.cwd(), emit: () => {}, platform: process.platform, version: '' };
let server = null;
let serverState = {
  state: 'stopped',
  pid: null,
  port: null,
  modelId: null,
  modelPath: null,
  startedAt: null,
  lastRequestAt: null,
  error: null,
};
let logs = [];
let idleTimer = null;
let scanCache = { at: 0, dir: '', value: null };
let configCache = null;
let bootAt = 0;

/* --------------------------------------------------------------- utilities */

function now() {
  return Date.now();
}

function dirnameOf(file) {
  return path.dirname(String(file || '.'));
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function shortId(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 12);
}

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…[trimmed]` : text;
}

function pushLog(line, kind = 'out') {
  const clean = security.redact(clip(line, 1200));
  logs.push({ at: now(), kind, line: clean });
  if (logs.length > LOG_LIMIT) logs = logs.slice(logs.length - LOG_LIMIT);
}

/* ---------------------------------------------------------- GGUF metadata */

const GGUF_TYPES = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

/**
 * Read the real GGUF header and key/value table. Returns architecture facts
 * the fit estimator needs; never invents values that are not in the file.
 */
async function readGgufMeta(file, { maxBytes = 8 * MB, maxKv = 256 } = {}) {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, 0);
    if (buf.length < 24 || buf.toString('utf8', 0, 4) !== 'GGUF') return { ok: false, reason: 'Not a GGUF file.' };
    let offset = 4;
    const readU32 = () => {
      if (offset + 4 > buf.length) throw new Error('truncated');
      const v = buf.readUInt32LE(offset);
      offset += 4;
      return v;
    };
    const readU64 = () => {
      if (offset + 8 > buf.length) throw new Error('truncated');
      const v = Number(buf.readBigUInt64LE(offset));
      offset += 8;
      return v;
    };
    const readString = () => {
      const len = readU64();
      if (len < 0 || len > 64 * 1024 || offset + len > buf.length) throw new Error('truncated');
      const s = buf.toString('utf8', offset, offset + len);
      offset += len;
      return s;
    };
    const skip = (type, arrayDepth = 0) => {
      if (arrayDepth > 6) throw new Error('array nesting too deep');
      if (type === 8) {
        const len = readU64();
        if (offset + len > buf.length) throw new Error('truncated');
        offset += len;
        return;
      }
      if (type === 9) {
        const itemType = readU32();
        const count = readU64();
        if (count > 1_000_000) throw new Error('array too large');
        for (let i = 0; i < count; i += 1) skip(itemType, arrayDepth + 1);
        return;
      }
      const size = GGUF_TYPES[type];
      if (!size) throw new Error(`unknown gguf type ${type}`);
      if (offset + size > buf.length) throw new Error('truncated');
      offset += size;
    };

    const version = readU32();
    const tensorCount = readU64();
    const kvCount = readU64();
    const meta = {};
    let parsedKv = 0;
    let truncated = false;
    for (let i = 0; i < Math.min(kvCount, maxKv); i += 1) {
      try {
        const key = readString();
        const type = readU32();
        if (type === 8) meta[key] = readString();
        else if (type === 9) skip(type);
        else if (type === 6) {
          if (offset + 4 > buf.length) throw new Error('truncated');
          meta[key] = buf.readFloatLE(offset);
          offset += 4;
        } else if (type === 12) {
          if (offset + 8 > buf.length) throw new Error('truncated');
          meta[key] = buf.readDoubleLE(offset);
          offset += 8;
        } else if (type === 7) {
          meta[key] = buf.readUInt8(offset) !== 0;
          offset += 1;
        } else if (type === 4 || type === 5) {
          meta[key] = buf.readInt32LE(offset);
          offset += 4;
        } else if (type === 10 || type === 11) {
          meta[key] = Number(buf.readBigInt64LE(offset));
          offset += 8;
        } else skip(type);
        parsedKv += 1;
      } catch {
        truncated = true;
        break;
      }
    }
    return {
      ok: true,
      version,
      tensorCount,
      kvCount,
      parsedKv,
      truncated: truncated || parsedKv < Math.min(kvCount, maxKv),
      meta,
      size: stat.size,
    };
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : String(err) };
  } finally {
    try {
      if (handle) await handle.close();
    } catch {
      /* ignore */
    }
  }
}

function archOf(meta) {
  return String(meta['general.architecture'] || '').trim();
}

function metaNumber(meta, key) {
  const value = meta[key];
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

/** Pull the fields the fit estimator uses out of an arch-prefixed KV table. */
function modelFacts(meta, size) {
  const arch = archOf(meta);
  const prefix = arch ? `${arch}.` : '';
  const blockCount = metaNumber(meta, `${prefix}block_count`);
  const contextLength = metaNumber(meta, `${prefix}context_length`);
  const embeddingLength = metaNumber(meta, `${prefix}embedding_length`);
  const headCount = metaNumber(meta, `${prefix}attention.head_count`);
  const headCountKv = metaNumber(meta, `${prefix}attention.head_count_kv`) || headCount;
  const fileType = metaNumber(meta, 'general.file_type');
  return {
    arch,
    name: String(meta['general.name'] || '').trim(),
    blockCount,
    contextLength,
    embeddingLength,
    headCount,
    headCountKv,
    fileType,
    size: Number(size) || 0,
  };
}

const QUANT_RE = /\b(I?Q[1-8](?:_[A-Z0-9]+)*|F16|BF16|F32|Q4_0|Q4_1|Q5_0|Q5_1|Q8_0)\b/i;
const PARAMS_RE = /(?:^|[^a-z0-9])(\d+(?:\.\d+)?)\s*([bm])(?=[^a-z0-9]|$)/i;

function guessFromName(file) {
  const base = path.basename(String(file || ''));
  const quant = (QUANT_RE.exec(base) || [])[1] || '';
  const params = PARAMS_RE.exec(base.replace(/[-_]/g, ' '));
  let paramsB = null;
  if (params) {
    const value = Number(params[1]);
    const unit = params[2].toLowerCase();
    if (Number.isFinite(value)) paramsB = unit === 'b' ? value : value / 1000;
  }
  return { quant: quant.toUpperCase(), paramsB };
}

/**
 * VRAM plan for one model. All inputs are bytes; no hidden constants without
 * a name. The KV maths follows llama.cpp: 2 tensors * layers * kv heads *
 * head dim * 2 bytes (f16).
 */
function estimateFit({
  size,
  blockCount = null,
  contextLength = null,
  embeddingLength = null,
  headCount = null,
  headCountKv = null,
  context = 4096,
  vramBytes = 0,
  gpuLayers = 'auto',
  overheadBytes = 1024 ** 3,
} = {}) {
  const modelBytes = Math.max(0, Number(size) || 0);
  if (!modelBytes) {
    return { ok: false, reason: 'Model size is unknown.', verdict: 'unknown' };
  }
  const layers = Math.max(1, Number(blockCount) || 0);
  const ctx = Math.max(256, Math.min(Number(context) || 4096, Number(contextLength) || 131072));
  const embd = Math.max(0, Number(embeddingLength) || 0);
  const heads = Math.max(1, Number(headCount) || 0);
  const kvHeads = Math.max(1, Number(headCountKv) || heads);
  const headDim = embd && heads ? embd / heads : 128;
  const kvBytes = blockCount
    ? 2 * layers * kvHeads * headDim * 2 * ctx
    : Math.round(ctx * 0.00012 * GB * (modelBytes / GB));
  const budget = Math.max(0, Number(vramBytes) || 0) - overheadBytes;
  const perLayer = modelBytes / layers;
  let recommended = 0;
  if (budget > 0) {
    const room = budget - kvBytes;
    recommended = room > 0 ? Math.min(layers, Math.max(0, Math.floor(room / perLayer))) : 0;
  }
  let chosen = recommended;
  if (gpuLayers !== 'auto' && gpuLayers !== '' && gpuLayers != null) {
    const wanted = Number(gpuLayers);
    if (Number.isFinite(wanted)) chosen = Math.max(0, Math.min(layers, Math.round(wanted)));
  }
  const offload = Math.min(1, chosen / layers);
  const vram = Math.round(modelBytes * offload + kvBytes * (chosen > 0 ? 1 : 0) + (chosen > 0 ? overheadBytes : 0));
  const ram = Math.round(modelBytes * (1 - offload) + (chosen > 0 ? 0 : kvBytes));
  let verdict = 'cpu';
  if (chosen >= layers) verdict = 'gpu-full';
  else if (chosen > 0) verdict = 'gpu-partial';
  if (!budget || budget <= 0) verdict = 'cpu';
  return {
    ok: true,
    verdict,
    layerCount: layers,
    gpuLayers: chosen,
    recommendedGpuLayers: recommended,
    context: ctx,
    kvBytes: Math.round(kvBytes),
    estimatedVramBytes: vram,
    estimatedRamBytes: ram,
    vramBytes: Number(vramBytes) || 0,
    fitsFully: chosen >= layers && layers > 0,
    note:
      verdict === 'cpu'
        ? 'No usable VRAM budget was found; this model will run on the CPU.'
        : verdict === 'gpu-partial'
          ? `${chosen}/${layers} layers offloaded; the rest stays in RAM.`
          : null,
  };
}

/* ------------------------------------------------------------ GPU probing */

let gpuCache = { at: 0, value: null, probing: false };

function parseGpuJson(text) {
  const out = [];
  const push = (name, bytes) => {
    const clean = String(name || '').trim();
    if (!clean) return;
    const mem = Number(bytes);
    out.push({ name: clean, memoryBytes: Number.isFinite(mem) && mem > 0 ? mem : null });
  };
  const chunks = String(text || '').match(/\{[^{}]*\}/g) || [];
  for (const chunk of chunks) {
    try {
      const row = JSON.parse(chunk);
      if (Array.isArray(row)) row.forEach((r) => push(r.Name, r.Memory));
      else push(row.Name, row.Memory ?? row.AdapterRAM);
    } catch {
      /* skip malformed row */
    }
  }
  return out;
}

async function probeGpu({ platform = process.platform } = {}) {
  if (platform !== 'win32') return { available: false, adapters: [], reason: 'GPU probing is Windows-only right now.' };
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress",
    "$k='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'",
    "Get-ChildItem $k | ForEach-Object { $p=Get-ItemProperty $_.PSPath; if($p.DriverDesc){ [pscustomobject]@{Name=$p.DriverDesc;Memory=$p.'HardwareInformation.qwMemorySize'} } } | ConvertTo-Json -Compress",
  ].join('; ');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 12_000, windowsHide: true, maxBuffer: 2 * MB },
      (err, stdout) => {
        const adapters = parseGpuJson(stdout);
        if (err && !adapters.length) {
          resolve({ available: false, adapters: [], reason: 'The GPU driver did not answer the probe.' });
          return;
        }
        resolve({
          available: adapters.length > 0,
          adapters,
          reason: adapters.length ? null : 'No video adapter was reported by Windows.',
        });
      },
    );
  });
}

async function gpuInfo({ force = false } = {}) {
  if (!force && gpuCache.value && now() - gpuCache.at < 5 * 60_000) return gpuCache.value;
  if (gpuCache.probing) return gpuCache.value || { available: false, adapters: [], pending: true };
  gpuCache.probing = true;
  try {
    const value = await probeGpu({ platform: ctx.platform });
    gpuCache = { at: now(), value, probing: false };
    return value;
  } finally {
    gpuCache.probing = false;
  }
}

/* -------------------------------------------------------------- discovery */

async function exists(file) {
  try {
    await fsp.access(file, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function runtimeNames(platform = ctx.platform) {
  return platform === 'win32' ? ['llama-server.exe', 'llama-server'] : ['llama-server'];
}

async function findRuntime(config = getConfig()) {
  const tried = [];
  const candidates = [];
  if (config.runtimePath) candidates.push(config.runtimePath);
  for (const name of runtimeNames(ctx.platform)) {
    candidates.push(path.join(training.root(), 'runtime', name));
    candidates.push(path.join(ctx.dataDir || process.cwd(), 'runtime', name));
    candidates.push(path.join(process.cwd(), 'runtime', name));
  }
  for (const candidate of candidates) {
    tried.push(candidate);
    if (await exists(candidate)) return { found: true, path: candidate, tried };
  }
  const which = ctx.platform === 'win32' ? 'where' : 'which';
  const found = await new Promise((resolve) => {
    execFile(which, ['llama-server'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      const first = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      resolve(!err && first ? first : '');
    });
  });
  if (found) return { found: true, path: found, tried, source: 'PATH' };
  return {
    found: false,
    path: null,
    tried,
    reason: `llama-server was not found. Put it in ${path.join(training.root(), 'runtime')} or set a runtime path.`,
  };
}

async function walkModels(dir, depth = 0, out = []) {
  if (depth > SCAN_DEPTH) return out;
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkModels(full, depth + 1, out);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!MODEL_EXTS.has(ext)) continue;
    try {
      const stat = await fsp.stat(full);
      out.push({ path: full, name: entry.name, size: stat.size, mtime: stat.mtimeMs });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

function modelIdOf(file) {
  return `gguf_${shortId(path.resolve(String(file || '')).toLowerCase())}`;
}

function cachedModel(file) {
  try {
    return db.raw()?.prepare('SELECT * FROM brain_models WHERE path = ?').get(path.resolve(String(file))) || null;
  } catch {
    return null;
  }
}

function saveModel(row) {
  try {
    db.raw()
      ?.prepare(
        `INSERT INTO brain_models(path, id, name, size, mtime, sha256, arch, params, block_count, context_length,
          embedding_length, head_count, head_count_kv, file_type, quant, meta, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, sha256=excluded.sha256,
          arch=excluded.arch, params=excluded.params, block_count=excluded.block_count,
          context_length=excluded.context_length, embedding_length=excluded.embedding_length,
          head_count=excluded.head_count, head_count_kv=excluded.head_count_kv, file_type=excluded.file_type,
          quant=excluded.quant, meta=excluded.meta, updated_at=excluded.updated_at`,
      )
      .run(
        path.resolve(row.path),
        row.id,
        row.name,
        row.size,
        Math.round(row.mtime || 0),
        row.sha256 || null,
        row.arch || null,
        row.params || null,
        row.blockCount || null,
        row.contextLength || null,
        row.embeddingLength || null,
        row.headCount || null,
        row.headCountKv || null,
        row.fileType == null ? null : row.fileType,
        row.quant || null,
        JSON.stringify(row.meta || {}),
        now(),
      );
  } catch {
    /* cache is best-effort */
  }
}

/** Scan model folders and merge GGUF facts with the SQLite cache. */
async function scanModels({ hash = false, dir } = {}) {
  const config = getConfig();
  const root = String(dir || config.modelsDir || path.join(training.root(), 'models'));
  const files = await walkModels(root);
  const models = [];
  for (const file of files) {
    const base = path.basename(file.name, path.extname(file.name)).toLowerCase();
    const isProjector = base.includes('mmproj');
    const cached = cachedModel(file.path);
    const cacheFresh = cached && Number(cached.size) === file.size && Number(cached.mtime) === Math.round(file.mtime);
    let meta = null;
    let facts = null;
    let headerError = null;
    if (cacheFresh) {
      try {
        meta = cached.meta ? JSON.parse(cached.meta) : {};
      } catch {
        meta = {};
      }
      facts = {
        arch: cached.arch || '',
        name: (meta && meta.name) || '',
        blockCount: cached.block_count,
        contextLength: cached.context_length,
        embeddingLength: cached.embedding_length,
        headCount: cached.head_count,
        headCountKv: cached.head_count_kv,
        fileType: cached.file_type,
        size: file.size,
      };
      headerError = (meta && meta.headerError) || null;
    } else {
      const read = await readGgufMeta(file.path);
      meta = read.ok ? read : { headerError: read.reason };
      headerError = meta.headerError || null;
      facts = modelFacts(meta.meta || {}, file.size);
    }
    const guessed = guessFromName(file.name);
    let sha256 = cached && cacheFresh ? cached.sha256 : null;
    if (hash && !sha256) sha256 = await hashFile(file.path);
    const row = {
      id: modelIdOf(file.path),
      path: file.path,
      name: file.name,
      size: file.size,
      mtime: file.mtime,
      sha256,
      arch: facts.arch,
      params: guessed.paramsB,
      blockCount: facts.blockCount,
      contextLength: facts.contextLength,
      embeddingLength: facts.embeddingLength,
      headCount: facts.headCount,
      headCountKv: facts.headCountKv,
      fileType: facts.fileType,
      quant: guessed.quant,
      meta: {
        name: facts.name,
        version: meta.version || null,
        tensorCount: meta.tensorCount || null,
        kvCount: meta.kvCount || null,
        projector: isProjector,
        headerError,
      },
    };
    saveModel({ ...row, meta: row.meta });
    models.push({
      ...row,
      kind: isProjector ? 'projector' : 'model',
      headerOk: !headerError,
      fit: null,
    });
  }
  const vram = await effectiveVram();
  const configCtx = getConfig().context;
  for (const model of models) {
    if (model.kind === 'projector') continue;
    model.fit = estimateFit({
      size: model.size,
      blockCount: model.blockCount,
      contextLength: model.contextLength,
      embeddingLength: model.embeddingLength,
      headCount: model.headCount,
      headCountKv: model.headCountKv,
      context: configCtx,
      vramBytes: vram.bytes,
      gpuLayers: getConfig().gpuLayers,
    });
  }
  const selected = getConfig().modelId;
  const value = {
    dir: root,
    models: models.sort((a, b) => b.size - a.size),
    count: models.filter((m) => m.kind === 'model').length,
    totalBytes: models.reduce((sum, m) => sum + (Number(m.size) || 0), 0),
    vram,
    scannedAt: now(),
    selected: models.find((m) => m.id === selected) || null,
  };
  scanCache = { at: now(), dir: root, value };
  return value;
}

/** Hash one registered model and persist the digest in the cache. */
async function hashModel(id) {
  const models = await ensureModels();
  const model = models.models.find((m) => m.id === id);
  if (!model) throw new Error('Model not found.');
  const sha256 = await hashFile(model.path);
  if (!sha256) throw new Error('The model file could not be read.');
  try {
    db.raw()?.prepare('UPDATE brain_models SET sha256 = ?, updated_at = ? WHERE path = ?').run(sha256, now(), path.resolve(model.path));
  } catch {
    /* cache is best-effort */
  }
  return { id, sha256, bytes: model.size };
}

async function hashFile(file) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/* --------------------------------------------------------------- config */

function sanitizeConfig(input = {}) {
  const base = { ...DEFAULT_CONFIG, ...(configCache || db.getSetting(CONFIG_KEY, {}) || {}) };
  const next = { ...base, ...(input || {}) };
  const out = {
    enabled: next.enabled !== false,
    prefer: ['local-first', 'cloud-first', 'offline-only'].includes(next.prefer) ? next.prefer : 'local-first',
    offline: next.offline === true,
    port: Math.max(PORT_MIN, Math.min(PORT_MAX, Math.round(Number(next.port) || DEFAULT_CONFIG.port))),
    context: Math.max(512, Math.min(131072, Math.round(Number(next.context) || DEFAULT_CONFIG.context))),
    threads: Math.max(1, Math.min(64, Math.round(Number(next.threads) || DEFAULT_CONFIG.threads))),
    gpuLayers: next.gpuLayers === 'auto' || next.gpuLayers === '' ? 'auto' : Math.max(0, Math.min(999, Math.round(Number(next.gpuLayers) || 0))),
    vramGb: Number.isFinite(Number(next.vramGb)) && Number(next.vramGb) > 0 ? Math.round(Number(next.vramGb) * 10) / 10 : null,
    idleMinutes: Math.max(0, Math.min(720, Math.round(Number(next.idleMinutes) || 0))),
    runtimePath: String(next.runtimePath || '').trim(),
    modelsDir: String(next.modelsDir || '').trim(),
    modelId: String(next.modelId || '').trim(),
  };
  if (out.offline) out.enabled = true;
  return out;
}

function getConfig() {
  if (!configCache) configCache = sanitizeConfig(db.getSetting(CONFIG_KEY, {}) || {});
  return { ...configCache };
}

function setConfig(patch = {}) {
  const next = sanitizeConfig(patch);
  configCache = next;
  db.setSetting(CONFIG_KEY, next);
  scanCache = { at: 0, dir: '', value: null };
  emit({ type: 'config', config: next });
  return next;
}

async function effectiveVram() {
  const config = getConfig();
  if (config.vramGb) return { bytes: Math.round(config.vramGb * GB), source: 'manual', adapters: [], available: true };
  const gpu = await gpuInfo();
  const best = (gpu.adapters || []).reduce(
    (top, adapter) => (Number(adapter.memoryBytes) > Number(top.memoryBytes || 0) ? adapter : top),
    {},
  );
  if (best && best.memoryBytes) {
    return { bytes: Math.round(best.memoryBytes), source: `driver: ${best.name}`, adapters: gpu.adapters, available: true };
  }
  return { bytes: 0, source: 'unknown', adapters: gpu.adapters || [], available: false, reason: gpu.reason };
}

/* ---------------------------------------------------------------- server */

function baseUrl(port = serverState.port || getConfig().port) {
  return `http://127.0.0.1:${port}/v1`;
}

function emit(event) {
  try {
    ctx.emit && ctx.emit(event);
  } catch {
    /* observer must not break the server */
  }
}

function selectedModel(models = null) {
  const config = getConfig();
  const list = models || (scanCache.value && scanCache.value.models) || [];
  return list.find((m) => m.id === config.modelId && m.kind !== 'projector') || null;
}

async function ensureModels() {
  const cached = scanCache.value;
  if (cached && now() - scanCache.at < 30_000) return cached;
  return scanModels();
}

function freePort(start) {
  const net = require('node:net');
  return new Promise((resolve) => {
    const attempt = (port) => {
      if (port > PORT_MAX) {
        resolve(0);
        return;
      }
      const probe = net.createServer();
      probe.once('error', () => attempt(port + 1));
      probe.once('listening', () => probe.close(() => resolve(port)));
      probe.listen(port, '127.0.0.1');
    };
    attempt(start);
  });
}

async function waitForHealth(port, timeoutMs) {
  const until = now() + timeoutMs;
  while (now() < until) {
    if (!server || server.exitCode !== null) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        if (String(body.status || '').toLowerCase() !== 'loading') return true;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

async function start(modelId) {
  const config = getConfig();
  if (!config.enabled) throw new Error('Local brain is disabled. Enable it first.');
  const models = await ensureModels();
  const model = models.models.find((m) => m.id === (modelId || config.modelId)) || selectedModel(models.models);
  if (!model) throw new Error('Pick a GGUF model to load first.');
  if (model.kind === 'projector') throw new Error('That file is a vision projector, not a chat model.');
  if (server && server.exitCode === null) {
    if (serverState.modelId === model.id && serverState.state === 'running') return status();
    await stop('switch');
  }
  const runtime = await findRuntime(config);
  if (!runtime.found) throw new Error(runtime.reason);
  const port = await freePort(config.port);
  const fit = estimateFit({
    size: model.size,
    blockCount: model.blockCount,
    contextLength: model.contextLength,
    embeddingLength: model.embeddingLength,
    headCount: model.headCount,
    headCountKv: model.headCountKv,
    context: config.context,
    vramBytes: (await effectiveVram()).bytes,
    gpuLayers: config.gpuLayers,
  });
  const args = [
    '-m',
    model.path,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '-c',
    String(config.context),
    '-t',
    String(config.threads),
    '-ngl',
    String(fit.gpuLayers || 0),
    '--no-webui',
  ];
  if (config.context && model.contextLength && config.context > model.contextLength) {
    pushLog(`Requested context ${config.context} exceeds the model's ${model.contextLength}; the server will clamp it.`, 'warn');
  }
  const modelDir = path.dirname(model.path).toLowerCase();
  const projector = (models.models || []).find(
    (m) => m.kind === 'projector' && path.dirname(m.path).toLowerCase() === modelDir,
  );
  if (projector) {
    args.push('--mmproj', projector.path);
    pushLog(`Vision projector attached: ${projector.name}`, 'info');
  }
  logs = [];
  pushLog(`Starting ${path.basename(runtime.path)} with ${model.name} on port ${port}`, 'info');
  serverState = {
    state: 'starting',
    pid: null,
    port,
    modelId: model.id,
    modelPath: model.path,
    startedAt: now(),
    lastRequestAt: null,
    error: null,
  };
  emit({ type: 'server', state: serverState.state, modelId: model.id, port });
  const child = spawn(runtime.path, args, { cwd: dirnameOf(runtime.path), windowsHide: true, env: process.env });
  server = child;
  serverState.pid = child.pid;
  const onData = (kind) => (chunk) => {
    for (const line of String(chunk || '').split(/\r?\n/)) if (line.trim()) pushLog(line.trim(), kind);
  };
  child.stdout.on('data', onData('out'));
  child.stderr.on('data', onData('err'));
  child.on('error', (err) => {
    serverState = { ...serverState, state: 'error', error: err && err.message ? err.message : String(err) };
    emit({ type: 'server', state: 'error', error: serverState.error });
  });
  child.on('exit', (code, signal) => {
    const wasRunning = serverState.state === 'running' || serverState.state === 'starting';
    server = null;
    serverState = {
      ...serverState,
      state: wasRunning && serverState.state !== 'stopping' ? 'error' : 'stopped',
      pid: null,
      error: wasRunning && serverState.state !== 'stopping' ? `llama-server exited (${code ?? signal}).` : serverState.error,
    };
    if (wasRunning && serverState.state === 'error') pushLog(`Process exited with code ${code ?? signal}`, 'err');
    emit({ type: 'server', state: serverState.state, error: serverState.error });
  });
  const healthy = await waitForHealth(port, HEALTH_TIMEOUT_MS);
  if (!healthy) {
    const error = serverState.error || 'llama-server did not pass its health check in time.';
    await stop('failed');
    throw new Error(`${error} ${logs.slice(-3).map((l) => l.line).join(' | ')}`.trim());
  }
  serverState = { ...serverState, state: 'running', startedAt: serverState.startedAt || now() };
  pushLog('Health check passed; the local model is ready.', 'info');
  startIdleTimer();
  emit({ type: 'server', state: 'running', modelId: model.id, port });
  await db.audit({ kind: 'local-brain-start', tool: 'localbrain', args: JSON.stringify({ model: model.name, port, gpuLayers: fit.gpuLayers }), ok: true, ms: now() - serverState.startedAt });
  return status();
}

async function stop(reason = 'user') {
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
  const child = server;
  if (!child || child.exitCode !== null) {
    server = null;
    if (serverState.state !== 'stopped') {
      serverState = { ...serverState, state: 'stopped', pid: null };
      emit({ type: 'server', state: 'stopped', reason });
    }
    return status();
  }
  serverState = { ...serverState, state: 'stopping' };
  emit({ type: 'server', state: 'stopping', reason });
  pushLog(`Stopping llama-server (${reason}).`, 'info');
  try {
    child.kill();
  } catch {
    /* fall through to taskkill */
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        if (ctx.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        else child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve();
    }, 4000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  server = null;
  serverState = { ...serverState, state: 'stopped', pid: null };
  emit({ type: 'server', state: 'stopped', reason });
  return status();
}

function startIdleTimer() {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = setInterval(async () => {
    const config = getConfig();
    if (!config.idleMinutes || !server || server.exitCode !== null) return;
    const last = serverState.lastRequestAt || serverState.startedAt || now();
    if (now() - last > config.idleMinutes * 60_000) {
      pushLog(`Auto-unload after ${config.idleMinutes} idle minutes.`, 'info');
      await stop('idle');
    }
  }, IDLE_CHECK_MS);
  idleTimer.unref?.();
}

/* ------------------------------------------------------------------- API */

async function chat({ messages, temperature, maxTokens, grammar, jsonSchema } = {}) {
  if (!serverState.state || serverState.state !== 'running') {
    throw new Error('No local model is running. Load a GGUF model on the Training page first.');
  }
  const config = getConfig();
  const model = selectedModel();
  const body = {
    model: (model && model.name) || 'local',
    messages: Array.isArray(messages) ? messages : [],
    temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.7,
    max_tokens: Number.isFinite(Number(maxTokens)) ? Number(maxTokens) : 1024,
    stream: false,
  };
  if (grammar) body.grammar = String(grammar);
  if (jsonSchema) body.response_format = { type: 'json_object', schema: jsonSchema };
  serverState.lastRequestAt = now();
  const res = await fetch(`${baseUrl(serverState.port)}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Local model returned ${res.status}: ${clip(text, 400)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The local model returned a non-JSON response.');
  }
}

/** GBNF grammar for a single tool call; llama.cpp accepts it on /chat/completions. */
function toolGrammar() {
  const ws = '[ \\t\\n]*';
  const string = '"\\"" ([^"\\\\] | "\\\\" .)* "\\""';
  return [
    'root ::= ' + ws + '"{"' + ws + '"tool"' + ws + '":"' + ws + 'string' + ws + '","' + ws + '"arguments"' + ws + '":"' + ws + 'json' + ws + '"}"' + ws,
    'string ::= ' + string,
    'json ::= object | array | string | number | "true" | "false" | "null"',
    'object ::= "{"' + ws + '(pair (' + ws + '","' + ws + 'pair)*)?' + ws + '"}"',
    'pair ::= ' + string + ws + '":"' + ws + 'json',
    'array ::= "["' + ws + '(json (' + ws + '","' + ws + 'json)*)?' + ws + '"]"',
    'number ::= "-"? [0-9]+ ("." [0-9]+)? ([eE] [-+]? [0-9]+)?',
  ].join('\n');
}

async function route({ task = 'agent' } = {}) {
  const config = getConfig();
  const running = serverState.state === 'running';
  if (!config.enabled) return { target: 'cloud', reason: 'Local brain is disabled.', task };
  if (config.prefer === 'offline-only' || config.offline) {
    if (running) return { target: 'local', reason: 'Offline mode; the local model is ready.', task };
    return { target: 'blocked', reason: 'Offline mode is on and no local model is running.', task };
  }
  if (running) return { target: 'local', reason: 'A local model is loaded and healthy.', task };
  return { target: 'cloud', reason: 'Local brain is enabled but no model is loaded.', task };
}

/** Gateway candidate for the currently running server, or null. */
function candidate() {
  if (serverState.state !== 'running') return null;
  const model = selectedModel();
  if (!model) return null;
  return {
    id: 'localbrain',
    presetId: 'localbrain',
    name: `Local Brain · ${model.name}`,
    baseUrl: baseUrl(serverState.port),
    apiKey: 'local',
    api: 'openai',
    model: model.name,
    local: true,
  };
}

async function capabilities() {
  const runtime = await findRuntime(getConfig());
  const models = (scanCache.value && scanCache.value.models) || [];
  const chatModel = selectedModel(models);
  const projector = models.find((m) => m.kind === 'projector');
  const running = serverState.state === 'running';
  return {
    chat: running
      ? { available: true, reason: null }
      : { available: false, reason: runtime.found ? (chatModel ? 'Load the model to enable chat.' : 'No GGUF chat model is selected.') : runtime.reason },
    vision: projector && running
      ? { available: true, reason: null }
      : { available: false, reason: projector ? 'Load a model with the projector attached.' : 'No mmproj vision projector found next to the model.' },
    embeddings: { available: false, reason: 'Loading an embedding model replaces the chat model; switch models to serve embeddings.' },
    speech: { available: false, reason: 'Local STT/TTS needs a separate runtime; none is configured.' },
    reranker: { available: false, reason: 'No reranker runtime is configured.' },
  };
}

async function status() {
  const config = getConfig();
  const runtime = await findRuntime(config);
  const cached = scanCache.value;
  const vram = await effectiveVram();
  const model = cached ? selectedModel(cached.models) : null;
  const models = cached ? cached.models : [];
  return {
    enabled: config.enabled,
    offline: config.offline,
    prefer: config.prefer,
    config,
    runtime,
    server: {
      ...serverState,
      baseUrl: serverState.state === 'running' ? baseUrl(serverState.port) : null,
      uptimeMs: serverState.startedAt && serverState.state === 'running' ? now() - serverState.startedAt : 0,
      canStart: runtime.found && !!(model || models.find((m) => m.kind !== 'projector')),
    },
    model: model
      ? {
          id: model.id,
          name: model.name,
          size: model.size,
          quant: model.quant,
          arch: model.arch,
          params: model.params,
          fit: estimateFit({
            size: model.size,
            blockCount: model.blockCount,
            contextLength: model.contextLength,
            embeddingLength: model.embeddingLength,
            headCount: model.headCount,
            headCountKv: model.headCountKv,
            context: config.context,
            vramBytes: vram.bytes,
            gpuLayers: config.gpuLayers,
          }),
        }
      : null,
    models: { count: models.filter((m) => m.kind !== 'projector').length, totalBytes: models.reduce((s, m) => s + (Number(m.size) || 0), 0), scannedAt: cached ? cached.scannedAt : null },
    vram,
    gpu: await gpuInfo(),
    capabilities: await capabilities(),
    logs: logs.slice(-80),
    bootAt,
  };
}

function init(options = {}) {
  ctx = { ...ctx, ...options };
  bootAt = now();
  try {
    db.raw()
      ?.prepare(
        `CREATE TABLE IF NOT EXISTS brain_models (
          path TEXT PRIMARY KEY, id TEXT NOT NULL, name TEXT, size INTEGER DEFAULT 0, mtime INTEGER DEFAULT 0,
          sha256 TEXT, arch TEXT, params REAL, block_count INTEGER, context_length INTEGER,
          embedding_length INTEGER, head_count INTEGER, head_count_kv INTEGER, file_type INTEGER,
          quant TEXT, meta TEXT, updated_at INTEGER NOT NULL
        )`,
      )
      .run();
  } catch {
    /* table is created by the schema in normal boots */
  }
  findRuntime(getConfig()).then((runtime) => {
    if (!runtime.found) pushLog(runtime.reason, 'warn');
    emit({ type: 'runtime', runtime });
  }).catch(() => {});
  ensureModels().catch(() => {});
  return status();
}

async function shutdown() {
  if (server && server.exitCode === null) await stop('shutdown');
}

module.exports = {
  init,
  status,
  getConfig,
  setConfig,
  scanModels,
  findRuntime,
  estimateFit,
  route,
  candidate,
  capabilities,
  start,
  stop,
  chat,
  toolGrammar,
  hashModel,
  hashFile,
  readGgufMeta,
  modelFacts,
  guessFromName,
  parseGpuJson,
  effectiveVram,
  shutdown,
  _internals: {
    DEFAULT_CONFIG,
    sanitizeConfig,
    formatBytes,
    modelIdOf,
    archOf,
    baseUrl,
  },
};
