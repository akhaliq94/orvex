import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const platform = require('../../electron/platform.cjs')

const { applescriptString, splitCombo, macKeyLine, linuxKeyName, decodeMacHandle } = platform._internals

function fakeExec(handler) {
  const calls = []
  platform._setExec((file, args, opts, cb) => {
    calls.push({ file, args })
    let out
    try {
      out = handler(file, args)
    } catch (err) {
      cb(err, '', err.message)
      return
    }
    if (out && out.error) {
      cb(new Error(out.error), '', out.error)
      return
    }
    cb(null, out == null ? '' : out, '')
  })
  return calls
}

function linux(tools = { xdotool: true, wmctrl: true, tesseract: true, pactl: true, brightnessctl: true }) {
  platform._setPlatform('linux')
  platform._setTools(tools)
}

function mac(tools = { osascript: true, cliclick: true, tesseract: true, brightness: true }) {
  platform._setPlatform('darwin')
  platform._setTools(tools)
}

afterEach(() => {
  platform._setPlatform(process.platform)
  platform._setExec(null)
  platform._setTools({})
})

describe('platform parsers', () => {
  it('parses wmctrl rows and keeps spaces in titles', () => {
    const rows = platform.parseWmctrl(
      ['0x03a00007  0 1234  0 0  1920 1080 host  My Window', '0x03a00008  1 4321  100 50  800 600 host  Other'].join('\n'),
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ handle: '0x03a00007', pid: 1234, w: 1920, h: 1080, title: 'My Window' })
    expect(rows[1]).toMatchObject({ x: 100, y: 50, title: 'Other' })
  })

  it('groups tesseract words into lines and drops confidence -1', () => {
    const tsv = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '5\t1\t1\t1\t1\t1\t10\t20\t30\t12\t91\tHello',
      '5\t1\t1\t1\t1\t2\t45\t20\t40\t12\t88\tworld',
      '5\t1\t1\t1\t2\t1\t10\t40\t20\t10\t-1\t',
    ].join('\n')
    const parsed = platform.parseTsv(tsv)
    expect(parsed.lines).toHaveLength(1)
    expect(parsed.lines[0]).toMatchObject({ x: 10, y: 20, w: 75, h: 12, text: 'Hello world' })
    expect(parsed.text).toBe('Hello world')
    expect(parsed.width).toBe(85)
  })

  it('escapes AppleScript strings and splits combos', () => {
    expect(applescriptString('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"')
    expect(splitCombo(['CTRL', 'SHIFT', 'S'])).toEqual({ modifiers: ['CTRL', 'SHIFT'], base: ['S'] })
  })

  it('maps macOS key codes and rejects media keys', () => {
    expect(macKeyLine('ENTER', [])).toBe('key code 36')
    expect(macKeyLine('S', ['CTRL'])).toBe('keystroke "s" using {control down}')
    expect(macKeyLine('MEDIAPLAY', [])).toBeNull()
  })

  it('maps Linux key names and rejects unknown ones', () => {
    expect(linuxKeyName('CTRL')).toBe('ctrl')
    expect(linuxKeyName('RETURN')).toBe('Return')
    expect(linuxKeyName('VOLUMEUP')).toBe('XF86AudioRaiseVolume')
    expect(linuxKeyName('S')).toBe('s')
    expect(linuxKeyName('NOPE')).toBeNull()
  })

  it('decodes synthetic macOS window handles', () => {
    expect(decodeMacHandle(1234007)).toEqual({ pid: 1234, idx: 7 })
  })
})

describe('linux input', () => {
  it('presses a combo through xdotool', async () => {
    linux()
    const calls = fakeExec(() => '')
    const r = await platform.pressKeys(['CTRL', 'S'])
    expect(r.ok).toBe(true)
    expect(calls[0]).toMatchObject({ file: 'xdotool', args: ['key', '--clearmodifiers', 'ctrl+s'] })
  })

  it('refuses an unknown key without spawning anything', async () => {
    linux()
    const calls = fakeExec(() => '')
    const r = await platform.pressKeys(['WHATEVER'])
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/unknown/i)
    expect(calls).toHaveLength(0)
  })

  it('passes typed text as one argument, not through a shell', async () => {
    linux()
    const calls = fakeExec(() => '')
    const text = 'echo hi; rm -rf / $(whoami) `id`'
    const r = await platform.typeText(text)
    expect(r.ok).toBe(true)
    expect(calls[0].args).toEqual(['type', '--clearmodifiers', '--delay', '0', '--', text])
  })

  it('reports the install hint when xdotool is missing', async () => {
    linux({ xdotool: false })
    const r = await platform.pressKeys(['ENTER'])
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/xdotool/)
    expect(r.error).toMatch(/apt install/)
  })

  it('clicks and drags with the correct button numbers', async () => {
    linux()
    const calls = fakeExec(() => '')
    await platform.input({ action: 'click', x: 10, y: 20, button: 1, count: 2 })
    await platform.input({ action: 'drag', x1: 0, y1: 0, x2: 10, y2: 10, button: 0 })
    expect(calls[0].args).toEqual(['mousemove', '--sync', '10', '20', 'click', '--repeat', '2', '3'])
    expect(calls[1].args).toEqual(['mousemove', '--sync', '0', '0'])
    expect(calls[2].args).toEqual(['mousedown', '1'])
  })
})

describe('macOS input', () => {
  it('runs osascript for key combos and newline-aware typing', async () => {
    mac()
    const calls = fakeExec(() => '')
    const r = await platform.pressKeys(['CTRL', 'SHIFT', 'S'])
    expect(r.ok).toBe(true)
    expect(calls[0].file).toBe('osascript')
    expect(calls[0].args.join(' ')).toContain('keystroke "s" using {control down, shift down}')

    calls.length = 0
    await platform.typeText('one "two"\nthree')
    const script = calls[0].args.join('\n')
    expect(script).toContain('keystroke "one \\"two\\""')
    expect(script).toContain('key code 36')
    expect(script).toContain('keystroke "three"')
  })

  it('requires cliclick for mouse control', async () => {
    mac({ osascript: true, cliclick: false })
    const r = await platform.input({ action: 'click', x: 5, y: 5 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/cliclick/)
  })

  it('detects the foreground window and focuses it', async () => {
    mac()
    const calls = fakeExec((file, args) => {
      const joined = args.join(' ')
      if (joined.includes('visible') && joined.includes('frontmost')) {
        return JSON.stringify([{ title: 'Editor', x: 0, y: 0, w: 800, h: 600, pid: 1234, cls: 'Code', foreground: true, state: 'normal', idx: 0 }])
      }
      return '{"result":"focused"}'
    })
    const listed = await platform.windows()
    expect(listed.ok).toBe(true)
    expect(listed.data[0]).toMatchObject({ title: 'Editor', hwnd: 1234000, foreground: true })
    const focused = await platform.windowAction({ handle: 1234000, op: 'focus' })
    expect(focused).toMatchObject({ ok: true, data: { result: 'focused' } })
    expect(calls[1].args.join(' ')).toContain('1234')
  })
})

describe('linux windows and actions', () => {
  it('lists windows with the active one marked', async () => {
    linux()
    fakeExec((file, args) => {
      if (file === 'wmctrl') return '0x03a00007  0 1234  0 0  1920 1080 host  Game\n0x03a00008  0 4321  0 0  800 600 host  Chat\n'
      if (file === 'xdotool') return String(parseInt('0x03a00008', 16))
      return ''
    })
    const listed = await platform.windows()
    expect(listed.ok).toBe(true)
    expect(listed.data).toHaveLength(2)
    expect(listed.data.find((w) => w.title === 'Chat').foreground).toBe(true)
    expect(listed.data.find((w) => w.title === 'Game').foreground).toBe(false)
  })

  it('focuses and closes through wmctrl by numeric window id', async () => {
    linux()
    const calls = fakeExec(() => '')
    await platform.windowAction({ handle: parseInt('0x03a00007', 16), op: 'focus' })
    await platform.windowAction({ handle: parseInt('0x03a00007', 16), op: 'close' })
    expect(calls[0].args).toEqual(['-ia', '0x3a00007'])
    expect(calls[1].args).toEqual(['-ic', '0x3a00007'])
  })
})

describe('OCR, volume and brightness fallbacks', () => {
  it('reports tesseract as missing instead of pretending to read text', async () => {
    linux({ tesseract: false })
    const r = await platform.ocr('/tmp/shot.png')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/tesseract/)
  })

  it('reads tesseract tsv output', async () => {
    linux()
    fakeExec(() => 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t5\t6\t20\t10\t95\tScore: 42\n')
    const r = await platform.ocr('/tmp/shot.png', 'eng')
    expect(r.ok).toBe(true)
    expect(r.data.lines[0]).toMatchObject({ text: 'Score: 42', x: 5, y: 6 })
  })

  it('sets and reads the volume through pactl', async () => {
    linux()
    const calls = fakeExec((file, args) => {
      if (args[0] === 'get-sink-volume') return 'Volume: front-left: 32768 /  50% / -18.06 dB\n'
      if (args[0] === 'get-sink-mute') return 'Mute: no\n'
      return ''
    })
    const r = await platform.volume({ level: 50, mute: false })
    expect(r).toMatchObject({ ok: true, data: { supported: true, level: 50, mute: false } })
    expect(calls[0].args).toEqual(['set-sink-volume', '@DEFAULT_SINK@', '50%'])
    expect(calls[1].args).toEqual(['set-sink-mute', '@DEFAULT_SINK@', '0'])
  })

  it('reads brightness from brightnessctl and marks it unsupported when absent', async () => {
    linux()
    fakeExec(() => 'intel_backlight,backlight,120,40%,300\n')
    expect(await platform.brightness({})).toMatchObject({ ok: true, data: { supported: true, level: 40 } })
    linux({ brightnessctl: false })
    expect(await platform.brightness({})).toMatchObject({ ok: true, data: { supported: false } })
  })

  it('reports which platform tools are missing', () => {
    linux({ xdotool: true, wmctrl: false, tesseract: false })
    const caps = platform.capabilities()
    expect(caps).toMatchObject({ platform: 'linux', input: true, windows: false, ocr: false })
    expect(caps.missing).toEqual(['wmctrl', 'tesseract'])
  })
})
