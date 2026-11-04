'use strict';

/**
 * Game Pilot — pure helpers.
 *
 * A pilot profile is a bounded contract: which window may receive input, which
 * keys are allowed, how often to act, and how long the run may last. Nothing
 * here touches Electron, so the rules that protect the desktop are unit-tested
 * apart from the loop that drives them.
 */

const crypto = require('node:crypto');

const POLICIES = new Set(['vision', 'macro']);
const MAX_PROFILES = 20;
const MAX_ACTIONS = 12;
const MAX_MACRO_STEPS = 20;
const MAX_REGION = 10000;
const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 15000;
const VISION_MIN_INTERVAL_MS = 250;
const MAX_BATCH = 6;
const MIN_ACT_MS = 40;
const MAX_ACT_MS = 2000;
const MAX_MINUTES = 180;

const GAME_SYSTEM = [
  'You are ORVEX Game Pilot, playing a game on the user\'s screen through keyboard input only.',
  'Look only at the supplied screenshot. Never claim a score, enemy, item or menu that is not visible in it.',
  'You may only press keys from the allowed list. Mouse input is not available.',
  'Reply with exactly one JSON object and no prose. Fast runs use an ordered batch:',
  '  {"actions":[{"key":"<allowed key>","waitMs":<0-2000>,"reason":"<short>"}, ...]} — 1 to 6 keys you expect to press before the next screenshot',
  '  {"action":"wait","ms":<250-10000>,"reason":"<short>"} — use while a screen is loading',
  '  {"action":"stop","reason":"<short>"} — only when the game is over, paused, or the window is not the game',
  'Keep the batch short, ordered and justified by this screenshot; a later action must not assume something the screenshot does not show.',
  'Prefer the actions that most directly advance the stated goal. If the screenshot is unclear, wait instead of guessing.',
].join('\n');

function clip(value, max) {
  const text = String(value ?? '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function newId() {
  return `game_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function intIn(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeKeyText(value) {
  if (value === null || value === undefined || value === '') return '';
  const parts = (Array.isArray(value) ? value : String(value).split('+'))
    .map((p) => String(p).trim().toUpperCase())
    .filter(Boolean);
  if (!parts.length || parts.length > 4) return '';
  return parts.join('+');
}

/** Accepts {x,y,width,height} or "x,y,w,h". Returns null for empty input. */
function normalizeRegion(value) {
  if (value === null || value === undefined || value === '') return null;
  let raw = value;
  if (typeof value === 'string') {
    const parts = value.split(',').map((p) => p.trim());
    if (parts.length !== 4) throw new Error('Region must look like x,y,w,h.');
    raw = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
  }
  if (!raw || typeof raw !== 'object') throw new Error('Region must look like x,y,w,h.');
  const x = Math.round(Number(raw.x));
  const y = Math.round(Number(raw.y));
  const width = Math.round(Number(raw.width ?? raw.w));
  const height = Math.round(Number(raw.height ?? raw.h));
  if (![x, y, width, height].every((n) => Number.isFinite(n))) {
    throw new Error('Region must contain four numbers: x, y, width, height.');
  }
  if (x < 0 || y < 0) throw new Error('Region x and y cannot be negative.');
  if (width < 40 || height < 30) throw new Error('Region must be at least 40x30 pixels.');
  if (width > MAX_REGION || height > MAX_REGION) throw new Error(`Region cannot exceed ${MAX_REGION} pixels per side.`);
  return { x, y, width, height };
}

function formatRegion(region) {
  return region ? `${region.x},${region.y},${region.width},${region.height}` : '';
}

function compileScorePattern(pattern) {
  const text = clip(pattern, 200);
  if (!text) return null;
  try {
    return new RegExp(text, 'i');
  } catch {
    throw new Error(`Score pattern "${text}" is not a valid regular expression.`);
  }
}

/**
 * Reads the first number out of OCR text. When a pattern is given, its first
 * capture group wins; a non-numeric match falls back to the first number so a
 * loose pattern cannot silently produce a bogus score.
 */
function parseScore(text, pattern) {
  const raw = String(text ?? '');
  if (!raw.trim()) return null;
  let candidate = '';
  let re = null;
  try {
    re = pattern ? (pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i')) : null;
  } catch {
    re = null;
  }
  if (re) {
    const match = re.exec(raw);
    if (match) {
      const picked = match[1] !== undefined ? match[1] : match[0];
      if (/\d/.test(String(picked))) candidate = picked;
    }
  }
  if (!candidate) {
    const fallback = /-?\d[\d,]*(?:\.\d+)?/.exec(raw);
    if (!fallback) return null;
    candidate = fallback[0];
  }
  const value = Number(String(candidate).replace(/,/g, '').replace(/\s+/g, ''));
  return Number.isFinite(value) ? value : null;
}

function extractJson(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const source = fenced ? fenced[1] : text;
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Turns a model reply into one bounded action. Only keys present in the
 * profile's allowed list survive; anything else is treated as no decision.
 */
function parseDecision(raw, allowedKeys = []) {
  const json = typeof raw === 'object' && raw ? raw : extractJson(raw);
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const allowed = (Array.isArray(allowedKeys) ? allowedKeys : [])
    .map((key) => normalizeKeyText(key))
    .filter(Boolean);
  const action = String(json.action ?? json.type ?? '').trim().toLowerCase();
  const reason = clip(json.reason ?? json.why ?? '', 200);

  if (action === 'stop' || action === 'done' || action === 'quit') {
    return { type: 'stop', reason: reason || 'The model stopped the run.' };
  }
  if (action === 'wait' || action === 'sleep') {
    const ms = intIn(json.ms ?? json.waitMs ?? json.seconds * 1000, 250, 10000, 750);
    return { type: 'wait', ms, note: reason };
  }
  if (!allowed.length) return null;
  const requested = normalizeKeyText(json.key ?? json.keys ?? json.press ?? json.combo);
  if (!requested) return null;
  const key = allowed.find((candidate) => candidate === requested);
  if (!key) return null;
  if (action && !['key', 'press', 'tap', 'input'].includes(action)) return null;
  return { type: 'key', key, note: reason };
}

/**
 * Parses a fast-run reply: either the classic single action or an ordered
 * `actions` batch. Unknown keys are dropped instead of guessed at, waits are
 * clamped, and a stop inside a batch stops after the actions that precede it.
 */
function parseBatch(raw, allowedKeys = [], options = {}) {
  const json = typeof raw === 'object' && raw ? raw : extractJson(raw);
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const allowed = (Array.isArray(allowedKeys) ? allowedKeys : [])
    .map((key) => normalizeKeyText(key))
    .filter(Boolean);
  const max = Math.max(1, Math.min(MAX_BATCH, Math.round(Number(options.max)) || MAX_BATCH));
  const fallbackWait = intIn(options.actMs, MIN_ACT_MS, MAX_ACT_MS, 120);
  const stopReason = clip(json.reason ?? json.why ?? '', 200);
  const kind = String(json.action ?? json.type ?? '').trim().toLowerCase();

  if (['stop', 'done', 'quit'].includes(kind)) {
    return { type: 'stop', reason: stopReason || 'The model stopped the run.' };
  }
  if (['wait', 'sleep'].includes(kind)) {
    return { type: 'batch', actions: [{ type: 'wait', ms: intIn(json.ms ?? json.waitMs ?? json.seconds * 1000, 250, 10000, 750) }] };
  }

  const entries = Array.isArray(json.actions) ? json.actions : [json];
  const actions = [];
  let stopAfter = false;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const entryKind = String(entry.action ?? entry.type ?? 'key').trim().toLowerCase();
    if (['stop', 'done', 'quit'].includes(entryKind)) {
      stopAfter = true;
      break;
    }
    if (['wait', 'sleep'].includes(entryKind)) {
      actions.push({ type: 'wait', ms: intIn(entry.ms ?? entry.waitMs ?? entry.seconds * 1000, 250, 10000, 750) });
    } else {
      if (!allowed.length) continue;
      const key = normalizeKeyText(entry.key ?? entry.keys ?? entry.press ?? entry.combo);
      if (!key || !allowed.includes(key)) continue;
      actions.push({
        type: 'key',
        key,
        waitMs: intIn(entry.waitMs ?? entry.wait ?? fallbackWait, MIN_ACT_MS, MAX_ACT_MS, fallbackWait),
        note: clip(entry.reason ?? entry.note ?? stopReason, 160),
      });
    }
    if (actions.length >= max) break;
  }
  if (!actions.length) return null;
  return { type: 'batch', actions, stopAfter, reason: stopReason };
}

function normalizeAction(input) {
  if (!input || typeof input !== 'object') return null;
  const key = normalizeKeyText(input.key ?? input.keys);
  if (!key) return null;
  return { key, label: clip(input.label ?? input.name ?? '', 40) };
}

function normalizeMacroStep(input) {
  if (!input || typeof input !== 'object') return null;
  let rawKeys = input.keys ?? input.key;
  let inlineWait = null;
  if (typeof rawKeys === 'string' && rawKeys.includes('@')) {
    const [keysPart, waitPart] = rawKeys.split('@');
    rawKeys = keysPart;
    inlineWait = waitPart;
  }
  const key = normalizeKeyText(rawKeys);
  if (!key) return null;
  const waitMs = intIn(input.waitMs ?? input.wait ?? inlineWait, 0, 60000, 0);
  return { keys: key, waitMs };
}

/**
 * Validates and fills a pilot profile. Throws with a user-readable reason for
 * anything that would make a run unsafe or meaningless.
 */
function normalizeProfile(input = {}) {
  if (!input || typeof input !== 'object') throw new Error('Give a profile object.');
  const name = clip(input.name, 80);
  if (!name) throw new Error('Give the profile a name.');
  const windowTitle = clip(input.windowTitle ?? input.window, 200);
  if (!windowTitle) throw new Error('Give the game window title — keys are only sent while it is in front.');

  const actions = [];
  const seenKeys = new Set();
  for (const entry of Array.isArray(input.actions) ? input.actions : []) {
    const action = normalizeAction(entry);
    if (!action || seenKeys.has(action.key)) continue;
    seenKeys.add(action.key);
    actions.push(action);
    if (actions.length >= MAX_ACTIONS) break;
  }

  const macro = [];
  for (const entry of Array.isArray(input.macro) ? input.macro : []) {
    const step = normalizeMacroStep(entry);
    if (!step) continue;
    macro.push(step);
    for (const key of step.keys.split('+')) {
      if (!seenKeys.has(key) && actions.length < MAX_ACTIONS) {
        seenKeys.add(key);
        actions.push({ key, label: '' });
      }
    }
    if (macro.length >= MAX_MACRO_STEPS) break;
  }

  const policy = POLICIES.has(String(input.policy)) ? String(input.policy) : macro.length ? 'macro' : 'vision';
  if (policy === 'macro' && !macro.length) throw new Error('A macro profile needs at least one step.');
  if (policy === 'vision' && !actions.length) throw new Error('A vision profile needs at least one allowed key.');

  const region = normalizeRegion(input.region);
  const scoreRegion = normalizeRegion(input.scoreRegion);
  const scoreRegex = clip(input.scoreRegex, 200);
  const scorePattern = compileScorePattern(scoreRegex);
  const targetScore = input.targetScore === '' || input.targetScore === null || input.targetScore === undefined
    ? null
    : Number(input.targetScore);
  if (targetScore !== null && !Number.isFinite(targetScore)) throw new Error('Target score must be a number.');
  if (targetScore !== null && !scorePattern && !scoreRegion) {
    throw new Error('A target score needs a score pattern or a score region so ORVEX can read it.');
  }

  let intervalMs = intIn(input.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS, 1500);
  if (policy === 'vision') intervalMs = Math.max(VISION_MIN_INTERVAL_MS, intervalMs);

  return {
    id: /^[a-zA-Z0-9_-]{1,60}$/.test(String(input.id || '')) ? String(input.id) : newId(),
    name,
    windowTitle,
    goal: clip(input.goal, 300),
    policy,
    actions,
    macro,
    region,
    scoreRegion,
    scoreRegex,
    targetScore,
    intervalMs,
    actMs: intIn(input.actMs, MIN_ACT_MS, MAX_ACT_MS, 120),
    reuseOnIdle: input.reuseOnIdle !== false,
    maxMinutes: intIn(input.maxMinutes, 1, MAX_MINUTES, 30),
    autoFocus: input.autoFocus !== false,
    display: clip(input.display, 40),
    createdAt: Number(input.createdAt) || Date.now(),
    updatedAt: Date.now(),
  };
}

function publicProfile(profile) {
  return {
    ...profile,
    region: profile.region ? { ...profile.region } : null,
    scoreRegion: profile.scoreRegion ? { ...profile.scoreRegion } : null,
    actions: profile.actions.map((a) => ({ ...a })),
    macro: profile.macro.map((m) => ({ ...m })),
  };
}

function nextMacroStep(profile, index) {
  if (!profile || !profile.macro.length) return null;
  const safe = ((Math.round(Number(index)) || 0) % profile.macro.length + profile.macro.length) % profile.macro.length;
  return { step: profile.macro[safe], index: safe };
}

function stopReasonLabel(reason) {
  const map = {
    user: 'Stopped by the user',
    target: 'Target score reached',
    time: 'Time limit reached',
    window: 'The game window left the foreground',
    security: 'Emergency stop',
    model: 'The model ended the run',
    input: 'Keyboard input kept failing',
    capture: 'Screen capture kept failing',
    error: 'Run failed',
  };
  return map[String(reason)] || clip(reason, 120) || 'Finished';
}

module.exports = {
  GAME_SYSTEM,
  POLICIES,
  MAX_PROFILES,
  MAX_ACTIONS,
  MAX_MACRO_STEPS,
  MAX_BATCH,
  MIN_ACT_MS,
  MAX_ACT_MS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  VISION_MIN_INTERVAL_MS,
  MAX_MINUTES,
  normalizeProfile,
  normalizeRegion,
  formatRegion,
  parseScore,
  parseDecision,
  parseBatch,
  extractJson,
  compileScorePattern,
  publicProfile,
  nextMacroStep,
  stopReasonLabel,
  normalizeKeyText,
};
