'use strict';

/**
 * One encrypted secret store for provider keys, integration credentials and
 * OAuth tokens. Values are encrypted with Electron safeStorage (DPAPI on
 * Windows) and written to a single owner-only JSON file.
 */

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { safeStorage } = require('electron');

let file = null;
let cache = null;
/** Entries that failed to decrypt are kept byte-for-byte and written back. */
let undecryptable = null;

function init(opts = {}) {
  file = opts.file || file;
  cache = null;
  undecryptable = null;
}

function available() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

async function load() {
  if (cache) return cache;
  const map = {};
  const failed = {};
  if (!file) {
    undecryptable = failed;
    return (cache = map);
  }
  try {
    const data = JSON.parse(await fsp.readFile(file, 'utf8'));
    for (const [id, b64] of Object.entries(data)) {
      try {
        map[id] = safeStorage.decryptString(Buffer.from(String(b64), 'base64'));
      } catch {
        // Another OS user (or a rotated key) produced this entry. Keep the
        // ciphertext so saving unrelated secrets cannot delete it.
        failed[id] = String(b64);
      }
    }
  } catch {
    /* no secrets yet */
  }
  undecryptable = failed;
  cache = map;
  return map;
}

async function save(map) {
  if (!file) throw new Error('The secret vault is not initialised.');
  if (!available()) throw new Error('OS encryption is not available on this machine.');
  const out = {};
  for (const [id, value] of Object.entries(map)) {
    if (!value) continue;
    out[id] = safeStorage.encryptString(String(value)).toString('base64');
  }
  for (const [id, encrypted] of Object.entries(undecryptable || {})) {
    if (!(id in out)) out[id] = encrypted;
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // Write to a sibling file first, then rename, so a crash mid-write cannot
  // leave a truncated secrets file.
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(out), 'utf8');
  await fsp.rename(tmp, file);
  cache = { ...map };
}

async function get(id) {
  const map = await load();
  return map[id] ?? null;
}

/** Synchronous read from the already-decrypted cache — never touches disk. */
function peek(id) {
  if (!cache) return null;
  return cache[id] ?? null;
}

/** Presence check without decrypting or returning the value. */
function has(id) {
  return !!(cache && cache[id]);
}

async function set(id, value) {
  const map = await load();
  if (value == null || value === '') {
    delete map[id];
    if (undecryptable) delete undecryptable[id];
  } else {
    map[id] = String(value);
    if (undecryptable) delete undecryptable[id];
  }
  await save(map);
  return true;
}

async function remove(id) {
  return set(id, null);
}

async function getJson(id) {
  const raw = await get(id);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function setJson(id, value) {
  return set(id, value == null ? null : JSON.stringify(value));
}

function fileInfo() {
  return { file, exists: !!file && fs.existsSync(file), encrypted: available() };
}

/** Names only — never decrypts or returns a value. */
async function list() {
  const ids = new Set();
  if (file) {
    try {
      const data = JSON.parse(await fsp.readFile(file, 'utf8'));
      for (const id of Object.keys(data || {})) ids.add(id);
    } catch {
      /* no vault yet */
    }
  }
  if (cache) for (const id of Object.keys(cache)) ids.add(id);
  let bytes = 0;
  let updatedAt = null;
  if (file) {
    try {
      const st = await fsp.stat(file);
      bytes = st.size;
      updatedAt = st.mtimeMs;
    } catch {
      /* no file */
    }
  }
  return {
    file: file ? path.basename(file) : null,
    exists: !!file && fs.existsSync(file),
    encrypted: available(),
    bytes,
    updatedAt,
    ids: [...ids].sort(),
    count: ids.size,
  };
}

module.exports = { init, load, save, get, peek, has, set, remove, getJson, setJson, available, fileInfo, list };
