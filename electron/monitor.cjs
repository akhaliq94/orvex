'use strict';

/**
 * Section 15 — monitoring.
 *
 * Everything below reports real machine or real ORVEX state:
 *   - hardware samples (CPU/RAM/disk/GPU) persisted to SQLite for history charts
 *   - network throughput from the OS counters
 *   - ORVEX's own process footprint from Electron's app metrics
 *   - token/cost usage straight from the usage table
 *   - a trace timeline merged from runs, steps, tool audit rows and model calls
 *   - model comparison that performs live calls through the model gateway
 *   - an eval engine that executes cases and scores the real replies
 *   - health probes over the database, disk, encryption, providers and backups
 *   - crash detection from a session marker plus resumable run discovery
 *
 * Nothing is simulated: when a value cannot be read it is reported as null or
 * as an explicit failure, never invented.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');

const db = require('./db.cjs');

const SAMPLE_MS = 15_000;
const METRICS_RETENTION_MS = 7 * 24 * 3600 * 1000;
const EVAL_RETENTION = 5000;
const MAX_COMPARE = 5;
const MAX_EVAL_CASES = 25;
const MAX_EVAL_CANDIDATES = 3;

let ctx = {
  dataDir: process.cwd(),
  dbFile: null,
  metrics: null,
  appMetrics: null,
  gateway: null,
  securityState: null,
  workflowsState: null,
  backups: null,
  vaultAvailable: null,
  version: null,
};

let timer = null;
let samplerBusy = false;
let lastNet = null;
let lastSample = null;
let lastPrunedAt = 0;
let sessionFile = null;
let sessionId = null;
let startedAt = Date.now();

/* ----------------------------------------------------------------- helpers */

const round = (n, digits = 2) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 10 ** digits) / 10 ** digits : null);

function raw() {
  return db.raw();
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function iso(ts) {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* ------------------------------------------------------- session / crashes */

function sessionMarkerPath() {
  return path.join(ctx.dataDir, 'monitor-session.json');
}

function detectPreviousSession() {
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  } catch {
    previous = null;
  }
  if (previous && previous.sessionId) {
    safe(() =>
      raw()
        ?.prepare('INSERT INTO crashes(at, pid, started_at, session_id, reason) VALUES(?, ?, ?, ?, ?)')
        .run(Date.now(), Number(previous.pid) || null, Number(previous.startedAt) || null, String(previous.sessionId), 'The previous ORVEX session ended without a clean shutdown.'),
    );
    safe(() => raw()?.prepare('DELETE FROM crashes WHERE id NOT IN (SELECT id FROM crashes ORDER BY id DESC LIMIT 100)').run());
  }
  try {
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({ sessionId, pid: process.pid, startedAt, version: ctx.version ? safe(() => ctx.version(), null) : null }),
      'utf8',
    );
  } catch {
    /* a read-only profile still runs — only crash detection is lost */
  }
}

function crashes(limit = 10) {
  const rows = safe(
    () =>
      raw()
        ?.prepare('SELECT id, at, pid, started_at AS startedAt, session_id AS sessionId, reason FROM crashes ORDER BY id DESC LIMIT ?')
        .all(clampNumber(limit, 1, 100, 10)),
    [],
  ) || [];
  return rows.map((row) => ({ ...row, atIso: iso(row.at) }));
}

function clearCrashes() {
  const deleted = safe(() => raw()?.prepare('DELETE FROM crashes').run().changes || 0, 0);
  return { removed: deleted };
}

/* -------------------------------------------------------------- sampling */

function readNetBytes() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$s = Get-NetAdapterStatistics -ErrorAction SilentlyContinue | Where-Object { $null -ne $_.ReceivedBytes }; if ($s) { $r = ($s | Measure-Object -Property ReceivedBytes -Sum).Sum; $t = ($s | Measure-Object -Property SentBytes -Sum).Sum; Write-Output "$r,$t" }',
        ],
        { timeout: 15000, windowsHide: true },
        (err, stdout) => {
          const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
          const [rx, tx] = line.split(',').map(Number);
          if (err || !Number.isFinite(rx) || !Number.isFinite(tx)) return resolve(null);
          resolve({ rx, tx });
        },
      );
      return;
    }
    fsp
      .readFile('/proc/net/dev', 'utf8')
      .then((text) => {
        let rx = 0;
        let tx = 0;
        for (const line of text.split('\n').slice(2)) {
          const [name, rest] = line.split(':');
          if (!rest || String(name || '').trim() === 'lo') continue;
          const parts = rest.trim().split(/\s+/).map(Number);
          rx += parts[0] || 0;
          tx += parts[8] || 0;
        }
        resolve({ rx, tx });
      })
      .catch(() => resolve(null));
  });
}

function appFootprint() {
  const list = safe(() => ctx.appMetrics?.() || [], []);
  let cpu = 0;
  let memKb = 0;
  for (const metric of list) {
    const usage = metric && metric.cpu ? Number(metric.cpu.percentCPUUsage) : 0;
    const mem = metric && metric.memory ? Number(metric.memory.workingSetSize) : 0;
    if (Number.isFinite(usage)) cpu += usage;
    if (Number.isFinite(mem)) memKb += mem;
  }
  return {
    processes: list.length,
    cpu: round(cpu),
    memMB: round(memKb / 1024, 1),
    detail: list.map((metric) => ({
      pid: metric.pid,
      type: metric.type || 'process',
      cpu: round(metric.cpu ? metric.cpu.percentCPUUsage : null),
      memMB: round(metric.memory ? Number(metric.memory.workingSetSize) / 1024 : null, 1),
    })),
  };
}

/**
 * One sample: hardware metrics, ORVEX footprint and network bytes/sec.
 * The first network read only establishes a baseline, so the rate is null
 * until a second sample exists — no made-up zero.
 */
async function sampleOnce() {
  if (samplerBusy) return lastSample;
  if (!ctx.metrics) return null;
  samplerBusy = true;
  try {
    const netPromise = readNetBytes();
    let metrics = null;
    try {
      metrics = await ctx.metrics();
    } catch {
      metrics = null;
    }
    if (!metrics || metrics.ok === false) return lastSample;
    const at = Date.now();
    const net = await netPromise;
    let netIn = null;
    let netOut = null;
    if (net && lastNet && at > lastNet.at) {
      const seconds = (at - lastNet.at) / 1000;
      if (seconds >= 1) {
        netIn = round(Math.max(0, (net.rx - lastNet.rx) / seconds), 1);
        netOut = round(Math.max(0, (net.tx - lastNet.tx) / seconds), 1);
      }
    }
    if (net) lastNet = { ...net, at };
    const app = appFootprint();
    const sample = {
      ts: at,
      cpu: round(metrics.cpuPercent),
      mem: round(metrics.memory ? metrics.memory.percent : null),
      disk: round(metrics.disk ? metrics.disk.percent : null),
      gpu: metrics.gpu && metrics.gpu.available ? round(metrics.gpu.percent) : null,
      netIn,
      netOut,
      appProcs: app.processes,
      appCpu: app.cpu,
      appMemMB: app.memMB,
      uptimeSec: Math.round(Number(metrics.uptimeSec) || os.uptime()),
      memoryUsed: metrics.memory ? metrics.memory.used : null,
      memoryTotal: metrics.memory ? metrics.memory.total : null,
      diskFree: metrics.disk ? metrics.disk.free : null,
      diskTotal: metrics.disk ? metrics.disk.total : null,
    };
    lastSample = sample;
    const store = raw();
    if (store) {
      safe(() =>
        store
          .prepare(
            `INSERT OR REPLACE INTO metrics(ts, cpu, mem, disk, gpu, net_in, net_out, app_procs, app_cpu, app_mem_mb, uptime_sec)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(sample.ts, sample.cpu, sample.mem, sample.disk, sample.gpu, sample.netIn, sample.netOut, sample.appProcs, sample.appCpu, sample.appMemMB, sample.uptimeSec),
      );
      if (at - lastPrunedAt > 3600_000) {
        lastPrunedAt = at;
        safe(() => store.prepare('DELETE FROM metrics WHERE ts < ?').run(at - METRICS_RETENTION_MS));
      }
    }
    return sample;
  } finally {
    samplerBusy = false;
  }
}

function bucketFor(minutes) {
  if (minutes <= 60) return 60_000;
  if (minutes <= 360) return 5 * 60_000;
  if (minutes <= 1440) return 15 * 60_000;
  return 60 * 60_000;
}

/** Averaged history for the charts. Buckets land on real sample timestamps. */
function series({ minutes = 60 } = {}) {
  const windowMinutes = clampNumber(minutes, 1, 7 * 24 * 60, 60);
  const bucket = bucketFor(windowMinutes);
  const since = Date.now() - windowMinutes * 60_000;
  const store = raw();
  if (!store) return { minutes: windowMinutes, bucketMs: bucket, points: [] };
  const rows =
    safe(
      () =>
        store
          .prepare(
            `SELECT CAST(ts / ? AS INTEGER) * ? AS t,
                    AVG(cpu) AS cpu, AVG(mem) AS mem, AVG(disk) AS disk, AVG(gpu) AS gpu,
                    AVG(net_in) AS netIn, AVG(net_out) AS netOut,
                    AVG(app_cpu) AS appCpu, AVG(app_mem_mb) AS appMemMB,
                    COUNT(*) AS samples
             FROM metrics WHERE ts >= ?
             GROUP BY t ORDER BY t`,
          )
          .all(bucket, bucket, since),
      [],
    ) || [];
  return {
    minutes: windowMinutes,
    bucketMs: bucket,
    points: rows.map((row) => ({
      t: row.t,
      cpu: round(row.cpu),
      mem: round(row.mem),
      disk: round(row.disk),
      gpu: round(row.gpu),
      netIn: round(row.netIn, 1),
      netOut: round(row.netOut, 1),
      appCpu: round(row.appCpu),
      appMemMB: round(row.appMemMB, 1),
      samples: row.samples,
    })),
  };
}

/* --------------------------------------------------------------- overview */

function usageTotalsSince(ts) {
  const store = raw();
  if (!store) return null;
  return safe(
    () =>
      store
        .prepare(
          `SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens,
                  COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(estimated),0) AS estimated,
                  COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END),0) AS failures,
                  COALESCE(AVG(ms),0) AS avgMs
           FROM usage WHERE ts >= ?`,
        )
        .get(ts),
    null,
  );
}

function overview() {
  const latest =
    lastSample ||
    safe(
      () =>
        raw()
          ?.prepare(
            `SELECT ts, cpu, mem, disk, gpu, net_in AS netIn, net_out AS netOut, app_procs AS appProcs,
                    app_cpu AS appCpu, app_mem_mb AS appMemMB, uptime_sec AS uptimeSec
             FROM metrics ORDER BY ts DESC LIMIT 1`,
          )
          .get(),
      null,
    ) ||
    null;
  const dbInfo = db.info();
  let dbBytes = null;
  if (dbInfo.file) {
    try {
      dbBytes = fs.statSync(dbInfo.file).size;
    } catch {
      dbBytes = null;
    }
  }
  const app = appFootprint();
  const now = Date.now();
  return {
    at: now,
    session: {
      id: sessionId,
      pid: process.pid,
      startedAt,
      uptimeSec: Math.round((now - startedAt) / 1000),
      version: ctx.version ? safe(() => ctx.version(), null) : null,
    },
    latest,
    series: series({ minutes: 60 }),
    app: app.detail,
    appTotals: { processes: app.processes, cpu: app.cpu, memMB: app.memMB },
    today: usageTotalsSince(todayStart()),
    db: { ready: dbInfo.ready, file: dbInfo.file, bytes: dbBytes },
    crashes: crashes(1)[0] || null,
    sampleMs: SAMPLE_MS,
    lastSampleAt: latest ? latest.ts : null,
  };
}

/* ------------------------------------------------------- usage / cost area */

function usageWindow(sinceMs) {
  return clampNumber(sinceMs, 60_000, 30 * 24 * 3600 * 1000, 24 * 3600 * 1000);
}

function usageSeries({ sinceMs = 24 * 3600 * 1000 } = {}) {
  const windowMs = usageWindow(sinceMs);
  const bucket = windowMs <= 6 * 3600_000 ? 5 * 60_000 : windowMs <= 48 * 3600_000 ? 3600_000 : windowMs <= 14 * 24 * 3600_000 ? 6 * 3600_000 : 24 * 3600_000;
  const since = Date.now() - windowMs;
  const store = raw();
  if (!store) return { sinceMs: windowMs, bucketMs: bucket, points: [] };
  const rows =
    safe(
      () =>
        store
          .prepare(
            `SELECT CAST(ts / ? AS INTEGER) * ? AS t, COUNT(*) AS calls,
                    COALESCE(SUM(prompt_tokens),0) AS promptTokens,
                    COALESCE(SUM(completion_tokens),0) AS completionTokens,
                    COALESCE(SUM(total_tokens),0) AS tokens,
                    COALESCE(SUM(cost_usd),0) AS cost,
                    COALESCE(SUM(estimated),0) AS estimated,
                    COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END),0) AS failures,
                    COALESCE(AVG(ms),0) AS avgMs
             FROM usage WHERE ts >= ? GROUP BY t ORDER BY t`,
          )
          .all(bucket, bucket, since),
      [],
    ) || [];
  return {
    sinceMs: windowMs,
    bucketMs: bucket,
    points: rows.map((row) => ({ ...row, at: iso(row.t) })),
  };
}

function byProvider() {
  const store = raw();
  if (!store) return [];
  return (
    safe(
      () =>
        store
          .prepare(
            `SELECT COALESCE(provider_name,'unknown') AS provider, COUNT(*) AS calls,
                    COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost,
                    COALESCE(SUM(estimated),0) AS estimated,
                    COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END),0) AS failures
             FROM usage GROUP BY provider ORDER BY cost DESC, calls DESC`,
          )
          .all(),
      [],
    ) || []
  );
}

function usage(payload = {}) {
  const windowMs = usageWindow(payload && payload.sinceMs);
  const since = Date.now() - windowMs;
  const summary = db.usageSummary({ sinceMs: windowMs }) || { totals: null, byModel: [], byTask: [], since: null };
  const budgetUsd = Number(db.getSetting('budget.dailyUsd', 0)) || 0;
  const todayUsd = db.usageCostSince(todayStart());
  return {
    at: Date.now(),
    windowMs,
    since: iso(since),
    totals: summary.totals,
    byModel: summary.byModel,
    byTask: summary.byTask,
    byProvider: byProvider(),
    series: usageSeries({ sinceMs: windowMs }),
    recent: db.usageRecent(60),
    budget: { dailyUsd: budgetUsd, todayUsd: round(todayUsd, 4), remainingUsd: budgetUsd > 0 ? round(Math.max(0, budgetUsd - todayUsd), 4) : null },
    db: db.info(),
  };
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function usageCsv({ sinceMs = 30 * 24 * 3600 * 1000 } = {}) {
  const windowMs = usageWindow(sinceMs);
  const since = Date.now() - windowMs;
  const store = raw();
  const rows =
    safe(
      () =>
        store
          ?.prepare(
            `SELECT ts, run_id, task, provider_id, provider_name, model, prompt_tokens, completion_tokens,
                    total_tokens, cost_usd, estimated, ms, ok, error
             FROM usage WHERE ts >= ? ORDER BY id ASC LIMIT 10000`,
          )
          .all(since),
      [],
    ) || [];
  const header = ['timestamp', 'run_id', 'task', 'provider_id', 'provider_name', 'model', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'cost_usd', 'estimated', 'ms', 'ok', 'error'];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        iso(row.ts),
        row.run_id,
        row.task,
        row.provider_id,
        row.provider_name,
        row.model,
        row.prompt_tokens,
        row.completion_tokens,
        row.total_tokens,
        row.cost_usd,
        row.estimated ? 1 : 0,
        row.ms,
        row.ok ? 1 : 0,
        row.error,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return { sinceMs: windowMs, rows: rows.length, csv: lines.join('\n'), name: `orvex-usage-${new Date().toISOString().slice(0, 10)}.csv` };
}

/* ----------------------------------------------------------------- traces */

function traces({ limit = 30 } = {}) {
  const store = raw();
  if (!store) return { runs: [], limit: 0 };
  const n = clampNumber(limit, 1, 200, 30);
  const runs =
    safe(
      () =>
        store
          .prepare(
            `SELECT r.id, r.goal, r.status, r.model, r.provider, r.agent_id AS agentId,
                    r.steps, r.started_at AS startedAt, r.ended_at AS endedAt, r.summary,
                    (SELECT COUNT(*) FROM run_steps s WHERE s.run_id = r.id) AS stepCount,
                    (SELECT COUNT(*) FROM audit a WHERE a.run_id = r.id) AS toolCalls,
                    (SELECT COUNT(*) FROM usage u WHERE u.run_id = r.id) AS modelCalls,
                    (SELECT COALESCE(SUM(u.total_tokens),0) FROM usage u WHERE u.run_id = r.id) AS tokens,
                    (SELECT COALESCE(SUM(u.cost_usd),0) FROM usage u WHERE u.run_id = r.id) AS cost,
                    (SELECT COALESCE(SUM(CASE WHEN u.ok = 0 THEN 1 ELSE 0 END),0) FROM usage u WHERE u.run_id = r.id) AS modelFailures
             FROM runs r ORDER BY r.started_at DESC LIMIT ?`,
          )
          .all(n),
      [],
    ) || [];
  return {
    limit: n,
    runs: runs.map((row) => ({
      ...row,
      startedAtIso: iso(row.startedAt),
      endedAtIso: iso(row.endedAt),
      durationMs: row.endedAt && row.startedAt ? row.endedAt - row.startedAt : row.startedAt ? Date.now() - row.startedAt : null,
    })),
  };
}

function trace({ runId } = {}) {
  const id = String(runId || '').trim();
  if (!id) throw new Error('runId is required.');
  const run = db.runGet(id);
  if (!run) throw new Error('That run was not found in the local history.');
  const steps = db.runStepsGet(id);
  const store = raw();
  const toolRows =
    safe(
      () =>
        store
          ?.prepare('SELECT ts, kind, tool, args, ok, ms, error FROM audit WHERE run_id = ? ORDER BY id ASC')
          .all(id),
      [],
    ) || [];
  const modelRows =
    safe(
      () =>
        store
          ?.prepare(
            `SELECT ts, task, provider_name AS provider, model, prompt_tokens AS promptTokens,
                    completion_tokens AS completionTokens, total_tokens AS tokens, cost_usd AS cost,
                    estimated, ms, ok, error
             FROM usage WHERE run_id = ? ORDER BY id ASC`,
          )
          .all(id),
      [],
    ) || [];

  const spans = [];
  const start = Number(run.startedAt) || Date.now();
  const end = Number(run.endedAt) || Date.now();
  spans.push({
    id: `run:${id}`,
    kind: 'run',
    label: run.goal || 'Run',
    start,
    end,
    ms: end - start,
    ok: run.status !== 'failed' && run.status !== 'stopped',
    detail: `${run.status}${run.model ? ` · ${run.provider || ''} ${run.model}`.trimEnd() : ''}`,
  });
  for (const step of steps) {
    const stepStart = Number(step.startedAt) || start;
    const stepEnd = Number(step.endedAt) || (step.status === 'running' ? Date.now() : stepStart);
    spans.push({
      id: `step:${id}:${step.idx}`,
      kind: 'step',
      label: step.title || `Step ${step.idx + 1}`,
      start: stepStart,
      end: stepEnd,
      ms: Math.max(0, stepEnd - stepStart),
      ok: step.status === 'done' || step.status === 'completed' || step.status === 'skipped' ? true : step.status === 'running' || step.status === 'pending' ? null : false,
      detail: step.status + (step.attempts > 1 ? ` · ${step.attempts} attempts` : '') + (step.error ? ` · ${step.error}` : ''),
      stepIdx: step.idx,
      status: step.status,
    });
  }
  for (const row of toolRows) {
    const spanEnd = Number(row.ts) || Date.now();
    spans.push({
      id: `tool:${spanEnd}:${row.tool || row.kind}`,
      kind: 'tool',
      label: row.tool || row.kind,
      start: spanEnd - (Number(row.ms) || 0),
      end: spanEnd,
      ms: Number(row.ms) || 0,
      ok: row.ok === null || row.ok === undefined ? null : !!row.ok,
      detail: row.error || row.args || '',
    });
  }
  for (const row of modelRows) {
    const spanEnd = Number(row.ts) || Date.now();
    spans.push({
      id: `model:${spanEnd}:${row.model || 'model'}`,
      kind: 'model',
      label: `${row.provider || 'model'} · ${row.model || 'model'}`,
      start: spanEnd - (Number(row.ms) || 0),
      end: spanEnd,
      ms: Number(row.ms) || 0,
      ok: !!row.ok,
      detail: `${row.task || 'call'} · ${row.tokens || 0} tokens${row.cost ? ` · $${Number(row.cost).toFixed(4)}` : ''}${row.error ? ` · ${row.error}` : ''}`,
      tokens: row.tokens,
      cost: row.cost,
      estimated: !!row.estimated,
    });
  }
  spans.sort((a, b) => a.start - b.start || (a.kind === 'run' ? -1 : b.kind === 'run' ? 1 : 0));
  const totals = {
    steps: steps.length,
    tools: toolRows.length,
    models: modelRows.length,
    tokens: modelRows.reduce((sum, row) => sum + (Number(row.tokens) || 0), 0),
    cost: round(modelRows.reduce((sum, row) => sum + (Number(row.cost) || 0), 0), 4),
    toolFailures: toolRows.filter((row) => row.ok === 0).length,
    modelFailures: modelRows.filter((row) => !row.ok).length,
  };
  return { run: { ...run, startedAtIso: iso(run.startedAt), endedAtIso: iso(run.endedAt) }, spans, totals, at: Date.now() };
}

/* --------------------------------------------------------- model compare */

function normalizedCandidates(list) {
  if (!ctx.gateway) throw new Error('The model gateway is not available.');
  const norm = ctx.gateway.normalizeCandidates(list);
  return norm.slice(0, MAX_COMPARE);
}

function timeoutController(ms) {
  const controller = new AbortController();
  const timerRef = setTimeout(() => controller.abort(), ms);
  return { controller, done: () => clearTimeout(timerRef) };
}

async function compare(payload = {}) {
  const prompt = String(payload.prompt || '').trim();
  if (!prompt) throw new Error('Write a prompt to compare.');
  if (prompt.length > 8000) throw new Error('Keep the comparison prompt under 8,000 characters.');
  const candidates = normalizedCandidates(payload.candidates);
  if (candidates.length < 2) throw new Error('Pick at least two configured models to compare.');
  const system = payload.system ? String(payload.system).slice(0, 4000) : undefined;
  const maxTokens = clampNumber(payload.maxTokens, 16, 4000, 600);
  const timeoutMs = clampNumber(payload.timeoutMs, 5000, 180000, 90000);
  const results = [];
  for (const candidate of candidates) {
    const started = Date.now();
    const guard = timeoutController(timeoutMs);
    try {
      const result = await ctx.gateway.chat({
        candidates: [candidate],
        task: 'compare',
        system,
        history: [{ role: 'user', text: prompt }],
        maxTokens,
        temperature: clampNumber(payload.temperature, 0, 2, 0.2),
        signal: guard.controller.signal,
      });
      results.push({
        id: String(candidate.id || candidate.presetId || candidate.baseUrl),
        name: candidate.name || candidate.model,
        model: candidate.model,
        ok: true,
        text: String(result.text || '').slice(0, 8000),
        chars: String(result.text || '').length,
        ms: Date.now() - started,
        usage: result.usage || null,
        provider: result.provider || null,
      });
    } catch (err) {
      const aborted = err && err.name === 'AbortError';
      results.push({
        id: String(candidate.id || candidate.presetId || candidate.baseUrl),
        name: candidate.name || candidate.model,
        model: candidate.model,
        ok: false,
        error: aborted ? `No reply within ${Math.round(timeoutMs / 1000)}s.` : err && err.message ? err.message : String(err),
        ms: Date.now() - started,
      });
    } finally {
      guard.done();
    }
  }
  const out = {
    at: Date.now(),
    prompt,
    system: system || null,
    results,
    summary: {
      candidates: results.length,
      ok: results.filter((row) => row.ok).length,
      failed: results.filter((row) => !row.ok).length,
      fastestMs: results.filter((row) => row.ok).reduce((min, row) => (min == null || row.ms < min ? row.ms : min), null),
      tokens: results.reduce((sum, row) => sum + Number(row.usage && row.usage.totalTokens) || 0, 0),
      cost: round(results.reduce((sum, row) => sum + (Number(row.usage && row.usage.costUsd) || 0), 0), 6),
    },
  };
  try {
    db.setSetting('monitor.lastCompare', out);
  } catch {
    /* storing the last comparison is best-effort */
  }
  return out;
}

/* ------------------------------------------------------------- eval engine */

function extractJson(text) {
  const source = String(text || '').trim();
  try {
    return JSON.parse(source);
  } catch {
    /* try harder below */
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }
  const start = source.search(/[[{]/);
  if (start >= 0) {
    const body = source.slice(start);
    try {
      return JSON.parse(body);
    } catch {
      /* fall through */
    }
    const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
    if (end > 0) {
      try {
        return JSON.parse(body.slice(0, end + 1));
      } catch {
        /* fall through */
      }
    }
  }
  throw new Error('The reply is not valid JSON.');
}

function asStringList(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => String(item)).filter((item) => item.length > 0);
}

/**
 * Scores one reply against a case's checks. Every check is independent so the
 * UI can show exactly which expectation failed.
 */
function evaluateChecks(output, checks = {}, meta = {}) {
  const text = String(output || '');
  const lower = text.toLowerCase();
  const results = [];
  for (const needle of asStringList(checks.contains)) {
    results.push({ name: `contains "${needle}"`, ok: lower.includes(needle.toLowerCase()) });
  }
  for (const needle of asStringList(checks.notContains)) {
    results.push({ name: `does not contain "${needle}"`, ok: !lower.includes(needle.toLowerCase()) });
  }
  for (const pattern of asStringList(checks.regex)) {
    let ok = false;
    let detail = '';
    try {
      ok = new RegExp(pattern, 'i').test(text);
    } catch (err) {
      detail = err && err.message ? err.message : 'invalid pattern';
    }
    results.push({ name: `matches /${pattern}/i`, ok, ...(detail ? { detail } : {}) });
  }
  if (checks.json) {
    try {
      extractJson(text);
      results.push({ name: 'is valid JSON', ok: true });
    } catch (err) {
      results.push({ name: 'is valid JSON', ok: false, detail: err && err.message ? err.message : 'invalid JSON' });
    }
  }
  if (checks.maxMs !== undefined && checks.maxMs !== null) {
    const limit = Number(checks.maxMs);
    const actual = Number(meta.ms);
    if (Number.isFinite(limit) && Number.isFinite(actual)) {
      results.push({ name: `replies within ${limit} ms`, ok: actual <= limit, detail: `${actual} ms` });
    }
  }
  const passed = results.filter((row) => row.ok).length;
  const score = results.length ? round(passed / results.length, 4) : 0;
  return { ok: results.length > 0 && passed === results.length, score, checks: results };
}

function validateCase(rawCase, index) {
  if (!rawCase || typeof rawCase !== 'object') throw new Error(`Case ${index + 1} is not an object.`);
  const prompt = String(rawCase.prompt || '').trim();
  if (!prompt) throw new Error(`Case ${index + 1} has no prompt.`);
  if (prompt.length > 4000) throw new Error(`Case ${index + 1} prompt is longer than 4,000 characters.`);
  const checks = rawCase.checks && typeof rawCase.checks === 'object' ? rawCase.checks : {};
  const normalized = {
    id: String(rawCase.id || `case_${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || `case_${index + 1}`,
    prompt,
    ...(rawCase.system ? { system: String(rawCase.system).slice(0, 4000) } : {}),
    checks: {
      ...(asStringList(checks.contains).length ? { contains: asStringList(checks.contains) } : {}),
      ...(asStringList(checks.notContains).length ? { notContains: asStringList(checks.notContains) } : {}),
      ...(asStringList(checks.regex).length ? { regex: asStringList(checks.regex) } : {}),
      ...(checks.json ? { json: true } : {}),
      ...(checks.maxMs !== undefined && Number.isFinite(Number(checks.maxMs)) ? { maxMs: clampNumber(checks.maxMs, 1, 600000, 60000) } : {}),
    },
  };
  for (const pattern of normalized.checks.regex || []) {
    try {
      new RegExp(pattern, 'i');
    } catch {
      throw new Error(`Case ${index + 1} has an invalid regex: ${pattern}`);
    }
  }
  if (!Object.keys(normalized.checks).length) throw new Error(`Case ${index + 1} has no checks. Add contains, regex, JSON or timing.`);
  return normalized;
}

const STARTER_SUITE = {
  id: 'starter',
  name: 'Starter checks',
  cases: [
    { id: 'json', prompt: 'Reply with ONLY a JSON object: {"status":"ok","count":3}', checks: { json: true, contains: ['"status"'] } },
    { id: 'exact', prompt: 'Reply with exactly the word PONG and nothing else.', checks: { contains: ['PONG'] } },
    { id: 'math', prompt: 'What is 17 * 23? Reply with only the number.', checks: { contains: ['391'], maxMs: 30000 } },
  ],
};

function ensureStarterSuite() {
  const store = raw();
  if (!store) return;
  const count = safe(() => store.prepare('SELECT COUNT(*) AS c FROM eval_suites').get().c, 0) || 0;
  if (count > 0) return;
  const now = Date.now();
  safe(() =>
    store
      .prepare('INSERT OR IGNORE INTO eval_suites(id, name, cases, created_at, updated_at) VALUES(?, ?, ?, ?, ?)')
      .run(STARTER_SUITE.id, STARTER_SUITE.name, JSON.stringify(STARTER_SUITE.cases), now, now),
  );
}

function parseSuiteRow(row) {
  let cases = [];
  try {
    cases = JSON.parse(row.cases);
  } catch {
    cases = [];
  }
  return { id: row.id, name: row.name, cases, createdAt: row.created_at, updatedAt: row.updated_at, caseCount: cases.length };
}

function evalSuites() {
  ensureStarterSuite();
  const rows =
    safe(
      () => raw()?.prepare('SELECT id, name, cases, created_at, updated_at FROM eval_suites ORDER BY updated_at DESC').all(),
      [],
    ) || [];
  return { suites: rows.map(parseSuiteRow), at: Date.now() };
}

function evalSave({ id, name, cases } = {}) {
  const store = raw();
  if (!store) throw new Error('The SQLite store is not available.');
  const list = Array.isArray(cases) ? cases : [];
  if (!list.length) throw new Error('Add at least one case.');
  if (list.length > MAX_EVAL_CASES) throw new Error(`A suite can hold at most ${MAX_EVAL_CASES} cases.`);
  const normalized = list.map((item, index) => validateCase(item, index));
  const seen = new Set();
  for (const item of normalized) {
    if (seen.has(item.id)) item.id = `${item.id}_${seen.size + 1}`;
    seen.add(item.id);
  }
  const title = String(name || '').trim().slice(0, 120);
  if (!title) throw new Error('Give the suite a name.');
  const suiteId = id
    ? String(id)
    : `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'suite'}_${crypto.randomBytes(3).toString('hex')}`;
  const now = Date.now();
  store
    .prepare(
      `INSERT INTO eval_suites(id, name, cases, created_at, updated_at) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, cases = excluded.cases, updated_at = excluded.updated_at`,
    )
    .run(suiteId, title, JSON.stringify(normalized), now, now);
  const row = store.prepare('SELECT id, name, cases, created_at, updated_at FROM eval_suites WHERE id = ?').get(suiteId);
  return parseSuiteRow(row);
}

function evalDelete({ id } = {}) {
  const suiteId = String(id || '').trim();
  if (!suiteId) throw new Error('id is required.');
  const store = raw();
  if (!store) throw new Error('The SQLite store is not available.');
  const info = store.prepare('DELETE FROM eval_suites WHERE id = ?').run(suiteId);
  store.prepare('DELETE FROM evals WHERE suite = ?').run(suiteId);
  return { removed: info.changes || 0, id: suiteId };
}

async function evalRun(payload = {}) {
  const suiteId = String(payload.suiteId || '').trim();
  if (!suiteId) throw new Error('suiteId is required.');
  const store = raw();
  if (!store) throw new Error('The SQLite store is not available.');
  const row = store.prepare('SELECT id, name, cases FROM eval_suites WHERE id = ?').get(suiteId);
  if (!row) throw new Error('That eval suite was not found.');
  let cases = [];
  try {
    cases = JSON.parse(row.cases);
  } catch {
    throw new Error('The suite definition is corrupt.');
  }
  const candidates = normalizedCandidates(payload.candidates);
  if (!candidates.length) throw new Error('Pick a configured model to run the suite.');
  if (candidates.length > MAX_EVAL_CANDIDATES) throw new Error(`Run at most ${MAX_EVAL_CANDIDATES} models at once.`);
  const timeoutMs = clampNumber(payload.timeoutMs, 5000, 180000, 60000);
  const maxTokens = clampNumber(payload.maxTokens, 16, 4000, 500);
  const rows = [];
  const at = Date.now();
  for (const candidate of candidates) {
    for (const testCase of cases) {
      const started = Date.now();
      const guard = timeoutController(timeoutMs);
      const provider = candidate.name || candidate.model;
      try {
        const result = await ctx.gateway.chat({
          candidates: [candidate],
          task: 'eval',
          system: testCase.system || undefined,
          history: [{ role: 'user', text: testCase.prompt }],
          maxTokens,
          temperature: 0,
          signal: guard.controller.signal,
        });
        const ms = Date.now() - started;
        const scored = evaluateChecks(result.text, testCase.checks, { ms });
        const detail = {
          caseId: testCase.id,
          provider,
          model: candidate.model,
          ms,
          checks: scored.checks,
          output: String(result.text || '').slice(0, 4000),
          usage: result.usage || null,
          error: null,
        };
        rows.push({ caseId: testCase.id, ok: scored.ok, score: scored.score, provider, model: candidate.model, ms, detail });
      } catch (err) {
        const aborted = err && err.name === 'AbortError';
        const ms = Date.now() - started;
        rows.push({
          caseId: testCase.id,
          ok: false,
          score: 0,
          provider,
          model: candidate.model,
          ms,
          detail: {
            caseId: testCase.id,
            provider,
            model: candidate.model,
            ms,
            checks: [],
            output: '',
            error: aborted ? `No reply within ${Math.round(timeoutMs / 1000)}s.` : err && err.message ? err.message : String(err),
          },
        });
      } finally {
        guard.done();
      }
    }
  }
  const insert = store.prepare(
    'INSERT INTO evals(id, suite, case_id, ok, score, detail, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
  );
  const write = store.transaction((items) => {
    for (const item of items) {
      insert.run(
        `eval_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
        suiteId,
        item.caseId,
        item.ok ? 1 : 0,
        item.score,
        JSON.stringify(item.detail),
        Date.now(),
      );
    }
  });
  write(rows);
  safe(() =>
    store
      .prepare('DELETE FROM evals WHERE id NOT IN (SELECT id FROM evals ORDER BY id DESC LIMIT ?)')
      .run(EVAL_RETENTION),
  );
  const passed = rows.filter((item) => item.ok).length;
  return {
    suite: { id: row.id, name: row.name },
    at,
    rows: rows.map((item) => ({ ...item, at: iso(Date.now()) })),
    summary: {
      runs: rows.length,
      passed,
      failed: rows.length - passed,
      score: rows.length ? round(rows.reduce((sum, item) => sum + item.score, 0) / rows.length, 4) : 0,
      candidates: candidates.map((candidate) => candidate.name || candidate.model),
      avgMs: rows.length ? Math.round(rows.reduce((sum, item) => sum + item.ms, 0) / rows.length) : 0,
    },
  };
}

function evalHistory({ suite, limit = 100 } = {}) {
  const store = raw();
  if (!store) return { rows: [] };
  const n = clampNumber(limit, 1, 1000, 100);
  const suiteId = suite ? String(suite) : null;
  const rows =
    safe(
      () =>
        (suiteId
          ? store.prepare('SELECT id, suite, case_id AS caseId, ok, score, detail, created_at AS at FROM evals WHERE suite = ? ORDER BY id DESC LIMIT ?').all(suiteId, n)
          : store.prepare('SELECT id, suite, case_id AS caseId, ok, score, detail, created_at AS at FROM evals ORDER BY id DESC LIMIT ?').all(n)),
      [],
    ) || [];
  return {
    rows: rows.map((row) => {
      let detail = null;
      try {
        detail = row.detail ? JSON.parse(row.detail) : null;
      } catch {
        detail = null;
      }
      return { ...row, ok: !!row.ok, detail, atIso: iso(row.at) };
    }),
  };
}

function evalClear({ suite } = {}) {
  const store = raw();
  if (!store) throw new Error('The SQLite store is not available.');
  const info = suite ? store.prepare('DELETE FROM evals WHERE suite = ?').run(String(suite)) : store.prepare('DELETE FROM evals').run();
  return { removed: info.changes || 0 };
}

/* --------------------------------------------------------- health probes */

function check(id, label, status, detail) {
  return { id, label, status, detail };
}

async function health(payload = {}) {
  const checks = [];
  const info = db.info();
  checks.push(
    check(
      'database',
      'SQLite store',
      info.ready ? 'ok' : 'fail',
      info.ready ? `${path.basename(info.file || 'orvex.db')} is open` : info.error || 'The database could not be opened.',
    ),
  );

  try {
    const probe = path.join(ctx.dataDir, '.monitor-write-probe');
    await fsp.writeFile(probe, 'ok', 'utf8');
    await fsp.unlink(probe);
    checks.push(check('data-dir', 'Data folder writable', 'ok', ctx.dataDir));
  } catch (err) {
    checks.push(check('data-dir', 'Data folder writable', 'fail', err && err.message ? err.message : 'The data folder is not writable.'));
  }

  try {
    const stats = await fsp.statfs(ctx.dataDir);
    const total = Number(stats.blocks) * Number(stats.bsize);
    const free = Number(stats.bavail) * Number(stats.bsize);
    const freeGb = free / 1024 ** 3;
    const percent = total ? Math.round(((total - free) / total) * 100) : null;
    checks.push(
      check(
        'disk',
        'Disk space',
        freeGb < 1 ? 'fail' : freeGb < 5 ? 'warn' : 'ok',
        `${freeGb.toFixed(1)} GB free${percent == null ? '' : ` · ${percent}% used`}`,
      ),
    );
  } catch (err) {
    checks.push(check('disk', 'Disk space', 'warn', err && err.message ? err.message : 'Free space could not be read.'));
  }

  const encryptionAvailable = ctx.vaultAvailable ? safe(() => !!ctx.vaultAvailable(), false) : null;
  checks.push(
    check(
      'encryption',
      'Secret encryption',
      encryptionAvailable === null ? 'warn' : encryptionAvailable ? 'ok' : 'fail',
      encryptionAvailable === null ? 'Not probed in this runtime.' : encryptionAvailable ? 'The OS keychain is available for API keys and secrets.' : 'safeStorage is unavailable, so secrets cannot be encrypted at rest.',
    ),
  );

  const candidates = safe(() => normalizedCandidates(payload.candidates), []);
  checks.push(
    check(
      'providers',
      'Model providers',
      candidates.length ? 'ok' : 'warn',
      candidates.length ? `${candidates.length} provider${candidates.length === 1 ? '' : 's'} available: ${candidates.map((c) => c.name || c.model).join(', ')}` : 'No provider is configured in Settings.',
    ),
  );

  const store = raw();
  const breakers =
    safe(
      () =>
        store
          ?.prepare('SELECT provider_id AS providerId, model, failures, opened_until AS openedUntil, last_error AS lastError FROM provider_health')
          .all(),
      [],
    ) || [];
  const open = breakers.filter((row) => Number(row.openedUntil) > Date.now());
  checks.push(
    check(
      'circuits',
      'Provider circuits',
      open.length ? 'warn' : 'ok',
      open.length
        ? `${open.length} circuit${open.length === 1 ? '' : 's'} open: ${open.map((row) => row.model || row.providerId).join(', ')} — paused for 60s after repeated failures.`
        : breakers.length
          ? 'No circuit is open. Historical failures recover automatically.'
          : 'No provider failures recorded.',
    ),
  );

  const since = Date.now() - 24 * 3600_000;
  const calls =
    safe(
      () =>
        store
          ?.prepare(
            `SELECT COUNT(*) AS calls, COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END),0) AS failures,
                    COALESCE(AVG(ms),0) AS avgMs
             FROM usage WHERE ts >= ?`,
          )
          .get(since),
      null,
    ) || { calls: 0, failures: 0, avgMs: 0 };
  checks.push(
    check(
      'model-calls',
      'Model calls · last 24h',
      calls.failures > 0 && calls.failures >= Math.ceil(calls.calls / 2) ? 'warn' : 'ok',
      calls.calls
        ? `${calls.calls} calls · ${calls.failures} failed · ${Math.round(Number(calls.avgMs) || 0)} ms average`
        : 'No model calls in the last 24 hours.',
    ),
  );

  const workflows = ctx.workflowsState ? safe(() => ctx.workflowsState(), null) : null;
  if (workflows && workflows.stats) {
    const stats = workflows.stats;
    checks.push(
      check(
        'workflows',
        'Automation queue',
        stats.interrupted > 0 ? 'warn' : 'ok',
        `${stats.workflows} workflows (${stats.enabled} enabled) · ${stats.running} running · ${stats.queued} queued${stats.interrupted ? ` · ${stats.interrupted} interrupted` : ''}`,
      ),
    );
  } else {
    checks.push(check('workflows', 'Automation queue', 'warn', 'The workflow engine did not answer.'));
  }

  const security = ctx.securityState ? safe(() => ctx.securityState(), null) : null;
  if (security) {
    const issues = [security.locked ? 'locked' : null, security.emergency && security.emergency.stopped ? 'emergency stop active' : null].filter(Boolean);
    checks.push(
      check(
        'security',
        'Security state',
        issues.length ? 'warn' : 'ok',
        `${security.roleLabel || security.role}${security.hasPin ? ' · PIN set' : ' · no PIN'}${issues.length ? ` · ${issues.join(' · ')}` : ''}`,
      ),
    );
  } else {
    checks.push(check('security', 'Security state', 'warn', 'The security layer did not answer.'));
  }

  const backups = ctx.backups ? safe(() => ctx.backups(), null) : null;
  if (Array.isArray(backups)) {
    const latest = backups[0];
    const ageDays = latest && latest.at ? (Date.now() - Number(latest.at)) / 86400_000 : null;
    checks.push(
      check(
        'backups',
        'Backups',
        !backups.length ? 'warn' : ageDays != null && ageDays > 14 ? 'warn' : 'ok',
        !backups.length ? 'No backup exists yet. Create one on Security → Backup.' : `${backups.length} backup${backups.length === 1 ? '' : 's'} · newest ${ageDays == null ? 'unknown age' : `${ageDays.toFixed(1)} days old`}`,
      ),
    );
  } else {
    checks.push(check('backups', 'Backups', 'warn', 'The backup list did not answer.'));
  }

  const lastCrash = crashes(1)[0] || null;
  checks.push(
    check(
      'crashes',
      'Crash recovery',
      lastCrash && Date.now() - Number(lastCrash.at) < 24 * 3600_000 ? 'warn' : 'ok',
      lastCrash ? `Last unexpected shutdown ${iso(lastCrash.at)}` : 'No unexpected shutdowns recorded.',
    ),
  );

  const memoryCount = safe(() => store?.prepare('SELECT COUNT(*) AS c FROM memory_items').get().c || 0, 0);
  checks.push(check('memory', 'Memory store', info.ready ? 'ok' : 'warn', `${memoryCount} memory item${memoryCount === 1 ? '' : 's'}`));

  const summary = {
    ok: checks.filter((row) => row.status === 'ok').length,
    warn: checks.filter((row) => row.status === 'warn').length,
    fail: checks.filter((row) => row.status === 'fail').length,
    total: checks.length,
  };
  return { at: Date.now(), checks, summary };
}

/* --------------------------------------------------------- crash recovery */

function recoverables() {
  const runs = safe(
    () =>
      db.runsUnfinished(20).map((run) => ({
        id: run.id,
        goal: run.goal,
        status: run.status,
        steps: run.steps,
        startedAt: run.startedAt,
        startedAtIso: iso(run.startedAt),
        endedAt: run.endedAt,
        summary: run.summary,
      })),
    [],
  );
  const workflows = safe(() => {
    const state = ctx.workflowsState ? ctx.workflowsState() : null;
    const list = state && Array.isArray(state.runs) ? state.runs : [];
    return list
      .filter((run) => ['running', 'queued', 'awaiting_approval', 'interrupted'].includes(run.status))
      .map((run) => ({
        id: run.id,
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        status: run.status,
        queuedAt: run.queuedAt,
        startedAt: run.startedAt,
        steps: run.steps,
        canResume: run.status === 'interrupted' || run.status === 'awaiting_approval',
      }));
  }, []);
  const crashRows = crashes(10);
  return {
    at: Date.now(),
    runs,
    workflows,
    crashes: crashRows,
    lastCrash: crashRows[0] || null,
    interrupted: runs.length + workflows.length,
  };
}

function abandonRun({ runId } = {}) {
  const id = String(runId || '').trim();
  if (!id) throw new Error('runId is required.');
  const store = raw();
  if (!store) throw new Error('The SQLite store is not available.');
  const run = store.prepare('SELECT id, status FROM runs WHERE id = ?').get(id);
  if (!run) throw new Error('That run was not found.');
  store.prepare("UPDATE runs SET status = 'abandoned', ended_at = ? WHERE id = ?").run(Date.now(), id);
  store.prepare("UPDATE run_steps SET status = 'abandoned' WHERE run_id = ? AND status IN ('pending', 'running')").run(id);
  return { id, status: 'abandoned', at: Date.now() };
}

/* ------------------------------------------------------------ lifecycle */

function init(options = {}) {
  ctx = { ...ctx, ...options };
  startedAt = Date.now();
  sessionId = ctx.sessionId || `sess_${crypto.randomBytes(5).toString('hex')}`;
  sessionFile = sessionMarkerPath();
  try {
    fs.mkdirSync(ctx.dataDir, { recursive: true });
  } catch {
    /* the app already created it */
  }
  db.init({ file: ctx.dbFile || path.join(ctx.dataDir, 'orvex.db') });
  detectPreviousSession();
  ensureStarterSuite();
  lastPrunedAt = Date.now();
  safe(() => raw()?.prepare('DELETE FROM metrics WHERE ts < ?').run(Date.now() - METRICS_RETENTION_MS));
  lastSample = series({ minutes: 1 }).points.length
    ? safe(
        () =>
          raw()
            ?.prepare(
              `SELECT ts, cpu, mem, disk, gpu, net_in AS netIn, net_out AS netOut, app_procs AS appProcs,
                      app_cpu AS appCpu, app_mem_mb AS appMemMB, uptime_sec AS uptimeSec
               FROM metrics ORDER BY ts DESC LIMIT 1`,
            )
            .get(),
        null,
      )
    : null;
  return { dataDir: ctx.dataDir, sessionId, sampleMs: SAMPLE_MS };
}

function start() {
  if (timer) return { running: true };
  const tick = () => {
    void sampleOnce().catch(() => {});
  };
  timer = setInterval(tick, SAMPLE_MS);
  timer.unref?.();
  setTimeout(tick, 2000).unref?.();
  return { running: true, sampleMs: SAMPLE_MS };
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  return { running: false };
}

function shutdown() {
  stop();
  try {
    fs.rmSync(sessionFile, { force: true });
  } catch {
    /* best-effort */
  }
}

module.exports = {
  init,
  start,
  stop,
  shutdown,
  sampleOnce,
  overview,
  series,
  usage,
  usageSeries,
  usageCsv,
  traces,
  trace,
  compare,
  health,
  recoverables,
  abandonRun,
  crashes,
  clearCrashes,
  evalSuites,
  evalSave,
  evalDelete,
  evalRun,
  evalHistory,
  evalClear,
  evaluateChecks,
  SAMPLE_MS,
  _internals: { extractJson, validateCase, readNetBytes, appFootprint, bucketFor, csvCell },
};
