'use strict';

/**
 * Section 17 Productivity UI smoke over CDP.
 * Requires the ORVEX window running with --remote-debugging-port=9222.
 *
 * Walks all twelve tabs on the real page and drives each workspace through its
 * bridge: calculator, Python, CSV analysis and charting, spreadsheet create and
 * reopen, SQL DDL/DML/select, a Markdown report, the meeting error path, note
 * create/search/update/delete, task create/toggle/delete, the translate error
 * path, text file save/rename/delete, a PPTX build and a real document diff.
 * Temporary files are removed afterwards.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.ORVEX_CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const stamp = Date.now();
const suffix = String(stamp).slice(-7);
const TABLE = `ui_smoke_${suffix}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-prod-ui-'));
const csvPath = path.join(tmp, 'sales.csv');
const xlsxPath = path.join(tmp, 'smoke-sheet.xlsx');
const diffA = path.join(tmp, 'a.txt');
const diffB = path.join(tmp, 'b.txt');
const created = [];

fs.writeFileSync(csvPath, 'name,qty,price\nalpha,10,2.5\nbeta,20,3.5\ngamma,30,4.5\n', 'utf8');
fs.writeFileSync(diffA, 'alpha\nbeta\ngamma\n', 'utf8');
fs.writeFileSync(diffB, 'alpha\nBETA\ngamma\ndelta\n', 'utf8');

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!res.ok) throw new Error(`CDP list failed: HTTP ${res.status}`);
  return res.json();
}

function connect(url) {
  const WebSocket = require('ws');
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', reject);
  });
  ws.addEventListener('message', (msg) => {
    const data = JSON.parse(msg.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after 20s`));
      }, 20_000);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, ready };
}

(async () => {
  let cdp;
  try {
    const list = await targets();
    const page = list.find((t) => t.type === 'page' && /\/index\.html|\/$/.test(t.url) && !/recorder\.html/.test(t.url));
    if (!page) throw new Error(`No ORVEX page target. Targets: ${list.map((t) => t.url).join(', ')}`);
    cdp = connect(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');

    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed');
      return r.result.value;
    };
    const until = async (expression, timeoutMs, label) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const value = await evaluate(expression);
        if (value) return value;
        await sleep(150);
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    const ipc = (ns, method, ...args) =>
      evaluate(`(async () => {
        const api = window.orvex && window.orvex.${ns};
        if (!api || !api.${method}) return { ok: false, error: 'bridge ${ns}.${method} missing' };
        try {
          const r = await api.${method}(${args.map((a) => JSON.stringify(a)).join(', ')});
          return r && r.ok === true ? { ok: true, data: r.data } : { ok: false, error: (r && r.error) || 'ipc failed' };
        } catch (err) {
          return { ok: false, error: String(err && err.message ? err.message : err) };
        }
      })()`);
    const ok = async (ns, method, ...args) => {
      const r = await ipc(ns, method, ...args);
      if (!r.ok) throw new Error(`${ns}.${method} failed: ${r.error}`);
      return r.data;
    };
    const clickText = (selector, text, exact = false) =>
      evaluate(`(() => {
        const hit = [...document.querySelectorAll(${JSON.stringify(selector)})].find((n) => ${
          exact ? `n.textContent.trim() === ${JSON.stringify(text)}` : `n.textContent.includes(${JSON.stringify(text)})`
        });
        if (!hit) return false;
        hit.click();
        return true;
      })()`);
    const setValue = (selector, value) =>
      evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
        return el.value;
      })()`);
    const clickId = (id) => evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); if (!el) return false; el.click(); return true; })()`);
    const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`);
    const count = (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    const goTab = async (id, label) => {
      await evaluate(`document.querySelector('[data-testid="prod-tab-${id}"]')?.click()`);
      await until(
        `document.querySelector('.prod-tabs .settings-tab.active')?.textContent.trim() === ${JSON.stringify(label)}`,
        8000,
        `the ${label} tab`,
      );
    };

    const caps = await ok('productivity', 'capabilities');
    check('the productivity bridge answers with capabilities', !!caps && !!caps.dirs && caps.dirs.root.length > 0);
    check('the scratch workspaces exist on disk', fs.existsSync(caps.dirs.root) && fs.existsSync(caps.dirs.reports));

    console.log('\n— open Productivity from the sidebar');
    if ((await evaluate(`document.querySelector('.page-title')?.textContent`)) === 'Productivity') {
      await evaluate(`document.querySelector('.page-back')?.click()`);
      await until(`document.querySelector('.page-title')?.textContent !== 'Productivity'`, 8000, 'the dashboard before the run');
    }
    await until(`[...document.querySelectorAll('.nav-item')].some((n) => n.textContent.trim() === 'Productivity')`, 20000, 'the Productivity nav item');
    await clickText('.nav-item', 'Productivity', true);
    await until(`document.querySelector('.page-title')?.textContent === 'Productivity'`, 10000, 'the Productivity page');
    check('Productivity opens from the sidebar', true);
    check('the page renders its own stylesheet', (await evaluate(`getComputedStyle(document.querySelector('.prod-tabs')).display`)) === 'flex');
    const tabLabels = await until(
      `(() => { const nodes = [...document.querySelectorAll('.prod-tabs .settings-tab')]; return nodes.length === 12 ? nodes.map((n) => n.textContent.trim()) : null; })()`,
      10000,
      'the twelve productivity tabs',
    );
    check(
      'all twelve workspaces are present',
      ['Calculator & Python', 'Data analyzer', 'Spreadsheet', 'SQL', 'Reports', 'Meetings', 'Notes', 'Tasks', 'Translate', 'Text editor', 'Slides', 'Compare'].every((label) => tabLabels.includes(label)),
      tabLabels.join(', '),
    );
    await until(`!!document.getElementById('prod-caps')`, 10000, 'the capability strip');
    check('the capability strip reports real module availability', (await count('#prod-caps .prod-chip')) >= 8);

    console.log('\n— calculator & python');
    await goTab('calc', 'Calculator & Python');
    check('the calculator input renders', (await count('#prod-calc-expr')) === 1);
    await setValue('#prod-calc-expr', '(1250*0.18)+sqrt(144)');
    await clickId('prod-calc-run');
    await until(`!!document.getElementById('prod-calc-result')`, 8000, 'the calculator result');
    const calcValue = await text('#prod-calc-result strong');
    check('the calculator evaluates the expression', calcValue === '237', calcValue);
    await setValue('#prod-calc-expr', '10/0');
    await clickId('prod-calc-run');
    await until(`document.querySelector('.prod-error')?.textContent.includes('zero')`, 6000, 'the division-by-zero error');
    check('the calculator reports division by zero honestly', true);

    const pyInfo = await evaluate(`document.getElementById('prod-py-info')?.textContent || ''`);
    const pyReady = caps.python && caps.python.available;
    check('the Python card shows the detected interpreter', pyReady ? /python|Python 3|3\.\d/i.test(pyInfo) : /not found/i.test(pyInfo), pyInfo.slice(0, 80));
    if (pyReady) {
      await setValue('#prod-py-code', 'print(6*7)\nprint("rows:", 2+3)');
      await clickId('prod-py-run');
      await until(`!!document.getElementById('prod-py-out')`, 20000, 'the Python output');
      const out = await text('#prod-py-out');
      check('the Python executor returns real stdout', out.includes('42') && out.includes('rows: 5'), out.replace(/\s+/g, ' ').slice(0, 90));
    } else {
      check('without Python the run button is disabled and explained', (await evaluate(`document.getElementById('prod-py-run')?.disabled`)) === true);
    }

    console.log('\n— data analyzer');
    await goTab('data', 'Data analyzer');
    await setValue('#prod-data-path', csvPath);
    await clickId('prod-data-run');
    await until(`!!document.getElementById('prod-data-result')`, 10000, 'the analysis result');
    const analysisText = await text('#prod-data-result');
    check('the CSV is profiled for real', analysisText.includes('3 rows') && analysisText.includes('3 columns'), analysisText.slice(0, 80));
    const columnRows = await count('#prod-data-result .prod-table tbody tr');
    check('every column gets a statistics row', columnRows >= 3, `${columnRows} rows`);
    check('the sample preview renders', (await count('#prod-data-result .prod-sample tbody tr')) === 3);
    await setValue('#prod-chart-x', 'name');
    await setValue('#prod-chart-y', 'qty');
    await setValue('#prod-chart-kind', 'bar');
    await clickId('prod-chart-run');
    await until(`!!document.getElementById('prod-chart-result')`, 10000, 'the chart result');
    check('the bar chart plots one bar per group', (await count('#prod-chart-result .prod-bar-row')) === 3);
    check('the chart summary names the axes', (await text('#prod-chart-result .prod-meta-row')).includes('qty by name'));

    console.log('\n— spreadsheet');
    await goTab('sheet', 'Spreadsheet');
    await setValue('#prod-sheet-path', xlsxPath);
    await setValue('#prod-sheet-name', 'Smoke');
    await setValue('#prod-sheet-grid thead .prod-cell', 'Item');
    await setValue('#prod-sheet-grid tbody .prod-cell', 'Widget');
    await clickId('prod-sheet-create');
    await until(`document.getElementById('prod-sheet-status')?.textContent.includes(${JSON.stringify(xlsxPath)})`, 15000, 'the workbook save status');
    check('a new workbook is written from the grid', fs.existsSync(xlsxPath), `${fs.existsSync(xlsxPath) ? fs.statSync(xlsxPath).size : 0} bytes`);
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(xlsxPath);
    const sheet = wb.Sheets.Smoke;
    check('the workbook has the requested sheet', !!sheet && wb.SheetNames.includes('Smoke'));
    check('the edited header and cell persisted', !!sheet && sheet.A1.v === 'Item' && sheet.A2.v === 'Widget');
    await clickId('prod-sheet-open');
    await until(
      `document.querySelector('#prod-sheet-grid')?.closest('.settings-block')?.querySelector('.settings-block-head .prod-hint')?.textContent.includes('source rows')`,
      10000,
      'the reopened workbook',
    );
    check('an existing workbook reopens into the grid', (await evaluate(`document.querySelector('#prod-sheet-grid thead .prod-cell')?.value`)) === 'Item');

    console.log('\n— sql');
    await goTab('sql', 'SQL');
    await setValue('#prod-sql-text', `CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY, label TEXT)`);
    await clickId('prod-sql-run');
    await until(`document.getElementById('prod-sql-result')?.textContent.includes('write')`, 10000, 'the DDL result');
    await setValue('#prod-sql-text', `INSERT INTO ${TABLE}(label) VALUES ('alpha')`);
    await clickId('prod-sql-run');
    await sleep(400);
    await setValue('#prod-sql-text', `SELECT id, label FROM ${TABLE}`);
    await clickId('prod-sql-run');
    await until(`!!document.querySelector('#prod-sql-result .prod-table tbody tr')`, 10000, 'the select rows');
    const sqlText = await text('#prod-sql-result');
    check('a real SQLite table is created, filled and queried', sqlText.includes('alpha') && sqlText.includes('read'), sqlText.replace(/\s+/g, ' ').slice(0, 80));
    await until(`document.getElementById('prod-sql-tables')?.textContent.includes(${JSON.stringify(TABLE)})`, 10000, 'the table list');
    check('the table list refreshes with the new table', true);
    await evaluate(`[...document.querySelectorAll('.prod-table-item')].find((n) => n.textContent.includes(${JSON.stringify(TABLE)}))?.click()`);
    await until(`document.getElementById('prod-sql-schema')?.textContent.includes('CREATE TABLE')`, 8000, 'the schema');
    check('clicking a table shows its DDL', true);

    console.log('\n— reports');
    await goTab('reports', 'Reports');
    await setValue('#prod-report-title', `UI report ${suffix}`);
    await setValue('#prod-report-block-type', 'heading');
    await clickId('prod-report-add-block');
    await until(`document.querySelectorAll('#prod-report-blocks .prod-block').length === 1`, 6000, 'the heading block');
    await evaluate(`(() => {
      const el = document.querySelector('#prod-report-blocks .prod-block input.text-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'Smoke heading');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    })()`);
    await setValue('#prod-report-block-type', 'text');
    await clickId('prod-report-add-block');
    await until(`document.querySelectorAll('#prod-report-blocks .prod-block').length === 2`, 6000, 'the paragraph block');
    await evaluate(`(() => {
      const el = document.querySelectorAll('#prod-report-blocks .prod-block')[1].querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'Body paragraph written by the UI smoke.');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    })()`);
    await clickId('prod-report-build');
    await until(`!!document.getElementById('prod-report-result')`, 15000, 'the built report');
    const reportPath = await text('#prod-report-result .prod-meta-row .prod-mono');
    if (reportPath) created.push(reportPath);
    check('the report is written to disk', !!reportPath && fs.existsSync(reportPath), reportPath);
    check('the report preview includes the heading', (await text('#prod-report-result .prod-preview')).includes('Smoke heading'));
    await evaluate(`document.querySelector('#prod-artifacts')?.closest('.settings-block')?.querySelector('button')?.click()`);
    await until(`document.querySelectorAll('#prod-artifacts .prod-artifact').length > 0`, 10000, 'the artifact list');
    check(
      'generated artifacts are listed',
      (await text('#prod-artifacts')).includes(path.basename(reportPath)) || (await text('#prod-artifacts')).includes(`ui-report-${suffix}`),
    );

    console.log('\n— meetings');
    await goTab('meetings', 'Meetings');
    check('the meeting source and transcript controls render', (await count('#prod-meet-source')) === 1 && (await count('#prod-meet-transcript')) === 1);
    await clickId('prod-meet-run');
    await until(`document.body.textContent.includes('Paste a transcript or pick an audio file')`, 10000, 'the empty-meeting error');
    check('an empty meeting is rejected with a real error', (await count('#prod-meet-result')) === 0);
    await setValue('#prod-meet-source', 'audio');
    await until(`!!document.getElementById('prod-meet-audio')`, 6000, 'the audio controls');
    check('switching to audio reveals the ASR fields', (await count('#prod-meet-asr-url')) === 1 && (await count('#prod-meet-asr-key')) === 1);
    await setValue('#prod-meet-source', 'transcript');

    console.log('\n— notes');
    await goTab('notes', 'Notes');
    await setValue('#prod-note-title', `UI note ${suffix}`);
    await setValue('#prod-note-body', 'Note body for the productivity UI smoke test.');
    await setValue('#prod-note-tags', 'smoke,ui');
    await clickId('prod-note-save');
    await until(`document.getElementById('prod-notes-list')?.textContent.includes(${JSON.stringify(`UI note ${suffix}`)})`, 12000, 'the saved note');
    check('a note is created in the memory store', true);
    await setValue('#prod-notes-query', `UI note ${suffix}`);
    await clickId('prod-notes-search');
    await until(`document.getElementById('prod-notes-list')?.textContent.includes(${JSON.stringify(`UI note ${suffix}`)})`, 8000, 'the search result');
    check('search finds the note', true);
    await setValue('#prod-note-body', 'Note body updated by the productivity UI smoke.');
    await clickId('prod-note-save');
    await sleep(600);
    const noteData = await ok('productivity', 'noteList', { query: `UI note ${suffix}` });
    check('the edited body is persisted', noteData.notes.some((note) => note.body.includes('updated by the productivity UI smoke')));
    check('the note keeps its tags', noteData.notes.some((note) => note.tags.includes('smoke') && note.tags.includes('ui')));
    await clickId('prod-note-delete');
    await until(`!document.getElementById('prod-notes-list')?.textContent.includes(${JSON.stringify(`UI note ${suffix}`)})`, 10000, 'the note removal');
    const afterNote = await ok('productivity', 'noteList', { query: `UI note ${suffix}` });
    check('deleting removes the note from the bridge too', !afterNote.notes.some((note) => note.title === `UI note ${suffix}`));
    check('the RAG question box is wired', (await count('#prod-notes-ask-q')) === 1 && (await count('#prod-notes-ask')) === 1);

    console.log('\n— tasks');
    await goTab('tasks', 'Tasks');
    await until(`!!document.getElementById('prod-task-stats')`, 8000, 'the task tiles');
    const before = await ok('productivity', 'taskStats');
    await setValue('#prod-task-title', `UI task ${suffix}`);
    await setValue('#prod-task-notes', 'created by the productivity ui smoke');
    await setValue('#prod-task-priority', '1');
    await clickId('prod-task-create');
    await until(`document.getElementById('prod-tasks-list')?.textContent.includes(${JSON.stringify(`UI task ${suffix}`)})`, 10000, 'the new task');
    const after = await ok('productivity', 'taskStats');
    check('creating a task updates the real counters', after.open === before.open + 1, `${before.open} → ${after.open}`);
    await setValue('#prod-task-status', 'all');
    await until(`document.querySelectorAll('#prod-tasks-list .prod-task').length >= 1`, 8000, 'the all-status list');
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('#prod-tasks-list .prod-task')].find((n) => n.textContent.includes(${JSON.stringify(`UI task ${suffix}`)}));
      if (!row) return false;
      row.querySelector('.prod-check')?.click();
      return true;
    })()`);
    await until(`(() => {
      const row = [...document.querySelectorAll('#prod-tasks-list .prod-task')].find((n) => n.textContent.includes(${JSON.stringify(`UI task ${suffix}`)}));
      return !!row && row.classList.contains('done');
    })()`, 8000, 'the completed task');
    check('toggling a task marks it done in the UI', true);
    const doneStats = await ok('productivity', 'taskStats');
    check('the done counter follows the toggle', doneStats.done === after.done + 1, `${after.done} → ${doneStats.done}`);
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('#prod-tasks-list .prod-task')].find((n) => n.textContent.includes(${JSON.stringify(`UI task ${suffix}`)}));
      if (!row) return false;
      const buttons = row.querySelectorAll('.prod-icon-btn');
      buttons[buttons.length - 1]?.click();
      return true;
    })()`);
    await until(`!document.getElementById('prod-tasks-list')?.textContent.includes(${JSON.stringify(`UI task ${suffix}`)})`, 8000, 'the task removal');
    check('deleting removes the task from the list', true);

    console.log('\n— translate');
    await goTab('translate', 'Translate');
    await clickId('prod-translate-run');
    await until(`document.body.textContent.includes('Type something to translate')`, 8000, 'the empty-translation error');
    check('translation refuses empty input honestly', true);
    check('the language pair is selectable', (await count('#prod-translate-source')) === 1 && (await count('#prod-translate-target')) === 1);

    console.log('\n— text editor');
    await goTab('text', 'Text editor');
    const textName = `ui-smoke-${suffix}.txt`;
    await setValue('#prod-text-name', textName);
    await setValue('#prod-text-body', 'first line\nsecond line\n');
    await clickId('prod-text-save');
    await until(`document.getElementById('prod-text-status')?.textContent.includes(${JSON.stringify(textName)})`, 10000, 'the text save status');
    check('a text file is written into the workspace', (await count('#prod-text-list .prod-note')) >= 1);
    const savedText = await ok('productivity', 'textOpen', textName);
    check('the saved text round-trips through the bridge', savedText.text.includes('second line'));
    await setValue('#prod-text-body', 'edited through the editor\n');
    await clickId('prod-text-save');
    await sleep(500);
    await evaluate(`[...document.querySelectorAll('#prod-text-list .prod-note')].find((n) => n.textContent.includes(${JSON.stringify(textName)}))?.click()`);
    await until(`document.getElementById('prod-text-body')?.value.includes('edited through the editor')`, 8000, 'the reopened text');
    check('reopening a file loads its contents', true);
    await setValue('input[placeholder="New name for rename"]', `ui-smoke-renamed-${suffix}.txt`);
    await clickId('prod-text-rename');
    await until(`document.getElementById('prod-text-status')?.textContent.includes('Renamed')`, 8000, 'the rename status');
    check('rename moves the file', (await count('#prod-text-list .prod-note')) >= 1);
    await clickId('prod-text-delete');
    await until(`!document.getElementById('prod-text-list')?.textContent.includes(${JSON.stringify(`ui-smoke-renamed-${suffix}.txt`)})`, 8000, 'the text removal');
    check('delete removes the file from the workspace', true);

    console.log('\n— slides');
    await goTab('slides', 'Slides');
    await setValue('#prod-slides-title', `UI deck ${suffix}`);
    await setValue('#prod-slides-subtitle', 'Built by the UI smoke');
    await clickId('prod-slides-add');
    await until(`document.querySelectorAll('#prod-slides-editor .prod-block').length === 1`, 6000, 'the slide editor');
    await evaluate(`(() => {
      const block = document.querySelector('#prod-slides-editor .prod-block');
      const inputs = block.querySelectorAll('input.text-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inputs[0], 'First content slide');
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      const area = block.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, 'Point one\\nPoint two');
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await clickId('prod-slides-build');
    await until(`!!document.getElementById('prod-slides-result')`, 15000, 'the built deck');
    const slidePath = await text('#prod-slides-result .prod-mono');
    if (slidePath) created.push(slidePath);
    check('the PPTX is written to disk', !!slidePath && fs.existsSync(slidePath), slidePath);
    check('the deck reports both slides', (await text('#prod-slides-result .prod-meta-row')).includes('2 slides'));

    console.log('\n— compare');
    await goTab('compare', 'Compare');
    await setValue('#prod-compare-a', diffA);
    await setValue('#prod-compare-b', diffB);
    await clickId('prod-compare-run');
    await until(`!!document.getElementById('prod-compare-result')`, 10000, 'the diff result');
    const compareText = await text('#prod-compare-result .prod-meta-row');
    check('the diff counts real changes', compareText.includes('+2') && compareText.includes('−1'), compareText.replace(/\s+/g, ' '));
    check('added and removed lines are marked', (await count('#prod-compare-result .prod-diff-line.add')) >= 1 && (await count('#prod-compare-result .prod-diff-line.remove')) >= 1);
    await setValue('#prod-compare-b', diffA);
    await clickId('prod-compare-run');
    await until(`document.getElementById('prod-compare-result')?.textContent.includes('identical')`, 8000, 'the identical result');
    check('comparing a file with itself reports identical', true);

    console.log('\n— return');
    await evaluate(`document.querySelector('.page-back')?.click()`);
    await until(`document.querySelector('.page-title')?.textContent !== 'Productivity'`, 8000, 'the dashboard');
    check('the back button leaves the page cleanly', true);

    if (created.length) {
      for (const file of created) {
        try {
          if (fs.existsSync(file)) fs.rmSync(file, { force: true });
        } catch {
          /* the smoke still passes if cleanup is blocked */
        }
      }
      check('smoke artifacts were cleaned up', created.every((file) => !fs.existsSync(file)));
    }

    try {
      await ok('productivity', 'sqlRun', { sql: `DROP TABLE IF EXISTS ${TABLE}` });
    } catch {
      /* the drop is best-effort cleanup */
    }
  } catch (err) {
    check('the Productivity UI suite ran without fatal errors', false, err && err.stack ? err.stack.split('\n')[0] : String(err));
    if (cdp) cdp.ws.close();
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* temp cleanup is best-effort */
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed${passed === results.length ? '' : ' — FAILURES PRESENT'}`);
  process.exit(passed === results.length ? 0 : 1);
})();
