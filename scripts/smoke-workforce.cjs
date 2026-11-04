'use strict';

/**
 * Phase 7 — Digital Workforce smoke.
 * Runs inside Electron-as-Node against a temporary profile. The engine is
 * replaced by a deterministic fake runner so the scheduler, budgets, memory
 * and inbox can be verified without a network model.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const db = require('../electron/db.cjs');
const workforce = require('../electron/workforce.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-workforce-'));
const dataDir = path.join(root, 'profile');
fs.mkdirSync(dataDir, { recursive: true });

let pass = 0;
let fail = 0;
const events = [];
const notes = [];
let engineBusy = false;
let outcome = { ok: true, summary: 'Report written to reports/today.md', steps: 4 };
let usage = { cost: 0, tokens: 0 };
let holdShift = false;
let holdResolver = null;

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

async function expectError(name, fn, pattern) {
  try {
    await fn();
    check(name, false, 'no error was thrown');
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    check(name, !pattern || pattern.test(message), message);
  }
}

async function waitFor(fn, label, ms = 4000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function usageRow(runId) {
  db.raw()
    .prepare('INSERT INTO usage(ts, run_id, task, total_tokens, cost_usd, estimated) VALUES(?, ?, ?, ?, ?, 0)')
    .run(Date.now(), runId, 'agent', usage.tokens, usage.cost);
}

async function main() {
  db.init({ file: path.join(dataDir, 'orvex.db') });
  workforce.init({
    dataDir,
    emit: (event) => events.push(event),
    notify: (note) => notes.push(note),
    runShift: async ({ onRunId }) => {
      engineBusy = true;
      const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      try {
        onRunId(runId);
        usageRow(runId);
        if (holdShift) await new Promise((resolve) => (holdResolver = resolve));
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { ...outcome };
      } finally {
        engineBusy = false;
      }
    },
    isEngineBusy: () => engineBusy,
  });

  const initial = workforce.status();
  check('status starts empty', initial.total === 0 && initial.inFlight === 0 && initial.unread === 0);
  check('scheduler starts stopped', initial.scheduler === false);

  const scout = workforce.createAgent({
    name: 'Research scout',
    role: 'researcher',
    mission: 'Scan the project inbox every weekday and write a short status report.',
    schedule: '0 9 * * 1-5',
    budgetUsd: 2,
    model: {
      providerId: 'openai',
      presetId: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-should-not-be-stored',
    },
  });
  check('agent is created', !!scout.id && scout.name === 'Research scout');
  check('schedule gets a next run', typeof scout.nextRunAt === 'number' && scout.nextRunAt > Date.now());
  check('agent starts active', scout.status === 'active' && scout.budgetBlocked === false);
  check('model assignment keeps the endpoint', scout.model.baseUrl === 'https://api.openai.com/v1');

  const rawModel = db.raw().prepare('SELECT model FROM wf_agents WHERE id = ?').get(scout.id);
  check('the raw row never contains the key', !String(rawModel.model).includes('sk-should-not-be-stored'));

  await expectError('short names are refused', () => workforce.createAgent({ name: 'A', mission: 'Do something useful every day.' }), /name/i);
  await expectError('short missions are refused', () => workforce.createAgent({ name: 'Scout', mission: 'short' }), /mission/i);
  await expectError('invalid cron is refused', () => workforce.createAgent({ name: 'Scout', mission: 'Do something useful.', schedule: '9 *' }), /5 fields/i);
  await expectError('non-http model endpoints are refused', () =>
    workforce.createAgent({ name: 'Scout', mission: 'Do something useful.', model: { baseUrl: 'ftp://x', model: 'm' } }),
  );

  const paused = workforce.pauseAgent(scout.id);
  check('pause clears the next run', paused.status === 'paused' && paused.nextRunAt === null);
  await expectError('a paused agent cannot start', () => workforce.startShift(scout.id), /paused/i);
  const resumed = workforce.resumeAgent(scout.id);
  check('resume restores the schedule', resumed.status === 'active' && typeof resumed.nextRunAt === 'number');

  /* ------------------------------------------------------------ manual shift */

  const shift = workforce.startShift(scout.id);
  check('shift starts immediately', shift.status === 'running' && shift.trigger === 'manual');
  check('shift uses the mission as its goal', shift.goal === scout.mission);
  await expectError('a second shift is refused while one is in flight', () => workforce.startShift(scout.id), /in flight|already/i);
  await expectError('the engine cannot start a different agent while busy', () => {
    const other = workforce.createAgent({ name: 'Second agent', mission: 'Keep an eye on the build queue.' });
    try {
      workforce.startShift(other.id);
    } finally {
      workforce.deleteAgent(other.id);
    }
  }, /engine/i);

  await waitFor(() => workforce.getShift(shift.id).status !== 'running', 'the first shift');
  const done = workforce.getShift(shift.id);
  check('shift finishes done', done.status === 'done', done.status);
  check('shift stores the summary', done.summary === outcome.summary);
  check('shift stores steps and tokens', done.steps === 4 && done.tokens === usage.tokens, `${done.steps}/${done.tokens}`);

  const afterShift = workforce.getAgent(scout.id);
  check('agent counts the run', afterShift.runs === 1 && afterShift.successes === 1);
  check('agent memory records the shift', afterShift.memory.length === 1 && afterShift.memory[0].shiftId === shift.id);
  check('memory note carries the summary', /Report written/.test(afterShift.memory[0].note));
  check('success advances the next cron run', typeof afterShift.nextRunAt === 'number' && afterShift.nextRunAt > Date.now());

  const inbox = workforce.listInbox({});
  check('inbox receives one report', inbox.length === 1 && inbox[0].kind === 'report');
  check('report links to the shift', inbox[0].shiftId === shift.id && inbox[0].agentId === scout.id);
  check('report body carries the real summary', inbox[0].body.includes(outcome.summary));
  check('inbox message starts unread', inbox[0].read === false);
  check('a desktop notification is queued', notes.some((note) => note.title.includes('shift complete')));

  check('shift cannot be finished twice', workforce.finishShift(shift.id, { ok: true, summary: 'again' }).summary === outcome.summary);

  const read = workforce.readInbox({ id: inbox[0].id });
  check('marking one message read works', read.updated === 1 && read.unread === 0);

  /* --------------------------------------------------------------- failure */

  outcome = { ok: false, error: 'The inbox folder was unavailable.', steps: 2 };
  const failed = workforce.startShift(scout.id, { goal: 'Write the Monday report' });
  check('manual goal overrides the mission', failed.goal === 'Write the Monday report');
  await waitFor(() => workforce.getShift(failed.id).status !== 'running', 'the failed shift');
  const failedRow = workforce.getShift(failed.id);
  check('failure is recorded', failedRow.status === 'failed' && /unavailable/.test(failedRow.error));
  const afterFail = workforce.getAgent(scout.id);
  check('failures do not count as successes', afterFail.runs === 2 && afterFail.successes === 1);
  check('failure writes a failure message', workforce.listInbox({}).some((m) => m.kind === 'failure' && m.shiftId === failed.id));

  /* ---------------------------------------------------------------- budget */

  usage = { cost: 0.75, tokens: 900 };
  outcome = { ok: true, summary: 'Budget test shift', steps: 1 };
  const tight = workforce.createAgent({
    name: 'Tight budget',
    role: 'operator',
    mission: 'Do one focused task and stop.',
    budgetUsd: 0.5,
  });
  const tightShift = workforce.startShift(tight.id);
  await waitFor(() => workforce.getShift(tightShift.id).status !== 'running', 'the budget shift');
  const tightAfter = workforce.getAgent(tight.id);
  check('measured cost is added to the agent', tightAfter.spentUsd === 0.75, String(tightAfter.spentUsd));
  check('reaching the budget pauses the agent', tightAfter.status === 'paused' && tightAfter.budgetBlocked === true);
  check('budget pause is emitted', events.some((event) => event.type === 'agent-paused' && event.agentId === tight.id));
  await expectError('a spent agent cannot start', () => workforce.startShift(tight.id), /budget|paused/i);

  const raised = workforce.updateAgent({ id: tight.id, budgetUsd: 5, status: 'active' });
  check('raising the budget and resuming works', raised.status === 'active' && raised.budgetBlocked === false);
  usage = { cost: 0, tokens: 0 };

  /* ---------------------------------------------------------------- delete */

  holdShift = true;
  const heldShift = workforce.startShift(tight.id);
  await expectError('delete is refused while a shift is in flight', () => workforce.deleteAgent(tight.id), /in flight/i);
  holdShift = false;
  holdResolver();
  await waitFor(() => workforce.getShift(heldShift.id).status !== 'running', 'the held shift');
  const removed = workforce.deleteAgent(tight.id);
  check('delete removes the agent', removed.deleted === tight.id && workforce.getAgent(tight.id) === null);
  check('delete removes its shifts', workforce.listShifts({ agentId: tight.id }).length === 0);
  check('delete removes its inbox messages', workforce.listInbox({}).every((m) => m.agentId !== tight.id));

  /* ------------------------------------------------------------- scheduler */

  outcome = { ok: true, summary: 'Scheduled shift ran', steps: 1 };
  const scheduled = workforce.createAgent({
    name: 'Nightly builder',
    role: 'builder',
    mission: 'Run the nightly build and report failures.',
    schedule: '0 2 * * *',
  });
  db.raw().prepare('UPDATE wf_agents SET next_run_at = 0 WHERE id = ?').run(scheduled.id);
  const tickResult = await workforce.tick();
  check('tick starts a due agent', tickResult.started.length === 1, tickResult.skipped || 'started');
  await waitFor(() => workforce.listShifts({ agentId: scheduled.id })[0]?.status === 'done', 'the scheduled shift');
  const scheduledShift = workforce.listShifts({ agentId: scheduled.id })[0];
  check('scheduled shift is marked as cron', scheduledShift.trigger === 'schedule');
  const scheduledAfter = workforce.getAgent(scheduled.id);
  check('scheduler computes the next run', typeof scheduledAfter.nextRunAt === 'number' && scheduledAfter.nextRunAt > Date.now());

  db.raw().prepare('UPDATE wf_agents SET next_run_at = 0 WHERE id = ?').run(scheduled.id);
  engineBusy = true;
  const busyTick = await workforce.tick();
  check('tick skips while the engine is busy', busyTick.skipped === 'engine-busy' && busyTick.started.length === 0);
  engineBusy = false;

  const started = workforce.start();
  check('scheduler can be started', started.scheduler === true && workforce.status().scheduler === true);
  workforce.stop();
  check('scheduler can be stopped', workforce.status().scheduler === false);

  /* ---------------------------------------------------------- status/inbox */

  const status = workforce.status();
  check('status counts agents', status.total === 2 && status.active === 2, `${status.total}/${status.active}`);
  check('status reports spend', Math.abs(status.spent) < 1e-9, String(status.spent));
  check('status reports unread messages', status.unread >= 1, String(status.unread));

  const all = workforce.readInbox({ all: true });
  check('mark all read clears the unread count', all.unread === 0);
  const cleared = workforce.clearInbox();
  check('clear empties the inbox', cleared.removed > 0 && workforce.listInbox({}).length === 0);

  check('workforce events are emitted', events.some((e) => e.type === 'agent-created') && events.some((e) => e.type === 'shift-started'));

  const prompt = workforce.systemAppendFor(workforce.getAgent(scout.id));
  check('shift prompt carries memory and mission', prompt.includes('Research scout') && prompt.includes('Report written'));
  check('shift prompt asks for verification', /verify/i.test(prompt));
  check('the profile database is on disk', fs.existsSync(path.join(dataDir, 'orvex.db')));

  console.log(`\n${pass} passed, ${fail} failed`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      workforce.stop();
    } catch {
      /* already stopped */
    }
    try {
      db.close();
    } catch {
      /* already closed */
    }
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  });
