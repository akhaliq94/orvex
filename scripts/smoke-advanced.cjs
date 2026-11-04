'use strict';

/**
 * Section 19 — advanced capabilities backend smoke.
 * Runs inside Electron-as-Node against a temporary profile (better-sqlite3 ABI):
 * privacy modes, proactive rules, self-eval, autonomous jobs with approvals and
 * recovery, measured routing, learning, the sandboxed plugin SDK + marketplace,
 * multi-device pairing/sync and the vision agent.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const archiver = require('archiver');

const db = require('../electron/db.cjs');
const advanced = require('../electron/advanced.cjs');
const collab = require('../electron/collab.cjs');
const plugins = require('../electron/plugins.cjs');
const devices = require('../electron/devices.cjs');
const a2a = require('../electron/a2a.cjs');
const vision = require('../electron/vision.cjs');
const runRecovery = require('../electron/run-recovery.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-adv-'));
const dataDir = path.join(root, 'profile');
fs.mkdirSync(dataDir, { recursive: true });
const dbFile = path.join(dataDir, 'orvex.db');

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

async function expectError(name, fn, pattern) {
  try {
    await fn();
    check(name, false, 'no error was thrown');
    return null;
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    check(name, !pattern || pattern.test(message), message);
    return message;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rawRequest(port, pathName, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathName,
        method,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* non-json body */
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function zipDir(dir) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    archive.directory(dir, false);
    archive.finalize();
  });
}

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  let catalogServer = null;
  const emitted = [];
  const notified = [];
  const approvals = [];
  const gatewayCalls = [];

  try {
    db.init({ file: dbFile });

    console.log('\n— interrupted run recovery');
    const insertRun = (id, status, checkpoint) =>
      db
        .raw()
        .prepare('INSERT INTO runs(id, goal, status, steps, started_at, checkpoint) VALUES(?, ?, ?, 0, ?, ?)')
        .run(id, `goal ${id}`, status, Date.now(), checkpoint ? JSON.stringify(checkpoint) : null);
    const savedPlan = [{ id: 's1', title: 'One', goal: 'do one', status: 'done' }];
    insertRun('smoke-stale', 'running', {
      mode: 'orchestrator',
      status: 'running',
      plan: savedPlan,
      provider: { baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai', model: 'qwen2.5:7b' },
    });
    insertRun('smoke-paused', 'paused', {
      mode: 'orchestrator',
      status: 'paused',
      plan: savedPlan,
      provider: { baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai', model: 'qwen2.5:7b' },
    });
    insertRun('smoke-done', 'ok', null);
    db.raw().prepare("INSERT INTO run_steps(run_id, idx, status) VALUES('smoke-stale', 0, 'running')").run();
    const stale = db.runsMarkStale();
    check('a process restart marks stale runs interrupted', stale.runs === 2 && stale.steps === 1, JSON.stringify(stale));
    const unfinished = db.runsUnfinished(15);
    check(
      'interrupted plans are listed with their parsed checkpoint',
      unfinished.some((run) => run.id === 'smoke-stale' && run.status === 'interrupted' && run.checkpoint?.plan?.length === 1),
      unfinished.map((run) => `${run.id}:${run.status}`).join(', '),
    );
    const target = runRecovery.autoResumeTarget(unfinished);
    check(
      'auto-resume picks the actively running plan, not the paused one',
      target && target.runId === 'smoke-stale' && target.provider.model === 'qwen2.5:7b',
      target ? target.runId : 'no target',
    );

    console.log('\n— github updater and SKILL.md import');
    const updateCore = require('../electron/update-core.cjs');
    const learner = require('../electron/learner.cjs');
    check(
      'the updater accepts owner/name and rejects traversal',
      updateCore.normalizeRepo('https://github.com/acme/orvex-releases.git') === 'acme/orvex-releases' &&
        (() => {
          try {
            updateCore.normalizeRepo('../etc/passwd');
            return false;
          } catch {
            return true;
          }
        })(),
    );
    const picked = updateCore.selectAsset(
      [
        { name: 'ORVEX-Setup-2.0.0.exe', size: 9, url: 'https://example.test/s.exe', digest: `sha256:${'a'.repeat(64)}` },
        { name: 'ORVEX-Portable-2.0.0.exe', size: 8, url: 'https://example.test/p.exe' },
        { name: 'SHA256SUMS.txt', size: 1, url: 'https://example.test/SHA256SUMS.txt' },
      ],
      { portable: false },
    );
    check('the setup build and checksum file are chosen', picked.asset.name.includes('Setup') && !!picked.checksums, picked.asset.name);
    const digest = updateCore.sha256Hex(Buffer.from('installer'));
    check(
      'a matching SHA-256 verifies and a missing one is refused',
      updateCore.verifyHash({ name: 'x.exe', digest: `sha256:${digest}`, actual: digest }).ok &&
        !updateCore.verifyHash({ name: 'x.exe', actual: digest }).ok,
    );
    const markdown = [
      '---',
      'name: smoke-pdf',
      'description: Extract a PDF and write a short reviewed summary.',
      'allowed-tools: doc_extract, fs_write',
      '---',
      '# Smoke PDF',
      'Read the source first.',
      '1. tool: doc_extract {"path":"C:/docs/a.pdf"}',
      '',
      '## Success check',
      'The summary file exists.',
      '',
    ].join('\n');
    const importedSkill = learner.importSkill({ text: markdown });
    const importedPrompt = importedSkill.id ? learner.skillPrompt(importedSkill.id) : '';
    check(
      'SKILL.md imports as a suggested skill with instructions',
      importedSkill.name === 'smoke-pdf' && importedSkill.status === 'suggested' && importedSkill.steps === 1 && /Instructions:[\s\S]*Read the source first/.test(importedPrompt || ''),
      `${importedSkill.name} (${importedSkill.steps} step)`,
    );
    if (importedSkill.id) learner.deleteSkill({ id: importedSkill.id });

    console.log('\n— game pilot loop');
    const gamePilot = require('../electron/game-pilot.cjs');
    const keysPressed = [];
    const recordedRuns = [];
    let finishedEvent = null;
    let finishResolve;
    const pilotFinished = new Promise((resolve) => {
      finishResolve = resolve;
    });
    gamePilot.init({
      platform: 'win32',
      desktop: {
        windowList: async () => ({ ok: true, windows: [{ title: 'Smoke Game', foreground: true, hwnd: 7, pid: 70 }] }),
        screenCapture: async () => ({ ok: true, file: 'smoke-shot.png', width: 800, height: 600 }),
        keyPress: async ({ keys }) => {
          keysPressed.push(keys);
          return { ok: true, output: `pressed ${keys}` };
        },
        windowAction: async () => ({ ok: true }),
      },
      ocr: async () => ({ ok: true, text: '' }),
      ask: async () => '{"action":"key","key":"SPACE"}',
      record: async (payload) => {
        recordedRuns.push(payload);
        return payload;
      },
      emit: (event) => {
        if (event.type === 'finished') {
          finishedEvent = event;
          finishResolve();
        }
      },
      isStopped: () => false,
      registerHotkey: () => true,
      unregisterHotkey: () => {},
    });
    const pilotProfile = gamePilot.saveProfile({
      name: 'Smoke pilot',
      windowTitle: 'Smoke Game',
      policy: 'macro',
      macro: [{ keys: 'SPACE' }, { keys: 'ENTER' }],
      intervalMs: 500,
      maxMinutes: 1,
    });
    check('a pilot profile is normalized and stored', pilotProfile.id.startsWith('game_') && pilotProfile.macro.length === 2, pilotProfile.id);
    const startedPilot = gamePilot.start(pilotProfile.id);
    check('a macro run starts and registers the stop shortcut', startedPilot.running === true && startedPilot.hotkeyRegistered === true, startedPilot.hotkey);
    await expectError(
      'starting a second run while one is active is refused',
      async () => gamePilot.start(pilotProfile.id),
      /already active/i,
    );
    await sleep(1300);
    gamePilot.stop();
    await Promise.race([pilotFinished, sleep(4000)]);
    check(
      'the loop pressed only keys from the macro',
      keysPressed.length >= 2 && keysPressed.every((key) => key === 'SPACE' || key === 'ENTER'),
      keysPressed.join(', ') || 'nothing pressed',
    );
    check(
      'the stopped run is recorded as a cancelled training episode',
      recordedRuns.length === 1 && recordedRuns[0].kind === 'manual' && recordedRuns[0].status === 'cancelled' && recordedRuns[0].outcome.ticks >= 1,
      recordedRuns.length ? `${recordedRuns[0].status}, ${recordedRuns[0].steps} steps` : 'no episode',
    );
    check(
      'the finished event explains why the run stopped',
      finishedEvent && /stopped by the user/i.test(finishedEvent.stopReasonLabel || ''),
      finishedEvent ? finishedEvent.stopReasonLabel : 'no event',
    );
    gamePilot.deleteProfile(pilotProfile.id);
    check('the pilot profile is deletable after the run', !gamePilot.listProfiles().some((p) => p.id === pilotProfile.id));

    const runTool = async (name) => {
      if (name === 'process_kill') return { ok: true, output: 'killed pid 4242', ms: 5 };
      if (name === 'fs_list') return { ok: true, output: 'alpha.txt\nbeta.txt', ms: 3 };
      if (name === 'clipboard_read') return { ok: true, output: 'copied text', ms: 2 };
      return { ok: false, output: '', error: `No tool named "${name}".`, ms: 0 };
    };

    advanced.init({
      gateway: null,
      runTool,
      toolDefinitions: () => [{ name: 'fs_list' }, { name: 'process_kill' }, { name: 'clipboard_read' }],
      approvalReason: (name) => (name === 'process_kill' ? 'This stops a running program.' : null),
      approve: async (req) => {
        approvals.push(req);
        return false;
      },
      emit: (event) => emitted.push(event),
      notify: (payload) => notified.push(payload),
      metrics: async () => ({ ok: true, cpuPercent: 91, memory: { percent: 55 }, disk: { percent: 40 }, uptimeSec: 1000 }),
      clipboard: async () => ({ ok: true, kind: 'text', text: 'copy of https://example.com/page' }),
      idleSeconds: () => 500,
      online: () => true,
      version: () => '1.0.0',
    });

    plugins.init({ dataDir, emit: (event) => emitted.push(event), toolsChanged: () => {} });
    collab.init({
      gateway: {
        chat: async ({ task }) => {
          gatewayCalls.push(task);
          return { text: `Contribution ${gatewayCalls.length} from a real gateway call.`, provider: { name: 'Fake', model: 'smoke-model' } };
        },
      },
      planCandidates: advanced.planCandidates,
      emit: (event) => emitted.push(event),
    });

    console.log('\n— privacy modes');
    await expectError('an unknown mode is rejected', () => advanced.setMode('turbo'), /Unknown mode/);
    const localFirst = advanced.setMode('local-first');
    check('local-first mode persists', localFirst.mode === 'local-first' && db.getSetting('advanced.mode') === 'local-first', localFirst.mode);
    const candidates = [
      { id: 'cloud', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', name: 'Cloud' },
      { id: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen2.5-7b', name: 'LM Studio' },
    ];
    const sensitivePlan = advanced.planCandidates(candidates, { task: 'agent', prompt: 'Summarize my private notes', sensitive: true });
    check('a sensitive task in local-first keeps only the local endpoint', sensitivePlan.candidates.length === 1 && sensitivePlan.candidates[0].id === 'lmstudio', sensitivePlan.reason);
    const normalPlan = advanced.planCandidates(candidates, { task: 'agent', prompt: 'Write a haiku' });
    check('local-first tries the local model before cloud', normalPlan.candidates[0].id === 'lmstudio' && normalPlan.candidates.length === 2, normalPlan.reason);

    advanced.setMode('offline');
    const offlinePlan = advanced.planCandidates(candidates, { task: 'agent' });
    check('offline drops every hosted endpoint', offlinePlan.candidates.length === 1 && offlinePlan.candidates[0].id === 'lmstudio', offlinePlan.reason);
    const offlineCloudOnly = advanced.planCandidates([candidates[0]], { task: 'agent' });
    check('offline with only cloud candidates is refused honestly', offlineCloudOnly.candidates.length === 0 && /no local endpoint/i.test(offlineCloudOnly.reason), offlineCloudOnly.reason);

    advanced.setMode('hybrid');
    const hybridCode = advanced.planCandidates(candidates, { task: 'code', prompt: 'Refactor this module' });
    check('hybrid escalates a code task to cloud first', hybridCode.candidates[0].id === 'cloud', hybridCode.reason);
    const hybridChat = advanced.planCandidates(candidates, { task: 'chat', prompt: 'Say hello' });
    check('hybrid keeps a light chat task local first', hybridChat.candidates[0].id === 'lmstudio', hybridChat.reason);
    const cloudMode = advanced.setMode('cloud');
    check('cloud mode restores the configured order', cloudMode.mode === 'cloud' && !cloudMode.localOnly, cloudMode.mode);

    console.log('\n— proactive rules');
    await expectError('a rule with an unknown condition is rejected', () => advanced.saveRule({ condition: { type: 'vibes' }, action: { type: 'notify' } }), /Condition must be one of/);
    await expectError('a rule missing its target is rejected', () => advanced.saveRule({ condition: { type: 'idle_minutes', minutes: 5 }, action: { type: 'run_tool' } }), /run_tool needs tool/);
    const idleRule = advanced.saveRule({ name: 'Idle reminder', condition: { type: 'idle_minutes', minutes: 5 }, action: { type: 'notify' }, cooldownSec: 30 });
    check('a valid rule is stored', advanced.listRules().some((r) => r.id === idleRule.id && r.enabled), idleRule.id);
    const firstTick = await advanced.tick();
    check('the ticker fires the idle rule from real signals', firstTick.fired === 1 && notified.length === 1 && /ORVEX · Idle reminder/.test(notified[0].title), `${firstTick.fired} fired`);
    const events = advanced.ruleEvents(10);
    check('the rule event is recorded', events.some((e) => e.ruleId === idleRule.id && e.ok === 1), events[0] && events[0].detail);
    const secondTick = await advanced.tick();
    check('the cooldown prevents an immediate re-fire', secondTick.fired === 0, `${secondTick.fired} fired`);
    advanced.setRuleEnabled(idleRule.id, false);
    check('a disabled rule shows as disabled', !advanced.listRules().find((r) => r.id === idleRule.id).enabled, 'disabled');
    advanced.deleteRule(idleRule.id);
    check('a rule can be deleted', !advanced.listRules().some((r) => r.id === idleRule.id), 'removed');

    const mutating = advanced.saveRule({ name: 'Clipboard kill', condition: { type: 'clipboard_contains', text: 'example.com' }, action: { type: 'run_tool', tool: 'process_kill' } });
    await advanced.tick();
    const mutatingEvent = advanced.ruleEvents(10).find((e) => e.ruleId === mutating.id);
    check('a proactive rule cannot run a mutating tool', mutatingEvent && mutatingEvent.ok === 0 && /read-only tools/.test(mutatingEvent.detail), mutatingEvent && mutatingEvent.detail);
    advanced.deleteRule(mutating.id);

    console.log('\n— self-evaluation');
    await expectError('an empty output cannot be evaluated', () => advanced.selfEval({ goal: 'x', output: '   ' }), /no output to evaluate/i);
    const evalRun = await advanced.selfEval({
      goal: 'Explain the quarterly numbers',
      output: '1. Revenue grew 18%.\n2. Costs fell 4%.\n3. Sources: https://example.com/report with complete detail for the board.',
    });
    check('the heuristic review returns a bounded score', evalRun.score > 0 && evalRun.score <= 1 && evalRun.method === 'heuristic', `score ${evalRun.score}`);
    const history = advanced.selfEvalHistory(10);
    check('the self-eval is stored in history', history.some((h) => h.id === evalRun.id), `${history.length} evaluation(s)`);
    const placeholder = await advanced.selfEval({ goal: 'Write a report', output: 'TODO: lorem ipsum placeholder text that should not pass.' });
    check('placeholder output is penalised', placeholder.score < 0.7 && placeholder.issues.some((i) => /placeholder/i.test(i)), `score ${placeholder.score}`);

    console.log('\n— autonomous jobs');
    await expectError('a job needs at least one step', () => advanced.createJob({ steps: [] }), /at least one step/);
    await expectError('a job with an unknown tool is rejected', () => advanced.createJob({ steps: [{ tool: 'format_disk' }] }), /Unknown tool/);
    const longSpec = Array.from({ length: 60 }, () => ({ tool: 'fs_list' }));
    const cappedJob = advanced.createJob({ title: 'Too many steps', steps: longSpec });
    check('a job is capped at 50 steps', cappedJob.spec.steps.length === 50, `${cappedJob.spec.steps.length} steps`);
    advanced.deleteJob(cappedJob.id);

    const readOnly = advanced.createJob({ title: 'List twice', steps: [{ tool: 'fs_list', label: 'first' }, { tool: 'fs_list', args: { path: 'C:\\Users' } }] });
    const finished = await advanced.startJob(readOnly.id, { wait: true });
    check('a read-only job runs every step', finished.status === 'done' && finished.results.length === 2 && finished.results.every((r) => r.ok), `${finished.results.length}/2 steps`);
    check('the checkpoint reaches the last step', finished.checkpoint === 2, `checkpoint ${finished.checkpoint}`);

    const dangerous = advanced.createJob({ title: 'Kill a process', steps: [{ tool: 'process_kill', args: { pid: 4242 } }] });
    const denied = await advanced.startJob(dangerous.id, { wait: true });
    check('a risky step asks for approval first', approvals.length === 1 && approvals[0].id === `${dangerous.id}:0` && /stops a running program/.test(approvals[0].reason), approvals[0] && approvals[0].reason);
    check('a declined approval fails the job with the reason', denied.status === 'failed' && /Declined: This stops a running program/.test(denied.error), denied.error);

    db.raw().prepare("UPDATE adv_jobs SET status = 'interrupted' WHERE id = ?").run(readOnly.id);
    const recovery = advanced.recoveryOverview();
    check('recovery lists the interrupted job', recovery.jobs.some((j) => j.id === readOnly.id && j.steps === 2), `${recovery.jobs.length} job(s)`);
    const discarded = advanced.discardRecovery({ kind: 'job', id: readOnly.id });
    check('discarding recovery cancels the job', discarded && discarded.status === 'cancelled', discarded && discarded.status);
    await expectError('resuming an unknown recovery kind is refused', () => advanced.resumeRecovery({ kind: 'spacecraft', id: 'x' }), /Unknown recovery kind/);
    advanced.deleteJob(readOnly.id);
    advanced.deleteJob(dangerous.id);

    console.log('\n— adaptive routing');
    advanced.recordOutcome({ task: 'agent', providerId: 'p1', model: 'gpt-4o', ok: true, ms: 1200 });
    advanced.recordOutcome({ task: 'agent', providerId: 'p1', model: 'gpt-4o', ok: true, ms: 900 });
    advanced.recordOutcome({ task: 'agent', providerId: 'p1', model: 'gpt-4o', ok: false, ms: 3000 });
    advanced.recordOutcome({ task: 'agent', providerId: 'p2', model: 'tiny-1b', ok: false, ms: 400 });
    const stats = advanced.routeStats('agent', 30);
    const gpt = stats.find((s) => s.model === 'gpt-4o');
    check('measured route stats count calls and success', gpt && gpt.calls === 3 && gpt.okRate === 0.67 && gpt.p50Ms === 1200, gpt && `${gpt.calls} calls · ${gpt.okRate} ok · p50 ${gpt.p50Ms}ms`);
    const ranked = advanced.recommendRoute({
      task: 'agent',
      candidates: [
        { id: 'p1', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', name: 'OpenAI' },
        { id: 'p2', baseUrl: 'http://127.0.0.1:1234/v1', model: 'tiny-1b', name: 'Local tiny' },
      ],
    });
    check('routing ranks the measured winner first', ranked.ranked[0].model === 'gpt-4o' && ranked.ranked[0].reliability === 0.67, ranked.ranked.map((r) => `${r.model}:${r.score}`).join(', '));
    const applied = advanced.applyRoute({ task: 'agent', chain: [{ providerId: 'p1', model: 'gpt-4o' }] });
    check('an approved route is written to the gateway config', applied.chain.length === 1 && db.getRouting().agent[0].model === 'gpt-4o', JSON.stringify(db.getRouting().agent));

    console.log('\n— personal workflow learning');
    for (const runId of ['learn-run-a', 'learn-run-b', 'learn-run-c']) {
      db.audit({ kind: 'tool', tool: 'fs_list', runId, ok: true });
      db.audit({ kind: 'tool', tool: 'clipboard_read', runId, ok: true });
    }
    for (let i = 0; i < 3; i += 1) {
      db.recordUsage({ task: 'chat', providerId: 'p1', providerName: 'OpenAI', model: 'gpt-4o-mini', ok: true, totalTokens: 500, ms: 800 });
    }
    const mined = advanced.mineLearning({ days: 30 });
    const workflowSuggestion = advanced.listLearning('suggested').find((l) => l.kind === 'workflow');
    check('repeat tool sequences become a workflow suggestion', workflowSuggestion && workflowSuggestion.support >= 2 && workflowSuggestion.detail.steps.join('>') === 'fs_list>clipboard_read', workflowSuggestion && `support ${workflowSuggestion.support}`);
    const routeSuggestion = advanced.listLearning('suggested').find((l) => l.kind === 'routing' && l.key === 'route:chat');
    check('a reliable provider becomes a routing suggestion', !!routeSuggestion && routeSuggestion.detail.chain[0].model === 'gpt-4o-mini', routeSuggestion && `${routeSuggestion.detail.calls} calls`);
    const approvedLearning = advanced.approveLearning(routeSuggestion.id);
    check('approving a routing suggestion applies it', approvedLearning.applied && db.getRouting().chat[0].model === 'gpt-4o-mini', JSON.stringify(db.getRouting().chat));
    advanced.dismissLearning(workflowSuggestion.id);
    check('a dismissed suggestion leaves the queue', advanced.listLearning('suggested').every((l) => l.id !== workflowSuggestion.id), `${mined.suggested} suggested`);

    console.log('\n— plugin SDK (sandboxed)');
    const sourceDir = path.join(root, 'plugin-src');
    fs.mkdirSync(sourceDir, { recursive: true });
    const manifest = {
      id: 'smoke-demo',
      name: 'Smoke Demo',
      version: '1.0.0',
      description: 'Exercises the plugin permission sandbox.',
      author: 'ORVEX tests',
      entry: 'index.js',
      tools: [
        { name: 'read_own', description: 'Read the plugin folder.', parameters: { type: 'object', properties: {} } },
        { name: 'write_data', description: 'Write the plugin data folder.', parameters: { type: 'object', properties: {} } },
        { name: 'read_outside', description: 'Attempt to read outside the sandbox.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
        { name: 'spawn', description: 'Attempt to spawn a child process.', parameters: { type: 'object', properties: {} } },
        { name: 'net_probe', description: 'Attempt an outbound request.', parameters: { type: 'object', properties: {} } },
      ],
    };
    fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      path.join(sourceDir, 'index.js'),
      [
        "'use strict';",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        'exports.run = async (tool, args, api) => {',
        "  if (tool === 'read_own') return fs.readFileSync(path.join(api.pluginDir, 'manifest.json'), 'utf8');",
        "  if (tool === 'write_data') { fs.mkdirSync(api.dataDir, { recursive: true }); fs.writeFileSync(path.join(api.dataDir, 'note.txt'), 'plugin wrote this'); return 'wrote'; }",
        "  if (tool === 'read_outside') return fs.readFileSync(String(args.path), 'utf8');",
        "  if (tool === 'spawn') { require('node:child_process').execSync('echo hi'); return 'spawned'; }",
        "  if (tool === 'net_probe') { require('node:http').get('http://127.0.0.1:9/', () => {}); return 'requested'; }",
        "  return { ok: false, error: 'unknown tool ' + tool };",
        '};',
      ].join('\n'),
    );
    const outside = path.join(root, 'outside-secret.txt');
    fs.writeFileSync(outside, 'top secret outside file');

    await expectError('a folder without a manifest is refused', () => plugins.installFromDir(path.join(root, 'missing')), /manifest.json/);
    const installed = await plugins.installFromDir(sourceDir);
    check('a local plugin installs', installed.id === 'smoke-demo' && installed.tools.length === 5, `${installed.id}@${installed.version}`);
    check('an undeclared plugin gets no network', installed.permissions?.network === 'none', String(installed.permissions?.network));
    const defs = plugins.toolDefinitions();
    check('plugin tools join the tool registry', defs.some((d) => d.name === 'plugin__smoke-demo__read_own'), `${defs.length} plugin tool(s)`);
    check('the approval text names the third-party plugin', /third-party plugin "Smoke Demo"/.test(plugins.pluginApproval('plugin__smoke-demo__read_own') || ''), plugins.pluginApproval('plugin__smoke-demo__read_own'));

    const readOwn = await plugins.callTool('plugin__smoke-demo__read_own');
    check('a plugin tool runs in its child process', readOwn.ok && readOwn.output.includes('"id": "smoke-demo"'), readOwn.ok ? 'manifest returned' : readOwn.error);
    const wrote = await plugins.callTool('plugin__smoke-demo__write_data');
    const dataFile = path.join(dataDir, 'plugin-data', 'smoke-demo', 'note.txt');
    check('the plugin can write only its data folder', wrote.ok && fs.existsSync(dataFile) && fs.readFileSync(dataFile, 'utf8') === 'plugin wrote this', wrote.output || wrote.error);
    const deniedRead = await plugins.callTool('plugin__smoke-demo__read_outside', { path: outside });
    check('reading outside the sandbox is denied', !deniedRead.ok && /denied|permission|restricted|EACCES|ERR_ACCESS/i.test(deniedRead.error || ''), deniedRead.error);
    const deniedSpawn = await plugins.callTool('plugin__smoke-demo__spawn');
    check('spawning a child process is denied', !deniedSpawn.ok && /denied|permission|restricted|ERR_ACCESS/i.test(deniedSpawn.error || ''), deniedSpawn.error);
    const deniedNet = await plugins.callTool('plugin__smoke-demo__net_probe');
    check('network access is denied unless declared', !deniedNet.ok && /not allowed|ORVEX_NETWORK_DENIED/i.test(deniedNet.error || ''), deniedNet.error);
    const unknownTool = await plugins.callTool('plugin__smoke-demo__not_declared');
    check('undeclared plugin tools are refused', !unknownTool.ok && /not declared/.test(unknownTool.error), unknownTool.error);
    plugins.setEnabled('smoke-demo', false);
    const disabled = await plugins.callTool('plugin__smoke-demo__read_own');
    check('a disabled plugin cannot run', !disabled.ok && /disabled/.test(disabled.error), disabled.error);
    plugins.setEnabled('smoke-demo', true);
    check('a plugin uninstalls from disk and DB', (await plugins.uninstall('smoke-demo')).removed === 1 && !plugins.listPlugins().some((p) => p.id === 'smoke-demo'), 'removed');

    console.log('\n— tool marketplace (sha256 enforced)');
    const emptyCatalog = await plugins.catalog();
    check('marketplace reports no catalog configured', emptyCatalog.configured === false && /No catalog URL/.test(emptyCatalog.note), emptyCatalog.note);
    const catalogCore = require('../electron/catalog.cjs');
    const zip = await zipDir(sourceDir);
    const realSha = crypto.createHash('sha256').update(zip).digest('hex');
    let listedSha = 'a'.repeat(64);
    const catalogItem = (port) => ({
      id: 'smoke-demo',
      name: 'Smoke Demo',
      version: '1.0.0',
      description: 'Zip install test.',
      author: 'orvex-smoke',
      url: `http://127.0.0.1:${port}/demo.zip`,
      sha256: listedSha,
      tools: ['read_own'],
    });
    let catalogBody = null;
    catalogServer = http.createServer((req, res) => {
      if (req.url === '/catalog.json') {
        const body = catalogBody ? catalogBody(catalogServer.address().port) : JSON.stringify([catalogItem(catalogServer.address().port)]);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
        return;
      }
      if (req.url === '/demo.zip') {
        res.writeHead(200, { 'content-type': 'application/zip' });
        res.end(zip);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => catalogServer.listen(0, '127.0.0.1', resolve));
    const catalogUrl = `http://127.0.0.1:${catalogServer.address().port}/catalog.json`;
    plugins.setCatalogUrl(catalogUrl);
    await expectError('a wrong sha256 blocks the install', () => plugins.installFromCatalog('smoke-demo'), /sha256 mismatch/);
    check('nothing was installed from the bad archive', !plugins.listPlugins().some((p) => p.id === 'smoke-demo'), 'not installed');
    listedSha = realSha;
    const fromCatalog = await plugins.installFromCatalog('smoke-demo');
    check('the verified archive installs', fromCatalog.id === 'smoke-demo' && /\/demo\.zip$/.test(fromCatalog.source), `${fromCatalog.source}`);
    const catalogState = await plugins.catalog({ refresh: true });
    check('the marketplace marks the plugin as installed', catalogState.items.some((i) => i.id === 'smoke-demo' && i.installed), `${catalogState.items.length} catalog item(s)`);
    await plugins.uninstall('smoke-demo');

    console.log('\n— signed catalog authenticity (Ed25519)');
    listedSha = realSha;
    const keyPair = crypto.generateKeyPairSync('ed25519');
    const publicPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' });
    const privatePem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const keyFingerprint = catalogCore.fingerprint(publicPem);
    const signBody = (pluginsList, keyId = 'smoke-key', pem = privatePem) => JSON.stringify(catalogCore.signCatalog(pluginsList, { privateKeyPem: pem, keyId }));
    catalogBody = (port) => signBody([catalogItem(port)]);

    const trusted = plugins.setCatalogKeys(JSON.stringify([{ keyId: 'smoke-key', publicKey: publicPem }]));
    check('a trusted key stores only its id and fingerprint', trusted.keys.length === 1 && trusted.keys[0].keyId === 'smoke-key' && trusted.keys[0].fingerprint === keyFingerprint && !JSON.stringify(trusted).includes('BEGIN PUBLIC KEY'), trusted.keys[0] && `${trusted.keys[0].keyId} ${trusted.keys[0].fingerprint}`);
    plugins.setRequireSignature(true);
    check('signature enforcement is remembered', plugins.requireSignature() === true, 'required');

    const signedState = await plugins.catalog({ refresh: true });
    check('a correctly signed catalog is accepted', !signedState.error && signedState.signed === true && signedState.items.length === 1, signedState.error || `${signedState.items.length} item(s)`);
    check('the accepted catalog reports the signing key', signedState.keyId === 'smoke-key' && signedState.fingerprint === keyFingerprint, `${signedState.keyId} ${signedState.fingerprint}`);
    const signedInstall = await plugins.installFromCatalog('smoke-demo');
    check('a plugin installs from a signed catalog', signedInstall.id === 'smoke-demo' && /\/demo\.zip$/.test(signedInstall.source), signedInstall.source);
    await plugins.uninstall('smoke-demo');

    const tamperedEnvelope = JSON.parse(catalogBody(catalogServer.address().port));
    tamperedEnvelope.payload = tamperedEnvelope.payload.replace(realSha, 'b'.repeat(64));
    catalogBody = () => JSON.stringify(tamperedEnvelope);
    const tamperedState = await plugins.catalog({ refresh: true });
    check('a tampered payload fails the signature check', !tamperedState.items.length && /signature does not match/i.test(tamperedState.error || ''), tamperedState.error);

    catalogBody = (port) => JSON.stringify([catalogItem(port)]);
    const unsignedState = await plugins.catalog({ refresh: true });
    check('an unsigned catalog is refused when signatures are required', !unsignedState.items.length && /unsigned/i.test(unsignedState.error || ''), unsignedState.error);

    const otherKeys = crypto.generateKeyPairSync('ed25519');
    const otherPem = otherKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
    catalogBody = (port) => signBody([catalogItem(port)], 'impostor-key', otherPem);
    const unknownState = await plugins.catalog({ refresh: true });
    check('a catalog signed by an untrusted key is refused', !unknownState.items.length && /unknown key/i.test(unknownState.error || ''), unknownState.error);

    plugins.setCatalogKeys('');
    catalogBody = (port) => signBody([catalogItem(port)]);
    const noKeyState = await plugins.catalog({ refresh: true });
    check('a signed catalog without a trusted key is refused', !noKeyState.items.length && /no trusted catalog key/i.test(noKeyState.error || ''), noKeyState.error);

    plugins.setRequireSignature(false);
    plugins.setCatalogKeys('');
    catalogBody = (port) => JSON.stringify([catalogItem(port)]);
    const unsignedAllowed = await plugins.catalog({ refresh: true });
    check('unsigned catalogs load again once enforcement is off', !unsignedAllowed.error && unsignedAllowed.signed === false && unsignedAllowed.items.length === 1, unsignedAllowed.error || 'unsigned accepted');
    plugins.setCatalogUrl('');

    console.log('\n— multi-device pairing and sync');
    devices.init({ emit: (event) => emitted.push(event), version: () => '1.0.0' });
    devices.setName('Smoke Host');
    const hostPort = 43000 + Math.floor(Math.random() * 20000);
    const hostStart = devices.startHost({ port: hostPort });
    await sleep(350);
    check('the host starts and shows a 6 digit pair code', hostStart.code && /^\d{6}$/.test(hostStart.code.code) && devices.hostStatus().hosting, `port ${devices.hostStatus().port}`);
    const noHeader = await rawRequest(hostPort, '/orvex/pair', { method: 'POST', body: { code: '000000' } });
    check('a request without the sync header is refused', noHeader.status === 403, `HTTP ${noHeader.status}`);
    const openBundle = await rawRequest(hostPort, '/orvex/bundle', { headers: { 'x-orvex-sync': '1' } });
    check('the bundle endpoint refuses unpaired callers', openBundle.status === 401, `HTTP ${openBundle.status}`);
    await expectError('a wrong pairing code is refused', () => devices.pair({ host: '127.0.0.1', port: hostPort, code: '000000' }), /wrong or expired/);
    const paired = await devices.pair({ host: '127.0.0.1', port: hostPort, code: hostStart.code.code });
    check('pairing returns a token and the host identity', !!paired.device && paired.device.name === 'Smoke Host', paired.device.name);
    const linked = devices.listDevices();
    check('the paired host is stored locally', linked.length === 1 && linked[0].port === hostPort, linked[0] && `${linked[0].name}:${linked[0].port}`);
    const storedToken = db.raw().prepare('SELECT token FROM adv_devices WHERE id = ?').get(linked[0].id).token;
    const wrongToken = await rawRequest(hostPort, '/orvex/bundle', { headers: { 'x-orvex-sync': '1', authorization: 'Bearer not-a-paired-token' } });
    check('an unpaired bearer token cannot read the bundle', wrongToken.status === 401, `HTTP ${wrongToken.status}`);
    const authed = await rawRequest(hostPort, '/orvex/bundle', { headers: { 'x-orvex-sync': '1', authorization: `Bearer ${storedToken}` } });
    check('a paired token reads the bundle', authed.status === 200 && authed.json && !!authed.json.bundle, `HTTP ${authed.status}`);
    const hello = await devices.check(linked[0].id);
    check('the device answers hello', hello.ok && hello.device.name === 'Smoke Host', hello.device.id);

    db.raw().prepare('INSERT INTO prompts(id, title, body, tags, created_at) VALUES(?, ?, ?, ?, ?)').run('prompt_smoke', 'Release checklist', 'Build, sign, publish.', 'release', Date.now());
    const bundle = devices.buildBundle();
    const settingKeys = Object.keys(bundle.settings);
    check('the sync bundle only carries whitelisted settings', settingKeys.length === 1 && settingKeys[0] === 'advanced.mode', settingKeys.join(', '));
    check('the bundle has an integrity hash and no token', /^[a-f0-9]{64}$/.test(bundle.sha256) && !JSON.stringify(bundle).includes('vault') && !JSON.stringify(bundle).includes('apiKey'), `${bundle.sha256.slice(0, 12)}…`);
    check('the bundle carries prompts and agents but no secrets', bundle.prompts.some((p) => p.id === 'prompt_smoke') && bundle.agents.length >= 5 && !JSON.stringify(bundle).includes('token'), `${bundle.prompts.length} prompt(s), ${bundle.agents.length} agent(s)`);
    const tampered = devices.buildBundle();
    tampered.prompts.push({ id: 'evil', title: 'Evil', body: 'x' });
    await expectError('a tampered bundle fails its integrity check', () => devices.applyBundle(tampered), /integrity check/);
    const savedMode = db.getSetting('advanced.mode', 'cloud');
    db.setSetting('advanced.mode', 'root-shell');
    const badMode = devices.buildBundle();
    const modeResult = devices.applyBundle(badMode);
    check('a peer cannot force an unknown privacy mode', modeResult.settings === 0 && db.getSetting('advanced.mode', 'cloud') === 'root-shell', JSON.stringify(modeResult));
    db.setSetting('advanced.mode', savedMode);

    const pulled = await devices.pull(linked[0].id);
    check('pulling applies the host bundle', pulled.applied.settings >= 1 && pulled.applied.prompts >= 1, JSON.stringify(pulled.applied));
    const pushed = await devices.push(linked[0].id);
    check('pushing sends this bundle to the host', pushed.applied && typeof pushed.applied.agents === 'number', JSON.stringify(pushed.applied));
    check('sync actions are logged', devices.syncLog(10).filter((l) => l.ok === 1).length >= 2, `${devices.syncLog(10).length} log row(s)`);
    check('unpairing drops the device', devices.unpair(linked[0].id).removed === 1 && devices.listDevices().length === 0, 'unpaired');
    const stopped = devices.stopHost();
    check('hosting stops cleanly', !stopped.hosting && !stopped.code, 'stopped');

    console.log('\n— agent-to-agent (A2A)');
    const a2aCalls = [];
    const a2aRun = async ({ goal, signal }) => {
      a2aCalls.push(goal);
      if (goal.includes('fail this')) throw new Error('The model refused this request.');
      if (goal.includes('slow')) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 4000);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
            },
            { once: true },
          );
        });
      }
      return `peer reply to: ${goal}`;
    };
    a2a.init({ version: () => '1.0.0', emit: (event) => emitted.push(event), run: a2aRun });
    const a2aPort = hostPort + 1;
    a2a.hostStart({ port: a2aPort, expose: 'loopback' });
    await sleep(250);
    const a2aState = a2a.status();
    check('the A2A host answers on loopback only', a2aState.hosting && a2aState.port === a2aPort && a2aState.expose === 'loopback' && a2aState.url === `http://127.0.0.1:${a2aPort}/a2a`, a2aState.url);
    const a2aCard = await rawRequest(a2aPort, '/.well-known/agent-card.json');
    check(
      'the public agent card claims no desktop control and no streaming',
      a2aCard.status === 200 && a2aCard.json.name === 'ORVEX' && a2aCard.json.metadata.pcControlForPeers === false && a2aCard.json.capabilities.streaming === false && a2aCard.json.skills.length >= 4,
      `${a2aCard.json.name} ${a2aCard.json.version}`,
    );
    const rpc = (body, headers = { 'x-orvex-a2a': '1', authorization: `Bearer ${a2aState.token}` }) => rawRequest(a2aPort, '/a2a', { method: 'POST', headers, body });
    const sendBody = (id, text, extra = {}) => ({ jsonrpc: '2.0', id, method: 'message/send', params: { message: { role: 'user', parts: [{ kind: 'text', text }] }, metadata: { peer: 'smoke-peer', ...extra } } });
    const a2aNoHeader = await rawRequest(a2aPort, '/a2a', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: {} } });
    check('a client without the ORVEX header is refused', a2aNoHeader.status === 403, `HTTP ${a2aNoHeader.status}`);
    const noToken = await rpc(sendBody(2, 'hello'), { 'x-orvex-a2a': '1' });
    check('a request without a bearer token is refused', noToken.status === 401, `HTTP ${noToken.status}`);
    const badToken = await rpc(sendBody(3, 'hello'), { 'x-orvex-a2a': '1', authorization: `Bearer ${'f'.repeat(64)}` });
    check('a wrong bearer token is refused', badToken.status === 401, `HTTP ${badToken.status}`);
    const wrongShape = await rpc({ jsonrpc: '1.0', id: 4, method: 'message/send' });
    check('a non JSON-RPC 2.0 body is rejected', wrongShape.status === 400 && wrongShape.json.error.code === -32600, String(wrongShape.json && wrongShape.json.error && wrongShape.json.error.message));
    const sent = await rpc(sendBody(5, 'Summarise the release'));
    const sentTask = sent.json && sent.json.result;
    check(
      'a text task completes and returns a reply artifact',
      sent.status === 200 && sentTask && sentTask.status.state === 'completed' && /peer reply to: Summarise/.test(sentTask.artifacts[0].parts[0].text),
      sentTask ? `${sentTask.id} ${sentTask.status.state}` : JSON.stringify(sent.json),
    );
    const fetched = await rpc({ jsonrpc: '2.0', id: 6, method: 'tasks/get', params: { id: sentTask.id } });
    check('the finished task is durable through tasks/get', fetched.json.result && fetched.json.result.status.state === 'completed' && fetched.json.result.id === sentTask.id, fetched.json.result && fetched.json.result.id);
    const missing = await rpc({ jsonrpc: '2.0', id: 7, method: 'tasks/get', params: { id: 'a2a_missing' } });
    check('an unknown task id returns a JSON-RPC error', missing.json.error && missing.json.error.code === -32001, missing.json.error && missing.json.error.message);
    const filePart = await rpc({ jsonrpc: '2.0', id: 8, method: 'message/send', params: { message: { role: 'user', parts: [{ kind: 'file', file: { uri: 'file:///etc/passwd' } }] } } });
    check('non-text parts are rejected instead of guessed at', filePart.json.error && filePart.json.error.code === -32602 && /Only text parts/.test(filePart.json.error.message), filePart.json.error && filePart.json.error.message);
    const unknownMethod = await rpc({ jsonrpc: '2.0', id: 9, method: 'tasks/list', params: {} });
    check('an unsupported method is named back to the caller', unknownMethod.json.error && unknownMethod.json.error.code === -32601, unknownMethod.json.error && unknownMethod.json.error.message);
    const failedTask = await rpc(sendBody(10, 'please fail this'));
    check('a model failure becomes a failed task with the real error', failedTask.json.result.status.state === 'failed' && /refused this request/.test(failedTask.json.result.status.message.parts[0].text), failedTask.json.result.status.message.parts[0].text);
    const slowCall = rpc(sendBody(11, 'slow work'));
    await sleep(300);
    const activeId = a2a.listTasks({ limit: 1, direction: 'inbound' })[0].id;
    const canceled = await rpc({ jsonrpc: '2.0', id: 12, method: 'tasks/cancel', params: { id: activeId } });
    const slowResult = await slowCall;
    check('an in-flight task can be canceled by its caller', canceled.json.result.status.state === 'canceled' && slowResult.json.result.status.state === 'canceled', `${activeId} → ${slowResult.json.result.status.state}`);
    await expectError('a peer URL must be http(s)', () => a2a.addPeer({ name: 'bad', url: 'ftp://127.0.0.1:1', token: 'a'.repeat(64) }), /http/i);
    await expectError('a peer token must be 32+ hex characters', () => a2a.addPeer({ name: 'bad', url: `http://127.0.0.1:${a2aPort}`, token: 'short' }), /hex/i);
    const peer = a2a.addPeer({ name: 'Loopback peer', url: `http://127.0.0.1:${a2aPort}`, token: a2aState.token });
    const peerList = a2a.listPeers();
    check('a saved peer surfaces a masked token only', peerList.length === 1 && peer.tokenPreview.endsWith(a2aState.token.slice(-4)) && !JSON.stringify(peerList).includes(a2aState.token), peer.tokenPreview);
    const outbound = await a2a.send(peer.id, 'hello from smoke');
    check(
      'a task sent to a saved peer round-trips over JSON-RPC',
      outbound.task.status.state === 'completed' && /peer reply to: hello from smoke/.test(outbound.task.artifacts[0].parts[0].text),
      outbound.task.id,
    );
    const wrongPeer = a2a.addPeer({ name: 'Wrong token', url: `http://127.0.0.1:${a2aPort}`, token: 'e'.repeat(64) });
    const rejected = await a2a.send(wrongPeer.id, 'should fail');
    check('a wrong peer token never reaches the model', !!rejected.error && rejected.task.status.state === 'failed' && /Bearer|401/.test(rejected.error), rejected.error);
    a2a.removePeer(wrongPeer.id);
    const remoteCard = await a2a.fetchCard(`http://127.0.0.1:${a2aPort}`);
    check('a peer card is readable before saving it', remoteCard.card.name === 'ORVEX' && remoteCard.card.skills.length >= 4, remoteCard.card.name);
    const rotated = a2a.rotateToken();
    const oldToken = await rawRequest(a2aPort, '/a2a', { method: 'POST', headers: { 'x-orvex-a2a': '1', authorization: `Bearer ${a2aState.token}` }, body: sendBody(13, 'old token') });
    check('rotating the token invalidates the previous one', oldToken.status === 401 && rotated.token !== a2aState.token, `HTTP ${oldToken.status}`);
    db.raw()
      .prepare("INSERT INTO adv_a2a_tasks(id, context_id, direction, peer, goal, status, created_at, updated_at) VALUES('a2a_stale0001', 'ctx_stale', 'inbound', 'peer', 'stale', 'working', ?, ?)")
      .run(Date.now(), Date.now());
    a2a.init({ version: () => '1.0.0', emit: (event) => emitted.push(event), run: a2aRun });
    check('a task interrupted by a restart is reported failed', a2a.getTask('a2a_stale0001').status.state === 'failed' && /restarted/.test(a2a.getTask('a2a_stale0001').status.message.parts[0].text), 'normalized');
    a2a.hostStop();
    check('the A2A host stops cleanly', !a2a.status().hosting, 'stopped');

    console.log('\n— multi-agent collaboration');
    check('the built-in agent roster is seeded', collab.listAgents().length >= 5, `${collab.listAgents().length} agents`);
    await expectError('a session needs a goal', () => collab.startSession({}), /Describe the goal/);
    await expectError('the synthesizer alone cannot run', () => collab.startSession({ goal: 'x', agentIds: ['synthesizer'] }), /working agent/);
    await expectError('no candidates is reported honestly', () => collab.startSession({ goal: 'x', agentIds: ['planner'] }), /No model|candidates/);
    const candidate = { id: 'fake', baseUrl: 'http://127.0.0.1:1234/v1', model: 'smoke-model', name: 'Fake' };
    const session = await collab.startSession({ goal: 'Plan the release', agentIds: ['planner', 'builder'], rounds: 2, candidates: [candidate] }, { wait: true });
    check('a session completes through the gateway', session.status === 'done' && !!session.result, session.status);
    const expected = 2 * 2 + 1;
    check('every worker speaks each round and the synthesizer closes', session.messages.length === expected, `${session.messages.length}/${expected} messages`);
    check('gateway calls match the transcript', gatewayCalls.length === expected, `${gatewayCalls.length} calls`);
    check('the synthesizer produces the final answer', session.messages[session.messages.length - 1].role === 'synthesizer', session.messages[session.messages.length - 1].agent);
    await expectError('a short agent prompt is rejected', () => collab.saveAgent({ name: 'Helper', prompt: 'short' }), /at least 20 characters/);
    const custom = collab.saveAgent({ name: 'Helper', role: 'worker', prompt: 'Help the team with precise, concrete details and no filler.' });
    check('a custom agent saves', collab.listAgents().some((a) => a.id === custom.id), custom.id);
    collab.deleteAgent(custom.id);
    collab.deleteSession(session.id);
    check('a session can be deleted', !collab.listSessions(10).some((s) => s.id === session.id), 'removed');

    console.log('\n— computer vision');
    const imagePath = path.join(root, 'pixel.png');
    fs.writeFileSync(imagePath, Buffer.from(PNG_1X1, 'base64'));
    vision.init({
      gateway: null,
      ocr: async () => ({ ok: true, text: 'HELLO FROM OCR', lines: ['HELLO FROM OCR'], lang: 'en', width: 1, height: 1 }),
    });
    const noModel = await vision.analyze({ path: imagePath, prompt: 'What is on screen?' });
    check('without a model the OCR text is still returned', noModel.analysis === null && noModel.ocr && noModel.ocr.text === 'HELLO FROM OCR' && /No vision model is configured/.test(noModel.note), noModel.note.slice(0, 60));
    const camera = await vision.analyze({ dataUrl: `data:image/png;base64,${PNG_1X1}`, ocr: false });
    check('a camera data URL is accepted', camera.source === 'camera' && camera.bytes > 0 && camera.analysis === null, `${camera.bytes} bytes`);
    await expectError('a blocked system image path is refused', () => vision.readImageFile('C:\\Windows\\win.ini'), /Blocked|not allowed/i);
    await expectError('screen capture without a connector is reported', () => vision.captureScreen({}), /not connected/i);
    vision.init({
      gateway: { chat: async () => ({ text: 'A single white pixel.', provider: { name: 'Fake', model: 'vision-1' } }) },
      ocr: async () => ({ ok: true, text: 'HELLO', lines: ['HELLO'] }),
    });
    const analyzed = await vision.analyze({ path: imagePath, candidates: [candidate] });
    check('a configured vision model describes the image', analyzed.analysis === 'A single white pixel.' && analyzed.model === 'Fake · vision-1', analyzed.model);

    console.log('\n— status roll-up');
    const state = advanced.status();
    check('the status roll-up reports the live counts', state.mode.mode === 'cloud' && state.jobs >= 0 && state.selfEvals >= 2 && state.version === '1.0.0', JSON.stringify({ mode: state.mode.mode, jobs: state.jobs, evals: state.selfEvals }));
    check('events were emitted for the UI', emitted.some((e) => e.type === 'job-created') && emitted.some((e) => e.type === 'rule-fired') && emitted.some((e) => e.type === 'device-paired'), `${emitted.length} event(s)`);

    console.log(`\nadvanced backend smoke: ${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
  } catch (err) {
    console.error('FATAL', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  } finally {
    try {
      plugins.stopAll();
    } catch {
      /* best effort */
    }
    try {
      devices.stop();
    } catch {
      /* best effort */
    }
    try {
      a2a.hostStop();
    } catch {
      /* best effort */
    }
    try {
      advanced.stopRules();
    } catch {
      /* best effort */
    }
    try {
      if (catalogServer) await new Promise((resolve) => catalogServer.close(resolve));
    } catch {
      /* best effort */
    }
    try {
      db.close();
    } catch {
      /* best effort */
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* temp cleanup */
    }
  }
})();
