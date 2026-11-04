import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const documents = require('../../electron/documents.cjs')
const { detectKind, htmlToText, htmlTitle, parseDelimited, toMarkdown } = documents

describe('parseDelimited', () => {
  it('parses quoted fields, escaped quotes and newlines', () => {
    const text = 'name,note\nAda,"hello, world"\n"multi\nline",x\n2,"he said ""hi"""\n'
    expect(parseDelimited(text, ',')).toEqual([
      ['name', 'note'],
      ['Ada', 'hello, world'],
      ['multi\nline', 'x'],
      ['2', 'he said "hi"'],
    ])
  })

  it('drops rows that contain no values at all', () => {
    expect(parseDelimited('a,b\n,\n\n1,2\n', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('honours a tab delimiter', () => {
    expect(parseDelimited('a\tb\n1\t2', '\t')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('htmlToText / htmlTitle', () => {
  const html = `<!doctype html><html><head><title>Report &amp; Notes</title></head><body>
    <script>alert('x')</script>
    <h1>Hello</h1>
    <p>World &amp; more</p>
    <ul><li>One</li><li>Two</li></ul>
    <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
  </body></html>`

  it('extracts readable text without scripts', () => {
    const { text } = htmlToText(html)
    expect(text).toContain('Hello')
    expect(text).toContain('World & more')
    expect(text).toContain('- One')
    expect(text).toContain('- Two')
    expect(text).not.toContain('alert')
  })

  it('lifts tables into markdown', () => {
    const { tables } = htmlToText(html)
    expect(tables).toHaveLength(1)
    expect(tables[0].rows).toBe(2)
    expect(tables[0].cols).toBe(2)
    expect(tables[0].markdown).toContain('| A | B |')
    expect(tables[0].markdown).toContain('| 1 | 2 |')
  })

  it('decodes the document title', () => {
    expect(htmlTitle(html)).toBe('Report & Notes')
    expect(htmlTitle('<p>none</p>')).toBe('')
  })
})

describe('detectKind', () => {
  const kind = (input) => detectKind(input)

  it('sniffs magic bytes before extensions', () => {
    expect(kind({ name: 'x.txt', buf: Buffer.from('%PDF-1.7\n...') })).toBe('pdf')
    expect(kind({ name: 'x.txt', buf: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) })).toBe('image')
    expect(kind({ name: 'x.bin', buf: Buffer.from('<!DOCTYPE html><html>', 'utf8') })).toBe('html')
  })

  it('falls back to extension and content type', () => {
    expect(kind({ name: 'rows.csv', buf: Buffer.from('a,b\n1,2') })).toBe('csv')
    expect(kind({ name: 'rows.tsv', buf: Buffer.from('a\tb') })).toBe('tsv')
    expect(kind({ name: 'page.html', buf: Buffer.from('') })).toBe('html')
    expect(kind({ name: 'note.md', buf: Buffer.from('# hi') })).toBe('markdown')
    expect(kind({ name: 'x', contentType: 'application/pdf', buf: Buffer.from('') })).toBe('pdf')
  })

  it('sniffs json and plain text, and refuses binaries', () => {
    expect(kind({ name: 'x', buf: Buffer.from('{"a":1}') })).toBe('json')
    expect(kind({ name: 'x', buf: Buffer.from('plain words\nsecond line\n') })).toBe('text')
    expect(kind({ name: 'x', buf: Buffer.from([0, 1, 2, 3, 255, 254, 0, 9]) })).toBe('binary')
  })
})

describe('toMarkdown', () => {
  it('keeps markdown documents and fences plain text', () => {
    expect(toMarkdown({ ok: true, title: 'Notes', mode: 'markdown', text: 'body' })).toBe('# Notes\n\nbody')
    const fenced = toMarkdown({ ok: true, mode: 'text', text: 'plain' })
    expect(fenced).toBe('```text\nplain\n```')
    const nested = toMarkdown({ ok: true, mode: 'text', text: 'code ``` inside' })
    expect(nested.startsWith('~~~text')).toBe(true)
  })

  it('returns empty for failed extractions', () => {
    expect(toMarkdown({ ok: false, text: 'nope' })).toBe('')
    expect(toMarkdown(null)).toBe('')
  })
})
