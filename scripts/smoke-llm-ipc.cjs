'use strict';

/**
 * End-to-end check of the renderer → preload → main gateway streaming path.
 * Needs the ORVEX window running with --remote-debugging-port=9222.
 * Spins up a local fake OpenAI-compatible server; no API keys involved.
 */

const http = require('node:http');
const PORT = Number(process.env.ORVEX_CDP_PORT || 9222);

function serve() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      if (!req.url.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"from IPC"}}]}\n\n');
      res.write('data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12}}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/v1`;

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('ORVEX window not found');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  let id = 1;
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const myId = id++;
      const handler = (msg) => {
        const data = JSON.parse(msg.data);
        if (data.id !== myId) return;
        ws.removeEventListener('message', handler);
        if (data.result && data.result.exceptionDetails) reject(new Error(data.result.exceptionDetails.text));
        else resolve(data.result.result.value);
      };
      ws.addEventListener('message', handler);
      ws.send(
        JSON.stringify({
          id: myId,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });

  const requestId = `ipc-smoke-${Date.now()}`;
  const events = await evaluate(`new Promise(async (resolve) => {
    const seen = [];
    const off = window.orvex.llm.onEvent((e) => {
      if (e.requestId !== ${JSON.stringify(requestId)}) return;
      seen.push({ type: e.type, text: e.text, full: e.full, message: e.message, usage: e.usage });
      if (e.type === 'done' || e.type === 'error' || e.type === 'aborted') { off(); resolve(seen); }
    });
    const started = await window.orvex.llm.start({
      requestId: ${JSON.stringify(requestId)},
      provider: { id: 'smoke', name: 'Fake local', baseUrl: ${JSON.stringify(base)}, api: 'openai', model: 'fake-model' },
      messages: [{ role: 'user', content: 'say hi' }],
      task: 'chat',
      maxTokens: 64,
    });
    if (!started.ok) { off(); resolve([{ type: 'start_error', message: started.error }]); }
    setTimeout(() => { off(); resolve(seen); }, 15000);
  })`);

  const types = events.map((e) => e.type);
  const done = events.find((e) => e.type === 'done');
  const usage = await evaluate('window.orvex.usage.summary(3600000).then((r) => r)');

  const checks = [
    ['stream started', types.includes('first') || types.includes('delta')],
    ['delta events arrived', types.filter((t) => t === 'delta').length >= 2],
    ['stream completed', !!done && done.text === 'Hello from IPC'],
    ['usage recorded through IPC', !!(usage && usage.ok && usage.data.totals && usage.data.totals.calls >= 1)],
  ];

  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  ws.close();
  server.close();

  if (checks.some(([, ok]) => !ok)) {
    console.error('llm ipc smoke FAILED');
    process.exit(1);
  }
  console.log(`llm ipc smoke: OK — ${types.join(', ')}`);
}

main().catch((err) => {
  console.error('llm ipc smoke FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
