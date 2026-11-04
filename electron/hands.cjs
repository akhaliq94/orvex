'use strict';

/**
 * Phase 9 — Hands: a bounded action loop over the real desktop.
 *
 * Each step reads the UI Automation tree first. When it exposes enough real
 * controls the model gets that text and answers with path-based ui_* actions,
 * which is far faster and cheaper than a screenshot. Flattened drawing apps,
 * games and empty trees fall back to screenshot + vision coordinates. The loop
 * is capped, audited, approvable and stoppable, and only ACTIONS can run.
 */

const MAX_STEPS = 12;
const MAX_HISTORY = 12;
const ACTIONS = new Set([
  'click',
  'click_text',
  'type',
  'key',
  'scroll',
  'wait',
  'open_app',
  'ui_click',
  'ui_set_value',
  'ui_toggle',
  'ui_select',
  'ui_expand',
  'ui_collapse',
  'ui_focus',
  'done',
  'fail',
]);
const UI_ACTIONS = new Set(['ui_click', 'ui_set_value', 'ui_toggle', 'ui_select', 'ui_expand', 'ui_collapse', 'ui_focus']);
const ACTION_KIND = {
  ui_click: 'click',
  ui_set_value: 'set_value',
  ui_toggle: 'toggle',
  ui_select: 'select',
  ui_expand: 'expand',
  ui_collapse: 'collapse',
  ui_focus: 'focus',
};
const MIN_TREE_CONTROLS = 3;

let ctx = {
  desktop: null,
  ask: null,
  emit: () => {},
  isStopped: () => false,
};

function init(opts = {}) {
  ctx = { ...ctx, ...opts };
}

function clip(value, max) {
  const text = String(value == null ? '' : value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const HANDS_SYSTEM = [
  'You control a Windows computer like a careful human. Each step gives you either the accessibility tree (preferred) or a screenshot.',
  'Return only one JSON object with no prose and no code fence. Allowed actions:',
  '  {"action":"ui_click","path":"[0/1/2]","reason":"..."}',
  '  {"action":"ui_set_value","path":"[0/1/2]","value":"text","reason":"..."}',
  '  {"action":"ui_toggle","path":"[0/1/2]","reason":"..."}',
  '  {"action":"ui_select","path":"[0/1/2]","reason":"..."}',
  '  {"action":"ui_expand","path":"[0/1/2]","reason":"..."}',
  '  {"action":"ui_collapse","path":"[0/1/2]","reason":"..."}',
  '  {"action":"ui_focus","path":"[0/1/2]","reason":"..."}',
  '  {"action":"click","x":NUMBER,"y":NUMBER,"button":"left|right|middle","count":1-3,"reason":"..."}',
  '  {"action":"click_text","text":"visible label","reason":"..."}',
  '  {"action":"type","text":"text to type","reason":"..."}',
  '  {"action":"key","keys":"ENTER","reason":"..."}',
  '  {"action":"scroll","amount":NUMBER,"x":NUMBER,"y":NUMBER,"reason":"..."}',
  '  {"action":"wait","ms":100-5000,"reason":"..."}',
  '  {"action":"open_app","name":"Start-menu app name","reason":"..."}',
  '  {"action":"done","summary":"what is now true on screen"}',
  '  {"action":"fail","reason":"why this cannot be completed"}',
  'When a tree is provided, copy an exact path from it and prefer ui_* actions; never invent a path. To enter text, ui_focus or ui_click the field first, then use type.',
  'When a screenshot is provided, coordinates are screen pixels. Prefer click_text when a label is readable; use click only for icons or blank areas.',
  'Do not repeat an action that already failed. If the goal is already satisfied, answer done immediately.',
].join('\n');

function extractJson(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) throw new Error('The model returned an empty action.');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced ? fenced[1] : null, text].filter(Boolean);
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* try the next slice */
    }
  }
  throw new Error(`The model reply was not a JSON action: ${clip(text, 240)}`);
}

function num(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number.`);
  return n;
}

function optionalNum(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Validate and normalize one model answer. Never trusts the model with raw execution. */
function parseAction(raw) {
  const data = extractJson(raw);
  const action = String(data.action || '').trim().toLowerCase();
  if (!ACTIONS.has(action)) throw new Error(`Unsupported action "${clip(data.action, 40)}".`);

  if (action === 'click') {
    const x = num(data.x, 'x');
    const y = num(data.y, 'y');
    if (x < 0 || y < 0 || x > 20000 || y > 20000) throw new Error('Click coordinates are outside the screen.');
    const button = ['left', 'right', 'middle'].includes(String(data.button)) ? String(data.button) : 'left';
    const count = Math.min(Math.max(Math.round(optionalNum(data.count) || 1), 1), 3);
    return { action, x: Math.round(x), y: Math.round(y), button, count, reason: clip(data.reason, 200) };
  }
  if (action === 'click_text') {
    const text = clip(data.text, 120).trim();
    if (!text) throw new Error('click_text needs the visible label.');
    return { action, text, reason: clip(data.reason, 200) };
  }
  if (action === 'type') {
    const text = String(data.text == null ? '' : data.text);
    if (!text) throw new Error('type needs text.');
    if (text.length > 2000) throw new Error('type is limited to 2000 characters.');
    return { action, text, reason: clip(data.reason, 200) };
  }
  if (action === 'key') {
    const keys = clip(data.keys, 60).trim();
    if (!keys) throw new Error('key needs a key or shortcut.');
    return { action, keys, reason: clip(data.reason, 200) };
  }
  if (action === 'scroll') {
    const amount = Math.min(Math.max(Math.round(num(data.amount, 'amount')), -20), 20);
    return { action, amount, x: optionalNum(data.x), y: optionalNum(data.y), reason: clip(data.reason, 200) };
  }
  if (action === 'wait') {
    const ms = Math.min(Math.max(Math.round(num(data.ms, 'ms')), 100), 5000);
    return { action, ms, reason: clip(data.reason, 200) };
  }
  if (action === 'open_app') {
    const name = clip(data.name, 120).trim();
    if (!name) throw new Error('open_app needs the app name.');
    return { action, name, reason: clip(data.reason, 200) };
  }
  if (UI_ACTIONS.has(action)) {
    const path = clip(data.path, 80).trim();
    const match = clip(data.match, 120).trim();
    if (!path && !match) throw new Error(`${action} needs a path from the tree (or match text).`);
    const out = { action, path, match, type: clip(data.type, 40).trim(), reason: clip(data.reason, 200) };
    if (action === 'ui_set_value') {
      const value = String(data.value == null ? '' : data.value);
      if (!value) throw new Error('ui_set_value needs a value.');
      if (value.length > 2000) throw new Error('ui_set_value is limited to 2000 characters.');
      out.value = value;
    }
    return out;
  }
  if (action === 'done') {
    return { action, summary: clip(data.summary || data.reason || 'Done.', 400) };
  }
  return { action: 'fail', reason: clip(data.reason || 'The model stopped without a reason.', 400) };
}

function requireDesktop() {
  if (!ctx.desktop) throw new Error('Desktop control is not connected.');
  return ctx.desktop;
}

/** Count labelled, visible, actionable nodes in an accessibility tree. */
function countControls(node, total = 0) {
  if (!node) return total;
  const patterns = Array.isArray(node.patterns) ? node.patterns : [];
  const usable = !node.offscreen && node.w > 0 && node.h > 0 && String(node.name || '').trim() && patterns.length > 0;
  const next = total + (usable ? 1 : 0);
  const children = Array.isArray(node.children) ? node.children : [];
  return children.reduce((sum, child) => countControls(child, sum), next);
}

async function execute(action, signal) {
  const desktop = requireDesktop();
  if (UI_ACTIONS.has(action.action)) {
    if (signal && signal.aborted) return { ok: false, error: 'Stopped by the user before this action ran.' };
    if (typeof desktop.uiAction !== 'function') throw new Error('UI Automation is not connected, so path actions cannot run.');
    return desktop.uiAction({
      action: ACTION_KIND[action.action],
      path: action.path || undefined,
      match: action.match || undefined,
      type: action.type || undefined,
      value: action.value,
    });
  }
  if (action.action === 'click') return desktop.mouseClick({ x: action.x, y: action.y, button: action.button, count: action.count });
  if (action.action === 'click_text') return desktop.screenClickText({ text: action.text, limit: 10 });
  if (action.action === 'type') return desktop.keyType({ text: action.text });
  if (action.action === 'key') return desktop.keyPress({ keys: action.keys });
  if (action.action === 'scroll') return desktop.mouseScroll({ amount: action.amount, x: action.x ?? undefined, y: action.y ?? undefined });
  if (action.action === 'wait') return desktop.waitFor({ ms: action.ms });
  if (action.action === 'open_app') return desktop.appLaunch({ name: action.name });
  if (signal && signal.aborted) return { ok: false, error: 'Stopped by the user before this action ran.' };
  throw new Error(`No executor for "${action.action}".`);
}

function summarizeAction(action) {
  if (UI_ACTIONS.has(action.action)) {
    const where = action.path ? `path ${action.path}` : `"${action.match}"`;
    return `${action.action.replace('ui_', '')} ${where}`;
  }
  if (action.action === 'click') return `click ${action.x},${action.y}`;
  if (action.action === 'click_text') return `click "${action.text}"`;
  if (action.action === 'type') return `type "${clip(action.text, 60)}"`;
  if (action.action === 'key') return `press ${action.keys}`;
  if (action.action === 'scroll') return `scroll ${action.amount}`;
  if (action.action === 'wait') return `wait ${action.ms} ms`;
  if (action.action === 'open_app') return `open ${action.name}`;
  return action.action;
}

async function runTask(args = {}) {
  const goal = clip(args.goal, 600).trim();
  if (goal.length < 4) throw new Error('Give a clear goal (at least 4 characters).');
  if (!ctx.ask) throw new Error('The hands loop needs a vision-capable model. Configure one in Settings → Providers.');
  const maxSteps = Math.min(Math.max(Math.round(Number(args.maxSteps) || 6), 1), MAX_STEPS);
  const signal = args.signal || null;
  const display = args.display;
  const steps = [];
  let completed = false;
  let note = '';

  for (let step = 1; step <= maxSteps; step += 1) {
    if (ctx.isStopped(signal) || (signal && signal.aborted)) {
      return { ok: false, error: 'Stopped by the user.', completed: false, steps, goal };
    }
    const desktop = requireDesktop();
    let mode = 'vision';
    let treeText = '';
    let shot = null;
    if (typeof desktop.uiTree === 'function') {
      try {
        const tree = await desktop.uiTree({ interactive: true, depth: 6, max: 300, refresh: true });
        if (tree && tree.ok && countControls(tree.tree) >= MIN_TREE_CONTROLS) {
          mode = 'tree';
          treeText = String(tree.output || '');
        }
      } catch {
        /* a UIA failure is not fatal — the screenshot path still works */
      }
    }
    if (mode === 'vision') {
      shot = await desktop.screenCapture({ display });
      if (!shot || shot.ok === false) {
        return { ok: false, error: (shot && shot.error) || 'Screen capture failed.', completed: false, steps, goal };
      }
    }
    const history = steps.slice(-MAX_HISTORY).map((s) => `step ${s.step}: ${s.what} → ${s.ok ? 'ok' : `failed: ${s.error || ''}`}`);
    let action;
    try {
      const raw = await ctx.ask({ goal, step, maxSteps, shot, tree: treeText, history });
      action = parseAction(raw);
      if (mode === 'tree' && action.action === 'click') {
        throw new Error('No screenshot was shown this step, so pixel coordinates are unsafe. Use ui_click with a path from the tree.');
      }
    } catch (err) {
      const failed = { step, mode, what: 'model reply', ok: false, error: err && err.message ? err.message : String(err) };
      steps.push(failed);
      ctx.emit({ type: 'step', ...failed, goal });
      return { ok: false, error: failed.error, completed: false, steps, goal };
    }

    if (action.action === 'done') {
      completed = true;
      note = action.summary;
      steps.push({ step, mode, what: 'done', ok: true, note });
      ctx.emit({ type: 'step', step, mode, what: 'done', ok: true, note, goal });
      break;
    }
    if (action.action === 'fail') {
      note = action.reason;
      steps.push({ step, mode, what: 'fail', ok: false, error: note });
      ctx.emit({ type: 'step', step, mode, what: 'fail', ok: false, error: note, goal });
      break;
    }

    const what = summarizeAction(action);
    const started = Date.now();
    let result;
    try {
      result = await execute(action, signal);
    } catch (err) {
      result = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    const entry = {
      step,
      mode,
      what,
      action: action.action,
      ok: !!(result && result.ok),
      output: clip((result && (result.output || result.error)) || '', 500),
      error: clip((result && result.error) || '', 300),
      ms: Date.now() - started,
    };
    steps.push(entry);
    ctx.emit({ type: 'step', ...entry, goal });
    if (!entry.ok) {
      const lastTwo = steps.slice(-2);
      if (lastTwo.length === 2 && lastTwo.every((s) => s.ok === false)) {
        note = `Two actions failed in a row; stopped. Last error: ${entry.error}`;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  const ok = completed;
  const done = steps.filter((s) => s.ok).length;
  const output = completed
    ? `Hands completed "${goal}" in ${steps.length} step${steps.length === 1 ? '' : 's'}. ${note || ''}`.trim()
    : `Hands did not finish "${goal}". ${note || `${steps.length} step${steps.length === 1 ? '' : 's'} ran without a done action.`}`;
  return { ok, output, completed, note, goal, steps, done, attempted: steps.length };
}

function approvalReason(args = {}) {
  const maxSteps = Math.min(Math.max(Math.round(Number(args.maxSteps) || 6), 1), MAX_STEPS);
  return `This lets ORVEX take over the mouse, keyboard and apps for up to ${maxSteps} steps toward "${clip(args.goal || 'the goal', 80)}". Watch it run and use Stop to end it.`;
}

const definitions = [
  {
    name: 'hands_run',
    description:
      'Autonomously control the computer toward a goal: screenshot, ask the vision model for one action, execute it (click, click_text, type, key, scroll, wait, open_app), then repeat. Bounded to 12 steps and needs approval. Fails honestly when no vision model is configured.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What should be true on screen when the task is done.' },
        maxSteps: { type: 'number', description: 'Step budget, 1-12 (default 6).' },
        display: { type: 'string', description: 'Display to watch, defaults to the primary screen.' },
      },
      required: ['goal'],
    },
  },
];

const handlers = {
  hands_run: (args, callCtx = {}) => runTask({ ...(args || {}), signal: callCtx.signal }),
};

module.exports = {
  init,
  runTask,
  parseAction,
  approvalReason,
  definitions,
  handlers,
  HANDS_SYSTEM,
  ACTIONS,
  MAX_STEPS,
  _internals: { extractJson, summarizeAction },
};
