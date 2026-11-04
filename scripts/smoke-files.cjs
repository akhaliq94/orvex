'use strict';

/**
 * Files backend end-to-end test: real fs browsing, hashing/metadata,
 * duplicate detection, version history, archive zip/unzip, PDF toolkit,
 * spreadsheets, DOCX generation, diff, backups, watcher and guardrails.
 *
 * Run: node scripts/smoke-files.cjs
 */

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const files = require('../electron/files.cjs');

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
    check(name, false, 'no error thrown');
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    check(name, !includes || message.toLowerCase().includes(includes.toLowerCase()), message);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeout = 8000, step = 100) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await sleep(step);
  }
  return null;
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'orvex-files-'));
  const dataDir = path.join(root, 'appdata');
  const work = path.join(root, 'work');
  await fsp.mkdir(work, { recursive: true });

  const events = [];
  files.init({
    dataDir,
    roots: [{ label: 'Work', path: work }],
    emit: (event) => events.push(event),
  });

  console.log('\n— init & roots');
  const info = files.info();
  check('info is ready', info.ready === true, JSON.stringify(info));
  const roots = await files.roots();
  check('root is listed and reachable', roots.some((r) => r.path === work), JSON.stringify(roots));

  console.log('\n— write / read / stat / list / search');
  const notePath = path.join(work, 'notes.txt');
  const written = await files.write({ path: notePath, content: 'alpha beta\nsecond line\n' });
  eq('write returns size', written.size, 23);
  eq('read returns text', (await files.read({ path: notePath })).text, 'alpha beta\nsecond line\n');

  const meta = await files.stat({ path: notePath });
  check('stat has a sha256', /^[a-f0-9]{64}$/.test(meta.sha256 || ''), meta.sha256);
  eq('stat extension', meta.ext, 'txt');
  check('stat preview marked text', meta.preview && meta.preview.kind === 'text', JSON.stringify(meta.preview && meta.preview.kind));

  const listing = await files.list({ path: work });
  check('list sees notes.txt', listing.entries.some((e) => e.name === 'notes.txt'), JSON.stringify(listing.entries.map((e) => e.name)));

  await files.mkdir({ path: path.join(work, 'sub'), recursive: true });
  await files.write({ path: path.join(work, 'sub', 'inner.md'), content: '# inner\n' });
  const found = await files.search({ path: work, query: 'inner*.md' });
  check('glob search finds inner.md', found.results.some((m) => m.name === 'inner.md'), JSON.stringify(found.results));
  const substring = await files.search({ path: work, query: 'notes' });
  check('substring search finds notes.txt', substring.results.some((m) => m.name === 'notes.txt'), JSON.stringify(substring.results));

  console.log('\n— versions');
  await files.write({ path: notePath, content: 'alpha beta\nsecond line changed\n' });
  const vers = await files.versions({ path: notePath });
  check('overwrite created one version', vers.length === 1, `count ${vers.length}`);
  eq('version reason', vers[0] && vers[0].reason, 'before-write');
  const restored = await files.restoreVersion({ id: vers[0].id });
  eq('restored size', restored.size, 23);
  eq('restored content', (await files.read({ path: notePath })).text, 'alpha beta\nsecond line\n');

  console.log('\n— rename / copy / remove');
  const copyPath = path.join(work, 'notes-copy.txt');
  await files.copy({ from: notePath, to: copyPath });
  check('copy exists', (await fsp.stat(copyPath)).size === 23);
  await expectThrow('copy refuses overwrite without flag', () => files.copy({ from: notePath, to: copyPath }), 'destination already exists');
  const renamed = path.join(work, 'notes-renamed.txt');
  await files.rename({ from: copyPath, to: renamed });
  check('rename moved file', fs.existsSync(renamed) && !fs.existsSync(copyPath));
  await files.remove({ path: renamed });
  check('remove deleted file', !fs.existsSync(renamed));

  console.log('\n— duplicates');
  await fsp.writeFile(path.join(work, 'dup-a.bin'), Buffer.alloc(2048, 7));
  await fsp.writeFile(path.join(work, 'dup-b.bin'), Buffer.alloc(2048, 7));
  const dups = await files.duplicates({ path: work });
  const group = dups.groups.find((g) => g.files.some((f) => f.name === 'dup-a.bin'));
  check('duplicate group found', Boolean(group), JSON.stringify(dups.groups.map((g) => g.files.map((f) => f.name))));
  check('duplicate group has both files', group && group.files.length === 2, group && group.files.length);
  check('duplicates counted wasted bytes', dups.wasted >= 2048, dups.wasted);

  console.log('\n— archive');
  const zipPath = path.join(work, 'bundle.zip');
  const zipped = await files.zip({ sources: [notePath, path.join(work, 'sub')], dest: zipPath });
  check('zip written', fs.existsSync(zipPath) && zipped.bytes > 0, JSON.stringify(zipped));
  const zipEntries = await files.zipList({ zipPath });
  check('zip lists entries', zipEntries.entries.some((e) => e.path === 'notes.txt'), JSON.stringify(zipEntries.entries));
  check('zip includes folder content', zipEntries.entries.some((e) => e.path.includes('inner.md')), JSON.stringify(zipEntries.entries.map((e) => e.path)));
  const unzipDir = path.join(work, 'unzipped');
  const unzipped = await files.unzip({ zipPath, destDir: unzipDir });
  check('unzip extracted files', unzipped.extracted >= 2, unzipped.extracted);
  const unzippedText = await waitFor(async () => {
    try {
      return await fsp.readFile(path.join(unzipDir, 'notes.txt'), 'utf8');
    } catch {
      return null;
    }
  });
  eq('unzipped text matches', unzippedText, 'alpha beta\nsecond line\n');

  console.log('\n— PDF');
  const pdfA = path.join(work, 'a.pdf');
  const made = await files.pdfCreate({ dest: pdfA, title: 'Report A', text: '# Heading\nParagraph one.\n- bullet one\n- bullet two' });
  check('pdf created', made.pages >= 1 && made.bytes > 500, JSON.stringify(made));
  const pdfB = path.join(work, 'b.pdf');
  await files.pdfCreate({ dest: pdfB, title: 'Report B', text: 'Second document body.' });

  const rotated = path.join(work, 'a-rotated.pdf');
  const rot = await files.pdfRotate({ path: pdfA, dest: rotated, degrees: 90, pages: '1' });
  check('pdf rotate keeps page count', rot.pages === made.pages, rot.pages);
  check('rotated file exists', fs.existsSync(rotated));

  const metaSet = path.join(work, 'a-meta.pdf');
  const metaOut = await files.pdfMeta({ path: pdfA, dest: metaSet, meta: { title: 'Renamed', author: 'ORVEX test', keywords: 'a, b' } });
  eq('pdf metadata title applied', metaOut.title, 'Renamed');

  const merged = path.join(work, 'merged.pdf');
  const mergeInfo = await files.pdfMerge({ paths: [pdfA, pdfB], dest: merged });
  eq('merge sums pages', mergeInfo.pages, made.pages + 1);

  const splitDir = path.join(work, 'split');
  const split = await files.pdfSplit({ path: merged, destDir: splitDir, ranges: '1-2,3' });
  eq('split produced two files', split.created.length, 2);
  check('split files exist', split.created.every((p) => fs.existsSync(p)), JSON.stringify(split.created));

  console.log('\n— spreadsheets');
  const sheetPath = path.join(work, 'sheet.xlsx');
  const wb = await files.xlsxWrite({
    dest: sheetPath,
    sheets: [{ name: 'Data', rows: [['name', 'qty'], ['apple', 3], ['pear', 5]] }],
  });
  check('xlsx written', wb.sheets.length === 1 && wb.sheets[0].name === 'Data', JSON.stringify(wb));
  const sheetRead = await files.xlsxRead({ path: sheetPath });
  eq('xlsx header', sheetRead.header, ['name', 'qty']);
  eq('xlsx rows', sheetRead.rows, [['apple', '3'], ['pear', '5']]);
  const csvPath = path.join(work, 'sheet.csv');
  const csv = await files.xlsxToCsv({ path: sheetPath, dest: csvPath });
  check('csv exported', fs.existsSync(csvPath) && csv.bytes > 0, JSON.stringify(csv));
  eq('csv content', (await fsp.readFile(csvPath, 'utf8')).replace(/\r\n/g, '\n').trim(), 'name,qty\napple,3\npear,5');

  console.log('\n— docx');
  const docxPath = path.join(work, 'doc.docx');
  const docx = await files.docxMake({
    dest: docxPath,
    title: 'Smoke Doc',
    markdown: '# Title\n\nBody text.\n\n- one\n- two\n\n| a | b |\n| 1 | 2 |',
  });
  check('docx written', docx.bytes > 1000, JSON.stringify(docx));
  const docxHead = await fsp.readFile(docxPath);
  check('docx is a zip container', docxHead.slice(0, 2).toString('latin1') === 'PK');
  await expectThrow('docx requires .docx extension', () => files.docxMake({ dest: path.join(work, 'doc.txt'), markdown: 'x' }), '.docx');
  await expectThrow('docx refuses empty content', () => files.docxMake({ dest: path.join(work, 'empty.docx'), markdown: '   ' }), 'content');

  console.log('\n— diff');
  const leftPath = path.join(work, 'left.txt');
  const rightPath = path.join(work, 'right.txt');
  await fsp.writeFile(leftPath, 'one\ntwo\nthree\n');
  await fsp.writeFile(rightPath, 'one\nTWO\nthree\nfour\n');
  const delta = await files.diff({ a: leftPath, b: rightPath });
  eq('diff added lines', delta.added, 2);
  eq('diff removed lines', delta.removed, 1);
  check('diff unified marks +/-', delta.unified.includes('-two') && delta.unified.includes('+TWO'), delta.unified);

  console.log('\n— backups');
  const backupPath = path.join(work, 'important.txt');
  await fsp.writeFile(backupPath, 'v1');
  const bak = await files.backup({ path: backupPath });
  check('backup recorded', bak.id && bak.bytes === 2, JSON.stringify(bak));
  await fsp.writeFile(backupPath, 'v2-changed');
  const bakList = await files.backups({ path: backupPath });
  check('backup listed for path', bakList.length === 1, bakList.length);
  await files.restoreBackup({ id: bak.id });
  eq('backup restored content', await fsp.readFile(backupPath, 'utf8'), 'v1');
  await files.removeBackup({ id: bak.id });
  eq('backup removed', (await files.backups({ path: backupPath })).length, 0);

  console.log('\n— watcher');
  const watched = path.join(work, 'watched');
  await fsp.mkdir(watched, { recursive: true });
  const watch = await files.watchStart({ path: watched });
  check('watcher started', Boolean(watch.id), JSON.stringify(watch));
  events.length = 0;
  await fsp.writeFile(path.join(watched, 'live.txt'), 'live');
  const seen = await waitFor(() => events.find((e) => path.basename(e.path).toLowerCase() === 'live.txt'));
  check('watcher emitted an event', Boolean(seen), JSON.stringify(events));
  const status = files.watchStatus();
  check('watch status lists watcher', status.watching.some((w) => w.id === watch.id), JSON.stringify(status));
  await files.watchStop({ id: watch.id });
  eq('watch status empty after stop', files.watchStatus().watching.length, 0);

  console.log('\n— guardrails');
  await expectThrow('system folder blocked', () => files.list({ path: 'C:\\Windows' }), 'blocked');
  await expectThrow('sensitive file blocked', () => files.read({ path: 'C:\\Users\\Public\\secrets.json' }), 'blocked');
  await expectThrow('empty path rejected', () => files.read({ path: '   ' }), 'empty');
  await expectThrow('unzip requires an existing zip', () => files.zipList({ zipPath: path.join(work, 'missing.zip') }));

  console.log('\n— persistence');
  await files.close();
  files.init({ dataDir, roots: [{ label: 'Work', path: work }], emit: () => {} });
  const versAfter = await files.versions({ path: notePath });
  check('version index survives re-init', versAfter.length >= 1, versAfter.length);
  await files.close();

  await fsp.rm(root, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(async (err) => {
  console.error('\nFATAL', err && err.stack ? err.stack : err);
  process.exit(1);
});
