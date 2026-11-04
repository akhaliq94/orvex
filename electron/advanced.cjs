'use strict';

/**
 * Section 19 — advanced capabilities that build on the real agent stack.
 *
 * Everything here works from live state: provider calls go through the model
 * gateway, jobs run the registered tools under the same approval + permission
 * engine, proactive rules read real system/clipboard signals, routing advice
 * comes from measured outcomes, and learning mines the real audit trail.
 * When a capability has no backing service (for example no model configured)
 * the API reports that explicitly instead of inventing a result.
 */

const crypto = require('node:crypto');
const db = require('./db.cjs');
const security = require('./security.cjs');

const MODES = ['cloud', 'local-first', 'hybrid', 'offline'];
const MODE_KEY = 'advanced.mode';
const MAX_RULES = 40;
const MAX_JOB_STEPS = 50;
const MAX_EVENTS = 200;
const TICK_MS = 30_000;

let ctx = {
  gateway: null,
  runTool: null,
  toolDefinitions: () => [],
  approvalReason: () => null,
  approve: null,
  emit: () => {},
  notify: () => {},
  metrics: null,
  clipboard: null,
  idleSeconds: null,
  ocr: null,
  screenshot: null,
  windowList: null,
  crashes: null,
  resumeRun: null,
  resumeWorkflow: null,
  runWorkflow: null,
  online: () => true,
  version: () => '1.0.0',
};

const activeJobs = new Map();
let tickTimer = null;
let ticking = false;
let lastTick = null;

function init(opts = {}) {
  ctx = { ...ctx, ...opts };
  try {
    db.raw()
      ?.prepare("UPDATE adv_jobs SET status = 'interrupted', updated_at = ? WHERE status = 'running'")
      .run(Date.now());
  } catch {
    /* a read-only profile still runs — boot recovery is skipped */
  }
  startRules();
}

function now() {
  return Date.now();
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function raw() {
  return db.raw();
}

function clip(text, max = 4000) {
  const s = String(text == null ? '' : text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function parse(text, fallback) {
  try {
    const value = typeof text === 'string' ? JSON.parse(text) : text;
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

function emit(event) {
  try {
    ctx.emit(event);
  } catch {
    /* the window may be gone */
  }
}

function audit(kind, detail, ok = true) {
  db.audit({ kind, tool: 'advanced', args: detail ? clip(typeof detail === 'string' ? detail : JSON.stringify(detail), 800) : null, ok });
}

function normalizeCandidates(list) {
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || !c.baseUrl || !c.model) continue;
    const item = {
      id: String(c.id || c.presetId || c.baseUrl),
      presetId: String(c.presetId || c.id || ''),
      name: String(c.name || c.model),
      baseUrl: String(c.baseUrl).replace(/\/+$/, ''),
      apiKey: c.apiKey || '',
      api: c.api === 'anthropic' ? 'anthropic' : 'openai',
      model: String(c.model),
    };
    const key = `${item.id}|${item.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function isLocalCandidate(c = {}) {
  const url = String(c.baseUrl || '');
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url) || /^(ollama|lmstudio|llamacpp|custom)$/.test(String(c.presetId || ''));
}

/* --------------------------------------------------------------- modes */

function getMode() {
  const mode = String(db.getSetting(MODE_KEY, 'cloud') || 'cloud');
  return MODES.includes(mode) ? mode : 'cloud';
}

function setMode(mode) {
  const wanted = String(mode || '').trim();
  if (!MODES.includes(wanted)) throw new Error(`Unknown mode "${wanted}". Use ${MODES.join(', ')}.`);
  db.setSetting(MODE_KEY, wanted);
  audit('advanced-mode', { mode: wanted });
  emit({ type: 'mode', mode: wanted, at: now() });
  return modeStatus();
}

function online() {
  try {
    return !!ctx.online();
  } catch {
    return false;
  }
}

function modeStatus() {
  return {
    mode: getMode(),
    online: online(),
    modes: MODES,
    hostedAllowed: getMode() !== 'offline',
    localOnly: getMode() === 'offline',
    updatedAt: now(),
  };
}

/**
 * Order candidates under the current privacy/connectivity mode.
 * - cloud: leave the configured order.
 * - local-first: local models first; a sensitive task never leaves the machine.
 * - hybrid: simple prompts stay local, heavy/code/research prompts may start cloud.
 * - offline: only local endpoints.
 */
function planCandidates(list, { task = 'agent', prompt = '', sensitive = false } = {}) {
  const candidates = normalizeCandidates(list);
  const mode = getMode();
  const local = candidates.filter(isLocalCandidate);
  const hosted = candidates.filter((c) => !isLocalCandidate(c));
  if (!candidates.length) return { mode, candidates: [], reason: 'No model candidates were supplied.' };
  if (mode === 'offline') {
    if (!online() && !local.length) return { mode, candidates: [], reason: 'Offline and no local model endpoint is configured.' };
    return {
      mode,
      candidates: local,
      reason: local.length ? 'Offline mode — only local endpoints are used.' : 'Offline mode has no local endpoint to call.',
    };
  }
  if (mode === 'local-first') {
    if (sensitive) {
      return {
        mode,
        candidates: local,
        reason: local.length ? 'Sensitive task kept on local models.' : 'This task is marked sensitive but no local model is configured.',
      };
    }
    return { mode, candidates: [...local, ...hosted], reason: local.length ? 'Local models are tried first; cloud is only a fallback.' : 'No local model configured — cloud fallback remains available.' };
  }
  if (mode === 'hybrid') {
    const heavy = sensitive ? false : /^(code|research|plan|media)$/.test(String(task)) || String(prompt).length > 700;
    return {
      mode,
      candidates: heavy ? [...hosted, ...local] : [...local, ...hosted],
      reason: heavy ? 'Hybrid mode — this task escalates to a cloud model first.' : 'Hybrid mode — this task starts on a local model.',
    };
  }
  return { mode, candidates, reason: 'Cloud mode — the configured order is used.' };
}

function filterCandidates(list, opts = {}) {
  const planned = planCandidates(list, opts);
  if (planned.candidates.length && opts.exclusive && planned.mode === 'offline') {
    return planned.candidates;
  }
  return planned.candidates;
}

/* ------------------------------------------------------------- context */

async function contextSnapshot() {
  const out = {
    at: now(),
    mode: getMode(),
    online: online(),
    activeWindow: null,
    clipboard: null,
    metrics: null,
    interrupted: 0,
    recentRuns: [],
  };
  try {
    if (ctx.windowList) {
      const wins = await ctx.windowList({ limit: 40 });
      if (wins && wins.ok && Array.isArray(wins.windows)) {
        const active = wins.windows.find((w) => w.foreground) || null;
        out.activeWindow = active ? { title: active.title, cls: active.cls, pid: active.pid, state: active.state } : null;
        out.windowCount = wins.windows.length;
      } else if (wins && wins.error) {
        out.windowError = wins.error;
      }
    }
  } catch (err) {
    out.windowError = err && err.message ? err.message : String(err);
  }
  try {
    if (ctx.clipboard) {
      const clipBoard = await ctx.clipboard();
      if (clipBoard && clipBoard.ok) {
        out.clipboard = {
          kind: clipBoard.kind || 'text',
          text: clipBoard.text ? String(clipBoard.text).slice(0, 2000) : '',
          file: clipBoard.file || null,
        };
      } else if (clipBoard && clipBoard.error) {
        out.clipboardError = clipBoard.error;
      }
    }
  } catch (err) {
    out.clipboardError = err && err.message ? err.message : String(err);
  }
  try {
    if (ctx.metrics) {
      const m = await ctx.metrics();
      if (m && m.ok) {
        out.metrics = {
          cpuPercent: m.cpuPercent,
          memoryPercent: m.memory ? m.memory.percent : null,
          diskPercent: m.disk ? m.disk.percent : null,
          uptimeSec: m.uptimeSec,
        };
      }
    }
  } catch {
    /* metrics are optional context */
  }
  try {
    out.interrupted = raw()?.prepare("SELECT COUNT(*) AS n FROM adv_jobs WHERE status = 'interrupted'").get()?.n || 0;
    out.recentRuns = raw()
      ?.prepare('SELECT id, goal, status, started_at AS startedAt FROM runs ORDER BY started_at DESC LIMIT 5')
      .all() || [];
  } catch {
    /* the database may be unavailable */
  }
  return out;
}

function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f\u0600-\u06ff\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function overlapScore(a, b) {
  const left = new Set(words(a));
  const right = new Set(words(b));
  if (!left.size || !right.size) return 0;
  let hit = 0;
  for (const w of left) if (right.has(w)) hit += 1;
  return hit / Math.max(left.size, right.size);
}

/** Suggestions that can be derived honestly from the snapshot without a model. */
function localSuggestions(snapshot) {
  const list = [];
  const text = snapshot.clipboard && snapshot.clipboard.kind === 'text' ? snapshot.clipboard.text || '' : '';
  const active = snapshot.activeWindow || null;
  if (/^https?:\/\/\S+$/i.test(text.trim())) {
    list.push({
      id: 'clipboard-url',
      title: 'Open the copied link',
      why: 'The clipboard holds one URL — open it in the Browser page.',
      action: { type: 'navigate', page: 'browser', payload: { url: text.trim() } },
      source: 'clipboard',
    });
  } else if (text.length > 400) {
    list.push({
      id: 'clipboard-summarize',
      title: 'Summarize the copied text',
      why: `${text.length} characters are on the clipboard.`,
      action: { type: 'navigate', page: 'research', payload: { seed: text.slice(0, 1200) } },
      source: 'clipboard',
    });
  }
  if (snapshot.activeWindow && /chrome|edge|firefox|brave/i.test(`${snapshot.activeWindow.cls || ''} ${snapshot.activeWindow.title || ''}`)) {
    list.push({
      id: 'explain-screen',
      title: 'Capture and explain the active page',
      why: `The foreground window is "${clip(snapshot.activeWindow.title, 80)}".`,
      action: { type: 'navigate', page: 'advanced', payload: { tab: 'vision' } },
      source: 'window',
    });
  }
  if (snapshot.interrupted > 0) {
    list.push({
      id: 'resume-jobs',
      title: `Resume ${snapshot.interrupted} interrupted job${snapshot.interrupted === 1 ? '' : 's'}`,
      why: 'Checkpointed work is waiting after the last shutdown.',
      action: { type: 'navigate', page: 'advanced', payload: { tab: 'recovery' } },
      source: 'recovery',
    });
  }
  if (snapshot.metrics && snapshot.metrics.memoryPercent != null && snapshot.metrics.memoryPercent > 85) {
    list.push({
      id: 'memory-pressure',
      title: 'Inspect memory pressure',
      why: `System memory is at ${snapshot.metrics.memoryPercent}%.`,
      action: { type: 'navigate', page: 'system', payload: { tab: 'monitor' } },
      source: 'metrics',
    });
  }
  return list;
}

const SUGGEST_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          why: { type: 'string' },
          page: { type: 'string' },
        },
        required: ['title', 'why', 'page'],
      },
    },
  },
  required: ['suggestions'],
};

async function suggestContext({ snapshot, candidates } = {}) {
  const snap = snapshot || (await contextSnapshot());
  const heuristics = localSuggestions(snap);
  const models = normalizeCandidates(candidates);
  if (!models.length) {
    return { suggestions: heuristics, method: 'rules', note: 'No model is configured, so suggestions come from local signals only.' };
  }
  const system =
    'You are ORVEX context assistance. Read the JSON snapshot of the user\'s machine and propose at most 4 concrete, useful next actions. ' +
    'Only use this page list: chat, browser, research, files, media, automation, productivity, code, monitoring, advanced. ' +
    'Never invent facts that are not in the snapshot. Reply with JSON only.';
  const prompt = `Snapshot:\n${JSON.stringify(snap).slice(0, 6000)}\n\nLocal rule matches:\n${JSON.stringify(heuristics)}\n\nReturn {"suggestions":[{"title":"...","why":"...","page":"..."}]}`;
  try {
    const reply = await ctx.gateway.chat({
      candidates: filterCandidates(models, { task: 'chat', prompt }),
      system,
      history: [{ role: 'user', text: prompt }],
      task: 'assistant',
      jsonSchema: SUGGEST_SCHEMA,
      temperature: 0.2,
      maxTokens: 700,
    });
    const parsed = reply.json || parse(reply.text, null);
    const items = parsed && Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    const clean = items
      .filter((s) => s && s.title && s.why)
      .slice(0, 5)
      .map((s, i) => ({
        id: `model-${i}`,
        title: clip(s.title, 120),
        why: clip(s.why, 240),
        action: { type: 'navigate', page: String(s.page || 'chat') },
        source: 'model',
      }));
    return {
      suggestions: [...heuristics, ...clean].slice(0, 8),
      method: 'model',
      model: reply.provider ? `${reply.provider.name} · ${reply.provider.model}` : null,
    };
  } catch (err) {
    return {
      suggestions: heuristics,
      method: 'rules',
      note: `Model suggestion failed: ${err && err.message ? err.message : String(err)}`,
    };
  }
}

/* ------------------------------------------------------ proactive rules */

const CONDITION_TYPES = ['idle_minutes', 'clipboard_contains', 'cpu_above', 'memory_above', 'disk_above', 'time_of_day', 'run_interrupted'];
const ACTION_TYPES = ['notify', 'run_workflow', 'run_job', 'run_tool'];

function normalizeRule(input = {}) {
  const condition = typeof input.condition === 'string' ? parse(input.condition, null) : input.condition;
  const action = typeof input.action === 'string' ? parse(input.action, null) : input.action;
  if (!condition || !CONDITION_TYPES.includes(condition.type)) throw new Error(`Condition must be one of ${CONDITION_TYPES.join(', ')}.`);
  if (!action || !ACTION_TYPES.includes(action.type)) throw new Error(`Action must be one of ${ACTION_TYPES.join(', ')}.`);
  if (condition.type === 'idle_minutes' && !(Number(condition.minutes) > 0)) throw new Error('idle_minutes needs minutes > 0.');
  if (condition.type === 'clipboard_contains' && !String(condition.text || '').trim()) throw new Error('clipboard_contains needs text.');
  if (['cpu_above', 'memory_above', 'disk_above'].includes(condition.type) && !(Number(condition.percent) > 0)) throw new Error(`${condition.type} needs percent > 0.`);
  if (condition.type === 'time_of_day' && !/^\d{1,2}:\d{2}$/.test(String(condition.at || ''))) throw new Error('time_of_day needs at in HH:MM.');
  if (action.type === 'run_workflow' && !String(action.workflowId || '').trim()) throw new Error('run_workflow needs workflowId.');
  if (action.type === 'run_job' && !String(action.jobId || '').trim()) throw new Error('run_job needs jobId.');
  if (action.type === 'run_tool' && !String(action.tool || '').trim()) throw new Error('run_tool needs tool.');
  const name = clip(String(input.name || 'Rule').trim(), 80) || 'Rule';
  const cooldown = Math.min(Math.max(Math.round(Number(input.cooldownSec) || 900), 30), 7 * 24 * 3600);
  return {
    name,
    condition,
    action: { type: action.type, ...action },
    enabled: input.enabled !== false,
    cooldownSec: cooldown,
  };
}

function listRules() {
  const rows = raw()?.prepare('SELECT * FROM adv_rules ORDER BY created_at DESC').all() || [];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    condition: parse(r.condition, {}),
    action: parse(r.action, {}),
    enabled: !!r.enabled,
    cooldownSec: r.cooldown_sec,
    lastFired: r.last_fired,
    firedCount: r.fired_count,
    createdAt: r.created_at,
  }));
}

function saveRule(input = {}) {
  const rule = normalizeRule(input);
  const id = input.id ? String(input.id) : newId('rule');
  const existing = input.id ? raw()?.prepare('SELECT id FROM adv_rules WHERE id = ?').get(id) : null;
  if (existing) {
    raw()
      .prepare('UPDATE adv_rules SET name = ?, condition = ?, action = ?, enabled = ?, cooldown_sec = ?, updated_at = ? WHERE id = ?')
      .run(rule.name, JSON.stringify(rule.condition), JSON.stringify(rule.action), rule.enabled ? 1 : 0, rule.cooldownSec, now(), id);
  } else {
    const count = raw()?.prepare('SELECT COUNT(*) AS n FROM adv_rules').get()?.n || 0;
    if (count >= MAX_RULES) throw new Error(`At most ${MAX_RULES} proactive rules are supported.`);
    raw()
      .prepare('INSERT INTO adv_rules(id, name, condition, action, enabled, cooldown_sec, fired_count, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, 0, ?, ?)')
      .run(id, rule.name, JSON.stringify(rule.condition), JSON.stringify(rule.action), rule.enabled ? 1 : 0, rule.cooldownSec, now(), now());
  }
  audit('advanced-rule', { id, name: rule.name, condition: rule.condition.type, action: rule.action.type });
  return { id, ...rule };
}

function deleteRule(id) {
  const changes = raw()?.prepare('DELETE FROM adv_rules WHERE id = ?').run(String(id)).changes || 0;
  return { removed: changes };
}

function setRuleEnabled(id, enabled) {
  raw()?.prepare('UPDATE adv_rules SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, now(), String(id));
  return { id: String(id), enabled: !!enabled };
}

function ruleEvents(limit = 40) {
  const n = Math.min(Math.max(Number(limit) || 40, 1), 200);
  return raw()?.prepare('SELECT id, rule_id AS ruleId, at, ok, detail FROM adv_rule_events ORDER BY id DESC LIMIT ?').all(n) || [];
}

/** Pure condition check used by the ticker and the unit tests. */
function evaluateRule(rule, signals = {}) {
  const c = rule.condition || {};
  const value = c.type === 'idle_minutes' ? Number(c.minutes) * 60 : null;
  switch (c.type) {
    case 'idle_minutes':
      if (signals.idleSec == null) return { match: false, detail: 'idle time is unavailable' };
      return { match: Number(signals.idleSec) >= value, detail: `idle ${Math.round(Number(signals.idleSec))}s / ${value}s` };
    case 'clipboard_contains': {
      if (signals.clipboard == null) return { match: false, detail: 'clipboard is unavailable' };
      const hit = String(signals.clipboard).toLowerCase().includes(String(c.text).toLowerCase());
      return { match: hit, detail: hit ? `clipboard contains "${clip(c.text, 60)}"` : 'clipboard does not contain the text' };
    }
    case 'cpu_above':
      if (signals.cpuPercent == null) return { match: false, detail: 'CPU is unavailable' };
      return { match: Number(signals.cpuPercent) >= Number(c.percent), detail: `CPU ${signals.cpuPercent}% / ${c.percent}%` };
    case 'memory_above':
      if (signals.memoryPercent == null) return { match: false, detail: 'memory is unavailable' };
      return { match: Number(signals.memoryPercent) >= Number(c.percent), detail: `memory ${signals.memoryPercent}% / ${c.percent}%` };
    case 'disk_above':
      if (signals.diskPercent == null) return { match: false, detail: 'disk is unavailable' };
      return { match: Number(signals.diskPercent) >= Number(c.percent), detail: `disk ${signals.diskPercent}% / ${c.percent}%` };
    case 'time_of_day': {
      const [hh, mm] = String(c.at).split(':').map(Number);
      const date = new Date(signals.at || Date.now());
      const DAY = 24 * 60;
      const mine = date.getHours() * 60 + date.getMinutes();
      const target = hh * 60 + mm;
      // Compare on a 24-hour clock so 23:59 and 00:01 are two minutes apart.
      const raw = Math.abs(mine - target);
      const diff = Math.min(raw, DAY - raw);
      const windowMinutes = Number(c.windowMinutes) > 0 ? Number(c.windowMinutes) : 1;
      return { match: diff <= windowMinutes, detail: `clock ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')} vs ${c.at}` };
    }
    case 'run_interrupted':
      return { match: Number(signals.interrupted) > 0, detail: `${signals.interrupted || 0} interrupted job(s)` };
    default:
      return { match: false, detail: `unknown condition "${c.type}"` };
  }
}

async function readSignals() {
  const signals = { at: now(), idleSec: null, clipboard: null, cpuPercent: null, memoryPercent: null, diskPercent: null, interrupted: 0 };
  try {
    if (ctx.idleSeconds) signals.idleSec = Number(ctx.idleSeconds());
  } catch {
    /* optional */
  }
  try {
    if (ctx.clipboard) {
      const c = await ctx.clipboard();
      if (c && c.ok && c.kind === 'text') signals.clipboard = String(c.text || '');
    }
  } catch {
    /* optional */
  }
  try {
    if (ctx.metrics) {
      const m = await ctx.metrics();
      if (m && m.ok) {
        signals.cpuPercent = m.cpuPercent;
        signals.memoryPercent = m.memory ? m.memory.percent : null;
        signals.diskPercent = m.disk ? m.disk.percent : null;
      }
    }
  } catch {
    /* optional */
  }
  try {
    signals.interrupted = raw()?.prepare("SELECT COUNT(*) AS n FROM adv_jobs WHERE status = 'interrupted'").get()?.n || 0;
  } catch {
    /* optional */
  }
  return signals;
}

async function fireRule(rule, detail) {
  const action = rule.action || {};
  const payload = { title: `ORVEX · ${rule.name}`, body: detail || `${rule.condition.type} matched`, kind: 'advanced', target: 'advanced', at: now() };
  try {
    if (action.type === 'notify') {
      ctx.notify(payload);
      return { ok: true, detail: 'notification sent' };
    }
    if (action.type === 'run_workflow') {
      if (!ctx.runWorkflow) throw new Error('The workflow engine is not connected.');
      const result = await ctx.runWorkflow(String(action.workflowId));
      return { ok: true, detail: `workflow run ${result && result.id ? result.id : 'started'}` };
    }
    if (action.type === 'run_job') {
      const job = await startJob(String(action.jobId), { wait: false });
      return { ok: true, detail: `job ${job.id} ${job.status}` };
    }
    if (action.type === 'run_tool') {
      const tool = String(action.tool);
      if (security.isMutatingTool(tool)) {
        return { ok: false, detail: `"${tool}" changes the machine — proactive runs only execute read-only tools.` };
      }
      const result = await ctx.runTool(tool, action.args || {}, { runId: `rule_${rule.id}` });
      return { ok: !!result.ok, detail: clip(result.ok ? result.output || 'tool finished' : result.error || 'tool failed', 400) };
    }
    return { ok: false, detail: `unknown action "${action.type}"` };
  } catch (err) {
    return { ok: false, detail: err && err.message ? err.message : String(err) };
  }
}

async function tick() {
  if (ticking || !raw()) return lastTick;
  ticking = true;
  try {
    const signals = await readSignals();
    const rules = listRules().filter((r) => r.enabled);
    let fired = 0;
    for (const rule of rules) {
      const verdict = evaluateRule(rule, signals);
      if (!verdict.match) continue;
      if (rule.lastFired && now() - rule.lastFired < rule.cooldownSec * 1000) continue;
      const result = await fireRule(rule, verdict.detail);
      raw()
        ?.prepare('UPDATE adv_rules SET last_fired = ?, fired_count = fired_count + 1, updated_at = ? WHERE id = ?')
        .run(now(), now(), rule.id);
      raw()?.prepare('INSERT INTO adv_rule_events(rule_id, at, ok, detail) VALUES(?, ?, ?, ?)').run(rule.id, now(), result.ok ? 1 : 0, clip(`${verdict.detail} — ${result.detail}`, 500));
      emit({ type: 'rule-fired', rule: rule.name, ok: result.ok, detail: result.detail, at: now() });
      fired += 1;
    }
    lastTick = { at: now(), rules: rules.length, fired, signals };
    return lastTick;
  } finally {
    ticking = false;
  }
}

function startRules() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    tick().catch(() => {});
  }, TICK_MS);
  if (tickTimer.unref) tickTimer.unref();
}

function stopRules() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

/* --------------------------------------------------------- self-eval */

function heuristicEval(goal, output, criteria) {
  const text = String(output || '');
  const list = (Array.isArray(criteria) && criteria.length ? criteria : ['addresses the goal', 'is complete', 'is specific']).map((c) =>
    typeof c === 'string' ? c : String(c && (c.name || c.criterion) || 'criterion'),
  );
  const goalWords = words(goal).slice(0, 12);
  const verdicts = list.map((criterion) => {
    const c = criterion.toLowerCase();
    let pass = false;
    let reason = '';
    if (/json/.test(c)) {
      try {
        JSON.parse(text);
        pass = true;
        reason = 'parses as JSON';
      } catch {
        reason = 'is not valid JSON';
      }
    } else if (/source|cite|reference|link/.test(c)) {
      pass = /https?:\/\//i.test(text);
      reason = pass ? 'contains a link' : 'contains no link or citation';
    } else if (/number|calculat|math|quantity/.test(c)) {
      pass = /\d/.test(text);
      reason = pass ? 'contains numbers' : 'contains no numbers';
    } else if (/concise|short|brief/.test(c)) {
      pass = text.length > 0 && text.length <= 1200;
      reason = `${text.length} characters`;
    } else if (/step|list|structure/.test(c)) {
      pass = /(^|\n)\s*(\d+[.)]|[-*•])/.test(text);
      reason = pass ? 'has a structured list' : 'has no list structure';
    } else if (/length|detail|complete/.test(c)) {
      pass = text.length >= 200;
      reason = `${text.length} characters`;
    } else {
      pass = overlapScore(goal, text) > 0 || (goalWords.length > 0 && goalWords.some((w) => text.toLowerCase().includes(w)));
      reason = pass ? 'mentions the goal wording' : 'does not mention the goal wording';
    }
    return { criterion, pass, reason };
  });
  const placeholders = /(lorem ipsum|\bTODO\b|placeholder|as an AI language model)/i.test(text);
  const filled = text.trim().length >= 40;
  const base = list.length ? verdicts.filter((v) => v.pass).length / list.length : 0;
  const score = Math.max(0, Math.min(1, base - (placeholders ? 0.35 : 0) - (filled ? 0 : 0.4)));
  return {
    score: Math.round(score * 100) / 100,
    verdicts,
    issues: [
      ...verdicts.filter((v) => !v.pass).map((v) => `${v.criterion}: ${v.reason}`),
      ...(placeholders ? ['output contains placeholder text'] : []),
      ...(filled ? [] : ['output is shorter than 40 characters']),
    ],
    method: 'heuristic',
  };
}

const EVAL_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number' },
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { criterion: { type: 'string' }, pass: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['criterion', 'pass', 'reason'],
      },
    },
    issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['score', 'verdicts', 'issues'],
};

async function selfEval({ goal, output, criteria, candidates } = {}) {
  const text = String(output || '');
  if (!text.trim()) throw new Error('There is no output to evaluate.');
  const list = Array.isArray(criteria) && criteria.length ? criteria.map((c) => String(c)) : ['addresses the goal', 'is complete', 'is specific'];
  const heuristic = heuristicEval(goal, text, list);
  const models = normalizeCandidates(candidates);
  if (!models.length) {
    const id = newId('eval');
    raw()
      ?.prepare('INSERT INTO adv_selfevals(id, goal, output, criteria, score, detail, model, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, clip(goal, 2000), clip(text, 8000), JSON.stringify(list), heuristic.score, JSON.stringify(heuristic), null, now());
    return { id, ...heuristic, model: null };
  }
  const system =
    'You are a strict output reviewer. Score the answer against each criterion from 0 to 1 and mark each pass/fail with a concrete reason. ' +
    'Do not praise; only report what the output actually does. Reply with JSON only.';
  const prompt = `Goal:\n${clip(goal, 2000)}\n\nCriteria:\n${list.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nOutput:\n${clip(text, 12000)}`;
  try {
    const reply = await ctx.gateway.chat({
      candidates: filterCandidates(models, { task: 'chat', prompt }),
      system,
      history: [{ role: 'user', text: prompt }],
      task: 'assistant',
      jsonSchema: EVAL_SCHEMA,
      temperature: 0,
      maxTokens: 900,
    });
    const parsed = reply.json || parse(reply.text, null);
    if (!parsed || !Array.isArray(parsed.verdicts)) throw new Error('the model did not return verdicts');
    const modelScore = Math.max(0, Math.min(1, Number(parsed.score)));
    const result = {
      score: Number.isFinite(modelScore) ? Math.round(modelScore * 100) / 100 : heuristic.score,
      verdicts: parsed.verdicts.slice(0, 20).map((v) => ({ criterion: String(v.criterion || ''), pass: !!v.pass, reason: String(v.reason || '') })),
      issues: Array.isArray(parsed.issues) ? parsed.issues.map((i) => String(i)).slice(0, 20) : [],
      method: 'model',
      heuristic,
      model: reply.provider ? `${reply.provider.name} · ${reply.provider.model}` : null,
    };
    const id = newId('eval');
    raw()
      ?.prepare('INSERT INTO adv_selfevals(id, goal, output, criteria, score, detail, model, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, clip(goal, 2000), clip(text, 8000), JSON.stringify(list), result.score, JSON.stringify(result), result.model, now());
    return { id, ...result };
  } catch (err) {
    const id = newId('eval');
    const fallback = { ...heuristic, note: `Model review failed: ${err && err.message ? err.message : String(err)}` };
    raw()
      ?.prepare('INSERT INTO adv_selfevals(id, goal, output, criteria, score, detail, model, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, clip(goal, 2000), clip(text, 8000), JSON.stringify(list), fallback.score, JSON.stringify(fallback), null, now());
    return { id, ...fallback, model: null };
  }
}

function selfEvalHistory(limit = 20) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  return raw()?.prepare('SELECT id, goal, score, model, created_at AS createdAt FROM adv_selfevals ORDER BY created_at DESC LIMIT ?').all(n) || [];
}

/* ---------------------------------------------------- adaptive routing */

function modelCapability(task, model = '') {
  const m = String(model).toLowerCase();
  const vision = /vision|gpt-4o|gpt-4\.1|claude|gemini|llava|qwen.*vl|pixtral|minicpm-v/.test(m);
  const coding = /code|coder|deepseek|qwen|claude|gpt-4|o3|sonnet|opus/.test(m);
  const reasoning = /o1|o3|r1|reasoner|opus|sonnet|qwen|gemini|gpt-4/.test(m);
  const fast = /mini|flash|instant|haiku|small|8b|7b|3b|1b|turbo/.test(m);
  const t = String(task || 'agent');
  if (t === 'vision') return vision ? 1 : 0.15;
  if (t === 'code') return coding ? 1 : 0.4;
  if (t === 'plan' || t === 'research') return reasoning ? 1 : 0.45;
  if (t === 'summarize') return fast ? 0.95 : 0.7;
  if (t === 'media') return vision || /dall|image|flux|stable/.test(m) ? 1 : 0.3;
  return 0.6;
}

function routeStats(task, days = 30) {
  const since = now() - Math.max(1, Number(days) || 30) * 24 * 3600 * 1000;
  const rows = raw()
    ?.prepare('SELECT provider_id AS providerId, model, ok, ms FROM adv_route_outcomes WHERE task = ? AND at >= ? ORDER BY at DESC LIMIT 500')
    .all(String(task), since) || [];
  const map = new Map();
  for (const row of rows) {
    const key = `${row.providerId || ''}|${row.model || ''}`;
    const entry = map.get(key) || { providerId: row.providerId || '', model: row.model || '', calls: 0, ok: 0, ms: [] };
    entry.calls += 1;
    if (row.ok) entry.ok += 1;
    if (Number(row.ms) > 0) entry.ms.push(Number(row.ms));
    map.set(key, entry);
  }
  return [...map.values()].map((e) => {
    const sorted = e.ms.sort((a, b) => a - b);
    return {
      providerId: e.providerId,
      model: e.model,
      calls: e.calls,
      okRate: e.calls ? Math.round((e.ok / e.calls) * 100) / 100 : null,
      p50Ms: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    };
  });
}

function recordOutcome({ task, providerId, model, ok, ms } = {}) {
  if (!task || !model) return { recorded: false };
  raw()?.prepare('INSERT INTO adv_route_outcomes(task, provider_id, model, ok, ms, at) VALUES(?, ?, ?, ?, ?, ?)').run(
    String(task),
    providerId ? String(providerId) : null,
    String(model),
    ok ? 1 : 0,
    Math.max(0, Math.round(Number(ms) || 0)),
    now(),
  );
  return { recorded: true };
}

/** Rank the supplied candidates for a task using capability + measured reliability. */
function recommendRoute({ task = 'agent', candidates } = {}) {
  const list = normalizeCandidates(candidates);
  if (!list.length) return { task, ranked: [], note: 'No candidates were supplied.' };
  const stats = routeStats(task);
  const ranked = list
    .map((c) => {
      const stat = stats.find((s) => s.model === c.model && (!s.providerId || s.providerId === c.id)) || null;
      const capability = modelCapability(task, c.model);
      const reliability = stat && stat.okRate != null ? stat.okRate : null;
      const speed = stat && stat.p50Ms ? Math.max(0, 1 - Math.min(1, stat.p50Ms / 20_000)) : null;
      const score = capability * 0.55 + (reliability == null ? 0.3 : reliability * 0.3) + (speed == null ? 0.15 : speed * 0.15);
      return {
        id: c.id,
        name: c.name,
        model: c.model,
        baseUrl: c.baseUrl,
        capability,
        reliability,
        p50Ms: stat ? stat.p50Ms : null,
        calls: stat ? stat.calls : 0,
        score: Math.round(score * 1000) / 1000,
        reasons: [
          `capability ${Math.round(capability * 100)}% for ${task}`,
          reliability == null ? 'no measured success rate yet' : `${Math.round(reliability * 100)}% success over ${stat.calls} calls`,
          stat && stat.p50Ms ? `p50 ${stat.p50Ms}ms` : 'no latency sample yet',
        ],
      };
    })
    .sort((a, b) => b.score - a.score);
  return { task, ranked, stats };
}

function applyRoute({ task, chain } = {}) {
  if (!task) throw new Error('Task is required.');
  const cleaned = (Array.isArray(chain) ? chain : [])
    .filter((c) => c && c.model)
    .slice(0, 8)
    .map((c) => ({ providerId: String(c.providerId || c.id || ''), model: String(c.model) }));
  db.setRouting(String(task), cleaned);
  return { task, chain: cleaned };
}

/* ----------------------------------------------------------- learning */

function sequencesFromAudit() {
  const rows = raw()
    ?.prepare("SELECT run_id AS runId, tool FROM audit WHERE kind = 'tool' AND ok = 1 AND run_id IS NOT NULL ORDER BY ts ASC LIMIT 4000")
    .all() || [];
  const byRun = new Map();
  for (const row of rows) {
    if (!row.tool) continue;
    const list = byRun.get(row.runId) || [];
    list.push(String(row.tool));
    byRun.set(row.runId, list);
  }
  return [...byRun.values()].filter((seq) => seq.length >= 2);
}

/** Count how many distinct runs contain each 2..4 step pattern. */
function mineSequences(sequences, minSupport = 2) {
  const counts = new Map();
  for (const seq of sequences) {
    const seen = new Set();
    for (let n = 2; n <= Math.min(4, seq.length); n += 1) {
      for (let i = 0; i + n <= seq.length; i += 1) {
        const key = seq.slice(i, i + n).join('>');
        if (seen.has(key)) continue;
        seen.add(key);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .filter(([, support]) => support >= minSupport)
    .map(([key, support]) => ({ key, steps: key.split('>'), support }))
    .sort((a, b) => b.support - a.support || b.steps.length - a.steps.length)
    .slice(0, 12);
}

function hashKey(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 14);
}

function mineLearning({ days = 30 } = {}) {
  const rawDb = raw();
  if (!rawDb) return { suggested: 0, items: [] };
  let added = 0;
  const sequences = sequencesFromAudit();
  if (sequences.length >= 2) {
    for (const pattern of mineSequences(sequences)) {
      const key = hashKey(pattern.key);
      const detail = { steps: pattern.steps, support: pattern.support, runs: sequences.length };
      const existing = rawDb.prepare('SELECT id, support, status FROM adv_learning WHERE kind = ? AND key = ?').get('workflow', key);
      if (existing) {
        rawDb.prepare('UPDATE adv_learning SET support = ?, detail = ?, updated_at = ? WHERE id = ?').run(pattern.support, JSON.stringify(detail), now(), existing.id);
        continue;
      }
      rawDb
        .prepare("INSERT INTO adv_learning(id, kind, key, detail, support, status, created_at, updated_at) VALUES(?, 'workflow', ?, ?, ?, 'suggested', ?, ?)")
        .run(newId('learn'), key, JSON.stringify(detail), pattern.support, now(), now());
      added += 1;
    }
  }
  const since = now() - Math.max(1, Number(days) || 30) * 24 * 3600 * 1000;
  const byTask = rawDb
    .prepare('SELECT COALESCE(task, \'chat\') AS task, provider_id AS providerId, model, COUNT(*) AS calls, SUM(ok) AS ok FROM usage WHERE ts >= ? AND model IS NOT NULL GROUP BY task, provider_id, model ORDER BY calls DESC LIMIT 40')
    .all(since);
  const tasks = new Map();
  for (const row of byTask) {
    if (!row.model || row.calls < 3) continue;
    const best = tasks.get(row.task);
    const rate = row.calls ? row.ok / row.calls : 0;
    if (rate < 0.75) continue;
    if (!best || row.calls > best.calls) tasks.set(row.task, { ...row, rate });
  }
  for (const [task, row] of tasks) {
    const key = `route:${task}`;
    const existing = rawDb.prepare("SELECT id FROM adv_learning WHERE kind = 'routing' AND key = ?").get(key);
    if (existing) continue;
    const detail = { task, chain: [{ providerId: row.providerId || '', model: row.model }], calls: row.calls, okRate: Math.round(row.rate * 100) / 100 };
    rawDb
      .prepare("INSERT INTO adv_learning(id, kind, key, detail, support, status, created_at, updated_at) VALUES(?, 'routing', ?, ?, ?, 'suggested', ?, ?)")
      .run(newId('learn'), key, JSON.stringify(detail), row.calls, now(), now());
    added += 1;
  }
  audit('advanced-learning', { scannedRuns: sequences.length, added });
  return { suggested: added, items: listLearning() };
}

function listLearning(status) {
  const sql = status
    ? 'SELECT * FROM adv_learning WHERE status = ? ORDER BY support DESC, updated_at DESC LIMIT 60'
    : 'SELECT * FROM adv_learning ORDER BY status = \'suggested\' DESC, support DESC, updated_at DESC LIMIT 60';
  const rows = (status ? raw()?.prepare(sql).all(String(status)) : raw()?.prepare(sql).all()) || [];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    key: r.key,
    detail: parse(r.detail, {}),
    support: r.support,
    status: r.status,
    updatedAt: r.updated_at,
  }));
}

function approveLearning(id) {
  const row = raw()?.prepare('SELECT * FROM adv_learning WHERE id = ?').get(String(id));
  if (!row) throw new Error('That suggestion no longer exists.');
  const detail = parse(row.detail, {});
  let applied = null;
  if (row.kind === 'routing' && detail.task && Array.isArray(detail.chain)) {
    applied = applyRoute({ task: detail.task, chain: detail.chain });
  }
  raw()?.prepare("UPDATE adv_learning SET status = 'approved', updated_at = ? WHERE id = ?").run(now(), String(id));
  audit('advanced-learning-approve', { id: String(id), kind: row.kind });
  return { id: String(id), status: 'approved', applied };
}

function dismissLearning(id) {
  const changes = raw()?.prepare("UPDATE adv_learning SET status = 'dismissed', updated_at = ? WHERE id = ?").run(now(), String(id)).changes || 0;
  return { removed: changes };
}

/* --------------------------------------------------------------- jobs */

function normalizeJobSpec(input = {}) {
  const steps = (Array.isArray(input.steps) ? input.steps : []).slice(0, MAX_JOB_STEPS).map((step, i) => {
    const tool = String(step && step.tool || '').trim();
    if (!tool) throw new Error(`Step ${i + 1} has no tool.`);
    return { tool, args: step.args && typeof step.args === 'object' ? step.args : {}, label: step.label ? clip(String(step.label), 120) : null };
  });
  if (!steps.length) throw new Error('A job needs at least one step.');
  return { steps, stopOnError: input.stopOnError !== false };
}

function jobRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    spec: parse(row.spec, {}),
    status: row.status,
    checkpoint: row.checkpoint,
    results: parse(row.results, []),
    error: row.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at || null,
  };
}

function listJobs(limit = 30) {
  const n = Math.min(Math.max(Number(limit) || 30, 1), 200);
  return (raw()?.prepare('SELECT * FROM adv_jobs ORDER BY created_at DESC LIMIT ?').all(n) || []).map(jobRow);
}

function getJob(id) {
  return jobRow(raw()?.prepare('SELECT * FROM adv_jobs WHERE id = ?').get(String(id)));
}

function createJob(input = {}) {
  const spec = normalizeJobSpec(input);
  const known = new Set((ctx.toolDefinitions() || []).map((d) => d.name));
  if (known.size) {
    const missing = spec.steps.map((s) => s.tool).filter((name) => !known.has(name));
    if (missing.length) throw new Error(`Unknown tool${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);
  }
  const id = newId('job');
  const title = clip(String(input.title || '').trim() || `${spec.steps[0].tool} job`, 120);
  raw()
    ?.prepare("INSERT INTO adv_jobs(id, title, spec, status, checkpoint, results, created_at, updated_at) VALUES(?, ?, ?, 'queued', 0, '[]', ?, ?)")
    .run(id, title, JSON.stringify(spec), now(), now());
  emit({ type: 'job-created', id, title, at: now() });
  return getJob(id);
}

function updateJob(id, patch = {}) {
  const row = raw()?.prepare('SELECT * FROM adv_jobs WHERE id = ?').get(String(id));
  if (!row) return null;
  const next = {
    status: patch.status != null ? patch.status : row.status,
    checkpoint: patch.checkpoint != null ? patch.checkpoint : row.checkpoint,
    results: patch.results != null ? JSON.stringify(patch.results) : row.results,
    error: patch.error !== undefined ? patch.error : row.error,
    endedAt: patch.endedAt !== undefined ? patch.endedAt : row.ended_at,
  };
  raw()
    ?.prepare('UPDATE adv_jobs SET status = ?, checkpoint = ?, results = ?, error = ?, updated_at = ?, ended_at = ? WHERE id = ?')
    .run(next.status, next.checkpoint, next.results, next.error, now(), next.endedAt, String(id));
  return getJob(id);
}

async function runJob(id, { wait = true } = {}) {
  const job = getJob(id);
  if (!job) throw new Error('That job no longer exists.');
  if (activeJobs.has(job.id)) throw new Error('That job is already running.');
  if (['done', 'cancelled'].includes(job.status)) throw new Error(`That job is already ${job.status}.`);
  const controller = new AbortController();
  const state = { controller, paused: false };
  activeJobs.set(job.id, state);
  const results = Array.isArray(job.results) ? [...job.results] : [];
  updateJob(job.id, { status: 'running', error: null, endedAt: null });
  emit({ type: 'job-start', id: job.id, at: now() });

  const finish = (status, error) => {
    activeJobs.delete(job.id);
    const updated = updateJob(job.id, { status, results, error: error || null, endedAt: ['done', 'failed', 'cancelled', 'paused', 'interrupted'].includes(status) ? now() : null });
    emit({ type: 'job-end', id: job.id, status, error: error || null, results, at: now() });
    return updated;
  };

  const run = async () => {
    const steps = job.spec.steps || [];
    for (let i = job.checkpoint; i < steps.length; i += 1) {
      if (controller.signal.aborted) return finish('cancelled');
      if (state.paused) return finish('paused');
      const step = steps[i];
      emit({ type: 'job-step', id: job.id, index: i, tool: step.tool, phase: 'start', at: now() });
      const risk = ctx.approvalReason(step.tool, step.args) || null;
      let allowed = true;
      if (risk) {
        if (!ctx.approve) allowed = false;
        else {
          emit({ type: 'job-approval', id: job.id, index: i, tool: step.tool, args: step.args, reason: risk, at: now() });
          try {
            allowed = await ctx.approve({ id: `${job.id}:${i}`, name: step.tool, args: step.args, reason: risk });
          } catch {
            allowed = false;
          }
        }
      }
      if (!allowed) {
        const error = risk ? `Declined: ${risk}` : 'This action needs approval and no approval channel is connected.';
        results.push({ index: i, tool: step.tool, ok: false, output: '', error, ms: 0 });
        updateJob(job.id, { checkpoint: i + 1, results });
        emit({ type: 'job-step', id: job.id, index: i, tool: step.tool, phase: 'error', error, at: now() });
        return finish('failed', error);
      }
      // Record the intent before the side effect. If the process dies mid-step
      // the resume skips it instead of repeating a possibly half-done action.
      updateJob(job.id, { checkpoint: i + 1, results });
      const toolResult = await ctx.runTool(step.tool, step.args, { runId: `job_${job.id}`, signal: controller.signal });
      const entry = {
        index: i,
        tool: step.tool,
        ok: !!toolResult.ok,
        output: clip(toolResult.output || '', 2000),
        error: toolResult.error || null,
        ms: toolResult.ms || 0,
      };
      results.push(entry);
      updateJob(job.id, { checkpoint: i + 1, results });
      emit({ type: 'job-step', id: job.id, index: i, tool: step.tool, phase: entry.ok ? 'done' : 'error', result: entry, at: now() });
      if (!entry.ok && job.spec.stopOnError !== false) return finish('failed', entry.error || `${step.tool} failed`);
    }
    return finish('done');
  };

  const promise = run().catch((err) => finish('failed', err && err.message ? err.message : String(err)));
  if (wait) return promise;
  return getJob(job.id);
}

function startJob(id, opts = {}) {
  return runJob(id, opts);
}

function pauseJob(id) {
  const state = activeJobs.get(String(id));
  if (!state) throw new Error('That job is not running.');
  state.paused = true;
  return getJob(id);
}

function resumeJob(id, opts = {}) {
  const job = getJob(id);
  if (!job) throw new Error('That job no longer exists.');
  if (!['paused', 'interrupted', 'failed'].includes(job.status)) throw new Error(`A ${job.status} job cannot be resumed.`);
  return runJob(id, opts);
}

function cancelJob(id) {
  const state = activeJobs.get(String(id));
  if (state) state.controller.abort();
  const job = getJob(id);
  if (!job) throw new Error('That job no longer exists.');
  if (['done', 'cancelled'].includes(job.status)) return job;
  return updateJob(id, { status: 'cancelled', endedAt: now() });
}

/** Emergency stop: abort every background job at once. */
function cancelAllJobs(reason = 'Emergency stop') {
  let cancelled = 0;
  for (const [id, state] of activeJobs) {
    try {
      state.controller.abort();
      updateJob(id, { status: 'cancelled', error: String(reason).slice(0, 400), endedAt: now() });
      cancelled += 1;
    } catch {
      /* one stuck job must not keep the rest alive */
    }
  }
  activeJobs.clear();
  return { cancelled };
}

function deleteJob(id) {
  const state = activeJobs.get(String(id));
  if (state) state.controller.abort();
  activeJobs.delete(String(id));
  const changes = raw()?.prepare('DELETE FROM adv_jobs WHERE id = ?').run(String(id)).changes || 0;
  return { removed: changes };
}

/* ----------------------------------------------------------- recovery */

function recoveryOverview() {
  const rawDb = raw();
  if (!rawDb) return { runs: [], workflows: [], jobs: [], crashes: [], at: now() };
  const runs = rawDb
    .prepare("SELECT id, goal, status, steps, started_at AS startedAt FROM runs WHERE status IN ('running', 'paused', 'failed') AND checkpoint IS NOT NULL ORDER BY started_at DESC LIMIT 20")
    .all();
  const workflows = rawDb
    .prepare(
      "SELECT r.id, r.workflow_id AS workflowId, w.name, r.status, r.started_at AS startedAt FROM workflow_runs r LEFT JOIN workflows w ON w.id = r.workflow_id WHERE r.status IN ('interrupted', 'queued') ORDER BY r.started_at DESC LIMIT 20",
    )
    .all();
  const jobs = rawDb
    .prepare("SELECT id, title, status, checkpoint, created_at AS createdAt FROM adv_jobs WHERE status IN ('interrupted', 'paused', 'queued', 'failed') ORDER BY created_at DESC LIMIT 20")
    .all()
    .map((j) => ({ ...j, steps: (getJob(j.id)?.spec.steps || []).length }));
  let crashes = [];
  try {
    crashes = ctx.crashes ? ctx.crashes(5) : [];
  } catch {
    crashes = [];
  }
  return { runs, workflows, jobs, crashes, at: now() };
}

async function resumeRecovery({ kind, id, provider, candidates, ...rest } = {}) {
  if (kind === 'job') return resumeJob(id, { wait: false });
  if (kind === 'workflow') {
    if (!ctx.resumeWorkflow) throw new Error('The workflow engine is not connected.');
    return ctx.resumeWorkflow(String(id));
  }
  if (kind === 'run') {
    if (!ctx.resumeRun) throw new Error('The engine is not connected.');
    if (!provider) throw new Error('Pick a provider in the Engine before resuming a run.');
    return ctx.resumeRun({ runId: String(id), provider, candidates: candidates || [], resume: true, ...rest });
  }
  throw new Error(`Unknown recovery kind "${kind}".`);
}

function discardRecovery({ kind, id } = {}) {
  const rawDb = raw();
  if (kind === 'job') return cancelJob(id);
  if (kind === 'workflow') {
    const changes = rawDb?.prepare("UPDATE workflow_runs SET status = 'cancelled', ended_at = ? WHERE id = ?").run(now(), String(id)).changes || 0;
    return { discarded: changes };
  }
  if (kind === 'run') {
    const changes = rawDb?.prepare("UPDATE runs SET status = 'cancelled', ended_at = ? WHERE id = ?").run(now(), String(id)).changes || 0;
    return { discarded: changes };
  }
  throw new Error(`Unknown recovery kind "${kind}".`);
}

/* ------------------------------------------------------------- status */

function status() {
  const rawDb = raw();
  const count = (sql) => {
    try {
      return rawDb?.prepare(sql).get()?.n || 0;
    } catch {
      return 0;
    }
  };
  return {
    mode: modeStatus(),
    rules: count('SELECT COUNT(*) AS n FROM adv_rules'),
    rulesFired: count("SELECT COUNT(*) AS n FROM adv_rule_events WHERE ok = 1"),
    jobs: count('SELECT COUNT(*) AS n FROM adv_jobs'),
    interruptedJobs: count("SELECT COUNT(*) AS n FROM adv_jobs WHERE status IN ('interrupted', 'paused')"),
    suggestions: count("SELECT COUNT(*) AS n FROM adv_learning WHERE status = 'suggested'"),
    selfEvals: count('SELECT COUNT(*) AS n FROM adv_selfevals'),
    lastTick,
    version: ctx.version(),
  };
}

module.exports = {
  init,
  MODES,
  getMode,
  setMode,
  modeStatus,
  planCandidates,
  filterCandidates,
  contextSnapshot,
  localSuggestions,
  suggestContext,
  listRules,
  saveRule,
  deleteRule,
  setRuleEnabled,
  ruleEvents,
  evaluateRule,
  tick,
  startRules,
  stopRules,
  heuristicEval,
  selfEval,
  selfEvalHistory,
  modelCapability,
  routeStats,
  recordOutcome,
  recommendRoute,
  applyRoute,
  mineSequences,
  mineLearning,
  listLearning,
  approveLearning,
  dismissLearning,
  createJob,
  listJobs,
  getJob,
  startJob,
  pauseJob,
  resumeJob,
  cancelJob,
  cancelAllJobs,
  deleteJob,
  recoveryOverview,
  resumeRecovery,
  discardRecovery,
  status,
};
