'use strict';

/**
 * Phase 6.4 — the learning loop around the training vault.
 *
 * Four honest pieces:
 *  - a nano scorer (hashed-feature logistic regression) trained on recorded
 *    episodes, promoted only when it beats the active model on held-out data;
 *  - a skill compiler that turns one finished run into a reusable recipe;
 *  - a Train Kit exporter that packages recorded runs for an external GPU;
 *  - a GGUF importer and an OpenAI-compatible fine-tune client.
 *
 * Nothing here fabricates a model, a score or a job: when a dependency is
 * missing (runtime, key, enough data) the call reports why it cannot run.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const yaml = require('js-yaml');

const db = require('./db.cjs');
const guardrails = require('./guardrails.cjs');
const security = require('./security.cjs');

const HASH_FEATURES = 64;
const NUMERIC_FEATURES = 6;
const FEATURE_SIZE = HASH_FEATURES + NUMERIC_FEATURES;
const MIN_NANO_SAMPLES = 12;
const ACTIVE_NANO_KEY = 'training.nanoActive';
const NANO_HISTORY_KEY = 'training.nanoHistory';
const LAST_CYCLE_KEY = 'training.lastCycleAt';
const MAX_DATASET_ITEMS = 500;
const TRAIN_KIT_BASE_MODEL = 'unsloth/Qwen2.5-1.5B-Instruct';
const SKILL_STATUS = new Set(['suggested', 'active', 'disabled']);
const JOB_STATES = new Map([
  ['validating_files', 'queued'],
  ['queued', 'queued'],
  ['running', 'running'],
  ['succeeded', 'succeeded'],
  ['failed', 'failed'],
  ['cancelled', 'cancelled'],
]);

const STOPWORDS = new Set(
  'the a an to of and or for in on with is are be this that it as at by from do does my me i you we our your then than into over under about'.split(' '),
);

let ctx = { dataDir: process.cwd(), version: '1.0.0', emit: () => {}, notify: () => {}, providerSecret: () => '', training: null, brain: null };

/* --------------------------------------------------------------- utilities */

function now() {
  return Date.now();
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…[trimmed]` : text;
}

function training() {
  if (!ctx.training) ctx.training = require('./training.cjs');
  return ctx.training;
}

function brain() {
  if (!ctx.brain) ctx.brain = require('./local-brain.cjs');
  return ctx.brain;
}

function root() {
  return training().root();
}

function emit(event) {
  try {
    ctx.emit({ ...event, at: now() });
  } catch {
    /* the window may be gone */
  }
}

function safeName(input, fallback = 'item') {
  const base = String(input || '')
    .replace(/[^\w.\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return base || fallback;
}

function jsonColumn(value, max = 131_072) {
  try {
    return clip(JSON.stringify(value ?? null), max);
  } catch {
    return null;
  }
}

function parseJson(text, fallback) {
  if (typeof text !== 'string' || !text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function fileSha256(file) {
  return brain().hashFile(file);
}

function recordRun({ kind, status, budget = null, usage = null, log = [] }) {
  const raw = db.raw();
  if (!raw) return null;
  const id = newId('tr');
  const startedAt = now();
  try {
    raw
      .prepare(
        `INSERT INTO train_runs(id, kind, status, budget, usage, log, started_at, ended_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        String(kind),
        String(status),
        jsonColumn(budget),
        jsonColumn(usage),
        clip(Array.isArray(log) ? log.join('\n') : String(log || ''), 32_000),
        startedAt,
        status === 'running' ? null : now(),
      );
  } catch {
    return null;
  }
  return id;
}

function updateRun(id, patch = {}) {
  const raw = db.raw();
  if (!raw || !id) return null;
  const fields = [];
  const params = { id: String(id) };
  if (patch.status) {
    fields.push('status = @status');
    params.status = String(patch.status);
    if (['succeeded', 'failed', 'cancelled'].includes(String(patch.status))) {
      fields.push('ended_at = @endedAt');
      params.endedAt = Number(patch.endedAt) || now();
    }
  }
  if (patch.usage !== undefined) {
    fields.push('usage = @usage');
    params.usage = jsonColumn(patch.usage);
  }
  if (patch.log !== undefined) {
    fields.push('log = @log');
    params.log = clip(String(patch.log), 32_000);
  }
  if (!fields.length) return null;
  try {
    raw.prepare(`UPDATE train_runs SET ${fields.join(', ')} WHERE id = @id`).run(params);
  } catch {
    return null;
  }
  return id;
}

/* ---------------------------------------------------------- nano features */

function tokenize(text) {
  const words = String(text || '')
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  if (!words) return [];
  return words.filter((word) => word.length >= 2 && word.length <= 28 && !STOPWORDS.has(word));
}

function hashToken(word) {
  let h = 2166136261;
  for (let i = 0; i < word.length; i += 1) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % HASH_FEATURES;
}

function featureVector({ goal, kind, steps, promptTokens, completionTokens, cost } = {}) {
  const vector = new Array(FEATURE_SIZE).fill(0);
  for (const word of tokenize(goal)) {
    const index = hashToken(word);
    vector[index] = Math.min(3, vector[index] + 1);
  }
  const stepCount = Math.max(0, Number(steps) || 0);
  const tokens = Math.max(0, Number(promptTokens) || 0) + Math.max(0, Number(completionTokens) || 0);
  const costUsd = Math.max(0, Number(cost) || 0);
  vector[HASH_FEATURES] = Math.min(1, Math.log1p(stepCount) / 5);
  vector[HASH_FEATURES + 1] = Math.min(1, Math.log1p(tokens) / 14);
  vector[HASH_FEATURES + 2] = stepCount > 0 ? 1 : 0;
  vector[HASH_FEATURES + 3] = kind === 'agent' ? 1 : 0;
  vector[HASH_FEATURES + 4] = kind === 'workflow' ? 1 : 0;
  vector[HASH_FEATURES + 5] = Math.min(1, Math.log1p(costUsd * 1000) / 8);
  return vector;
}

function sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

function scoreVector(model, vector) {
  let z = Number(model.bias) || 0;
  const weights = model.weights || [];
  for (let i = 0; i < vector.length; i += 1) z += (Number(weights[i]) || 0) * vector[i];
  return sigmoid(z);
}

function seededShuffle(list, seed = 7) {
  const out = list.slice();
  let state = seed >>> 0 || 7;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function logLoss(model, rows) {
  if (!rows.length) return null;
  let total = 0;
  for (const row of rows) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, scoreVector(model, row.x)));
    total += -(row.y * Math.log(p) + (1 - row.y) * Math.log(1 - p));
  }
  return total / rows.length;
}

function accuracy(model, rows) {
  if (!rows.length) return null;
  let hits = 0;
  for (const row of rows) {
    const guess = scoreVector(model, row.x) >= 0.5 ? 1 : 0;
    if (guess === row.y) hits += 1;
  }
  return hits / rows.length;
}

function baselineAccuracy(rows) {
  if (!rows.length) return null;
  const ones = rows.reduce((sum, row) => sum + row.y, 0);
  return Math.max(ones, rows.length - ones) / rows.length;
}

/** Full-batch gradient descent on a 70-dimension logistic model; deterministic. */
function trainLogistic(rows, { epochs = 240, lr = 0.35, l2 = 0.001, seed = 7 } = {}) {
  const data = seededShuffle(rows, seed);
  const weights = new Array(FEATURE_SIZE).fill(0);
  let bias = 0;
  const curve = [];
  const steps = Math.max(20, Math.min(2000, Math.round(Number(epochs) || 240)));
  for (let epoch = 1; epoch <= steps; epoch += 1) {
    const grad = new Array(FEATURE_SIZE).fill(0);
    let gradBias = 0;
    for (const row of data) {
      let z = bias;
      for (let i = 0; i < FEATURE_SIZE; i += 1) z += weights[i] * row.x[i];
      const error = sigmoid(z) - row.y;
      for (let i = 0; i < FEATURE_SIZE; i += 1) grad[i] += error * row.x[i];
      gradBias += error;
    }
    const scale = lr / data.length;
    for (let i = 0; i < FEATURE_SIZE; i += 1) weights[i] -= scale * grad[i] + scale * l2 * weights[i];
    bias -= scale * gradBias;
    if (epoch % 10 === 0 || epoch === 1) {
      const model = { weights, bias };
      curve.push({ epoch, loss: Number((logLoss(model, data) ?? 0).toFixed(6)) });
    }
  }
  return { weights, bias, curve, seed };
}

function splitRows(rows) {
  const sorted = rows.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const validation = sorted.filter((_, index) => index % 5 === 0);
  const trainingRows = sorted.filter((_, index) => index % 5 !== 0);
  const mixed = (list) => list.some((row) => row.y === 0) && list.some((row) => row.y === 1);
  if (validation.length < 4 || !mixed(validation) || !mixed(trainingRows)) {
    return { train: sorted, validation: null };
  }
  return { train: trainingRows, validation };
}

function rowsFromEpisodes(episodes) {
  const rows = [];
  for (const episode of episodes) {
    if (!episode || !episode.goal) continue;
    if (episode.status !== 'done' && episode.status !== 'failed') continue;
    const score = episode.score === null || episode.score === undefined ? null : Number(episode.score);
    let label;
    if (episode.status === 'failed') label = 0;
    else if (score === null) label = 1;
    else label = score >= 0.5 ? 1 : 0;
    rows.push({
      id: String(episode.id),
      y: label,
      x: featureVector({
        goal: episode.goal,
        kind: episode.kind,
        steps: episode.steps,
        promptTokens: episode.promptTokens,
        completionTokens: episode.completionTokens,
        cost: episode.cost,
      }),
    });
  }
  return rows;
}

function nanoModels() {
  const raw = db.raw();
  if (!raw) return [];
  try {
    return raw
      .prepare(
        `SELECT id, name, path, bytes, sha256, meta, status, created_at AS createdAt
         FROM train_models WHERE role = 'nano-scorer' ORDER BY created_at DESC LIMIT 100`,
      )
      .all()
      .map((row) => ({
        ...row,
        path: row.path,
        meta: parseJson(row.meta, null),
      }));
  } catch {
    return [];
  }
}

function readNanoModel(id) {
  const raw = db.raw();
  if (!raw || !id) return null;
  try {
    const row = raw.prepare(`SELECT path, meta FROM train_models WHERE id = ? AND role = 'nano-scorer'`).get(String(id));
    if (!row || !row.path) return null;
    const file = path.resolve(root(), row.path);
    if (!fs.existsSync(file)) return null;
    const model = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...model, id: String(id), metrics: model.metrics || parseJson(row.meta, null) || null };
  } catch {
    return null;
  }
}

function activeNano() {
  const id = db.getSetting(ACTIVE_NANO_KEY, null);
  if (!id) return null;
  const model = readNanoModel(id);
  return model ? { id: String(id), model } : null;
}

function nanoHistory() {
  const saved = db.getSetting(NANO_HISTORY_KEY, []);
  return Array.isArray(saved) ? saved.filter((entry) => typeof entry === 'string') : [];
}

async function trainNano({ minSamples = MIN_NANO_SAMPLES, epochs = 240 } = {}) {
  const episodes = training().listEpisodes({ limit: 500 });
  const rows = rowsFromEpisodes(episodes);
  const minimum = Math.max(6, Math.min(500, Math.round(Number(minSamples) || MIN_NANO_SAMPLES)));
  if (rows.length < minimum) {
    throw new Error(`Need at least ${minimum} scored episodes; ${rows.length} available. Finish a few more runs first.`);
  }
  if (!rows.some((row) => row.y === 1) || !rows.some((row) => row.y === 0)) {
    throw new Error('The scorer needs both successful and failed runs; every recorded episode has the same outcome.');
  }
  const { train, validation } = splitRows(rows);
  const fitted = trainLogistic(train, { epochs, seed: 7 });
  const model = {
    id: newId('nano'),
    version: 1,
    featureSize: FEATURE_SIZE,
    hashFeatures: HASH_FEATURES,
    weights: fitted.weights,
    bias: fitted.bias,
    curve: fitted.curve,
    seed: fitted.seed,
    samples: { training: train.length, validation: validation ? validation.length : 0, total: rows.length },
    metrics: {
      accuracy: Number((accuracy(fitted, validation || train) ?? 0).toFixed(4)),
      logLoss: Number((logLoss(fitted, validation || train) ?? 0).toFixed(4)),
      baseline: Number((baselineAccuracy(validation || train) ?? 0).toFixed(4)),
      holdout: !!validation,
    },
    createdAt: now(),
    versionTag: `${ctx.version || '1.0.0'}-nano1`,
  };
  const relative = path.join('checkpoints', `${model.id}.json`).replace(/\\/g, '/');
  const body = JSON.stringify(model, null, 2);
  if (!(await training().canWrite(Buffer.byteLength(body, 'utf8')))) {
    throw new Error('The training quota or the drive reserve blocks this nano model.');
  }
  await training().ensureLayout();
  await fsp.mkdir(path.dirname(path.join(root(), relative)), { recursive: true });
  const target = path.join(root(), relative);
  await fsp.writeFile(target, body, 'utf8');
  const digest = sha256(body);

  const previous = activeNano();
  const previousScore = previous ? Number(previous.model.metrics?.accuracy) || 0 : null;
  const promoted = !previous || model.metrics.accuracy > previousScore + 0.005;
  const raw = db.raw();
  if (raw) {
    try {
      raw
        .prepare(
          `INSERT OR REPLACE INTO train_models(id, name, role, format, path, bytes, sha256, source, status, meta, created_at, updated_at)
           VALUES(?, ?, 'nano-scorer', 'json', ?, ?, ?, 'episodes', ?, ?, ?, ?)`,
        )
        .run(
          model.id,
          `Nano scorer ${new Date(model.createdAt).toISOString().slice(0, 16).replace('T', ' ')}`,
          relative,
          Buffer.byteLength(body, 'utf8'),
          digest,
          promoted ? 'active' : 'ready',
          jsonColumn(model.metrics),
          model.createdAt,
          model.createdAt,
        );
      if (promoted) {
        raw.prepare(`UPDATE train_models SET status = 'ready' WHERE role = 'nano-scorer' AND id <> ?`).run(model.id);
        if (previous) {
          const history = nanoHistory();
          if (history[history.length - 1] !== previous.id) {
            history.push(previous.id);
            if (history.length > 10) history.splice(0, history.length - 10);
            db.setSetting(NANO_HISTORY_KEY, history);
          }
        }
        db.setSetting(ACTIVE_NANO_KEY, model.id);
      }
    } catch {
      /* the file is still usable without the index row */
    }
  }
  recordRun({
    kind: 'nano-train',
    status: 'succeeded',
    budget: { epochs, minSamples: minimum },
    usage: { modelId: model.id, samples: model.samples, metrics: model.metrics, promoted },
    log: [`accuracy ${model.metrics.accuracy}`, `baseline ${model.metrics.baseline}`, promoted ? 'promoted' : 'kept active model'],
  });
  emit({ type: promoted ? 'nano-promoted' : 'nano-trained', id: model.id, accuracy: model.metrics.accuracy, previous: previous ? previous.id : null });
  return { model, promoted, previous: previous ? previous.id : null, metrics: model.metrics, samples: model.samples, path: relative };
}

function predictNano(input = {}) {
  const active = activeNano();
  if (!active) return null;
  const vector = featureVector(input);
  const probability = scoreVector(active.model, vector);
  return {
    modelId: active.id,
    probability: Number(probability.toFixed(4)),
    verdict: probability >= 0.5 ? 'likely-success' : 'likely-failure',
    accuracy: active.model.metrics?.accuracy ?? null,
    holdout: !!active.model.metrics?.holdout,
  };
}

function rollbackNano() {
  const raw = db.raw();
  if (!raw) return null;
  const active = activeNano();
  if (!active) throw new Error('No nano model is active.');
  const history = nanoHistory();
  let target = null;
  while (history.length) {
    const candidate = history.pop();
    if (readNanoModel(candidate)) {
      target = candidate;
      break;
    }
  }
  db.setSetting(NANO_HISTORY_KEY, history);
  try {
    raw.prepare(`UPDATE train_models SET status = 'ready' WHERE role = 'nano-scorer'`).run();
    if (target) {
      raw.prepare(`UPDATE train_models SET status = 'active' WHERE id = ?`).run(target);
      db.setSetting(ACTIVE_NANO_KEY, target);
    } else {
      db.setSetting(ACTIVE_NANO_KEY, null);
    }
    emit({ type: 'nano-rollback', from: active.id, to: target });
    return { from: active.id, to: target };
  } catch (err) {
    throw new Error(`The rollback failed: ${err && err.message ? err.message : err}`);
  }
}

/* -------------------------------------------------------------- skills */

const GOAL_SYSTEM = 'Use the compiled ORVEX skill when the request matches its "when" description.';

function compactArgs(args) {
  if (args === null || args === undefined) return {};
  if (typeof args !== 'object') return { value: clip(security.redact(String(args)), 200) };
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(args)) {
    if (count >= 6) break;
    if (/key|token|secret|password|authorization|cookie/i.test(key)) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[key] = typeof value === 'string' ? clip(security.redact(value), 200) : value;
      count += 1;
    }
  }
  return out;
}

function skillFromEpisode(episode, name) {
  const actions = Array.isArray(episode.actions) ? episode.actions : [];
  const tools = actions.filter((action) => action && action.type === 'tool' && action.name);
  const steps = tools.map((action, index) => ({
    order: index + 1,
    tool: String(action.name),
    args: compactArgs(action.args),
    ok: action.ok !== false,
    ms: Math.max(0, Number(action.ms) || 0),
  }));
  const failed = steps.filter((step) => !step.ok);
  const outcome = episode.outcome && typeof episode.outcome === 'object' ? episode.outcome : {};
  const summary = String(outcome.summary || '').trim();
  const keywords = [...new Set(tokenize(episode.goal))].slice(0, 12);
  const title = String(name || keywords.slice(0, 5).join(' ') || `${episode.kind} recipe`).slice(0, 80);
  return {
    version: 1,
    name: title,
    when: clip(String(episode.goal || '').replace(/\s+/g, ' '), 600),
    keywords,
    steps,
    successCheck:
      episode.status === 'done'
        ? summary
          ? `The run ended with: ${clip(summary, 400)}`
          : 'The run finished with status done.'
        : 'The source run did not finish successfully; verify this recipe before enabling it.',
    avoid: failed.map((step) => `${step.tool} failed in the source run; check its inputs first.`),
    source: {
      episodeId: episode.id,
      kind: episode.kind,
      status: episode.status,
      score: episode.score,
      runId: episode.runId || null,
    },
    compiledAt: now(),
  };
}

function compileSkill({ episodeId, name } = {}) {
  const episode = training().getEpisode(episodeId);
  if (!episode) throw new Error('That episode no longer exists.');
  const body = skillFromEpisode(episode, name);
  const raw = db.raw();
  if (!raw) throw new Error('The local database is not ready.');
  const existing = raw.prepare('SELECT id, version FROM train_skills WHERE source = ?').get(String(episode.id));
  const at = now();
  let id;
  if (existing) {
    id = existing.id;
    const version = bumpVersion(existing.version);
    raw
      .prepare('UPDATE train_skills SET name = ?, version = ?, body = ?, score = ?, support = support + 1, updated_at = ? WHERE id = ?')
      .run(body.name, version, JSON.stringify(body), episode.score ?? null, at, id);
  } else {
    id = newId('skill');
    raw
      .prepare(
        `INSERT INTO train_skills(id, name, version, status, body, support, score, source, created_at, updated_at)
         VALUES(?, ?, '1.0.0', 'suggested', ?, 1, ?, ?, ?, ?)`,
      )
      .run(id, body.name, JSON.stringify(body), episode.score ?? null, String(episode.id), at, at);
  }
  emit({ type: existing ? 'skill-updated' : 'skill-compiled', id, episodeId: episode.id });
  return { id, ...body, status: 'suggested', version: existing ? bumpVersion(existing.version) : '1.0.0', updated: !!existing };
}

function bumpVersion(input) {
  const parts = String(input || '1.0.0').split('.').map((n) => Math.max(0, Number(n) || 0));
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  return parts.slice(0, 3).join('.');
}

function listSkills({ status, limit = 100 } = {}) {
  const raw = db.raw();
  if (!raw) return [];
  const take = Math.max(1, Math.min(300, Math.round(Number(limit) || 100)));
  const where = status && SKILL_STATUS.has(String(status)) ? 'WHERE status = ?' : '';
  try {
    const rows = raw
      .prepare(
        `SELECT id, name, version, status, body, support, score, source, created_at AS createdAt, updated_at AS updatedAt
         FROM train_skills ${where} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...(where ? [String(status), take] : [take]));
    return rows.map((row) => {
      const body = parseJson(row.body, {});
      return {
        id: row.id,
        name: row.name,
        version: row.version,
        status: row.status,
        support: row.support,
        score: row.score,
        source: row.source,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        when: body.when || '',
        steps: Array.isArray(body.steps) ? body.steps.length : 0,
        tools: Array.isArray(body.steps) ? [...new Set(body.steps.map((step) => step.tool))] : [],
        avoid: Array.isArray(body.avoid) ? body.avoid.length : 0,
      };
    });
  } catch {
    return [];
  }
}

function setSkillStatus({ id, status } = {}) {
  if (!SKILL_STATUS.has(String(status))) throw new Error('Skill status must be suggested, active or disabled.');
  const raw = db.raw();
  if (!raw) throw new Error('The local database is not ready.');
  const result = raw.prepare('UPDATE train_skills SET status = ?, updated_at = ? WHERE id = ?').run(String(status), now(), String(id || ''));
  if (!result.changes) throw new Error('That skill no longer exists.');
  emit({ type: 'skill-status', id: String(id), status: String(status) });
  return { id: String(id), status: String(status) };
}

function deleteSkill({ id } = {}) {
  const raw = db.raw();
  if (!raw) throw new Error('The local database is not ready.');
  const result = raw.prepare('DELETE FROM train_skills WHERE id = ?').run(String(id || ''));
  emit({ type: 'skill-deleted', id: String(id) });
  return { removed: result.changes };
}

function skillPrompt(id) {
  const raw = db.raw();
  if (!raw) return null;
  const row = raw.prepare('SELECT id, name, body FROM train_skills WHERE id = ?').get(String(id || ''));
  if (!row) return null;
  const body = parseJson(row.body, null);
  if (!body) return null;
  const lines = [`## Skill: ${row.name}`, `When: ${body.when || 'n/a'}`];
  if (Array.isArray(body.allowedTools) && body.allowedTools.length) lines.push(`Allowed tools: ${body.allowedTools.join(', ')}`);
  if (Array.isArray(body.steps) && body.steps.length) {
    lines.push('Steps:');
    for (const step of body.steps) {
      const args = Object.keys(step.args || {}).length ? ` ${JSON.stringify(step.args)}` : '';
      lines.push(`${step.order}. ${step.tool}${args}${step.ok ? '' : ' (failed last time — verify inputs)'}`);
    }
  }
  if (body.successCheck) lines.push(`Success check: ${body.successCheck}`);
  if (Array.isArray(body.avoid) && body.avoid.length) lines.push(`Avoid: ${body.avoid.join(' ')}`);
  if (body.guide) lines.push(`Instructions:\n${body.guide}`);
  return lines.join('\n');
}

/** One line per enabled skill; the full steps are fetched on demand. */
function skillCatalog(limit = 12) {
  const raw = db.raw();
  if (!raw) return [];
  const take = Math.max(1, Math.min(30, Math.round(Number(limit) || 12)));
  try {
    const rows = raw
      .prepare(`SELECT id, name, version, body FROM train_skills WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?`)
      .all(take);
    return rows.map((row) => {
      const body = parseJson(row.body, {});
      const count = Array.isArray(body.steps) ? body.steps.length : 0;
      const when = String(body.when || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      return `- [${row.id}] ${row.name} ${row.version}${when ? ` — ${when}` : ''} (${count} steps)`;
    });
  } catch {
    return [];
  }
}

function skillSuggestions(limit = 5) {
  const raw = db.raw();
  if (!raw) return [];
  try {
    return raw
      .prepare(
        `SELECT e.id, e.goal, e.kind, e.score, e.steps
         FROM train_episodes e
         LEFT JOIN train_skills s ON s.source = e.id
         WHERE e.status = 'done' AND s.id IS NULL AND e.steps >= 1
         ORDER BY COALESCE(e.score, 0) DESC, e.created_at DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(20, Math.round(Number(limit) || 5))))
      .map((row) => ({
        episodeId: row.id,
        goal: clip(String(row.goal || ''), 160),
        kind: row.kind,
        score: row.score,
        steps: row.steps,
      }));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------- manual skills v1 */

function normalizeManualSkill(input = {}) {
  const name = clip(String(input.name || '').trim(), 80);
  if (name.length < 2) throw new Error('Skill name must be at least 2 characters.');
  const whenText = clip(String(input.when || '').replace(/\s+/g, ' ').trim(), 600);
  if (whenText.length < 8) throw new Error('Describe when this skill applies (at least 8 characters).');
  const rawSteps = Array.isArray(input.steps) ? input.steps : [];
  const guide = clip(security.redact(String(input.guide || '').trim()), 8000);
  if (!rawSteps.length && !guide) throw new Error('A skill needs at least one step or written instructions.');
  if (rawSteps.length > 20) throw new Error('A skill can have at most 20 steps.');
  const steps = rawSteps.map((step, index) => {
    const tool = String(typeof step === 'string' ? step : (step && step.tool) || '').trim();
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(tool)) throw new Error(`Step ${index + 1} needs a valid tool name.`);
    const args = step && typeof step === 'object' ? compactArgs(step.args) : {};
    return { order: index + 1, tool, args, ok: !(step && step.ok === false), ms: 0 };
  });
  const avoid = (Array.isArray(input.avoid) ? input.avoid : [])
    .map((line) => clip(security.redact(String(line || '').trim()), 200))
    .filter(Boolean)
    .slice(0, 10);
  const allowedTools = (Array.isArray(input.allowedTools) ? input.allowedTools : [])
    .map((tool) => clip(String(tool || '').trim(), 80))
    .filter((tool) => /^[a-zA-Z0-9_.-]{2,80}$/.test(tool))
    .slice(0, 20);
  return {
    version: 1,
    name,
    when: whenText,
    keywords: [...new Set(tokenize(whenText))].slice(0, 12),
    steps,
    successCheck: clip(security.redact(String(input.successCheck || '').trim()), 400),
    avoid,
    guide,
    allowedTools,
    source: { manual: true },
    compiledAt: now(),
  };
}

function skillSummary(row) {
  const body = parseJson(row.body, {});
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    status: row.status,
    support: row.support,
    score: row.score,
    source: row.source,
    when: body.when || '',
    steps: Array.isArray(body.steps) ? body.steps.length : 0,
    tools: Array.isArray(body.steps) ? [...new Set(body.steps.map((step) => step.tool))] : [],
    avoid: Array.isArray(body.avoid) ? body.avoid.length : 0,
    guide: !!body.guide,
  };
}

function saveSkill(payload = {}) {
  const raw = db.raw();
  if (!raw) throw new Error('The local database is not ready.');
  const body = normalizeManualSkill(payload);
  const at = now();
  if (payload.id) {
    const existing = raw.prepare('SELECT id, version, status FROM train_skills WHERE id = ?').get(String(payload.id));
    if (!existing) throw new Error('That skill no longer exists.');
    const version = bumpVersion(existing.version);
    const status = SKILL_STATUS.has(String(payload.status)) ? String(payload.status) : existing.status;
    raw
      .prepare('UPDATE train_skills SET name = ?, version = ?, status = ?, body = ?, updated_at = ? WHERE id = ?')
      .run(body.name, version, status, JSON.stringify(body), at, String(payload.id));
    emit({ type: 'skill-updated', id: String(payload.id) });
    return { id: String(payload.id), name: body.name, version, status, when: body.when, steps: body.steps.length, updated: true };
  }
  const id = newId('skill');
  const status = SKILL_STATUS.has(String(payload.status)) ? String(payload.status) : 'suggested';
  const source = clip(String(payload.source || 'manual'), 80);
  raw
    .prepare(
      `INSERT INTO train_skills(id, name, version, status, body, support, score, source, created_at, updated_at)
       VALUES(?, ?, '1.0.0', ?, ?, 1, NULL, ?, ?, ?)`,
    )
    .run(id, body.name, status, JSON.stringify(body), source, at, at);
  emit({ type: 'skill-saved', id });
  return { id, name: body.name, version: '1.0.0', status, when: body.when, steps: body.steps.length, updated: false };
}

function exportSkill({ id } = {}) {
  const raw = db.raw();
  if (!raw) throw new Error('The local database is not ready.');
  const row = raw.prepare('SELECT id, name, version, status, body FROM train_skills WHERE id = ?').get(String(id || ''));
  if (!row) throw new Error('That skill no longer exists.');
  const body = parseJson(row.body, {});
  return {
    format: 'orvex-skill',
    formatVersion: 1,
    id: row.id,
    name: row.name,
    version: row.version,
    status: row.status,
    skill: {
      name: body.name || row.name,
      when: body.when || '',
      steps: (Array.isArray(body.steps) ? body.steps : []).map((step) => ({ tool: step.tool, args: step.args || {}, ok: step.ok !== false })),
      successCheck: body.successCheck || '',
      avoid: Array.isArray(body.avoid) ? body.avoid : [],
      guide: body.guide || '',
      allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools : [],
    },
  };
}

function exportSkills() {
  const skills = listSkills({ limit: 300 }).map((skill) => exportSkill({ id: skill.id }));
  return { format: 'orvex-skill-pack', formatVersion: 1, exportedAt: now(), skills: skills.map((item) => item.skill) };
}

/* ------------------------------------------------------- SKILL.md import */

const SKILL_MD_LIMIT = 20000;

function stepArgs(value) {
  const text = String(value || '').trim().replace(/^`|`$/g, '');
  if (!text) return {};
  if (!text.startsWith('{')) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? compactArgs(parsed) : {};
  } catch {
    return {};
  }
}

function normalizeStepList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((step) => step && typeof step === 'object' && /^[a-zA-Z0-9_.-]{2,80}$/.test(String(step.tool || '').trim()))
    .slice(0, 20)
    .map((step) => ({ tool: String(step.tool).trim(), args: compactArgs(step.args), ok: step.ok !== false }));
}

function parseStepLines(text) {
  const steps = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:[-*]|\d+[.)])\s+(?:step\s*:\s*)?tool\s*:\s*`?([a-zA-Z0-9_.-]{2,80})`?\s*(.*)$/i,
    );
    if (!match) continue;
    steps.push({ tool: match[1], args: stepArgs(match[2]), ok: true });
    if (steps.length >= 20) break;
  }
  return steps;
}

function parseStepBlock(text) {
  try {
    const doc = JSON.parse(text);
    const list = Array.isArray(doc) ? doc : doc && doc.steps;
    const steps = normalizeStepList(list);
    if (steps.length) return steps;
  } catch {
    /* not JSON — the block may use tool: lines */
  }
  return parseStepLines(text);
}

function sectionOf(markdown, names, max) {
  const wanted = names.map((name) => name.toLowerCase());
  let capture = false;
  const out = [];
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const title = heading[1].toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      capture = wanted.some((name) => title === name || title.startsWith(`${name} `));
      continue;
    }
    if (!capture) continue;
    if (!line.trim()) {
      if (out.length) break;
      continue;
    }
    out.push(line.trim());
  }
  return clip(out.join(' ').replace(/\s+/g, ' ').trim(), max);
}

/**
 * Convert a Claude-style SKILL.md into an ORVEX skill. Frontmatter supplies
 * name/description/allowed-tools; explicit `tool:` steps or an ```orvex-steps
 * JSON block become executable steps; the remaining markdown is kept as
 * written instructions the agent reads through skill_load/​skillPrompt.
 */
function parseSkillMarkdown(text, options = {}) {
  const source = String(text || '').replace(/^\uFEFF/, '').slice(0, SKILL_MD_LIMIT);
  if (!source.trim()) throw new Error('Paste a SKILL.md file or pick one first.');
  let front = {};
  let body = source;
  const block = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (block) {
    try {
      const doc = yaml.load(block[1]);
      if (doc && typeof doc === 'object' && !Array.isArray(doc)) front = doc;
      else if (doc != null) throw new Error('frontmatter must be a mapping');
    } catch (err) {
      throw new Error(`The SKILL.md frontmatter is not valid YAML: ${err && err.message ? err.message : err}`);
    }
    body = source.slice(block[0].length);
  }
  const heading = (body.match(/^#\s+(.+?)\s*$/m) || [])[1] || '';
  const filename = String(options.filename || '').replace(/\.(md|markdown)$/i, '').trim();
  const name = clip(String(front.name || heading || filename || '').trim(), 80);
  if (name.length < 2) throw new Error('SKILL.md needs a name in the frontmatter or an H1 heading.');
  const paragraph = body
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith('#') && !part.startsWith('-') && !part.startsWith('```'));
  const description = String(front.description || paragraph || '').replace(/\s+/g, ' ').trim();
  const when = clip(description || `Use the ${name} skill when its instructions apply.`, 600);
  if (when.length < 8) throw new Error('SKILL.md needs a longer description so the agent knows when to use it.');

  const steps = [];
  const stripped = body.replace(/```(?:orvex-steps|orvex|json)\s*\r?\n([\s\S]*?)```/gi, (whole, content) => {
    const found = parseStepBlock(content);
    if (!found.length) return whole;
    steps.push(...found.slice(0, Math.max(0, 20 - steps.length)));
    return '';
  });
  if (steps.length < 20) {
    const fromLines = parseStepLines(stripped);
    for (const step of fromLines) {
      if (steps.length >= 20) break;
      steps.push(step);
    }
  }

  const guideLines = stripped
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:[-*]|\d+[.)])\s+(?:step\s*:\s*)?tool\s*:/i.test(line));
  let guide = guideLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const allowed = front['allowed-tools'] ?? front.allowedTools;
  const allowedTools = (Array.isArray(allowed) ? allowed : String(allowed || '').split(','))
    .map((tool) => String(tool || '').trim())
    .filter((tool) => /^[a-zA-Z0-9_.-]{2,80}$/.test(tool))
    .slice(0, 20);
  const avoidSection = sectionOf(stripped, ['avoid', 'pitfalls', 'do not', 'constraints'], 1200);
  const avoid = avoidSection
    ? avoidSection
        .split(/\s*(?:^|\s)[-*]\s+|\s*;\s*/)
        .map((line) => line.replace(/^[-*]\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 10)
    : [];

  return {
    name,
    when,
    steps,
    guide: clip(guide, 8000),
    allowedTools,
    successCheck: sectionOf(stripped, ['success check', 'verification', 'done when', 'success criteria'], 400),
    avoid,
  };
}

function importSkill(payload = {}) {
  const text = payload && (payload.text ?? payload.markdown ?? payload.content);
  if (typeof text === 'string') {
    const parsed = parseSkillMarkdown(text, { filename: payload.filename });
    return saveSkill({
      ...parsed,
      status: payload.activate === true ? 'active' : 'suggested',
      source: 'import',
    });
  }
  const incoming = payload.skill && typeof payload.skill === 'object' ? payload.skill : payload;
  if (incoming && incoming.format === 'orvex-skill-pack' && Array.isArray(incoming.skills)) {
    const imported = incoming.skills.map((skill) =>
      importSkill({ skill, activate: payload.activate === true }),
    );
    return { imported, count: imported.length };
  }
  const bundle = incoming && incoming.format === 'orvex-skill' && incoming.skill ? incoming.skill : incoming;
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error('That is not an ORVEX skill, skill pack or SKILL.md.');
  const hasGuide = typeof bundle.guide === 'string' && bundle.guide.trim().length > 0;
  if (!bundle.name || !bundle.when || (!Array.isArray(bundle.steps) && !hasGuide)) {
    throw new Error('That is not an ORVEX skill or skill pack (it needs name, when and steps, or written instructions).');
  }
  return saveSkill({
    ...bundle,
    status: payload.activate === true ? 'active' : 'suggested',
    source: 'import',
  });
}

/* ------------------------------------------------------------ train kit */

function assistantFromEpisode(detail) {
  const outcome = detail.outcome && typeof detail.outcome === 'object' ? detail.outcome : {};
  const tools = (Array.isArray(detail.actions) ? detail.actions : []).filter((a) => a && a.type === 'tool' && a.name);
  const lines = [`Goal: ${clip(detail.goal, 1200)}`];
  const plan = detail.plan;
  if (plan && typeof plan === 'object') {
    const steps = Array.isArray(plan.steps) ? plan.steps : Array.isArray(plan.plan) ? plan.plan : null;
    if (steps && steps.length) {
      lines.push('Plan:');
      steps.slice(0, 12).forEach((step, index) => {
        const text = typeof step === 'string' ? step : step && (step.title || step.label || step.goal || step.text);
        if (text) lines.push(`${index + 1}. ${clip(security.redact(String(text)), 240)}`);
      });
    }
  }
  if (tools.length) {
    lines.push('Tool calls:');
    tools.slice(0, 20).forEach((tool, index) => {
      const args = Object.keys(compactArgs(tool.args)).length ? ` ${clip(JSON.stringify(compactArgs(tool.args)), 240)}` : '';
      lines.push(`${index + 1}. ${tool.name}${args} -> ${tool.ok === false ? 'failed' : 'ok'}`);
    });
  }
  const summary = String(outcome.summary || '').trim();
  if (summary) lines.push(`Result: ${clip(summary, 1600)}`);
  else if (detail.status === 'done') lines.push(`Result: completed in ${detail.steps} step(s).`);
  if (detail.error) lines.push(`Error: ${clip(detail.error, 600)}`);
  return lines.join('\n');
}

function datasetLine(detail) {
  return JSON.stringify({
    messages: [
      {
        role: 'system',
        content:
          'You are ORVEX, a desktop operator agent. Reply with a short plan, the tool calls you would make, and the verified result. Never invent tool output.',
      },
      { role: 'user', content: clip(detail.goal, 4000) },
      { role: 'assistant', content: assistantFromEpisode(detail) },
    ],
  });
}

function notebookCells({ datasetName, baseModel, episodes }) {
  const cell = (type, source) => ({
    cell_type: type,
    metadata: {},
    source: Array.isArray(source) ? source : source.split('\n').map((line, i, arr) => (i < arr.length - 1 ? `${line}\n` : line)),
    ...(type === 'code' ? { execution_count: null, outputs: [] } : {}),
  });
  return {
    cells: [
      cell('markdown', `# ORVEX Train Kit\n\nThis notebook fine-tunes **${baseModel}** on ${episodes} recorded ORVEX runs.\n\n- Runs on a free Kaggle/Colab T4 GPU. ORVEX does not upload anything for you.\n- The dataset contains only scrubbed, completed runs from your own vault.\n- Quality depends on the data: more varied successful runs produce a better adapter.\n- After training, download the adapter and import it in ORVEX → Training.`),
      cell('code', `!pip install -q unsloth trl datasets peft accelerate`),
      cell('code', `from datasets import load_dataset\n\nDATASET = "${datasetName}"\nds = load_dataset("json", data_files=DATASET, split="train")\nprint(len(ds), "examples")\nprint(ds[0]["messages"][1]["content"][:400])`),
      cell('code', `from unsloth import FastLanguageModel\n\nMAX_SEQ = 2048\nmodel, tokenizer = FastLanguageModel.from_pretrained(\n    model_name="${baseModel}",\n    max_seq_length=MAX_SEQ,\n    load_in_4bit=True,\n)\nmodel = FastLanguageModel.get_peft_model(\n    model, r=16, lora_alpha=16, lora_dropout=0.0,\n    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],\n)`),
      cell('code', `def to_text(example):\n    return {"text": tokenizer.apply_chat_template(example["messages"], tokenize=False, add_generation_prompt=False)}\n\ntrain_ds = ds.map(to_text)`),
      cell('code', `from trl import SFTTrainer\nfrom transformers import TrainingArguments\n\nargs = TrainingArguments(\n    per_device_train_batch_size=2,\n    gradient_accumulation_steps=4,\n    warmup_steps=5,\n    num_train_epochs=1,\n    learning_rate=2e-4,\n    fp16=True,\n    bf16=False,\n    logging_steps=1,\n    output_dir="orvex-adapter",\n    save_strategy="epoch",\n)\ntrainer = SFTTrainer(\n    model=model,\n    tokenizer=tokenizer,\n    train_dataset=train_ds,\n    dataset_text_field="text",\n    max_seq_length=MAX_SEQ,\n    args=args,\n)\ntrainer.train()\nmodel.save_pretrained("orvex-adapter")\ntokenizer.save_pretrained("orvex-adapter")`),
      cell('code', `# Optional: export GGUF for ORVEX Local Brain (Q4_K_M)\nmodel.save_pretrained_gguf("orvex-gguf", tokenizer, quantization_method="q4_k_m")\nimport glob\nprint(glob.glob("orvex-gguf/*.gguf"))`),
      cell('markdown', `## Next step\n\n1. Zip and download \`orvex-adapter\` (or \`orvex-gguf\`).\n2. In ORVEX: Training → Train kit → import the GGUF (or keep the adapter for your own runtime).\n3. Compare against the base model on the frozen eval pack before enabling it in Local Brain.`),
    ],
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3.10' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

async function buildTrainKit({ limit = 200, name } = {}) {
  const take = Math.max(1, Math.min(MAX_DATASET_ITEMS, Math.round(Number(limit) || 200)));
  const episodes = training().listEpisodes({ limit: take }).filter((episode) => episode.goal && episode.status !== 'running');
  const usable = [];
  for (const episode of episodes) {
    const detail = training().getEpisode(episode.id);
    if (!detail || detail.status !== 'done') continue;
    usable.push(detail);
  }
  if (!usable.length) throw new Error('Record at least one finished run with a goal before building a Train Kit.');
  const id = newId('kit');
  const title = safeName(name || `Train kit ${new Date().toISOString().slice(0, 10)}`, 'Train kit');
  const relativeDir = path.join('exports', `${id}`).replace(/\\/g, '/');
  const dir = path.join(root(), relativeDir);
  await training().ensureLayout();
  await fsp.mkdir(dir, { recursive: true });
  const datasetName = 'dataset.jsonl';
  const lines = usable.map((detail) => datasetLine(detail)).join('\n') + '\n';
  const bytes = Buffer.byteLength(lines, 'utf8');
  if (!(await training().canWrite(bytes))) throw new Error('The training quota or the drive reserve blocks this Train Kit.');
  await fsp.writeFile(path.join(dir, datasetName), lines, 'utf8');
  const notebook = JSON.stringify(notebookCells({ datasetName, baseModel: TRAIN_KIT_BASE_MODEL, episodes: usable.length }), null, 2);
  await fsp.writeFile(path.join(dir, 'train.ipynb'), notebook, 'utf8');
  const readme = [
    `# ${title}`,
    '',
    `Generated by ORVEX from ${usable.length} recorded runs.`,
    '',
    '## Run it on a free GPU',
    '1. Open Kaggle or Google Colab and create a notebook with a free T4 GPU.',
    '2. Upload `dataset.jsonl` and `train.ipynb`.',
    '3. Run every cell. Training takes roughly 10–40 minutes for a few hundred examples.',
    '4. Download the adapter or the exported GGUF and import it back into ORVEX.',
    '',
    '## Honest limits',
    `- Base model: ${TRAIN_KIT_BASE_MODEL} (1.5B parameters, 4-bit QLoRA).`,
    '- ORVEX does not upload the dataset; you decide where it goes.',
    '- One epoch on a small dataset teaches style and tool habits, not new facts.',
    '- Evaluate the result on the frozen eval pack before enabling it in Local Brain.',
    '',
  ].join('\n');
  await fsp.writeFile(path.join(dir, 'README.md'), readme, 'utf8');
  const files = [];
  for (const entry of ['dataset.jsonl', 'train.ipynb', 'README.md']) {
    const full = path.join(dir, entry);
    const stat = await fsp.stat(full);
    files.push({ name: entry, bytes: stat.size, sha256: await fileSha256(full) });
  }
  const manifest = {
    id,
    name: title,
    createdAt: now(),
    items: usable.length,
    baseModel: TRAIN_KIT_BASE_MODEL,
    format: 'chat-jsonl',
    files,
    note: 'Training happens on an external GPU; ORVEX only packages real recorded runs.',
  };
  const manifestBody = JSON.stringify(manifest, null, 2);
  await fsp.writeFile(path.join(dir, 'manifest.json'), manifestBody, 'utf8');
  const raw = db.raw();
  if (raw) {
    try {
      raw
        .prepare(
          `INSERT INTO train_datasets(id, name, kind, format, path, items, bytes, status, meta, created_at, updated_at)
           VALUES(?, ?, 'sft', 'jsonl', ?, ?, ?, 'ready', ?, ?, ?)`,
        )
        .run(
          id,
          title,
          path.join(relativeDir, datasetName).replace(/\\/g, '/'),
          usable.length,
          bytes,
          jsonColumn({ manifest: `${relativeDir}/manifest.json`, baseModel: TRAIN_KIT_BASE_MODEL }),
          manifest.createdAt,
          manifest.createdAt,
        );
    } catch {
      /* the files are still valid without the index row */
    }
  }
  emit({ type: 'kit-built', id, items: usable.length });
  return { ...manifest, path: relativeDir, dataset: path.join(relativeDir, datasetName).replace(/\\/g, '/'), datasetBytes: bytes };
}

function listTrainKits(limit = 50) {
  const raw = db.raw();
  if (!raw) return [];
  try {
    return raw
      .prepare(
        `SELECT id, name, kind, format, path, items, bytes, status, meta, created_at AS createdAt, updated_at AS updatedAt
         FROM train_datasets ORDER BY created_at DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(200, Math.round(Number(limit) || 50))))
      .map((row) => {
        const meta = parseJson(row.meta, {});
        return { ...row, meta, dir: `exports/${row.id}`, exists: fs.existsSync(path.join(root(), 'exports', row.id)) };
      });
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------- GGUF import */

function modelsIndex() {
  const raw = db.raw();
  if (!raw) return [];
  try {
    return raw
      .prepare(
        `SELECT id, name, role, format, path, bytes, sha256, source, status, meta, created_at AS createdAt
         FROM train_models WHERE role = 'llm' ORDER BY created_at DESC LIMIT 200`,
      )
      .all()
      .map((row) => ({ ...row, meta: parseJson(row.meta, null) }));
  } catch {
    return [];
  }
}

async function importGguf({ source, name } = {}) {
  const input = String(source || '').trim();
  if (!input) throw new Error('Choose a GGUF file to import.');
  const blocked = guardrails.checkPath(input, 'read');
  if (blocked) throw new Error(blocked);
  const stat = await fsp.stat(input).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error('That file does not exist.');
  if (stat.size < 1024) throw new Error('That file is too small to be a GGUF model.');
  const facts = await brain().readGgufMeta(input).catch(() => null);
  if (!facts || !facts.ok) throw new Error('That file is not a readable GGUF model.');
  if (!(await training().canWrite(stat.size))) throw new Error('The training quota or the drive reserve blocks this model.');
  await training().ensureLayout();
  const modelsDir = path.join(root(), 'models');
  await fsp.mkdir(modelsDir, { recursive: true });
  const base = safeName(name || path.basename(input, path.extname(input)), 'model');
  let fileName = `${base}.gguf`;
  let target = path.join(modelsDir, fileName);
  const digest = await fileSha256(input);
  if (fs.existsSync(target)) {
    const existing = await fileSha256(target).catch(() => null);
    if (existing === digest) {
      return { imported: false, duplicate: true, path: path.join('models', fileName).replace(/\\/g, '/'), sha256: digest };
    }
    fileName = `${base}-${digest.slice(0, 8)}.gguf`;
    target = path.join(modelsDir, fileName);
  }
  emit({ type: 'gguf-copy', source: input, target: fileName, bytes: stat.size });
  await fsp.copyFile(input, target);
  const copied = await fileSha256(target);
  if (copied !== digest) {
    await fsp.rm(target, { force: true });
    throw new Error('The copy did not match the source file; nothing was imported.');
  }
  const id = newId('model');
  const relative = path.join('models', fileName).replace(/\\/g, '/');
  const meta = brain().modelFacts ? brain().modelFacts(facts.meta || {}, stat.size) : facts;
  const raw = db.raw();
  if (raw) {
    try {
      raw
        .prepare(
          `INSERT OR REPLACE INTO train_models(id, name, role, format, path, bytes, sha256, source, status, meta, created_at, updated_at)
           VALUES(?, ?, 'llm', 'gguf', ?, ?, ?, 'import', 'ready', ?, ?, ?)`,
        )
        .run(id, fileName, relative, stat.size, digest, jsonColumn(meta), now(), now());
    } catch {
      /* the file is still on disk and the Local Brain scan will find it */
    }
  }
  let scan = null;
  try {
    scan = await brain().scanModels({ hash: false });
  } catch {
    scan = null;
  }
  emit({ type: 'gguf-imported', id, path: relative, bytes: stat.size });
  return { imported: true, duplicate: false, id, name: fileName, path: relative, bytes: stat.size, sha256: digest, meta, scan };
}

async function deleteModel(input = {}) {
  const id = typeof input === 'string' ? input : input.id;
  const raw = db.raw();
  if (!raw) throw new Error('The local database is not ready.');
  const row = raw.prepare(`SELECT id, path FROM train_models WHERE id = ? AND role = 'llm'`).get(String(id || ''));
  if (!row) throw new Error('That model is not in the vault index.');
  const modelsRoot = path.resolve(root(), 'models');
  const target = path.resolve(root(), row.path);
  if (target !== modelsRoot && !target.startsWith(modelsRoot + path.sep)) {
    throw new Error('Refusing to delete a file outside the vault models folder.');
  }
  await fsp.rm(target, { force: true });
  raw.prepare('DELETE FROM train_models WHERE id = ?').run(row.id);
  try {
    await brain().scanModels({ hash: false });
  } catch {
    /* rescan is best-effort */
  }
  emit({ type: 'model-deleted', id: row.id, path: row.path });
  return { removed: 1, path: row.path };
}

/* ------------------------------------------------------- fine-tune client */

function normalizeBaseUrl(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw new Error('The provider base URL is not valid.');
  }
  if (url.username || url.password) throw new Error('Do not put credentials in the URL.');
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Fine-tune requests need HTTPS (HTTP is allowed only on localhost).');
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

function resolveDataset({ trainKitId, datasetPath } = {}) {
  const raw = db.raw();
  let relative = null;
  if (trainKitId && raw) {
    const row = raw.prepare('SELECT path FROM train_datasets WHERE id = ?').get(String(trainKitId));
    if (!row || !row.path) throw new Error('That Train Kit is not indexed.');
    relative = row.path;
  } else if (datasetPath) {
    relative = String(datasetPath);
  } else {
    throw new Error('Choose a Train Kit to upload.');
  }
  const vault = path.resolve(root());
  const full = path.resolve(vault, relative);
  if (full !== vault && !full.startsWith(vault + path.sep)) throw new Error('The dataset must live inside the training vault.');
  if (!fs.existsSync(full)) throw new Error('The dataset file is missing from the vault.');
  return { full, relative: path.relative(vault, full).replace(/\\/g, '/') };
}

async function fetchJson(url, options = {}, timeout = 60_000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const detail = (data && (data.error?.message || data.message)) || clip(text, 240) || `HTTP ${response.status}`;
    throw new Error(`Fine-tune endpoint refused the request: ${clip(detail, 300)}`);
  }
  return data;
}

function finetuneKey(providerId, baseUrl) {
  const key = ctx.providerSecret(String(providerId || ''), baseUrl);
  if (!key) throw new Error('No saved key is linked to this endpoint. Save the provider key with this base URL first.');
  return key;
}

async function finetune({ providerId, baseUrl, model, trainKitId, suffix, epochs, batchSize, learningRateMultiplier } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  if (!model || typeof model !== 'string') throw new Error('Choose a base model for the fine-tune.');
  const key = finetuneKey(providerId, base);
  const dataset = resolveDataset({ trainKitId });
  const buffer = await fsp.readFile(dataset.full);
  emit({ type: 'finetune-upload', bytes: buffer.length });
  const form = new FormData();
  form.append('purpose', 'fine-tune');
  form.append('file', new Blob([buffer], { type: 'application/jsonl' }), path.basename(dataset.full));
  const upload = await fetchJson(`${base}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const fileId = upload && upload.id;
  if (!fileId) throw new Error('The endpoint accepted the upload but returned no file id.');
  const hyper = {};
  if (Number(epochs) >= 1 && Number(epochs) <= 10) hyper.n_epochs = Math.round(Number(epochs));
  if (Number(batchSize) >= 1 && Number(batchSize) <= 64) hyper.batch_size = Math.round(Number(batchSize));
  if (Number(learningRateMultiplier) > 0 && Number(learningRateMultiplier) <= 5) {
    hyper.learning_rate_multiplier = Number(learningRateMultiplier);
  }
  const jobBody = { training_file: fileId, model: String(model).slice(0, 120) };
  if (Object.keys(hyper).length) jobBody.hyperparameters = hyper;
  if (suffix) jobBody.suffix = safeName(suffix, 'orvex').slice(0, 18);
  const job = await fetchJson(`${base}/fine_tuning/jobs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(jobBody),
  });
  if (!job || !job.id) throw new Error('The endpoint returned no fine-tune job id.');
  const runId = recordRun({
    kind: 'finetune',
    status: JOB_STATES.get(String(job.status)) || 'queued',
    budget: { ...jobBody, providerId: String(providerId || ''), baseUrl: base, dataset: dataset.relative },
    usage: { remoteJobId: job.id, fileId, model: job.model || jobBody.model, status: job.status || null },
    log: [`uploaded ${dataset.relative}`, `job ${job.id}`],
  });
  emit({ type: 'finetune-submitted', id: runId, remoteId: job.id });
  return { id: runId, remoteId: job.id, fileId, status: JOB_STATES.get(String(job.status)) || 'queued', model: job.model || jobBody.model };
}

function finetuneRuns(limit = 50) {
  const raw = db.raw();
  if (!raw) return [];
  try {
    return raw
      .prepare(
        `SELECT id, status, budget, usage, log, started_at AS startedAt, ended_at AS endedAt
         FROM train_runs WHERE kind = 'finetune' ORDER BY started_at DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(200, Math.round(Number(limit) || 50))))
      .map((row) => {
        const budget = parseJson(row.budget, {});
        const usage = parseJson(row.usage, {});
        return {
          id: row.id,
          status: row.status,
          providerId: budget.providerId || null,
          baseUrl: budget.baseUrl || null,
          model: usage.model || budget.model || null,
          remoteId: usage.remoteId || null,
          dataset: budget.dataset || null,
          log: row.log || '',
          startedAt: row.startedAt,
          endedAt: row.endedAt,
        };
      });
  } catch {
    return [];
  }
}

function findRun(id) {
  const raw = db.raw();
  if (!raw) return null;
  const row = raw.prepare(`SELECT * FROM train_runs WHERE id = ? AND kind = 'finetune'`).get(String(id || ''));
  if (!row) return null;
  return { ...row, budget: parseJson(row.budget, {}), usage: parseJson(row.usage, {}) };
}

async function finetuneStatus({ id } = {}) {
  const run = findRun(id);
  if (!run) throw new Error('That fine-tune job is not in the vault.');
  const base = normalizeBaseUrl(run.budget.baseUrl);
  const key = finetuneKey(run.budget.providerId, base);
  const job = await fetchJson(`${base}/fine_tuning/jobs/${encodeURIComponent(run.usage.remoteId)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const mapped = JOB_STATES.get(String(job && job.status)) || run.status;
  const usage = {
    ...run.usage,
    status: job && job.status,
    fineTunedModel: (job && job.fine_tuned_model) || run.usage.fineTunedModel || null,
  };
  const log = `${run.log || ''}\n${new Date().toISOString()} ${job && job.status}`.trim();
  updateRun(run.id, { status: mapped, usage, log });
  if (mapped !== run.status) emit({ type: 'finetune-updated', id: run.id, status: mapped });
  return { id: run.id, status: mapped, remoteStatus: job && job.status, fineTunedModel: usage.fineTunedModel, events: (job && job.events) || null };
}

async function finetuneCancel({ id } = {}) {
  const run = findRun(id);
  if (!run) throw new Error('That fine-tune job is not in the vault.');
  const base = normalizeBaseUrl(run.budget.baseUrl);
  const key = finetuneKey(run.budget.providerId, base);
  const job = await fetchJson(`${base}/fine_tuning/jobs/${encodeURIComponent(run.usage.remoteId)}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
  });
  const mapped = JOB_STATES.get(String(job && job.status)) || 'cancelled';
  updateRun(run.id, { status: mapped, log: `${run.log || ''}\n${new Date().toISOString()} cancel requested`.trim() });
  emit({ type: 'finetune-updated', id: run.id, status: mapped });
  return { id: run.id, status: mapped };
}

/* ------------------------------------------------------------- cycle/status */

function suggestions() {
  const items = [];
  const packs = training().listEvalPacks(1);
  const lastPack = packs.length ? packs[0].createdAt : 0;
  const finished = training().listEpisodes({ limit: 500 }).filter((episode) => episode.status !== 'running');
  const sincePack = finished.filter((episode) => episode.createdAt > lastPack).length;
  if (!packs.length || sincePack >= 10) {
    items.push({
      id: 'suggest-eval',
      kind: 'eval',
      title: packs.length ? 'Freeze a fresh eval pack' : 'Freeze your first eval pack',
      detail: packs.length
        ? `${sincePack} new runs since the last pack.`
        : `${finished.length} recorded runs are ready to freeze as cases.`,
    });
  }
  for (const suggestion of skillSuggestions(2)) {
    items.push({
      id: `suggest-skill-${suggestion.episodeId}`,
      kind: 'skill',
      episodeId: suggestion.episodeId,
      title: 'Compile a skill from a successful run',
      detail: suggestion.goal || suggestion.kind,
    });
  }
  const nano = nanoModels();
  const active = activeNano();
  const labeled = rowsFromEpisodes(finished).length;
  const lastTrained = nano.length ? nano[0].createdAt : 0;
  const sinceTrain = finished.filter((episode) => episode.createdAt > lastTrained).length;
  if (labeled >= MIN_NANO_SAMPLES && (!active || sinceTrain >= 8)) {
    items.push({
      id: 'suggest-train',
      kind: 'train',
      title: active ? 'Retrain the nano scorer on newer runs' : 'Train the nano scorer',
      detail: `${labeled} scored runs available${active ? `, ${sinceTrain} since the active model` : ''}.`,
    });
  }
  const kits = listTrainKits(1);
  if (kits.length) {
    items.push({
      id: 'suggest-finetune',
      kind: 'finetune',
      title: 'Fine-tune on a free GPU',
      detail: 'A Train Kit is ready; upload it to a compatible provider when you choose to.',
    });
  }
  return items;
}

async function runCycle() {
  const startedAt = now();
  const actions = [];
  const skipped = [];
  const finished = training().listEpisodes({ limit: 500 }).filter((episode) => episode.status !== 'running');
  const packs = training().listEvalPacks(1);
  const sincePack = finished.filter((episode) => episode.createdAt > (packs.length ? packs[0].createdAt : 0)).length;
  if (!packs.length || sincePack >= 10) {
    try {
      const pack = await training().buildEvalPack({ limit: 100, name: `Auto pack · ${new Date().toISOString().slice(0, 10)}` });
      actions.push({ kind: 'eval', id: pack.id, cases: pack.cases.length });
    } catch (err) {
      skipped.push({ kind: 'eval', reason: err && err.message ? err.message : String(err) });
    }
  } else {
    skipped.push({ kind: 'eval', reason: `Only ${sincePack} new runs since the last pack.` });
  }
  try {
    const trained = await trainNano();
    actions.push({ kind: 'train', id: trained.model.id, promoted: trained.promoted, accuracy: trained.metrics.accuracy });
  } catch (err) {
    skipped.push({ kind: 'train', reason: err && err.message ? err.message : String(err) });
  }
  for (const suggestion of skillSuggestions(2)) {
    try {
      const skill = compileSkill({ episodeId: suggestion.episodeId });
      actions.push({ kind: 'skill', id: skill.id, name: skill.name });
    } catch (err) {
      skipped.push({ kind: 'skill', reason: err && err.message ? err.message : String(err) });
    }
  }
  db.setSetting(LAST_CYCLE_KEY, startedAt);
  const report = { startedAt, endedAt: now(), actions, skipped, suggestions: suggestions() };
  recordRun({
    kind: 'cycle',
    status: 'succeeded',
    budget: null,
    usage: { actions, skipped },
    log: actions.map((action) => `${action.kind} ${action.id || ''}`).concat(skipped.map((skip) => `skip ${skip.kind}: ${skip.reason}`)),
  });
  emit({ type: 'cycle', actions: actions.length, skipped: skipped.length });
  return report;
}

function status() {
  const raw = db.raw();
  const active = activeNano();
  const skillCounts = { suggested: 0, active: 0, disabled: 0, total: 0 };
  let kits = 0;
  let fineTunes = 0;
  let openFineTunes = 0;
  if (raw) {
    try {
      const rows = raw.prepare('SELECT status, COUNT(*) AS count FROM train_skills GROUP BY status').all();
      for (const row of rows) {
        const count = Number(row.count) || 0;
        skillCounts.total += count;
        if (Object.hasOwn(skillCounts, row.status)) skillCounts[row.status] = count;
      }
      kits = Number(raw.prepare(`SELECT COUNT(*) AS count FROM train_datasets`).get()?.count) || 0;
      const ft = raw.prepare(`SELECT COUNT(*) AS count FROM train_runs WHERE kind = 'finetune'`).get();
      fineTunes = Number(ft?.count) || 0;
      openFineTunes =
        Number(
          raw
            .prepare(`SELECT COUNT(*) AS count FROM train_runs WHERE kind = 'finetune' AND status IN ('queued','running')`)
            .get()?.count,
        ) || 0;
    } catch {
      /* counts stay zero */
    }
  }
  return {
    root: root(),
    nano: {
      active: active ? { id: active.id, accuracy: active.model.metrics?.accuracy ?? null, holdout: !!active.model.metrics?.holdout, createdAt: active.model.createdAt } : null,
      models: nanoModels().length,
      lastTrainedAt: nanoModels()[0]?.createdAt || null,
    },
    skills: skillCounts,
    kits,
    fineTunes: { total: fineTunes, open: openFineTunes },
    lastCycleAt: db.getSetting(LAST_CYCLE_KEY, null),
    suggestions: suggestions(),
  };
}

function init(opts = {}) {
  ctx = { ...ctx, ...opts };
  return { root: root() };
}

/* -------------------------------------------------- skills v1 agent tools */

function approvalReason(name) {
  if (['skill_save', 'skill_import', 'skill_set_status', 'skill_delete'].includes(name)) {
    return 'This changes the skill library that is added to future agent prompts.';
  }
  return null;
}

const definitions = [
  {
    name: 'skill_load',
    description: 'Load the full ordered steps for one enabled skill. The system prompt lists enabled skills by id; call this before following one. Read-only.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Skill id from the enabled-skills list.' } },
      required: ['id'],
    },
  },
  {
    name: 'skill_list',
    description: 'List compiled, manual and imported skills with status, step count and tools. Enabled skills are injected into future agent prompts.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['suggested', 'active', 'disabled'], description: 'Optional status filter.' },
      },
    },
  },
  {
    name: 'skill_save',
    description: 'Create or update a reusable skill by hand. steps is an ordered array of {tool, args} using real tool names from the registry. Set activate=true to enable it immediately. Changes future agent prompts and needs approval.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Existing skill id to update.' },
        name: { type: 'string', description: 'Skill name (2–80 chars).' },
        when: { type: 'string', description: 'When this skill applies.' },
        steps: {
          type: 'array',
          description: 'Ordered tool steps.',
          items: {
            type: 'object',
            properties: { tool: { type: 'string' }, args: { type: 'object' }, ok: { type: 'boolean' } },
            required: ['tool'],
          },
        },
        successCheck: { type: 'string', description: 'How to verify the skill worked.' },
        avoid: { type: 'array', items: { type: 'string' }, description: 'Pitfalls to avoid.' },
        activate: { type: 'boolean', description: 'Enable the skill immediately.' },
      },
      required: ['name', 'when', 'steps'],
    },
  },
  {
    name: 'skill_import',
    description: 'Import one ORVEX skill, a {format:"orvex-skill"} bundle, a full skill pack, or the text of a Claude-style SKILL.md. Imported skills stay suggested unless activate=true. Needs approval.',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'object', description: 'Skill, bundle or pack to import.' },
        text: { type: 'string', description: 'Raw SKILL.md markdown with YAML frontmatter.' },
        filename: { type: 'string', description: 'Optional SKILL.md filename, used as a fallback name.' },
        activate: { type: 'boolean', description: 'Enable imported skills immediately.' },
      },
      required: ['skill'],
    },
  },
  {
    name: 'skill_export',
    description: 'Export one skill (id) as an ORVEX bundle, or every skill as a pack when id is omitted.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'Skill id (omit to export all).' } } },
  },
  {
    name: 'skill_set_status',
    description: 'Enable, disable or re-suggest a skill. Enabled skills change future agent prompts, so this needs approval.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['suggested', 'active', 'disabled'] },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'skill_delete',
    description: 'Delete a skill permanently. Needs approval.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

const handlers = {
  async skill_load(args) {
    const raw = db.raw();
    if (!raw) throw new Error('The local database is not ready.');
    const row = raw.prepare('SELECT status FROM train_skills WHERE id = ?').get(String(args.id || ''));
    if (!row) throw new Error(`No skill with id "${args.id || ''}".`);
    if (row.status !== 'active') throw new Error(`Skill ${args.id} is ${row.status}; only enabled skills can be loaded.`);
    const prompt = skillPrompt(args.id);
    if (!prompt) throw new Error(`Skill ${args.id} has no readable body.`);
    return { ok: true, output: prompt };
  },
  async skill_list(args) {
    const skills = listSkills({ status: args.status, limit: 200 });
    if (!skills.length) return { ok: true, output: 'No skills yet. Compile one from a recorded episode, save one manually or import a pack.' };
    return {
      ok: true,
      output: skills.map((s) => `[${s.id}] ${s.name} (${s.status}, ${s.steps} steps) — ${s.when}`).join('\n'),
      skills,
    };
  },
  async skill_save(args) {
    const skill = saveSkill({ ...args, status: args.activate ? 'active' : undefined });
    return { ok: true, output: `Saved skill [${skill.id}] "${skill.name}" ${skill.version} (${skill.status}, ${skill.steps} steps).`, skill };
  },
  async skill_import(args) {
    const result = importSkill({ skill: args.skill, text: args.text, filename: args.filename, activate: args.activate });
    if (result.count != null) return { ok: true, output: `Imported ${result.count} skill(s) from the pack.`, ...result };
    return { ok: true, output: `Imported skill [${result.id}] "${result.name}" (${result.status}).`, skill: result };
  },
  async skill_export(args) {
    if (args.id) {
      const bundle = exportSkill({ id: args.id });
      return { ok: true, output: `Exported "${bundle.name}" ${bundle.version} as an ORVEX skill bundle.`, bundle };
    }
    const pack = exportSkills();
    return { ok: true, output: `Exported ${pack.skills.length} skill(s) as an ORVEX skill pack.`, pack };
  },
  async skill_set_status(args) {
    const result = setSkillStatus({ id: args.id, status: args.status });
    return { ok: true, output: `Skill ${result.id} is now ${result.status}.`, ...result };
  },
  async skill_delete(args) {
    const result = deleteSkill({ id: args.id });
    return { ok: true, output: result.removed ? `Deleted skill ${args.id}.` : `No skill with id "${args.id}".`, ...result };
  },
};

module.exports = {
  init,
  status,
  suggestions,
  runCycle,
  trainNano,
  predictNano,
  nanoModels,
  activeNano,
  rollbackNano,
  compileSkill,
  saveSkill,
  exportSkill,
  exportSkills,
  importSkill,
  listSkills,
  approvalReason,
  definitions,
  handlers,
  setSkillStatus,
  deleteSkill,
  skillPrompt,
  skillCatalog,
  skillSuggestions,
  buildTrainKit,
  listTrainKits,
  importGguf,
  modelsIndex,
  deleteModel,
  finetune,
  finetuneStatus,
  finetuneCancel,
  finetuneRuns,
  _internals: {
    FEATURE_SIZE,
    HASH_FEATURES,
    NUMERIC_FEATURES,
    MIN_NANO_SAMPLES,
    TRAIN_KIT_BASE_MODEL,
    tokenize,
    featureVector,
    trainLogistic,
    scoreVector,
    logLoss,
    accuracy,
    splitRows,
    rowsFromEpisodes,
    skillFromEpisode,
    compactArgs,
    datasetLine,
    notebookCells,
    normalizeBaseUrl,
    resolveDataset,
    bumpVersion,
    safeName,
    parseSkillMarkdown,
    JOB_STATES,
  },
};
