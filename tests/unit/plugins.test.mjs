import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const plugins = require('../../electron/plugins.cjs')

const dir = path.resolve('C:/orvex-test/plugin')

function manifest(permissions) {
  return {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    entry: 'index.cjs',
    tools: [{ name: 'hello', description: 'Say hello' }],
    ...(permissions === undefined ? {} : { permissions }),
  }
}

describe('plugin network permission', () => {
  it('blocks the network unless the manifest declares it', () => {
    expect(plugins.normalizeNetworkPermission(undefined)).toEqual({ mode: 'none', hosts: [] })
    expect(plugins.normalizeNetworkPermission(false)).toEqual({ mode: 'none', hosts: [] })
    expect(plugins.normalizeNetworkPermission('none')).toEqual({ mode: 'none', hosts: [] })
    expect(plugins.normalizeNetworkPermission(true)).toEqual({ mode: 'any', hosts: [] })
    expect(plugins.normalizeNetworkPermission('any')).toEqual({ mode: 'any', hosts: [] })
  })

  it('normalizes a host allowlist and wildcards', () => {
    expect(plugins.normalizeNetworkPermission(['API.Example.com', ' *.example.org ', 'api.example.com'])).toEqual({
      mode: 'hosts',
      hosts: ['api.example.com', '*.example.org'],
    })
    expect(plugins.normalizeNetworkPermission('api.example.com, cdn.example.com')).toEqual({
      mode: 'hosts',
      hosts: ['api.example.com', 'cdn.example.com'],
    })
  })

  it('rejects malformed allowlists', () => {
    expect(() => plugins.normalizeNetworkPermission(42)).toThrow(/permissions\.network/)
    expect(() => plugins.normalizeNetworkPermission([])).toThrow(/no hostnames/i)
    expect(() => plugins.normalizeNetworkPermission(['https://example.com'])).toThrow(/invalid hostname/i)
    expect(() => plugins.normalizeNetworkPermission(['exa mple.com'])).toThrow(/invalid hostname/i)
    expect(() => plugins.normalizeNetworkPermission(Array.from({ length: 51 }, (_, i) => `h${i}.test`))).toThrow(/50/)
  })

  it('records blocked, allowlisted and unrestricted network in the manifest', () => {
    expect(plugins.validateManifest(manifest(), dir).permissions).toMatchObject({ networkMode: 'none', network: 'none' })
    expect(plugins.validateManifest(manifest({ network: ['api.example.com'] }), dir).permissions).toMatchObject({
      networkMode: 'hosts',
      network: ['api.example.com'],
    })
    expect(plugins.validateManifest(manifest({ network: 'any' }), dir).permissions).toMatchObject({ networkMode: 'any', network: 'any' })
  })

  it('keeps plugins installed before the policy unrestricted', () => {
    expect(plugins.normalizeNetworkPermission('not restricted by the sandbox')).toEqual({ mode: 'any', hosts: [] })
  })
})
