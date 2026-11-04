'use strict';

/**
 * Phase 6.1 — training vault backend smoke.
 * Runs inside Electron-as-Node against a temporary profile so better-sqlite3
 * loads with the right ABI and the real `F:\Orvex space` vault is untouched.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const db = require('../electron/db.cjs');
const training = require('../electron/training.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-training-'));
const dataDir = path.join(root, 'profile');
const vault = path.join(root, 'vault');
fs.mkdirSync(dataDir, { recursive: true });

let pass = 0;
let fail = 0;
const events = [];

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

async function main() {
  db.init({ file: path.join(dataDir, 'orvex.db') });
  training.init({ dataDir, emit: (event) => events.push(event) });

  const initial = await training.setRoot(vault);
  check('vault root is configurable', initial.root === path.resolve(vault), initial.root);
  check('vault layout is created', initial.layout.every((name) => fs.existsSync(path.join(vault, name))), initial.layout.join(','));
  check('layout marker is written', fs.existsSync(path.join(vault, '.orvex-training.json')));

  const quota = await training.setQuota('2GB');
  check('quota accepts a fitting value', quota.quotaBytes === 2 * 1024 ** 3, training.formatBytes(quota.quotaBytes));

  await expectError('quota refuses more than the drive can hold', () => training.setQuota('999TB'), /can hold|reserve/i);
  await expectError('vault refuses a system folder', () => training.setRoot('C:\\Windows'), /system folder/i);

  const episode = await training.appendEpisode({
    goal: 'write a status report',
    kind: 'agent',
    status: 'done',
    score: 0.9,
    provider: 'local',
    model: 'qwen-test',
    steps: 3,
    promptTokens: 120,
    completionTokens: 80,
    cost: 0.0012,
    plan: { apiKey: 'sk-should-not-appear', steps: ['collect', 'write'] },
    actions: [{ tool: 'fs_write', args: { path: 'report.md' } }],
    outcome: 'report.md written',
  });
  check('episode is indexed', !!episode.id);
  check('episode file is written', episode.file === null || fs.existsSync(path.join(vault, episode.file)), String(episode.file));

  const list = training.listEpisodes({ limit: 10 });
  check('episode is listed', list.length === 1 && list[0].id === episode.id);
  check('episode score is stored', list[0].score === 0.9);

  const detail = training.getEpisode(episode.id);
  check('episode detail parses the plan', detail && detail.plan && detail.plan.steps.length === 2);
  check('episode plan redacts credential keys', detail && detail.plan.apiKey === '[redacted]');
  check('episode outcome is stored', detail && detail.outcome === 'report.md written');

  const raw = db.raw().prepare('SELECT plan FROM train_episodes WHERE id = ?').get(episode.id);
  check('raw row never contains the secret', !String(raw.plan).includes('sk-should-not-appear'));

  const stats = training.episodeStats();
  check('stats count the episode', stats.count === 1 && stats.byKind[0].kind === 'agent');

  const usage = await training.usage(true);
  check('usage scans the vault', usage.root === path.resolve(vault) && usage.totalBytes >= 0);
  check('episodes category sees the log', usage.categories.episodes > 0, training.formatBytes(usage.categories.episodes));

  check('episode events are emitted', events.some((event) => event.type === 'episode'));

  const curve = training.scoreCurve({ days: 30 });
  check('score curve groups the run by day', curve.points.length === 1 && curve.points[0].count === 1, curve.points.map((p) => p.day).join(','));
  check('score curve averages the recorded score', curve.points[0].avgScore === 0.9 && curve.overall.passRate === 1, String(curve.points[0].avgScore));

  const pack = await training.buildEvalPack({ limit: 10, name: 'Smoke pack' });
  check('eval pack freezes the recorded case', pack.cases.length === 1 && pack.cases[0].goal === 'write a status report');
  check('eval pack file is written', fs.existsSync(path.join(vault, pack.path)), pack.path);
  const packFile = JSON.parse(fs.readFileSync(path.join(vault, pack.path), 'utf8'));
  check('eval pack carries explicit criteria', Array.isArray(packFile.criteria) && packFile.criteria.length === 3);
  check('eval pack keeps the recorded outcome', packFile.cases[0].expected.summary === 'report.md written');
  check('eval pack never contains the secret', !fs.readFileSync(path.join(vault, pack.path), 'utf8').includes('sk-should-not-appear'));
  const packs = training.listEvalPacks();
  check('eval pack is indexed', packs.length === 1 && packs[0].cases === 1, packs.map((p) => p.id).join(','));

  const removed = training.deleteEpisode(episode.id);
  check('episode delete removes the index row', removed.removed === 1 && training.listEpisodes({}).length === 0);

  await training.appendEpisode({ goal: 'one', status: 'done' });
  await training.appendEpisode({ goal: 'two', status: 'failed' });
  const cleared = await training.clearEpisodes();
  check('clear removes every episode and log', cleared.removed === 2 && training.listEpisodes({}).length === 0);
  check('clear recreates the episodes folder', fs.existsSync(path.join(vault, 'episodes')));

  const afterClear = await training.status();
  check('status reports a healthy vault', afterClear.exists && !afterClear.overQuota && afterClear.episodes === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  });
