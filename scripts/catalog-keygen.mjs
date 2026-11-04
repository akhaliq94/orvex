import { createRequire } from 'node:module'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const catalogCore = require('../electron/catalog.cjs')

const args = process.argv.slice(2)
const flag = (name, fallback = '') => {
  const prefix = `--${name}=`
  const hit = args.find((a) => a.startsWith(prefix))
  if (hit) return hit.slice(prefix.length)
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback
}

const dir = path.resolve(flag('dir', 'catalog-keys'))
const keyId = flag('key-id', 'orvex-catalog').slice(0, 64)
const force = args.includes('--force')
const privatePath = path.join(dir, 'private.pem')
const publicPath = path.join(dir, 'public.pem')

if (existsSync(privatePath) && !force) {
  console.error(`Refusing to overwrite ${privatePath}. Pass --force only if you are rotating the key on purpose.`)
  process.exit(1)
}

mkdirSync(dir, { recursive: true })
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' })
const publicPem = publicKey.export({ type: 'spki', format: 'pem' })

writeFileSync(privatePath, privatePem, { mode: 0o600 })
writeFileSync(publicPath, `${publicPem}`, 'utf8')
try {
  chmodSync(privatePath, 0o600)
} catch {
  /* Windows ignores the mode */
}

const fingerprint = catalogCore.fingerprint(publicPem)
const publicSha = createHash('sha256').update(publicPem).digest('hex')

console.log(`Private key: ${privatePath} (keep this offline; never commit it)`)
console.log(`Public key:  ${publicPath}`)
console.log(`Key id:      ${keyId}`)
console.log(`Fingerprint: ${fingerprint}`)
console.log(`SHA-256:     ${publicSha}`)
console.log('')
console.log('Trusted key JSON for Settings → Plugins & market:')
console.log(JSON.stringify([{ keyId, publicKey: publicPem }], null, 2))
