import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const maker = require('../../electron/maker.cjs')
const { slugify, makePalette, tokensCss, logoSvg, escapeHtml, resolveInside, TEMPLATES } = maker._internals

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-maker-test-'))
const dataDir = path.join(root, 'profile')

function rawRequest(url, requestPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(`${url.replace(/\/$/, '')}/${requestPath.replace(/^\//, '')}`, { method }, (res) => {
      let body = ''
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('maker helpers', () => {
  it('slugifies names safely', () => {
    expect(slugify('Nimbus Portfolio!')).toBe('nimbus-portfolio')
    expect(slugify('  Café  Ünit  ')).toBe('cafe-unit')
    expect(slugify('')).toMatch(/^project-/)
    expect(slugify('x'.repeat(90))).toHaveLength(48)
  })

  it('generates a deterministic palette from a seed', () => {
    const a = makePalette('nimbus')
    const b = makePalette('nimbus')
    const c = makePalette('different')
    expect(a).toEqual(b)
    expect(a.brand).not.toBe(c.brand)
    for (const [key, value] of Object.entries(a)) {
      if (key === 'seed') continue
      expect(value).toMatch(/^#[0-9a-f]{6}$/)
    }
    expect(tokensCss(a)).toContain(`--brand: ${a.brand}`)
  })

  it('makes an escaped logo and escapes HTML', () => {
    const svg = logoSvg('Acme <Tools>', makePalette('acme'))
    expect(svg).toContain('<svg')
    expect(svg).toContain('&lt;Tools&gt;')
    expect(svg).not.toContain('<Tools>')
    expect(escapeHtml(`<b>"x" & 'y'</b>`)).toBe('&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;')
  })

  it('refuses paths outside a project folder', () => {
    const base = path.join(root, 'inside')
    expect(resolveInside(base, 'index.html')).toBe(path.join(base, 'index.html'))
    expect(() => resolveInside(base, '../escape.txt')).toThrow(/outside/i)
    expect(() => resolveInside(base, 'C:\\Windows\\win.ini')).toThrow(/outside/i)
  })
})

describe('maker projects', () => {
  let website = null
  let cli = null
  let design = null
  let previewUrl = null

  beforeAll(() => {
    maker.init({ dataDir, emit: () => {} })
  })

  afterAll(async () => {
    await maker.stopAll().catch(() => {})
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('starts empty and lists six real templates', () => {
    expect(maker.list().projects).toEqual([])
    const templates = maker.templates()
    expect(templates.map((t) => t.id)).toEqual(['website', 'landing', 'design-kit', 'node-cli', 'python-cli', 'react-vite'])
    expect(templates.every((t) => t.label && t.description && t.kind)).toBe(true)
    expect(Object.keys(TEMPLATES)).toHaveLength(6)
  })

  it('rejects unknown templates and short names', async () => {
    await expect(maker.create({ template: 'nope', name: 'Good name' })).rejects.toThrow(/Unknown template/)
    await expect(maker.create({ template: 'website', name: 'x' })).rejects.toThrow(/2-60/)
  })

  it('scaffolds a real website with generated source files', async () => {
    website = await maker.create({ template: 'website', name: 'Acme <Tools>', title: 'Build <fast>', description: 'A test site.' })
    expect(website.name).toBe('Acme <Tools>')
    expect(website.slug).toBe('acme-tools')
    expect(website.kind).toBe('static')
    expect(website.files).toEqual(
      expect.arrayContaining(['index.html', 'about.html', 'contact.html', '404.html', 'styles.css', 'app.js', 'README.md', 'assets/logo.svg']),
    )
    for (const rel of website.files) expect(fs.existsSync(path.join(website.dir, rel))).toBe(true)
    expect(fs.existsSync(path.join(website.dir, '..', 'maker.json'))).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'maker', 'maker.json'))).toBe(true)

    const index = fs.readFileSync(path.join(website.dir, 'index.html'), 'utf8')
    expect(index).toContain('Build &lt;fast&gt;')
    expect(index).toContain('Acme &lt;Tools&gt;')
    expect(index).not.toContain('<fast>')
    expect(index).toContain('assets/logo.svg')
    const css = fs.readFileSync(path.join(website.dir, 'styles.css'), 'utf8')
    expect(css).toContain(`--brand: ${website.palette.brand}`)
    expect(css).toContain('--step-5')
  })

  it('lists files and reads them back', async () => {
    const listing = await maker.files(website.id)
    expect(listing.project.id).toBe(website.id)
    expect(listing.files.find((f) => f.path === 'index.html')).toMatchObject({ name: 'index.html', dir: false })
    expect(listing.files.find((f) => f.path === 'assets')).toMatchObject({ name: 'assets', dir: true })
    const file = await maker.readFile(website.id, 'index.html')
    expect(file.binary).toBe(false)
    expect(file.content).toContain('<!doctype html>')
  })

  it('writes new and existing files inside the project only', async () => {
    const result = await maker.writeFile(website.id, 'notes/todo.md', '# Todo\n')
    expect(result.path).toBe('notes/todo.md')
    expect(result.bytes).toBe(7)
    expect(fs.readFileSync(path.join(website.dir, 'notes', 'todo.md'), 'utf8')).toBe('# Todo\n')
    const read = await maker.readFile(website.id, 'notes/todo.md')
    expect(read.content).toBe('# Todo\n')
    await expect(maker.writeFile(website.id, '../escape.txt', 'x')).rejects.toThrow(/outside/i)
    await expect(maker.readFile(website.id, '../../maker.json')).rejects.toThrow(/outside/i)
  })

  it('detects binary files instead of returning garbage text', async () => {
    await maker.writeFile(website.id, 'assets/pixel.png', 'not really a png')
    const file = await maker.readFile(website.id, 'assets/pixel.png')
    expect(file.binary).toBe(true)
    expect(file.content).toBeNull()
  })

  it('serves a real live preview with traversal protection', async () => {
    const preview = await maker.preview(website.id)
    previewUrl = preview.url
    expect(previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)

    const index = await rawRequest(previewUrl, '')
    expect(index.status).toBe(200)
    expect(index.headers['content-type']).toMatch(/text\/html/)
    expect(index.body).toContain('Build &lt;fast&gt;')

    const head = await rawRequest(previewUrl, 'styles.css', 'HEAD')
    expect(head.status).toBe(200)
    expect(head.body).toBe('')

    const post = await rawRequest(previewUrl, '', 'POST')
    expect(post.status).toBe(405)

    const escape = await rawRequest(previewUrl, '/%2e%2e%2fmaker.json')
    expect(escape.status).toBe(403)
    const normalized = await rawRequest(previewUrl, '/%2e%2e/maker.json')
    expect([403, 404]).toContain(normalized.status)

    const missing = await rawRequest(previewUrl, 'nope.html')
    expect(missing.status).toBe(404)

    const again = await maker.preview(website.id)
    expect(again.reused).toBe(true)
    expect(again.url).toBe(previewUrl)
  })

  it('exports a zip containing the project files', async () => {
    const out = await maker.exportZip(website.id)
    expect(fs.existsSync(out.file)).toBe(true)
    expect(out.bytes).toBeGreaterThan(500)
    const buffer = fs.readFileSync(out.file)
    expect(buffer.includes(Buffer.from('index.html'))).toBe(true)
    expect(buffer.includes(Buffer.from('styles.css'))).toBe(true)
  })

  it('builds a design kit without unsafe markup', async () => {
    design = await maker.create({ template: 'design-kit', name: 'Aurora Kit' })
    expect(design.kind).toBe('static')
    expect(design.files).toEqual(expect.arrayContaining(['tokens.css', 'palette.json', 'specimen.html', 'assets/logo.svg', 'README.md']))
    const palette = JSON.parse(fs.readFileSync(path.join(design.dir, 'palette.json'), 'utf8'))
    expect(palette.name).toBe('Aurora Kit')
    expect(palette.colors.brand).toBe(design.palette.brand)
    const specimen = fs.readFileSync(path.join(design.dir, 'specimen.html'), 'utf8')
    expect(specimen).toContain('tokens.css')
    expect(specimen).not.toContain('innerHTML')
  })

  it('runs a generated CLI in place', async () => {
    cli = await maker.create({ template: 'node-cli', name: 'Word Counter' })
    expect(cli.kind).toBe('node-cli')
    await expect(maker.preview(cli.id)).rejects.toThrow(/no website/)
    const help = await maker.run(cli.id, ['--help'])
    expect(help.ok).toBe(true)
    expect(help.stdout).toContain('Usage:')
    const count = await maker.run(cli.id, ['README.md', '--json'])
    expect(count.ok).toBe(true)
    const json = JSON.parse(count.stdout)
    expect(json.file).toBe('README.md')
    expect(json.words).toBeGreaterThan(3)
  })

  it('refuses to run a website as a process', async () => {
    await expect(maker.run(website.id)).rejects.toThrow(/Only node-cli and python-cli/)
  })

  it('needs approval for runs and deletes only', () => {
    expect(maker.approvalReason('maker_run', {})).toMatch(/real process/i)
    expect(maker.approvalReason('maker_remove', { projectId: 'mk_1' })).toMatch(/mk_1/)
    expect(maker.approvalReason('maker_list', {})).toBeNull()
    expect(maker.approvalReason('maker_write_file', {})).toBeNull()
  })

  it('exposes tools and honest handlers', () => {
    const names = maker.definitions.map((d) => d.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'maker_templates',
        'maker_list',
        'maker_create',
        'maker_files',
        'maker_read_file',
        'maker_write_file',
        'maker_preview',
        'maker_run',
        'maker_export',
        'maker_remove',
      ]),
    )
    expect(typeof maker.handlers.maker_list).toBe('function')
  })

  it('persists the registry across a reload', () => {
    const before = maker.list().projects.length
    expect(before).toBe(3)
    maker.init({ dataDir, emit: () => {} })
    expect(maker.list().projects.map((p) => p.id)).toEqual(expect.arrayContaining([website.id, design.id, cli.id]))
  })

  it('removes a project folder and its registry entry', async () => {
    await maker.stopPreview(website.id)
    await maker.remove(website.id)
    expect(fs.existsSync(website.dir)).toBe(false)
    expect(maker.list().projects.some((p) => p.id === website.id)).toBe(false)
    await expect(maker.files(website.id)).rejects.toThrow(/Unknown Maker project/)
    await expect(maker.remove(design.id)).resolves.toEqual({ removed: design.id })
    await maker.remove(cli.id)
    expect(maker.list().projects).toEqual([])
  })
})
