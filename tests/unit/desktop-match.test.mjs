import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const desktop = require('../../electron/desktop.cjs')
const { matchApp, flattenUiTree, matchUiTree, matchOcrLines } = desktop._internals

const APPS = [
  { name: 'Notepad', appId: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' },
  { name: 'Notepad++', appId: 'Notepad++' },
  { name: 'Paint', appId: 'Microsoft.Paint_8wekyb3d8bbwe!App' },
  { name: 'Paint 3D', appId: 'Microsoft.MSPaint_8wekyb3d8bbwe!App' },
  { name: 'Calculator', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
]

const TREE = {
  name: 'Window',
  type: 'WindowControl',
  path: '[0]',
  x: 0,
  y: 0,
  w: 800,
  h: 600,
  children: [
    { name: 'Save', type: 'ButtonControl', path: '[0/0]', x: 100, y: 200, w: 80, h: 30 },
    { name: 'Save as…', type: 'MenuItemControl', path: '[0/1]', x: 100, y: 240, w: 120, h: 28 },
    { name: '', type: 'TextControl', path: '[0/2]', x: 10, y: 10, w: 50, h: 20 },
    { name: 'Hidden thing', type: 'ButtonControl', path: '[0/3]', x: 0, y: 0, w: 40, h: 20, offscreen: true },
    { name: 'Zero size', type: 'ButtonControl', path: '[0/4]', x: 0, y: 0, w: 0, h: 0 },
    {
      name: 'Panel',
      type: 'PaneControl',
      path: '[0/5]',
      x: 300,
      y: 300,
      w: 200,
      h: 100,
      children: [{ name: 'Save', type: 'ButtonControl', path: '[0/5/0]', x: 320, y: 340, w: 60, h: 24 }],
    },
  ],
}

describe('app matching', () => {
  it('prefers an exact name regardless of case', () => {
    const result = matchApp(APPS, 'notepad')
    expect(result.exact.appId).toBe('Microsoft.WindowsNotepad_8wekyb3d8bbwe!App')
    expect(result.matches).toHaveLength(1)
  })

  it('accepts a unique prefix', () => {
    const result = matchApp(APPS, 'calc')
    expect(result.exact.name).toBe('Calculator')
  })

  it('lists ambiguous prefixes instead of guessing', () => {
    const result = matchApp(APPS, 'note')
    expect(result.exact).toBeNull()
    expect(result.matches.map((a) => a.name)).toEqual(['Notepad', 'Notepad++'])
  })

  it('accepts a unique loose match and rejects empty queries', () => {
    expect(matchApp(APPS, '++').exact.name).toBe('Notepad++')
    expect(matchApp(APPS, 'nothing here')).toEqual({ exact: null, matches: [] })
    expect(matchApp(APPS, '   ')).toEqual({ exact: null, matches: [] })
  })
})

describe('UI Automation grounding', () => {
  it('flattens the tree in document order', () => {
    const nodes = flattenUiTree(TREE)
    expect(nodes).toHaveLength(8)
    expect(nodes[0].name).toBe('Window')
    expect(nodes.at(-1).name).toBe('Save')
  })

  it('finds every visible node containing the text', () => {
    const matches = matchUiTree(TREE, 'save', false)
    expect(matches.map((m) => m.path)).toEqual(['[0/0]', '[0/1]', '[0/5/0]'])
    expect(matches[0]).toMatchObject({ source: 'uia', x: 100, y: 200, w: 80, h: 30, cx: 140, cy: 215 })
  })

  it('skips offscreen, zero-size and unnamed nodes', () => {
    const matches = matchUiTree(TREE, 'hidden', false)
    expect(matches).toHaveLength(0)
    expect(matchUiTree(TREE, 'zero', false)).toHaveLength(0)
    expect(matchUiTree(TREE, '', false)).toHaveLength(0)
  })

  it('honours exact matching', () => {
    const exact = matchUiTree(TREE, 'save', true)
    expect(exact).toHaveLength(2)
    expect(exact.every((m) => m.name === 'Save')).toBe(true)
  })
})

describe('fast desktop tree', () => {
  const withPatterns = (extra) => ({ ...TREE, children: [...TREE.children, { name: 'Custom', type: 'CustomControl', path: '[0/6]', x: 1, y: 1, w: 9, h: 9, patterns: ['Invoke'], ...extra }] })

  it('recognises actionable control types and patterns', () => {
    expect(desktop._internals.isInteractiveNode({ type: 'ButtonControl' })).toBe(true)
    expect(desktop._internals.isInteractiveNode({ type: 'EditControl' })).toBe(true)
    expect(desktop._internals.isInteractiveNode({ type: 'TextControl' })).toBe(false)
    expect(desktop._internals.isInteractiveNode({ type: 'PaneControl' })).toBe(false)
    expect(desktop._internals.isInteractiveNode({ type: 'CustomControl', patterns: ['Invoke'] })).toBe(true)
  })

  it('prints only actionable, on-screen nodes in interactive mode', () => {
    const lines = []
    desktop._internals.formatTree(TREE, 0, lines, 300, true)
    expect(lines).toHaveLength(3)
    expect(lines.every((line) => !line.includes('Pane'))).toBe(true)
    expect(lines.every((line) => !line.includes('offscreen'))).toBe(true)
    expect(lines.every((line) => !line.includes('Zero size'))).toBe(true)
    expect(lines.some((line) => line.includes('[0/5/0]'))).toBe(true)
  })

  it('keeps the full tree when interactive mode is off', () => {
    const lines = []
    desktop._internals.formatTree(TREE, 0, lines, 300, false)
    expect(lines).toHaveLength(8)
  })

  it('finds nodes by path and counts duplicate names', () => {
    const node = desktop._internals.findUiNodeByPath(TREE, '0/5/0')
    expect(node).toMatchObject({ name: 'Save', type: 'ButtonControl' })
    expect(desktop._internals.findUiNodeByPath(TREE, '9/9')).toBeNull()
    expect(desktop._internals.countMatchingNodes(TREE, 'Save', 'ButtonControl')).toBe(2)
    expect(desktop._internals.countMatchingNodes(TREE, 'Save', 'MenuItemControl')).toBe(0)
  })

  it('counts interactive nodes for the header', () => {
    expect(desktop._internals.countInteractive(TREE)).toBe(5)
    expect(desktop._internals.countInteractive(withPatterns())).toBe(6)
  })
})

describe('OCR grounding', () => {
  const LINES = [
    { x: 10, y: 20, w: 100, h: 24, text: 'File Edit View' },
    { x: 120, y: 20, w: 60, h: 24, text: 'Save' },
    { x: 0, y: 0, w: 10, h: 10, text: '   ' },
  ]

  it('finds lines and applies the capture origin and display offset', () => {
    const matches = matchOcrLines(LINES, 'save', false, { x: 25, y: 40 }, { x: -100, y: 7 })
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ source: 'ocr', x: 45, y: 67, w: 60, h: 24, cx: 75, cy: 79 })
  })

  it('honours exact matching and ignores empty lines', () => {
    expect(matchOcrLines(LINES, 'save', true)).toHaveLength(1)
    expect(matchOcrLines(LINES, 'file edit view', true)).toHaveLength(1)
    expect(matchOcrLines(LINES, 'file', true)).toHaveLength(0)
    expect(matchOcrLines(LINES, 'view', false)).toHaveLength(1)
    expect(matchOcrLines(LINES, '', false)).toHaveLength(0)
  })

  it('is exposed as a registered desktop tool', () => {
    const names = desktop.definitions.map((d) => d.name)
    expect(names).toEqual(expect.arrayContaining(['app_list', 'app_launch', 'screen_find', 'screen_click_text']))
    expect(typeof desktop.handlers.screen_find).toBe('function')
    expect(typeof desktop.handlers.app_launch).toBe('function')
  })
})
