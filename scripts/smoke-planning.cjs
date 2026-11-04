'use strict';

/**
 * Phase 13 — planning smoke: per-run todos, background sub-agent delegation,
 * unattended tool safety and long-output spill. Runs under Electron-as-Node.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('../electron/db.cjs');
const permissions = require('../electron/permissions.cjs');
const delegates = require('../electron/delegates.cjs');
const planTodos = require('../electron/plan-todos.cjs');
const tools = require('../electron/tools.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-plan-'));
const dataDir = path.join(root, 'profile');
const outputDir = path.join(root, 'tool-outputs');
fs.mkdirSync(dataDir, { recursive: true });

let pass = 0;
let fail = 0;

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

function baseCtx(runId, extra = {}) {
  return {
    runId,
    candidates: [{ baseUrl: 'https://example.test/v1', model: 'test-model' }],
    signal: new AbortController().signal,
    allowDelegation: true,
    ...extra,
  };
}

async function main() {
  db.init({ file: path.join(dataDir, 'orvex.db') });
  permissions.init({ dataDir, registry: () => tools.definitions });
  tools.init({ auditFile: path.join(root, 'audit.jsonl'), outputDir });
  planTodos._reset();
  delegates._reset();

  /* ---------------------------------- todos --------------------------------- */

  const seen = [];
  const added = await tools.runTool('todo_add', { items: [{ title: 'Read the spec' }, { title: 'Write the report' }] }, baseCtx('smoke_todos', { emit: (event) => seen.push(event) }));
  check('todo_add registers items', added.ok && /#\d+ \[ \] Read the spec/.test(added.output), added.error || '');
  check('todo events reach the renderer', seen.some((event) => event.type === 'todos' && event.remaining === 2));
  const dup = await tools.runTool('todo_add', { items: [{ title: 'read the spec' }] }, baseCtx('smoke_todos'));
  check('duplicate open titles are ignored', dup.ok && planTodos.list('smoke_todos').total === 2);
  const ids = planTodos.list('smoke_todos').items.map((item) => item.id);
  const done = await tools.runTool('todo_complete', { ids: [ids[0], 9999], reason: 'verified with fs_read' }, baseCtx('smoke_todos'));
  check('todo_complete reports unknown ids', done.ok && /Missing ids: 9999/.test(done.output), done.error || '');
  check('plan prompt shows one open item', /1 of 2 item\(s\) still open/.test(planTodos.prompt('smoke_todos')));
  const removed = await tools.runTool('todo_remove', { ids: [ids[1]] }, baseCtx('smoke_todos'));
  check('todo_remove deletes an item', removed.ok && planTodos.list('smoke_todos').total === 1);
  const noRun = await tools.runTool('todo_list', {}, {});
  check('todos require a run id', !noRun.ok && /active agent run/i.test(noRun.error), noRun.error || '');
  planTodos.clear('smoke_todos');

  /* -------------------------------- delegation ------------------------------ */

  const noSpawner = await tools.runTool('delegate_start', { goal: 'check logs' }, baseCtx('smoke_parent'));
  check('delegation refuses to start without a spawner', !noSpawner.ok && /not available/i.test(noSpawner.error), noSpawner.error || '');

  const childEvents = [];
  const spawnChild = async ({ goal, agent, signal }) => {
    childEvents.push({ goal, agent, aborted: signal.aborted });
    return { ok: true, summary: `Child finished: ${goal}` };
  };
  delegates.init({ spawn: spawnChild });

  const started = await tools.runTool('delegate_start', { goal: 'summarise the changelog', agent: 'researcher' }, baseCtx('smoke_parent'));
  check('delegate_start returns a task id', started.ok && /Started background sub-agent sub_/.test(started.output), started.error || '');
  const taskId = (started.output.match(/sub_[a-z0-9_]+/) || [])[0];
  const listed = await tools.runTool('delegate_status', {}, baseCtx('smoke_parent'));
  check('delegate_status lists the run\'s task', listed.ok && listed.output.includes(taskId), listed.error || '');
  const waited = await tools.runTool('delegate_wait', { id: taskId, timeoutMs: 5000 }, baseCtx('smoke_parent'));
  check('delegate_wait returns the child result', waited.ok && /done/.test(waited.output) && /summarise the changelog/.test(waited.output), waited.error || '');
  const again = await tools.runTool('delegate_result', { id: taskId }, baseCtx('smoke_parent'));
  check('delegate_result can be read twice', again.ok && /Child finished/.test(again.output), again.error || '');
  check('the child received an abort signal', childEvents.length === 1 && childEvents[0].aborted === false);

  const scoped = await tools.runTool('delegate_status', { id: taskId }, baseCtx('smoke_other'));
  check('tasks stay scoped to their parent run', !scoped.ok && /different run/i.test(scoped.error), scoped.error || '');

  const nested = await tools.runTool('delegate_start', { goal: 'nested' }, baseCtx('smoke_child', { allowDelegation: false }));
  check('a child cannot start another sub-agent', !nested.ok && /cannot start another sub-agent/i.test(nested.error), nested.error || '');

  const slow = new Promise(() => {});
  delegates._setSpawnForTests(() => slow);
  const cancelledStart = await tools.runTool('delegate_start', { goal: 'slow child' }, baseCtx('smoke_parent'));
  const cancelledId = (cancelledStart.output.match(/sub_[a-z0-9_]+/) || [])[0];
  const cancelled = await tools.runTool('delegate_cancel', { id: cancelledId }, baseCtx('smoke_parent'));
  check('delegate_cancel stops a running child', cancelled.ok && /cancelled/.test(cancelled.output), cancelled.error || '');
  delegates.cancelForParent('smoke_parent');
  delegates.clear('smoke_parent');

  delegates.init({
    spawn: spawnChild,
    store: {
      save: (task) => db.delegationSave(task),
      get: (id) => db.delegationGet(id),
      list: (limit) => db.delegationsRecent(limit),
      markResumed: (id, resumedAs) => db.delegationMarkResumed(id, resumedAs),
      interruptOpen: () => db.delegationsInterruptOpen(),
      prune: (keep) => db.delegationPrune(keep),
    },
  });
  db.delegationSave({
    id: 'sub_smoke_interrupted',
    parentRunId: 'smoke_old',
    agent: 'researcher',
    goal: 'finish the interrupted table',
    status: 'interrupted',
    error: 'ORVEX stopped before this sub-agent finished.',
    createdAt: Date.now() - 60_000,
    endedAt: Date.now() - 30_000,
  });
  const queue = await tools.runTool('delegate_queue', {}, baseCtx('smoke_parent'));
  check(
    'delegate_queue lists durable interrupted tasks',
    queue.ok && /sub_smoke_interrupted/.test(queue.output) && /interrupted/.test(queue.output) && /resumable/.test(queue.output),
    queue.error || '',
  );
  const resumed = await tools.runTool('delegate_resume', { id: 'sub_smoke_interrupted' }, baseCtx('smoke_parent'));
  check('delegate_resume re-runs an interrupted task', resumed.ok && /Resumed sub_smoke_interrupted/.test(resumed.output), resumed.error || '');
  const resumedId = (resumed.output.match(/as (sub_[a-z0-9_]+)/) || [])[1];
  const resumedWait = resumedId
    ? await tools.runTool('delegate_wait', { id: resumedId, timeoutMs: 5000 }, baseCtx('smoke_parent'))
    : { ok: false, error: 'no resumed id' };
  check('the resumed task runs to completion', resumedWait.ok && /done/.test(resumedWait.output), (resumedWait.output || resumedWait.error || '').slice(0, 200));
  check(
    'the original durable row links to its resumed run',
    !!resumedId && db.delegationGet('sub_smoke_interrupted').resumedAs === resumedId,
  );
  const blockedResume = await tools.runTool('delegate_resume', { id: 'sub_smoke_interrupted' }, baseCtx('smoke_parent'));
  check('a resumed task cannot be resumed twice', !blockedResume.ok, blockedResume.ok ? 'second resume was accepted' : '');
  const queueAfter = await tools.runTool('delegate_queue', { limit: 5 }, baseCtx('smoke_parent'));
  check('delegate_queue survives without a database error', queueAfter.ok, queueAfter.error || '');

  check('an unattended child may read files', tools.unattendedDenial('fs_read', { path: 'C:/notes.txt' }) === null);
  check('an unattended child cannot kill processes', /cannot ask the user for approval/i.test(tools.unattendedDenial('process_kill', { pid: 1 }) || ''));

  /* ---------------------------------- spill --------------------------------- */

  const marker = 'END-OF-LONG-OUTPUT-MARKER';
  const longFile = path.join(root, 'long.txt');
  fs.writeFileSync(longFile, `${'log row\n'.repeat(2000)}${marker}\n`, 'utf8');
  const long = await tools.runTool('fs_read', { path: longFile }, baseCtx('smoke_spill'));
  check('long output is saved instead of silently cut', long.ok && /full text saved at/i.test(long.output), long.error || '');
  const savedPath = (long.output.match(/saved at (.+?) — use fs_read/i) || [])[1];
  check('the saved file holds the whole output', !!savedPath && fs.existsSync(savedPath) && fs.readFileSync(savedPath, 'utf8').includes(marker));

  const secretFile = path.join(root, 'secret.txt');
  fs.writeFileSync(secretFile, `${'log row\n'.repeat(2000)}sk-proj-ABCDEFGHIJKLMNOPQRSTUV\n`, 'utf8');
  const secret = await tools.runTool('fs_read', { path: secretFile }, baseCtx('smoke_spill'));
  check('credential-like output is never written to disk', secret.ok && /not saved to disk/i.test(secret.output), secret.error || '');

  const oldDir = path.join(outputDir, 'old_run');
  fs.mkdirSync(oldDir, { recursive: true });
  const oldFile = path.join(oldDir, 'old.txt');
  fs.writeFileSync(oldFile, 'old', 'utf8');
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldFile, eightDaysAgo, eightDaysAgo);
  tools.init({ auditFile: path.join(root, 'audit.jsonl'), outputDir });
  check('old spill files are pruned', !fs.existsSync(oldFile));

  delegates._reset();
  planTodos._reset();
  db.close();
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* the profile is deleted by the OS temp cleaner */
  }
  console.log(`\n${pass} passed, ${fail} failed`);
}

main()
  .catch((err) => {
    fail += 1;
    process.exitCode = 1;
    console.log(`FAIL  smoke crashed — ${err && err.stack ? err.stack : err}`);
  })
  .finally(() => process.exit(process.exitCode || 0));
