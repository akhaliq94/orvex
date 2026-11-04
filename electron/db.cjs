'use strict';

/**
 * Single SQLite database for ORVEX state: usage/cost, routing, conversations,
 * memory (FTS5), runs, workflows, jobs, tasks, audit, assets, prompts, evals.
 * better-sqlite3 is a native module built for Electron's ABI.
 */

const path = require('node:path');
const fs = require('node:fs');

let Database = null;
let db = null;
let dbFile = null;
let lastError = null;

try {
  Database = require('better-sqlite3');
} catch (err) {
  lastError = err && err.message ? err.message : String(err);
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  run_id TEXT,
  task TEXT,
  provider_id TEXT,
  provider_name TEXT,
  model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT
);
CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
CREATE INDEX IF NOT EXISTS usage_model ON usage(model);
CREATE INDEX IF NOT EXISTS usage_run ON usage(run_id);

CREATE TABLE IF NOT EXISTS provider_health (
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  opened_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model)
);

CREATE TABLE IF NOT EXISTS routing (
  task TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  agent_id TEXT,
  provider_id TEXT,
  model TEXT,
  tags TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, at);

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'fact',
  text TEXT NOT NULL,
  tags TEXT,
  importance REAL NOT NULL DEFAULT 0.5,
  source TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS memory_kind ON memory_items(kind);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  id UNINDEXED,
  text,
  tags
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  goal TEXT,
  status TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  agent_id TEXT,
  steps INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  summary TEXT,
  checkpoint TEXT
);
CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);

CREATE TABLE IF NOT EXISTS run_steps (
  run_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  id TEXT,
  title TEXT,
  goal TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  output TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  PRIMARY KEY (run_id, idx)
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  graph TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  log TEXT,
  checkpoint TEXT
);
CREATE INDEX IF NOT EXISTS workflow_runs_wf ON workflow_runs(workflow_id, started_at);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  spec TEXT NOT NULL,
  schedule TEXT,
  next_run_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  last_status TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_next ON jobs(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workflow_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  input TEXT,
  output TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, priority);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tool TEXT,
  args TEXT,
  ok INTEGER,
  ms INTEGER,
  error TEXT,
  run_id TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  meta TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evals (
  id TEXT PRIMARY KEY,
  suite TEXT NOT NULL,
  case_id TEXT,
  ok INTEGER NOT NULL,
  score REAL,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
  ts INTEGER PRIMARY KEY,
  cpu REAL,
  mem REAL,
  disk REAL,
  gpu REAL,
  net_in REAL,
  net_out REAL,
  app_procs INTEGER,
  app_cpu REAL,
  app_mem_mb REAL,
  uptime_sec INTEGER
);

CREATE TABLE IF NOT EXISTS eval_suites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cases TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS crashes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  pid INTEGER,
  started_at INTEGER,
  session_id TEXT,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS adv_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  prompt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS adv_sessions (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  rounds INTEGER NOT NULL DEFAULT 0,
  agents TEXT,
  model TEXT,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS adv_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent TEXT,
  role TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 1,
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS adv_messages_session ON adv_messages(session_id, id);

CREATE TABLE IF NOT EXISTS adv_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  condition TEXT NOT NULL,
  action TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  cooldown_sec INTEGER NOT NULL DEFAULT 900,
  last_fired INTEGER,
  fired_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS adv_rule_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS adv_rule_events_rule ON adv_rule_events(rule_id, at);

CREATE TABLE IF NOT EXISTS adv_jobs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  spec TEXT NOT NULL,
  status TEXT NOT NULL,
  checkpoint INTEGER NOT NULL DEFAULT 0,
  results TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS adv_selfevals (
  id TEXT PRIMARY KEY,
  goal TEXT,
  output TEXT NOT NULL,
  criteria TEXT,
  score REAL,
  detail TEXT,
  model TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS adv_route_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  provider_id TEXT,
  model TEXT,
  ok INTEGER NOT NULL,
  ms INTEGER,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS adv_route_task ON adv_route_outcomes(task, at);

CREATE TABLE IF NOT EXISTS adv_learning (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  detail TEXT,
  support INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'suggested',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(kind, key)
);

CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  parent_run_id TEXT,
  child_run_id TEXT,
  agent TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  resumed_as TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS delegations_status ON delegations(status, created_at);

CREATE TABLE IF NOT EXISTS adv_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  token TEXT,
  paired_at INTEGER,
  last_seen INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS adv_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  direction TEXT NOT NULL,
  device TEXT,
  items TEXT,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT
);

CREATE TABLE IF NOT EXISTS adv_plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  dir TEXT NOT NULL,
  manifest TEXT NOT NULL,
  source TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS adv_market_cache (
  url TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  items TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS adv_a2a_tasks (
  id TEXT PRIMARY KEY,
  context_id TEXT,
  direction TEXT NOT NULL,
  peer TEXT,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS adv_a2a_tasks_created ON adv_a2a_tasks(direction, created_at);

CREATE TABLE IF NOT EXISTS adv_a2a_peers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS train_episodes (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  kind TEXT NOT NULL DEFAULT 'agent',
  goal TEXT,
  status TEXT NOT NULL DEFAULT 'done',
  score REAL,
  provider TEXT,
  model TEXT,
  steps INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  plan TEXT,
  actions TEXT,
  outcome TEXT,
  error TEXT,
  file TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS train_episodes_created ON train_episodes(created_at);
CREATE INDEX IF NOT EXISTS train_episodes_kind ON train_episodes(kind, status);

CREATE TABLE IF NOT EXISTS train_datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'sft',
  format TEXT NOT NULL DEFAULT 'jsonl',
  path TEXT,
  items INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  meta TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS train_evals (
  id TEXT PRIMARY KEY,
  suite TEXT NOT NULL,
  name TEXT NOT NULL,
  cases TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS train_eval_runs (
  id TEXT PRIMARY KEY,
  suite TEXT NOT NULL,
  model TEXT,
  baseline TEXT,
  score REAL,
  passed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS train_eval_runs_suite ON train_eval_runs(suite, created_at);

CREATE TABLE IF NOT EXISTS train_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  status TEXT NOT NULL DEFAULT 'suggested',
  body TEXT NOT NULL,
  support INTEGER NOT NULL DEFAULT 0,
  score REAL,
  source TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS train_models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'general',
  format TEXT NOT NULL DEFAULT 'gguf',
  path TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  meta TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS train_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  budget TEXT,
  usage TEXT,
  log TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS train_runs_started ON train_runs(started_at);
CREATE TABLE IF NOT EXISTS wf_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator',
  mission TEXT NOT NULL,
  model TEXT,
  schedule TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  budget_usd REAL NOT NULL DEFAULT 0,
  spent_usd REAL NOT NULL DEFAULT 0,
  runs INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER,
  next_run_at INTEGER,
  memory TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS wf_agents_due ON wf_agents(status, next_run_at);

CREATE TABLE IF NOT EXISTS wf_shifts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  trigger TEXT NOT NULL DEFAULT 'manual',
  run_id TEXT,
  summary TEXT,
  error TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  steps INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS wf_shifts_agent ON wf_shifts(agent_id, started_at);
CREATE INDEX IF NOT EXISTS wf_shifts_status ON wf_shifts(status);

CREATE TABLE IF NOT EXISTS wf_inbox (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  shift_id TEXT,
  kind TEXT NOT NULL DEFAULT 'report',
  title TEXT NOT NULL,
  body TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS wf_inbox_created ON wf_inbox(created_at);

CREATE TABLE IF NOT EXISTS brain_models (
  path TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  name TEXT,
  size INTEGER DEFAULT 0,
  mtime INTEGER DEFAULT 0,
  sha256 TEXT,
  arch TEXT,
  params REAL,
  block_count INTEGER,
  context_length INTEGER,
  embedding_length INTEGER,
  head_count INTEGER,
  head_count_kv INTEGER,
  file_type INTEGER,
  quant TEXT,
  meta TEXT,
  updated_at INTEGER NOT NULL
);
`;

function init(opts = {}) {
  if (db) return db;
  if (!Database) {
    lastError = lastError || 'better-sqlite3 is not available in this runtime';
    return null;
  }
  const file = opts.file || path.join(opts.dataDir || process.cwd(), 'orvex.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  dbFile = file;
  db.exec(SCHEMA);
  // Databases created before per-agent run history existed need the column.
  const runCols = db.prepare('PRAGMA table_info(runs)').all().map((c) => c.name);
  if (!runCols.includes('agent_id')) db.exec('ALTER TABLE runs ADD COLUMN agent_id TEXT');
  return db;
}

function requireDb() {
  if (!db) throw new Error(`Database is not ready${lastError ? ` — ${lastError}` : ''}.`);
  return db;
}

function now() {
  return Date.now();
}

function getSetting(key, fallback = null) {
  try {
    const row = requireDb().prepare('SELECT value FROM settings WHERE key = ?').get(String(key));
    if (!row) return fallback;
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

function setSetting(key, value) {
  requireDb()
    .prepare(
      `INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(String(key), JSON.stringify(value), now());
  return value;
}

function recordUsage(row) {
  if (!db) return null;
  const at = Number(row.ts) || now();
  const info = db
    .prepare(
      `INSERT INTO usage(ts, run_id, task, provider_id, provider_name, model,
         prompt_tokens, completion_tokens, total_tokens, cost_usd, estimated, ms, ok, error)
       VALUES(@ts, @runId, @task, @providerId, @providerName, @model,
         @promptTokens, @completionTokens, @totalTokens, @costUsd, @estimated, @ms, @ok, @error)`,
    )
    .run({
      ts: at,
      runId: row.runId || null,
      task: row.task || null,
      providerId: row.providerId || null,
      providerName: row.providerName || null,
      model: row.model || null,
      promptTokens: Math.max(0, Math.round(Number(row.promptTokens) || 0)),
      completionTokens: Math.max(0, Math.round(Number(row.completionTokens) || 0)),
      totalTokens: Math.max(0, Math.round(Number(row.totalTokens) || 0)),
      costUsd: Math.max(0, Number(row.costUsd) || 0),
      estimated: row.estimated ? 1 : 0,
      ms: Math.max(0, Math.round(Number(row.ms) || 0)),
      ok: row.ok === false ? 0 : 1,
      error: row.error || null,
    });
  return info.lastInsertRowid;
}

function usageSummary({ sinceMs = 24 * 3600 * 1000 } = {}) {
  if (!db) return null;
  const since = now() - Number(sinceMs || 0);
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens,
              COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(estimated),0) AS estimated,
              COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END),0) AS failures,
              COALESCE(AVG(ms),0) AS avgMs
       FROM usage WHERE ts >= ?`,
    )
    .get(since);
  const byModel = db
    .prepare(
      `SELECT provider_name AS provider, model, COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens),0) AS promptTokens,
              COALESCE(SUM(completion_tokens),0) AS completionTokens,
              COALESCE(SUM(total_tokens),0) AS tokens,
              COALESCE(SUM(cost_usd),0) AS cost,
              COALESCE(SUM(estimated),0) AS estimated
       FROM usage WHERE ts >= ? GROUP BY provider_name, model ORDER BY cost DESC, calls DESC LIMIT 25`,
    )
    .all(since);
  const byTask = db
    .prepare(
      `SELECT COALESCE(task,'unspecified') AS task, COUNT(*) AS calls,
              COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost
       FROM usage WHERE ts >= ? GROUP BY task ORDER BY calls DESC`,
    )
    .all(since);
  return { since: new Date(since).toISOString(), totals, byModel, byTask };
}

/** Total spend since an absolute timestamp — used by the daily budget guard. */
function usageCostSince(ts) {
  if (!db) return 0;
  const row = db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS cost FROM usage WHERE ts >= ?').get(Number(ts) || 0);
  return Number(row && row.cost) || 0;
}

function usageRecent(limit = 50) {
  if (!db) return [];
  const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
  return db
    .prepare(
      `SELECT id, ts, run_id AS runId, task, provider_name AS provider, model,
              prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
              total_tokens AS tokens, cost_usd AS cost, estimated, ms, ok, error
       FROM usage ORDER BY id DESC LIMIT ?`,
    )
    .all(n);
}

function clearUsage() {
  requireDb().prepare('DELETE FROM usage').run();
  return { cleared: true };
}

function setRouting(task, chain) {
  requireDb()
    .prepare(
      `INSERT INTO routing(task, chain, updated_at) VALUES(?, ?, ?)
       ON CONFLICT(task) DO UPDATE SET chain = excluded.chain, updated_at = excluded.updated_at`,
    )
    .run(String(task), JSON.stringify(Array.isArray(chain) ? chain : []), now());
  return getRouting();
}

function getRouting() {
  if (!db) return {};
  const rows = db.prepare('SELECT task, chain FROM routing').all();
  const out = {};
  for (const row of rows) {
    try {
      out[row.task] = JSON.parse(row.chain);
    } catch {
      out[row.task] = [];
    }
  }
  return out;
}

function healthGet(providerId, model) {
  if (!db) return null;
  return (
    db
      .prepare('SELECT failures, opened_until AS openedUntil, last_error AS lastError FROM provider_health WHERE provider_id = ? AND model = ?')
      .get(String(providerId || ''), String(model || '')) || null
  );
}

function healthSet(providerId, model, { failures = 0, openedUntil = 0, lastError = null } = {}) {
  if (!db) return;
  db.prepare(
    `INSERT INTO provider_health(provider_id, model, failures, opened_until, last_error, updated_at)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_id, model) DO UPDATE SET
       failures = excluded.failures, opened_until = excluded.opened_until,
       last_error = excluded.last_error, updated_at = excluded.updated_at`,
  ).run(String(providerId || ''), String(model || ''), failures, openedUntil, lastError, now());
}

function healthResetAll() {
  if (!db) return;
  db.prepare('DELETE FROM provider_health').run();
}

function audit(row) {
  if (!db) return;
  try {
    db.prepare(
      'INSERT INTO audit(ts, kind, tool, args, ok, ms, error, run_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      Number(row.ts) || now(),
      String(row.kind || 'event'),
      row.tool || null,
      row.args ? String(row.args).slice(0, 2000) : null,
      row.ok === undefined ? null : row.ok ? 1 : 0,
      row.ms === undefined ? null : Math.round(Number(row.ms) || 0),
      row.error ? String(row.error).slice(0, 2000) : null,
      row.runId || null,
    );
  } catch {
    /* auditing must never break a run */
  }
}

function auditTail(limit = 120) {
  if (!db) return [];
  const n = Math.min(Math.max(Number(limit) || 120, 1), 1000);
  return db
    .prepare(
      `SELECT ts, kind, tool, args, ok, ms, error, run_id AS runId
       FROM audit ORDER BY id DESC LIMIT ?`,
    )
    .all(n);
}

function runGet(runId) {
  if (!db) return null;
  const row = db
    .prepare(
      `SELECT id, goal, status, model, provider, steps, started_at AS startedAt,
              ended_at AS endedAt, summary, checkpoint
       FROM runs WHERE id = ?`,
    )
    .get(String(runId));
  if (!row) return null;
  let checkpoint = null;
  try {
    checkpoint = row.checkpoint ? JSON.parse(row.checkpoint) : null;
  } catch {
    checkpoint = null;
  }
  return { ...row, checkpoint };
}

function runsRecent(limit = 20) {
  if (!db) return [];
  const n = Math.min(Math.max(Number(limit) || 20, 1), 200);
  return db
    .prepare(
      `SELECT id, goal, status, model, provider, agent_id AS agentId, steps, started_at AS startedAt,
              ended_at AS endedAt, summary
       FROM runs ORDER BY started_at DESC LIMIT ?`,
    )
    .all(n);
}

/**
 * A process only starts with no engine running, so any run still marked
 * running or paused belongs to a previous session. Marking them interrupted
 * keeps the history truthful and makes them visible to recovery.
 */
function runsMarkStale(at = now()) {
  if (!db) return { runs: 0, steps: 0 };
  try {
    const runs = db
      .prepare(
        `UPDATE runs SET status = 'interrupted', ended_at = COALESCE(ended_at, ?),
                summary = COALESCE(summary, 'Interrupted when ORVEX closed before the run finished.')
         WHERE status IN ('running', 'paused')`,
      )
      .run(at);
    const steps = db
      .prepare(`UPDATE run_steps SET status = 'interrupted', ended_at = COALESCE(ended_at, ?) WHERE status = 'running'`)
      .run(at);
    return { runs: runs.changes || 0, steps: steps.changes || 0 };
  } catch {
    return { runs: 0, steps: 0 };
  }
}

/** Runs that were interrupted while unfinished — resumable when a plan was saved. */
function runsUnfinished(limit = 20) {
  if (!db) return [];
  const n = Math.min(Math.max(Number(limit) || 20, 1), 200);
  return db
    .prepare(
      `SELECT id, goal, status, steps, started_at AS startedAt, ended_at AS endedAt, summary, checkpoint
       FROM runs WHERE status IN ('running', 'paused', 'failed', 'interrupted') AND checkpoint IS NOT NULL
       ORDER BY started_at DESC LIMIT ?`,
    )
    .all(n)
    .map((row) => {
      let checkpoint = null;
      try {
        checkpoint = row.checkpoint ? JSON.parse(row.checkpoint) : null;
      } catch {
        checkpoint = null;
      }
      return { ...row, checkpoint };
    });
}

function runSaveCheckpoint(runId, checkpoint) {
  if (!db) return;
  try {
    db.prepare('UPDATE runs SET checkpoint = ? WHERE id = ?').run(
      checkpoint === null || checkpoint === undefined ? null : JSON.stringify(checkpoint),
      String(runId),
    );
  } catch {
    /* best-effort */
  }
}

function runStepsGet(runId) {
  if (!db) return [];
  return db
    .prepare(
      `SELECT idx, id, title, goal, status, output, attempts, error,
              started_at AS startedAt, ended_at AS endedAt
       FROM run_steps WHERE run_id = ? ORDER BY idx`,
    )
    .all(String(runId));
}

function runStepUpsert(runId, step = {}) {
  if (!db) return;
  try {
    db.prepare(
      `INSERT INTO run_steps(run_id, idx, id, title, goal, status, output, attempts, error, started_at, ended_at)
       VALUES(@runId, @idx, @id, @title, @goal, @status, @output, @attempts, @error, @startedAt, @endedAt)
       ON CONFLICT(run_id, idx) DO UPDATE SET
         id = excluded.id, title = excluded.title, goal = excluded.goal,
         status = excluded.status, output = excluded.output, attempts = excluded.attempts,
         error = excluded.error, started_at = excluded.started_at, ended_at = excluded.ended_at`,
    ).run({
      runId: String(runId),
      idx: Math.max(0, Math.round(Number(step.idx) || 0)),
      id: step.id ? String(step.id) : null,
      title: step.title ? String(step.title).slice(0, 300) : null,
      goal: step.goal ? String(step.goal).slice(0, 4000) : null,
      status: String(step.status || 'pending'),
      output: step.output === undefined || step.output === null ? null : String(step.output).slice(0, 8000),
      attempts: Math.max(0, Math.round(Number(step.attempts) || 0)),
      error: step.error ? String(step.error).slice(0, 2000) : null,
      startedAt: Number(step.startedAt) || null,
      endedAt: Number(step.endedAt) || null,
    });
  } catch {
    /* best-effort */
  }
}

function info() {
  return { ready: !!db, file: dbFile, error: lastError };
}

function delegationSave(row = {}) {
  if (!db) return;
  try {
    const stamp = now();
    db.prepare(
      `INSERT INTO delegations(id, parent_run_id, child_run_id, agent, goal, status, result, error, created_at, updated_at, ended_at)
       VALUES(@id, @parentRunId, @childRunId, @agent, @goal, @status, @result, @error, @createdAt, @updatedAt, @endedAt)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status, result = excluded.result, error = excluded.error,
         resumed_as = COALESCE(delegations.resumed_as, excluded.resumed_as),
         updated_at = excluded.updated_at, ended_at = excluded.ended_at`,
    ).run({
      id: String(row.id),
      parentRunId: row.parentRunId ? String(row.parentRunId) : null,
      childRunId: row.childRunId ? String(row.childRunId) : null,
      agent: String(row.agent || 'worker').slice(0, 80),
      goal: String(row.goal || '').slice(0, 4000),
      status: String(row.status || 'running'),
      result: row.result === undefined || row.result === null ? null : String(row.result).slice(0, 8000),
      error: row.error ? String(row.error).slice(0, 4000) : null,
      createdAt: Number(row.createdAt) || stamp,
      updatedAt: stamp,
      endedAt: Number(row.endedAt) || null,
    });
  } catch {
    /* durability is best-effort; the live task map remains authoritative */
  }
}

function delegationMarkResumed(id, resumedAs) {
  if (!db) return;
  try {
    db.prepare('UPDATE delegations SET resumed_as = ?, updated_at = ? WHERE id = ?').run(
      resumedAs ? String(resumedAs) : null,
      now(),
      String(id),
    );
  } catch {
    /* best-effort */
  }
}

function delegationGet(id) {
  if (!db) return null;
  const row = db
    .prepare(
      `SELECT id, parent_run_id AS parentRunId, child_run_id AS childRunId, agent, goal, status,
              result, error, resumed_as AS resumedAs, created_at AS createdAt,
              updated_at AS updatedAt, ended_at AS endedAt
       FROM delegations WHERE id = ?`,
    )
    .get(String(id));
  return row || null;
}

function delegationsRecent(limit = 50) {
  if (!db) return [];
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return db
    .prepare(
      `SELECT id, parent_run_id AS parentRunId, child_run_id AS childRunId, agent, goal, status,
              result, error, resumed_as AS resumedAs, created_at AS createdAt,
              updated_at AS updatedAt, ended_at AS endedAt
       FROM delegations ORDER BY created_at DESC LIMIT ?`,
    )
    .all(n);
}

/** A fresh process cannot resume in-flight children, so mark them honestly. */
function delegationsInterruptOpen(reason = 'ORVEX stopped before this sub-agent finished.') {
  if (!db) return 0;
  try {
    const info = db
      .prepare(
        `UPDATE delegations SET status = 'interrupted', error = ?, updated_at = ?, ended_at = ?
         WHERE status = 'running'`,
      )
      .run(String(reason).slice(0, 4000), now(), now());
    return info.changes || 0;
  } catch {
    return 0;
  }
}

function delegationPrune(keep = 200) {
  if (!db) return 0;
  try {
    const info = db
      .prepare(
        `DELETE FROM delegations WHERE id NOT IN (
           SELECT id FROM delegations ORDER BY created_at DESC LIMIT ?
         )`,
      )
      .run(Math.min(Math.max(Number(keep) || 200, 20), 1000));
    return info.changes || 0;
  } catch {
    return 0;
  }
}


function close() {
  if (db) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  db = null;
}

module.exports = {
  init,
  info,
  close,
  now,
  getSetting,
  setSetting,
  recordUsage,
  usageSummary,
  usageRecent,
  usageCostSince,
  clearUsage,
  setRouting,
  getRouting,
  healthGet,
  healthSet,
  healthResetAll,
  audit,
  auditTail,
  runGet,
  runsRecent,
  runsMarkStale,
  runsUnfinished,
  runSaveCheckpoint,
  runStepsGet,
  runStepUpsert,
  delegationSave,
  delegationMarkResumed,
  delegationGet,
  delegationsRecent,
  delegationsInterruptOpen,
  delegationPrune,
  raw: () => db,
};
