import { createRequire } from 'node:module'
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const catalog = require('../../electron/catalog.cjs')

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  }
}

const plugins = [
  { id: 'demo', name: 'Demo', version: '1.0.0', url: 'https://example.com/demo.zip', sha256: 'a'.repeat(64) },
]

describe('signed catalogs', () => {
  it('round-trips a signed payload with the right key', () => {
    const keys = keypair()
    const envelope = catalog.signCatalog(plugins, { privateKeyPem: keys.privateKeyPem, keyId: 'test-key', generatedAt: '2026-01-01T00:00:00.000Z' })
    const trusted = catalog.parseTrustedKeys(JSON.stringify([{ keyId: 'test-key', publicKey: keys.publicKeyPem }]))
    const result = catalog.verifyEnvelope(envelope, trusted)
    expect(result.ok).toBe(true)
    expect(result.signed).toBe(true)
    expect(result.keyId).toBe('test-key')
    expect(result.plugins).toEqual(plugins)
    expect(result.generatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(result.fingerprint).toMatch(/^[a-f0-9]{16}$/)
  })

  it('rejects a tampered payload', () => {
    const keys = keypair()
    const envelope = catalog.signCatalog(plugins, { privateKeyPem: keys.privateKeyPem, keyId: 'k' })
    envelope.payload = envelope.payload.replace('Demo', 'Evil')
    const trusted = catalog.parseTrustedKeys(keys.publicKeyPem)
    const result = catalog.verifyEnvelope(envelope, trusted)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/signature/i)
  })

  it('rejects a signature from a different key', () => {
    const signer = keypair()
    const other = keypair()
    const envelope = catalog.signCatalog(plugins, { privateKeyPem: signer.privateKeyPem, keyId: 'k' })
    const result = catalog.verifyEnvelope(envelope, catalog.parseTrustedKeys(other.publicKeyPem))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/does not match/i)
  })

  it('refuses a signed catalog when no key is trusted', () => {
    const keys = keypair()
    const envelope = catalog.signCatalog(plugins, { privateKeyPem: keys.privateKeyPem, keyId: 'k' })
    const result = catalog.verifyEnvelope(envelope, [])
    expect(result.ok).toBe(false)
    expect(result.signed).toBe(true)
    expect(result.error).toMatch(/no trusted catalog key/i)
  })

  it('names the unknown key id', () => {
    const keys = keypair()
    const envelope = catalog.signCatalog(plugins, { privateKeyPem: keys.privateKeyPem, keyId: 'signing-key' })
    const result = catalog.verifyEnvelope(envelope, catalog.parseTrustedKeys(JSON.stringify({ other: keys.publicKeyPem })))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/unknown key "signing-key"/)
  })

  it('accepts legacy unsigned catalogs and marks them unsigned', () => {
    expect(catalog.verifyEnvelope(plugins, []).signed).toBe(false)
    const listed = catalog.verifyEnvelope({ plugins }, [])
    expect(listed.ok).toBe(true)
    expect(listed.plugins).toEqual(plugins)
  })

  it('rejects a partial envelope', () => {
    const result = catalog.verifyEnvelope({ payload: '{}' }, [])
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/partial signature/i)
  })

  it('rejects a signed payload with the wrong schema', () => {
    const keys = keypair()
    const payload = JSON.stringify({ schema: 'other/1', plugins })
    const envelope = { schema: catalog.SCHEMA, payload, keyId: 'k', signature: catalog.signPayload(payload, keys.privateKeyPem) }
    const result = catalog.verifyEnvelope(envelope, catalog.parseTrustedKeys(keys.publicKeyPem))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/orvex\.catalog\/1/)
  })
})

describe('trusted key parsing', () => {
  it('accepts a PEM, a JSON array and a keyed JSON object', () => {
    const keys = keypair()
    expect(catalog.parseTrustedKeys(keys.publicKeyPem)).toHaveLength(1)
    expect(catalog.parseTrustedKeys(JSON.stringify([{ keyId: 'a', publicKey: keys.publicKeyPem }]))[0].keyId).toBe('a')
    const mapped = catalog.parseTrustedKeys(JSON.stringify({ b: keys.publicKeyPem }))
    expect(mapped[0]).toMatchObject({ keyId: 'b' })
    expect(mapped[0].fingerprint).toBe(catalog.fingerprint(keys.publicKeyPem))
  })

  it('rejects RSA keys, garbage and empty input', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' })
    expect(catalog.parseTrustedKeys(rsa)).toEqual([])
    expect(catalog.parseTrustedKeys('not a key')).toEqual([])
    expect(catalog.parseTrustedKeys('')).toEqual([])
  })

  it('never exposes the public key in the view', () => {
    const keys = keypair()
    const view = catalog.publicKeyView(catalog.parseTrustedKeys(keys.publicKeyPem))
    expect(view).toEqual([{ keyId: 'key-1', fingerprint: catalog.fingerprint(keys.publicKeyPem) }])
    expect(JSON.stringify(view)).not.toContain('BEGIN PUBLIC KEY')
  })
})
