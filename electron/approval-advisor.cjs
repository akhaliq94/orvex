'use strict';

/**
 * Escalation-only approval advisor.
 *
 * A rule here can only make a call stricter: it adds a human approval prompt
 * (even under auto-approve / full-auto) or a denial for unattended children.
 * There is deliberately no API that approves, allows or lowers anything.
 *
 * Rules come from the user or from repeated evidence in the audit log
 * (declined approvals, approval-floor hits, unattended denials).
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_RULES = 50;
const MAX_PATTERN = 300;
const MAX_REASON = 300;
const MIN_SUPPORT = 2;
const SCAN_EVENTS = 1500;
const EVIDENCE_KINDS = new Set(['approval', 'tool-floor', 'tool-unattended-denied']);
const TOOL_NAME = /^[a-zA-Z0-9_.:-]{1,120}$/;

let dataDir = null;
let file = null;
let rules = [];
let seq = 0;
let auditTail = () => [];
let flushTimer = null;

function init(opts = {}) {
  dataDir = opts.dataDir || dataDir;
  if (typeof opts.auditTail === 'function') auditTail = opts.auditTail;
  file = dataDir ? path.join(dataDir, 'approval-advisor.json') : null;
  rules = [];
  if (!file) return;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const entry of Array.isArray(raw && raw.rules) ? raw.rules.slice(0, MAX_RULES) : []) {
      try {
        rules.push(normalizeRule(entry));
      } catch {
        /* one damaged rule must not stop the app */
      }
    }
  } catch {
    /* first run */
  }
}

function flush() {
  if (!file || flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString(), rules }, null, 2), 'utf8');
    } catch {
      /* persistence is best-effort; rules still apply for this session */
    }
  }, 150);
}

function normalizeTool(value) {
  const tool = String(value || '').trim();
  if (tool === '*') return '*';
  if (!TOOL_NAME.test(tool)) throw new Error('tool must be "*" or a registered tool name, e.g. shell_exec.');
  return tool;
}

function normalizePattern(value) {
  const pattern = String(value || '').trim();
  if (!pattern) throw new Error('pattern is required.');
  if (pattern.length > MAX_PATTERN) throw new Error(`pattern must be ${MAX_PATTERN} characters or fewer.`);
  try {
    new RegExp(pattern, 'i');
  } catch (err) {
    throw new Error(`pattern is not a valid regular expression: ${err.message}`);
  }
  return pattern;
}

function normalizeRule(raw = {}) {
  const status = raw.status === 'suggested' ? 'suggested' : 'active';
  return {
    id: String(raw.id || `esc_${Date.now().toString(36)}_${(seq += 1).toString(36)}`),
    tool: normalizeTool(raw.tool),
    pattern: normalizePattern(raw.pattern),
    reason: String(raw.reason || 'Requires explicit approval.').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON),
    status,
    source: raw.source === 'manual' ? 'manual' : 'observed',
    hits: Math.max(0, Math.round(Number(raw.hits) || 0)),
    evidence: Math.max(0, Math.round(Number(raw.evidence) || 0)),
    createdAt: String(raw.createdAt || new Date().toISOString()),
  };
}

function state() {
  const active = rules.filter((rule) => rule.status === 'active').length;
  return {
    rules: rules.map((rule) => ({ ...rule })),
    counts: { active, suggested: rules.length - active, total: rules.length },
    note: 'Escalation rules can only add an approval prompt or a denial. They never approve, allow or relax a call.',
  };
}

function add(input = {}) {
  if (rules.length >= MAX_RULES) throw new Error(`You can keep at most ${MAX_RULES} escalation rules.`);
  const rule = normalizeRule({ ...input, status: input.status === 'suggested' ? 'suggested' : 'active', source: 'manual' });
  if (rules.some((r) => r.tool === rule.tool && r.pattern === rule.pattern)) {
    throw new Error('An identical escalation rule already exists.');
  }
  rules.push(rule);
  flush();
  return state();
}

function remove(id) {
  const before = rules.length;
  rules = rules.filter((rule) => rule.id !== String(id || ''));
  flush();
  return { ...state(), removed: before !== rules.length };
}

function accept(id) {
  const rule = rules.find((r) => r.id === String(id || ''));
  if (!rule) throw new Error(`Unknown escalation rule "${id}".`);
  rule.status = 'active';
  flush();
  return state();
}

/**
 * The only decision surface: returns a reason when a rule matches, otherwise
 * null. A returned reason can only escalate the call, never permit it.
 */
function escalate(tool, args = {}) {
  const name = String(tool || '');
  if (!name) return null;
  let haystack = '';
  try {
    haystack = `${name} ${JSON.stringify(args || {})}`;
  } catch {
    haystack = `${name} ${String(args)}`;
  }
  for (const rule of rules) {
    if (rule.status !== 'active') continue;
    if (rule.tool !== '*' && rule.tool !== name) continue;
    let hit = false;
    try {
      hit = new RegExp(rule.pattern, 'i').test(haystack);
    } catch {
      hit = false;
    }
    if (!hit) continue;
    rule.hits += 1;
    flush();
    return {
      id: rule.id,
      reason: `Escalated by the approval advisor: ${rule.reason} (rule /${rule.pattern}/i on ${rule.tool}). It needs your explicit yes even in auto-approve.`,
    };
  }
  return null;
}

/**
 * Turn audit evidence into suggestions. Only suggestions — nothing activates
 * without the user accepting it.
 */
function learn() {
  let events = [];
  try {
    events = auditTail(SCAN_EVENTS) || [];
  } catch {
    events = [];
  }
  const evidence = new Map();
  for (const event of events) {
    if (!event || !EVIDENCE_KINDS.has(String(event.kind))) continue;
    const declined = event.kind === 'approval' && !event.ok;
    const denied = event.kind !== 'approval';
    if (!declined && !denied) continue;
    const tool = String(event.tool || '').trim();
    if (!TOOL_NAME.test(tool)) continue;
    const item = evidence.get(tool) || { count: 0, example: '' };
    item.count += 1;
    if (!item.example && event.args) item.example = String(event.args).slice(0, 140);
    evidence.set(tool, item);
  }
  const created = [];
  for (const [tool, item] of evidence) {
    if (item.count < MIN_SUPPORT) continue;
    if (rules.some((rule) => rule.tool === tool)) continue;
    if (rules.length >= MAX_RULES) break;
    const rule = normalizeRule({
      tool,
      pattern: '.*',
      reason: `${tool} was blocked or refused ${item.count} time(s); ask first${item.example ? ` (last: ${item.example})` : ''}.`,
      status: 'suggested',
      source: 'observed',
      evidence: item.count,
    });
    rules.push(rule);
    created.push({ ...rule });
  }
  if (created.length) flush();
  return { created, ...state() };
}

/**
 * Pure decision helper used by the agent loop so the policy is testable:
 * escalation always wins over auto-approve; nothing here can auto-approve a
 * call that had no risk classification to begin with.
 */
function approvalMode({ risk = null, escalation = null, autoApprove = false } = {}) {
  if (escalation) return 'ask';
  if (!risk) return null;
  return autoApprove ? 'auto' : 'ask';
}

function _reset() {
  rules = [];
  seq = 0;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  auditTail = () => [];
}

module.exports = {
  MAX_RULES,
  MIN_SUPPORT,
  init,
  state,
  add,
  remove,
  accept,
  escalate,
  learn,
  approvalMode,
  _reset,
};
