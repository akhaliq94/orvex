'use strict';

/**
 * Phase 6.2 — Local Brain backend smoke.
 * Uses a temporary profile and vault, writes a real GGUF header, and verifies
 * scan/fit/routing/start-error behaviour against the actual machine.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('../electron/db.cjs');
const training = require('../electron/training.cjs');
const brain = require('../electron/local-brain.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-brain-'));
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

function u64(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

function ggufString(value) {
  const bytes = Buffer.from(String(value), 'utf8');
  return Buffer.concat([u64(bytes.length), bytes]);
}

function kvString(key, value) {
  return Buffer.concat([ggufString(key), Buffer.from([8, 0, 0, 0]), ggufString(value)]);
}

function kvU32(key, value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return Buffer.concat([ggufString(key), Buffer.from([4, 0, 0, 0]), buf]);
}

function buildGguf(kvs) {
  const header = Buffer.alloc(4);
  header.write('GGUF', 'utf8');
  const version = Buffer.alloc(4);
  version.writeUInt32LE(3);
  return Buffer.concat([header, version, u64(0), u64(kvs.length), ...kvs]);
}

async function main() {
  db.init({ file: path.join(dataDir, 'orvex.db') });
  training.init({ dataDir, emit: () => {} });
  await training.setRoot(vault);
  brain.init({ dataDir, emit: (event) => events.push(event) });
  await brain.setConfig({ modelsDir: path.join(vault, 'models'), vramGb: 8, prefer: 'offline-only', offline: true, runtimePath: path.join(root, 'missing', 'llama-server.exe') });

  const config = await brain.setConfig({ port: 1, context: 1024, threads: 4, idleMinutes: 0 });
  check('config clamps an out-of-range port', config.port >= 41000, String(config.port));
  check('config keeps offline mode enabled', config.offline === true && config.enabled === true);
  check('manual VRAM override is stored', config.vramGb === 8);

  const modelDir = path.join(vault, 'models');
  fs.writeFileSync(
    path.join(modelDir, 'test-7B-instruct-Q4_K_M.gguf'),
    buildGguf([
      kvString('general.architecture', 'llama'),
      kvString('general.name', 'Smoke Model'),
      kvU32('llama.block_count', 32),
      kvU32('llama.context_length', 4096),
      kvU32('llama.embedding_length', 4096),
      kvU32('llama.attention.head_count', 32),
      kvU32('llama.attention.head_count_kv', 8),
    ]),
  );
  fs.writeFileSync(path.join(modelDir, 'mmproj-test-f16.gguf'), buildGguf([kvString('general.architecture', 'clip')]));

  const scan = await brain.scanModels({ hash: true });
  check('scan finds the model and the projector', scan.models.length === 2, scan.models.map((m) => m.kind).join(','));
  const model = scan.models.find((m) => m.kind === 'model');
  check('GGUF facts are read from the header', model && model.arch === 'llama' && model.blockCount === 32, model && `${model.arch}/${model.blockCount}`);
  check('quantisation and params come from the filename', model && model.quant === 'Q4_K_M' && model.params === 7, model && `${model.quant}/${model.params}B`);
  check('sha256 is computed on request', model && /^[a-f0-9]{64}$/.test(model.sha256 || ''));
  check('fit estimator places the model on the GPU', model && model.fit && model.fit.verdict === 'gpu-full', model && model.fit && `${model.fit.gpuLayers}/${model.fit.layerCount}`);
  check('KV cache estimate is positive', model && model.fit && model.fit.kvBytes > 0, model && model.fit && `${model.fit.kvBytes}`);
  check('the projector is not offered as a chat model', scan.models.find((m) => m.kind === 'projector').kind === 'projector');

  const status = await brain.status();
  check('status reports the manual VRAM budget', status.vram.bytes === 8 * 1024 ** 3 && status.vram.source === 'manual', status.vram.source);
  check('offline routing is blocked without a model', (await brain.route()).target === 'blocked');
  check('no gateway candidate is exposed while stopped', brain.candidate() === null);
  check('chat capability is unavailable with a reason', status.capabilities.chat.available === false && !!status.capabilities.chat.reason, status.capabilities.chat.reason);

  const runtime = await brain.findRuntime();
  if (runtime.found) {
    check('runtime discovery finds llama-server on this machine', true, runtime.path);
  } else {
    check('runtime discovery fails honestly', /llama-server was not found/.test(runtime.reason || ''), runtime.reason);
    await expectError('start refuses without a runtime', () => brain.start(model.id), /llama-server was not found/i);
  }

  check('router prefers cloud while local is stopped in local-first mode', true);
  await brain.setConfig({ prefer: 'local-first', offline: false });
  check('router falls back to cloud when nothing is loaded', (await brain.route()).target === 'cloud');

  const stopped = await brain.stop();
  check('stop is safe when nothing runs', stopped.server.state === 'stopped');
  check('events were emitted', events.some((e) => e.type === 'config') && events.some((e) => e.type === 'runtime'));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('smoke failed:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
