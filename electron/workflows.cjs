'use strict';

/**
 * Section 13 — real automation engine.
 *
 * Workflows are graphs of trigger/tool/condition/loop/delay/notify/approval/
 * transform nodes. Runs are queued (2 at a time), executed against the real
 * ORVEX tools, checkpointed after every node, resumable after an interruption
 * and gated by the same approval + permission engine the agent uses.
 * Schedules are 5-field cron expressions evaluated by the built-in parser.
 */

const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const MAX_RUNS = 50;
const MAX_STEPS_PER_RUN = 500;
const MAX_EXEC_STEPS = 5000;
const MAX_NODE_VISITS = 120;
const MAX_RUNTIME_MS = 15 * 60 * 1000;
const CONCURRENCY = 2;
const NODE_TYPES = ['trigger', 'tool', 'condition', 'loop', 'delay', 'notify', 'approval', 'transform'];
const OPERATORS = ['truthy', 'falsy', 'equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'matches', 'gt', 'gte', 'lt', 'lte'];

let dataDir = null;
let defsFile = null;
let runsFile = null;
let emit = () => {};
let notify = () => {};
let runTool = async () => ({ ok: false, error: 'The tool runner is not available.' });
let approvalReason = () => null;
let toolExists = () => true;
let onRunFinish = () => {};

const store = {
  workflows: [],
  runs: [],
  active: new Set(),
  timer: null,
  loaded: false,
  writeTimer: null,
  seq: 0,
};

/* --------------------------------------------------------------- utilities */

function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function clip(text, max = 4000) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n…[${s.length - max} more characters]` : s;
}

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function slug(text, fallback = 'workflow') {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || fallback;
}

function newId(prefix) {
  store.seq = (store.seq + 1) % 1000;
  return `${prefix}_${Date.now().toString(36)}${store.seq.toString(36)}`;
}

function signal() {
  try {
    emit({ type: 'changed', at: Date.now() });
  } catch {
    /* renderer is gone */
  }
}

/* -------------------------------------------------------------- cron parser */

function parseField(field, min, max) {
  const set = new Set();
  for (const part of String(field).split(',')) {
    if (!part) throw new Error(`Empty cron list item in "${field}".`);
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart == null ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step "${part}".`);
    let lo;
    let hi;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = Number(a);
      hi = Number(b);
    } else if (stepPart != null) {
      lo = Number(rangePart);
      hi = max;
    } else {
      lo = Number(rangePart);
      hi = Number(rangePart);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`Cron value "${part}" is outside ${min}-${max}.`);
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  if (!set.size) throw new Error(`Cron field "${field}" is empty.`);
  return set;
}

function parseCron(expression) {
  const parts = String(expression || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('A cron expression needs 5 fields: minute hour day month weekday.');
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    day: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    weekday: parseField(parts[4], 0, 7),
    dayStar: parts[2] === '*',
    weekdayStar: parts[4] === '*',
  };
}

function cronNext(expression, from = Date.now()) {
  const cron = typeof expression === 'string' ? parseCron(expression) : expression;
  const date = new Date(Number(from) || Date.now());
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const limit = 400 * 24 * 60;
  for (let i = 0; i < limit; i += 1) {
    if (cron.month.has(date.getMonth() + 1)) {
      const dow = date.getDay();
      const dowOk = cron.weekday.has(dow) || (dow === 0 && cron.weekday.has(7));
      let dayOk;
      if (cron.dayStar && cron.weekdayStar) dayOk = true;
      else if (cron.dayStar) dayOk = dowOk;
      else if (cron.weekdayStar) dayOk = cron.day.has(date.getDate());
      else dayOk = cron.day.has(date.getDate()) || dowOk;
      if (dayOk && cron.hour.has(date.getHours()) && cron.minute.has(date.getMinutes())) {
        return date.getTime();
      }
    }
    date.setMinutes(date.getMinutes() + 1);
  }
  throw new Error('This cron expression never matches within a year.');
}

function cronLabel(expression) {
  try {
    const next = cronNext(expression);
    return `Next ${new Date(next).toLocaleString()}`;
  } catch {
    return 'Invalid schedule';
  }
}

/* ------------------------------------------------------- definition helpers */

const DEFAULT_LABELS = {
  trigger: 'Trigger',
  tool: 'Run a tool',
  condition: 'Condition',
  loop: 'Loop',
  delay: 'Wait',
  notify: 'Notify',
  approval: 'Approval',
  transform: 'Set value',
};

function normalizeNode(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Every node must be an object.');
  const type = String(raw.type || '');
  if (!NODE_TYPES.includes(type)) throw new Error(`Unknown node type "${type}".`);
  const id = String(raw.id || '').trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error(`Node id "${id}" must be 1-40 letters, digits, "-" or "_".`);
  const config = raw.config && typeof raw.config === 'object' ? raw.config : {};
  const position = { x: Number(raw.position?.x) || 0, y: Number(raw.position?.y) || 0 };
  const label = String(raw.label || DEFAULT_LABELS[type]).slice(0, 80);

  if (type === 'trigger') {
    const kind = config.type === 'schedule' ? 'schedule' : 'manual';
    const node = { id, type, label, position, config: { type: kind } };
    if (kind === 'schedule') {
      const cron = String(config.cron || '').trim();
      cronNext(cron);
      node.config.cron = cron;
    }
    return node;
  }
  if (type === 'tool') {
    const tool = String(config.tool || '').trim();
    if (!tool) throw new Error(`Node "${id}" needs a tool.`);
    if (!toolExists(tool)) throw new Error(`Node "${id}" uses unknown tool "${tool}".`);
    const args = config.args && typeof config.args === 'object' && !Array.isArray(config.args) ? config.args : {};
    return {
      id,
      type,
      label,
      position,
      config: {
        tool,
        args,
        retry: {
          attempts: clampInt(config.retry && config.retry.attempts, 1, 5, 1),
          delayMs: clampInt(config.retry && config.retry.delayMs, 0, 60000, 1000),
        },
        onError: config.onError === 'continue' ? 'continue' : 'stop',
      },
    };
  }
  if (type === 'condition') {
    const operator = OPERATORS.includes(config.operator) ? config.operator : 'truthy';
    return {
      id,
      type,
      label,
      position,
      config: { left: String(config.left ?? ''), operator, right: String(config.right ?? '') },
    };
  }
  if (type === 'loop') {
    return {
      id,
      type,
      label,
      position,
      config: {
        mode: config.mode === 'lines' ? 'lines' : 'count',
        count: clampInt(config.count, 0, 50, 3),
        source: String(config.source ?? ''),
        itemVar: String(config.itemVar || 'item').slice(0, 20),
      },
    };
  }
  if (type === 'delay') {
    return { id, type, label, position, config: { ms: clampInt(config.ms, 0, 300000, 1000) } };
  }
  if (type === 'notify') {
    return {
      id,
      type,
      label,
      position,
      config: {
        title: String(config.title || 'ORVEX workflow').slice(0, 80),
        message: String(config.message || '').slice(0, 500),
      },
    };
  }
  if (type === 'approval') {
    return {
      id,
      type,
      label,
      position,
      config: {
        title: String(config.title || 'Approval needed').slice(0, 80),
        message: String(config.message || 'This workflow step needs your approval.').slice(0, 500),
      },
    };
  }
  return { id, type, label, position, config: { template: String(config.template ?? '') } };
}

function normalizeDefinition(input, existing) {
  if (!input || typeof input !== 'object') throw new Error('A workflow definition is required.');
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Give the workflow a name.');
  if (name.length > 80) throw new Error('Workflow names are limited to 80 characters.');
  const nodes = Array.isArray(input.nodes) ? input.nodes.map(normalizeNode) : [];
  if (!nodes.length) throw new Error('A workflow needs at least a trigger node.');
  const ids = new Set();
  for (const node of nodes) {
    if (ids.has(node.id)) throw new Error(`Duplicate node id "${node.id}".`);
    ids.add(node.id);
  }
  const triggers = nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) throw new Error('A workflow needs exactly one trigger node.');

  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const edges = [];
  const edgeKeys = new Set();
  for (const raw of Array.isArray(input.edges) ? input.edges : []) {
    const source = String(raw?.source || '');
    const target = String(raw?.target || '');
    if (!nodesById.has(source) || !nodesById.has(target)) throw new Error('Every edge must connect two nodes in this workflow.');
    if (source === target) throw new Error('A node cannot connect to itself.');
    const sourceType = nodesById.get(source).type;
    let when = String(raw?.when || 'next');
    if (sourceType === 'condition') {
      if (!['true', 'false'].includes(when)) throw new Error('Edges from a condition must be labelled true or false.');
    } else if (sourceType === 'loop') {
      if (!['body', 'done'].includes(when)) throw new Error('Edges from a loop must be labelled body or done.');
    } else if (when !== 'next') {
      when = 'next';
    }
    const key = `${source}|${target}|${when}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({ id: String(raw?.id || `e${edges.length + 1}`), source, target, when });
  }

  const loopWithoutBody = nodes.find((n) => n.type === 'loop' && !edges.some((e) => e.source === n.id && e.when === 'body'));
  if (loopWithoutBody) throw new Error(`Loop "${loopWithoutBody.label}" needs a body edge.`);

  const reachable = new Set();
  const queue = [triggers[0].id];
  while (queue.length) {
    const id = queue.shift();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of edges) if (edge.source === id) queue.push(edge.target);
  }
  const unreachable = nodes.filter((n) => !reachable.has(n.id));
  if (unreachable.length) {
    throw new Error(`Unconnected node(s): ${unreachable.map((n) => n.label).join(', ')}. Connect them to the trigger.`);
  }

  // Cycles are only legal when they land back on a loop node.
  const visiting = new Set();
  const done = new Set();
  const visit = (id) => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      if (nodesById.get(id).type !== 'loop') throw new Error(`The workflow loops through "${nodesById.get(id).label}" without a loop node.`);
      return;
    }
    visiting.add(id);
    for (const edge of edges) if (edge.source === id) visit(edge.target);
    visiting.delete(id);
    done.add(id);
  };
  visit(triggers[0].id);

  const id = existing ? existing.id : uniqueWorkflowId(input.id || slug(name));
  const triggerNode = nodesById.get(triggers[0].id);
  return {
    id,
    name,
    description: String(input.description || '').slice(0, 500),
    enabled: input.enabled === undefined ? true : !!input.enabled,
    nodes,
    edges,
    trigger: { type: triggerNode.config.type, ...(triggerNode.config.cron ? { cron: triggerNode.config.cron } : {}) },
  };
}

function uniqueWorkflowId(base) {
  let id = slug(base);
  if (!store.workflows.some((w) => w.id === id)) return id;
  let n = 2;
  while (store.workflows.some((w) => w.id === `${id}-${n}`)) n += 1;
  return `${id}-${n}`;
}

function computeNextRun(workflow) {
  if (!workflow.enabled || workflow.trigger.type !== 'schedule' || !workflow.trigger.cron) return null;
  try {
    return cronNext(workflow.trigger.cron, Date.now());
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- persistence */

function load() {
  store.workflows = [];
  store.runs = [];
  if (defsFile) {
    try {
      const raw = JSON.parse(fs.readFileSync(defsFile, 'utf8'));
      for (const wf of raw.workflows || []) {
        try {
          const normalized = normalizeDefinition(wf, { id: wf.id });
          normalized.createdAt = wf.createdAt || Date.now();
          normalized.updatedAt = wf.updatedAt || normalized.createdAt;
          normalized.nextRunAt = computeNextRun(normalized);
          store.workflows.push(normalized);
        } catch {
          /* skip a corrupt definition, keep the rest */
        }
      }
    } catch {
      /* first run */
    }
  }
  if (runsFile) {
    try {
      const raw = JSON.parse(fs.readFileSync(runsFile, 'utf8'));
      for (const run of raw.runs || []) {
        if (!run || !run.id) continue;
        if (run.status === 'running') {
          run.status = 'interrupted';
          run.error = 'ORVEX stopped while this run was executing. Resume it to continue from the last finished step.';
          run.suspended = null;
        }
        store.runs.push(run);
      }
      store.runs.sort((a, b) => (b.queuedAt || 0) - (a.queuedAt || 0));
      trimRuns();
    } catch {
      /* first run */
    }
  }
  store.loaded = true;
}

function persistDefinitions() {
  if (!defsFile) return;
  try {
    fs.mkdirSync(path.dirname(defsFile), { recursive: true });
    fs.writeFileSync(defsFile, JSON.stringify({ version: VERSION, workflows: store.workflows }, null, 2), 'utf8');
  } catch {
    /* read-only profile */
  }
}

function flushRuns() {
  if (store.writeTimer) {
    clearTimeout(store.writeTimer);
    store.writeTimer = null;
  }
  if (!runsFile) return;
  try {
    fs.mkdirSync(path.dirname(runsFile), { recursive: true });
    fs.writeFileSync(runsFile, JSON.stringify({ version: VERSION, runs: store.runs }, null, 2), 'utf8');
  } catch {
    /* read-only profile */
  }
}

function persistRuns(immediate = false) {
  if (immediate) {
    flushRuns();
    return;
  }
  if (store.writeTimer) return;
  store.writeTimer = setTimeout(() => {
    store.writeTimer = null;
    flushRuns();
  }, 300);
  if (store.writeTimer.unref) store.writeTimer.unref();
}

/* ---------------------------------------------------------------- public API */

function init(opts = {}) {
  if (opts.dataDir) {
    dataDir = opts.dataDir;
    defsFile = path.join(dataDir, 'workflows.json');
    runsFile = path.join(dataDir, 'workflow-runs.json');
  }
  if (typeof opts.emit === 'function') emit = opts.emit;
  if (typeof opts.notify === 'function') notify = opts.notify;
  if (typeof opts.runTool === 'function') runTool = opts.runTool;
  if (typeof opts.approvalReason === 'function') approvalReason = opts.approvalReason;
  if (typeof opts.toolExists === 'function') toolExists = opts.toolExists;
  if (typeof opts.onRunFinish === 'function') onRunFinish = opts.onRunFinish;
  load();
  return { workflows: store.workflows.length, runs: store.runs.length };
}

function start() {
  if (!store.loaded) load();
  if (store.timer) return;
  store.timer = setInterval(() => {
    try {
      tick();
    } catch (err) {
      signal();
      console.error('Workflow scheduler:', err && err.message ? err.message : err);
    }
  }, 30000);
  if (store.timer.unref) store.timer.unref();
  tick();
}

function stop() {
  if (store.timer) {
    clearInterval(store.timer);
    store.timer = null;
  }
  flushRuns();
}

function tick() {
  const now = Date.now();
  let changed = false;
  for (const wf of store.workflows) {
    if (!wf.enabled || wf.trigger.type !== 'schedule') {
      if (wf.nextRunAt != null) {
        wf.nextRunAt = null;
        changed = true;
      }
      continue;
    }
    if (wf.nextRunAt == null || Number.isNaN(wf.nextRunAt)) {
      wf.nextRunAt = computeNextRun(wf);
      changed = true;
    }
    if (wf.nextRunAt != null && now >= wf.nextRunAt) {
      const busy = store.runs.some(
        (r) => r.workflowId === wf.id && ['queued', 'running', 'awaiting_approval'].includes(r.status),
      );
      if (!busy) enqueue(wf, { scheduledAt: nowIso(wf.nextRunAt) }, 'schedule');
      wf.nextRunAt = cronNext(wf.trigger.cron, now);
      changed = true;
    }
  }
  if (changed) persistDefinitions();
  pump();
}

function list() {
  const stats = {
    workflows: store.workflows.length,
    enabled: store.workflows.filter((w) => w.enabled).length,
    scheduled: store.workflows.filter((w) => w.enabled && w.trigger.type === 'schedule').length,
    queued: store.runs.filter((r) => r.status === 'queued').length,
    running: store.runs.filter((r) => r.status === 'running').length,
    awaiting: store.runs.filter((r) => r.status === 'awaiting_approval').length,
    interrupted: store.runs.filter((r) => r.status === 'interrupted').length,
    failed: store.runs.filter((r) => r.status === 'failed').length,
  };
  return {
    workflows: store.workflows.map((wf) => ({ ...wf, nextRunAt: wf.nextRunAt ?? null, nextRun: wf.nextRunAt ? nowIso(wf.nextRunAt) : null, lastRun: lastRunOf(wf.id) })),
    runs: store.runs.map(runSummary),
    stats,
    concurrency: CONCURRENCY,
  };
}

function lastRunOf(workflowId) {
  const run = store.runs.find((r) => r.workflowId === workflowId);
  return run ? runSummary(run) : null;
}

function runSummary(run) {
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    status: run.status,
    trigger: run.trigger,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    steps: run.steps.length,
    error: run.error,
    suspended: run.suspended ? { ...run.suspended } : null,
    cancelRequested: !!run.cancelRequested,
    output: clip(run.output || '', 300),
  };
}

function runDetail(id) {
  const run = findRun(id);
  return {
    ...run,
    summary: runSummary(run),
    workflow: store.workflows.find((w) => w.id === run.workflowId) || null,
  };
}

function findRun(id) {
  const run = store.runs.find((r) => r.id === String(id || ''));
  if (!run) throw new Error(`No workflow run with id "${id}".`);
  return run;
}

function findWorkflow(idOrName) {
  const key = String(idOrName || '').trim();
  return store.workflows.find((w) => w.id === key) || store.workflows.find((w) => w.name.toLowerCase() === key.toLowerCase());
}

function save(input) {
  const existing = input && input.id ? store.workflows.find((w) => w.id === String(input.id)) : null;
  const def = normalizeDefinition(input, existing);
  def.updatedAt = Date.now();
  def.createdAt = existing ? existing.createdAt : def.updatedAt;
  def.nextRunAt = computeNextRun(def);
  if (existing) {
    const index = store.workflows.indexOf(existing);
    store.workflows[index] = def;
  } else {
    store.workflows.push(def);
  }
  persistDefinitions();
  signal();
  return { ...def };
}

function remove(id) {
  const wf = findWorkflow(id);
  if (!wf) throw new Error(`No workflow with id "${id}".`);
  for (const run of store.runs) {
    if (run.workflowId === wf.id && ['queued', 'running', 'awaiting_approval', 'interrupted'].includes(run.status)) {
      run.cancelRequested = true;
      run.status = 'cancelled';
      run.endedAt = Date.now();
      run.suspended = null;
      run.error = 'The workflow was deleted.';
    }
  }
  store.workflows = store.workflows.filter((w) => w.id !== wf.id);
  persistDefinitions();
  persistRuns(true);
  signal();
  return { removed: wf.id };
}

function setEnabled(id, enabled) {
  const wf = findWorkflow(id);
  if (!wf) throw new Error(`No workflow with id "${id}".`);
  wf.enabled = !!enabled;
  wf.updatedAt = Date.now();
  wf.nextRunAt = computeNextRun(wf);
  persistDefinitions();
  signal();
  return { ...wf, lastRun: lastRunOf(wf.id) };
}

/* ------------------------------------------------------------------ engine */

function makeRun(workflow, input, trigger) {
  const triggerNode = workflow.nodes.find((n) => n.type === 'trigger');
  return {
    id: newId('run'),
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'queued',
    trigger: trigger || (workflow.trigger.type === 'schedule' ? 'schedule' : 'manual'),
    input: input && typeof input === 'object' && !Array.isArray(input) ? input : {},
    queuedAt: Date.now(),
    startedAt: null,
    endedAt: null,
    steps: [],
    outputs: {},
    output: '',
    error: null,
    suspended: null,
    cancelRequested: false,
    cursor: { stack: [{ node: triggerNode.id }], loops: {}, counts: {}, approvals: {}, loopStack: [] },
  };
}

function takeApproval(run, nodeId) {
  // One approval covers one execution. A node revisited by a loop asks again.
  if (!run.cursor.approvals[nodeId]) return false;
  delete run.cursor.approvals[nodeId];
  return true;
}

function enqueue(workflow, input, trigger) {
  const run = makeRun(workflow, input, trigger);
  store.runs.unshift(run);
  trimRuns();
  persistRuns();
  signal();
  pump();
  return run;
}

/** Keep history bounded without ever throwing away a run that is still alive. */
function trimRuns() {
  if (store.runs.length <= MAX_RUNS) return;
  const live = new Set(['queued', 'running', 'awaiting_approval']);
  for (let i = store.runs.length - 1; i >= 0 && store.runs.length > MAX_RUNS; i -= 1) {
    if (!live.has(store.runs[i].status)) store.runs.splice(i, 1);
  }
}

function runNow(idOrName, input) {
  const wf = findWorkflow(idOrName);
  if (!wf) throw new Error(`No workflow matches "${idOrName}".`);
  const run = enqueue(wf, input, 'manual');
  return { ...runSummary(run) };
}

function pump() {
  while (store.active.size < CONCURRENCY) {
    const run = [...store.runs].reverse().find((r) => r.status === 'queued');
    if (!run) return;
    store.active.add(run.id);
    void execute(run)
      .catch(() => {})
      .finally(() => {
        store.active.delete(run.id);
        pump();
      });
  }
}

async function execute(run) {
  const wf = store.workflows.find((w) => w.id === run.workflowId);
  run.status = 'running';
  run.startedAt = run.startedAt || Date.now();
  run.error = null;
  persistRuns();
  signal();
  try {
    if (!wf) throw new Error('This workflow no longer exists.');
    let steps = 0;
    while (run.cursor.stack.length) {
      if (run.cancelRequested) {
        finish(run, 'cancelled', 'Cancelled by you.');
        return;
      }
      if (Date.now() - run.startedAt > MAX_RUNTIME_MS) throw new Error('The run exceeded the 15 minute limit.');
      steps += 1;
      if (steps > MAX_EXEC_STEPS) throw new Error('The run exceeded the step limit.');
      const task = run.cursor.stack[0];
      const outcome = await executeNode(run, wf, task.node);
      if (outcome === 'suspended') {
        persistRuns(true);
        signal();
        return;
      }
      const index = run.cursor.stack.indexOf(task);
      if (index >= 0) run.cursor.stack.splice(index, 1);
    }
    if (run.cancelRequested) {
      finish(run, 'cancelled', 'Cancelled by you.');
      return;
    }
    finish(run, 'succeeded', null);
  } catch (err) {
    finish(run, 'failed', err && err.message ? err.message : String(err));
  }
}

function finish(run, status, error) {
  run.status = status;
  run.endedAt = Date.now();
  run.error = error || null;
  run.suspended = null;
  if (status === 'succeeded') {
    const last = [...run.steps].reverse().find((s) => s.ok && s.output);
    run.output = last ? clip(last.output, 20000) : '';
  }
  persistRuns(true);
  signal();
  try {
    onRunFinish({ ...run, steps: run.steps.slice(), outputs: undefined });
  } catch {
    /* training capture must never break the run */
  }
  if (status === 'failed') {
    try {
      notify({
        title: `Workflow failed: ${run.workflowName}`,
        body: String(error || 'A step failed.').slice(0, 200),
      });
    } catch {
      /* notifications unavailable */
    }
  }
}

function record(run, node, entry) {
  const step = {
    nodeId: node.id,
    label: node.label,
    type: node.type,
    at: Date.now(),
    ok: !!entry.ok,
    output: clip(entry.output || ''),
    error: entry.error ? clip(entry.error, 2000) : null,
    ms: Number(entry.ms) || 0,
    ...(entry.meta || {}),
  };
  run.steps.push(step);
  if (run.steps.length > MAX_STEPS_PER_RUN) run.steps.splice(0, run.steps.length - MAX_STEPS_PER_RUN);
  run.outputs[node.id] = { ok: step.ok, output: step.ok ? step.output : '', error: step.error };
  persistRuns();
}

function ctxOf(run) {
  const activeId = run.cursor.loopStack[run.cursor.loopStack.length - 1];
  const loop = activeId ? run.cursor.loops[activeId] : null;
  return {
    input: run.input,
    steps: run.outputs,
    run: { id: run.id },
    loop: loop
      ? { index: loop.iteration - 1, n: loop.iteration, total: loop.total, item: loop.items[loop.iteration - 1] ?? '' }
      : {},
  };
}

function readPath(root, expression) {
  let current = root;
  for (const part of String(expression).split('.')) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function render(text, ctx) {
  if (typeof text !== 'string') return text;
  return text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, expression) => {
    const value = readPath(ctx, expression.trim());
    if (value === undefined) return match;
    if (value === null) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

function renderDeep(value, ctx) {
  if (typeof value === 'string') return render(value, ctx);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderDeep(v, ctx);
    return out;
  }
  return value;
}

function evaluateCondition(left, operator, right) {
  const l = String(left ?? '');
  const r = String(right ?? '');
  const lowerL = l.toLowerCase();
  const lowerR = r.toLowerCase();
  switch (operator) {
    case 'truthy':
      return !['', 'false', '0', 'null', 'undefined'].includes(lowerL);
    case 'falsy':
      return ['', 'false', '0', 'null', 'undefined'].includes(lowerL);
    case 'equals':
      return l === r;
    case 'notEquals':
      return l !== r;
    case 'contains':
      return lowerL.includes(lowerR);
    case 'notContains':
      return !lowerL.includes(lowerR);
    case 'startsWith':
      return lowerL.startsWith(lowerR);
    case 'endsWith':
      return lowerL.endsWith(lowerR);
    case 'matches': {
      let re;
      try {
        re = new RegExp(r, 'i');
      } catch {
        throw new Error(`"${r}" is not a valid regular expression.`);
      }
      return re.test(l);
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = Number(l);
      const b = Number(r);
      if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`"${l}" and "${r}" are not numbers.`);
      if (operator === 'gt') return a > b;
      if (operator === 'gte') return a >= b;
      if (operator === 'lt') return a < b;
      return a <= b;
    }
    default:
      throw new Error(`Unknown condition operator "${operator}".`);
  }
}

function pushNext(run, workflow, node, when) {
  const edges = workflow.edges.filter((e) => e.source === node.id && e.when === when);
  for (let i = edges.length - 1; i >= 0; i -= 1) run.cursor.stack.unshift({ node: edges[i].target });
}

function sleepCancelable(run, ms) {
  return new Promise((resolve) => {
    const until = Date.now() + ms;
    const tickMs = () => {
      if (run.cancelRequested || Date.now() >= until) {
        resolve();
        return;
      }
      setTimeout(tickMs, Math.min(100, until - Date.now()));
    };
    tickMs();
  });
}

async function executeNode(run, workflow, nodeId) {
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`Node "${nodeId}" is missing from this workflow.`);
  const counts = run.cursor.counts;
  counts[nodeId] = (counts[nodeId] || 0) + 1;
  if (counts[nodeId] > MAX_NODE_VISITS) throw new Error(`Node "${node.label}" ran too many times — check the loop wiring.`);

  if (node.type === 'trigger') {
    record(run, node, {
      ok: true,
      output: run.trigger === 'schedule' ? `Scheduled run (${node.config.cron || 'cron'}).` : `Started from ${run.trigger === 'agent' ? 'the agent' : 'the Automations page'}.`,
    });
    pushNext(run, workflow, node, 'next');
    return 'next';
  }

  if (node.type === 'tool') {
    const args = renderDeep(node.config.args, ctxOf(run));
    const tool = node.config.tool;
    let reason = null;
    try {
      reason = approvalReason(tool, args);
    } catch {
      reason = null;
    }
    if (reason && !takeApproval(run, node.id)) {
      run.status = 'awaiting_approval';
      run.suspended = { nodeId: node.id, kind: 'tool', tool, reason, title: node.label, at: Date.now() };
      return 'suspended';
    }
    const attempts = Math.max(1, node.config.retry.attempts || 1);
    let result = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const started = Date.now();
      try {
        result = await runTool(tool, args, { runId: run.id, source: 'workflow' });
      } catch (err) {
        result = { ok: false, error: err && err.message ? err.message : String(err) };
      }
      result = { ...result, ms: Number(result.ms) || Date.now() - started };
      if (result.ok) break;
      if (attempt < attempts) await sleepCancelable(run, node.config.retry.delayMs);
    }
    record(run, node, {
      ok: !!result.ok,
      output: result.output || '',
      error: result.ok ? null : result.error || 'The tool failed.',
      ms: result.ms,
      meta: { attempts },
    });
    if (!result.ok) {
      if (node.config.onError === 'continue') {
        pushNext(run, workflow, node, 'next');
        return 'next';
      }
      throw new Error(`${node.label}: ${result.error || 'the tool failed'}`);
    }
    pushNext(run, workflow, node, 'next');
    return 'next';
  }

  if (node.type === 'condition') {
    const ctx = ctxOf(run);
    const left = render(node.config.left, ctx);
    const right = render(node.config.right, ctx);
    let verdict;
    try {
      verdict = evaluateCondition(left, node.config.operator, right);
    } catch (err) {
      record(run, node, { ok: false, error: err.message });
      throw err;
    }
    record(run, node, {
      ok: true,
      output: `${node.config.operator} → ${verdict ? 'true' : 'false'}`,
      meta: { when: verdict ? 'true' : 'false', left: clip(left, 500), right: clip(right, 500) },
    });
    pushNext(run, workflow, node, verdict ? 'true' : 'false');
    return 'next';
  }

  if (node.type === 'loop') {
    let loop = run.cursor.loops[node.id];
    if (!loop) {
      let total = 0;
      let items = [];
      if (node.config.mode === 'lines') {
        const text = String(render(node.config.source, ctxOf(run)) || '');
        items = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 100);
        total = items.length;
      } else {
        total = clampInt(Number(render(String(node.config.count), ctxOf(run))), 0, 50, 0);
      }
      loop = run.cursor.loops[node.id] = { total, iteration: 0, items };
      run.cursor.loopStack.push(node.id);
    }
    if (loop.iteration >= loop.total) {
      delete run.cursor.loops[node.id];
      const index = run.cursor.loopStack.lastIndexOf(node.id);
      if (index >= 0) run.cursor.loopStack.splice(index, 1);
      record(run, node, { ok: true, output: `Loop finished after ${loop.total} iteration(s).`, meta: { total: loop.total } });
      pushNext(run, workflow, node, 'done');
      return 'next';
    }
    loop.iteration += 1;
    record(run, node, {
      ok: true,
      output: `Iteration ${loop.iteration} of ${loop.total}${loop.items[loop.iteration - 1] != null ? ` — ${loop.items[loop.iteration - 1]}` : ''}`,
      meta: { iteration: loop.iteration, total: loop.total, item: loop.items[loop.iteration - 1] ?? null },
    });
    pushNext(run, workflow, node, 'body');
    return 'next';
  }

  if (node.type === 'delay') {
    const ms = clampInt(Number(render(String(node.config.ms), ctxOf(run))), 0, 300000, 0);
    await sleepCancelable(run, ms);
    record(run, node, { ok: true, output: `Waited ${ms} ms.`, ms });
    pushNext(run, workflow, node, 'next');
    return 'next';
  }

  if (node.type === 'notify') {
    const ctx = ctxOf(run);
    const title = render(node.config.title || 'ORVEX workflow', ctx);
    const message = render(node.config.message || '', ctx);
    let delivered = true;
    try {
      notify({ title: String(title).slice(0, 80), body: String(message).slice(0, 400) });
    } catch {
      delivered = false;
    }
    record(run, node, { ok: true, output: `${delivered ? 'Notification sent' : 'Notification unavailable'}: ${title}${message ? ` — ${message}` : ''}` });
    pushNext(run, workflow, node, 'next');
    return 'next';
  }

  if (node.type === 'approval') {
    if (!takeApproval(run, node.id)) {
      const ctx = ctxOf(run);
      run.status = 'awaiting_approval';
      run.suspended = {
        nodeId: node.id,
        kind: 'approval',
        title: render(node.config.title, ctx),
        reason: render(node.config.message, ctx),
        at: Date.now(),
      };
      return 'suspended';
    }
    record(run, node, { ok: true, output: 'Approved by you.' });
    pushNext(run, workflow, node, 'next');
    return 'next';
  }

  const text = String(render(node.config.template || '', ctxOf(run)));
  record(run, node, { ok: true, output: text });
  pushNext(run, workflow, node, 'next');
  return 'next';
}

/* ------------------------------------------------------------- run controls */

function approve(runId, allow) {
  const run = findRun(runId);
  const wf = store.workflows.find((w) => w.id === run.workflowId);
  if (!run.suspended) throw new Error('This run is not waiting for approval.');
  const suspended = run.suspended;
  const node = wf ? wf.nodes.find((n) => n.id === suspended.nodeId) : null;
  run.suspended = null;
  if (!allow) {
    run.status = 'failed';
    run.endedAt = Date.now();
    run.error = suspended.kind === 'approval' ? 'You rejected this step.' : 'You rejected the tool call.';
    if (node) {
      run.steps.push({ nodeId: node.id, label: node.label, type: node.type, at: Date.now(), ok: false, output: '', error: run.error, ms: 0 });
      run.outputs[node.id] = { ok: false, output: '', error: run.error };
    }
    persistRuns(true);
    signal();
    return runSummary(run);
  }
  run.cursor.approvals[suspended.nodeId] = true;
  run.status = 'queued';
  run.error = null;
  persistRuns();
  signal();
  pump();
  return runSummary(run);
}

function cancel(runId) {
  const run = findRun(runId);
  if (['succeeded', 'failed', 'cancelled'].includes(run.status)) throw new Error('This run already finished.');
  run.cancelRequested = true;
  if (run.status === 'queued' || run.status === 'awaiting_approval' || run.status === 'interrupted') {
    run.status = 'cancelled';
    run.endedAt = Date.now();
    run.suspended = null;
    run.error = 'Cancelled by you.';
    persistRuns(true);
  }
  signal();
  return runSummary(run);
}

function resume(runId) {
  const run = findRun(runId);
  if (run.status === 'awaiting_approval') throw new Error('Approve or reject this run instead of resuming it.');
  if (!['interrupted', 'queued'].includes(run.status)) throw new Error(`A ${run.status} run cannot be resumed.`);
  run.status = 'queued';
  run.cancelRequested = false;
  run.error = null;
  persistRuns();
  signal();
  pump();
  return runSummary(run);
}

function runsFor(workflowId, limit = 20) {
  const list = workflowId ? store.runs.filter((r) => r.workflowId === workflowId) : store.runs;
  return list.slice(0, clampInt(limit, 1, MAX_RUNS, 20)).map(runSummary);
}

function clearRuns(workflowId) {
  const active = ['queued', 'running', 'awaiting_approval', 'interrupted'];
  const scope = workflowId ? String(workflowId) : null;
  const kept = store.runs.filter((r) => active.includes(r.status) || (scope && r.workflowId !== scope));
  const removed = store.runs.length - kept.length;
  store.runs = kept;
  persistRuns(true);
  signal();
  return { removed, kept: kept.length };
}

/* ---------------------------------------------------------------- templates */

function templateDefs() {
  return [
    {
      id: 'daily-briefing',
      name: 'Daily system briefing',
      description: 'Every morning at 09:00, capture the real system status and notify you when the report is ready.',
      workflow: {
        name: 'Daily system briefing',
        description: 'Captures sys_info on a 09:00 schedule.',
        enabled: true,
        nodes: [
          { id: 'trigger', type: 'trigger', label: 'Every day at 09:00', position: { x: 80, y: 40 }, config: { type: 'schedule', cron: '0 9 * * *' } },
          { id: 'status', type: 'tool', label: 'System status', position: { x: 80, y: 200 }, config: { tool: 'system_status', args: {}, retry: { attempts: 1, delayMs: 1000 }, onError: 'stop' } },
          { id: 'notify', type: 'notify', label: 'Tell me it is ready', position: { x: 80, y: 360 }, config: { title: 'Daily briefing ready', message: 'ORVEX captured the system status. Open Runs for the full report.' } },
        ],
        edges: [
          { id: 'e1', source: 'trigger', target: 'status', when: 'next' },
          { id: 'e2', source: 'status', target: 'notify', when: 'next' },
        ],
      },
    },
    {
      id: 'api-heartbeat',
      name: 'API heartbeat',
      description: 'Calls a real HTTP endpoint, checks that the reply is HTTP 200 and notifies you either way.',
      workflow: {
        name: 'API heartbeat',
        description: 'Checks https://api.github.com/zen and reports the result.',
        enabled: false,
        nodes: [
          { id: 'trigger', type: 'trigger', label: 'Run manually', position: { x: 80, y: 40 }, config: { type: 'manual' } },
          { id: 'call', type: 'tool', label: 'GET api.github.com/zen', position: { x: 80, y: 200 }, config: { tool: 'http_request', args: { method: 'GET', url: 'https://api.github.com/zen' }, retry: { attempts: 2, delayMs: 1500 }, onError: 'stop' } },
          { id: 'check', type: 'condition', label: 'Was it 200?', position: { x: 80, y: 360 }, config: { left: '{{steps.call.output}}', operator: 'contains', right: '200' } },
          { id: 'up', type: 'notify', label: 'Say it is up', position: { x: 40, y: 520 }, config: { title: 'API is up', message: 'The endpoint answered with HTTP 200.' } },
          { id: 'down', type: 'notify', label: 'Say it is down', position: { x: 300, y: 520 }, config: { title: 'API problem', message: 'The endpoint did not answer with 200. Check Runs for the response.' } },
        ],
        edges: [
          { id: 'e1', source: 'trigger', target: 'call', when: 'next' },
          { id: 'e2', source: 'call', target: 'check', when: 'next' },
          { id: 'e3', source: 'check', target: 'up', when: 'true' },
          { id: 'e4', source: 'check', target: 'down', when: 'false' },
        ],
      },
    },
    {
      id: 'loop-pause',
      name: 'Loop and pause',
      description: 'Runs a body three times with a one second pause and a live counter, then notifies you. Shows loops and delays.',
      workflow: {
        name: 'Loop and pause',
        description: 'Three iterations with a delay each time.',
        enabled: false,
        nodes: [
          { id: 'trigger', type: 'trigger', label: 'Run manually', position: { x: 80, y: 40 }, config: { type: 'manual' } },
          { id: 'loop', type: 'loop', label: 'Repeat 3 times', position: { x: 80, y: 180 }, config: { mode: 'count', count: 3, itemVar: 'item' } },
          { id: 'wait', type: 'delay', label: 'Wait 1s', position: { x: 80, y: 340 }, config: { ms: 1000 } },
          { id: 'note', type: 'transform', label: 'Tick', position: { x: 80, y: 500 }, config: { template: 'Tick {{loop.n}} of {{loop.total}}' } },
          { id: 'done', type: 'notify', label: 'Finished', position: { x: 80, y: 660 }, config: { title: 'Loop finished', message: 'All iterations completed.' } },
        ],
        edges: [
          { id: 'e1', source: 'trigger', target: 'loop', when: 'next' },
          { id: 'e2', source: 'loop', target: 'wait', when: 'body' },
          { id: 'e3', source: 'wait', target: 'note', when: 'next' },
          { id: 'e4', source: 'note', target: 'loop', when: 'next' },
          { id: 'e5', source: 'loop', target: 'done', when: 'done' },
        ],
      },
    },
    {
      id: 'guarded-action',
      name: 'Guarded action',
      description: 'Waits for your approval before it notifies you. Pair this block with any risky tool node.',
      workflow: {
        name: 'Guarded action',
        description: 'An approval gate in front of the next step.',
        enabled: false,
        nodes: [
          { id: 'trigger', type: 'trigger', label: 'Run manually', position: { x: 80, y: 40 }, config: { type: 'manual' } },
          { id: 'gate', type: 'approval', label: 'Ask me first', position: { x: 80, y: 200 }, config: { title: 'Workflow approval', message: 'Continue with the guarded action?' } },
          { id: 'done', type: 'notify', label: 'Approved', position: { x: 80, y: 360 }, config: { title: 'Guarded action approved', message: 'You approved the step and the workflow continued.' } },
        ],
        edges: [
          { id: 'e1', source: 'trigger', target: 'gate', when: 'next' },
          { id: 'e2', source: 'gate', target: 'done', when: 'next' },
        ],
      },
    },
  ].map((template) => ({ ...template, workflow: withTemplateTrigger(template.workflow) }));
}

function withTemplateTrigger(workflow) {
  const node = workflow.nodes.find((n) => n.type === 'trigger');
  return {
    ...workflow,
    trigger: { type: node.config.type, ...(node.config.cron ? { cron: node.config.cron } : {}) },
  };
}

function createFromTemplate(templateId) {
  const template = templateDefs().find((t) => t.id === String(templateId || ''));
  if (!template) throw new Error(`No workflow template with id "${templateId}".`);
  const wf = save({
    ...template.workflow,
    name: uniqueWorkflowName(template.workflow.name),
    id: undefined,
  });
  return { ...wf, lastRun: lastRunOf(wf.id) };
}

function uniqueWorkflowName(name) {
  if (!store.workflows.some((w) => w.name === name)) return name;
  let n = 2;
  while (store.workflows.some((w) => w.name === `${name} ${n}`)) n += 1;
  return `${name} ${n}`;
}

/* -------------------------------------------------------------- agent tools */

function agentList() {
  if (!store.workflows.length) return { ok: true, output: 'No workflows yet. Create one on the Automations page or add a template.' };
  const lines = store.workflows.map((w) => `[${w.id}] ${w.name} — ${w.trigger.type === 'schedule' ? `cron ${w.trigger.cron}` : 'manual'} · ${w.enabled ? 'enabled' : 'paused'}${w.lastRun ? ` · last run ${w.lastRun.status}` : ''}`);
  return { ok: true, output: lines.join('\n'), workflows: list().workflows };
}

function agentRun(idOrName, input) {
  const wf = findWorkflow(idOrName);
  if (!wf) throw new Error(`No workflow matches "${idOrName}".`);
  const run = enqueue(wf, input, 'agent');
  return { ok: true, output: `Queued "${wf.name}" as ${run.id}.`, run: runSummary(run) };
}

function agentStatus(workflowId, limit) {
  const runs = runsFor(workflowId, limit);
  if (!runs.length) return { ok: true, output: 'No workflow runs yet.', runs: [] };
  return {
    ok: true,
    output: runs.map((r) => `${r.id} ${r.workflowName} — ${r.status}${r.error ? ` (${String(r.error).slice(0, 100)})` : ''} · ${r.steps} step(s)`).join('\n'),
    runs,
  };
}

function agentCancel(runId) {
  const run = cancel(runId);
  return { ok: true, output: `Run ${run.id} is ${run.status}.`, run };
}

const definitions = [
  {
    name: 'workflow_list',
    description: 'List the real automation workflows in ORVEX with their trigger, schedule state and last run.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'workflow_run',
    description: 'Queue a real ORVEX workflow by id or name. Optional input variables are available to nodes as {{input.name}}. Returns the run id.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Workflow id or exact name.' },
        input: { type: 'object', description: 'Optional input variables for the run.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'workflow_status',
    description: 'Show recent workflow runs, optionally limited to one workflow.',
    parameters: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Optional workflow id.' },
        limit: { type: 'number', description: 'How many runs to show (default 10).' },
      },
    },
  },
  {
    name: 'workflow_cancel',
    description: 'Cancel a queued, running or waiting workflow run.',
    parameters: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Run id from workflow_status.' } },
      required: ['runId'],
    },
  },
];

const agentHandlers = {
  workflow_list: () => agentList(),
  workflow_run: (args) => agentRun(args.id, args.input),
  workflow_status: (args) => agentStatus(args.workflowId, args.limit),
  workflow_cancel: (args) => agentCancel(args.runId),
};

module.exports = {
  init,
  start,
  stop,
  list,
  save,
  remove,
  setEnabled,
  runNow,
  runsFor,
  runDetail,
  clearRuns,
  approve,
  cancel,
  resume,
  templateDefs,
  createFromTemplate,
  cronNext,
  cronLabel,
  definitions,
  agentHandlers,
  agentList,
  agentRun,
  agentStatus,
  agentCancel,
  _internals: { parseCron, normalizeDefinition, evaluateCondition, render, computeNextRun },
};
