'use strict';

/**
 * Coding workspace backend.
 *
 * Every path the renderer sends is workspace-relative and resolved inside the
 * opened folder (symlinks included). Git is driven through the real `git`
 * binary, and only scripts declared in the root package.json can be launched by
 * name. The terminal path reuses the same dangerous-command blocklist as the
 * agent's shell_exec tool and streams output instead of buffering it.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { checkCommand } = require('./guardrails.cjs');

const realpathNative = (target) =>
  new Promise((resolve, reject) => fs.realpath.native(target, (err, out) => (err ? reject(err) : resolve(out))));

const STATE_FILE = 'code-workspace.json';
const IGNORED = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.output',
  '.venv', 'venv', '__pycache__', '.cache', '.turbo', 'target', 'coverage',
]);
const MAX_READ = 2 * 1024 * 1024;
const MAX_WRITE = 5 * 1024 * 1024;
const MAX_DIFF = 200 * 1024;
const MAX_LOG = 30;
const MAX_RUNS = 4;
const MAX_RUNTIME_MS = 30 * 60 * 1000;
const SEARCH_FILE_LIMIT = 8000;
const SEARCH_MATCH_LIMIT = 250;
const CHUNK = 8 * 1024;

let dataDir = null;
let emit = () => {};
let root = null;
let realRoot = null;
let stateReady = null;
const runs = new Map();

function stateFile() {
  return path.join(dataDir || os.tmpdir(), STATE_FILE);
}

async function loadState() {
  try {
    const raw = JSON.parse(await fsp.readFile(stateFile(), 'utf8'));
    const dir = raw && typeof raw.root === 'string' ? raw.root : '';
    if (dir) {
      const stat = await fsp.stat(dir).catch(() => null);
      if (stat && stat.isDirectory()) {
        realRoot = await realpathNative(dir);
        root = realRoot;
      }
    }
  } catch {
    /* no workspace saved yet */
  }
}

async function saveState() {
  try {
    await fsp.mkdir(path.dirname(stateFile()), { recursive: true });
    await fsp.writeFile(stateFile(), JSON.stringify({ root }, null, 2), 'utf8');
  } catch {
    /* a read-only profile should not block coding, it only forgets the folder */
  }
}

function init(opts = {}) {
  dataDir = opts.dataDir || dataDir;
  if (typeof opts.emit === 'function') emit = opts.emit;
  if (!stateReady) stateReady = loadState();
  return stateReady;
}

async function ready() {
  if (!stateReady) stateReady = loadState();
  await stateReady;
}

function requireRoot() {
  if (!root) throw new Error('No folder is open. Pick a workspace first.');
  return root;
}

function isUnder(child, parent) {
  const a = child.toLowerCase();
  const b = parent.toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

function resolveInside(rel) {
  const base = requireRoot();
  const raw = String(rel ?? '').replace(/\\/g, '/');
  if (!raw || raw === '.' || raw === './') return base;
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) throw new Error('Use a workspace-relative path.');
  const abs = path.resolve(base, raw);
  if (!isUnder(abs, base)) throw new Error('That path is outside the open workspace.');
  return abs;
}

async function assertRealInside(abs, mode) {
  const base = realRoot || requireRoot();
  let target = abs;
  try {
    target = await realpathNative(abs);
  } catch {
    if (mode === 'write') target = await realpathNative(path.dirname(abs)).then((p) => path.join(p, path.basename(abs))).catch(() => abs);
  }
  if (!isUnder(target, base)) throw new Error('That path escapes the workspace through a link.');
  return target;
}

function toRel(abs) {
  const base = requireRoot();
  const rel = path.relative(base, abs).split(path.sep).join('/');
  return rel || '.';
}

async function readScripts() {
  const base = requireRoot();
  const file = path.join(base, 'package.json');
  try {
    const pkg = JSON.parse(await fsp.readFile(file, 'utf8'));
    const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
    return Object.entries(scripts)
      .filter(([, cmd]) => typeof cmd === 'string' && cmd.trim())
      .map(([name, command]) => ({ name, command: command.slice(0, 300) }));
  } catch {
    return [];
  }
}

async function info() {
  await ready();
  if (!root) return { root: null, name: null, isGit: false, scripts: [], branch: null };
  const isGit = fs.existsSync(path.join(root, '.git'));
  let branch = null;
  if (isGit) {
    branch = await gitText(['rev-parse', '--abbrev-ref', 'HEAD'])
      .then((name) => (name === 'HEAD' ? '(detached)' : name))
      .catch(() => gitText(['symbolic-ref', '--short', 'HEAD']).catch(() => null));
  }
  return { root, name: path.basename(root), isGit, scripts: await readScripts(), branch };
}

async function open(dir) {
  await ready();
  const wanted = String(dir || '').trim();
  if (!wanted) throw new Error('Pick a folder to open.');
  const stat = await fsp.stat(wanted).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`"${wanted}" is not a folder.`);
  const real = await realpathNative(wanted);
  if (root && real !== root) stopAll();
  root = real;
  realRoot = real;
  await saveState();
  return info();
}

async function close() {
  await ready();
  stopAll();
  root = null;
  realRoot = null;
  await saveState();
  return { root: null };
}

async function list(rel) {
  await ready();
  const abs = resolveInside(rel);
  const real = await assertRealInside(abs, 'read');
  const entries = await fsp.readdir(real, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    if (IGNORED.has(entry.name.toLowerCase())) continue;
    const full = path.join(abs, entry.name);
    let size = 0;
    if (!entry.isDirectory()) {
      const st = await fsp.stat(full).catch(() => null);
      size = st ? st.size : 0;
      if (!st) continue;
    }
    out.push({ path: toRel(full), name: entry.name, dir: entry.isDirectory(), size });
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { path: toRel(abs), entries: out };
}

function looksBinary(buf) {
  const probe = buf.subarray(0, Math.min(buf.length, 8192));
  return probe.includes(0);
}

async function read(rel) {
  await ready();
  const abs = resolveInside(rel);
  const real = await assertRealInside(abs, 'read');
  const st = await fsp.stat(real);
  if (st.isDirectory()) throw new Error('That is a folder, not a file.');
  if (st.size > MAX_READ) throw new Error(`File is ${(st.size / 1024 / 1024).toFixed(1)} MB — the editor opens files up to 2 MB.`);
  const buf = await fsp.readFile(real);
  if (looksBinary(buf)) {
    return { path: toRel(abs), binary: true, size: st.size, content: '', mtime: st.mtimeMs };
  }
  return { path: toRel(abs), binary: false, size: st.size, content: buf.toString('utf8'), mtime: st.mtimeMs };
}

async function write(rel, content) {
  await ready();
  if (typeof content !== 'string') throw new Error('File content must be text.');
  if (content.length > MAX_WRITE) throw new Error('File is larger than the 5 MB write limit.');
  const abs = resolveInside(rel);
  if (abs === requireRoot()) throw new Error('Choose a file name, not the workspace root.');
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const real = await assertRealInside(abs, 'write');
  await fsp.writeFile(real, content, 'utf8');
  const st = await fsp.stat(real);
  return { path: toRel(abs), bytes: st.size, mtime: st.mtimeMs };
}

async function rename(from, to) {
  await ready();
  const src = resolveInside(from);
  const dst = resolveInside(to);
  if (src === requireRoot() || dst === requireRoot()) throw new Error('The workspace root cannot be renamed.');
  await assertRealInside(src, 'read');
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await assertRealInside(dst, 'write');
  await fsp.rename(src, dst);
  return { from: toRel(src), to: toRel(dst) };
}

async function remove(rel) {
  await ready();
  const abs = resolveInside(rel);
  if (abs === requireRoot()) throw new Error('The workspace root cannot be deleted.');
  await assertRealInside(abs, 'write');
  const st = await fsp.lstat(abs);
  if (st.isDirectory()) await fsp.rm(abs, { recursive: true, force: false });
  else await fsp.unlink(abs);
  return { removed: toRel(abs), dir: st.isDirectory() };
}

async function search(query) {
  await ready();
  const needle = String(query || '').trim();
  if (needle.length < 2) throw new Error('Type at least two characters to search.');
  if (needle.length > 200) throw new Error('Search text is too long.');
  const base = requireRoot();
  const lowerNeedle = needle.toLowerCase();
  const matches = [];
  let scanned = 0;
  const queue = [base];
  while (queue.length && scanned < SEARCH_FILE_LIMIT && matches.length < SEARCH_MATCH_LIMIT) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (scanned >= SEARCH_FILE_LIMIT || matches.length >= SEARCH_MATCH_LIMIT) break;
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED.has(entry.name.toLowerCase())) queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const st = await fsp.stat(full).catch(() => null);
      if (!st || st.size > MAX_READ) continue;
      scanned += 1;
      let buf;
      try {
        buf = await fsp.readFile(full);
      } catch {
        continue;
      }
      if (looksBinary(buf)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < SEARCH_MATCH_LIMIT; i += 1) {
        const idx = lines[i].toLowerCase().indexOf(lowerNeedle);
        if (idx === -1) continue;
        matches.push({
          path: toRel(full),
          line: i + 1,
          column: idx + 1,
          text: lines[i].trim().slice(0, 240),
        });
      }
    }
  }
  return {
    query: needle,
    matches,
    scanned,
    limited: matches.length >= SEARCH_MATCH_LIMIT || scanned >= SEARCH_FILE_LIMIT,
  };
}

/* ------------------------------- git ------------------------------- */

function runGit(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd || requireRoot(),
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('Git did not answer within 20 seconds.'));
    }, 20000);
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
      if (stdout.length > 8 * 1024 * 1024) stdout = stdout.slice(0, 8 * 1024 * 1024);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(err.code === 'ENOENT' ? 'Git is not installed or not on PATH.' : err.message));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = (stderr || stdout).trim().split('\n').slice(0, 6).join('\n');
        reject(new Error(detail || `git exited with code ${code}.`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function gitText(args, opts = {}) {
  const { stdout } = await runGit(args, opts);
  return stdout.trim();
}

function parseStatus(out) {
  const parts = out.split('\0');
  const header = parts.shift() || '';
  let branch = null;
  let ahead = 0;
  let behind = 0;
  if (header.startsWith('## ')) {
    const text = header.slice(3);
    if (text.startsWith('No commits yet on ')) branch = text.slice('No commits yet on '.length);
    else if (text.startsWith('Initial commit on ')) branch = text.slice('Initial commit on '.length);
    else {
      const [name] = text.split('...');
      branch = name.trim();
    }
    const aheadMatch = text.match(/ahead (\d+)/);
    const behindMatch = text.match(/behind (\d+)/);
    if (aheadMatch) ahead = Number(aheadMatch[1]);
    if (behindMatch) behind = Number(behindMatch[1]);
  }
  const entries = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const index = entry[0];
    const worktree = entry[1];
    let file = entry.slice(3);
    let from = null;
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
      from = parts[i + 1] || null;
      i += 1;
    }
    if (!file) continue;
    const untracked = index === '?' || worktree === '?';
    entries.push({
      path: file,
      from,
      index,
      worktree,
      untracked,
      staged: !untracked && index !== ' ',
      unstaged: untracked || worktree !== ' ',
    });
  }
  return { branch, ahead, behind, entries };
}

async function gitStatus() {
  await ready();
  requireRoot();
  if (!fs.existsSync(path.join(root, '.git'))) {
    return { git: false, branch: null, ahead: 0, behind: 0, entries: [] };
  }
  const { stdout } = await runGit(['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']);
  return { git: true, ...parseStatus(stdout) };
}

async function gitDiff(opts = {}) {
  await ready();
  requireRoot();
  const args = ['diff', '--no-color', '--no-ext-diff'];
  if (opts.staged) args.push('--cached');
  if (opts.path) {
    resolveInside(opts.path);
    args.push('--', String(opts.path));
  }
  const { stdout } = await runGit(args);
  const truncated = stdout.length > MAX_DIFF;
  return { diff: truncated ? `${stdout.slice(0, MAX_DIFF)}\n… diff truncated at 200 KB` : stdout, truncated, staged: !!opts.staged };
}

function pathList(paths) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('Pick at least one file.');
  if (paths.length > 200) throw new Error('Stage at most 200 files at once.');
  return paths.map((p) => {
    resolveInside(p);
    return String(p);
  });
}

async function gitStage(paths) {
  await ready();
  const listPaths = pathList(paths);
  await runGit(['add', '--', ...listPaths]);
  return { staged: listPaths };
}

async function gitUnstage(paths) {
  await ready();
  const listPaths = pathList(paths);
  try {
    await runGit(['reset', '-q', 'HEAD', '--', ...listPaths]);
  } catch (err) {
    // Unborn branch: there is no HEAD to reset to, so drop the index entries.
    try {
      await runGit(['rm', '--cached', '-r', '-q', '--', ...listPaths]);
    } catch {
      throw err;
    }
  }
  return { unstaged: listPaths };
}

async function gitCommit(message) {
  await ready();
  const text = String(message || '').trim();
  if (!text) throw new Error('Write a commit message first.');
  if (text.length > 5000) throw new Error('Commit message is too long (5,000 chars max).');
  const { stdout, stderr } = await runGit(['commit', '-m', text]);
  const hash = await gitText(['rev-parse', '--short', 'HEAD']).catch(() => '');
  return { hash, output: (stdout + stderr).trim() };
}

async function gitLog(limit) {
  await ready();
  requireRoot();
  if (!fs.existsSync(path.join(root, '.git'))) return { entries: [] };
  const n = Math.min(Math.max(Number(limit) || 10, 1), MAX_LOG);
  const format = '%h%x1f%an%x1f%ad%x1f%s';
  const out = await gitText(['log', `-${n}`, '--date=short', `--pretty=format:${format}`]).catch((err) => {
    if (/does not have any commits|unknown revision|ambiguous argument/i.test(err.message)) return '';
    throw err;
  });
  const entries = out
    ? out.split('\n').filter(Boolean).map((line) => {
        const [hash, author, date, subject] = line.split('\x1f');
        return { hash, author, date, subject };
      })
    : [];
  return { entries };
}

async function gitInit() {
  await ready();
  requireRoot();
  if (fs.existsSync(path.join(root, '.git'))) return { created: false };
  await runGit(['init']);
  return { created: true };
}

/* ---------------------------- commands ---------------------------- */

function describeRun(kind, command) {
  return { kind, command };
}

function startRun(kind, command, opts = {}) {
  if (!root) throw new Error('No folder is open. Pick a workspace first.');
  if (runs.size >= MAX_RUNS) throw new Error(`At most ${MAX_RUNS} commands can run at once — stop one first.`);
  const runId = `run_${crypto.randomUUID()}`;
  const child = spawn(command.argv, command.args, {
    cwd: opts.cwd || root,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    shell: !!command.shell,
    windowsHide: true,
    windowsVerbatimArguments: !!command.verbatim,
  });
  const started = Date.now();
  const meta = describeRun(kind, opts.label || command.label || '');
  runs.set(runId, { child, kind, started, bytes: 0 });

  emit({ runId, type: 'start', ...meta, cwd: opts.cwd || root });

  const push = (stream, data) => {
    const text = data.toString('utf8');
    const run = runs.get(runId);
    if (run) run.bytes += text.length;
    for (let i = 0; i < text.length; i += CHUNK) {
      emit({ runId, type: 'data', stream, chunk: text.slice(i, i + CHUNK) });
    }
  };
  child.stdout.on('data', (d) => push('stdout', d));
  child.stderr.on('data', (d) => push('stderr', d));
  child.on('error', (err) => {
    emit({ runId, type: 'data', stream: 'stderr', chunk: err.message + '\n' });
    emit({ runId, type: 'exit', code: null, signal: null, ms: Date.now() - started });
    runs.delete(runId);
  });
  const limit = setTimeout(() => {
    if (!runs.has(runId)) return;
    push('stderr', `\nORVEX stopped this command after ${MAX_RUNTIME_MS / 60000} minutes.\n`);
    killRun(runId);
  }, MAX_RUNTIME_MS);
  if (limit.unref) limit.unref();
  child.on('close', (code, signal) => {
    clearTimeout(limit);
    if (!runs.has(runId)) return;
    runs.delete(runId);
    emit({ runId, type: 'exit', code, signal, ms: Date.now() - started });
  });
  return { runId, ...meta, cwd: opts.cwd || root };
}

function killRun(runId) {
  const run = runs.get(runId);
  if (!run) return false;
  runs.delete(runId);
  try {
    if (process.platform === 'win32' && run.child.pid) {
      spawn('taskkill', ['/pid', String(run.child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      run.child.kill('SIGTERM');
    }
  } catch {
    /* already gone */
  }
  try {
    emit({ runId, type: 'exit', code: null, signal: 'SIGTERM', ms: Date.now() - run.started, stopped: true });
  } catch {
    /* window is gone */
  }
  return true;
}

function stop(runId) {
  if (!runId) throw new Error('runId is required.');
  return { stopped: killRun(String(runId)) };
}

function stopAll() {
  for (const runId of [...runs.keys()]) killRun(runId);
}

async function runScript(name) {
  await ready();
  requireRoot();
  const wanted = String(name || '');
  const scripts = await readScripts();
  const hit = scripts.find((s) => s.name === wanted);
  if (!hit) throw new Error(`"${wanted}" is not a script in this package.json.`);
  if (!/^[A-Za-z0-9:._@ -]{1,120}$/.test(wanted)) throw new Error('That script name is not supported.');
  return startRun('script', {
    argv: `npm run ${hit.name} --silent`,
    args: [],
    shell: true,
    label: `npm run ${hit.name}`,
  });
}

async function terminal(command, cwd) {
  await ready();
  const base = requireRoot();
  const text = String(command || '').trim();
  if (!text) throw new Error('Type a command first.');
  const blocked = checkCommand(text);
  if (blocked) throw new Error(blocked);
  let workdir = base;
  if (cwd) {
    workdir = resolveInside(cwd);
    await assertRealInside(workdir, 'read');
    const st = await fsp.stat(workdir);
    if (!st.isDirectory()) throw new Error('The terminal cwd must be a folder inside the workspace.');
  }
  const shellCmd = process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh';
  const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', text] : ['-c', text];
  return startRun(
    'terminal',
    { argv: shellCmd, args: shellArgs, shell: false, verbatim: process.platform === 'win32', label: text },
    { cwd: workdir, label: text },
  );
}

function dispose() {
  stopAll();
}

module.exports = {
  init,
  info,
  open,
  close,
  list,
  read,
  write,
  rename,
  remove,
  search,
  gitStatus,
  gitDiff,
  gitStage,
  gitUnstage,
  gitCommit,
  gitLog,
  gitInit,
  runScript,
  terminal,
  stop,
  dispose,
};
