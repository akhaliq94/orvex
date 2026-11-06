'use strict';

/**
 * Self-driving agent loop.
 * Cloud model decides, local model compresses long tool output (hybrid), tools
 * run in the main process with guardrails, every step is emitted to the renderer.
 */

const { definitions, runTool, audit, approvalReason, escalationReason, unattendedDenial, coerceArgs } = require('./tools.cjs');
const permissions = require('./permissions.cjs');
const security = require('./security.cjs');
const gateway = require('./model-gateway.cjs');
const planTodos = require('./plan-todos.cjs');
const approvalAdvisor = require('./approval-advisor.cjs');
const fs = require('node:fs');

const MAX_STEPS = 60;
const MAX_RUN_MS = 45 * 60 * 1000;
const MAX_RESULT_CHARS = 8000;
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;

const SYSTEM_PROMPT = `You are ORVEX, an autonomous agent running inside the user's desktop app on their own computer.
You can actually use the machine through tools: read/list/write files, search folders, run shell commands, open apps and URLs, read system info, drive a real Chrome/Edge window, capture the screen, control the real mouse and keyboard, and search or read the web.

Rules:
- Act, don't ask for permission for normal steps.
- A few risky actions (deleting files, installers, installs, git push, the registry) may be shown to the user for a quick yes/no before they run. In full-auto they are approved automatically. If the answer is no, do not retry — take a safer route or stop and explain.
- Never touch system folders, password stores or private keys — those are hard-blocked and will return an error.
- Never handle money, payments or account passwords.
- Read before you write. Do not overwrite a file unless the goal requires it.
- Prefer the smallest command that works. Windows shell is cmd.exe.
- Fastest web path: when the goal is "open <site> and search <x>" or "play <x>", call browser_task ONCE with site + query (action=play_first to click the first video, action=search otherwise). It opens the real browser itself. Never use app_launch, app_list or window_list for a website — those start a window you cannot control and waste steps.
- For anything else that needs clicking, typing or reading inside a website (forms, logins, multi-page flows), use browser_open first, then work from the numbered [ids] in the snapshot and re-snapshot after every change. Keep the run short: one tool call per obvious step, no exploratory window_list/screen_capture for web goals.
- For normal desktop apps that have no browser/element ids (Notepad, Explorer, Paint, installers), drive the real screen: screen_capture, then mouse_click / key_type / key_press using the screenshot's pixel coordinates, and screen_capture again to verify. Focus the target window before typing.
- Prefer UI Automation over blind clicking: window_list to find the window, ui_tree to see controls with their names and element paths, then ui_action (invoke, set_value, toggle, select, expand, focus, scroll, click). Re-read the tree after actions that change the window. ui_action refuses a disabled or off-screen target, highlights what it is about to touch, and reports verified / visibly changed / NOT confirmed — when it is NOT confirmed, capture the screen and re-check instead of assuming success. Fall back to pixel clicking only when UIA does not expose the control.
- For a window that is still loading, use ui_wait (exists/gone/enabled/value) instead of sleep loops or repeated screenshots. For a known multi-field form, use ui_sequence so every step is verified and the first failure stops the rest.
- Use window_action to focus/minimize/maximize/restore/close windows, mouse_scroll for the wheel, and mouse_drag for sliders and selections. process_list shows running apps; process_kill stops one (it needs approval and core Windows processes are refused).
- Use screen_ocr to read text that is not exposed through UI Automation (canvas apps, images, video), and clipboard_read / clipboard_write to move text the user copied.
- screen_info lists displays and their origins; on multi-monitor setups add a display's origin to the image pixels before clicking. screen_capture all:true captures every display, and region:{x,y,width,height} crops.
- screen_record_start / screen_record_stop make a real .webm video of a display; always stop the recording when the task is done.
- Screenshots from screen_capture and browser_screenshot are attached to your next message as real images. Look at the picture before clicking; never invent what is on screen.
- When a goal needs current information (news, prices, docs, versions), use web_search and then web_fetch the most relevant result. Do not answer from memory when the answer may have changed.
- When a tool fails, read the error and try a different approach once, then explain the blocker.
- Delegate independent research or checking to a background sub-agent with delegate_start when you can keep working in parallel; call delegate_wait before you finish. Sub-agents cannot ask the user for approval, so they never perform risky actions.
- Sub-agent work is durable: delegate_queue lists earlier tasks, and delegate_resume re-runs one that was interrupted by a restart or failed. Resume only when the user wants that work completed.
- When the goal is done, reply with a short summary of what you actually did, with real paths and results. Never claim an action you did not perform.
- You have structured long-term memory shown below (ids like [M1] map to the Memory page). Recall more with memory_search before asking the user to repeat context; save durable facts with memory_append — one short line each, not task logs.
- If the goal is impossible with these tools, say so plainly and stop.`;

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

/** Turn the payload's provider(s) into an ordered fallback chain for the gateway. */
function candidatesFor(provider, candidates) {
  const list = Array.isArray(candidates) && candidates.length ? candidates : [provider];
  return list
    .filter((c) => c && c.baseUrl && c.model)
    .map((c) => ({
      id: c.id || c.presetId || c.baseUrl,
      presetId: c.presetId || '',
      name: c.name || c.model,
      baseUrl: c.baseUrl,
      apiKey: c.apiKey || '',
      api: c.api || 'openai',
      model: c.model,
    }));
}

/** Open screenshots as images the model can actually see. JPEG keeps tokens low without moving pixels. */
function readImage(file) {
  const target = String(file || '');
  if (!target) return null;
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromPath(target);
    if (img && !img.isEmpty()) {
      const size = img.getSize();
      const jpeg = img.toJPEG(72);
      if (jpeg && jpeg.length && jpeg.length <= MAX_IMAGE_BYTES) {
        return { mime: 'image/jpeg', data: jpeg.toString('base64'), width: size.width, height: size.height, file: target };
      }
    }
  } catch {
    /* not running inside Electron — fall back to the raw file */
  }
  try {
    const buf = fs.readFileSync(target);
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
    const mime = buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : 'image/jpeg';
    return { mime, data: buf.toString('base64'), width: null, height: null, file: target };
  } catch {
    return null;
  }
}

/** Keep only the newest image messages in context so long runs do not balloon. */
function pruneImages(history, keep = 2) {
  let seen = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].images && history[i].images.length) {
      seen += 1;
      if (seen > keep) delete history[i].images;
    }
  }
}

/**
 * One model step through the shared gateway: retries on 429/5xx, provider
 * fallback, real token/cost accounting and circuit breakers all live there.
 */
async function callModel(candidates, { system, history, tools, signal, noImages, onWait, onEvent, onDelta, runId, task }) {
  const startedAt = Date.now();
  // A slow CPU model can sit here for minutes — say so instead of looking hung,
  // until the answer itself starts arriving.
  let ticker = onWait
    ? setInterval(() => {
        try {
          onWait(Math.round((Date.now() - startedAt) / 1000));
        } catch {
          /* renderer gone */
        }
      }, 20000)
    : null;
  const stopTicker = () => {
    if (!ticker) return;
    clearInterval(ticker);
    ticker = null;
  };
  const deltas = onDelta
    ? (delta, full) => {
        stopTicker();
        onDelta(delta, full);
      }
    : undefined;
  try {
    return await gateway.chat({
      candidates,
      task: task || 'agent',
      system,
      history,
      tools,
      signal,
      runId,
      noImages,
      temperature: 0.2,
      maxTokens: 2048,
      stream: !!onDelta,
      onDelta: deltas,
      onEvent,
    });
  } finally {
    stopTicker();
  }
}

/** Hybrid step: the local model shrinks long tool output before it reaches the cloud. */
async function condense(candidate, text, signal) {
  return await gateway.condense(candidate, String(text || '').slice(0, 16000), signal);
}

/**
 * Context manager: when a run's transcript grows past the budget, older steps
 * are compressed by the local/cheap model and replaced by one summary turn.
 * The cut always lands on a user turn so tool_call/tool_result pairs stay valid.
 */
async function compactHistory(chain, localCfg, history, signal, emit) {
  const estimated = gateway.estimateTokens(JSON.stringify(history));
  if (estimated < 24000 || history.length < 8) return;
  let cut = history.length - 4;
  while (cut > 0 && history[cut].role !== 'user') cut -= 1;
  if (cut <= 0) return;
  const old = history.slice(0, cut);
  const transcript = old
    .map((m) => {
      const tools = m.calls && m.calls.length ? ` (tools: ${m.calls.map((c) => c.name).join(', ')})` : '';
      return `${m.role}${tools}: ${String(m.text || m.content || '').slice(0, 500)}`;
    })
    .join('\n');
  try {
    const summary = await gateway.condense(localCfg || chain[0], transcript.slice(0, 20000), signal);
    history.splice(0, cut, { role: 'user', text: `Summary of earlier steps in this run:\n${summary}` });
    emit({ type: 'context_compacted', removed: old.length, kept: history.length, chars: transcript.length });
  } catch {
    /* keep the full history if summarising fails — correctness first */
  }
}

async function runAgent({ goal, provider, candidates, local, memory, emit, signal, gate, approve, maxSteps, autoApprove, runId, task, systemAppend, unattended = false, allowDelegation = true }) {
  const started = Date.now();
  const stepLimit = Math.min(Math.max(Number(maxSteps) || MAX_STEPS, 1), 200);
  const chain = candidatesFor(provider, candidates);
  if (!chain.length) throw new Error('No model configured for this run.');
  const primary = chain[0];
  let steps = 0;
  let localCfg = local && local.baseUrl && local.model ? local : null;
  if (localCfg && primary && localCfg.baseUrl === primary.baseUrl && localCfg.model === primary.model) localCfg = null;

  const memoryBlock =
    memory && memory.trim()
      ? `\n\nLong-term memory from earlier runs (may be stale — verify before relying on it):\n${memory.trim()}`
      : '';
  const roleBlock = systemAppend && String(systemAppend).trim() ? `\n\n${String(systemAppend).trim()}` : '';
  const system = SYSTEM_PROMPT + roleBlock + memoryBlock;
  const planPrompt = () => {
    try {
      return planTodos.prompt(runId);
    } catch {
      return planTodos.INSTRUCTIONS;
    }
  };

  const finish = (payload) => {
    const outcome = { ok: false, ms: Date.now() - started, steps, ...payload };
    if (outcome.summary) {
      const guarded = security.outputTripwire(outcome.summary);
      if (guarded.findings.length) {
        outcome.summary = guarded.text;
        outcome.guard = guarded.findings;
        emit({ type: 'guard', stage: 'output', findings: guarded.findings });
      }
    }
    emit({ type: 'run_end', ...outcome });
    return outcome;
  };

  const truncated = (text, max) => {
    const s = String(text ?? '');
    return s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} chars]` : s;
  };

  // Held while the user has paused the engine; resolves on resume or stop.
  const holdIfPaused = async () => {
    if (gate) await gate();
    return !signal.aborted;
  };

  emit({
    type: 'run_start',
    goal,
    model: primary.model,
    provider: primary.name || primary.id,
    candidates: chain.map((c) => ({ id: c.id, name: c.name, model: c.model })),
    localModel: localCfg ? localCfg.model : null,
    maxSteps: stepLimit,
  });

  const history = [{ role: 'user', text: String(goal) }];
  let attachImages = true;

  for (let step = 1; step <= stepLimit; step += 1) {
    steps = step;
    if (!(await holdIfPaused())) {
      return finish({ ok: false, cancelled: true, summary: 'Stopped by user.' });
    }

    const elapsed = Date.now() - started;
    if (elapsed > MAX_RUN_MS) {
      return finish({
        ok: false,
        summary: `Time budget (${Math.round(MAX_RUN_MS / 60000)} min) reached after ${steps} steps — goal not confirmed complete.`,
      });
    }

    emit({
      type: 'status',
      text: step === 1 ? 'Planning the task…' : `Thinking — step ${step} of ${stepLimit} · ${Math.round(elapsed / 60000)} min`,
    });

    await compactHistory(chain, localCfg, history, signal, emit);

    let reply;
    let retriedWithoutImages = false;
    let retriedWithoutStream = false;
    let sawDelta = false;
    for (;;) {
      sawDelta = false;
      try {
        reply = await callModel(chain, {
          system: `${system}\n\n${planPrompt()}`,
          history,
          tools: definitions,
          signal,
          noImages: !attachImages,
          runId,
          task,
          onWait: (secs) => emit({ type: 'status', text: `${primary.name || primary.model} is still working — ${secs}s` }),
          // The answer is shown and spoken while it is still being written, so
          // nothing unguarded is ever put in front of the user.
          onDelta: retriedWithoutStream
            ? undefined
            : (_delta, full) => {
                sawDelta = true;
                emit({ type: 'answer_delta', text: security.outputTripwire(full).text });
              },
          onEvent: (e) => {
            if (!e) return;
            if (e.type === 'model_retry') {
              emit({ type: 'status', text: `${e.provider || primary.name || primary.model} hit a temporary error — retrying (${e.attempt || 1}/${e.maxAttempts || 2})` });
            } else if (e.type === 'model_fallback') {
              emit({ type: 'status', text: `Failing over to ${e.next || 'the next model'}` });
            } else if (e.type === 'model_error') {
              emit({ type: 'status', text: `${e.provider || 'Model'} error: ${e.message || e.reason || 'failed'}` });
            } else if (e.type === 'budget_exceeded') {
              emit({
                type: 'status',
                text: `Budget reached — $${Number(e.spent || 0).toFixed(2)} spent of $${Number(e.budget || 0).toFixed(2)}. Paid models are paused; a local model keeps this run going, or raise the limit in Settings → Usage.`,
              });
            }
          },
        });
        break;
      } catch (err) {
        if (err && err.name === 'AbortError') {
          return finish({ ok: false, cancelled: true, summary: 'Stopped by user.' });
        }
        const message = err && err.message ? err.message : String(err);
        // Streaming is what makes an answer arrive early, but a provider that
        // cannot hold an open stream must still get asked for the reply.
        if (!retriedWithoutStream && !sawDelta && /stream/i.test(message)) {
          retriedWithoutStream = true;
          emit({ type: 'status', text: `${primary.name || primary.model} does not stream its answer — asking for the whole reply instead.` });
          continue;
        }
        if (attachImages && !retriedWithoutImages && /image|vision|multimodal/i.test(message)) {
          attachImages = false;
          retriedWithoutImages = true;
          emit({ type: 'status', text: 'This model cannot read images — continuing without screenshots.' });
          continue;
        }
        audit({ kind: 'agent_error', error: message.slice(0, 500), steps });
        emit({ type: 'error', message });
        return finish({ ok: false, summary: `Model call failed: ${message}` });
      }
    }

    if (reply.text) {
      const guarded = security.outputTripwire(reply.text);
      if (guarded.findings.length) emit({ type: 'guard', stage: 'output', findings: guarded.findings });
      emit({ type: 'assistant', text: guarded.text });
    }

    if (!reply.calls.length) {
      const summary = reply.text || 'Task finished with no output.';
      history.push({ role: 'assistant', text: summary, calls: [] });
      return finish({ ok: true, summary });
    }

    history.push({ role: 'assistant', text: reply.text, calls: reply.calls });

    const shots = [];
    for (const call of reply.calls) {
      if (!(await holdIfPaused())) {
        return finish({ ok: false, cancelled: true, summary: 'Stopped by user.' });
      }
      const typed = coerceArgs(call.name, call.args);
      if (typed.repairs.length) {
        call.args = typed.args;
        audit({ kind: 'tool-args-coerced', tool: call.name, args: JSON.stringify({ repaired: typed.repairs }), ok: true, runId: runId || null });
      }
      emit({ type: 'tool_start', id: call.id, name: call.name, args: call.args });

      // Approval floors are checked before the approval gate so auto-approve
      // and full-auto can never skip them.
      const floor = permissions.floorReason(call.name, call.args);
      if (floor) {
        audit({ kind: 'tool-floor', tool: call.name, args: truncated(JSON.stringify(call.args || {}), 400), ok: false, runId: runId || null });
        history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: `ERROR: ${floor}` });
        emit({ type: 'tool_result', id: call.id, name: call.name, ok: false, output: '', error: floor, ms: 0 });
        continue;
      }

      const risk = approvalReason(call.name, call.args);
      const escalation = escalationReason(call.name, call.args);
      if (escalation) {
        audit({ kind: 'tool-escalated', tool: call.name, args: truncated(JSON.stringify(call.args || {}), 400), ok: false, runId: runId || null });
      }
      const approval = approvalAdvisor.approvalMode({ risk, escalation, autoApprove });
      if (approval && unattended) {
        const why = escalation ? escalation.reason : risk;
        const content = `ERROR: Background sub-agents cannot ask the user for approval, so "${call.name}" was refused (${why}). Use a non-risky tool or report what the parent should do.`;
        audit({ kind: 'tool-unattended-denied', tool: call.name, args: truncated(JSON.stringify(call.args || {}), 400), ok: false, runId: runId || null });
        history.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
        emit({ type: 'tool_result', id: call.id, name: call.name, ok: false, output: '', error: content, ms: 0 });
        continue;
      }
      if (approval && approve) {
        const reason = escalation ? escalation.reason : risk;
        emit({ type: 'approval_request', id: call.id, name: call.name, args: call.args, reason });
        let allowed = false;
        if (approval === 'auto') {
          allowed = true;
          emit({ type: 'approval_result', id: call.id, name: call.name, allow: true, auto: true });
          audit({ kind: 'approval', tool: call.name, args: truncated(JSON.stringify(call.args || {}), 400), ok: true, auto: true });
        } else {
          try {
            allowed = await approve({ id: call.id, name: call.name, args: call.args, reason }, signal);
          } catch {
            allowed = false;
          }
          if (signal.aborted) {
            return finish({ ok: false, cancelled: true, summary: 'Stopped by user.' });
          }
          emit({ type: 'approval_result', id: call.id, name: call.name, allow: allowed });
          audit({ kind: 'approval', tool: call.name, args: truncated(JSON.stringify(call.args || {}), 400), ok: allowed });
        }
        if (!allowed) {
          const content = `ERROR: The user declined this action (${reason}) or did not answer. Do not attempt it again; pick a safe alternative or explain the blocker.`;
          history.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
          emit({
            type: 'tool_result',
            id: call.id,
            name: call.name,
            ok: false,
            output: '',
            error: 'Declined by the user — action not run.',
            ms: 0,
          });
          continue;
        }
      }

      // A pause or stop that arrived while the approval prompt was open must
      // win before the tool actually touches the machine.
      if (!(await holdIfPaused())) {
        return finish({ ok: false, cancelled: true, summary: 'Stopped while waiting for approval.' });
      }

      const result = await runTool(call.name, call.args, {
        runId: runId || `run_${started}`,
        candidates: chain,
        signal,
        emit,
        autoApprove: autoApprove === true,
        allowDelegation,
        unattended,
      });
      if (signal.aborted) {
        return finish({ ok: false, cancelled: true, summary: 'Stopped by user.' });
      }
      let content = result.ok ? result.output || '(empty)' : `ERROR: ${result.error}`;
      if (localCfg && content.length > 3200) {
        try {
          const short = await condense(localCfg, content, signal);
          if (short && short.length < content.length) {
            emit({ type: 'compact', model: localCfg.model, chars: content.length, to: short.length });
            content = short;
          }
        } catch {
          /* keep the full output if the local model is down */
        }
      }
      history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: truncated(content, MAX_RESULT_CHARS) });
      if (result.ok && result.image) {
        const shot = attachImages ? readImage(result.image) : null;
        if (shot) shots.push(shot);
      }
      emit({
        type: 'tool_result',
        id: call.id,
        name: call.name,
        ok: result.ok,
        output: truncated(content, 1500),
        error: result.error,
        ms: result.ms,
      });
    }

    if (shots.length) {
      history.push({
        role: 'user',
        text: shots
          .map((s) => `Attached: ${s.file}${s.width ? ` (${s.width}x${s.height} screen pixels — mouse_click uses the same pixels)` : ''}`)
          .join('\n'),
        images: shots,
      });
      pruneImages(history, 2);
    }
  }

  return finish({ ok: false, summary: `Step limit (${stepLimit}) reached — goal not confirmed complete.` });
}

module.exports = { runAgent, MAX_STEPS, MAX_RUN_MS };
