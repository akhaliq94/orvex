'use strict';

/**
 * Section 7 Research page UI smoke over CDP.
 * Drives the real Reader against a local HTTP server (HTML table, multi-page
 * PDF, scanned PDF, 404), saves a document to the library, opens the saved
 * report, filters/deletes it, and checks the New research form.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { makePdf, makeDocx } = require('./lib/doc-fixtures.cjs');

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
    pass++;
  } else {
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

function makeOcrImage() {
  const file = path.join(os.tmpdir(), `orvex-research-ui-ocr-${process.pid}.png`);
  const script = `Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 900,260
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$font = New-Object System.Drawing.Font('Segoe UI', 40)
$g.DrawString('UI OCR SMOKE 24680', $font, [System.Drawing.Brushes]::Black, 30, 40)
$g.DrawString('Second OCR line for the reader', $font, [System.Drawing.Brushes]::Black, 30, 130)
$bmp.Save('${file.replace(/\\/g, '/')}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 60000,
    windowsHide: true,
  });
  return file;
}

function startServer(ocrPng) {
  const article = `<!doctype html><html><head><title>UI Smoke Article</title></head><body>
    <article><h1>UI smoke article</h1>
    <p>Paragraph read through the Research reader.</p>
    <table><tr><th>Key</th><th>Value</th></tr><tr><td>alpha</td><td>1</td></tr><tr><td>beta</td><td>2</td></tr></table>
    </article></body></html>`;
  const pdf = makePdf([
    ['ORVEX UI PDF ONE', 'alpha beta'],
    ['ORVEX UI PDF TWO', 'gamma delta'],
    ['ORVEX UI PDF THREE', 'epsilon'],
  ]);
  const scan = makePdf([[]]);
  const docx = makeDocx({ title: 'UI Smoke DOCX', paragraphs: ['Remote docx paragraph for the reader.'] });
  const routes = new Map([
    ['/ui-smoke-article.html', { type: 'text/html; charset=utf-8', body: article }],
    ['/ui-smoke-paper.pdf', { type: 'application/pdf', body: pdf }],
    ['/ui-smoke-scan.pdf', { type: 'application/pdf', body: scan }],
    ['/ui-smoke-notes.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: docx }],
    ['/ui-smoke-ocr.png', { type: 'image/png', body: ocrPng }],
  ]);
  const server = http.createServer((req, res) => {
    const route = routes.get(new URL(req.url, 'http://localhost').pathname);
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': route.type, 'content-length': Buffer.byteLength(route.body) });
    res.end(route.body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const ocrImage = makeOcrImage();
  const server = await startServer(fs.readFileSync(ocrImage));
  const origin = `http://127.0.0.1:${server.address().port}`;

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
  const submitUrlThroughUi = async (url) => {
    await setValue('.research-url-input', url);
    await sleep(120);
    await clickText('.research-reader-row button', 'Read');
  };
  const readUrlThroughUi = async (url, needle, timeoutMs, label) => {
    await submitUrlThroughUi(url);
    return until(
      `(document.querySelector('.research-document')?.textContent || '').includes(${JSON.stringify(needle)})`,
      timeoutMs,
      label,
    );
  };

  let stale = -1;
  try {
    check('research bridge is exposed', await evaluate(`!!window.orvex?.research`));

    stale = await evaluate(`(async () => {
      const api = window.orvex?.research;
      if (!api) return -1;
      const r = await api.list();
      if (!r.ok) return -2;
      let n = 0;
      for (const entry of r.data) {
        if (String(entry.title || '').startsWith('ui-smoke-')) {
          const removed = await api.remove(entry.id);
          if (removed.ok) n += 1;
        }
      }
      return n;
    })()`);
    check('stale smoke reports from earlier runs are cleaned', stale >= 0, `${stale} removed`);

    await clickText('.nav-item', 'Research', true);
    await until(`document.querySelector('.page-title')?.textContent === 'Research'`, 10000, 'the Research page');
    await until(`!!document.querySelector('.research-layout')`, 10000, 'the research layout');
    await until(`!document.querySelector('.research-lib-list')?.textContent.includes('Loading library')`, 10000, 'the library');

    const shell = await evaluate(`(() => ({
      sub: document.querySelector('.page-sub')?.textContent || '',
      tabs: [...document.querySelectorAll('.research-tab')].map((b) => b.textContent.trim()),
      hint: document.querySelector('.research-hint')?.textContent || '',
      count: document.querySelector('.research-lib-count')?.textContent || '',
      question: !!document.querySelector('.research-question'),
      sources: document.querySelector('.research-sources-input')?.value || '',
    }))()`);
    check('Research page renders its subtitle, tabs and library', shell.sub.includes('cited report library') && shell.tabs.some((t) => t.includes('New research')) && shell.tabs.some((t) => t.includes('Reader')));
    check('Provider hint is honest about synthesis vs extractive', /No AI provider|Planning and synthesis use/.test(shell.hint), shell.hint.slice(0, 90));
    check('New research form defaults to Standard with 8 sources', shell.question && shell.sources === '8', `sources=${shell.sources}`);

    await setValue('.research-question', 'ab');
    await sleep(120);
    await clickText('.research-form-row button', 'Run research');
    await until(`(document.querySelector('.research-new .research-error.inline')?.textContent || '').includes('at least 3')`, 5000, 'the short-question error');
    check('Short questions are rejected in the UI', true);
    await evaluate(`document.querySelector('.research-new .research-error.inline button')?.click()`);

    await clickText('.research-depth-btn', 'Deep', true);
    await until(`document.querySelector('.research-sources-input')?.value === '14'`, 5000, 'Deep source count');
    await clickText('.research-depth-btn', 'Quick', true);
    await until(`document.querySelector('.research-sources-input')?.value === '4'`, 5000, 'Quick source count');
    check('Depth buttons update the source budget', true);

    await clickText('.research-tab', 'Reader');
    await until(`!!document.querySelector('.research-url-input')`, 5000, 'the reader URL input');
    check('Reader offers URL and file modes', await evaluate(`[...document.querySelectorAll('.research-reader-toggle button')].map((b) => b.textContent.trim()).join(',') === 'URL,File'`));

    await readUrlThroughUi(`${origin}/ui-smoke-article.html`, 'UI Smoke Article', 15000, 'the HTML document');
    const htmlView = await evaluate(`(() => ({
      title: document.querySelector('.research-document h3')?.textContent || '',
      chips: [...document.querySelectorAll('.research-document-meta .research-chip')].map((c) => c.textContent.trim()),
      tables: document.querySelectorAll('.research-md-table table').length,
      text: document.querySelector('.research-document')?.textContent || '',
      pre: !!document.querySelector('.research-doc-pre'),
    }))()`);
    check('Reader renders HTML as Markdown', htmlView.title === 'UI Smoke Article' && htmlView.text.includes('UI smoke article') && !htmlView.pre, htmlView.title);
    check('Reader keeps the HTML table as a rendered table', htmlView.tables === 1 && htmlView.text.includes('alpha') && htmlView.text.includes('beta'));
    check('Document meta shows kind, table and size chips', htmlView.chips.includes('HTML') && htmlView.chips.some((c) => c.includes('table')) && htmlView.chips.some((c) => /chars/.test(c)), htmlView.chips.join(', '));

    await readUrlThroughUi(`${origin}/ui-smoke-paper.pdf`, 'ORVEX UI PDF ONE', 20000, 'the PDF document');
    await until(`(document.querySelector('.research-doc-pre')?.textContent || '').includes('ORVEX UI PDF ONE')`, 10000, 'the PDF text');
    const pdfView = await evaluate(`(() => ({
      chips: [...document.querySelectorAll('.research-document-meta .research-chip')].map((c) => c.textContent.trim()),
      text: document.querySelector('.research-doc-pre')?.textContent || '',
    }))()`);
    check('Reader shows PDF text in a plain-text pane', pdfView.text.includes('ORVEX UI PDF ONE') && pdfView.text.includes('ORVEX UI PDF THREE'));
    check('PDF meta reports the real page count', pdfView.chips.includes('PDF') && pdfView.chips.includes('3 pages'), pdfView.chips.join(', '));

    await readUrlThroughUi(`${origin}/ui-smoke-scan.pdf`, '--- Page 1 ---', 20000, 'the scanned PDF');
    await until(`!!document.querySelector('.research-warning')`, 10000, 'the scan warning');
    const scanWarning = await evaluate(`document.querySelector('.research-warning')?.textContent || ''`);
    check('Scanned PDFs surface the OCR warning', /little or no extractable text/i.test(scanWarning) && scanWarning.length > 20, scanWarning.slice(0, 80));

    await readUrlThroughUi(`${origin}/ui-smoke-notes.docx`, 'UI Smoke DOCX', 20000, 'the DOCX document');
    const docxView = await evaluate(`(() => ({
      chips: [...document.querySelectorAll('.research-document-meta .research-chip')].map((c) => c.textContent.trim()),
      tables: document.querySelectorAll('.research-md-table table').length,
      text: document.querySelector('.research-document')?.textContent || '',
    }))()`);
    check(
      'Packaged DOCX engine reads text and its table',
      docxView.chips.includes('DOCX') &&
        docxView.chips.includes('1 table') &&
        docxView.tables === 1 &&
        docxView.text.includes('Remote docx paragraph') &&
        docxView.text.includes('North'),
      docxView.chips.join(', '),
    );

    await readUrlThroughUi(`${origin}/ui-smoke-ocr.png`, 'UI OCR SMOKE 24680', 30000, 'the OCR image');
    const ocrView = await evaluate(`(() => ({
      chips: [...document.querySelectorAll('.research-document-meta .research-chip')].map((c) => c.textContent.trim()),
      text: document.querySelector('.research-doc-pre')?.textContent || '',
    }))()`);
    check(
      'Packaged OCR reads text from a real image',
      ocrView.chips.includes('IMAGE') && /UI OCR SMOKE 24680/.test(ocrView.text) && /Second OCR line/.test(ocrView.text),
      ocrView.text.slice(0, 80).replace(/\n/g, ' '),
    );

    await submitUrlThroughUi(`${origin}/ui-smoke-missing.txt`);
    await until(`(document.querySelector('.research-reader .research-error.inline')?.textContent || '').includes('404')`, 10000, 'the 404 message');
    check('Failed reads show the real HTTP error', true);
    await evaluate(`document.querySelector('.research-reader .research-error.inline button')?.click()`);

    await readUrlThroughUi(`${origin}/ui-smoke-paper.pdf`, 'ORVEX UI PDF TWO', 20000, 'the PDF again');
    await until(`(document.querySelector('.research-doc-pre')?.textContent || '').includes('ORVEX UI PDF TWO')`, 10000, 'the PDF text to save');
    await clickText('.research-document-actions button', 'Save to library');
    await until(`document.querySelector('.research-report-head h3')?.textContent === 'ui-smoke-paper.pdf'`, 20000, 'the saved report view');
    check('Save to library opens the stored report', true);

    const reportView = await evaluate(`(() => ({
      chips: [...document.querySelectorAll('.research-report-head .research-chip')].map((c) => c.textContent.trim()),
      sources: [...document.querySelectorAll('.research-report-side .research-source')].map((s) => s.textContent),
      pre: document.querySelector('.research-report .research-md-pre')?.textContent || '',
      text: document.querySelector('.research-report .research-md')?.textContent || '',
    }))()`);
    check(
      'Saved document report keeps its metadata',
      reportView.chips.includes('Document') && reportView.chips.includes('saved read') && reportView.chips.some((c) => /1 source/.test(c)),
      reportView.chips.join(', '),
    );
    check('Saved report links back to its source', reportView.sources.length === 1 && reportView.sources[0].includes('ui-smoke-paper.pdf'), reportView.sources.join(' | '));
    check('Saved report keeps the extracted text', reportView.pre.includes('ORVEX UI PDF ONE') && reportView.text.includes('Source:'), '');

    const savedEntry = await evaluate(`(async () => {
      const r = await window.orvex.research.list();
      if (!r.ok) return null;
      return r.data.find((entry) => entry.title === 'ui-smoke-paper.pdf') || null;
    })()`);
    check('Library lists the saved document', !!savedEntry && savedEntry.kind === 'document' && savedEntry.status === 'done', savedEntry ? savedEntry.id : 'missing');

    await setValue('.research-search input', 'no-such-report-zzz');
    await sleep(200);
    await until(`(document.querySelector('.research-lib-list')?.textContent || '').includes('No report matches that filter.')`, 5000, 'the empty filter state');
    check('Library filter explains an empty match', true);
    await setValue('.research-search input', 'ui-smoke-paper');
    await until(`[...document.querySelectorAll('.research-lib-title')].some((t) => t.textContent.includes('ui-smoke-paper'))`, 5000, 'the filtered report');
    check('Library filter finds the report', true);
    await evaluate(`document.querySelector('.research-lib-item .research-lib-title')?.click()`);
    await until(`!!document.querySelector('.research-report-head')`, 10000, 'the report to reopen');
    check('Library click reopens the report', true);

    await evaluate(`document.querySelector('.research-report-head .research-document-actions button[title="Delete report"]')?.click()`);
    await until(`!!document.querySelector('.research-new') && !document.querySelector('.research-report-view')`, 10000, 'the report to be deleted');
    const afterDelete = await evaluate(`(async () => {
      const r = await window.orvex.research.list();
      return r.ok ? r.data.filter((entry) => String(entry.title || '').startsWith('ui-smoke-')).length : -1;
    })()`);
    check('Deleting the report clears it from the library', afterDelete === 0, `${afterDelete} left`);

    const exceptions = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
    check('no renderer exceptions on the Research page', exceptions.length === 0, exceptions.map((e) => e.params?.exceptionDetails?.text).join('; '));

    console.log(`\nSection 7 Research UI: ${pass} checks passed.`);
  } finally {
    try {
      await evaluate(`(async () => {
        const api = window.orvex?.research;
        if (!api) return;
        const r = await api.list();
        if (!r.ok) return;
        for (const entry of r.data) {
          if (String(entry.title || '').startsWith('ui-smoke-')) await api.remove(entry.id);
        }
      })()`);
    } catch {
      /* renderer may be gone */
    }
    cdp.ws.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(ocrImage, { force: true });
  }
}

main().catch((err) => {
  console.error('\nRESEARCH UI SMOKE FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
