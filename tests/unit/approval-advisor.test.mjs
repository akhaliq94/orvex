import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const advisor = require('../../electron/approval-advisor.cjs')

let dir = null

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-esc-'))
  advisor._reset()
  advisor.init({ dataDir: dir })
})

afterEach(() => {
  advisor._reset()
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* temp cleanup */
  }
})

describe('escalation-only approval advisor', () => {
  it('has no API that can approve, allow or relax a call', () => {
    const names = Object.keys(advisor)
    expect(names.filter((name) => /^(allow|approve|permit|grant)|lower|relax/i.test(name))).toEqual([])
    expect(advisor.state().note).toMatch(/never approve/i)
  })

  it('matches an active rule against the tool name and its arguments', () => {
    advisor.add({ tool: 'shell_exec', pattern: 'del\\s+/f', reason: 'recursive delete' })
    const hit = advisor.escalate('shell_exec', { command: 'del /f C:\\data' })
    expect(hit.reason).toMatch(/recursive delete/)
    expect(hit.reason).toMatch(/even in auto-approve/i)
    expect(advisor.escalate('shell_exec', { command: 'dir' })).toBeNull()
    expect(advisor.escalate('sys_info', { command: 'del /f C:\\data' })).toBeNull()
  })

  it('keeps suggestions inactive until the user accepts them', () => {
    advisor.add({ tool: '*', pattern: 'format\\s+c:', reason: 'drive format', status: 'suggested' })
    expect(advisor.escalate('shell_exec', { command: 'format c:' })).toBeNull()
    const id = advisor.state().rules[0].id
    advisor.accept(id)
    expect(advisor.escalate('shell_exec', { command: 'format c:' })).toMatchObject({ reason: expect.stringMatching(/drive format/) })
  })

  it('never lets auto-approve win over an escalation', () => {
    expect(advisor.approvalMode({ risk: 'risky', autoApprove: true })).toBe('auto')
    expect(advisor.approvalMode({ risk: 'risky', autoApprove: false })).toBe('ask')
    expect(advisor.approvalMode({ risk: 'risky', autoApprove: true, escalation: { reason: 'x' } })).toBe('ask')
    expect(advisor.approvalMode({ escalation: { reason: 'x' }, autoApprove: true })).toBe('ask')
    expect(advisor.approvalMode({ risk: null, escalation: null, autoApprove: true })).toBeNull()
  })

  it('suggests a rule only after repeated refusals, without activating it', () => {
    const events = [
      { kind: 'approval', ok: false, tool: 'shell_exec', args: '{"command":"npm publish"}' },
      { kind: 'approval', ok: false, tool: 'shell_exec', args: '{"command":"npm publish"}' },
      { kind: 'approval', ok: true, tool: 'file_write', args: '{}' },
      { kind: 'tool-floor', ok: false, tool: 'file_write', args: '{}' },
    ]
    advisor._reset()
    advisor.init({ dataDir: dir, auditTail: () => events })
    const out = advisor.learn()
    expect(out.created.length).toBe(1)
    expect(out.created[0]).toMatchObject({ tool: 'shell_exec', status: 'suggested' })
    expect(out.created[0].reason).toMatch(/refused 2 time/i)
    expect(advisor.escalate('shell_exec', { command: 'npm publish' })).toBeNull()
    expect(advisor.learn().created.length).toBe(0)
  })

  it('persists rules across a restart and rejects damaged patterns', async () => {
    advisor.add({ tool: 'browser_open', pattern: 'bank\\.example', reason: 'banking site' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    advisor._reset()
    advisor.init({ dataDir: dir })
    expect(advisor.escalate('browser_open', { url: 'https://bank.example/login' })).not.toBeNull()
    expect(() => advisor.add({ tool: 'shell_exec', pattern: '([' })).toThrow(/valid regular expression/i)
    expect(() => advisor.add({ tool: 'shell_exec', pattern: 'x', reason: 'dup' })).not.toThrow()
    expect(() => advisor.add({ tool: 'shell_exec', pattern: 'x', reason: 'dup again' })).toThrow(/identical/i)
  })
})
