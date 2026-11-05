import type { KeyboardEvent } from 'react'

const inertOwners = new Set<string>()

/**
 * Marks every direct child of the app root inert while at least one overlay
 * asks for it. Overlay layers that must stay interactive carry
 * `data-inert-keep` so they are skipped.
 */
export function setAppInert(owner: string, on: boolean) {
  const app = document.querySelector<HTMLElement>('.orvex-app')
  if (!app) return
  if (on) inertOwners.add(owner)
  else inertOwners.delete(owner)
  const inert = inertOwners.size > 0
  for (const el of Array.from(app.children) as HTMLElement[]) {
    if (el.hasAttribute('data-inert-keep')) continue
    el.inert = inert
  }
}

/**
 * Arrow/Home/End navigation for a role="tablist". Focus and activation move
 * together, which is the expected pattern for these small tab toolbars.
 */
export function onTablistKeyDown(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])'))
  if (tabs.length === 0) return
  const index = tabs.indexOf(document.activeElement as HTMLElement)
  if (index < 0) return
  e.preventDefault()
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? tabs.length - 1
        : e.key === 'ArrowRight'
          ? (index + 1) % tabs.length
          : (index - 1 + tabs.length) % tabs.length
  const target = tabs[next]
  target.focus()
  target.click()
}
