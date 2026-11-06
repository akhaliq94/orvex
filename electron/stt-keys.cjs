'use strict';

/**
 * A pool of transcription keys for one endpoint. Hosted quotas are counted per
 * key, and a spoken turn cannot wait for a top-up, so when one key is refused
 * the next one answers the same request with the same model.
 *
 * Key material never leaves the vault: this module orders and describes the
 * pool, it does not read or return values.
 */

const MAX_KEYS = 20;

/** How long a key sits out after each kind of refusal. */
const COOLDOWN_MS = {
  quota: 15 * 60 * 1000,
  key: 6 * 60 * 60 * 1000,
};

const STATE_LABELS = {
  working: 'Working',
  quota: 'Out of quota',
  key: 'Rejected by the endpoint',
  cooling: 'Waiting to retry',
};

/**
 * Which failures are about the key (worth trying another) and which are about
 * the request or the service (every key would fail the same way).
 */
function classifyError(err) {
  const status = Number(err && err.status) || Number(String((err && err.message) || '').match(/HTTP (\d{3})/)?.[1]) || 0;
  if (status === 401 || status === 403) return 'key';
  if (status === 402 || status === 429) return 'quota';
  if (status >= 500) return 'server';
  if (status) return 'request';
  return 'network';
}

/** Should the next key get the same clip? */
function shouldRotate(kind) {
  return kind === 'key' || kind === 'quota';
}

function newKeyId() {
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Accepts anything read from the vault and returns a clean, capped list. */
function normalisePool(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const key = String((entry && entry.key) || '');
    if (!key.trim()) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    const id = String((entry && entry.id) || newKeyId());
    out.push({ id, label: String((entry && entry.label) || '').slice(0, 60), addedAt: Number(entry && entry.addedAt) || Date.now(), key });
    if (out.length >= MAX_KEYS) break;
  }
  return out;
}

function cooldownUntil(row, nowMs) {
  if (!row || !row.at) return 0;
  const window = COOLDOWN_MS[row.kind] || COOLDOWN_MS.key;
  return row.at + window;
}

/**
 * Keys to try, in order: healthy first, then the one that comes back soonest.
 * A cooling key is still offered when nothing else is left, so voice input
 * degrades to a slow retry instead of stopping dead.
 */
function pickOrder(pool, health, nowMs = Date.now()) {
  const ready = [];
  const cooling = [];
  for (const entry of pool) {
    const row = health[entry.id];
    const until = cooldownUntil(row, nowMs);
    if (row && row.kind && until > nowMs) cooling.push({ id: entry.id, until });
    else ready.push({ id: entry.id, until: 0 });
  }
  cooling.sort((a, b) => a.until - b.until);
  return [...ready, ...cooling];
}

function withFailure(health, id, kind, nowMs = Date.now(), detail = '') {
  const next = { ...health };
  const before = Number(health[id] && health[id].fails);
  next[id] = { kind, at: nowMs, detail: String(detail).slice(0, 200), fails: (Number.isFinite(before) ? before : 0) + 1 };
  return next;
}

function withSuccess(health, id, nowMs = Date.now()) {
  const next = { ...health };
  // only this key proved itself; the others wait out their own cooldowns, so a
  // dead credential is not re-tried on every turn just because a good one answered
  next[id] = { okAt: nowMs };
  return next;
}

/** One row for the settings list — never any part of the key itself. */
function describe(entry, health, nowMs = Date.now()) {
  const row = health[entry.id] || {};
  const until = cooldownUntil(row, nowMs);
  const cooling = !!row.kind && until > nowMs;
  let state = 'working';
  if (row.kind === 'quota') state = cooling ? 'quota' : 'working';
  else if (row.kind === 'key') state = cooling ? 'key' : 'working';
  if (row.okAt && !row.kind) state = 'working';
  return {
    id: entry.id,
    label: entry.label || '',
    addedAt: entry.addedAt,
    state,
    stateLabel: STATE_LABELS[state] || state,
    fails: Number(row.fails) || 0,
    detail: cooling ? String(row.detail || '') : '',
    retryInMs: cooling ? Math.max(0, until - nowMs) : 0,
  };
}

module.exports = {
  MAX_KEYS,
  COOLDOWN_MS,
  classifyError,
  shouldRotate,
  newKeyId,
  normalisePool,
  pickOrder,
  withFailure,
  withSuccess,
  describe,
};
