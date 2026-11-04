'use strict';

/**
 * Section 18 — core performance benchmarks with real measurements.
 *
 * Runs inside Electron-as-Node so better-sqlite3 uses the Electron ABI:
 *   node scripts/run-electron-smoke.mjs scripts/bench-core.cjs
 *
 * Covers SQLite settings/audit, FTS memory index + search, JSON encode/decode,
 * SHA-256 and scrypt hashing, guardrail path/command checks, CSV parsing,
 * calculator evaluation and real line diffs. Writes a JSON report to reports/.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('../electron/db.cjs');
const memory = require('../electron/memory.cjs');
const files = require('../electron/files.cjs');
const documents = require('../electron/documents.cjs');
const productivity = require('../electron/productivity.cjs');
const guardrails = require('../electron/guardrails.cjs');
const security = require('../electron/security.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-bench-'));
const dataDir = path.join(root, 'profile');
const work = path.join(root, 'work');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(work, { recursive: true });

const results = [];

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function round(n, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

async function bench(suite, name, iterations, fn, opts = {}) {
  const warmup = opts.warmup ?? Math.min(50, Math.max(1, Math.ceil(iterations / 10)));
  for (let i = 0; i < warmup; i += 1) await fn(i);

  const times = [];
  const wallStart = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) {
    const start = process.hrtime.bigint();
    await fn(i);
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  const totalMs = Number(process.hrtime.bigint() - wallStart) / 1e6;
  const sorted = [...times].sort((a, b) => a - b);
  const row = {
    suite,
    name,
    unit: opts.unit || 'op',
    iterations,
    totalMs: round(totalMs),
    opsPerSec: round(totalMs > 0 ? (iterations / totalMs) * 1000 : 0, 1),
    minMs: round(sorted[0], 4),
    p50Ms: round(percentile(sorted, 50), 4),
    p95Ms: round(percentile(sorted, 95), 4),
    p99Ms: round(percentile(sorted, 99), 4),
    maxMs: round(sorted[sorted.length - 1], 4),
  };
  results.push(row);
  console.log(
    `${suite.padEnd(16)} ${name.padEnd(28)} n=${String(iterations).padStart(5)}  ` +
      `p50=${row.p50Ms.toFixed(3)}ms  p95=${row.p95Ms.toFixed(3)}ms  ${row.opsPerSec.toFixed(0)} op/s`,
  );
  return row;
}

function buildCsv(rows) {
  const out = ['id,name,city,note,amount'];
  for (let i = 0; i < rows; i += 1) {
    out.push(`${i},Person ${i},"City, ${i % 90}","He said ""hello ${i}"", then left",${(i % 100) + 0.25}`);
  }
  return out.join('\n');
}

function buildJson(items) {
  const list = [];
  for (let i = 0; i < items; i += 1) {
    list.push({
      id: `item-${i}`,
      name: `Benchmark item ${i}`,
      tags: ['bench', 'orvex', `bucket-${i % 20}`],
      nested: { score: i / 7, ok: i % 2 === 0, note: `row ${i} of ${items}` },
    });
  }
  return { generatedAt: new Date().toISOString(), items: list };
}

(async () => {
  try {
    db.init({ file: path.join(dataDir, 'orvex.db') });
    memory.init({ dataDir, gateway: null });
    await files.init({ dataDir, roots: [{ label: 'Bench', path: work }], emit: () => {} });
    productivity.init({ dataDir, db: db.raw(), gateway: null, memory, creative: null, documents, files: null });

    console.log(`\nORVEX core benchmarks — Electron ${process.versions.electron || 'n/a'} / Node ${process.versions.node}\n`);

    /* ------------------------------------------------------------ SQLite */
    await bench('sqlite', 'settings upsert', 800, (i) =>
      db.setSetting(`bench.key.${i}`, { i, label: `value ${i}`, at: Date.now() }),
    );
    await bench('sqlite', 'settings read', 800, (i) => db.getSetting(`bench.key.${i}`, null));
    await bench('sqlite', 'audit insert', 800, (i) =>
      db.audit({ ts: Date.now(), kind: 'bench', tool: 'bench_tool', ok: true, ms: i % 50 }),
    );
    await bench('sqlite', 'audit tail(50)', 300, () => db.auditTail(50));

    /* ------------------------------------------------------- FTS memory */
    const topics = ['deployment', 'invoice', 'hiring', 'roadmap', 'security', 'release', 'budget', 'customer'];
    const unique = (i) => crypto.createHash('sha1').update(`note-${i}`).digest('hex').slice(0, 8);
    await bench('memory-fts', 'add + index', 400, (i) =>
      memory.add({
        text: `${topics[i % topics.length]} ${unique(i)} decision for project ${unique(i + 1000)} on ${new Date(2026, i % 12, (i % 28) + 1).toISOString().slice(0, 10)}: ${unique(i + 2000)} ${topics[(i + 3) % topics.length]}.`,
        kind: 'fact',
        tags: ['bench', topics[i % topics.length]],
        importance: (i % 10) / 10,
      }),
    );
    await bench('memory-fts', 'add near-duplicate', 150, (i) =>
      memory.add({
        text: `Benchmark note ${i % 40}: deployment decision for project alpha recorded on day ${i % 28}. Similar wording stress for the conflict detector.`,
        kind: 'fact',
        tags: ['bench', 'deployment'],
        importance: 0.5,
      }),
    );
    await bench('memory-fts', 'search', 400, (i) => memory.search(`${topics[i % topics.length]} project ${unique(i + 1000)}`, { limit: 10 }));

    /* ------------------------------------------------------------- JSON */
    const payload = buildJson(2500);
    const jsonText = JSON.stringify(payload);
    await bench('json', 'stringify 2500 items', 200, () => JSON.stringify(payload));
    await bench('json', 'parse 2500 items', 200, () => JSON.parse(jsonText));
    console.log(`\njson payload size: ${round(Buffer.byteLength(jsonText) / 1024, 1)} KiB\n`);

    /* ---------------------------------------------------------- hashing */
    const block = crypto.randomBytes(64 * 1024);
    await bench('hash', 'sha256 64 KiB', 2000, () => crypto.createHash('sha256').update(block).digest('hex'));
    await bench('hash', 'scrypt pin hash', 8, () => security._internals.hashPin('482913', security.SCRYPT), { unit: 'pin' });

    /* ------------------------------------------------------- guardrails */
    await bench('guardrails', 'checkPath allowed temp', 3000, () => guardrails.checkPath(path.join(dataDir, 'file.txt')));
    await bench('guardrails', 'checkPath blocked system', 3000, () => guardrails.checkPath('C:\\Windows\\System32\\config\\SAM'));
    await bench('guardrails', 'checkCommand safe', 5000, () => guardrails.checkCommand('git status --short'));
    await bench('guardrails', 'checkCommand dangerous', 5000, () => guardrails.checkCommand('rm -rf / --no-preserve-root'));
    await bench('guardrails', 'checkUrl https', 5000, () => guardrails.checkUrl('https://api.example.com/v1/items?limit=5'));

    /* -------------------------------------------------------------- CSV */
    const csv = buildCsv(5000);
    await bench('csv', 'parse 5000 rows', 60, () => documents.parseDelimited(csv, ','));
    console.log(`\ncsv payload size: ${round(Buffer.byteLength(csv) / 1024, 1)} KiB\n`);

    /* ------------------------------------------------------- calculator */
    await bench('calc', 'evaluate expression', 5000, () => productivity.calc({ expression: '(123.45 * 67 + 89) / 3 - 12^2 + sqrt(144)' }));

    /* ------------------------------------------------------------- diff */
    const linesA = [];
    const linesB = [];
    for (let i = 0; i < 2000; i += 1) {
      linesA.push(`line ${i} stable content`);
      linesB.push(i % 40 === 0 ? `line ${i} changed content` : `line ${i} stable content`);
    }
    const fileA = path.join(work, 'bench-a.txt');
    const fileB = path.join(work, 'bench-b.txt');
    fs.writeFileSync(fileA, linesA.join('\n'), 'utf8');
    fs.writeFileSync(fileB, linesB.join('\n'), 'utf8');
    await bench('diff', 'diff 2000-line files', 25, () => files.diff({ a: fileA, b: fileB }));

    /* ----------------------------------------------------------- report */
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const report = {
      generatedAt: new Date().toISOString(),
      runtime: {
        electron: process.versions.electron || null,
        node: process.versions.node,
        v8: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
        cpus: os.cpus().length,
        totalMemGb: round(os.totalmem() / 2 ** 30, 1),
      },
      suites: results,
    };
    const reportsDir = path.join(__dirname, '..', 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    const latest = path.join(reportsDir, 'bench-core-latest.json');
    const archived = path.join(reportsDir, `bench-core-${stamp}.json`);
    fs.writeFileSync(latest, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.writeFileSync(archived, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log(`\nreports: ${latest}`);
    console.log(`         ${archived}`);
    console.log(`bench-core: ${results.length} suites measured`);
    process.exitCode = 0;
  } catch (err) {
    console.error(`bench-core failed: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  } finally {
    try {
      await files.close();
    } catch {
      /* not initialised */
    }
    try {
      if (typeof productivity.close === 'function') productivity.close();
    } catch {
      /* not initialised */
    }
    try {
      db.close();
    } catch {
      /* not initialised */
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
})();
