'use strict';

/**
 * Phase 6.4 — learner smoke: nano scorer, skills, Train Kit, GGUF import and
 * the fine-tune guard rails. Runs inside Electron-as-Node on a temp profile.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const db = require('../electron/db.cjs');
const training = require('../electron/training.cjs');
const learner = require('../electron/learner.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-learner-'));
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

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

const fakeBrain = {
  async readGgufMeta(file) {
    const handle = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(24);
      await handle.read(buf, 0, 24, 0);
      if (buf.toString('utf8', 0, 4) !== 'GGUF') return { ok: false, reason: 'Not a GGUF file.' };
      return { ok: true, version: buf.readUInt32LE(4), meta: { 'general.architecture': 'llama' }, size: buf.length };
    } finally {
      await handle.close();
    }
  },
  hashFile: sha256File,
  modelFacts(meta, size) {
    return { arch: meta['general.architecture'] || '', size: Number(size) || 0 };
  },
  async scanModels() {
    return { dir: '', models: [], count: 0 };
  },
};

function synthGguf(file, bytes = 2048) {
  const buf = Buffer.alloc(bytes);
  buf.write('GGUF', 0, 'utf8');
  buf.writeUInt32LE(3, 4);
  buf.writeBigUInt64LE(0n, 8);
  buf.writeBigUInt64LE(0n, 16);
  fs.writeFileSync(file, buf);
}

async function seedEpisodes() {
  const ids = [];
  for (let i = 0; i < 10; i += 1) {
    const done = await training.appendEpisode({
      id: `ep_success_${i}`,
      goal: `write a status report from the logs ${i}`,
      kind: 'agent',
      status: 'done',
      score: 1,
      steps: 3,
      promptTokens: 200,
      completionTokens: 120,
      cost: 0.002,
      plan: { steps: ['collect logs', 'write report'] },
      actions: [
        { type: 'tool', name: 'fs_read', args: { path: 'logs/app.txt', apiKey: 'sk-learner-secret' }, ok: true, ms: 8 },
        { type: 'tool', name: 'fs_write', args: { path: 'report.md' }, ok: true, ms: 12 },
      ],
      outcome: { summary: 'report.md written' },
    });
    ids.push(done.id);
    const failed = await training.appendEpisode({
      id: `ep_failure_${i}`,
      goal: `delete system files and erase the drive ${i}`,
      kind: 'agent',
      status: 'failed',
      score: 0,
      steps: 0,
      promptTokens: 60,
      completionTokens: 10,
      outcome: { summary: 'refused by guardrails' },
      error: 'Blocked by guardrails.',
    });
    ids.push(failed.id);
  }
  return ids;
}

async function main() {
  db.init({ file: path.join(dataDir, 'orvex.db') });
  training.init({ dataDir, emit: (event) => events.push(event) });
  learner.init({ dataDir, brain: fakeBrain, emit: (event) => events.push(event) });
  await training.setRoot(vault);

  const seeded = await seedEpisodes();
  check('seed episodes are recorded', training.listEpisodes({ limit: 50 }).length === 20);

  const early = learner.suggestions().map((item) => item.kind);
  check('suggestions ask for an eval pack', early.includes('eval'), early.join(','));
  check('suggestions ask for a nano scorer', early.includes('train'), early.join(','));
  check('suggestions ask for a skill', early.includes('skill'), early.join(','));

  await expectError('nano trainer needs both outcomes', async () => {
    const raw = db.raw();
    raw.prepare(`UPDATE train_episodes SET status = 'done', score = 1`).run();
    try {
      await learner.trainNano();
    } finally {
      raw.prepare(`UPDATE train_episodes SET status = 'done', score = 1 WHERE goal LIKE 'write a status report%'`).run();
      raw.prepare(`UPDATE train_episodes SET status = 'failed', score = 0 WHERE goal LIKE 'delete system files%'`).run();
    }
  }, /both successful and failed|same outcome/i);

  const trained = await learner.trainNano();
  check('nano scorer trains on recorded runs', trained.samples.total === 20 && trained.model.metrics.accuracy >= 0.75, `${trained.model.metrics.accuracy}`);
  check('nano scorer keeps a holdout when possible', trained.metrics.holdout === true, String(trained.metrics.holdout));
  check('nano scorer beats the majority baseline', trained.metrics.accuracy >= trained.metrics.baseline);
  check('nano model file lands in the vault', fs.existsSync(path.join(vault, trained.path)), trained.path);
  check('first nano model is promoted', trained.promoted === true);
  check('active nano pointer is stored', learner.activeNano()?.id === trained.model.id);
  check('nano model is indexed', learner.nanoModels().length === 1 && learner.nanoModels()[0].status === 'active');

  const good = learner.predictNano({ goal: 'write a status report from the logs now', kind: 'agent', steps: 3, promptTokens: 200, completionTokens: 120 });
  const bad = learner.predictNano({ goal: 'delete system files and erase the drive now', kind: 'agent', steps: 0, promptTokens: 60, completionTokens: 10 });
  check('nano scorer predicts likely success', good && good.verdict === 'likely-success', good && String(good.probability));
  check('nano scorer predicts likely failure', bad && bad.verdict === 'likely-failure', bad && String(bad.probability));

  const second = await learner.trainNano();
  check('an equal model does not replace the active one', second.promoted === false && learner.activeNano()?.id === trained.model.id);

  const rolled = learner.rollbackNano();
  check('rollback clears the single active model', rolled.to === null && learner.activeNano() === null);

  const doneId = seeded[0];
  const skill = learner.compileSkill({ episodeId: doneId });
  check('skill compiles from the recorded run', skill.steps.length === 2 && skill.steps[0].tool === 'fs_read', skill.name);
  check('skill drops credential arguments', !JSON.stringify(skill).includes('sk-learner-secret'));
  check('skill lists the failed-tool avoid rule', Array.isArray(skill.avoid));
  check('skill is listed as suggested', learner.listSkills()[0]?.status === 'suggested');
  learner.setSkillStatus({ id: skill.id, status: 'active' });
  check('active skill reaches the agent catalog', learner.skillCatalog().length === 1 && learner.skillCatalog()[0].includes('2 steps'));
  learner.setSkillStatus({ id: skill.id, status: 'disabled' });
  check('disabled skill leaves the agent catalog', learner.skillCatalog().length === 0);
  await expectError('unknown skill status is refused', () => learner.setSkillStatus({ id: skill.id, status: 'super' }), /must be/i);

  const manual = learner.saveSkill({
    name: 'Read a log tail',
    when: 'when the user asks what changed in a log file today',
    steps: [{ tool: 'fs_read', args: { path: 'C:\\logs\\app.log' } }, { tool: 'fs_write', args: { path: 'summary.md', content: 'done' } }],
    successCheck: 'The summary file exists.',
    avoid: ['Do not read binary files'],
  });
  check('manual skill saves as suggested', manual.status === 'suggested' && manual.steps === 2 && manual.version === '1.0.0', manual.id);
  check('manual skill enters the list', learner.listSkills().some((row) => row.id === manual.id && row.name === 'Read a log tail'));
  await expectError('manual skill needs a when clause', () => learner.saveSkill({ name: 'Short', when: 'no', steps: [{ tool: 'fs_read' }] }), /when this skill applies/);
  await expectError('manual skill needs valid steps', () => learner.saveSkill({ name: 'Bad step', when: 'when a bad step is provided', steps: [{ tool: 'bad tool!' }] }), /valid tool/i);

  const updatedSkill = learner.saveSkill({
    id: manual.id,
    name: 'Read a log tail',
    when: 'when the user asks what changed in a log file today',
    steps: [{ tool: 'fs_read', args: { path: 'C:\\logs\\app.log' } }],
    successCheck: 'The log was read.',
    activate: true,
    status: 'active',
  });
  check('manual skill update bumps the version', updatedSkill.version === '1.0.1' && updatedSkill.status === 'active', updatedSkill.version);
  check('manual skill reaches the agent catalog', learner.skillCatalog().some((line) => line.includes('Read a log tail')));

  const bundle = learner.exportSkill({ id: manual.id });
  check('skill export produces an ORVEX bundle', bundle.format === 'orvex-skill' && bundle.skill.steps.length === 1 && bundle.skill.steps[0].tool === 'fs_read');
  const pack = learner.exportSkills();
  check('skill pack export includes every skill', pack.format === 'orvex-skill-pack' && pack.skills.length >= 2);

  const importedSkill = learner.importSkill({ skill: { ...bundle, name: 'Imported tail' } });
  check('importing a bundle creates a suggested skill', importedSkill.status === 'suggested' && importedSkill.name === 'Read a log tail');
  const importedPack = learner.importSkill({ skill: pack });
  check('importing a pack reports its count', importedPack.count === pack.skills.length);
  await expectError('a non-skill import is refused', () => learner.importSkill({ skill: { hello: 'world' } }), /not an ORVEX skill/i);

  check('learner tools are exported', learner.definitions.some((def) => def.name === 'skill_save') && !!learner.handlers.skill_save);
  check('skill writes are guarded by approval', /future agent prompts/.test(learner.approvalReason('skill_save') || '') && learner.approvalReason('skill_list') === null);

  const kit = await learner.buildTrainKit({ limit: 100, name: 'Smoke kit' });
  check('train kit includes only successful runs', kit.items === 10, String(kit.items));
  const datasetFile = path.join(vault, kit.dataset);
  check('train kit dataset is written', fs.existsSync(datasetFile));
  const lines = fs.readFileSync(datasetFile, 'utf8').trim().split('\n');
  check('train kit emits one chat row per run', lines.length === 10);
  const firstRow = JSON.parse(lines[0]);
  check('train kit rows carry chat messages', Array.isArray(firstRow.messages) && firstRow.messages.length === 3 && firstRow.messages[2].role === 'assistant');
  check('train kit never contains the secret', !fs.readFileSync(datasetFile, 'utf8').includes('sk-learner-secret'));
  const notebook = JSON.parse(fs.readFileSync(path.join(vault, kit.path, 'train.ipynb'), 'utf8'));
  check('notebook is valid nbformat 4', notebook.nbformat === 4 && notebook.cells.length >= 6);
  check('notebook names the free GPU', JSON.stringify(notebook).includes('T4'));
  const manifest = JSON.parse(fs.readFileSync(path.join(vault, kit.path, 'manifest.json'), 'utf8'));
  check('manifest hashes every file', manifest.files.length === 3 && manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  check('train kit is indexed', learner.listTrainKits().length === 1 && learner.listTrainKits()[0].items === 10);

  const gguf = path.join(root, 'tiny.gguf');
  synthGguf(gguf);
  const imported = await learner.importGguf({ source: gguf, name: 'tiny' });
  check('GGUF import copies into the vault', imported.imported === true && fs.existsSync(path.join(vault, imported.path)), imported.path);
  check('GGUF import records the hash', imported.sha256 === (await sha256File(gguf)));
  check('GGUF model is indexed', learner.modelsIndex().length === 1);
  const again = await learner.importGguf({ source: gguf, name: 'tiny' });
  check('duplicate import is detected', again.duplicate === true && learner.modelsIndex().length === 1);

  const notGguf = path.join(root, 'fake.bin');
  fs.writeFileSync(notGguf, Buffer.alloc(2048, 1));
  await expectError('non-GGUF files are refused', () => learner.importGguf({ source: notGguf }), /not a readable GGUF/i);

  await expectError('fine-tune refuses without a saved key', () => learner.finetune({
    providerId: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-test',
    trainKitId: kit.id,
  }), /saved key/i);
  await expectError('fine-tune requires HTTPS', () => learner._internals.normalizeBaseUrl('http://example.com/v1'), /HTTPS/i);
  check('localhost HTTP is allowed for fine-tune', learner._internals.normalizeBaseUrl('http://127.0.0.1:8000/v1') === 'http://127.0.0.1:8000/v1');
  await expectError('dataset outside the vault is refused', () => learner._internals.resolveDataset({ datasetPath: 'C:/Windows/win.ini' }), /inside the training vault/i);

  const cycle = await learner.runCycle();
  const cycleKinds = cycle.actions.map((action) => action.kind);
  check('learning cycle builds the eval pack', cycleKinds.includes('eval'), cycleKinds.join(','));
  check('learning cycle retrains the scorer', cycleKinds.includes('train'), cycleKinds.join(','));
  check('learning cycle compiles skills', cycleKinds.includes('skill'), cycleKinds.join(','));
  check('learning cycle records itself', learner.status().lastCycleAt !== null);

  const status = learner.status();
  check('learner status counts skills and kits', status.skills.total >= 1 && status.kits === 1 && status.nano.active !== null);
  check('learner events are emitted', events.some((event) => event.type === 'nano-promoted') && events.some((event) => event.type === 'kit-built'));

  const removed = await learner.deleteModel(imported.id);
  check('model delete removes the vault file', removed.removed === 1 && !fs.existsSync(path.join(vault, imported.path)));
  check('model index is empty after delete', learner.modelsIndex().length === 0);

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
