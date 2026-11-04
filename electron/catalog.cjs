'use strict';

/**
 * Signed plugin catalog envelopes.
 *
 * The builder signs the exact payload string with Ed25519, so verification
 * never depends on JSON key order. A catalog is only accepted when its
 * signature matches a public key the user has trusted locally; an unsigned
 * catalog is reported as unsigned and can be refused with a setting.
 */

const crypto = require('node:crypto');

const SCHEMA = 'orvex.catalog/1';

function fingerprint(publicKeyPem) {
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    const der = key.export({ type: 'spki', format: 'der' });
    return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

function isEd25519(publicKeyPem) {
  try {
    return crypto.createPublicKey(publicKeyPem).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

function normalizeKeyEntry(entry, index) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    const pem = entry.trim();
    if (!pem.includes('BEGIN PUBLIC KEY')) return null;
    if (!isEd25519(pem)) return null;
    return { keyId: `key-${index + 1}`, publicKey: pem, fingerprint: fingerprint(pem), auto: true };
  }
  if (typeof entry === 'object') {
    const pem = String(entry.publicKey || entry.key || entry.pem || '').trim();
    if (!pem || !isEd25519(pem)) return null;
    const explicit = String(entry.keyId || entry.id || '').trim();
    return {
      keyId: (explicit || `key-${index + 1}`).slice(0, 64),
      publicKey: pem,
      fingerprint: fingerprint(pem),
      auto: !explicit,
    };
  }
  return null;
}

/** Accepts a PEM, a JSON array, or a JSON object keyed by key id. */
function parseTrustedKeys(input) {
  const text = String(input || '').trim();
  if (!text) return [];
  const looksJson = text.startsWith('[') || text.startsWith('{');
  if (!looksJson) return text.includes('BEGIN PUBLIC KEY') ? [normalizeKeyEntry(text, 0)].filter(Boolean) : [];
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (Array.isArray(data)) return data.map(normalizeKeyEntry).filter(Boolean);
  if (data && typeof data === 'object') {
    return Object.entries(data)
      .map(([keyId, value], index) => normalizeKeyEntry({ keyId, publicKey: value }, index))
      .filter(Boolean);
  }
  return [];
}

function publicKeyView(keys) {
  return (keys || []).map((key) => ({ keyId: key.keyId, fingerprint: key.fingerprint }));
}

function buildPayload(plugins, generatedAt) {
  return JSON.stringify({
    schema: SCHEMA,
    generatedAt: String(generatedAt || new Date().toISOString()),
    plugins: Array.isArray(plugins) ? plugins : [],
  });
}

function signPayload(payload, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The catalog signing key must be Ed25519.');
  return crypto.sign(null, Buffer.from(payload, 'utf8'), key).toString('base64');
}

function signCatalog(plugins, opts = {}) {
  if (!opts.privateKeyPem) throw new Error('A private key is required to sign a catalog.');
  const payload = buildPayload(plugins, opts.generatedAt);
  return {
    schema: SCHEMA,
    payload,
    keyId: String(opts.keyId || 'orvex-catalog').slice(0, 64),
    signature: signPayload(payload, opts.privateKeyPem),
  };
}

function verifyPayload(payload, signature, publicKeyPem) {
  try {
    return crypto.verify(null, Buffer.from(payload, 'utf8'), crypto.createPublicKey(publicKeyPem), Buffer.from(String(signature), 'base64'));
  } catch {
    return false;
  }
}

/**
 * Returns { ok, signed, plugins, keyId, fingerprint, error }.
 * Unsigned shapes (a bare array or { plugins }) stay supported.
 */
function verifyEnvelope(raw, trustedKeys = []) {
  if (Array.isArray(raw)) return { ok: true, signed: false, plugins: raw, keyId: null, fingerprint: null, error: null };
  if (!raw || typeof raw !== 'object') return { ok: false, signed: false, plugins: [], keyId: null, fingerprint: null, error: 'The catalog is not a JSON object or array.' };
  const payload = typeof raw.payload === 'string' ? raw.payload : '';
  const signature = typeof raw.signature === 'string' ? raw.signature : '';
  if (!payload && !signature) {
    const list = Array.isArray(raw.plugins) ? raw.plugins : [];
    return { ok: true, signed: false, plugins: list, keyId: null, fingerprint: null, error: null };
  }
  if (!payload || !signature) {
    return { ok: false, signed: false, plugins: [], keyId: null, fingerprint: null, error: 'The catalog has a partial signature envelope.' };
  }
  const keyId = String(raw.keyId || '').trim();
  const keys = Array.isArray(trustedKeys) ? trustedKeys : [];
  if (!keys.length) {
    return {
      ok: false,
      signed: true,
      plugins: [],
      keyId,
      fingerprint: null,
      error: `The catalog is signed with key "${keyId || 'unknown'}", but no trusted catalog key is configured. Add its public key first.`,
    };
  }
  // A key pasted without an id is still trusted for any catalog key id.
  const candidates = keys.filter((key) => key.auto || !keyId || key.keyId === keyId);
  if (!candidates.length) {
    return {
      ok: false,
      signed: true,
      plugins: [],
      keyId,
      fingerprint: null,
      error: `The catalog is signed with unknown key "${keyId}". Trusted keys: ${keys.map((key) => `${key.keyId} (${key.fingerprint})`).join(', ')}.`,
    };
  }
  const hit = candidates.find((key) => verifyPayload(payload, signature, key.publicKey));
  if (!hit) {
    return {
      ok: false,
      signed: true,
      plugins: [],
      keyId,
      fingerprint: candidates[0].fingerprint,
      error: 'The catalog signature does not match any trusted key. Nothing was loaded.',
    };
  }
  let body;
  try {
    body = JSON.parse(payload);
  } catch {
    return { ok: false, signed: true, plugins: [], keyId, fingerprint: hit.fingerprint, error: 'The signed catalog payload is not valid JSON.' };
  }
  if (!body || body.schema !== SCHEMA || !Array.isArray(body.plugins)) {
    return { ok: false, signed: true, plugins: [], keyId, fingerprint: hit.fingerprint, error: `The signed payload is not a ${SCHEMA} catalog.` };
  }
  return { ok: true, signed: true, plugins: body.plugins, keyId: hit.keyId, fingerprint: hit.fingerprint, generatedAt: body.generatedAt || null, error: null };
}

module.exports = {
  SCHEMA,
  parseTrustedKeys,
  publicKeyView,
  buildPayload,
  signPayload,
  signCatalog,
  verifyPayload,
  verifyEnvelope,
  fingerprint,
};
