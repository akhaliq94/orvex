'use strict';

/**
 * Per-run plan tracking for the agent loop.
 * Items live only for the lifetime of one engine run (orchestrated steps share
 * the run id), so a finished run never leaves stale work behind.
 */

const MAX_ITEMS = 40;
const MAX_TITLE = 200;

const runs = new Map();
let seq = 0;

const INSTRUCTIONS = `## Plan tracking

For a goal that needs more than two steps, write a short todo list with todo_add before acting.
Mark an item done with todo_complete only after a tool result proves it; remove items that stopped
being relevant with todo_remove. Call todo_list before you finish and account for every open item.`;

function runKey(runId) {
  const key = String(runId || '').trim();
  if (!key) throw new Error('Todos are scoped to an active agent run, and this run has no id.');
  return key;
}

function bucket(runId) {
  return runs.get(runKey(runId)) || null;
}

function ensure(runId) {
  const key = runKey(runId);
  let state = runs.get(key);
  if (!state) {
    state = { items: [], createdAt: new Date().toISOString() };
    runs.set(key, state);
  }
  return state;
}

function normalizeTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  if (!title) throw new Error('A todo title is required.');
  if (title.length > MAX_TITLE) throw new Error(`A todo title must be ${MAX_TITLE} characters or fewer.`);
  return title;
}

function normalizeIds(input) {
  const list = Array.isArray(input) ? input : [input];
  const ids = [];
  for (const raw of list) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Todo ids must be positive integers.');
    if (!ids.includes(id)) ids.push(id);
  }
  if (!ids.length) throw new Error('At least one todo id is required.');
  return ids;
}

function present(item) {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    createdAt: item.createdAt,
    completedAt: item.completedAt,
    reason: item.reason,
  };
}

function snapshot(runId) {
  const state = bucket(runId);
  const items = state ? state.items.map(present) : [];
  return { items, remaining: items.filter((item) => item.status === 'open').length, total: items.length };
}

function add(runId, input) {
  const state = ensure(runId);
  const list = Array.isArray(input) ? input : input && Array.isArray(input.items) ? input.items : [input];
  const added = [];
  for (const raw of list) {
    const title = normalizeTitle(typeof raw === 'string' ? raw : raw && (raw.title || raw.text));
    const existing = state.items.find((item) => item.status === 'open' && item.title.toLowerCase() === title.toLowerCase());
    if (existing) {
      added.push(present(existing));
      continue;
    }
    if (state.items.filter((item) => item.status === 'open').length >= MAX_ITEMS) {
      throw new Error(`A run can track at most ${MAX_ITEMS} open todo items. Finish or remove one first.`);
    }
    seq += 1;
    const item = {
      id: seq,
      title,
      status: 'open',
      createdAt: new Date().toISOString(),
      completedAt: null,
      reason: null,
    };
    state.items.push(item);
    added.push(present(item));
  }
  return { added, ...snapshot(runId) };
}

function complete(runId, input) {
  const state = ensure(runId);
  const ids = normalizeIds(input && input.ids !== undefined ? input.ids : input);
  const reason = String((input && input.reason) || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  const done = [];
  const missing = [];
  for (const id of ids) {
    const item = state.items.find((entry) => entry.id === id);
    if (!item) {
      missing.push(id);
      continue;
    }
    if (item.status !== 'done') {
      item.status = 'done';
      item.completedAt = new Date().toISOString();
      item.reason = reason;
    }
    done.push(present(item));
  }
  return { completed: done, missing, ...snapshot(runId) };
}

function remove(runId, input) {
  const state = ensure(runId);
  const ids = normalizeIds(input && input.ids !== undefined ? input.ids : input);
  const removed = [];
  const missing = [];
  for (const id of ids) {
    const index = state.items.findIndex((entry) => entry.id === id);
    if (index < 0) {
      missing.push(id);
      continue;
    }
    removed.push(present(state.items[index]));
    state.items.splice(index, 1);
  }
  return { removed, missing, ...snapshot(runId) };
}

function list(runId) {
  return snapshot(runId);
}

function prompt(runId) {
  const state = snapshot(runId);
  if (!state.items.length) return INSTRUCTIONS;
  const lines = state.items.map((item) => `- [${item.status === 'done' ? 'x' : ' '}] #${item.id} ${item.title}`);
  return `${INSTRUCTIONS}\n\n## Current plan\n${lines.join('\n')}\n${state.remaining} of ${state.total} item(s) still open.`;
}

function clear(runId) {
  const key = String(runId || '').trim();
  if (!key) return false;
  return runs.delete(key);
}

function stats() {
  let items = 0;
  let open = 0;
  for (const state of runs.values()) {
    items += state.items.length;
    open += state.items.filter((item) => item.status === 'open').length;
  }
  return { runs: runs.size, items, open };
}

function _reset() {
  runs.clear();
  seq = 0;
}

module.exports = {
  INSTRUCTIONS,
  MAX_ITEMS,
  add,
  complete,
  remove,
  list,
  prompt,
  clear,
  stats,
  _reset,
};
