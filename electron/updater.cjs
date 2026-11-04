'use strict';

/**
 * GitHub release updater. Checks the public `owner/name` repository, downloads
 * the installer that matches this copy (NSIS setup or portable exe), verifies
 * the published SHA-256, and only then offers a consented install. Nothing is
 * installed or launched without an explicit user action.
 */

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const db = require('./db.cjs');
const core = require('./update-core.cjs');

const REPO_KEY = 'updater.repo';
const AUTO_KEY = 'updater.autoCheck';
const LAST_KEY = 'updater.last';
const MAX_ASSET_BYTES = 512 * 1024 * 1024;
const MAX_SUMS_BYTES = 1024 * 1024;

let ctx = {
  dataDir: '',
  version: () => '0.0.0',
  isPackaged: false,
  portable: false,
  fetchImpl: null,
  emit: () => {},
  shell: null,
  quit: () => {},
  spawn: null,
};

function init(next = {}) {
  ctx = { ...ctx, ...next, fetchImpl: next.fetchImpl || (typeof fetch === 'function' ? fetch : null) };
}

function versionOf() {
  try {
    return String(typeof ctx.version === 'function' ? ctx.version() : ctx.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function readLast() {
  try {
    const raw = db.getSetting(LAST_KEY, null);
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeLast(value) {
  db.setSetting(LAST_KEY, value || '');
}

function repoOf() {
  return String(db.getSetting(REPO_KEY, '') || '');
}

function autoCheckOf() {
  return db.getSetting(AUTO_KEY, true) !== false;
}

function state() {
  return {
    repo: repoOf(),
    autoCheck: autoCheckOf(),
    current: versionOf(),
    portable: !!ctx.portable,
    packaged: !!ctx.isPackaged,
    last: readLast(),
  };
}

function setRepo({ repo } = {}) {
  const value = String(repo || '').trim();
  const normalized = value ? core.normalizeRepo(value) : '';
  db.setSetting(REPO_KEY, normalized);
  if (!normalized) writeLast(null);
  return state();
}

function setAutoCheck({ enabled } = {}) {
  db.setSetting(AUTO_KEY, enabled !== false);
  return state();
}

function apiHeaders() {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'ORVEX-Updater',
  };
}

async function check({ repo } = {}) {
  if (repo !== undefined) setRepo({ repo });
  const configured = repoOf();
  const current = versionOf();
  const base = { current, portable: !!ctx.portable, checkedAt: Date.now() };
  if (!configured) {
    const result = { ...base, ok: false, configured: false, available: false, latest: null, error: 'Set the GitHub repository as owner/name.' };
    writeLast(result);
    return result;
  }
  if (!ctx.fetchImpl) {
    const result = { ...base, ok: false, configured: true, available: false, latest: null, error: 'This runtime has no fetch implementation.' };
    writeLast(result);
    return result;
  }

  let result;
  const url = core.apiUrl(configured);
  try {
    const response = await ctx.fetchImpl(url, { headers: apiHeaders(), redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    if (response.status === 404) throw new Error(`No public release was found in ${configured}. Check the repository name and that it is public.`);
    if (response.status === 403) {
      const remaining = response.headers && response.headers.get ? response.headers.get('x-ratelimit-remaining') : null;
      throw new Error(remaining === '0' ? 'GitHub rate limit reached. Try again in an hour.' : `GitHub refused the request (403) for ${configured}.`);
    }
    if (!response.ok) throw new Error(`GitHub responded ${response.status}.`);
    const json = await response.json();
    const release = core.normalizeRelease(json, { current, portable: !!ctx.portable });
    const previous = readLast();
    result = {
      ...base,
      ok: true,
      configured: true,
      latest: release.latest,
      available: release.available,
      name: release.name,
      url: release.url,
      notes: release.notes,
      publishedAt: release.publishedAt,
      prerelease: release.prerelease,
      assets: release.assets,
      asset: release.asset,
      checksums: release.checksums,
      missing: release.missing,
      error: null,
      // A download prepared for an older check no longer applies.
      download: previous && previous.download && previous.latest === release.latest ? previous.download : null,
    };
  } catch (err) {
    result = {
      ...base,
      ok: false,
      configured: true,
      available: false,
      latest: null,
      name: '',
      url: '',
      notes: '',
      publishedAt: '',
      prerelease: false,
      assets: [],
      asset: null,
      checksums: null,
      missing: '',
      download: null,
      error: err && err.message ? err.message : String(err),
    };
  }
  writeLast(result);
  ctx.emit({ phase: 'check', result });
  return result;
}

async function fetchSums(checksums) {
  if (!checksums || !checksums.url) return null;
  const response = await ctx.fetchImpl(checksums.url, {
    headers: { accept: 'text/plain', 'user-agent': 'ORVEX-Updater' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`The checksum file responded ${response.status}.`);
  const text = String(await response.text()).slice(0, MAX_SUMS_BYTES);
  return core.parseSums(text);
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function download() {
  const last = readLast();
  if (!last || !last.ok) throw new Error('Check for a release first.');
  if (!last.available) throw new Error(`${versionOf()} is already the latest version.`);
  const asset = last.asset;
  if (!asset) throw new Error(last.missing || 'This release has no installer for this copy of ORVEX.');
  if (!last.checksums && !core.digestHex(asset.digest)) {
    throw new Error('This release publishes no SHA-256 checksum, so the download cannot be verified.');
  }
  if (!ctx.fetchImpl) throw new Error('This runtime has no fetch implementation.');
  if (!ctx.dataDir) throw new Error('The update folder is not available.');

  const dir = path.join(ctx.dataDir, 'updates');
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, asset.name);
  const part = `${target}.part`;
  await fsp.rm(part, { force: true });

  const sums = last.checksums ? await fetchSums(last.checksums) : null;
  const response = await ctx.fetchImpl(asset.url, {
    headers: { accept: 'application/octet-stream', 'user-agent': 'ORVEX-Updater' },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) throw new Error(`The download responded ${response.status}.`);
  const total = Number(response.headers && response.headers.get ? response.headers.get('content-length') : 0) || Number(asset.size) || 0;
  if (total > MAX_ASSET_BYTES) throw new Error('The release asset is larger than the 512 MB update limit.');

  const handle = await fsp.open(part, 'w');
  let received = 0;
  let emitAt = 0;
  const progress = (force = false) => {
    const now = Date.now();
    if (!force && now - emitAt < 200) return;
    emitAt = now;
    const pct = total > 0 ? Math.min(100, Math.round((received / total) * 1000) / 10) : null;
    ctx.emit({ phase: 'download', name: asset.name, received, total, pct });
  };
  try {
    progress(true);
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_ASSET_BYTES) throw new Error('The download exceeded the 512 MB update limit.');
      await handle.write(Buffer.from(value));
      progress();
    }
  } catch (err) {
    await handle.close().catch(() => {});
    await fsp.rm(part, { force: true }).catch(() => {});
    throw err;
  }
  await handle.close();

  const actual = await hashFile(part);
  const verdict = core.verifyHash({ name: asset.name, digest: asset.digest, sums, actual });
  if (!verdict.ok) {
    await fsp.rm(part, { force: true }).catch(() => {});
    throw new Error(verdict.reason);
  }
  await fsp.rm(target, { force: true }).catch(() => {});
  await fsp.rename(part, target);

  const downloadInfo = {
    status: 'ready',
    name: asset.name,
    path: target,
    bytes: received,
    verified: true,
    hash: actual,
    hashSource: verdict.source,
    at: Date.now(),
  };
  const next = { ...last, download: downloadInfo };
  writeLast(next);
  ctx.emit({ phase: 'ready', download: downloadInfo });
  return { download: downloadInfo, state: state() };
}

async function install() {
  const last = readLast();
  const info = last && last.download;
  if (!info || info.status !== 'ready' || !info.verified) throw new Error('Download and verify an update first.');
  if (process.platform !== 'win32') throw new Error('Automatic install is only implemented for Windows builds.');
  if (!ctx.isPackaged) throw new Error('Install is disabled in a development build; run the packaged ORVEX build to update it.');
  try {
    await fsp.access(info.path);
  } catch {
    throw new Error('The downloaded installer is no longer on disk. Download it again.');
  }
  if (!ctx.spawn) throw new Error('The installer cannot be launched in this runtime.');

  if (last.asset && last.asset.kind === 'portable') {
    if (ctx.shell && ctx.shell.showItemInFolder) ctx.shell.showItemInFolder(info.path);
    return {
      installed: false,
      revealed: true,
      note: 'A portable copy cannot replace itself while running. The verified exe is shown in Explorer; close ORVEX and swap it in.',
    };
  }

  const child = ctx.spawn(info.path, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  ctx.emit({ phase: 'install', name: info.name });
  setTimeout(() => {
    try {
      ctx.quit();
    } catch {
      /* the installer continues even if quit fails */
    }
  }, 1500);
  return { installed: true, revealed: false, note: 'The installer is running silently; ORVEX closes to let it replace the files.' };
}

function reveal() {
  const last = readLast();
  const info = last && last.download;
  if (!info || !info.path) throw new Error('Nothing has been downloaded yet.');
  if (ctx.shell && ctx.shell.showItemInFolder) ctx.shell.showItemInFolder(info.path);
  return { path: info.path };
}

async function openRelease() {
  const last = readLast();
  const url = last && /^https:\/\/github\.com\//i.test(String(last.url || '')) ? String(last.url) : '';
  if (!url || !ctx.shell || !ctx.shell.openExternal) throw new Error('There is no GitHub release page to open.');
  await ctx.shell.openExternal(url);
  return { url };
}

/** Boot check: silent, and only when the user allowed it and a repo is set. */
async function autoCheck() {
  if (!ctx.isPackaged || !autoCheckOf() || !repoOf()) return null;
  const result = await check();
  if (result.ok && result.available) {
    ctx.emit({ phase: 'available', result });
  }
  return result;
}

module.exports = {
  init,
  state,
  setRepo,
  setAutoCheck,
  check,
  download,
  install,
  reveal,
  openRelease,
  autoCheck,
};
