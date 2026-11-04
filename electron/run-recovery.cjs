'use strict';

/**
 * Pure helpers for resuming a checkpointed plan after an unclean shutdown.
 * Kept free of Electron and vault access so they can be unit tested; the
 * caller hydrates the provider with its stored key.
 */

function text(value, max) {
  const s = String(value == null ? '' : value);
  return s.length > max ? s.slice(0, max) : s;
}

function sanitizeProvider(provider) {
  if (!provider || typeof provider !== 'object') return null;
  const baseUrl = text(provider.baseUrl, 400).trim();
  const model = text(provider.model, 200).trim();
  if (!baseUrl || !model) return null;
  return {
    id: text(provider.id || provider.presetId, 80) || undefined,
    presetId: text(provider.presetId, 80) || undefined,
    name: text(provider.name, 120) || undefined,
    baseUrl,
    api: text(provider.api, 40) || 'openai',
    model,
  };
}

/** Provider descriptor captured in a checkpoint, or null when it cannot drive a run. */
function providerFromCheckpoint(checkpoint) {
  return sanitizeProvider(checkpoint && checkpoint.provider);
}

function candidatesFromCheckpoint(checkpoint) {
  const list = checkpoint && Array.isArray(checkpoint.candidates) ? checkpoint.candidates : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const candidate = sanitizeProvider(raw);
    if (!candidate) continue;
    const key = `${candidate.baseUrl}|${candidate.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

/**
 * The newest interrupted plan that is safe to continue: it was actively
 * running (not paused by the user), has a saved plan, and captured enough
 * provider detail to make model calls without the renderer.
 */
function autoResumeTarget(runs) {
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || run.status !== 'interrupted') continue;
    const checkpoint = run.checkpoint;
    if (!checkpoint || checkpoint.mode !== 'orchestrator') continue;
    if (checkpoint.status !== 'running') continue;
    if (!Array.isArray(checkpoint.plan) || !checkpoint.plan.length) continue;
    if (!String(run.goal || checkpoint.goal || '').trim()) continue;
    const provider = providerFromCheckpoint(checkpoint);
    if (!provider) continue;
    return {
      runId: String(run.id),
      goal: String(run.goal || checkpoint.goal || '').slice(0, 4000),
      provider,
      candidates: candidatesFromCheckpoint(checkpoint),
      task: text(checkpoint.task, 40) || 'agent',
    };
  }
  return null;
}

module.exports = { sanitizeProvider, providerFromCheckpoint, candidatesFromCheckpoint, autoResumeTarget };
