'use strict';

/**
 * Memory backend end-to-end test: schema migration, FTS5 + local embeddings,
 * hybrid search, CRUD, tags/pinning, expiry, conflicts and resolution, links,
 * profile, agent context, RAG (LLM + extractive + failure), legacy import,
 * persistence and FTS reindex.
 *
 * Run: node scripts/run-electron-smoke.mjs scripts/smoke-memory.cjs
 * (Electron-as-Node is required because better-sqlite3 is built for Electron.)
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const db = require('../electron/db.cjs');
const memory = require('../electron/memory.cjs');

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `got ${a}, expected ${e}`);
}

async function expectThrow(name, fn, includes) {
  try {
    await fn();
    check(name, false, 'did not throw');
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    check(name, !includes || message.includes(includes), message);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-memory-smoke-'));
  const dbFile = path.join(dir, 'memory.db');
  const legacyFile = path.join(dir, 'memory.md');
  fs.writeFileSync(
    legacyFile,
    ['# ORVEX memory', '- 2026-10-01 — User keeps projects in D:\\dev', '- Prefers concise replies', 'not a bullet'].join('\n'),
    'utf8',
  );

  const fakeCalls = [];
  const fakeGateway = {
    chat: async (opts) => {
      fakeCalls.push(opts);
      return {
        text: 'You prefer dark mode [M1].',
        provider: { id: 'fake', name: 'Fake Provider', model: 'fake-1' },
        model: 'fake-1',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        ms: 4,
      };
    },
  };
  const uncitedGateway = {
    chat: async () => ({
      text: 'You seem to like dark themes.',
      provider: { id: 'fake', name: 'Fake Provider', model: 'fake-1' },
      model: 'fake-1',
    }),
  };
  const failingGateway = {
    chat: async () => {
      throw new Error('provider exploded');
    },
  };

  db.init({ file: dbFile });
  const info = memory.init({ dataDir: dir, legacyFile, gateway: null });
  check('init reports ready', info.ready === true, info.error);
  eq('embedding dimensions', info.dimensions, 256);

  const raw = db.raw();
  const cols = new Set(raw.prepare('PRAGMA table_info(memory_items)').all().map((c) => c.name));
  for (const col of ['project', 'status', 'pinned', 'embedding', 'meta', 'last_used_at', 'use_count']) {
    check(`schema has column ${col}`, cols.has(col));
  }
  check('conflict table exists', !!raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_conflicts'").get());
  check('links table exists', !!raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_links'").get());

  section('legacy import');
  const legacyItems = memory.list({ kind: 'legacy' });
  eq('imports two bullet notes', legacyItems.length, 2);
  check('strips date prefix', legacyItems.some((i) => i.text === 'User keeps projects in D:\\dev'));
  check('keeps plain bullet', legacyItems.some((i) => i.text === 'Prefers concise replies'));
  check('ignores non-bullet lines', !legacyItems.some((i) => i.text.startsWith('not a bullet')));

  section('create and validate');
  const dark = memory.add({
    text: 'User prefers dark mode',
    kind: 'preference',
    project: 'ui',
    tags: ['theme', 'theme', 'ui'],
    importance: 0.8,
    source: 'user',
  });
  check('add returns an id', /^mem_/.test(dark.id));
  eq('tag dedupe', dark.tags, ['theme', 'ui']);
  eq('status active', dark.status, 'active');
  eq('project stored', dark.project, 'ui');
  check('embedding not leaked in API', !('embedding' in dark));

  const duplicate = memory.add({ text: '  user PREFERS   dark mode ', importance: 0.95 });
  eq('duplicate reuses id', duplicate.id, dark.id);
  eq('duplicate flagged', duplicate.duplicate, true);
  check('duplicate raises importance', memory.get(dark.id).importance >= 0.95);

  const light = memory.add({
    text: 'User prefers light mode',
    kind: 'preference',
    project: 'ui',
    tags: ['theme'],
    importance: 0.7,
  });
  eq('near-duplicate creates one conflict', light.conflicts, 1);

  const projectItem = memory.add({
    text: 'ORVEX project lives in D:\\orvex qoder and uses Electron',
    kind: 'project',
    project: 'orvex',
    importance: 0.9,
    pinned: false,
  });
  const personItem = memory.add({ text: "The user's dog is named Pixel", kind: 'person', project: 'personal' });
  const deployItem = memory.add({
    text: 'Deploy checklist: run tsc then package the app',
    kind: 'procedure',
    project: 'orvex',
    tags: ['deploy'],
    importance: 0.7,
    pinned: true,
  });
  const standup = memory.add({ text: 'Team standup happens every Monday at 10 AM', kind: 'event', project: 'work' });
  const clamped = memory.add({ text: 'Overclamped importance note', importance: 5 });
  eq('importance clamps to 1', clamped.importance, 1);
  const unknownKind = memory.add({ text: 'Unknown kind defaults to fact', kind: 'made-up' });
  eq('unknown kind becomes fact', unknownKind.kind, 'fact');
  eq('unknown project normalizes', memory.add({ text: 'Projectless note', project: '  ' }).project, '');

  await expectThrow('empty text rejected', () => memory.add({ text: '   ' }), 'empty');
  await expectThrow('oversized text rejected', () => memory.add({ text: 'x'.repeat(20001) }), '20000');
  await expectThrow('unknown status rejected', () => memory.update(dark.id, { status: 'zombie' }), 'status');

  section('list and filters');
  const prefs = memory.list({ kind: 'preference' });
  eq('kind filter', prefs.length, 2);
  eq('project filter', memory.list({ project: 'ui' }).length, 2);
  eq('tag filter', memory.list({ tag: 'theme' }).length, 2);
  eq('pinned filter', memory.list({ pinned: true }).map((i) => i.id), [deployItem.id]);
  eq('status filter empty', memory.list({ status: 'superseded' }).length, 0);
  check('pinned sorts first', memory.list()[0]?.id === deployItem.id);
  check('all statuses include active', memory.list({ status: 'all' }).length >= 10);
  check('limit respected', memory.list({ limit: 3 }).length === 3);

  section('hybrid search');
  const darkHits = memory.search('dark mode', { limit: 4 });
  eq('dark search top hit', darkHits[0]?.id, dark.id);
  check('search exposes scores', typeof darkHits[0]?.score === 'number' && darkHits[0].score > 0);
  eq('pixel search', memory.search('what is the dog called')[0]?.id, personItem.id);
  eq('tag search finds both theme notes', memory.search('theme', { limit: 10, kind: 'preference' }).length, 2);
  const orvexHits = memory.search('electron', { project: 'orvex' });
  check('search project filter returns results', orvexHits.length > 0);
  eq('search project filter stays in project', orvexHits.every((h) => h.project === 'orvex'), true);
  const personHits = memory.search('pixel', { kind: 'person' });
  eq('search kind filter top hit', personHits[0]?.id, personItem.id);
  check('search kind filter stays in kind', personHits.every((h) => h.kind === 'person'));
  check('search tracks recall count', memory.get(dark.id).useCount >= 1);
  eq('empty query falls back to list', memory.search('', { limit: 3 }).length, 3);
  const nonsense = memory.search('quantum flux capacitor hyperdrive');
  check('nonsense search finds nothing', nonsense.length === 0, JSON.stringify(nonsense.map((h) => h.text)));

  section('update');
  const updated = memory.update(personItem.id, { text: 'The user owns a dog named Pixel', tags: ['pets'], importance: 0.65 });
  eq('text updated', updated.text, 'The user owns a dog named Pixel');
  eq('tags updated', updated.tags, ['pets']);
  check('fts reflects new text', memory.search('pixel')[0]?.id === personItem.id);
  check('new text searchable', memory.search('owns a dog').some((h) => h.id === personItem.id));
  const archived = memory.update(standup.id, { status: 'archived' });
  eq('archive status', archived.status, 'archived');
  check('archived hidden from active list', !memory.list().some((i) => i.id === standup.id));
  check('archived hidden from search', !memory.search('standup').some((h) => h.id === standup.id));
  const restored = memory.update(standup.id, { status: 'active' });
  eq('restore status', restored.status, 'active');
  check('restored searchable', memory.search('standup').some((h) => h.id === standup.id));

  section('stats and expiry');
  memory.add({ text: 'Trial license ends tomorrow', kind: 'event', project: 'ops', expiresAt: Date.now() + 2 * 24 * 3600 * 1000 });
  const expiring = memory.stats();
  eq('expiring within 7 days', expiring.expiring, 1);
  check('projects summarized', expiring.projects.some((p) => p.project === 'ui'));
  check('kinds summarized', expiring.kinds.some((k) => k.kind === 'preference'));
  check('link count present', expiring.links >= 1, String(expiring.links));
  const past = memory.add({ text: 'Temporary expired fact', kind: 'fact', expiresAt: Date.now() - 60000 });
  eq('past add starts active until sweep', memory.get(past.id).status, 'active');
  const swept = memory.sweep();
  eq('sweep expires one', swept.expired, 1);
  eq('expired item marked', memory.get(past.id).status, 'expired');
  check('expired hidden from list', !memory.list().some((i) => i.id === past.id));
  check('expired hidden from search', !memory.search('temporary expired fact').some((h) => h.id === past.id));
  eq('expired counted', memory.stats().expired, 1);
  eq('sweep is idempotent', memory.sweep().expired, 0);

  section('conflicts');
  let openConflicts = memory.conflicts();
  check('near-duplicate conflict recorded', openConflicts.some((c) => c.reason === 'similar' && c.itemA && c.itemB));
  check('conflict carries score', openConflicts[0].score > 0);
  const negated = memory.add({ text: 'User never prefers dark mode', kind: 'preference', project: 'ui' });
  openConflicts = memory.conflicts();
  check('negation conflict recorded', openConflicts.some((c) => c.reason === 'negation'));
  const beforeDup = openConflicts.length;
  const dupAgain = memory.add({ text: 'User prefers light mode', kind: 'preference', project: 'ui' });
  eq('exact duplicate flagged', dupAgain.duplicate, true);
  eq('duplicate adds no conflict', memory.conflicts().length, beforeDup);

  const darkLight = memory
    .conflicts()
    .find(
      (c) =>
        (c.itemA?.id === dark.id && c.itemB?.id === light.id) || (c.itemA?.id === light.id && c.itemB?.id === dark.id),
    );
  check('dark/light conflict found', !!darkLight);
  const keep = darkLight.itemA.id === dark.id ? 'a' : 'b';
  const resolved = memory.resolveConflict(darkLight.id, `keep_${keep}`);
  eq('conflict resolved status', resolved.status, 'resolved');
  eq('resolution recorded', resolved.resolution, `keep_${keep}`);
  eq('loser superseded', memory.get(light.id).status, 'superseded');
  check('superseded hidden from search', !memory.search('light mode').some((h) => h.id === light.id));
  await expectThrow('cannot resolve twice', () => memory.resolveConflict(darkLight.id, 'keep_a'), 'already resolved');
  await expectThrow('unknown resolution rejected', () => memory.resolveConflict(memory.conflicts()[0].id, 'nuke'));

  const build = memory.add({ text: 'Deploy: build with npm run build', kind: 'procedure', project: 'deploy' });
  const pack = memory.add({ text: 'Deploy: build with npm run dist', kind: 'procedure', project: 'deploy' });
  const deployConflict = memory
    .conflicts()
    .find((c) => (c.itemA?.id === build.id && c.itemB?.id === pack.id) || (c.itemA?.id === pack.id && c.itemB?.id === build.id));
  check('build/pack conflict recorded', !!deployConflict);
  await expectThrow('merge without text is rejected', () => memory.resolveConflict(deployConflict.id, 'merge'), 'mergedText');
  const mergedText = 'Deploy: run npm run build then npm run dist:dir';
  const merged = memory.resolveConflict(deployConflict.id, 'merge', { mergedText });
  eq('merge resolves conflict', merged.status, 'resolved');
  eq('merge outcome', merged.resolution, 'merge');
  check('merge text stored', memory.get(build.id).text === mergedText || memory.get(pack.id).text === mergedText);
  check('merged loser superseded', memory.get(build.id).status === 'superseded' || memory.get(pack.id).status === 'superseded');

  const negationConflict = memory.conflicts().find((c) => c.reason === 'negation');
  if (negationConflict) {
    const dimmed = memory.resolveConflict(negationConflict.id, 'dismiss');
    eq('dismiss marks conflict', dimmed.status, 'dismissed');
    eq('dismiss keeps items', memory.get(dark.id).status, 'active');
  } else {
    check('negation conflict available to dismiss', false);
  }

  section('links and graph');
  const pkgA = memory.add({ text: 'Electron app packaging uses electron-builder tooling', kind: 'insight', project: 'packaging' });
  const pkgB = memory.add({ text: 'electron-builder produces the Windows installer package', kind: 'insight', project: 'packaging' });
  const pkgLinks = memory.links(pkgA.id);
  check('related memory linked', pkgLinks.some((l) => l.id === pkgB.id), JSON.stringify(pkgLinks.map((l) => l.text)));
  check('link carries score', (pkgLinks.find((l) => l.id === pkgB.id)?.score || 0) > 0);
  const graph = memory.graph({ limit: 100 });
  check('graph nodes present', graph.nodes.some((n) => n.id === pkgA.id) && graph.nodes.some((n) => n.id === pkgB.id));
  check('graph edge present', graph.edges.some((e) => (e.source === pkgA.id && e.target === pkgB.id) || (e.source === pkgB.id && e.target === pkgA.id)));
  memory.remove(pkgB.id);
  eq('removed item gone', memory.get(pkgB.id), null);
  check('links cleaned up', !memory.links(pkgA.id).some((l) => l.id === pkgB.id));

  section('profile and context');
  memory.saveProfile({ name: 'Abdul', role: 'developer' });
  memory.saveProfile({ language: 'Roman Urdu', unknown: 'ignored' });
  const profile = memory.getProfile();
  eq('profile merges fields', [profile.name, profile.role, profile.language], ['Abdul', 'developer', 'Roman Urdu']);
  check('profile updatedAt set', typeof profile.updatedAt === 'number');
  const contextText = memory.context({ goal: 'which theme does the user like' });
  check('context includes profile', contextText.includes('Name: Abdul'));
  check('context includes relevant memory', /\[M\d+\] .*dark mode/i.test(contextText), contextText);
  check('context includes pinned memory', contextText.includes('Deploy checklist'), contextText);
  check('context respects maxChars', memory.context({ goal: 'theme', maxChars: 120 }).length <= 120);

  section('RAG ask');
  await expectThrow('empty question rejected', () => memory.ask({ question: '  ' }), 'Ask a question');
  const extractive = await memory.ask({ question: 'What theme does the user prefer?', limit: 5 });
  eq('extractive mode without candidates', extractive.mode, 'extractive');
  check('extractive cites memories', extractive.citations.length >= 1 && extractive.answer.includes('[M1]'));
  check('extractive warning is null', extractive.warning === null);
  const empty = await memory.ask({ question: 'quantum flux capacitor hyperdrive' });
  eq('no-hit ask mode', empty.mode, 'empty');
  eq('no-hit citations', empty.citations.length, 0);

  memory.init({ dataDir: dir, legacyFile, gateway: null });
  // keep DB open; init only refreshes memory module state
  memory.init({ dataDir: dir, legacyFile, gateway: fakeGateway });
  const candidates = [{ id: 'fake', name: 'Fake Provider', baseUrl: 'http://127.0.0.1:9', api: 'openai', model: 'fake-1' }];
  const llm = await memory.ask({ question: 'What theme does the user prefer?', candidates });
  eq('llm mode with candidates', llm.mode, 'llm');
  eq('llm provider surfaced', llm.provider?.name, 'Fake Provider');
  eq('llm answer passed through', llm.answer, 'You prefer dark mode [M1].');
  check('llm warning null when cited', llm.warning === null);
  eq('gateway called once', fakeCalls.length, 1);
  eq('gateway task is memory', fakeCalls[0].task, 'memory');
  check('gateway prompt includes numbered memory', /\[M1\]/.test(fakeCalls[0].history[0].text));

  memory.init({ dataDir: dir, legacyFile, gateway: uncitedGateway });
  const uncited = await memory.ask({ question: 'What theme does the user prefer?', candidates });
  eq('uncited answer still llm', uncited.mode, 'llm');
  check('uncited warning shown', /did not cite/i.test(uncited.warning || ''), uncited.warning);

  memory.init({ dataDir: dir, legacyFile, gateway: failingGateway });
  const failed = await memory.ask({ question: 'What theme does the user prefer?', candidates });
  eq('failure falls back to extractive', failed.mode, 'extractive');
  check('failure warning shown', /failed/i.test(failed.warning || ''), failed.warning);

  section('legacy re-import');
  fs.writeFileSync(
    legacyFile,
    [
      '# ORVEX memory',
      '- 2026-10-01 — User keeps projects in D:\\dev',
      '- Prefers concise replies',
      '- 2026-10-02 — Likes dark themes late at night',
    ].join('\n'),
    'utf8',
  );
  memory.init({ dataDir: dir, legacyFile, gateway: null });
  const legacyAfter = memory.list({ kind: 'legacy' });
  eq('new legacy line imported', legacyAfter.length, 3);
  check('old legacy lines not duplicated', legacyAfter.filter((i) => i.text === 'Prefers concise replies').length === 1);
  const unchanged = memory.importLegacy(legacyFile);
  eq('unchanged import skips', unchanged.unchanged, true);

  section('persistence and reindex');
  const activeBefore = memory.stats().active;
  db.close();
  db.init({ file: dbFile });
  const reopened = memory.init({ dataDir: dir, legacyFile, gateway: null });
  check('reopen reports ready', reopened.ready === true);
  eq('items persisted', memory.stats().active, activeBefore);
  eq('profile persisted', memory.getProfile().name, 'Abdul');
  check('search works after reopen', memory.search('dark mode')[0]?.id === dark.id);

  const handle = db.raw();
  handle.prepare('DELETE FROM memory_fts WHERE id = ?').run(personItem.id);
  const missing = handle.prepare('SELECT COUNT(*) AS c FROM memory_fts').get().c;
  check('fts row removed for test', !handle.prepare('SELECT id FROM memory_fts WHERE id = ?').get(personItem.id));
  memory.init({ dataDir: dir, legacyFile, gateway: null });
  const restoredFts = handle.prepare('SELECT COUNT(*) AS c FROM memory_fts').get().c;
  eq('init reindexes missing rows', restoredFts, missing + 1);
  check('reindexed item searchable', memory.search('Pixel')[0]?.id === personItem.id);

  const twice = memory.init({ dataDir: dir, legacyFile, gateway: null });
  check('repeated init is safe', twice.ready === true);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
