'use strict';

/**
 * Section 7 backend smoke: document extraction (PDF/DOCX/HTML tables/CSV/OCR),
 * web.readUrl over a local HTTP server, and the deep-research pipeline with
 * injected fake search/gateway implementations.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const documents = require('../electron/documents.cjs');
const web = require('../electron/web.cjs');
const research = require('../electron/research.cjs');
const { makePdf, makeDocx, zipStored } = require('./lib/doc-fixtures.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function waitFor(fn, label, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await sleep(40);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function rejection(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

function recorder() {
  const events = [];
  return { events, emit: (event) => events.push(event) };
}

function fakeSourceBody(url) {
  return (
    `Source coverage for ${url}. ` +
    'This paragraph contains evidence, numbers 42 and 7, and a clear claim about the topic. '.repeat(5) +
    'The final sentence closes the evidence trail.'
  );
}

function makeFakeWeb(opts = {}) {
  const calls = { search: [], read: [] };
  const table = {
    'alpha query': [
      { title: 'Alpha primary', url: 'https://alpha.edu/paper', snippet: 'primary alpha evidence' },
      { title: 'Alpha news', url: 'https://news.example.com/alpha?utm_source=feed', snippet: 'news alpha' },
    ],
    'beta query': [
      { title: 'Alpha duplicate', url: 'https://alpha.edu/paper/', snippet: 'same paper, tracking-free copy' },
      { title: 'Beta blog', url: 'https://beta.org/post', snippet: 'beta analysis' },
    ],
    'gamma query': [
      { title: 'Gamma data', url: 'https://gamma.gov/data', snippet: 'official gamma numbers' },
      { title: 'Broken source', url: 'https://broken.example.com/x', snippet: 'this one refuses to load' },
    ],
    'extra one': [{ title: 'Follow-up source', url: 'https://followup.net/new', snippet: 'fills the gap' }],
  };
  return {
    calls,
    async search(queryText, max, { signal } = {}) {
      calls.search.push(queryText);
      if (signal && signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
      if (opts.failSearch) return { ok: false, error: 'Every search backend refused.', results: [] };
      const exact = table[queryText];
      const results = exact
        ? exact
        : [
            { title: 'Shared primary', url: 'https://shared.edu/primary?utm_source=feed', snippet: 'shared evidence' },
            {
              title: `Blog about ${queryText}`,
              url: `https://blog.example.com/${encodeURIComponent(queryText).replace(/%20/g, '-').slice(0, 40)}`,
              snippet: 'blog evidence',
            },
          ];
      return { ok: true, source: 'FakeSearch', results: results.slice(0, max) };
    },
    async readUrl(url, { maxChars = 12000, signal } = {}) {
      calls.read.push(url);
      if (url.includes('broken')) return { ok: false, error: 'HTTP 403 Forbidden' };
      if (opts.slowRead) {
        await new Promise((resolve, reject) => {
          if (signal && signal.aborted) return reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
          const timer = setTimeout(resolve, 15000);
          if (signal) {
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
              },
              { once: true },
            );
          }
        });
      } else if (signal && signal.aborted) {
        throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
      }
      const text = fakeSourceBody(url).slice(0, maxChars);
      return {
        ok: true,
        url,
        kind: 'html',
        mode: 'markdown',
        title: `Title of ${new URL(url).hostname}`,
        text,
        tables: [],
        warnings: [],
        chars: text.length,
        truncated: false,
      };
    },
  };
}

function makeFakeGateway() {
  const calls = [];
  return {
    calls,
    async chat(opts) {
      calls.push(opts);
      const props = (opts && opts.jsonSchema && opts.jsonSchema.properties) || {};
      if (props.questions && props.queries) {
        return {
          text: JSON.stringify({
            questions: ['What is the primary evidence?', 'Where do the sources disagree?'],
            queries: ['alpha query', 'beta query', 'gamma query'],
          }),
        };
      }
      if (props.queries) return { text: JSON.stringify({ queries: ['extra one'] }) };
      if (opts && opts.stream) {
        const pieces = [
          'The evidence points to a clear answer [1][2]. ',
          '## Key findings\n\n',
          '- First fact from the primary source [3].\n',
          '- Second fact with numbers [4].\n\n',
          '## Evidence\n\n',
          'A synthesised paragraph grounded in the named sources [5].\n\n',
          '## Sources\n\n1. fabricated source that must be stripped\n',
        ];
        let full = '';
        for (const piece of pieces) {
          full += piece;
          if (opts.onDelta) opts.onDelta(piece);
          await Promise.resolve();
        }
        return {
          text: full,
          usage: {},
          provider: { id: 'p1', name: 'Fake', model: 'fake-1' },
          model: 'fake-1',
          ms: 5,
        };
      }
      return { text: 'unexpected call' };
    },
  };
}

async function testDocuments(base) {
  console.log('\n— Document extraction —');

  const pdf = makePdf([
    ['ORVEX PDF PAGE ONE', 'alpha beta gamma'],
    ['ORVEX PDF PAGE TWO', 'delta epsilon zeta'],
  ]);
  const pdfDoc = await documents.extract({ buf: pdf, name: 'report.pdf' });
  check(
    'PDF: multi-page text with page map',
    pdfDoc.ok && pdfDoc.kind === 'pdf' && pdfDoc.mode === 'text' && pdfDoc.pageCount === 2,
    pdfDoc.ok ? `${pdfDoc.pageCount} pages, ${pdfDoc.chars} chars` : pdfDoc.error,
  );
  check(
    'PDF: text from both pages',
    pdfDoc.ok && pdfDoc.text.includes('PAGE ONE') && pdfDoc.text.includes('PAGE TWO') && pdfDoc.text.includes('epsilon'),
  );
  check('PDF: per-page character counts', pdfDoc.ok && pdfDoc.pages.length === 2 && pdfDoc.pages.every((p) => p.chars > 0));

  const scanDoc = await documents.extract({ buf: makePdf([[]]), name: 'scan.pdf' });
  check(
    'PDF: scan warning instead of silent emptiness',
    scanDoc.ok && scanDoc.pages[0].chars === 0 && scanDoc.warnings.some((w) => /little or no extractable text/i.test(w)),
    scanDoc.ok ? scanDoc.warnings.join(' | ') : scanDoc.error,
  );

  const docxDoc = await documents.extract({ buf: makeDocx(), name: 'notes.docx' });
  check(
    'DOCX: paragraphs extracted',
    docxDoc.ok && docxDoc.kind === 'docx' && docxDoc.text.includes('ORVEX DOCX SMOKE') && docxDoc.text.includes('Closing paragraph'),
    docxDoc.ok ? '' : docxDoc.error,
  );
  check(
    'DOCX: table becomes Markdown',
    docxDoc.ok &&
      docxDoc.tables.length === 1 &&
      docxDoc.tables[0].markdown.includes('| Region | Units | Revenue |') &&
      docxDoc.tables[0].markdown.includes('| North | 120 | 4800 |'),
    docxDoc.ok ? docxDoc.tables[0] && docxDoc.tables[0].markdown.split('\n')[0] : '',
  );

  const html = `<!doctype html><html><head><title>Smoke Article</title><style>.x{color:red}</style></head><body>
    <h1>Heading One</h1>
    <p>Paragraph with <b>bold</b> &amp; an entity.</p>
    <table>
      <tr><th colspan="2">Wide</th><th>Third</th></tr>
      <tr><td>A</td><td>B</td><td rowspan="2">C</td></tr>
      <tr><td>D</td><td>E</td></tr>
    </table>
    <script>bad()</script>
  </body></html>`;
  const htmlDoc = await documents.extract({ buf: Buffer.from(html), name: 'article.html' });
  check('HTML: title and readable text', htmlDoc.ok && htmlDoc.title === 'Smoke Article' && /Heading One/.test(htmlDoc.text));
  check('HTML: scripts and styles stripped', htmlDoc.ok && !htmlDoc.text.includes('bad()') && !htmlDoc.text.includes('color:red'));
  check(
    'HTML: colspan/rowspan table kept as Markdown',
    htmlDoc.ok &&
      htmlDoc.tables.length === 1 &&
      htmlDoc.tables[0].markdown.includes('| Wide | Wide | Third |') &&
      htmlDoc.tables[0].markdown.includes('| D | E | C |'),
    htmlDoc.ok && htmlDoc.tables[0] ? htmlDoc.tables[0].markdown.split('\n').join(' / ') : '',
  );

  const csv = 'name,note\n"Widget, large","he said ""hi"""\nplain,"no quote"\n';
  const csvDoc = await documents.extract({ buf: Buffer.from(csv), name: 'data.csv' });
  check(
    'CSV: quoted commas and doubled quotes survive',
    csvDoc.ok && csvDoc.kind === 'csv' && csvDoc.tables.length === 1 && csvDoc.text.includes('Widget, large') && csvDoc.text.includes('he said "hi"'),
    csvDoc.ok ? csvDoc.text.split('\n')[1] : csvDoc.error,
  );

  const rows = documents.parseDelimited('a,"b ""q""",c\nd,e,f', ',');
  check('CSV: parser keeps quotes inside unquoted fields', rows[0][1] === 'b "q"', JSON.stringify(rows[0]));

  const txtDoc = await documents.extract({ buf: Buffer.from('plain text contents'), name: 'doc.txt' });
  check('TXT: text mode', txtDoc.ok && txtDoc.kind === 'text' && txtDoc.mode === 'text' && txtDoc.text === 'plain text contents');

  const zipDoc = await documents.extract({ buf: zipStored([{ name: 'a.txt', data: 'x' }]), name: 'bundle.zip' });
  check('ZIP: refused honestly as not-a-DOCX', !zipDoc.ok && /not a DOCX/i.test(zipDoc.error), zipDoc.error || '');

  const binaryDoc = await documents.extract({ buf: Buffer.alloc(64, 0), name: 'blob.bin' });
  check('Binary: refused honestly', !binaryDoc.ok && /binary/i.test(binaryDoc.error), binaryDoc.error || '');

  let ocrCalled = 0;
  let ocrSawFile = false;
  documents.init({
    ocr: async (file) => {
      ocrCalled += 1;
      ocrSawFile = fs.existsSync(file);
      return { text: 'OCR SMOKE TEXT' };
    },
  });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 0)]);
  const ocrDoc = await documents.extract({ buf: png, name: 'scan.png' });
  check(
    'Image: OCR handler is called with the real file',
    ocrDoc.ok && ocrDoc.kind === 'image' && ocrDoc.text === 'OCR SMOKE TEXT' && ocrCalled === 1 && ocrSawFile,
    ocrDoc.ok ? ocrDoc.text : ocrDoc.error,
  );

  const folder = path.join(base, 'files');
  await fsp.mkdir(folder, { recursive: true });
  const txtPath = path.join(folder, 'note.txt');
  await fsp.writeFile(txtPath, 'extractFile smoke', 'utf8');
  const fileDoc = await documents.extractFile(txtPath);
  check(
    'extractFile: path, size and mtime included',
    fileDoc.ok && fileDoc.text === 'extractFile smoke' && fileDoc.path === txtPath && fileDoc.size > 0 && typeof fileDoc.mtime === 'number',
    fileDoc.ok ? `${fileDoc.size} bytes` : fileDoc.error,
  );

  const textMd = documents.toMarkdown({ ok: true, title: 'Plain note', text: 'line one\nline two', mode: 'text' });
  const richMd = documents.toMarkdown({ ok: true, title: 'Rich note', text: '## Heading', mode: 'markdown' });
  check(
    'toMarkdown: text fenced, markdown untouched',
    textMd.includes('# Plain note') && textMd.includes('```text') && richMd.includes('# Rich note') && richMd.includes('## Heading') && !richMd.includes('```text'),
  );
}

async function testWeb(base) {
  console.log('\n— web.readUrl over a local server —');

  const articleBody = 'The quick brown fox jumps over the lazy dog and records every observation. '.repeat(30);
  const article = `<!doctype html><html><head><title>Local Smoke</title></head><body><article>
    <h1>Local article</h1><p>${articleBody}</p>
    <table><tr><th>Key</th><th>Value</th></tr><tr><td>alpha</td><td>1</td></tr></table>
  </article></body></html>`;
  const pdf = makePdf([
    ['ORVEX LOCAL PDF ONE', 'alpha beta'],
    ['ORVEX LOCAL PDF TWO', 'gamma delta'],
    ['ORVEX LOCAL PDF THREE', 'epsilon'],
  ]);
  const docx = makeDocx({ title: 'Local DOCX', paragraphs: ['Remote docx paragraph.'] });
  const csv = 'region,units\nNorth,120\nSouth,90\n';

  const routes = new Map([
    ['/article.html', { type: 'text/html; charset=utf-8', body: article }],
    ['/paper.pdf', { type: 'application/pdf', body: pdf }],
    ['/notes.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: docx }],
    ['/data.csv', { type: 'text/csv; charset=utf-8', body: Buffer.from(csv) }],
    ['/doc.txt', { type: 'text/plain; charset=utf-8', body: Buffer.from('Local plain text.') }],
    ['/empty.html', { type: 'text/html; charset=utf-8', body: Buffer.from('<html><body><script>x()</script></body></html>') }],
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    const readArticle = await web.readUrl(`${origin}/article.html`, { maxChars: 60000 });
    check(
      'readUrl: HTML title, text and table',
      readArticle.ok &&
        readArticle.kind === 'html' &&
        readArticle.title === 'Local Smoke' &&
        readArticle.tables.length === 1 &&
        readArticle.text.includes('Local article') &&
        readArticle.text.includes('| alpha | 1 |'),
      readArticle.ok ? `${readArticle.chars} chars` : readArticle.error,
    );

    const cut = await web.readUrl(`${origin}/article.html`, { maxChars: 800 });
    check(
      'readUrl: maxChars truncates with a visible cut marker',
      cut.ok && cut.truncated && cut.text.length > 800 && /\[cut \d+ chars\]/.test(cut.text),
      cut.ok ? `${cut.text.length} chars` : cut.error,
    );

    const readPdf = await web.readUrl(`${origin}/paper.pdf`);
    check(
      'readUrl: PDF is read, not refused',
      readPdf.ok && readPdf.kind === 'pdf' && readPdf.pageCount === 3 && readPdf.text.includes('ORVEX LOCAL PDF ONE') && readPdf.text.includes('PDF THREE'),
      readPdf.ok ? web.describeRead(readPdf) : readPdf.error,
    );

    const readDocx = await web.readUrl(`${origin}/notes.docx`);
    check(
      'readUrl: DOCX over HTTP',
      readDocx.ok && readDocx.kind === 'docx' && readDocx.text.includes('Remote docx paragraph') && readDocx.tables.length === 1,
      readDocx.ok ? web.describeRead(readDocx) : readDocx.error,
    );

    const readCsv = await web.readUrl(`${origin}/data.csv`);
    check(
      'readUrl: CSV over HTTP',
      readCsv.ok && readCsv.kind === 'csv' && readCsv.text.includes('| North | 120 |'),
      readCsv.ok ? readCsv.text.split('\n')[0] : readCsv.error,
    );

    const readTxt = await web.readUrl(`${origin}/doc.txt`);
    check('readUrl: plain text over HTTP', readTxt.ok && readTxt.kind === 'text' && readTxt.text === 'Local plain text.');

    const missing = await web.readUrl(`${origin}/missing.txt`);
    check('readUrl: HTTP errors surface', !missing.ok && /HTTP 404/.test(missing.error), missing.error || '');

    const empty = await web.readUrl(`${origin}/empty.html`);
    check('readUrl: page without readable text is refused', !empty.ok && /no readable text/i.test(empty.error), empty.error || '');

    const fileUrl = await web.readUrl('file:///C:/Windows/win.ini');
    check('readUrl: file URLs blocked by guardrails', !fileUrl.ok && /Only http\(s\)/.test(fileUrl.error), fileUrl.error || '');

    const fetchedPdf = await web.handlers.web_fetch({ url: `${origin}/paper.pdf`, maxChars: 4000 });
    check(
      'web_fetch: reports PDF kind, page count and text',
      fetchedPdf.ok &&
        /Kind: PDF, 3 pages/.test(fetchedPdf.output) &&
        fetchedPdf.output.includes('URL: ') &&
        fetchedPdf.output.includes('ORVEX LOCAL PDF TWO'),
      fetchedPdf.ok ? fetchedPdf.output.split('\n').slice(0, 3).join(' | ') : fetchedPdf.error,
    );

    const fetchedDocx = await web.handlers.web_fetch({ url: `${origin}/notes.docx` });
    check(
      'web_fetch: DOCX reports its table',
      fetchedDocx.ok && /Kind: DOCX, 1 table/.test(fetchedDocx.output),
      fetchedDocx.ok ? fetchedDocx.output.split('\n')[2] : fetchedDocx.error,
    );

    const emptySearch = await web.handlers.web_search({ query: '' });
    check('web_search: empty query refused without network', !emptySearch.ok && /empty/i.test(emptySearch.error), emptySearch.error || '');

    const describe = web.describeRead({ kind: 'docx', tables: [{}, {}] });
    check('describeRead: counts tables', describe === 'DOCX, 2 tables', describe);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testResearch(base) {
  console.log('\n— Deep research pipeline —');

  const dataDir = path.join(base, 'research-data');
  await fsp.mkdir(dataDir, { recursive: true });
  const candidate = { id: 'p1', name: 'Fake', baseUrl: 'https://fake.local/v1', api: 'openai', model: 'fake-1' };

  const rec = recorder();
  const fakeWeb = makeFakeWeb();
  const fakeGw = makeFakeGateway();
  research.init({ dataDir, web: fakeWeb, gateway: fakeGw, emit: rec.emit });

  const started = await research.start({
    query: 'alpha beta gamma evidence review',
    depth: 'deep',
    maxSources: 6,
    candidates: [candidate],
  });
  check('start returns a run id immediately', !!started.runId && started.entry.status === 'running', started.runId);

  const done = await waitFor(async () => {
    const entry = await research.get(started.runId);
    return entry && entry.status !== 'running' ? entry : null;
  }, 'the deep run to finish');

  check('deep run finishes', done.status === 'done', done.error || '');
  check(
    'LLM planner produced the queries',
    done.plan.engine === 'llm' && done.plan.queries.length === 3 && done.plan.questions.length === 2,
    JSON.stringify(done.plan.queries),
  );
  check(
    'search results are deduped across queries',
    done.sources.filter((s) => s.url.includes('alpha.edu')).length === 1 && !done.sources.some((s) => /utm_/.test(s.url)),
    done.sources.map((s) => s.url).join(', '),
  );
  check(
    'unreadable sources are kept with honest errors',
    done.sources.some((s) => s.status === 'error' && /403/.test(s.error || '')),
    done.sources.map((s) => `${s.n}:${s.status}`).join(' '),
  );
  check(
    'follow-up round added fresh sources',
    done.sources.length === 6 && rec.events.some((event) => event.type === 'search' && event.followup && event.query === 'extra one'),
    `${done.sources.length} sources`,
  );
  check(
    'streamed deltas reached the renderer',
    rec.events.filter((event) => event.type === 'delta').length >= 4,
    `${rec.events.filter((event) => event.type === 'delta').length} deltas`,
  );
  check(
    'model report kept and the fake Sources section stripped',
    done.mode === 'llm' &&
      done.report.includes('The evidence points to a clear answer') &&
      !done.report.includes('fabricated source') &&
      (done.report.match(/^## Sources$/gm) || []).length === 1,
  );
  check(
    'citations are verified against real sources',
    done.citations.length >= 3 &&
      done.citations.every((c) => /^https?:/.test(c.url)) &&
      done.sources.filter((s) => s.used).length >= done.citations.length,
    done.citations.map((c) => c.n).join(','),
  );
  check('provider recorded for the report', done.provider && done.provider.model === 'fake-1', JSON.stringify(done.provider));
  check('stats record the work', done.stats.queries === 3 && done.stats.fetched >= 5 && done.stats.failed >= 1, JSON.stringify(done.stats));
  check(
    'gateway was used for plan, follow-up and synthesis',
    fakeGw.calls.length === 3 && fakeGw.calls.some((call) => call.stream === true) && fakeGw.calls.some((call) => call.jsonSchema && call.jsonSchema.properties.queries && !call.jsonSchema.properties.questions),
    `${fakeGw.calls.length} calls`,
  );
  check(
    'done event carries the finished entry',
    rec.events.some((event) => event.type === 'done' && event.entry && event.entry.id === started.runId),
  );

  const rec2 = recorder();
  const gw2 = makeFakeGateway();
  research.init({ dataDir, web: makeFakeWeb(), gateway: gw2, emit: rec2.emit });
  const extractiveStart = await research.start({ query: 'extractive coverage brief', depth: 'standard', maxSources: 5 });
  const extractive = await waitFor(async () => {
    const entry = await research.get(extractiveStart.runId);
    return entry && entry.status !== 'running' ? entry : null;
  }, 'the extractive run');
  check(
    'extractive fallback marks itself honestly',
    extractive.status === 'done' && extractive.mode === 'extractive' && /No AI provider was used/.test(extractive.report),
    extractive.error || '',
  );
  check('extractive fallback cites every source', extractive.citations.length === extractive.sources.filter((s) => s.status === 'ok').length && extractive.citations.length > 0);
  check(
    'extractive fallback never calls the gateway',
    gw2.calls.length === 0 && !extractive.provider,
    `${gw2.calls.length} calls`,
  );

  const rec3 = recorder();
  research.init({ dataDir, web: makeFakeWeb({ failSearch: true }), gateway: makeFakeGateway(), emit: rec3.emit });
  const failedStart = await research.start({ query: 'network failure smoke', depth: 'quick' });
  const failed = await waitFor(async () => {
    const entry = await research.get(failedStart.runId);
    return entry && entry.status !== 'running' ? entry : null;
  }, 'the failed run');
  check(
    'total search failure is reported, not faked',
    failed.status === 'failed' && /No search results/.test(failed.error) && failed.warnings.some((w) => /Search failed/.test(w)),
    failed.error || '',
  );

  const rec4 = recorder();
  const slowWeb = makeFakeWeb({ slowRead: true });
  research.init({ dataDir, web: slowWeb, gateway: makeFakeGateway(), emit: rec4.emit });
  const cancelStart = await research.start({ query: 'slow cancellation test', depth: 'quick', candidates: [candidate] });
  await waitFor(() => rec4.events.some((event) => event.type === 'source' && event.source.status === 'reading'), 'reading to begin');
  const stopped = await research.stop(cancelStart.runId);
  const cancelled = await waitFor(async () => {
    const entry = await research.get(cancelStart.runId);
    return entry && entry.status !== 'running' ? entry : null;
  }, 'the cancelled run');
  check(
    'stop() cancels an in-flight deep run',
    stopped.stopped && cancelled.status === 'cancelled' && /Stopped by you/.test(cancelled.error),
    cancelled.error || '',
  );

  const libBefore = await research.list();
  check(
    'library keeps every run with real statuses',
    ['done', 'failed', 'cancelled'].every((status) => libBefore.some((entry) => entry.status === status)),
    libBefore.map((entry) => entry.status).join(','),
  );
  const infoBefore = await research.info();
  check('info reports counts and no leaked running jobs', infoBefore.reports === libBefore.length && infoBefore.running.length === 0, JSON.stringify(infoBefore));

  research.init({ dataDir, web: makeFakeWeb(), gateway: makeFakeGateway() });
  const libAfterReload = await research.list();
  check(
    'library survives a re-init (persisted to research.json)',
    libAfterReload.some((entry) => entry.id === started.runId) && libAfterReload.length === libBefore.length,
    `${libAfterReload.length} reports`,
  );

  const removed = await research.remove(started.runId);
  const removedAgain = await research.remove(started.runId);
  const libAfterRemove = await research.list();
  check(
    'remove deletes one report and reports the second miss',
    removed.removed && !removedAgain.removed && !libAfterRemove.some((entry) => entry.id === started.runId),
  );

  const rec5 = recorder();
  research.init({ dataDir, web: makeFakeWeb(), gateway: makeFakeGateway(), emit: rec5.emit });
  const saved = await research.saveDocument({
    title: 'Saved note',
    text: 'Hello saved document',
    mode: 'text',
    url: 'https://example.com/note',
    warnings: ['kept warning'],
  });
  check(
    'saveDocument stores a document entry with its source',
    saved.kind === 'document' &&
      saved.sources.length === 1 &&
      saved.report.includes('> Source: https://example.com/note') &&
      saved.report.includes('```text') &&
      saved.warnings.includes('kept warning'),
    saved.id,
  );
  check('saveDocument emits a saved event', rec5.events.some((event) => event.type === 'saved' && event.entry.id === saved.id));
  const fetchedSaved = await research.get(saved.id);
  check('saved document is in the library', !!fetchedSaved && fetchedSaved.kind === 'document');

  const badText = await rejection(() => research.saveDocument({ text: '   ' }));
  const badUrl = await rejection(() => research.saveDocument({ text: 'x', url: 'ftp://example.com/x' }));
  check(
    'saveDocument validates text and source URLs',
    !!badText && /no text/i.test(badText.message) && !!badUrl && /http\(s\)/.test(badUrl.message),
    `${badText && badText.message} | ${badUrl && badUrl.message}`,
  );

  const shortQuery = await rejection(() => research.start({ query: 'ab' }));
  const longQuery = await rejection(() => research.start({ query: 'x'.repeat(1001) }));
  check(
    'start validates the question length',
    !!shortQuery && /at least 3/.test(shortQuery.message) && !!longQuery && /1000/.test(longQuery.message),
  );

  const readFile = await research.readFile(path.join(base, 'files', 'note.txt'));
  check('research.readFile extracts a real file', readFile.ok && readFile.text === 'extractFile smoke', readFile.error || '');
}

async function main() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'orvex-research-'));
  try {
    await testDocuments(base);
    await testWeb(base);
    await testResearch(base);
    console.log(`\nSection 7 backend: ${pass} checks passed.`);
  } finally {
    await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('\nRESEARCH SMOKE FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
