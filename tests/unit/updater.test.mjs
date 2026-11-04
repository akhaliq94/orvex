import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const core = require('../../electron/update-core.cjs')

const digestFor = (text) => core.sha256Hex(Buffer.from(text))

describe('github repo parsing', () => {
  it('accepts owner/name and github URLs', () => {
    expect(core.normalizeRepo('orvex-org/orvex-releases')).toBe('orvex-org/orvex-releases')
    expect(core.normalizeRepo(' https://github.com/orvex-org/orvex-releases.git ')).toBe('orvex-org/orvex-releases')
    expect(core.normalizeRepo('https://www.github.com/a/b/')).toBe('a/b')
  })

  it('rejects traversal, extra segments and empty values', () => {
    expect(() => core.normalizeRepo('')).toThrow(/owner\/name/)
    expect(() => core.normalizeRepo('../etc/passwd')).toThrow(/owner\/name/)
    expect(() => core.normalizeRepo('a/b/c')).toThrow(/owner\/name/)
    expect(() => core.normalizeRepo('a/..')).toThrow(/owner\/name/)
    expect(() => core.normalizeRepo('a b/c')).toThrow(/owner\/name/)
  })

  it('builds the release API URL', () => {
    expect(core.apiUrl('a/b')).toBe('https://api.github.com/repos/a/b/releases/latest')
  })
})

describe('version comparison', () => {
  it('compares numeric parts, not strings', () => {
    expect(core.compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(core.compareVersions('v2.0.0', '2.0')).toBe(0)
    expect(core.compareVersions('1.0.0', '1.0.1')).toBe(-1)
  })

  it('sorts prereleases below their release', () => {
    expect(core.compareVersions('1.2.0-beta.2', '1.2.0')).toBe(-1)
    expect(core.compareVersions('1.2.0-beta.2', '1.2.0-beta.10')).toBe(-1)
    expect(core.compareVersions('1.2.0-rc.1', '1.2.0-beta.9')).toBe(1)
    expect(core.isNewer('1.0.1', '1.0.0')).toBe(true)
    expect(core.isNewer('1.0.0', '1.0.0')).toBe(false)
  })
})

describe('release assets', () => {
  const assets = [
    { name: 'ORVEX-Setup-1.2.0.exe', size: 90, url: 'https://example.test/setup.exe', digest: 'sha256:abc' },
    { name: 'ORVEX-Portable-1.2.0.exe', size: 80, url: 'https://example.test/portable.exe' },
    { name: 'SHA256SUMS.txt', size: 120, url: 'https://example.test/SHA256SUMS.txt' },
    { name: 'source.zip', size: 10, url: 'https://example.test/source.zip' },
  ]

  it('selects the setup build for an installed copy', () => {
    const picked = core.selectAsset(assets, { portable: false })
    expect(picked.asset.name).toBe('ORVEX-Setup-1.2.0.exe')
    expect(picked.checksums.name).toBe('SHA256SUMS.txt')
    expect(picked.missing).toBe('')
  })

  it('selects the portable build for a portable copy', () => {
    expect(core.selectAsset(assets, { portable: true }).asset.name).toBe('ORVEX-Portable-1.2.0.exe')
  })

  it('reports a release without the needed build', () => {
    const picked = core.selectAsset([assets[1]], { portable: false })
    expect(picked.asset).toBeNull()
    expect(picked.missing).toMatch(/setup/)
  })

  it('strips traversal from names and drops non-https assets', () => {
    const picked = core.selectAsset(
      [
        { name: '../evil.exe', size: 1, url: 'https://example.test/a.exe' },
        { name: 'ORVEX-Setup-1.exe', size: 1, url: 'http://example.test/b.exe' },
      ],
      { portable: false },
    )
    expect(picked.asset).toBeNull()
    expect(picked.assets).toHaveLength(1)
    expect(picked.assets[0].name).toBe('evil.exe')
  })

  it('classifies and sanitizes names', () => {
    expect(core.classifyAsset('ORVEX-Setup-1.0.0.exe')).toBe('setup')
    expect(core.classifyAsset('ORVEX-Portable-1.0.0.exe')).toBe('portable')
    expect(core.classifyAsset('notes.txt')).toBe('other')
    expect(core.safeFileName('..\\ORVEX Setup 1.exe')).toBe('ORVEX-Setup-1.exe')
    expect(core.safeFileName('script.bat')).toBe('')
  })
})

describe('checksum verification', () => {
  const text = 'hello update'
  const actual = digestFor(text)

  it('accepts a matching published digest', () => {
    const verdict = core.verifyHash({ name: 'a.exe', digest: `sha256:${actual}`, actual })
    expect(verdict.ok).toBe(true)
    expect(verdict.source).toBe('digest')
  })

  it('accepts a matching SHA256SUMS entry', () => {
    const sums = core.parseSums(`${'0'.repeat(64)}  other.exe\n${actual} *a.exe\n`)
    expect(core.findSums(sums, 'dir/a.exe')).toBe(actual)
    expect(core.verifyHash({ name: 'a.exe', sums, actual }).ok).toBe(true)
  })

  it('rejects a mismatched hash', () => {
    const verdict = core.verifyHash({ name: 'a.exe', digest: `sha256:${'1'.repeat(64)}`, actual })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/does not match/)
  })

  it('refuses to verify when nothing was published', () => {
    const verdict = core.verifyHash({ name: 'a.exe', actual })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/No SHA-256/)
  })

  it('ignores malformed sums lines', () => {
    expect(core.parseSums('not a hash  a.exe\nzzz  b.exe').size).toBe(0)
  })
})

describe('release normalization', () => {
  it('normalizes a GitHub latest-release payload', () => {
    const release = core.normalizeRelease(
      {
        tag_name: 'v1.3.0',
        name: 'ORVEX 1.3.0',
        html_url: 'https://github.com/a/b/releases/tag/v1.3.0',
        body: 'notes',
        published_at: '2026-11-01T00:00:00Z',
        assets: [{ name: 'ORVEX-Setup-1.3.0.exe', size: 5, url: 'https://example.test/s.exe', digest: `sha256:${'a'.repeat(64)}` }],
      },
      { current: '1.2.0' },
    )
    expect(release.latest).toBe('1.3.0')
    expect(release.available).toBe(true)
    expect(release.asset.kind).toBe('setup')
    expect(release.url).toContain('github.com')
  })

  it('marks an older tag as not available and rejects drafts', () => {
    const older = core.normalizeRelease({ tag_name: 'v1.0.0', assets: [] }, { current: '1.2.0' })
    expect(older.available).toBe(false)
    expect(() => core.normalizeRelease({ tag_name: 'v1.0.0', draft: true }, { current: '1.2.0' })).toThrow(/draft/)
    expect(() => core.normalizeRelease({ name: 'no tag' }, { current: '1.2.0' })).toThrow(/version tag/)
  })
})
