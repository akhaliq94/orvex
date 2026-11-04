'use strict';

/**
 * Pure helpers for the GitHub release updater: repo parsing, semver compare,
 * asset selection and SHA-256 checksum matching. No Electron or network access,
 * so every rule here is covered by unit tests.
 */

const crypto = require('node:crypto');

const REPO_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const SHA256 = /^[a-f0-9]{64}$/i;

function normalizeRepo(value) {
  let text = String(value || '').trim();
  if (!text) throw new Error('Set the GitHub repository as owner/name.');
  text = text.replace(/^https?:\/\/(www\.)?github\.com\//i, '');
  text = text.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  const parts = text.split('/');
  if (parts.length !== 2 || !parts.every((part) => REPO_SEGMENT.test(part) && part !== '.' && part !== '..')) {
    throw new Error('Use owner/name, for example orvex-org/orvex-releases.');
  }
  return `${parts[0]}/${parts[1]}`;
}

function apiUrl(repo) {
  return `https://api.github.com/repos/${normalizeRepo(repo)}/releases/latest`;
}

/** Numeric semver comparison; a prerelease sorts below its release. */
function compareVersions(a, b) {
  const parse = (value) => {
    const text = String(value || '').trim().replace(/^v/i, '');
    const [core, ...rest] = text.split('-');
    const nums = core.split('.').map((part) => {
      const n = Number.parseInt(part.replace(/[^0-9].*$/, ''), 10);
      return Number.isFinite(n) ? n : 0;
    });
    return { nums, pre: rest.join('-') };
  };
  const left = parse(a);
  const right = parse(b);
  const len = Math.max(left.nums.length, right.nums.length);
  for (let i = 0; i < len; i += 1) {
    const x = left.nums[i] || 0;
    const y = right.nums[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (left.pre && !right.pre) return -1;
  if (!left.pre && right.pre) return 1;
  if (left.pre === right.pre) return 0;
  const leftPre = left.pre.split('.');
  const rightPre = right.pre.split('.');
  const parts = Math.max(leftPre.length, rightPre.length);
  for (let i = 0; i < parts; i += 1) {
    if (leftPre[i] === undefined) return -1;
    if (rightPre[i] === undefined) return 1;
    const na = /^\d+$/.test(leftPre[i]) ? Number(leftPre[i]) : null;
    const nb = /^\d+$/.test(rightPre[i]) ? Number(rightPre[i]) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na > nb ? 1 : -1;
      continue;
    }
    if (na !== null) return -1;
    if (nb !== null) return 1;
    if (leftPre[i] !== rightPre[i]) return leftPre[i] > rightPre[i] ? 1 : -1;
  }
  return 0;
}

function isNewer(latest, current) {
  return compareVersions(latest, current) > 0;
}

function classifyAsset(name) {
  const base = String(name || '').toLowerCase();
  if (!base.endsWith('.exe')) return 'other';
  if (base.includes('setup') || base.includes('installer')) return 'setup';
  if (base.includes('portable')) return 'portable';
  return 'other';
}

function safeFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean && clean.toLowerCase().endsWith('.exe') ? clean : '';
}

function checksumName(name) {
  return /sha256sums|checksums?|sha256\.txt/i.test(String(name || ''));
}

/**
 * Pick the build that matches how this copy runs. A portable copy can never be
 * replaced while running, so it is told apart from the installed NSIS copy.
 */
function selectAsset(assets, { portable = false } = {}) {
  const list = (Array.isArray(assets) ? assets : [])
    .map((asset) => ({
      name: safeFileName(asset && asset.name),
      size: Number(asset && asset.size) || 0,
      url: String((asset && asset.url) || ''),
      digest: String((asset && asset.digest) || ''),
      kind: classifyAsset(asset && asset.name),
    }))
    .filter((asset) => asset.name && /^https:\/\//i.test(asset.url));
  const wanted = portable ? 'portable' : 'setup';
  const match = list.find((asset) => asset.kind === wanted) || null;
  const sums = (Array.isArray(assets) ? assets : []).find((asset) => checksumName(asset && asset.name));
  return {
    asset: match,
    assets: list,
    checksums: sums && /^https:\/\//i.test(String(sums.url || ''))
      ? { name: safeFileName(sums.name) || String(sums.name || ''), size: Number(sums.size) || 0, url: String(sums.url) }
      : null,
    missing: !match ? `This release has no ${wanted} .exe asset.` : '',
  };
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function digestHex(value) {
  const text = String(value || '').trim();
  const match = text.match(/^sha256:([a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : '';
}

/** Parse a SHA256SUMS-style file: `hex  name` or `hex *name`. */
function parseSums(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!match) continue;
    const name = match[2].trim().split(/[\\/]/).pop();
    if (name) map.set(name, match[1].toLowerCase());
  }
  return map;
}

function findSums(map, name) {
  const base = String(name || '').split(/[\\/]/).pop();
  if (!map || !base) return '';
  if (map instanceof Map) return map.get(base) || '';
  const value = map[base];
  return typeof value === 'string' ? value : '';
}

/**
 * Verify a downloaded file. A published checksum is mandatory: an unsigned
 * installer with no hash is never offered for install.
 */
function verifyHash({ name, digest = '', sums = null, actual }) {
  const expectedDigest = digestHex(digest);
  const expectedSums = findSums(sums, name);
  const expected = expectedDigest || expectedSums;
  const actualHex = String(actual || '').toLowerCase();
  if (!expected) {
    return { ok: false, expected: '', actual: actualHex, source: '', reason: 'No SHA-256 checksum was published for this file.' };
  }
  if (!SHA256.test(actualHex)) {
    return { ok: false, expected, actual: actualHex, source: expectedDigest ? 'digest' : 'sums', reason: 'The downloaded file did not hash to a valid SHA-256 value.' };
  }
  const ok = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actualHex, 'hex'));
  return {
    ok,
    expected,
    actual: actualHex,
    source: expectedDigest ? 'digest' : 'sums',
    reason: ok ? '' : 'The downloaded file does not match the published SHA-256 checksum.',
  };
}

/** Normalize the GitHub "latest release" payload; drafts are never returned anyway. */
function normalizeRelease(json, { current, portable = false } = {}) {
  if (!json || typeof json !== 'object') throw new Error('GitHub did not return a release object.');
  if (json.draft) throw new Error('The latest release is still a draft.');
  const tag = String(json.tag_name || json.name || '').trim().replace(/^v/i, '');
  if (!tag || !/^\d+(\.\d+)*/.test(tag)) throw new Error('The release did not include a version tag.');
  const picked = selectAsset(json.assets, { portable });
  return {
    latest: tag,
    available: isNewer(tag, current),
    name: String(json.name || tag),
    url: String(json.html_url || ''),
    notes: String(json.body || '').slice(0, 6000),
    publishedAt: String(json.published_at || ''),
    prerelease: !!json.prerelease,
    assets: picked.assets,
    asset: picked.asset,
    checksums: picked.checksums,
    missing: picked.missing,
  };
}

module.exports = {
  normalizeRepo,
  apiUrl,
  compareVersions,
  isNewer,
  classifyAsset,
  safeFileName,
  selectAsset,
  sha256Hex,
  digestHex,
  parseSums,
  findSums,
  verifyHash,
  normalizeRelease,
};
