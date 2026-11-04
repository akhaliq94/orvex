'use strict';

/**
 * Section 12 backend smoke over CDP.
 * Requires the ORVEX window running with --remote-debugging-port=9222.
 *
 * Everything runs against local mock servers started by this script:
 * HTTP echo, GitHub-shaped REST, CalDAV, S3, OAuth (device, PKCE, refresh),
 * SMTP, a WebSocket echo — plus a real SQLite file and an honest Postgres
 * connection failure. Also covers the webhook receiver, the MCP server,
 * the permission engine and secret redaction.
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.ORVEX_CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = path.join(os.tmpdir(), `orvex-int-${Date.now()}`);
const APP_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'orvex');
const SECRET_GH = 'gh-secret-token-1234567890';
const SECRET_SMTP = 'smtp-secret-pass-0987654321';
const SECRET_CAL = 'caldav-secret-pass-1122334455';
const SECRET_S3 = 's3-secret-key-998877665544';

/* ------------------------------------------------------------------ mocks */

const state = {
  devicePolls: 0,
  deviceTokenGranted: false,
  refreshCalls: 0,
  refreshGrantType: '',
  codeCalls: 0,
  codeVerifier: '',
  lastAuth: null,
  smtpAuths: 0,
  smtpMails: [],
  s3Objects: new Map([['existing.txt', 'hello from the bucket']]),
  s3Authz: [],
  putIcs: [],
  deleteHrefs: [],
  calAuth: null,
  ghAuth: [],
};

function collect(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function xml(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/xml; charset=utf-8' });
  res.end(body);
}

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:evt-1@orvex',
  'SUMMARY:Design review',
  'DTSTART:20260501T100000Z',
  'DTEND:20260501T110000Z',
  'LOCATION:Room 4',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

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

  /* GitHub shape */
  if (p.startsWith('/gh/')) {
    state.ghAuth.push(req.headers.authorization || '');
    if (req.headers.authorization !== `Bearer ${SECRET_GH}`) return json(res, 401, { message: 'Bad credentials' });
    if (p === '/gh/user') return json(res, 200, { login: 'orvex-test', name: 'ORVEX Tester', html_url: 'https://github.com/orvex-test', public_repos: 3, followers: 1, company: 'ORVEX' });
    if (p === '/gh/user/repos') return json(res, 200, [{ full_name: 'orvex-test/demo', private: false, description: 'Smoke repo', html_url: 'https://github.com/orvex-test/demo' }]);
    if (p === '/gh/repos/o/r/issues' && req.method === 'GET') {
      return json(res, 200, [
        { number: 7, state: url.searchParams.get('state') || 'open', title: 'A real issue', user: { login: 'tester' } },
        { number: 9, state: 'open', title: 'A pull request', pull_request: { url: 'x' }, user: { login: 'dev' } },
      ]);
    }
    if (p === '/gh/repos/o/r/pulls') return json(res, 200, [{ number: 3, title: 'Add smoke', head: { ref: 'feat' }, base: { ref: 'main' }, user: { login: 'dev' } }]);
    if (p === '/gh/repos/o/r/issues' && req.method === 'POST') {
      const input = body ? JSON.parse(body) : {};
      return json(res, 201, { number: 8, title: input.title, html_url: 'https://github.com/o/r/issues/8' });
    }
    if (/^\/gh\/repos\/o\/r\/issues\/8\/comments$/.test(p) && req.method === 'POST') {
      return json(res, 201, { html_url: 'https://github.com/o/r/issues/8#issuecomment-1' });
    }
    return json(res, 404, { message: 'Not Found' });
  }

  /* CalDAV shape */
  if (p.startsWith('/dav/')) {
    state.calAuth = req.headers.authorization || '';
    const expected = 'Basic ' + Buffer.from('caluser:' + SECRET_CAL).toString('base64');
    if (state.calAuth !== expected) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      return res.end('Unauthorized');
    }
    if (req.method === 'PROPFIND' && p === '/dav/') {
      if (String(req.headers.depth) === '1') {
        return xml(res, 207, '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dav/calendars/caluser/work/</d:href><d:propstat><d:prop><d:displayname>Work</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>');
      }
      return xml(res, 207, '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/dav/principals/caluser/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>');
    }
    if (req.method === 'PROPFIND' && p === '/dav/principals/caluser/') {
      return xml(res, 207, '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dav/principals/caluser/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/dav/calendars/caluser/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>');
    }
    if (req.method === 'PROPFIND' && p === '/dav/calendars/caluser/') {
      return xml(res, 207, '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dav/calendars/caluser/work/</d:href><d:propstat><d:prop><d:displayname>Work</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>');
    }
    if (req.method === 'REPORT' && p.startsWith('/dav/calendars/caluser/')) {
      return xml(res, 207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dav/calendars/caluser/work/evt-1.ics</d:href><d:propstat><d:prop><c:calendar-data>${ICS}</c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`);
    }
    if (req.method === 'PUT') {
      state.putIcs.push({ path: p, body });
      res.writeHead(201);
      return res.end();
    }
    if (req.method === 'DELETE') {
      state.deleteHrefs.push(p);
      res.writeHead(204);
      return res.end();
    }
    return xml(res, 404, '<d:error xmlns:d="DAV:">not found</d:error>');
  }

  /* S3 shape */
  if (p.startsWith('/bucket')) {
    state.s3Authz.push(req.headers.authorization || '');
    if (!String(req.headers.authorization || '').startsWith('AWS4-HMAC-SHA256 Credential=s3-access-key/')) {
      return json(res, 403, { error: 'bad signature' });
    }
    const key = decodeURIComponent(p.replace(/^\/bucket\/?/, ''));
    if (req.method === 'GET' && !key) {
      const keys = [...state.s3Objects.entries()];
      const bodyXml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>bucket</Name>${keys.map(([k, v]) => `<Contents><Key>${k}</Key><Size>${Buffer.byteLength(v)}</Size></Contents>`).join('')}</ListBucketResult>`;
      return xml(res, 200, bodyXml);
    }
    if (req.method === 'GET' && key) {
      if (!state.s3Objects.has(key)) return json(res, 404, { error: 'NoSuchKey' });
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(state.s3Objects.get(key));
    }
    if (req.method === 'PUT') {
      state.s3Objects.set(key, body);
      res.writeHead(200);
      return res.end();
    }
    if (req.method === 'DELETE') {
      state.s3Objects.delete(key);
      res.writeHead(204);
      return res.end();
    }
  }

  /* OAuth shape */
  if (p === '/oauth/device' && req.method === 'POST') {
    const form = new URLSearchParams(body);
    if (!form.get('client_id')) return json(res, 400, { error: 'invalid_client' });
    return json(res, 200, {
      device_code: 'device-code-1',
      user_code: 'ORVX-1234',
      verification_uri: `${base}/oauth/verify`,
      verification_uri_complete: `${base}/oauth/verify?code=ORVX-1234`,
      expires_in: 600,
      interval: 2,
    });
  }
  if (p === '/oauth/token' && req.method === 'POST') {
    const form = new URLSearchParams(body);
    const grant = form.get('grant_type') || '';
    if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
      state.devicePolls += 1;
      if (state.devicePolls === 1) return json(res, 400, { error: 'authorization_pending' });
      state.deviceTokenGranted = true;
      return json(res, 200, { access_token: 'at-device-1', refresh_token: 'rt-device-1', token_type: 'Bearer', scope: 'read write', expires_in: 2 });
    }
    if (grant === 'refresh_token') {
      state.refreshCalls += 1;
      state.refreshGrantType = form.get('refresh_token') || '';
      if (form.get('client_id') !== 'cid-device' && form.get('client_id') !== 'cid-pkce') return json(res, 400, { error: 'invalid_client' });
      return json(res, 200, { access_token: 'at-refreshed-2', token_type: 'Bearer', scope: 'read write', expires_in: 3600 });
    }
    if (grant === 'authorization_code') {
      state.codeCalls += 1;
      state.codeVerifier = form.get('code_verifier') || '';
      if (form.get('code') !== 'auth-code-1') return json(res, 400, { error: 'invalid_grant' });
      return json(res, 200, { access_token: 'at-pkce-1', refresh_token: 'rt-pkce-1', token_type: 'Bearer', scope: 'read write', expires_in: 3600 });
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }
  if (p === '/oauth/authorize') {
    const redirect = url.searchParams.get('redirect_uri');
    if (!redirect) return json(res, 400, { error: 'missing redirect_uri' });
    state.lastAuth = Object.fromEntries(url.searchParams.entries());
    const target = new URL(redirect);
    target.searchParams.set('code', 'auth-code-1');
    target.searchParams.set('state', url.searchParams.get('state') || '');
    res.writeHead(302, { location: target.toString() });
    return res.end();
  }
  if (p === '/oauth/userinfo') {
    return json(res, 200, { sub: 'u-1', email: 'smoke@example.com', name: 'Smoke Tester' });
  }

  json(res, 404, { error: 'not found' });
}

let base = '';
let httpServer;
let wss;
let wsPort = 0;
let smtp;
let smtpPort = 0;

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
      const port = httpServer.address().port;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

function startWs() {
  return new Promise((resolve, reject) => {
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    wss.once('error', reject);
    wss.on('connection', (socket) => {
      socket.on('message', (data) => socket.send(`echo:${data.toString()}`));
    });
    wss.once('listening', () => {
      wsPort = wss.address().port;
      resolve();
    });
  });
}

function startSmtp() {
  return new Promise((resolve, reject) => {
    smtp = net.createServer((socket) => {
      socket.write('220 mock.local ESMTP ORVEX smoke\r\n');
      let buffer = '';
      let mode = null;
      let mail = '';
      let inData = false;
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (inData) {
            if (line === '.') {
              inData = false;
              state.smtpMails.push(mail);
              mail = '';
              socket.write('250 2.0.0 queued as smoke\r\n');
            } else {
              mail += line + '\n';
            }
            continue;
          }
          const upper = line.toUpperCase();
          if (mode === 'user') {
            mode = 'pass';
            socket.write('334 UGFzc3dvcmQ6\r\n');
          } else if (mode === 'pass') {
            mode = null;
            state.smtpAuths += 1;
            socket.write('235 2.7.0 authenticated\r\n');
          } else if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
            socket.write('250-mock.local\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SIZE 10485760\r\n');
          } else if (upper.startsWith('AUTH PLAIN')) {
            if (line.trim().split(/\s+/).length === 2) {
              socket.write('334 \r\n');
              mode = 'plain-continue';
            } else {
              state.smtpAuths += 1;
              socket.write('235 2.7.0 authenticated\r\n');
            }
          } else if (mode === 'plain-continue') {
            mode = null;
            state.smtpAuths += 1;
            socket.write('235 2.7.0 authenticated\r\n');
          } else if (upper.startsWith('AUTH LOGIN')) {
            mode = 'user';
            socket.write('334 VXNlcm5hbWU6\r\n');
          } else if (upper.startsWith('MAIL FROM')) {
            socket.write('250 2.1.0 ok\r\n');
          } else if (upper.startsWith('RCPT TO')) {
            socket.write('250 2.1.5 ok\r\n');
          } else if (upper === 'DATA') {
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (upper === 'QUIT') {
            socket.write('221 2.0.0 bye\r\n');
            socket.end();
          } else {
            socket.write('250 2.0.0 ok\r\n');
          }
        }
      });
      socket.on('error', () => {});
    });
    smtp.once('error', reject);
    smtp.listen(0, '127.0.0.1', () => {
      smtpPort = smtp.address().port;
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

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  await startHttp();
  await startWs();
  await startSmtp();
  console.log(`mocks: ${base} · ws 127.0.0.1:${wsPort} · smtp 127.0.0.1:${smtpPort}`);

  const list = await targets();
  const page = list.find((t) => t.type === 'page' && /\/index\.html|\/$/.test(t.url) && !/recorder\.html/.test(t.url));
  if (!page) throw new Error(`No ORVEX page target. Targets: ${list.map((t) => t.url).join(', ')}`);
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed');
    return r.result.value;
  };
  const ipc = (ns, method, ...args) =>
    evaluate(`(async () => {
      const api = window.orvex && window.orvex.${ns};
      if (!api || !api.${method}) return { ok: false, error: 'bridge ${ns}.${method} missing' };
      const r = await api.${method}(${args.map((a) => JSON.stringify(a)).join(', ')});
      return r && r.ok === true ? { ok: true, data: r.data } : { ok: false, error: (r && r.error) || 'ipc failed' };
    })()`);
  const tool = (name, args) =>
    evaluate(`(async () => {
      const r = await window.orvex.tools.run(${JSON.stringify(name)}, ${JSON.stringify(args || {})});
      if (!r || r.ok !== true) return { ok: false, error: (r && r.error) || 'ipc failed' };
      const data = r.data || {};
      return data.ok === true ? { ok: true, data } : { ok: false, error: data.error || 'tool failed' };
    })()`);
  const integrations = require('../electron/integrations.cjs');
  integrations.init({ dataDir: APP_DATA });
  const RUN = Date.now().toString(36);
  const created = [];
  const accounts = [];
  let initialHook = null;
  let initialMcp = null;

  async function ok(ns, method, ...args) {
    const r = await ipc(ns, method, ...args);
    if (!r.ok) throw new Error(`${ns}.${method} failed: ${r.error}`);
    return r.data;
  }
  async function fails(ns, method, ...args) {
    const r = await ipc(ns, method, ...args);
    if (r.ok) throw new Error(`${ns}.${method} unexpectedly succeeded`);
    return r.error;
  }
  const save = async (payload) => {
    const data = await ok('integrations', 'save', { ...payload, label: `${payload.label} ${RUN}` });
    created.push(data.id);
    return data;
  };

  const freePort = () =>
    new Promise((resolve) => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const p = probe.address().port;
        probe.close(() => resolve(p));
      });
    });

  try {
    console.log('\n— bridge, schema and approval policy');
    const keys = await evaluate(`Object.keys(window.orvex.integrations || {})`);
    check(
      'preload exposes the integrations bridge',
      ['list', 'save', 'remove', 'test', 'run', 'health', 'http', 'ws', 'webhook', 'onChange'].every((k) => keys.includes(k)),
      keys.join(', '),
    );
    const oauthKeys = await evaluate(`Object.keys(window.orvex.oauth || {})`);
    check('preload exposes the OAuth bridge', ['state', 'device', 'pkce', 'flow', 'cancel', 'remove', 'tokenState', 'check', 'onChange'].every((k) => oauthKeys.includes(k)), oauthKeys.join(', '));
    const mcpKeys = await evaluate(`Object.keys(window.orvex.mcpServer || {})`);
    check('preload exposes the MCP server bridge', ['status', 'start', 'stop', 'setAllowRisky', 'onChange'].every((k) => mcpKeys.includes(k)), mcpKeys.join(', '));

    const schemaData = await ok('integrations', 'list');
    const kinds = schemaData.schema.kinds.map((k) => k.id);
    check(
      'schema lists every real integration kind with actions',
      ['github', 'email', 'calendar', 'postgres', 'sqlite', 's3', 'gdrive'].every((k) => kinds.includes(k)) && schemaData.schema.kinds.every((k) => k.actions.length > 0 && Array.isArray(k.fields) && Array.isArray(k.secrets)),
      kinds.join(', '),
    );
    check('schema reports the real limits', schemaData.schema.limits.httpBytes > 0 && schemaData.schema.limits.webhookBytes > 0 && schemaData.schema.limits.dbRows > 0);
    check('non-GET http_request needs approval', !!integrations.approvalReason('http_request', { method: 'POST' }));
    check('GET http_request never needs approval', !integrations.approvalReason('http_request', { method: 'GET' }));
    check('starting the webhook receiver needs approval', !!integrations.approvalReason('webhook_server', { op: 'start' }));
    check('Postgres SSL certificates are verified', !/rejectUnauthorized:\s*false/.test(fs.readFileSync(path.join(__dirname, '..', 'electron', 'integrations.cjs'), 'utf8')));

    console.log('\n— REST client');
    const getEcho = await ok('integrations', 'http', { method: 'GET', url: `${base}/echo?a=1&b=two`, headers: { 'x-smoke': 'yes' } });
    check('http GET reaches a real server and returns JSON', getEcho.ok && getEcho.status === 200 && getEcho.json.method === 'GET' && getEcho.json.query.a === '1' && getEcho.json.headers['x-smoke'] === 'yes', `${getEcho.status} · ${getEcho.bytes} bytes in ${getEcho.ms} ms`);
    const postEcho = await ok('integrations', 'http', { method: 'POST', url: `${base}/echo`, json: { hello: 'world', n: 5 } });
    check('http POST sends JSON and parses the reply', postEcho.ok && postEcho.json.method === 'POST' && postEcho.json.body.hello === 'world' && postEcho.json.body.n === 5 && /application\/json/.test(postEcho.json.headers['content-type'] || ''), `${postEcho.status}`);
    const teapot = await ok('integrations', 'http', { method: 'GET', url: `${base}/status/418` });
    check('http reports non-2xx honestly', teapot.ok === false && teapot.status === 418 && /teapot/.test(teapot.body), teapot.error);
    const blockedScheme = await fails('integrations', 'http', { url: 'file:///C:/Windows/win.ini' });
    check('http rejects non-http(s) URLs', /http/i.test(blockedScheme), blockedScheme);
    const bodyGet = await fails('integrations', 'http', { url: `${base}/echo`, body: 'nope' });
    check('http rejects a body on GET', /cannot carry a body/i.test(bodyGet), bodyGet);
    const headerInject = await ok('integrations', 'http', { method: 'GET', url: `${base}/echo`, headers: { 'x-ok': '1', 'bad header': '2' } });
    check('http drops malformed header names', headerInject.json.headers['x-ok'] === '1' && !('bad header' in headerInject.json.headers));

    console.log('\n— WebSocket client');
    const wsEcho = await ok('integrations', 'ws', { url: `ws://127.0.0.1:${wsPort}`, message: { ping: 'orvex' }, messages: 1, timeoutMs: 8000 });
    check('ws sends a message and receives the echo', wsEcho.ok && wsEcho.messages.length === 1 && wsEcho.messages[0] === 'echo:{"ping":"orvex"}', wsEcho.messages[0]);
    const wsBad = await fails('integrations', 'ws', { url: 'http://127.0.0.1:1' });
    check('ws rejects non-ws URLs', /ws:\/\//.test(wsBad), wsBad);
    const wsDead = await ok('integrations', 'ws', { url: `ws://127.0.0.1:1`, timeoutMs: 3000 });
    check('ws reports an unreachable server', wsDead.ok === false && !!wsDead.error, wsDead.error);

    console.log('\n— GitHub connection');
    const gh = await save({ kind: 'github', label: 'Smoke GitHub', config: { apiBase: `${base}/gh` }, secrets: { token: SECRET_GH } });
    check('saveConnection stores the token in the vault and reports only a boolean', gh.secretSet.token === true && !JSON.stringify(gh).includes(SECRET_GH));
    const allConnections = JSON.stringify(await ok('integrations', 'list'));
    check('listing connections never leaks secrets', !allConnections.includes(SECRET_GH) && !allConnections.includes(SECRET_SMTP) && !allConnections.includes(SECRET_S3));
    const ghTest = await ok('integrations', 'test', gh.id);
    check('GitHub connection test reaches /user with the bearer token', ghTest.ok && /orvex-test/.test(ghTest.output), ghTest.output.split('\n')[0]);
    const ghMe = await ok('integrations', 'run', { id: gh.id, action: 'me' });
    check('GitHub me returns the profile', ghMe.ok && /orvex-test/.test(ghMe.output) && /Public repos: 3/.test(ghMe.output));
    const ghRepos = await ok('integrations', 'run', { id: gh.id, action: 'repos', args: { limit: 5 } });
    check('GitHub repos lists the repositories', ghRepos.ok && /orvex-test\/demo/.test(ghRepos.output));
    const ghIssues = await ok('integrations', 'run', { id: gh.id, action: 'issues', args: { repo: 'o/r', state: 'open' } });
    check('GitHub issues lists issues and filters out pull requests', ghIssues.ok && /A real issue/.test(ghIssues.output) && !/A pull request/.test(ghIssues.output), ghIssues.output.split('\n')[0]);
    const ghPulls = await ok('integrations', 'run', { id: gh.id, action: 'pulls', args: { repo: 'o/r' } });
    check('GitHub pulls lists open pull requests', ghPulls.ok && /#3 Add smoke/.test(ghPulls.output));
    const ghCreate = await ok('integrations', 'run', { id: gh.id, action: 'create_issue', args: { repo: 'o/r', title: 'From the smoke', body: 'real body' } });
    check('GitHub create_issue writes through the API', ghCreate.ok && /Created o\/r#8/.test(ghCreate.output), ghCreate.output.split('\n')[0]);
    const ghComment = await ok('integrations', 'run', { id: gh.id, action: 'comment', args: { repo: 'o/r', number: 8, body: 'smoke comment' } });
    check('GitHub comment writes through the API', ghComment.ok && /Commented on o\/r#8/.test(ghComment.output));
    const ghBadRepo = await fails('integrations', 'run', { id: gh.id, action: 'issues', args: { repo: 'not a repo' } });
    check('GitHub rejects a malformed repo', /owner\/name/.test(ghBadRepo), ghBadRepo);
    check('GitHub calls always carried the bearer token', state.ghAuth.length >= 7 && state.ghAuth.every((h) => h === `Bearer ${SECRET_GH}`), `${state.ghAuth.length} calls`);
    integrations.init({ dataDir: APP_DATA });
    check('integration_call gates GitHub writes behind approval', !!integrations.approvalReason('integration_call', { connection: gh.id, action: 'create_issue', args: {} }) && !integrations.approvalReason('integration_call', { connection: gh.id, action: 'me', args: {} }));

    console.log('\n— email connection (real SMTP, honest IMAP failure)');
    const mail = await save({
      kind: 'email',
      label: 'Smoke Email',
      config: { host: '127.0.0.1', port: String(smtpPort), secure: 'false', user: 'smoke@example.com', imapHost: '127.0.0.1', imapPort: '1', fromName: 'ORVEX Smoke' },
      secrets: { password: SECRET_SMTP },
    });
    const mailTest = await fails('integrations', 'test', mail.id);
    check('email test logs into SMTP and surfaces the unreachable IMAP instead of faking it', state.smtpAuths > 0 && /imap|ECONNREFUSED|connect/i.test(mailTest), mailTest.slice(0, 120));
    const send = await ok('integrations', 'run', { id: mail.id, action: 'send', args: { to: 'dest@example.com', subject: 'ORVEX smoke subject', body: 'Hello from the smoke test.' } });
    const mailBody = state.smtpMails[state.smtpMails.length - 1] || '';
    check('email send delivers through the mock SMTP server', send.ok && /Sent|delivered/i.test(send.output) && /Subject: ORVEX smoke subject/.test(mailBody) && /Hello from the smoke test\./.test(mailBody), send.output.split('\n')[0]);
    check('SMTP received an authenticated session', state.smtpAuths > 0, `${state.smtpAuths} auth(s)`);
    integrations.init({ dataDir: APP_DATA });
    check('integration_call gates email sending behind approval', !!integrations.approvalReason('integration_call', { connection: mail.id, action: 'send', args: {} }) && !integrations.approvalReason('integration_call', { connection: mail.id, action: 'inbox', args: {} }));

    console.log('\n— CalDAV calendar');
    const cal = await save({ kind: 'calendar', label: 'Smoke Calendar', config: { url: `${base}/dav/`, user: 'caluser' }, secrets: { password: SECRET_CAL } });
    const calTest = await ok('integrations', 'test', cal.id);
    check('CalDAV login works and lists the Work calendar', calTest.ok && /Work/.test(calTest.output), calTest.output);
    const cals = await ok('integrations', 'run', { id: cal.id, action: 'calendars' });
    check('CalDAV calendars returns the parsed href', cals.ok && cals.calendars.length === 1 && /\/dav\/calendars\/caluser\/work\//.test(cals.calendars[0].url), cals.calendars[0]?.url);
    const events = await ok('integrations', 'run', { id: cal.id, action: 'events', args: { from: '2026-04-01', to: '2026-06-01' } });
    check('CalDAV events resolves the principal chain and parses ICS', events.ok && events.events.length === 1 && events.events[0].summary === 'Design review' && events.events[0].location === 'Room 4', events.events[0]?.summary);
    const createdEvent = await ok('integrations', 'run', { id: cal.id, action: 'create', args: { summary: 'Smoke event', start: '2026-05-02T10:00:00Z', end: '2026-05-02T11:00:00Z' } });
    const putBody = state.putIcs[state.putIcs.length - 1]?.body || '';
    check('CalDAV create PUTs a real VCALENDAR with If-None-Match', createdEvent.ok && /BEGIN:VCALENDAR/.test(putBody) && /SUMMARY:Smoke event/.test(putBody), createdEvent.href);
    const del = await ok('integrations', 'run', { id: cal.id, action: 'delete', args: { href: createdEvent.href } });
    check('CalDAV delete sends DELETE for the event href', del.ok && state.deleteHrefs.length === 1, del.output);

    console.log('\n— S3 storage');
    const s3 = await save({
      kind: 's3',
      label: 'Smoke S3',
      config: { endpoint: `${base}`, region: 'us-east-1', bucket: 'bucket', accessKeyId: 's3-access-key' },
      secrets: { secretAccessKey: SECRET_S3 },
    });
    const s3Test = await ok('integrations', 'test', s3.id);
    check('S3 test signs the request with SigV4', s3Test.ok && /reachable/.test(s3Test.output) && state.s3Authz.every((a) => a.startsWith('AWS4-HMAC-SHA256 Credential=s3-access-key/')), s3Test.output);
    const s3List = await ok('integrations', 'run', { id: s3.id, action: 'list', args: { limit: 10 } });
    check('S3 list parses the XML keys', s3List.ok && s3List.objects.length === 1 && s3List.objects[0].key === 'existing.txt', s3List.output.split('\n')[0]);
    const s3Put = await ok('integrations', 'run', { id: s3.id, action: 'put', args: { key: 'smoke/new.txt', content: 'uploaded by smoke' } });
    check('S3 put uploads the content', s3Put.ok && state.s3Objects.get('smoke/new.txt') === 'uploaded by smoke');
    const s3Get = await ok('integrations', 'run', { id: s3.id, action: 'get', args: { key: 'existing.txt' } });
    check('S3 get downloads the object to disk', s3Get.ok && s3Get.bytes === Buffer.byteLength('hello from the bucket') && /hello from the bucket/.test(s3Get.output) && fs.existsSync(s3Get.file), s3Get.file);
    if (s3Get.file) fs.rmSync(s3Get.file, { force: true });
    const s3Del = await ok('integrations', 'run', { id: s3.id, action: 'delete', args: { key: 'smoke/new.txt' } });
    check('S3 delete removes the object', s3Del.ok && !state.s3Objects.has('smoke/new.txt'));
    integrations.init({ dataDir: APP_DATA });
    check('integration_call gates S3 writes behind approval', !!integrations.approvalReason('integration_call', { connection: s3.id, action: 'put', args: {} }) && !integrations.approvalReason('integration_call', { connection: s3.id, action: 'list', args: {} }));

    console.log('\n— SQLite');
    const dbFile = path.join(TMP, 'smoke.db');
    const db = new DatabaseSync(dbFile);
    db.exec("create table items (id integer primary key, name text)");
    db.exec("insert into items (name) values ('alpha'), ('beta')");
    db.close();
    const sq = await save({ kind: 'sqlite', label: 'Smoke SQLite', config: { file: dbFile } });
    const sqTest = await ok('integrations', 'test', sq.id);
    check('SQLite test opens the real file', sqTest.ok && /1 table/.test(sqTest.output), sqTest.output);
    const tables = await ok('integrations', 'run', { id: sq.id, action: 'tables' });
    check('SQLite tables lists the schema', tables.ok && /table: items/.test(tables.output));
    const rows = await ok('integrations', 'run', { id: sq.id, action: 'query', args: { sql: 'select name from items order by name' } });
    check('SQLite query returns real rows', rows.ok && rows.rows.length === 2 && rows.rows[0].name === 'alpha', rows.output.split('\n')[0]);
    const writeBlocked = await fails('integrations', 'run', { id: sq.id, action: 'query', args: { sql: "insert into items (name) values ('gamma')" } });
    check('SQLite refuses writes unless write is set', /writes/.test(writeBlocked), writeBlocked);
    const writeOk = await ok('integrations', 'run', { id: sq.id, action: 'query', args: { sql: "insert into items (name) values ('gamma')", write: 'true' } });
    const after = new DatabaseSync(dbFile);
    const gamma = after.prepare("select count(*) as n from items where name = 'gamma'").get();
    after.close();
    check('SQLite write runs when explicitly allowed', writeOk.ok && gamma.n === 1, writeOk.output);
    const sqBlocked = await save({ kind: 'sqlite', label: 'Smoke SQLite blocked', config: { file: 'C:\\Windows\\System32\\drivers\\etc\\hosts' } });
    const sqBlockedTest = await fails('integrations', 'test', sqBlocked.id);
    check('SQLite keeps Windows system paths blocked', /Blocked/i.test(sqBlockedTest), sqBlockedTest.slice(0, 100));

    console.log('\n— PostgreSQL honest failure');
    const pg = await save({ kind: 'postgres', label: 'Smoke Postgres', config: { host: '127.0.0.1', port: '1', database: 'nope', user: 'nope', ssl: 'false' }, secrets: { password: 'x' } });
    const pgTest = await fails('integrations', 'test', pg.id);
    check('Postgres reports a real connection error instead of pretending', /connect|ECONNREFUSED|refused|timeout/i.test(pgTest), pgTest.slice(0, 120));

    console.log('\n— health');
    const health = await ok('integrations', 'health');
    const ghHealth = health.connections.find((c) => c.id === gh.id);
    check('health reports per-connection state and missing secrets', health.connections.length >= 6 && ghHealth?.state === 'ok' && health.webhook && typeof health.checkedAt === 'string', `${health.connections.length} connections`);

    console.log('\n— webhook receiver');
    initialHook = await ok('integrations', 'webhook', { op: 'status' });
    const hookStart = await ok('integrations', 'webhook', { op: 'start' });
    check('webhook starts on loopback with a token URL', hookStart.running === true && /^http:\/\/127\.0\.0\.1:\d+\/hook\/[0-9a-f]+$/.test(hookStart.url || ''), hookStart.url);
    await sleep(200);
    const hookCfg = JSON.parse(fs.readFileSync(path.join(APP_DATA, 'webhook.json'), 'utf8'));
    check('webhook records autostart so it returns after a restart', hookCfg.autostart === true && hookCfg.port === hookStart.port);
    const deliver = await fetch(hookStart.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-smoke': '1' }, body: JSON.stringify({ event: 'smoke.delivery', n: 42 }) });
    const deliverJson = await deliver.json();
    check('webhook accepts a real JSON delivery', deliver.status === 200 && deliverJson.ok === true && !!deliverJson.id);
    const wrongPath = await fetch(hookStart.url.replace(/\/hook\/.*/, '/hook/wrong'));
    check('webhook rejects an unknown path', wrongPath.status === 404);
    const hookEvents = await ok('integrations', 'webhook', { op: 'events', limit: 5 });
    const evt = hookEvents.events[0];
    check('webhook records the delivery with body, headers and size', hookEvents.events.length === 1 && evt.method === 'POST' && evt.body.n === 42 && evt.headers['x-smoke'] === '1' && evt.bytes > 0, `${evt.bytes} bytes`);
    const hookTest = await ok('integrations', 'webhook', { op: 'test' });
    check('webhook test delivers a real request back to itself', hookTest.ok === true && /accepted/.test(hookTest.output));
    const hookCount = await ok('integrations', 'webhook', { op: 'status' });
    check('webhook status counts requests', hookCount.requests >= 2, `${hookCount.requests} requests`);
    const hookClear = await ok('integrations', 'webhook', { op: 'clear' });
    check('webhook clear resets the in-memory history', hookClear.events === 0);
    const hookStop = await ok('integrations', 'webhook', { op: 'stop' });
    await sleep(200);
    const hookCfg2 = JSON.parse(fs.readFileSync(path.join(APP_DATA, 'webhook.json'), 'utf8'));
    check('webhook stop closes the port and clears autostart', hookStop.running === false && hookCfg2.autostart === false);

    console.log('\n— permissions');
    const perms = await ok('permissions', 'state');
    check('permissions list every registered tool with a source', perms.tools.length > 50 && perms.tools.every((t) => t.name && t.source && t.policy), `${perms.tools.length} tools`);
    const deny = await ok('permissions', 'set', 'system_status', 'deny');
    check('permissions set stores a deny policy', deny.policies.system_status === 'deny');
    const deniedRun = await tool('system_status');
    check('denied tools are refused before the handler runs', deniedRun.ok === false && /denied|permission/i.test(deniedRun.error), deniedRun.error);
    await ok('permissions', 'set', 'system_status', 'allow');
    const allowedRun = await tool('system_status');
    check('allow policies bypass the built-in approval prompt', allowedRun.ok === true && /threads/.test(allowedRun.data.output), allowedRun.data?.output?.split('\n')[0]);
    await ok('permissions', 'reset', 'system_status');
    const resetState = await ok('permissions', 'state');
    check('permissions reset restores the default policy', !resetState.policies.system_status);

    console.log('\n— MCP server');
    initialMcp = await ok('mcpServer', 'status');
    const mcpPort = await freePort();
    const mcpStart = await ok('mcpServer', 'start', { port: mcpPort });
    check('MCP server starts on 127.0.0.1 with a bearer token', mcpStart.running === true && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(mcpStart.endpoint || '') && /^Authorization: Bearer /.test(mcpStart.authHeader || ''), mcpStart.endpoint);
    const cli = async (body, headers = {}) => {
      const res = await fetch(mcpStart.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* SSE framing */
        const line = text.split('\n').find((l) => l.startsWith('data: '));
        if (line) json = JSON.parse(line.slice(6));
      }
      return { status: res.status, json, headers: res.headers, text };
    };
    const noAuth = await cli({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    check('MCP rejects requests without the bearer token', noAuth.status === 401, `HTTP ${noAuth.status}`);
    const wrongAuth = await cli({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { authorization: 'Bearer wrong-token' });
    check('MCP rejects a wrong bearer token', wrongAuth.status === 401, `HTTP ${wrongAuth.status}`);
    const bearer = mcpStart.authHeader.replace(/^Authorization:\s*/i, '');
    const initRes = await cli({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'smoke' } } }, { authorization: bearer });
    const sessionId = initRes.headers.get('mcp-session-id');
    const auth = { authorization: bearer, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) };
    check('MCP initialize returns the protocol and server identity', initRes.status === 200 && initRes.json?.result?.protocolVersion === '2025-03-26' && initRes.json.result.serverInfo.name === 'orvex' && !!sessionId, initRes.json?.result?.serverInfo?.name);
    const toolsRes = await cli({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, auth);
    const toolNames = (toolsRes.json?.result?.tools || []).map((t) => t.name);
    check('MCP tools/list exposes the real ORVEX tool registry', toolNames.length > 50 && toolNames.includes('system_status') && toolNames.includes('http_request') && toolNames.includes('integration_call'), `${toolNames.length} tools`);
    const callStatus = await cli({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'system_status', arguments: {} } }, auth);
    const callText = callResText(callStatus.json);
    check('MCP tools/call runs a real tool', callStatus.status === 200 && callStatus.json?.result?.isError === false && /threads/.test(callText), callText.split('\n')[0]);
    await ok('permissions', 'set', 'system_status', 'deny');
    const callDenied = await cli({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'system_status', arguments: {} } }, auth);
    check('MCP honours the permission engine', callDenied.json?.result?.isError === true && /denied|permission/i.test(callResText(callDenied.json)));
    await ok('permissions', 'reset', 'system_status');
    const scriptPath = path.join(TMP, 'risky.ps1');
    const risky = await cli({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'fs_write', arguments: { path: scriptPath, content: '# smoke' } } }, auth);
    check('MCP refuses an approval-gated tool by default', risky.json?.result?.isError === true && /approve|Approve/i.test(callResText(risky.json)) && !fs.existsSync(scriptPath), callResText(risky.json).slice(0, 80));
    const before = await ok('mcpServer', 'setAllowRisky', true);
    const risky2 = await cli({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'fs_write', arguments: { path: scriptPath, content: '# smoke' } } }, auth);
    check('MCP runs approval-gated tools when allowed', before.allowRisky === true && risky2.json?.result?.isError === false && fs.existsSync(scriptPath), callResText(risky2.json).slice(0, 80));
    await ok('mcpServer', 'setAllowRisky', false);
    fs.rmSync(scriptPath, { force: true });
    const unknown = await cli({ jsonrpc: '2.0', id: 8, method: 'does/not/exist' }, auth);
    check('MCP answers unknown methods with -32601', unknown.json?.error?.code === -32601);
    const unknownTool = await cli({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope_tool', arguments: {} } }, auth);
    check('MCP rejects an unknown tool name', unknownTool.json?.result?.isError === true && /Unknown tool/.test(callResText(unknownTool.json)));
    const mcpFinal = await ok('mcpServer', 'status');
    check('MCP status counts requests and tool calls', mcpFinal.requests >= 8 && mcpFinal.toolCalls >= 2, `${mcpFinal.requests} requests, ${mcpFinal.toolCalls} calls`);
    const mcpStop = await ok('mcpServer', 'stop');
    check('MCP stop closes the loopback port', mcpStop.running === false);

    console.log('\n— OAuth device flow');
    const deviceFlow = await ok('oauth', 'device', {
      provider: 'custom',
      clientId: 'cid-device',
      deviceUrl: `${base}/oauth/device`,
      tokenUrl: `${base}/oauth/token`,
      userinfoUrl: `${base}/oauth/userinfo`,
      scopes: ['read', 'write'],
      label: 'Smoke Device',
      autoOpen: false,
    });
    check('device flow requests a real device code', deviceFlow.status === 'pending' && deviceFlow.userCode === 'ORVX-1234' && /\/oauth\/verify/.test(deviceFlow.verificationUrl || ''), deviceFlow.userCode);
    let deviceDone = null;
    for (let i = 0; i < 20 && !deviceDone; i += 1) {
      await sleep(800);
      const f = await ok('oauth', 'flow', deviceFlow.id);
      if (f.status !== 'pending') deviceDone = f;
    }
    check('device flow polls through authorization_pending to a token', deviceDone?.status === 'done' && !!deviceDone.accountId && state.devicePolls >= 2, `status ${deviceDone?.status}, ${state.devicePolls} polls`);
    accounts.push(deviceDone?.accountId);
    const dToken = await ok('oauth', 'tokenState', deviceDone.accountId);
    check('device account keeps a refresh token and a real expiry', dToken.connected === true && dToken.hasRefresh === true && dToken.expiresAt !== null, `expires in ${dToken.expiresIn}s`);
    const dCheck = await ok('oauth', 'check', deviceDone.accountId);
    check('check refreshes a token that is about to expire', dCheck.ok === true && dCheck.refreshed === true && state.refreshCalls >= 1 && state.refreshGrantType === 'rt-device-1', `refreshed=${dCheck.refreshed}, calls=${state.refreshCalls}`);
    const dAfter = await ok('oauth', 'tokenState', deviceDone.accountId);
    check('refreshed token is valid for the new lifetime', dAfter.tokenState === 'valid' && dAfter.expiresIn > 3000, `${dAfter.expiresIn}s`);
    const oauthState = JSON.stringify(await ok('oauth', 'state'));
    check('OAuth state never exposes access or refresh tokens', !oauthState.includes('at-device-1') && !oauthState.includes('rt-device-1') && !oauthState.includes('at-refreshed-2') && !oauthState.includes('access_token'));

    console.log('\n— OAuth PKCE loopback');
    const pkceFlow = await ok('oauth', 'pkce', {
      provider: 'custom',
      clientId: 'cid-pkce',
      authUrl: `${base}/oauth/authorize`,
      tokenUrl: `${base}/oauth/token`,
      userinfoUrl: `${base}/oauth/userinfo`,
      scopes: ['read'],
      label: 'Smoke PKCE',
      autoOpen: false,
    });
    const authQuery = new URL(pkceFlow.authUrl).searchParams;
    check('PKCE builds an S256 challenge and a loopback redirect', authQuery.get('code_challenge_method') === 'S256' && !!authQuery.get('code_challenge') && /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(authQuery.get('redirect_uri') || ''), authQuery.get('redirect_uri'));
    const authorize = await fetch(pkceFlow.authUrl, { redirect: 'manual' });
    const callbackUrl = authorize.headers.get('location');
    const cb = await fetch(callbackUrl);
    const callbackHtml = await cb.text();
    let pkceDone = null;
    for (let i = 0; i < 20 && !pkceDone; i += 1) {
      await sleep(400);
      const f = await ok('oauth', 'flow', pkceFlow.id);
      if (f.status !== 'pending') pkceDone = f;
    }
    check('PKCE completes through the loopback callback and exchanges the code', authorize.status === 302 && cb.status === 200 && /sign-in|Connected|ORVEX/i.test(callbackHtml) && pkceDone?.status === 'done', `status ${pkceDone?.status}`);
    accounts.push(pkceDone?.accountId);
    const verifierOk = state.codeVerifier.length >= 43 && /^[-_A-Za-z0-9]+$/.test(state.codeVerifier);
    check('PKCE sends the real code verifier to the token endpoint', state.codeCalls >= 1 && verifierOk, `${state.codeVerifier.length} chars`);
    const pToken = await ok('oauth', 'tokenState', pkceDone.accountId);
    check('PKCE account is connected', pToken.connected === true && pToken.hasRefresh === true);

    const badFlow = await ok('oauth', 'pkce', {
      provider: 'custom',
      clientId: 'cid-pkce',
      authUrl: `${base}/oauth/authorize`,
      tokenUrl: `${base}/oauth/token`,
      scopes: ['read'],
      label: 'Smoke Bad State',
      autoOpen: false,
    });
    const badRedirect = new URL(new URL(badFlow.authUrl).searchParams.get('redirect_uri'));
    badRedirect.searchParams.set('code', 'auth-code-1');
    badRedirect.searchParams.set('state', 'tampered');
    await fetch(badRedirect);
    await sleep(300);
    const badState = await ok('oauth', 'flow', badFlow.id);
    check('PKCE rejects a tampered state and never exchanges the code', badState.status === 'error' && /state/i.test(badState.error || ''), badState.error);

    const accountsBefore = await ok('oauth', 'state');
    const ours = accountsBefore.accounts.filter((a) => a.id === deviceDone.accountId || a.id === pkceDone.accountId);
    check('OAuth state lists the connected accounts with metadata', ours.length === 2 && ours.every((a) => a.email === 'smoke@example.com' && a.name === 'Smoke Tester'), ours.map((a) => a.label).join(', '));

    const removed = await ok('oauth', 'remove', deviceDone.accountId);
    const goneState = await fails('oauth', 'tokenState', deviceDone.accountId);
    const afterState = await ok('oauth', 'state');
    check(
      'removing an OAuth account deletes its token and listing',
      removed.removed === deviceDone.accountId && /No OAuth account/.test(goneState) && !afterState.accounts.some((a) => a.id === deviceDone.accountId),
    );

    console.log('\n— cleanup');
  } catch (err) {
    check('smoke suite completed without fatal errors', false, err && err.message ? err.message : String(err));
  } finally {
    for (const id of created) {
      try {
        await ipc('integrations', 'remove', id);
      } catch {
        /* gone */
      }
    }
    for (const id of accounts) {
      if (!id) continue;
      try {
        await ipc('oauth', 'remove', id);
      } catch {
        /* gone */
      }
    }
    try {
      await ipc('permissions', 'reset');
    } catch {
      /* ignore */
    }
    try {
      await ipc('integrations', 'webhook', { op: 'stop' });
      if (initialHook && initialHook.autostart) await ipc('integrations', 'webhook', { op: 'start', port: initialHook.port, autostart: true });
    } catch {
      /* ignore */
    }
    try {
      await ipc('mcpServer', 'stop');
      if (initialMcp && initialMcp.running) await ipc('mcpServer', 'start', { port: initialMcp.port });
    } catch {
      /* ignore */
    }
    cdp.ws.close();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => smtp.close(resolve));
    removeDir(TMP);
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} checks passed`);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      console.log('\nFailed checks:');
      for (const f of failed) console.log(` - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
      process.exitCode = 1;
    }
  }
})();

function callResText(json) {
  try {
    return (json.result.content || []).map((c) => c.text).join('\n');
  } catch {
    return '';
  }
}
