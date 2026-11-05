/**
 * Shared runtime stores. These are plain module-level pub/sub stores so any
 * component can read/write without threading context through the tree.
 *
 * Everything here persists to localStorage on this device only.
 */

import { useEffect, useState } from 'react'

/* --------------------------------------------------------------- activity */

export type FeedKind = 'agent' | 'system' | 'user' | 'job' | 'voice' | 'model'

export type FeedItem = {
  id: string
  kind: FeedKind
  text: string
  at: number
  source?: string
}

type Listener<T> = (value: T) => void

function createStore<T>(initial: T, key?: string) {
  let value = initial
  const listeners = new Set<Listener<T>>()

  if (key) {
    try {
      const raw = localStorage.getItem(key)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        // Arrays must stay arrays — spreading them into an object turns the
        // store into `{0: …}` and every `.filter`/.map call then throws.
        if (Array.isArray(initial)) {
          if (Array.isArray(parsed)) value = parsed as T
        } else if (parsed && typeof parsed === 'object') {
          value = { ...(initial as object), ...(parsed as object) } as T
        }
      }
    } catch {
      /* corrupt store — keep defaults */
    }
  }

  const emit = () => {
    listeners.forEach((l) => l(value))
    if (key) {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* quota — keep running */
      }
    }
  }

  return {
    get: () => value,
    set: (next: T) => {
      value = next
      emit()
    },
    update: (fn: (v: T) => T) => {
      value = fn(value)
      emit()
    },
    subscribe: (l: Listener<T>) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
  }
}

/* ------------------------------------------------------------ notifications */

export type Notification = {
  id: string
  title: string
  body: string
  kind: FeedKind
  at: number
  read: boolean
  /** sidebar destination opened when the notification is clicked */
  target?: string
  runId?: string
}

export const notificationsStore = createStore<Notification[]>([], 'orvex-notifications')

export function pushNotification(n: Omit<Notification, 'id' | 'at' | 'read'>) {
  const item: Notification = {
    ...n,
    id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    read: false,
  }
  notificationsStore.update((list) => {
    // The main process and the renderer can both report the same event.
    const duplicate = list.some(
      (x) => x.title === item.title && x.body === item.body && item.at - x.at < 4000,
    )
    return duplicate ? list : [item, ...list].slice(0, 60)
  })
}

export function markAllRead() {
  notificationsStore.update((list) => list.map((n) => ({ ...n, read: true })))
}

export function markRead(id: string) {
  notificationsStore.update((list) => list.map((n) => (n.id === id ? { ...n, read: true } : n)))
}

export function clearRead() {
  notificationsStore.update((list) => list.filter((n) => !n.read))
}

export function clearNotifications() {
  notificationsStore.set([])
}

export function unreadCount(list: Notification[]): number {
  return list.filter((n) => !n.read).length
}

/* ------------------------------------------------------------------- goals */

export type Goal = {
  id: string
  title: string
  outcome: string
  /** id of the parent goal, null for a top-level goal */
  parentId: string | null
  done: boolean
  createdAt: number
}

export const goalsStore = createStore<Goal[]>([], 'orvex-goals')

export function upsertGoal(g: Goal) {
  goalsStore.update((list) => {
    const i = list.findIndex((x) => x.id === g.id)
    return i >= 0 ? list.map((x) => (x.id === g.id ? g : x)) : [...list, g]
  })
}

export function removeGoal(id: string) {
  goalsStore.update((list) => list.filter((g) => g.id !== id).map((g) => (g.parentId === id ? { ...g, parentId: null } : g)))
}

/* -------------------------------------------------------------- failure log */

export type FailureEntry = {
  id: string
  where: string
  reason: string
  at: number
}

export const failuresStore = createStore<FailureEntry[]>([], 'orvex-failures')

export function logFailure(where: string, reason: string) {
  failuresStore.update((list) =>
    [{ id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, where, reason, at: Date.now() }, ...list].slice(0, 80),
  )
}

/* ------------------------------------------------------------------- hooks */

/** Subscribes a component to a store and re-renders on every change. */
export function useStore<T>(store: { subscribe: (l: Listener<T>) => () => void; get: () => T }): T {
  const [value, setValue] = useState<T>(store.get())
  useEffect(() => {
    setValue(store.get())
    return store.subscribe(setValue)
  }, [store])
  return value
}
