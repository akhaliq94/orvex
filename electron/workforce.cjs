'use strict';

/**
 * Phase 7 — Digital Workforce.
 *
 * Persistent agents with a role, mission, model assignment, optional cron
 * schedule, a USD budget, memory notes, shift history and an inbox of real
 * deliverables. A shift is a normal ORVEX engine run: the scheduler never
 * fakes output, it only decides *when* a real run starts and records what
 * actually happened.
 */

const crypto = require('node:crypto');

const db = require('./db.cjs');
const workflows = require('./workflows.cjs');

const TICK_MS = 30_000;
const RETRY_MS = 2 * 60_000;
const MAX_MEMORY_NOTES = 20;
const MAX_GOAL = 4000;
const MAX_SUMMARY = 2000;
const SHIFT_OPEN = `('running')`;

let ctx = {
  dataDir: process.cwd(),
  emit: () => {},
  notify: () => {},
  runShift: null,
  isEngineBusy: () => false,
};
let timer = null;
let ticking = false;

/* --------------------------------------------------------------- utilities */

function now() {
  return Date.now();
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function raw() {
  const handle = db.raw();
  if (!handle) throw new Error('The local database is not ready.');
  return handle;
}

function emit(event) {
  try {
    ctx.emit({ ...event, at: now() });
  } catch {
    /* the window may be gone */
  }
}

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…[trimmed]` : text;
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function message(err) {
  return err && err.message ? err.message : String(err);
}

/* ------------------------------------------------------------ normalisation */

/**
 * Store only what the engine needs to reach a model. API keys are never part
 * of an agent row; main hydrates the key at run time from the vault binding.
 */
function cleanModel(input) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input !== 'object') throw new Error('The model assignment must be an object.');
  const baseUrl = String(input.baseUrl || '').trim();
  const model = String(input.model || '').trim();
  if (!baseUrl || !model) return null;
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('The model base URL is not valid.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('The model base URL must be http(s).');
  }
  return {
    providerId: clip(input.providerId || input.id || '', 80),
    presetId: clip(input.presetId || '', 80),
    name: clip(input.name || input.providerId || 'Model', 120),
    baseUrl: clip(baseUrl, 400),
    model: clip(model, 200),
    api: input.api === 'anthropic' ? 'anthropic' : 'openai',
  };
}

function cleanSchedule(input) {
  const schedule = String(input || '').trim();
  if (!schedule) return null;
  workflows.cronNext(schedule);
  return schedule.slice(0, 120);
}

function cleanBudget(input) {
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100) / 100;
}

function normalizeDefinition(input = {}, existing = null) {
  const name = String(input.name ?? existing?.name ?? '').trim();
  if (name.length < 2 || name.length > 80) throw new Error('Agent name must be 2–80 characters.');
  const mission = String(input.mission ?? existing?.mission ?? '').trim();
  if (mission.length < 8) throw new Error('Give the agent a mission of at least 8 characters.');
  if (mission.length > MAX_GOAL) throw new Error('The mission is too long.');
  const role = clip(input.role ?? existing?.role ?? 'operator', 60).trim() || 'operator';
  const model = input.model === undefined ? existing?.model ?? null : cleanModel(input.model);
  const schedule = input.schedule === undefined ? existing?.schedule ?? null : cleanSchedule(input.schedule);
  const budgetUsd = input.budgetUsd === undefined ? existing?.budgetUsd ?? 0 : cleanBudget(input.budgetUsd);
  return { name, mission, role, model, schedule, budgetUsd };
}

function mapAgent(row) {
  const budgetUsd = Number(row.budget_usd) || 0;
  const spentUsd = Number(row.spent_usd) || 0;
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    mission: row.mission,
    model: parseJson(row.model, null),
    schedule: row.schedule || null,
    status: row.status,
    budgetUsd,
    spentUsd,
    runs: Number(row.runs) || 0,
    successes: Number(row.successes) || 0,
    lastRunAt: row.last_run_at || null,
    nextRunAt: row.next_run_at || null,
    memory: parseJson(row.memory, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    budgetBlocked: budgetUsd > 0 && spentUsd >= budgetUsd,
  };
}

function mapShift(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name || null,
    goal: row.goal,
    status: row.status,
    trigger: row.trigger,
    runId: row.run_id || null,
    summary: row.summary || null,
    error: row.error || null,
    costUsd: Number(row.cost_usd) || 0,
    tokens: Number(row.tokens) || 0,
    steps: Number(row.steps) || 0,
    startedAt: row.started_at,
    endedAt: row.ended_at || null,
  };
}

function mapInbox(row) {
  return {
    id: row.id,
    agentId: row.agent_id || null,
    agentName: row.agent_name || null,
    shiftId: row.shift_id || null,
    kind: row.kind,
    title: row.title,
    body: row.body || '',
    read: row.read === 1,
    createdAt: row.created_at,
  };
}

/* -------------------------------------------------------------- agent CRUD */

function listAgents(filter = {}) {
  const sql = `SELECT * FROM wf_agents ${filter.status ? 'WHERE status = ?' : ''} ORDER BY name COLLATE NOCASE ASC`;
  const rows = filter.status ? raw().prepare(sql).all(String(filter.status)) : raw().prepare(sql).all();
  return rows.map(mapAgent);
}

function getAgent(id) {
  const row = raw().prepare('SELECT * FROM wf_agents WHERE id = ?').get(String(id || ''));
  return row ? mapAgent(row) : null;
}

function createAgent(input = {}) {
  const definition = normalizeDefinition(input);
  const id = newId('agent');
  const at = now();
  const nextRunAt = definition.schedule ? workflows.cronNext(definition.schedule) : null;
  raw()
    .prepare(
      `INSERT INTO wf_agents(id, name, role, mission, model, schedule, status, budget_usd, spent_usd, runs, successes, last_run_at, next_run_at, memory, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, 'active', ?, 0, 0, 0, NULL, ?, ?, ?, ?)`,
    )
    .run(
      id,
      definition.name,
      definition.role,
      definition.mission,
      definition.model ? JSON.stringify(definition.model) : null,
      definition.schedule,
      definition.budgetUsd,
      nextRunAt,
      JSON.stringify([]),
      at,
      at,
    );
  const agent = getAgent(id);
  emit({ type: 'agent-created', agentId: id, name: agent.name });
  return agent;
}

function updateAgent(input = {}) {
  const current = getAgent(input.id);
  if (!current) throw new Error('That agent does not exist.');
  const definition = normalizeDefinition(input, current);
  let status = current.status;
  if (input.status !== undefined) {
    const wanted = String(input.status || '');
    if (!['active', 'paused'].includes(wanted)) throw new Error('Agent status must be active or paused.');
    status = wanted;
  }
  const at = now();
  let nextRunAt = current.nextRunAt;
  if (definition.schedule !== current.schedule) {
    nextRunAt = definition.schedule && status === 'active' ? workflows.cronNext(definition.schedule) : null;
  }
  if (status === 'paused') nextRunAt = null;
  if (status === 'active' && definition.schedule && (!nextRunAt || nextRunAt < at - TICK_MS)) {
    nextRunAt = workflows.cronNext(definition.schedule);
  }
  raw()
    .prepare(
      `UPDATE wf_agents SET name = ?, role = ?, mission = ?, model = ?, schedule = ?, budget_usd = ?, status = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      definition.name,
      definition.role,
      definition.mission,
      definition.model ? JSON.stringify(definition.model) : null,
      definition.schedule,
      definition.budgetUsd,
      status,
      nextRunAt,
      at,
      current.id,
    );
  const agent = getAgent(current.id);
  emit({ type: 'agent-updated', agentId: agent.id, status: agent.status });
  return agent;
}

function deleteAgent(id) {
  const agent = getAgent(id);
  if (!agent) throw new Error('That agent does not exist.');
  const handle = raw();
  const open = handle.prepare(`SELECT id FROM wf_shifts WHERE agent_id = ? AND status IN ${SHIFT_OPEN}`).get(agent.id);
  if (open) throw new Error('This agent has a shift in flight. Wait for it to finish first.');
  handle.prepare('DELETE FROM wf_shifts WHERE agent_id = ?').run(agent.id);
  handle.prepare('DELETE FROM wf_inbox WHERE agent_id = ?').run(agent.id);
  handle.prepare('DELETE FROM wf_agents WHERE id = ?').run(agent.id);
  emit({ type: 'agent-deleted', agentId: agent.id, name: agent.name });
  return { deleted: agent.id };
}

function pauseAgent(id) {
  return updateAgent({ id, status: 'paused' });
}

function resumeAgent(id) {
  return updateAgent({ id, status: 'active' });
}

/* ------------------------------------------------------------------ memory */

function memoryNotes(agent) {
  const notes = Array.isArray(agent.memory) ? agent.memory : [];
  return notes.filter((note) => note && typeof note === 'object' && note.note).slice(-MAX_MEMORY_NOTES);
}

function systemAppendFor(agent) {
  const notes = memoryNotes(agent).slice(-8);
  const lines = [
    `You are ${agent.name}, a persistent ${agent.role} agent working a shift inside ORVEX.`,
    `Mission: ${agent.mission}`,
    'Use the available tools to do real work, verify the result, then stop. If a tool is unavailable or an approval is denied, say so plainly instead of pretending.',
  ];
  if (notes.length) {
    lines.push(
      'Memory from earlier shifts (may be stale — verify before relying on it):\n' +
        notes.map((note) => `- ${new Date(Number(note.at) || 0).toLocaleString()}: ${clip(note.note, 300)}`).join('\n'),
    );
  }
  return lines.join('\n');
}

function appendMemory(agent, entry) {
  const notes = [...memoryNotes(agent), entry].slice(-MAX_MEMORY_NOTES);
  raw()
    .prepare('UPDATE wf_agents SET memory = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(notes), now(), agent.id);
}

/* ------------------------------------------------------------------ shifts */

function listShifts(filter = {}) {
  const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 200);
  const where = filter.agentId ? 'WHERE s.agent_id = ?' : '';
  const sql = `SELECT s.*, a.name AS agent_name FROM wf_shifts s LEFT JOIN wf_agents a ON a.id = s.agent_id ${where} ORDER BY s.started_at DESC LIMIT ?`;
  const rows = filter.agentId ? raw().prepare(sql).all(String(filter.agentId), limit) : raw().prepare(sql).all(limit);
  return rows.map(mapShift);
}

function getShift(id) {
  const row = raw()
    .prepare('SELECT s.*, a.name AS agent_name FROM wf_shifts s LEFT JOIN wf_agents a ON a.id = s.agent_id WHERE s.id = ?')
    .get(String(id || ''));
  return row ? mapShift(row) : null;
}

function usageForRun(runId) {
  if (!runId) return { cost: 0, tokens: 0 };
  try {
    const row = raw()
      .prepare('SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(total_tokens),0) AS tokens FROM usage WHERE run_id = ?')
      .get(String(runId));
    return { cost: Number(row?.cost) || 0, tokens: Number(row?.tokens) || 0 };
  } catch {
    return { cost: 0, tokens: 0 };
  }
}

function addInbox({ agent, shift, kind, title, body }) {
  const id = newId('note');
  raw()
    .prepare('INSERT INTO wf_inbox(id, agent_id, shift_id, kind, title, body, read, created_at) VALUES(?, ?, ?, ?, ?, ?, 0, ?)')
    .run(id, agent.id, shift.id, kind, clip(title, 160), clip(body, 4000), now());
  emit({ type: 'inbox', agentId: agent.id, shiftId: shift.id, title, kind });
  try {
    ctx.notify({
      title,
      body: clip(body, 160),
      kind: 'agent',
      target: 'workforce',
      at: now(),
    });
  } catch {
    /* notifications are best-effort */
  }
}

/** Finalise a shift exactly once; safe to call twice when a run ends twice. */
function finishShift(shiftId, event = {}) {
  const handle = raw();
  const row = handle.prepare('SELECT * FROM wf_shifts WHERE id = ?').get(String(shiftId || ''));
  if (!row) return null;
  if (row.status !== 'running') return getShift(row.id);

  const agentRow = handle.prepare('SELECT * FROM wf_agents WHERE id = ?').get(row.agent_id);
  const agent = agentRow ? mapAgent(agentRow) : null;
  const usage = usageForRun(row.run_id);
  const cancelled = event.cancelled === true;
  const ok = event.ok === true && !cancelled;
  const status = cancelled ? 'cancelled' : ok ? 'done' : 'failed';
  const summary = clip(event.summary || '', MAX_SUMMARY);
  const error = ok || cancelled ? null : clip(event.error || event.summary || 'The run failed.', MAX_SUMMARY);
  const steps = Math.max(0, Number(event.steps) || 0);

  handle
    .prepare(
      `UPDATE wf_shifts SET status = ?, summary = ?, error = ?, cost_usd = ?, tokens = ?, steps = ?, ended_at = ? WHERE id = ?`,
    )
    .run(status, summary || null, error, usage.cost, usage.tokens, steps, now(), row.id);

  const shift = getShift(row.id);

  if (agent) {
    const spent = Math.round((agent.spentUsd + usage.cost) * 1e6) / 1e6;
    const schedule = agent.schedule;
    let nextRunAt = schedule ? workflows.cronNext(schedule) : null;
    let statusNext = agent.status;
    let pausedForBudget = false;
    if (agent.budgetUsd > 0 && spent >= agent.budgetUsd) {
      statusNext = 'paused';
      nextRunAt = null;
      pausedForBudget = true;
    }
    handle
      .prepare(
        `UPDATE wf_agents SET spent_usd = ?, successes = successes + ?, next_run_at = ?, status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(spent, ok ? 1 : 0, nextRunAt, statusNext, now(), agent.id);

    appendMemory(agent, {
      at: now(),
      ok,
      shiftId: shift.id,
      note: `${ok ? 'Shift complete' : cancelled ? 'Shift cancelled' : 'Shift failed'} — ${summary || error || 'no summary'}`,
    });

    addInbox({
      agent,
      shift,
      kind: ok ? 'report' : 'failure',
      title: `${agent.name}: ${ok ? 'shift complete' : cancelled ? 'shift cancelled' : 'shift failed'}`,
      body: [
        `Goal: ${shift.goal}`,
        '',
        summary || error || 'The run ended without a summary.',
        '',
        `${steps} steps · ${usage.tokens.toLocaleString()} tokens · $${usage.cost.toFixed(4)}`,
      ].join('\n'),
    });

    if (pausedForBudget) {
      emit({ type: 'agent-paused', agentId: agent.id, reason: 'budget' });
      try {
        ctx.notify({
          title: `${agent.name} paused`,
          body: `Spent $${spent.toFixed(2)} of a $${agent.budgetUsd.toFixed(2)} budget. Raise the budget, then resume.`,
          kind: 'system',
          target: 'workforce',
          at: now(),
        });
      } catch {
        /* notifications are best-effort */
      }
    }
  }

  emit({ type: 'shift-finished', agentId: row.agent_id, shiftId: row.id, status });
  return getShift(row.id);
}

async function executeShift(shiftId, agent, goal) {
  try {
    const event = await ctx.runShift({
      agent,
      goal,
      shiftId,
      systemAppend: systemAppendFor(agent),
      onRunId: (runId) => {
        try {
          raw().prepare('UPDATE wf_shifts SET run_id = ? WHERE id = ?').run(String(runId || ''), shiftId);
        } catch {
          /* best-effort link to the run trace */
        }
      },
    });
    finishShift(shiftId, event || { ok: false, error: 'The engine returned no outcome.' });
  } catch (err) {
    finishShift(shiftId, { ok: false, error: message(err) });
  }
}

/**
 * Claim a shift and start it in the background. The returned row is the
 * in-flight shift; the inbox gets the real outcome when the run ends.
 */
function startShift(agentId, options = {}) {
  if (typeof ctx.runShift !== 'function') throw new Error('The workforce runner is not connected.');
  const agent = getAgent(agentId);
  if (!agent) throw new Error('That agent does not exist.');
  if (agent.status !== 'active') throw new Error('This agent is paused. Resume it before starting a shift.');
  if (agent.budgetBlocked) throw new Error('This agent exhausted its budget. Raise the budget, then resume.');
  const handle = raw();
  const open = handle.prepare(`SELECT id FROM wf_shifts WHERE agent_id = ? AND status IN ${SHIFT_OPEN}`).get(agent.id);
  if (open) throw new Error('This agent already has a shift in flight.');
  if (ctx.isEngineBusy()) throw new Error('The engine is already running a goal. Stop it first.');

  const goal = clip(String(options.goal || '').trim() || agent.mission, MAX_GOAL);
  const shiftId = newId('shift');
  const at = now();
  handle
    .prepare(
      `INSERT INTO wf_shifts(id, agent_id, goal, status, trigger, run_id, summary, error, cost_usd, tokens, steps, started_at, ended_at)
       VALUES(?, ?, ?, 'running', ?, NULL, NULL, NULL, 0, 0, 0, ?, NULL)`,
    )
    .run(shiftId, agent.id, goal, options.trigger === 'schedule' ? 'schedule' : 'manual', at);
  handle
    .prepare('UPDATE wf_agents SET runs = runs + 1, last_run_at = ?, updated_at = ? WHERE id = ?')
    .run(at, at, agent.id);

  emit({ type: 'shift-started', agentId: agent.id, shiftId, trigger: options.trigger || 'manual' });
  void executeShift(shiftId, agent, goal);
  return getShift(shiftId);
}

/* ------------------------------------------------------------------- inbox */

function listInbox(filter = {}) {
  const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 200);
  const where = filter.unreadOnly ? 'WHERE i.read = 0' : '';
  const rows = raw()
    .prepare(
      `SELECT i.*, a.name AS agent_name FROM wf_inbox i LEFT JOIN wf_agents a ON a.id = i.agent_id ${where} ORDER BY i.created_at DESC LIMIT ?`,
    )
    .all(limit);
  return rows.map(mapInbox);
}

function readInbox(input = {}) {
  const handle = raw();
  if (input.all === true) {
    const result = handle.prepare('UPDATE wf_inbox SET read = 1 WHERE read = 0').run();
    emit({ type: 'inbox-read', count: result.changes });
    return { updated: result.changes, unread: unreadCount() };
  }
  const id = String(input.id || '');
  if (!id) throw new Error('Pick a message to mark as read.');
  const result = handle.prepare('UPDATE wf_inbox SET read = 1 WHERE id = ?').run(id);
  emit({ type: 'inbox-read', count: result.changes });
  return { updated: result.changes, unread: unreadCount() };
}

function clearInbox() {
  const result = raw().prepare('DELETE FROM wf_inbox').run();
  emit({ type: 'inbox-cleared', count: result.changes });
  return { removed: result.changes };
}

function unreadCount() {
  try {
    const row = raw().prepare('SELECT COUNT(*) AS count FROM wf_inbox WHERE read = 0').get();
    return Number(row?.count) || 0;
  } catch {
    return 0;
  }
}

/* --------------------------------------------------------------- scheduler */

function dueAgents(at) {
  return raw()
    .prepare(
      `SELECT * FROM wf_agents WHERE status = 'active' AND schedule IS NOT NULL AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY next_run_at ASC LIMIT 5`,
    )
    .all(at)
    .map(mapAgent);
}

async function tick() {
  if (ticking) return { started: [], skipped: 'tick-in-progress' };
  if (ctx.isEngineBusy()) return { started: [], skipped: 'engine-busy' };
  ticking = true;
  const started = [];
  try {
    for (const agent of dueAgents(now())) {
      if (ctx.isEngineBusy()) break;
      if (agent.budgetBlocked) {
        raw().prepare(`UPDATE wf_agents SET status = 'paused', next_run_at = NULL, updated_at = ? WHERE id = ?`).run(now(), agent.id);
        emit({ type: 'agent-paused', agentId: agent.id, reason: 'budget' });
        continue;
      }
      try {
        const shift = startShift(agent.id, { trigger: 'schedule' });
        started.push(shift.id);
        break;
      } catch (err) {
        raw().prepare('UPDATE wf_agents SET next_run_at = ?, updated_at = ? WHERE id = ?').run(now() + RETRY_MS, now(), agent.id);
        emit({ type: 'shift-skipped', agentId: agent.id, reason: message(err) });
      }
    }
  } finally {
    ticking = false;
  }
  return { started, skipped: null };
}

function start() {
  if (timer) return { scheduler: true, tickMs: TICK_MS };
  timer = setInterval(() => {
    void tick().catch(() => {});
  }, TICK_MS);
  if (timer.unref) timer.unref();
  emit({ type: 'scheduler-started', tickMs: TICK_MS });
  return { scheduler: true, tickMs: TICK_MS };
}

function stop() {
  if (!timer) return { scheduler: false };
  clearInterval(timer);
  timer = null;
  emit({ type: 'scheduler-stopped' });
  return { scheduler: false };
}

function status() {
  const agents = listAgents({});
  const counts = agents.reduce(
    (acc, agent) => {
      acc.total += 1;
      if (agent.status === 'active') acc.active += 1;
      if (agent.status === 'paused') acc.paused += 1;
      if (agent.schedule) acc.scheduled += 1;
      acc.spent += agent.spentUsd;
      if (agent.budgetUsd > 0) acc.budget += agent.budgetUsd;
      if (agent.status === 'active' && agent.nextRunAt && (acc.nextRunAt === null || agent.nextRunAt < acc.nextRunAt)) {
        acc.nextRunAt = agent.nextRunAt;
      }
      return acc;
    },
    { total: 0, active: 0, paused: 0, scheduled: 0, spent: 0, budget: 0, nextRunAt: null },
  );
  let inFlight = 0;
  try {
    const row = raw().prepare(`SELECT COUNT(*) AS count FROM wf_shifts WHERE status IN ${SHIFT_OPEN}`).get();
    inFlight = Number(row?.count) || 0;
  } catch {
    inFlight = 0;
  }
  return {
    ...counts,
    spent: Math.round(counts.spent * 1e6) / 1e6,
    budget: Math.round(counts.budget * 1e6) / 1e6,
    inFlight,
    unread: unreadCount(),
    scheduler: !!timer,
    tickMs: TICK_MS,
    engineBusy: !!ctx.isEngineBusy(),
  };
}

/* -------------------------------------------------------------- bootstrap */

function init(options = {}) {
  ctx = { ...ctx, ...options, runShift: options.runShift || ctx.runShift };
  try {
    const handle = db.raw();
    if (handle) {
      // Agents saved before the scheduler existed may have no next_run_at.
      const missing = handle
        .prepare(`SELECT id, schedule FROM wf_agents WHERE status = 'active' AND schedule IS NOT NULL AND next_run_at IS NULL`)
        .all();
      for (const row of missing) {
        try {
          handle.prepare('UPDATE wf_agents SET next_run_at = ? WHERE id = ?').run(workflows.cronNext(row.schedule), row.id);
        } catch {
          handle.prepare(`UPDATE wf_agents SET status = 'paused' WHERE id = ?`).run(row.id);
        }
      }
    }
  } catch {
    /* schema arrives with db.init; the next launch repairs it */
  }
}

module.exports = {
  init,
  start,
  stop,
  tick,
  status,
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  pauseAgent,
  resumeAgent,
  listShifts,
  getShift,
  startShift,
  finishShift,
  listInbox,
  readInbox,
  clearInbox,
  systemAppendFor,
  memoryNotes,
  _internals: {
    cleanModel,
    cleanSchedule,
    cleanBudget,
    normalizeDefinition,
    mapAgent,
    MAX_MEMORY_NOTES,
    TICK_MS,
  },
};
