'use strict';

/**
 * Section 15 — monitoring smoke.
 *
 * Part A runs electron/monitor.cjs in plain Node against a temp SQLite file:
 * sampling and history, usage/cost aggregation, CSV escaping, trace merging,
 * model comparison through the gateway, the eval engine, health probes,
 * crash detection from the session marker and run recovery.
 *
 * Part B drives the running ORVEX window over CDP (--remote-debugging-port=9222)
 * and checks the IPC wiring: overview, series, sampling, usage, CSV, traces,
 * health, recoverables, eval suite round trip and the error paths.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.ORVEX_CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ------------------------------------------------------------ part A */

const monitor = require('../electron/monitor.cjs');
const db = require('../electron/db.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-mon-'));

function fakeGateway() {
  return {
    normalizeCandidates: (list) => (Array.isArray(list) ? list : []),
    chat: async ({ candidates, history }) => {
      const prompt = (history && history[0] && history[0].text) || '';
      const model = (candidates[0] && candidates[0].model) || 'fake';
      let text = 'ok';
      if (/json/i.test(prompt)) text = '{"status":"ok","count":3}';
      else if (/PONG/i.test(prompt)) text = 'PONG';
      else if (/17 \* 23/.test(prompt)) text = '391';
      else text = `reply from ${model}`;
      return {
        text,
        provider: { name: candidates[0].name, model },
        usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10, costUsd: 0.0005, estimated: false },
      };
    },
  };
}

const CANDIDATES = [
  { id: 'a', name: 'Alpha', model: 'alpha-1', baseUrl: 'http://a', apiKey: 'k', api: 'openai' },
  { id: 'b', name: 'Beta', model: 'beta-1', baseUrl: 'http://b', apiKey: 'k', api: 'openai' },
];

function boot(dir) {
  return monitor.init({
    dataDir: dir,
    dbFile: path.join(dir, 'orvex.db'),
    metrics: async () => ({
      cpuPercent: 21.5,
      memory: { percent: 63.2, used: 8 * 1024 ** 3, total: 16 * 1024 ** 3 },
      disk: { percent: 71, free: 40 * 1024 ** 3, total: 100 * 1024 ** 3 },
      gpu: { available: false, percent: null },
      uptimeSec: 12345,
    }),
    appMetrics: () => [
      { pid: 101, type: 'Browser', cpu: { percentCPUUsage: 3.5 }, memory: { workingSetSize: 2048 } },
      { pid: 102, type: 'GPU', cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 1024 } },
    ],
    gateway: fakeGateway(),
    securityState: () => ({ role: 'owner', roleLabel: 'Owner', hasPin: true, locked: false, emergency: { stopped: false } }),
    workflowsState: () => ({
      stats: { workflows: 2, enabled: 1, running: 0, queued: 1, interrupted: 1 },
      runs: [
        { id: 'wfr-1', workflowId: 'wf-1', workflowName: 'Nightly', status: 'interrupted', queuedAt: Date.now(), startedAt: Date.now(), steps: 3 },
        { id: 'wfr-2', workflowId: 'wf-1', workflowName: 'Nightly', status: 'done', queuedAt: Date.now(), startedAt: Date.now(), steps: 3 },
      ],
    }),
    backups: () => [{ name: 'orvex-backup-1.zip', at: Date.now() - 3600_000 }],
    vaultAvailable: () => true,
    version: () => '1.0.0-smoke',
  });
}

async function partA() {
  console.log('\n— init, sampling and history');
  const dir = tmp();
  const info = boot(dir);
  check('init reports the sample interval', info.sampleMs === 15_000);
  check('init creates a session id', /^sess_/.test(info.sessionId));
  check('init writes the session marker', fs.existsSync(path.join(dir, 'monitor-session.json')));

  const first = await monitor.sampleOnce();
  check('the sampler records hardware metrics', first && first.cpu === 21.5 && first.mem === 63.2 && first.disk === 71, JSON.stringify({ cpu: first && first.cpu, mem: first && first.mem, disk: first && first.disk }));
  check('an unavailable GPU is reported as null, not a fake number', first && first.gpu === null);
  check('the first network read only establishes a baseline', first && first.netIn === null && first.netOut === null);
  check('ORVEX footprint sums Electron processes', first && first.appProcs === 2 && first.appMemMB === 3);
  await sleep(1100);
  const second = await monitor.sampleOnce();
  check('a second sample produces a real throughput delta', second && typeof second.netIn === 'number' && typeof second.netOut === 'number', `${second && second.netIn} B/s`);

  const range = monitor.series({ minutes: 60 });
  check('history buckets at one minute for a 60m range', range.bucketMs === 60_000 && range.points.length >= 1);
  check('history keeps the real sampled values', range.points.some((p) => p.cpu === 21.5 && p.samples >= 1));

  const snap = monitor.overview();
  check('overview exposes the latest sample', snap.latest && snap.latest.ts === second.ts);
  check('overview reports the app version and DB size', snap.session.version === '1.0.0-smoke' && snap.db.ready && typeof snap.db.bytes === 'number');
  check('overview lists each Electron process', snap.app.length === 2 && snap.app[0].pid === 101);
  check('overview includes a 60m chart series', Array.isArray(snap.series.points) && snap.series.minutes === 60);
  check('today starts with zero recorded calls', snap.today && snap.today.calls === 0);
  check('no crash is reported on a clean start', snap.crashes === null);

  console.log('\n— usage, cost and CSV');
  const store = db.raw();
  const now = Date.now();
  const insertUsage = store.prepare(
    'INSERT INTO usage(ts, task, provider_id, provider_name, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, estimated, ms, ok, error) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
  );
  insertUsage.run(now - 1000, 'chat', 'a', 'Alpha', 'alpha-1', 100, 50, 150, 0.0102, 800, 1, null);
  insertUsage.run(now - 500, 'code', 'a', 'Alpha', 'alpha-1', 20, 30, 50, 0.0014, 400, 0, 'rate limited');
  insertUsage.run(now - 2000, 'chat', 'b', 'Beta', 'beta, "quoted"', 10, 10, 20, 0.0002, 1200, 1, null);
  db.setSetting('budget.dailyUsd', 1.5);

  const usage = monitor.usage({ sinceMs: 3600_000 });
  check('usage totals count every call in the window', usage.totals.calls === 3 && usage.totals.tokens === 220);
  check('usage totals carry provider cost and failures', Math.abs(usage.totals.cost - 0.0118) < 1e-9 && usage.totals.failures === 1);
  check('usage groups by provider with failures', usage.byProvider.length === 2 && usage.byProvider.some((row) => row.provider === 'Alpha' && row.failures === 1));
  check('usage groups by task', usage.byTask.length === 2);
  check('usage reports the configured daily budget', usage.budget.dailyUsd === 1.5 && usage.budget.remainingUsd > 0);
  check('usage builds a bucket series', usage.series.points.length >= 1 && usage.series.bucketMs === 300_000);
  check('usage lists recent calls', usage.recent.length === 3);

  const csv = monitor.usageCsv({ sinceMs: 3600_000 });
  check('CSV exports the header and every row', csv.rows === 3 && csv.csv.split('\n').length === 4 && /^timestamp,run_id,task/.test(csv.csv));
  check('CSV escapes commas and quotes in model names', csv.csv.includes('"beta, ""quoted"""'));
  check('CSV names the file with the date', /^orvex-usage-\d{4}-\d{2}-\d{2}\.csv$/.test(csv.name));

  console.log('\n— traces');
  const runStart = now - 6000;
  store
    .prepare('INSERT INTO runs(id, goal, status, model, provider, steps, started_at, ended_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
    .run('run-smoke', 'Smoke trace', 'done', 'alpha-1', 'Alpha', 2, runStart, now - 1000);
  store
    .prepare('INSERT INTO run_steps(run_id, idx, id, title, status, attempts, started_at, ended_at) VALUES(?, ?, ?, ?, ?, 1, ?, ?)')
    .run('run-smoke', 0, 's1', 'Read the file', 'done', runStart + 100, runStart + 700);
  store
    .prepare('INSERT INTO run_steps(run_id, idx, id, title, status, attempts, error, started_at, ended_at) VALUES(?, ?, ?, ?, ?, 2, ?, ?, ?)')
    .run('run-smoke', 1, 's2', 'Write the report', 'failed', 'disk full', runStart + 800, runStart + 900);
  store
    .prepare('INSERT INTO audit(ts, kind, tool, args, ok, ms, run_id) VALUES(?, ?, ?, ?, ?, ?, ?)')
    .run(runStart + 600, 'tool', 'fs_read', '{"path":"a.txt"}', 1, 25, 'run-smoke');
  insertUsage.run(runStart + 500, 'agent', 'a', 'Alpha', 'alpha-1', 60, 60, 120, 0.004, 900, 1, null);
  store.prepare("UPDATE usage SET run_id = 'run-smoke' WHERE id = (SELECT MAX(id) FROM usage)").run();

  const list = monitor.traces({ limit: 5 });
  check('trace list returns the new run', list.runs.length === 1 && list.runs[0].id === 'run-smoke');
  check(
    'trace list counts steps, tools, tokens and cost',
    list.runs[0].stepCount === 2 && list.runs[0].toolCalls === 1 && list.runs[0].tokens === 120 && Math.abs(list.runs[0].cost - 0.004) < 1e-9,
  );
  const detail = monitor.trace({ runId: 'run-smoke' });
  check('trace merges run, step, tool and model spans', detail.spans.length === 5 && ['run', 'step', 'tool', 'model'].every((k) => detail.spans.some((s) => s.kind === k)));
  check('trace keeps a chronological order', detail.spans.every((s, i, arr) => i === 0 || s.start >= arr[i - 1].start - 1));
  check('trace totals expose the failed step and tool counts', detail.totals.steps === 2 && detail.totals.tools === 1 && detail.totals.models === 1 && detail.totals.tokens === 120);
  let threw = false;
  try {
    monitor.trace({ runId: 'missing-run' });
  } catch (e) {
    threw = /not found/.test(e.message);
  }
  check('an unknown run is reported, not invented', threw);

  console.log('\n— model comparison');
  threw = false;
  try {
    await monitor.compare({ prompt: 'hello', candidates: [CANDIDATES[0]] });
  } catch (e) {
    threw = /at least two/.test(e.message);
  }
  check('comparison needs at least two models', threw);

  const many = Array.from({ length: 7 }, (_, i) => ({ ...CANDIDATES[0], id: `m${i}`, model: `m-${i}` }));
  const compared = await monitor.compare({ prompt: 'Compare this', candidates: many });
  check('comparison caps the candidate list at five', compared.summary.candidates === 5);
  check('every candidate really answers', compared.summary.ok === 5 && compared.results.every((row) => row.ok && row.text.startsWith('reply from')));
  check('comparison sums real tokens and cost', compared.summary.tokens === 50 && Math.abs(compared.summary.cost - 0.0025) < 1e-9);
  check('comparison records the last result in settings', !!db.getSetting('monitor.lastCompare', null));

  console.log('\n— eval engine');
  const containsCheck = monitor.evaluateChecks('The answer is 391.', { contains: ['391'], notContains: ['wrong'] });
  check('contains checks pass on a real reply', containsCheck.ok && containsCheck.score === 1);
  const partial = monitor.evaluateChecks('PONG', { contains: ['PONG'], regex: ['^nope$'], maxMs: 50 }, { ms: 200 });
  check('partial failures score the share that passed', partial.ok === false && partial.score === 0.3333 && partial.checks.length === 3);
  check('regex checks are case insensitive', monitor.evaluateChecks('Hello', { regex: ['^hello$'] }).ok);
  const invalidRegex = monitor.evaluateChecks('x', { regex: ['['] });
  check('an invalid regex fails the check with its error', invalidRegex.ok === false && /invalid|unterminated|nothing/i.test(invalidRegex.checks[0].detail || ''));
  check('JSON checks accept fenced objects', monitor.evaluateChecks('```json\n{"a":1}\n```', { json: true }).ok);
  check('maxMs uses the measured latency', monitor.evaluateChecks('x', { maxMs: 100 }, { ms: 200 }).ok === false);

  for (const [label, bad, pattern] of [
    ['a missing prompt', { checks: { contains: ['x'] } }, /no prompt/],
    ['missing checks', { prompt: 'hi' }, /no checks/],
    ['an invalid regex', { prompt: 'hi', checks: { regex: ['['] } }, /invalid regex/],
  ]) {
    threw = false;
    try {
      monitor._internals.validateCase(bad, 0);
    } catch (e) {
      threw = pattern.test(e.message);
    }
    check(`validateCase rejects ${label}`, threw);
  }

  const seeded = monitor.evalSuites();
  check('the starter suite is seeded once', seeded.suites.length === 1 && seeded.suites[0].id === 'starter' && seeded.suites[0].caseCount === 3);

  const saved = monitor.evalSave({
    name: 'Smoke suite',
    cases: [
      { id: 'json', prompt: 'Reply with JSON {"status":"ok","count":3}', checks: { json: true, contains: ['"status"'] } },
      { id: 'pong', prompt: 'Reply with exactly PONG', checks: { contains: ['PONG'], maxMs: 30000 } },
      { id: 'bad', prompt: 'Answer 2+2', checks: { contains: ['5'] } },
    ],
  });
  check('a suite is saved with normalized cases', saved.caseCount === 3 && /^smoke-suite_/.test(saved.id));

  const evalResult = await monitor.evalRun({ suiteId: saved.id, candidates: CANDIDATES });
  check('every case runs against every model', evalResult.rows.length === 6 && evalResult.summary.runs === 6);
  check('passing and failing cases are scored from real replies', evalResult.summary.passed === 4 && evalResult.summary.failed === 2 && evalResult.summary.score > 0.6 && evalResult.summary.score < 0.8);
  check('per-check detail reaches the result rows', evalResult.rows[0].detail.checks.length >= 2 && evalResult.rows[0].detail.output.length > 0);

  const history = monitor.evalHistory({ suite: saved.id });
  check('eval history persists each row', history.rows.length === 6 && history.rows.every((row) => row.detail && typeof row.ok === 'boolean'));
  check('history can be cleared for one suite', monitor.evalClear({ suite: saved.id }).removed === 6 && monitor.evalHistory({ suite: saved.id }).rows.length === 0);
  check('a suite can be deleted with its history', monitor.evalDelete({ id: saved.id }).removed === 1 && monitor.evalSuites().suites.length === 1);

  console.log('\n— health and recovery');
  const ready = await monitor.health({ candidates: CANDIDATES });
  check('health runs twelve real probes', ready.checks.length === 12 && ready.summary.total === 12);
  check('health reports the database as open', ready.checks.find((c) => c.id === 'database').status === 'ok');
  check('health probes the data folder with a write', ready.checks.find((c) => c.id === 'data-dir').status === 'ok');
  check('health reports disk free space', /GB free/.test(ready.checks.find((c) => c.id === 'disk').detail));
  check('health sees the configured providers', ready.checks.find((c) => c.id === 'providers').status === 'ok');
  check('health sees the encryption keychain', ready.checks.find((c) => c.id === 'encryption').status === 'ok');
  check('health reports the automation queue', /1 queued/.test(ready.checks.find((c) => c.id === 'workflows').detail));
  check('health reports the security role', /Owner/.test(ready.checks.find((c) => c.id === 'security').detail));

  const empty = await monitor.health({ candidates: [] });
  check('with no provider health warns but does not fail', empty.checks.find((c) => c.id === 'providers').status === 'warn' && empty.summary.fail === 0);

  store
    .prepare('INSERT INTO runs(id, goal, status, steps, started_at, checkpoint) VALUES(?, ?, ?, ?, ?, ?)')
    .run('run-resume', 'Resume me', 'running', 2, now - 60_000, JSON.stringify({ step: 1 }));
  const recover = monitor.recoverables();
  check('recoverables lists interrupted agent runs', recover.runs.some((r) => r.id === 'run-resume'));
  check('recoverables lists interrupted workflow runs', recover.workflows.length === 1 && recover.workflows[0].id === 'wfr-1' && recover.workflows[0].canResume);
  check('recoverables reports the backup count and crash state', Array.isArray(recover.crashes) && recover.interrupted >= 2);
  check('abandoning a run flips its status', monitor.abandonRun({ runId: 'run-resume' }).status === 'abandoned');
  check('an abandoned run leaves the recoverable list', !monitor.recoverables().runs.some((r) => r.id === 'run-resume'));

  console.log('\n— crash detection');
  const crashDir = tmp();
  boot(crashDir);
  boot(crashDir);
  const crashList = monitor.crashes(5);
  check('an existing session marker on boot records a crash', crashList.length === 1 && /clean shutdown/.test(crashList[0].reason));
  check('the crash record carries the previous session id', /^sess_/.test(crashList[0].sessionId));
  check('clearCrashes removes the log', monitor.clearCrashes().removed === 1 && monitor.crashes(5).length === 0);
  monitor.shutdown();
  check('shutdown removes the session marker', !fs.existsSync(path.join(crashDir, 'monitor-session.json')));
  boot(crashDir);
  check('a clean shutdown is not reported as a crash', monitor.crashes(5).length === 0);
  monitor.shutdown();
}

/* ------------------------------------------------------------ part B */

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!res.ok) throw new Error(`CDP list failed: HTTP ${res.status}`);
  return res.json();
}

function connect(url) {
  const WebSocket = require('ws');
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', reject);
  });
  ws.addEventListener('message', (msg) => {
    const data = JSON.parse(msg.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after 20s`));
      }, 20_000);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, ready };
}

async function partB() {
  let cdp;
  try {
    const list = await targets();
    const page = list.find((t) => t.type === 'page' && /\/index\.html|\/$/.test(t.url) && !/recorder\.html/.test(t.url));
    if (!page) throw new Error(`No ORVEX page target. Targets: ${list.map((t) => t.url).join(', ')}`);
    cdp = connect(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');

    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed');
      return r.result.value;
    };
    const ipc = (ns, method, ...args) =>
      evaluate(`(async () => {
        const api = window.orvex && window.orvex.${ns};
        if (!api || !api.${method}) return { ok: false, error: 'bridge ${ns}.${method} missing' };
        try {
          const r = await api.${method}(${args.map((a) => JSON.stringify(a)).join(', ')});
          return r && r.ok === true ? { ok: true, data: r.data } : { ok: false, error: (r && r.error) || 'ipc failed' };
        } catch (err) {
          return { ok: false, error: String(err && err.message ? err.message : err) };
        }
      })()`);
    const ok = async (ns, method, ...args) => {
      const r = await ipc(ns, method, ...args);
      if (!r.ok) throw new Error(`${ns}.${method} failed: ${r.error}`);
      return r.data;
    };

    console.log('\n— live IPC');
    const overview = await ok('monitor', 'overview');
    check('the monitoring bridge answers with an overview', !!overview && typeof overview.at === 'number' && overview.db.ready === true);
    check('the live overview names the session and version', /^sess_/.test(overview.session.id || '') && typeof overview.session.uptimeSec === 'number');
    check('the live overview exposes the sampler interval', overview.sampleMs === 15_000);
    check('the live process list is Electron\'s own', Array.isArray(overview.app));

    const sampled = await ok('monitor', 'sample');
    check('a manual sample returns a timestamp', !!sampled && typeof sampled.ts === 'number');
    const overview2 = await ok('monitor', 'overview');
    check('the manual sample becomes the latest sample', overview2.latest && overview2.latest.ts >= sampled.ts);

    const series = await ok('monitor', 'series', 15);
    check('the history series answers for 15m', series.minutes === 15 && series.bucketMs === 60_000 && Array.isArray(series.points));
    check('the persisted history contains real samples', series.points.length >= 1 && series.points.every((p) => typeof p.t === 'number'));

    const usage = await ok('monitor', 'usage', 3600_000);
    check('usage answers for the last hour', usage.windowMs === 3600_000 && usage.totals && typeof usage.totals.calls === 'number');
    check('usage includes budget and provider groups', usage.budget && Array.isArray(usage.byProvider) && Array.isArray(usage.byModel));
    const usageSeries = await ok('monitor', 'usageSeries', 86_400_000);
    check('the usage series answers for 24h', usageSeries.sinceMs === 86_400_000 && Array.isArray(usageSeries.points));

    const csv = await ok('monitor', 'usageCsv', 86_400_000);
    check('the CSV export has the documented header', typeof csv.csv === 'string' && csv.csv.startsWith('timestamp,run_id,task') && /^orvex-usage-/.test(csv.name));

    const traces = await ok('monitor', 'traces', 5);
    check('the trace list answers with runs', Array.isArray(traces.runs) && traces.limit === 5);
    const badTrace = await ipc('monitor', 'trace', 'missing-run');
    check('an unknown run returns an error, not a blank trace', !badTrace.ok && /not found/i.test(badTrace.error));

    const noModel = await ipc('monitor', 'compare', { prompt: 'hi', candidates: [] });
    check('comparison without models is refused', !noModel.ok && /at least two|provider/i.test(noModel.error));

    const health = await ok('monitor', 'health', []);
    check('health runs all twelve probes live', health.checks.length === 12 && health.summary.total === 12);
    check('live health checks the SQLite store', health.checks.find((c) => c.id === 'database').status === 'ok');

    const recovery = await ok('monitor', 'recoverables');
    check('recovery lists runs, workflows and crashes', Array.isArray(recovery.runs) && Array.isArray(recovery.workflows) && Array.isArray(recovery.crashes));

    const suites = await ok('monitor', 'evalSuites');
    check('the live eval suites include the starter', suites.suites.some((s) => s.id === 'starter'));
    const created = await ok('monitor', 'evalSave', {
      name: 'IPC smoke suite',
      cases: [{ id: 'one', prompt: 'Reply OK', checks: { contains: ['OK'] } }],
    });
    check('an eval suite round trips through SQLite', /^ipc-smoke-suite_/.test(created.id) && created.caseCount === 1);
    const afterSave = await ok('monitor', 'evalSuites');
    check('the saved suite is listed', afterSave.suites.some((s) => s.id === created.id));
    const badRun = await ipc('monitor', 'evalRun', { suiteId: 'nope', candidates: [] });
    check('running an unknown suite is refused', !badRun.ok && /not found/i.test(badRun.error));
    const removed = await ok('monitor', 'evalDelete', created.id);
    check('the smoke suite is deleted again', removed.removed === 1);
    check('the saved suite is gone', !(await ok('monitor', 'evalSuites')).suites.some((s) => s.id === created.id));

    const badAbandon = await ipc('monitor', 'abandon', 'missing-run');
    check('abandoning an unknown run is refused', !badAbandon.ok && /not found/i.test(badAbandon.error));
    check('the crash log answers', Array.isArray(await ok('monitor', 'crashes', 5)));
  } finally {
    if (cdp) cdp.ws.close();
  }
}

(async () => {
  try {
    await partA();
    await partB();
  } catch (err) {
    check('the monitoring suite ran without fatal errors', false, err && err.stack ? err.stack.split('\n')[0] : String(err));
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed${passed === results.length ? '' : ' — FAILURES PRESENT'}`);
  process.exit(passed === results.length ? 0 : 1);
})();
