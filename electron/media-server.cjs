'use strict';

/**
 * Tiny read-only HTTP host for bundled MediaPipe assets. The renderer runs from
 * file:// in the installed build, where fetch() cannot read local files, so the
 * wasm loader and the hand model are served from 127.0.0.1 with a random token.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const SAFE = /^[a-zA-Z0-9._/-]+$/;

let server = null;
let ready = null;
let token = '';
let baseUrl = '';
let roots = [];

function info() {
  return { baseUrl, token: token ? 'set' : '', running: !!server };
}

function isSafeRel(rel) {
  return typeof rel === 'string' && rel.length > 0 && SAFE.test(rel) && !rel.includes('..');
}

function resolveAsset(rel) {
  if (!isSafeRel(rel)) return null;
  for (const root of roots) {
    const base = path.resolve(root);
    const candidate = path.resolve(base, rel);
    if (!candidate.startsWith(base + path.sep)) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* try the next root */
    }
  }
  return null;
}

function handle(req, res) {
  const deny = (code, text) => {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(text);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'GET only');
  let url;
  try {
    url = new URL(req.url || '/', 'http://127.0.0.1');
  } catch {
    return deny(400, 'Bad request');
  }
  const prefix = `/${token}/mediapipe/`;
  if (!url.pathname.startsWith(prefix)) return deny(404, 'Not found');
  let rel;
  try {
    rel = decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    return deny(400, 'Bad request');
  }
  const file = resolveAsset(rel);
  if (!file) return deny(404, 'Not found');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return deny(404, 'Not found');
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=86400',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function start({ dirs } = {}) {
  if (ready) return ready;
  roots = (Array.isArray(dirs) ? dirs : []).filter(Boolean);
  token = crypto.randomBytes(18).toString('hex');
  server = http.createServer(handle);
  server.unref();
  ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}/${token}/mediapipe`;
      resolve(info());
    });
  });
  return ready;
}

function stop() {
  if (!server) return;
  const s = server;
  server = null;
  ready = null;
  baseUrl = '';
  token = '';
  try {
    s.close();
  } catch {
    /* already closed */
  }
}

module.exports = { start, stop, info, isSafeRel };
