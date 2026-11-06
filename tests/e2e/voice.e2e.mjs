import { _electron as electron } from 'playwright'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixturePath = process.argv.find((arg) => arg.startsWith('--audio='))?.slice(8)
if (!fixturePath) throw new Error('Supply --audio=<spoken WAV fixture>; local Whisper must be running on port 8079.')
const fixture = readFileSync(fixturePath)
const profile = mkdtempSync(path.join(tmpdir(), 'orvex-voice-e2e-'))
const errors = []
const requests = []
let holdTts = false
let releaseTts = () => {}
let onHeldTts = () => {}
const server = createServer(async (req, res) => {
  for await (const chunk of req) { void chunk }
  requests.push(Date.now())
  if (holdTts) await new Promise((resolve) => {
    releaseTts = resolve
    onHeldTts()
  })
  res.writeHead(200, { 'content-type': 'audio/wav', 'access-control-allow-origin': '*' })
  res.end(fixture)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const ttsUrl = `http://127.0.0.1:${server.address().port}`
const env = { ...process.env, ORVEX_USER_DATA_DIR: profile, ORVEX_DISABLE_LOCAL_WHISPER: '1' }
delete env.ELECTRON_RUN_AS_NODE
if (process.argv.includes('--dev')) env.VITE_DEV_URL = 'http://127.0.0.1:5183'
else delete env.VITE_DEV_URL
const app = await electron.launch({ args: [root, '--autoplay-policy=no-user-gesture-required'], cwd: root, env, timeout: 90000 })
try {
  const page = await app.firstWindow({ timeout: 90000 })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(({ audio, ttsUrl }) => {
    localStorage.setItem('orvex-handsfree', '0')
    localStorage.setItem('orvex-chat-agent', '0')
    localStorage.setItem('orvex-voice-speak-on', '1')
    localStorage.setItem('orvex-providers', JSON.stringify({
      providers: [{ id: 'fixture-disabled', enabled: false, apiKey: '', env: [] }],
      activeId: 'none',
    }))
    localStorage.setItem('orvex-voice-config', JSON.stringify({
      engine: 'kokoro', serverUrl: ttsUrl, synthPath: '/tts', autoSpeak: true,
      asrUrl: 'http://127.0.0.1:8079/v1/audio/transcriptions', asrModel: 'base',
      micDeviceId: '', streaming: true, wakeEnabled: false, bargeIn: false,
    }))
    window.__voiceTest = { plays: 0, ended: 0, tracks: [], feed: null, marks: [] }
    const phase = (name) => {
      const last = window.__voiceTest.marks[window.__voiceTest.marks.length - 1]
      if (!last || last.name !== name) window.__voiceTest.marks.push({ name, at: performance.now() })
    }
    window.__voiceTest.phase = phase
    new MutationObserver(() => {
      const el = document.querySelector('.voice-focus-label strong')
      if (el && document.querySelector('.voice-focus')) phase(el.textContent.trim())
    }).observe(document, { subtree: true, childList: true, characterData: true })
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext()
      await ctx.resume()
      const dest = ctx.createMediaStreamDestination()
      const bytes = Uint8Array.from(atob(audio), (char) => char.charCodeAt(0))
      const decoded = await ctx.decodeAudioData(bytes.buffer)
      window.__voiceTest.feed = () => {
        const source = ctx.createBufferSource()
        source.buffer = decoded
        source.connect(dest)
        window.__voiceTest.marks = []
        phase('SPOKE')
        source.start()
      }
      const stream = dest.stream
      window.__voiceTest.tracks.push(...stream.getTracks())
      return stream
    }
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function () {
      this.addEventListener('playing', () => { window.__voiceTest.plays += 1 }, { once: true })
      this.addEventListener('ended', () => { window.__voiceTest.ended += 1 }, { once: true })
      return play.call(this)
    }
  }, { audio: fixture.toString('base64'), ttsUrl })
  await page.reload()
  await page.waitForSelector('.sidebar-area')
  await page.getByRole('button', { name: 'Toggle voice input', exact: true }).click()
  await page.waitForSelector('.chat-wrap')
  assert.equal(await page.getByRole('button', { name: 'Hands-free conversation', exact: true }).getAttribute('aria-pressed'), 'true')
  console.log('PASS Home microphone enters hands-free Chat')
  await page.waitForFunction(() => window.__voiceTest.feed !== null)

  const stateDump = () => page.evaluate(() => ({
    label: document.querySelector('.voice-focus-label strong')?.textContent ?? null,
    header: document.querySelector('.topbar')?.innerText?.replace(/\s+/g, ' ').slice(0, 160) ?? null,
    user: document.querySelectorAll('.chat-row.user').length,
    marks: (window.__voiceTest.marks ?? []).slice(-8).map((m) => m.name),
    tracks: window.__voiceTest.tracks.map((t) => t.readyState).join(','),
  }))
  const heardTurn = (count) => page.waitForFunction(
    (n) => document.querySelectorAll('.chat-row.user').length > n,
    count,
    { timeout: 135000 },
  ).catch(async (error) => {
    console.log(`turn ${count} stalled:`, JSON.stringify(await stateDump()))
    throw error
  })

  for (let turn = 1; turn <= 2; turn += 1) {
    const before = await page.locator('.chat-row.user').count()
    const started = Date.now()
    await page.evaluate(() => window.__voiceTest.feed())
    await heardTurn(before)
    const transcriptMs = Date.now() - started
    await page.evaluate(() => window.__voiceTest.phase('HEARD'))
    await page.waitForFunction((count) => window.__voiceTest.ended >= count, turn, { timeout: 30000 })
    await page.evaluate(() => window.__voiceTest.phase('PLAYED'))
    const marks = await page.evaluate(() => {
      const out = window.__voiceTest.marks.slice(-24)
      const base = out[0]?.at ?? 0
      return out.map((m) => `${m.name}@${Math.round((m.at - base) / 100) / 10}s`)
    })
    console.log(`  turn ${turn} phases: ${marks.join(' → ')}`)
    assert.equal(await page.locator('.chat-row.user').count(), before + 1)
    assert.match(await page.locator('.chat-row.assistant .chat-bubble').last().innerText(), /offline brain/i)
    await page.waitForFunction(() => document.querySelector('.voice-focus-label strong')?.textContent === 'Listening')
    console.log(`PASS spoken WAV → real MediaRecorder/Whisper → offline reply → fixture Audio playback → listen again (turn ${turn}, transcript ${transcriptMs}ms)`)
  }

  await page.mouse.move(25, 25)
  holdTts = true
  const beforeRequests = requests.length
  const heldArrival = new Promise((resolve) => { onHeldTts = resolve })
  await page.getByRole('textbox', { name: 'Chat message', exact: true }).fill('Hello from the cancellation test')
  const beforePlay = await page.evaluate(() => window.__voiceTest.plays)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await Promise.race([heldArrival, new Promise((resolve) => setTimeout(resolve, 20000))])
  assert.ok(requests.length > beforeRequests, 'held TTS request never reached the fixture server')
  await page.waitForFunction(() => document.querySelector('.voice-focus-label strong')?.textContent === 'Preparing voice…')
  await page.mouse.move(35, 35)
  await page.getByRole('button', { name: 'Stop voice input', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'Hands-free conversation', exact: true }).getAttribute('aria-pressed'), 'false')
  await page.waitForFunction(() => window.__voiceTest.tracks.every((track) => track.readyState === 'ended'))
  holdTts = false
  releaseTts()
  await page.getByRole('textbox', { name: 'Chat message', exact: true }).fill('Hello after stopping')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.waitForFunction((count) => window.__voiceTest.ended > count, 2, { timeout: 30000 })
  assert.equal(await page.evaluate(() => window.__voiceTest.plays), beforePlay + 1)
  console.log('PASS stop closes microphone and cancels delayed speech; typed chat still speaks')

  await page.getByRole('button', { name: 'Voice input', exact: true }).click()
  await page.waitForSelector('.voice-focus')
  await page.mouse.move(45, 45)
  await page.locator('nav[aria-label="Primary"] .nav-item').filter({ hasText: /^Voice$/ }).click()
  await page.waitForFunction(() => window.__voiceTest.tracks.every((track) => track.readyState === 'ended'))
  console.log('PASS leaving Chat releases the microphone')
  await page.screenshot({ path: path.join(profile, 'voice-ui.png') })
  assert.deepEqual(errors, [])
  console.log('PASS no renderer errors; TTS is an explicit audio fixture, not a cloud synthesis claim')
} finally {
  releaseTts()
  await app.close()
  await new Promise((resolve) => server.close(resolve))
  rmSync(profile, { recursive: true, force: true })
}
