/**
 * Section 18 — visual regression against real Electron screenshots.
 *
 * Boots the app with an isolated profile, captures a fixed set of screens at a
 * fixed window size, and compares them pixel-by-pixel with the baselines in
 * tests/visual/baselines/. Dynamic regions are hidden before capture so the
 * comparison stays meaningful. Diff images and a JSON report land in reports/.
 *
 * Usage:
 *   node scripts/visual-compare.mjs                 # compare against baselines
 *   node scripts/visual-compare.mjs --update        # (re)write the baselines
 *   node scripts/visual-compare.mjs --target=source # use electron/ + dist/ instead of the packaged exe
 *   node scripts/visual-compare.mjs --threshold=0.004 --tolerance=12
 */

import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_DIR = path.join(ROOT, 'tests', 'visual', 'baselines')
const DIFF_DIR = path.join(ROOT, 'reports', 'visual-diff')
const REPORT_DIR = path.join(ROOT, 'reports')

const args = process.argv.slice(2)
const flag = (name, fallback = '') => {
  const prefix = `--${name}=`
  const hit = args.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

const UPDATE = args.includes('--update')
const TARGET = (flag('target', process.env.ORVEX_VISUAL_TARGET || 'packaged')).toLowerCase()
const EXE = process.env.ORVEX_E2E_EXE || path.join(ROOT, 'release', 'win-unpacked', 'ORVEX.exe')
const THRESHOLD = Math.max(0, Number(flag('threshold', '0.004')) || 0.004)
const TOLERANCE = Math.max(0, Number(flag('tolerance', '12')) || 12)

const SCREENS = [
  { name: 'chat-empty', nav: 'Chat', hide: [] },
  { name: 'productivity-calc', nav: 'Productivity', hide: ['#prod-caps'] },
  { name: 'productivity-compare', nav: 'Productivity', tab: 'compare', hide: ['#prod-caps'] },
  { name: 'advanced-teams', nav: 'Advanced', navTab: 'Agent teams', hide: [] },
  { name: 'advanced-plugins', nav: 'Advanced', navTab: 'Plugins & market', hide: [] },
  { name: 'tools-catalog', nav: 'Tools', hide: [] },
]

const results = []

async function comparePixels(baselinePath, shot, name) {
  const base = await sharp(baselinePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const next = await sharp(shot).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (base.info.width !== next.info.width || base.info.height !== next.info.height) {
    return {
      ok: false,
      status: 'size-mismatch',
      width: next.info.width,
      height: next.info.height,
      baselineWidth: base.info.width,
      baselineHeight: base.info.height,
      changed: next.info.width * next.info.height,
      total: next.info.width * next.info.height,
      ratio: 1,
    }
  }

  const width = next.info.width
  const height = next.info.height
  const total = width * height
  const diff = Buffer.alloc(total * 4)
  let changed = 0
  for (let i = 0; i < total; i += 1) {
    const o = i * 4
    const dr = Math.abs(base.data[o] - next.data[o])
    const dg = Math.abs(base.data[o + 1] - next.data[o + 1])
    const db = Math.abs(base.data[o + 2] - next.data[o + 2])
    const da = Math.abs(base.data[o + 3] - next.data[o + 3])
    if (Math.max(dr, dg, db, da) > TOLERANCE) {
      changed += 1
      diff[o] = 255
      diff[o + 1] = 0
      diff[o + 2] = 0
      diff[o + 3] = 255
    } else {
      const gray = Math.round((next.data[o] + next.data[o + 1] + next.data[o + 2]) / 3 / 4)
      diff[o] = gray
      diff[o + 1] = gray
      diff[o + 2] = gray
      diff[o + 3] = 255
    }
  }
  const ratio = changed / total
  const diffPath = path.join(DIFF_DIR, `${name}.png`)
  if (changed > 0) {
    mkdirSync(DIFF_DIR, { recursive: true })
    await sharp(diff, { raw: { width, height, channels: 4 } }).png().toFile(diffPath)
  }
  return {
    ok: ratio <= THRESHOLD,
    status: ratio <= THRESHOLD ? 'pass' : 'fail',
    width,
    height,
    changed,
    total,
    ratio: Math.round(ratio * 1e6) / 1e6,
    diffPath: changed > 0 ? diffPath : null,
  }
}

async function main() {
  if (TARGET === 'packaged' && !existsSync(EXE)) {
    console.error(`Packaged build missing: ${EXE}\nRun "npm run dist:dir" first, or pass --target=source.`)
    process.exit(2)
  }

  mkdirSync(BASELINE_DIR, { recursive: true })
  const profile = mkdtempSync(path.join(tmpdir(), 'orvex-visual-'))
  const env = { ...process.env, ORVEX_USER_DATA_DIR: profile, ORVEX_DISABLE_LOCAL_WHISPER: '1' }
  delete env.VITE_DEV_URL

  const launchOptions =
    TARGET === 'source'
      ? { args: [ROOT], cwd: ROOT, env, timeout: 90_000 }
      : { executablePath: EXE, args: [], env, timeout: 90_000 }

  console.log(`Launching ORVEX (${TARGET}) for visual comparison`)
  const app = await electron.launch(launchOptions)
  try {
    const win = await app.firstWindow({ timeout: 90_000 })
    await win.waitForSelector('.sidebar-area', { timeout: 60_000 })
    await win.waitForFunction(() => !!window.orvex, null, { timeout: 30_000 })

    await app.evaluate(async ({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows().find((w) => w.isVisible()) || BrowserWindow.getAllWindows()[0]
      if (target) {
        target.setSize(1480, 940)
        target.center()
      }
    })
    await win.waitForTimeout(600)

    await win.addStyleTag({
      content:
        '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}' +
        '::-webkit-scrollbar{width:10px!important;height:10px!important}',
    })

    async function openNav(label) {
      await win.locator('nav[aria-label="Primary"] .nav-item').evaluateAll((nodes, wanted) => {
        const target = nodes.find((n) => (n.querySelector('.nav-label')?.textContent || '').trim().toLowerCase() === wanted.toLowerCase())
        if (target) target.click()
      }, label)
      await win.waitForSelector('.page-area', { timeout: 10_000 })
      await win.waitForTimeout(400)
    }

    for (const screen of SCREENS) {
      try {
        await openNav(screen.nav)
        if (screen.tab) {
          await win.locator(`[data-testid="prod-tab-${screen.tab}"]`).click()
          await win.waitForFunction(
            (id) => document.querySelector(`[data-testid="prod-tab-${id}"]`)?.getAttribute('aria-selected') === 'true',
            screen.tab,
            { timeout: 5_000 },
          )
          await win.waitForTimeout(300)
        }
        if (screen.navTab) {
          await win.locator('.adv-tabs [role="tab"]').filter({ hasText: screen.navTab }).first().click()
          await win.waitForFunction(
            (want) => [...document.querySelectorAll('.adv-tabs [role="tab"]')].some((n) => (n.textContent || '').trim() === want && n.getAttribute('aria-selected') === 'true'),
            screen.navTab,
            { timeout: 5_000 },
          )
          await win.waitForTimeout(300)
        }
        if (screen.hide.length) {
          await win
            .waitForFunction((sels) => sels.every((sel) => document.querySelector(sel)), screen.hide, { timeout: 15_000 })
            .catch(() => {})
          for (const selector of screen.hide) {
            await win.evaluate((sel) => {
              document.querySelectorAll(sel).forEach((el) => {
                el.style.visibility = 'hidden'
              })
            }, selector)
          }
        }
        await win.waitForTimeout(250)

        const shot = await win.locator('.page-area').screenshot({ animations: 'disabled' })
        const baselinePath = path.join(BASELINE_DIR, `${screen.name}.png`)

        if (UPDATE || !existsSync(baselinePath)) {
          writeFileSync(baselinePath, shot)
          results.push({
            name: screen.name,
            status: UPDATE ? 'updated' : 'created',
            ok: true,
            baseline: baselinePath,
            bytes: shot.length,
          })
          console.log(`${UPDATE ? 'UPDATE' : 'CREATE'}  ${screen.name}  (${shot.length} bytes)`)
          continue
        }

        const cmp = await comparePixels(baselinePath, shot, screen.name)
        results.push({ name: screen.name, baseline: baselinePath, ...cmp })
        const pct = (cmp.ratio * 100).toFixed(3)
        console.log(`${cmp.ok ? 'PASS' : 'FAIL'}    ${screen.name}  ${cmp.width}x${cmp.height}  changed ${cmp.changed}/${cmp.total} (${pct}%)${cmp.diffPath ? `  diff ${cmp.diffPath}` : ''}`)
      } catch (err) {
        results.push({ name: screen.name, status: 'error', ok: false, error: String(err && err.message ? err.message : err) })
        console.log(`ERROR   ${screen.name} — ${String(err && err.message ? err.message : err).slice(0, 200)}`)
      }
    }
  } finally {
    try {
      await app.close()
    } catch {
      /* already closed */
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(profile, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 300))
      }
    }
  }

  const failed = results.filter((r) => !r.ok)
  const created = results.filter((r) => r.status === 'created' || r.status === 'updated')
  const report = {
    generatedAt: new Date().toISOString(),
    target: TARGET,
    threshold: THRESHOLD,
    tolerance: TOLERANCE,
    update: UPDATE,
    passed: results.filter((r) => r.ok).length,
    failed: failed.length,
    created: created.length,
    screens: results,
  }
  mkdirSync(REPORT_DIR, { recursive: true })
  const reportPath = path.join(REPORT_DIR, 'visual-latest.json')
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  console.log(`\n${results.length - failed.length}/${results.length} screens matched${created.length ? `, ${created.length} baseline(s) written` : ''}`)
  console.log(`report: ${reportPath}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error('visual-compare crashed:', err)
  process.exit(1)
})
