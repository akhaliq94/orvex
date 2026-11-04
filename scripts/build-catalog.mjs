import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const catalogCore = require('../electron/catalog.cjs')
const unzipper = require('unzipper')

const args = process.argv.slice(2)
const flag = (name, fallback = '') => {
  const prefix = `--${name}=`
  const hit = args.find((a) => a.startsWith(prefix))
  if (hit) return hit.slice(prefix.length)
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback
}

const dir = path.resolve(flag('dir', 'release/plugins'))
const base = flag('base', '').replace(/\/+$/, '')
const out = path.resolve(flag('out', 'release/catalog.json'))
const keyPath = flag('key', '')
const keyId = flag('key-id', 'orvex-catalog').slice(0, 64)

function fail(message) {
  console.error(message)
  process.exit(1)
}

if (!existsSync(dir)) fail(`Plugin archive folder not found: ${dir}\nBuild the .zip files first, or pass --dir.`)
if (!base) fail('Pass --base with the public URL prefix for the archives, e.g. --base https://github.com/acme/orvex-releases/releases/latest/download')
if (!/^https:\/\//i.test(base)) fail('--base must be an https:// URL so the catalog cannot point at a plaintext download.')

const archives = readdirSync(dir)
  .filter((name) => name.toLowerCase().endsWith('.zip'))
  .sort()
if (!archives.length) fail(`No .zip archives were found in ${dir}.`)

async function readManifest(zipPath) {
  const directory = await unzipper.Open.file(zipPath)
  const entry = directory.files.find((file) => file.type !== 'Directory' && file.path.replace(/\\/g, '/').replace(/^\.\//, '') === 'manifest.json')
  if (!entry) throw new Error('manifest.json is missing at the archive root.')
  const buffer = await entry.buffer()
  if (buffer.length > 64 * 1024) throw new Error('manifest.json is larger than 64 KB.')
  return JSON.parse(buffer.toString('utf8'))
}

const items = []
const seen = new Set()
for (const name of archives) {
  const zipPath = path.join(dir, name)
  let manifest
  try {
    manifest = await readManifest(zipPath)
  } catch (err) {
    fail(`${name}: ${err && err.message ? err.message : String(err)}`)
  }
  const id = String(manifest.id || '').trim()
  const version = String(manifest.version || '').trim()
  if (!/^[a-z0-9][a-z0-9._-]{1,40}$/i.test(id)) fail(`${name}: manifest id "${id}" is not a valid plugin id.`)
  if (!/^\d+\.\d+\.\d+/.test(version)) fail(`${name}: manifest version "${version}" is not semver.`)
  if (seen.has(id)) fail(`${name}: a second archive also claims id "${id}". Keep one version per id.`)
  seen.add(id)
  const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
  const tools = Array.isArray(manifest.tools)
    ? manifest.tools.map((tool) => (typeof tool === 'string' ? tool : tool && tool.name)).filter(Boolean).slice(0, 20)
    : []
  items.push({
    id,
    name: String(manifest.name || id).slice(0, 80),
    version,
    description: String(manifest.description || '').slice(0, 400),
    author: String(manifest.author || '').slice(0, 80),
    url: `${base}/${encodeURIComponent(name)}`,
    sha256,
    tools,
  })
}

items.sort((a, b) => a.id.localeCompare(b.id))

let document
if (keyPath) {
  const keyFile = path.resolve(keyPath)
  if (!existsSync(keyFile)) fail(`Signing key not found: ${keyFile}`)
  const privateKeyPem = readFileSync(keyFile, 'utf8')
  try {
    document = catalogCore.signCatalog(items, { privateKeyPem, keyId })
  } catch (err) {
    fail(`Signing failed: ${err && err.message ? err.message : String(err)}`)
  }
  console.log(`Signed ${items.length} plugin(s) with ${keyId}.`)
  try {
    const publicPem = readFileSync(path.join(path.dirname(keyFile), 'public.pem'), 'utf8')
    console.log(`Public fingerprint: ${catalogCore.fingerprint(publicPem)}`)
  } catch {
    /* the public key may live elsewhere */
  }
} else {
  document = { schema: catalogCore.SCHEMA, generatedAt: new Date().toISOString(), plugins: items }
  console.log(`Built an UNSIGNED catalog with ${items.length} plugin(s). Anyone can replace it — pass --key to sign.`)
}

mkdirSync(path.dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
const digest = createHash('sha256').update(readFileSync(out)).digest('hex')
console.log(`Wrote ${out}`)
console.log(`catalog sha256: ${digest}`)
