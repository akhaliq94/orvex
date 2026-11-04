'use strict';

/**
 * Document extraction: PDF text, DOCX, HTML (with tables), CSV/TSV, plain text
 * and image OCR. Everything here is pure Node — pdfjs-dist and mammoth are
 * loaded lazily so tests can run without Electron.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_INPUT_BYTES = 24 * 1024 * 1024;
const MAX_TEXT_CHARS = 240000;
const MAX_TABLES = 60;
const MAX_TABLE_ROWS = 400;
const MAX_TABLE_COLS = 24;
const MAX_PDF_PAGES = 400;

let ocrHandler = null;

function init(opts = {}) {
  if (typeof opts.ocr === 'function') ocrHandler = opts.ocr;
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  laquo: '«',
  raquo: '»',
  deg: '°',
  times: '×',
  bull: '•',
  euro: '€',
  pound: '£',
  yen: '¥',
  sect: '§',
  para: '¶',
};

function decodeEntities(input) {
  return String(input).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] && body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    const value = NAMED_ENTITIES[body.toLowerCase()];
    return value === undefined ? match : value;
  });
}

function isProbablyText(buf) {
  if (!buf.length) return true;
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  let bad = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 7 || (byte > 13 && byte < 32)) bad += 1;
  }
  return bad / sample.length < 0.05;
}

const IMAGE_MAGIC = [
  { kind: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { kind: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { kind: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { kind: 'bmp', bytes: [0x42, 0x4d] },
  { kind: 'webp', bytes: [0x52, 0x49, 0x46, 0x46] },
  { kind: 'tiff', bytes: [0x49, 0x49, 0x2a, 0x00] },
];

function startsWith(buf, bytes) {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}

function hasDocxPart(buf) {
  const marker = Buffer.from('word/document.xml');
  return buf.includes(marker);
}

function detectKind({ name, contentType, buf }) {
  const ct = String(contentType || '').toLowerCase();
  const ext = path.extname(String(name || '')).toLowerCase();
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);

  if (startsWith(data, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
  if (startsWith(data, [0x50, 0x4b, 0x03, 0x04]) || startsWith(data, [0x50, 0x4b, 0x05, 0x06])) {
    if (hasDocxPart(data)) return 'docx';
    if (ext === '.docx' || /wordprocessingml/.test(ct)) return 'docx';
    return 'zip';
  }
  for (const image of IMAGE_MAGIC) {
    if (startsWith(data, image.bytes)) return 'image';
  }

  if (ct.includes('application/pdf') || ext === '.pdf') return 'pdf';
  if (/wordprocessingml|msword/.test(ct) || ext === '.docx' || ext === '.doc') return 'docx';
  if (/^text\/csv|csv/.test(ct) || ext === '.csv') return 'csv';
  if (/tab-separated/.test(ct) || ext === '.tsv') return 'tsv';
  if (/text\/markdown/.test(ct) || ext === '.md' || ext === '.markdown') return 'markdown';
  if (/json/.test(ct) || ext === '.json') return 'json';
  if (/html/.test(ct) || ext === '.html' || ext === '.htm') return 'html';
  if (/xml/.test(ct) || ext === '.xml' || ext === '.rss' || ext === '.atom') return 'xml';
  if (/^text\//.test(ct) || ext === '.txt' || ext === '.log' || ext === '.yaml' || ext === '.yml' || ext === '.ini') return 'text';

  const sniff = data.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (sniff.startsWith('<!doctype html') || sniff.startsWith('<html')) return 'html';
  if (sniff.startsWith('<?xml')) return 'xml';
  if (sniff.startsWith('{') || sniff.startsWith('[')) return 'json';
  if (isProbablyText(data)) return 'text';
  return 'binary';
}

function normalizeText(input) {
  return String(input)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0\u200b]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cellText(html) {
  return decodeEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeCell(text) {
  const clipped = text.length > 300 ? `${text.slice(0, 297)}…` : text;
  return clipped.replace(/\|/g, '\\|') || ' ';
}

function tableToGrid(fragment) {
  const rows = [];
  for (const rowMatch of fragment.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<(t[dh])([^>]*)>([\s\S]*?)<\/\1>/gi)) {
      const attrs = cellMatch[2] || '';
      const colspan = Math.min(Math.max(parseInt((/(?:^|\s)colspan\s*=\s*["']?(\d+)/i.exec(attrs) || [])[1] || '1', 10) || 1, 1), 20);
      const rowspan = Math.min(Math.max(parseInt((/(?:^|\s)rowspan\s*=\s*["']?(\d+)/i.exec(attrs) || [])[1] || '1', 10) || 1, 1), 50);
      cells.push({
        text: cellText(cellMatch[3]),
        header: cellMatch[1].toLowerCase() === 'th',
        colspan,
        rowspan,
      });
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return { grid: [], headerRow: false };

  const carries = [];
  const grid = [];
  let sawHeader = false;
  for (const cells of rows) {
    const line = [];
    let col = 0;
    const placeCarries = () => {
      while (carries[col] && carries[col].left > 0) {
        line[col] = carries[col].text;
        carries[col].left -= 1;
        col += 1;
      }
    };
    for (const cell of cells) {
      placeCarries();
      for (let span = 0; span < cell.colspan && col < MAX_TABLE_COLS; span += 1) {
        line[col] = cell.text;
        if (cell.rowspan > 1) carries[col] = { text: cell.text, left: cell.rowspan - 1 };
        col += 1;
      }
      if (cell.header) sawHeader = true;
    }
    placeCarries();
    for (let c = 0; c < line.length; c += 1) if (line[c] === undefined) line[c] = '';
    grid.push(line);
  }
  return { grid, headerRow: sawHeader };
}

function gridToMarkdown(grid) {
  const rows = grid.slice(0, MAX_TABLE_ROWS);
  const width = Math.min(Math.max(...rows.map((r) => r.length)), MAX_TABLE_COLS);
  if (width < 2 || rows.length < 2) return '';
  const line = (cells) => `| ${cells.map((c) => escapeCell(c || '')).join(' | ')} |`;
  const head = rows[0].slice(0, width);
  const body = rows.slice(1);
  const out = [line(head), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`];
  for (const row of body) out.push(line(row.slice(0, width)));
  return out.join('\n');
}

function extractTables(html) {
  const tables = [];
  const placeholders = [];
  let index = 0;
  const stripped = String(html).replace(/<table[^>]*>[\s\S]*?<\/table>/gi, (fragment) => {
    if (tables.length >= MAX_TABLES) return ' ';
    const { grid } = tableToGrid(fragment);
    const markdown = gridToMarkdown(grid);
    if (!markdown) return ' ';
    const width = Math.min(Math.max(...grid.map((r) => r.length)), MAX_TABLE_COLS);
    const entry = { index: tables.length + 1, rows: grid.length, cols: width, markdown };
    tables.push(entry);
    const key = `\u0000TABLE${index}\u0000`;
    index += 1;
    placeholders.push({ key, markdown });
    return `\n\n${key}\n\n`;
  });
  return { stripped, tables, placeholders };
}

function htmlToText(html) {
  const { stripped, tables, placeholders } = extractTables(html);
  let text = String(stripped)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template|head|object|embed|canvas)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|main|h[1-6]|li|tr|blockquote|pre|table|ul|ol|dd|dt|figure|figcaption)>/gi, '\n\n')
    .replace(/<(li|dd|dt)[^>]*>/gi, '\n- ')
    .replace(/<(h[1-6])[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  for (const { key, markdown } of placeholders) text = text.split(key).join(`\n\n${markdown}\n\n`);
  text = normalizeText(text);
  return { text, tables };
}

function htmlTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html));
  return m ? cellText(m[1]) : '';
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text).replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field === '') quoted = true;
      else field += '"';
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

function csvToMarkdown(rows) {
  if (!rows.length) return { text: '', tables: [] };
  const width = Math.min(Math.max(...rows.map((r) => r.length)), MAX_TABLE_COLS);
  if (width < 2) {
    return { text: normalizeText(rows.map((r) => r.join(' ')).join('\n')), tables: [] };
  }
  const clipped = rows.slice(0, MAX_TABLE_ROWS).map((r) => r.slice(0, width));
  const markdown = gridToMarkdown(clipped);
  return {
    text: markdown,
    tables: [{ index: 1, rows: clipped.length, cols: width, markdown }],
  };
}

function layoutPdfItems(items) {
  const lines = new Map();
  for (const item of items) {
    if (!item || typeof item.str !== 'string') continue;
    const x = item.transform ? item.transform[4] : 0;
    const y = item.transform ? item.transform[5] : 0;
    const key = Math.round(y / 2) * 2;
    let row = lines.get(key);
    if (!row) {
      row = [];
      lines.set(key, row);
    }
    row.push({ x, width: item.width || 0, text: item.str });
  }
  const keys = [...lines.keys()].sort((a, b) => b - a);
  const out = [];
  for (const key of keys) {
    const row = lines.get(key).sort((a, b) => a.x - b.x);
    let line = '';
    let prevEnd = null;
    for (const piece of row) {
      const gap = prevEnd === null ? 0 : piece.x - prevEnd;
      if (line && gap > 1.5 && !/\s$/.test(line) && !/^\s/.test(piece.text)) line += ' ';
      line += piece.text;
      prevEnd = piece.x + piece.width;
    }
    const cleaned = line.replace(/[ \t]+/g, ' ').trim();
    if (cleaned) out.push(cleaned);
  }
  return out.join('\n');
}

async function parsePdf(buf, warnings) {
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (err) {
    return { error: `PDF engine could not load — ${(err && err.message) || err}` };
  }
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      useSystemFonts: false,
      isEvalSupported: false,
      disableFontFace: true,
      verbosity: 0,
    }).promise;
  } catch (err) {
    return { error: `This PDF could not be parsed — ${(err && err.message) || err}` };
  }

  try {
    let title = '';
    try {
      const meta = await doc.getMetadata();
      const info = (meta && meta.info) || {};
      if (info.Title && String(info.Title).trim()) title = normalizeText(info.Title);
    } catch {
      /* metadata is optional */
    }

    const total = doc.numPages;
    const pageLimit = Math.min(total, MAX_PDF_PAGES);
    if (total > pageLimit) warnings.push(`Only the first ${pageLimit} of ${total} pages were read.`);
    const pages = [];
    const parts = [];
    let emptyPages = 0;
    let rawChars = 0;
    for (let p = 1; p <= pageLimit; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const text = layoutPdfItems(content.items);
      if (!text) emptyPages += 1;
      rawChars += text.length;
      pages.push({ page: p, chars: text.length });
      parts.push(`--- Page ${p} ---\n${text}`);
      page.cleanup();
    }
    const text = normalizeText(parts.join('\n\n'));
    if (rawChars < pageLimit * 8 || emptyPages === pageLimit) {
      warnings.push(
        'This PDF has little or no extractable text (it may be a scan or an image-only export). ' +
          'The text layer is shown as-is; OCR the original pages as images if you need every word.',
      );
    }
    return { text, pages, pageCount: total, title };
  } finally {
    try {
      await doc.destroy();
    } catch {
      /* already released */
    }
  }
}

async function parseDocx(buf, warnings) {
  let mammoth;
  try {
    mammoth = require('mammoth');
  } catch (err) {
    return { error: `DOCX engine could not load — ${(err && err.message) || err}` };
  }
  try {
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(buf) });
    for (const message of result.messages || []) {
      if (message.type === 'warning' || message.type === 'error') {
        const text = String(message.message || '').trim();
        if (text && warnings.length < 12) warnings.push(`DOCX: ${text}`);
      }
    }
    const html = result.value || '';
    const { text, tables } = htmlToText(html);
    return { text, tables };
  } catch (err) {
    return { error: `This DOCX could not be read — ${(err && err.message) || err}` };
  }
}

async function ocrImage(buf, name) {
  if (!ocrHandler) return { error: 'Image OCR is not available in this context.' };
  const dir = path.join(os.tmpdir(), 'orvex-documents');
  await fsp.mkdir(dir, { recursive: true });
  const ext = path.extname(String(name || '')) || '.png';
  const file = path.join(dir, `ocr-${crypto.randomBytes(6).toString('hex')}${ext}`);
  await fsp.writeFile(file, buf);
  try {
    const result = await ocrHandler(file);
    if (!result || result.error) return { error: (result && result.error) || 'OCR failed.' };
    return { text: normalizeText(result.text || '') };
  } finally {
    void fsp.rm(file, { force: true }).catch(() => {});
  }
}

function clip(text, warnings) {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  warnings.push(`Text was cut to ${MAX_TEXT_CHARS.toLocaleString('en-US')} characters (${text.length.toLocaleString('en-US')} total).`);
  return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true };
}

/**
 * Extract readable text, page info and tables from a buffer.
 * @param {{buf: Buffer, name?: string, contentType?: string}} input
 */
async function extract(input = {}) {
  const buf = Buffer.isBuffer(input.buf) ? input.buf : Buffer.from(input.buf || []);
  const name = String(input.name || '').trim();
  if (!buf.length) return { ok: false, error: 'The document is empty.' };
  if (buf.length > MAX_INPUT_BYTES) {
    return { ok: false, error: `The document is ${(buf.length / 1048576).toFixed(1)} MB — the limit is 24 MB.` };
  }

  const kind = detectKind({ name, contentType: input.contentType, buf });
  const warnings = [];
  let text = '';
  let tables = [];
  let pages = null;
  let pageCount = null;
  let title = '';
  let mode = 'markdown';

  if (kind === 'pdf') {
    const parsed = await parsePdf(buf, warnings);
    if (parsed.error) return { ok: false, error: parsed.error };
    text = parsed.text;
    pages = parsed.pages;
    pageCount = parsed.pageCount;
    title = parsed.title;
    mode = 'text';
    if (!text) return { ok: false, error: 'This PDF has no extractable text. It is probably a scan — OCR it as images instead.' };
  } else if (kind === 'docx') {
    const parsed = await parseDocx(buf, warnings);
    if (parsed.error) return { ok: false, error: parsed.error };
    text = parsed.text;
    tables = parsed.tables || [];
    if (!text) warnings.push('The DOCX contained no readable text.');
  } else if (kind === 'html' || kind === 'xml') {
    const raw = buf.toString('utf8');
    const parsed = htmlToText(raw);
    text = parsed.text;
    tables = parsed.tables;
    if (kind === 'html') title = htmlTitle(raw);
  } else if (kind === 'csv' || kind === 'tsv') {
    const parsed = csvToMarkdown(parseDelimited(buf.toString('utf8'), kind === 'tsv' ? '\t' : ','));
    text = parsed.text;
    tables = parsed.tables;
  } else if (kind === 'markdown' || kind === 'text' || kind === 'json') {
    text = normalizeText(buf.toString('utf8'));
    if (kind !== 'markdown') mode = 'text';
  } else if (kind === 'image') {
    const parsed = await ocrImage(buf, name);
    if (parsed.error) return { ok: false, error: parsed.error };
    text = parsed.text;
    mode = 'text';
    if (!text) warnings.push('OCR found no text in this image.');
  } else if (kind === 'zip') {
    return { ok: false, error: 'This ZIP is not a DOCX. Only PDF, DOCX, HTML, CSV, text and images can be read.' };
  } else {
    return { ok: false, error: 'That file is binary — only PDF, DOCX, HTML, CSV, text and images can be read.' };
  }

  const clipped = clip(text, warnings);
  if (kind === 'html' && !clipped.text) return { ok: false, error: 'The page had no readable text.' };

  return {
    ok: true,
    kind,
    mode,
    title: title || (name ? path.basename(name) : ''),
    name: name || '',
    text: clipped.text,
    truncated: clipped.truncated,
    chars: clipped.text.length,
    tables: tables.map((t) => ({ ...t })),
    pages,
    pageCount,
    warnings,
  };
}

async function extractFile(filePath) {
  const target = path.resolve(String(filePath || ''));
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    return { ok: false, error: `File not found: ${target}` };
  }
  if (!stat.isFile()) return { ok: false, error: 'That path is not a file.' };
  if (stat.size > MAX_INPUT_BYTES) {
    return { ok: false, error: `The file is ${(stat.size / 1048576).toFixed(1)} MB — the limit is 24 MB.` };
  }
  const buf = await fsp.readFile(target);
  const result = await extract({ buf, name: path.basename(target) });
  return { ...result, path: target, size: stat.size, mtime: stat.mtimeMs };
}

/** Markdown that preserves the document faithfully when saved as a research note. */
function toMarkdown(doc) {
  if (!doc || !doc.ok) return '';
  const header = doc.title ? `# ${String(doc.title).trim()}\n\n` : '';
  if (doc.mode === 'markdown') return `${header}${doc.text}`;
  const fence = doc.text.includes('```') ? '~~~' : '```';
  return `${header}${fence}text\n${doc.text}\n${fence}`;
}

module.exports = {
  init,
  extract,
  extractFile,
  detectKind,
  htmlToText,
  htmlTitle,
  parseDelimited,
  toMarkdown,
  MAX_INPUT_BYTES,
  MAX_TEXT_CHARS,
};
