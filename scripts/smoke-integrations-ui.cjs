'use strict';

/**
 * Section 12 Integrations UI smoke over CDP.
 * Requires the ORVEX window running with --remote-debugging-port=9222.
 *
 * Drives the real page against local mock servers: creates a GitHub
 * connection through the editor, tests it, runs an action, deletes it;
 * sends REST requests (200, 418, bad header JSON); runs a WebSocket echo;
 * starts / tests / clears / stops the webhook receiver; signs in with a
 * device flow, checks the token and removes the account; starts and stops
 * the MCP server and flips the risky-tools switch; filters tools and sets
 * a deny policy before resetting it. Asserts the saved secret never shows
 * up in the rendered page.
 */

const http = require('node:http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.ORVEX_CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);
const SECRET_GH = 'gh-ui-secret-token-5566778899';

/* ------------------------------------------------------------------ mocks */

const state = {
  devicePolls: 0,
  refreshCalls: 0,
  ghAuth: [],
};

function collect(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

let base = '';
let httpServer;
let wss;
let wsPort = 0;

async function handleHttp(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const body = await collect(req);
  const p = url.pathname;

  if (p === '/echo') {
    let parsed = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      parsed = null;
    }
    return json(res, 200, {
      method: req.method,
      path: p,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: req.headers,
      body: parsed == null ? body : parsed,
    });
  }
  if (p === '/status/418') {
    res.writeHead(418, { 'content-type': 'text/plain' });
    return res.end('teapot');
  }

  if (p.startsWith('/gh/')) {
    state.ghAuth.push(req.headers.authorization || '');
    if (req.headers.authorization !== `Bearer ${SECRET_GH}`) return json(res, 401, { message: 'Bad credentials' });
    if (p === '/gh/user') {
      return json(res, 200, { login: 'orvex-ui', name: 'ORVEX UI Tester', html_url: 'https://github.com/orvex-ui', public_repos: 4, followers: 2, company: 'ORVEX' });
    }
    if (p === '/gh/rate_limit') return json(res, 200, { resources: { core: { limit: 5000, remaining: 4999 } } });
    if (p === '/gh/user/repos') return json(res, 200, [{ full_name: 'orvex-ui/repo', private: false, description: 'UI smoke', html_url: 'https://github.com/orvex-ui/repo' }]);
    return json(res, 404, { message: 'Not Found' });
  }

  if (p === '/oauth/device' && req.method === 'POST') {
    const form = new URLSearchParams(body);
    if (!form.get('client_id')) return json(res, 400, { error: 'invalid_client' });
    return json(res, 200, {
      device_code: 'device-code-ui',
      user_code: 'ORVX-UI-1',
      verification_uri: `${base}/oauth/verify`,
      expires_in: 600,
      interval: 1,
    });
  }
  if (p === '/oauth/token' && req.method === 'POST') {
    const form = new URLSearchParams(body);
    if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
      state.devicePolls += 1;
      if (state.devicePolls === 1) return json(res, 400, { error: 'authorization_pending' });
      return json(res, 200, { access_token: 'at-device-ui', refresh_token: 'rt-device-ui', token_type: 'Bearer', scope: 'read', expires_in: 2 });
    }
    if (form.get('grant_type') === 'refresh_token') {
      state.refreshCalls += 1;
      return json(res, 200, { access_token: 'at-refreshed-ui', token_type: 'Bearer', scope: 'read', expires_in: 3600 });
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }
  if (p === '/oauth/userinfo') return json(res, 200, { sub: 'u-ui', email: 'ui@example.com', name: 'UI Tester' });

  json(res, 404, { error: 'not found' });
}

function startHttp() {
  return new Promise((resolve, reject) => {
    httpServer = http.createServer((req, res) => {
      handleHttp(req, res).catch((err) => {
        try {
          json(res, 500, { error: err && err.message ? err.message : String(err) });
        } catch {
          /* closed */
        }
      });
    });
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${httpServer.address().port}`;
      resolve();
    });
  });
}

function startWs() {
  return new Promise((resolve, reject) => {
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    wss.once('error', reject);
    wss.on('connection', (socket) => socket.on('message', (data) => socket.send(`echo:${data.toString()}`)));
    wss.once('listening', () => {
      wsPort = wss.address().port;
      resolve();
    });
  });
}

/* ------------------------------------------------------------------- cdp */

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!res.ok) throw new Error(`CDP list failed: HTTP ${res.status}`);
  return res.json();
}

function connect(url) {
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
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, ready };
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
  await startHttp();
  await startWs();
  console.log(`mocks: ${base} · ws 127.0.0.1:${wsPort}`);

  const list = await targets();
  const page = list.find((t) => t.type === 'page' && /\/index\.html|\/$/.test(t.url) && !/recorder\.html/.test(t.url));
  if (!page) throw new Error(`No ORVEX page target. Targets: ${list.map((t) => t.url).join(', ')}`);
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const detail = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed';
      throw new Error(`${detail}\nEXPR: ${expression.slice(0, 600)}`);
    }
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
  const ipc = (ns, method, ...args) =>
    evaluate(`(async () => {
      const api = window.orvex && window.orvex.${ns};
      if (!api || !api.${method}) return { ok: false, error: 'bridge ${ns}.${method} missing' };
      const r = await api.${method}(${args.map((a) => JSON.stringify(a)).join(', ')});
      return r && r.ok === true ? { ok: true, data: r.data } : { ok: false, error: (r && r.error) || 'ipc failed' };
    })()`);
  const ok = async (ns, method, ...args) => {
    const r = await ipc(ns, method, ...args);
    if (!r.ok) throw new Error(`${ns}.${method} failed: ${r.error}`);
    return r.data;
  };
  const clickText = (selector, text, exact = false) =>
    evaluate(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const hit = nodes.find((n) => ${exact ? `n.textContent.trim() === ${JSON.stringify(text)}` : `n.textContent.includes(${JSON.stringify(text)})`});
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
  const clickButton = (text) =>
    evaluate(`(() => {
      const hit = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)});
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
  const setField = (label, value) =>
    evaluate(`(() => {
      const field = [...document.querySelectorAll('.ig-field')].find((f) => f.querySelector('span')?.textContent.trim().startsWith(${JSON.stringify(label)}));
      const el = field && field.querySelector('textarea, input, select');
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      return el.value;
    })()`);
  const clickInCard = (label, buttonText) =>
    evaluate(`(() => {
      const card = [...document.querySelectorAll('.ig-conn')].find((c) => c.querySelector('.ig-conn-head strong')?.textContent.trim() === ${JSON.stringify(label)});
      const btn = card && [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(buttonText)});
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
  const clickInAccount = (label, buttonText) =>
    evaluate(`(() => {
      const card = [...document.querySelectorAll('.ig-account')].find((c) => c.querySelector('strong')?.textContent.trim() === ${JSON.stringify(label)});
      const btn = card && [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(buttonText)});
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
  const cardChip = (label) =>
    evaluate(`(() => {
      const card = [...document.querySelectorAll('.ig-conn')].find((c) => c.querySelector('.ig-conn-head strong')?.textContent.trim() === ${JSON.stringify(label)});
      return card?.querySelector('.dc-chip')?.textContent.trim() || '';
    })()`);
  const goTab = async (label) => {
    await clickText('.ig-tabs .dc-tab', label, true);
    await until(`document.querySelector('.ig-tabs .dc-tab.active')?.textContent.trim() === ${JSON.stringify(label)}`, 5000, `the ${label} tab`);
  };

  const existingHook = await ok('integrations', 'webhook', { op: 'status' });
  const existingMcp = await ok('mcpServer', 'status');
  const label = `UI GitHub ${RUN}`;
  const oauthLabel = `UI Device ${RUN}`;

  try {
    await until(`!!window.orvex?.integrations && !!window.orvex?.oauth && !!window.orvex?.mcpServer && !!window.orvex?.permissions`, 20000, 'the integrations bridges');
    check('integration bridges are exposed to the renderer', true);

    console.log('\n— open the page');
    await until(`[...document.querySelectorAll('.nav-item')].some((n) => n.textContent.trim() === 'Integrations')`, 20000, 'the Integrations nav item');
    await clickText('.nav-item', 'Integrations', true);
    await until(`document.querySelector('.page-title')?.textContent === 'Integrations'`, 10000, 'the Integrations page');
    check('Integrations opens from the sidebar', true);
    const tabs = await until(
      `(() => {
        const labels = [...document.querySelectorAll('.ig-tabs .dc-tab')].map((n) => n.textContent.trim());
        return labels.length === 7 ? labels : null;
      })()`,
      10000,
      'the seven integration tabs',
    );
    check(
      'seven integration tools are listed',
      ['Connections', 'REST', 'WebSocket', 'Webhooks', 'OAuth', 'MCP server', 'Permissions'].every((t) => tabs.includes(t)),
      tabs.join(', '),
    );

    console.log('\n— create, test and run a GitHub connection');
    await goTab('Connections');
    await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'New connection')`, 10000, 'the New connection button');
    await clickButton('New connection');
    await until(`!!document.querySelector('.ig-editor')`, 5000, 'the connection editor');
    const kinds = await evaluate(`[...document.querySelectorAll('.ig-editor .ig-kind')].map((n) => n.textContent.trim())`);
    check('the editor offers every connection kind', ['GitHub', 'Email', 'Calendar (CalDAV)', 'PostgreSQL', 'SQLite', 'S3 storage', 'Google Drive'].every((k) => kinds.includes(k)), kinds.join(', '));
    await clickText('.ig-editor .ig-kind', 'GitHub', true);
    await until(`document.querySelector('.ig-editor .ig-kind.on')?.textContent.trim() === 'GitHub'`, 5000, 'the GitHub kind');
    const ghFields = await evaluate(`[...document.querySelectorAll('.ig-editor .ig-field span')].map((n) => n.textContent.trim())`);
    check('GitHub editor asks for the API base and a token', ghFields.some((f) => f.startsWith('API base')) && ghFields.some((f) => f.startsWith('Personal access token')), ghFields.join(', '));
    await setField('Label', label);
    await setField('API base', `${base}/gh`);
    await setField('Personal access token', SECRET_GH);
    const passwordField = await evaluate(`document.querySelector('.ig-editor input[type=password]')?.type || ''`);
    check('the token field is masked', passwordField === 'password');
    await clickButton('Save');
    await until(`[...document.querySelectorAll('.ig-conn-head strong')].some((n) => n.textContent.trim() === ${JSON.stringify(label)})`, 15000, 'the saved connection card');
    check('a connection saves from the editor', true);

    const pageHtml = await evaluate(`document.body.innerHTML`);
    const bridgeHtml = JSON.stringify(await ok('integrations', 'list'));
    check('the saved token never appears in the page or the connection list', !pageHtml.includes(SECRET_GH) && !bridgeHtml.includes(SECRET_GH));
    await until(`!document.querySelector('.ig-editor')`, 5000, 'the editor to close');

    await clickInCard(label, 'Test');
    await until(`(() => {
      const card = [...document.querySelectorAll('.ig-conn')].find((c) => c.querySelector('.ig-conn-head strong')?.textContent.trim() === ${JSON.stringify(label)});
      return card?.querySelector('.dc-chip')?.textContent.trim() === 'ok';
    })()`, 20000, 'the connection health chip');
    const testedCard = await evaluate(`(() => {
      const card = [...document.querySelectorAll('.ig-conn')].find((c) => c.querySelector('.ig-conn-head strong')?.textContent.trim() === ${JSON.stringify(label)});
      return { chip: card?.querySelector('.dc-chip')?.textContent.trim(), test: card?.querySelector('.ig-conn-test')?.textContent.trim() || '' };
    })()`);
    check('Test reaches the API and marks the card healthy', testedCard.chip === 'ok' && /orvex-ui/.test(testedCard.test), `${testedCard.chip} · ${testedCard.test.slice(0, 90)}`);
    check('every GitHub call carried the bearer token', state.ghAuth.length > 0 && state.ghAuth.every((h) => h === `Bearer ${SECRET_GH}`), `${state.ghAuth.length} calls`);

    await clickInCard(label, 'Actions');
    await until(`!!document.querySelector('.ig-action-panel')`, 5000, 'the action panel');
    const actions = await evaluate(`[...document.querySelectorAll('.ig-action-panel .ig-action-row .ig-kind')].map((n) => n.textContent.trim())`);
    check('the action panel lists every GitHub action', ['Who am I', 'List repositories', 'List issues', 'List pull requests', 'Create issue', 'Comment on issue'].every((a) => actions.includes(a)), actions.join(', '));
    await clickButton('Run action');
    const runOutput = await until(
      `(() => {
        const out = document.querySelector('.ig-action-panel .ig-output pre')?.textContent || '';
        return /orvex-ui/.test(out) ? out : (document.querySelector('.ig-action-panel .ig-output.bad')?.textContent || '');
      })()`,
      20000,
      'the action output',
    );
    check('Run action executes through the connection', /orvex-ui/.test(runOutput) && /Public repos: 4/.test(runOutput), runOutput.split('\n')[0]);
    await evaluate(`document.querySelector('.ig-action-panel [aria-label="Close actions"]')?.click()`);

    console.log('\n— REST tab');
    await goTab('REST');
    await until(`!!document.querySelector('.ig-rest-line input')`, 5000, 'the REST form');
    await setField('Headers', '{"x-ui":"yes"}');
    await setValue('.ig-rest-line input', `${base}/echo?ui=1`);
    await clickButton('Send');
    const rest200 = await until(
      `(() => {
        const status = document.querySelector('.ig-status')?.textContent.trim();
        const pre = document.querySelector('.ig-pre')?.textContent || '';
        return status === '200' && pre ? pre : '';
      })()`,
      20000,
      'the 200 response',
    );
    check('REST tab sends a real GET and renders the JSON', /"x-ui": "yes"/.test(rest200) && /"ui": "1"/.test(rest200), rest200.replace(/\s+/g, ' ').slice(0, 90));
    const restHeaders = await evaluate(`[...document.querySelectorAll('.ig-kv-table b')].map((n) => n.textContent)`);
    check('REST tab shows the real response headers', restHeaders.some((h) => h === 'content-type'), restHeaders.slice(0, 4).join(', '));

    await setValue('.ig-rest-line input', `${base}/status/418`);
    await clickButton('Send');
    const rest418 = await until(
      `(() => {
        const s = document.querySelector('.ig-status');
        return s?.classList.contains('bad') && s.textContent.trim() === '418' ? document.querySelector('.ig-pre')?.textContent || '' : '';
      })()`,
      20000,
      'the 418 response',
    );
    check('REST tab reports a non-2xx status honestly', /teapot/.test(rest418), rest418.slice(0, 40));

    await setField('Headers', '{oops');
    await clickButton('Send');
    const headerError = await until(`document.querySelector('.ig-output.bad')?.textContent || ''`, 10000, 'the header error banner');
    check('REST tab refuses malformed header JSON', /Headers must be a JSON object/.test(headerError), headerError.slice(0, 80));
    await setField('Headers', '');

    console.log('\n— WebSocket tab');
    await goTab('WebSocket');
    await until(`!!document.querySelector('.ig-editor')`, 5000, 'the WebSocket form');
    await setField('URL', `ws://127.0.0.1:${wsPort}`);
    await setField('Message to send', '{"ui":"ws"}');
    await setField('Messages to collect', '1');
    await setField('Timeout', '8000');
    await clickButton('Connect');
    const wsOutput = await until(
      `(() => {
        const pre = [...document.querySelectorAll('.ig-pre')].map((n) => n.textContent).join('\\n');
        return /echo:/.test(pre) ? pre : (document.querySelector('.ig-output.bad')?.textContent || '');
      })()`,
      15000,
      'the WebSocket echo',
    );
    check('WebSocket tab connects and renders the echo', /echo:\{"ui":"ws"\}/.test(wsOutput), wsOutput.slice(0, 60));
    const wsMeta = await evaluate(`[...document.querySelectorAll('.ig-editor .ig-editor-head .dc-muted')].map((n) => n.textContent.trim()).join(' | ')`);
    check('WebSocket tab reports the message count and close state', /closed:/.test(wsMeta), wsMeta.slice(0, 80));

    console.log('\n— Webhooks tab');
    if (existingHook.running) {
      await ok('integrations', 'webhook', { op: 'stop' });
      await sleep(300);
    }
    await goTab('Webhooks');
    await until(`!!document.querySelector('.ig-editor')`, 5000, 'the webhook panel');
    const hookStopped = await evaluate(`document.querySelector('.ig-editor .dc-chip')?.textContent.trim()`);
    check('webhook receiver starts out stopped', hookStopped === 'stopped', hookStopped);
    await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Start')`, 5000, 'the Start button');
    await clickButton('Start');
    const hookUrl = await until(`document.querySelector('.ig-copy-row code')?.textContent.trim() || ''`, 10000, 'the webhook URL');
    check('Start opens a real loopback receiver with a token URL', /^http:\/\/127\.0\.0\.1:\d+\/hook\/[0-9a-f]+$/.test(hookUrl), hookUrl);
    const hookChip = await until(`document.querySelector('.ig-editor .dc-chip')?.textContent.trim() === 'running' ? 'running' : ''`, 5000, 'the running chip');
    check('the receiver shows as running', hookChip === 'running');
    const hookMeta = await evaluate(`[...document.querySelectorAll('.dc-toolbar .dc-muted')].map((n) => n.textContent.trim()).join(' ')`);
    check('the receiver shows port and autostart', /port \d+/.test(hookMeta) && /autostart on/.test(hookMeta), hookMeta.slice(0, 80));

    await clickButton('Send test');
    const hookEvent = await until(
      `(() => {
        const evt = document.querySelector('.ig-event');
        return evt ? { method: evt.querySelector('.ig-method')?.textContent.trim(), path: evt.querySelector('.ig-event-path')?.textContent.trim() } : null;
      })()`,
      10000,
      'the test delivery',
    );
    check('Send test records a real delivery in the event list', hookEvent.method === 'POST' && /^\/hook\//.test(hookEvent.path), `${hookEvent.method} ${hookEvent.path}`);
    const hookDetail = await evaluate(`(() => {
      const evt = document.querySelector('.ig-event');
      evt.querySelector('summary').click();
      return evt.querySelector('.ig-event-body pre')?.textContent || '';
    })()`);
    check('deliveries expose their body', /test|delivery/i.test(hookDetail), hookDetail.replace(/\s+/g, ' ').slice(0, 70));

    await clickButton('Clear');
    await until(`!![...document.querySelectorAll('.ig-empty strong')].find((n) => n.textContent.includes('No deliveries yet'))`, 5000, 'the cleared event list');
    check('Clear empties the delivery history', true);
    await clickButton('Stop');
    const hookOff = await until(`document.querySelector('.ig-editor .dc-chip')?.textContent.trim() === 'stopped' ? 'stopped' : ''`, 10000, 'the receiver to stop');
    check('Stop closes the receiver', hookOff === 'stopped');

    console.log('\n— OAuth tab');
    await goTab('OAuth');
    await until(`[...document.querySelectorAll('.ig-action-row .ig-kind')].length >= 4`, 10000, 'the OAuth providers');
    await clickText('.ig-action-row .ig-kind', 'Custom provider', true);
    await until(`document.querySelector('.ig-action-row .ig-kind.on')?.textContent.trim() === 'Custom provider'`, 5000, 'the custom provider');
    await setField('Flow', 'device');
    await setField('Account label', oauthLabel);
    await setField('Client id', 'cid-ui');
    await setField('Device authorization URL', `${base}/oauth/device`);
    await setField('Token URL', `${base}/oauth/token`);
    await setField('Userinfo URL', `${base}/oauth/userinfo`);
    await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Start sign-in' && !b.disabled)`, 5000, 'the sign-in button');
    await clickButton('Start sign-in');
    const pendingCode = await until(`document.querySelector('.ig-user-code code')?.textContent.trim() || ''`, 10000, 'the device user code');
    check('device flow shows the real user code', pendingCode === 'ORVX-UI-1', pendingCode);
    const verifyLink = await evaluate(`document.querySelector('.ig-flow a')?.getAttribute('href') || ''`);
    check('device flow links to the verification page', verifyLink === `${base}/oauth/verify`, verifyLink);
    await until(`!!document.querySelector('.ig-flow.done')`, 30000, 'the device flow to complete');
    check('device flow polls to a connected account', true, `${state.devicePolls} polls`);
    await until(`[...document.querySelectorAll('.ig-account strong')].some((n) => n.textContent.trim() === ${JSON.stringify(oauthLabel)})`, 10000, 'the connected account');
    const accountMeta = await evaluate(`(() => {
      const card = [...document.querySelectorAll('.ig-account')].find((c) => c.querySelector('strong')?.textContent.trim() === ${JSON.stringify(oauthLabel)});
      return { meta: card?.querySelector('.dc-muted')?.textContent.trim(), id: card?.querySelector('.ig-account-id')?.textContent.trim() };
    })()`);
    check('the connected account lists its provider, email and id', /Custom provider/.test(accountMeta.meta) && /ui@example\.com/.test(accountMeta.meta) && !!accountMeta.id, `${accountMeta.meta} · ${accountMeta.id}`);

    await clickInAccount(oauthLabel, 'Check token');
    const checkMessage = await until(
      `(() => {
        const card = [...document.querySelectorAll('.ig-account')].find((c) => c.querySelector('strong')?.textContent.trim() === ${JSON.stringify(oauthLabel)});
        const text = [...(card?.querySelectorAll('.dc-muted') || [])].map((n) => n.textContent.trim()).join(' ');
        return /Token (is valid|refreshed)/.test(text) ? text : '';
      })()`,
      15000,
      'the token check message',
    );
    check('Check token refreshes or validates the saved token', /Token (is valid|refreshed)/.test(checkMessage), checkMessage.slice(0, 100));
    check('the refresh really reached the token endpoint when needed', state.refreshCalls >= 1 || /valid for ~0 min/.test(checkMessage), `${state.refreshCalls} refresh call(s)`);
    const oauthHtml = await evaluate(`document.body.innerHTML`);
    check('OAuth tokens never appear in the page', !oauthHtml.includes('at-device-ui') && !oauthHtml.includes('at-refreshed-ui') && !oauthHtml.includes('rt-device-ui'));

    await evaluate(`window.__orvexConfirm = []; window.confirm = (m) => { window.__orvexConfirm.push(m); return true; }`);
    await clickInAccount(oauthLabel, 'Remove');
    const removedMsg = await evaluate(`(window.__orvexConfirm || []).join(' ')`);
    await until(`![...document.querySelectorAll('.ig-account strong')].some((n) => n.textContent.trim() === ${JSON.stringify(oauthLabel)})`, 10000, 'the account to be removed');
    check('Remove deletes the account after confirmation', /Remove the OAuth account/.test(removedMsg));

    console.log('\n— MCP server tab');
    await goTab('MCP server');
    await until(`!!document.querySelector('.ig-editor')`, 5000, 'the MCP panel');
    if ((await ok('mcpServer', 'status')).running) {
      await ok('mcpServer', 'stop');
      await sleep(300);
      await clickText('button', 'Refresh', true).catch(() => {});
      await sleep(500);
    }
    const mcpStartButton = await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Start server')`, 10000, 'the Start server button');
    check('the MCP panel offers a real start button', !!mcpStartButton);
    await clickButton('Start server');
    const mcpToken = await until(`document.querySelector('.ig-token')?.textContent.trim() || ''`, 10000, 'the MCP bearer token');
    const mcpEndpoint = await evaluate(`document.querySelector('.ig-copy-row code')?.textContent.trim() || ''`);
    check('MCP server starts on loopback and shows its endpoint and token', /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(mcpEndpoint) && mcpToken.length >= 16, mcpEndpoint);
    const mcpChip = await evaluate(`[...document.querySelectorAll('.dc-chip')].some((n) => n.textContent.trim() === 'running')`);
    check('MCP panel shows the running state', mcpChip);
    const stats = await evaluate(`[...document.querySelectorAll('.ig-stat-grid > div')].map((n) => n.innerText)`);
    check('MCP panel shows requests, tool calls, sessions and protocol', stats.length === 4 && stats.some((s) => /JSON-RPC requests/.test(s)) && stats.some((s) => /2025-03-26/.test(s)), stats.join(' | ').slice(0, 120));

    const riskyCheckbox = `.ig-check input[type=checkbox]`;
    const riskyOn = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(riskyCheckbox)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    await until(`(async () => { const r = await window.orvex.mcpServer.status(); return r.ok && r.data.allowRisky === true; })()`, 10000, 'allowRisky to turn on');
    check('the risky-tools switch really turns risky tools on', riskyOn);
    await evaluate(`document.querySelector(${JSON.stringify(riskyCheckbox)})?.click()`);
    await until(`(async () => { const r = await window.orvex.mcpServer.status(); return r.ok && r.data.allowRisky === false; })()`, 10000, 'allowRisky to turn off');
    check('the risky-tools switch turns back off', true);

    await clickButton('Stop server');
    await until(`(async () => { const r = await window.orvex.mcpServer.status(); return r.ok && r.data.running === false; })()`, 10000, 'MCP to stop');
    check('Stop server closes the loopback port', true);

    console.log('\n— Permissions tab');
    await goTab('Permissions');
    await until(`!!document.querySelector('.ig-perm')`, 10000, 'the tool list');
    const total = await evaluate(`document.querySelectorAll('.ig-perm').length`);
    check('every registered tool is listed with a policy selector', total > 50, `${total} tools`);
    const counts = await evaluate(`document.querySelector('.ig-editor-head .dc-muted')?.textContent.trim() || ''`);
    check('the header counts allow, ask, deny and total', /allow/.test(counts) && /ask/.test(counts) && /deny/.test(counts) && /tools/.test(counts), counts);

    await setValue('.ig-search input', 'system_status');
    await until(
      `(() => {
        const rows = [...document.querySelectorAll('.ig-perm')];
        return rows.length === 1 && rows[0].querySelector('code')?.textContent === 'system_status';
      })()`,
      5000,
      'the filtered tool list',
    );
    const filteredName = await evaluate(`document.querySelector('.ig-perm .ig-perm-name')?.innerText.replace(/\\s+/g, ' ') || ''`);
    check('the filter narrows to one tool', /system_status/.test(filteredName), filteredName);

    await setValue('.ig-perm select', 'deny');
    await until(
      `(async () => { const r = await window.orvex.permissions.state(); return r.ok && r.data.policies.system_status === 'deny'; })()`,
      10000,
      'the deny policy',
    );
    check('setting Deny stores a real policy', await evaluate(`document.querySelector('.ig-perm select.ig-policy')?.classList.contains('deny')`));
    const deniedRun = await evaluate(`(async () => {
      const r = await window.orvex.tools.run('system_status', {});
      return r.ok ? { ok: r.data.ok, error: r.data.error } : { ok: false, error: r.error };
    })()`);
    check('a denied tool is refused everywhere', deniedRun.ok === false && /denied|permission/i.test(deniedRun.error), deniedRun.error);

    await setValue('.ig-search input', '');
    await setValue('.ig-filter-row select', 'mcp');
    await sleep(500);
    const mcpSources = await evaluate(`[...document.querySelectorAll('.ig-perm .ig-perm-name .dc-muted')].map((n) => n.textContent.trim())`);
    check('the source filter only shows MCP tools', mcpSources.every((s) => s === 'mcp'), `${mcpSources.length} MCP tools`);
    await setValue('.ig-filter-row select', 'builtin');
    await until(
      `(() => {
        const rows = [...document.querySelectorAll('.ig-perm .ig-perm-name .dc-muted')].map((n) => n.textContent.trim());
        return rows.length > 0 && rows.every((s) => s === 'builtin');
      })()`,
      5000,
      'the built-in tools',
    );
    check('the source filter shows the built-in tools', true);
    await setValue('.ig-filter-row select', 'all');

    await evaluate(`window.confirm = () => true`);
    await clickButton('Reset all');
    await until(
      `(async () => { const r = await window.orvex.permissions.state(); return r.ok && !r.data.policies.system_status; })()`,
      10000,
      'the reset policy',
    );
    check('Reset all restores the default policy', true);

    console.log('\n— restore the page and the machine state');
    await goTab('Connections');
    await evaluate(`window.confirm = () => true`);
    await evaluate(`(() => {
      const card = [...document.querySelectorAll('.ig-conn')].find((c) => c.querySelector('.ig-conn-head strong')?.textContent.trim() === ${JSON.stringify(label)});
      card?.querySelector('.ig-danger')?.click();
    })()`);
    await until(`![...document.querySelectorAll('.ig-conn-head strong')].some((n) => n.textContent.trim() === ${JSON.stringify(label)})`, 10000, 'the connection to be deleted');
    check('deleting the connection removes its card', true);
  } catch (err) {
    check('the UI suite ran without fatal errors', false, err && err.message ? err.message : String(err));
  } finally {
    try {
      const listNow = await ok('integrations', 'list');
      for (const c of listNow.connections.filter((c) => c.label === label || c.id.startsWith('ui-github'))) {
        await ipc('integrations', 'remove', c.id);
      }
      const oauthNow = await ok('oauth', 'state');
      for (const a of oauthNow.accounts.filter((a) => a.label === oauthLabel)) await ipc('oauth', 'remove', a.id);
      await ipc('permissions', 'reset');
      await ipc('integrations', 'webhook', { op: 'stop' });
      if (existingHook.running && existingHook.autostart) {
        await ipc('integrations', 'webhook', { op: 'start', port: existingHook.port, autostart: true });
      }
      await ipc('mcpServer', 'stop');
      if (existingMcp.running) await ipc('mcpServer', 'start', { port: existingMcp.port });
    } catch {
      /* best effort */
    }
    cdp.ws.close();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
    await new Promise((resolve) => wss.close(resolve));
    console.log(`\nintegrations UI smoke ${process.exitCode ? 'reported failures' : 'OK'}: ${pass} checks`);
  }
}

main().catch((err) => {
  console.error('\nintegrations UI smoke crashed:', err && err.message ? err.message : err);
  process.exit(1);
});
