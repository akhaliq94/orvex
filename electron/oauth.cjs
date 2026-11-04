'use strict';

/**
 * Real OAuth for ORVEX: RFC 8628 device flow and PKCE loopback flow.
 * Tokens and client secrets live in the encrypted vault; account metadata lives
 * in the app data folder. Every flow talks to the provider's real endpoints —
 * nothing is simulated, and a missing client id is reported as such.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const vault = require('./vault.cjs');

const FLOW_TTL_MS = 10 * 60 * 1000;
const POLL_SAFETY_MS = 60 * 1000;
const MAX_FLOWS = 6;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

const PROVIDERS = {
  google: {
    label: 'Google',
    deviceUrl: 'https://oauth2.googleapis.com/device/code',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.file'],
    pkce: true,
    device: true,
    hint: 'Create an OAuth client (Desktop app or TV and limited-input device) in Google Cloud Console. Enable the Drive API for Drive access.',
  },
  github: {
    label: 'GitHub',
    deviceUrl: 'https://github.com/login/device/code',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    authUrl: 'https://github.com/login/oauth/authorize',
    userinfoUrl: 'https://api.github.com/user',
    scopes: ['read:user', 'user:email', 'repo'],
    pkce: false,
    device: true,
    hint: 'Create a GitHub OAuth App (or use the device flow) and paste its client id. GitHub needs no client secret for PKCE/device sign-in.',
  },
  microsoft: {
    label: 'Microsoft',
    deviceUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    userinfoUrl: 'https://graph.microsoft.com/oidc/userinfo',
    scopes: ['openid', 'profile', 'email', 'offline_access', 'Files.ReadWrite'],
    pkce: true,
    device: true,
    hint: 'Register an app in Entra ID (Azure) with "Allow public client flows" enabled. Use the application (client) id.',
  },
  custom: {
    label: 'Custom provider',
    deviceUrl: '',
    tokenUrl: '',
    authUrl: '',
    userinfoUrl: '',
    scopes: [],
    pkce: true,
    device: true,
    hint: 'Point ORVEX at any OAuth 2.0 provider: fill in the authorization, token, device and userinfo URLs plus your scopes.',
  },
};

let dataDir = null;
let accountsFile = null;
let emit = () => {};
let openExternal = null;

const accounts = [];
const flows = new Map();

/* ------------------------------------------------------------------ helpers */

function nowIso() {
  return new Date().toISOString();
}

function slug(text) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s;
}

function providerOf(name) {
  const p = PROVIDERS[String(name || 'custom')];
  if (!p) throw new Error(`Unknown OAuth provider "${name}". Use google, github, microsoft or custom.`);
  return p;
}

function trimUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function persistAccounts() {
  const file = accountsFile;
  if (!file) return;
  const plain = accounts.map((a) => ({
    id: a.id,
    provider: a.provider,
    label: a.label,
    email: a.email || '',
    name: a.name || '',
    scopes: a.scopes,
    clientId: a.clientId,
    tokenUrl: a.tokenUrl,
    userinfoUrl: a.userinfoUrl,
    authType: a.authType,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }));
  fsp.mkdir(path.dirname(file), { recursive: true }).then(() => fsp.writeFile(file, JSON.stringify({ accounts: plain }, null, 2), 'utf8')).catch(() => {});
}

function loadAccounts() {
  accounts.length = 0;
  if (!accountsFile) return;
  try {
    const raw = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    for (const a of (raw.accounts || [])) {
      if (!a || !a.id) continue;
      accounts.push({
        id: String(a.id),
        provider: String(a.provider || 'custom'),
        label: String(a.label || a.id),
        email: a.email || '',
        name: a.name || '',
        scopes: Array.isArray(a.scopes) ? a.scopes.map(String) : [],
        clientId: a.clientId || '',
        tokenUrl: a.tokenUrl || '',
        userinfoUrl: a.userinfoUrl || '',
        authType: a.authType || 'pkce',
        createdAt: a.createdAt || nowIso(),
        updatedAt: a.updatedAt || a.createdAt || nowIso(),
      });
    }
  } catch {
    /* first run */
  }
}

function init(opts = {}) {
  dataDir = opts.dataDir || dataDir;
  accountsFile = dataDir ? path.join(dataDir, 'oauth.json') : null;
  if (typeof opts.emit === 'function') emit = opts.emit;
  if (typeof opts.openExternal === 'function') openExternal = opts.openExternal;
  loadAccounts();
  return { accounts: accounts.length, providers: Object.keys(PROVIDERS) };
}

function tokenKey(id) {
  return `oauth:token:${id}`;
}

function clientSecretKey(id) {
  return `oauth:client:${id}`;
}

/* -------------------------------------------------------------- http helper */

async function jsonRequest(url, { method = 'POST', body, headers = {}, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        'user-agent': 'ORVEX/1.0',
        ...(body && typeof body === 'string' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      body,
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`${url} could not be reached: ${err && err.name === 'AbortError' ? 'timed out' : (err && err.message) || String(err)}`);
  }
  clearTimeout(timer);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* GitHub returns form-encoded error bodies for some endpoints */
  }
  if (!json && /(^|&)error=/.test(text)) {
    json = Object.fromEntries(new URLSearchParams(text).entries());
  }
  return { status: res.status, ok: res.ok, text, json, headers: res.headers };
}

function formBody(params) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') search.set(k, String(v));
  }
  return search.toString();
}

async function fetchUserinfo(account, accessToken) {
  if (!account.userinfoUrl) return null;
  try {
    const res = await jsonRequest(account.userinfoUrl, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      timeoutMs: 15000,
    });
    if (!res.ok || !res.json) return null;
    const data = res.json;
    return {
      email: data.email || data.mail || data.userPrincipalName || '',
      name: data.name || data.displayName || data.login || '',
      picture: data.picture || '',
      raw: { id: data.sub || data.id || data.login || '', login: data.login || '', email: data.email || '' },
    };
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- accounts */

function publicAccount(a) {
  return {
    id: a.id,
    provider: a.provider,
    providerLabel: PROVIDERS[a.provider]?.label || a.provider,
    label: a.label,
    email: a.email,
    name: a.name,
    scopes: a.scopes,
    authType: a.authType,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function accountsState() {
  return {
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({
      id,
      label: p.label,
      scopes: p.scopes,
      pkce: p.pkce,
      device: p.device,
      hint: p.hint,
    })),
    accounts: accounts.map((a) => {
      const active = [...flows.values()].some((f) => f.accountId === a.id && f.status === 'pending');
      return { ...publicAccount(a), tokenState: active ? 'renewing' : 'ready' };
    }),
    flows: [...flows.values()].map(publicFlow).filter((f) => f.status === 'pending' || Date.now() - Date.parse(f.startedAt) < 120000),
  };
}

function accountById(id) {
  const hit = accounts.find((a) => a.id === String(id || ''));
  if (!hit) throw new Error(`No OAuth account with id "${id}".`);
  return hit;
}

function uniqueAccountId(provider, identity) {
  const base = `${provider}-${slug(identity) || crypto.randomBytes(3).toString('hex')}`.slice(0, 48);
  let id = base;
  let n = 2;
  while (accounts.some((a) => a.id === id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

async function saveAccount({ provider, label, tokenSet, clientId, clientSecret, authType, tokenUrl, userinfoUrl, scopes }) {
  const p = providerOf(provider);
  const account = {
    id: '',
    provider,
    label: label || p.label,
    email: '',
    name: '',
    scopes: Array.isArray(scopes) && scopes.length ? scopes.map(String) : p.scopes,
    clientId: clientId || '',
    tokenUrl: tokenUrl || p.tokenUrl,
    userinfoUrl: userinfoUrl || p.userinfoUrl,
    authType: authType || 'pkce',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const info = await fetchUserinfo(account, tokenSet.access_token);
  if (info) {
    account.email = info.email || '';
    account.name = info.name || '';
    account.label = label || info.name || info.email || p.label;
  }
  account.id = uniqueAccountId(provider, account.email || account.name || account.label);
  accounts.push(account);
  await vault.setJson(tokenKey(account.id), tokenSet);
  if (clientSecret) await vault.set(clientSecretKey(account.id), clientSecret);
  persistAccounts();
  emit('oauth', { kind: 'account', account: publicAccount(account) });
  return account;
}

async function removeAccount(id) {
  const account = accountById(id);
  const index = accounts.indexOf(account);
  accounts.splice(index, 1);
  await vault.remove(tokenKey(account.id));
  await vault.remove(clientSecretKey(account.id));
  persistAccounts();
  emit('oauth', { kind: 'remove', id: account.id });
  return { ok: true, removed: account.id };
}

/* ------------------------------------------------------------------- tokens */

function tokenState(tokenSet) {
  const expiresAt = Number(tokenSet.expires_at) || 0;
  if (!expiresAt) return { valid: !!tokenSet.access_token, expiresAt: null, expiresIn: null };
  const ms = expiresAt - Date.now();
  return { valid: !!tokenSet.access_token && ms > 30000, expiresAt: new Date(expiresAt).toISOString(), expiresIn: Math.round(ms / 1000) };
}

async function refreshAccount(account, tokenSet) {
  const secret = await vault.get(clientSecretKey(account.id));
  const tokenUrl = account.tokenUrl || providerOf(account.provider).tokenUrl;
  if (!tokenSet.refresh_token) {
    throw new Error(`OAuth account "${account.id}" expired and has no refresh token. Connect it again from the OAuth tab.`);
  }
  if (!tokenUrl) throw new Error(`OAuth account "${account.id}" has no token URL to refresh with.`);
  const res = await jsonRequest(tokenUrl, {
    body: formBody({
      grant_type: 'refresh_token',
      refresh_token: tokenSet.refresh_token,
      client_id: account.clientId,
      client_secret: secret || undefined,
    }),
  });
  if (!res.ok || !res.json || !res.json.access_token) {
    const detail = res.json?.error_description || res.json?.error || res.text.slice(0, 200) || `HTTP ${res.status}`;
    emit('oauth', { kind: 'refresh-error', id: account.id, error: String(detail) });
    throw new Error(`Could not refresh "${account.id}": ${detail}`);
  }
  const merged = {
    ...tokenSet,
    ...res.json,
    refresh_token: res.json.refresh_token || tokenSet.refresh_token,
    obtained_at: nowIso(),
  };
  const ttl = Number(res.json.expires_in) || 0;
  merged.expires_at = ttl ? Date.now() + ttl * 1000 : 0;
  await vault.setJson(tokenKey(account.id), merged);
  account.updatedAt = nowIso();
  persistAccounts();
  emit('oauth', { kind: 'refresh', id: account.id });
  return merged;
}

/** Returns a valid access token, refreshing first when it is about to expire. */
async function tokenFor(accountId) {
  const account = accountById(accountId);
  const tokenSet = await vault.getJson(tokenKey(account.id));
  if (!tokenSet || !tokenSet.access_token) {
    throw new Error(`OAuth account "${account.id}" has no token. Connect it again from the OAuth tab.`);
  }
  const state = tokenState(tokenSet);
  if (state.valid) return tokenSet.access_token;
  const refreshed = await refreshAccount(account, tokenSet);
  return refreshed.access_token;
}

async function accountTokenState(id) {
  const account = accountById(id);
  const tokenSet = await vault.getJson(tokenKey(account.id));
  if (!tokenSet) return { id: account.id, connected: false };
  const state = tokenState(tokenSet);
  return {
    id: account.id,
    connected: true,
    scope: tokenSet.scope || account.scopes.join(' '),
    hasRefresh: !!tokenSet.refresh_token,
    tokenType: tokenSet.token_type || 'Bearer',
    expiresAt: state.expiresAt,
    expiresIn: state.expiresIn,
    tokenState: state.expiresAt ? (state.valid ? 'valid' : 'expired') : 'valid',
  };
}

/** Fetches a usable token (refreshing when needed) and reports the new lifetime. */
async function checkAccount(id) {
  const account = accountById(id);
  const before = await vault.getJson(tokenKey(account.id));
  if (!before || !before.access_token) {
    throw new Error(`OAuth account "${account.id}" has no token. Connect it again.`);
  }
  const wasValid = tokenState(before).valid;
  await tokenFor(account.id);
  const after = await vault.getJson(tokenKey(account.id));
  const state = tokenState(after || before);
  return {
    id: account.id,
    ok: true,
    refreshed: !wasValid,
    tokenState: state.expiresAt ? (state.valid ? 'valid' : 'expired') : 'valid',
    expiresAt: state.expiresAt,
    expiresIn: state.expiresIn,
  };
}

/* -------------------------------------------------------------- device flow */

function publicFlow(flow) {
  return {
    id: flow.id,
    kind: flow.kind,
    provider: flow.provider,
    status: flow.status,
    startedAt: flow.startedAt,
    userCode: flow.userCode || null,
    verificationUrl: flow.verificationUrl || null,
    authUrl: flow.authUrl || null,
    redirectUri: flow.redirectUri || null,
    expiresIn: flow.expiresAt ? Math.max(0, Math.round((flow.expiresAt - Date.now()) / 1000)) : null,
    error: flow.error || null,
    accountId: flow.accountId || null,
    label: flow.label || '',
    hint: flow.hint || '',
  };
}

function addFlow(flow) {
  const pending = [...flows.values()].filter((f) => f.status === 'pending');
  if (pending.length >= MAX_FLOWS) {
    const oldest = pending.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))[0];
    cancelFlow(oldest.id);
  }
  flows.set(flow.id, flow);
  return flow;
}

function flowById(id) {
  const flow = flows.get(String(id || ''));
  if (!flow) throw new Error(`No OAuth flow with id "${id}".`);
  return flow;
}

function finishFlow(flow, patch) {
  Object.assign(flow, patch, { finishedAt: nowIso() });
  if (flow.status !== 'pending' && flow.timer) {
    clearTimeout(flow.timer);
    clearInterval(flow.pollTimer);
    flow.timer = null;
    flow.pollTimer = null;
  }
  emit('oauth', { kind: 'flow', flow: publicFlow(flow) });
  return flow;
}

async function startDeviceFlow(payload = {}) {
  const provider = String(payload.provider || 'google');
  const p = providerOf(provider);
  if (!p.device) throw new Error(`${p.label} does not support the device flow. Use the PKCE loopback flow.`);
  const deviceUrl = trimUrl(payload.deviceUrl) || p.deviceUrl;
  const tokenUrl = trimUrl(payload.tokenUrl) || p.tokenUrl;
  if (!deviceUrl || !tokenUrl) throw new Error('Device flow needs a device authorization URL and a token URL.');
  const clientId = String(payload.clientId || '').trim();
  if (!clientId) throw new Error('A client id is required. Create an OAuth client with your provider first.');
  const scopes = Array.isArray(payload.scopes) && payload.scopes.length ? payload.scopes.map(String) : p.scopes;

  const res = await jsonRequest(deviceUrl, {
    body: formBody({ client_id: clientId, scope: scopes.join(' ') }),
  });
  if (!res.ok || !res.json) {
    const detail = res.json?.error_description || res.json?.error || res.text.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(`Device authorization failed: ${detail}`);
  }
  const data = res.json;
  const deviceCode = data.device_code;
  if (!deviceCode) throw new Error('The provider did not return a device code.');
  const verificationUrl = data.verification_uri_complete || data.verification_uri || data.verification_url || '';
  const flow = addFlow({
    id: crypto.randomUUID(),
    kind: 'device',
    provider,
    status: 'pending',
    startedAt: nowIso(),
    userCode: data.user_code || '',
    verificationUrl,
    deviceCode,
    clientId,
    clientSecret: String(payload.clientSecret || ''),
    scopes,
    tokenUrl,
    deviceUrl,
    userinfoUrl: trimUrl(payload.userinfoUrl) || p.userinfoUrl,
    label: String(payload.label || ''),
    hint: p.hint,
    expiresAt: Date.now() + Math.min(Number(data.expires_in) || 600, 1800) * 1000,
    interval: Math.max(2, Math.min(60, Number(data.interval) || 5)),
  });
  if (openExternal && verificationUrl && payload.autoOpen !== false) openExternal(verificationUrl).catch(() => {});
  pollDeviceFlow(flow);
  return publicFlow(flow);
}

function pollDeviceFlow(flow) {
  const tick = async () => {
    if (flow.status !== 'pending') return;
    if (Date.now() > flow.expiresAt) {
      finishFlow(flow, { status: 'expired', error: 'The device code expired before it was approved.' });
      return;
    }
    try {
      const res = await jsonRequest(flow.tokenUrl, {
        body: formBody({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: flow.deviceCode,
          client_id: flow.clientId,
          client_secret: flow.clientSecret || undefined,
        }),
        headers: { accept: 'application/json' },
      });
      const data = res.json || {};
      if (res.ok && data.access_token) {
        const tokenSet = {
          access_token: data.access_token,
          refresh_token: data.refresh_token || null,
          token_type: data.token_type || 'Bearer',
          scope: data.scope || flow.scopes.join(' '),
          obtained_at: nowIso(),
          expires_at: Number(data.expires_in) ? Date.now() + Number(data.expires_in) * 1000 : 0,
        };
        const account = await saveAccount({
          provider: flow.provider,
          label: flow.label,
          tokenSet,
          clientId: flow.clientId,
          clientSecret: flow.clientSecret,
          authType: 'device',
          tokenUrl: flow.tokenUrl,
          userinfoUrl: flow.userinfoUrl,
          scopes: flow.scopes,
        });
        finishFlow(flow, { status: 'done', accountId: account.id });
        return;
      }
      const error = String(data.error || '');
      if (error === 'authorization_pending') {
        flow.pollTimer = setTimeout(tick, flow.interval * 1000);
        return;
      }
      if (error === 'slow_down') {
        flow.interval = Math.min(60, flow.interval + 5);
        flow.pollTimer = setTimeout(tick, flow.interval * 1000);
        return;
      }
      const detail = data.error_description || (error ? `The provider returned "${error}".` : `HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      finishFlow(flow, { status: error === 'access_denied' ? 'denied' : 'error', error: detail });
    } catch (err) {
      finishFlow(flow, { status: 'error', error: err && err.message ? err.message : String(err) });
    }
  };
  flow.timer = setTimeout(tick, flow.interval * 1000);
  flow.timer.unref?.();
}

/* ---------------------------------------------------------------- PKCE flow */

async function startPkceFlow(payload = {}) {
  const provider = String(payload.provider || 'google');
  const p = providerOf(provider);
  const clientId = String(payload.clientId || '').trim();
  if (!clientId) throw new Error('A client id is required. Create an OAuth client with your provider first.');
  const authUrl = trimUrl(payload.authUrl) || p.authUrl;
  const tokenUrl = trimUrl(payload.tokenUrl) || p.tokenUrl;
  if (!authUrl || !tokenUrl) throw new Error('PKCE flow needs an authorization URL and a token URL.');
  const scopes = Array.isArray(payload.scopes) && payload.scopes.length ? payload.scopes.map(String) : p.scopes;
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = crypto.randomBytes(20).toString('hex');

  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const flow = addFlow({
    id: crypto.randomUUID(),
    kind: 'pkce',
    provider,
    status: 'pending',
    startedAt: nowIso(),
    clientId,
    clientSecret: String(payload.clientSecret || ''),
    scopes,
    tokenUrl,
    userinfoUrl: trimUrl(payload.userinfoUrl) || p.userinfoUrl,
    label: String(payload.label || ''),
    hint: p.hint,
    state,
    verifier,
    redirectUri,
    server,
    expiresAt: Date.now() + FLOW_TTL_MS,
  });

  const search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  if (provider === 'google') {
    search.set('access_type', 'offline');
    search.set('prompt', 'consent');
  }
  flow.authUrl = `${authUrl}?${search.toString()}`;
  if (openExternal && payload.autoOpen !== false) openExternal(flow.authUrl).catch(() => {});

  const finishPage = (res, title, body) => {
    // Provider-supplied error text reaches this page, so it is escaped rather
    // than treated as markup.
    const safeTitle = escapeHtml(title);
    const safeBody = escapeHtml(body);
    const html = `<!doctype html><meta charset="utf-8"><title>${safeTitle}</title><body style="font:15px system-ui;padding:40px;background:#0e1116;color:#e6e9ef"><h1 style="font-size:18px">${safeTitle}</h1><p>${safeBody}</p></body>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  };

  server.on('request', async (req, res) => {
    const url = new URL(req.url || '/', redirectUri);
    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found.');
      return;
    }
    if (flow.status !== 'pending') {
      finishPage(res, 'ORVEX sign-in', 'This sign-in has already been handled.');
      return;
    }
    const incomingState = url.searchParams.get('state') || '';
    if (incomingState !== state) {
      finishFlow(flow, { status: 'error', error: 'OAuth state did not match; the request was ignored.' });
      closeServer(flow);
      finishPage(res, 'ORVEX sign-in failed', 'The security state did not match. Try connecting again.');
      return;
    }
    const error = url.searchParams.get('error');
    if (error) {
      const detail = url.searchParams.get('error_description') || error;
      finishFlow(flow, { status: error === 'access_denied' ? 'denied' : 'error', error: detail });
      closeServer(flow);
      finishPage(res, 'ORVEX sign-in cancelled', String(detail));
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      finishFlow(flow, { status: 'error', error: 'The provider did not return a code.' });
      closeServer(flow);
      finishPage(res, 'ORVEX sign-in failed', 'No authorization code was returned.');
      return;
    }
    try {
      const exchange = await jsonRequest(tokenUrl, {
        body: formBody({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
          client_secret: flow.clientSecret || undefined,
        }),
      });
      const data = exchange.json || {};
      if (!exchange.ok || !data.access_token) {
        const detail = data.error_description || data.error || exchange.text.slice(0, 200) || `HTTP ${exchange.status}`;
        throw new Error(detail);
      }
      const tokenSet = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || null,
        token_type: data.token_type || 'Bearer',
        scope: data.scope || scopes.join(' '),
        obtained_at: nowIso(),
        expires_at: Number(data.expires_in) ? Date.now() + Number(data.expires_in) * 1000 : 0,
      };
      const account = await saveAccount({
        provider,
        label: flow.label,
        tokenSet,
        clientId,
        clientSecret: flow.clientSecret,
        authType: 'pkce',
        tokenUrl,
        userinfoUrl: flow.userinfoUrl,
        scopes,
      });
      finishFlow(flow, { status: 'done', accountId: account.id });
      closeServer(flow);
      finishPage(res, 'ORVEX is connected', 'You can close this tab and return to ORVEX.');
    } catch (err) {
      finishFlow(flow, { status: 'error', error: err && err.message ? err.message : String(err) });
      closeServer(flow);
      finishPage(res, 'ORVEX sign-in failed', String((err && err.message) || err));
    }
  });

  flow.timer = setTimeout(() => {
    if (flow.status !== 'pending') return;
    finishFlow(flow, { status: 'expired', error: 'The sign-in window timed out after 10 minutes.' });
    closeServer(flow);
  }, FLOW_TTL_MS);
  flow.timer.unref?.();

  return publicFlow(flow);
}

function closeServer(flow) {
  if (flow.server) {
    const server = flow.server;
    flow.server = null;
    try {
      server.close();
    } catch {
      /* already closed */
    }
  }
}

function cancelFlow(id) {
  const flow = flowById(id);
  if (flow.status === 'pending') finishFlow(flow, { status: 'cancelled', error: 'Cancelled.' });
  closeServer(flow);
  return publicFlow(flow);
}

function flowState(id) {
  return publicFlow(flowById(id));
}

/* ------------------------------------------------------------------ exports */

module.exports = {
  init,
  PROVIDERS,
  accountsState,
  listAccounts: () => accounts.map(publicAccount),
  accountById,
  accountTokenState,
  checkAccount,
  tokenFor,
  refreshAccount,
  removeAccount,
  startDeviceFlow,
  startPkceFlow,
  flowState,
  cancelFlow,
  tokenState,
  _test: { base64url, formBody, tokenState, slug },
};
