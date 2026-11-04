'use strict';

/**
 * Section 9 — real file system layer.
 * Every path goes through guardrails.checkPath (system folders, credentials and
 * private keys are refused). Writes create version snapshots, and backups live
 * under the app data folder so the Files page can restore them.
 */

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const archiver = require('archiver');
const unzipper = require('unzipper');
const { PDFDocument, StandardFonts, degrees, rgb } = require('pdf-lib');
const XLSX = require('xlsx');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  PageBreak,
} = require('docx');
const chokidar = require('chokidar');
const diffLib = require('diff');
const { checkPath } = require('./guardrails.cjs');

const MAX_TEXT = 2 * 1024 * 1024;
const MAX_PREVIEW_IMAGE = 8 * 1024 * 1024;
const MAX_HASH_BYTES = 512 * 1024 * 1024;
const MAX_WRITE_BYTES = 32 * 1024 * 1024;
const VERSION_KEEP = 20;
const BACKUP_KEEP = 200;
const WATCH_EVENT_KEEP = 200;

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'html', 'htm',
  'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'log', 'csv', 'tsv', 'sql', 'sh', 'bat', 'ps1', 'py', 'rb',
  'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'env', 'gitignore', 'editorconfig',
]);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg']);
const MIME = {
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', json: 'application/json',
  jsonl: 'application/jsonl', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
  ts: 'text/typescript', tsx: 'text/typescript', jsx: 'text/javascript', css: 'text/css', scss: 'text/css',
  html: 'text/html', htm: 'text/html', xml: 'application/xml', yml: 'text/yaml', yaml: 'text/yaml',
  toml: 'text/toml', ini: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values',
  sql: 'text/plain', log: 'text/plain', sh: 'text/x-sh', bat: 'text/plain', ps1: 'text/plain',
  py: 'text/x-python', rb: 'text/x-ruby', go: 'text/plain', rs: 'text/plain', java: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
  pdf: 'application/pdf', zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', mp4: 'video/mp4', mov: 'video/quicktime',
  webm: 'video/webm', exe: 'application/vnd.microsoft.portable-executable',
};

let ctx = { dataDir: null, roots: [], emit: null };
let ready = false;
let lastError = null;
let watchSeq = 0;
const watchers = new Map();
let indexQueue = Promise.resolve();

function now() {
  return Date.now();
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(Number(n) || 0, lo), hi);
}

function id(prefix) {
  return `${prefix}_${now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function extOf(p) {
  return path.extname(String(p || '')).replace(/^\./, '').toLowerCase();
}

function mimeOf(p) {
  return MIME[extOf(p)] || 'application/octet-stream';
}

function stemOf(p) {
  return path.basename(String(p || ''), path.extname(String(p || '')));
}

function safePath(raw, label = 'path') {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error(`${label} is empty.`);
  let resolved;
  try {
    resolved = path.resolve(text.replace(/^["']|["']$/g, ''));
  } catch {
    throw new Error(`${label} could not be resolved.`);
  }
  const blocked = checkPath(resolved, 'read');
  if (blocked) throw new Error(blocked);
  return resolved;
}

function ensureParent(p) {
  return fsp.mkdir(path.dirname(p), { recursive: true });
}

function humanPath(p) {
  return path.normalize(p);
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/* ------------------------------- storage -------------------------------- */

function versionsDir() {
  return path.join(ctx.dataDir, 'file-versions');
}

function backupsDir() {
  return path.join(ctx.dataDir, 'file-backups');
}

function versionsIndexPath() {
  return path.join(versionsDir(), 'index.json');
}

function backupsIndexPath() {
  return path.join(backupsDir(), 'index.json');
}

async function readIndex(file) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeIndex(file, rows) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(rows, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

function mutateIndex(file, mutator) {
  const run = async () => {
    const rows = await readIndex(file);
    const result = await mutator(rows);
    await writeIndex(file, rows);
    return result;
  };
  const next = indexQueue.then(run, run);
  indexQueue = next.catch(() => {});
  return next;
}

async function init(opts = {}) {
  ctx = {
    dataDir: opts.dataDir || ctx.dataDir || process.cwd(),
    roots: Array.isArray(opts.roots) ? opts.roots.filter((r) => r && r.path) : ctx.roots,
    emit: typeof opts.emit === 'function' ? opts.emit : ctx.emit,
  };
  lastError = null;
  ready = true;
  try {
    await fsp.mkdir(versionsDir(), { recursive: true });
    await fsp.mkdir(backupsDir(), { recursive: true });
    await Promise.all([readIndex(versionsIndexPath()), readIndex(backupsIndexPath())]);
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
    versionsDir: ctx.dataDir ? versionsDir() : null,
    backupsDir: ctx.dataDir ? backupsDir() : null,
    watching: [...watchers.values()].map((w) => ({ id: w.id, path: w.path, events: w.events.length, startedAt: w.startedAt })),
  };
}

function requireReady() {
  if (!ready || !ctx.dataDir) throw new Error(`Files is not ready${lastError ? ` — ${lastError}` : ''}.`);
}

async function roots() {
  const list = [];
  const seen = new Set();
  for (const root of ctx.roots) {
    try {
      const st = await fsp.stat(root.path);
      if (!st.isDirectory()) continue;
      const lower = path.resolve(root.path).toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      list.push({ label: String(root.label || path.basename(root.path)), path: path.resolve(root.path) });
    } catch {
      /* folder was removed */
    }
  }
  if (!list.length) list.push({ label: 'Home', path: os.homedir() });
  return list;
}

/* --------------------------------- meta --------------------------------- */

async function hashFile(filePath) {
  const st = await fsp.stat(filePath);
  if (st.size > MAX_HASH_BYTES) {
    const sum = crypto.createHash('sha256');
    const handle = await fsp.open(filePath, 'r');
    try {
      const head = Buffer.alloc(1024 * 1024);
      const tail = Buffer.alloc(1024 * 1024);
      await handle.read(head, 0, head.length, 0);
      await handle.read(tail, 0, tail.length, Math.max(0, st.size - tail.length));
      sum.update(head);
      sum.update(tail);
    } finally {
      await handle.close();
    }
    return { sha256: sum.digest('hex'), partial: true };
  }
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { sha256: hash.digest('hex'), partial: false };
}

async function previewFor(filePath, st) {
  const ext = extOf(filePath);
  if (st.size <= MAX_PREVIEW_IMAGE && IMAGE_EXT.has(ext)) {
    const buf = await fsp.readFile(filePath);
    return { kind: 'image', dataUrl: `data:${mimeOf(filePath)};base64,${buf.toString('base64')}` };
  }
  if (ext === 'pdf') return { kind: 'pdf' };
  if (TEXT_EXT.has(ext) && st.size <= 512 * 1024) {
    const text = await fsp.readFile(filePath, 'utf8');
    return { kind: 'text', text: text.length > 20000 ? `${text.slice(0, 20000)}\n… (truncated)` : text, truncated: text.length > 20000 };
  }
  if (st.size <= 512 * 1024) {
    const buf = await fsp.readFile(filePath);
    if (!buf.includes(0)) {
      const text = buf.toString('utf8');
      return { kind: 'text', text: text.length > 20000 ? `${text.slice(0, 20000)}\n… (truncated)` : text, truncated: text.length > 20000 };
    }
  }
  return { kind: 'binary' };
}

async function stat(payload = {}) {
  requireReady();
  const filePath = safePath(payload.path);
  const st = await fsp.lstat(filePath);
  const meta = {
    path: humanPath(filePath),
    name: path.basename(filePath),
    parent: path.dirname(filePath) === filePath ? null : path.dirname(filePath),
    isDir: st.isDirectory(),
    isFile: st.isFile(),
    isSymlink: st.isSymbolicLink(),
    size: st.size,
    createdAt: st.birthtimeMs || st.ctimeMs || 0,
    modifiedAt: st.mtimeMs || 0,
    accessedAt: st.atimeMs || 0,
    ext: st.isFile() ? extOf(filePath) : '',
    mime: st.isFile() ? mimeOf(filePath) : 'inode/directory',
    mode: `0${(st.mode & 0o777).toString(8)}`,
    hidden: path.basename(filePath).startsWith('.'),
    sha256: null,
    hashPartial: false,
    preview: null,
  };
  if (st.isFile()) {
    try {
      const hashed = await hashFile(filePath);
      meta.sha256 = hashed.sha256;
      meta.hashPartial = hashed.partial;
    } catch {
      /* locked file */
    }
    try {
      meta.preview = await previewFor(filePath, st);
    } catch {
      meta.preview = null;
    }
  }
  return meta;
}

/* -------------------------------- browsing ------------------------------- */

async function list(payload = {}) {
  requireReady();
  const dir = safePath(payload.path, 'Folder');
  const st = await fsp.stat(dir);
  if (!st.isDirectory()) throw new Error('That path is a file, not a folder.');
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const entries = [];
  for (const dirent of dirents) {
    const full = path.join(dir, dirent.name);
    let s;
    try {
      s = await fsp.stat(full);
    } catch {
      continue;
    }
    entries.push({
      name: dirent.name,
      path: humanPath(full),
      isDir: s.isDirectory(),
      size: s.size,
      modifiedAt: s.mtimeMs || 0,
      ext: s.isFile() ? extOf(full) : '',
      hidden: dirent.name.startsWith('.'),
    });
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.isDir ? -1 : 1));
  return {
    path: humanPath(dir),
    name: path.basename(dir) || dir,
    parent: path.dirname(dir) === dir ? null : humanPath(path.dirname(dir)),
    entries,
    dirs: entries.filter((e) => e.isDir).length,
    files: entries.filter((e) => !e.isDir).length,
    totalBytes: entries.reduce((sum, e) => sum + (e.isDir ? 0 : e.size), 0),
  };
}

function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

async function search(payload = {}) {
  requireReady();
  const root = safePath(payload.path, 'Folder');
  const rawQuery = String(payload.query || '').trim();
  if (!rawQuery) throw new Error('Type something to search for.');
  const limit = clamp(payload.limit ?? 200, 1, 1000);
  const glob = rawQuery.includes('*') || rawQuery.includes('?') ? globToRegExp(rawQuery) : null;
  const needle = rawQuery.toLowerCase();
  const results = [];
  let scanned = 0;

  async function walk(dir, depth) {
    if (depth > 8 || results.length >= limit) return;
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (results.length >= limit) return;
      scanned += 1;
      const full = path.join(dir, dirent.name);
      const hit = glob ? glob.test(dirent.name) : dirent.name.toLowerCase().includes(needle);
      if (hit) {
        let s = null;
        try {
          s = await fsp.stat(full);
        } catch {
          continue;
        }
        results.push({
          name: dirent.name,
          path: humanPath(full),
          dir: humanPath(dir),
          isDir: s.isDirectory(),
          size: s.size,
          modifiedAt: s.mtimeMs || 0,
          ext: s.isFile() ? extOf(full) : '',
          hidden: dirent.name.startsWith('.'),
        });
      }
      if (dirent.isDirectory()) await walk(full, depth + 1);
    }
  }

  await walk(root, 0);
  return { root: humanPath(root), query: rawQuery, scanned, results, truncated: results.length >= limit };
}

async function read(payload = {}) {
  requireReady();
  const filePath = safePath(payload.path);
  const st = await fsp.stat(filePath);
  if (!st.isFile()) throw new Error('That path is a folder.');
  const limit = clamp(payload.maxBytes ?? MAX_TEXT, 1, MAX_TEXT);
  const handle = await fsp.open(filePath, 'r');
  let buf;
  try {
    const length = Math.min(st.size, limit);
    buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, 0);
  } finally {
    await handle.close();
  }
  return { path: humanPath(filePath), text: buf.toString('utf8'), bytes: st.size, truncated: st.size > limit };
}

/* --------------------------------- writes -------------------------------- */

async function pushVersion(filePath, reason) {
  const st = await fsp.stat(filePath);
  if (!st.isFile()) return null;
  const digest = await hashFile(filePath).then((h) => h.sha256);
  const record = {
    id: id('ver'),
    path: humanPath(filePath),
    name: path.basename(filePath),
    bytes: st.size,
    sha256: digest,
    createdAt: now(),
    reason: String(reason || 'snapshot'),
    stored: `${now()}-${crypto.randomBytes(4).toString('hex')}-${path.basename(filePath).replace(/[^\w.-]+/g, '_').slice(0, 80)}`,
  };
  const storeDir = path.join(versionsDir(), 'store');
  await fsp.mkdir(storeDir, { recursive: true });
  await fsp.copyFile(filePath, path.join(storeDir, record.stored));
  await mutateIndex(versionsIndexPath(), (rows) => {
    rows.push(record);
    const mine = rows.filter((r) => r.path.toLowerCase() === record.path.toLowerCase()).sort((a, b) => b.createdAt - a.createdAt);
    const drop = new Set(mine.slice(VERSION_KEEP).map((r) => r.id));
    if (drop.size) {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (drop.has(rows[i].id)) {
          try {
            fs.rmSync(path.join(storeDir, rows[i].stored), { force: true });
          } catch {
            /* best effort */
          }
          rows.splice(i, 1);
        }
      }
    }
  });
  return record;
}

async function write(payload = {}) {
  requireReady();
  const filePath = safePath(payload.path, 'File');
  if (typeof payload.content !== 'string') throw new Error('Content must be text.');
  if (Buffer.byteLength(payload.content, 'utf8') > MAX_WRITE_BYTES) {
    throw new Error(`That document is larger than the ${Math.round(MAX_WRITE_BYTES / (1024 * 1024))} MB editor limit.`);
  }
  let existed = false;
  try {
    const st = await fsp.stat(filePath);
    if (st.isDirectory()) throw new Error('That path is a folder.');
    existed = true;
  } catch (err) {
    if (err && err.message === 'That path is a folder.') throw err;
  }
  if (existed) await pushVersion(filePath, 'before-write');
  await ensureParent(filePath);
  await fsp.writeFile(filePath, payload.content, 'utf8');
  return stat({ path: filePath });
}

async function mkdir(payload = {}) {
  requireReady();
  const dir = safePath(payload.path, 'Folder');
  await fsp.mkdir(dir, { recursive: Boolean(payload.recursive) });
  return stat({ path: dir });
}

async function rename(payload = {}) {
  requireReady();
  const from = safePath(payload.from, 'Source');
  const to = safePath(payload.to, 'Destination');
  if (from === to) throw new Error('Source and destination are the same.');
  const st = await fsp.stat(from);
  if (st.isFile()) await pushVersion(from, 'before-rename');
  await ensureParent(to);
  await fsp.rename(from, to);
  return stat({ path: to });
}

async function copy(payload = {}) {
  requireReady();
  const from = safePath(payload.from, 'Source');
  const to = safePath(payload.to, 'Destination');
  if (from === to) throw new Error('Source and destination are the same.');
  const st = await fsp.stat(from);
  if (st.isDirectory()) throw new Error('Copying folders is not supported yet — use the archive tool.');
  await ensureParent(to);
  try {
    if (!payload.overwrite) await fsp.access(to);
    if (!payload.overwrite) throw new Error('The destination already exists.');
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
  await fsp.copyFile(from, to);
  return stat({ path: to });
}

async function remove(payload = {}) {
  requireReady();
  const target = safePath(payload.path);
  const st = await fsp.lstat(target);
  if (st.isDirectory()) {
    const entries = await fsp.readdir(target);
    if (entries.length && !payload.recursive) throw new Error('That folder is not empty. Confirm a recursive delete first.');
    await fsp.rm(target, { recursive: Boolean(payload.recursive), force: false });
    return { removed: true, path: humanPath(target), isDir: true };
  }
  await pushVersion(target, 'before-delete');
  await fsp.unlink(target);
  return { removed: true, path: humanPath(target), isDir: false };
}

/* ------------------------------- duplicates ------------------------------ */

async function duplicates(payload = {}) {
  requireReady();
  const root = safePath(payload.path, 'Folder');
  const minSize = Math.max(0, Number(payload.minSize ?? 1) || 0);
  const maxFiles = clamp(payload.maxFiles ?? 5000, 10, 20000);
  const started = Date.now();
  const bySize = new Map();
  let scanned = 0;

  async function walk(dir, depth) {
    if (depth > 10 || scanned >= maxFiles) return;
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (scanned >= maxFiles) return;
      const full = path.join(dir, dirent.name);
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      let s;
      try {
        s = await fsp.stat(full);
      } catch {
        continue;
      }
      if (!s.isFile() || s.size < minSize) continue;
      scanned += 1;
      const bucket = bySize.get(s.size);
      const entry = { path: humanPath(full), name: dirent.name, size: s.size, modifiedAt: s.mtimeMs || 0 };
      if (bucket) bucket.push(entry);
      else bySize.set(s.size, [entry]);
    }
  }

  await walk(root, 0);
  const groups = [];
  let wasted = 0;
  let duplicateFiles = 0;
  for (const [size, entries] of bySize) {
    if (entries.length < 2) continue;
    const byHash = new Map();
    for (const entry of entries) {
      let sha;
      try {
        sha = (await hashFile(entry.path)).sha256;
      } catch {
        continue;
      }
      const list = byHash.get(sha);
      if (list) list.push(entry);
      else byHash.set(sha, [entry]);
    }
    for (const [sha, same] of byHash) {
      if (same.length < 2) continue;
      duplicateFiles += same.length - 1;
      wasted += size * (same.length - 1);
      groups.push({ sha256: sha, size, files: same, wasted: size * (same.length - 1) });
    }
  }
  groups.sort((a, b) => b.wasted - a.wasted);
  return {
    root: humanPath(root),
    scanned,
    groups,
    duplicateFiles,
    wasted,
    tookMs: Date.now() - started,
    truncated: scanned >= maxFiles,
  };
}

/* -------------------------------- archive -------------------------------- */

function archiveName(base, used) {
  let name = base;
  let i = 2;
  while (used.has(name.toLowerCase())) {
    const ext = path.extname(base);
    name = `${path.basename(base, ext)} (${i++})${ext}`;
  }
  used.add(name.toLowerCase());
  return name;
}

async function zip(payload = {}) {
  requireReady();
  const dest = safePath(payload.dest, 'Zip file');
  if (extOf(dest) !== 'zip') throw new Error('Pick a .zip destination.');
  const sources = (Array.isArray(payload.sources) ? payload.sources : []).map((s) => safePath(s, 'Source'));
  if (!sources.length) throw new Error('Pick at least one file or folder to zip.');
  for (const source of sources) await fsp.stat(source);
  await ensureParent(dest);
  const used = new Set();
  const output = fs.createWriteStream(dest);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const done = new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('warning', (err) => {
      if (err && err.code !== 'ENOENT') reject(err);
    });
    archive.on('error', reject);
  });
  archive.pipe(output);
  let entries = 0;
  for (const source of sources) {
    const st = await fsp.stat(source);
    if (st.isDirectory()) {
      archive.directory(source, archiveName(path.basename(source), used));
      const count = await countFiles(source);
      entries += count;
    } else {
      archive.file(source, { name: archiveName(path.basename(source), used) });
      entries += 1;
    }
  }
  await archive.finalize();
  await done;
  const st = await fsp.stat(dest);
  return { path: humanPath(dest), bytes: st.size, entries, sources: sources.map(humanPath) };
}

async function countFiles(dir) {
  let count = 0;
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const dirent of dirents) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) count += await countFiles(full);
    else count += 1;
  }
  return count;
}

async function unzip(payload = {}) {
  requireReady();
  const zipPath = safePath(payload.zipPath, 'Zip file');
  const destDir = safePath(payload.destDir, 'Destination folder');
  const directory = await unzipper.Open.file(zipPath);
  await fsp.mkdir(destDir, { recursive: true });
  const root = path.resolve(destDir);
  let extracted = 0;
  for (const entry of directory.files) {
    const rel = entry.path.replace(/\\/g, '/');
    if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) continue;
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) continue;
    if (entry.type === 'Directory') {
      await fsp.mkdir(target, { recursive: true });
      continue;
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await new Promise((resolve, reject) => {
      const stream = entry.stream();
      const out = fs.createWriteStream(target);
      stream.on('error', reject);
      out.on('error', reject);
      out.on('close', resolve);
      stream.pipe(out);
    });
    extracted += 1;
  }
  return { path: humanPath(destDir), extracted };
}

async function zipList(payload = {}) {
  requireReady();
  const zipPath = safePath(payload.zipPath, 'Zip file');
  const directory = await unzipper.Open.file(zipPath);
  return {
    path: humanPath(zipPath),
    entries: directory.files.map((e) => ({
      path: e.path,
      size: e.uncompressedSize || 0,
      isDir: e.type === 'Directory',
    })),
  };
}

/* ---------------------------------- PDF ---------------------------------- */

async function loadPdf(filePath) {
  try {
    const bytes = await fsp.readFile(filePath);
    return await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch (err) {
    throw new Error(`Could not read that PDF (${err && err.message ? err.message : err}).`);
  }
}

async function pdfInfo(payload = {}) {
  requireReady();
  const filePath = safePath(payload.path);
  const doc = await loadPdf(filePath);
  const st = await fsp.stat(filePath);
  return {
    path: humanPath(filePath),
    pages: doc.getPageCount(),
    title: doc.getTitle() || '',
    author: doc.getAuthor() || '',
    subject: doc.getSubject() || '',
    creator: doc.getCreator() || '',
    producer: doc.getProducer() || '',
    createdAt: doc.getCreationDate() ? doc.getCreationDate().toISOString() : null,
    modifiedAt: doc.getModificationDate() ? doc.getModificationDate().toISOString() : null,
    bytes: st.size,
  };
}

async function pdfMerge(payload = {}) {
  requireReady();
  const paths = (Array.isArray(payload.paths) ? payload.paths : []).map((p) => safePath(p, 'PDF'));
  if (paths.length < 2) throw new Error('Pick at least two PDFs to merge.');
  const dest = safePath(payload.dest, 'Destination');
  const out = await PDFDocument.create();
  for (const filePath of paths) {
    const doc = await loadPdf(filePath);
    const pages = await out.copyPages(doc, doc.getPageIndices());
    for (const page of pages) out.addPage(page);
  }
  await ensureParent(dest);
  await fsp.writeFile(dest, await out.save());
  return pdfInfo({ path: dest });
}

function parseRanges(spec, total) {
  const groups = [];
  for (const part of String(spec || '').split(',')) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part.trim());
    if (!match) continue;
    const a = clamp(Number(match[1]), 1, total);
    const b = clamp(Number(match[2] || match[1]), 1, total);
    if (a <= b) groups.push([a, b]);
  }
  if (!groups.length) for (let i = 1; i <= total; i += 1) groups.push([i, i]);
  return groups;
}

async function pdfSplit(payload = {}) {
  requireReady();
  const filePath = safePath(payload.path);
  const destDir = safePath(payload.destDir, 'Destination folder');
  const source = await loadPdf(filePath);
  const total = source.getPageCount();
  const groups = parseRanges(payload.ranges, total);
  await fsp.mkdir(destDir, { recursive: true });
  const base = stemOf(filePath);
  const created = [];
  for (const [a, b] of groups) {
    const out = await PDFDocument.create();
    const indices = [];
    for (let i = a; i <= b; i += 1) indices.push(i - 1);
    const pages = await out.copyPages(source, indices);
    for (const page of pages) out.addPage(page);
    const name = `${base}-p${a}${b > a ? `-${b}` : ''}.pdf`;
    const dest = path.join(destDir, name);
    await fsp.writeFile(dest, await out.save());
    created.push(humanPath(dest));
  }
  return { created, pages: total, destDir: humanPath(destDir) };
}

async function pdfRotate(payload = {}) {
  requireReady();
  const filePath = safePath(payload.path);
  const dest = safePath(payload.dest || payload.path, 'Destination');
  const delta = Number(payload.degrees ?? 90) % 360;
  const doc = await loadPdf(filePath);
  const total = doc.getPageCount();
  const pages = parseRanges(payload.pages || '', total);
  for (const [a, b] of pages) {
    for (let i = a; i <= b; i += 1) {
      const page = doc.getPage(i - 1);
      page.setRotation(degrees((page.getRotation().angle + delta + 360) % 360));
    }
  }
  if (path.resolve(dest) === path.resolve(filePath)) await pushVersion(filePath, 'before-rotate');
  await ensureParent(dest);
  await fsp.writeFile(dest, await doc.save());
  return pdfInfo({ path: dest });
}

async function pdfMeta(payload = {}) {
  requireReady();
  const filePath = safePath(payload.path);
  const dest = safePath(payload.dest || payload.path, 'Destination');
  const meta = payload.meta || {};
  const doc = await loadPdf(filePath);
  if (typeof meta.title === 'string') doc.setTitle(meta.title);
  if (typeof meta.author === 'string') doc.setAuthor(meta.author);
  if (typeof meta.subject === 'string') doc.setSubject(meta.subject);
  if (typeof meta.keywords === 'string') doc.setKeywords(meta.keywords.split(',').map((s) => s.trim()).filter(Boolean));
  if (typeof meta.creator === 'string') doc.setCreator(meta.creator);
  if (path.resolve(dest) === path.resolve(filePath)) await pushVersion(filePath, 'before-metadata-edit');
  await ensureParent(dest);
  await fsp.writeFile(dest, await doc.save());
  return pdfInfo({ path: dest });
}

function winAnsi(text) {
  return String(text ?? '').replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u00FF]/g, '?');
}

function wrapLine(text, width) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (!line) line = word;
    else if (`${line} ${word}`.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

async function pdfCreate(payload = {}) {
  requireReady();
  const dest = safePath(payload.dest, 'Destination');
  const title = winAnsi(String(payload.title || stemOf(dest)));
  const body = String(payload.text || '');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(title);
  doc.setProducer('ORVEX');
  const width = 595.28;
  const height = 841.89;
  const margin = 56;
  const maxWidth = width - margin * 2;
  let page = doc.addPage([width, height]);
  let y = height - margin;
  const draw = (text, size, useBold, color) => {
    page.drawText(text, { x: margin, y, size, font: useBold ? bold : font, color });
    y -= size + 6;
  };
  draw(title, 22, true, rgb(0.08, 0.09, 0.12));
  y -= 8;
  for (const raw of body.split(/\r?\n/)) {
    const line = winAnsi(raw.replace(/^#{1,3}\s*/, '').replace(/^[-*]\s+/, '• '));
    const chunks = wrapLine(line || ' ', 92);
    for (const chunk of chunks) {
      if (y < margin) {
        page = doc.addPage([width, height]);
        y = height - margin;
      }
      draw(chunk, raw.startsWith('#') ? 14 : 11, raw.startsWith('#'), rgb(0.1, 0.11, 0.14));
    }
  }
  await ensureParent(dest);
  await fsp.writeFile(dest, await doc.save());
  return pdfInfo({ path: dest });
}

/* --------------------------------- XLSX ---------------------------------- */

async function xlsxInfo(payload = {}) {
  requireReady();
  const filePath = safePath(payload.path);
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const st = await fsp.stat(filePath);
  return {
    path: humanPath(filePath),
    bytes: st.size,
    sheets: wb.SheetNames.map((name) => {
      const ws = wb.Sheets[name];
      return { name, ref: (ws && ws['!ref']) || 'A1:A1' };
    }),
  };
}

async function xlsxRead(payload = {}) {
  requireReady();
  const filePath = safePath(payload.path);
  const wb = XLSX.readFile(filePath, { cellDates: true });
  if (!wb.SheetNames.length) throw new Error('That workbook has no sheets.');
  const sheet = payload.sheet && wb.SheetNames.includes(payload.sheet) ? payload.sheet : wb.SheetNames[0];
  const ws = wb.Sheets[sheet];
  const all = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  const limit = clamp(payload.limit ?? 200, 1, 2000);
  const rows = all.slice(0, limit).map((row) => row.map((cell) => String(cell ?? '')));
  return {
    path: humanPath(filePath),
    sheet,
    sheets: wb.SheetNames,
    header: rows[0] || [],
    rows: rows.slice(1),
    totalRows: Math.max(0, all.length - 1),
    truncated: all.length > limit,
  };
}

async function xlsxToCsv(payload = {}) {
  requireReady();
  const filePath = safePath(payload.path);
  const dest = safePath(payload.dest, 'Destination');
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const sheet = payload.sheet && wb.SheetNames.includes(payload.sheet) ? payload.sheet : wb.SheetNames[0];
  const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheet]);
  await ensureParent(dest);
  await fsp.writeFile(dest, csv, 'utf8');
  const st = await fsp.stat(dest);
  return { path: humanPath(dest), bytes: st.size, sheet };
}

async function xlsxWrite(payload = {}) {
  requireReady();
  const dest = safePath(payload.dest, 'Destination');
  const sheets = Array.isArray(payload.sheets) ? payload.sheets : [];
  if (!sheets.length) throw new Error('Add at least one sheet.');
  const book = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const name = String(sheet.name || `Sheet${book.SheetNames.length + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet${book.SheetNames.length + 1}`;
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(book, ws, name);
  }
  await ensureParent(dest);
  XLSX.writeFile(book, dest);
  return xlsxInfo({ path: dest });
}

/* --------------------------------- DOCX ---------------------------------- */

function tableFromRows(rows) {
  const columns = Math.max(...rows.map((r) => r.length));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      (cells) =>
        new TableRow({
          children: Array.from({ length: columns }, (_, i) => new TableCell({ children: [new Paragraph(String(cells[i] ?? ''))] })),
        }),
    ),
  });
}

function markdownToBlocks(markdown) {
  const children = [];
  const lines = String(markdown ?? '').split(/\r?\n/);
  let table = [];
  const flush = () => {
    if (table.length) {
      children.push(tableFromRows(table));
      children.push(new Paragraph(''));
      table = [];
    }
  };
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      table.push(cells);
      continue;
    }
    flush();
    if (!line.trim()) {
      children.push(new Paragraph(''));
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length === 1 ? HeadingLevel.HEADING_1 : heading[1].length === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      children.push(new Paragraph({ text: heading[2], heading: level }));
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      children.push(new Paragraph({ text: line.replace(/^[-*]\s+/, ''), bullet: { level: 0 } }));
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      children.push(new Paragraph({ text: line.replace(/^\d+\.\s+/, ''), bullet: { level: 0 } }));
      continue;
    }
    if (/^>\s?/.test(line)) {
      children.push(new Paragraph({ children: [new TextRun({ text: line.replace(/^>\s?/, ''), italics: true })] }));
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
      continue;
    }
    children.push(new Paragraph({ text: line }));
  }
  flush();
  return children;
}

async function docxMake(payload = {}) {
  requireReady();
  const dest = safePath(payload.dest, 'Destination');
  if (extOf(dest) !== 'docx') throw new Error('Pick a .docx destination.');
  const markdown = String(payload.markdown ?? '');
  if (!markdown.trim()) throw new Error('Write some content for the document.');
  const children = markdownToBlocks(markdown);
  const doc = new Document({
    creator: 'ORVEX',
    title: String(payload.title || stemOf(dest)),
    sections: [{ children }],
  });
  const buffer = await Packer.toBuffer(doc);
  await ensureParent(dest);
  await fsp.writeFile(dest, buffer);
  return { path: humanPath(dest), bytes: buffer.length, paragraphs: children.length };
}

/* ---------------------------------- diff --------------------------------- */

function readForDiff(filePath) {
  return fsp.readFile(filePath, 'utf8');
}

async function diff(payload = {}) {
  requireReady();
  const a = safePath(payload.a, 'First file');
  const b = safePath(payload.b, 'Second file');
  const [left, right] = await Promise.all([readForDiff(a), readForDiff(b)]);
  const parts = diffLib.diffLines(left, right);
  const lines = [];
  let added = 0;
  let removed = 0;
  let same = 0;
  for (const part of parts) {
    const type = part.added ? 'add' : part.removed ? 'remove' : 'same';
    const chunk = part.value.endsWith('\n') ? part.value.slice(0, -1) : part.value;
    for (const text of chunk.split('\n')) {
      lines.push({ type, text });
      if (type === 'add') added += 1;
      else if (type === 'remove') removed += 1;
      else same += 1;
    }
  }
  const unified = lines.map((l) => `${l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' '}${l.text}`).join('\n');
  return { a: humanPath(a), b: humanPath(b), lines: lines.slice(0, 4000), added, removed, same, truncated: lines.length > 4000, unified };
}

/* -------------------------------- backups -------------------------------- */

async function backup(payload = {}) {
  requireReady();
  const filePath = safePath(payload.path);
  const st = await fsp.stat(filePath);
  if (!st.isFile()) throw new Error('Only files can be backed up.');
  const sha = (await hashFile(filePath)).sha256;
  const record = {
    id: id('bak'),
    source: humanPath(filePath),
    name: path.basename(filePath),
    bytes: st.size,
    sha256: sha,
    createdAt: now(),
    stored: `${stamp()}-${crypto.randomBytes(3).toString('hex')}-${path.basename(filePath).replace(/[^\w.-]+/g, '_').slice(0, 80)}`,
  };
  const storeDir = path.join(backupsDir(), 'store');
  await fsp.mkdir(storeDir, { recursive: true });
  await fsp.copyFile(filePath, path.join(storeDir, record.stored));
  await mutateIndex(backupsIndexPath(), (rows) => {
    rows.push(record);
    const drop = rows.slice(0, Math.max(0, rows.length - BACKUP_KEEP));
    for (const old of drop) {
      try {
        fs.rmSync(path.join(storeDir, old.stored), { force: true });
      } catch {
        /* best effort */
      }
    }
    if (drop.length) rows.splice(0, drop.length);
  });
  return record;
}

async function backups(payload = {}) {
  requireReady();
  const rows = await readIndex(backupsIndexPath());
  const filter = payload.path ? humanPath(safePath(payload.path)) .toLowerCase() : null;
  return rows
    .filter((r) => !filter || String(r.source || '').toLowerCase() === filter)
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function restoreBackup(payload = {}) {
  requireReady();
  const rows = await readIndex(backupsIndexPath());
  const record = rows.find((r) => r.id === payload.id);
  if (!record) throw new Error('That backup no longer exists.');
  const stored = path.join(backupsDir(), 'store', record.stored);
  try {
    await fsp.access(stored);
  } catch {
    throw new Error('The backup file is missing on disk.');
  }
  const target = safePath(record.source, 'Restore path');
  try {
    await pushVersion(target, 'before-restore');
  } catch {
    /* target may not exist */
  }
  await ensureParent(target);
  await fsp.copyFile(stored, target);
  return stat({ path: target });
}

async function removeBackup(payload = {}) {
  requireReady();
  let removed = null;
  await mutateIndex(backupsIndexPath(), (rows) => {
    const at = rows.findIndex((r) => r.id === payload.id);
    if (at >= 0) removed = rows.splice(at, 1)[0];
  });
  if (!removed) throw new Error('That backup no longer exists.');
  try {
    fs.rmSync(path.join(backupsDir(), 'store', removed.stored), { force: true });
  } catch {
    /* best effort */
  }
  return { removed: true, id: removed.id };
}

/* ------------------------------- versions -------------------------------- */

async function versions(payload = {}) {
  requireReady();
  const filePath = humanPath(safePath(payload.path)).toLowerCase();
  const rows = await readIndex(versionsIndexPath());
  return rows
    .filter((r) => String(r.path || '').toLowerCase() === filePath)
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function restoreVersion(payload = {}) {
  requireReady();
  const rows = await readIndex(versionsIndexPath());
  const record = rows.find((r) => r.id === payload.id);
  if (!record) throw new Error('That version no longer exists.');
  const stored = path.join(versionsDir(), 'store', record.stored);
  try {
    await fsp.access(stored);
  } catch {
    throw new Error('The version file is missing on disk.');
  }
  const target = safePath(record.path, 'Restore path');
  try {
    await pushVersion(target, 'before-restore');
  } catch {
    /* target may not exist */
  }
  await ensureParent(target);
  await fsp.copyFile(stored, target);
  return stat({ path: target });
}

/* -------------------------------- watcher -------------------------------- */

async function watchStart(payload = {}) {
  requireReady();
  const requested = safePath(payload.path, 'Folder');
  // Watch the canonical path (libuv aborts on 8.3 names) but report paths the
  // caller asked for, so the Files page can match them against its listing.
  const dir = await fsp.realpath(requested);
  const blocked = checkPath(dir, 'read');
  if (blocked) throw new Error(blocked);
  const st = await fsp.stat(dir);
  if (!st.isDirectory()) throw new Error('Watch a folder, not a file.');
  const existing = [...watchers.values()].find(
    (w) => w.path.toLowerCase() === requested.toLowerCase() || w.realPath.toLowerCase() === dir.toLowerCase(),
  );
  if (existing) return { id: existing.id, path: existing.path, startedAt: existing.startedAt, reused: true };
  const watchId = `watch_${++watchSeq}_${crypto.randomBytes(2).toString('hex')}`;
  const watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    depth: 6,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });
  const state = { id: watchId, path: humanPath(requested), realPath: humanPath(dir), startedAt: now(), events: [], watcher };
  const pushEvent = (type, label) => {
    const event = { id: watchId, type, path: label, at: now() };
    state.events.push(event);
    if (state.events.length > WATCH_EVENT_KEEP) state.events.splice(0, state.events.length - WATCH_EVENT_KEEP);
    if (ctx.emit) {
      try {
        ctx.emit(event);
      } catch {
        /* listener gone */
      }
    }
  };
  const displayPath = (filePath) => {
    const full = path.normalize(filePath);
    const rel = path.relative(dir, full);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return humanPath(full);
    return path.join(state.path, rel);
  };
  const record = (type) => (filePath) => pushEvent(type, displayPath(filePath));
  watcher.on('add', record('add'));
  watcher.on('change', record('change'));
  watcher.on('unlink', record('unlink'));
  watcher.on('addDir', record('addDir'));
  watcher.on('unlinkDir', record('unlinkDir'));
  watcher.on('error', (err) => pushEvent('error', String(err && err.message ? err.message : err)));
  watchers.set(watchId, state);
  // chokidar 4 dropped the `.ready` promise; wait for the event with a floor.
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    watcher.once('ready', finish);
    setTimeout(finish, 2000);
  });
  return { id: watchId, path: state.path, startedAt: state.startedAt, reused: false };
}

async function watchStop(payload = {}) {
  requireReady();
  const state = payload.id ? watchers.get(payload.id) : [...watchers.values()][0];
  if (!state) throw new Error('No watcher is running.');
  await state.watcher.close();
  watchers.delete(state.id);
  return { stopped: state.id, path: state.path };
}

function watchStatus() {
  return {
    watching: [...watchers.values()].map((w) => ({
      id: w.id,
      path: w.path,
      startedAt: w.startedAt,
      events: w.events.length,
      last: w.events.slice(-25),
    })),
  };
}

async function close() {
  for (const state of watchers.values()) {
    try {
      await state.watcher.close();
    } catch {
      /* shutting down */
    }
  }
  watchers.clear();
}

module.exports = {
  init,
  info,
  roots,
  list,
  search,
  stat,
  read,
  write,
  mkdir,
  rename,
  copy,
  remove,
  duplicates,
  zip,
  unzip,
  zipList,
  pdfInfo,
  pdfMerge,
  pdfSplit,
  pdfRotate,
  pdfMeta,
  pdfCreate,
  xlsxInfo,
  xlsxRead,
  xlsxToCsv,
  xlsxWrite,
  docxMake,
  diff,
  backup,
  backups,
  restoreBackup,
  removeBackup,
  versions,
  restoreVersion,
  watchStart,
  watchStop,
  watchStatus,
  close,
  _internals: { parseRanges, markdownToBlocks, wrapLine, winAnsi, globToRegExp, safePath, hashFile },
};
