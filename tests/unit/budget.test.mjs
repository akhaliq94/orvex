import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const gateway = require('../../electron/model-gateway.cjs')
const db = require('../../electron/db.cjs')
const { budgetOverrun } = gateway._internals

const original = { getSetting: db.getSetting, usageCostSince: db.usageCostSince }

function stub(settings, spent) {
  db.getSetting = (key, fallback) => (Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallback)
  db.usageCostSince = () => spent
}

afterEach(() => {
  db.getSetting = original.getSetting
  db.usageCostSince = original.usageCostSince
})

describe('model budget hard stop', () => {
  it('does nothing when no caps are configured', () => {
    stub({ 'budget.dailyUsd': 0, 'budget.monthlyUsd': 0 }, 99)
    expect(budgetOverrun()).toBeNull()
  })

  it('reports the daily cap once it is reached', () => {
    stub({ 'budget.dailyUsd': 5 }, 5)
    expect(budgetOverrun()).toEqual({ scope: 'daily', spent: 5, limit: 5 })
  })

  it('stays quiet while the daily cap has room', () => {
    stub({ 'budget.dailyUsd': 5 }, 4.99)
    expect(budgetOverrun()).toBeNull()
  })

  it('reports the monthly cap when the daily cap is unused', () => {
    stub({ 'budget.dailyUsd': 0, 'budget.monthlyUsd': 40 }, 41)
    expect(budgetOverrun()).toEqual({ scope: 'monthly', spent: 41, limit: 40 })
  })

  it('never throws when the usage table is unavailable', () => {
    db.getSetting = () => {
      throw new Error('database is closed')
    }
    expect(budgetOverrun()).toBeNull()
  })
})
