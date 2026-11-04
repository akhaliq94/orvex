'use strict';

/** Real OS tools available to the agent. Everything is audited. */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { exec } = require('node:child_process');
const { shell } = require('electron');
const { checkPath, checkCommand, checkUrl, needsApproval } = require('./guardrails.cjs');
const browser = require('./browser.cjs');
const desktop = require('./desktop.cjs');
const web = require('./web.cjs');
const integrations = require('./integrations.cjs');
const connectors = require('./connectors.cjs');
const learner = require('./learner.cjs');
const hands = require('./hands.cjs');
const maker = require('./maker.cjs');
const advisor = require('./advisor.cjs');
const workflows = require('./workflows.cjs');
const permissions = require('./permissions.cjs');
const mcp = require('./mcp.cjs');
const db = require('./db.cjs');
const memory = require('./memory.cjs');
const files = require('./files.cjs');
const creative = require('./creative.cjs');
const security = require('./security.cjs');
const productivity = require('./productivity.cjs');
const planTodos = require('./plan-todos.cjs');
const delegates = require('./delegates.cjs');
const approvalAdvisor = require('./approval-advisor.cjs');
const a2a = require('./a2a.cjs');
const { coerceArgsFor } = require('./tool-args.cjs');

const MAX_READ_BYTES = 512 * 1024;
const SPILL_THRESHOLD = 6000;
const SPILL_MAX_CHARS = 256 * 1024;
const MAX_WRITE_CHARS = 2 * 1024 * 1024;
const MAX_TOOL_OUTPUT = 6000;
const IGNORED_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'build', '$recycle.bin', 'system volume information']);

let auditFile = null;
let memoryFile = null;
let outputDir = null;

function init(opts) {
  auditFile = opts && opts.auditFile ? opts.auditFile : null;
  memoryFile = opts && opts.memoryFile ? opts.memoryFile : null;
  outputDir = opts && opts.outputDir ? String(opts.outputDir) : null;
  if (outputDir) pruneSpill();
}

function audit(entry) {
  const ts = Date.now();
  const safe = { ...entry };
  if (safe.args) safe.args = security.redact(String(safe.args)).slice(0, 2000);
  if (safe.error) safe.error = security.redact(String(safe.error)).slice(0, 2000);
  try {
    db.audit({ ...safe, ts });
  } catch {
    /* the JSONL trail below is the fallback */
  }
  if (!auditFile) return;
  const line = JSON.stringify({ ts: new Date(ts).toISOString(), ...safe }) + '\n';
  fsp.appendFile(auditFile, line, 'utf8').catch(() => {});
}

function clip(text, max = MAX_TOOL_OUTPUT) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

/**
 * Long tool output is more useful on disk than silently cut: keep a head in the
 * transcript and save the full text where fs_read can reach it. Output that
 * looks like it carries credentials is never written.
 */
function spillOutput(name, runId, text) {
  if (!outputDir || text.length <= SPILL_THRESHOLD) return null;
  const scan = security.outputTripwire(text);
  if (scan.findings.length) return { blocked: scan.findings };
  const run = String(runId || 'run').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'run';
  const safeTool = String(name || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  const dir = path.join(outputDir, run);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now().toString(36)}-${safeTool}.txt`);
  const body = text.slice(0, SPILL_MAX_CHARS);
  const tail = text.length > body.length ? `\n…[${text.length - body.length} chars were not saved because the file cap is ${SPILL_MAX_CHARS}]` : '';
  fs.writeFileSync(file, body + tail, 'utf8');
  return { path: file, chars: text.length, saved: body.length };
}

/** Keep the spill folder bounded: 7 days or 500 files, oldest first. */
function pruneSpill(maxAgeMs = 7 * 24 * 60 * 60 * 1000, maxFiles = 500) {
  if (!outputDir) return { removed: 0, kept: 0 };
  try {
    if (!fs.existsSync(outputDir)) return { removed: 0, kept: 0 };
    const files = [];
    for (const run of fs.readdirSync(outputDir)) {
      const dir = path.join(outputDir, run);
      let stat;
      try {
        stat = fs.statSync(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        try {
          const info = fs.statSync(file);
          files.push({ file, mtime: info.mtimeMs });
        } catch {
          /* a file removed mid-scan is fine */
        }
      }
    }
    files.sort((a, b) => a.mtime - b.mtime);
    const now = Date.now();
    const excess = Math.max(0, files.length - maxFiles);
    let removed = 0;
    files.forEach((entry, index) => {
      if (index < excess || now - entry.mtime > maxAgeMs) {
        try {
          fs.unlinkSync(entry.file);
          removed += 1;
        } catch {
          /* locked or already gone */
        }
      }
    });
    return { removed, kept: files.length - removed };
  } catch {
    return { removed: 0, kept: 0 };
  }
}

function todoText(snapshot) {
  if (!snapshot.items.length) return 'No todo items.';
  const lines = snapshot.items.map((item) => `#${item.id} [${item.status === 'done' ? 'x' : ' '}] ${item.title}`);
  return `${lines.join('\n')}\n${snapshot.remaining} open of ${snapshot.total}.`;
}

function emitTodos(ctx, snapshot) {
  if (!ctx || typeof ctx.emit !== 'function') return;
  try {
    ctx.emit({ type: 'todos', ...snapshot });
  } catch {
    /* the parent may already be gone */
  }
}

function delegateText(task) {
  const lines = [`${task.id} — ${task.agent} — ${task.status}`];
  if (task.goal) lines.push(`Goal: ${task.goal}`);
  if (task.result) lines.push(`Result: ${task.result}`);
  if (task.error) lines.push(`Error: ${task.error}`);
  if (task.note) lines.push(`Note: ${task.note}`);
  return lines.join('\n');
}

function queueText(row) {
  const when = row.createdAt ? new Date(Number(row.createdAt)).toISOString().slice(0, 16).replace('T', ' ') : 'unknown time';
  const lines = [`${row.id} — ${row.agent} — ${row.status} — ${when}`];
  lines.push(`Goal: ${String(row.goal || '').slice(0, 240)}`);
  if (row.result) lines.push(`Result: ${String(row.result).slice(0, 400)}`);
  if (row.error) lines.push(`Error: ${String(row.error).slice(0, 300)}`);
  if (row.resumedAs) lines.push(`Resumed as: ${row.resumedAs}`);
  return lines.join('\n');
}

/** Every http(s)/ws(s) URL anywhere in the arguments (nested payloads included). */
function urlArgsOf(args) {
  const found = [];
  const seen = new Set();
  let budget = 300;
  const visit = (value, depth) => {
    if (depth > 4 || found.length >= 12 || budget <= 0) return;
    budget -= 1;
    if (typeof value === 'string') {
      const text = value.trim();
      if (/^(https?|wss?):\/\//i.test(text) && !seen.has(text)) {
        seen.add(text);
        found.push(text);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item, depth + 1);
    }
  };
  visit(args, 0);
  return found;
}

/** A clean environment so a sandboxed shell cannot inherit tokens from the app process. */
function sandboxEnv() {
  const keep = ['PATH', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LANG', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];
  const env = {};
  for (const key of keep) if (process.env[key]) env[key] = process.env[key];
  return env;
}

function prettySize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)}${units[i]}`;
}

/** Models often send relative paths; anchor them at the user's home, not the app folder. */
function userPath(input, fallback) {
  let raw = String(input ?? '').trim().replace(/^["']|["']$/g, '');
  if (raw === '~' || raw === '~/' || raw === '~\\') raw = '';
  if (raw.startsWith('~/') || raw.startsWith('~\\')) raw = raw.slice(2);
  if (!raw) return fallback || os.homedir();
  return path.isAbsolute(raw) ? raw : path.join(os.homedir(), raw);
}

function toolPath(input, label = 'path') {
  const resolved = userPath(input, '');
  if (!resolved) throw new Error(`${label} is empty.`);
  return resolved;
}

/** First provider in the run's chain that can serve images (Anthropic cannot). */
function imageProvider(candidates) {
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) => c && c.baseUrl);
  const usable = list.find((c) => String(c.api || 'openai') !== 'anthropic');
  if (!usable) {
    throw new Error('No image-capable provider is configured. Add OpenAI, Gemini, Together or OpenRouter in Settings → Providers.');
  }
  return usable;
}

const IMAGE_KIND_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'tiff']);
function imageMime(file) {
  const ext = String(path.extname(file)).replace(/^\./, '').toLowerCase();
  if (!IMAGE_KIND_EXT.has(ext)) throw new Error('That file is not a supported image (png, jpg, webp, gif, bmp, avif, tiff).');
  return `image/${ext === 'jpg' ? 'jpeg' : ext}`;
}

const definitions = [
  {
    name: 'sys_info',
    description:
      'Read real machine information: OS, CPU, memory, uptime, home folder, drives. Use this before making claims about the computer.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'fs_list',
    description:
      'List a folder on the user\'s computer. Returns names, [dir] markers and sizes. Use before reading or writing so you know what exists.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute folder path, e.g. C:\\Users\\Abdul Khaliq\\Desktop' },
      },
      required: ['path'],
    },
  },
  {
    name: 'fs_read',
    description:
      'Read a text file (max 512 KB). Use for source code, notes, logs, configs. Never for password stores or private keys — those are blocked.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'fs_write',
    description:
      'Create or overwrite a text file, creating parent folders as needed. Use for reports, notes and code the user asked for. System folders are blocked.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'fs_find',
    description:
      'Find files or folders by name under a start folder. Good for "where is my thesis.docx" style goals.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute folder to search from' },
        pattern: { type: 'string', description: 'Case-insensitive part of the name, or a glob like *.pdf' },
      },
      required: ['path', 'pattern'],
    },
  },
  {
    name: 'shell_exec',
    description:
      'Run a shell command on the user\'s machine and get stdout/stderr. Windows uses cmd.exe. Destructive commands (format, diskpart, recursive delete, registry, shutdown, remote code execution) are blocked.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command line to run' },
        cwd: { type: 'string', description: 'Working folder (defaults to the user home)' },
        timeoutMs: { type: 'number', description: 'Timeout in ms, default 30000, max 600000' },
      },
      required: ['command'],
    },
  },
  {
    name: 'app_open',
    description:
      'Open a URL in the default browser or an existing file/folder with its default app. This is a real action on the user\'s screen.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'http(s) URL or absolute file/folder path' },
      },
      required: ['target'],
    },
  },
  {
    name: 'memory_append',
    description:
      'Save one durable fact to ORVEX long-term memory (SQLite, searchable). Use for facts about the user, this machine, running projects and preferences that matter in future runs. Not for task logs.',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Single short line to remember, e.g. "User keeps projects in D:\\\\dev"' },
        kind: {
          type: 'string',
          enum: ['fact', 'preference', 'project', 'person', 'procedure', 'event', 'insight'],
          description: 'Memory type — defaults to fact',
        },
        project: { type: 'string', description: 'Project/category this belongs to (defaults to general)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional short tags' },
      },
      required: ['note'],
    },
  },
  {
    name: 'memory_search',
    description:
      'Search long-term memory (BM25 + semantic) before asking the user to repeat context. Returns matching memory lines with their ids.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall' },
        kind: {
          type: 'string',
          enum: ['fact', 'preference', 'project', 'person', 'procedure', 'event', 'insight', 'legacy'],
          description: 'Optional memory type filter',
        },
        project: { type: 'string', description: 'Optional project filter' },
        limit: { type: 'number', description: 'Max results, default 6, max 20' },
      },
      required: ['query'],
    },
  },
  {
    name: 'file_meta',
    description:
      'Inspect a real file: size, type, timestamps, SHA-256 and a short text preview. Use before converting or archiving so you know what the file is.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_duplicates',
    description:
      'Scan a folder (and subfolders) for byte-identical duplicate files using SHA-256. Returns duplicate groups and wasted space. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute folder to scan' },
        minSize: { type: 'number', description: 'Ignore files smaller than this many bytes (default 1)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_archive',
    description:
      'Zip files/folders or inspect/extract real zip archives. op=zip needs dest (.zip) and sources; op=unzip needs zipPath and destDir; op=list needs zipPath.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['zip', 'unzip', 'list'], description: 'Archive operation' },
        dest: { type: 'string', description: 'Zip destination for op=zip' },
        sources: { type: 'array', items: { type: 'string' }, description: 'Files or folders to zip' },
        zipPath: { type: 'string', description: 'Existing .zip for op=unzip/list' },
        destDir: { type: 'string', description: 'Extraction folder for op=unzip' },
      },
      required: ['op'],
    },
  },
  {
    name: 'file_pdf',
    description:
      'Real PDF toolkit. op=info (pages/metadata), op=merge (paths, dest), op=split (path, ranges like "1-2,4", destDir), op=rotate (path, degrees, pages, dest), op=meta (path, title/author/subject, dest), op=create (dest, title, text).',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['info', 'merge', 'split', 'rotate', 'meta', 'create'], description: 'PDF operation' },
        path: { type: 'string', description: 'Source PDF' },
        paths: { type: 'array', items: { type: 'string' }, description: 'PDFs to merge' },
        dest: { type: 'string', description: 'Output PDF path' },
        destDir: { type: 'string', description: 'Output folder for split' },
        ranges: { type: 'string', description: 'Page ranges for split/rotate, e.g. "1-2,4"' },
        pages: { type: 'string', description: 'Pages to rotate (default all)' },
        degrees: { type: 'number', description: 'Rotation: 90, 180 or 270' },
        title: { type: 'string', description: 'Document title' },
        author: { type: 'string', description: 'Document author (meta)' },
        subject: { type: 'string', description: 'Document subject (meta)' },
        text: { type: 'string', description: 'Body text for op=create' },
      },
      required: ['op'],
    },
  },
  {
    name: 'file_sheet',
    description:
      'Spreadsheet toolkit (XLSX/CSV). op=info (sheets/bytes), op=read (header + rows), op=to_csv (dest), op=create (dest, rows as an array of arrays, sheetName). Read-only except to_csv/create.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['info', 'read', 'to_csv', 'create'], description: 'Sheet operation' },
        path: { type: 'string', description: 'Source .xlsx/.xls' },
        dest: { type: 'string', description: 'Output path for to_csv/create' },
        sheet: { type: 'string', description: 'Sheet name (default first)' },
        sheetName: { type: 'string', description: 'Sheet name for op=create' },
        rows: { type: 'array', description: '2D array of cell values for op=create' },
        limit: { type: 'number', description: 'Max rows to return (default 100)' },
      },
      required: ['op'],
    },
  },
  {
    name: 'file_docx',
    description:
      'Create a real Word .docx from Markdown. Supports headings, bullets, quotes, pipe tables and --- page breaks. Needs dest (.docx), markdown and an optional title.',
    parameters: {
      type: 'object',
      properties: {
        dest: { type: 'string', description: 'Output .docx path' },
        markdown: { type: 'string', description: 'Document content in Markdown' },
        title: { type: 'string', description: 'Document title' },
      },
      required: ['dest', 'markdown'],
    },
  },
  {
    name: 'file_diff',
    description:
      'Compare two real text files and return a unified diff plus added/removed line counts. Use for reviewing edits.',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'string', description: 'Original file path' },
        b: { type: 'string', description: 'Changed file path' },
      },
      required: ['a', 'b'],
    },
  },
  {
    name: 'file_backup',
    description:
      'Manage ORVEX file backups stored in app data. op=create (path), op=list (optional path), op=restore (id — overwrites the current file), op=delete (id).',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['create', 'list', 'restore', 'delete'], description: 'Backup operation' },
        path: { type: 'string', description: 'Source file for create/list' },
        id: { type: 'string', description: 'Backup id for restore/delete' },
      },
      required: ['op'],
    },
  },
  {
    name: 'file_versions',
    description:
      'Version history for a file (ORVEX snapshots before each write, rename or delete). op=list (path) or op=restore (id — overwrites the current file).',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'restore'], description: 'Version operation' },
        path: { type: 'string', description: 'File path for op=list' },
        id: { type: 'string', description: 'Version id for op=restore' },
      },
      required: ['op'],
    },
  },
  {
    name: 'file_watch',
    description:
      'Watch a real folder for adds/changes/deletes (chokidar). op=start (path), op=status, op=stop (id, or the first watcher when omitted).',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['start', 'status', 'stop'], description: 'Watcher operation' },
        path: { type: 'string', description: 'Folder to watch for op=start' },
        id: { type: 'string', description: 'Watcher id for op=stop' },
      },
      required: ['op'],
    },
  },
  {
    name: 'media_library',
    description:
      'Manage the real ORVEX media library (images, audio, video, 3D, subtitles). op=list (optional kind/query), op=import (path), op=delete (id), op=export (id + destDir), op=reveal (id).',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'import', 'delete', 'export', 'reveal'], description: 'Library operation' },
        kind: { type: 'string', enum: ['image', 'audio', 'video', 'model', 'subtitle', 'file'], description: 'Filter for op=list' },
        query: { type: 'string', description: 'Name/prompt search for op=list' },
        path: { type: 'string', description: 'File to import for op=import' },
        destDir: { type: 'string', description: 'Destination folder for op=export' },
        id: { type: 'string', description: 'Asset id for delete/export/reveal' },
      },
      required: ['op'],
    },
  },
  {
    name: 'media_generate_image',
    description:
      'Generate a real image through the configured image provider (OpenAI, Gemini, Together, OpenRouter). Saves every result into the media library. Costs provider credits.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Image description' },
        model: { type: 'string', description: 'Optional image model id (defaults per provider)' },
        size: { type: 'string', description: 'Optional size like 1024x1024' },
        n: { type: 'number', description: 'How many images, 1-4' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'media_edit_image',
    description:
      'Edit an existing image (or remove its background) through the configured image provider. Give assetId from media_library or an absolute image path. Saves the result.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The edit to perform' },
        assetId: { type: 'string', description: 'Library asset id' },
        path: { type: 'string', description: 'Absolute image path when no assetId' },
        removeBackground: { type: 'boolean', description: 'Use the transparent-background preset' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'media_upscale',
    description: 'Upscale a real image locally with Lanczos resampling (sharp). factor 2-8, optional sharpen. Saves the result into the library.',
    parameters: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Library asset id' },
        path: { type: 'string', description: 'Absolute image path when no assetId' },
        factor: { type: 'number', description: 'Scale factor, default 2' },
        sharpen: { type: 'boolean', description: 'Apply a light sharpen pass' },
      },
    },
  },
  {
    name: 'media_analyze',
    description:
      'Analyse a real image (library asset or path) with the configured vision model: describe content, read text, answer a question. Uses the run\'s model chain.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to find out' },
        assetId: { type: 'string', description: 'Library image id' },
        path: { type: 'string', description: 'Absolute image path when no assetId' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'media_3d_info',
    description:
      'Read real 3D model metadata (glTF/GLB/OBJ/STL/PLY/FBX): meshes, nodes, vertices, faces, animations. op=info needs path; op=import also copies it into the media library.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['info', 'import'], description: 'Read metadata or import' },
        path: { type: 'string', description: 'Absolute 3D file path' },
      },
      required: ['op', 'path'],
    },
  },
  {
    name: 'media_subtitles',
    description:
      'Build a real SRT or VTT file from timed segments. Save it into the media library. segments is an array of {start,end,text} seconds.',
    parameters: {
      type: 'object',
      properties: {
        segments: {
          type: 'array',
          description: 'Timed segments',
          items: {
            type: 'object',
            properties: { start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' } },
            required: ['start', 'end', 'text'],
          },
        },
        format: { type: 'string', enum: ['srt', 'vtt'], description: 'Subtitle format' },
        maxChars: { type: 'number', description: 'Max characters per line (default 42)' },
        name: { type: 'string', description: 'Optional file name' },
      },
      required: ['segments'],
    },
  },
  {
    name: 'media_prompts',
    description:
      'Prompt library. op=list (query/kind), op=save (text, optional title/kind/tags/id), op=use (id), op=delete (id).',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'save', 'use', 'delete'], description: 'Prompt operation' },
        id: { type: 'string', description: 'Prompt id' },
        title: { type: 'string' },
        text: { type: 'string' },
        kind: { type: 'string', description: 'image, video, music, speech…' },
        tags: { type: 'array', items: { type: 'string' } },
        query: { type: 'string', description: 'Search for op=list' },
      },
      required: ['op'],
    },
  },
  {
    name: 'todo_add',
    description:
      'Track a multi-step goal as a short todo list for this run. Add one or more items before starting work; duplicate open titles are ignored.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Todo items to add',
          items: {
            type: 'object',
            properties: { title: { type: 'string', description: 'Short, verifiable item' } },
            required: ['title'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'todo_complete',
    description:
      'Mark todo items done. Only do this after a tool result proves the item is finished; include a short reason.',
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'number' }, description: 'Todo ids returned by todo_add or todo_list' },
        reason: { type: 'string', description: 'How it was verified' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'todo_remove',
    description: 'Remove todo items that are no longer relevant to the goal.',
    parameters: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'number' } } },
      required: ['ids'],
    },
  },
  {
    name: 'todo_list',
    description: 'Show the current run plan with open and completed items.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'delegate_start',
    description:
      'Start a background sub-agent for an independent piece of work and keep going. Children run concurrently, cannot ask the user for approval, and return their finding through delegate_result. Wait for them with delegate_wait before finishing.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Complete, self-contained task for the sub-agent' },
        agent: { type: 'string', description: 'Optional short label, e.g. researcher or checker' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'delegate_status',
    description: 'List this run\'s background sub-agents, or show one task by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Optional sub-agent task id' } },
      required: [],
    },
  },
  {
    name: 'delegate_wait',
    description:
      'Block until one background sub-agent finishes, or until the timeout. Use this before you finish the parent goal.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Sub-agent task id' },
        timeoutMs: { type: 'number', description: 'Maximum wait, default 30000, max 120000' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delegate_result',
    description: 'Read a sub-agent\'s result. While it is still running the answer says so; wait first.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'delegate_cancel',
    description: 'Stop one of this run\'s background sub-agents.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'delegate_queue',
    description:
      'List durable sub-agent tasks from this and earlier sessions. Tasks interrupted by a restart or crash are shown as interrupted and can be resumed.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many recent tasks, default 20, max 100' } },
      required: [],
    },
  },
  {
    name: 'delegate_resume',
    description:
      'Re-run an interrupted, failed or cancelled durable sub-agent task with the current model chain. Use delegate_queue to find the id first.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Durable task id, e.g. sub_m1abc_1' },
        agent: { type: 'string', description: 'Optional new label for the resumed worker' },
      },
      required: ['id'],
    },
  },
  {
    name: 'a2a_send',
    description:
      'Send a text task to a saved A2A peer (another ORVEX or A2A-speaking machine) and return its reply. The peer answers with text only; it cannot act on this PC.',
    parameters: {
      type: 'object',
      properties: {
        peer: { type: 'string', description: 'Saved peer name or peer id (see a2a_peers)' },
        text: { type: 'string', description: 'The request to send, up to 8000 characters' },
        timeoutMs: { type: 'number', description: 'How long to wait, default 120000, max 300000' },
      },
      required: ['peer', 'text'],
    },
  },
  {
    name: 'a2a_tasks',
    description: 'List recent agent-to-agent tasks, or show one task by id with its reply.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional task id' },
        limit: { type: 'number', description: 'How many recent tasks, default 20, max 200' },
        direction: { type: 'string', enum: ['inbound', 'outbound'], description: 'Optional direction filter' },
      },
      required: [],
    },
  },
  {
    name: 'a2a_peers',
    description: 'List saved A2A peers and their last error. Peers are added by the user in Advanced → Devices.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  ...browser.definitions,
  ...desktop.definitions,
  ...web.definitions,
  ...integrations.definitions,
  ...connectors.definitions,
  ...learner.definitions,
  ...hands.definitions,
  ...maker.definitions,
  ...advisor.definitions,
  ...workflows.definitions,
  ...productivity.definitions,
];

/** Repair model-typed arguments against the tool's own schema before any gate sees them. */
function coerceArgs(name, args) {
  return coerceArgsFor(name, args, definitions);
}

const handlers = {
  async sys_info() {
    const cpus = os.cpus();
    const lines = [
      `OS: ${os.platform()} ${os.release()} (${os.arch()})`,
      `Machine: ${os.hostname()} — user ${os.userInfo().username}`,
      `CPU: ${cpus[0] ? cpus[0].model.trim() : 'unknown'} × ${cpus.length} cores`,
      `Memory: ${prettySize(os.totalmem() - os.freemem())} used of ${prettySize(os.totalmem())}`,
      `Uptime: ${(os.uptime() / 3600).toFixed(1)} h`,
      `Home: ${os.homedir()}`,
      `Temp: ${os.tmpdir()}`,
      `Node: ${process.versions.node} — Electron: ${process.versions.electron || 'n/a'}`,
    ];
    if (process.platform === 'win32') {
      const drives = [];
      for (let i = 67; i <= 90; i += 1) {
        const letter = `${String.fromCharCode(i)}:\\`;
        if (!fs.existsSync(letter)) continue;
        try {
          const st = fs.statfsSync(letter);
          const total = st.blocks * st.bsize;
          const free = st.bfree * st.bsize;
          drives.push(`${letter} ${prettySize(total - free)} used / ${prettySize(total)} (${prettySize(free)} free)`);
        } catch {
          drives.push(`${letter} present`);
        }
      }
      if (drives.length) lines.push(`Drives:\n  ${drives.join('\n  ')}`);
    }
    return { ok: true, output: lines.join('\n') };
  },

  async fs_list(args) {
    const target = userPath(args.path, os.homedir());
    const blocked = checkPath(target, 'read');
    if (blocked) return { ok: false, error: blocked };
    const st = await fsp.stat(target);
    if (!st.isDirectory()) return { ok: false, error: `${target} is a file, not a folder. Use fs_read.` };
    const entries = await fsp.readdir(target, { withFileTypes: true });
    const rows = [];
    for (const d of entries.slice(0, 500)) {
      const full = path.join(target, d.name);
      let size = '';
      try {
        if (d.isFile()) size = ` — ${prettySize((await fsp.stat(full)).size)}`;
      } catch {
        /* permission */
      }
      rows.push(`${d.isDirectory() ? '[dir]' : '     '} ${d.name}${size}`);
    }
    rows.sort((a, b) => (b.startsWith('[dir]') ? 1 : 0) - (a.startsWith('[dir]') ? 1 : 0) || a.localeCompare(b));
    const more = entries.length > 500 ? `\n…and ${entries.length - 500} more entries` : '';
    return { ok: true, output: `${target}\n${rows.join('\n') || '(empty folder)'}${more}` };
  },

  async fs_read(args) {
    const target = userPath(args.path, '');
    const blocked = checkPath(target, 'read');
    if (blocked) return { ok: false, error: blocked };
    const st = await fsp.stat(target);
    if (!st.isFile()) return { ok: false, error: `${target} is a folder. Use fs_list.` };
    if (st.size > MAX_READ_BYTES) {
      return { ok: false, error: `File is ${prettySize(st.size)} — larger than the ${prettySize(MAX_READ_BYTES)} read limit.` };
    }
    const buf = await fsp.readFile(target);
    if (buf.includes(0)) return { ok: false, error: 'Looks like a binary file, not text.' };
    return { ok: true, output: buf.toString('utf8') };
  },

  async fs_write(args) {
    const target = userPath(args.path, '');
    const content = String(args.content ?? '');
    const blocked = checkPath(target, 'write');
    if (blocked) return { ok: false, error: blocked };
    if (content.length > MAX_WRITE_CHARS) return { ok: false, error: 'Content is too large (2 MB max).' };
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf8');
    return { ok: true, output: `Wrote ${content.length} chars to ${target}` };
  },

  async fs_find(args) {
    const start = userPath(args.path, os.homedir());
    const raw = String(args.pattern || '').trim();
    if (!raw) return { ok: false, error: 'Pattern is empty.' };
    const blocked = checkPath(start, 'read');
    if (blocked) return { ok: false, error: blocked };
    const re = new RegExp('^' + raw.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const needle = raw.toLowerCase().replace(/[*?]/g, '');
    const hits = [];
    const queue = [{ dir: start, depth: 0 }];
    let visited = 0;
    while (queue.length && hits.length < 100 && visited < 20000) {
      const { dir, depth } = queue.shift();
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of entries) {
        visited += 1;
        const lower = d.name.toLowerCase();
        const nameHit = raw.includes('*') || raw.includes('?') ? re.test(lower) : lower.includes(needle);
        if (nameHit) hits.push(path.join(dir, d.name));
        if (d.isDirectory() && depth < 7 && !IGNORED_DIRS.has(lower) && !d.name.startsWith('.')) {
          queue.push({ dir: path.join(dir, d.name), depth: depth + 1 });
        }
        if (hits.length >= 100 || visited >= 20000) break;
      }
    }
    return {
      ok: true,
      output: hits.length ? hits.join('\n') : `No match for "${raw}" under ${start} (searched ${visited} entries).`,
    };
  },

  async shell_exec(args) {
    const command = String(args.command || '');
    const blocked = checkCommand(command);
    if (blocked) return { ok: false, error: blocked };
    const sandboxed = security.sandboxEnabled();
    const cwd = sandboxed ? security.sandboxDir() : userPath(args.cwd, os.homedir());
    if (!cwd) return { ok: false, error: 'The sandbox folder is not available.' };
    const cwdBlocked = checkPath(cwd, 'read');
    if (cwdBlocked) return { ok: false, error: cwdBlocked };
    const timeout = Math.min(Math.max(Number(args.timeoutMs) || 30000, 1000), 600000);
    const options = { cwd, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true };
    if (sandboxed) options.env = sandboxEnv();
    return await new Promise((resolve) => {
      exec(command, options, (err, stdout, stderr) => {
        const out = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean).join('\n');
        if (err) {
          resolve({
            ok: false,
            error: `${err.killed ? 'Timed out' : 'Exit ' + (err.code ?? '?')}: ${err.message}`,
            output: clip(out),
          });
          return;
        }
        resolve({ ok: true, output: String(out || '(no output)').slice(0, 1024 * 1024) });
      });
    });
  },

  async app_open(args) {
    const raw = String(args.target || '').trim();
    const urlBlocked = checkUrl(raw);
    if (!urlBlocked) {
      await shell.openExternal(raw);
      return { ok: true, output: `Opened ${raw} in the default app.` };
    }
    const target = userPath(raw, '');
    const blocked = checkPath(target, 'read');
    if (blocked) return { ok: false, error: blocked };
    if (!fs.existsSync(target)) return { ok: false, error: `${target} does not exist. Use shell_exec to launch apps by name.` };
    const err = await shell.openPath(target);
    if (err) return { ok: false, error: err };
    return { ok: true, output: `Opened ${target}.` };
  },

  async memory_append(args) {
    const note = String(args.note || '').trim().replace(/\s+/g, ' ');
    if (!note) return { ok: false, error: 'Note is empty.' };
    if (note.length > 500) return { ok: false, error: 'Keep each memory note under 500 characters.' };
    try {
      const stored = memory.add({
        text: note,
        kind: args.kind,
        project: args.project,
        tags: args.tags,
        source: 'agent',
        importance: 0.6,
      });
      return {
        ok: true,
        output: stored.duplicate
          ? `Already in memory (importance raised): ${note}`
          : `Remembered ${stored.id}: ${note}`,
      };
    } catch (err) {
      if (!memoryFile) return { ok: false, error: `Memory is unavailable: ${err && err.message ? err.message : err}` };
      await fsp.mkdir(path.dirname(memoryFile), { recursive: true });
      await fsp.appendFile(memoryFile, `- ${new Date().toISOString().slice(0, 10)} — ${note}\n`, 'utf8');
      return { ok: true, output: `Remembered: ${note}` };
    }
  },

  async memory_search(args) {
    const query = String(args.query || '').trim();
    if (!query) return { ok: false, error: 'Query is empty.' };
    try {
      const limit = Math.min(Math.max(Number(args.limit) || 6, 1), 20);
      const hits = memory.search(query, { kind: args.kind, project: args.project, limit });
      if (!hits.length) return { ok: true, output: `No memories matched "${query}".` };
      return {
        ok: true,
        output: hits
          .map((hit) => {
            const meta = [hit.kind, hit.project || 'general'].join(', ');
            return `[${hit.id}] (${meta}, importance ${Math.round(hit.importance * 100)}%) ${hit.text}`;
          })
          .join('\n'),
      };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  },

  async file_meta(args) {
    const meta = await files.stat({ path: toolPath(args.path) });
    const lines = [
      `${meta.path}`,
      `Type: ${meta.isDir ? 'folder' : meta.mime || meta.ext || 'file'}`,
      `Size: ${prettySize(meta.size)} (${meta.size} bytes)`,
      `Modified: ${new Date(meta.modifiedAt || Date.now()).toISOString()}`,
      meta.sha256 ? `SHA-256: ${meta.sha256}${meta.hashPartial ? ' (head+tail of a very large file)' : ''}` : 'SHA-256: unavailable',
    ];
    if (meta.preview && meta.preview.kind === 'text') {
      lines.push('Preview:', clip(meta.preview.text || '', 1200));
    } else if (meta.preview) {
      lines.push(`Preview: ${meta.preview.kind} file`);
    }
    return { ok: true, output: lines.join('\n') };
  },

  async file_duplicates(args) {
    const result = await files.duplicates({ path: toolPath(args.path), minSize: args.minSize });
    if (!result.groups.length) {
      return { ok: true, output: `No duplicate files under ${result.root} (scanned ${result.scanned} files).` };
    }
    const lines = [
      `${result.groups.length} duplicate group(s) under ${result.root} — ${prettySize(result.wasted)} can be reclaimed (scanned ${result.scanned} files in ${result.tookMs} ms).`,
    ];
    for (const group of result.groups.slice(0, 20)) {
      lines.push(`\n${prettySize(group.size)} × ${group.files.length} — saves ${prettySize(group.wasted)}`);
      for (const file of group.files.slice(0, 10)) lines.push(`  ${file.path}`);
    }
    if (result.groups.length > 20) lines.push(`\n…and ${result.groups.length - 20} more groups`);
    return { ok: true, output: lines.join('\n') };
  },

  async file_archive(args) {
    const op = String(args.op || '');
    if (op === 'zip') {
      const sources = (Array.isArray(args.sources) ? args.sources : []).map((p) => toolPath(p, 'source'));
      const result = await files.zip({ dest: toolPath(args.dest, 'destination'), sources });
      return { ok: true, output: `Zipped ${result.entries} entries into ${result.path} (${prettySize(result.bytes)}).` };
    }
    if (op === 'unzip') {
      const result = await files.unzip({ zipPath: toolPath(args.zipPath, 'zip'), destDir: toolPath(args.destDir, 'destination folder') });
      return { ok: true, output: `Extracted ${result.extracted} files into ${result.path}.` };
    }
    if (op === 'list') {
      const result = await files.zipList({ zipPath: toolPath(args.zipPath, 'zip') });
      const rows = result.entries.slice(0, 200).map((e) => `${e.isDir ? '[dir]' : prettySize(e.size).padStart(8)} ${e.path}`);
      const more = result.entries.length > 200 ? `\n…and ${result.entries.length - 200} more entries` : '';
      return { ok: true, output: `${result.path} — ${result.entries.length} entries\n${rows.join('\n')}${more}` };
    }
    return { ok: false, error: 'op must be zip, unzip or list.' };
  },

  async file_pdf(args) {
    const op = String(args.op || '');
    if (op === 'info') {
      const info = await files.pdfInfo({ path: toolPath(args.path) });
      return {
        ok: true,
        output: [
          `${info.path}`,
          `Pages: ${info.pages}`,
          `Title: ${info.title || '—'} · Author: ${info.author || '—'} · Subject: ${info.subject || '—'}`,
          `Producer: ${info.producer || '—'} · Size: ${prettySize(info.bytes)}`,
        ].join('\n'),
      };
    }
    if (op === 'merge') {
      const paths = (Array.isArray(args.paths) ? args.paths : []).map((p) => toolPath(p, 'PDF'));
      const info = await files.pdfMerge({ paths, dest: toolPath(args.dest, 'destination') });
      return { ok: true, output: `Merged ${paths.length} PDFs into ${info.path} (${info.pages} pages).` };
    }
    if (op === 'split') {
      const result = await files.pdfSplit({ path: toolPath(args.path), ranges: String(args.ranges || ''), destDir: toolPath(args.destDir, 'destination folder') });
      return { ok: true, output: `Split ${result.pages} pages into ${result.created.length} file(s):\n${result.created.join('\n')}` };
    }
    if (op === 'rotate') {
      const info = await files.pdfRotate({
        path: toolPath(args.path),
        pages: String(args.pages || ''),
        degrees: Number(args.degrees ?? 90),
        dest: toolPath(args.dest, 'destination'),
      });
      return { ok: true, output: `Rotated to ${args.degrees ?? 90}° — wrote ${info.path} (${info.pages} pages).` };
    }
    if (op === 'meta') {
      const info = await files.pdfMeta({
        path: toolPath(args.path),
        dest: toolPath(args.dest, 'destination'),
        meta: { title: args.title, author: args.author, subject: args.subject },
      });
      return { ok: true, output: `Updated metadata on ${info.path} (title "${info.title || '—'}", author "${info.author || '—'}").` };
    }
    if (op === 'create') {
      const info = await files.pdfCreate({ dest: toolPath(args.dest, 'destination'), title: args.title || '', text: String(args.text || '') });
      return { ok: true, output: `Created ${info.path} (${info.pages} page(s), ${prettySize(info.bytes)}).` };
    }
    return { ok: false, error: 'op must be info, merge, split, rotate, meta or create.' };
  },

  async file_sheet(args) {
    const op = String(args.op || '');
    if (op === 'info') {
      const info = await files.xlsxInfo({ path: toolPath(args.path) });
      return {
        ok: true,
        output: `${info.path} (${prettySize(info.bytes)})\nSheets: ${info.sheets.map((s) => `${s.name} ${s.ref}`).join(' · ')}`,
      };
    }
    if (op === 'read') {
      const limit = args.limit;
      const sheet = await files.xlsxRead({ path: toolPath(args.path), sheet: args.sheet, limit });
      const lines = [sheet.header.join(' | ')];
      for (const row of sheet.rows) lines.push(row.join(' | '));
      lines.push(`(${sheet.rows.length} of ${sheet.totalRows} rows${sheet.truncated ? ', truncated' : ''} — sheet "${sheet.sheet}")`);
      return { ok: true, output: clip(lines.join('\n')) };
    }
    if (op === 'to_csv') {
      const result = await files.xlsxToCsv({ path: toolPath(args.path), dest: toolPath(args.dest, 'destination'), sheet: args.sheet });
      return { ok: true, output: `Wrote CSV to ${result.path} (${prettySize(result.bytes)}, sheet "${result.sheet}").` };
    }
    if (op === 'create') {
      const rows = (Array.isArray(args.rows) ? args.rows : []).map((row) => (Array.isArray(row) ? row : [row]));
      const info = await files.xlsxWrite({ dest: toolPath(args.dest, 'destination'), sheets: [{ name: args.sheetName, rows }] });
      return { ok: true, output: `Created ${info.path} with sheet "${info.sheets[0] ? info.sheets[0].name : 'Sheet1'}" (${rows.length} rows).` };
    }
    return { ok: false, error: 'op must be info, read, to_csv or create.' };
  },

  async file_docx(args) {
    const result = await files.docxMake({
      dest: toolPath(args.dest, 'destination'),
      markdown: String(args.markdown || ''),
      title: args.title,
    });
    return { ok: true, output: `Created ${result.path} (${result.paragraphs} blocks, ${prettySize(result.bytes)}).` };
  },

  async file_diff(args) {
    const result = await files.diff({ a: toolPath(args.a, 'first file'), b: toolPath(args.b, 'second file') });
    const header = `${result.a} → ${result.b}\n+${result.added} added · -${result.removed} removed · ${result.same} unchanged`;
    return { ok: true, output: clip(`${header}\n\n${result.unified}`) };
  },

  async file_backup(args) {
    const op = String(args.op || '');
    if (op === 'create') {
      const record = await files.backup({ path: toolPath(args.path) });
      return { ok: true, output: `Backed up ${record.source} (${prettySize(record.bytes)}) as ${record.id}.` };
    }
    if (op === 'list') {
      const rows = await files.backups({ path: args.path ? toolPath(args.path) : undefined });
      if (!rows.length) return { ok: true, output: 'No backups yet.' };
      return {
        ok: true,
        output: rows
          .slice(0, 50)
          .map((r) => `[${r.id}] ${r.source} — ${prettySize(r.bytes)} · ${new Date(r.createdAt).toISOString()}`)
          .join('\n'),
      };
    }
    if (op === 'restore') {
      const info = await files.restoreBackup({ id: String(args.id || '') });
      return { ok: true, output: `Restored ${info.path} from backup (${prettySize(info.size)}).` };
    }
    if (op === 'delete') {
      await files.removeBackup({ id: String(args.id || '') });
      return { ok: true, output: `Deleted backup ${args.id}.` };
    }
    return { ok: false, error: 'op must be create, list, restore or delete.' };
  },

  async file_versions(args) {
    const op = String(args.op || '');
    if (op === 'list') {
      const rows = await files.versions({ path: toolPath(args.path) });
      if (!rows.length) return { ok: true, output: 'No versions recorded for this file yet.' };
      return {
        ok: true,
        output: rows
          .slice(0, 50)
          .map((r) => `[${r.id}] ${new Date(r.createdAt).toISOString()} — ${r.reason} · ${prettySize(r.bytes)}`)
          .join('\n'),
      };
    }
    if (op === 'restore') {
      const info = await files.restoreVersion({ id: String(args.id || '') });
      return { ok: true, output: `Restored ${info.path} from version (${prettySize(info.size)}).` };
    }
    return { ok: false, error: 'op must be list or restore.' };
  },

  async file_watch(args) {
    const op = String(args.op || '');
    if (op === 'start') {
      const watch = await files.watchStart({ path: toolPath(args.path) });
      return { ok: true, output: `Watching ${watch.path} (${watch.id}${watch.reused ? ', already running' : ''}).` };
    }
    if (op === 'status') {
      const status = files.watchStatus();
      if (!status.watching.length) return { ok: true, output: 'No folder watchers are running.' };
      return {
        ok: true,
        output: status.watching
          .map((w) => `[${w.id}] ${w.path} — ${w.events} events${w.last.length ? `; last ${w.last[w.last.length - 1].type} ${w.last[w.last.length - 1].path}` : ''}`)
          .join('\n'),
      };
    }
    if (op === 'stop') {
      const stopped = await files.watchStop({ id: args.id });
      return { ok: true, output: `Stopped watching ${stopped.path}.` };
    }
    return { ok: false, error: 'op must be start, status or stop.' };
  },

  async media_library(args) {
    const op = String(args.op || '');
    if (op === 'list') {
      const result = await creative.library({ kind: args.kind, query: args.query, limit: 60 });
      if (!result.assets.length) return { ok: true, output: 'The media library is empty.' };
      return {
        ok: true,
        output: result.assets
          .map((a) => `[${a.id}] ${a.kind} · ${a.name} · ${prettySize(a.bytes)}${a.prompt ? ` · "${String(a.prompt).slice(0, 60)}"` : ''}`)
          .join('\n') + `\n(${result.total} total)`,
      };
    }
    if (op === 'import') {
      const asset = await creative.importAsset({ path: toolPath(args.path) });
      return { ok: true, output: `Imported ${asset.name} as ${asset.kind} (${prettySize(asset.bytes)}) — id ${asset.id}.` };
    }
    if (op === 'delete') {
      const info = await creative.deleteAsset(String(args.id || ''));
      return { ok: true, output: `Deleted ${info.name} (${info.deleted}).` };
    }
    if (op === 'export') {
      const info = await creative.exportAsset({ id: String(args.id || ''), destDir: toolPath(args.destDir, 'destination folder') });
      return { ok: true, output: `Exported to ${info.path} (${prettySize(info.bytes)}).` };
    }
    if (op === 'reveal') {
      const info = await creative.assetPath({ id: String(args.id || '') });
      shell.showItemInFolder(info.path);
      return { ok: true, output: `Revealed ${info.path}.` };
    }
    return { ok: false, error: 'op must be list, import, delete, export or reveal.' };
  },

  async media_generate_image(args, ctx) {
    const provider = imageProvider(ctx.candidates);
    const result = await creative.generateImage({
      provider,
      prompt: args.prompt,
      model: args.model,
      size: args.size,
      n: args.n,
    });
    return {
      ok: true,
      output: `Generated ${result.assets.length} image${result.assets.length === 1 ? '' : 's'} with ${result.provider || provider.name} · ${result.model}:\n${result.assets
        .map((a) => `[${a.id}] ${a.name}${a.meta && a.meta.width ? ` (${a.meta.width}×${a.meta.height})` : ''}`)
        .join('\n')}`,
    };
  },

  async media_edit_image(args, ctx) {
    const provider = imageProvider(ctx.candidates);
    const payload = { provider, prompt: args.prompt, assetId: args.assetId, path: args.assetId ? undefined : toolPath(args.path) };
    const result = args.removeBackground ? await creative.removeBackground(payload) : await creative.editImage(payload);
    return { ok: true, output: `Saved ${result.assets.map((a) => `[${a.id}] ${a.name}`).join(', ')}.` };
  },

  async media_upscale(args) {
    const result = await creative.upscaleImage({
      assetId: args.assetId,
      path: args.assetId ? undefined : toolPath(args.path),
      factor: args.factor,
      sharpen: args.sharpen,
    });
    return {
      ok: true,
      output: `Upscaled ${result.from.width}×${result.from.height} → ${result.to.width}×${result.to.height} (${result.factor}x): [${result.asset.id}] ${result.asset.name}.`,
    };
  },

  async media_analyze(args, ctx) {
    if (!Array.isArray(ctx.candidates) || !ctx.candidates.length) {
      return { ok: false, error: 'No model chain is available for this run.' };
    }
    let image;
    if (args.assetId) image = await creative.imagePayload({ assetId: args.assetId });
    else {
      const file = toolPath(args.path);
      const blocked = checkPath(file, 'read');
      if (blocked) return { ok: false, error: blocked };
      image = { mime: imageMime(file), data: (await fsp.readFile(file)).toString('base64') };
    }
    const result = await creative.analyzeImages({
      candidates: ctx.candidates,
      prompt: args.prompt,
      images: [image],
      task: 'vision',
    });
    return { ok: true, output: result.text || '(the model returned no text)' };
  },

  async media_3d_info(args) {
    const file = toolPath(args.path);
    const blocked = checkPath(file, 'read');
    if (blocked) return { ok: false, error: blocked };
    if (args.op === 'import') {
      const asset = await creative.importAsset({ path: file });
      const meta = asset.meta || {};
      return { ok: true, output: `Imported ${asset.name} (${asset.kind}, ${prettySize(asset.bytes)}) as ${asset.id}.\n${JSON.stringify(meta, null, 2)}` };
    }
    const buffer = await fsp.readFile(file);
    const meta = await creative.modelMeta(file, buffer);
    return { ok: true, output: `${path.basename(file)}\n${JSON.stringify(meta, null, 2)}` };
  },

  async media_subtitles(args) {
    const result = await creative.subtitleFile({
      segments: Array.isArray(args.segments) ? args.segments : [],
      format: args.format,
      maxChars: args.maxChars,
      name: args.name,
    });
    return {
      ok: true,
      output: `Wrote ${result.cues} cues to [${result.asset.id}] ${result.asset.name} (${result.format}).\n\n${result.text.slice(0, 1500)}`,
    };
  },

  async media_prompts(args) {
    const op = String(args.op || '');
    if (op === 'list') {
      const result = await creative.prompts({ query: args.query, kind: args.kind, limit: 60 });
      if (!result.prompts.length) return { ok: true, output: 'The prompt library is empty.' };
      return { ok: true, output: result.prompts.map((p) => `[${p.id}] (${p.kind}) ${p.title} — ${p.text.slice(0, 120)}`).join('\n') };
    }
    if (op === 'save') {
      const row = await creative.savePrompt({ id: args.id, title: args.title, text: args.text, kind: args.kind, tags: args.tags });
      return { ok: true, output: `Saved prompt [${row.id}] ${row.title}.` };
    }
    if (op === 'use') {
      const row = await creative.usePrompt({ id: String(args.id || '') });
      return { ok: true, output: `[${row.id}] ${row.title}\n\n${row.text}` };
    }
    if (op === 'delete') {
      const info = await creative.deletePrompt({ id: String(args.id || '') });
      return { ok: true, output: `Deleted prompt ${info.deleted}.` };
    }
    return { ok: false, error: 'op must be list, save, use or delete.' };
  },

  async todo_add(args, ctx) {
    try {
      const snapshot = planTodos.add(ctx && ctx.runId, Array.isArray(args.items) ? args.items : [args.items]);
      emitTodos(ctx, snapshot);
      return { ok: true, output: `Added ${snapshot.added.length} todo item(s).\n\n${todoText(snapshot)}` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async todo_complete(args, ctx) {
    try {
      const snapshot = planTodos.complete(ctx && ctx.runId, { ids: args.ids, reason: args.reason });
      emitTodos(ctx, snapshot);
      const missing = snapshot.missing.length ? ` Missing ids: ${snapshot.missing.join(', ')}.` : '';
      return { ok: true, output: `Completed ${snapshot.completed.length} item(s).${missing}\n\n${todoText(snapshot)}` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async todo_remove(args, ctx) {
    try {
      const snapshot = planTodos.remove(ctx && ctx.runId, { ids: args.ids });
      emitTodos(ctx, snapshot);
      const missing = snapshot.missing.length ? ` Missing ids: ${snapshot.missing.join(', ')}.` : '';
      return { ok: true, output: `Removed ${snapshot.removed.length} item(s).${missing}\n\n${todoText(snapshot)}` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async todo_list(args, ctx) {
    try {
      return { ok: true, output: todoText(planTodos.list(ctx && ctx.runId)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async delegate_start(args, ctx) {
    if (!ctx || ctx.allowDelegation === false) {
      return { ok: false, error: 'A background sub-agent cannot start another sub-agent.' };
    }
    try {
      const task = delegates.start({
        goal: args.goal,
        agent: args.agent,
        parentRunId: ctx.runId,
        chain: ctx.candidates,
        signal: ctx.signal,
        emit: ctx.emit,
      });
      return {
        ok: true,
        output: `Started background sub-agent ${task.id} (${task.agent}).\nUse delegate_wait "${task.id}" before finishing, or delegate_status to check on it.`,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async delegate_status(args, ctx) {
    try {
      const view = delegates.status(args.id, ctx && ctx.runId);
      if (!args.id) {
        if (!view.tasks.length) return { ok: true, output: 'No background sub-agents in this run.' };
        return { ok: true, output: `${view.running} running of ${view.tasks.length}:\n\n${view.tasks.map(delegateText).join('\n\n')}` };
      }
      return { ok: true, output: delegateText(view) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async delegate_wait(args, ctx) {
    try {
      const task = await delegates.wait(args.id, ctx && ctx.runId, args.timeoutMs, ctx && ctx.signal);
      return { ok: true, output: delegateText(task) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async delegate_result(args, ctx) {
    try {
      return { ok: true, output: delegateText(delegates.result(args.id, ctx && ctx.runId)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async delegate_cancel(args, ctx) {
    try {
      return { ok: true, output: delegateText(delegates.cancel(args.id, ctx && ctx.runId)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async delegate_queue(args) {
    try {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const queue = delegates.queue(limit);
      if (!queue.available) return { ok: false, error: 'The durable sub-agent queue needs the app database, which is not open in this window.' };
      if (!queue.tasks.length) return { ok: true, output: 'The durable sub-agent queue is empty.' };
      const resumable = queue.tasks.filter((row) => ['interrupted', 'failed', 'cancelled'].includes(String(row.status))).length;
      return {
        ok: true,
        output: `${queue.tasks.length} durable task(s), ${resumable} resumable (interrupted, failed or cancelled):\n\n${queue.tasks.map(queueText).join('\n\n')}`,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async a2a_peers() {
    try {
      const peers = a2a.listPeers();
      if (!peers.length) return { ok: true, output: 'No A2A peer is saved. The user can add one in Advanced → Devices → Agent network.' };
      return {
        ok: true,
        output: peers
          .map((peer) => `${peer.name} — ${peer.url}${peer.lastError ? ` (last error: ${peer.lastError})` : peer.lastSeen ? ' (reachable before)' : ''}`)
          .join('\n'),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async a2a_tasks(args) {
    try {
      if (args.id) {
        const task = a2a.getTask(String(args.id));
        if (!task) return { ok: false, error: `No A2A task "${args.id}" exists.` };
        const text = (task.artifacts || []).flatMap((artifact) => artifact.parts || []).map((part) => part.text || '').join('\n');
        return {
          ok: true,
          output: `${task.id} — ${task.status.state} (${task.metadata?.direction || 'unknown'}, ${task.metadata?.peer || 'unknown peer'})\n${text || (task.status.message?.parts || []).map((p) => p.text || '').join(' ') || 'No reply text.'}`,
        };
      }
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 200);
      const direction = args.direction === 'inbound' || args.direction === 'outbound' ? args.direction : undefined;
      const tasks = a2a.listTasks({ limit, direction });
      if (!tasks.length) return { ok: true, output: 'No A2A task has been exchanged yet.' };
      return {
        ok: true,
        output: tasks.map((task) => `${task.id} — ${task.status.state} · ${task.metadata?.direction || '?'} · ${task.metadata?.peer || '?'} · ${String(task.goal || '').slice(0, 80)}`).join('\n'),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async a2a_send(args) {
    try {
      const wanted = String(args.peer || '').trim().toLowerCase();
      const peers = a2a.listPeers();
      const hit = peers.find((peer) => peer.id === args.peer || peer.name.toLowerCase() === wanted);
      if (!hit) return { ok: false, error: `No saved A2A peer matches "${args.peer}". Use a2a_peers to see the saved names.` };
      const result = await a2a.send(hit.id, String(args.text || ''), { timeoutMs: args.timeoutMs });
      if (result.error) return { ok: false, error: result.error };
      const text = (result.task.artifacts || []).flatMap((artifact) => artifact.parts || []).map((part) => part.text || '').join('\n');
      return { ok: true, output: text || `Task ${result.task.id} finished as ${result.task.status.state}.` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async delegate_resume(args, ctx) {
    if (!ctx || ctx.allowDelegation === false) {
      return { ok: false, error: 'A background sub-agent cannot resume another sub-agent.' };
    }
    try {
      const out = delegates.resume({
        id: args.id,
        agent: args.agent,
        parentRunId: ctx && ctx.runId,
        chain: ctx && ctx.candidates,
        signal: ctx && ctx.signal,
        emit: ctx && ctx.emit,
      });
      const previous = out.previousError ? ` Previous error: ${out.previousError}` : '';
      return {
        ok: true,
        output: `Resumed ${out.resumedFrom} (was ${out.previousStatus}) as ${out.task.id} (${out.task.agent}).${previous}\nUse delegate_wait "${out.task.id}" before finishing.`,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  ...browser.handlers,
  ...desktop.handlers,
  ...web.handlers,
  ...integrations.handlers,
  ...connectors.handlers,
  ...learner.handlers,
  ...hands.handlers,
  ...maker.handlers,
  ...advisor.handlers,
  ...workflows.agentHandlers,
  ...productivity.agentHandlers,
};

/** Replace every mcp__ tool with the current server set. Definitions are mutated in place so the agent sees them. */
function applyMcp(defs, callTool) {
  for (let i = definitions.length - 1; i >= 0; i -= 1) {
    if (definitions[i].name.startsWith('mcp__')) {
      delete handlers[definitions[i].name];
      definitions.splice(i, 1);
    }
  }
  for (const def of defs || []) {
    definitions.push(def);
    handlers[def.name] = (args) => callTool(def.name, args);
  }
}

/** Replace every plugin__ tool with the current installed plugin set. */
function applyPlugins(defs, callTool) {
  for (let i = definitions.length - 1; i >= 0; i -= 1) {
    if (definitions[i].name.startsWith('plugin__')) {
      delete handlers[definitions[i].name];
      definitions.splice(i, 1);
    }
  }
  for (const def of defs || []) {
    definitions.push(def);
    handlers[def.name] = (args) => callTool(def.name, args);
  }
}

/** Guardrail answer for any tool, including external MCP tools. null = no human needed. */
function approvalReason(name, args) {
  const custom = permissions.approvalReason(name);
  if (custom || permissions.isAllowed(name)) return custom;
  const integration = integrations.approvalReason(name, args);
  if (integration) return integration;
  const connector = connectors.approvalReason(name, args);
  if (connector) return connector;
  const learning = learner.approvalReason(name, args);
  if (learning) return learning;
  if (name === 'hands_run') return hands.approvalReason(args);
  const makerReason = maker.approvalReason(name, args);
  if (makerReason) return makerReason;
  if (mcp.isMcpTool(name)) return mcp.approvalReason(name, args);
  if (String(name || '').startsWith('plugin__')) return 'Runs third-party plugin code in a sandboxed child process.';
  return needsApproval(name, args);
}

/**
 * Background sub-agents have no UI to ask the user. Any tool that would prompt
 * for approval is refused up front instead of running unapproved.
 */
function unattendedDenial(name, args) {
  const risk = approvalReason(name, args);
  if (!risk) return null;
  return `Background sub-agents cannot ask the user for approval, so "${name}" was refused (${risk}). Use a non-risky tool or report what the parent should do.`;
}

/**
 * Optional escalation from the approval advisor. Kept separate from
 * approvalReason so auto-approve can never treat it as ordinary risk.
 */
function escalationReason(name, args) {
  return approvalAdvisor.escalate(name, args);
}

async function runTool(name, args, ctx = {}) {
  const started = Date.now();
  if (ctx.signal && ctx.signal.aborted) {
    return { ok: false, output: '', error: 'Stopped by the user before this tool ran.', image: null, ms: 0 };
  }
  args = coerceArgs(name, args).args;
  const floored = permissions.floorReason(name, args);
  if (floored) {
    const ms = Date.now() - started;
    audit({ kind: 'tool-floor', runId: ctx.runId || null, tool: name, args: clip(JSON.stringify(args || {}), 600), ok: false, ms, error: floored });
    return { ok: false, output: '', error: floored, image: null, ms };
  }
  const denied = permissions.denialReason(name);
  if (denied) {
    const ms = Date.now() - started;
    audit({ kind: 'tool-denied', runId: ctx.runId || null, tool: name, args: clip(JSON.stringify(args || {}), 600), ok: false, ms, error: denied });
    return { ok: false, output: '', error: denied, image: null, ms };
  }
  const blocked = security.guardTool(name);
  if (blocked) {
    const ms = Date.now() - started;
    audit({ kind: 'tool-blocked', runId: ctx.runId || null, tool: name, args: clip(JSON.stringify(args || {}), 600), ok: false, ms, error: blocked });
    return { ok: false, output: '', error: blocked, image: null, ms };
  }
  const targetUrls = urlArgsOf(args);
  for (const targetUrl of targetUrls) {
    const net = security.networkPolicyBlock(targetUrl);
    if (net) {
      const ms = Date.now() - started;
      audit({ kind: 'tool-blocked', runId: ctx.runId || null, tool: name, args: clip(JSON.stringify(args || {}), 600), ok: false, ms, error: net });
      return { ok: false, output: '', error: net, image: null, ms };
    }
  }
  const handler = handlers[name];
  let result;
  if (!handler) {
    result = { ok: false, error: `Unknown tool "${name}".` };
  } else {
    try {
      result = await handler(args || {}, ctx);
    } catch (err) {
      result = { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }
  const ms = Date.now() - started;
  const fullOutput = String(result.output || '');
  let spilled = null;
  try {
    spilled = result.ok ? spillOutput(name, ctx.runId, fullOutput) : null;
  } catch {
    spilled = null;
  }
  let rawOutput;
  if (spilled && spilled.path) {
    rawOutput = `${fullOutput.slice(0, 4000)}\n…[output is ${spilled.chars} chars; full text saved at ${spilled.path} — use fs_read on that path to inspect the rest]`;
  } else if (spilled && spilled.blocked) {
    rawOutput = `${clip(fullOutput)}\n…[output contains credential-like text (${spilled.blocked.join(', ')}), so it was not saved to disk]`;
  } else {
    rawOutput = clip(fullOutput);
  }
  const wrapped = rawOutput ? security.wrapUntrusted(rawOutput, name) : { text: rawOutput, scan: { suspicious: false, reasons: [] } };
  if (wrapped.scan.suspicious) {
    audit({
      kind: 'injection-suspected',
      runId: ctx.runId || null,
      tool: name,
      args: clip(JSON.stringify(args || {}), 600),
      ok: false,
      ms,
      error: `Untrusted content tried to steer the agent: ${wrapped.scan.reasons.join('; ')}`,
    });
  }
  audit({
    kind: 'tool',
    runId: ctx.runId || null,
    tool: name,
    args: clip(JSON.stringify(args || {}), 600),
    ok: !!result.ok,
    ms,
    error: result.ok ? undefined : result.error,
  });
  return {
    ok: !!result.ok,
    output: wrapped.text,
    error: result.error || null,
    image: result.image || null,
    ms,
  };
}

module.exports = { definitions, runTool, coerceArgs, init, audit, applyMcp, applyPlugins, approvalReason, escalationReason, unattendedDenial, MAX_TOOL_OUTPUT };
