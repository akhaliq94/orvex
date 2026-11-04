'use strict';

/**
 * ORVEX structured memory: SQLite rows + FTS5 + local hashed embeddings.
 * Hybrid ranking (BM25 + cosine + importance + recency), conflict detection,
 * expiry, lightweight related-memory graph, user profile, and RAG answers.
 * No network calls except ask(), which uses the configured model gateway.
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const db = require('./db.cjs');

const KINDS = ['fact', 'preference', 'project', 'person', 'procedure', 'event', 'insight', 'legacy'];
const STATUSES = ['active', 'superseded', 'archived', 'expired'];
const DIM = 256;
const DAY = 24 * 3600 * 1000;
const MAX_TEXT = 20000;

let ctx = {};
let ready = false;
let lastError = null;

function init(opts = {}) {
  ctx = { ...ctx, ...opts };
  const raw = db.raw();
  if (!raw) {
    ready = false;
    lastError = 'Database is not ready.';
    return info();
  }
  try {
    ensureSchema(raw);
    const items = raw.prepare('SELECT COUNT(*) AS c FROM memory_items').get().c;
    const indexed = raw.prepare('SELECT COUNT(*) AS c FROM memory_fts').get().c;
    if (items !== indexed) reindex();
    ready = true;
    lastError = null;
    sweep();
    if (ctx.legacyFile) {
      try {
        importLegacy(ctx.legacyFile);
      } catch {
        /* migration must never block startup */
      }
    }
  } catch (err) {
    ready = false;
    lastError = err && err.message ? err.message : String(err);
  }
  return info();
}

function info() {
  return { ready, error: lastError, kinds: KINDS, dimensions: DIM };
}

function requireReady() {
  if (!ready || !db.raw()) throw new Error(`Memory is not ready${lastError ? ` — ${lastError}` : ''}.`);
  return db.raw();
}

function ensureSchema(raw) {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS memory_links (
      src TEXT NOT NULL,
      dst TEXT NOT NULL,
      rel TEXT NOT NULL DEFAULT 'related',
      score REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (src, dst, rel)
    );
    CREATE INDEX IF NOT EXISTS memory_links_dst ON memory_links(dst);

    CREATE TABLE IF NOT EXISTS memory_conflicts (
      id TEXT PRIMARY KEY,
      a TEXT NOT NULL,
      b TEXT NOT NULL,
      kind TEXT NOT NULL,
      project TEXT,
      score REAL NOT NULL DEFAULT 0,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      resolution TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS memory_conflicts_status ON memory_conflicts(status, created_at);
    CREATE INDEX IF NOT EXISTS memory_conflicts_pair ON memory_conflicts(a, b);

    CREATE TABLE IF NOT EXISTS memory_profile (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const cols = new Set(raw.prepare('PRAGMA table_info(memory_items)').all().map((c) => c.name));
  const additions = [
    ['project', "TEXT NOT NULL DEFAULT ''"],
    ['status', "TEXT NOT NULL DEFAULT 'active'"],
    ['pinned', 'INTEGER NOT NULL DEFAULT 0'],
    ['embedding', 'TEXT'],
    ['meta', 'TEXT'],
    ['last_used_at', 'INTEGER'],
    ['use_count', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [name, ddl] of additions) {
    if (!cols.has(name)) raw.exec(`ALTER TABLE memory_items ADD COLUMN ${name} ${ddl}`);
  }
  raw.exec('CREATE INDEX IF NOT EXISTS memory_status ON memory_items(status, kind)');
  raw.exec('CREATE INDEX IF NOT EXISTS memory_project ON memory_items(project)');
}

function now() {
  return Date.now();
}

function newId(prefix) {
  return `${prefix}_${now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(Number(n) || 0, lo), hi);
}

function round(n, places = 4) {
  const f = 10 ** places;
  return Math.round(Number(n) * f) / f;
}

function normText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function normKey(text) {
  return normText(text).toLowerCase();
}

function normalizeKind(kind) {
  const k = String(kind || 'fact').trim().toLowerCase();
  return KINDS.includes(k) ? k : 'fact';
}

function normalizeProject(project) {
  return String(project ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function normalizeTags(tags) {
  const list = Array.isArray(tags)
    ? tags
    : typeof tags === 'string'
      ? tags.split(',')
      : [];
  const out = [];
  for (const raw of list) {
    const tag = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
    if (out.length >= 12) break;
  }
  return out;
}

function normalizeImportance(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return clamp(n, 0, 1);
}

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function parseVector(raw) {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length === DIM ? arr : null;
  } catch {
    return null;
  }
}

function rowToItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    tags: parseJson(row.tags, []),
    importance: Number(row.importance) || 0,
    source: row.source || null,
    project: row.project || '',
    status: row.status || 'active',
    pinned: !!row.pinned,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    expiresAt: row.expires_at || null,
    lastUsedAt: row.last_used_at || null,
    useCount: Number(row.use_count) || 0,
    meta: parseJson(row.meta, null),
  };
}

/* ------------------------------- embeddings ------------------------------- */

function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function words(text) {
  try {
    return String(text ?? '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]{2,}/gu) || [];
  } catch {
    return String(text ?? '').toLowerCase().match(/[a-z0-9]{2,}/g) || [];
  }
}

function tokenSet(text) {
  return new Set(words(text).slice(0, 600));
}

/** Local 256-dimension hashed bag-of-words + bigrams, L2-normalised. */
function embedText(text) {
  const toks = words(text).slice(0, 600);
  const vec = new Array(DIM).fill(0);
  const add = (token, weight) => {
    const h = hash32(token);
    const sign = hash32(`s:${token}`) & 1 ? 1 : -1;
    vec[h % DIM] += sign * weight;
  };
  for (const tok of toks) add(tok, 1);
  for (let i = 0; i < toks.length - 1; i += 1) add(`${toks[i]}_${toks[i + 1]}`, 0.55);
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (!norm) return vec;
  return vec.map((v) => v / norm);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  const small = a.size <= b.size ? a : b;
  const large = small === a ? b : a;
  for (const token of small) if (large.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function approximateCosine(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / Math.sqrt(a.size * b.size);
}

function hasNegation(text) {
  return /\b(not|never|no|avoid|without|disable|disabled|off|don't|dont|isn't|doesn't)\b/i.test(text);
}

/* ---------------------------------- FTS ---------------------------------- */

function ftsQuery(query) {
  const toks = [...tokenSet(query)].slice(0, 12);
  if (!toks.length) return null;
  return toks.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

function ftsScores(query) {
  const match = ftsQuery(query);
  if (!match) return new Map();
  try {
    const rows = requireReady()
      .prepare('SELECT id, bm25(memory_fts) AS rank FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT 80')
      .all(match);
    if (!rows.length) return new Map();
    const best = Math.max(...rows.map((r) => Math.abs(Number(r.rank) || 0))) || 1;
    return new Map(rows.map((r) => [r.id, clamp(Math.abs(Number(r.rank) || 0) / best, 0, 1)]));
  } catch {
    return new Map();
  }
}

function indexRow(raw, item) {
  raw.prepare('DELETE FROM memory_fts WHERE id = ?').run(item.id);
  if (item.status !== 'active') return;
  raw.prepare('INSERT INTO memory_fts(id, text, tags) VALUES(?, ?, ?)').run(item.id, item.text, item.tags.join(' '));
}

function reindex() {
  const raw = requireReady();
  raw.prepare('DELETE FROM memory_fts').run();
  const rows = raw.prepare('SELECT * FROM memory_items').all();
  const insert = raw.prepare('INSERT INTO memory_fts(id, text, tags) VALUES(?, ?, ?)');
  for (const row of rows) {
    if ((row.status || 'active') !== 'active') continue;
    insert.run(row.id, row.text, parseJson(row.tags, []).join(' '));
  }
  return rows.length;
}

function touch(ids) {
  const raw = db.raw();
  if (!raw || !ids.length) return;
  const update = raw.prepare('UPDATE memory_items SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?');
  const at = now();
  try {
    for (const id of ids) update.run(at, id);
  } catch {
    /* usage tracking is best-effort */
  }
}

/* --------------------------------- expiry -------------------------------- */

function sweep() {
  const raw = requireReady();
  const expired = raw
    .prepare("SELECT id FROM memory_items WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?")
    .all(now());
  if (!expired.length) return { expired: 0, ids: [] };
  const mark = raw.prepare("UPDATE memory_items SET status = 'expired', updated_at = ? WHERE id = ?");
  const unindex = raw.prepare('DELETE FROM memory_fts WHERE id = ?');
  const tx = raw.transaction((rows) => {
    for (const row of rows) {
      mark.run(now(), row.id);
      unindex.run(row.id);
    }
  });
  tx(expired);
  return { expired: expired.length, ids: expired.map((r) => r.id) };
}

/* ---------------------------------- CRUD --------------------------------- */

function get(id) {
  const row = requireReady().prepare('SELECT * FROM memory_items WHERE id = ?').get(String(id || ''));
  return rowToItem(row);
}

function list(opts = {}) {
  const raw = requireReady();
  sweep();
  const where = [];
  const params = [];
  const status = opts.status ? String(opts.status) : 'active';
  if (status !== 'all') {
    if (!STATUSES.includes(status)) throw new Error(`Unknown memory status "${status}".`);
    where.push('status = ?');
    params.push(status);
  }
  if (opts.kind) {
    where.push('kind = ?');
    params.push(normalizeKind(opts.kind));
  }
  if (opts.project !== undefined && opts.project !== null) {
    where.push("COALESCE(project, '') = ?");
    params.push(normalizeProject(opts.project));
  }
  if (opts.pinned) {
    where.push('pinned = 1');
  }
  if (opts.tag) {
    where.push("LOWER(COALESCE(tags, '')) LIKE ?");
    params.push(`%${String(opts.tag).toLowerCase()}%`);
  }
  const limit = clamp(opts.limit ?? 100, 1, 500);
  const sql = `SELECT * FROM memory_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ?`;
  return raw.prepare(sql).all(...params, limit).map(rowToItem);
}

function findActiveByText(text) {
  const key = normKey(text);
  if (!key) return null;
  const rows = requireReady()
    .prepare("SELECT * FROM memory_items WHERE status = 'active' ORDER BY updated_at DESC LIMIT 500")
    .all();
  const row = rows.find((r) => normKey(r.text) === key);
  return rowToItem(row);
}

function add(input = {}) {
  const raw = requireReady();
  const text = normText(input.text ?? input.note);
  if (!text) throw new Error('Memory text is empty.');
  if (text.length > MAX_TEXT) throw new Error(`Keep each memory under ${MAX_TEXT} characters.`);
  sweep();

  const existing = findActiveByText(text);
  if (existing) {
    raw
      .prepare('UPDATE memory_items SET importance = MAX(importance, ?), updated_at = ?, use_count = use_count + 1, last_used_at = ? WHERE id = ?')
      .run(normalizeImportance(input.importance ?? existing.importance), now(), now(), existing.id);
    return { ...get(existing.id), duplicate: true };
  }

  const tags = normalizeTags(input.tags);
  const item = {
    id: newId('mem'),
    kind: normalizeKind(input.kind),
    text,
    tags,
    importance: normalizeImportance(input.importance),
    source: String(input.source || 'user').slice(0, 80),
    project: normalizeProject(input.project),
    status: 'active',
    pinned: input.pinned ? 1 : 0,
    createdAt: now(),
    updatedAt: now(),
    expiresAt: input.expiresAt === undefined ? null : Number(input.expiresAt) || null,
    meta: input.meta && typeof input.meta === 'object' ? JSON.stringify(input.meta).slice(0, 2000) : null,
    embedding: JSON.stringify(embedText(text).map((v) => round(v, 5))),
  };

  raw
    .prepare(
      `INSERT INTO memory_items(id, kind, text, tags, importance, source, created_at, updated_at, expires_at,
        project, status, pinned, embedding, meta, last_used_at, use_count)
       VALUES(@id, @kind, @text, @tags, @importance, @source, @createdAt, @updatedAt, @expiresAt,
        @project, @status, @pinned, @embedding, @meta, NULL, 0)`,
    )
    .run({
      id: item.id,
      kind: item.kind,
      text: item.text,
      tags: JSON.stringify(item.tags),
      importance: item.importance,
      source: item.source,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      expiresAt: item.expiresAt,
      project: item.project,
      status: item.status,
      pinned: item.pinned,
      embedding: item.embedding,
      meta: item.meta,
    });
  indexRow(raw, item);
  rebuildLinks(item.id);
  const conflicts = detectConflicts(item.id);
  return { ...get(item.id), duplicate: false, conflicts: conflicts.length };
}

function update(id, patch = {}) {
  const raw = requireReady();
  const current = get(id);
  if (!current) throw new Error('Memory item not found.');

  const text = patch.text === undefined ? current.text : normText(patch.text);
  if (!text) throw new Error('Memory text is empty.');
  if (text.length > MAX_TEXT) throw new Error(`Keep each memory under ${MAX_TEXT} characters.`);

  const kind = patch.kind === undefined ? current.kind : normalizeKind(patch.kind);
  const tags = patch.tags === undefined ? current.tags : normalizeTags(patch.tags);
  const importance = patch.importance === undefined ? current.importance : normalizeImportance(patch.importance);
  const project = patch.project === undefined ? current.project : normalizeProject(patch.project);
  const pinned = patch.pinned === undefined ? current.pinned : !!patch.pinned;
  const status = patch.status === undefined ? current.status : String(patch.status);
  if (!STATUSES.includes(status)) throw new Error(`Unknown memory status "${status}".`);
  const expiresAt = patch.expiresAt === undefined ? current.expiresAt : Number(patch.expiresAt) || null;
  const meta =
    patch.meta === undefined
      ? current.meta
      : patch.meta && typeof patch.meta === 'object'
        ? patch.meta
        : null;

  raw
    .prepare(
      `UPDATE memory_items SET kind = ?, text = ?, tags = ?, importance = ?, project = ?, status = ?,
        pinned = ?, expires_at = ?, embedding = ?, meta = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      kind,
      text,
      JSON.stringify(tags),
      importance,
      project,
      status,
      pinned ? 1 : 0,
      expiresAt,
      JSON.stringify(embedText(text).map((v) => round(v, 5))),
      meta ? JSON.stringify(meta).slice(0, 2000) : null,
      now(),
      current.id,
    );
  const item = get(current.id);
  indexRow(raw, item);
  rebuildLinks(item.id);
  if (item.status === 'active') detectConflicts(item.id);
  return item;
}

function remove(id) {
  const raw = requireReady();
  const item = get(id);
  if (!item) throw new Error('Memory item not found.');
  raw.prepare('DELETE FROM memory_fts WHERE id = ?').run(item.id);
  raw.prepare('DELETE FROM memory_links WHERE src = ? OR dst = ?').run(item.id, item.id);
  raw.prepare('DELETE FROM memory_items WHERE id = ?').run(item.id);
  raw
    .prepare(
      `UPDATE memory_conflicts SET status = 'cancelled', resolved_at = ?
       WHERE status = 'open' AND (a = ? OR b = ?)`,
    )
    .run(now(), item.id, item.id);
  return { removed: true, id: item.id };
}

function setStatus(id, status) {
  const raw = requireReady();
  if (!STATUSES.includes(status)) throw new Error(`Unknown memory status "${status}".`);
  raw.prepare('UPDATE memory_items SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), String(id));
  const item = get(id);
  if (item) indexRow(raw, item);
  return item;
}

/* -------------------------------- conflicts ------------------------------- */

function conflictRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    a: row.a,
    b: row.b,
    kind: row.kind,
    project: row.project || '',
    score: Number(row.score) || 0,
    reason: row.reason || 'similar',
    status: row.status,
    resolution: row.resolution || null,
    createdAt: Number(row.created_at) || 0,
    resolvedAt: row.resolved_at || null,
  };
}

function conflicts({ status = 'open', limit = 50 } = {}) {
  const rows = requireReady()
    .prepare('SELECT * FROM memory_conflicts WHERE status = ? ORDER BY created_at DESC LIMIT ?')
    .all(String(status), clamp(limit, 1, 200));
  return rows.map((row) => ({ ...conflictRow(row), itemA: get(row.a), itemB: get(row.b) }));
}

function detectConflicts(id) {
  const raw = requireReady();
  const item = get(id);
  if (!item || item.status !== 'active') return [];
  const others = raw
    .prepare("SELECT * FROM memory_items WHERE status = 'active' AND id != ? AND kind = ? AND COALESCE(project, '') = ?")
    .all(item.id, item.kind, item.project);
  const base = tokenSet(item.text);
  if (!base.size) return [];
  const out = [];
  const pairLookup = raw.prepare("SELECT 1 FROM memory_conflicts WHERE status = 'open' AND a = ? AND b = ? LIMIT 1");
  const insertConflict = raw.prepare(
    `INSERT INTO memory_conflicts(id, a, b, kind, project, score, reason, status, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
  );
  for (const row of others) {
    const other = rowToItem(row);
    if (normKey(other.text) === normKey(item.text)) continue;
    const tokens = tokenSet(other.text);
    if (!tokens.size) continue;
    const j = jaccard(base, tokens);
    const cos = approximateCosine(base, tokens);
    const negated = hasNegation(item.text) !== hasNegation(other.text);
    const hit = (j >= 0.6 && cos >= 0.65) || (negated && j >= 0.45);
    if (!hit) continue;
    const exists = pairLookup.get(item.id, other.id) || pairLookup.get(other.id, item.id);
    if (exists) continue;
    const id2 = newId('cf');
    insertConflict.run(id2, item.id, other.id, item.kind, item.project, round(j), negated ? 'negation' : 'similar', now());
    out.push({ id: id2, score: round(j), reason: negated ? 'negation' : 'similar', itemA: item, itemB: other });
  }
  return out;
}

function resolveConflict(id, action, opts = {}) {
  const raw = requireReady();
  const row = raw.prepare('SELECT * FROM memory_conflicts WHERE id = ?').get(String(id || ''));
  if (!row) throw new Error('Conflict not found.');
  if (row.status !== 'open') throw new Error('This conflict is already resolved.');
  const act = String(action || '');
  let resolution = act;

  if (act === 'keep_a') setStatus(row.b, 'superseded');
  else if (act === 'keep_b') setStatus(row.a, 'superseded');
  else if (act === 'merge') {
    const mergedText = normText(opts.mergedText);
    if (!mergedText) throw new Error('Merging needs mergedText.');
    setStatus(row.b, 'superseded');
    update(row.a, { text: mergedText });
  } else if (act === 'dismiss') {
    resolution = 'dismiss';
  } else {
    throw new Error('Unknown resolution — use keep_a, keep_b, merge or dismiss.');
  }

  raw
    .prepare('UPDATE memory_conflicts SET status = ?, resolution = ?, resolved_at = ? WHERE id = ?')
    .run(act === 'dismiss' ? 'dismissed' : 'resolved', resolution, now(), row.id);
  if (act === 'keep_a' || act === 'keep_b' || act === 'merge') {
    const loser = act === 'keep_b' ? row.a : row.b;
    raw
      .prepare(
        `UPDATE memory_conflicts SET status = 'resolved', resolution = 'superseded', resolved_at = ?
         WHERE status = 'open' AND (a = ? OR b = ?)`,
      )
      .run(now(), loser, loser);
  }
  return conflictRow(raw.prepare('SELECT * FROM memory_conflicts WHERE id = ?').get(row.id));
}

/* ---------------------------------- links -------------------------------- */

function rebuildLinks(id) {
  const raw = requireReady();
  raw.prepare('DELETE FROM memory_links WHERE src = ? OR dst = ?').run(id, id);
  const item = get(id);
  if (!item || item.status !== 'active') return;
  const base = embedText(item.text);
  const rows = raw.prepare("SELECT * FROM memory_items WHERE status = 'active' AND id != ?").all(id);
  const ranked = [];
  for (const row of rows) {
    const vec = parseVector(row.embedding) || embedText(row.text);
    const score = cosine(base, vec);
    if (score >= 0.3) ranked.push({ id: row.id, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  const insert = raw.prepare(
    "INSERT OR REPLACE INTO memory_links(src, dst, rel, score, created_at) VALUES(?, ?, 'related', ?, ?)",
  );
  for (const peer of ranked.slice(0, 4)) {
    insert.run(id, peer.id, round(peer.score), now());
    insert.run(peer.id, id, round(peer.score), now());
  }
}

function links(id, limit = 8) {
  const rows = requireReady()
    .prepare(
      `SELECT l.dst AS id, l.score, m.* FROM memory_links l
       JOIN memory_items m ON m.id = l.dst
       WHERE l.src = ? AND m.status = 'active'
       ORDER BY l.score DESC LIMIT ?`,
    )
    .all(String(id || ''), clamp(limit, 1, 50));
  return rows.map((row) => ({ ...rowToItem(row), score: Number(row.score) || 0 }));
}

function graph({ project, limit = 80 } = {}) {
  const raw = requireReady();
  const max = clamp(limit, 5, 300);
  const items = list({ status: 'active', project, limit: max });
  const ids = new Set(items.map((i) => i.id));
  const edges = [];
  const rows = raw.prepare('SELECT src, dst, rel, score FROM memory_links WHERE src < dst ORDER BY score DESC').all();
  for (const row of rows) {
    if (!ids.has(row.src) || !ids.has(row.dst)) continue;
    edges.push({ source: row.src, target: row.dst, rel: row.rel, score: Number(row.score) || 0 });
    if (edges.length >= max * 2) break;
  }
  return {
    nodes: items.map((i) => ({ id: i.id, kind: i.kind, text: i.text, project: i.project, pinned: i.pinned })),
    edges,
  };
}

/* ---------------------------------- search -------------------------------- */

function search(query, opts = {}) {
  const raw = requireReady();
  sweep();
  const limit = clamp(opts.limit ?? 10, 1, 100);
  const q = normText(query);
  if (!q) return list({ ...opts, limit });
  const qTokens = tokenSet(q);
  const qVec = embedText(q);
  const fts = ftsScores(q);

  const where = ["status = 'active'"];
  const params = [];
  if (opts.kind) {
    where.push('kind = ?');
    params.push(normalizeKind(opts.kind));
  }
  if (opts.project !== undefined && opts.project !== null) {
    where.push("COALESCE(project, '') = ?");
    params.push(normalizeProject(opts.project));
  }
  const rows = raw.prepare(`SELECT * FROM memory_items WHERE ${where.join(' AND ')}`).all(...params);

  const scored = [];
  for (const row of rows) {
    const tags = parseJson(row.tags, []);
    const vec = parseVector(row.embedding) || embedText(row.text);
    const cos = cosine(qVec, vec);
    const f = fts.get(row.id) || 0;
    const overlap = jaccard(qTokens, tokenSet(`${row.text} ${tags.join(' ')}`));
    if (f === 0 && cos < 0.12 && overlap === 0) continue;
    const recency = Math.max(0, 1 - (now() - Number(row.updated_at)) / (30 * DAY));
    const importance = clamp(Number(row.importance) || 0, 0, 1);
    let score = 0.45 * f + 0.3 * cos + 0.15 * importance + 0.1 * recency;
    if (tags.some((tag) => qTokens.has(String(tag).toLowerCase()))) score += 0.08;
    if (row.pinned) score += 0.12;
    scored.push({
      ...rowToItem(row),
      score: round(score),
      fts: round(f),
      cosine: round(cos),
      overlap: round(overlap),
    });
  }
  scored.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
  const out = scored.slice(0, limit);
  touch(out.map((h) => h.id));
  return out;
}

/* --------------------------------- profile -------------------------------- */

const PROFILE_KEYS = ['name', 'role', 'language', 'timezone', 'locations', 'notes'];

function getProfile() {
  const rows = requireReady().prepare('SELECT key, value, updated_at FROM memory_profile').all();
  const out = { updatedAt: null };
  for (const key of PROFILE_KEYS) out[key] = '';
  for (const row of rows) {
    out[row.key] = parseJson(row.value, row.value);
    out.updatedAt = Math.max(out.updatedAt || 0, Number(row.updated_at) || 0) || null;
  }
  return out;
}

function saveProfile(patch = {}) {
  const raw = requireReady();
  const saved = {};
  for (const key of PROFILE_KEYS) {
    if (!(key in patch)) continue;
    const value = String(patch[key] ?? '').replace(/\s+/g, ' ').trim().slice(0, key === 'notes' ? 2000 : 200);
    raw
      .prepare(
        `INSERT INTO memory_profile(key, value, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), now());
    saved[key] = value;
  }
  return { ...getProfile(), ...saved };
}

/* ------------------------------ agent context ----------------------------- */

function context({ goal = '', project, limit = 6, maxChars = 2400 } = {}) {
  try {
    const profile = getProfile();
    const profileLines = [];
    if (profile.name) profileLines.push(`Name: ${profile.name}`);
    if (profile.role) profileLines.push(`Role: ${profile.role}`);
    if (profile.language) profileLines.push(`Language: ${profile.language}`);
    if (profile.timezone) profileLines.push(`Timezone: ${profile.timezone}`);
    if (profile.locations) profileLines.push(`Locations: ${profile.locations}`);
    if (profile.notes) profileLines.push(`Notes: ${profile.notes}`);

    const hits = goal ? search(goal, { limit, project }) : list({ status: 'active', project, limit });
    const seen = new Set();
    const picked = [];
    for (const hit of hits) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      picked.push(hit);
    }
    const pinned = list({ status: 'active', project, pinned: true, limit: 3 });
    for (const pin of pinned) {
      if (seen.has(pin.id)) continue;
      seen.add(pin.id);
      picked.push(pin);
    }
    if (!profileLines.length && !picked.length) return '';

    const lines = [];
    if (profileLines.length) lines.push(`User profile:\n${profileLines.map((l) => `- ${l}`).join('\n')}`);
    if (picked.length) {
      lines.push(
        `Relevant memories ([M#] ids match the Memory inspector):\n${picked
          .map((item, i) => {
            const meta = [item.kind, item.project || 'general'].filter(Boolean).join(', ');
            return `[M${i + 1}] (${meta}) ${item.text}`;
          })
          .join('\n')}`,
      );
    }
    let text = lines.join('\n\n');
    if (text.length > maxChars) text = `${text.slice(0, maxChars - 20).trimEnd()}\n… (truncated)`;
    touch(picked.map((p) => p.id));
    return text;
  } catch {
    return '';
  }
}

/* ----------------------------------- RAG ---------------------------------- */

function getGateway() {
  return 'gateway' in ctx ? ctx.gateway : require('./model-gateway.cjs');
}

function extractiveAnswer(hits) {
  if (!hits.length) return 'No memories matched this question.';
  const body = hits.map((hit, i) => `[M${i + 1}] ${hit.text}`).join('\n');
  return `Matched ${hits.length} memory item${hits.length === 1 ? '' : 's'} (extractive — no model configured):\n\n${body}`;
}

async function ask({ question, candidates, project, limit = 8, signal } = {}) {
  const q = normText(question);
  if (!q) throw new Error('Ask a question first.');
  const hits = search(q, { limit: clamp(limit, 1, 20), project }).filter((h) => h.status === 'active');
  const citations = hits.map((hit, i) => ({
    n: i + 1,
    id: hit.id,
    kind: hit.kind,
    text: hit.text,
    score: hit.score,
  }));

  if (!hits.length) {
    return {
      question: q,
      answer: 'No stored memories matched this question. Add or import memories first.',
      mode: 'empty',
      provider: null,
      citations: [],
      hits: [],
    };
  }

  const usable = Array.isArray(candidates) && candidates.length > 0;
  const gateway = getGateway();
  let warning = null;
  if (usable && gateway && typeof gateway.chat === 'function') {
    const numbered = hits
      .map((hit, i) => `[M${i + 1}] (${hit.kind}${hit.project ? `, ${hit.project}` : ''}) ${hit.text}`)
      .join('\n');
    try {
      const result = await gateway.chat({
        candidates,
        task: 'memory',
        system:
          'You answer questions using ONLY the numbered long-term memories provided. ' +
          'Cite every claim with its memory id in square brackets, e.g. [M1]. ' +
          'If the memories do not contain the answer, say exactly what is missing instead of guessing. ' +
          'Keep the answer short and direct.',
        history: [{ role: 'user', text: `Question: ${q}\n\nMemories:\n${numbered}` }],
        maxTokens: 900,
        temperature: 0.2,
        signal,
      });
      const text = String((result && result.text) || '').trim();
      if (!text) throw new Error('The model returned an empty answer.');
      if (!/\[M\d+\]/.test(text)) warning = 'The model did not cite a memory — verify the answer against the list below.';
      return {
        question: q,
        answer: text,
        mode: 'llm',
        provider: result.provider || null,
        model: result.model || null,
        citations,
        hits,
        warning,
      };
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.name === 'TypeError')) throw err;
      warning = `Model answer failed (${err && err.message ? err.message : String(err)}). Showing matched memories instead.`;
    }
  }

  return {
    question: q,
    answer: extractiveAnswer(hits),
    mode: 'extractive',
    provider: null,
    citations,
    hits,
    warning,
  };
}

/* ------------------------------ legacy import ----------------------------- */

function importLegacy(file) {
  if (!file) return { imported: 0, skipped: 0 };
  let text = '';
  let stat = null;
  try {
    stat = fs.statSync(file);
    if (!stat.size) return { imported: 0, skipped: 0 };
    const marker = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    if (db.getSetting('memory.legacyImported') === marker) return { imported: 0, skipped: 0, unchanged: true };
    text = fs.readFileSync(file, 'utf8');
    let imported = 0;
    let skipped = 0;
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*[-*]\s*(?:\d{4}-\d{2}-\d{2}\s*[—–-]\s*)?(.+)$/);
      if (!match) continue;
      const note = normText(match[1]);
      if (!note) continue;
      if (findActiveByText(note)) {
        skipped += 1;
        continue;
      }
      add({ text: note, kind: 'legacy', source: 'legacy', project: 'general', importance: 0.6 });
      imported += 1;
    }
    db.setSetting('memory.legacyImported', marker);
    return { imported, skipped };
  } catch {
    return { imported: 0, skipped: 0 };
  }
}

/* ---------------------------------- stats --------------------------------- */

/** Privacy control: removes every memory row, index, link, conflict and profile. */
function clearAll() {
  const raw = requireReady();
  const counts = {
    items: raw.prepare('SELECT COUNT(*) AS c FROM memory_items').get().c,
    links: raw.prepare('SELECT COUNT(*) AS c FROM memory_links').get().c,
    conflicts: raw.prepare('SELECT COUNT(*) AS c FROM memory_conflicts').get().c,
    profile: raw.prepare('SELECT COUNT(*) AS c FROM memory_profile').get().c,
  };
  raw.exec('DELETE FROM memory_fts; DELETE FROM memory_links; DELETE FROM memory_conflicts; DELETE FROM memory_profile; DELETE FROM memory_items;');
  return counts;
}

function stats() {
  const raw = requireReady();
  sweep();
  const rows = raw.prepare('SELECT kind, status, project, pinned, expires_at, updated_at FROM memory_items').all();
  const summary = {
    total: rows.length,
    active: 0,
    pinned: 0,
    superseded: 0,
    archived: 0,
    expired: 0,
    expiring: 0,
    projects: [],
    kinds: [],
    lastUpdated: null,
    conflicts: raw.prepare("SELECT COUNT(*) AS c FROM memory_conflicts WHERE status = 'open'").get().c,
    links: raw.prepare('SELECT COUNT(*) AS c FROM memory_links WHERE src < dst').get().c,
  };
  const projects = new Map();
  const kinds = new Map();
  const horizon = now() + 7 * DAY;
  for (const row of rows) {
    const status = row.status || 'active';
    if (status === 'active') {
      summary.active += 1;
      if (row.pinned) summary.pinned += 1;
      if (row.expires_at && row.expires_at > now() && row.expires_at <= horizon) summary.expiring += 1;
    } else if (status === 'superseded') summary.superseded += 1;
    else if (status === 'archived') summary.archived += 1;
    else if (status === 'expired') summary.expired += 1;
    if (status === 'active') {
      const project = row.project || 'general';
      projects.set(project, (projects.get(project) || 0) + 1);
      kinds.set(row.kind, (kinds.get(row.kind) || 0) + 1);
    }
    summary.lastUpdated = Math.max(summary.lastUpdated || 0, Number(row.updated_at) || 0) || null;
  }
  summary.projects = [...projects.entries()].map(([project, count]) => ({ project, count })).sort((a, b) => b.count - a.count);
  summary.kinds = [...kinds.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
  return summary;
}

module.exports = {
  init,
  info,
  KINDS,
  add,
  get,
  list,
  update,
  remove,
  search,
  stats,
  sweep,
  conflicts,
  resolveConflict,
  links,
  graph,
  getProfile,
  saveProfile,
  context,
  ask,
  importLegacy,
  clearAll,
  embed: embedText,
  _internals: { words, tokenSet, jaccard, cosine, ftsQuery },
};
