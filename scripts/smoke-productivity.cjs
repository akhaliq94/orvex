'use strict';

/**
 * Section 17 — Productivity backend smoke.
 * Runs inside Electron-as-Node (better-sqlite3 ABI) against a temporary profile:
 * calculator, Python runner, data analysis/charts, spreadsheet round trip, SQL
 * console, report export, notes (memory/RAG), tasks, text workspace, PPTX,
 * document comparison, artifacts and honest failure paths.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const unzipper = require('unzipper');

const productivity = require('../electron/productivity.cjs');
const memory = require('../electron/memory.cjs');
const db = require('../electron/db.cjs');
const documents = require('../electron/documents.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-prod-'));
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

(async () => {
  try {
    db.init({ file: dbFile });
    memory.init({ dataDir, legacyFile: path.join(dataDir, 'memory.md'), gateway: null });
    productivity.init({
      dataDir,
      db: db.raw(),
      gateway: null,
      memory,
      creative: null,
      documents,
      files: null,
    });

    console.log('\n— calculator');
    const c1 = productivity.calc({ expression: '(1250*0.18)+sqrt(144)' });
    check('the calculator evaluates a real expression', c1.value === 237 && c1.display === '237', `${c1.expression} = ${c1.display}`);
    const c2 = productivity.calc({ expression: '2^10 + round(pi, 4) * 2' });
    check('the calculator handles powers, constants and functions', Math.abs(c2.value - 1030.2832) < 1e-9, c2.display);
    const c3 = productivity.calc({ expression: '5! + min(9, 4, 7)' });
    check('factorial and multi-argument functions work', c3.value === 124, c3.display);
    await expectError('division by zero is refused', () => productivity.calc({ expression: '1/0' }), /zero/i);
    await expectError('unknown functions are refused', () => productivity.calc({ expression: 'alert(1)' }), /Unknown function/);
    await expectError('empty input is refused', () => productivity.calc({ expression: '  ' }), /Type a calculation/);

    console.log('\n— python');
    const py = await productivity.pythonInfo();
    check('python detection answers honestly', typeof py.available === 'boolean' && (py.available ? !!py.version : !!py.error), py.available ? `${py.command} · ${py.version}` : py.error);
    if (py.available) {
      const run = await productivity.runPython({ code: 'print(6*7)\nprint("orvex")' });
      check('python runs a real script', run.exitCode === 0 && run.stdout.includes('42') && run.stdout.includes('orvex'), `${run.ms} ms · exit ${run.exitCode}`);
      const bad = await productivity.runPython({ code: 'raise SystemExit(3)' });
      check('python reports the real exit code', bad.exitCode === 3, `exit ${bad.exitCode}`);
      const err = await productivity.runPython({ code: 'import sys; print("boom", file=sys.stderr)' });
      check('python stderr is captured', err.stderr.includes('boom'), err.stderr.trim());
    } else {
      await expectError('running python without an interpreter is refused', () => productivity.runPython({ code: 'print(1)' }), /not found/i);
    }

    console.log('\n— data analysis and charts');
    const csvPath = path.join(root, 'sales.csv');
    await fsp.writeFile(csvPath, 'region,qty,price\neast,10,2.5\nwest,4,3.0\neast,6,2.5\nnorth,8,1.5\nwest,2,3.0\n', 'utf8');
    const analysis = await productivity.dataAnalyze({ path: csvPath });
    const qty = analysis.columns.find((c) => c.name === 'qty');
    check('CSV analysis finds rows and typed columns', analysis.rows === 5 && qty && qty.type === 'number', `${analysis.rows} row(s), ${analysis.columns.length} column(s)`);
    check('numeric statistics are computed from the file', qty.sum === 30 && qty.mean === 6 && qty.min === 2 && qty.max === 10, `sum ${qty.sum}, mean ${qty.mean}`);
    check('missing-value and unique counts are real', qty.missing === 0 && qty.unique === 5, `${qty.missing} missing, ${qty.unique} unique`);
    const chart = await productivity.dataChart({ path: csvPath, x: 'region', y: 'qty', kind: 'bar' });
    const east = chart.points.find((p) => p.label === 'east');
    const west = chart.points.find((p) => p.label === 'west');
    check('bar chart groups the real numbers', east.value === 16 && west.value === 6, chart.points.map((p) => `${p.label}:${p.value}`).join(', '));
    const avg = await productivity.dataChart({ path: csvPath, x: 'region', y: 'price', agg: 'avg' });
    check('chart aggregation is applied', Math.abs(avg.points.find((p) => p.label === 'east').value - 2.5) < 1e-9, 'avg price east = 2.5');
    const xlsxPath = path.join(root, 'sales.xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['day', 'steps'], ['mon', 1000], ['tue', 2500], ['wed', 1750]]), 'Steps');
    XLSX.writeFile(wb, xlsxPath);
    const xl = await productivity.dataAnalyze({ path: xlsxPath });
    check('XLSX files are read as real sheets', xl.sheet === 'Steps' && xl.rows === 3 && xl.columns.find((c) => c.name === 'steps').sum === 5250, `${xl.sheet} · sum 5250`);
    await expectError('blocked system files are refused', () => productivity.dataAnalyze({ path: 'C:\\Windows\\win.ini' }), /Blocked/i);

    console.log('\n— spreadsheet editor');
    const sheetPath = path.join(root, 'edited.xlsx');
    const saved = await productivity.sheetSave({ path: sheetPath, sheet: 'Plan', headers: ['Task', 'Hours'], rows: [['Design', 6], ['Build', '12']] });
    check('the spreadsheet writer creates a real workbook', saved.bytes > 1000 && saved.sheets.includes('Plan'), `${saved.bytes} bytes`);
    const opened = await productivity.sheetOpen({ path: sheetPath, sheet: 'Plan' });
    check('the sheet reopens with its headers and rows', opened.headers.join(',') === 'Task,Hours' && opened.rows.length === 2, JSON.stringify(opened.rows));
    check('numeric values stay numeric after a round trip', opened.rows[0][1] === 6 && opened.rows[1][1] === 12, JSON.stringify(opened.rows));
    await productivity.sheetSave({ path: sheetPath, sheet: 'Plan', headers: ['Task', 'Hours'], rows: [['Design', 7], ['Build', 12], ['Test', 4]] });
    const reopened = await productivity.sheetOpen({ path: sheetPath, sheet: 'Plan' });
    check('saving again replaces the rows', reopened.rows.length === 3 && reopened.rows[2][0] === 'Test', `${reopened.rows.length} rows`);
    const created = await productivity.sheetCreate({ path: path.join(root, 'fresh.xlsx'), sheets: [{ name: 'One', headers: ['A'], rows: [['x']] }] });
    check('a new workbook can be created', created.sheets.join(',') === 'One', created.sheets.join(','));

    console.log('\n— SQL console');
    const create = productivity.sqlRun({ sql: 'CREATE TABLE IF NOT EXISTS smoke_people (id INTEGER PRIMARY KEY, name TEXT, score REAL)' });
    check('CREATE runs on the scratch database', create.kind === 'write' && create.changes === 0, `${create.changes} changes`);
    productivity.sqlRun({ sql: "INSERT INTO smoke_people (name, score) VALUES ('Ada', 91.5)" });
    const insert = productivity.sqlRun({ sql: "INSERT INTO smoke_people (name, score) VALUES ('Grace', 88)" });
    check('INSERT reports the row id', insert.kind === 'write' && insert.lastInsertRowid > 0, `last id ${insert.lastInsertRowid}`);
    const select = productivity.sqlRun({ sql: 'SELECT name, score FROM smoke_people ORDER BY score DESC' });
    check('SELECT returns real rows and columns', select.kind === 'read' && select.columns.join(',') === 'name,score' && select.rows.length === 2, JSON.stringify(select.rows));
    const tables = productivity.sqlTables();
    check('the table list shows the scratch schema', tables.tables.some((t) => t.name === 'smoke_people' && t.rows === 2), tables.tables.map((t) => `${t.name}(${t.rows})`).join(', '));
    const schema = productivity.sqlSchema({ table: 'smoke_people' });
    check('the schema view returns the real DDL', /CREATE TABLE/.test(schema.sql) && schema.sql.includes('score'), schema.sql.split('\n')[0]);
    await expectError('ATTACH is blocked', () => productivity.sqlRun({ sql: "ATTACH DATABASE 'x.db' AS x" }), /ATTACH/);

    console.log('\n— reports');
    const blocks = [
      { type: 'heading', text: 'Findings' },
      { type: 'text', text: 'Revenue grew 18% QoQ.' },
      { type: 'list', items: ['East leads', 'West steady'] },
      { type: 'table', headers: ['Region', 'Sales'], rows: [['East', 16], ['West', 6]] },
      { type: 'chart', kind: 'bar', x: 'region', y: 'qty', points: chart.points },
      { type: 'kv', items: [{ label: 'Owner', value: 'Ops' }] },
    ];
    const mdReport = await productivity.reportBuild({ title: 'Sales review', blocks, format: 'md' });
    const mdText = await fsp.readFile(mdReport.path, 'utf8');
    check('the Markdown report is written with real content', mdText.includes('# Sales review') && mdText.includes('East') && mdText.includes('| Label | Value |'), `${mdReport.bytes} bytes`);
    const htmlReport = await productivity.reportBuild({ title: 'Sales review', blocks, format: 'html' });
    const htmlText = await fsp.readFile(htmlReport.path, 'utf8');
    check('the HTML report contains the chart bars', htmlText.includes('<table>') && htmlText.includes('class="bar"'), `${htmlReport.bytes} bytes`);
    const docxReport = await productivity.reportBuild({ title: 'Sales review', blocks, format: 'docx' });
    const docxHead = await fsp.readFile(docxReport.path);
    check('the DOCX report is a real OOXML file', docxHead.slice(0, 2).toString() === 'PK' && docxHead.length > 3000, `${docxReport.bytes} bytes`);
    const docxZip = await unzipper.Open.file(docxReport.path);
    check('the DOCX contains the document body', docxZip.files.some((f) => f.path === 'word/document.xml'), `${docxZip.files.length} entries`);
    await expectError('an empty report is refused', () => productivity.reportBuild({ title: 'x', blocks: [] }), /at least one block/);

    console.log('\n— notes (memory/RAG)');
    const noteA = productivity.noteCreate({ title: 'Q4 roadmap', body: 'Ship the productivity workbench and finish the installer.', tags: ['plan'] });
    check('a note is stored as a real memory item', noteA.note.id.startsWith('mem_') && noteA.note.title === 'Q4 roadmap', noteA.note.id);
    const noteB = productivity.noteCreate({ title: 'Vendor call', body: 'Renew the CDN contract in March.', tags: 'ops' });
    const listed = productivity.noteList({});
    check('notes are listed from the store', listed.notes.length >= 2 && listed.notes.some((n) => n.title === 'Vendor call'), `${listed.notes.length} note(s)`);
    const searched = productivity.noteList({ query: 'installer' });
    check('note search finds the roadmap text', searched.notes.some((n) => n.id === noteA.note.id), `${searched.notes.length} hit(s)`);
    const memoryHits = memory.search('installer', { limit: 5 });
    check('RAG search sees the note too', memoryHits.some((m) => m.id === noteA.note.id), `${memoryHits.length} memory hit(s)`);
    const updated = productivity.noteUpdate({ id: noteB.note.id, title: 'Vendor renewal', body: 'Renew the CDN contract in March; ask for a discount.' });
    check('a note title and body update', updated.note.title === 'Vendor renewal' && updated.note.body.includes('discount'), updated.note.title);
    const removed = productivity.noteDelete({ id: noteB.note.id });
    check('a note can be deleted', removed.removed === noteB.note.id, removed.removed);

    console.log('\n— tasks');
    const madeA = productivity.taskCreate({ title: 'Write the quarter plan', priority: 1, due: '2030-01-15', notes: 'Include the hiring line' });
    const madeB = productivity.taskCreate({ title: 'Archive old invoices', priority: 3 });
    check('tasks are stored with priority and due date', madeA.task.status === 'open' && madeA.task.dueAt > 0 && madeA.task.priority === 1, new Date(madeA.task.dueAt).toISOString());
    const openTasks = productivity.taskList({ status: 'open' });
    check('the open list returns both tasks', openTasks.tasks.length === 2, `${openTasks.tasks.length} open`);
    const done = productivity.taskToggle({ id: madeB.task.id });
    check('toggle marks a task done with a completion time', done.task.status === 'done' && done.task.completedAt > 0, `done at ${done.task.completedAt}`);
    const stats = productivity.taskStats();
    check('task stats count open, done and totals', stats.open === 1 && stats.done === 1 && stats.total === 2, JSON.stringify(stats));
    const edited = productivity.taskUpdate({ id: madeA.task.id, patch: { title: 'Write the FY plan', priority: 2 } });
    check('task edits persist', edited.task.title === 'Write the FY plan' && edited.task.priority === 2, edited.task.title);
    const removedTask = productivity.taskRemove({ id: madeA.task.id });
    check('a task can be deleted', removedTask.removed === madeA.task.id, removedTask.removed);

    console.log('\n— translate and meetings (honest unavailable states)');
    await expectError('translation without a provider is refused', () => productivity.translate({ text: 'hello', target: 'Urdu' }), /model provider/i);
    await expectError('summarising without a provider is refused', () => productivity.meetingSummarize({ title: 'Standup', transcript: 'We shipped the build.' }), /model provider/i);
    await expectError('a meeting with no transcript or audio is refused', () => productivity.meetingSummarize({ title: 'Empty' }), /transcript or pick an audio file/i);

    console.log('\n— text workspace');
    const textSaved = await productivity.textSave({ name: 'ideas.md', text: '# Ideas\n\n- Faster builds\n' });
    check('a text file saves in the workspace', textSaved.bytes > 10, `${textSaved.bytes} bytes`);
    const textOpened = await productivity.textOpen({ name: 'ideas.md' });
    check('the text file reopens with its content', textOpened.text.includes('Faster builds'), textOpened.text.split('\n')[0]);
    const renamed = await productivity.textRename({ name: 'ideas.md', newName: 'notes.md' });
    check('a text file renames inside the workspace', renamed.to === 'notes.md', renamed.to);
    const textFiles = await productivity.textList();
    check('the workspace list shows the renamed file', textFiles.files.some((f) => f.name === 'notes.md'), textFiles.files.map((f) => f.name).join(', '));
    await expectError('path traversal in the text workspace is refused', () => productivity.textSave({ name: '../escape.txt', text: 'nope' }), /without folders/);
    await productivity.textRemove({ name: 'notes.md' });
    const afterRemove = await productivity.textList();
    check('a text file can be deleted', !afterRemove.files.some((f) => f.name === 'notes.md'), `${afterRemove.files.length} left`);

    console.log('\n— slides');
    const slides = await productivity.slidesBuild({
      title: 'Productivity launch',
      subtitle: 'Section 17',
      slides: [
        { title: 'What shipped', bullets: ['Calculator and Python', 'Data and sheets', 'Reports and slides'], notes: 'Keep it short.' },
        { title: 'Next', bullets: ['Vision agent', 'Plugin SDK'] },
      ],
    });
    check('a real .pptx is generated', slides.slides === 3 && slides.bytes > 10000, `${slides.bytes} bytes, ${slides.slides} slides`);
    const pptxHead = await fsp.readFile(slides.path);
    check('the presentation is a ZIP/OOXML package', pptxHead.slice(0, 2).toString() === 'PK', pptxHead.slice(0, 2).toString());
    const pptxZip = await unzipper.Open.file(slides.path);
    const slideEntry = pptxZip.files.find((f) => /ppt\/slides\/slide1\.xml$/.test(f.path));
    const slideXml = slideEntry ? (await slideEntry.buffer()).toString('utf8') : '';
    check('the first slide carries the real title', slideXml.includes('Productivity launch'), `${pptxZip.files.length} entries`);

    console.log('\n— document comparison');
    const fileA = path.join(root, 'a.txt');
    const fileB = path.join(root, 'b.txt');
    await fsp.writeFile(fileA, 'alpha\nbeta\ngamma\n', 'utf8');
    await fsp.writeFile(fileB, 'alpha\nbeta changed\ngamma\ndelta\n', 'utf8');
    const compared = await productivity.compareDocs({ a: fileA, b: fileB });
    check('added and removed lines are counted', compared.added === 2 && compared.removed === 1 && compared.same === 2, `+${compared.added} -${compared.removed} =${compared.same}`);
    check('the unified diff names the changed line', compared.unified.includes('-beta') && compared.unified.includes('+beta changed'), compared.unified.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-')).join(' / '));
    const sameSheet = await productivity.compareDocs({ a: xlsxPath, b: xlsxPath });
    check('comparing a file with itself reports no changes', sameSheet.changed === false, `+${sameSheet.added} -${sameSheet.removed}`);

    console.log('\n— artifacts and persistence');
    const autoSheet = await productivity.sheetSave({ sheet: 'Auto', headers: ['A'], rows: [[1]] });
    const autoText = await productivity.textSave({ name: 'artifact.txt', text: 'keep me' });
    const artifacts = await productivity.artifacts({ limit: 100 });
    const kinds = new Set(artifacts.artifacts.map((a) => a.kind));
    check('sheet and text outputs default into the workspace', autoSheet.path.includes(`${path.sep}productivity${path.sep}sheets`) && autoText.path.includes(`${path.sep}productivity${path.sep}texts`), autoSheet.path);
    check('the artifact index lists every generated kind', ['report', 'slides', 'sheet', 'text'].every((k) => kinds.has(k)), [...kinds].join(', '));
    check('artifact sizes are real', artifacts.artifacts.every((a) => a.bytes > 0), `${artifacts.total} artifact(s)`);
    productivity.close();
    productivity.init({ dataDir, db: db.raw(), gateway: null, memory, creative: null, documents, files: null });
    const persisted = productivity.taskList({ status: 'done' });
    check('tasks survive a database reopen', persisted.tasks.some((t) => t.id === madeB.task.id), `${persisted.tasks.length} done task(s)`);
    const caps = await productivity.capabilities();
    check('capabilities report the real dependencies', caps.sqlite && caps.xlsx && caps.docx && caps.pptx && caps.model === false, JSON.stringify({ python: caps.python.available, model: caps.model, dirs: !!caps.dirs.root }));

    console.log(`\nproductivity backend smoke: ${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
  } catch (err) {
    console.error('FATAL', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  } finally {
    try {
      productivity.close();
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
