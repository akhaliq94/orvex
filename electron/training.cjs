'use strict';

/**
 * Phase 6 foundation — the training vault.
 *
 * One dedicated folder (default `F:\Orvex space` on this machine) holds every
 * artifact the learning loop produces: GGUF models, episode logs, datasets,
 * eval packs, compiled skills, exports and checkpoints. The folder has a hard
 * quota, a write probe, a layout marker and a usage meter.
 *
 * Episodes are indexed in SQLite for fast queries and mirrored to a daily
 * JSONL file so the vault stays portable without the database.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const db = require('./db.cjs');
const guardrails = require('./guardrails.cjs');
const security = require('./security.cjs');

const GB = 1024 ** 3;
const DEFAULT_QUOTA_BYTES = 300 * GB;
const RESERVE_BYTES = 20 * GB;
const MIN_QUOTA_BYTES = 1 * GB;
const MAX_QUOTA_BYTES = 4096 * GB;
const USAGE_TTL_MS = 30_000;
const MARKER = '.orvex-training.json';
const ROOT_KEY = 'training.root';
const QUOTA_KEY = 'training.quotaBytes';
const LAYOUT = ['models', 'episodes', 'datasets', 'evals', 'skills', 'exports', 'checkpoints', 'cache'];
const KINDS = new Set(['agent', 'orchestrator', 'workflow', 'job', 'chat', 'manual']);
const STATUSES = new Set(['running', 'done', 'failed', 'cancelled']);

const SECRET_KEY =
  /^(api[_-]?key|apikey|key|secret|password|passwd|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|cookie|credential|credentials|private[_-]?key)$/i;

let ctx = { dataDir: process.cwd(), emit: () => {}, platform: process.platform };
let usageCache = { root: null, at: 0, value: null };

/* --------------------------------------------------------------- utilities */

function now() {
  return Date.now();
}

function newId(prefix = 'ep') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…[trimmed]` : text;
}

function isSecretKey(key) {
  return SECRET_KEY.test(String(key || ''));
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

/** Accepts 300, "300GB", "300 gb", "1.5 TB". Returns bytes. */
function parseBytes(input) {
  if (typeof input === 'number' && Number.isFinite(input)) {
    if (input <= 0) throw new Error('Size must be greater than zero.');
    return Math.round(input);
  }
  const text = String(input ?? '').trim();
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i.exec(text);
  if (!match) throw new Error('Size must look like 300GB, 1.5TB or a byte count.');
  const value = Number(match[1]);
  const unit = String(match[2] || 'b').toLowerCase();
  const factor = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[unit];
  const bytes = value * factor;
  if (!Number.isFinite(bytes) || bytes <= 0) throw new Error('Size must be greater than zero.');
  return Math.round(bytes);
}

function clampQuota(bytes) {
  return Math.max(MIN_QUOTA_BYTES, Math.min(Math.round(Number(bytes) || 0), MAX_QUOTA_BYTES));
}

/**
 * Would this quota fit on the drive after keeping the safety reserve?
 * `usedBytes` is the vault's own footprint, already included in free space.
 */
function quotaAdvice({ requestedBytes, freeBytes, usedBytes = 0, reserveBytes = RESERVE_BYTES } = {}) {
  const requested = clampQuota(requestedBytes);
  if (freeBytes === null || freeBytes === undefined || !Number.isFinite(Number(freeBytes))) {
    return { ok: true, quotaBytes: requested, maxBytes: null, note: 'Free space could not be read; the quota is logical only.' };
  }
  const maxBytes = Math.max(0, Number(usedBytes) + Number(freeBytes) - reserveBytes);
  return {
    ok: requested <= maxBytes,
    quotaBytes: requested,
    maxBytes,
    note:
      requested <= maxBytes
        ? null
        : `This drive can hold ${formatBytes(maxBytes)} for training after the ${formatBytes(reserveBytes)} reserve.`,
  };
}

function pickDefaultRoot({
  platform = process.platform,
  dataDir = process.cwd(),
  exists = (candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  },
} = {}) {
  if (platform === 'win32' && exists('F:\\Orvex space')) return 'F:\\Orvex space';
  return path.join(dataDir || process.cwd(), 'training');
}

/** Deep-scrub a value: known secret keys are dropped, strings are redacted. */
function scrubDeep(value, redact = security.redact, depth = 0) {
  if (depth > 10) return '[depth-limit]';
  if (typeof value === 'string') return clip(redact(value), 65_536);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => scrubDeep(item, redact, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      out[key] = isSecretKey(key) ? '[redacted]' : scrubDeep(item, redact, depth + 1);
    }
    return out;
  }
  return String(value);
}

function jsonColumn(value, max = 131_072) {
  if (value === null || value === undefined) return null;
  const scrubbed = scrubDeep(value);
  const text = typeof scrubbed === 'string' ? scrubbed : JSON.stringify(scrubbed);
  if (text.length <= max) return text;
  return JSON.stringify({ truncated: true, chars: text.length, preview: text.slice(0, max) });
}

function parseJsonColumn(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeEpisode(payload = {}) {
  const createdAt = Math.max(0, Number(payload.createdAt) || now());
  const score = payload.score === null || payload.score === undefined ? null : Math.max(0, Math.min(1, Number(payload.score) || 0));
  return {
    id: String(payload.id || newId('ep')).slice(0, 80),
    runId: payload.runId ? String(payload.runId).slice(0, 120) : null,
    kind: KINDS.has(String(payload.kind)) ? String(payload.kind) : 'agent',
    goal: clip(security.redact(String(payload.goal || '')), 8000),
    status: STATUSES.has(String(payload.status)) ? String(payload.status) : 'done',
    score,
    provider: payload.provider ? String(payload.provider).slice(0, 120) : null,
    model: payload.model ? String(payload.model).slice(0, 160) : null,
    steps: Math.max(0, Math.round(Number(payload.steps) || 0)),
    promptTokens: Math.max(0, Math.round(Number(payload.promptTokens) || 0)),
    completionTokens: Math.max(0, Math.round(Number(payload.completionTokens) || 0)),
    cost: Math.max(0, Number(payload.cost) || 0),
    ms: Math.max(0, Math.round(Number(payload.ms) || 0)),
    plan: jsonColumn(payload.plan),
    actions: jsonColumn(payload.actions),
    outcome: jsonColumn(payload.outcome),
    error: payload.error ? clip(security.redact(String(payload.error)), 4000) : null,
    file: null,
    createdAt,
  };
}

/* -------------------------------------------------------------------- init */

function init(opts = {}) {
  ctx = { ...ctx, ...opts };
  usageCache = { root: null, at: 0, value: null };
  void ensureLayout().catch(() => {});
  return { root: root(), quotaBytes: quotaBytes() };
}

function root() {
  const saved = db.getSetting(ROOT_KEY, null);
  const value = typeof saved === 'string' && saved.trim() ? saved.trim() : pickDefaultRoot({ dataDir: ctx.dataDir });
  return path.resolve(value);
}

function quotaBytes() {
  const saved = Number(db.getSetting(QUOTA_KEY, 0));
  return Number.isFinite(saved) && saved >= MIN_QUOTA_BYTES ? Math.min(saved, MAX_QUOTA_BYTES) : DEFAULT_QUOTA_BYTES;
}

function emit(event) {
  try {
    ctx.emit({ ...event, at: now() });
  } catch {
    /* the window may be gone */
  }
}

async function isDir(candidate) {
  try {
    return (await fsp.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function diskSpace(target) {
  if (typeof fsp.statfs !== 'function') return { total: null, free: null, used: null };
  try {
    const stats = await fsp.statfs(target);
    const block = Number(stats.bsize) || 0;
    const total = Number(stats.blocks) * block;
    const free = Number(stats.bavail) * block;
    return { total, free, used: Math.max(0, total - free) };
  } catch {
    return { total: null, free: null, used: null };
  }
}

async function folderSize(target) {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          total += (await fsp.stat(full)).size;
        } catch {
          /* a file may vanish mid-scan */
        }
      }
    }
  }
  return total;
}

async function ensureLayout(target = root()) {
  await fsp.mkdir(target, { recursive: true });
  for (const name of LAYOUT) await fsp.mkdir(path.join(target, name), { recursive: true });
  const marker = path.join(target, MARKER);
  try {
    await fsp.access(marker);
  } catch {
    await fsp.writeFile(marker, JSON.stringify({ app: 'ORVEX', version: 1, createdAt: new Date().toISOString() }, null, 2), 'utf8');
  }
  return target;
}

async function usage(force = false) {
  const target = root();
  if (!force && usageCache.value && usageCache.root === target && now() - usageCache.at < USAGE_TTL_MS) {
    return usageCache.value;
  }
  const categories = {};
  let totalBytes = 0;
  for (const name of LAYOUT) {
    const bytes = await folderSize(path.join(target, name));
    categories[name] = bytes;
    totalBytes += bytes;
  }
  const space = await diskSpace((await isDir(target)) ? target : path.dirname(target));
  const value = {
    root: target,
    categories,
    totalBytes,
    quotaBytes: quotaBytes(),
    freeBytes: space.free,
    diskTotalBytes: space.total,
    at: now(),
  };
  usageCache = { root: target, at: now(), value };
  return value;
}

async function canWrite(bytes) {
  const amount = Math.max(0, Number(bytes) || 0);
  const use = await usage();
  if (use.totalBytes + amount > use.quotaBytes) return false;
  return use.freeBytes === null || use.freeBytes - amount > RESERVE_BYTES;
}

async function status() {
  const target = root();
  const exists = await isDir(target);
  const use = await usage();
  const space = await diskSpace(exists ? target : path.dirname(target));
  const stats = episodeStats();
  const quota = quotaBytes();
  return {
    root: target,
    exists,
    marker: path.join(target, MARKER),
    quotaBytes: quota,
    usedBytes: use.totalBytes,
    categories: use.categories,
    freeBytes: space.free,
    diskTotalBytes: space.total,
    reserveBytes: RESERVE_BYTES,
    overQuota: use.totalBytes >= quota,
    diskTight: space.free !== null && space.free < RESERVE_BYTES,
    layout: LAYOUT,
    episodes: stats.count,
    lastEpisodeAt: stats.lastAt,
    at: now(),
  };
}

async function setRoot(input) {
  const candidate = String(input || '').trim();
  if (!candidate) throw new Error('Choose a folder for the training vault.');
  if (!path.isAbsolute(candidate)) throw new Error('The training vault must be an absolute path.');
  const blocked = guardrails.checkPath(candidate, 'write');
  if (blocked) throw new Error(blocked);
  await fsp.mkdir(candidate, { recursive: true });
  const probe = path.join(candidate, `.orvex-probe-${crypto.randomBytes(3).toString('hex')}`);
  await fsp.writeFile(probe, 'ok', 'utf8');
  await fsp.rm(probe, { force: true });
  db.setSetting(ROOT_KEY, path.resolve(candidate));
  usageCache = { root: null, at: 0, value: null };
  await ensureLayout();
  emit({ type: 'root', root: path.resolve(candidate) });
  return status();
}

async function setQuota(input) {
  const requested = parseBytes(input);
  const target = root();
  const space = await diskSpace((await isDir(target)) ? target : path.dirname(target));
  const use = await usage(true);
  const advice = quotaAdvice({ requestedBytes: requested, freeBytes: space.free, usedBytes: use.totalBytes });
  if (!advice.ok) throw new Error(advice.note || 'That quota does not fit on this drive.');
  db.setSetting(QUOTA_KEY, advice.quotaBytes);
  usageCache = { root: null, at: 0, value: null };
  emit({ type: 'quota', quotaBytes: advice.quotaBytes });
  return status();
}

/* ----------------------------------------------------------------- episodes */

function rawDb() {
  const raw = db.raw();
  if (!raw) throw new Error('The ORVEX database is not ready.');
  return raw;
}

function episodeDay(ts) {
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function appendEpisode(payload = {}) {
  const episode = normalizeEpisode(payload);
  const relative = path.join('episodes', `${episodeDay(episode.createdAt)}.jsonl`).replace(/\\/g, '/');
  episode.file = relative;

  rawDb()
    .prepare(
      `INSERT OR REPLACE INTO train_episodes
        (id, run_id, kind, goal, status, score, provider, model, steps,
         prompt_tokens, completion_tokens, cost_usd, ms, plan, actions, outcome, error, file, created_at)
       VALUES
        (@id, @runId, @kind, @goal, @status, @score, @provider, @model, @steps,
         @promptTokens, @completionTokens, @cost, @ms, @plan, @actions, @outcome, @error, @file, @createdAt)`,
    )
    .run(episode);

  let storedFile = null;
  try {
    const line = JSON.stringify({
      ...episode,
      plan: parseJsonColumn(episode.plan),
      actions: parseJsonColumn(episode.actions),
      outcome: parseJsonColumn(episode.outcome),
    });
    if (await canWrite(Buffer.byteLength(line, 'utf8'))) {
      const full = path.join(root(), relative);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.appendFile(full, `${line}\n`, 'utf8');
      storedFile = relative;
    }
  } catch {
    storedFile = null;
  }
  if (!storedFile) {
    try {
      rawDb().prepare('UPDATE train_episodes SET file = NULL WHERE id = ?').run(episode.id);
    } catch {
      /* the index row is still valid */
    }
  }
  usageCache = { root: null, at: 0, value: null };
  emit({ type: 'episode', id: episode.id, kind: episode.kind, status: episode.status });
  return { ...episode, file: storedFile };
}

function listEpisodes({ limit = 50, kind, status, query } = {}) {
  const raw = rawDb();
  const where = [];
  const params = {};
  if (kind) {
    where.push('kind = @kind');
    params.kind = String(kind);
  }
  if (status) {
    where.push('status = @status');
    params.status = String(status);
  }
  const search = String(query || '').trim();
  if (search) {
    where.push('(goal LIKE @query OR outcome LIKE @query OR error LIKE @query)');
    params.query = `%${search}%`;
  }
  params.limit = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const sql = `SELECT id, run_id AS runId, kind, goal, status, score, provider, model, steps,
                      prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
                      cost_usd AS cost, ms, error, file, created_at AS createdAt
               FROM train_episodes
               ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY created_at DESC LIMIT @limit`;
  return raw.prepare(sql).all(params);
}

function getEpisode(id) {
  const row = rawDb()
    .prepare(
      `SELECT id, run_id AS runId, kind, goal, status, score, provider, model, steps,
              prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
              cost_usd AS cost, ms, plan, actions, outcome, error, file, created_at AS createdAt
       FROM train_episodes WHERE id = ?`,
    )
    .get(String(id || ''));
  if (!row) return null;
  return {
    ...row,
    plan: parseJsonColumn(row.plan),
    actions: parseJsonColumn(row.actions),
    outcome: parseJsonColumn(row.outcome),
  };
}

function deleteEpisode(id) {
  const result = rawDb().prepare('DELETE FROM train_episodes WHERE id = ?').run(String(id || ''));
  usageCache = { root: null, at: 0, value: null };
  emit({ type: 'episode-deleted', id: String(id || '') });
  return { removed: result.changes };
}

async function clearEpisodes() {
  const raw = rawDb();
  const before = raw.prepare('SELECT COUNT(*) AS count FROM train_episodes').get();
  raw.prepare('DELETE FROM train_episodes').run();
  const dir = path.join(root(), 'episodes');
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  usageCache = { root: null, at: 0, value: null };
  emit({ type: 'episodes-cleared', removed: before.count });
  return { removed: before.count };
}

function episodeStats() {
  const raw = db.raw();
  if (!raw) {
    return { count: 0, avgScore: 0, cost: 0, tokens: 0, steps: 0, byKind: [], lastAt: null };
  }
  try {
    const totals = raw
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(AVG(score),0) AS avgScore,
                COALESCE(SUM(cost_usd),0) AS cost,
                COALESCE(SUM(prompt_tokens + completion_tokens),0) AS tokens,
                COALESCE(SUM(steps),0) AS steps,
                MAX(created_at) AS lastAt
         FROM train_episodes`,
      )
      .get();
    const byKind = raw
      .prepare('SELECT kind, COUNT(*) AS count FROM train_episodes GROUP BY kind ORDER BY count DESC')
      .all();
    return { ...totals, byKind, lastAt: totals.lastAt || null };
  } catch {
    return { count: 0, avgScore: 0, cost: 0, tokens: 0, steps: 0, byKind: [], lastAt: null };
  }
}

/**
 * Daily outcome curve. Scores are only averaged over episodes that actually
 * have a score; the pass rate counts finished runs.
 */
function scoreCurve({ days = 30, kind } = {}) {
  const raw = db.raw();
  const windowDays = Math.max(1, Math.min(365, Math.round(Number(days) || 30)));
  if (!raw) return { days: windowDays, kind: kind || null, points: [], overall: { count: 0, avgScore: null, passRate: null } };
  const since = now() - windowDays * 86_400_000;
  try {
    const rows = raw
      .prepare(
        `SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day,
                COUNT(*) AS count,
                AVG(score) AS avgScore,
                SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
         FROM train_episodes
         WHERE created_at >= @since ${kind ? 'AND kind = @kind' : ''}
         GROUP BY day ORDER BY day ASC`,
      )
      .all(kind ? { since, kind: String(kind) } : { since });
    const points = rows.map((row) => ({
      day: row.day,
      count: Number(row.count) || 0,
      avgScore: row.avgScore == null ? null : Number(row.avgScore),
      passRate: row.count ? (Number(row.done) || 0) / Number(row.count) : null,
      done: Number(row.done) || 0,
      failed: Number(row.failed) || 0,
      cancelled: Number(row.cancelled) || 0,
    }));
    const count = points.reduce((sum, p) => sum + p.count, 0);
    const scored = points.filter((p) => p.avgScore !== null);
    const avgScore = scored.length
      ? scored.reduce((sum, p) => sum + p.avgScore * p.count, 0) / scored.reduce((sum, p) => sum + p.count, 0)
      : null;
    const done = points.reduce((sum, p) => sum + p.done, 0);
    return { days: windowDays, kind: kind || null, points, overall: { count, avgScore, passRate: count ? done / count : null } };
  } catch {
    return { days: windowDays, kind: kind || null, points: [], overall: { count: 0, avgScore: null, passRate: null } };
  }
}

const EVAL_CRITERIA = ['the goal is addressed directly', 'the recorded actions match the goal', 'the final summary is specific and verifiable'];

/** Turn recorded runs into reproducible cases; no invented expectations. */
function evalCases({ limit = 50, kind } = {}) {
  const episodes = listEpisodes({ limit: Math.max(1, Math.min(500, Math.round(Number(limit) || 50))), kind }).filter(
    (episode) => episode.status !== 'running',
  );
  return episodes.map((episode) => {
    const detail = getEpisode(episode.id);
    const rawOutcome = detail && detail.outcome;
    const outcome = rawOutcome && typeof rawOutcome === 'object' ? rawOutcome : rawOutcome ? { summary: rawOutcome } : {};
    return {
      id: episode.id,
      goal: String(episode.goal || ''),
      kind: episode.kind,
      observed: { status: episode.status, score: episode.score, steps: episode.steps },
      expected: {
        status: episode.status,
        summary: String(outcome.summary || '').slice(0, 2000) || null,
        error: episode.error || null,
      },
      criteria: EVAL_CRITERIA,
    };
  });
}

async function buildEvalPack({ limit = 50, kind, name } = {}) {
  ensureLayout();
  const cases = evalCases({ limit, kind });
  if (!cases.length) throw new Error('Record at least one finished run before building an eval pack.');
  const id = newId('eval');
  const builtAt = now();
  const pack = {
    id,
    suite: 'recorded-episodes',
    name: String(name || `Recorded runs · ${new Date(builtAt).toISOString().slice(0, 16).replace('T', ' ')}`).slice(0, 120),
    builtAt,
    source: 'train_episodes',
    criteria: EVAL_CRITERIA,
    cases,
  };
  const body = JSON.stringify(pack, null, 2);
  if (!(await canWrite(Buffer.byteLength(body, 'utf8')))) {
    throw new Error('The training quota or the drive reserve blocks this eval pack.');
  }
  const relative = path.join('evals', `${id}.json`).replace(/\\/g, '/');
  await fsp.mkdir(path.dirname(path.join(root(), relative)), { recursive: true });
  await fsp.writeFile(path.join(root(), relative), body, 'utf8');
  try {
    rawDb()
      .prepare(
        `INSERT INTO train_evals(id, suite, name, cases, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?)`,
      )
      .run(id, pack.suite, pack.name, JSON.stringify(cases), builtAt, builtAt);
  } catch {
    /* the file is still valid without the index row */
  }
  usageCache = { root: null, at: 0, value: null };
  emit({ type: 'eval-pack', id, cases: cases.length });
  return { ...pack, path: relative, bytes: Buffer.byteLength(body, 'utf8') };
}

function listEvalPacks(limit = 50) {
  const raw = db.raw();
  if (!raw) return [];
  const take = Math.max(1, Math.min(200, Math.round(Number(limit) || 50)));
  try {
    return raw
      .prepare(
        `SELECT id, suite, name, cases, created_at AS createdAt, updated_at AS updatedAt
         FROM train_evals ORDER BY created_at DESC LIMIT ?`,
      )
      .all(take)
      .map((row) => {
        let count = 0;
        try {
          count = Array.isArray(JSON.parse(row.cases)) ? JSON.parse(row.cases).length : 0;
        } catch {
          count = 0;
        }
        return {
          id: row.id,
          suite: row.suite,
          name: row.name,
          cases: count,
          path: `evals/${row.id}.json`,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      });
  } catch {
    return [];
  }
}

module.exports = {
  init,
  root,
  quotaBytes,
  ensureLayout,
  usage,
  canWrite,
  status,
  setRoot,
  setQuota,
  appendEpisode,
  listEpisodes,
  getEpisode,
  deleteEpisode,
  clearEpisodes,
  episodeStats,
  scoreCurve,
  buildEvalPack,
  listEvalPacks,
  formatBytes,
  _internals: {
    parseBytes,
    clampQuota,
    quotaAdvice,
    pickDefaultRoot,
    scrubDeep,
    normalizeEpisode,
    isSecretKey,
    formatBytes,
    LAYOUT,
    KINDS,
    STATUSES,
    DEFAULT_QUOTA_BYTES,
    RESERVE_BYTES,
    MIN_QUOTA_BYTES,
    MAX_QUOTA_BYTES,
  },
};
