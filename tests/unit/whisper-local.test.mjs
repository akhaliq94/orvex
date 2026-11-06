import { createRequire } from 'node:module'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const whisper = require('../../electron/whisper-local.cjs')

const temps = []

function fakeInstall({ model = 'ggml-base.bin', ffmpeg = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-whisper-'))
  temps.push(root)
  const dir = path.join(root, 'whisper')
  fs.mkdirSync(path.join(dir, 'Release'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'Release', 'whisper-server.exe'), 'stub')
  fs.writeFileSync(path.join(dir, model), 'stub')
  let ffmpegBin = null
  if (ffmpeg) {
    ffmpegBin = path.join(root, 'ffmpeg', 'bin')
    fs.mkdirSync(ffmpegBin, { recursive: true })
    fs.writeFileSync(path.join(ffmpegBin, 'ffmpeg.exe'), 'stub')
  }
  return { dir, root, ffmpeg: ffmpegBin }
}

afterEach(() => {
  vi.unstubAllEnvs()
  whisper.stop()
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('local whisper install discovery', () => {
  it('finds the server, model and ffmpeg bin', () => {
    const { dir } = fakeInstall()
    const found = whisper.findInstall([dir])
    expect(found.server).toBe(path.join(dir, 'Release', 'whisper-server.exe'))
    expect(found.model).toBe(path.join(dir, 'ggml-base.bin'))
    expect(found.ffmpeg).toBeTruthy()
  })

  it('ignores a folder that has no model', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-empty-'))
    temps.push(empty)
    expect(whisper.findInstall([empty])).toBeNull()
  })

  it('prefers the base model over small when both exist', () => {
    const { dir } = fakeInstall()
    fs.writeFileSync(path.join(dir, 'ggml-small.bin'), 'stub')
    expect(path.basename(whisper.findInstall([dir]).model)).toBe('ggml-base.bin')
  })

  it('treats ORVEX_WHISPER_DIR as the only search location', () => {
    const { dir } = fakeInstall()
    vi.stubEnv('ORVEX_WHISPER_DIR', dir)
    expect(whisper.findInstall().dir).toBe(path.resolve(dir))
  })
})

describe('local whisper process', () => {
  it('builds the OpenAI-compatible server command', () => {
    const { dir } = fakeInstall()
    const args = whisper.buildArgs(whisper.findInstall([dir]), 8079)
    const joined = args.join(' ')
    expect(joined).toContain('-m ' + path.join(dir, 'ggml-base.bin'))
    expect(joined).toContain('--port 8079')
    expect(joined).toContain('--host 127.0.0.1')
    expect(joined).toContain('--convert')
    expect(joined).toContain('-l auto')
    expect(joined).toContain('-nc')
    expect(joined).toContain('-nt')
    expect(args[args.indexOf('--inference-path') + 1]).toBe('/v1/audio/transcriptions')
  })

  it('stays off when disabled or not installed', async () => {
    vi.stubEnv('ORVEX_DISABLE_LOCAL_WHISPER', '1')
    expect((await whisper.start()).skipped).toBe('disabled')
    vi.unstubAllEnvs()
    const none = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-none-'))
    temps.push(none)
    vi.stubEnv('ORVEX_WHISPER_DIR', none)
    const state = await whisper.start()
    expect(state.skipped).toBe('not-installed')
    expect(state.running).toBe(false)
  })

  it('detects a server that is already listening', async () => {
    const server = net.createServer((socket) => socket.end())
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    expect(await whisper.portAnswers(port)).toBe(true)
    await new Promise((resolve) => server.close(resolve))
    const closed = net.createServer()
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const freePort = closed.address().port
    await new Promise((resolve) => closed.close(resolve))
    expect(await whisper.portAnswers(freePort)).toBe(false)
  })

  it('does nothing when it never spawned a server', () => {
    whisper.stop()
    const state = whisper.info()
    expect(state.running).toBe(false)
    expect(state.owned).toBe(false)
  })
})
