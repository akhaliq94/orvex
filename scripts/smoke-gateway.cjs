'use strict';

/**
 * Runtime smoke test for the model gateway + usage DB.
 * Run: ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/smoke-gateway.cjs
 * Uses a local fake provider, so it needs no API keys or network.
 */

const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const db = require(path.join(root, 'electron', 'db.cjs'));
const gateway = require(path.join(root, 'electron', 'model-gateway.cjs'));

const hits = { bad: 0, good: 0, badjson: 0 };

function body(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
  });
}

function serve() {
  const server = http.createServer(async (req, res) => {
    const payload = JSON.parse((await body(req)) || '{}');
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    if (payload.model === 'bad-model') {
      hits.bad += 1;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'no upstreams available' } }));
      return;
    }
    if (payload.model === 'bad-json') {
      hits.badjson += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'this is not json' } }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }));
      return;
    }
    hits.good += 1;
    if (payload.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"world"}}]}\n\n');
      res.write('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '{"answer":"ok"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-smoke-'));
  const ready = db.init({ file: path.join(dir, 'smoke.db') });
  assert.ok(ready, 'SQLite database must open');
  assert.strictEqual(db.info().ready, true);

  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const bad = { id: 'bad', name: 'Bad Provider', baseUrl: base, model: 'bad-model', api: 'openai' };
  const good = { id: 'good', name: 'Good Provider', baseUrl: base, model: 'good-model', api: 'openai' };
  const badJson = { id: 'badjson', name: 'Json Provider', baseUrl: base, model: 'bad-json', api: 'openai' };

  const events = [];
  const fallback = await gateway.chat({
    candidates: [bad, good],
    task: 'agent',
    system: 'test',
    history: [{ role: 'user', text: 'hi' }],
    maxTokens: 64,
    temperature: 0,
    runId: 'run_smoke',
    onEvent: (e) => events.push(e.type),
  });
  assert.strictEqual(fallback.text, '{"answer":"ok"}');
  assert.strictEqual(fallback.provider.id, 'good');
  assert.strictEqual(hits.bad, 2, 'the failing provider is retried twice');
  assert.strictEqual(hits.good, 1, 'the fallback answers once');
  assert.ok(events.includes('model_error') && events.includes('model_fallback'), 'fallback events are emitted');

  const chunks = [];
  const streamed = await gateway.chat({
    candidates: [good],
    task: 'chat',
    history: [{ role: 'user', text: 'hi' }],
    maxTokens: 64,
    stream: true,
    onDelta: (delta) => chunks.push(delta),
  });
  assert.strictEqual(streamed.text, 'Hello world');
  assert.strictEqual(chunks.join(''), 'Hello world');
  assert.ok(streamed.usage.promptTokens >= 11, 'streamed usage is captured');

  const structured = await gateway.chat({
    candidates: [good],
    task: 'plan',
    history: [{ role: 'user', text: 'plan it' }],
    maxTokens: 64,
    jsonSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } },
  });
  assert.strictEqual(structured.json.answer, 'ok');

  await assert.rejects(
    gateway.chat({
      candidates: [badJson],
      task: 'plan',
      history: [{ role: 'user', text: 'plan it' }],
      maxTokens: 64,
      jsonSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } },
    }),
    /structured output/,
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    gateway.chat({ candidates: [good], task: 'chat', history: [{ role: 'user', text: 'hi' }], signal: controller.signal }),
    (err) => err && err.name === 'AbortError',
  );

  db.setRouting('agent', [{ providerId: 'good', model: 'good-model' }]);
  assert.strictEqual(db.getRouting().agent[0].providerId, 'good');

  const summary = db.usageSummary({ sinceMs: 3600 * 1000 });
  assert.ok(summary.totals.calls >= 4, 'every attempt is recorded');
  assert.ok(summary.totals.tokens > 0, 'token totals are recorded');
  assert.ok(summary.byModel.some((row) => row.model === 'good-model'), 'usage is grouped by model');

  const recent = db.usageRecent(10);
  assert.ok(recent.length >= 4);
  assert.ok(recent.some((row) => row.ok === 0), 'failed attempts are stored as failures');

  server.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('gateway smoke: OK —', summary.totals.calls, 'calls,', summary.totals.tokens, 'tokens,', recent.length, 'recent rows');
}

main().catch((err) => {
  console.error('gateway smoke FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
