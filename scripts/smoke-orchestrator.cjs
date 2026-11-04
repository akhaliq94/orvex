'use strict';

/**
 * Orchestrator end-to-end test: planner → executor → validator, parallel
 * read-only steps, a validation failure that triggers retry + replan, a failed
 * run with a saved checkpoint, then resume of that same run.
 * Needs the ORVEX window running with --remote-debugging-port=9222.
 */

const http = require('node:http');
const PORT = Number(process.env.ORVEX_CDP_PORT || 9222);

let failing = false;
const counters = { plan: 0, replan: 0, validate: 0, worker: 0, tools: 0 };

const HAPPY_PLAN = {
  steps: [
    {
      id: 's1',
      title: 'Check the machine',
      goal: 'Check the machine and report what you find.',
      dependsOn: [],
      readOnly: true,
      parallelGroup: 0,
      validate: 'A concrete machine report is shown.',
    },
    {
      id: 's2',
      title: 'Inspect disk usage',
      goal: 'Inspect disk usage on this machine.',
      dependsOn: ['s1'],
      readOnly: true,
      parallelGroup: 1,
      validate: 'Disk usage numbers are reported.',
    },
    {
      id: 's3',
      title: 'Inspect memory usage',
      goal: 'Inspect memory usage on this machine.',
      dependsOn: ['s1'],
      readOnly: true,
      parallelGroup: 1,
      validate: 'Memory usage numbers are reported.',
    },
  ],
};

const RESUME_PLAN = {
  steps: [
    {
      id: 'd1',
      title: 'Collect the data',
      goal: 'Collect the data needed for the report.',
      dependsOn: [],
      readOnly: true,
      parallelGroup: 0,
      validate: 'Collected data is reported.',
    },
    {
      id: 'd2',
      title: 'Write report',
      goal: 'Write report from the collected data.',
      dependsOn: ['d1'],
      readOnly: false,
      parallelGroup: 0,
      validate: 'The report exists with real content.',
    },
  ],
};

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
      const payload = JSON.parse(raw || '{}');
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => String(m.content || ''))
        .join('\n');
      const userText = messages
        .filter((m) => m.role === 'user')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')))
        .join('\n');
      const reply = (obj) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: JSON.stringify(obj) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 25, completion_tokens: 12, total_tokens: 37 },
          }),
        );
      };
      const say = (text) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
          }),
        );
      };

      if (/ORVEX planner/.test(system)) {
        counters.plan += 1;
        if (/A step could not be completed/.test(userText)) {
          counters.replan += 1;
          return reply({
            steps: [
              {
                id: 'r1',
                title: 'Write a shorter report',
                goal: 'Write a shorter report from the collected data and show its path.',
                dependsOn: [],
                readOnly: false,
                parallelGroup: 0,
                validate: 'A shorter report exists and its path is shown.',
              },
            ],
          });
        }
        return reply(/Resume smoke/.test(userText) ? RESUME_PLAN : HAPPY_PLAN);
      }

      if (/ORVEX validator/.test(system)) {
        counters.validate += 1;
        const reportStep = /Write report|shorter report/.test(userText);
        const ok = failing ? !reportStep : true;
        return reply({
          ok,
          reason: ok ? 'The report shows concrete evidence for the step.' : 'No evidence that the report was written.',
          feedback: ok ? '' : 'Actually write the report and show its real path.',
        });
      }

      counters.worker += 1;
      const sawTool = messages.some((m) => m.role === 'tool');
      if (/Check the machine/.test(userText) && !sawTool) {
        counters.tools += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Checking the machine first.',
                  tool_calls: [{ id: 'call_orch_smoke', type: 'function', function: { name: 'sys_info', arguments: '{}' } }],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
          }),
        );
        return;
      }
      if (/Inspect disk usage/.test(userText)) return say('Disk usage inspected and reported.');
      if (/Inspect memory usage/.test(userText)) return say('Memory usage inspected and reported.');
      if (/Check the machine/.test(userText)) return say('Machine checked with sys_info. Report above.');
      if (/collected data|Collect the data/.test(userText)) return say('Collected the data from the system.');
      if (/shorter report/i.test(userText)) return say('Shorter report written to C:\\Users\\Public\\report-short.txt');
      if (/Write report/i.test(userText)) return say('Report written to C:\\Users\\Public\\report.txt');
      return say('Step complete.');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const provider = `{ id: 'smoke', name: 'Fake local', baseUrl: ${JSON.stringify(base)}, api: 'openai', model: 'fake-orch-model' }`;
  const collector = `
    const seen = [];
    const off = window.orvex.agent.onEvent((e) => {
      seen.push({
        type: e.type, runId: e.runId, ok: e.ok, resumed: e.resumed, parallel: e.parallel,
        stepId: e.stepId, summary: e.summary, message: e.message, position: e.position, total: e.total,
        plan: e.plan ? e.plan.map((s) => ({ id: s.id, status: s.status })) : null,
      });
      if (e.type === 'run_end') { off(); setTimeout(() => resolve(seen), 120); }
    });
    setTimeout(() => { off(); resolve(seen); }, 90000);`;

  const runGoal = (goal) =>
    evaluate(`new Promise(async (resolve) => {
      ${collector}
      const started = await window.orvex.agent.start({ goal: ${JSON.stringify(goal)}, provider: ${provider}, task: 'agent', autoApprove: true, mode: 'orchestrator' });
      if (!started.ok) { off(); resolve([{ type: 'start_error', message: started.error }]); }
    })`);

  const runResume = (runId) =>
    evaluate(`new Promise(async (resolve) => {
      ${collector}
      const started = await window.orvex.orchestrator.resume({ runId: ${JSON.stringify(runId)}, goal: '', provider: ${provider}, task: 'agent', autoApprove: true, mode: 'orchestrator' });
      if (!started.ok) { off(); resolve([{ type: 'start_error', message: started.error }]); }
    })`);

  const checks = [];
  const check = (name, ok, detail) => {
    checks.push([name, ok]);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // ---- Phase 1: happy path with a parallel read-only group ----
  const happy = await runGoal('Happy path smoke: check the machine, then inspect disk and memory.');
  const happyEnd = happy.find((e) => e.type === 'run_end');
  const happyStarts = happy.filter((e) => e.type === 'step_start');
  const happyDone = happy.filter((e) => e.type === 'step_done' && e.ok);
  const happyValid = happy.filter((e) => e.type === 'validation' && e.ok);
  check('happy: plan created', happy.some((e) => e.type === 'plan_created'));
  check('happy: 3 steps executed', happyStarts.length === 3, `saw ${happyStarts.length}`);
  check('happy: read-only steps ran in parallel', happyStarts.filter((e) => e.parallel).length === 2);
  check('happy: every step validated', happyValid.length === 3, `saw ${happyValid.length}`);
  check('happy: every step done', happyDone.length === 3, `saw ${happyDone.length}`);
  check('happy: run finished ok', !!happyEnd && happyEnd.ok === true, happyEnd ? happyEnd.summary : 'no run_end');
  check('happy: tool call executed inside a step', counters.tools >= 1);

  const happyRunId = happy.find((e) => e.type === 'run_start')?.runId;
  const happyRecord = happyRunId ? await evaluate(`window.orvex.orchestrator.run(${JSON.stringify(happyRunId)}).then((r) => r)`) : null;
  check(
    'happy: run_steps persisted',
    !!(happyRecord && happyRecord.ok && happyRecord.data.steps.length === 3 && happyRecord.data.steps.every((s) => s.status === 'done')),
    happyRecord && happyRecord.ok ? happyRecord.data.steps.map((s) => s.status).join(',') : 'no record',
  );

  // ---- Phase 2: validation failure → retry → replan → failed checkpoint ----
  failing = true;
  const failed = await runGoal('Resume smoke: collect data, then write a report.');
  const failedEnd = failed.find((e) => e.type === 'run_end');
  const failedRunId = failed.find((e) => e.type === 'run_start')?.runId;
  check('failure: retried the failing step', failed.some((e) => e.type === 'step_retry'));
  check('failure: replanned once', failed.some((e) => e.type === 'plan_revised'));
  check('failure: run ended as failed', !!failedEnd && failedEnd.ok === false, failedEnd ? failedEnd.summary : 'no run_end');

  const runsList = failedRunId ? await evaluate('window.orvex.orchestrator.runs(10).then((r) => r)') : null;
  check(
    'failure: run is resumable',
    !!(runsList && runsList.ok && runsList.data.resumable.some((r) => r.id === failedRunId)),
  );

  // ---- Phase 3: resume the failed run ----
  failing = false;
  const resumed = failedRunId ? await runResume(failedRunId) : [{ type: 'start_error', message: 'no runId' }];
  const resumedStart = resumed.find((e) => e.type === 'run_start');
  const resumedEnd = resumed.find((e) => e.type === 'run_end');
  const resumedDone = resumed.filter((e) => e.type === 'step_done' && e.ok);
  check('resume: run_start is marked resumed', !!resumedStart && resumedStart.resumed === true);
  check('resume: completed step was not re-run', !resumed.some((e) => e.type === 'step_start' && e.stepId === 'd1'));
  check('resume: remaining step verified', resumedDone.length >= 1, `saw ${resumedDone.length}`);
  check('resume: run finished ok', !!resumedEnd && resumedEnd.ok === true, resumedEnd ? resumedEnd.summary : 'no run_end');

  const resumedRecord = failedRunId ? await evaluate(`window.orvex.orchestrator.run(${JSON.stringify(failedRunId)}).then((r) => r)`) : null;
  check(
    'resume: step rows show the finished step',
    !!(resumedRecord && resumedRecord.ok && resumedRecord.data.steps.some((s) => s.id === 'r1' && s.status === 'done')),
  );

  const usage = await evaluate('window.orvex.usage.summary(3600000).then((r) => r)');
  const tasks = usage && usage.ok ? usage.data.byTask.map((r) => r.task) : [];
  check('usage: planner/validator calls recorded under plan', tasks.includes('plan'), tasks.join(','));
  check('usage: worker calls recorded under agent', tasks.includes('agent'), tasks.join(','));

  await sleep(150);
  ws.close();
  server.close();
  if (checks.some(([, ok]) => !ok)) {
    console.error('orchestrator smoke failed; counters:', JSON.stringify(counters));
    process.exit(1);
  }
  console.log(`orchestrator smoke: OK — counters ${JSON.stringify(counters)}`);
}

main().catch((err) => {
  console.error('orchestrator smoke FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
