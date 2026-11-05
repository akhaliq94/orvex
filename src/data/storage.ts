/** localStorage can throw (private mode, quota, disabled storage). Never let that break a render. */

export function readItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function readJson<T>(key: string, fallback: T): T {
  const raw = readItem(key)
  if (!raw) return fallback
  try {
    const parsed: unknown = JSON.parse(raw)
    return (parsed as T) ?? fallback
  } catch {
    return fallback
  }
}

export function writeJson(key: string, value: unknown): boolean {
  return writeItem(key, JSON.stringify(value))
}
