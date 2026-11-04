'use strict';

/**
 * Section 19 — multi-agent collaboration.
 *
 * A goal is handed to a roster of specialised agents (planner, researcher,
 * builder, critic). They share one transcript, contribute in rounds, then a
 * synthesizer produces the final answer. Every call goes through the real model
 * gateway; nothing is simulated. Runs are bounded (5 agents, 3 rounds) and can
 * be stopped at any time.
 */

const crypto = require('node:crypto');
const db = require('./db.cjs');

const MAX_AGENTS = 5;
const MAX_ROUNDS = 3;
const MAX_GOAL = 4000;

const BUILTIN = [
  {
    id: 'planner',
    name: 'Planner',
    role: 'planner',
    prompt:
      'You are the planning agent in a small team. Break the goal into concrete ordered steps, name the constraints, and state how success will be judged. Do not write the final deliverable yet. Be specific and brief (max 250 words).',
  },
  {
    id: 'researcher',
    name: 'Researcher',
    role: 'researcher',
    prompt:
      'You are the research agent. From the goal and the shared transcript, gather the facts that matter. Separate verified facts from assumptions, and point out what is still unknown. Never invent citations. Max 250 words.',
  },
  {
    id: 'builder',
    name: 'Builder',
    role: 'builder',
    prompt:
      'You are the builder agent. Produce the concrete artifact or answer the goal asks for: code, draft, plan, or calculation. Prefer complete, directly usable output over commentary. Max 500 words.',
  },
  {
    id: 'critic',
    name: 'Critic',
    role: 'critic',
    prompt:
      'You are the critic. Check the shared transcript against the goal and the success criteria. List concrete errors, omissions, risks, and contradictions, then say exactly how to fix each. Do not praise. Max 250 words.',
  },
  {
    id: 'synthesizer',
    name: 'Synthesizer',
    role: 'synthesizer',
    prompt:
      'You are the synthesizer. Merge the team contributions into one final answer for the user. Resolve the critic\'s objections, keep every concrete detail that matters, and do not mention the internal team or the process. Output only the final answer.',
  },
];

let ctx = {
  gateway: null,
  emit: () => {},
  planCandidates: (list) => list,
  version: () => '1.0.0',
};

const running = new Map();

function init(opts = {}) {
  ctx = { ...ctx, ...opts };
  seedBuiltins();
  try {
    db.raw()
      ?.prepare("UPDATE adv_sessions SET status = 'interrupted', updated_at = ? WHERE status = 'running'")
      .run(Date.now());
  } catch {
    /* first run or read-only profile */
  }
}

function now() {
  return Date.now();
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function raw() {
  return db.raw();
}

function clip(text, max = 8000) {
  const s = String(text == null ? '' : text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function parse(text, fallback) {
  try {
    const value = typeof text === 'string' ? JSON.parse(text) : text;
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

function emit(event) {
  try {
    ctx.emit(event);
  } catch {
    /* the window closed */
  }
}

function seedBuiltins() {
  const rawDb = raw();
  if (!rawDb) return;
  const insert = rawDb.prepare('INSERT OR IGNORE INTO adv_agents(id, name, role, prompt, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)');
  for (const a of BUILTIN) insert.run(a.id, a.name, a.role, a.prompt, now(), now());
}

function listAgents() {
  const rows = raw()?.prepare('SELECT * FROM adv_agents ORDER BY created_at ASC').all() || [];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role,
    prompt: r.prompt,
    builtin: BUILTIN.some((b) => b.id === r.id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

function saveAgent(input = {}) {
  const name = clip(String(input.name || '').trim(), 80);
  const ROLES = ['planner', 'researcher', 'builder', 'critic', 'synthesizer', 'worker'];
  const askedRole = clip(String(input.role || 'worker').trim().toLowerCase(), 40) || 'worker';
  const role = ROLES.includes(askedRole) ? askedRole : 'worker';
  const prompt = clip(String(input.prompt || '').trim(), 4000);
  if (!name) throw new Error('Agent name is required.');
  if (prompt.length < 20) throw new Error('Give the agent a prompt of at least 20 characters.');
  let id = newId('agent');
  if (input.id) {
    id = String(input.id);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) throw new Error('Agent ids may only use letters, numbers, dashes and underscores.');
  }
  const existing = raw()?.prepare('SELECT id FROM adv_agents WHERE id = ?').get(id);
  if (existing) {
    raw()?.prepare('UPDATE adv_agents SET name = ?, role = ?, prompt = ?, updated_at = ? WHERE id = ?').run(name, role, prompt, now(), id);
  } else {
    raw()?.prepare('INSERT INTO adv_agents(id, name, role, prompt, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)').run(id, name, role, prompt, now(), now());
  }
  db.audit({ kind: 'collab-agent-save', tool: 'collab', args: JSON.stringify({ id, name, role }), ok: true });
  return { id, name, role, prompt, builtin: BUILTIN.some((b) => b.id === id) };
}

function deleteAgent(id) {
  const rows = raw()?.prepare('SELECT COUNT(*) AS n FROM adv_agents').get()?.n || 0;
  if (rows <= 2) throw new Error('Keep at least two agents so collaboration still works.');
  const changes = raw()?.prepare('DELETE FROM adv_agents WHERE id = ?').run(String(id)).changes || 0;
  return { removed: changes };
}

function normalizeCandidates(list) {
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || !c.baseUrl || !c.model) continue;
    const item = {
      id: String(c.id || c.presetId || c.baseUrl),
      presetId: String(c.presetId || c.id || ''),
      name: String(c.name || c.model),
      baseUrl: String(c.baseUrl).replace(/\/+$/, ''),
      apiKey: c.apiKey || '',
      api: c.api === 'anthropic' ? 'anthropic' : 'openai',
      model: String(c.model),
    };
    const key = `${item.id}|${item.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function sessionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    goal: row.goal,
    status: row.status,
    rounds: row.rounds,
    agents: parse(row.agents, []),
    model: row.model || null,
    result: row.result || null,
    error: row.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listSessions(limit = 20) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  return (raw()?.prepare('SELECT id, goal, status, rounds, model, created_at AS createdAt, updated_at AS updatedAt FROM adv_sessions ORDER BY created_at DESC LIMIT ?').all(n) || []).map(sessionRow);
}

function getSession(id) {
  const row = raw()?.prepare('SELECT * FROM adv_sessions WHERE id = ?').get(String(id));
  if (!row) return null;
  return { ...sessionRow(row), messages: messagesFor(id) };
}

function messagesFor(id) {
  return (raw()?.prepare('SELECT id, agent, role, round, text, at FROM adv_messages WHERE session_id = ? ORDER BY id ASC').all(String(id)) || []).map((m) => ({
    id: m.id,
    agent: m.agent,
    role: m.role,
    round: m.round,
    text: m.text,
    at: m.at,
  }));
}

function transcript(messages) {
  return messages
    .map((m) => `[round ${m.round}] ${m.agent || m.role}: ${m.text}`)
    .join('\n\n')
    .slice(-14000);
}

async function callAgent({ agent, goal, round, totalRounds, messages, candidates, signal }) {
  const prior = transcript(messages);
  const system = `${agent.prompt}\n\nYou are one of several agents collaborating on the same goal. Reply with your contribution only — no role label, no preamble.`;
  const prompt = [
    `Goal:\n${goal}`,
    `Round ${round} of ${totalRounds}.`,
    prior ? `Shared transcript so far:\n${prior}` : 'The shared transcript is empty — you go first.',
    `Your contribution as ${agent.name}:`,
  ].join('\n\n');
  const reply = await ctx.gateway.chat({
    candidates,
    system,
    history: [{ role: 'user', text: prompt }],
    task: 'agent',
    temperature: agent.role === 'critic' ? 0.2 : 0.5,
    maxTokens: agent.role === 'synthesizer' ? 2200 : 1100,
    signal,
  });
  return { text: String(reply.text || '').trim(), provider: reply.provider || null };
}

async function runSession(id, state) {
  const session = sessionRow(raw()?.prepare('SELECT * FROM adv_sessions WHERE id = ?').get(id));
  if (!session) return null;
  const agents = (session.agents || []).map((agentId) => listAgents().find((a) => a.id === agentId)).filter(Boolean);
  const synth = agents.find((a) => a.role === 'synthesizer') || listAgents().find((a) => a.id === 'synthesizer');
  const workers = agents.filter((a) => a.role !== 'synthesizer');
  const messages = [];
  const candidates = state.candidates;
  try {
    for (let round = 1; round <= session.rounds; round += 1) {
      for (const agent of workers) {
        if (state.stopped || state.controller.signal.aborted) throw Object.assign(new Error('Stopped by the user.'), { stopped: true });
        emit({ type: 'collab-thinking', sessionId: id, agent: agent.name, role: agent.role, round, at: now() });
        const result = await callAgent({ agent, goal: session.goal, round, totalRounds: session.rounds, messages, candidates, signal: state.controller.signal });
        const message = { agent: agent.name, role: agent.role, round, text: result.text, at: now() };
        messages.push(message);
        raw()?.prepare('INSERT INTO adv_messages(session_id, agent, role, round, text, at) VALUES(?, ?, ?, ?, ?, ?)').run(id, agent.name, agent.role, round, result.text, message.at);
        state.model = result.provider ? `${result.provider.name} · ${result.provider.model}` : state.model;
        emit({ type: 'collab-message', sessionId: id, ...message });
      }
    }
    if (state.stopped || state.controller.signal.aborted) throw Object.assign(new Error('Stopped by the user.'), { stopped: true });
    let final = '';
    if (synth) {
      emit({ type: 'collab-thinking', sessionId: id, agent: synth.name, role: 'synthesizer', round: session.rounds + 1, at: now() });
      const result = await callAgent({ agent: synth, goal: session.goal, round: session.rounds + 1, totalRounds: session.rounds, messages, candidates, signal: state.controller.signal });
      final = result.text;
      const message = { agent: synth.name, role: 'synthesizer', round: session.rounds + 1, text: final, at: now() };
      messages.push(message);
      raw()?.prepare('INSERT INTO adv_messages(session_id, agent, role, round, text, at) VALUES(?, ?, ?, ?, ?, ?)').run(id, synth.name, 'synthesizer', message.round, final, message.at);
      state.model = result.provider ? `${result.provider.name} · ${result.provider.model}` : state.model;
      emit({ type: 'collab-message', sessionId: id, ...message });
    } else {
      final = messages.filter((m) => m.role === 'builder').slice(-1)[0]?.text || messages.slice(-1)[0]?.text || '';
    }
    raw()?.prepare("UPDATE adv_sessions SET status = 'done', result = ?, model = ?, updated_at = ? WHERE id = ?").run(clip(final, 12000), state.model || null, now(), id);
    emit({ type: 'collab-done', sessionId: id, result: final, at: now() });
  } catch (err) {
    const stopped = state.stopped || state.controller.signal.aborted || (err && err.stopped);
    raw()
      ?.prepare('UPDATE adv_sessions SET status = ?, error = ?, model = ?, updated_at = ? WHERE id = ?')
      .run(stopped ? 'stopped' : 'failed', stopped ? 'Stopped by the user.' : err && err.message ? err.message : String(err), state.model || null, now(), id);
    emit({ type: 'collab-error', sessionId: id, error: stopped ? 'Stopped by the user.' : err && err.message ? err.message : String(err), at: now() });
  } finally {
    running.delete(id);
  }
  return getSession(id);
}

async function startSession(input = {}, { wait = false } = {}) {
  const goal = clip(String(input.goal || '').trim(), MAX_GOAL);
  if (!goal) throw new Error('Describe the goal for the team.');
  const all = listAgents();
  const requested = Array.isArray(input.agentIds) && input.agentIds.length ? input.agentIds.map(String) : all.filter((a) => a.role !== 'synthesizer').map((a) => a.id);
  const ids = [...new Set(requested.filter((id) => all.some((a) => a.id === id)))];
  if (!ids.length) throw new Error('Pick at least one agent from the roster.');
  if (!ids.includes('synthesizer')) ids.push('synthesizer');
  if (ids.length > MAX_AGENTS) throw new Error(`At most ${MAX_AGENTS} agents can work on one session, including the synthesizer.`);
  const workers = ids.filter((id) => id !== 'synthesizer');
  if (!workers.length) throw new Error('Pick at least one working agent besides the synthesizer.');
  const rounds = Math.min(Math.max(Math.round(Number(input.rounds) || 1), 1), MAX_ROUNDS);
  const rawCandidates = normalizeCandidates([input.provider, ...(Array.isArray(input.candidates) ? input.candidates : [])]);
  const planned = ctx.planCandidates(rawCandidates, { task: 'agent', prompt: goal, sensitive: !!input.sensitive });
  const candidates = (planned && planned.candidates) || rawCandidates;
  if (!candidates.length) throw new Error((planned && planned.reason) || 'No model is configured. Add a provider in Settings first.');
  const id = newId('collab');
  const controller = new AbortController();
  raw()
    ?.prepare("INSERT INTO adv_sessions(id, goal, status, rounds, agents, model, created_at, updated_at) VALUES(?, ?, 'running', ?, ?, NULL, ?, ?)")
    .run(id, goal, rounds, JSON.stringify(ids), now(), now());
  const state = { controller, candidates, stopped: false, model: null };
  running.set(id, state);
  emit({ type: 'collab-start', sessionId: id, goal, agents: ids, rounds, model: planned && planned.reason ? planned.reason : null, at: now() });
  const promise = runSession(id, state);
  if (wait) return promise;
  return getSession(id);
}

function stopSession(id) {
  const state = running.get(String(id));
  if (!state) throw new Error('That session is not running.');
  state.stopped = true;
  state.controller.abort();
  raw()?.prepare("UPDATE adv_sessions SET status = 'stopped', error = 'Stopped by the user.', updated_at = ? WHERE id = ?").run(now(), String(id));
  return getSession(id);
}

/** Emergency stop: abort every running collaboration session. */
function stopAll(reason = 'Emergency stop') {
  let stopped = 0;
  for (const [id, state] of running) {
    try {
      state.stopped = true;
      state.controller.abort();
      raw()
        ?.prepare("UPDATE adv_sessions SET status = 'stopped', error = ?, updated_at = ? WHERE id = ?")
        .run(String(reason).slice(0, 400), now(), String(id));
      stopped += 1;
    } catch {
      /* one stuck session must not keep the rest alive */
    }
  }
  running.clear();
  return { stopped };
}

function deleteSession(id) {
  const state = running.get(String(id));
  if (state) state.controller.abort();
  raw()?.prepare('DELETE FROM adv_messages WHERE session_id = ?').run(String(id));
  const changes = raw()?.prepare('DELETE FROM adv_sessions WHERE id = ?').run(String(id)).changes || 0;
  return { removed: changes };
}

module.exports = {
  init,
  listAgents,
  saveAgent,
  deleteAgent,
  listSessions,
  getSession,
  startSession,
  stopSession,
  stopAll,
  deleteSession,
  BUILTIN,
};
