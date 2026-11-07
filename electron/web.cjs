'use strict';

/**
 * Web research: search through DuckDuckGo's no-JS HTML endpoints, fetch any
 * page as readable text, tables included, and read PDFs / DOCX / CSV / images
 * through the documents extractor. No API keys.
 */

const documents = require('./documents.cjs');
const { checkUrl } = require('./guardrails.cjs');

const MAX_PAGE_BYTES = 20 * 1024 * 1024;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  laquo: '«',
  raquo: '»',
  deg: '°',
  times: '×',
};

function decodeEntities(input) {
  return String(input).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] && body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    const value = NAMED_ENTITIES[body.toLowerCase()];
    return value === undefined ? match : value;
  });
}

function stripHtml(html) {
  const text = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre|table|ul|ol|dd|dt)>/gi, '\n')
    .replace(/<(li|tr|dt)[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0\u200b]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html));
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

async function fetchPage(url, init, timeoutMs, maxBytes = MAX_PAGE_BYTES) {
  const ctrl = new AbortController();
  const { signal: external, ...rest } = init || {};
  const forwardAbort = () => ctrl.abort();
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener('abort', forwardAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: 'follow', ...rest, signal: ctrl.signal });
    if (!res.ok) {
      return { error: `HTTP ${res.status} ${res.statusText || ''}`.trim() };
    }
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) {
      return { error: `Response is ${(declared / 1048576).toFixed(1)} MB — too large to read.` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return { error: `Response is ${(buf.length / 1048576).toFixed(1)} MB — too large to read.` };
    return { res, buf };
  } catch (err) {
    if (err && err.name === 'AbortError') return { error: `Timed out after ${Math.round(timeoutMs / 1000)}s.` };
    const cause = err && err.cause && err.cause.code ? ` (${err.cause.code})` : '';
    return { error: `Network error: ${(err && err.message) || err}${cause}` };
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', forwardAbort);
  }
}

function decodeBody(buf, contentType) {
  const charset = /charset=([\w-]+)/i.exec(contentType || '');
  if (charset) {
    try {
      return new TextDecoder(charset[1].toLowerCase()).decode(buf);
    } catch {
      /* unknown label — fall through to utf-8 */
    }
  }
  return new TextDecoder('utf-8').decode(buf);
}

function unwrapDdg(href) {
  let link = String(href || '').trim();
  if (link.startsWith('//')) link = 'https:' + link;
  try {
    const u = new URL(link);
    if (/(^|\.)duckduckgo\.com$/i.test(u.hostname) && u.pathname.startsWith('/l/')) {
      const target = u.searchParams.get('uddg');
      if (target) return target;
    }
  } catch {
    /* not a URL */
  }
  return link;
}

function parseDdgHtml(html) {
  const out = [];
  const blocks = String(html).split(/<div class="result[^"]*"/i).slice(1);
  for (const block of blocks) {
    if (/result--ad/i.test(block.slice(0, 200))) continue;
    const anchor = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!anchor) continue;
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(block);
    const url = unwrapDdg(decodeEntities(anchor[1]));
    const title = decodeEntities(stripHtml(anchor[2])).replace(/\s+/g, ' ').trim();
    if (!url || !title) continue;
    out.push({ title, url, snippet: snippet ? stripHtml(snippet[1]).replace(/\s+/g, ' ').trim() : '' });
  }
  return out;
}

function parseDdgLite(html) {
  const out = [];
  const links = [...String(html).matchAll(/<a[^>]*class=['"]result-link['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...String(html).matchAll(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi)];
  links.forEach((m, i) => {
    const url = unwrapDdg(decodeEntities(m[1]));
    const title = decodeEntities(stripHtml(m[2])).replace(/\s+/g, ' ').trim();
    if (!url || !title) return;
    const snippet = snippets[i] ? stripHtml(snippets[i][1]).replace(/\s+/g, ' ').trim() : '';
    out.push({ title, url, snippet });
  });
  return out;
}

function parseBingRss(xml) {
  const out = [];
  const items = [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  for (const [, block] of items) {
    const read = (tag) => {
      const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
      return m ? decodeEntities(String(m[1]).replace(/^<!\[CDATA\[|\]\]>$/g, '')) : '';
    };
    const url = read('link').trim();
    const title = stripHtml(read('title')).replace(/\s+/g, ' ').trim();
    if (!url || !title) continue;
    out.push({ title, url, snippet: stripHtml(read('description')).replace(/\s+/g, ' ').trim() });
  }
  return out;
}

async function search(query, max = 6, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'Search query is empty.', results: [] };
  if (q.length > 400) return { ok: false, error: 'Query is too long (400 chars max).', results: [] };
  const limit = Math.min(Math.max(Math.round(Number(max) || 6), 1), 10);

  const requestInit = {
    signal: opts.signal,
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/rss+xml',
      'accept-language': 'en-US,en;q=0.9',
    },
  };

  let results = [];
  let source = '';
  let lastError = '';

  const first = await fetchPage(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, requestInit, 20000);
  if (first.error) {
    lastError = first.error;
  } else {
    const html = decodeBody(first.buf, first.res.headers.get('content-type'));
    if (/anomaly-modal|unusual traffic/i.test(html)) {
      lastError = 'DuckDuckGo asked for a captcha (rate limit).';
    } else {
      results = parseDdgHtml(html);
      source = 'DuckDuckGo';
    }
  }

  if (!results.length) {
    const lite = await fetchPage(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, requestInit, 20000);
    if (!lite.error) {
      results = parseDdgLite(decodeBody(lite.buf, lite.res.headers.get('content-type')));
      source = 'DuckDuckGo Lite';
    } else {
      lastError = lastError || lite.error;
    }
  }

  if (!results.length) {
    const bing = await fetchPage(
      `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss&count=${limit}`,
      requestInit,
      20000,
    );
    if (!bing.error) {
      results = parseBingRss(decodeBody(bing.buf, bing.res.headers.get('content-type')));
      source = 'Bing';
    } else {
      lastError = lastError || bing.error;
    }
  }

  results = results
    .filter((r) => /^https?:/i.test(r.url))
    .map((r) => {
      let host = '';
      try {
        host = new URL(r.url).hostname.replace(/^www\./i, '');
      } catch {
        /* filtered above */
      }
      return { ...r, host };
    })
    .slice(0, limit);

  if (!results.length) {
    return { ok: false, error: lastError || `No search results for "${q}".`, results: [], source };
  }
  return { ok: true, results, source, error: null };
}

function filenameFromUrl(rawUrl) {
  try {
    const pathname = new URL(rawUrl).pathname;
    return decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
  } catch {
    return '';
  }
}

function clampNumber(value, fallback, min, max) {
  const n = Math.round(Number(value));
  return Math.min(Math.max(Number.isFinite(n) && n > 0 ? n : fallback, min), max);
}

/**
 * Fetch any http(s) URL and return structured readable content.
 * Handles HTML (with tables), PDF, DOCX, CSV/TSV, plain text and images (OCR).
 */
async function readUrl(rawUrl, opts = {}) {
  const raw = String(rawUrl || '').trim();
  if (!raw) return { ok: false, error: 'URL is empty.' };
  const blocked = checkUrl(raw);
  if (blocked) return { ok: false, error: blocked };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: 'That is not a valid URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only http(s) pages can be read.' };
  }

  const maxChars = clampNumber(opts.maxChars, 12000, 800, 60000);
  const got = await fetchPage(
    parsed.toString(),
    {
      signal: opts.signal,
      headers: {
        'user-agent': UA,
        accept:
          'text/html,application/xhtml+xml,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain;q=0.9,text/csv;q=0.8,*/*;q=0.5',
        'accept-language': 'en-US,en;q=0.9',
      },
    },
    clampNumber(opts.timeoutMs, 25000, 3000, 60000),
  );
  if (got.error) return { ok: false, error: `Fetch failed — ${got.error}` };

  const finalUrl = got.res.url || parsed.toString();
  const type = String(got.res.headers.get('content-type') || '').toLowerCase();
  const doc = await documents.extract({
    buf: got.buf,
    name: filenameFromUrl(finalUrl),
    contentType: type,
  });
  if (!doc.ok) return { ok: false, error: doc.error };

  const text = doc.text;
  if (!text.trim()) return { ok: false, error: 'The page had no readable text.' };

  const truncated = text.length > maxChars;
  return {
    ok: true,
    url: finalUrl,
    requestedUrl: parsed.toString(),
    kind: doc.kind,
    mode: doc.mode,
    title: doc.title || '',
    text: truncated ? `${text.slice(0, maxChars)}\n…[cut ${text.length - maxChars} chars]` : text,
    tables: doc.tables || [],
    pages: doc.pages || null,
    pageCount: doc.pageCount || null,
    warnings: doc.warnings || [],
    chars: text.length,
    truncated,
    contentType: type,
  };
}

const KIND_LABELS = {
  pdf: 'PDF',
  docx: 'DOCX',
  html: 'HTML',
  xml: 'XML',
  csv: 'CSV',
  tsv: 'TSV',
  markdown: 'Markdown',
  json: 'JSON',
  text: 'Text',
  image: 'Image (OCR)',
};

function describeRead(result) {
  const label = KIND_LABELS[result.kind] || result.kind;
  if (result.pageCount) return `${label}, ${result.pageCount} page${result.pageCount === 1 ? '' : 's'}`;
  if (result.tables && result.tables.length) return `${label}, ${result.tables.length} table${result.tables.length === 1 ? '' : 's'}`;
  return label;
}

async function webSearch(args = {}) {
  const query = String(args.query || '').trim();
  const limit = clampNumber(args.max, 6, 1, 10);
  const found = await search(query, limit);
  if (!found.ok) {
    return {
      ok: false,
      error: `${found.error}${found.error.includes('No search results') ? ' Try browser_open with a search engine and read the page with the browser tools.' : ''}`,
    };
  }

  const lines = [`Search: ${query} (${found.source})`, ''];
  found.results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
  });
  return { ok: true, output: lines.join('\n') };
}

async function webFetch(args = {}) {
  const maxChars = clampNumber(args.maxChars, 8000, 800, 40000);
  const result = await readUrl(args.url, { maxChars });
  if (!result.ok) return { ok: false, error: result.error };

  const header = [`URL: ${result.url}`];
  if (result.title) header.push(`Title: ${result.title}`);
  header.push(`Kind: ${describeRead(result)}`);
  for (const warning of result.warnings || []) header.push(`Warning: ${warning}`);
  return { ok: true, output: `${header.join('\n')}\n\n${result.text}` };
}

const definitions = [
  {
    name: 'web_search',
    description:
      'Search the live web (DuckDuckGo, no API key) and get ranked results with titles, URLs and snippets. Use it for current facts, docs links or "how to" questions, then web_fetch the best result.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query, written in English even when the user speaks another language' },
        max: { type: 'number', description: 'How many results, 1-10 (default 6)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description:
      'Download a URL and return readable text: HTML pages (tables kept as Markdown), PDFs, DOCX, CSV/TSV, plain text and images (OCR). Use after web_search to read the real source instead of guessing from the snippet.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL to read' },
        maxChars: { type: 'number', description: 'Text limit, default 8000, max 40000' },
      },
      required: ['url'],
    },
  },
];

const handlers = { web_search: webSearch, web_fetch: webFetch };

module.exports = { definitions, handlers, search, readUrl, describeRead, fetchPage, decodeBody };
