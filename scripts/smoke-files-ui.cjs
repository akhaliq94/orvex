'use strict';

/**
 * Section 9 Files workspace UI smoke over CDP.
 * Seeds a temporary real folder (text, duplicates, PDFs, workbook, zip, diff
 * pair), then drives the real page: path bar, listing, search, preview,
 * rename, versions restore, backups, duplicates, archive listing, PDF info,
 * sheet preview, doc text load, diff and the live folder watcher.
 * Cleans up every seeded file in finally.
 *
 * Needs the ORVEX window running with --remote-debugging-port=9222.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.ORVEX_CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!res.ok) throw new Error(`CDP list failed: HTTP ${res.status}`);
  return res.json();
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const events = [];
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(e));
  });
  ws.addEventListener('message', (msg) => {
    const data = JSON.parse(msg.data);
    if (data.method) events.push(data);
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
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, ready, events };
}

let pass = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
    pass += 1;
  } else {
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

async function main() {
  const work = path.join(os.tmpdir(), `orvex-files-ui-${Date.now().toString(36)}`);
  fs.mkdirSync(work, { recursive: true });
  const fwd = work.replace(/\\/g, '/');

  const list = await targets();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('No page target — is the ORVEX window open?');
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed');
    return r.result.value;
  };
  const until = async (expression, timeoutMs, label) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const value = await evaluate(expression);
      if (value) return value;
      await sleep(200);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const clickText = (selector, text, exact = false) =>
    evaluate(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const hit = nodes.find((n) => ${exact ? `n.textContent.trim() === ${JSON.stringify(text)}` : `n.textContent.includes(${JSON.stringify(text)})`});
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
  const setValue = (selector, value) =>
    evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    })()`);
  const clickRow = (name) =>
    evaluate(`(() => {
      const hit = [...document.querySelectorAll('.fm-row')].find((r) => r.querySelector('.fm-name')?.textContent.trim() === ${JSON.stringify(name)});
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
  const rowNames = () =>
    evaluate(`[...document.querySelectorAll('.fm-row')].map((r) => r.querySelector('.fm-name')?.textContent.trim())`);
  const filesEval = (body) =>
    evaluate(`(async () => {
      const api = window.orvex?.files;
      if (!api) return { ok: false, error: 'no bridge' };
      ${body}
    })()`);

  let pageMounted = false;

  try {
    const exposed = await until(`!!window.orvex?.files && typeof window.orvex.files.list === 'function'`, 20000, 'the files bridge');
    check('files bridge is exposed', exposed === true);

    const seeded = await filesEval(`
      const f = window.orvex.files;
      const work = ${JSON.stringify(fwd)};
      const dir = await f.mkdir(work, true);
      if (!dir.ok) return { ok: false, error: dir.error };
      const hello = work + '/hello.txt';
      const steps = [
        ['write hello', () => f.write(hello, 'hello from ui smoke v1\\nsecond line\\n')],
        ['write dup a', () => f.write(work + '/dup-a.txt', 'duplicate payload '.repeat(90))],
        ['write dup b', () => f.write(work + '/dup-b.txt', 'duplicate payload '.repeat(90))],
        ['write left', () => f.write(work + '/left.txt', 'one\\ntwo\\nthree\\n')],
        ['write right', () => f.write(work + '/right.txt', 'one\\nTWO\\nthree\\nfour\\n')],
        ['pdf a', () => f.pdfCreate(work + '/a.pdf', 'UI Smoke A', 'Body of document A.')],
        ['pdf b', () => f.pdfCreate(work + '/b.pdf', 'UI Smoke B', 'Body of document B.')],
        ['workbook', () => f.xlsxWrite(work + '/sheet.xlsx', [{ name: 'Data', rows: [['name', 'qty'], ['apple', 3], ['pear', 5]] }])],
        ['zip', () => f.zip(work + '/bundle.zip', [hello])],
      ];
      for (const [label, run] of steps) {
        const result = await run();
        if (!result.ok) return { ok: false, error: label + ': ' + result.error };
      }
      return { ok: true };
    `);
    check('temporary workspace seeded', seeded?.ok === true, seeded?.error || '');

    // Fresh renderer so the page mounts with seeded folders.
    try {
      await cdp.send('Page.enable');
      await cdp.send('Page.reload', { ignoreCache: true });
    } catch {
      /* Page domain may be unavailable */
    }
    const reloadStart = Date.now();
    while (Date.now() - reloadStart < 20000) {
      try {
        if (await evaluate(`!!window.orvex?.files`)) break;
      } catch {
        /* context is being replaced */
      }
      await sleep(200);
    }

    await until(`[...document.querySelectorAll('.nav-item')].some((n) => n.textContent.trim() === 'Files')`, 20000, 'the Files nav item');
    await clickText('.nav-item', 'Files', true);
    await until(`document.querySelector('.page-title')?.textContent === 'Files'`, 10000, 'the Files page');
    await until(`!!document.querySelector('.fm-roots')`, 10000, 'the file landing');
    pageMounted = true;

    const roots = await evaluate(`document.querySelectorAll('.fm-root').length`);
    check('Landing shows quick-access roots and a folder picker', roots >= 5, `${roots} cards`);
    check('Landing has a path bar', await evaluate(`!!document.querySelector('.fm-path-input')`));

    await setValue('.fm-path-input', fwd);
    await evaluate(`document.querySelector('.fm-pathbar .btn-primary')?.click()`);
    await until(`[...document.querySelectorAll('.fm-row')].some((r) => r.textContent.includes('hello.txt'))`, 15000, 'the seeded folder listing');
    const names = await rowNames();
    check('Listing shows every seeded file', ['hello.txt', 'dup-a.txt', 'dup-b.txt', 'left.txt', 'right.txt', 'a.pdf', 'b.pdf', 'sheet.xlsx', 'bundle.zip'].every((n) => names.includes(n)), JSON.stringify(names));
    check('Table has name/size/modified headers', await evaluate(`(() => {
      const heads = [...document.querySelectorAll('.fm-th')].map((n) => n.textContent.trim());
      return heads.length === 3 && heads[0].startsWith('Name') && heads[1].startsWith('Size') && heads[2].startsWith('Modified');
    })()`));

    // New folder through the toolbar.
    await evaluate(`document.querySelector('[aria-label="New folder"]')?.click()`);
    await until(`!!document.querySelector('.fm-newbar input')`, 5000, 'the new-folder bar');
    await setValue('.fm-newbar input', 'made-in-ui');
    await clickText('.fm-newbar .btn-primary', 'Create', true);
    await until(`[...document.querySelectorAll('.fm-row')].some((r) => r.querySelector('.fm-name')?.textContent.trim() === 'made-in-ui')`, 10000, 'the new folder row');
    check('New folder creates a real directory', (await rowNames()).includes('made-in-ui'));

    await setValue('.fm-search input', 'hello');
    await evaluate(`document.querySelector('[aria-label="Search folder"]')?.click()`);
    await until(`document.querySelector('.fm-search-note')?.textContent.includes('match')`, 10000, 'search results note');
    check('Folder search filters to the match', (await rowNames()).includes('hello.txt'));

    await clickText('.fm-search-note .fm-link', 'Clear', true);
    await until(`[...document.querySelectorAll('.fm-row')].some((r) => r.textContent.includes('sheet.xlsx'))`, 10000, 'the full listing again');

    await clickRow('hello.txt');
    await until(`!!document.querySelector('.fm-detail .fm-meta')`, 10000, 'the file inspector');
    const detail = await evaluate(`(() => ({
      sha: [...document.querySelectorAll('.fm-meta b')].map((b) => b.textContent.trim()).find((t) => /^[a-f0-9]{64}$/.test(t)) || '',
      preview: document.querySelector('.fm-preview')?.textContent || '',
      actions: [...document.querySelectorAll('.fm-actions button')].map((b) => b.textContent.trim()),
    }))()`);
    check('Inspector shows a real SHA-256', detail.sha.length === 64, detail.sha);
    check('Inspector previews text content', detail.preview.includes('hello from ui smoke v1'));
    check('Inspector offers open, reveal, rename, delete', ['Open with app', 'Show in Explorer', 'Rename', 'Delete'].every((a) => detail.actions.some((b) => b.includes(a))), JSON.stringify(detail.actions));

    // Copy and paste in the same folder.
    await clickText('.fm-actions button', 'Copy', true);
    await evaluate(`document.querySelector('[aria-label="Paste copied file"]')?.click()`);
    await until(`[...document.querySelectorAll('.fm-row')].some((r) => r.querySelector('.fm-name')?.textContent.trim() === 'hello (copy).txt')`, 10000, 'the pasted copy');
    const copyBytes = await filesEval(`
      const f = window.orvex.files;
      const r = await f.read(${JSON.stringify(fwd + '/hello (copy).txt')});
      return { ok: r.ok, text: r.ok ? r.data.text : r.error };
    `);
    check('Copy + paste writes an identical file', copyBytes.ok && copyBytes.text.includes('hello from ui smoke v1'), copyBytes.text);

    // Rename through the real backend.
    await clickText('.fm-actions button', 'Rename', true);
    await until(`!!document.querySelector('.fm-rename input')`, 5000, 'the rename input');
    await setValue('.fm-rename input', 'hello-renamed.txt');
    await clickText('.fm-rename button', 'Save', true);
    await until(`[...document.querySelectorAll('.fm-row')].some((r) => r.querySelector('.fm-name')?.textContent.trim() === 'hello-renamed.txt')`, 10000, 'the renamed row');
    check('Rename updates the row', true);

    // Version history + restore (content changed outside the page).
    const changed = await filesEval(`
      const f = window.orvex.files;
      const written = await f.write(${JSON.stringify(fwd + '/hello-renamed.txt')}, 'hello from ui smoke v2\\n');
      if (!written.ok) return { ok: false, error: written.error };
      const vers = await f.versions(${JSON.stringify(fwd + '/hello-renamed.txt')});
      return { ok: vers.ok, count: vers.ok ? vers.data.length : 0 };
    `);
    check('Overwrite created a version snapshot', changed.ok && changed.count >= 1, JSON.stringify(changed));
    await evaluate(`document.querySelector('[aria-label="Refresh"]')?.click()`);
    await sleep(400);
    await clickRow('hello-renamed.txt');
    await until(`!!document.querySelector('.fm-tool-history') || !!document.querySelector('.fm-detail .fm-meta')`, 10000, 'the refreshed inspector');
    await clickText('.fm-tool-tabs button', 'Versions', true);
    await until(`!!document.querySelector('.fm-tool-history')`, 5000, 'the history panel');
    await until(`document.querySelectorAll('.fm-history-col .fm-history-row').length > 0`, 10000, 'version rows');
    check('Versions panel lists snapshots', true);
    await clickText('.fm-history-col .fm-history-row .fm-link', 'Restore', true);
    const restored = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 10000) {
        const r = await filesEval(`
          const f = window.orvex.files;
          const read = await f.read(${JSON.stringify(fwd + '/hello-renamed.txt')});
          return { ok: read.ok, text: read.ok ? read.data.text : read.error };
        `);
        if (r.ok && r.text.includes('v1')) return r;
        await sleep(250);
      }
      return { ok: false, text: 'timed out' };
    })();
    check('Restore from the UI brings the old content back', restored.ok && restored.text.includes('v1'), restored.text);

    // Duplicates.
    await clickText('.fm-tool-tabs button', 'Duplicates', true);
    await until(`!!document.querySelector('.fm-tool-duplicates')`, 5000, 'the duplicates panel');
    await clickText('.fm-tool-duplicates .btn-primary', 'Scan this folder', false);
    await until(`!!document.querySelector('.fm-dup-group')`, 20000, 'duplicate groups');
    const dupText = await evaluate(`document.querySelector('.fm-tool-duplicates')?.textContent || ''`);
    check('Duplicate scanner groups the seeded twins', dupText.includes('1 groups') || dupText.includes('dup-a.txt'), dupText.slice(0, 160));

    // Archive listing without native dialogs.
    await clickRow('bundle.zip');
    await until(`!!document.querySelector('.fm-detail .fm-meta')`, 10000, 'the zip inspector');
    await clickText('.fm-tool-tabs button', 'Archive', true);
    await until(`!!document.querySelector('.fm-tool-archive')`, 5000, 'the archive panel');
    await clickText('.fm-tool-archive button', 'List zip contents', false);
    await until(`!!document.querySelector('.fm-list-box')`, 10000, 'zip entries');
    check('Archive panel lists zip entries', (await evaluate(`document.querySelector('.fm-list-box')?.textContent || ''`)).includes('hello.txt'));

    // PDF info.
    await clickRow('a.pdf');
    await until(`!!document.querySelector('.fm-detail .fm-meta')`, 10000, 'the pdf inspector');
    await clickText('.fm-tool-tabs button', 'PDF', true);
    await until(`!!document.querySelector('.fm-tool-pdf')`, 5000, 'the PDF panel');
    await clickText('.fm-tool-pdf button', 'Read info', false);
    await until(`!!document.querySelector('.fm-inline-grid')`, 10000, 'PDF info');
    const pdfText = await evaluate(`document.querySelector('.fm-inline-grid')?.textContent || ''`);
    check('PDF tool reads page count and metadata', pdfText.includes('Pages') && pdfText.includes('UI Smoke A'), pdfText.slice(0, 160));
    check('PDF tool offers split, rotate and metadata', await evaluate(`(() => {
      const t = document.querySelector('.fm-tool-pdf')?.textContent || '';
      return t.includes('Split into folder') && t.includes('Rotate') && t.includes('Save metadata');
    })()`));

    // Spreadsheet preview.
    await clickRow('sheet.xlsx');
    await until(`!!document.querySelector('.fm-detail .fm-meta')`, 10000, 'the workbook inspector');
    await clickText('.fm-tool-tabs button', 'Sheets', true);
    await until(`!!document.querySelector('.fm-tool-sheets')`, 5000, 'the sheets panel');
    await clickText('.fm-tool-sheets button', 'Load sheet', false);
    await until(`!!document.querySelector('.fm-sheet table')`, 10000, 'the sheet table');
    const sheetText = await evaluate(`document.querySelector('.fm-sheet')?.textContent || ''`);
    check('Sheet preview shows real cells', sheetText.includes('apple') && sheetText.includes('pear'), sheetText.slice(0, 160));

    // Word: load selected text into the markdown box.
    await clickRow('hello-renamed.txt');
    await until(`!!document.querySelector('.fm-detail .fm-meta')`, 10000, 'the text inspector');
    await clickText('.fm-tool-tabs button', 'Word', true);
    await until(`!!document.querySelector('.fm-tool-doc textarea')`, 5000, 'the doc panel');
    await clickText('.fm-tool-doc button', 'Load selected text', false);
    const docText = await evaluate(`document.querySelector('.fm-tool-doc textarea')?.value || ''`);
    check('Word tool loads the selected file text', docText.includes('hello from ui smoke'), docText.slice(0, 120));

    // Diff driven by real paths.
    await clickText('.fm-tool-tabs button', 'Diff', true);
    await until(`!!document.querySelector('.fm-tool-diff')`, 5000, 'the diff panel');
    await setValue('[aria-label="First file path"]', fwd + '/left.txt');
    await setValue('[aria-label="Second file path"]', fwd + '/right.txt');
    await clickText('.fm-tool-diff .btn-primary', 'Compare', false);
    await until(`document.querySelectorAll('.fm-diff-line.add').length > 0`, 10000, 'diff rows');
    const diffCounts = await evaluate(`({
      add: document.querySelectorAll('.fm-diff-line.add').length,
      remove: document.querySelectorAll('.fm-diff-line.remove').length,
    })`);
    check('Diff marks added and removed lines', diffCounts.add >= 1 && diffCounts.remove >= 1, JSON.stringify(diffCounts));

    // Backups through the history tab.
    await clickText('.fm-tool-tabs button', 'Versions', true);
    await until(`!!document.querySelector('.fm-tool-history')`, 5000, 'the history panel again');
    await clickText('.fm-tool-history .btn-primary', 'Back up this file now', false);
    await until(`document.querySelectorAll('.fm-history-col:nth-child(2) .fm-history-row').length > 0`, 10000, 'backup rows');
    check('Back up creates a restorable backup row', true);

    // Watcher: start, receive a real change, stop.
    await clickText('.fm-tool-tabs button', 'Watcher', true);
    await until(`!!document.querySelector('.fm-tool-watch')`, 5000, 'the watcher panel');
    await clickText('.fm-tool-watch .btn-primary', 'Watch this folder', false);
    await until(`(document.querySelector('.fm-tool-watch')?.textContent || '').includes('watching since')`, 15000, 'the active watcher');
    const live = await filesEval(`
      const f = window.orvex.files;
      const r = await f.write(${JSON.stringify(fwd + '/watcher-new.txt')}, 'live change');
      return { ok: r.ok, error: r.ok ? '' : r.error };
    `);
    check('Live change written for the watcher', live.ok === true, live.error);
    await until(`[...document.querySelectorAll('.fm-event')].some((e) => e.textContent.includes('watcher-new.txt'))`, 15000, 'a watcher event');
    check('Watcher streams change events into the page', true);
    await clickText('.fm-tool-watch .btn-primary', 'Stop watching this folder', false);
    await until(`(document.querySelector('.fm-tool-watch')?.textContent || '').includes('Watch this folder')`, 10000, 'the stopped watcher');
    check('Watcher stops cleanly', true);

    // Delete confirmation. The live write needs a listing refresh first.
    await evaluate(`document.querySelector('[aria-label="Refresh"]')?.click()`);
    await until(`[...document.querySelectorAll('.fm-row')].some((r) => r.querySelector('.fm-name')?.textContent.trim() === 'watcher-new.txt')`, 10000, 'the new file in the listing');
    check('Refresh brings the externally created file into the listing', await clickRow('watcher-new.txt'));
    await until(`document.querySelector('.fm-detail .fm-title strong')?.textContent === 'watcher-new.txt' && !!document.querySelector('.fm-detail .fm-meta')`, 10000, 'the new file inspector');
    await clickText('.fm-actions button', 'Delete', true);
    await until(`[...document.querySelectorAll('.fm-actions button')].some((b) => b.textContent.trim() === 'Confirm delete')`, 5000, 'the delete confirmation');
    await clickText('.fm-actions button', 'Confirm delete', true);
    const diskGone = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 10000) {
        const r = await filesEval(`
          const f = window.orvex.files;
          const s = await f.stat(${JSON.stringify(fwd + '/watcher-new.txt')});
          return { ok: s.ok, error: s.ok ? '' : s.error };
        `);
        if (!r.ok) return true;
        await sleep(200);
      }
      return false;
    })();
    check('Delete removes the file from disk', diskGone);
    await until(`![...document.querySelectorAll('.fm-row')].some((r) => r.querySelector('.fm-name')?.textContent.trim() === 'watcher-new.txt')`, 10000, 'the deleted row');
    const remaining = await rowNames();
    const errorText = await evaluate(`document.querySelector('.fm-error')?.textContent || ''`);
    check('Delete removes the file after confirmation', !remaining.includes('watcher-new.txt'), JSON.stringify({ remaining, errorText }));

    // Guardrails: a system folder must be refused in the UI.
    try {
      await cdp.send('Page.reload', { ignoreCache: true });
    } catch {
      /* ignore */
    }
    const guardStart = Date.now();
    while (Date.now() - guardStart < 20000) {
      try {
        if (await evaluate(`!!window.orvex?.files`)) break;
      } catch {
        /* context replaced */
      }
      await sleep(200);
    }
    await until(`[...document.querySelectorAll('.nav-item')].some((n) => n.textContent.trim() === 'Files')`, 20000, 'the Files nav after reload');
    await clickText('.nav-item', 'Files', true);
    await until(`!!document.querySelector('.fm-path-input')`, 10000, 'the landing path bar');
    await setValue('.fm-path-input', 'C:\\Windows');
    await evaluate(`document.querySelector('.fm-pathbar .btn-primary')?.click()`);
    await until(`(document.querySelector('.fm-error')?.textContent || '').includes('Blocked')`, 10000, 'the guardrail error');
    check('System folders are blocked in the UI', true);
    pageMounted = false;
  } finally {
    try {
      if (pageMounted || (await evaluate(`!!window.orvex?.files`))) {
        await filesEval(`
          const f = window.orvex.files;
          const status = await f.watchStatus();
          if (status.ok) for (const w of status.data.watching) await f.watchStop(w.id);
          await f.remove(${JSON.stringify(fwd)}, true);
          return { ok: true };
        `);
      }
    } catch {
      /* app may be closing */
    }
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    cdp.ws.close();
  }

  console.log(`\n${pass} checks passed${process.exitCode ? ' — with failures' : ''}`);
}

main().catch((err) => {
  console.error('\nFATAL', err && err.stack ? err.stack : err);
  process.exit(1);
});
