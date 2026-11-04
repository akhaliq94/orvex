import { createRequire } from 'node:module'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const brain = require('../../electron/local-brain.cjs')
const { sanitizeConfig, modelIdOf, formatBytes } = brain._internals

const GB = 1024 ** 3

function u64(value) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(BigInt(value))
  return buf
}

function ggufString(value) {
  const bytes = Buffer.from(String(value), 'utf8')
  return Buffer.concat([u64(bytes.length), bytes])
}

function kvString(key, value) {
  return Buffer.concat([ggufString(key), Buffer.from([8, 0, 0, 0]), ggufString(value)])
}

function kvU32(key, value) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(value)
  return Buffer.concat([ggufString(key), Buffer.from([4, 0, 0, 0]), buf])
}

function buildGguf(kvs) {
  const header = Buffer.alloc(4)
  header.write('GGUF', 'utf8')
  const version = Buffer.alloc(4)
  version.writeUInt32LE(3)
  return Buffer.concat([header, version, u64(0), u64(kvs.length), ...kvs])
}

describe('readGgufMeta', () => {
  it('reads the architecture facts from a real GGUF header layout', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'orvex-gguf-'))
    try {
      const file = path.join(dir, 'test-Q4_K_M.gguf')
      await writeFile(
        file,
        buildGguf([
          kvString('general.architecture', 'llama'),
          kvString('general.name', 'Test Model'),
          kvU32('llama.block_count', 32),
          kvU32('llama.context_length', 4096),
          kvU32('llama.embedding_length', 4096),
          kvU32('llama.attention.head_count', 32),
          kvU32('llama.attention.head_count_kv', 8),
        ]),
      )
      const read = await brain.readGgufMeta(file)
      expect(read.ok).toBe(true)
      expect(read.version).toBe(3)
      expect(read.meta['general.architecture']).toBe('llama')
      expect(read.meta['general.name']).toBe('Test Model')
      const facts = brain.modelFacts(read.meta, read.size)
      expect(facts.arch).toBe('llama')
      expect(facts.blockCount).toBe(32)
      expect(facts.contextLength).toBe(4096)
      expect(facts.embeddingLength).toBe(4096)
      expect(facts.headCount).toBe(32)
      expect(facts.headCountKv).toBe(8)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a file that is not GGUF', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'orvex-gguf-'))
    try {
      const file = path.join(dir, 'not-a-model.gguf')
      await writeFile(file, 'this is not a gguf file')
      const read = await brain.readGgufMeta(file)
      expect(read.ok).toBe(false)
      expect(read.reason).toMatch(/not a gguf/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('estimateFit', () => {
  const llama = {
    size: 4 * GB,
    blockCount: 32,
    contextLength: 4096,
    embeddingLength: 4096,
    headCount: 32,
    headCountKv: 8,
    context: 4096,
  }

  it('offloads every layer when the model and KV cache fit', () => {
    const fit = brain.estimateFit({ ...llama, vramBytes: 8 * GB })
    expect(fit.verdict).toBe('gpu-full')
    expect(fit.gpuLayers).toBe(32)
    expect(fit.fitsFully).toBe(true)
    expect(fit.kvBytes).toBeGreaterThan(0)
    expect(fit.estimatedVramBytes).toBeLessThan(8 * GB)
  })

  it('offloads a subset when the model is larger than the budget', () => {
    const fit = brain.estimateFit({ ...llama, size: 8 * GB, vramBytes: 8 * GB })
    expect(fit.verdict).toBe('gpu-partial')
    expect(fit.gpuLayers).toBeGreaterThan(0)
    expect(fit.gpuLayers).toBeLessThan(32)
    expect(fit.estimatedRamBytes).toBeGreaterThan(0)
  })

  it('falls back to the CPU without a VRAM budget', () => {
    const fit = brain.estimateFit({ ...llama, vramBytes: 0 })
    expect(fit.verdict).toBe('cpu')
    expect(fit.gpuLayers).toBe(0)
    expect(fit.estimatedRamBytes).toBeGreaterThan(0)
  })

  it('honours an explicit GPU layer count', () => {
    const fit = brain.estimateFit({ ...llama, vramBytes: 8 * GB, gpuLayers: 0 })
    expect(fit.verdict).toBe('cpu')
    expect(fit.gpuLayers).toBe(0)
  })

  it('clamps context to the model limit', () => {
    const fit = brain.estimateFit({ ...llama, context: 32768, vramBytes: 8 * GB })
    expect(fit.context).toBe(4096)
  })

  it('reports unknown when the size is missing', () => {
    const fit = brain.estimateFit({ size: 0 })
    expect(fit.ok).toBe(false)
    expect(fit.verdict).toBe('unknown')
  })
})

describe('guessFromName', () => {
  it('reads quantisation and parameter count', () => {
    expect(brain.guessFromName('Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf')).toEqual({ quant: 'Q4_K_M', paramsB: 8 })
    expect(brain.guessFromName('qwen2.5-coder-7b-instruct-q5_k_m.gguf')).toEqual({ quant: 'Q5_K_M', paramsB: 7 })
    expect(brain.guessFromName('tinyllama-1.1b-chat-v1.0.Q8_0.gguf')).toEqual({ quant: 'Q8_0', paramsB: 1.1 })
  })

  it('returns blanks when nothing can be inferred', () => {
    expect(brain.guessFromName('model.gguf')).toEqual({ quant: '', paramsB: null })
  })
})

describe('sanitizeConfig', () => {
  it('clamps numeric ranges and normalises unknown values', () => {
    const config = sanitizeConfig({ port: 1, context: 1, threads: 0, gpuLayers: -5, vramGb: 0, idleMinutes: -2, prefer: 'whatever' })
    expect(config.port).toBeGreaterThan(40000)
    expect(config.context).toBe(512)
    expect(config.threads).toBeGreaterThanOrEqual(1)
    expect(config.gpuLayers).toBe(0)
    expect(config.vramGb).toBeNull()
    expect(config.idleMinutes).toBe(0)
    expect(config.prefer).toBe('local-first')
  })

  it('keeps offline mode switched on', () => {
    const config = sanitizeConfig({ enabled: false, offline: true })
    expect(config.enabled).toBe(true)
    expect(config.offline).toBe(true)
  })

  it('accepts an explicit GPU layer count and VRAM override', () => {
    const config = sanitizeConfig({ gpuLayers: 24, vramGb: 8 })
    expect(config.gpuLayers).toBe(24)
    expect(config.vramGb).toBe(8)
  })
})

describe('helpers', () => {
  it('builds stable ids per path', () => {
    const a = modelIdOf('C:\\models\\a.gguf')
    expect(a).toBe(modelIdOf('c:\\models\\a.gguf'))
    expect(a.startsWith('gguf_')).toBe(true)
    expect(a).not.toBe(modelIdOf('C:\\models\\b.gguf'))
  })

  it('formats bytes for the UI', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(4 * GB)).toBe('4.0 GB')
  })

  it('parses GPU probe output with a 64-bit memory value', () => {
    const rows = brain.parseGpuJson('{"Name":"AMD Radeon RX 470","AdapterRAM":4293918720}\n{"Name":"AMD Radeon RX 470","Memory":8573157376}')
    expect(rows.length).toBe(2)
    expect(rows[1].memoryBytes).toBe(8573157376)
  })

  it('ships a tool-call grammar that llama.cpp can use', () => {
    const grammar = brain.toolGrammar()
    expect(grammar).toMatch(/^root ::=/)
    expect(grammar).toContain('"tool"')
    expect(grammar).toContain('"arguments"')
  })
})
