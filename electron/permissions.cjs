'use strict';

/**
 * Per-tool permission engine.
 * Every tool can be set to allow (run silently), ask (human confirms) or deny
 * (never runs). Policies persist in the app data folder and are enforced in
 * tools.runTool / tools.approvalReason before anything executes.
 */

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const POLICIES = new Set(['allow', 'ask', 'deny']);
const VALID_NAME = /^[a-zA-Z0-9_.:-]{1,120}$/;
const MAX_FLOORS = 100;
const MAX_PATTERN = 300;

let dataDir = null;
let file = null;
let policies = {};
let floors = [];
let registry = () => [];
let writeTimer = null;
let floorSeq = 0;

function validFloorTool(tool) {
  return tool === '*' || VALID_NAME.test(tool);
}

function normalizeFloor(raw) {
  const tool = String(raw?.tool || '*').trim();
  const pattern = String(raw?.pattern || '').trim();
  if (!validFloorTool(tool)) throw new Error('tool must be "*" or a registered tool name.');
  if (!pattern) throw new Error('pattern is required.');
  if (pattern.length > MAX_PATTERN) throw new Error(`pattern must be ${MAX_PATTERN} characters or fewer.`);
  try {
    new RegExp(pattern, 'i');
  } catch (err) {
    throw new Error(`pattern is not a valid regular expression: ${err.message}`);
  }
  const note = String(raw?.note || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return {
    id: String(raw?.id || `floor_${Date.now().toString(36)}_${(floorSeq += 1).toString(36)}`),
    tool,
    pattern,
    note,
    addedAt: String(raw?.addedAt || new Date().toISOString()),
  };
}

function init(opts = {}) {
  dataDir = opts.dataDir || dataDir;
  registry = typeof opts.registry === 'function' ? opts.registry : registry;
  file = dataDir ? path.join(dataDir, 'permissions.json') : null;
  policies = {};
  floors = [];
  if (!file) return;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const stored = raw && typeof raw === 'object' && raw.policies && typeof raw.policies === 'object' ? raw.policies : raw;
    for (const [name, value] of Object.entries(stored || {})) {
      if (VALID_NAME.test(name) && POLICIES.has(String(value))) policies[name] = String(value);
    }
    const storedFloors = raw && Array.isArray(raw.floors) ? raw.floors : [];
    for (const entry of storedFloors.slice(0, MAX_FLOORS)) {
      try {
        floors.push(normalizeFloor(entry));
      } catch {
        /* skip a damaged floor instead of refusing to start */
      }
    }
  } catch {
    /* first run */
  }
}

function flush() {
  if (!file || writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const text = JSON.stringify({ policies, floors }, null, 2);
    fsp.mkdir(path.dirname(file), { recursive: true }).then(() => fsp.writeFile(file, text, 'utf8')).catch(() => {});
  }, 120);
  writeTimer.unref?.();
}

/* --------------------------------- floors -------------------------------- */

/**
 * Approval floors are hard deny rules for tool calls. Unlike `ask`, a floor is
 * checked before the approval gate, so auto-approve and full-auto cannot skip
 * it. Pattern matching runs against `<tool> <json args>`.
 */
function floorFor(tool, args) {
  const name = String(tool || '');
  let body;
  try {
    body = JSON.stringify(args || {});
  } catch {
    body = String(args ?? '');
  }
  const haystack = `${name} ${body}`;
  for (const floor of floors) {
    if (floor.tool !== '*' && floor.tool !== name) continue;
    try {
      if (new RegExp(floor.pattern, 'i').test(haystack)) return floor;
    } catch {
      /* pattern was validated on write */
    }
  }
  return null;
}

function floorReason(tool, args) {
  const floor = floorFor(tool, args);
  if (!floor) return null;
  const label = floor.note ? `"${floor.note}"` : floor.pattern;
  return `Blocked by approval floor ${label} (${floor.tool}). Approval floors always win, even in auto-approve or full-auto. Remove it on Security → Permissions.`;
}

function listFloors() {
  return floors.map((floor) => ({ ...floor }));
}

function addFloor(input = {}) {
  if (floors.length >= MAX_FLOORS) throw new Error(`You can keep at most ${MAX_FLOORS} approval floors.`);
  const floor = normalizeFloor(input);
  if (floors.some((f) => f.tool === floor.tool && f.pattern === floor.pattern)) {
    throw new Error('An identical approval floor already exists.');
  }
  floors.push(floor);
  flush();
  return state();
}

function removeFloor(id) {
  const key = String(id || '');
  const before = floors.length;
  floors = floors.filter((floor) => floor.id !== key);
  flush();
  return { ...state(), removed: before !== floors.length };
}

function policyOf(name) {
  return policies[String(name)] || null;
}

/** 'deny' always wins; 'allow' lets a tool skip the built-in approval gate. */
function isDenied(name) {
  return policyOf(name) === 'deny';
}

function isAllowed(name) {
  return policyOf(name) === 'allow';
}

function isAsk(name) {
  return policyOf(name) === 'ask';
}

function denialReason(name) {
  if (!isDenied(name)) return null;
  return `Tool "${name}" is blocked by your permission policy (Integrations → Permissions). Set it to ask or allow to run it.`;
}

function approvalReason(name) {
  if (isDenied(name)) return null;
  if (isAllowed(name)) return null;
  if (isAsk(name)) return `Your permission policy asks before every "${name}" call.`;
  return null;
}

function setPolicy({ tool, policy } = {}) {
  const name = String(tool || '').trim();
  if (!VALID_NAME.test(name)) throw new Error('tool must be a valid tool name.');
  if (policy == null || policy === 'default') {
    delete policies[name];
  } else {
    const value = String(policy).toLowerCase();
    if (!POLICIES.has(value)) throw new Error('policy must be allow, ask, deny or default.');
    policies[name] = value;
  }
  flush();
  return state();
}

function reset(name) {
  if (name) delete policies[String(name)];
  else policies = {};
  flush();
  return state();
}

function sourceOf(tool) {
  const name = String(tool);
  if (name.startsWith('mcp__')) return 'mcp';
  return 'builtin';
}

function state() {
  let defs = [];
  try {
    defs = registry() || [];
  } catch {
    defs = [];
  }
  const tools = defs
    .filter((d) => d && d.name)
    .map((d) => ({
      name: d.name,
      description: String(d.description || '').slice(0, 400),
      source: sourceOf(d.name),
      policy: policies[d.name] || 'default',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const known = new Set(tools.map((t) => t.name));
  for (const [name, policy] of Object.entries(policies)) {
    if (!known.has(name)) tools.push({ name, description: 'This tool is not registered right now (MCP server offline or integration removed).', source: sourceOf(name), policy });
  }
  return {
    policies: { ...policies },
    tools,
    floors: listFloors(),
    counts: {
      allow: tools.filter((t) => t.policy === 'allow').length,
      ask: tools.filter((t) => t.policy === 'ask').length,
      deny: tools.filter((t) => t.policy === 'deny').length,
      floors: floors.length,
      total: tools.length,
    },
  };
}

module.exports = {
  init,
  state,
  setPolicy,
  reset,
  policyOf,
  isDenied,
  isAllowed,
  isAsk,
  denialReason,
  approvalReason,
  floorFor,
  floorReason,
  listFloors,
  addFloor,
  removeFloor,
};
