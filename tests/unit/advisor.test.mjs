import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const advisor = require('../../electron/advisor.cjs')
const db = require('../../electron/db.cjs')

const DAY = 24 * 3600 * 1000

// The native SQLite build targets Electron's ABI, so unit tests stub only the
// four db calls the advisor makes instead of opening a database.
const settings = new Map()
const fake = { runsRow: { total: 0, failed: 0, done: 0, running: 0, finished: 0 }, todayUsd: 0 }
const original = { getSetting: db.getSetting, setSetting: db.setSetting, raw: db.raw, usageCostSince: db.usageCostSince }

function cleanSignals(overrides = {}) {
  return {
    at: Date.now(),
    version: '1.0.0',
    model: { chat: true, vision: true },
    runs: { today: 0, failed: 0, done: 0, running: 0, finished: 0 },
    budget: advisor.budgetStatus({}),
    inbox: { unread: 0 },
    crashes: [],
    backups: { count: 1, lastAt: Date.now() - 3600 * 1000 },
    training: { episodes: 0, overQuota: false, diskTight: false },
    brain: { enabled: true, offline: false, runtimeFound: true, models: 0 },
    learner: { kits: 1, skills: { suggested: 0 } },
    advanced: { suggestions: 0, interruptedJobs: 0 },
    update: { last: null },
    ...overrides,
  }
}

beforeAll(() => {
  db.getSetting = (key, fallback = null) => (settings.has(String(key)) ? structuredClone(settings.get(String(key))) : fallback)
  db.setSetting = (key, value) => {
    settings.set(String(key), structuredClone(value))
    return value
  }
  db.usageCostSince = () => fake.todayUsd
  db.raw = () => ({
    prepare: () => ({
      get: () => fake.runsRow,
      run: () => ({ changes: 1 }),
    }),
  })
})

afterAll(() => {
  Object.assign(db, original)
})

describe('semver comparison', () => {
  it('orders releases, prefixes and prereleases', () => {
    expect(advisor.compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(advisor.compareVersions('v1.2.3', '1.2.4')).toBe(-1)
    expect(advisor.compareVersions('2.0.0', '1.9.9')).toBe(1)
    expect(advisor.compareVersions('1.10.0', '1.9.0')).toBe(1)
    expect(advisor.compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1)
    expect(advisor.compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1)
  })
})

describe('update feed parsing', () => {
  it('accepts public https feeds and rejects everything else', () => {
    expect(advisor.isFeedUrl('https://updates.example.com/orvex.json')).toBe(true)
    expect(advisor.isFeedUrl('http://updates.example.com/orvex.json')).toBe(false)
    expect(advisor.isFeedUrl('https://localhost/feed')).toBe(false)
    expect(advisor.isFeedUrl('https://127.0.0.1/feed')).toBe(false)
    expect(advisor.isFeedUrl('https://10.1.2.3/feed')).toBe(false)
    expect(advisor.isFeedUrl('https://192.168.1.5/feed')).toBe(false)
    expect(advisor.isFeedUrl('https://172.20.0.1/feed')).toBe(false)
    expect(advisor.isFeedUrl('https://user:pass@example.com/feed')).toBe(false)
    expect(advisor.isFeedUrl('not a url')).toBe(false)
  })

  it('normalizes a generic feed and a GitHub releases response', () => {
    expect(
      advisor.normalizeFeed({ version: 'v3.2.1', url: 'https://example.com/r', notes: 'fixes', publishedAt: '2026-11-01' }),
    ).toMatchObject({ latest: '3.2.1', url: 'https://example.com/r', notes: 'fixes', publishedAt: '2026-11-01' })
    expect(advisor.normalizeFeed({ tag_name: 'v1.4.0', html_url: 'https://github.com/x/y', body: 'notes' })).toMatchObject({
      latest: '1.4.0',
      url: 'https://github.com/x/y',
      notes: 'notes',
    })
    expect(() => advisor.normalizeFeed({ url: 'https://example.com' })).toThrow(/version/i)
    expect(() => advisor.normalizeFeed(null)).toThrow()
  })
})

describe('budgets', () => {
  it('reports reached, near and remaining amounts', () => {
    const open = advisor.budgetStatus({})
    expect(open.dailyPct).toBeNull()
    expect(open.dailyReached).toBe(false)
    expect(open.remainingTodayUsd).toBeNull()

    const near = advisor.budgetStatus({ dailyUsd: 10, todayUsd: 8, monthlyUsd: 100, monthUsd: 90 })
    expect(near.dailyPct).toBe(80)
    expect(near.dailyNear).toBe(true)
    expect(near.dailyReached).toBe(false)
    expect(near.monthlyNear).toBe(true)
    expect(near.remainingTodayUsd).toBe(2)
    expect(near.remainingMonthUsd).toBe(10)

    const over = advisor.budgetStatus({ dailyUsd: 5, todayUsd: 6, monthlyUsd: 20, monthUsd: 20 })
    expect(over.dailyReached).toBe(true)
    expect(over.monthlyReached).toBe(true)
    expect(over.remainingTodayUsd).toBe(0)
  })

  it('validates values before saving', () => {
    expect(() => advisor.setBudget({ dailyUsd: -1 })).toThrow()
    expect(() => advisor.setBudget({ monthlyUsd: 1_000_001 })).toThrow()
  })
})

describe('suggestion rules', () => {
  it('stays empty when nothing needs attention', () => {
    expect(advisor.buildSuggestions(cleanSignals())).toEqual([])
  })

  it('produces every real signal as a ranked suggestion', () => {
    const items = advisor.buildSuggestions(
      cleanSignals({
        model: { chat: false },
        runs: { today: 3, failed: 2, done: 1, finished: 3, running: 0 },
        budget: advisor.budgetStatus({ dailyUsd: 10, todayUsd: 10, monthlyUsd: 50, monthUsd: 50 }),
        inbox: { unread: 2 },
        crashes: [{ at: Date.now() - 1000 }],
        backups: { count: 0, lastAt: 0 },
        training: { episodes: 25, overQuota: true, diskTight: true },
        brain: { enabled: true, offline: true, runtimeFound: false, models: 0 },
        learner: { kits: 0, skills: { suggested: 2 } },
        advanced: { suggestions: 1, interruptedJobs: 1 },
        update: { last: { available: true, latest: '1.1.0', url: 'https://example.com/release' } },
      }),
    )
    const ids = items.map((item) => item.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'model-missing',
        'budget-daily',
        'budget-monthly',
        'run-failures',
        'recent-crashes',
        'interrupted-jobs',
        'learning-review',
        'inbox-unread',
        'training-quota',
        'training-disk',
        'train-kit',
        'skills-review',
        'backup-missing',
        'brain-offline',
        'update-available',
      ]),
    )
    expect(items.find((item) => item.id === 'model-missing').severity).toBe('critical')
    expect(items.find((item) => item.id === 'update-available').url).toBe('https://example.com/release')
    expect(items.find((item) => item.id === 'run-failures').count).toBe(2)
  })

  it('filters dismissed entries and ranks by score', () => {
    const items = [
      { id: 'b', severity: 'medium', title: 'B', detail: '', action: null, score: 45 },
      { id: 'a', severity: 'high', title: 'A', detail: '', action: null, score: 70 },
      { id: 'c', severity: 'low', title: 'C', detail: '', action: null, score: 20 },
    ]
    const ranked = advisor.rankSuggestions(items, { c: Date.now() + 60_000 })
    expect(ranked.map((item) => item.id)).toEqual(['a', 'b'])
    expect(ranked.map((item) => item.rank)).toEqual([1, 2])

    const expired = advisor.rankSuggestions(items, { c: Date.now() - 60_000 })
    expect(expired.map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('live collection, dismissals and the daily brief', () => {
  beforeAll(() => {
    fake.runsRow = { total: 1, failed: 1, done: 0, running: 0, finished: 1 }
    fake.todayUsd = 2
    advisor.init({
      version: '2.0.0',
      providers: {
        model: () => ({ chat: false, vision: false }),
        workforce: () => ({ unread: 2 }),
        backups: () => [{ at: Date.now() - 10 * DAY }],
        advanced: () => ({ suggestions: 0, interruptedJobs: 1 }),
        crashes: () => [],
      },
    })
  })

  it('ranks real signals and persists a dismissal', async () => {
    const before = await advisor.suggestions({ force: true })
    const ids = before.items.map((item) => item.id)
    expect(ids).toEqual(expect.arrayContaining(['model-missing', 'run-failures', 'interrupted-jobs', 'inbox-unread', 'backup-stale']))

    const result = advisor.dismiss({ id: 'inbox-unread', hours: 1 })
    expect(result.dismissed).toBeGreaterThan(0)
    const after = await advisor.suggestions({ force: true })
    expect(after.items.map((item) => item.id)).not.toContain('inbox-unread')
    expect(advisor._internals.readDismissed()['inbox-unread']).toBeGreaterThan(Date.now())

    advisor.restore({ id: 'inbox-unread' })
    const restored = await advisor.suggestions({ force: true })
    expect(restored.items.map((item) => item.id)).toContain('inbox-unread')
    advisor.restore()
  })

  it('builds a brief from real runs, spend and inbox', async () => {
    advisor.setBudget({ dailyUsd: 2, monthlyUsd: 10 })
    const data = await advisor.brief({ force: true })
    expect(data.stats.runsToday).toBeGreaterThan(0)
    expect(data.stats.runsFailed).toBeGreaterThan(0)
    expect(data.stats.unread).toBe(2)
    expect(data.stats.spendToday).toBe(2)
    expect(data.stats.successRate).toBe(0)
    expect(data.budget.dailyReached).toBe(true)
    expect(data.budget.remainingMonthUsd).toBe(8)
    expect(data.top[0].severity).toBe('critical')
    expect(data.itemsCount).toBeGreaterThan(0)
    expect(data.highlights.length).toBeGreaterThan(2)
    expect(advisor.formatBrief(data)).toContain(data.headline)
  })
})

describe('update checks with an injected fetch', () => {
  it('stores a newer release and exposes it as a suggestion', async () => {
    advisor.init({
      version: '2.0.0',
      providers: {
        model: () => ({ chat: true }),
        backups: () => [{ at: Date.now() }],
        workforce: () => ({ unread: 0 }),
        advanced: () => ({ suggestions: 0, interruptedJobs: 0 }),
      },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ version: '2.1.0', url: 'https://example.com/release', notes: 'notes' }),
      }),
    })
    advisor.setUpdateFeed({ url: 'https://updates.example.com/orvex.json' })
    const result = await advisor.checkUpdate()
    expect(result).toMatchObject({ configured: true, ok: true, current: '2.0.0', latest: '2.1.0', available: true })
    expect(advisor.getUpdate().last.latest).toBe('2.1.0')
    const data = await advisor.suggestions({ force: true })
    expect(data.items.map((item) => item.id)).toContain('update-available')
  })

  it('reports a failure instead of inventing an update', async () => {
    advisor.init({
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }),
    })
    const result = await advisor.checkUpdate()
    expect(result.ok).toBe(false)
    expect(result.available).toBe(false)
    expect(result.error).toMatch(/503/)
    expect(advisor.getUpdate().last.available).toBe(false)
  })

  it('rejects a non-https feed and refuses to check without one', async () => {
    expect(() => advisor.setUpdateFeed({ url: 'http://updates.example.com/feed' })).toThrow(/https/i)
    expect(() => advisor.setUpdateFeed({ url: 'https://localhost/feed' })).toThrow()
    advisor.setUpdateFeed({ url: '' })
    const result = await advisor.checkUpdate()
    expect(result.configured).toBe(false)
    expect(result.note).toMatch(/feed/i)
  })
})
