'use strict';

/**
 * One gateway for every model call: task routing candidates, retries with
 * backoff, provider fallback, circuit breakers, streaming, structured output,
 * token accounting and cost estimation. The agent and the chat UI both go
 * through here so usage numbers are always real.
 */

const db = require('./db.cjs');
const pricing = require('./pricing.cjs');
const { StreamWatchdog } = require('./stream-watchdog.cjs');

const HOSTED_TIMEOUT_MS = 180 * 1000;
const LOCAL_TIMEOUT_MS = 10 * 60 * 1000;
const HOSTED_STALL_MS = 75 * 1000;
const LOCAL_STALL_MS = 150 * 1000;
const MAX_ATTEMPTS = 2;
const MAX_FALLBACKS = 4;
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524, 529]);
const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 60 * 1000;

/** Optional observer for measured outcomes; used by adaptive routing. */
let routeObserver = null;
function setRouteObserver(fn) {
  routeObserver = typeof fn === 'function' ? fn : null;
}

const AjvMod = require('ajv');
const Ajv = AjvMod.Ajv || AjvMod.default || AjvMod;
const ajv = new Ajv({ allErrors: true, strict: false });

class ModelError extends Error {
  // The 400-shaped hints below are what let chat() retry a provider that
  // refuses stream_options or max_completion_tokens instead of failing the run.
  constructor(
    message,
    { status = 0, retryable = false, detail = '', retryAfter = 0, streamOptions = false, maxTokens = false } = {},
  ) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
    this.retryable = retryable;
    this.detail = detail;
    this.retryAfter = retryAfter;
    this.streamOptions = streamOptions;
    this.maxTokens = maxTokens;
  }
}

function isLocal(cfg) {
  return pricing.isLocalUrl(cfg && cfg.baseUrl) || /ollama|lm ?studio|llama\.cpp|local/i.test(String((cfg && cfg.name) || ''));
}

function candidateKey(c) {
  return String(c.id || c.presetId || c.baseUrl || '') + '|' + String(c.model || '');
}

function normalizeCandidates(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || !raw.baseUrl || !raw.model) continue;
    const c = {
      id: raw.id || raw.presetId || raw.baseUrl,
      presetId: raw.presetId || raw.id || '',
      name: raw.name || raw.model,
      baseUrl: String(raw.baseUrl).replace(/\/+$/, ''),
      apiKey: raw.apiKey || '',
      api: raw.api === 'anthropic' ? 'anthropic' : 'openai',
      model: String(raw.model),
    };
    const key = candidateKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function toOpenAIMessages(system, history, opts = {}) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of history || []) {
    if (m.role === 'user' || m.role === 'system') {
      const imgs = !opts.noImages && Array.isArray(m.images) ? m.images : [];
      if (!imgs.length) {
        out.push({ role: m.role, content: m.text });
      } else {
        const parts = [];
        if (m.text) parts.push({ type: 'text', text: m.text });
        for (const img of imgs) parts.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } });
        out.push({ role: m.role, content: parts });
      }
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.text || null };
      if (m.calls && m.calls.length) {
        msg.tool_calls = m.calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId || m.id, content: m.content });
    }
  }
  return out;
}

function toAnthropicMessages(history, opts = {}) {
  const out = [];
  const src = history || [];
  for (let i = 0; i < src.length; i += 1) {
    const m = src[i];
    if (m.role === 'user') {
      const blocks = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      if (!opts.noImages) {
        for (const img of m.images || []) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } });
        }
      }
      out.push({ role: 'user', content: blocks.length ? blocks : m.text || '' });
    } else if (m.role === 'assistant') {
      const blocks = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      for (const c of m.calls || []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} });
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      const blocks = [];
      while (i < src.length && src[i].role === 'tool') {
        blocks.push({ type: 'tool_result', tool_use_id: src[i].toolCallId || src[i].id, content: src[i].content });
        i += 1;
      }
      i -= 1;
      out.push({ role: 'user', content: blocks });
    }
  }
  return out;
}

function openAITools(defs) {
  return (defs || []).map((d) => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.parameters },
  }));
}

function anthropicTools(defs) {
  return (defs || []).map((d) => ({ name: d.name, description: d.description, input_schema: d.parameters }));
}

function reasoningModel(model) {
  return /^(o1|o3|o4)/i.test(String(model || ''));
}

/** Ollama's OpenAI layer exposes qwen3/deepseek-r1 thinking; it can be dialled down. */
function ollamaThinking(model) {
  return /qwen3|deepseek-r1|qwq|gpt-oss|magistral/i.test(String(model || ''));
}

function requestFor(candidate, opts, stream) {
  const isAnthropic = candidate.api === 'anthropic';
  const headers = { 'content-type': 'application/json' };
  if (isAnthropic) {
    if (candidate.apiKey) headers['x-api-key'] = candidate.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (candidate.apiKey) {
    headers.authorization = `Bearer ${candidate.apiKey}`;
  }

  const maxTokens = Math.max(1, Math.min(Number(opts.maxTokens) || 2048, 32000));
  const schemaNote = opts.jsonSchema
    ? '\n\nRespond with a single JSON value only — no markdown fences, no prose before or after it. It must match this JSON Schema exactly:\n' +
      JSON.stringify(opts.jsonSchema)
    : '';

  if (isAnthropic) {
    const body = {
      model: candidate.model,
      max_tokens: maxTokens,
      temperature: opts.temperature === undefined ? 0.7 : Number(opts.temperature),
      messages: toAnthropicMessages(opts.history, { noImages: opts.noImages }),
      ...(opts.system ? { system: String(opts.system) + schemaNote } : schemaNote ? { system: schemaNote.trim() } : {}),
      ...(opts.tools && opts.tools.length ? { tools: anthropicTools(opts.tools) } : {}),
      ...(stream ? { stream: true } : {}),
    };
    return { url: `${candidate.baseUrl}/messages`, headers, body };
  }

  let responseFormat;
  if (opts.jsonSchema) {
    const host = candidate.baseUrl.toLowerCase();
    if (host.includes('openai.com') || host.includes('openrouter.ai')) {
      responseFormat = { type: 'json_schema', json_schema: { name: 'orvex_output', schema: opts.jsonSchema, strict: true } };
    } else {
      responseFormat = { type: 'json_object' };
    }
  }

  const body = {
    model: candidate.model,
    messages: toOpenAIMessages(opts.system ? String(opts.system) + schemaNote : schemaNote ? schemaNote.trim() : '', opts.history, {
      noImages: opts.noImages,
    }),
    ...(opts.tools && opts.tools.length ? { tools: openAITools(opts.tools), tool_choice: opts.toolChoice || 'auto' } : {}),
    ...(reasoningModel(candidate.model) && !opts._legacyMaxTokens
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens, temperature: opts.temperature === undefined ? 0.7 : Number(opts.temperature) }),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(stream && !opts._noStreamOptions ? { stream: true, stream_options: { include_usage: true } } : stream ? { stream: true } : {}),
    ...(isLocal(candidate) && ollamaThinking(candidate.model) && opts.thinking !== true ? { reasoning_effort: 'none' } : {}),
    ...(candidate.baseUrl.includes('openrouter.ai') ? { usage: { include: true } } : {}),
  };
  return { url: `${candidate.baseUrl}/chat/completions`, headers, body };
}

function parseRetryAfter(res) {
  const raw = res.headers.get('retry-after');
  if (!raw) return 0;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs * 1000, 0), 15000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), 15000) : 0;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function friendly(status, text) {
  const detail = String(text || '').slice(0, 400);
  if (status === 401 || status === 403) return `the API key was rejected (${status}) — check this provider's key in Settings`;
  if (status === 402) return 'the account is out of credits (402) — top up or switch provider';
  if (status === 404) return `model not found (404) — the provider does not serve this model id`;
  if (status === 429) return 'rate-limited upstream (429) — retrying, then failing over to the next model';
  if (status === 503) return 'the provider has no healthy upstream right now (503)';
  if (status >= 500) return `provider error ${status}`;
  if (status === 400) return `the provider rejected the request (400) — ${detail.slice(0, 160)}`;
  return `HTTP ${status} — ${detail.slice(0, 160)}`;
}

/**
 * One HTTP attempt against one provider/model.
 * Returns { text, calls, usage, model } or throws ModelError.
 */
async function attempt(candidate, opts, signal, hooks) {
  if (signal && signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
  const stream = opts.stream === true;
  const { url, headers, body } = requestFor(candidate, opts, stream);
  const timeoutMs = isLocal(candidate) ? LOCAL_TIMEOUT_MS : HOSTED_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
  } catch (err) {
    if (signal && signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    if (controller.signal.aborted) {
      throw new ModelError(
        isLocal(candidate)
          ? `${candidate.name} did not answer within ${Math.round(timeoutMs / 60000)} min (local models are slow on CPU).`
          : `${candidate.name} did not answer within ${Math.round(timeoutMs / 1000)}s.`,
        { retryable: true },
      );
    }
    throw new ModelError(`${candidate.name}: network error — ${err && err.message ? err.message : String(err)}`, {
      retryable: true,
      detail: err && err.message ? err.message : '',
    });
  } finally {
    // Streaming keeps both the timeout and the user's abort wired to the body
    // reader; they are cleared when the stream ends instead.
    if (!stream) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    const retryable = RETRYABLE_STATUS.has(res.status);
    throw new ModelError(`${candidate.name}: ${friendly(res.status, text)}`, {
      status: res.status,
      retryable,
      detail: text.slice(0, 600),
      retryAfter: parseRetryAfter(res),
      streamOptions: res.status === 400 && /stream_options/i.test(text),
      maxTokens: res.status === 400 && /max_completion_tokens|max_tokens/i.test(text),
    });
  }

  if (!stream) {
    const data = await res.json().catch(() => null);
    if (!data) throw new ModelError(`${candidate.name}: the provider returned invalid JSON.`, { retryable: true });
    return parseNonStream(candidate, data);
  }

  if (!res.body) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    throw new ModelError(`${candidate.name}: the response had no stream body.`, { retryable: true });
  }

  const reader = res.body.getReader();
  const stallMs = isLocal(candidate) ? LOCAL_STALL_MS : HOSTED_STALL_MS;
  const watchdog = new StreamWatchdog({
    windowMs: stallMs,
    onStall: () => {
      hooks?.onStall?.(stallMs);
      controller.abort();
    },
  });
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let reasoning = '';
  let text = '';
  let usageRaw = null;
  let calls = [];
  let first = true;
  let terminal = false;

  const handleEvent = (json) => {
    if (candidate.api === 'anthropic') {
      if (json.type === 'message_start' && json.message && json.message.usage) usageRaw = { ...(usageRaw || {}), ...json.message.usage };
      if (json.type === 'message_delta' && json.usage) usageRaw = { ...(usageRaw || {}), ...json.usage };
      if (json.type === 'message_delta' && json.delta && json.delta.stop_reason) terminal = true;
      if (json.type === 'message_stop') terminal = true;
      if (json.type === 'content_block_start' && json.content_block && json.content_block.type === 'tool_use') {
        calls.push({ id: json.content_block.id, name: json.content_block.name, args: {} });
      }
      if (json.type === 'content_block_delta' && json.delta) {
        if (json.delta.type === 'text_delta' && json.delta.text) {
          if (first) {
            first = false;
            hooks.onFirstToken?.();
          }
          text += json.delta.text;
          hooks.onDelta?.(json.delta.text, text);
        }
        if (json.delta.type === 'input_json_delta' && calls.length) {
          const last = calls[calls.length - 1];
          last.raw = String(last.raw || '') + String(json.delta.partial_json || '');
        }
      }
      return;
    }
    if (json.usage) usageRaw = { ...(usageRaw || {}), ...json.usage };
    const choice = json.choices && json.choices[0];
    if (!choice) return;
    if (choice.finish_reason) terminal = true;
    const delta = choice.delta || {};
    const r = delta.reasoning || delta.reasoning_content || '';
    if (r) {
      reasoning += r;
      hooks.onReasoning?.(reasoning);
    }
    if (delta.content) {
      if (first) {
        first = false;
        hooks.onFirstToken?.();
      }
      text += delta.content;
      hooks.onDelta?.(delta.content, text);
    }
    for (const tc of delta.tool_calls || []) {
      const idx = Number.isInteger(tc.index) ? tc.index : calls.length;
      if (!calls[idx]) calls[idx] = { id: tc.id || `call_${Date.now()}_${idx}`, name: '', raw: '' };
      if (tc.id) calls[idx].id = tc.id;
      if (tc.function && tc.function.name) calls[idx].name = tc.function.name;
      if (tc.function && tc.function.arguments) calls[idx].raw = String(calls[idx].raw || '') + tc.function.arguments;
    }
  };

  const consume = (rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('event:') || line.startsWith(':')) return;
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      terminal = true;
      return;
    }
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    try {
      handleEvent(json);
    } catch {
      /* a malformed event must not kill the stream */
    }
  };

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      watchdog.progress();
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() || '';
      for (const rawLine of parts) consume(rawLine);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } catch (err) {
    if (signal && signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    if (watchdog.fired) {
      throw new ModelError(
        `${candidate.name}: the stream went silent for ${Math.round(stallMs / 1000)}s after it started answering — treating it as a stalled provider.`,
        { retryable: true },
      );
    }
    if (controller.signal.aborted) {
      throw new ModelError(
        isLocal(candidate)
          ? `${candidate.name} did not finish within ${Math.round(timeoutMs / 60000)} min (local models are slow on CPU).`
          : `${candidate.name} did not finish within ${Math.round(timeoutMs / 1000)}s.`,
        { retryable: true },
      );
    }
    throw new ModelError(`${candidate.name}: the stream broke before it finished — ${err && err.message ? err.message : String(err)}`, {
      retryable: true,
    });
  } finally {
    watchdog.finish();
    try {
      await reader.cancel();
    } catch {
      /* the socket is already closed */
    }
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!terminal) {
    throw new ModelError(`${candidate.name}: the stream ended before the response was complete.`, { retryable: true });
  }

  full = text;
  calls = calls
    .filter((c) => c && c.name)
    .map((c) => {
      let args = {};
      if (c.raw) {
        try {
          args = JSON.parse(c.raw);
        } catch {
          args = { _raw: c.raw };
        }
      }
      return { id: c.id, name: c.name, args };
    });

  return {
    text: full,
    calls,
    usage: normalizeUsage(usageRaw),
    model: candidate.model,
    // With streaming the provider may report usage in the final chunk; if not,
    // the caller estimates from characters and marks it estimated.
    streamed: true,
  };
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const prompt = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0) || 0;
  const completion = Number(raw.completion_tokens ?? raw.output_tokens ?? 0) || 0;
  const total = Number(raw.total_tokens ?? prompt + completion) || prompt + completion;
  const cost = raw.cost === undefined ? undefined : Number(raw.cost);
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total, cost };
}

function parseNonStream(candidate, data) {
  if (candidate.api === 'anthropic') {
    const blocks = Array.isArray(data.content) ? data.content : [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const calls = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
    return { text, calls, usage: normalizeUsage(data.usage), model: candidate.model, stop: data.stop_reason };
  }
  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  const text = typeof msg.content === 'string' ? msg.content.trim() : '';
  const calls = (msg.tool_calls || [])
    .map((c, i) => ({
      id: c.id || `call_${Date.now()}_${i}`,
      name: c.function && c.function.name,
      args: (() => {
        const raw = c.function && c.function.arguments;
        if (raw && typeof raw === 'object') return raw;
        try {
          return JSON.parse(raw || '{}');
        } catch {
          return { _raw: raw };
        }
      })(),
    }))
    .filter((c) => c.name);
  return { text, calls, usage: normalizeUsage(data.usage), model: candidate.model, stop: data.choices && data.choices[0] && data.choices[0].finish_reason };
}

function breakerOpen(candidate) {
  const row = db.healthGet(candidate.id, candidate.model);
  if (!row) return false;
  return Number(row.openedUntil || 0) > Date.now();
}

function breakerSuccess(candidate) {
  db.healthSet(candidate.id, candidate.model, { failures: 0, openedUntil: 0, lastError: null });
}

function breakerFailure(candidate, error) {
  const row = db.healthGet(candidate.id, candidate.model);
  const failures = Number((row && row.failures) || 0) + 1;
  const open = failures >= BREAKER_THRESHOLD;
  db.healthSet(candidate.id, candidate.model, {
    failures: open ? 0 : failures,
    openedUntil: open ? Date.now() + BREAKER_OPEN_MS : 0,
    lastError: String(error && error.message ? error.message : error).slice(0, 400),
  });
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function validateSchema(schema, text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, ''));
  } catch {
    return { ok: false, error: 'response was not valid JSON' };
  }
  try {
    const check = ajv.compile(schema);
    if (check(parsed)) return { ok: true, value: parsed };
    return { ok: false, error: ajv.errorsText(check.errors, { separator: '; ' }) };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

async function recordCall({ candidate, opts, result, startedAt, error }) {
  const usage = (result && result.usage) || null;
  const promptTokens = usage ? usage.promptTokens : error ? 0 : estimateTokens(JSON.stringify(opts.history || []));
  const completionTokens = usage ? usage.completionTokens : error ? 0 : estimateTokens(result && result.text);
  const totalTokens = usage ? usage.totalTokens : promptTokens + completionTokens;
  let cost = { costUsd: 0, estimated: true };
  if (!error) {
    try {
      cost = await pricing.costOf({
        candidate,
        model: candidate.model,
        promptTokens,
        completionTokens,
        rawUsage: usage && usage.cost !== undefined ? { cost: usage.cost } : null,
      });
    } catch {
      /* pricing is best-effort */
    }
  }
  db.recordUsage({
    runId: opts.runId || null,
    task: opts.task || null,
    providerId: candidate.id,
    providerName: candidate.name,
    model: candidate.model,
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd: cost.costUsd,
    estimated: !usage || cost.estimated,
    ms: Date.now() - startedAt,
    ok: !error,
    error: error ? String(error.message || error).slice(0, 400) : null,
  });
  try {
    if (routeObserver) {
      routeObserver({
        task: opts.task || null,
        providerId: candidate.id || candidate.presetId || null,
        model: candidate.model,
        ok: !error,
        ms: Date.now() - startedAt,
      });
    }
  } catch {
    /* an observer must never break a model call */
  }
  return { promptTokens, completionTokens, totalTokens, ...cost };
}

let budgetNotifiedFor = '';

/** Spend caps that are already used up, or null when calls may continue. */
function budgetOverrun() {
  try {
    const daily = Number(db.getSetting('budget.dailyUsd', 0)) || 0;
    const monthly = Number(db.getSetting('budget.monthlyUsd', 0)) || 0;
    if (daily <= 0 && monthly <= 0) return null;
    const nowDate = new Date();
    if (daily > 0) {
      const start = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
      const spent = db.usageCostSince(start);
      if (spent >= daily) return { scope: 'daily', spent, limit: daily };
    }
    if (monthly > 0) {
      const start = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).getTime();
      const spent = db.usageCostSince(start);
      if (spent >= monthly) return { scope: 'monthly', spent, limit: monthly };
    }
  } catch {
    /* a broken usage table must not brick every model call */
  }
  return null;
}

/** Warn once per day when the configured daily budget is exceeded. */
function checkBudget(opts) {
  try {
    const limit = Number(db.getSetting('budget.dailyUsd', 0)) || 0;
    if (limit <= 0) return;
    const nowDate = new Date();
    const day = nowDate.toISOString().slice(0, 10);
    if (budgetNotifiedFor === day) return;
    const startOfDay = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
    const spent = db.usageCostSince(startOfDay);
    if (spent <= limit) return;
    budgetNotifiedFor = day;
    opts.onEvent?.({ type: 'budget_exceeded', spent, budget: limit });
  } catch {
    /* budget guard must never break a call */
  }
}

/**
 * Main entry. Candidates are tried in order with retries on transient errors.
 * opts: { candidates, task, system, history, tools, toolChoice, jsonSchema,
 *         temperature, maxTokens, stream, signal, runId, noImages,
 *         onDelta, onReasoning, onFirstToken, onEvent }
 */
async function chat(opts) {
  const candidates = normalizeCandidates(opts.candidates);
  if (!candidates.length) {
    throw new ModelError('No model is configured. Add a provider in Settings → Providers, or pick a model for this task in Settings → Routing.', {
      retryable: false,
    });
  }

  let queue = candidates;
  const overrun = budgetOverrun();
  if (overrun) {
    opts.onEvent?.({ type: 'budget_exceeded', spent: overrun.spent, budget: overrun.limit, scope: overrun.scope, hardStop: true });
    // Local models cost nothing, so they stay usable. Paid candidates are
    // removed rather than silently spending past the cap.
    queue = candidates.filter((c) => isLocal(c));
    if (!queue.length) {
      const label = overrun.scope === 'monthly' ? 'monthly' : 'daily';
      throw new ModelError(
        `${label === 'monthly' ? 'Monthly' : 'Daily'} budget reached — $${Number(overrun.spent).toFixed(2)} of $${Number(overrun.limit).toFixed(2)} used. Raise the ${label} limit in Settings → Usage, or switch routing to a local model to keep working for free.`,
        { retryable: false },
      );
    }
  }

  const failures = [];
  let attemptsTotal = 0;
  queue = queue.slice(0, MAX_FALLBACKS);
  const allOpen = queue.every((c) => breakerOpen(c));
  if (allOpen) db.healthResetAll();

  for (let idx = 0; idx < queue.length; idx += 1) {
    const candidate = queue[idx];
    if (breakerOpen(candidate)) {
      failures.push({ candidate, reason: 'circuit open after repeated failures — skipped for 60s' });
      opts.onEvent?.({ type: 'model_fallback', provider: candidate.name, model: candidate.model, reason: 'circuit open' });
      continue;
    }

    let schemaTries = 0;
    let usedNoStreamOptions = false;
    let usedLegacyMaxTokens = false;
    const attemptOpts = { ...opts };
    for (let attemptNo = 1; attemptNo <= MAX_ATTEMPTS; attemptNo += 1) {
      attemptsTotal += 1;
      const startedAt = Date.now();
      try {
        let result = await attempt(candidate, attemptOpts, opts.signal, {
          onDelta: opts.onDelta,
          onReasoning: opts.onReasoning,
          onFirstToken: opts.onFirstToken,
          onStall: (windowMs) =>
            opts.onEvent?.({ type: 'model_stall', provider: candidate.name, model: candidate.model, windowMs }),
        });

        if (opts.jsonSchema) {
          const check = validateSchema(opts.jsonSchema, result.text);
          if (!check.ok) {
            schemaTries += 1;
            if (schemaTries <= 1) {
              // One corrective retry, with the validator's complaint in context.
              opts.onEvent?.({ type: 'model_retry', provider: candidate.name, model: candidate.model, reason: `structured output invalid: ${check.error}` });
              const correction = {
                role: 'user',
                text: `Your previous reply did not match the required JSON Schema (${check.error}). Reply again with ONLY valid JSON that matches it.`,
              };
              result = await attempt(
                candidate,
                { ...opts, history: [...(opts.history || []), { role: 'assistant', text: result.text }, correction] },
                opts.signal,
                {
                  onDelta: opts.onDelta,
                  onReasoning: opts.onReasoning,
                  onFirstToken: opts.onFirstToken,
                  onStall: (windowMs) =>
                    opts.onEvent?.({ type: 'model_stall', provider: candidate.name, model: candidate.model, windowMs }),
                },
              );
              const second = validateSchema(opts.jsonSchema, result.text);
              if (!second.ok) {
                throw new ModelError(`${candidate.name}: structured output still invalid — ${second.error}`, { retryable: false });
              }
              result.json = second.value;
            } else {
              throw new ModelError(`${candidate.name}: structured output invalid — ${check.error}`, { retryable: false });
            }
          } else {
            result.json = check.value;
          }
        }

        breakerSuccess(candidate);
        const usage = await recordCall({ candidate, opts, result, startedAt });
        checkBudget(opts);
        opts.onUsage?.({
          provider: candidate.name,
          providerId: candidate.id,
          model: candidate.model,
          task: opts.task || null,
          ...usage,
          ms: Date.now() - startedAt,
        });
        return {
          ...result,
          provider: { id: candidate.id, presetId: candidate.presetId, name: candidate.name, model: candidate.model },
          attempts: attemptsTotal,
          ms: Date.now() - startedAt,
          usage: { ...(result.usage || {}), ...usage },
        };
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        const message = err && err.message ? err.message : String(err);
        await recordCall({ candidate, opts, result: null, startedAt, error: err });

        // A provider that rejects optional fields gets one clean retry without them.
        if (err instanceof ModelError && err.streamOptions && opts.stream && !usedNoStreamOptions) {
          usedNoStreamOptions = true;
          attemptOpts._noStreamOptions = true;
          opts.onEvent?.({ type: 'model_retry', provider: candidate.name, model: candidate.model, reason: 'provider rejected stream_options — retrying without the usage stream' });
          attemptNo -= 1;
          continue;
        }
        if (err instanceof ModelError && err.maxTokens && !usedLegacyMaxTokens) {
          usedLegacyMaxTokens = true;
          attemptOpts._legacyMaxTokens = true;
          opts.onEvent?.({ type: 'model_retry', provider: candidate.name, model: candidate.model, reason: 'provider rejected max_completion_tokens — retrying with max_tokens' });
          attemptNo -= 1;
          continue;
        }

        const retryable = !(err instanceof ModelError) || err.retryable;
        failures.push({ candidate, reason: message, status: err && err.status });
        breakerFailure(candidate, err);
        opts.onEvent?.({ type: 'model_error', provider: candidate.name, model: candidate.model, status: err && err.status, message });

        if (retryable && attemptNo < MAX_ATTEMPTS) {
          const waitMs = (err && err.retryAfter) || Math.min(600 * 2 ** (attemptNo - 1) + Math.round(Math.random() * 250), 4000);
          opts.onEvent?.({ type: 'model_retry', provider: candidate.name, model: candidate.model, attempt: attemptNo, waitMs, reason: message });
          try {
            await sleep(waitMs, opts.signal);
          } catch {
            throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
          }
          continue;
        }
        break;
      }
    }

    if (idx < queue.length - 1) {
      const next = queue[idx + 1];
      opts.onEvent?.({
        type: 'model_fallback',
        provider: candidate.name,
        model: candidate.model,
        next: `${next.name} · ${next.model}`,
        reason: failures.length ? failures[failures.length - 1].reason : 'failed',
      });
    }
  }

  const summary = failures.length
    ? failures
        .slice(-3)
        .map((f) => `${f.candidate.name} · ${f.candidate.model}: ${f.reason}`)
        .join(' | ')
    : 'all candidates were skipped';
  const error = new ModelError(`Every model attempt failed (${attemptsTotal} tries). ${summary}`, { retryable: false });
  error.failures = failures.map((f) => ({ provider: f.candidate.name, model: f.candidate.model, reason: f.reason }));
  throw error;
}

/** Compress a long tool result with a cheap model (hybrid execution). */
async function condense(candidate, text, signal) {
  const result = await chat({
    candidates: [candidate],
    task: 'summarize',
    system:
      'You compress tool output for another AI. Keep every fact, path, number, error message and identifier that could matter for the next step. Drop boilerplate and repetition. Reply with the compressed text only, under 1200 characters.',
    history: [{ role: 'user', text: `Compress this tool output:\n\n${text}` }],
    maxTokens: 600,
    temperature: 0,
    signal,
  });
  return result.text.trim();
}

module.exports = {
  chat,
  _internals: { budgetOverrun },
  condense,
  estimateTokens,
  normalizeCandidates,
  isLocal,
  setRouteObserver,
  ModelError,
  MAX_ATTEMPTS,
  BREAKER_OPEN_MS,
};
