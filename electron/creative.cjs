'use strict';

/**
 * Section 10 — Media / Creative Studio.
 * Real generation, editing, upscaling, transcription, subtitles, speech, music,
 * 3D inspection and an on-disk asset + prompt library. Every provider call goes
 * to an endpoint the user configured; there is no simulated output anywhere.
 */

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const mm = require('music-metadata');
const { checkPath, checkUrl } = require('./guardrails.cjs');

const MAX_IMPORT = 1024 * 1024 * 1024;
const MAX_DOWNLOAD = 100 * 1024 * 1024;
const MAX_TRANSCRIBE = 500 * 1024 * 1024;
const MAX_PROMPT = 8000;
const SOURCE_TTL_MS = 6 * 3600 * 1000;
const NET_TIMEOUT_MS = 240 * 1000;
const PROMPT_KEEP = 2000;

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'tiff', 'tif', 'svg']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma', 'aiff']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'wmv']);
const MODEL_EXT = new Set(['gltf', 'glb', 'obj', 'stl', 'ply', 'fbx', 'dae', '3ds']);
const SUB_EXT = new Set(['srt', 'vtt']);

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
  avif: 'image/avif', tiff: 'image/tiff', tif: 'image/tiff', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/opus', flac: 'audio/flac', wma: 'audio/x-ms-wma', aiff: 'audio/aiff',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  m4v: 'video/mp4', wmv: 'video/x-ms-wmv',
  gltf: 'model/gltf+json', glb: 'model/gltf-binary', obj: 'model/obj', stl: 'model/stl', ply: 'model/ply',
  fbx: 'application/octet-stream', dae: 'model/vnd.collada+xml', '3ds': 'application/octet-stream',
  srt: 'application/x-subrip', vtt: 'text/vtt', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
};

let ctx = { dataDir: null, emit: null, gateway: null };
let ready = false;
let lastError = null;
let indexQueue = Promise.resolve();
let cachedLibrary = null;
let cachedPrompts = null;
const sources = new Map();

function now() {
  return Date.now();
}

function newId(prefix) {
  return `${prefix}_${now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function extOf(p) {
  return path.extname(String(p || '')).replace(/^\./, '').toLowerCase();
}

function mimeOf(p, fallback = 'application/octet-stream') {
  return MIME[extOf(p)] || fallback;
}

function stemOf(p) {
  return path.basename(String(p || ''), path.extname(String(p || '')));
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(Number(n) || 0, lo), hi);
}

function kindOfExt(ext) {
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (MODEL_EXT.has(ext)) return 'model';
  if (SUB_EXT.has(ext)) return 'subtitle';
  return 'file';
}

function libraryDir() {
  return path.join(ctx.dataDir, 'media-library');
}

function filesDir() {
  return path.join(libraryDir(), 'files');
}

function indexPath() {
  return path.join(libraryDir(), 'index.json');
}

function promptsPath() {
  return path.join(libraryDir(), 'prompts.json');
}

function safeReadPath(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('File path is empty.');
  const resolved = path.resolve(text.replace(/^["']|["']$/g, ''));
  const blocked = checkPath(resolved, 'read');
  if (blocked) throw new Error(blocked);
  return resolved;
}

function safeWriteDir(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('Folder is empty.');
  const resolved = path.resolve(text.replace(/^["']|["']$/g, ''));
  const blocked = checkPath(resolved, 'write');
  if (blocked) throw new Error(blocked);
  return resolved;
}

async function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(value), 'utf8');
  await fsp.rename(tmp, file);
}

function mutateIndex(fn) {
  const run = async () => {
    const lib = await loadLibrary();
    const result = await fn(lib);
    await writeJson(indexPath(), lib);
    cachedLibrary = lib;
    return result;
  };
  const next = indexQueue.then(run, run);
  indexQueue = next.catch(() => {});
  return next;
}

async function loadLibrary() {
  if (cachedLibrary) return cachedLibrary;
  const parsed = await readJson(indexPath(), { version: 1, assets: [] });
  if (!Array.isArray(parsed.assets)) parsed.assets = [];
  cachedLibrary = parsed;
  return parsed;
}

async function loadPrompts() {
  if (cachedPrompts) return cachedPrompts;
  const parsed = await readJson(promptsPath(), { version: 1, prompts: [] });
  if (!Array.isArray(parsed.prompts)) parsed.prompts = [];
  cachedPrompts = parsed;
  return parsed;
}

function mutatePrompts(fn) {
  const run = async () => {
    const lib = await loadPrompts();
    const result = fn(lib);
    if (lib.prompts.length > PROMPT_KEEP) lib.prompts = lib.prompts.slice(-PROMPT_KEEP);
    await writeJson(promptsPath(), lib);
    cachedPrompts = lib;
    return result;
  };
  return run();
}

function emit(event) {
  if (!ctx.emit) return;
  try {
    ctx.emit(event);
  } catch {
    /* renderer gone */
  }
}

function requireReady() {
  if (!ready || !ctx.dataDir) throw new Error(`Media is not ready${lastError ? ` — ${lastError}` : ''}.`);
}

async function init(opts = {}) {
  ctx = {
    dataDir: opts.dataDir || ctx.dataDir,
    emit: typeof opts.emit === 'function' ? opts.emit : ctx.emit,
    gateway: opts.gateway || ctx.gateway,
  };
  lastError = null;
  cachedLibrary = null;
  cachedPrompts = null;
  try {
    await fsp.mkdir(filesDir(), { recursive: true });
    await loadLibrary();
    await loadPrompts();
    ready = true;
  } catch (err) {
    ready = false;
    lastError = err && err.message ? err.message : String(err);
  }
  return info();
}

function info() {
  return {
    ready,
    error: lastError,
    libraryDir: ctx.dataDir ? libraryDir() : null,
    assets: cachedLibrary ? cachedLibrary.assets.length : 0,
    prompts: cachedPrompts ? cachedPrompts.prompts.length : 0,
  };
}

/**
 * Real metadata: sharp for raster images, music-metadata for audio/video
 * containers. Anything unreadable is reported as null rather than invented.
 */
async function deriveMeta(file, kind) {
  const ext = extOf(file);
  if (kind === 'image' && ext !== 'svg') {
    try {
      const meta = await sharp(file, { failOn: 'none' }).metadata();
      return {
        width: meta.width || null,
        height: meta.height || null,
        format: meta.format || ext,
        hasAlpha: !!meta.hasAlpha,
        space: meta.space || null,
        pages: meta.pages && meta.pages > 1 ? meta.pages : undefined,
      };
    } catch {
      return null;
    }
  }
  if (kind === 'audio' || kind === 'video') {
    try {
      const parsed = await mm.parseFile(file, { duration: true, skipCovers: true });
      const common = parsed.common || {};
      return {
        duration: parsed.format && Number.isFinite(parsed.format.duration) ? Math.round(parsed.format.duration * 1000) / 1000 : null,
        codec: parsed.format && parsed.format.codec ? String(parsed.format.codec) : null,
        container: parsed.format && parsed.format.container ? String(parsed.format.container) : null,
        bitrate: parsed.format && parsed.format.bitrate ? Math.round(parsed.format.bitrate) : null,
        sampleRate: parsed.format && parsed.format.sampleRate ? parsed.format.sampleRate : null,
        channels: parsed.format && parsed.format.numberOfChannels ? parsed.format.numberOfChannels : null,
        title: common.title || null,
        artist: common.artist || null,
        album: common.album || null,
      };
    } catch {
      return null;
    }
  }
  return null;
}

function uniqueName(dir, desired) {
  const parsed = path.parse(desired);
  const stem = parsed.name || 'asset';
  const ext = parsed.ext || '';
  let candidate = `${stem}${ext}`;
  let n = 2;
  while (true) {
    try {
      fs.accessSync(path.join(dir, candidate));
      candidate = `${stem} (${n})${ext}`;
      n += 1;
    } catch {
      return candidate;
    }
  }
}

async function saveBuffer(buffer, opts = {}) {
  requireReady();
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('The provider returned an empty file.');
  const baseName = String(opts.name || '').trim();
  let ext = (opts.ext || extOf(baseName) || '').replace(/^\./, '').toLowerCase();
  if (!ext) ext = 'bin';
  const display = baseName
    ? baseName.toLowerCase().endsWith(`.${ext}`) ? baseName : `${baseName}.${ext}`
    : `${opts.kind || 'asset'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
  const record = await mutateIndex(async (lib) => {
    const id = newId('med');
    const file = `${id}.${ext}`;
    await fsp.writeFile(path.join(filesDir(), file), buffer);
    const kind = opts.kind || kindOfExt(ext);
    const meta = opts.meta || (await deriveMeta(path.join(filesDir(), file), kind));
    const row = {
      id,
      name: display,
      kind,
      file,
      ext,
      mime: opts.mime || mimeOf(file),
      bytes: buffer.length,
      createdAt: now(),
      source: opts.source || 'generated',
      prompt: opts.prompt ? String(opts.prompt).slice(0, MAX_PROMPT) : null,
      provider: opts.provider || null,
      model: opts.model || null,
      meta: meta || null,
    };
    lib.assets.push(row);
    return row;
  });
  emit({ type: 'add', asset: publicAsset(record) });
  return publicAsset(record);
}

function publicAsset(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    ext: row.ext,
    mime: row.mime,
    bytes: row.bytes,
    createdAt: row.createdAt,
    source: row.source,
    prompt: row.prompt,
    provider: row.provider,
    model: row.model,
    meta: row.meta,
    url: `orvex-media://asset/${row.id}`,
  };
}

async function getAssetRow(id) {
  requireReady();
  const lib = await loadLibrary();
  const row = lib.assets.find((a) => a.id === String(id));
  if (!row) throw new Error('That media asset no longer exists.');
  return row;
}

function assetFile(row) {
  const file = path.join(filesDir(), path.basename(row.file));
  if (!file.startsWith(filesDir() + path.sep)) throw new Error('Asset path escaped the library.');
  return file;
}

async function library({ kind, query, limit } = {}) {
  requireReady();
  const lib = await loadLibrary();
  const q = String(query || '').trim().toLowerCase();
  let rows = lib.assets.slice().sort((a, b) => b.createdAt - a.createdAt);
  if (kind && kind !== 'all') rows = rows.filter((r) => r.kind === kind);
  if (q) {
    rows = rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        String(r.prompt || '').toLowerCase().includes(q) ||
        String(r.model || '').toLowerCase().includes(q) ||
        String(r.ext || '').toLowerCase() === q,
    );
  }
  const total = rows.length;
  rows = rows.slice(0, clamp(limit || 200, 1, 2000));
  return { total, assets: rows.map(publicAsset) };
}

async function getAsset(id) {
  return publicAsset(await getAssetRow(id));
}

async function deleteAsset(id) {
  const row = await getAssetRow(id);
  await mutateIndex(async (lib) => {
    lib.assets = lib.assets.filter((a) => a.id !== row.id);
  });
  try {
    await fsp.unlink(assetFile(row));
  } catch {
    /* file already gone */
  }
  emit({ type: 'delete', id: row.id });
  return { deleted: row.id, name: row.name };
}

async function renameAsset({ id, name } = {}) {
  const row = await getAssetRow(id);
  const next = String(name || '').trim();
  if (!next) throw new Error('Name is empty.');
  if (/[\\/:*?"<>|]/.test(next)) throw new Error('Names cannot contain \\ / : * ? " < > |');
  if (next.length > 160) throw new Error('Name is too long (160 max).');
  const updated = await mutateIndex(async (lib) => {
    const target = lib.assets.find((a) => a.id === row.id);
    target.name = next;
    return target;
  });
  emit({ type: 'update', asset: publicAsset(updated) });
  return publicAsset(updated);
}

async function exportAsset({ id, destDir } = {}) {
  const row = await getAssetRow(id);
  const dir = safeWriteDir(destDir);
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, uniqueName(dir, row.name));
  await fsp.copyFile(assetFile(row), target);
  return { path: target, bytes: row.bytes };
}

async function exportTo({ id, destPath } = {}) {
  const row = await getAssetRow(id);
  const target = path.resolve(String(destPath || '').replace(/^["']|["']$/g, ''));
  const blocked = checkPath(target, 'write');
  if (blocked) throw new Error(blocked);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.copyFile(assetFile(row), target);
  return { path: target, bytes: row.bytes };
}

async function assetPath({ id } = {}) {
  const row = await getAssetRow(id);
  return { path: assetFile(row), name: row.name, id: row.id };
}

/** Base64 payload for vision calls, straight from a library asset. */
async function imagePayload({ assetId } = {}) {
  const row = await getAssetRow(assetId);
  if (row.kind !== 'image') throw new Error('Only image assets can be sent for analysis.');
  const buffer = await fsp.readFile(assetFile(row));
  return { mime: row.mime, data: buffer.toString('base64'), name: row.name };
}

async function importAsset({ path: filePath, name } = {}) {
  const source = safeReadPath(filePath);
  const st = await fsp.stat(source);
  if (!st.isFile()) throw new Error('Pick a file, not a folder.');
  if (st.size > MAX_IMPORT) throw new Error('That file is over 1 GB — too large for the media library.');
  const ext = extOf(source);
  const kind = kindOfExt(ext);
  const buffer = await fsp.readFile(source);
  let meta = await deriveMeta(source, kind);
  if (kind === 'model') meta = await modelMeta(source, buffer);
  return await saveBuffer(buffer, {
    name: String(name || path.basename(source)),
    ext,
    kind,
    mime: mimeOf(source),
    source: 'import',
    meta,
  });
}

/* ------------------------------------------------------------ provider calls */

function friendlyHttp(status, text) {
  const detail = String(text || '').replace(/\s+/g, ' ').slice(0, 300);
  if (status === 401 || status === 403) return `the API key was rejected (${status}) — check it in Settings → Providers`;
  if (status === 402) return 'the account is out of credits (402)';
  if (status === 404) return `the endpoint or model was not found (404) — ${detail}`;
  if (status === 429) return 'rate-limited upstream (429) — wait a moment and retry';
  if (status >= 500) return `provider error ${status} — ${detail}`;
  return `provider rejected the request (${status}) — ${detail}`;
}

function providerKind(provider = {}) {
  const base = String(provider.baseUrl || '').toLowerCase();
  if (provider.api === 'anthropic') return 'unsupported';
  if (base.includes('generativelanguage.googleapis.com')) return 'gemini';
  if (base.includes('openrouter.ai')) return 'openrouter';
  return 'openai';
}

function providerBase(provider) {
  const base = String(provider && provider.baseUrl ? provider.baseUrl : '').replace(/\/+$/, '');
  if (!base) throw new Error('That provider has no base URL. Fix it in Settings → Providers.');
  return base;
}

function defaultImageModel(provider) {
  const kind = providerKind(provider);
  const base = providerBase(provider).toLowerCase();
  if (kind === 'gemini') return 'gemini-2.5-flash-image';
  if (kind === 'openrouter') return '';
  if (base.includes('openai.com')) return 'gpt-image-1';
  if (base.includes('together')) return 'black-forest-labs/FLUX.1-schnell';
  return '';
}

function authHeaders(provider, extra = {}) {
  const headers = { ...extra };
  if (provider && provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  return headers;
}

function requireKey(provider) {
  if (!provider || !provider.apiKey) {
    const name = provider && provider.name ? provider.name : 'this provider';
    throw new Error(`${name} has no API key — add one in Settings → Providers, or pick a local endpoint.`);
  }
}

async function requestJson(url, { method = 'POST', headers, body, timeoutMs = NET_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method, headers, body: body && typeof body !== 'string' && !(body instanceof FormData) ? JSON.stringify(body) : body, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`The request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    throw new Error(`Network error — ${err && err.message ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(friendlyHttp(res.status, text));
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { json, text, contentType: res.headers.get('content-type') || '' };
}

async function downloadBytes(url, headers = undefined) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NET_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`Could not download the generated file (HTTP ${res.status}).`);
    const length = Number(res.headers.get('content-length') || 0);
    if (length > MAX_DOWNLOAD) throw new Error('The provider returned a file over 100 MB.');
    const type = res.headers.get('content-type') || '';
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType: type };
  } catch (err) {
    if (controller.signal.aborted) throw new Error('The download timed out.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function dataUrlToBuffer(value) {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(value || ''));
  if (!match) return null;
  return { mime: match[1], buffer: Buffer.from(match[3], match[2] ? 'base64' : 'utf8') };
}

function imagesFromChatJson(json) {
  const out = [];
  const message = json && json.choices && json.choices[0] && json.choices[0].message;
  if (!message) return out;
  // OpenRouter returns generated images in message.images.
  for (const img of message.images || []) {
    const url = img && img.image_url ? img.image_url.url : img && img.url ? img.url : typeof img === 'string' ? img : '';
    const parsed = dataUrlToBuffer(url);
    if (parsed) out.push(parsed);
  }
  // Some gateways mirror images as content parts.
  if (!out.length && Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part && part.type === 'image_url' && part.image_url && part.image_url.url) {
        const parsed = dataUrlToBuffer(part.image_url.url);
        if (parsed) out.push(parsed);
      }
    }
  }
  return out;
}

function imagesFromGemini(json) {
  const out = [];
  const candidates = (json && json.candidates) || [];
  for (const cand of candidates) {
    const parts = (cand.content && cand.content.parts) || [];
    for (const part of parts) {
      const inline = part.inlineData || part.inline_data;
      if (inline && inline.data) {
        out.push({ mime: inline.mimeType || inline.mime_type || 'image/png', buffer: Buffer.from(inline.data, 'base64') });
      }
    }
  }
  return out;
}

async function geminiCall(provider, model, parts) {
  requireKey(provider);
  const base = providerBase(provider);
  const id = String(model || '').trim();
  if (!id) throw new Error('Pick a Gemini image model (for example gemini-2.5-flash-image).');
  const { json } = await requestJson(`${base}/models/${encodeURIComponent(id)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`, {
    headers: { 'content-type': 'application/json' },
    body: { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } },
  });
  return { images: imagesFromGemini(json || {}), text: geminiText(json) };
}

function geminiText(json) {
  const candidates = (json && json.candidates) || [];
  const lines = [];
  for (const cand of candidates) {
    for (const part of (cand.content && cand.content.parts) || []) {
      if (part.text) lines.push(part.text);
    }
  }
  return lines.join('\n').trim();
}

async function generateImage({ provider, prompt, model, size, n } = {}) {
  requireReady();
  const text = String(prompt || '').trim();
  if (!text) throw new Error('Write a prompt first.');
  if (text.length > MAX_PROMPT) throw new Error(`Prompt is too long (${MAX_PROMPT} characters max).`);
  const count = clamp(n || 1, 1, 4);
  const kind = providerKind(provider);
  if (kind === 'unsupported') {
    throw new Error(`${provider.name || 'This provider'} does not serve image generation. Pick OpenAI, Google Gemini, Together, OpenRouter or a custom image endpoint.`);
  }
  const chosen = String(model || '').trim() || defaultImageModel(provider);
  if (!chosen) throw new Error('Pick an image model first.');

  let buffers = [];
  if (kind === 'gemini') {
    for (let i = 0; i < count; i += 1) {
      const result = await geminiCall(provider, chosen, [{ text }]);
      if (!result.images.length) {
        throw new Error(`Gemini returned no image${result.text ? ` — ${result.text.slice(0, 200)}` : ' (the model may be text-only).'}`);
      }
      buffers.push(...result.images);
    }
  } else if (kind === 'openrouter') {
    for (let i = 0; i < count; i += 1) {
      const { json } = await requestJson(`${providerBase(provider)}/chat/completions`, {
        headers: authHeaders(provider, { 'content-type': 'application/json' }),
        body: {
          model: chosen,
          modalities: ['image', 'text'],
          messages: [{ role: 'user', content: text }],
        },
      });
      const images = imagesFromChatJson(json || {});
      if (!images.length) throw new Error('OpenRouter returned no image — that model may not support image output.');
      buffers.push(...images);
    }
  } else {
    requireKey(provider);
    const base = providerBase(provider);
    const payload = { model: chosen, prompt: text, n: count, ...(size ? { size } : {}) };
    let result;
    try {
      result = await requestJson(`${base}/images/generations`, {
        headers: authHeaders(provider, { 'content-type': 'application/json' }),
        body: { ...payload, response_format: 'b64_json' },
      });
    } catch (err) {
      // gpt-image-1 rejects response_format; the image still comes back as b64.
      if (/response_format|unsupported|unknown/i.test(err.message)) {
        result = await requestJson(`${base}/images/generations`, {
          headers: authHeaders(provider, { 'content-type': 'application/json' }),
          body: payload,
        });
      } else {
        throw err;
      }
    }
    const rows = (result.json && result.json.data) || [];
    if (!rows.length) throw new Error('The provider returned no image data.');
    for (const row of rows) {
      if (row.b64_json) buffers.push({ mime: 'image/png', buffer: Buffer.from(row.b64_json, 'base64') });
      else if (row.url) {
        const dl = await downloadBytes(row.url);
        buffers.push({ mime: dl.contentType || 'image/png', buffer: dl.buffer });
      }
    }
  }

  if (!buffers.length) throw new Error('The provider returned no decodable image.');
  const assets = [];
  for (const item of buffers.slice(0, 8)) {
    const ext = (item.mime.split('/')[1] || 'png').replace('jpeg', 'jpg').split('+')[0];
    assets.push(
      await saveBuffer(item.buffer, {
        name: `generated-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`,
        ext: IMAGE_EXT.has(ext) ? ext : 'png',
        kind: 'image',
        mime: item.mime,
        source: 'generation',
        prompt: text,
        provider: provider.name || provider.id || null,
        model: chosen,
      }),
    );
  }
  return { assets, prompt: text, provider: provider.name || null, model: chosen };
}

async function readImageInput({ assetId, path: filePath } = {}) {
  if (assetId) {
    const row = await getAssetRow(assetId);
    return { buffer: await fsp.readFile(assetFile(row)), mime: row.mime, name: row.name, asset: row };
  }
  const source = safeReadPath(filePath);
  const buffer = await fsp.readFile(source);
  return { buffer, mime: mimeOf(source, 'image/png'), name: path.basename(source), asset: null };
}

async function editImage({ provider, prompt, assetId, path: filePath, maskAssetId, maskPath, model, size } = {}) {
  requireReady();
  const text = String(prompt || '').trim();
  if (!text) throw new Error('Describe the edit you want.');
  const input = await readImageInput({ assetId, path: filePath });
  let mask = null;
  if (maskAssetId || maskPath) mask = await readImageInput({ assetId: maskAssetId, path: maskPath });

  const kind = providerKind(provider);
  let images = [];
  if (kind === 'unsupported') {
    throw new Error(`${provider.name || 'This provider'} cannot edit images. Pick OpenAI, Google Gemini or OpenRouter.`);
  }
  const chosen = String(model || '').trim() || defaultImageModel(provider) || 'gpt-image-1';
  if (kind === 'gemini') {
    const parts = [{ text }, { inline_data: { mime_type: input.mime, data: input.buffer.toString('base64') } }];
    if (mask) parts.push({ text: 'Use this mask to limit the edit to the transparent area.' }, { inline_data: { mime_type: mask.mime, data: mask.buffer.toString('base64') } });
    const result = await geminiCall(provider, chosen, parts);
    if (!result.images.length) throw new Error(`Gemini returned no edited image${result.text ? ` — ${result.text.slice(0, 200)}` : ''}.`);
    images = result.images;
  } else if (kind === 'openrouter') {
    const content = [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: `data:${input.mime};base64,${input.buffer.toString('base64')}` } },
    ];
    const { json } = await requestJson(`${providerBase(provider)}/chat/completions`, {
      headers: authHeaders(provider, { 'content-type': 'application/json' }),
      body: { model: chosen, modalities: ['image', 'text'], messages: [{ role: 'user', content }] },
    });
    images = imagesFromChatJson(json || {});
    if (!images.length) throw new Error('OpenRouter returned no edited image.');
  } else {
    requireKey(provider);
    const form = new FormData();
    form.append('model', chosen);
    form.append('prompt', text);
    form.append('image', new Blob([input.buffer], { type: input.mime }), input.name);
    if (mask) form.append('mask', new Blob([mask.buffer], { type: mask.mime }), mask.name);
    if (size) form.append('size', size);
    const { json } = await requestJson(`${providerBase(provider)}/images/edits`, {
      headers: authHeaders(provider),
      body: form,
    });
    const rows = (json && json.data) || [];
    if (!rows.length) throw new Error('The provider returned no edited image.');
    for (const row of rows) {
      if (row.b64_json) images.push({ mime: 'image/png', buffer: Buffer.from(row.b64_json, 'base64') });
      else if (row.url) {
        const dl = await downloadBytes(row.url);
        images.push({ mime: dl.contentType || 'image/png', buffer: dl.buffer });
      }
    }
  }

  const assets = [];
  for (const item of images) {
    const ext = (item.mime.split('/')[1] || 'png').replace('jpeg', 'jpg').split('+')[0];
    assets.push(
      await saveBuffer(item.buffer, {
        name: `${stemOf(input.name)}-edit`,
        ext: IMAGE_EXT.has(ext) ? ext : 'png',
        kind: 'image',
        mime: item.mime,
        source: 'edit',
        prompt: text,
        provider: provider.name || provider.id || null,
        model: chosen,
      }),
    );
  }
  return { assets, prompt: text };
}

async function removeBackground({ provider, assetId, path: filePath, model } = {}) {
  return editImage({
    provider,
    assetId,
    path: filePath,
    model,
    prompt:
      'Remove the background completely and keep only the main subject. Return the subject on a fully transparent background with clean edges.',
  });
}

async function upscaleImage({ assetId, path: filePath, factor, sharpen } = {}) {
  requireReady();
  const input = await readImageInput({ assetId, path: filePath });
  const meta = await sharp(input.buffer, { failOn: 'none' }).metadata();
  if (!meta.width || !meta.height) throw new Error('That image has no readable pixel dimensions.');
  const scale = clamp(factor || 2, 1, 8);
  const width = Math.min(Math.round(meta.width * scale), 16000);
  const height = Math.min(Math.round(meta.height * scale), 16000);
  let pipeline = sharp(input.buffer, { failOn: 'none' }).resize(width, height, { kernel: 'lanczos3', fit: 'fill' });
  if (sharpen) pipeline = pipeline.sharpen({ sigma: 1 });
  const hasAlpha = !!meta.hasAlpha;
  const ext = hasAlpha ? 'png' : meta.format === 'jpeg' ? 'jpg' : 'png';
  const buffer = ext === 'jpg' ? await pipeline.jpeg({ quality: 94 }).toBuffer() : await pipeline.png().toBuffer();
  const asset = await saveBuffer(buffer, {
    name: `${stemOf(input.name)}-${scale}x`,
    ext,
    kind: 'image',
    source: 'upscale',
    prompt: null,
    meta: { width, height, from: { width: meta.width, height: meta.height }, factor: scale, kernel: 'lanczos3', sharpen: !!sharpen },
  });
  return { asset, from: { width: meta.width, height: meta.height }, to: { width, height }, factor: scale };
}

/* --------------------------------------------------------------- understanding */

async function analyzeImages({ candidates, prompt, system, images, maxTokens, task = 'vision' } = {}) {
  requireReady();
  if (!ctx.gateway) throw new Error('The model gateway is not ready.');
  const list = Array.isArray(images) ? images.filter((img) => img && img.data) : [];
  if (!list.length) throw new Error('No image or frame was supplied.');
  if (list.length > 12) throw new Error('At most 12 images can be analysed at once.');
  const text = String(prompt || '').trim() || 'Describe this image in detail.';
  const result = await ctx.gateway.chat({
    candidates,
    task,
    system:
      String(system || '').trim() ||
      'You analyse visual input for a desktop assistant. Be concrete: describe what is visible, read any text, and answer the question directly.',
    history: [{ role: 'user', text, images: list }],
    maxTokens: clamp(maxTokens || 900, 64, 4096),
    temperature: 0.2,
  });
  return {
    text: String(result.text || '').trim(),
    provider: result.provider || null,
    model: result.model || null,
    usage: result.usage || null,
  };
}

/* ----------------------------------------------------------------- speech I/O */

function normalizeSegments(raw, text) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const seg of list) {
    const start = Number(seg.start ?? seg.startTime ?? 0);
    const end = Number(seg.end ?? seg.endTime ?? start);
    const body = String(seg.text ?? '').trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || !body) continue;
    out.push({ start: Math.max(0, start), end: Math.max(start, end), text: body });
  }
  if (out.length) return out;
  if (text) return [{ start: 0, end: 0, text: String(text).trim() }];
  return [];
}

function normalizeAsrUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) throw new Error('Set a transcription endpoint first (Settings → Voice, or this page).');
  const blocked = checkUrl(url);
  if (blocked) throw new Error(blocked);
  return url;
}

async function transcribe({ url, key, model, path: filePath, language, responseFormat } = {}) {
  requireReady();
  const target = normalizeAsrUrl(url);
  const source = safeReadPath(filePath);
  const st = await fsp.stat(source);
  if (!st.isFile()) throw new Error('Pick an audio or video file.');
  if (st.size > MAX_TRANSCRIBE) throw new Error('That file is over 500 MB — too large to transcribe here.');
  const buffer = await fsp.readFile(source);
  const headers = {};
  if (key) headers.authorization = `Bearer ${key}`;
  const send = async (format) => {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeOf(source, 'application/octet-stream') }), path.basename(source));
    form.append('model', String(model || 'whisper-1'));
    form.append('response_format', format);
    if (language) form.append('language', String(language));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NET_TIMEOUT_MS);
    try {
      const response = await fetch(target, { method: 'POST', headers, body: form, signal: controller.signal });
      return { res: response, text: await response.text().catch(() => '') };
    } catch (err) {
      if (controller.signal.aborted) throw new Error('The transcription request timed out.');
      throw new Error(`Could not reach the transcription endpoint — ${err && err.message ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  };
  let { res, text } = await send(responseFormat || 'verbose_json');
  // Servers that only implement plain JSON reject verbose_json with a 400.
  if (!res.ok && res.status === 400 && /response_format|verbose/i.test(text)) {
    ({ res, text } = await send('json'));
  }
  if (!res.ok) throw new Error(`Transcription failed — ${friendlyHttp(res.status, text)}`);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const transcript = json ? String(json.text || '').trim() : String(text || '').trim();
  if (!transcript) throw new Error('The endpoint returned an empty transcript.');
  return {
    text: transcript,
    segments: normalizeSegments(json && json.segments, transcript),
    language: (json && (json.language || (json.result && json.result.language))) || language || null,
    duration: json && Number.isFinite(json.duration) ? json.duration : null,
    endpoint: target,
    file: path.basename(source),
  };
}

function stamp(seconds, comma, padMs = true) {
  const total = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const msText = padMs ? String(ms).padStart(3, '0') : String(ms).padStart(3, '0').slice(0, 3);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}${comma ? ',' : '.'}${msText}`;
}

function wrapCue(text, maxChars) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) line = word;
    else if ((line + ' ' + word).length <= maxChars) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Turns timed segments into real subtitle cues. Long segments are split into
 * proportional pieces so every cue fits maxChars per line.
 */
function buildSubtitles({ segments, format = 'srt', maxChars = 42 } = {}) {
  const list = Array.isArray(segments) ? segments : [];
  if (!list.length) throw new Error('There are no timed segments to turn into subtitles.');
  const limit = clamp(maxChars || 42, 16, 120);
  const cues = [];
  let cursor = 0;
  for (const seg of list) {
    const start = Math.max(Number(seg.start) || 0, cursor);
    const end = Math.max(Number(seg.end) || start, start + 0.4);
    const words = String(seg.text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (!words.length) continue;
    const perCue = Math.max(3, Math.floor(limit / 6));
    const chunks = [];
    for (let i = 0; i < words.length; i += perCue) chunks.push(words.slice(i, i + perCue).join(' '));
    const totalChars = chunks.reduce((sum, c) => sum + c.length, 0) || 1;
    let t = start;
    for (const chunk of chunks) {
      const span = ((end - start) * chunk.length) / totalChars;
      const cueStart = t;
      const cueEnd = Math.min(end, t + Math.max(0.3, span));
      cues.push({ start: cueStart, end: cueEnd, text: wrapCue(chunk, limit).join('\n') });
      t = cueEnd;
    }
    cursor = end;
  }
  if (!cues.length) throw new Error('There is no text to write into subtitles.');
  if (String(format).toLowerCase() === 'vtt') {
    return {
      format: 'vtt',
      text: `WEBVTT\n\n${cues
        .map((c, i) => `${i + 1}\n${stamp(c.start, false)} --> ${stamp(c.end, false)}\n${c.text}`)
        .join('\n\n')}\n`,
      cues: cues.length,
    };
  }
  return {
    format: 'srt',
    text: `${cues.map((c, i) => `${i + 1}\n${stamp(c.start, true)} --> ${stamp(c.end, true)}\n${c.text}`).join('\n\n')}\n`,
    cues: cues.length,
  };
}

async function subtitleFile({ segments, format, maxChars, name } = {}) {
  const built = buildSubtitles({ segments, format, maxChars });
  const base = String(name || '').trim() || `subtitles-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  const asset = await saveBuffer(Buffer.from(built.text, 'utf8'), {
    name: stemOf(base) || base,
    ext: built.format,
    kind: 'subtitle',
    mime: built.format === 'vtt' ? 'text/vtt' : 'application/x-subrip',
    source: 'subtitles',
  });
  return { asset, text: built.text, format: built.format, cues: built.cues };
}

async function subtitlesFromAudio({ url, key, model, path: filePath, language, format, maxChars, name } = {}) {
  const result = await transcribe({ url, key, model, path: filePath, language, responseFormat: 'verbose_json' });
  if (!result.segments.length) throw new Error('The endpoint returned no timestamped segments.');
  const saved = await subtitleFile({
    segments: result.segments,
    format: format || 'srt',
    maxChars,
    name: name || `${stemOf(filePath)}-${format === 'vtt' ? 'vtt' : 'srt'}`,
  });
  return { ...saved, transcript: result.text, segments: result.segments, language: result.language };
}

function audioExtFrom(contentType, fallback = 'mp3') {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('wav')) return 'wav';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('webm')) return 'webm';
  if (type.includes('mp4') || type.includes('m4a')) return 'm4a';
  if (type.includes('flac')) return 'flac';
  if (type.includes('aac')) return 'aac';
  return fallback;
}

async function synthesize({ url, key, path: synthPath, body, ext, name } = {}) {
  requireReady();
  const target = normalizeAsrUrl(url);
  const payload = body && typeof body === 'object' ? body : {};
  if (!String(payload.input || '').trim()) throw new Error('Write the text to speak first.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NET_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) throw new Error('The speech request timed out.');
    throw new Error(`Could not reach the speech server — ${err && err.message ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  const type = res.headers.get('content-type') || '';
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`Speech server returned HTTP ${res.status} — ${buffer.toString('utf8').slice(0, 200)}`);
  if (!buffer.length) throw new Error('The speech server returned an empty audio body.');
  if (type.includes('json')) {
    throw new Error(`The speech server returned JSON, not audio — ${buffer.toString('utf8').slice(0, 200)}`);
  }
  const fileExt = (ext || audioExtFrom(type, 'mp3')).replace(/^\./, '');
  const asset = await saveBuffer(buffer, {
    name: String(name || payload.name || `speech-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`),
    ext: fileExt,
    kind: 'audio',
    mime: type || MIME[fileExt] || 'audio/mpeg',
    source: 'tts',
    prompt: String(payload.input || '').slice(0, MAX_PROMPT),
  });
  return { asset, bytes: buffer.length, contentType: type || null, synthPath: synthPath || null };
}

const HEYGEN_ORIGIN = 'https://api.heygen.com';
const HEYGEN_MODELS = new Set(['heygen-voice-1', 'heygen-voice-1-turbo', 'heygen-voice-1-turbo-free']);
const HEYGEN_PAGE_SIZE = 100;
const HEYGEN_MAX_PAGES = 60;
const HEYGEN_LIST_BUDGET_MS = 45000;

async function heygenVoices({ key, type = 'public' } = {}) {
  requireReady();
  const apiKey = String(key || '').trim();
  if (!apiKey) throw new Error('Add your HeyGen API key in Settings → Voice first.');
  const scope = type === 'private' ? 'private' : 'public';
  const started = Date.now();
  const byId = new Map();
  let token = '';
  let pages = 0;
  let complete = false;
  while (pages < HEYGEN_MAX_PAGES) {
    const query = `type=${scope}&limit=${HEYGEN_PAGE_SIZE}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
    const { json } = await requestJson(`${HEYGEN_ORIGIN}/v3/models/audio/voices?${query}`, {
      method: 'GET',
      headers: { 'x-api-key': apiKey, accept: 'application/json' },
      timeoutMs: 20000,
    });
    const raw = json && json.data !== undefined ? json.data : json;
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw && raw.voices) ? raw.voices : [];
    for (const v of rows) {
      const voiceId = String((v && (v.voice_id || v.id)) || '');
      if (!voiceId || byId.has(voiceId)) continue;
      byId.set(voiceId, {
        voiceId,
        name: String((v && (v.name || v.voice_name)) || voiceId),
        language: String((v && (v.language || v.locale)) || ''),
        gender: String((v && v.gender) || ''),
        preview: String((v && (v.preview_audio_url || v.preview_url)) || ''),
      });
    }
    pages += 1;
    const meta = json && (json.has_more !== undefined || json.next_token !== undefined) ? json : raw || {};
    const hasMore = !!(meta && meta.has_more);
    const next = String((meta && meta.next_token) || '');
    if (!hasMore || !next) {
      complete = true;
      break;
    }
    if (Date.now() - started > HEYGEN_LIST_BUDGET_MS) break;
    token = next;
  }
  const voices = [...byId.values()];
  if (!voices.length) throw new Error('HeyGen returned no voices for this key.');
  return { voices, type: scope, pages, complete };
}

async function heygenSpeak({ key, text, voiceId, model, language, speed, pitch, expressiveness, seed } = {}) {
  requireReady();
  const apiKey = String(key || '').trim();
  if (!apiKey) throw new Error('Add your HeyGen API key in Settings → Voice first.');
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('Write the text to speak first.');
  const voice = String(voiceId || '').trim();
  if (!voice) throw new Error('Pick a HeyGen voice first — Settings → Voice → Fetch voices.');
  const mdl = HEYGEN_MODELS.has(String(model || '')) ? String(model) : 'heygen-voice-1-turbo-free';
  const body = {
    model: mdl,
    voice_id: voice,
    text: clean.slice(0, 5000),
    language: String(language || 'en'),
  };
  const spd = Number(speed);
  if (Number.isFinite(spd) && spd > 0) body.speed = Math.min(2, Math.max(0.5, spd));
  const pitchShift = Number(pitch);
  if (Number.isFinite(pitchShift) && pitchShift !== 0) body.pitch_shift = Math.min(12, Math.max(-12, pitchShift));
  const boost = Number(expressiveness);
  if (Number.isFinite(boost) && boost !== 0) body.expressiveness_boost = Math.min(1.5, Math.max(0.5, boost));
  const s = Number(seed);
  if (Number.isFinite(s) && s > 0) body.seed = Math.floor(s);

  const { json, text: raw } = await requestJson(`${HEYGEN_ORIGIN}/v3/models/audio/tts`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body,
    timeoutMs: 120000,
  });
  const data = json && json.data !== undefined ? json.data : json;
  const audioUrl = String((data && (data.audio_url || data.audioUrl)) || (json && json.audio_url) || '');
  if (!audioUrl) throw new Error(`HeyGen returned no audio — ${String(raw || '').slice(0, 200) || 'empty response'}`);
  const blocked = checkUrl(audioUrl);
  if (blocked) throw new Error(blocked);
  const { buffer, contentType } = await downloadBytes(audioUrl);
  const ext = audioExtFrom(contentType, 'mp3');
  const asset = await saveBuffer(buffer, {
    name: `heygen-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`,
    ext,
    kind: 'audio',
    mime: contentType || MIME[ext] || 'audio/mpeg',
    source: 'tts',
    provider: 'heygen',
    model: mdl,
    prompt: clean,
  });
  return { asset, model: mdl, voiceId: voice, duration: data && Number.isFinite(data.duration) ? data.duration : null };
}

async function music({ url, key, body, ext, name } = {}) {
  requireReady();
  const target = String(url || '').trim();
  if (!target) throw new Error('Set a music/SFX endpoint URL first.');
  const blocked = checkUrl(target);
  if (blocked) throw new Error(blocked);
  const payload = body && typeof body === 'object' ? { ...body } : {};
  if (!String(payload.prompt || payload.text || '').trim()) throw new Error('Describe the music or sound effect first.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NET_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) throw new Error('The music request timed out.');
    throw new Error(`Could not reach the music endpoint — ${err && err.message ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  const type = res.headers.get('content-type') || '';
  const raw = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`Music endpoint returned HTTP ${res.status} — ${raw.toString('utf8').slice(0, 200)}`);
  let buffer = null;
  let mimeType = type;
  if (type.includes('json')) {
    let json = null;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      json = null;
    }
    const link = json
      ? json.audio_url || json.audioUrl || json.url || (Array.isArray(json.output) ? json.output[0] : '') || (Array.isArray(json.data) ? json.data[0] && json.data[0].url : '')
      : '';
    if (!link) throw new Error(`The music endpoint returned JSON without an audio URL — ${raw.toString('utf8').slice(0, 160)}`);
    if (String(link).startsWith('data:')) {
      const parsed = dataUrlToBuffer(link);
      if (!parsed) throw new Error('The music endpoint returned an unreadable data URL.');
      buffer = parsed.buffer;
      mimeType = parsed.mime;
    } else {
      const dl = await downloadBytes(String(link));
      buffer = dl.buffer;
      mimeType = dl.contentType || 'audio/mpeg';
    }
  } else {
    buffer = raw;
  }
  if (!buffer || !buffer.length) throw new Error('The music endpoint returned no audio.');
  const fileExt = (ext || audioExtFrom(mimeType, 'mp3')).replace(/^\./, '');
  const asset = await saveBuffer(buffer, {
    name: String(name || `music-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`),
    ext: fileExt,
    kind: 'audio',
    mime: mimeType || MIME[fileExt] || 'audio/mpeg',
    source: 'music',
    prompt: String(payload.prompt || payload.text || '').slice(0, MAX_PROMPT),
  });
  return { asset, bytes: buffer.length, contentType: mimeType || null };
}

/* --------------------------------------------------------------------- 3D files */

async function modelMeta(filePath, buffer) {  const ext = extOf(filePath);
  try {
    if (ext === 'gltf') {
      const json = JSON.parse(buffer.toString('utf8'));
      return gltfMeta(json, 'gltf');
    }
    if (ext === 'glb') {
      if (buffer.length < 20) throw new Error('truncated');
      const magic = buffer.readUInt32LE(0);
      if (magic !== 0x46546c67) throw new Error('not a GLB');
      const version = buffer.readUInt32LE(4);
      const length = buffer.readUInt32LE(8);
      const chunkLength = buffer.readUInt32LE(12);
      const chunkType = buffer.readUInt32LE(16);
      if (chunkType !== 0x4e4f534a) throw new Error('no JSON chunk');
      const json = JSON.parse(buffer.slice(20, 20 + chunkLength).toString('utf8').replace(/\0+$/, '').trim());
      return { ...gltfMeta(json, 'glb'), version, length };
    }
    if (ext === 'obj') {
      const text = buffer.toString('utf8');
      const count = (re) => (text.match(re) || []).length;
      return {
        format: 'obj',
        groups: count(/^o\s+/gm) + count(/^g\s+/gm),
        vertices: count(/^v\s+/gm),
        normals: count(/^vn\s+/gm),
        uvs: count(/^vt\s+/gm),
        faces: count(/^f\s+/gm),
        materials: count(/^usemtl\s+/gm),
      };
    }
    if (ext === 'stl') {
      const head = buffer.slice(0, 80).toString('utf8').trim().toLowerCase();
      if (head.startsWith('solid') && buffer.includes('facet')) {
        const text = buffer.toString('utf8');
        return { format: 'stl', encoding: 'ascii', triangles: (text.match(/facet normal/g) || []).length };
      }
      return { format: 'stl', encoding: 'binary', triangles: Math.max(0, Math.floor((buffer.length - 84) / 50)) };
    }
    if (ext === 'ply') {
      const head = buffer.slice(0, Math.min(buffer.length, 4096)).toString('utf8');
      const num = (key) => {
        const m = new RegExp(`element ${key}\\s+(\\d+)`).exec(head);
        return m ? Number(m[1]) : null;
      };
      return {
        format: 'ply',
        encoding: /format\s+ascii/.test(head) ? 'ascii' : 'binary',
        vertices: num('vertex'),
        faces: num('face'),
        edges: num('edge'),
      };
    }
    if (ext === 'fbx') {
      const head = buffer.slice(0, 64).toString('utf8');
      const version = /Kaydara FBX Binary/.test(head) ? buffer.readUInt32LE(23) : null;
      return { format: 'fbx', encoding: version ? 'binary' : 'ascii', version };
    }
    return { format: ext, bytes: buffer.length };
  } catch (err) {
    return { format: ext, error: `Could not parse ${ext} — ${err && err.message ? err.message : String(err)}` };
  }
}

function gltfMeta(json, format) {
  const accessorCount = (index) => {
    const accessor = json.accessors && json.accessors[index];
    return accessor && Number.isFinite(accessor.count) ? accessor.count : 0;
  };
  let vertices = 0;
  let primitives = 0;
  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives || []) {
      primitives += 1;
      if (prim.attributes && prim.attributes.POSITION !== undefined) vertices += accessorCount(prim.attributes.POSITION);
    }
  }
  return {
    format,
    generator: (json.asset && json.asset.generator) || null,
    version: (json.asset && json.asset.version) || null,
    scenes: (json.scenes || []).length,
    nodes: (json.nodes || []).length,
    meshes: (json.meshes || []).length,
    materials: (json.materials || []).length,
    textures: (json.textures || []).length,
    animations: (json.animations || []).length,
    skins: (json.skins || []).length,
    primitives,
    vertices,
  };
}

/* --------------------------------------------------------------- saved text */

async function saveText({ name, text, ext = 'txt' } = {}) {
  requireReady();
  const body = String(text ?? '');
  if (!body.trim()) throw new Error('There is no text to save.');
  const extension = String(ext || 'txt').replace(/^\./, '').toLowerCase();
  if (!['txt', 'md', 'json'].includes(extension)) throw new Error('Text assets must be .txt, .md or .json.');
  if (extension === 'json') {
    try {
      JSON.parse(body);
    } catch {
      throw new Error('That is not valid JSON.');
    }
  }
  return saveBuffer(Buffer.from(body, 'utf8'), {
    name: String(name || `note-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`),
    ext: extension,
    kind: 'file',
    mime: extension === 'json' ? 'application/json' : extension === 'md' ? 'text/markdown' : 'text/plain',
    source: 'written',
  });
}

async function saveSubtitleText({ name, text, format = 'srt' } = {}) {
  requireReady();
  const body = String(text ?? '').trim();
  if (!body) throw new Error('The subtitle text is empty.');
  if (!body.includes('-->')) throw new Error('Subtitle text needs at least one "start --> end" cue line.');
  const fmt = String(format).toLowerCase() === 'vtt' ? 'vtt' : 'srt';
  if (fmt === 'vtt' && !body.startsWith('WEBVTT')) throw new Error('A VTT file must start with WEBVTT.');
  return saveBuffer(Buffer.from(`${body}\n`, 'utf8'), {
    name: String(name || `subtitles-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`),
    ext: fmt,
    kind: 'subtitle',
    mime: fmt === 'vtt' ? 'text/vtt' : 'application/x-subrip',
    source: 'subtitles',
  });
}

async function saveImageData({ dataUrl, name } = {}) {
  requireReady();
  const parsed = dataUrlToBuffer(dataUrl);
  if (!parsed) throw new Error('That frame is not a base64 data URL.');
  if (!/^image\//.test(parsed.mime)) throw new Error('Only image data URLs can be saved here.');
  const ext = (parsed.mime.split('/')[1] || 'png').replace('jpeg', 'jpg').split('+')[0];
  return saveBuffer(parsed.buffer, {
    name: String(name || `frame-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`),
    ext: IMAGE_EXT.has(ext) ? ext : 'png',
    kind: 'image',
    mime: parsed.mime,
    source: 'frame',
  });
}

async function inspect3D({ path: filePath } = {}) {
  const source = safeReadPath(filePath);
  const st = await fsp.stat(source);
  if (!st.isFile()) throw new Error('Pick a 3D file, not a folder.');
  const ext = extOf(source);
  if (!MODEL_EXT.has(ext)) throw new Error(`Not a supported 3D format (${[...MODEL_EXT].join(', ')}).`);
  const buffer = await fsp.readFile(source);
  return { name: path.basename(source), path: source, ext, bytes: st.size, meta: await modelMeta(source, buffer) };
}

/* ------------------------------------------------------------ prompt library */

async function prompts({ query, kind, limit } = {}) {
  requireReady();
  const lib = await loadPrompts();
  const q = String(query || '').trim().toLowerCase();
  let rows = lib.prompts.slice().sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || b.createdAt - a.createdAt);
  if (kind && kind !== 'all') rows = rows.filter((p) => p.kind === kind);
  if (q) rows = rows.filter((p) => p.text.toLowerCase().includes(q) || p.title.toLowerCase().includes(q) || p.tags.some((t) => t.includes(q)));
  const total = rows.length;
  return { total, prompts: rows.slice(0, clamp(limit || 300, 1, 2000)) };
}

async function savePrompt({ id, title, text, kind, tags, favorite } = {}) {
  requireReady();
  const body = String(text || '').trim();
  if (!body) throw new Error('The prompt is empty.');
  if (body.length > MAX_PROMPT) throw new Error(`Prompts are capped at ${MAX_PROMPT} characters.`);
  return await mutatePrompts((lib) => {
    const existing = id ? lib.prompts.find((p) => p.id === id) : null;
    if (existing) {
      if (title !== undefined) existing.title = String(title).trim().slice(0, 120) || existing.title;
      existing.text = body;
      if (kind) existing.kind = String(kind);
      if (Array.isArray(tags)) existing.tags = tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 12);
      if (favorite !== undefined) existing.favorite = !!favorite;
      existing.updatedAt = now();
      return { ...existing };
    }
    const row = {
      id: newId('prm'),
      title: String(title || '').trim().slice(0, 120) || body.slice(0, 60),
      text: body,
      kind: String(kind || 'image'),
      tags: Array.isArray(tags) ? tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 12) : [],
      favorite: !!favorite,
      uses: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    lib.prompts.push(row);
    return { ...row };
  });
}

async function deletePrompt({ id } = {}) {
  if (!id) throw new Error('Prompt id is missing.');
  return await mutatePrompts((lib) => {
    const row = lib.prompts.find((p) => p.id === String(id));
    if (!row) throw new Error('That prompt no longer exists.');
    lib.prompts = lib.prompts.filter((p) => p.id !== String(id));
    return { deleted: row.id };
  });
}

async function usePrompt({ id } = {}) {
  return await mutatePrompts((lib) => {
    const row = lib.prompts.find((p) => p.id === String(id));
    if (!row) throw new Error('That prompt no longer exists.');
    row.uses = Number(row.uses || 0) + 1;
    row.lastUsedAt = now();
    return { ...row };
  });
}

/* ------------------------------------------------------------- source handles */

function registerSource({ path: filePath } = {}) {
  const resolved = safeReadPath(filePath);
  const st = fs.statSync(resolved);
  if (!st.isFile()) throw new Error('Pick a file, not a folder.');
  const token = crypto.randomBytes(16).toString('hex');
  sources.set(token, { path: resolved, createdAt: now() });
  for (const [key, value] of sources) {
    if (now() - value.createdAt > SOURCE_TTL_MS) sources.delete(key);
  }
  return {
    token,
    path: resolved,
    name: path.basename(resolved),
    mime: mimeOf(resolved),
    bytes: st.size,
    url: `orvex-media://source/${token}/${encodeURIComponent(path.basename(resolved))}`,
  };
}

function sourcePath(token) {
  const row = sources.get(String(token || ''));
  return row ? row.path : null;
}

/** Path lookup used by the orvex-media protocol handler. */
async function resolveUrl(requestUrl) {
  const url = new URL(requestUrl);
  if (url.hostname === 'asset') {
    const id = url.pathname.replace(/^\/+/, '');
    const row = await getAssetRow(id);
    return assetFile(row);
  }
  if (url.hostname === 'source') {
    const token = url.pathname.replace(/^\/+/, '').split('/')[0];
    const file = sourcePath(token);
    if (!file) throw new Error('This preview link expired — pick the file again.');
    return file;
  }
  throw new Error('Unknown media URL.');
}

async function close() {
  sources.clear();
  cachedLibrary = null;
  cachedPrompts = null;
  ready = false;
}

/** Privacy control: removes every asset file plus the index and prompt store. */
async function clearLibrary() {
  const files = filesDir();
  let removedFiles = 0;
  try {
    removedFiles = (await fsp.readdir(files)).length;
  } catch {
    removedFiles = 0;
  }
  await fsp.rm(files, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(files, { recursive: true }).catch(() => {});
  const lib = await loadLibrary();
  const promptLib = await loadPrompts();
  const counts = { assets: lib.assets.length, prompts: promptLib.prompts.length, files: removedFiles };
  await writeJson(indexPath(), { version: 1, assets: [] });
  await writeJson(promptsPath(), { version: 1, prompts: [] });
  cachedLibrary = { version: 1, assets: [] };
  cachedPrompts = { version: 1, prompts: [] };
  emit({ reason: 'library-cleared' });
  return counts;
}

module.exports = {
  init,
  info,
  library,
  getAsset,
  deleteAsset,
  renameAsset,
  exportAsset,
  exportTo,
  assetPath,
  imagePayload,
  importAsset,
  generateImage,
  editImage,
  removeBackground,
  upscaleImage,
  analyzeImages,
  transcribe,
  buildSubtitles,
  subtitleFile,
  subtitlesFromAudio,
  synthesize,
  heygenVoices,
  heygenSpeak,
  music,
  modelMeta,
  inspect3D,
  saveText,
  saveSubtitleText,
  saveImageData,
  prompts,
  savePrompt,
  deletePrompt,
  usePrompt,
  registerSource,
  resolveUrl,
  clearLibrary,
  close,
  _internals: { stamp, wrapCue, normalizeSegments, gltfMeta, imagesFromChatJson, imagesFromGemini, kindOfExt, safeReadPath, mimeOf },
};
