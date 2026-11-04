'use strict';

/**
 * Token pricing for the cost manager.
 * Priority: exact cost returned by the provider (OpenRouter) > models.dev
 * catalogue (cached 24h) > small static sheet for offline use. Anything priced
 * from a guess is flagged `estimated` so the dashboard never pretends otherwise.
 */

const db = require('./db.cjs');

const CATALOG_TTL_MS = 24 * 3600 * 1000;
const CATALOG_URL = 'https://models.dev/api.json';
const CATALOG_SETTING = 'pricing.catalog';

/** USD per 1M tokens [input, output] — only used when nothing better exists. */
const STATIC = {
  'gpt-4o': [2.5, 10],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4.1': [2, 8],
  'gpt-4.1-mini': [0.4, 1.6],
  'o3-mini': [1.1, 4.4],
  'o1-mini': [1.1, 4.4],
  'claude-opus-4': [15, 75],
  'claude-sonnet-4': [3, 15],
  'claude-3-5-sonnet': [3, 15],
  'claude-haiku': [0.8, 4],
  'gemini-2.5-pro': [1.25, 10],
  'gemini-2.5-flash': [0.3, 2.5],
  'llama-3.3-70b-versatile': [0.59, 0.79],
  'llama-3.1-8b-instant': [0.05, 0.08],
  'deepseek-chat': [0.27, 1.1],
  'deepseek-reasoner': [0.55, 2.19],
  'mistral-large-latest': [2, 6],
  'mistral-small-latest': [0.2, 0.6],
  'grok-4': [3, 15],
  'grok-3-mini': [0.3, 0.5],
  'qwen3:8b': [0, 0],
  'qwen2.5-coder': [0, 0],
  'llama3.1': [0, 0],
};

let memoryCatalog = null;

function hostOf(baseUrl) {
  try {
    return new URL(String(baseUrl || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isLocalUrl(baseUrl) {
  const host = hostOf(baseUrl);
  if (!host) return false;
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(host)) return true;
  // A single-label hostname can only resolve on the local network.
  if (!host.includes('.') && !host.includes(':')) return true;
  if (host.endsWith('.local')) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const m = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  try {
    const os = require('node:os');
    const name = String(os.hostname() || '').toLowerCase();
    if (name && (host === name || host === name.replace(/\..*$/, ''))) return true;
  } catch {
    /* hostname is optional */
  }
  return false;
}

async function catalog() {
  if (memoryCatalog && Date.now() - memoryCatalog.fetchedAt < CATALOG_TTL_MS) return memoryCatalog.data;
  const cached = db.getSetting(CATALOG_SETTING, null);
  if (cached && cached.data && Date.now() - Number(cached.fetchedAt || 0) < CATALOG_TTL_MS) {
    memoryCatalog = cached;
    return cached.data;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(CATALOG_URL, { signal: controller.signal, headers: { accept: 'application/json' } });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
    const data = await res.json();
    memoryCatalog = { fetchedAt: Date.now(), data };
    db.setSetting(CATALOG_SETTING, memoryCatalog);
    return data;
  } catch {
    memoryCatalog = cached || { fetchedAt: 0, data: null };
    return memoryCatalog.data;
  }
}

function catalogProviderIds(candidate) {
  const ids = [];
  if (candidate.presetId) ids.push(String(candidate.presetId));
  if (candidate.id) ids.push(String(candidate.id));
  const host = hostOf(candidate.baseUrl);
  const map = {
    'openai.com': 'openai',
    'anthropic.com': 'anthropic',
    'googleapis.com': 'google',
    'openrouter.ai': 'openrouter',
    'groq.com': 'groq',
    'mistral.ai': 'mistral',
    'deepseek.com': 'deepseek',
    'x.ai': 'xai',
    'together.xyz': 'togetherai',
    'cerebras.ai': 'cerebras',
  };
  for (const [needle, id] of Object.entries(map)) {
    if (host.endsWith(needle)) ids.push(id);
  }
  return [...new Set(ids.filter(Boolean))];
}

function priceFromCatalog(data, candidate, model) {
  if (!data || typeof data !== 'object') return null;
  const wanted = String(model || '');
  for (const pid of catalogProviderIds(candidate)) {
    const provider = data[pid];
    const entry = provider && provider.models && provider.models[wanted];
    if (entry && entry.cost) {
      const input = Number(entry.cost.input);
      const output = Number(entry.cost.output);
      if (Number.isFinite(input) || Number.isFinite(output)) {
        return { input: Number.isFinite(input) ? input : 0, output: Number.isFinite(output) ? output : 0, source: 'models.dev' };
      }
    }
  }
  return null;
}

function staticPrice(model) {
  const id = String(model || '').trim().toLowerCase();
  if (!id) return null;
  const price = STATIC[id];
  return price ? { input: price[0], output: price[1], source: 'static' } : null;
}

async function priceFor(candidate, model, rawUsage) {
  const exact = rawUsage && Number(rawUsage.cost);
  if (Number.isFinite(exact) && exact >= 0) {
    return { input: 0, output: 0, source: 'provider', exactCost: exact };
  }
  const data = await catalog();
  return priceFromCatalog(data, candidate || {}, model) || staticPrice(model) || null;
}

/** Returns { costUsd, estimated, priced }. `priced` is false when no rate was found. */
async function costOf({ candidate, model, promptTokens, completionTokens, rawUsage }) {
  if (isLocalUrl(candidate && candidate.baseUrl)) {
    return { costUsd: 0, estimated: false, priced: true };
  }
  const price = await priceFor(candidate, model, rawUsage);
  if (!price) return { costUsd: 0, estimated: true, priced: false };
  if (price.exactCost !== undefined) return { costUsd: price.exactCost, estimated: false, priced: true };
  const cost = (Number(promptTokens) || 0) * (price.input / 1_000_000) + (Number(completionTokens) || 0) * (price.output / 1_000_000);
  return { costUsd: cost, estimated: price.source !== 'models.dev', priced: true };
}

function clearCache() {
  memoryCatalog = null;
  db.setSetting(CATALOG_SETTING, null);
}

module.exports = { costOf, priceFor, isLocalUrl, clearCache };
