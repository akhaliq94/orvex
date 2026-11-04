import { describe, expect, it } from 'vitest';

const connectors = require('../../electron/connectors.cjs');
const { parseSpec, buildRequest, cleanAuth, slug } = connectors._test;

const baseSpec = {
  openapi: '3.0.3',
  info: { title: 'Demo API', version: '1.2.3' },
  servers: [{ url: 'https://api.example.com/{version}', variables: { version: { default: 'v1' } } }],
  paths: {
    '/items/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        operationId: 'getItem',
        summary: 'Get one item',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
        ],
      },
      post: {
        operationId: 'createItem',
        summary: 'Create an item',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Item' },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Item: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Item name' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

describe('connectors.parseSpec', () => {
  it('parses an OpenAPI 3 spec with server variables, refs and body fields', () => {
    const parsed = parseSpec(baseSpec);
    expect(parsed.title).toBe('Demo API');
    expect(parsed.version).toBe('1.2.3');
    expect(parsed.format).toBe('openapi');
    expect(parsed.baseUrl).toBe('https://api.example.com/v1');
    expect(parsed.ops).toHaveLength(2);
    const get = parsed.ops.find((op) => op.id === 'getItem');
    expect(get.method).toBe('GET');
    expect(get.path).toBe('/items/{id}');
    expect(get.params).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'id', in: 'path', required: true }),
        expect.objectContaining({ name: 'limit', in: 'query', required: false, type: 'integer' }),
        expect.objectContaining({ name: 'X-Trace', in: 'header' }),
      ]),
    );
    const post = parsed.ops.find((op) => op.id === 'createItem');
    expect(post.body.required).toBe(true);
    expect(post.body.properties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'name', type: 'string', required: true }),
        expect.objectContaining({ name: 'tags', type: 'array', required: false }),
      ]),
    );
  });

  it('parses a Swagger 2 spec with host, basePath and scheme', () => {
    const parsed = parseSpec({
      swagger: '2.0',
      info: { title: 'Legacy', version: '2.0.1' },
      host: 'api.legacy.test',
      basePath: '/v2',
      schemes: ['http'],
      paths: { '/ping': { get: { summary: 'Ping' } } },
    });
    expect(parsed.format).toBe('swagger');
    expect(parsed.baseUrl).toBe('http://api.legacy.test/v2');
    expect(parsed.ops[0].method).toBe('GET');
    expect(parsed.ops[0].id).toBeTruthy();
  });

  it('resolves a relative server URL against the source URL', () => {
    const parsed = parseSpec(
      { openapi: '3.0.0', info: { title: 'Rel', version: '1' }, servers: [{ url: '/api' }], paths: { '/x': { get: {} } } },
      'https://docs.example.com/spec.json',
    );
    expect(parsed.baseUrl).toBe('https://docs.example.com/api');
  });

  it('parses a YAML spec', () => {
    const parsed = parseSpec(`openapi: 3.0.3
info:
  title: YAML Demo
  version: '1.0.0'
servers:
  - url: https://x.test
paths:
  /ping:
    get:
      operationId: ping
      responses:
        '200':
          description: ok
`);
    expect(parsed.title).toBe('YAML Demo');
    expect(parsed.baseUrl).toBe('https://x.test');
    expect(parsed.ops.map((op) => op.id)).toEqual(['ping']);
  });

  it('rejects broken YAML and non-OpenAPI documents', () => {
    expect(() => parseSpec('openapi: 3.0.0\npaths:\n  - [unclosed')).toThrow(/JSON nor valid YAML/);
    expect(() => parseSpec('{not json')).toThrow(/JSON nor valid YAML/);
    expect(() => parseSpec({ paths: {} })).toThrow(/OpenAPI/);
    expect(() => parseSpec({ openapi: '3.0.0', info: {}, servers: [{ url: 'https://x.test' }], paths: {} })).toThrow(/no HTTP operations/);
  });

  it('requires an absolute base URL when the spec cannot supply one', () => {
    expect(() => parseSpec({ openapi: '3.0.0', info: {}, paths: { '/x': { get: {} } } })).toThrow(/server URL/);
  });

  it('skips forbidden header parameters and de-duplicates operations', () => {
    const parsed = parseSpec({
      openapi: '3.0.0',
      info: { title: 'H', version: '1' },
      servers: [{ url: 'https://h.test' }],
      paths: {
        '/a': { get: { operationId: 'same', parameters: [{ name: 'Authorization', in: 'header' }, { name: 'Cookie', in: 'header' }, { name: 'X-Key', in: 'header' }] } },
        '/b': { get: { operationId: 'same' } },
      },
    });
    expect(parsed.ops[0].params.map((p) => p.name)).toEqual(['X-Key']);
    expect(parsed.ops.map((op) => op.id)).toEqual(['same', 'same_2']);
  });
});

describe('connectors auth and requests', () => {
  const conn = { id: 'demo', label: 'Demo', baseUrl: 'https://api.example.com/v1', auth: { type: 'none', name: '' }, secretSet: false };

  it('validates auth types and header names', () => {
    expect(cleanAuth({ type: 'bearer' })).toEqual({ type: 'bearer', name: '' });
    expect(cleanAuth({ type: 'header', name: 'X-API-Key' })).toEqual({ type: 'header', name: 'X-API-Key' });
    expect(() => cleanAuth({ type: 'header', name: 'Authorization' })).toThrow(/header name/);
    expect(() => cleanAuth({ type: 'header', name: 'bad name' })).toThrow(/header name/);
    expect(() => cleanAuth({ type: 'query', name: 'bad name' })).toThrow(/query parameter/);
    expect(() => cleanAuth({ type: 'basic' })).toThrow(/auth.type/);
  });

  it('builds a URL with encoded path values, query and headers', async () => {
    const op = parseSpec(baseSpec).ops.find((o) => o.id === 'getItem');
    const request = await buildRequest(conn, op, { path: { id: 'a/b' }, query: { limit: 5 }, headers: { 'X-Trace': 'abc' } });
    expect(request.url).toBe('https://api.example.com/v1/items/a%2Fb?limit=5');
    expect(request.method).toBe('GET');
    expect(request.headers).toEqual({ 'X-Trace': 'abc' });
    expect(request.body).toBeUndefined();
  });

  it('serializes a JSON body for write operations', async () => {
    const op = parseSpec(baseSpec).ops.find((o) => o.id === 'createItem');
    const request = await buildRequest(conn, op, { path: { id: '42' }, body: { name: 'demo' } });
    expect(request.method).toBe('POST');
    expect(request.headers['content-type']).toBe('application/json');
    expect(JSON.parse(request.body)).toEqual({ name: 'demo' });
  });

  it('refuses to call an auth connector with no saved secret', async () => {
    const op = parseSpec(baseSpec).ops.find((o) => o.id === 'getItem');
    await expect(buildRequest({ ...conn, auth: { type: 'bearer', name: '' } }, op, { path: { id: '1' } })).rejects.toThrow(/no secret is saved/);
  });

  it('rejects missing path values', async () => {
    const op = parseSpec(baseSpec).ops.find((o) => o.id === 'getItem');
    await expect(buildRequest(conn, op, {})).rejects.toThrow(/Missing path parameter "id"/);
  });

  it('encodes path values so they cannot escape the operation path', async () => {
    const op = parseSpec(baseSpec).ops.find((o) => o.id === 'getItem');
    const request = await buildRequest(conn, op, { path: { id: '../admin?x=1' } });
    expect(request.url).toBe('https://api.example.com/v1/items/..%2Fadmin%3Fx%3D1');
    expect(new URL(request.url).origin).toBe('https://api.example.com');
  });

  it('produces stable slugs', () => {
    expect(slug('My API!', 'fallback')).toBe('my-api');
    expect(slug('***', 'fallback')).toBe('fallback');
  });
});
