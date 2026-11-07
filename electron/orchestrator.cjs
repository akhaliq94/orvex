'use strict';

/**
 * Multi-step orchestration: a planner turns the goal into verifiable steps, an
 * executor runs each step through the agent loop, and a supervisor judges the
 * reported result against the step's acceptance criteria. Failures are retried
 * once with feedback, then replanned once. Every step and the plan itself are
 * checkpointed in SQLite, so an interrupted run can be resumed.
 */

const gateway = require('./model-gateway.cjs');
const db = require('./db.cjs');
const { runAgent } = require('./agent.cjs');

const MAX_PLAN_STEPS = 8;
const MAX_ATTEMPTS_PER_STEP = 2;
const MAX_REPLANS = 1;
const MAX_ORCH_MS = 90 * 60 * 1000;

const PLANNER_SYSTEM = `You are the ORVEX planner. You break a goal for an autonomous desktop agent into the smallest number of concrete, verifiable steps.
Rules:
- 1 to 8 steps. Each step must be doable on its own with the executor's tools: files, shell, apps, real browser/screen control, web search, memory.
- Write steps as work to do, never as invented findings or results.
- Put ids of earlier steps that must finish first in dependsOn.
- readOnly is true only for steps that never write, install, delete, send, or change state.
- Give the same positive parallelGroup to independent read-only steps that can safely run at the same time; use 0 for everything that must run alone.
- validate describes the observable evidence that proves the step really succeeded.
- Keep every goal string self-contained — the executor sees only that step plus a short summary of earlier steps.
- Reply with JSON matching the schema exactly.`;

const VALIDATOR_SYSTEM = `You are the ORVEX validator. Decide whether the executor really completed the step, based only on its report.
- ok=true only when the acceptance criteria were met by real actions with concrete evidence (paths, command output, URLs, visible results).
- If the report is vague, claims actions without evidence, or only partly covers the criteria, ok=false and say precisely what is missing in feedback.
- Never accept a claim that contradicts an error in the report.
- Reply with JSON matching the schema exactly.`;

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['steps'],
  properties: {
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_PLAN_STEPS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'goal', 'dependsOn', 'readOnly', 'parallelGroup', 'validate'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          goal: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          readOnly: { type: 'boolean' },
          parallelGroup: { type: 'integer', minimum: 0, maximum: 8 },
          validate: { type: 'string' },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'reason', 'feedback'],
  properties: {
    ok: { type: 'boolean' },
    reason: { type: 'string' },
    feedback: { type: 'string' },
  },
};

function normalizePlan(raw, { startIdx = 0, existingIds = new Set() } = {}) {
  const list = Array.isArray(raw && raw.steps) ? raw.steps.slice(0, MAX_PLAN_STEPS) : [];
  const seen = new Set(existingIds);
  const picked = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const goal = String(s.goal || '').trim();
    if (!goal) continue;
    let id = String(s.id || '').trim() || `s${startIdx + picked.length + 1}`;
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);
    picked.push({ raw: s, id, goal });
  }
  // Dependencies may point forward in the plan, so resolve them after every id
  // exists instead of dropping them as they are reached.
  return picked.map(({ raw: s, id, goal }, i) => ({
    idx: startIdx + i,
    id,
    title: String(s.title || '').trim() || goal.slice(0, 70),
    goal,
    dependsOn: (Array.isArray(s.dependsOn) ? s.dependsOn : [])
      .map((d) => String(d || '').trim())
      .filter((d) => d && d !== id && seen.has(d)),
    readOnly: s.readOnly === true,
    parallelGroup: Math.max(0, Math.min(8, Math.round(Number(s.parallelGroup) || 0))),
    validate:
      String(s.validate || '').trim() ||
      'The step goal is achieved and the result is backed by real evidence from the tools.',
    status: 'pending',
    attempts: 0,
    output: '',
    error: null,
    startedAt: null,
    endedAt: null,
  }));
}

/** Stable topological order — dependencies before dependants, plan order otherwise. */
function orderPlan(plan) {
  const byId = new Map(plan.map((s) => [s.id, s]));
  const out = [];
  const state = new Map();
  const visit = (step) => {
    const mark = state.get(step.id);
    if (mark === 2 || mark === 1) return;
    state.set(step.id, 1);
    for (const dep of step.dependsOn) {
      const target = byId.get(dep);
      if (target) visit(target);
    }
    state.set(step.id, 2);
    out.push(step);
  };
  for (const step of plan) visit(step);
  return out;
}

function hydratePlan(plan) {
  return (Array.isArray(plan) ? plan : [])
    .filter((s) => s && s.id && s.goal)
    .map((s, i) => ({
      idx: Number.isFinite(Number(s.idx)) ? Number(s.idx) : i,
      id: String(s.id),
      title: String(s.title || s.goal).slice(0, 120),
      goal: String(s.goal).slice(0, 4000),
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
      readOnly: s.readOnly === true,
      parallelGroup: Math.max(0, Math.min(8, Number(s.parallelGroup) || 0)),
      validate: String(s.validate || 'The step goal is achieved with real evidence.'),
      status:
        s.status === 'done'
          ? 'done'
          : s.status === 'skipped'
            ? 'skipped'
            : s.status === 'replaced'
              ? 'replaced'
              : s.status === 'running'
                ? 'interrupted'
                : 'pending',
      attempts: Math.max(0, Number(s.attempts) || 0),
      output: String(s.output || ''),
      error: s.error ? String(s.error) : null,
      startedAt: Number(s.startedAt) || null,
      endedAt: Number(s.endedAt) || null,
    }));
}

/** A run of steps that can execute together: same group, read-only, no internal deps. */
function collectGroup(plan, pos) {
  const step = plan[pos];
  if (!step || !(step.readOnly && step.parallelGroup > 0)) return { parallel: false, steps: step ? [step] : [] };
  const batch = [step];
  let j = pos + 1;
  while (j < plan.length) {
    const next = plan[j];
    if (!(next.readOnly && next.parallelGroup === step.parallelGroup)) break;
    if (next.dependsOn.some((d) => batch.some((b) => b.id === d))) break;
    batch.push(next);
    j += 1;
  }
  return { parallel: batch.length > 1, steps: batch };
}

async function runOrchestrator(opts) {
  const { goal, provider, candidates, local, memory, emit, signal, gate, approve, maxSteps, autoApprove, runId, task, resume } = opts;
  const started = Date.now();
  const chain = Array.isArray(candidates) && candidates.length ? candidates : provider ? [provider] : [];
  if (!chain.length) throw new Error('No model configured for this run.');
  const primary = chain[0];
  const perStep = Math.min(Math.max(Math.round(Number(maxSteps) || 12), 4), 24);

  const saved = resume ? db.runGet(runId) : null;
  const cp = saved && saved.checkpoint;
  const resuming = !!(resume && cp && Array.isArray(cp.plan) && cp.plan.length);

  const state = {
    goal: String(goal || (saved && saved.goal) || ''),
    plan: resuming ? orderPlan(hydratePlan(cp.plan)) : [],
    nextIdx: resuming ? Number(cp.nextIdx) || cp.plan.length : 0,
    replans: resuming ? Number(cp.replans) || 0 : 0,
  };
  if (!state.goal.trim()) throw new Error('This run has no saved goal to resume.');
  if (resuming) {
    // A step that was executing when the app died is still marked running in
    // run_steps (or interrupted by boot cleanup); never re-run it silently.
    for (const row of db.runStepsGet(runId)) {
      if (row.status !== 'running' && row.status !== 'interrupted') continue;
      const step = state.plan.find((s) => (row.id ? s.id === row.id : s.idx === row.idx));
      if (step && !['done', 'skipped', 'replaced'].includes(step.status)) step.status = 'interrupted';
    }
  }

  let executed = 0;
  let finished = false;

  const planView = () =>
    state.plan.map((s) => ({
      idx: s.idx,
      id: s.id,
      title: s.title,
      status: s.status,
      readOnly: s.readOnly,
      parallelGroup: s.parallelGroup,
      dependsOn: s.dependsOn,
      attempts: s.attempts,
    }));

  // Enough to rebuild model calls after a restart. Never the API key.
  const providerInfo = (p) =>
    p && p.baseUrl && p.model
      ? {
          id: p.id || p.presetId || null,
          presetId: p.presetId || null,
          name: p.name || null,
          baseUrl: String(p.baseUrl),
          api: p.api || 'openai',
          model: String(p.model),
        }
      : null;

  // Step output already lives in run_steps; the checkpoint only needs enough
  // of it for the resume summary, so every step write stays small.
  const checkpointPlan = () =>
    state.plan.map((step) => ({ ...step, output: String(step.output || '').slice(0, 800) }));

  const saveCheckpoint = (status) => {
    db.runSaveCheckpoint(runId, {
      mode: 'orchestrator',
      goal: state.goal,
      task: String(task || 'agent'),
      provider: providerInfo(primary),
      candidates: chain.map(providerInfo).filter(Boolean),
      plan: checkpointPlan(),
      nextIdx: state.nextIdx,
      replans: state.replans,
      status,
      savedAt: Date.now(),
    });
  };

  const persist = (step) => db.runStepUpsert(runId, step);

  const finish = (payload) => {
    if (finished) return payload;
    finished = true;
    const outcome = {
      ok: false,
      mode: 'orchestrator',
      ms: Date.now() - started,
      steps: executed,
      plan: planView(),
      ...payload,
    };
    saveCheckpoint(outcome.cancelled ? 'paused' : outcome.ok ? 'done' : 'failed');
    emit({ type: 'run_end', ...outcome });
    return outcome;
  };

  const doneList = () => {
    const done = state.plan.filter((s) => s.status === 'done');
    if (!done.length) return '(nothing completed yet)';
    return done.map((s) => `- ${s.title}: ${String(s.output || '').slice(0, 400)}`).join('\n');
  };

  const gateEvent = (event) => {
    if (!event) return;
    if (event.type === 'model_retry') {
      const wait = Math.round(Number(event.waitMs || 0) / 1000);
      const when = wait >= 1 ? `waiting ${wait}s, ` : '';
      const rateLimited = Number(event.status) === 429 || /429|rate.?limit/i.test(String(event.reason || ''));
      emit({
        type: 'status',
        text: rateLimited
          ? `Planner/validator is rate-limited — ${when}retry ${event.attempt || 1}/${event.maxAttempts || 2}`
          : `Planner/validator hit a temporary error — ${when}retry ${event.attempt || 1}/${event.maxAttempts || 2}`,
      });
    } else if (event.type === 'model_fallback') {
      emit({ type: 'status', text: `Failing over to ${event.next || 'the next model'}` });
    } else if (event.type === 'budget_exceeded') {
      emit({
        type: 'status',
        text: `Budget reached — $${Number(event.spent || 0).toFixed(2)} spent of $${Number(event.budget || 0).toFixed(2)}. Paid models are paused; a local model keeps this run going, or raise the limit in Settings → Usage.`,
      });
    }
  };

  async function requestPlan({ mode, failed, remaining }) {
    const parts = [`Goal:\n${state.goal}`];
    if (mode === 'replan') {
      parts.push(
        `A step could not be completed after retries:\n- ${failed.title}: ${failed.goal}\nFailure: ${
          failed.error || failed.output || 'unknown'
        }`,
      );
      parts.push(`Work already completed (do not repeat it):\n${doneList()}`);
      if (remaining && remaining.length) {
        parts.push(`Unfinished steps from the old plan (rework as needed):\n${remaining.map((s) => `- ${s.title}: ${s.goal}`).join('\n')}`);
      }
      parts.push('Produce a revised plan for the remaining work only. Keep it small and verifiable.');
    } else {
      parts.push('Produce the plan for this goal.');
    }
    if (memory && memory.trim()) parts.push(`Context from earlier runs (may be stale — verify before relying on it):\n${memory.trim().slice(-3000)}`);
    const res = await gateway.chat({
      candidates: chain,
      task: 'plan',
      system: PLANNER_SYSTEM,
      history: [{ role: 'user', text: parts.join('\n\n') }],
      jsonSchema: PLAN_SCHEMA,
      temperature: 0.2,
      maxTokens: 1600,
      signal,
      runId,
      onEvent: gateEvent,
    });
    return res.json;
  }

  async function supervise(step, summary) {
    try {
      const res = await gateway.chat({
        candidates: chain,
        task: 'plan',
        system: VALIDATOR_SYSTEM,
        history: [
          {
            role: 'user',
            text: `Overall goal: ${state.goal}\n\nStep: ${step.title}\nStep goal: ${step.goal}\nAcceptance criteria: ${step.validate}\n\nExecutor report:\n${String(summary).slice(0, 4000)}`,
          },
        ],
        jsonSchema: VERDICT_SCHEMA,
        temperature: 0,
        maxTokens: 400,
        signal,
        runId,
        onEvent: gateEvent,
      });
      const v = res.json || {};
      return {
        ok: v.ok === true,
        reason: String(v.reason || '').slice(0, 500),
        feedback: String(v.feedback || '').slice(0, 900),
      };
    } catch (err) {
      if (err && err.name === 'AbortError') return { cancelled: true, ok: false, reason: 'Stopped by user.' };
      return {
        ok: true,
        unverified: true,
        reason: `Validator unavailable (${err && err.message ? err.message : String(err)}) — step result accepted as reported.`,
      };
    }
  }

  function stepGuidance(step, feedback) {
    const position = state.plan.filter((s) => s.idx <= step.idx).length;
    return `You are executing one step of a larger multi-step plan.
Overall goal: ${state.goal}
This step (${position} of ${state.plan.length}): ${step.title}
Step goal: ${step.goal}
Acceptance criteria: ${step.validate}
What is already done:
${doneList()}
${
  feedback
    ? `\nThe previous attempt at this step failed validation:\n${feedback}\nFix that specific problem.`
    : ''
}
Do only this step. End with a short report of exactly what you did and the concrete evidence (paths, command output, URLs). Never claim an action you did not perform.`;
  }

  async function runStepOnce(step, attempt, { feedback, parallel }) {
    const stepStarted = Date.now();
    step.status = 'running';
    step.startedAt = step.startedAt || stepStarted;
    persist(step);
    saveCheckpoint('running');
    emit({
      type: 'step_start',
      idx: step.idx,
      id: step.id,
      title: step.title,
      goal: step.goal,
      attempt,
      parallel,
      validate: step.validate,
      position: state.plan.filter((s) => s.idx <= step.idx).length,
      total: state.plan.length,
    });

    const stepEmit = (event) => {
      if (!event || event.type === 'run_start' || event.type === 'run_end') return;
      emit({ ...event, stepId: step.id, stepIdx: step.idx, stepTitle: step.title, attempt });
    };

    let outcome;
    try {
      outcome = await runAgent({
        goal: step.goal,
        provider: provider || primary,
        candidates: chain,
        local,
        memory,
        emit: stepEmit,
        signal,
        gate,
        approve,
        maxSteps: perStep,
        autoApprove,
        runId,
        task: task || 'agent',
        systemAppend: stepGuidance(step, feedback),
      });
    } catch (err) {
      if (err && err.name === 'AbortError') return { cancelled: true, ok: false, reason: 'Stopped by user.' };
      outcome = { ok: false, summary: `Step crashed: ${err && err.message ? err.message : String(err)}` };
    }

    if (outcome && outcome.cancelled) {
      step.status = 'pending';
      persist(step);
      return { cancelled: true, ok: false, reason: 'Stopped by user.' };
    }

    const summary = String((outcome && outcome.summary) || '').trim() || '(no summary)';
    if (!outcome || !outcome.ok) {
      const reason = `Step did not finish: ${summary}`;
      return { ok: false, reason, feedback: reason };
    }

    emit({ type: 'status', text: `Validating “${step.title}”…` });
    const verdict = await supervise(step, summary);
    if (verdict.cancelled) return { cancelled: true, ok: false, reason: 'Stopped by user.' };
    emit({
      type: 'validation',
      idx: step.idx,
      id: step.id,
      ok: verdict.ok,
      reason: verdict.reason,
      unverified: !!verdict.unverified,
      attempt,
    });
    if (!verdict.ok) {
      return { ok: false, reason: verdict.reason || 'Validation failed.', feedback: verdict.feedback || verdict.reason || '' };
    }

    step.status = 'done';
    step.output = summary;
    step.error = null;
    step.endedAt = Date.now();
    persist(step);
    saveCheckpoint('running');
    emit({
      type: 'step_done',
      idx: step.idx,
      id: step.id,
      title: step.title,
      ok: true,
      summary,
      attempts: step.attempts,
      ms: Date.now() - stepStarted,
      unverified: !!verdict.unverified,
      parallel,
    });
    return { ok: true };
  }

  async function executeWithRetries(step, { parallel }) {
    if (step.status === 'interrupted') {
      // The app closed while this step was mid-flight. It may already have
      // written files or sent something, so re-running it needs a yes.
      const reason = `“${step.title}” was interrupted while it was running and may have already changed things. Run it again?`;
      step.status = 'pending';
      persist(step);
      if (approve) {
        emit({ type: 'approval_request', id: `resume:${step.id}`, name: 'resume_step', args: { step: step.title }, reason });
        let allowed = false;
        try {
          allowed = await approve({ id: `resume:${step.id}`, name: 'resume_step', args: { step: step.title }, reason }, signal);
        } catch {
          allowed = false;
        }
        if (signal.aborted) return { cancelled: true, ok: false, reason: 'Stopped by user.' };
        emit({ type: 'approval_result', id: `resume:${step.id}`, name: 'resume_step', allow: allowed });
        if (!allowed) {
          step.status = 'failed';
          step.error = 'Re-run after interruption was not confirmed.';
          step.endedAt = Date.now();
          persist(step);
          saveCheckpoint('running');
          return { ok: false, reason: step.error };
        }
      } else {
        emit({ type: 'status', text: reason });
      }
    }
    let attempt = 0;
    let feedback = '';
    let lastReason = '';
    while (attempt < MAX_ATTEMPTS_PER_STEP) {
      if (signal.aborted) return { cancelled: true, ok: false, reason: 'Stopped by user.' };
      attempt += 1;
      step.attempts += 1;
      const result = await runStepOnce(step, attempt, { feedback, parallel });
      if (result.cancelled) return result;
      if (result.ok) return result;
      lastReason = result.reason || 'step did not complete';
      if (attempt < MAX_ATTEMPTS_PER_STEP) {
        feedback = result.feedback || result.reason || '';
        emit({
          type: 'step_retry',
          idx: step.idx,
          id: step.id,
          attempt: attempt + 1,
          reason: lastReason,
          feedback: feedback.slice(0, 600),
        });
      }
    }
    step.status = 'failed';
    step.error = lastReason;
    step.endedAt = Date.now();
    persist(step);
    saveCheckpoint('running');
    emit({
      type: 'step_done',
      idx: step.idx,
      id: step.id,
      title: step.title,
      ok: false,
      summary: lastReason,
      attempts: attempt,
      ms: step.endedAt - (step.startedAt || step.endedAt),
      parallel,
    });
    return { ok: false, reason: lastReason };
  }

  async function replan(failedStep) {
    if (state.replans >= MAX_REPLANS) return false;
    state.replans += 1;
    const remaining = state.plan.filter((s) => s.status !== 'done' && s.status !== 'replaced');
    emit({ type: 'status', text: `Replanning after “${failedStep.title}” could not be completed…` });
    let raw = null;
    try {
      raw = await requestPlan({ mode: 'replan', failed: failedStep, remaining });
    } catch (err) {
      if (err && err.name === 'AbortError') return false;
      emit({ type: 'status', text: `Replan failed: ${err && err.message ? err.message : String(err)}` });
      return false;
    }
    const fresh = normalizePlan(raw, {
      startIdx: state.nextIdx,
      existingIds: new Set(state.plan.map((s) => s.id)),
    });
    if (!fresh.length) {
      emit({ type: 'status', text: 'The planner returned no usable replacement steps.' });
      return false;
    }
    for (const step of remaining) {
      step.status = 'replaced';
      step.error = step.error || `Replaced while replanning after ${failedStep.title}.`;
      persist(step);
    }
    state.plan = orderPlan([...state.plan, ...fresh]);
    state.nextIdx += fresh.length;
    for (const step of fresh) persist(step);
    saveCheckpoint('running');
    emit({
      type: 'plan_revised',
      reason: failedStep.error || failedStep.title,
      plan: planView(),
      replans: state.replans,
    });
    return true;
  }

  emit({
    type: 'run_start',
    mode: 'orchestrator',
    goal: state.goal,
    model: primary.model,
    provider: primary.name || primary.id,
    candidates: chain.map((c) => ({ id: c.id, name: c.name, model: c.model })),
    localModel: local && local.model ? local.model : null,
    maxSteps: perStep,
    resumed: resuming,
    plan: planView(),
  });

  if (!resuming) {
    emit({ type: 'status', text: 'Planning the goal…' });
    let raw = null;
    try {
      raw = await requestPlan({ mode: 'plan' });
    } catch (err) {
      if (err && err.name === 'AbortError') return finish({ ok: false, cancelled: true, summary: 'Stopped by user.' });
      const message = err && err.message ? err.message : String(err);
      emit({ type: 'status', text: `Planner failed (${message}). Running the goal as a single step.` });
      raw = {
        steps: [
          {
            id: 's1',
            title: 'Do the goal',
            goal: state.goal,
            dependsOn: [],
            readOnly: false,
            parallelGroup: 0,
            validate: 'The overall goal is achieved with real evidence from the tools.',
          },
        ],
      };
    }
    state.plan = normalizePlan(raw, { startIdx: 0 });
    if (!state.plan.length) return finish({ ok: false, summary: 'The planner returned no usable steps.' });
    state.plan = orderPlan(state.plan);
    state.nextIdx = state.plan.length;
    for (const step of state.plan) persist(step);
    saveCheckpoint('running');
    emit({ type: 'plan_created', plan: planView(), replanned: false });
  } else {
    const pending = state.plan.filter((s) => s.status !== 'done' && s.status !== 'replaced' && s.status !== 'skipped');
    emit({
      type: 'status',
      text: `Resuming run — ${state.plan.filter((s) => s.status === 'done').length} step(s) already done, ${pending.length} to go.`,
    });
    emit({ type: 'plan_created', plan: planView(), replanned: true, resumed: true });
    for (const step of state.plan) persist(step);
  }

  let pos = 0;
  while (pos < state.plan.length) {
    if (signal.aborted) return finish({ ok: false, cancelled: true, summary: 'Stopped by user.' });
    if (Date.now() - started > MAX_ORCH_MS) {
      return finish({
        ok: false,
        summary: `Orchestrator time budget (${Math.round(MAX_ORCH_MS / 60000)} min) reached with ${pos}/${state.plan.length} steps handled.`,
      });
    }

    const group = collectGroup(state.plan, pos);
    if (!group.steps.length) break;

    const pending = group.steps.filter((s) => s.status !== 'done' && s.status !== 'replaced' && s.status !== 'skipped');
    if (pending.length) {
      for (const step of pending) {
        const missing = step.dependsOn
          .map((id) => state.plan.find((s) => s.id === id))
          .find((d) => d && d.status !== 'done');
        if (missing) {
          step.status = 'skipped';
          step.error = `Dependency “${missing.title}” did not complete.`;
          step.endedAt = Date.now();
          persist(step);
          emit({
            type: 'step_done',
            idx: step.idx,
            id: step.id,
            title: step.title,
            ok: false,
            skipped: true,
            summary: step.error,
            attempts: 0,
            ms: 0,
            parallel: group.parallel,
          });
        }
      }
      const runnable = pending.filter((s) => s.status === 'running' || s.status === 'pending' || s.status === 'interrupted');
      executed += runnable.length;

      if (group.parallel && runnable.length > 1) {
        const results = await Promise.all(runnable.map((step) => executeWithRetries(step, { parallel: true })));
        if (results.some((r) => r && r.cancelled)) {
          return finish({ ok: false, cancelled: true, summary: 'Stopped by user.' });
        }
        const failedStep = runnable.find((s) => s.status === 'failed');
        if (failedStep) {
          const replanned = await replan(failedStep);
          if (!replanned) {
            return finish({
              ok: false,
              summary: `Step “${failedStep.title}” failed: ${failedStep.error || 'unknown error'}`,
            });
          }
        }
      } else {
        for (const step of runnable) {
          if (step.status === 'done' || step.status === 'replaced') continue;
          const result = await executeWithRetries(step, { parallel: false });
          if (result.cancelled) return finish({ ok: false, cancelled: true, summary: 'Stopped by user.' });
          if (!result.ok) {
            const replanned = await replan(step);
            if (!replanned) {
              return finish({
                ok: false,
                summary: `Step “${step.title}” failed: ${step.error || result.reason || 'unknown error'}`,
              });
            }
            break;
          }
        }
      }
    }
    pos += group.steps.length;
  }

  const doneCount = state.plan.filter((s) => s.status === 'done').length;
  const failed = state.plan.filter((s) => s.status === 'failed');
  const skipped = state.plan.filter((s) => s.status === 'skipped');
  if (failed.length || skipped.length) {
    return finish({
      ok: false,
      summary: `${doneCount} of ${state.plan.length} steps verified. ${
        failed.length ? `Failed: ${failed.map((s) => s.title).join(', ')}. ` : ''
      }${skipped.length ? `Skipped: ${skipped.map((s) => s.title).join(', ')}.` : ''}`.trim(),
    });
  }
  return finish({
    ok: true,
    summary: `Plan complete — ${doneCount} step(s) executed and verified:\n${state.plan
      .filter((s) => s.status === 'done')
      .map((s, i) => `${i + 1}. ${s.title}`)
      .join('\n')}`,
  });
}

module.exports = { runOrchestrator, MAX_PLAN_STEPS, MAX_ATTEMPTS_PER_STEP, MAX_REPLANS };
