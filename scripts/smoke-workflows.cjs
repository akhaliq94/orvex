'use strict';

/**
 * Section 13 — workflow engine + desktop wiring smoke.
 *
 * Part A exercises the engine module in plain Node with a mock tool runner:
 * cron parsing, definition validation, loops, conditions, retries, approvals,
 * cancellation, concurrency, crash interrupts + resume, scheduling and templates.
 *
 * Part B drives the packaged app over CDP: the preload bridge, IPC handlers,
 * the merged agent tools, a real run against system_status, an approval gate,
 * cancellation, cron scheduling and persisted files.
 *
 * Requires the ORVEX window running with --remote-debugging-port=9222 for Part B.
 * Set ORVEX_SKIP_SCHEDULE=1 to skip the live cron tick wait.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.ORVEX_CDP_PORT || 9222);
const APP_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'orvex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ------------------------------------------------------------ part A: module */

const TOOLS = new Set(['echo', 'fail_twice', 'always_fail', 'slow', 'risky_tool', 'system_status', 'http_request']);
const TERMINAL = ['succeeded', 'failed', 'cancelled'];

function makeRunner(state) {
  return async (name, args = {}) => {
    state.calls.push({ name, args });
    if (name === 'echo') return { ok: true, output: String(args.text ?? JSON.stringify(args)), ms: 1 };
    if (name === 'system_status') return { ok: true, output: 'System status ok', ms: 1 };
    if (name === 'fail_twice') {
      state.failTwice += 1;
      return state.failTwice <= 2 ? { ok: false, error: 'boom' } : { ok: true, output: 'recovered', ms: 1 };
    }
    if (name === 'always_fail') return { ok: false, error: 'nope', ms: 1 };
    if (name === 'slow') {
      await sleep(Number(args.ms) || 300);
      if (state.slowError) return { ok: false, error: 'slow failed', ms: 1 };
      return { ok: true, output: 'slow done', ms: Number(args.ms) || 300 };
    }
    if (name === 'risky_tool') {
      state.risky += 1;
      return { ok: true, output: 'risky done', ms: 1 };
    }
    return { ok: false, error: `unknown tool ${name}`, ms: 1 };
  };
}

function buildMod(dir, state, notifications) {
  const mod = require('../electron/workflows.cjs');
  mod.init({
    dataDir: dir,
    emit: () => {},
    notify: (n) => notifications.push(n),
    runTool: makeRunner(state),
    approvalReason: (name) => (name === 'risky_tool' ? 'This tool changes the system.' : null),
    toolExists: (name) => TOOLS.has(name),
  });
  return mod;
}

async function moduleSuite() {
  console.log('\n— engine module');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-wf-'));
  const state = { calls: [], failTwice: 0, risky: 0, slowError: false };
  const notifications = [];
  const mod = buildMod(dir, state, notifications);

  let seq = 0;
  const uniq = (base) => `${base} ${(seq += 1)}`;
  const trigger = (config = { type: 'manual' }, id = 'trigger') => ({
    id,
    type: 'trigger',
    label: 'Start',
    position: { x: 0, y: 0 },
    config,
  });
  const node = (type, id, config, label) => ({ id, type, label: label || type, position: { x: 0, y: 0 }, config });
  const edge = (source, target, when = 'next') => ({ source, target, when });

  const runsFor = (id) => mod.runsFor(undefined, 50).find((r) => r.id === id);
  async function waitStatus(id, statuses, timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const run = runsFor(id);
      if (run && statuses.includes(run.status)) return run;
      await sleep(15);
    }
    throw new Error(`Timed out waiting for ${id} to be ${statuses.join('/')}; last ${runsFor(id)?.status}`);
  }
  const waitTerminal = (id, timeout = 8000) => waitStatus(id, TERMINAL, timeout);
  function expectThrow(label, fn, part) {
    try {
      fn();
      check(label, false, 'no error was thrown');
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      check(label, message.toLowerCase().includes(String(part).toLowerCase()), message);
    }
  }

  /* cron */
  const base = new Date(2026, 0, 1, 10, 7, 30).getTime(); // local time
  const quarter = new Date(mod.cronNext('*/15 * * * *', base));
  check(
    'cron */15 lands on the next quarter hour',
    quarter.getMinutes() === 15 && quarter.getSeconds() === 0 && quarter.getHours() === 10,
    quarter.toString(),
  );
  const daily = new Date(mod.cronNext('0 9 * * *', base));
  check('cron 0 9 rolls to tomorrow 09:00', daily.getDate() === 2 && daily.getHours() === 9 && daily.getMinutes() === 0, daily.toString());
  const orDay = new Date(mod.cronNext('0 0 13 * 5', new Date(2026, 0, 1, 12, 0, 0).getTime()));
  check('cron day-of-month OR day-of-week picks Friday the 2nd', orDay.getDate() === 2 && orDay.getDay() === 5, orDay.toString());
  const step = new Date(mod.cronNext('10-30/10 * * * *', base));
  check('cron ranges with steps work', [10, 20, 30].includes(step.getMinutes()), step.toString());
  expectThrow('cron rejects the wrong field count', () => mod.cronNext('0 9 *'), '5 fields');
  expectThrow('cron rejects out-of-range minutes', () => mod.cronNext('99 * * * *'), 'outside');
  expectThrow('cron rejects an impossible date', () => mod.cronNext('0 0 30 2 *'), 'never matches');
  check('cronLabel describes the next run', /^Next /.test(mod.cronLabel('0 9 * * *')), mod.cronLabel('0 9 * * *'));

  /* validation */
  expectThrow('save requires a name', () => mod.save({ name: ' ', nodes: [trigger()], edges: [] }), 'name');
  expectThrow('save requires a trigger node', () => mod.save({ name: uniq('empty'), nodes: [], edges: [] }), 'trigger');
  expectThrow(
    'save rejects two triggers',
    () => mod.save({ name: uniq('two'), nodes: [trigger(), trigger({ type: 'manual' }, 't2')], edges: [] }),
    'exactly one trigger',
  );
  expectThrow(
    'save rejects unknown tools',
    () =>
      mod.save({
        name: uniq('bad tool'),
        nodes: [trigger(), node('tool', 'x', { tool: 'not_a_tool', args: {} })],
        edges: [edge('trigger', 'x')],
      }),
    'unknown tool',
  );
  expectThrow(
    'save rejects duplicate node ids',
    () =>
      mod.save({
        name: uniq('dup'),
        nodes: [trigger(), node('notify', 'trigger', { title: 'a', message: 'b' })],
        edges: [edge('trigger', 'trigger')],
      }),
    'Duplicate node id',
  );
  expectThrow(
    'save rejects unreachable nodes',
    () => mod.save({ name: uniq('stranded'), nodes: [trigger(), node('notify', 'n', { title: 'a', message: 'b' })], edges: [] }),
    'Unconnected',
  );
  expectThrow(
    'save rejects an edge to a missing node',
    () =>
      mod.save({
        name: uniq('missing'),
        nodes: [trigger(), node('notify', 'n', { title: 'a', message: 'b' })],
        edges: [edge('trigger', 'ghost')],
      }),
    'two nodes',
  );
  expectThrow(
    'save rejects a self connection',
    () => mod.save({ name: uniq('self'), nodes: [trigger()], edges: [edge('trigger', 'trigger')] }),
    'itself',
  );
  expectThrow(
    'save rejects a loop without a body edge',
    () => mod.save({ name: uniq('nobody'), nodes: [trigger(), node('loop', 'l', { mode: 'count', count: 2 })], edges: [edge('trigger', 'l')] }),
    'body edge',
  );
  expectThrow(
    'condition edges must be true or false',
    () =>
      mod.save({
        name: uniq('cond labels'),
        nodes: [trigger(), node('condition', 'c', { left: 'a', operator: 'truthy' }), node('notify', 'n', { title: 'a', message: 'b' })],
        edges: [edge('trigger', 'c'), edge('c', 'n', 'next')],
      }),
    'true or false',
  );
  expectThrow(
    'loop edges must be body or done',
    () =>
      mod.save({
        name: uniq('loop labels'),
        nodes: [trigger(), node('loop', 'l', { mode: 'count', count: 2 }), node('notify', 'n', { title: 'a', message: 'b' })],
        edges: [edge('trigger', 'l'), edge('l', 'n', 'next')],
      }),
    'body or done',
  );
  expectThrow(
    'cycles that skip the loop node are rejected',
    () =>
      mod.save({
        name: uniq('cycle'),
        nodes: [
          trigger(),
          node('transform', 'a', { template: 'a' }),
          node('transform', 'b', { template: 'b' }),
        ],
        edges: [edge('trigger', 'a'), edge('a', 'b'), edge('b', 'a')],
      }),
    'without a loop node',
  );
  expectThrow(
    'unknown node types are rejected',
    () => mod.save({ name: uniq('type'), nodes: [trigger(), node('wat', 'n', {})], edges: [edge('trigger', 'n')] }),
    'Unknown node type',
  );
  expectThrow(
    'bad cron is rejected on save',
    () =>
      mod.save({
        name: uniq('cron'),
        nodes: [trigger({ type: 'schedule', cron: '99 9 * * *' })],
        edges: [],
      }),
    'outside',
  );

  /* basic chain + interpolation */
  const chain = mod.save({
    name: uniq('chain'),
    nodes: [
      trigger(),
      node('transform', 'say', { template: 'Hello {{input.who}}' }, 'Say hello'),
      node('notify', 'done', { title: '{{steps.say.output}}', message: 'All done' }, 'Notify'),
    ],
    edges: [edge('trigger', 'say'), edge('say', 'done')],
  });
  check('save returns a slug id, manual trigger and no next run', chain.id.startsWith('chain-') && chain.trigger.type === 'manual' && chain.nextRunAt === null, chain.id);
  check('definitions persist to workflows.json', fs.existsSync(path.join(dir, 'workflows.json')));
  const chainRun = mod.runNow(chain.id, { who: 'world' });
  const chainDone = await waitTerminal(chainRun.id);
  const chainDetail = mod.runDetail(chainRun.id);
  check('manual chain succeeds with three recorded steps', chainDone.status === 'succeeded' && chainDetail.steps.length === 3, `${chainDone.status} / ${chainDetail.steps.length} steps`);
  check('templates render run input', chainDetail.outputs.say.output === 'Hello world', chainDetail.outputs.say.output);
  check('notify step delivered a real notification', notifications.some((n) => n.title === 'Hello world'), JSON.stringify(notifications.at(-1) || null));
  check('runs persist to workflow-runs.json', fs.existsSync(path.join(dir, 'workflow-runs.json')));

  /* loop count */
  const loopWf = mod.save({
    name: uniq('loop'),
    nodes: [
      trigger(),
      node('loop', 'loop', { mode: 'count', count: 3, itemVar: 'item' }, '3 times'),
      node('delay', 'wait', { ms: 5 }, 'Wait'),
      node('transform', 'tick', { template: 'Tick {{loop.n}}/{{loop.total}}' }, 'Tick'),
      node('notify', 'done', { title: 'Loop finished', message: 'ok' }, 'Notify'),
    ],
    edges: [
      edge('trigger', 'loop'),
      edge('loop', 'wait', 'body'),
      edge('wait', 'tick'),
      edge('tick', 'loop'),
      edge('loop', 'done', 'done'),
    ],
  });
  const loopRun = await (async () => {
    const r = mod.runNow(loopWf.id);
    return waitTerminal(r.id);
  })();
  const loopDetail = mod.runDetail(loopRun.id);
  const ticks = loopDetail.steps.filter((s) => s.nodeId === 'tick').map((s) => s.output);
  check('loop runs its body three times', loopRun.status === 'succeeded' && ticks.join('|') === 'Tick 1/3|Tick 2/3|Tick 3/3', ticks.join('|'));
  check('loop node records three iterations plus the finish', loopDetail.steps.filter((s) => s.nodeId === 'loop').length === 4, String(loopDetail.steps.filter((s) => s.nodeId === 'loop').length));

  /* loop over lines */
  const linesWf = mod.save({
    name: uniq('lines'),
    nodes: [
      trigger(),
      node('loop', 'loop', { mode: 'lines', source: 'alpha\n\n beta \n\n' }, 'Each line'),
      node('transform', 'item', { template: '[{{loop.item}}]' }, 'Item'),
      node('notify', 'done', { title: 'done', message: 'ok' }, 'Notify'),
    ],
    edges: [edge('trigger', 'loop'), edge('loop', 'item', 'body'), edge('item', 'loop'), edge('loop', 'done', 'done')],
  });
  const linesRun = await (async () => {
    const r = mod.runNow(linesWf.id);
    return waitTerminal(r.id);
  })();
  const lineItems = mod.runDetail(linesRun.id).steps.filter((s) => s.nodeId === 'item').map((s) => s.output);
  check('line loops trim and skip blank lines', linesRun.status === 'succeeded' && lineItems.join('|') === '[alpha]|[beta]', lineItems.join('|'));

  /* condition branches */
  function conditionWf(value) {
    return mod.save({
      name: uniq('cond'),
      nodes: [
        trigger(),
        node('transform', 'value', { template: value }, 'Value'),
        node('condition', 'check', { left: '{{steps.value.output}}', operator: 'contains', right: 'y' }, 'Contains y?'),
        node('notify', 'up', { title: 'yes', message: 'yes' }, 'Yes'),
        node('notify', 'down', { title: 'no', message: 'no' }, 'No'),
      ],
      edges: [
        edge('trigger', 'value'),
        edge('value', 'check'),
        edge('check', 'up', 'true'),
        edge('check', 'down', 'false'),
      ],
    });
  }
  const yesWf = conditionWf('yes');
  const yesRun = await (async () => {
    const r = mod.runNow(yesWf.id);
    return waitTerminal(r.id);
  })();
  const yesOutputs = mod.runDetail(yesRun.id).outputs;
  check('true branch runs and false branch is skipped', yesRun.status === 'succeeded' && !!yesOutputs.up && !yesOutputs.down, Object.keys(yesOutputs).join(','));
  const noWf = conditionWf('zzz');
  const noRun = await (async () => {
    const r = mod.runNow(noWf.id);
    return waitTerminal(r.id);
  })();
  const noOutputs = mod.runDetail(noRun.id).outputs;
  check('false branch runs when the condition fails', noRun.status === 'succeeded' && !!noOutputs.down && !noOutputs.up, Object.keys(noOutputs).join(','));

  /* retries and onError */
  state.failTwice = 0;
  const retryWf = mod.save({
    name: uniq('retry'),
    nodes: [
      trigger(),
      node('tool', 'call', { tool: 'fail_twice', args: {}, retry: { attempts: 3, delayMs: 5 }, onError: 'stop' }, 'Flaky'),
      node('notify', 'done', { title: 'done', message: 'ok' }, 'Notify'),
    ],
    edges: [edge('trigger', 'call'), edge('call', 'done')],
  });
  const retryRun = await (async () => {
    const r = mod.runNow(retryWf.id);
    return waitTerminal(r.id);
  })();
  const retryStep = mod.runDetail(retryRun.id).steps.find((s) => s.nodeId === 'call');
  check('retries recover a flaky tool after three attempts', retryRun.status === 'succeeded' && retryStep.attempts === 3 && retryStep.ok, `attempts ${retryStep.attempts}`);

  const failWf = mod.save({
    name: uniq('fail'),
    nodes: [
      trigger(),
      node('tool', 'call', { tool: 'always_fail', args: {}, retry: { attempts: 2, delayMs: 1 }, onError: 'stop' }, 'Doomed'),
      node('notify', 'done', { title: 'done', message: 'ok' }, 'Notify'),
    ],
    edges: [edge('trigger', 'call'), edge('call', 'done')],
  });
  const failRun = await (async () => {
    const r = mod.runNow(failWf.id);
    return waitTerminal(r.id);
  })();
  const failSteps = mod.runDetail(failRun.id).steps;
  check('a failing tool stops the run with the node label', failRun.status === 'failed' && /Doomed/.test(failRun.error || ''), failRun.error);
  check('the failing attempt is recorded twice', failSteps.find((s) => s.nodeId === 'call').attempts === 2 && !failSteps.find((s) => s.nodeId === 'done'), failSteps.length + ' steps');

  const continueWf = mod.save({
    name: uniq('continue'),
    nodes: [
      trigger(),
      node('tool', 'call', { tool: 'always_fail', args: {}, retry: { attempts: 1, delayMs: 0 }, onError: 'continue' }, 'Optional'),
      node('notify', 'done', { title: 'continued', message: 'ok' }, 'Notify'),
    ],
    edges: [edge('trigger', 'call'), edge('call', 'done')],
  });
  const continueRun = await (async () => {
    const r = mod.runNow(continueWf.id);
    return waitTerminal(r.id);
  })();
  const continueSteps = mod.runDetail(continueRun.id).steps;
  check(
    'onError continue keeps going and marks the step failed',
    continueRun.status === 'succeeded' && !continueSteps.find((s) => s.nodeId === 'call').ok && !!continueSteps.find((s) => s.nodeId === 'done'),
  );

  /* approval node */
  const approvalWf = mod.save({
    name: uniq('approval'),
    nodes: [
      trigger(),
      node('approval', 'gate', { title: 'Go ahead?', message: 'Continue now' }, 'Ask'),
      node('notify', 'done', { title: 'approved', message: 'ok' }, 'Notify'),
    ],
    edges: [edge('trigger', 'gate'), edge('gate', 'done')],
  });
  const gateRun = mod.runNow(approvalWf.id);
  await waitStatus(gateRun.id, ['awaiting_approval']);
  const gateDetail = mod.runDetail(gateRun.id);
  check('an approval node suspends the run', gateDetail.summary.status === 'awaiting_approval' && gateDetail.suspended.kind === 'approval', gateDetail.suspended && gateDetail.suspended.title);
  mod.approve(gateRun.id, true);
  const gateDone = await waitTerminal(gateRun.id);
  check('approving resumes and finishes the run', gateDone.status === 'succeeded');
  const rejectRun = mod.runNow(approvalWf.id);
  await waitStatus(rejectRun.id, ['awaiting_approval']);
  mod.approve(rejectRun.id, false);
  const rejected = await waitTerminal(rejectRun.id);
  check('rejecting fails the run with a clear reason', rejected.status === 'failed' && /rejected this step/.test(rejected.error || ''), rejected.error);

  /* risky tool gate */
  const riskyWf = mod.save({
    name: uniq('risky'),
    nodes: [
      trigger(),
      node('tool', 'danger', { tool: 'risky_tool', args: {}, retry: { attempts: 1, delayMs: 0 }, onError: 'stop' }, 'Danger'),
      node('notify', 'done', { title: 'risky done', message: 'ok' }, 'Notify'),
    ],
    edges: [edge('trigger', 'danger'), edge('danger', 'done')],
  });
  const beforeRisky = state.risky;
  const riskyRun = mod.runNow(riskyWf.id);
  await waitStatus(riskyRun.id, ['awaiting_approval']);
  const riskyDetail = mod.runDetail(riskyRun.id);
  check('a risky tool pauses before it executes', riskyDetail.suspended.kind === 'tool' && state.risky === beforeRisky, riskyDetail.suspended.reason);
  mod.approve(riskyRun.id, true);
  const riskyDone = await waitTerminal(riskyRun.id);
  check('approving runs the risky tool exactly once', riskyDone.status === 'succeeded' && state.risky === beforeRisky + 1);

  /* cancel */
  const slowWf = mod.save({
    name: uniq('slow'),
    nodes: [trigger(), node('delay', 'wait', { ms: 800 }, 'Wait')],
    edges: [edge('trigger', 'wait')],
  });
  const cancelRun = mod.runNow(slowWf.id);
  await waitStatus(cancelRun.id, ['running']);
  mod.cancel(cancelRun.id);
  const cancelled = await waitTerminal(cancelRun.id, 4000);
  check('cancelling a running workflow stops it', cancelled.status === 'cancelled', cancelled.error);

  /* concurrency */
  const three = [mod.runNow(slowWf.id).id, mod.runNow(slowWf.id).id, mod.runNow(slowWf.id).id];
  await sleep(120);
  const live = mod.list().stats;
  check('the queue runs at most two workflows at once', live.running <= 2 && live.queued >= 1, `running ${live.running}, queued ${live.queued}`);
  await Promise.all(three.map((id) => waitTerminal(id, 8000)));
  check('the queued run starts after a slot frees up', live.queued >= 1);

  /* agent tools */
  const agentRun = mod.agentRun(chain.id, { who: 'agent' });
  check('agentRun queues a workflow', agentRun.ok && ['queued', 'running'].includes(agentRun.run.status), agentRun.run && agentRun.run.id);
  await waitTerminal(agentRun.run.id);
  check('agentList lists workflows', /chain/.test(mod.agentList().output));
  check('agentStatus reports the run', mod.agentStatus(chain.id, 5).output.includes(agentRun.run.id));
  expectThrow('agentRun rejects unknown workflows', () => mod.agentRun('nope-nope'), 'No workflow matches');

  /* templates */
  const templateDefs = mod.templateDefs();
  check(
    'four real templates ship',
    templateDefs.length === 4 && ['daily-briefing', 'api-heartbeat', 'loop-pause', 'guarded-action'].every((id) => templateDefs.some((t) => t.id === id)),
    templateDefs.map((t) => t.id).join(', '),
  );
  check(
    'templates expose their derived trigger to the UI',
    templateDefs.every((t) => t.workflow.trigger && ['manual', 'schedule'].includes(t.workflow.trigger.type)),
    templateDefs.map((t) => `${t.id}:${t.workflow.trigger && t.workflow.trigger.type}`).join(', '),
  );
  const made = templateDefs.map((t) => mod.createFromTemplate(t.id));
  check('every template creates a valid workflow', made.every((w) => w.id && w.nodes.length >= 2), made.map((w) => w.id).join(', '));
  expectThrow('unknown templates are rejected', () => mod.createFromTemplate('nope'), 'No workflow template');

  /* scheduling */
  const scheduled = mod.save({
    name: uniq('scheduled'),
    nodes: [trigger({ type: 'schedule', cron: '* * * * *' }), node('notify', 'done', { title: 'scheduled', message: 'ok' }, 'Notify')],
    edges: [edge('trigger', 'done')],
  });
  check('a schedule computes its next run', scheduled.nextRunAt != null && scheduled.nextRunAt <= Date.now() + 60000, new Date(scheduled.nextRunAt).toISOString());
  mod.start();
  const startAt = Date.now();
  let scheduledRun = null;
  while (Date.now() - startAt < 2500 && !scheduledRun) {
    scheduledRun = mod.runsFor(scheduled.id, 10).find((r) => r.trigger === 'schedule');
    if (!scheduledRun) await sleep(30);
  }
  check('the scheduler queues a run when the slot is due', !!scheduledRun && scheduledRun.trigger === 'schedule', scheduledRun && scheduledRun.status);
  mod.setEnabled(scheduled.id, false);
  check('pausing a schedule clears its next run', mod.list().workflows.find((w) => w.id === scheduled.id).nextRunAt === null);
  mod.setEnabled(scheduled.id, true);
  mod.stop();
  mod.start();
  await sleep(250);
  const scheduleRuns = mod.runsFor(scheduled.id, 10).filter((r) => r.trigger === 'schedule');
  check('re-enabling catches up a missed slot once', scheduleRuns.length >= 2, `${scheduleRuns.length} scheduled run(s)`);
  mod.stop();

  /* crash interrupt + resume */
  const resumeWf = mod.save({
    name: uniq('resume'),
    nodes: [trigger(), node('notify', 'notify', { title: 'Resumed', message: 'it works' }, 'Notify')],
    edges: [edge('trigger', 'notify')],
  });
  mod.stop();
  const runsFile = path.join(dir, 'workflow-runs.json');
  const crafted = {
    id: 'run_crafted_interrupt',
    workflowId: resumeWf.id,
    workflowName: resumeWf.name,
    status: 'running',
    trigger: 'manual',
    input: {},
    queuedAt: Date.now() - 2000,
    startedAt: Date.now() - 1500,
    endedAt: null,
    steps: [{ nodeId: 'trigger', label: 'Start', type: 'trigger', at: Date.now() - 1500, ok: true, output: 'Started', error: null, ms: 0 }],
    outputs: { trigger: { ok: true, output: 'Started', error: null } },
    output: '',
    error: null,
    suspended: null,
    cancelRequested: false,
    cursor: { stack: [{ node: 'notify' }], loops: {}, counts: { trigger: 1 }, approvals: {}, loopStack: [] },
  };
  fs.mkdirSync(path.dirname(runsFile), { recursive: true });
  fs.writeFileSync(runsFile, JSON.stringify({ version: 1, runs: [crafted] }, null, 2), 'utf8');

  delete require.cache[require.resolve('../electron/workflows.cjs')];
  const state2 = { calls: [], failTwice: 0, risky: 0, slowError: false };
  const notifications2 = [];
  const mod2 = buildMod(dir, state2, notifications2);
  const reloaded = mod2.list().runs.find((r) => r.id === crafted.id);
  check(
    'a run left running by a crash loads as interrupted',
    reloaded && reloaded.status === 'interrupted' && /Resume it/.test(reloaded.error || ''),
    reloaded && reloaded.status,
  );
  mod2.resume(crafted.id);
  const resumeStart = Date.now();
  let resumed = null;
  while (Date.now() - resumeStart < 4000 && !resumed) {
    const run = mod2.runsFor(undefined, 10).find((r) => r.id === crafted.id);
    if (run && TERMINAL.includes(run.status)) resumed = run;
    else await sleep(30);
  }
  check('resuming continues from the checkpointed node', !!resumed && resumed.status === 'succeeded', resumed && resumed.status);
  check('the resumed node really executed', notifications2.some((n) => n.title === 'Resumed'), JSON.stringify(notifications2));
  mod2.stop();

  /* scoped history clearing */
  const clearWf = mod2.save({
    name: `clear history ${(seq += 1)}`,
    nodes: [trigger(), node('notify', 'done', { title: 'clear', message: 'ok' }, 'Notify')],
    edges: [edge('trigger', 'done')],
  });
  const clearRunA = mod2.runNow(clearWf.id);
  const clearRunB = mod2.runNow(clearWf.id);
  const waitOnMod2 = async (id) => {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const run = mod2.runsFor(undefined, 50).find((r) => r.id === id);
      if (run && TERMINAL.includes(run.status)) return run;
      await sleep(30);
    }
    throw new Error(`Timed out waiting for ${id} on the reloaded engine.`);
  };
  const clearSeen = await Promise.all([waitOnMod2(clearRunA.id), waitOnMod2(clearRunB.id)]);
  const clearTarget = mod2.runsFor(clearWf.id, 20).length;
  const otherRuns = mod2.runsFor(undefined, 50).length - clearTarget;
  const cleared = mod2.clearRuns(clearWf.id);
  check(
    'clearRuns(workflowId) removes only that workflow’s history',
    clearSeen.every((r) => r.status === 'succeeded') &&
      clearTarget === 2 &&
      cleared.removed === 2 &&
      mod2.runsFor(clearWf.id, 20).length === 0 &&
      mod2.runsFor(undefined, 50).length === otherRuns,
    `removed ${cleared.removed}, kept ${cleared.kept}`,
  );
  mod2.remove(clearWf.id);

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return { moduleChecks: results.length };
}

/* ------------------------------------------------------------------ part B */

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!res.ok) throw new Error(`CDP list failed: HTTP ${res.status}`);
  return res.json();
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', reject);
  });
  ws.addEventListener('message', (msg) => {
    const data = JSON.parse(msg.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, ready };
}

async function cdpSuite() {
  console.log('\n— desktop wiring');
  const list = await targets();
  const page = list.find((t) => t.type === 'page' && /\/index\.html|\/$/.test(t.url) && !/recorder\.html/.test(t.url));
  if (!page) throw new Error(`No ORVEX page target. Targets: ${list.map((t) => t.url).join(', ')}`);
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed');
    return r.result.value;
  };
  const ipc = (ns, method, ...args) =>
    evaluate(`(async () => {
      const api = window.orvex && window.orvex.${ns};
      if (!api || !api.${method}) return { ok: false, error: 'bridge ${ns}.${method} missing' };
      const r = await api.${method}(${args.map((a) => JSON.stringify(a)).join(', ')});
      return r && r.ok === true ? { ok: true, data: r.data } : { ok: false, error: (r && r.error) || 'ipc failed' };
    })()`);
  const ok = async (ns, method, ...args) => {
    const r = await ipc(ns, method, ...args);
    if (!r.ok) throw new Error(`${ns}.${method} failed: ${r.error}`);
    return r.data;
  };
  const fails = async (ns, method, ...args) => {
    const r = await ipc(ns, method, ...args);
    if (r.ok) throw new Error(`${ns}.${method} unexpectedly succeeded`);
    return r.error;
  };
  const tool = (name, args) =>
    evaluate(`(async () => {
      const r = await window.orvex.tools.run(${JSON.stringify(name)}, ${JSON.stringify(args || {})});
      if (!r || r.ok !== true) return { ok: false, error: (r && r.error) || 'ipc failed' };
      const data = r.data || {};
      return data.ok === true ? { ok: true, data } : { ok: false, error: data.error || 'tool failed' };
    })()`);

  const RUN = Date.now().toString(36);
  const created = [];
  const createdRuns = [];
  const node = (type, id, config, label) => ({ id, type, label: label || type, position: { x: 0, y: 0 }, config });
  const trigger = (config = { type: 'manual' }) => ({ id: 'trigger', type: 'trigger', label: 'Start', position: { x: 0, y: 0 }, config });
  const edge = (source, target, when = 'next') => ({ source, target, when });

  const waitRun = async (id, wanted, timeout = 30000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const data = await ok('workflows', 'runs');
      const run = data.runs.find((r) => r.id === id);
      if (run && wanted.includes(run.status)) return run;
      await sleep(200);
    }
    throw new Error(`Timed out waiting for ${id} to be ${wanted.join('/')}`);
  };

  try {
    const keys = await evaluate(`Object.keys(window.orvex.workflows || {})`);
    check(
      'preload exposes the workflows bridge',
      ['list', 'save', 'remove', 'setEnabled', 'run', 'runs', 'clearRuns', 'runDetail', 'approve', 'cancel', 'resume', 'templates', 'fromTemplate', 'tools', 'cron', 'onChange'].every((k) => keys.includes(k)),
      keys.join(', '),
    );

    const initial = await ok('workflows', 'list');
    check(
      'list returns workflows, runs, stats and the run slot count',
      Array.isArray(initial.workflows) && Array.isArray(initial.runs) && typeof initial.stats.workflows === 'number' && initial.concurrency === 2,
      JSON.stringify(initial.stats),
    );

    const saveError = await fails('workflows', 'save', { name: 'Bad', nodes: [], edges: [] });
    check('save errors cross IPC with a readable message', /trigger/i.test(saveError), saveError);
    const toolError = await fails('workflows', 'save', {
      name: `Smoke bad tool ${RUN}`,
      nodes: [trigger(), node('tool', 'x', { tool: 'does_not_exist', args: {} })],
      edges: [edge('trigger', 'x')],
    });
    check('unknown tools are rejected in the packaged app', /unknown tool/i.test(toolError), toolError);

    const chain = await ok('workflows', 'save', {
      name: `Smoke chain ${RUN}`,
      description: 'Section 13 smoke',
      enabled: true,
      nodes: [
        trigger(),
        node('tool', 'sys', { tool: 'system_status', args: {}, retry: { attempts: 1, delayMs: 1000 }, onError: 'stop' }, 'System status'),
        node('transform', 'brief', { template: '{{steps.sys.output}}' }, 'Brief'),
        node('notify', 'done', { title: 'Smoke chain', message: '{{steps.brief.output}}' }, 'Notify'),
      ],
      edges: [edge('trigger', 'sys'), edge('sys', 'brief'), edge('brief', 'done')],
    });
    created.push(chain.id);
    check('a workflow saves through IPC with a slug id', chain.id.startsWith(`smoke-chain-${RUN}`) && chain.trigger.type === 'manual', chain.id);
    check('the persisted definition keeps normalized retry settings', chain.nodes.find((n) => n.id === 'sys').config.retry.attempts === 1);

    const cron = await ok('workflows', 'cron', '*/15 * * * *');
    const cronDate = new Date(cron.nextAt);
    check('the cron IPC returns the next aligned run', cronDate.getMinutes() % 15 === 0 && cronDate.getSeconds() === 0 && typeof cron.next === 'string', cron.next);
    const cronError = await fails('workflows', 'cron', 'not a cron');
    check('bad cron expressions report an error', /5 fields/.test(cronError), cronError);

    const registry = await ok('workflows', 'tools');
    const names = registry.tools.map((t) => t.name);
    check('the node inspector gets the real tool registry', names.includes('system_status') && names.includes('http_request') && names.includes('workflow_run'), `${names.length} tools`);

    const tpl = await ok('workflows', 'templates');
    check('templates are available over IPC', tpl.templates.length === 4, tpl.templates.map((t) => t.id).join(', '));

    const run = await ok('workflows', 'run', chain.id);
    createdRuns.push(run.id);
    const finished = await waitRun(run.id, ['succeeded', 'failed']);
    check('a real workflow run succeeds in the app', finished.status === 'succeeded', finished.error || '');
    const detail = await ok('workflows', 'runDetail', run.id);
    check('run detail records every step with outputs', detail.steps.length === 4 && detail.outputs.sys.ok && detail.outputs.brief.output.length > 0, `${detail.steps.length} steps`);
    check(
      'the tool step really executed system_status',
      /— (win32|linux|darwin) /.test(detail.outputs.sys.output) && /threads/.test(detail.outputs.sys.output) && /RAM /.test(detail.outputs.sys.output),
      detail.outputs.sys.output.slice(0, 60).replace(/\n/g, ' '),
    );
    check('the notify step reports delivery', /Notification (sent|unavailable)/.test(detail.outputs.done.output), detail.outputs.done.output.slice(0, 80));

    const agentList = await tool('workflow_list');
    check('the agent can list workflows', agentList.ok && agentList.data.output.includes(chain.name), agentList.ok ? '' : agentList.error);
    const agentRun = await tool('workflow_run', { id: chain.id, input: {} });
    const agentRunId = agentRun.ok ? (/(run_[a-z0-9]+)/.exec(agentRun.data.output) || [])[1] : null;
    check('the agent can queue a workflow run', agentRun.ok && !!agentRunId, agentRun.ok ? agentRun.data.output : agentRun.error);
    if (agentRunId) {
      createdRuns.push(agentRunId);
      const agentDone = await waitRun(agentRunId, ['succeeded', 'failed']);
      check('the agent-queued run reaches a terminal state', ['succeeded', 'failed'].includes(agentDone.status), agentDone.status);
    }
    const agentStatus = await tool('workflow_status', { workflowId: chain.id, limit: 5 });
    check('the agent can read run history', agentStatus.ok && agentStatus.data.output.includes(run.id), agentStatus.ok ? '' : agentStatus.error);
    const cancelFinished = await tool('workflow_cancel', { runId: run.id });
    check('cancelling a finished run is refused', !cancelFinished.ok && /already finished/i.test(cancelFinished.error), cancelFinished.error);

    const failure = await ok('workflows', 'save', {
      name: `Smoke failure ${RUN}`,
      enabled: false,
      nodes: [
        trigger(),
        node('tool', 'call', { tool: 'http_request', args: { method: 'GET', url: 'http://127.0.0.1:1/' }, retry: { attempts: 1, delayMs: 0 }, onError: 'stop' }, 'Dead endpoint'),
      ],
      edges: [edge('trigger', 'call')],
    });
    created.push(failure.id);
    const failRun = await ok('workflows', 'run', failure.id);
    createdRuns.push(failRun.id);
    const failed = await waitRun(failRun.id, ['failed'], 30000);
    check('a failing tool fails the run with the HTTP error', failed.status === 'failed' && /Dead endpoint/.test(failed.error || ''), failed.error);

    const longWf = await ok('workflows', 'save', {
      name: `Smoke cancel ${RUN}`,
      enabled: false,
      nodes: [trigger(), node('delay', 'wait', { ms: 5000 }, 'Wait')],
      edges: [edge('trigger', 'wait')],
    });
    created.push(longWf.id);
    const longRun = await ok('workflows', 'run', longWf.id);
    createdRuns.push(longRun.id);
    await waitRun(longRun.id, ['running'], 10000);
    const cancelled = await ok('workflows', 'cancel', longRun.id);
    check('cancelling a running workflow works over IPC', cancelled.status === 'cancelled' || cancelled.cancelRequested, cancelled.status);
    await waitRun(longRun.id, ['cancelled'], 10000);

    const approvalTpl = await ok('workflows', 'fromTemplate', 'guarded-action');
    created.push(approvalTpl.id);
    const approvalRun = await ok('workflows', 'run', approvalTpl.id);
    createdRuns.push(approvalRun.id);
    const waiting = await waitRun(approvalRun.id, ['awaiting_approval'], 15000);
    const approvalDetail = await ok('workflows', 'runDetail', approvalRun.id);
    check('a template approval gate suspends the real run', waiting.status === 'awaiting_approval' && approvalDetail.suspended.kind === 'approval', approvalDetail.suspended && approvalDetail.suspended.title);
    await ok('workflows', 'approve', approvalRun.id, true);
    const approved = await waitRun(approvalRun.id, ['succeeded', 'failed'], 15000);
    check('approving over IPC finishes the run', approved.status === 'succeeded', approved.error || '');

    if (!process.env.ORVEX_SKIP_SCHEDULE) {
      const scheduled = await ok('workflows', 'save', {
        name: `Smoke schedule ${RUN}`,
        enabled: true,
        nodes: [
          trigger({ type: 'schedule', cron: '* * * * *' }),
          node('notify', 'done', { title: 'Smoke schedule', message: 'tick' }, 'Notify'),
        ],
        edges: [edge('trigger', 'done')],
      });
      created.push(scheduled.id);
      check('a scheduled workflow computes nextRunAt', scheduled.nextRunAt != null && scheduled.nextRunAt <= Date.now() + 60000, new Date(scheduled.nextRunAt).toISOString());
      const start = Date.now();
      let scheduledRun = null;
      while (Date.now() - start < 55000 && !scheduledRun) {
        const data = await ok('workflows', 'runs');
        scheduledRun = data.runs.find((r) => r.workflowId === scheduled.id && r.trigger === 'schedule');
        if (!scheduledRun) await sleep(500);
      }
      check('the running scheduler queues the workflow itself', !!scheduledRun, scheduledRun && scheduledRun.id);
      if (scheduledRun) {
        createdRuns.push(scheduledRun.id);
        await waitRun(scheduledRun.id, ['succeeded', 'failed'], 15000);
      }
      const paused = await ok('workflows', 'setEnabled', scheduled.id, false);
      check('pausing the schedule clears its next run', paused.enabled === false && paused.nextRunAt === null);
    } else {
      console.log('SKIP  live cron tick (ORVEX_SKIP_SCHEDULE=1)');
    }

    const defsFile = path.join(APP_DATA, 'workflows.json');
    const runsFile = path.join(APP_DATA, 'workflow-runs.json');
    let defs = null;
    try {
      defs = JSON.parse(fs.readFileSync(defsFile, 'utf8'));
    } catch {
      defs = null;
    }
    check('workflows.json persists the definitions', !!defs && (defs.workflows || []).some((w) => w.id === chain.id), defs ? `${(defs.workflows || []).length} defs` : 'missing');
    check('workflow-runs.json persists the history', fs.existsSync(runsFile));
  } finally {
    for (const id of created) {
      try {
        await ok('workflows', 'remove', id);
      } catch {
        /* already removed */
      }
      try {
        await ok('workflows', 'clearRuns', id);
      } catch {
        /* ignore */
      }
    }
    const after = await ok('workflows', 'list').catch(() => null);
    if (after) {
      check(
        'smoke workflows and their runs are cleaned up',
        !after.workflows.some((w) => w.name.includes(RUN)) && !after.runs.some((r) => createdRuns.includes(r.id)),
        `${after.stats.workflows} workflow(s) left`,
      );
    }
    try {
      cdp.ws.close();
    } catch {
      /* ignore */
    }
  }
}

(async () => {
  await moduleSuite();
  if (process.env.ORVEX_SKIP_CDP === '1') {
    console.log('SKIP  desktop part (ORVEX_SKIP_CDP=1)');
  } else {
    await cdpSuite();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
})().catch((err) => {
  console.error('\nSmoke aborted:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
