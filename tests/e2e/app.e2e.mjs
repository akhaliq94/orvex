/**
 * Section 18 — real Electron end-to-end suite (Playwright).
 *
 * Boots the actual app with an isolated profile, walks every sidebar page,
 * drives each Productivity tab, runs the twelve live health probes, and calls
 * the real IPC bridge. Nothing is mocked: a failure here means the shipped
 * build is broken.
 *
 * Usage:
 *   node tests/e2e/app.e2e.mjs                 # packaged release/win-unpacked build
 *   ORVEX_E2E_TARGET=source node tests/e2e/app.e2e.mjs
 *   ORVEX_E2E_EXE="D:\path\ORVEX.exe" node tests/e2e/app.e2e.mjs
 */

import { _electron as electron } from 'playwright'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const flag = (name, fallback = '') => {
  const prefix = `--${name}=`
  const hit = args.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}
const TARGET = (flag('target', process.env.ORVEX_E2E_TARGET || 'packaged')).toLowerCase()
const EXE = process.env.ORVEX_E2E_EXE || path.join(ROOT, 'release', 'win-unpacked', 'ORVEX.exe')

const results = []
const pageErrors = []

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  if (TARGET === 'packaged' && !existsSync(EXE)) {
    console.error(`Packaged build missing: ${EXE}\nRun "npm run dist:dir" first, or set ORVEX_E2E_TARGET=source.`)
    process.exit(2)
  }

  const profile = mkdtempSync(path.join(tmpdir(), 'orvex-e2e-'))
  const env = { ...process.env, ORVEX_USER_DATA_DIR: profile }
  delete env.VITE_DEV_URL

  const launchOptions =
    TARGET === 'source'
      ? { args: [ROOT], cwd: ROOT, env, timeout: 90_000 }
      : { executablePath: EXE, args: [], env, timeout: 90_000 }

  console.log(`Launching ORVEX (${TARGET}) with profile ${profile}`)
  const app = await electron.launch(launchOptions)
  let win = null

  try {
    win = await app.firstWindow({ timeout: 90_000 })
    win.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)))
    await win.waitForLoadState('domcontentloaded')

    /* ---------------------------------------------------------- boot */
    check('window opens', !!win)
    check('window title is ORVEX', /orvex/i.test(await win.title()), await win.title())
    const url = win.url()
    check('renderer is the packaged bundle or dev server', /^file:/.test(url) || /^https?:/.test(url), url)

    await win.waitForSelector('.sidebar-area', { timeout: 30_000 })
    await win.waitForFunction(() => !!window.orvex, null, { timeout: 30_000 })

    const navCount = await win.locator('nav[aria-label="Primary"] .nav-item').count()
    check('all 28 sidebar destinations render', navCount === 28, `${navCount} items`)

    const bodyLen = (await win.locator('body').innerText()).length
    check('shell renders content', bodyLen > 400, `${bodyLen} chars`)

    const bridge = await win.evaluate(() => {
      const b = window.orvex || {}
      const want = [
        'agent', 'air', 'advanced', 'app', 'audit', 'budget', 'code', 'dashboard', 'db', 'desktop',
        'files', 'health', 'integrations', 'connectors', 'llm', 'mcp', 'mcpServer', 'media', 'memory',
        'monitor', 'oauth', 'orchestrator', 'permissions', 'productivity', 'research',
        'routing', 'secrets', 'security', 'tools', 'training', 'usage', 'workflows', 'learner', 'workforce',
        'hands', 'maker', 'advisor', 'gamePilot',
      ]
      return { isDesktop: b.isDesktop === true, missing: want.filter((k) => !b[k]) }
    })
    check('preload exposes the whole bridge', bridge.isDesktop && bridge.missing.length === 0, bridge.missing.join(',') || '38 modules')

    const guardBridge = await win.evaluate(async () => {
      const perms = window.orvex.permissions
      const state = await perms.state()
      return {
        addFloor: typeof perms.addFloor === 'function',
        removeFloor: typeof perms.removeFloor === 'function',
        floorsArray: !!(state && state.ok && Array.isArray(state.data.floors)),
        floorCount: !!(state && state.ok && typeof state.data.counts.floors === 'number'),
      }
    })
    check(
      'approval floors are exposed through the bridge',
      guardBridge.addFloor && guardBridge.removeFloor && guardBridge.floorsArray && guardBridge.floorCount,
      JSON.stringify(guardBridge),
    )

    /* --------------------------------------------------- real IPC reads */
    const planningTools = await win.evaluate(async () => {
      const res = await window.orvex.workflows.tools()
      const names = res && res.ok && res.data && Array.isArray(res.data.tools) ? res.data.tools.map((tool) => tool.name) : []
      const wanted = ['todo_add', 'todo_complete', 'todo_remove', 'todo_list', 'delegate_start', 'delegate_status', 'delegate_wait', 'delegate_result', 'delegate_cancel', 'browser_task']
      return { found: wanted.filter((name) => names.includes(name)) }
    })
    check(
      'plan, delegation and fast-browser tools are registered',
      planningTools.found.length === 10,
      `${planningTools.found.length}/10`,
    )

    const snap = await win.evaluate(() => window.orvex.dashboard.snapshot())
    check(
      'dashboard snapshot is real system data',
      !!(snap && snap.ok && snap.data && snap.data.system && snap.data.system.cores > 0 && !!snap.data.system.hostname),
      snap && snap.ok ? `${snap.data.system.hostname} / ${snap.data.system.cores} cores` : snap && snap.error,
    )

    const dbInfo = await win.evaluate(() => window.orvex.db.info())
    check('SQLite database opens', !!(dbInfo && dbInfo.ok && dbInfo.data && dbInfo.data.ready), dbInfo && dbInfo.ok ? String(dbInfo.data.file) : dbInfo && dbInfo.error)
    check('database lives in the isolated profile', !!(dbInfo && dbInfo.ok && String(dbInfo.data.file).startsWith(profile)), dbInfo && dbInfo.ok ? String(dbInfo.data.file) : '')

    const overview = await win.evaluate(() => window.orvex.monitor.overview())
    check('monitor overview returns live counters', !!(overview && overview.ok && overview.data), overview && overview.error)

    const status = await win.evaluate(() => window.orvex.security.status())
    check(
      'security status answers with the owner role',
      !!(status && status.ok && status.data && status.data.role === 'owner' && status.data.locked === false),
      status && status.ok ? `role=${status.data.role} locked=${status.data.locked}` : status && status.error,
    )

    const usage = await win.evaluate(() => window.orvex.usage.summary(86_400_000))
    check('usage summary answers', !!(usage && usage.ok && usage.data && Array.isArray(usage.data.byModel)), usage && usage.error)

    const budget = await win.evaluate(() => window.orvex.budget.get())
    check(
      'budget exposes daily and monthly limits',
      !!(budget && budget.ok && budget.data && typeof budget.data.dailyUsd === 'number' && typeof budget.data.monthlyUsd === 'number'),
      budget && budget.ok ? `today=$${Number(budget.data.todayUsd || 0).toFixed(2)}` : budget && budget.error,
    )

    const advice = await win.evaluate(() => window.orvex.advisor.brief())
    check(
      'advisor brief is built from real state',
      !!(advice && advice.ok && advice.data && advice.data.stats && typeof advice.data.stats.runsToday === 'number' && Array.isArray(advice.data.top)),
      advice && advice.ok ? advice.data.headline : advice && advice.error,
    )

    const audit = await win.evaluate(() => window.orvex.audit.tail(5))
    check('audit log is readable', !!(audit && audit.ok && Array.isArray(audit.data)), audit && audit.error)

    const prefs = await win.evaluate(() => window.orvex.app.prefs())
    check('prefs round-trip through IPC', !!(prefs && prefs.ok && prefs.data && typeof prefs.data.closeToTray === 'boolean'))

    const engineRecovery = await win.evaluate(async () => {
      const before = await window.orvex.orchestrator.runs(1)
      const off = await window.orvex.orchestrator.setAutoResume(false)
      const on = await window.orvex.orchestrator.setAutoResume(true)
      return {
        runsOk: !!(before && before.ok && Array.isArray(before.data.resumable) && before.data.autoResume === true),
        toggled: !!(off && off.ok && off.data.enabled === false && on && on.ok && on.data.enabled === true),
      }
    })
    check(
      'engine exposes interrupted-plan recovery and the auto-resume switch',
      engineRecovery.runsOk && engineRecovery.toggled,
      JSON.stringify(engineRecovery),
    )

    const updaterState = await win.evaluate(async () => {
      const before = await window.orvex.updater.state()
      const saved = await window.orvex.updater.setRepo('acme/orvex-releases')
      const cleared = await window.orvex.updater.setRepo('')
      const auto = await window.orvex.updater.setAutoCheck(true)
      return {
        stateOk: !!(before && before.ok && before.data && typeof before.data.current === 'string' && typeof before.data.portable === 'boolean'),
        saved: !!(saved && saved.ok && saved.data.repo === 'acme/orvex-releases'),
        // An emptied setting falls back to the built-in public release channel.
        cleared: !!(cleared && cleared.ok && cleared.data.repo === before.data.repo && cleared.data.repo.includes('/')),
        auto: !!(auto && auto.ok && auto.data.autoCheck === true),
      }
    })
    check(
      'github updater state, repo and auto-check round-trip over IPC',
      updaterState.stateOk && updaterState.saved && updaterState.cleared && updaterState.auto,
      JSON.stringify(updaterState),
    )

    const gameBridge = await win.evaluate(async () => {
      const profiles = await window.orvex.gamePilot.profiles()
      const status = await window.orvex.gamePilot.status()
      return {
        profiles: !!(profiles && profiles.ok && Array.isArray(profiles.data)),
        status: !!(status && status.ok && status.data && typeof status.data.running === 'boolean' && typeof status.data.hotkey === 'string'),
      }
    })
    check(
      'game pilot exposes profiles and a live run status over IPC',
      gameBridge.profiles && gameBridge.status,
      JSON.stringify(gameBridge),
    )

    /* ------------------------------------------- no demo copy anywhere */
    const DEMO_COPY = /demo mode|sample data|mock data|fake data|placeholder data|simulated data|data is simulated|simulated demo|coming soon/i

    /* ------------------------------------------------ every page mounts */
    const pages = [
      ['chat', 'Chat'],
      ['voice', 'Voice'],
      ['agents', 'Agents'],
      ['workforce', 'Workforce'],
      ['advisor', 'Advisor'],
      ['engine', 'Engine'],
      ['code', 'Code'],
      ['maker', 'Maker'],
      ['browser', 'Browser'],
      ['research', 'Research'],
      ['files', 'Files'],
      ['media', 'Media'],
      ['automation', 'Automation'],
      ['tools', 'Tools'],
      ['productivity', 'Productivity'],
      ['training', 'Training'],
      ['advanced', 'Advanced'],
      ['knowledge', 'Knowledge'],
      ['memory', 'Memory'],
      ['integrations', 'Integrations'],
      ['monitoring', 'Monitoring'],
      ['security', 'Security'],
      ['system', 'System'],
      ['control-pc', 'Control PC'],
      ['game', 'Game Pilot'],
      ['air-touch', 'Air Touch'],
      ['settings', 'Settings'],
    ]

    async function openNav(id) {
      await win.locator(`nav[aria-label="Primary"] .nav-item`).evaluateAll((nodes, wanted) => {
        const target = nodes.find((n) => (n.querySelector('.nav-label')?.textContent || '').trim().toLowerCase() === wanted.toLowerCase())
        if (target) target.click()
      }, id === 'control-pc' ? 'Control PC' : id === 'air-touch' ? 'Air Touch' : id === 'game' ? 'Game Pilot' : id)
      await win.waitForSelector('.page-title', { timeout: 10_000 })
    }

    // Home is the dashboard, not a PageShell, so it is asserted separately
    // instead of being falsely marked as a missing page title.
    await win.locator('nav[aria-label="Primary"] .nav-item').evaluateAll((nodes) => {
      const target = nodes.find((n) => (n.querySelector('.nav-label')?.textContent || '').trim().toLowerCase() === 'home')
      if (target) target.click()
    })
    await win.waitForSelector('.widgets-area', { timeout: 10_000 })
    const homeActive = await win.evaluate(
      () => (document.querySelector('nav[aria-label="Primary"] .nav-item[aria-current="page"] .nav-label')?.textContent || '').trim(),
    )
    check('Home is the active destination', homeActive === 'Home', homeActive || 'no active nav item')
    const homeText = await win.locator('.orvex-app').innerText()
    check('Home dashboard mounts with real content', homeText.length > 400, `${homeText.length} chars`)
    check('Home dashboard shows no demo copy', !DEMO_COPY.test(homeText))

    for (const [id, title] of pages) {
      try {
        await openNav(id)
        await win.waitForFunction(
          (wanted) => (document.querySelector('.page-title')?.textContent || '').trim() === wanted,
          title,
          { timeout: 10_000 },
        )
        const text = await win.locator('.page-area').innerText()
        check(`${title} page mounts with real content`, text.length > 120, `${text.length} chars`)
        check(`${title} page shows no demo copy`, !DEMO_COPY.test(text))
      } catch (err) {
        check(`${title} page mounts with real content`, false, String(err.message || err).slice(0, 160))
      }
    }

    /* ---------------------------------------------- productivity tabs */
    await openNav('productivity')
    const prodTabs = [
      'calc', 'data', 'sheet', 'sql', 'reports', 'meetings',
      'notes', 'tasks', 'translate', 'text', 'slides', 'compare',
    ]
    const seenTabs = []
    for (const tab of prodTabs) {
      const btn = win.locator(`[data-testid="prod-tab-${tab}"]`)
      if ((await btn.count()) !== 1) {
        check(`productivity tab ${tab} exists`, false)
        continue
      }
      await btn.click()
      await win.waitForFunction(
        (id) => document.querySelector(`[data-testid="prod-tab-${id}"]`)?.getAttribute('aria-selected') === 'true',
        tab,
        { timeout: 5_000 },
      )
      const text = await win.locator('.prod').innerText()
      seenTabs.push(tab)
      check(`productivity tab ${tab} renders its workspace`, text.length > 200, `${text.length} chars`)
    }
    check('all twelve productivity tabs drive real panels', seenTabs.length === 12, seenTabs.join(','))
    const capText = await win.locator('#prod-caps').innerText().catch(() => '')
    check('productivity capability chips report this machine', /python|xlsx|sqlite/i.test(capText), capText.replace(/\s+/g, ' ').slice(0, 120))

    /* -------------------------------------------------- advanced tabs */
    await openNav('advanced')
    const advTabs = [
      'Overview & modes', 'Agent teams', 'Vision', 'Context & rules', 'Autonomous jobs',
      'Adaptive routing', 'Devices', 'Learning', 'Plugins & market', 'Recovery',
    ]
    const seenAdv = []
    for (const label of advTabs) {
      const btn = win.locator('.adv-tabs [role="tab"]').filter({ hasText: label }).first()
      if ((await btn.count()) !== 1) {
        check(`advanced tab ${label} exists`, false)
        continue
      }
      await btn.click()
      await win.waitForFunction(
        (want) => [...document.querySelectorAll('.adv-tabs [role="tab"]')].some((n) => (n.textContent || '').trim() === want && n.getAttribute('aria-selected') === 'true'),
        label,
        { timeout: 5_000 },
      )
      const text = await win.locator('.adv').innerText()
      seenAdv.push(label)
      check(`advanced tab ${label} renders its panel`, text.length > 200, `${text.length} chars`)
    }
    check('all ten advanced tabs drive real panels', seenAdv.length === 10, seenAdv.join(','))

    /* -------------------------------------------------- training tabs */
    await openNav('training')
    const trainingTabs = ['Overview', 'Vault & quota', 'Episodes', 'Skills & scorer', 'Train kit', 'Fine-tune', 'Local brain']
    const seenTraining = []
    for (const label of trainingTabs) {
      const btn = win.locator('.adv-tabs [role="tab"]').filter({ hasText: label }).first()
      if ((await btn.count()) !== 1) {
        check(`training tab ${label} exists`, false)
        continue
      }
      await btn.click()
      await win.waitForFunction(
        (want) => [...document.querySelectorAll('.adv-tabs [role="tab"]')].some((n) => (n.textContent || '').trim() === want && n.getAttribute('aria-selected') === 'true'),
        label,
        { timeout: 5_000 },
      )
      const text = await win.locator('.adv').innerText()
      seenTraining.push(label)
      check(`training tab ${label} renders its panel`, text.length > 150, `${text.length} chars`)
    }
    check('all seven training tabs drive real panels', seenTraining.length === 7, seenTraining.join(','))
    const brainText = await win.locator('.adv').innerText()
    check('local brain reports the runtime honestly', /llama-server/i.test(brainText), brainText.replace(/\s+/g, ' ').slice(0, 120))
    await win.locator('.adv-tabs [role="tab"]', { hasText: 'Skills & scorer' }).click()
    await win.waitForFunction(
      () => [...document.querySelectorAll('.adv-tabs [role="tab"]')].some((n) => (n.textContent || '').trim() === 'Skills & scorer' && n.getAttribute('aria-selected') === 'true'),
      null,
      { timeout: 5_000 },
    )
    const skillsText = await win.locator('.adv').innerText()
    check('skill studio exposes manual and import controls', /Skill studio/i.test(skillsText) && /Import/i.test(skillsText) && /Steps/i.test(skillsText), skillsText.replace(/\s+/g, ' ').slice(0, 120))

    /* -------------------------------------------------- workforce IPC */
    const wfStatus = await win.evaluate(() => window.orvex.workforce.status())
    check(
      'workforce status answers with scheduler truth',
      !!(wfStatus && wfStatus.ok && wfStatus.data && typeof wfStatus.data.total === 'number' && typeof wfStatus.data.scheduler === 'boolean'),
      wfStatus && wfStatus.ok ? `${wfStatus.data.total} agents` : wfStatus && wfStatus.error,
    )
    const wfInbox = await win.evaluate(() => window.orvex.workforce.inbox({ limit: 5 }))
    check('workforce inbox answers', !!(wfInbox && wfInbox.ok && Array.isArray(wfInbox.data.messages)), wfInbox && wfInbox.error)
    const wfTick = await win.evaluate(() => window.orvex.workforce.tick())
    check('workforce scheduler tick runs honestly', !!(wfTick && wfTick.ok && Array.isArray(wfTick.data.started)), wfTick && wfTick.error)
    await openNav('workforce')
    const wfText = await win.locator('.adv').innerText()
    check('workforce page shows the real agent form', /New agent|Edit agent/i.test(wfText) && /Mission/i.test(wfText), wfText.replace(/\s+/g, ' ').slice(0, 120))

    /* --------------------------------------------- OpenAPI connector IPC */
    const connList = await win.evaluate(() => window.orvex.connectors.list())
    check('connector list answers', !!(connList && connList.ok && Array.isArray(connList.data.connectors)), connList && connList.error)
    const connPreview = await win.evaluate(() =>
      window.orvex.connectors.preview({
        spec: {
          openapi: '3.0.0',
          info: { title: 'E2E API', version: '1.0.0' },
          servers: [{ url: 'https://api.example.com' }],
          paths: { '/ping': { get: { operationId: 'ping', summary: 'Ping' } } },
        },
      }),
    )
    check(
      'OpenAPI preview parses a real spec',
      !!(connPreview && connPreview.ok && connPreview.data.ops.length === 1 && connPreview.data.baseUrl === 'https://api.example.com'),
      connPreview && connPreview.ok ? connPreview.data.ops[0].id : connPreview && connPreview.error,
    )
    await openNav('integrations')
    await win.locator('.dc-tabs .dc-tab', { hasText: 'API connectors' }).click()
    const connText = await win.locator('.ig-page').innerText()
    check('Integrations exposes the API connectors panel', /Import connector/i.test(connText) && /OpenAPI/i.test(connText), connText.replace(/\s+/g, ' ').slice(0, 120))

    /* ------------------------------------------------- monitoring health */
    await openNav('monitoring')
    const healthTab = win.locator('.mon-tabs [role="tab"]').filter({ hasText: 'Health' }).first()
    await healthTab.click()
    await win.waitForFunction(
      () => (document.querySelector('.mon-tabs .settings-tab.active')?.textContent || '').trim() === 'Health',
      null,
      { timeout: 10_000 },
    )
    await win.waitForFunction(() => document.querySelectorAll('.mon-health-row').length === 12, null, { timeout: 25_000 })
    const rows = await win.locator('.mon-health-row').count()
    check('all twelve health probes run', rows === 12, `${rows} rows`)
    const dbProbeOk = await win.evaluate(() =>
      [...document.querySelectorAll('.mon-health-row')].some(
        (n) => n.textContent.includes('SQLite store') && n.classList.contains('ok'),
      ),
    )
    check('the database health probe passes', dbProbeOk)
    check('health page shows no demo copy', !DEMO_COPY.test(await win.locator('.page-area').innerText()))

    /* ------------------------------------------------------- security */
    await openNav('security')
    const secText = await win.locator('.page-area').innerText()
    check('security page renders policy status', /Role|Audit|Policy|Secrets/i.test(secText), `${secText.length} chars`)
    check('security page shows no demo copy', !DEMO_COPY.test(secText))

    /* ---------------------------------------------- uncaught renderer errors */
    check('no uncaught renderer errors while walking pages', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

    /* --------------------------------------------------------- clean close */
    const child = app.process()
    await app.close()
    await sleep(1_500)
    check('app quits cleanly after close', child.exitCode !== null, `exitCode=${child.exitCode}`)
  } catch (err) {
    check('e2e run completes', false, String(err && err.stack ? err.stack : err).slice(0, 500))
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
        await sleep(400)
      }
    }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    console.log('Failed:')
    for (const f of failed) console.log(`  - ${f.name}`)
  }
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error('e2e crashed:', err)
  process.exit(1)
})
