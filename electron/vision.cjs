'use strict';

/**
 * Section 19 — computer vision agent.
 *
 * Two real paths that can be combined:
 *   1. Windows OCR on a live screen capture or an image path.
 *   2. A multimodal model call through the model gateway (OpenAI or Anthropic
 *      image blocks) for description, UI reading and question answering.
 * A camera frame captured in the renderer can be passed as a data URL too.
 * If no model is configured the result says so and still returns the OCR text.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkPath } = require('./guardrails.cjs');

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp' };
const CAMERA_DIR = path.join(os.tmpdir(), 'orvex-vision');

let ctx = {
  gateway: null,
  screenshot: null,
  ocr: null,
  planCandidates: (list) => list,
};

function init(opts = {}) {
  ctx = { ...ctx, ...opts };
}

function clip(text, max = 8000) {
  const s = String(text == null ? '' : text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function normalizeCandidates(list) {
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || !c.baseUrl || !c.model) continue;
    const item = {
      id: String(c.id || c.presetId || c.baseUrl),
      presetId: String(c.presetId || c.id || ''),
      name: String(c.name || c.model),
      baseUrl: String(c.baseUrl).replace(/\/+$/, ''),
      apiKey: c.apiKey || '',
      api: c.api === 'anthropic' ? 'anthropic' : 'openai',
      model: String(c.model),
    };
    const key = `${item.id}|${item.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function readImageFile(imagePath) {
  const file = path.resolve(String(imagePath));
  const blocked = checkPath(file, 'read');
  if (blocked) throw new Error(blocked);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('That path is not a file.');
  if (stat.size > MAX_IMAGE_BYTES) throw new Error(`Image is ${(stat.size / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
  const mime = MIME[path.extname(file).toLowerCase()] || 'image/png';
  return { file, mime, data: fs.readFileSync(file).toString('base64'), bytes: stat.size };
}

function parseDataUrl(dataUrl) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!match) throw new Error('Camera frames must be base64 image data URLs.');
  const data = match[2].replace(/\s+/g, '');
  const bytes = Math.floor((data.length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES) throw new Error('The camera frame is too large.');
  return { mime: match[1], data, bytes };
}

/** Windows OCR needs a real file, so a camera frame is persisted for the run. */
function saveCameraFrame(dataUrl) {
  const frame = parseDataUrl(dataUrl);
  let ext = '.jpg';
  if (frame.mime.includes('png')) ext = '.png';
  else if (frame.mime.includes('webp')) ext = '.webp';
  else if (frame.mime.includes('bmp')) ext = '.bmp';
  fs.mkdirSync(CAMERA_DIR, { recursive: true });
  const file = path.join(CAMERA_DIR, `camera-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  fs.writeFileSync(file, Buffer.from(frame.data, 'base64'));
  const cutoff = Date.now() - 24 * 3600 * 1000;
  try {
    for (const name of fs.readdirSync(CAMERA_DIR)) {
      const target = path.join(CAMERA_DIR, name);
      try {
        if (fs.statSync(target).mtimeMs < cutoff) fs.unlinkSync(target);
      } catch {
        /* another frame may already be gone */
      }
    }
  } catch {
    /* pruning is best-effort */
  }
  return { file, mime: frame.mime, data: frame.data, bytes: frame.bytes };
}

async function captureScreen(args = {}) {
  if (!ctx.screenshot) throw new Error('Screen capture is not connected.');
  const result = await ctx.screenshot(args);
  if (!result || result.ok === false) throw new Error((result && result.error) || 'Screen capture failed.');
  return result;
}

async function readScreenText(args = {}) {
  if (!ctx.ocr) throw new Error('OCR is not connected.');
  const result = await ctx.ocr(args);
  if (!result || result.ok === false) throw new Error((result && result.error) || 'OCR failed.');
  return {
    text: String(result.text || '').slice(0, 8000),
    lines: Array.isArray(result.lines) ? result.lines.slice(0, 200) : [],
    lang: result.lang || '',
    width: result.width || 0,
    height: result.height || 0,
    file: result.file || null,
    url: result.url || null,
  };
}

const VISION_SYSTEM =
  'You are ORVEX\'s computer-vision agent. Look at the image and answer the user\'s request precisely. ' +
  'Describe only what is visible. Read UI text exactly. If something is unreadable or cropped, say so. ' +
  'When you identify clickable controls, give their approximate screen coordinates only if the user asked for them.';

async function analyze(input = {}) {
  const prompt = clip(String(input.prompt || 'Describe this image and list the visible UI controls.'), 4000);
  const candidatesIn = normalizeCandidates([input.provider, ...(Array.isArray(input.candidates) ? input.candidates : [])]);
  const planned = ctx.planCandidates(candidatesIn, { task: 'vision', prompt, sensitive: !!input.sensitive });
  const candidates = (planned && planned.candidates) || candidatesIn;

  let image = null;
  let source = input.source || 'screen';
  let captured = null;
  if (input.dataUrl) {
    image = saveCameraFrame(input.dataUrl);
    source = 'camera';
  } else if (input.path) {
    image = readImageFile(input.path);
    source = 'file';
  } else {
    captured = await captureScreen(input.capture || {});
    const file = captured.file || captured.image;
    if (!file) throw new Error('The capture did not produce an image file.');
    image = readImageFile(file);
    source = 'screen';
  }

  let ocr = null;
  let ocrError = null;
  if (input.ocr !== false) {
    try {
      ocr = await readScreenText(input.path ? { path: input.path } : { path: image.file });
    } catch (err) {
      ocrError = err && err.message ? err.message : String(err);
    }
  }

  const base = {
    source,
    file: image.file || null,
    mime: image.mime,
    bytes: image.bytes,
    width: captured ? captured.width || null : null,
    height: captured ? captured.height || null : null,
    url: captured ? captured.url || null : null,
    ocr,
    ocrError,
  };

  if (!candidates.length) {
    return {
      ...base,
      analysis: null,
      model: null,
      note: 'No vision model is configured. OCR text from the image is returned; add a multimodal provider in Settings to get a model description.',
    };
  }

  const textPart = [
    prompt,
    ocr && ocr.text ? `\nWindows OCR text found in the image (may contain errors):\n${clip(ocr.text, 4000)}` : '',
  ].join('\n');
  try {
    const reply = await ctx.gateway.chat({
      candidates,
      system: VISION_SYSTEM,
      history: [{ role: 'user', text: textPart, images: [{ mime: image.mime, data: image.data }] }],
      task: 'vision',
      temperature: 0.2,
      maxTokens: 1600,
    });
    return {
      ...base,
      analysis: String(reply.text || '').trim(),
      model: reply.provider ? `${reply.provider.name} · ${reply.provider.model}` : null,
      note: null,
    };
  } catch (err) {
    return {
      ...base,
      analysis: null,
      model: null,
      note: `The vision model call failed: ${err && err.message ? err.message : String(err)}. OCR text is still shown.`,
    };
  }
}

module.exports = { init, captureScreen, readScreenText, analyze, readImageFile };
