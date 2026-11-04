import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const browser = require('../../electron/browser.cjs')

describe('browser_task search URLs', () => {
  it('builds a YouTube results URL with an encoded query', () => {
    expect(browser.searchUrlFor('youtube', 'jhol mashup')).toBe('https://www.youtube.com/results?search_query=jhol%20mashup')
    expect(browser.searchUrlFor('yt', 'a&b')).toBe('https://www.youtube.com/results?search_query=a%26b')
  })

  it('maps common search sites and aliases', () => {
    expect(browser.searchUrlFor('google', 'orvex')).toBe('https://www.google.com/search?q=orvex')
    expect(browser.searchUrlFor('www.google.com', 'orvex')).toBe('https://www.google.com/search?q=orvex')
    expect(browser.searchUrlFor('bing', 'orvex')).toBe('https://www.bing.com/search?q=orvex')
    expect(browser.searchUrlFor('ddg', 'orvex')).toBe('https://duckduckgo.com/?q=orvex')
    expect(browser.searchUrlFor('github', 'agents framework')).toBe('https://github.com/search?q=agents%20framework')
  })

  it('uses a full URL as-is and supports a {query} placeholder', () => {
    expect(browser.searchUrlFor('https://example.com/search?q=old', 'new term')).toBe('https://example.com/search?q=old&q=new%20term')
    expect(browser.searchUrlFor('https://example.com/find/{query}', 'hello world')).toBe('https://example.com/find/hello%20world')
  })

  it('falls back to Google for an unknown site and refuses an empty query', () => {
    expect(browser.searchUrlFor('unknown-site', 'term')).toBe('https://www.google.com/search?q=term')
    expect(() => browser.searchUrlFor('youtube', '  ')).toThrow(/search query/i)
  })

  it('exposes the tool and rejects an invalid action before launching a browser', async () => {
    const tool = browser.definitions.find((entry) => entry.name === 'browser_task')
    expect(tool).toBeTruthy()
    expect(tool.parameters.properties.action.enum).toEqual(['open', 'search', 'play_first'])
    const result = await browser.handlers.browser_task({ action: 'dance' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/open, search or play_first/)
  })
})
