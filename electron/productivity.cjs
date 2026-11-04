'use strict';

/**
 * Section 17 — Productivity.
 *
 * Real workbench backed by this machine: a parser-based calculator (no eval),
 * a Python runner that uses the installed interpreter, CSV/XLSX analysis and
 * charts, an XLSX editor, a SQL console over a private scratch database, report
 * export to Markdown/HTML/DOCX, meeting transcription + model summarisation,
 * notes stored in the shared memory store so the agent and RAG can see them,
 * a persistent task list, model-backed translation, a text workspace, PPTX
 * generation with pptxgenjs and a document comparison built on real extraction.
 *
 * Everything fails loudly when the machine or a configured model is missing —
 * no simulated output is ever produced.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const XLSX = require('xlsx');
const diffLib = require('diff');
const Database = require('better-sqlite3');
const { checkPath } = require('./guardrails.cjs');

const MAX_ROWS = 20000;
const MAX_PREVIEW_ROWS = 1000;
const MAX_TEXT_FILE = 2 * 1024 * 1024;
const MAX_OUTPUT = 200000;
const MAX_SQL_ROWS = 2000;

const state = {
  dataDir: null,
  dirs: null,
  db: null,
  ownDb: false,
  dbFile: null,
  gateway: null,
  memory: null,
  creative: null,
  documents: null,
  files: null,
  scratch: null,
  pyInfo: null,
  pyPromise: null,
};

/* ------------------------------------------------------------- lifecycle */

function init(opts = {}) {
  state.dataDir = opts.dataDir || path.join(os.homedir(), '.orvex');
  state.dirs = {
    root: path.join(state.dataDir, 'productivity'),
    reports: path.join(state.dataDir, 'productivity', 'reports'),
    slides: path.join(state.dataDir, 'productivity', 'slides'),
    sheets: path.join(state.dataDir, 'productivity', 'sheets'),
    texts: path.join(state.dataDir, 'productivity', 'texts'),
    meetings: path.join(state.dataDir, 'productivity', 'meetings'),
    tmp: path.join(state.dataDir, 'productivity', 'tmp'),
  };
  for (const dir of Object.values(state.dirs)) fs.mkdirSync(dir, { recursive: true });
  state.gateway = opts.gateway || null;
  state.memory = opts.memory || null;
  state.creative = opts.creative || null;
  state.documents = opts.documents || null;
  state.files = opts.files || null;
  state.dbFile = opts.dbFile || null;
  if (opts.db) {
    state.db = opts.db;
    state.ownDb = false;
  } else if (opts.dbFile) {
    state.db = new Database(opts.dbFile);
    state.ownDb = true;
  }
  if (state.db) {
    state.db.exec(`
      CREATE TABLE IF NOT EXISTS productivity_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        priority INTEGER NOT NULL DEFAULT 2,
        due_at INTEGER,
        project TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS productivity_tasks_status ON productivity_tasks(status, due_at, priority);
    `);
  }
}

function close() {
  if (state.ownDb && state.db) {
    try {
      state.db.close();
    } catch {
      /* already closed */
    }
  }
  state.db = null;
  if (state.scratch) {
    try {
      state.scratch.close();
    } catch {
      /* already closed */
    }
  }
  state.scratch = null;
}

function requireReady() {
  if (!state.dirs) throw new Error('Productivity is not initialised yet.');
  return state;
}

function requireDb() {
  requireReady();
  if (!state.db) throw new Error('The task database is not available in this session.');
  return state.db;
}

function requireModel() {
  requireReady();
  if (!state.gateway) throw new Error('The model gateway is not available in this session.');
  return state.gateway;
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function slug(text, fallback = 'orvex') {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || fallback;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function guardedPath(raw, label = 'Path', mode = 'read') {
  const text = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (!text) throw new Error(`${label} is empty.`);
  let resolved;
  try {
    resolved = path.resolve(text);
  } catch {
    throw new Error(`${label} could not be resolved.`);
  }
  const blocked = checkPath(resolved, mode);
  if (blocked) throw new Error(blocked);
  return resolved;
}

function safeWorkspaceName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) throw new Error('File name is empty.');
  if (/[\\/]/.test(name) || name === '.' || name === '..' || name.includes('\0')) {
    throw new Error('Use a plain file name without folders.');
  }
  const clean = name.replace(/[<>:"|?*]/g, '').slice(0, 80);
  if (!clean) throw new Error('That file name has no usable characters.');
  return clean;
}

async function fileStat(file) {
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new Error('That path is not a file.');
  return st;
}

/* --------------------------------------------------------- calculator */

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

const FUNCTIONS = {
  sqrt: (x) => {
    if (x < 0) throw new Error('sqrt() needs a value of zero or more.');
    return Math.sqrt(x);
  },
  cbrt: Math.cbrt,
  abs: Math.abs,
  round: (x, digits) => {
    if (digits === undefined) return Math.round(x);
    const f = 10 ** Math.floor(digits);
    return Math.round(x * f) / f;
  },
  floor: Math.floor,
  ceil: Math.ceil,
  trunc: Math.trunc,
  sign: Math.sign,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  log: Math.log10,
  log2: Math.log2,
  ln: Math.log,
  exp: Math.exp,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  hypot: Math.hypot,
  deg2rad: (x) => (x * Math.PI) / 180,
  rad2deg: (x) => (x * 180) / Math.PI,
};

const ARITY = {
  round: [1, 2],
  min: [1, Infinity],
  max: [1, Infinity],
  pow: [2, 2],
  hypot: [1, Infinity],
};

function tokenize(expression) {
  const tokens = [];
  const text = String(expression);
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      let dots = 0;
      while (j < text.length && /[0-9.]/.test(text[j])) {
        if (text[j] === '.' && ++dots > 1) throw new Error(`Bad number at character ${j + 1}.`);
        j += 1;
      }
      if (text[j] && /[eE]/.test(text[j]) && /[0-9+-]/.test(text[j + 1] || '')) {
        j += 1;
        if (/[+-]/.test(text[j])) j += 1;
        while (j < text.length && /[0-9]/.test(text[j])) j += 1;
      }
      const raw = text.slice(i, j);
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`"${raw}" is not a number.`);
      tokens.push({ type: 'number', value, at: i });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[a-zA-Z0-9_]/.test(text[j])) j += 1;
      tokens.push({ type: 'name', value: text.slice(i, j), at: i });
      i = j;
      continue;
    }
    if ('+-*/%^(),!'.includes(ch)) {
      tokens.push({ type: 'op', value: ch, at: i });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected character "${ch}" at position ${i + 1}.`);
  }
  tokens.push({ type: 'end', at: text.length });
  return tokens;
}

function parseExpression(expression) {
  const tokens = tokenize(expression);
  let pos = 0;
  let depth = 0;

  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  const expect = (value) => {
    const token = take();
    if (token.type !== 'op' || token.value !== value) {
      throw new Error(`Expected "${value}" at position ${token.at + 1}.`);
    }
  };

  function primary() {
    depth += 1;
    if (depth > 120) throw new Error('Expression is nested too deeply.');
    const token = peek();
    let value;
    if (token.type === 'number') {
      take();
      value = token.value;
    } else if (token.type === 'name') {
      take();
      const name = token.value.toLowerCase();
      if (peek().type === 'op' && peek().value === '(') {
        const fn = FUNCTIONS[name];
        if (!fn) throw new Error(`Unknown function "${token.value}".`);
        expect('(');
        const args = [];
        if (!(peek().type === 'op' && peek().value === ')')) {
          args.push(expression_());
          while (peek().type === 'op' && peek().value === ',') {
            take();
            args.push(expression_());
          }
        }
        expect(')');
        const range = ARITY[name] || [1, 1];
        if (args.length < range[0] || args.length > range[1]) {
          throw new Error(`${token.value}() takes ${range[0] === range[1] ? range[0] : `${range[0]}–${range[1]}`} value(s).`);
        }
        value = fn(...args);
        if (typeof value !== 'number') throw new Error(`${token.value}() did not return a number.`);
      } else {
        if (!(name in CONSTANTS)) throw new Error(`Unknown name "${token.value}".`);
        value = CONSTANTS[name];
      }
    } else if (token.type === 'op' && token.value === '(') {
      take();
      value = expression_();
      expect(')');
    } else {
      throw new Error(`Unexpected "${token.type === 'end' ? 'end of input' : token.value}" at position ${token.at + 1}.`);
    }
    while (peek().type === 'op' && peek().value === '!') {
      take();
      if (!Number.isInteger(value) || value < 0 || value > 170) {
        throw new Error('Factorial needs a whole number from 0 to 170.');
      }
      let acc = 1;
      for (let n = 2; n <= value; n += 1) acc *= n;
      value = acc;
    }
    depth -= 1;
    return value;
  }

  function unary() {
    const token = peek();
    if (token.type === 'op' && (token.value === '+' || token.value === '-')) {
      take();
      const value = unary();
      return token.value === '-' ? -value : value;
    }
    return power();
  }

  function power() {
    const base = primary();
    if (peek().type === 'op' && peek().value === '^') {
      take();
      const exponent = unary();
      return base ** exponent;
    }
    return base;
  }

  function term() {
    let value = unary();
    for (;;) {
      const token = peek();
      if (token.type !== 'op' || !'*/%'.includes(token.value)) return value;
      take();
      const right = unary();
      if (token.value === '*') value *= right;
      else if (token.value === '/') {
        if (right === 0) throw new Error('Division by zero.');
        value /= right;
      } else {
        if (right === 0) throw new Error('Modulo by zero.');
        value %= right;
      }
    }
  }

  function expression_() {
    let value = term();
    for (;;) {
      const token = peek();
      if (token.type !== 'op' || (token.value !== '+' && token.value !== '-')) return value;
      take();
      const right = term();
      value = token.value === '+' ? value + right : value - right;
    }
  }

  const result = expression_();
  if (peek().type !== 'end') throw new Error(`Unexpected "${peek().value}" at position ${peek().at + 1}.`);
  if (!Number.isFinite(result)) throw new Error('The result is not a finite number.');
  return result;
}

function formatNumber(value) {
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return String(value);
  const rounded = Number(value.toPrecision(12));
  if (Math.abs(rounded) >= 1e21 || (Math.abs(rounded) < 1e-7 && rounded !== 0)) return rounded.toExponential(6);
  return String(rounded);
}

function calc(payload = {}) {
  const expression = String(payload.expression ?? '').trim();
  if (!expression) throw new Error('Type a calculation first.');
  if (expression.length > 2000) throw new Error('Keep the expression under 2000 characters.');
  const value = parseExpression(expression);
  return { expression, value, display: formatNumber(value) };
}

/* ------------------------------------------------------------- python */

const PYTHON_CANDIDATES = [
  process.env.ORVEX_PYTHON ? { command: process.env.ORVEX_PYTHON, prefix: [] } : null,
  { command: 'python', prefix: [] },
  { command: 'python3', prefix: [] },
  { command: 'py', prefix: ['-3'] },
].filter(Boolean);

function spawnCapture(command, args, { timeoutMs = 5000, env = {} } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err && err.message ? err.message : err), spawnError: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      if (process.platform === 'win32' && child.pid) {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } catch {
          /* best effort */
        }
      }
    }, timeoutMs);
    child.stdout.on('data', (b) => {
      if (stdout.length < MAX_OUTPUT) stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b) => {
      if (stderr.length < MAX_OUTPUT) stderr += b.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(err.message), spawnError: true });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

async function detectPython(force = false) {
  requireReady();
  if (state.pyInfo && !force) return state.pyInfo;
  if (state.pyPromise) return state.pyPromise;
  state.pyPromise = (async () => {
    for (const candidate of PYTHON_CANDIDATES) {
      const out = await spawnCapture(candidate.command, [...candidate.prefix, '--version'], { timeoutMs: 6000 });
      const text = `${out.stdout} ${out.stderr}`.trim();
      if (out.code === 0 && /python\s+\d/i.test(text)) {
        const version = text.split('\n')[0].trim();
        return { available: true, command: candidate.command, prefix: candidate.prefix, version };
      }
    }
    return {
      available: false,
      error: 'Python was not found on PATH. Install Python 3 and make sure "python" or "py" runs in a terminal.',
    };
  })();
  try {
    state.pyInfo = await state.pyPromise;
  } finally {
    state.pyPromise = null;
  }
  return state.pyInfo;
}

async function pythonInfo() {
  return detectPython();
}

async function runPython(payload = {}) {
  requireReady();
  const code = String(payload.code ?? '');
  if (!code.trim()) throw new Error('Write some Python first.');
  if (code.length > 100000) throw new Error('Keep the script under 100,000 characters.');
  const timeoutMs = clamp(Number(payload.timeoutMs) || 30000, 1000, 120000);
  const info = await detectPython();
  if (!info.available) throw new Error(info.error);
  const file = path.join(state.dirs.tmp, `py-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.py`);
  await fsp.writeFile(file, code, 'utf8');
  const started = Date.now();
  const run = await spawnCapture(info.command, [...info.prefix, file], {
    timeoutMs,
    env: { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
  });
  await fsp.unlink(file).catch(() => {});
  return {
    command: `${info.command} ${info.prefix.join(' ')}`.trim(),
    version: info.version,
    exitCode: run.code,
    signal: run.signal || null,
    timedOut: !!run.timedOut,
    ms: Date.now() - started,
    stdout: run.stdout,
    stderr: run.stderr,
    truncated: run.stdout.length >= MAX_OUTPUT || run.stderr.length >= MAX_OUTPUT,
  };
}

/* ------------------------------------------------------------ data files */

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/,/g, '');
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) return Number(text);
  if (/^-?\d+(\.\d+)?%$/.test(text)) return Number(text.slice(0, -1));
  return null;
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return String(value);
  return String(value);
}

function isDateLike(value) {
  if (value instanceof Date) return true;
  if (typeof value !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/.test(value.trim());
}

function serializeCell(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return value;
}

function loadTable(file, sheet) {
  const wb = XLSX.readFile(file, { cellDates: true });
  const names = wb.SheetNames;
  if (!names.length) throw new Error('That workbook has no sheets.');
  const sheetName = sheet && names.includes(sheet) ? sheet : names[0];
  const ws = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: false });
  if (!matrix.length) return { names, sheetName, headers: [], rows: [], totalRows: 0, truncated: false };
  const headerRow = matrix[0];
  const width = headerRow.reduce((max, value, index) => (cellText(value).trim() ? Math.max(max, index + 1) : max), 0);
  const headers = [];
  for (let i = 0; i < Math.max(width, 1); i += 1) {
    const label = cellText(headerRow[i]).trim();
    headers.push(label || `Column ${i + 1}`);
  }
  const body = matrix.slice(1).filter((row) => row.some((cell) => cellText(cell).trim() !== ''));
  const rows = body.slice(0, MAX_ROWS);
  return {
    names,
    sheetName,
    headers,
    rows,
    totalRows: body.length,
    truncated: body.length > MAX_ROWS,
  };
}

function columnIndex(headers, name) {
  const index = headers.findIndex((h) => h.toLowerCase() === String(name || '').toLowerCase());
  if (index < 0) throw new Error(`There is no column named "${name}".`);
  return index;
}

function columnStats(headers, rows) {
  return headers.map((name, index) => {
    const values = rows.map((row) => row[index]);
    const nonEmpty = values.filter((v) => cellText(v).trim() !== '');
    const numbers = [];
    let dateCount = 0;
    for (const value of nonEmpty) {
      const n = typeof value === 'number' ? value : asNumber(value);
      if (n !== null && !(typeof value === 'string' && isDateLike(value))) numbers.push(n);
      else if (isDateLike(value)) dateCount += 1;
    }
    const numeric = nonEmpty.length > 0 && numbers.length / nonEmpty.length >= 0.8;
    const counts = new Map();
    for (const value of nonEmpty) {
      const key = cellText(value);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([value, count]) => ({ value, count }));
    const stats = {
      name,
      index,
      type: numeric ? 'number' : dateCount && dateCount / nonEmpty.length >= 0.8 ? 'date' : nonEmpty.length ? 'text' : 'empty',
      nonEmpty: nonEmpty.length,
      missing: values.length - nonEmpty.length,
      unique: counts.size,
      top,
    };
    if (numeric && numbers.length) {
      const sorted = [...numbers].sort((a, b) => a - b);
      const sum = numbers.reduce((a, b) => a + b, 0);
      const mean = sum / numbers.length;
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      const variance = numbers.reduce((acc, n) => acc + (n - mean) ** 2, 0) / numbers.length;
      stats.min = sorted[0];
      stats.max = sorted[sorted.length - 1];
      stats.sum = sum;
      stats.mean = mean;
      stats.median = median;
      stats.stddev = Math.sqrt(variance);
    }
    return stats;
  });
}

async function dataAnalyze(payload = {}) {
  requireReady();
  const file = guardedPath(payload.path, 'Data file');
  const st = await fileStat(file);
  const table = loadTable(file, payload.sheet);
  return {
    path: file,
    bytes: st.size,
    sheets: table.names,
    sheet: table.sheetName,
    rows: table.rows.length,
    totalRows: table.totalRows,
    truncated: table.truncated,
    columns: columnStats(table.headers, table.rows),
    sample: table.rows.slice(0, 20).map((row) => table.headers.map((_h, i) => serializeCell(row[i]))),
    headers: table.headers,
  };
}

async function dataChart(payload = {}) {
  requireReady();
  const file = guardedPath(payload.path, 'Data file');
  await fileStat(file);
  const table = loadTable(file, payload.sheet);
  const kind = ['bar', 'line', 'pie', 'scatter'].includes(payload.kind) ? payload.kind : 'bar';
  const yIndex = columnIndex(table.headers, payload.y);
  const xIndex = payload.x ? columnIndex(table.headers, payload.x) : null;
  const agg = ['sum', 'avg', 'count', 'min', 'max'].includes(payload.agg) ? payload.agg : 'sum';
  const limit = clamp(Number(payload.limit) || 40, 1, 200);
  if (kind === 'scatter') {
    const points = [];
    for (const row of table.rows) {
      const x = xIndex === null ? null : asNumber(row[xIndex]);
      const y = asNumber(row[yIndex]);
      if (x === null || y === null) continue;
      points.push({ x, y, label: cellText(row[xIndex]) });
      if (points.length >= limit) break;
    }
    if (!points.length) throw new Error('No numeric pairs were found in those columns.');
    return { path: file, sheet: table.sheetName, kind, x: table.headers[xIndex], y: table.headers[yIndex], points, truncated: points.length >= limit };
  }
  const groups = new Map();
  for (const row of table.rows) {
    const y = asNumber(row[yIndex]);
    if (y === null) continue;
    const label = xIndex === null ? String(groups.size + 1) : cellText(row[xIndex]).trim() || '(blank)';
    const bucket = groups.get(label) || { count: 0, sum: 0, min: Infinity, max: -Infinity };
    bucket.count += 1;
    bucket.sum += y;
    bucket.min = Math.min(bucket.min, y);
    bucket.max = Math.max(bucket.max, y);
    groups.set(label, bucket);
  }
  if (!groups.size) throw new Error('No numeric values were found in that column.');
  const all = [...groups.entries()].map(([label, b]) => {
    let value;
    if (agg === 'count') value = b.count;
    else if (agg === 'avg') value = b.sum / b.count;
    else if (agg === 'min') value = b.min;
    else if (agg === 'max') value = b.max;
    else value = b.sum;
    return { label, value, count: b.count };
  });
  return {
    path: file,
    sheet: table.sheetName,
    kind,
    x: xIndex === null ? '(row)' : table.headers[xIndex],
    y: table.headers[yIndex],
    agg,
    points: all.slice(0, limit),
    groups: all.length,
    truncated: all.length > limit,
  };
}

/* ------------------------------------------------------------ spreadsheet */

async function sheetOpen(payload = {}) {
  requireReady();
  const file = guardedPath(payload.path, 'Workbook');
  const st = await fileStat(file);
  const table = loadTable(file, payload.sheet);
  const limit = clamp(Number(payload.limit) || MAX_PREVIEW_ROWS, 1, MAX_PREVIEW_ROWS);
  return {
    path: file,
    bytes: st.size,
    sheets: table.names,
    sheet: table.sheetName,
    headers: table.headers,
    rows: table.rows.slice(0, limit).map((row) => table.headers.map((_h, i) => serializeCell(row[i]))),
    totalRows: table.totalRows,
    truncated: table.truncated || table.rows.length > limit,
  };
}

function coerceCell(value) {
  if (typeof value === 'number') return value;
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (text.trim() === '') return '';
  const n = asNumber(text);
  return n === null ? text : n;
}

function validateSheetName(raw) {
  const name = String(raw || 'Sheet1').trim() || 'Sheet1';
  if (name.length > 31) throw new Error('Excel sheet names are limited to 31 characters.');
  if (/[\\/?*[\]:]/.test(name)) throw new Error('Sheet names cannot contain \\ / ? * [ ] :');
  return name;
}

async function sheetSave(payload = {}) {
  requireReady();
  const file = guardedPath(payload.path || path.join(state.dirs.sheets, `sheet-${stamp()}.xlsx`), 'Workbook', 'write');
  const sheet = validateSheetName(payload.sheet);
  const headers = Array.isArray(payload.headers) ? payload.headers.map((h) => String(h ?? '')) : [];
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!headers.length) throw new Error('The sheet needs at least one column.');
  if (rows.length > MAX_ROWS) throw new Error(`Keep the sheet under ${MAX_ROWS} rows.`);
  const aoa = [headers, ...rows.map((row) => headers.map((_h, i) => coerceCell(Array.isArray(row) ? row[i] : '')))];
  let wb;
  if (fs.existsSync(file)) {
    wb = XLSX.readFile(file);
  } else {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    wb = XLSX.utils.book_new();
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = headers.map((h) => ({ wch: clamp(String(h).length + 4, 10, 32) }));
  if (wb.SheetNames.includes(sheet)) wb.Sheets[sheet] = ws;
  else XLSX.utils.book_append_sheet(wb, ws, sheet);
  XLSX.writeFile(wb, file);
  const st = await fsp.stat(file);
  return { path: file, sheet, bytes: st.size, rows: rows.length, columns: headers.length, sheets: wb.SheetNames };
}

async function sheetCreate(payload = {}) {
  requireReady();
  const file = guardedPath(payload.path || path.join(state.dirs.sheets, `sheet-${stamp()}.xlsx`), 'Workbook', 'write');
  const sheets = Array.isArray(payload.sheets) && payload.sheets.length ? payload.sheets : [{ name: 'Sheet1', headers: ['Column 1'], rows: [] }];
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const name = validateSheetName(sheet.name);
    const headers = Array.isArray(sheet.headers) && sheet.headers.length ? sheet.headers.map((h) => String(h ?? '')) : ['Column 1'];
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows.map((row) => headers.map((_h, i) => coerceCell(Array.isArray(row) ? row[i] : '')))]);
    ws['!cols'] = headers.map((h) => ({ wch: clamp(String(h).length + 4, 10, 32) }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  XLSX.writeFile(wb, file);
  const st = await fsp.stat(file);
  return { path: file, bytes: st.size, sheets: wb.SheetNames };
}

/* ------------------------------------------------------------------ sql */

function scratch() {
  requireReady();
  if (!state.scratch) {
    const file = path.join(state.dirs.root, 'scratch.db');
    state.scratch = new Database(file);
    state.scratch.pragma('journal_mode = WAL');
  }
  return state.scratch;
}

function sqlRun(payload = {}) {
  requireReady();
  const sql = String(payload.sql ?? '').trim();
  if (!sql) throw new Error('Write a SQL statement first.');
  if (sql.length > 100000) throw new Error('Keep the statement under 100,000 characters.');
  if (/\b(attach|detach)\b/i.test(sql)) throw new Error('ATTACH and DETACH are blocked — this console works only on its own scratch database.');
  const db = scratch();
  const started = Date.now();
  const stmt = db.prepare(sql);
  if (stmt.reader) {
    const limit = clamp(Number(payload.limit) || 500, 1, MAX_SQL_ROWS);
    const rows = stmt.all();
    const columns = stmt.columns().map((c) => c.name);
    return {
      kind: 'read',
      columns,
      rows: rows.slice(0, limit).map((row) => columns.map((c) => (row[c] instanceof Buffer ? `<${row[c].length} bytes>` : row[c]))),
      returned: rows.length,
      truncated: rows.length > limit,
      ms: Date.now() - started,
    };
  }
  const info = stmt.run();
  return {
    kind: 'write',
    columns: [],
    rows: [],
    changes: info.changes,
    lastInsertRowid: typeof info.lastInsertRowid === 'bigint' ? Number(info.lastInsertRowid) : info.lastInsertRowid,
    ms: Date.now() - started,
  };
}

function sqlTables() {
  const db = scratch();
  const rows = db
    .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  return {
    tables: rows.map((row) => {
      let count = null;
      try {
        count = db.prepare(`SELECT COUNT(*) AS c FROM "${String(row.name).replace(/"/g, '""')}"`).get().c;
      } catch {
        count = null;
      }
      return { name: row.name, type: row.type, rows: count };
    }),
    path: path.join(state.dirs.root, 'scratch.db'),
  };
}

function sqlSchema(payload = {}) {
  const db = scratch();
  const row = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(String(payload.table || ''));
  if (!row) throw new Error('That table does not exist in the scratch database.');
  return { table: String(payload.table), sql: row.sql || '' };
}

/* --------------------------------------------------------------- reports */

function escapeMd(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) throw new Error('Add at least one block to the report.');
  return blocks.map((block, index) => {
    const type = String(block && block.type ? block.type : 'text');
    const out = { ...block, type };
    if (['heading', 'text', 'code'].includes(type) && !String(block.text ?? '').trim()) {
      throw new Error(`Block ${index + 1} (${type}) is empty.`);
    }
    if (type === 'list' && !(Array.isArray(block.items) && block.items.length)) {
      throw new Error(`Block ${index + 1} (list) needs items.`);
    }
    if (type === 'table') {
      if (!Array.isArray(block.headers) || !block.headers.length) throw new Error(`Block ${index + 1} (table) needs headers.`);
      if (!Array.isArray(block.rows)) throw new Error(`Block ${index + 1} (table) needs rows.`);
    }
    if (type === 'chart' && !(block.points && Array.isArray(block.points) && block.points.length)) {
      throw new Error(`Block ${index + 1} (chart) needs chart points.`);
    }
    return out;
  });
}

function renderMarkdown(title, blocks) {
  const out = [`# ${title}`, ''];
  for (const block of blocks) {
    if (block.type === 'heading') out.push(`${'#'.repeat(clamp(Number(block.level) || 2, 2, 4))} ${block.text}`, '');
    else if (block.type === 'text') out.push(String(block.text), '');
    else if (block.type === 'list') out.push(...block.items.map((item) => `- ${String(item)}`), '');
    else if (block.type === 'kv') out.push(...(block.items || []).map((it) => `- **${it.label}:** ${it.value}`), '');
    else if (block.type === 'divider') out.push('---', '');
    else if (block.type === 'code') out.push('```', String(block.text), '```', '');
    else if (block.type === 'table') {
      out.push(`| ${block.headers.map(escapeMd).join(' | ')} |`);
      out.push(`| ${block.headers.map(() => '---').join(' | ')} |`);
      for (const row of block.rows) out.push(`| ${block.headers.map((_h, i) => escapeMd(row[i])).join(' | ')} |`);
      out.push('');
    } else if (block.type === 'chart') {
      out.push(`**Chart:** ${block.kind || 'bar'} — ${block.y || 'value'}${block.x ? ` by ${block.x}` : ''}`, '');
      out.push('| Label | Value |', '| --- | --- |');
      for (const point of block.points) out.push(`| ${escapeMd(point.label)} | ${escapeMd(point.value)} |`);
      out.push('');
    }
  }
  return out.join('\n');
}

function chartHtml(block) {
  const points = Array.isArray(block.points) ? block.points : [];
  const max = Math.max(1, ...points.map((p) => Math.abs(Number(p.value) || 0)));
  return `<div class="chart">${points
    .map((p) => {
      const pct = Math.round((Math.abs(Number(p.value) || 0) / max) * 100);
      return `<div class="bar"><span class="lbl">${escapeHtml(p.label)}</span><span class="track"><span style="width:${pct}%"></span></span><span class="val">${escapeHtml(p.value)}</span></div>`;
    })
    .join('')}</div>`;
}

function renderHtml(title, blocks) {
  const body = blocks
    .map((block) => {
      if (block.type === 'heading') return `<h${clamp(Number(block.level) || 2, 2, 4)}>${escapeHtml(block.text)}</h${clamp(Number(block.level) || 2, 2, 4)}>`;
      if (block.type === 'text') return `<p>${escapeHtml(block.text).replace(/\r?\n/g, '<br>')}</p>`;
      if (block.type === 'list') return `<ul>${block.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
      if (block.type === 'kv') return `<ul>${(block.items || []).map((i) => `<li><b>${escapeHtml(i.label)}:</b> ${escapeHtml(i.value)}</li>`).join('')}</ul>`;
      if (block.type === 'divider') return '<hr>';
      if (block.type === 'code') return `<pre>${escapeHtml(block.text)}</pre>`;
      if (block.type === 'table') {
        return `<table><thead><tr>${block.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${block.rows
          .map((row) => `<tr>${block.headers.map((_h, i) => `<td>${escapeHtml(row[i])}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`;
      }
      if (block.type === 'chart') return `<h3>${escapeHtml(block.kind || 'bar')} — ${escapeHtml(block.y || 'value')}</h3>${chartHtml(block)}`;
      return '';
    })
    .join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body{margin:40px auto;max-width:860px;font:15px/1.55 "Segoe UI",system-ui,sans-serif;color:#111827;background:#fff;padding:0 20px}
h1,h2,h3,h4{line-height:1.25;color:#0f172a}h1{border-bottom:1px solid #e5e7eb;padding-bottom:12px}
table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #d1d5db;padding:6px 9px;text-align:left}
th{background:#f3f4f6}pre{background:#0f172a;color:#e5e7eb;padding:14px;border-radius:8px;overflow:auto}
.chart{display:flex;flex-direction:column;gap:7px;margin:14px 0}.bar{display:grid;grid-template-columns:160px 1fr 80px;gap:10px;align-items:center;font-size:13px}
.track{height:10px;background:#e5e7eb;border-radius:99px;overflow:hidden}.track>span{display:block;height:100%;background:#0ea5e9;border-radius:99px}
.lbl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.val{text-align:right;font-variant-numeric:tabular-nums}
</style></head><body><h1>${escapeHtml(title)}</h1>
${body}
<footer style="margin-top:36px;color:#6b7280;font-size:12px">Generated by ORVEX · ${new Date().toISOString()}</footer>
</body></html>`;
}

async function renderDocx(title, blocks) {
  const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, TextRun } = require('docx');
  const children = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
  for (const block of blocks) {
    if (block.type === 'heading') {
      const level = clamp(Number(block.level) || 2, 2, 4);
      children.push(new Paragraph({ text: String(block.text), heading: level === 2 ? HeadingLevel.HEADING_1 : level === 3 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3 }));
    } else if (block.type === 'text') {
      children.push(new Paragraph({ children: [new TextRun(String(block.text))] }));
    } else if (block.type === 'list') {
      for (const item of block.items) children.push(new Paragraph({ text: String(item), bullet: { level: 0 } }));
    } else if (block.type === 'kv') {
      for (const item of block.items || []) {
        children.push(new Paragraph({ children: [new TextRun({ text: `${item.label}: `, bold: true }), new TextRun(String(item.value))] }));
      }
    } else if (block.type === 'divider') {
      children.push(new Paragraph({ text: '────────────────────────────' }));
    } else if (block.type === 'code') {
      for (const line of String(block.text).split(/\r?\n/)) children.push(new Paragraph({ children: [new TextRun({ text: line, font: 'Consolas' })] }));
    } else if (block.type === 'table') {
      const rows = [
        new TableRow({ children: block.headers.map((h) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(h), bold: true })] })] })) }),
        ...block.rows.map((row) => new TableRow({ children: block.headers.map((_h, i) => new TableCell({ children: [new Paragraph(String(row[i] ?? ''))] })) })),
      ];
      children.push(new Table({ rows }));
    } else if (block.type === 'chart') {
      children.push(new Paragraph({ text: `${block.kind || 'bar'} chart — ${block.y || 'value'}${block.x ? ` by ${block.x}` : ''}`, heading: HeadingLevel.HEADING_2 }));
      const rows = [
        new TableRow({ children: [new TableCell({ children: [new Paragraph('Label')] }), new TableCell({ children: [new Paragraph('Value')] })] }),
        ...block.points.map((p) => new TableRow({ children: [new TableCell({ children: [new Paragraph(String(p.label))] }), new TableCell({ children: [new Paragraph(String(p.value))] })] })),
      ];
      children.push(new Table({ rows }));
    }
  }
  const doc = new Document({ creator: 'ORVEX', title, sections: [{ children }] });
  return Packer.toBuffer(doc);
}

async function reportBuild(payload = {}) {
  requireReady();
  const title = String(payload.title ?? '').trim();
  if (!title) throw new Error('Give the report a title.');
  if (title.length > 200) throw new Error('Keep the title under 200 characters.');
  const blocks = normalizeBlocks(payload.blocks);
  const format = ['md', 'html', 'docx'].includes(payload.format) ? payload.format : 'md';
  const dir = state.dirs.reports;
  const file = path.join(dir, `${slug(title)}-${stamp()}.${format}`);
  let preview;
  if (format === 'docx') {
    const buf = await renderDocx(title, blocks);
    await fsp.writeFile(file, buf);
    preview = `DOCX report with ${blocks.length} block(s) and ${buf.length} bytes.`;
  } else if (format === 'html') {
    const html = renderHtml(title, blocks);
    await fsp.writeFile(file, html, 'utf8');
    preview = html.slice(0, 2000);
  } else {
    const md = renderMarkdown(title, blocks);
    await fsp.writeFile(file, md, 'utf8');
    preview = md.slice(0, 2000);
  }
  const st = await fsp.stat(file);
  return { path: file, format, bytes: st.size, blocks: blocks.length, preview };
}

/* --------------------------------------------------------------- meetings */

async function transcribeAudio(payload = {}) {
  requireReady();
  if (!state.creative) throw new Error('Audio transcription is not available in this session.');
  const file = guardedPath(payload.audioPath, 'Audio file');
  await fileStat(file);
  const asr = payload.asr || {};
  if (!asr.url) throw new Error('Set a speech-to-text endpoint in Settings → Voice, or paste a transcript instead.');
  const result = await state.creative.transcribe({
    path: file,
    url: String(asr.url),
    key: asr.key ? String(asr.key) : undefined,
    model: asr.model ? String(asr.model) : undefined,
    language: payload.language || undefined,
  });
  return {
    path: file,
    text: String(result.text || ''),
    segments: Array.isArray(result.segments) ? result.segments : [],
    language: result.language || payload.language || null,
    duration: typeof result.duration === 'number' ? result.duration : null,
    endpoint: result.endpoint || asr.url,
  };
}

function parseSummaryJson(text) {
  const raw = String(text || '').trim();
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(stripped.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

async function meetingSummarize(payload = {}) {
  requireReady();
  const title = String(payload.title || '').trim() || `Meeting ${new Date().toLocaleString()}`;
  let transcript = String(payload.transcript || '').trim();
  let transcription = null;
  if (!transcript) {
    if (!payload.audioPath) throw new Error('Paste a transcript or pick an audio file.');
    transcription = await transcribeAudio(payload);
    transcript = transcription.text.trim();
    if (!transcript) throw new Error('The speech-to-text endpoint returned no text.');
  }
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  if (!candidates.length) throw new Error('Configure a model provider in Settings → Providers to summarise the meeting.');
  const gateway = requireModel();
  const limited = transcript.slice(0, 30000);
  const system = [
    'You summarise meetings from a transcript.',
    'Return only JSON matching this shape:',
    '{"summary": string, "decisions": string[], "actionItems": [{"task": string, "owner": string, "due": string}], "topics": string[]}',
    'Use the transcript language for the values. Do not invent facts. Leave owner/due empty when the transcript does not say.',
  ].join('\n');
  const result = await gateway.chat({
    candidates,
    task: 'summarize',
    system,
    history: [{ role: 'user', text: `Transcript:\n${limited}` }],
    jsonSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        decisions: { type: 'array', items: { type: 'string' } },
        actionItems: {
          type: 'array',
          items: {
            type: 'object',
            properties: { task: { type: 'string' }, owner: { type: 'string' }, due: { type: 'string' } },
            required: ['task'],
          },
        },
        topics: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary'],
    },
    temperature: 0.2,
    maxTokens: 1400,
    runId: newId('meeting'),
  });
  const parsed = parseSummaryJson(result.text) || { summary: String(result.text || '').trim() };
  const summary = String(parsed.summary || '').trim();
  if (!summary) throw new Error('The model returned an empty summary.');
  const actionItems = (Array.isArray(parsed.actionItems) ? parsed.actionItems : []).map((item) => ({
    task: String(item.task || '').trim(),
    owner: String(item.owner || '').trim(),
    due: String(item.due || '').trim(),
  })).filter((item) => item.task);
  const decisions = (Array.isArray(parsed.decisions) ? parsed.decisions : []).map((d) => String(d)).filter(Boolean);
  const topics = (Array.isArray(parsed.topics) ? parsed.topics : []).map((t) => String(t)).filter(Boolean);
  const blocks = [
    { type: 'text', text: summary },
    ...(decisions.length ? [{ type: 'heading', text: 'Decisions' }, { type: 'list', items: decisions }] : []),
    ...(actionItems.length
      ? [{ type: 'heading', text: 'Action items' }, { type: 'table', headers: ['Task', 'Owner', 'Due'], rows: actionItems.map((a) => [a.task, a.owner, a.due]) }]
      : []),
    ...(topics.length ? [{ type: 'heading', text: 'Topics' }, { type: 'list', items: topics }] : []),
    { type: 'heading', text: 'Transcript' },
    { type: 'text', text: transcript },
  ];
  const report = await reportBuild({ title: `${title} — meeting summary`, blocks, format: 'md' });
  const meetingFile = path.join(state.dirs.meetings, `${slug(title)}-${stamp()}.md`);
  await fsp.copyFile(report.path, meetingFile);
  let remembered = false;
  const warnings = [];
  if (state.memory) {
    try {
      state.memory.add({
        text: `Meeting: ${title}. ${summary}`,
        kind: 'event',
        tags: 'meeting, productivity',
        source: 'meeting',
        project: payload.project || '',
        meta: { title, path: meetingFile, actionItems: actionItems.length },
      });
      remembered = true;
    } catch (err) {
      warnings.push(`Meeting note was not added to memory: ${err.message}`);
    }
  }
  return {
    title,
    summary,
    decisions,
    actionItems,
    topics,
    transcript,
    transcriptChars: transcript.length,
    transcriptTruncated: transcript.length > limited.length,
    language: transcription ? transcription.language : payload.language || null,
    duration: transcription ? transcription.duration : null,
    segments: transcription ? transcription.segments : [],
    model: result.model || null,
    usage: result.usage || null,
    path: meetingFile,
    reportPath: report.path,
    remembered,
    warnings,
    generatedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ notes */

function noteFromItem(item) {
  let title = '';
  if (item.meta && typeof item.meta === 'object') title = String(item.meta.title || '');
  if (!title) {
    const first = String(item.text || '').split(/\r?\n/)[0];
    title = first.length > 80 ? `${first.slice(0, 77)}…` : first;
  }
  return {
    id: item.id,
    title,
    body: item.text,
    tags: item.tags || [],
    project: item.project || '',
    pinned: !!item.pinned,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    score: typeof item.score === 'number' ? item.score : undefined,
  };
}

function requireMemory() {
  requireReady();
  if (!state.memory) throw new Error('The memory store is not available in this session.');
  return state.memory;
}

function noteList(payload = {}) {
  const memory = requireMemory();
  const limit = clamp(Number(payload.limit) || 100, 1, 500);
  const query = String(payload.query || '').trim();
  const items = query
    ? memory.search(query, { limit: clamp(limit * 2, 10, 500) }).filter((item) => item.source === 'notes')
    : memory.list({ tag: 'note', limit }).filter((item) => item.source === 'notes');
  return {
    notes: items.slice(0, limit).map(noteFromItem),
    total: items.length,
    query: query || null,
  };
}

function noteCreate(payload = {}) {
  const memory = requireMemory();
  const title = String(payload.title || '').trim();
  const body = String(payload.body || '').trim();
  if (!title) throw new Error('Give the note a title.');
  if (!body) throw new Error('Write something in the note.');
  if (body.length > 20000) throw new Error('Keep notes under 20,000 characters.');
  const extra = Array.isArray(payload.tags) ? payload.tags : String(payload.tags || '').split(',');
  const tags = ['note', ...extra.map((t) => String(t).trim()).filter(Boolean)].filter((t, i, arr) => arr.indexOf(t) === i);
  const item = memory.add({
    text: body,
    kind: 'fact',
    tags,
    source: 'notes',
    project: payload.project || '',
    meta: { title: title.slice(0, 200) },
  });
  return { note: noteFromItem(item), duplicate: !!item.duplicate };
}

function noteUpdate(payload = {}) {
  const memory = requireMemory();
  const id = String(payload.id || '');
  if (!id) throw new Error('Which note should be updated?');
  const patch = {};
  if (payload.title !== undefined) {
    const title = String(payload.title).trim();
    if (!title) throw new Error('The note title cannot be empty.');
    const current = memory.get(id);
    patch.meta = { ...(current && current.meta && typeof current.meta === 'object' ? current.meta : {}), title: title.slice(0, 200) };
  }
  if (payload.body !== undefined) {
    const body = String(payload.body).trim();
    if (!body) throw new Error('The note body cannot be empty.');
    patch.text = body;
  }
  if (payload.tags !== undefined) {
    const extra = Array.isArray(payload.tags) ? payload.tags : String(payload.tags || '').split(',');
    patch.tags = ['note', ...extra.map((t) => String(t).trim()).filter(Boolean)].filter((t, i, arr) => arr.indexOf(t) === i);
  }
  if (payload.project !== undefined) patch.project = payload.project;
  const item = memory.update(id, patch);
  return { note: noteFromItem(item) };
}

function noteDelete(payload = {}) {
  const memory = requireMemory();
  const id = String(payload.id || '');
  if (!id) throw new Error('Which note should be deleted?');
  const result = memory.remove(id);
  if (!result || !result.removed) throw new Error('That note no longer exists.');
  return { removed: id };
}

async function noteAsk(payload = {}) {
  const memory = requireMemory();
  const question = String(payload.question || '').trim();
  if (!question) throw new Error('Ask a question first.');
  return memory.ask({
    question,
    candidates: Array.isArray(payload.candidates) ? payload.candidates : [],
    project: payload.project || undefined,
    limit: clamp(Number(payload.limit) || 6, 1, 20),
  });
}

/* ------------------------------------------------------------------ tasks */

function taskRow(row) {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes || '',
    status: row.status,
    priority: row.priority,
    dueAt: row.due_at == null ? null : row.due_at,
    project: row.project || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at == null ? null : row.completed_at,
  };
}

const TASK_STATUSES = ['open', 'done'];

function normalizePriority(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 2;
  return clamp(Math.round(n), 1, 3);
}

function normalizeDue(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new Error('The due date could not be understood. Use YYYY-MM-DD or an ISO timestamp.');
  return parsed;
}

function taskList(payload = {}) {
  const db = requireDb();
  const status = String(payload.status || 'all');
  const where = [];
  const params = [];
  if (status !== 'all') {
    if (!TASK_STATUSES.includes(status)) throw new Error('Status must be open, done or all.');
    where.push('status = ?');
    params.push(status);
  }
  if (payload.project) {
    where.push('project = ?');
    params.push(String(payload.project));
  }
  const query = String(payload.query || '').trim();
  if (query) {
    where.push('(LOWER(title) LIKE ? OR LOWER(notes) LIKE ?)');
    params.push(`%${query.toLowerCase()}%`, `%${query.toLowerCase()}%`);
  }
  const limit = clamp(Number(payload.limit) || 200, 1, 500);
  const rows = db
    .prepare(
      `SELECT * FROM productivity_tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, COALESCE(due_at, 9000000000000000), priority, created_at DESC LIMIT ?`,
    )
    .all(...params, limit);
  return { tasks: rows.map(taskRow), status };
}

function taskCreate(payload = {}) {
  const db = requireDb();
  const title = String(payload.title || '').trim();
  if (!title) throw new Error('Give the task a title.');
  if (title.length > 300) throw new Error('Keep the task title under 300 characters.');
  const notes = String(payload.notes || '').trim().slice(0, 5000);
  const now = Date.now();
  const id = newId('todo');
  db.prepare(
    `INSERT INTO productivity_tasks(id, title, notes, status, priority, due_at, project, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, NULL)`,
  ).run(id, title, notes, normalizePriority(payload.priority), normalizeDue(payload.due ?? payload.dueAt), String(payload.project || '').slice(0, 80), now, now);
  return { task: taskRow(db.prepare('SELECT * FROM productivity_tasks WHERE id = ?').get(id)) };
}

function taskUpdate(payload = {}) {
  const db = requireDb();
  const id = String(payload.id || '');
  if (!id) throw new Error('Which task should be updated?');
  const current = db.prepare('SELECT * FROM productivity_tasks WHERE id = ?').get(id);
  if (!current) throw new Error('That task no longer exists.');
  const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : payload;
  const title = patch.title === undefined ? current.title : String(patch.title).trim();
  if (!title) throw new Error('The task title cannot be empty.');
  if (title.length > 300) throw new Error('Keep the task title under 300 characters.');
  const notes = patch.notes === undefined ? current.notes : String(patch.notes).trim().slice(0, 5000);
  const priority = patch.priority === undefined ? current.priority : normalizePriority(patch.priority);
  const due = patch.due === undefined && patch.dueAt === undefined ? current.due_at : normalizeDue(patch.due ?? patch.dueAt);
  const project = patch.project === undefined ? current.project : String(patch.project).slice(0, 80);
  let status = patch.status === undefined ? current.status : String(patch.status);
  if (!TASK_STATUSES.includes(status)) throw new Error('Status must be open or done.');
  const now = Date.now();
  const completedAt = status === 'done' ? current.completed_at || now : null;
  db.prepare(
    'UPDATE productivity_tasks SET title = ?, notes = ?, priority = ?, due_at = ?, project = ?, status = ?, updated_at = ?, completed_at = ? WHERE id = ?',
  ).run(title, notes, priority, due, project, status, now, completedAt, id);
  return { task: taskRow(db.prepare('SELECT * FROM productivity_tasks WHERE id = ?').get(id)) };
}

function taskToggle(payload = {}) {
  const db = requireDb();
  const id = String(payload.id || '');
  if (!id) throw new Error('Which task should be toggled?');
  const current = db.prepare('SELECT * FROM productivity_tasks WHERE id = ?').get(id);
  if (!current) throw new Error('That task no longer exists.');
  return taskUpdate({ id, patch: { status: current.status === 'done' ? 'open' : 'done' } });
}

function taskRemove(payload = {}) {
  const db = requireDb();
  const id = String(payload.id || '');
  if (!id) throw new Error('Which task should be deleted?');
  const info = db.prepare('DELETE FROM productivity_tasks WHERE id = ?').run(id);
  if (!info.changes) throw new Error('That task no longer exists.');
  return { removed: id };
}

function taskStats() {
  const db = requireDb();
  const rows = db.prepare('SELECT status, COUNT(*) AS c FROM productivity_tasks GROUP BY status').all();
  const counts = { open: 0, done: 0 };
  for (const row of rows) if (row.status in counts) counts[row.status] = row.c;
  const soon = Date.now() + 7 * 86400000;
  const overdue = db.prepare("SELECT COUNT(*) AS c FROM productivity_tasks WHERE status = 'open' AND due_at IS NOT NULL AND due_at < ?").get(Date.now()).c;
  const dueSoon = db
    .prepare("SELECT COUNT(*) AS c FROM productivity_tasks WHERE status = 'open' AND due_at IS NOT NULL AND due_at >= ? AND due_at <= ?")
    .get(Date.now(), soon).c;
  return { ...counts, total: counts.open + counts.done, overdue, dueSoon };
}

/* ------------------------------------------------------------- translate */

async function translate(payload = {}) {
  requireReady();
  const text = String(payload.text ?? '').trim();
  if (!text) throw new Error('Type something to translate.');
  if (text.length > 20000) throw new Error('Keep the text under 20,000 characters.');
  const target = String(payload.target || '').trim();
  if (!target) throw new Error('Choose a target language.');
  const source = String(payload.source || 'auto').trim() || 'auto';
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  if (!candidates.length) throw new Error('Configure a model provider in Settings → Providers to translate text.');
  const gateway = requireModel();
  const started = Date.now();
  const result = await gateway.chat({
    candidates,
    task: 'chat',
    system: `You are a professional translator. Translate the user's text${source === 'auto' ? '' : ` from ${source}`} into ${target}. Preserve formatting. Output only the translation with no notes.`,
    history: [{ role: 'user', text }],
    temperature: 0.1,
    maxTokens: clamp(Math.ceil(text.length / 2) + 400, 400, 5000),
    runId: newId('translate'),
  });
  const translation = String(result.text || '').trim();
  if (!translation) throw new Error('The model returned an empty translation.');
  return { text: translation, source, target, model: result.model || null, usage: result.usage || null, ms: Date.now() - started };
}

/* ------------------------------------------------------------ text files */

async function textList() {
  requireReady();
  const entries = await fsp.readdir(state.dirs.texts, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(state.dirs.texts, entry.name);
    const st = await fsp.stat(file);
    files.push({ name: entry.name, bytes: st.size, mtime: st.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return { files, dir: state.dirs.texts };
}

async function textOpen(payload = {}) {
  requireReady();
  const name = safeWorkspaceName(payload.name);
  const file = path.join(state.dirs.texts, name);
  try {
    const st = await fileStat(file);
    if (st.size > MAX_TEXT_FILE) throw new Error('That file is larger than 2 MB. Open it in Code instead.');
    const text = await fsp.readFile(file, 'utf8');
    return { name, path: file, text, bytes: st.size, mtime: st.mtimeMs };
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`"${name}" does not exist in the text workspace.`);
    throw err;
  }
}

async function textSave(payload = {}) {
  requireReady();
  const name = safeWorkspaceName(payload.name);
  const text = String(payload.text ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_FILE) throw new Error('Keep the file under 2 MB.');
  const file = path.join(state.dirs.texts, name);
  await fsp.writeFile(file, text, 'utf8');
  const st = await fsp.stat(file);
  return { name, path: file, bytes: st.size, mtime: st.mtimeMs };
}

async function textRemove(payload = {}) {
  requireReady();
  const name = safeWorkspaceName(payload.name);
  await fsp.rm(path.join(state.dirs.texts, name), { force: true });
  return { removed: name };
}

async function textRename(payload = {}) {
  requireReady();
  const from = safeWorkspaceName(payload.name);
  const to = safeWorkspaceName(payload.newName);
  const source = path.join(state.dirs.texts, from);
  await fileStat(source);
  if (fs.existsSync(path.join(state.dirs.texts, to))) throw new Error(`"${to}" already exists.`);
  await fsp.rename(source, path.join(state.dirs.texts, to));
  return { from, to };
}

/* ----------------------------------------------------------------- slides */

async function slidesBuild(payload = {}) {
  requireReady();
  const PptxGenJS = require('pptxgenjs');
  const title = String(payload.title || '').trim();
  if (!title) throw new Error('Give the presentation a title.');
  const slides = Array.isArray(payload.slides) ? payload.slides : [];
  if (!slides.length) throw new Error('Add at least one slide.');
  if (slides.length > 100) throw new Error('Keep presentations under 100 slides.');
  const theme = payload.theme === 'light' ? 'light' : 'dark';
  const palette = theme === 'light'
    ? { bg: 'F8FAFC', title: '0F172A', body: '334155', accent: '0EA5E9' }
    : { bg: '0B1220', title: 'F8FAFC', body: 'CBD5E1', accent: 'F97316' };
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'ORVEX';
  pptx.title = title;
  pptx.subject = 'Generated by ORVEX Productivity';

  const cover = pptx.addSlide();
  cover.background = { color: palette.bg };
  cover.addText(title, { x: 0.7, y: 2.2, w: 11.9, h: 1.5, fontSize: 40, bold: true, color: palette.title, fontFace: 'Segoe UI' });
  if (payload.subtitle) {
    cover.addText(String(payload.subtitle), { x: 0.7, y: 3.7, w: 11.9, h: 0.9, fontSize: 18, color: palette.body, fontFace: 'Segoe UI' });
  }
  cover.addShape(pptx.ShapeType.rect, { x: 0.7, y: 4.7, w: 2.2, h: 0.08, fill: { color: palette.accent } });

  slides.forEach((slide, index) => {
    const s = pptx.addSlide();
    s.background = { color: palette.bg };
    s.addText(String(slide.title || `Slide ${index + 2}`), { x: 0.7, y: 0.5, w: 11.9, h: 0.9, fontSize: 28, bold: true, color: palette.title, fontFace: 'Segoe UI' });
    s.addShape(pptx.ShapeType.rect, { x: 0.7, y: 1.35, w: 1.4, h: 0.06, fill: { color: palette.accent } });
    const bullets = Array.isArray(slide.bullets) ? slide.bullets.map((b) => String(b)).filter(Boolean) : [];
    if (bullets.length) {
      s.addText(
        bullets.map((text) => ({ text, options: { bullet: { code: '2022' }, breakLine: true } })),
        { x: 0.8, y: 1.7, w: 11.6, h: 5.2, fontSize: 18, color: palette.body, fontFace: 'Segoe UI', lineSpacingMultiple: 1.2 },
      );
    }
    if (slide.notes) s.addNotes(String(slide.notes));
    s.addText(`${index + 1}`, { x: 12.2, y: 6.7, w: 0.6, h: 0.3, fontSize: 11, color: palette.body, align: 'right' });
  });

  const file = path.join(state.dirs.slides, `${slug(title)}-${stamp()}.pptx`);
  await pptx.writeFile({ fileName: file });
  const st = await fsp.stat(file);
  return { path: file, bytes: st.size, slides: slides.length + 1, theme, title };
}

/* --------------------------------------------------------------- compare */

async function fileText(file) {
  const ext = path.extname(file).toLowerCase();
  if (['.xlsx', '.xls', '.xlsm'].includes(ext)) {
    const wb = XLSX.readFile(file, { cellDates: true });
    return wb.SheetNames.map((name) => {
      const ws = wb.Sheets[name];
      return `## Sheet: ${name}\n${XLSX.utils.sheet_to_csv(ws, { blankrows: false }).trim()}\n`;
    }).join('\n');
  }
  if (ext === '.csv' || ext === '.tsv') {
    const wb = XLSX.readFile(file);
    return XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]], { blankrows: false });
  }
  if (['.txt', '.md', '.json', '.log', '.html', '.htm'].includes(ext)) {
    const text = await fsp.readFile(file, 'utf8');
    if (ext === '.html' || ext === '.htm') {
      if (state.documents && state.documents.extract) {
        const doc = await state.documents.extract({ buf: Buffer.from(text), name: path.basename(file), contentType: 'text/html' });
        return doc.text || text;
      }
    }
    return text;
  }
  if (!state.documents) throw new Error(`Cannot read ${ext || 'that file'} in this session.`);
  const doc = await state.documents.extractFile(file);
  if (!doc || typeof doc.text !== 'string') throw new Error('That file did not produce any text.');
  return doc.text;
}

async function compareDocs(payload = {}) {
  requireReady();
  const left = guardedPath(payload.a, 'First document');
  const right = guardedPath(payload.b, 'Second document');
  await Promise.all([fileStat(left), fileStat(right)]);
  const [textA, textB] = await Promise.all([fileText(left), fileText(right)]);
  const cap = 200000;
  const a = textA.length > cap ? textA.slice(0, cap) : textA;
  const b = textB.length > cap ? textB.slice(0, cap) : textB;
  const parts = diffLib.diffLines(a, b);
  const lines = [];
  let added = 0;
  let removed = 0;
  let same = 0;
  for (const part of parts) {
    const type = part.added ? 'add' : part.removed ? 'remove' : 'same';
    const chunk = part.value.endsWith('\n') ? part.value.slice(0, -1) : part.value;
    for (const text of chunk.split('\n')) {
      lines.push({ type, text });
      if (type === 'add') added += 1;
      else if (type === 'remove') removed += 1;
      else same += 1;
    }
  }
  return {
    a: { path: left, name: path.basename(left), chars: textA.length, truncated: textA.length > cap },
    b: { path: right, name: path.basename(right), chars: textB.length, truncated: textB.length > cap },
    lines: lines.slice(0, 4000),
    added,
    removed,
    same,
    changed: added + removed > 0,
    truncated: lines.length > 4000,
    unified: lines.slice(0, 4000).map((l) => `${l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' '}${l.text}`).join('\n'),
  };
}

/* ------------------------------------------------------------- artifacts */

const ARTIFACT_KIND = {
  '.md': 'report',
  '.html': 'report',
  '.docx': 'report',
  '.pptx': 'slides',
  '.xlsx': 'sheet',
  '.txt': 'text',
  '.csv': 'data',
  '.db': 'database',
};

async function artifacts(payload = {}) {
  requireReady();
  const dirs = [state.dirs.reports, state.dirs.slides, state.dirs.sheets, state.dirs.texts, state.dirs.meetings];
  const result = [];
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = path.join(dir, entry.name);
      const st = await fsp.stat(file);
      result.push({
        name: entry.name,
        path: file,
        kind: ARTIFACT_KIND[path.extname(entry.name).toLowerCase()] || 'file',
        bytes: st.size,
        mtime: st.mtimeMs,
      });
    }
  }
  result.sort((x, y) => y.mtime - x.mtime);
  const limit = clamp(Number(payload.limit) || 200, 1, 500);
  return { artifacts: result.slice(0, limit), total: result.length, dirs: state.dirs };
}

async function capabilities() {
  const python = state.dirs ? await detectPython() : { available: false, error: 'Productivity is not initialised yet.' };
  return {
    python,
    xlsx: true,
    docx: true,
    pptx: true,
    sqlite: true,
    stt: !!state.creative,
    model: !!state.gateway,
    memory: !!state.memory,
    dirs: state.dirs,
  };
}

/* ------------------------------------------------------------ agent tools */

const definitions = [
  {
    name: 'calc',
    description: 'Evaluate an arithmetic expression safely (no code execution). Supports + - * / % ^, parentheses, factorial, pi/e and functions such as sqrt, round, min, max, log, sin. Use it instead of guessing arithmetic.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'Expression, e.g. (1250*0.18)+sqrt(144)' } },
      required: ['expression'],
    },
  },
  {
    name: 'python_run',
    description: 'Run a Python 3 script on this computer and return stdout/stderr. Use for data work, calculations or quick scripts. The script runs in a temporary folder with a timeout; it is not a sandbox for hostile code.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Full Python source to run' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 30000, max 120000)' },
      },
      required: ['code'],
    },
  },
  {
    name: 'data_analyze',
    description: 'Profile a CSV or Excel file: column types, missing values, unique counts, min/max/mean/median/stddev and top values. Use before charting or claiming numbers.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a .csv, .tsv, .xlsx or .xls file' },
        sheet: { type: 'string', description: 'Optional sheet name' },
      },
      required: ['path'],
    },
  },
  {
    name: 'data_chart',
    description: 'Aggregate a numeric column from a CSV/Excel file into chart points (bar, line, pie or scatter).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the data file' },
        sheet: { type: 'string' },
        x: { type: 'string', description: 'Category column (omit to use row numbers)' },
        y: { type: 'string', description: 'Numeric column to plot' },
        kind: { type: 'string', enum: ['bar', 'line', 'pie', 'scatter'] },
        agg: { type: 'string', enum: ['sum', 'avg', 'count', 'min', 'max'] },
      },
      required: ['path', 'y'],
    },
  },
  {
    name: 'sql_query',
    description: 'Run one SQL statement against ORVEX\'s private SQLite scratch database. Supports CREATE/INSERT/UPDATE/DELETE/SELECT and returns columns and rows for reads. ATTACH is blocked.',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'One SQL statement' },
        limit: { type: 'number', description: 'Max rows to return (default 500)' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'note_save',
    description: 'Save a note into ORVEX memory so it is searchable by the agent and RAG. Use for facts worth keeping across sessions.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'string', description: 'Comma-separated tags' },
        project: { type: 'string' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'note_search',
    description: 'Search saved notes and memory for relevant text.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
  },
  {
    name: 'task_add',
    description: 'Add a task to the real ORVEX task list.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        notes: { type: 'string' },
        priority: { type: 'number', description: '1 high, 2 normal, 3 low' },
        due: { type: 'string', description: 'YYYY-MM-DD or ISO timestamp' },
        project: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'task_list',
    description: 'List tasks from the ORVEX task list.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'done', 'all'] },
        query: { type: 'string' },
      },
    },
  },
  {
    name: 'task_done',
    description: 'Mark a task done (or reopen it).',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'translate_text',
    description: 'Translate text into another language using the configured model.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        target: { type: 'string', description: 'Target language, e.g. Urdu, English, Arabic' },
        source: { type: 'string', description: 'Source language or auto' },
      },
      required: ['text', 'target'],
    },
  },
  {
    name: 'report_build',
    description: 'Build a Markdown, HTML or DOCX report from blocks and save it in the Productivity workspace.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        format: { type: 'string', enum: ['md', 'html', 'docx'] },
        blocks: {
          type: 'array',
          description: 'Blocks: heading, text, list, kv, table, chart, code, divider',
          items: { type: 'object' },
        },
      },
      required: ['title', 'blocks'],
    },
  },
  {
    name: 'slides_build',
    description: 'Generate a real .pptx presentation from a title and slides with bullets.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        subtitle: { type: 'string' },
        theme: { type: 'string', enum: ['dark', 'light'] },
        slides: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } },
            required: ['title'],
          },
        },
      },
      required: ['title', 'slides'],
    },
  },
  {
    name: 'compare_docs',
    description: 'Compare two documents (PDF, DOCX, XLSX, CSV, text) line by line and report added and removed lines.',
    parameters: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a', 'b'],
    },
  },
];

const agentHandlers = {
  calc: async (args) => {
    const result = calc(args);
    return { ok: true, output: `${result.expression} = ${result.display}` };
  },
  python_run: async (args) => {
    const result = await runPython(args);
    const parts = [];
    if (result.stdout) parts.push(result.stdout.trimEnd());
    if (result.stderr) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
    if (!parts.length) parts.push(`(no output, exit code ${result.exitCode})`);
    return {
      ok: result.exitCode === 0,
      output: parts.join('\n').slice(0, MAX_OUTPUT),
      error: result.exitCode === 0 ? undefined : result.timedOut ? 'Python timed out.' : `Python exited with code ${result.exitCode}.`,
    };
  },
  data_analyze: async (args) => {
    const info = await dataAnalyze(args);
    const lines = [`${info.path} · ${info.sheet} · ${info.rows} row(s), ${info.columns.length} column(s)`];
    for (const col of info.columns) {
      const bits = [`${col.name}: ${col.type}`, `${col.nonEmpty} filled`, `${col.missing} missing`, `${col.unique} unique`];
      if (col.type === 'number') bits.push(`min ${col.min}`, `max ${col.max}`, `mean ${Number(col.mean).toFixed(3)}`, `sum ${col.sum}`);
      lines.push(`- ${bits.join(' · ')}`);
    }
    return { ok: true, output: lines.join('\n') };
  },
  data_chart: async (args) => {
    const chart = await dataChart(args);
    const lines = [`${chart.kind} chart of ${chart.y}${chart.x ? ` by ${chart.x}` : ''} (${chart.agg || 'raw'}) · ${chart.points.length} point(s)`];
    for (const point of chart.points.slice(0, 30)) lines.push(`- ${point.label}: ${point.value}`);
    if (chart.points.length > 30) lines.push(`… ${chart.points.length - 30} more point(s)`);
    return { ok: true, output: lines.join('\n') };
  },
  sql_query: async (args) => {
    const result = sqlRun(args);
    if (result.kind === 'write') return { ok: true, output: `Statement applied · ${result.changes} row(s) changed · last id ${result.lastInsertRowid}` };
    const lines = [result.columns.join(' | ')];
    for (const row of result.rows.slice(0, 40)) lines.push(row.map((v) => (v === null ? 'NULL' : String(v))).join(' | '));
    if (result.rows.length > 40) lines.push(`… ${result.rows.length - 40} more row(s)`);
    return { ok: true, output: lines.join('\n') };
  },
  note_save: async (args) => {
    const result = noteCreate({ title: args.title, body: args.body, tags: args.tags, project: args.project });
    return { ok: true, output: `Saved note "${result.note.title}" (${result.note.id})${result.duplicate ? ' — identical text already existed' : ''}.` };
  },
  note_search: async (args) => {
    const result = noteList({ query: args.query, limit: args.limit });
    if (!result.notes.length) return { ok: true, output: 'No notes matched.' };
    return { ok: true, output: result.notes.map((n) => `[${n.id}] ${n.title}\n${String(n.body).slice(0, 400)}`).join('\n\n') };
  },
  task_add: async (args) => {
    const result = taskCreate(args);
    return { ok: true, output: `Added task "${result.task.title}" (${result.task.id})${result.task.dueAt ? ` · due ${new Date(result.task.dueAt).toISOString()}` : ''}.` };
  },
  task_list: async (args) => {
    const result = taskList({ status: args.status || 'open', query: args.query });
    if (!result.tasks.length) return { ok: true, output: 'No tasks.' };
    return {
      ok: true,
      output: result.tasks.map((t) => `[${t.id}] ${t.status === 'done' ? '✓' : '○'} ${t.title}${t.dueAt ? ` · due ${new Date(t.dueAt).toISOString().slice(0, 10)}` : ''}`).join('\n'),
    };
  },
  task_done: async (args) => {
    const result = taskToggle(args);
    return { ok: true, output: `Task "${result.task.title}" is now ${result.task.status}.` };
  },
  translate_text: async (args, ctx = {}) => {
    const result = await translate({ ...args, candidates: Array.isArray(ctx.candidates) ? ctx.candidates : [] });
    return { ok: true, output: result.text };
  },
  report_build: async (args) => {
    const result = await reportBuild(args);
    return { ok: true, output: `Saved ${result.format.toUpperCase()} report (${result.bytes} bytes) at ${result.path}` };
  },
  slides_build: async (args) => {
    const result = await slidesBuild(args);
    return { ok: true, output: `Saved ${result.slides}-slide presentation (${result.bytes} bytes) at ${result.path}` };
  },
  compare_docs: async (args) => {
    const result = await compareDocs(args);
    return {
      ok: true,
      output: `${result.added} added, ${result.removed} removed, ${result.same} unchanged line(s).\n${result.unified.slice(0, 4000)}`,
    };
  },
};

module.exports = {
  init,
  close,
  capabilities,
  calc,
  pythonInfo,
  runPython,
  dataAnalyze,
  dataChart,
  sheetOpen,
  sheetSave,
  sheetCreate,
  sqlRun,
  sqlTables,
  sqlSchema,
  reportBuild,
  transcribeAudio,
  meetingSummarize,
  noteList,
  noteCreate,
  noteUpdate,
  noteDelete,
  noteAsk,
  taskList,
  taskCreate,
  taskUpdate,
  taskToggle,
  taskRemove,
  taskStats,
  translate,
  textList,
  textOpen,
  textSave,
  textRemove,
  textRename,
  slidesBuild,
  compareDocs,
  artifacts,
  definitions,
  agentHandlers,
};
