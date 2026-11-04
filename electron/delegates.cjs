'use strict';

/**
 * Background sub-agent delegation.
 * A parent run can start bounded child agent runs that work concurrently and
 * report back. Children are unattended: they cannot raise approval prompts, so
 * any tool that would ask the user for a yes/no is refused before it runs.
 */

const MAX_TASKS_PER_PARENT = 20;
const MAX_ACTIVE_PER_PARENT = 2;
const MAX_GOAL_CHARS = 4000;
const MAX_WAIT_MS = 120_000;
const MAX_LABEL = 40;
const RESUMABLE = new Set(['interrupted', 'failed', 'cancelled']);

let spawnChild = null;
let store = null;
const tasks = new Map();
let seq = 0;

function init(opts = {}) {
  if (typeof opts.spawn === 'function') spawnChild = opts.spawn;
  if (opts.store && typeof opts.store === 'object') {
    store = {
      save: typeof opts.store.save === 'function' ? opts.store.save : () => {},
      get: typeof opts.store.get === 'function' ? opts.store.get : () => null,
      list: typeof opts.store.list === 'function' ? opts.store.list : () => [],
      markResumed: typeof opts.store.markResumed === 'function' ? opts.store.markResumed : () => {},
      interruptOpen: typeof opts.store.interruptOpen === 'function' ? opts.store.interruptOpen : () => 0,
      prune: typeof opts.store.prune === 'function' ? opts.store.prune : () => 0,
    };
    // Children that were in flight when the previous process died cannot be
    // resumed in place; record them as interrupted so they can be re-run.
    try {
      store.interruptOpen();
      store.prune(300);
    } catch {
      /* the queue is an addition, never a startup blocker */
    }
  }
}

function durable(task) {
  if (!store) return;
  try {
    store.save({
      id: task.id,
      parentRunId: task.parentRunId,
      childRunId: task.childRunId,
      agent: task.agent,
      goal: task.goal,
      status: task.status,
      result: task.result,
      error: task.error,
      createdAt: task.createdAt,
      endedAt: task.endedAt ? Date.parse(task.endedAt) : null,
    });
  } catch {
    /* best-effort */
  }
}

function requireSpawn() {
  if (!spawnChild) throw new Error('Background sub-agents are not available in this window.');
  return spawnChild;
}

function normalizeGoal(value) {
  const goal = String(value || '').replace(/\s+$/g, '').trim();
  if (!goal) throw new Error('A task description is required.');
  if (goal.length > MAX_GOAL_CHARS) throw new Error(`A sub-agent task must be ${MAX_GOAL_CHARS} characters or fewer.`);
  return goal;
}

function normalizeLabel(value) {
  const label = String(value || 'worker').replace(/[^\w .-]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
  return label || 'worker';
}

function publicTask(task) {
  return {
    id: task.id,
    agent: task.agent,
    goal: task.goal,
    status: task.status,
    result: task.result,
    error: task.error,
    parentRunId: task.parentRunId,
    resumeOf: task.resumeOf || null,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
  };
}

function owned(id, parentRunId) {
  const task = tasks.get(String(id || ''));
  if (!task) throw new Error(`Unknown sub-agent task "${id}".`);
  if (task.parentRunId !== String(parentRunId || '')) throw new Error(`Sub-agent task "${id}" belongs to a different run.`);
  return task;
}

function notify(task, type) {
  if (typeof task.emit !== 'function') return;
  try {
    task.emit({ type, task: publicTask(task) });
  } catch {
    /* the parent may already be gone */
  }
}

function dropOldestFinished(parentRunId) {
  const finished = [...tasks.values()]
    .filter((task) => task.parentRunId === parentRunId && task.status !== 'running')
    .sort((a, b) => String(a.endedAt || '').localeCompare(String(b.endedAt || '')));
  while (finished.length && [...tasks.values()].filter((task) => task.parentRunId === parentRunId).length >= MAX_TASKS_PER_PARENT) {
    const oldest = finished.shift();
    tasks.delete(oldest.id);
  }
}

function start(input = {}) {
  const spawn = requireSpawn();
  const parentRunId = String(input.parentRunId || '').trim();
  if (!parentRunId) throw new Error('A parent run id is required to start a sub-agent.');
  const goal = normalizeGoal(input.goal);
  const agent = normalizeLabel(input.agent);
  const mine = [...tasks.values()].filter((task) => task.parentRunId === parentRunId);
  const active = mine.filter((task) => task.status === 'running').length;
  if (active >= MAX_ACTIVE_PER_PARENT) {
    throw new Error(`At most ${MAX_ACTIVE_PER_PARENT} background sub-agents can run at once. Wait for one with delegate_wait or stop one with delegate_cancel.`);
  }
  if (mine.length >= MAX_TASKS_PER_PARENT) {
    dropOldestFinished(parentRunId);
    if ([...tasks.values()].filter((task) => task.parentRunId === parentRunId).length >= MAX_TASKS_PER_PARENT) {
      throw new Error(`This run already started ${MAX_TASKS_PER_PARENT} sub-agents. Finish the work yourself or start a new run.`);
    }
  }

  const chain = Array.isArray(input.chain) ? input.chain.filter((c) => c && c.baseUrl && c.model) : [];
  if (!chain.length) throw new Error('No model is available for a background sub-agent.');

  seq += 1;
  const id = `sub_${Date.now().toString(36)}_${seq.toString(36)}`;
  const childRunId = `${parentRunId}~${id}`;
  const controller = new AbortController();
  const startedAt = new Date().toISOString();
  const task = {
    id,
    agent,
    goal,
    status: 'running',
    result: null,
    error: null,
    parentRunId,
    childRunId,
    startedAt,
    endedAt: null,
    createdAt: Date.parse(startedAt),
    resumeOf: input.resumeOf ? String(input.resumeOf) : null,
    controller,
    emit: typeof input.emit === 'function' ? input.emit : null,
    promise: null,
  };

  const onParentAbort = () => controller.abort();
  if (input.signal && typeof input.signal.addEventListener === 'function') {
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener('abort', onParentAbort, { once: true });
    task.detach = () => input.signal.removeEventListener('abort', onParentAbort);
  }

  tasks.set(id, task);
  durable(task);
  notify(task, 'delegate_start');

  const childEmit = (event) => {
    if (!event || event.type === 'assistant') return;
    if (event.type === 'tool_start' || event.type === 'tool_result' || event.type === 'status') {
      if (typeof task.emit === 'function') {
        try {
          task.emit({ type: 'delegate_progress', id: task.id, agent: task.agent, event });
        } catch {
          /* parent gone */
        }
      }
    }
  };

  task.promise = Promise.resolve()
    .then(() =>
      spawn({
        goal,
        agent,
        parentRunId,
        childRunId,
        chain,
        autoApprove: false,
        signal: controller.signal,
        emit: childEmit,
      }),
    )
    .then((outcome) => {
      if (task.status === 'cancelled') return;
      if (!outcome || outcome.cancelled) {
        task.status = 'cancelled';
        task.result = outcome && outcome.summary ? String(outcome.summary) : null;
      } else if (outcome.ok) {
        task.status = 'done';
        task.result = String(outcome.summary || '(no summary)');
      } else {
        task.status = 'failed';
        task.error = String(outcome.summary || 'Sub-agent failed without a summary.');
      }
    })
    .catch((err) => {
      if (task.status === 'cancelled') return;
      if (controller.signal.aborted) {
        task.status = 'cancelled';
        task.result = 'Stopped before completion.';
      } else {
        task.status = 'failed';
        task.error = err && err.message ? err.message : String(err);
      }
    })
    .finally(() => {
      task.endedAt = new Date().toISOString();
      task.controller = null;
      if (task.detach) task.detach();
      task.detach = null;
      durable(task);
      notify(task, 'delegate_end');
    });

  return publicTask(task);
}

function status(id, parentRunId) {
  if (id) return publicTask(owned(id, parentRunId));
  const mine = [...tasks.values()].filter((task) => task.parentRunId === String(parentRunId || '')).map(publicTask);
  return { tasks: mine, running: mine.filter((task) => task.status === 'running').length };
}

async function wait(id, parentRunId, timeoutMs, signal) {
  const task = owned(id, parentRunId);
  if (task.status !== 'running') return publicTask(task);
  const limit = Math.min(Math.max(Number(timeoutMs) || 30_000, 1_000), MAX_WAIT_MS);
  let timer = null;
  let onAbort = null;
  const stopped = new Promise((resolve) => {
    if (signal && typeof signal.addEventListener === 'function') {
      onAbort = () => resolve('aborted');
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), limit);
  });
  const reason = await Promise.race([task.promise.then(() => 'finished'), timeout, stopped]);
  clearTimeout(timer);
  if (onAbort && signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
  if (reason === 'timeout') {
    return { ...publicTask(task), note: `Still running after ${Math.round(limit / 1000)}s. Call delegate_wait again or delegate_status.` };
  }
  if (reason === 'aborted') {
    return { ...publicTask(task), note: 'The parent run was stopped while waiting.' };
  }
  return publicTask(task);
}

function result(id, parentRunId) {
  const task = owned(id, parentRunId);
  const view = publicTask(task);
  if (task.status === 'running') view.note = 'Still running — wait with delegate_wait before relying on its output.';
  return view;
}

function cancel(id, parentRunId) {
  const task = owned(id, parentRunId);
  if (task.status !== 'running') {
    return { ...publicTask(task), note: `Task already ${task.status}.` };
  }
  if (task.controller) task.controller.abort();
  task.status = 'cancelled';
  task.endedAt = new Date().toISOString();
  task.result = task.result || 'Stopped by the parent run.';
  durable(task);
  notify(task, 'delegate_end');
  return publicTask(task);
}

function cancelForParent(parentRunId, reason = 'Parent run finished.') {
  const stopped = [];
  for (const task of tasks.values()) {
    if (task.parentRunId !== String(parentRunId || '') || task.status !== 'running') continue;
    if (task.controller) task.controller.abort();
    task.status = 'cancelled';
    task.endedAt = new Date().toISOString();
    task.result = task.result || reason;
    durable(task);
    stopped.push(task.id);
    notify(task, 'delegate_end');
  }
  return stopped;
}

/** Durable history across restarts — independent of the live task map. */
function queue(limit = 40) {
  if (!store) return { available: false, tasks: [] };
  let rows = [];
  try {
    rows = store.list(limit);
  } catch {
    rows = [];
  }
  return { available: true, tasks: rows };
}

/**
 * Re-run an interrupted, failed or cancelled durable task as a new child with
 * the caller's current model chain. Interrupted tasks can only come from a
 * previous process, so resuming is always an explicit decision.
 */
function resume(input = {}) {
  const spawn = requireSpawn();
  if (!store) throw new Error('The durable sub-agent queue is not available in this window.');
  const id = String(input.id || '').trim();
  if (!id) throw new Error('Which sub-agent task should be resumed? Pass its id from delegate_queue.');
  const row = store.get(id);
  if (!row) throw new Error(`No durable sub-agent task "${id}" was found.`);
  if (row.resumedAs) throw new Error(`Task "${id}" was already resumed as ${row.resumedAs}. Use that task instead.`);
  if (!RESUMABLE.has(String(row.status))) {
    throw new Error(
      row.status === 'running'
        ? `Task "${id}" is still marked running. Call delegate_status after it finishes, or restart ORVEX so it becomes interrupted.`
        : `Task "${id}" finished as ${row.status}${row.status === 'resumed' ? ` (resumed as ${row.resumedAs})` : ''} — only interrupted, failed or cancelled tasks can be resumed.`,
    );
  }
  const parentRunId = String(input.parentRunId || '').trim();
  if (!parentRunId) throw new Error('A parent run id is required to resume a sub-agent.');
  const chain = Array.isArray(input.chain) ? input.chain.filter((c) => c && c.baseUrl && c.model) : [];
  if (!chain.length) throw new Error('No model is available to resume this sub-agent.');
  const task = start({
    goal: row.goal,
    agent: input.agent || row.agent,
    parentRunId,
    chain,
    signal: input.signal,
    emit: input.emit,
    resumeOf: id,
  });
  try {
    store.markResumed(id, task.id);
  } catch {
    /* the new task is already running; the link is informational */
  }
  return { task: publicTask(task), resumedFrom: id, previousStatus: row.status, previousError: row.error || null };
}

function clear(parentRunId) {
  let removed = 0;
  for (const [id, task] of tasks) {
    if (task.parentRunId !== String(parentRunId || '')) continue;
    if (task.status === 'running' && task.controller) task.controller.abort();
    tasks.delete(id);
    removed += 1;
  }
  return removed;
}

function stats() {
  const all = [...tasks.values()];
  return {
    tasks: all.length,
    running: all.filter((task) => task.status === 'running').length,
    done: all.filter((task) => task.status === 'done').length,
    failed: all.filter((task) => task.status === 'failed').length,
    cancelled: all.filter((task) => task.status === 'cancelled').length,
  };
}

function _setSpawnForTests(fn) {
  spawnChild = typeof fn === 'function' ? fn : null;
}

function _reset() {
  for (const task of tasks.values()) {
    if (task.status === 'running' && task.controller) task.controller.abort();
    if (task.detach) task.detach();
  }
  tasks.clear();
  store = null;
  seq = 0;
}

module.exports = {
  MAX_TASKS_PER_PARENT,
  MAX_ACTIVE_PER_PARENT,
  MAX_GOAL_CHARS,
  MAX_WAIT_MS,
  init,
  start,
  status,
  wait,
  result,
  cancel,
  cancelForParent,
  queue,
  resume,
  clear,
  stats,
  _setSpawnForTests,
  _reset,
};
