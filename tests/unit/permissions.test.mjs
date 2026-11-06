import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const permissions = require('../../electron/permissions.cjs')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-perm-'))
permissions.init({ dataDir: dir, registry: () => [{ name: 'shell_exec', description: 'run a command' }, { name: 'fs_write', description: 'write a file' }] })

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const storedFloors = () => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'permissions.json'), 'utf8'))
    return Array.isArray(raw.floors) ? raw.floors : []
  } catch {
    return []
  }
}

describe('approval floors', () => {
  it('starts with no floors', () => {
    expect(permissions.state().floors).toEqual([])
    expect(permissions.floorReason('shell_exec', { command: 'dir' })).toBeNull()
  })

  it('matches a specific tool case-insensitively', () => {
    permissions.addFloor({ tool: 'shell_exec', pattern: 'rm\\s+-rf', note: 'no recursive delete' })
    expect(permissions.floorReason('shell_exec', { command: 'RM -RF /tmp/x' })).toContain('no recursive delete')
    expect(permissions.floorReason('fs_write', { command: 'rm -rf /tmp/x' })).toBeNull()
  })

  it('matches every tool with a wildcard floor', () => {
    permissions.addFloor({ tool: '*', pattern: '\\.env\\b', note: 'env files' })
    expect(permissions.floorReason('fs_write', { path: 'C:/app/.env' })).toContain('env files')
    expect(permissions.floorReason('shell_exec', { command: 'type .env' })).toContain('env files')
  })

  it('rejects an invalid regular expression', () => {
    expect(() => permissions.addFloor({ tool: 'shell_exec', pattern: '([' })).toThrow(/valid regular expression/)
  })

  it('rejects a duplicate floor', () => {
    expect(() => permissions.addFloor({ tool: 'shell_exec', pattern: 'rm\\s+-rf', note: 'again' })).toThrow(/already exists/)
  })

  it('keeps floors when a tool policy is reset', () => {
    permissions.setPolicy({ tool: 'shell_exec', policy: 'deny' })
    permissions.reset()
    expect(permissions.state().floors.length).toBe(2)
  })

  it('removes a floor by id', () => {
    const floor = permissions.state().floors.find((f) => f.note === 'no recursive delete')
    const next = permissions.removeFloor(floor.id)
    expect(next.removed).toBe(true)
    expect(permissions.floorReason('shell_exec', { command: 'rm -rf /' })).toBeNull()
  })

  it('persists floors to disk', async () => {
    // The store is debounced, so wait for the file to appear instead of a fixed sleep.
    await expect.poll(() => storedFloors().length, { timeout: 10000 }).toBe(1)
    permissions.init({ dataDir: dir, registry: () => [] })
    const floors = permissions.state().floors
    expect(floors.length).toBe(1)
    expect(floors[0].pattern).toBe('\\.env\\b')
  })

  it('ignores a damaged stored floor instead of failing to load', () => {
    const file = path.join(dir, 'permissions.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    raw.floors.push({ tool: 'shell_exec', pattern: '(' })
    fs.writeFileSync(file, JSON.stringify(raw), 'utf8')
    permissions.init({ dataDir: dir, registry: () => [] })
    expect(permissions.state().floors.length).toBe(1)
  })
})
