'use strict';

/**
 * Phase 8 — OpenAPI connectors smoke.
 * Runs inside Electron-as-Node against a temporary profile and a real local
 * HTTP server, so URL building, request bodies and responses are exercised
 * over the network instead of being mocked.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const connectors = require('../electron/connectors.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-connectors-'));
const dataDir = path.join(root, 'profile');
fs.mkdirSync(dataDir, { recursive: true });

let pass = 0;
let fail = 0;
const events = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

async function expectError(name, fn, pattern) {
  try {
    await fn();
    check(name, false, 'no error was thrown');
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    check(name, !pattern || pattern.test(message), message);
  }
}

function specFor(baseUrl) {
  return {
    openapi: '3.0.0',
    info: { title: 'Local Test API', version: '1.0.0' },
    servers: [{ url: baseUrl }],
    paths: {
      '/echo/{id}': {
        get: {
          operationId: 'echo',
          summary: 'Echo path and query',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'q', in: 'query', schema: { type: 'string' } },
          ],
        },
        post: {
          operationId: 'write',
          summary: 'Echo the JSON body',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } },
        },
      },
      '/status': { get: { operationId: 'status', summary: 'Status' } },
    },
  };
}

function startServer() {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ method: req.method, url: req.url, received: body ? JSON.parse(body) : null }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

(async () => {
  const { server, seen, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const init = await connectors.init({
      dataDir,
      emit: (event) => events.push(event),
    });
    check('init starts with no connectors', init.connectors === 0);

    const preview = await connectors.previewSpec({ spec: specFor(baseUrl) });
    check('preview parses the OpenAPI document', preview.title === 'Local Test API' && preview.ops.length === 3, `${preview.ops.length} ops`);
    check('preview reports the server base URL', preview.baseUrl === baseUrl, preview.baseUrl);
    check('preview exposes method, path and params', preview.ops.some((op) => op.id === 'echo' && op.method === 'GET' && op.params.length === 2));
    check('preview exposes JSON body fields', preview.ops.find((op) => op.id === 'write').body.properties[0].name === 'name');

    const yamlDoc = `openapi: 3.0.3
info:
  title: YAML API
  version: '1.0'
servers:
  - url: ${baseUrl}
paths:
  /ping:
    get:
      operationId: ping
      summary: Ping the server
      responses:
        '200':
          description: ok
`;
    const yamlPreview = await connectors.previewSpec({ spec: yamlDoc });
    check('YAML spec preview parses', yamlPreview.title === 'YAML API' && yamlPreview.ops.length === 1, `${yamlPreview.ops.length} ops`);
    check('YAML spec keeps its server URL', yamlPreview.baseUrl === baseUrl, yamlPreview.baseUrl);
    await expectError('broken YAML is rejected clearly', () => connectors.previewSpec({ spec: 'openapi: 3.0.0\npaths:\n  - [unclosed' }), /JSON nor valid YAML|not/i);
    await expectError('non-OpenAPI documents are rejected', () => connectors.previewSpec({ spec: { hello: 'world' } }), /OpenAPI/);

    const saved = await connectors.saveConnector({
      label: 'Local Test API',
      spec: specFor(baseUrl),
      auth: { type: 'none' },
    });
    check('save stores the connector', saved.id === 'local-test-api' && saved.operationCount === 3, saved.id);
    check('save emits a change event', events.some((event) => event.kind === 'connectors-changed' && event.id === saved.id));
    check('connectors file exists', fs.existsSync(path.join(dataDir, 'connectors.json')));

    const listed = connectors.listConnectors();
    check('list returns the saved connector', listed.connectors.length === 1 && listed.connectors[0].baseUrl === baseUrl);

    const raw = fs.readFileSync(path.join(dataDir, 'connectors.json'), 'utf8');
    check('connectors file stores no spec body or secret fields', !raw.includes('"secret"') && !raw.includes('"spec"'));

    const get = await connectors.callConnector({
      connector: saved.id,
      operation: 'echo',
      args: { path: { id: 'a b' }, query: { q: 'hello world' } },
    });
    check('GET call succeeds', get.ok && get.status === 200, `status ${get.status}`);
    check('GET encodes the path and query values', seen.at(-1).url === '/echo/a%20b?q=hello+world', seen.at(-1).url);
    check('GET returns parsed JSON', get.json && get.json.method === 'GET');

    const post = await connectors.callConnector({
      connector: saved.id,
      operation: 'write',
      args: { path: { id: '9' }, body: { name: 'orvex' } },
    });
    check('POST call succeeds', post.ok && post.status === 200, `status ${post.status}`);
    check('POST sends the JSON body', seen.at(-1).body === '{"name":"orvex"}' && seen.at(-1).headers['content-type'] === 'application/json');
    check('POST returns the echoed body', post.json && post.json.received && post.json.received.name === 'orvex');

    const tested = await connectors.testConnector(saved.id);
    check('test picks the parameter-free GET operation', tested.ok && seen.at(-1).url === '/status', seen.at(-1).url);

    await expectError('unknown connector is rejected', () => connectors.callConnector({ connector: 'nope', operation: 'echo' }), /No connector/);
    await expectError('unknown operation is rejected', () => connectors.callConnector({ connector: saved.id, operation: 'nope' }), /not in connector/);
    await expectError('missing path parameters are reported', () => connectors.callConnector({ connector: saved.id, operation: 'echo', args: {} }), /Missing path parameter/);

    check('GET needs no approval', connectors.approvalReason('connector_call', { connector: saved.id, operation: 'echo' }) === null);
    check('POST needs approval', /POST/.test(connectors.approvalReason('connector_call', { connector: saved.id, operation: 'write' }) || ''));

    const defs = connectors.definitions.map((d) => d.name);
    check('tool definitions expose connector_list and connector_call', defs.includes('connector_list') && defs.includes('connector_call'));
    const listOutput = await connectors.handlers.connector_list();
    check('connector_list handler describes operations', listOutput.ok && listOutput.output.includes('echo') && listOutput.output.includes('GET /echo/{id}'));

    const reloaded = await connectors.init({ dataDir });
    check('connectors survive a reload', reloaded.connectors === 1 && connectors.listConnectors().connectors[0].operationCount === 3);

    const edited = await connectors.saveConnector({ id: saved.id, label: 'Renamed API', auth: { type: 'none' } });
    check('editing keeps operations without re-importing', edited.label === 'Renamed API' && edited.operationCount === 3);

    await connectors.deleteConnector(saved.id);
    check('delete removes the connector', connectors.listConnectors().connectors.length === 0);
    await expectError('deleted connector cannot be called', () => connectors.callConnector({ connector: saved.id, operation: 'echo' }), /No connector/);

    await expectError('an auth connector without a secret refuses to run', async () => {
      const authSaved = await connectors.saveConnector({ label: 'Needs Auth', spec: specFor(baseUrl), auth: { type: 'bearer' } });
      try {
        await connectors.callConnector({ connector: authSaved.id, operation: 'echo', args: { path: { id: '1' } } });
      } finally {
        await connectors.deleteConnector(authSaved.id);
      }
    }, /no secret is saved/);
  } finally {
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
