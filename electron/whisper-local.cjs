'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

/**
 * Keeps a local whisper.cpp server alive for the lifetime of the app.
 *
 * The install is optional: when no whisper.cpp build + ggml model can be found
 * the feature simply stays off, and voice input reports that no endpoint is
 * configured. A server someone else already started on the same port is reused
 * and never killed by us.
 */

const HOST = '127.0.0.1';
const PORT = 8079;
const INFERENCE_PATH = '/v1/audio/transcriptions';
const MODEL_FILES = [
  'ggml-base-q8_0.bin',
  'ggml-base.bin-q8_0.bin',
  'ggml-base.bin',
  'ggml-small.bin',
  'ggml-medium.bin',
  'ggml-base.en.bin',
];

let child = null;
let external = false;
let install = null;
let lastError = null;
let stderrTail = '';

function serverName() {
  return process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
}

function searchRoots() {
  const fromEnv = String(process.env.ORVEX_WHISPER_DIR || '').trim();
  // An explicit location is authoritative — never fall back to the machine default.
  if (fromEnv) return [path.resolve(fromEnv)];
  return [...new Set([
    // Unpacked/dev layout: <project>/release/win-unpacked/ORVEX.exe → <project>/tools/whisper
    path.resolve(path.join(path.dirname(process.execPath), '..', '..', 'tools', 'whisper')),
    path.resolve(path.join(__dirname, '..', 'tools', 'whisper')),
  ])];
}

function findInstall(roots = searchRoots()) {
  for (const dir of roots) {
    const server = path.join(dir, 'Release', serverName());
    const model = MODEL_FILES.map((m) => path.join(dir, m)).find((m) => fs.existsSync(m));
    if (!fs.existsSync(server) || !model) continue;
    const ffmpeg = path.join(dir, '..', 'ffmpeg', 'bin');
    return {
      dir,
      server,
      model,
      ffmpeg: fs.existsSync(path.join(ffmpeg, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')) ? ffmpeg : null,
    };
  }
  return null;
}

function buildArgs(found, port = PORT) {
  return [
    '-m', found.model,
    '--host', HOST,
    '--port', String(port),
    '--convert',
    '-l', 'auto',
    // Measured on this 4-core desktop: every core beats leaving one free for
    // the app, and skipping token timestamps nearly halves the turn.
    '-t', String(Math.max(2, os.cpus().length)),
    '-nc',
    '-nt',
    '--inference-path', INFERENCE_PATH,
  ];
}

function portAnswers(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function info() {
  return {
    running: !!child || external,
    owned: !!child,
    external,
    pid: child ? child.pid : null,
    port: PORT,
    endpoint: `http://${HOST}:${PORT}${INFERENCE_PATH}`,
    dir: install ? install.dir : null,
    model: install ? path.basename(install.model) : null,
    error: lastError,
  };
}

async function start({ port = PORT } = {}) {
  if (child) return info();
  if (process.env.ORVEX_DISABLE_LOCAL_WHISPER === '1') {
    return { ...info(), skipped: 'disabled' };
  }
  install = findInstall();
  if (!install) {
    lastError = null;
    return { ...info(), skipped: 'not-installed' };
  }
  if (await portAnswers(port)) {
    external = true;
    return { ...info(), skipped: 'already-running' };
  }

  lastError = null;
  stderrTail = '';
  const env = { ...process.env };
  if (install.ffmpeg) env.PATH = `${install.ffmpeg}${path.delimiter}${env.PATH || ''}`;
  const proc = spawn(install.server, buildArgs(install, port), {
    cwd: install.dir,
    env,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child = proc;
  external = false;
  proc.stderr?.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });
  proc.on('error', (err) => {
    lastError = err && err.message ? err.message : String(err);
  });
  proc.on('exit', (code) => {
    if (child === proc) child = null;
    if (code && code !== 0) {
      const tail = stderrTail.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
      lastError = `whisper-server exited with code ${code}${tail ? ` — ${tail}` : ''}`;
    }
  });
  return info();
}

function stop() {
  if (!child) return;
  const proc = child;
  child = null;
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
}

module.exports = { HOST, PORT, INFERENCE_PATH, findInstall, buildArgs, portAnswers, start, stop, info };
