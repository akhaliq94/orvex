import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const tools = require('../../electron/tools.cjs')

let root = ''
let outputDir = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-spill-'))
  outputDir = path.join(root, 'tool-outputs')
  tools.init({ auditFile: path.join(root, 'audit.jsonl'), outputDir })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function writeLong(name, body) {
  const file = path.join(root, name)
  fs.writeFileSync(file, body, 'utf8')
  return file
}

describe('long tool output spill', () => {
  it('saves the full text and returns a readable path', async () => {
    const marker = 'LAST-LINE-MARKER-9f3a'
    const body = `${'row of real output\n'.repeat(1600)}${marker}\n`
    const file = writeLong('long.txt', body)
    const result = await tools.runTool('fs_read', { path: file }, { runId: 'spill_run' })
    expect(result.ok).toBe(true)
    expect(result.output).toMatch(/full text saved at/i)
    const saved = result.output.match(/saved at (.+?) — use fs_read/i)
    expect(saved).not.toBeNull()
    const savedPath = saved[1]
    expect(fs.existsSync(savedPath)).toBe(true)
    expect(fs.readFileSync(savedPath, 'utf8')).toContain(marker)
  })

  it('does not write outputs that look like credentials', async () => {
    const body = `${'normal log line\n'.repeat(1200)}sk-proj-ABCDEFGHIJKLMNOPQRSTUV\n`
    const file = writeLong('secret.txt', body)
    const result = await tools.runTool('fs_read', { path: file }, { runId: 'spill_run' })
    expect(result.ok).toBe(true)
    expect(result.output).toMatch(/not saved to disk/i)
    const savedFiles = fs.existsSync(outputDir)
      ? fs.readdirSync(outputDir).flatMap((run) => fs.readdirSync(path.join(outputDir, run)))
      : []
    expect(savedFiles).toEqual([])
  })

  it('keeps short output inline and creates no file', async () => {
    const file = writeLong('short.txt', 'small\n')
    const result = await tools.runTool('fs_read', { path: file }, { runId: 'spill_run' })
    expect(result.ok).toBe(true)
    expect(result.output).not.toMatch(/saved at/i)
    expect(fs.existsSync(outputDir)).toBe(false)
  })

  it('prunes spill files older than the retention window', () => {
    const dir = path.join(outputDir, 'old_run')
    fs.mkdirSync(dir, { recursive: true })
    const old = path.join(dir, 'old.txt')
    fs.writeFileSync(old, 'old output', 'utf8')
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    fs.utimesSync(old, eightDaysAgo, eightDaysAgo)
    tools.init({ auditFile: path.join(root, 'audit.jsonl'), outputDir })
    expect(fs.existsSync(old)).toBe(false)
  })
})
