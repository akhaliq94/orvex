'use strict';

/**
 * Deep research: plan → search → read sources → synthesise a cited report.
 * Reports persist in a small JSON library under userData. The pipeline takes
 * injected web/gateway implementations so tests never touch the network.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const documents = require('./documents.cjs');

const DEPTHS = {
  quick: { queries: 2, sources: 4, perQuery: 5, followup: false },
  standard: { queries: 3, sources: 8, perQuery: 6, followup: false },
  deep: { queries: 5, sources: 14, perQuery: 8, followup: true },
};

const MAX_SOURCES = 24;
const SOURCE_TEXT_CHARS = 14000;
const SAVED_SOURCE_CHARS = 2500;
const PROMPT_SOURCE_CHARS = 3500;
const PROMPT_TOTAL_CHARS = 36000;
const REPORT_CHARS = 40000;
const MAX_REPORTS = 100;

const PLANNER_SCHEMA = {
  type: 'object',
  properties: {
    questions: { type: 'array', items: { type: 'string' } },
    queries: { type: 'array', items: { type: 'string' } },
  },
  required: ['questions', 'queries'],
  additionalProperties: false,
};

const FOLLOWUP_SCHEMA = {
  type: 'object',
  properties: { queries: { type: 'array', items: { type: 'string' } } },
  required: ['queries'],
  additionalProperties: false,
};

let ctx = {};
let state = { reports: [] };
let loaded = false;
const running = new Map();

function init(opts = {}) {
  ctx = { ...ctx, ...opts };
  state = { reports: [] };
  loaded = false;
}

function libraryFile() {
  return path.join(String(ctx.dataDir || '.'), 'research.json');
}

function getWeb() {
  return 'web' in ctx ? ctx.web : require('./web.cjs');
}

function getGateway() {
  return 'gateway' in ctx ? ctx.gateway : require('./model-gateway.cjs');
}

function emit(event) {
  try {
    ctx.emit?.(event);
  } catch {
    /* renderer may be gone */
  }
}

function abortError() {
  return Object.assign(new Error('Cancelled'), { name: 'AbortError' });
}

function isAbort(err) {
  return !!err && err.name === 'AbortError';
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

async function loadLibrary() {
  if (loaded) return state;
  // A re-init must not read a stale file while an earlier snapshot is still flushing.
  await saveChain.catch(() => {});
  try {
    const raw = await fsp.readFile(libraryFile(), 'utf8');
    const parsed = JSON.parse(raw);
    state = { reports: Array.isArray(parsed.reports) ? parsed.reports.filter((r) => r && r.id) : [] };
  } catch {
    state = { reports: [] };
  }
  // A report saved as "running" belongs to a previous process; nothing is
  // driving it any more, so mark it failed instead of spinning forever.
  let reconciled = false;
  for (const report of state.reports) {
    if (report && report.status === 'running') {
      report.status = 'failed';
      report.phase = 'done';
      report.error = 'ORVEX closed before this research run finished.';
      report.finishedAt = report.finishedAt || Date.now();
      reconciled = true;
    }
  }
  loaded = true;
  if (reconciled) await saveNow().catch(() => {});
  return state;
}

let saveChain = Promise.resolve();

async function saveNow() {
  const snapshot = JSON.stringify({ version: 1, savedAt: Date.now(), reports: state.reports });
  saveChain = saveChain
    .catch(() => {})
    .then(async () => {
      const file = libraryFile();
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, file);
    });
  try {
    await saveChain;
  } catch {
    /* a failed save must not crash an in-flight run */
  }
}

function summary(entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    query: entry.query,
    title: entry.title || entry.query,
    depth: entry.depth || null,
    status: entry.status,
    phase: entry.phase || null,
    error: entry.error || null,
    createdAt: entry.createdAt,
    finishedAt: entry.finishedAt || null,
    provider: entry.provider || null,
    mode: entry.mode || null,
    sources: Array.isArray(entry.sources) ? entry.sources.length : 0,
    readable: Array.isArray(entry.sources) ? entry.sources.filter((s) => s.status === 'ok').length : 0,
    citations: Array.isArray(entry.citations) ? entry.citations.length : 0,
    chars: entry.report ? entry.report.length : 0,
  };
}

async function list() {
  const lib = await loadLibrary();
  return lib.reports
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map(summary);
}

async function get(id) {
  const lib = await loadLibrary();
  return lib.reports.find((r) => r.id === id) || null;
}

async function remove(id) {
  const lib = await loadLibrary();
  const before = lib.reports.length;
  lib.reports = lib.reports.filter((r) => r.id !== id);
  if (lib.reports.length === before) return { removed: false };
  await saveNow();
  return { removed: true };
}

async function trimLibrary() {
  const lib = await loadLibrary();
  if (lib.reports.length <= MAX_REPORTS) return;
  const sorted = lib.reports.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const keep = new Set(sorted.slice(0, MAX_REPORTS).map((r) => r.id));
  lib.reports = lib.reports.filter((r) => keep.has(r.id));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_|ref$|source$)/i;

/** Drop fragments and tracking parameters while keeping the rest of the URL intact. */
function cleanUrl(raw) {
  try {
    const u = new URL(String(raw));
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return String(raw || '').trim();
  }
}

function canonicalUrl(raw) {
  const out = cleanUrl(raw);
  const trimmed = out.endsWith('/') ? out.slice(0, -1) : out;
  return trimmed.toLowerCase();
}

function providerRef(candidate) {
  if (!candidate) return null;
  return {
    id: candidate.id || null,
    name: candidate.name || 'provider',
    model: candidate.model || '',
  };
}

function clamp(value, fallback, min, max) {
  const n = Math.round(Number(value));
  const base = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.min(Math.max(base, min), max);
}

function uniqueStrings(items, limit) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const text = String(item || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text.slice(0, 200));
    if (out.length >= limit) break;
  }
  return out;
}

function heuristicPlan(query, count) {
  const base = String(query).replace(/\s+/g, ' ').trim();
  const variants = [
    base,
    `${base} overview`,
    `${base} explained`,
    `${base} latest research`,
    `${base} statistics`,
    `${base} documentation`,
  ];
  return {
    engine: 'heuristic',
    questions: [
      `What is ${base}?`,
      `What do the strongest sources say about ${base}?`,
      `What recent evidence or numbers matter for ${base}?`,
    ],
    queries: uniqueStrings(variants, count),
  };
}

async function makePlan({ query, depth, cfg, candidates, gateway, signal }) {
  if (gateway && candidates.length) {
    try {
      const result = await gateway.chat({
        candidates,
        task: 'research',
        system:
          'You plan web research. Break the question into distinct sub-questions and write short, keyword-rich search queries ' +
          '(no site: operators, no quotes unless essential). Always write the queries in English, even when the question ' +
          'is in Urdu, Hindi or another language — the search backends index English far better. Reply with JSON only.',
        history: [
          {
            role: 'user',
            text:
              `Research question: ${query}\nDepth: ${depth}. ` +
              `Produce 2-5 sub-questions and exactly ${cfg.queries} search queries that will surface primary and recent sources.`,
          },
        ],
        maxTokens: 700,
        temperature: 0.3,
        jsonSchema: PLANNER_SCHEMA,
        stream: false,
        signal,
      });
      const parsed = JSON.parse(result.text);
      const questions = uniqueStrings(parsed.questions, 5);
      const queries = uniqueStrings(parsed.queries, Math.max(cfg.queries, 3));
      if (queries.length) {
        return { engine: 'llm', questions: questions.length ? questions : heuristicPlan(query, cfg.queries).questions, queries: queries.slice(0, 6) };
      }
    } catch (err) {
      if (isAbort(err)) throw err;
      /* fall back to the heuristic plan */
    }
  }
  return heuristicPlan(query, cfg.queries);
}

function rankSources(map) {
  return [...map.values()]
    .map((item) => {
      let bonus = 0;
      const host = hostOf(item.url);
      if (/\.(edu|gov)$/i.test(host)) bonus += 7;
      else if (/\.org$/i.test(host)) bonus += 4;
      if (/wikipedia\.org$/i.test(host)) bonus += 3;
      return { ...item, score: item.hits * 100 + Math.max(0, 30 - item.bestRank * 3) + bonus };
    })
    .sort((a, b) => b.score - a.score);
}

async function mapLimit(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function countWords(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

function firstSentences(text, terms, limit = 3) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const sentences = clean.split(/(?<=[.!?])\s+/).filter((s) => s.length > 20);
  if (!sentences.length) return clean.slice(0, 400);
  const scored = sentences.map((sentence) => {
    const lower = sentence.toLowerCase();
    const hits = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
    return { sentence, score: hits * 10 + Math.min(sentence.length / 300, 1) };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.sentence.trim())
    .join(' ')
    .slice(0, 700);
}

function extractiveReport(query, sources) {
  const terms = String(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);
  const findings = sources.map((source) => {
    const summaryText = firstSentences(source.text || source.snippet, terms) || 'No readable excerpt.';
    const title = String(source.title || source.host || 'Source').replace(/[[\]]/g, '');
    return `- **${title}** — ${summaryText} [${source.n}]`;
  });
  return [
    `## Research brief: ${query}`,
    '',
    `_No AI provider was used, so this brief is assembled extractively from ${sources.length} readable source${sources.length === 1 ? '' : 's'}. Add a provider in Settings → Providers for a synthesised report._`,
    '',
    '### Key findings',
    '',
    findings.join('\n'),
    '',
    '### Open questions',
    '',
    '- Which claims here can be verified in a primary source?',
    '- Where do these sources disagree, and why?',
    '- What is missing from this coverage?',
  ].join('\n');
}

function renderSourcesForPrompt(sources) {
  const blocks = [];
  let used = 0;
  for (const source of sources) {
    const header = `[${source.n}] ${source.title || source.host}\nURL: ${source.url}\n`;
    const room = Math.max(400, Math.min(PROMPT_SOURCE_CHARS, PROMPT_TOTAL_CHARS - used));
    const body = String(source.text || source.snippet || '').slice(0, room);
    used += body.length;
    blocks.push(`${header}\n${body}`);
    if (used >= PROMPT_TOTAL_CHARS) break;
  }
  return blocks.join('\n\n---\n\n');
}

async function synthesize({ query, sources, candidates, gateway, signal }) {
  let streamed = '';
  const result = await gateway.chat({
    candidates,
    task: 'research',
    system:
      'You are a meticulous research analyst writing for a busy professional. Use GitHub-flavoured Markdown. ' +
      'Structure: a one-paragraph "Quick answer", then "## Key findings" bullets, then "## Evidence" with a short ' +
      'paragraph per theme, then "## Open questions". Every factual claim must carry its source number in square ' +
      'brackets, e.g. [2] or [1][4]. Use only the numbered sources provided. If they disagree, say so explicitly. ' +
      'Never invent facts, numbers or URLs. Do not write a Sources section — the app appends verified links.',
    history: [
      {
        role: 'user',
        text: `Question: ${query}\n\nNumbered sources:\n\n${renderSourcesForPrompt(sources)}`,
      },
    ],
    maxTokens: 2600,
    temperature: 0.3,
    stream: true,
    signal,
    onDelta: (delta) => {
      streamed += delta;
      emit({ type: 'delta', text: delta });
    },
  });
  const text = String((result && result.text) || streamed || '').trim();
  if (!text) throw new Error('The model returned an empty report.');
  return text;
}

function stripSourcesSection(markdown) {
  const lines = String(markdown).split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^#{1,3}\s*(sources|references|bibliography|citations)\s*$/i.test(lines[i].trim())) {
      cut = i;
      break;
    }
  }
  return lines.slice(0, cut).join('\n').trim();
}

function citationNumbers(markdown) {
  const numbers = [];
  const seen = new Set();
  const re = /\[(\d{1,2}(?:\s*[,–-]\s*\d{1,2})*)\]/g;
  let match;
  while ((match = re.exec(markdown))) {
    const parts = match[1].split(/\s*[,–-]\s*/);
    for (const part of parts) {
      const n = parseInt(part, 10);
      if (Number.isFinite(n) && !seen.has(n)) {
        seen.add(n);
        numbers.push(n);
      }
    }
  }
  return numbers;
}

function applyCitations(markdown, sources) {
  const valid = new Set(sources.map((s) => s.n));
  const citations = [];
  for (const n of citationNumbers(markdown)) {
    if (!valid.has(n)) continue;
    const source = sources.find((s) => s.n === n);
    source.used = true;
    citations.push({ n, title: source.title || source.host, url: source.url, host: source.host });
  }
  citations.sort((a, b) => a.n - b.n);
  return citations;
}

function sourcesSection(sources) {
  const lines = ['## Sources', ''];
  for (const source of sources) {
    const label = String(source.title || source.host || source.url).replace(/[[\]]/g, '');
    lines.push(`${source.n}. [${label}](${source.url})${source.host ? ` — ${source.host}` : ''}`);
  }
  return lines.join('\n');
}

function metaSource(source) {
  return {
    id: source.id,
    n: source.n,
    title: source.title,
    url: source.url,
    host: source.host,
    snippet: source.snippet || '',
    status: source.status,
    kind: source.kind || '',
    chars: source.chars || 0,
    tables: source.tables || 0,
    error: source.error || null,
    used: !!source.used,
  };
}

function emitSource(entry, source) {
  emit({ runId: entry.id, type: 'source', source: metaSource(source) });
}

async function addSearchResults({ entry, queryText, results, map, onNew }) {
  let added = 0;
  results.forEach((result, index) => {
    if (!result || !/^https?:/i.test(result.url || '')) return;
    const url = cleanUrl(result.url);
    const key = canonicalUrl(url);
    const existing = map.get(key);
    if (existing) {
      existing.hits += 1;
      existing.bestRank = Math.min(existing.bestRank, index);
      return;
    }
    map.set(key, {
      title: String(result.title || '').trim() || hostOf(url),
      url,
      host: result.host || hostOf(url),
      snippet: String(result.snippet || '').trim(),
      hits: 1,
      bestRank: index,
    });
    added += 1;
    onNew?.();
  });
  return added;
}

async function rankNewSources({ entry, map, maxSources, signal }) {
  const ranked = rankSources(map).slice(0, maxSources);
  const fresh = [];
  for (const item of ranked) {
    if (signal && signal.aborted) throw abortError();
    const n = entry.sources.length + fresh.length + 1;
    fresh.push({
      id: `s${n}`,
      n,
      title: item.title,
      url: item.url,
      host: item.host,
      snippet: item.snippet,
      status: 'pending',
      kind: '',
      chars: 0,
      tables: 0,
      error: null,
      used: false,
      text: '',
    });
  }
  return fresh;
}

async function fetchSources({ entry, sources, web, signal }) {
  await mapLimit(sources, 3, async (source) => {
    if (signal && signal.aborted) return;
    source.status = 'reading';
    emitSource(entry, source);
    let result;
    try {
      result = await web.readUrl(source.url, { maxChars: SOURCE_TEXT_CHARS, signal });
    } catch (err) {
      result = { ok: false, error: (err && err.message) || String(err) };
    }
    if (signal && signal.aborted) return;
    if (result && result.ok && String(result.text || '').trim().length >= 120) {
      source.status = 'ok';
      source.title = (result.title || source.title || source.host).slice(0, 300);
      source.kind = result.kind || '';
      source.chars = result.chars || String(result.text).length;
      source.tables = (result.tables || []).length;
      source.text = String(result.text || '').slice(0, SOURCE_TEXT_CHARS);
      entry.stats.fetched += 1;
    } else {
      source.status = 'error';
      source.error = (result && result.error) || 'The source returned too little text to use.';
      entry.stats.failed += 1;
    }
    emitSource(entry, source);
  });
}

async function followUpQueries({ query, sources, candidates, gateway, signal }) {
  const snippets = sources
    .filter((s) => s.status === 'ok')
    .slice(0, 10)
    .map((s) => `[${s.n}] ${s.title} — ${String(s.text || '').slice(0, 260).replace(/\s+/g, ' ')}`)
    .join('\n');
  const result = await gateway.chat({
    candidates,
    task: 'research',
    system:
      'You find gaps in research coverage. Given the question and the sources already read, reply with JSON only: ' +
      '2-3 new search queries that would fill the most important gaps. Write them in English whatever the question\'s ' +
      'language. No site: operators.',
    history: [{ role: 'user', text: `Question: ${query}\n\nSources already read:\n${snippets}` }],
    maxTokens: 300,
    temperature: 0.3,
    jsonSchema: FOLLOWUP_SCHEMA,
    stream: false,
    signal,
  });
  const parsed = JSON.parse(result.text);
  return uniqueStrings(parsed.queries, 3);
}

async function execute(entry, payload, controller) {
  const started = Date.now();
  const signal = controller.signal;
  const cfg = DEPTHS[entry.depth] || DEPTHS.standard;
  const maxSources = clamp(payload.maxSources, cfg.sources, 3, MAX_SOURCES);
  const candidates = Array.isArray(payload.candidates) ? payload.candidates.filter((c) => c && c.baseUrl && c.model) : [];
  const gateway = candidates.length ? getGateway() : null;
  const web = getWeb();

  emit({ runId: entry.id, type: 'entry', entry: summary(entry) });

  try {
    entry.phase = 'plan';
    const plan = await makePlan({ query: entry.query, depth: entry.depth, cfg, candidates, gateway, signal });
    entry.plan = plan;
    emit({ runId: entry.id, type: 'plan', plan });
    await saveNow();

    entry.phase = 'search';
    const map = new Map();
    for (const queryText of plan.queries) {
      if (signal.aborted) throw abortError();
      emit({ runId: entry.id, type: 'search_start', query: queryText });
      let found;
      try {
        found = await web.search(queryText, cfg.perQuery, { signal });
      } catch (err) {
        found = { ok: false, error: (err && err.message) || String(err), results: [] };
      }
      entry.stats.queries += 1;
      if (found.ok) {
        entry.stats.searched += found.results.length;
        await addSearchResults({ entry, queryText, results: found.results, map });
        emit({ runId: entry.id, type: 'search', query: queryText, count: found.results.length, source: found.source || '' });
      } else {
        emit({ runId: entry.id, type: 'search', query: queryText, count: 0, error: found.error || 'Search failed.' });
        if (!entry.warnings.includes(found.error || '')) entry.warnings.push(`Search failed for "${queryText}": ${found.error || 'unknown error'}`);
      }
    }

    if (!map.size) {
      throw new Error(
        `No search results for "${entry.query}". Every search backend refused or returned nothing — check the network and try again.`,
      );
    }

    entry.sources = await rankNewSources({ entry, map, maxSources, signal });
    emit({ runId: entry.id, type: 'sources', sources: entry.sources.map(metaSource) });
    await saveNow();

    entry.phase = 'reading';
    emit({ runId: entry.id, type: 'progress', phase: 'reading', done: 0, total: entry.sources.length });
    await fetchSources({ entry, sources: entry.sources, web, signal });
    await saveNow();
    if (signal.aborted) throw abortError();

    let readable = entry.sources.filter((s) => s.status === 'ok');
    if (!readable.length) {
      throw new Error('None of the sources could be read. They may be paywalled, blocked or offline.');
    }

    if (cfg.followup && gateway && candidates.length && readable.length >= 2) {
      entry.phase = 'followup';
      emit({ runId: entry.id, type: 'progress', phase: 'followup', done: 0, total: 1 });
      try {
        const queries = await followUpQueries({ query: entry.query, sources: readable, candidates, gateway, signal });
        if (queries.length && !signal.aborted) {
          const extraMap = new Map();
          const known = new Set(entry.sources.map((s) => canonicalUrl(s.url)));
          for (const queryText of queries) {
            if (signal.aborted) throw abortError();
            const found = await web.search(queryText, 5, { signal });
            if (!found.ok) continue;
            const fresh = found.results.filter((r) => !known.has(canonicalUrl(r.url)));
            await addSearchResults({ entry, queryText, results: fresh, map: extraMap });
            fresh.forEach((r) => known.add(canonicalUrl(r.url)));
            emit({ runId: entry.id, type: 'search', query: queryText, count: fresh.length, source: found.source || '', followup: true });
          }
          const room = Math.min(4, MAX_SOURCES - entry.sources.length);
          if (room > 0 && extraMap.size) {
            const extra = await rankNewSources({ entry, map: extraMap, maxSources: room, signal });
            entry.sources.push(...extra);
            emit({ runId: entry.id, type: 'sources', sources: entry.sources.map(metaSource) });
            await fetchSources({ entry, sources: extra, web, signal });
            readable = entry.sources.filter((s) => s.status === 'ok');
          }
        }
      } catch (err) {
        if (isAbort(err)) throw err;
        entry.warnings.push(`Follow-up round skipped: ${(err && err.message) || err}`);
      }
    }

    if (!readable.length) {
      throw new Error('None of the sources could be read. They may be paywalled, blocked or offline.');
    }
    if (signal.aborted) throw abortError();

    entry.phase = 'writing';
    emit({ runId: entry.id, type: 'progress', phase: 'writing', done: 0, total: 1 });

    let report = '';
    let mode = 'extractive';
    if (gateway && candidates.length) {
      try {
        report = await synthesize({ query: entry.query, sources: readable, candidates, gateway, signal });
        mode = 'llm';
      } catch (err) {
        if (isAbort(err)) throw err;
        entry.warnings.push(`The model failed (${(err && err.message) || err}); using an extractive brief instead.`);
      }
    }
    if (!report.trim()) {
      report = extractiveReport(entry.query, readable);
      mode = 'extractive';
    }

    const body = stripSourcesSection(report).slice(0, REPORT_CHARS);
    entry.citations = applyCitations(body, entry.sources);
    entry.report = `${body}\n\n${sourcesSection(entry.sources)}`;
    entry.mode = mode;
    entry.provider = mode === 'llm' ? providerRef(candidates[0]) : null;
    entry.status = 'done';
    entry.phase = 'done';
    entry.finishedAt = Date.now();
    entry.stats.ms = entry.finishedAt - started;
    entry.sources = entry.sources.map((s) => ({ ...s, text: String(s.text || '').slice(0, SAVED_SOURCE_CHARS) }));
    await saveNow();

    emit({ runId: entry.id, type: 'done', entry: summary(entry) });
    running.delete(entry.id);
    return summary(entry);
  } catch (err) {
    const cancelled = isAbort(err) || signal.aborted;
    entry.status = cancelled ? 'cancelled' : 'failed';
    entry.phase = 'done';
    entry.error = cancelled ? 'Stopped by you.' : (err && err.message) || String(err);
    entry.finishedAt = Date.now();
    entry.stats.ms = entry.finishedAt - started;
    entry.sources = entry.sources.map((s) => ({ ...s, text: String(s.text || '').slice(0, SAVED_SOURCE_CHARS) }));
    await saveNow();
    running.delete(entry.id);
    emit({ runId: entry.id, type: cancelled ? 'cancelled' : 'error', message: entry.error, entry: summary(entry) });
    return summary(entry);
  }
}

/**
 * Start a deep-research run. Returns immediately with the run id; progress
 * arrives on the research event channel.
 */
async function start(payload = {}) {
  const query = String(payload.query || '').replace(/\s+/g, ' ').trim();
  if (query.length < 3) throw new Error('Write a research question (at least 3 characters).');
  if (query.length > 1000) throw new Error('The question is too long (1000 characters max).');
  if (running.size >= 2) throw new Error('Two research runs are already in progress. Wait for one to finish.');

  const depth = DEPTHS[payload.depth] ? payload.depth : 'standard';
  const entry = {
    id: newId('rs'),
    kind: 'research',
    query,
    title: query,
    depth,
    status: 'running',
    phase: 'plan',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    provider: null,
    mode: null,
    plan: { engine: null, questions: [], queries: [] },
    sources: [],
    citations: [],
    report: '',
    warnings: [],
    stats: { queries: 0, searched: 0, fetched: 0, failed: 0, ms: 0 },
  };

  const lib = await loadLibrary();
  lib.reports.unshift(entry);
  await trimLibrary();
  await saveNow();

  const controller = new AbortController();
  running.set(entry.id, controller);
  void execute(entry, { ...payload, query, depth }, controller);
  return { runId: entry.id, entry: summary(entry) };
}

async function stop(runId) {
  if (runId && running.has(runId)) {
    running.get(runId).abort();
    return { stopped: true };
  }
  if (!runId && running.size) {
    for (const controller of running.values()) controller.abort();
    return { stopped: true };
  }
  return { stopped: false };
}

function activeRuns() {
  return [...running.keys()];
}

async function readUrl(url, opts = {}) {
  return getWeb().readUrl(String(url || ''), opts);
}

async function readFile(filePath) {
  return documents.extractFile(filePath);
}

async function saveDocument(input = {}) {
  const text = String(input.text || '').trim();
  if (!text) throw new Error('There is no text to save.');
  const title = String(input.title || input.name || 'Saved document').slice(0, 300);
  const url = String(input.url || '').trim();
  if (url && !/^https?:/i.test(url)) throw new Error('Only http(s) sources can be attached.');
  const mode = input.mode === 'markdown' ? 'markdown' : 'text';
  const markdown = documents.toMarkdown({ ok: true, title, text, mode });

  const entry = {
    id: newId('rs'),
    kind: 'document',
    query: title,
    title,
    depth: null,
    status: 'done',
    phase: 'done',
    error: null,
    createdAt: Date.now(),
    finishedAt: Date.now(),
    provider: null,
    mode: 'document',
    plan: { engine: 'document', questions: [], queries: [] },
    sources: url
      ? [
          {
            id: 's1',
            n: 1,
            title,
            url,
            host: hostOf(url),
            snippet: '',
            status: 'ok',
            kind: String(input.kind || ''),
            chars: text.length,
            tables: Number(input.tables) || 0,
            error: null,
            used: true,
            text: text.slice(0, SAVED_SOURCE_CHARS),
          },
        ]
      : [],
    citations: [],
    report: `${url ? `> Source: ${url}\n\n` : ''}${markdown}`,
    warnings: Array.isArray(input.warnings) ? input.warnings.map((w) => String(w)).slice(0, 8) : [],
    stats: { queries: 0, searched: 0, fetched: url ? 1 : 0, failed: 0, ms: 0 },
  };

  const lib = await loadLibrary();
  lib.reports.unshift(entry);
  await trimLibrary();
  await saveNow();
  emit({ runId: null, type: 'saved', entry: summary(entry) });
  return entry;
}

async function info() {
  const lib = await loadLibrary();
  return { reports: lib.reports.length, running: activeRuns(), file: libraryFile() };
}

function dispose() {
  for (const controller of running.values()) controller.abort();
  running.clear();
}

module.exports = {
  init,
  list,
  get,
  remove,
  start,
  stop,
  dispose,
  info,
  readUrl,
  readFile,
  saveDocument,
  activeRuns,
  DEPTHS,
  MAX_SOURCES,
};
