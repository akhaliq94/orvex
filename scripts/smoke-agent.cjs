'use strict';

/**
 * End-to-end agent test: renderer → IPC → agent loop → gateway → tools → audit.
 * Uses a fake local provider that asks for sys_info once, then finishes.
 * Needs the ORVEX window running with --remote-debugging-port=9222.
 */

const http = require('node:http');
const PORT = Number(process.env.ORVEX_CDP_PORT || 9222);

function serve() {
  let calls = 0;
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
      calls += 1;
      const payload = JSON.parse(raw || '{}');
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const sawToolResult = messages.some((m) => m.role === 'tool');
      res.writeHead(200, { 'content-type': 'application/json' });
      if (!sawToolResult) {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Checking the machine first.',
                  tool_calls: [
                    { id: 'call_smoke_1', type: 'function', function: { name: 'sys_info', arguments: '{}' } },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Machine checked. All done.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 30, completion_tokens: 6, total_tokens: 36 },
        }),
      );
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
      ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });

  const events = await evaluate(`new Promise(async (resolve) => {
    const seen = [];
    const off = window.orvex.agent.onEvent((e) => {
      seen.push({ type: e.type, name: e.name, ok: e.ok, summary: e.summary, text: e.text, message: e.message, model: e.model });
      if (e.type === 'run_end') { off(); resolve(seen); }
    });
    const started = await window.orvex.agent.start({
      goal: 'Check this machine and report back.',
      provider: { id: 'smoke', name: 'Fake local', baseUrl: ${JSON.stringify(base)}, api: 'openai', model: 'fake-agent-model' },
      task: 'agent',
      autoApprove: true,
    });
    if (!started.ok) { off(); resolve([{ type: 'start_error', message: started.error }]); }
    setTimeout(() => { off(); resolve(seen); }, 45000);
  })`);

  const types = events.map((e) => e.type);
  const runStart = events.find((e) => e.type === 'run_start');
  const toolStart = events.find((e) => e.type === 'tool_start');
  const toolResult = events.find((e) => e.type === 'tool_result');
  const runEnd = events.find((e) => e.type === 'run_end');

  const usage = await evaluate("window.orvex.usage.summary(3600000).then((r) => r)");
  const audit = await evaluate('window.orvex.audit.tail(20).then((r) => r)');

  const checks = [
    ['run_start emitted', !!runStart && runStart.type === 'run_start'],
    ['model called through the gateway', !!runStart && runStart.model === 'fake-agent-model'],
    ['tool call executed', !!toolStart && toolStart.name === 'sys_info'],
    ['tool result returned', !!toolResult && toolResult.type === 'tool_result'],
    ['run finished ok', !!runEnd && runEnd.ok === true],
    ['agent usage recorded', !!(usage && usage.ok && usage.data.byTask.some((r) => r.task === 'agent'))],
    ['tool call audited', !!(audit && audit.ok && audit.data.some((row) => row.tool === 'sys_info'))],
  ];

  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  ws.close();
  server.close();
  if (checks.some(([, ok]) => !ok)) {
    console.error('events:', types.join(', '), runEnd ? runEnd.summary : '');
    process.exit(1);
  }
  console.log(`agent smoke: OK — ${types.join(', ')}`);
}

main().catch((err) => {
  console.error('agent smoke FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
