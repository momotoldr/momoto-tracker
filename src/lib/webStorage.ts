/**
 * Web Storage that never throws. Merely *reading* `window.localStorage` throws in some
 * browsers when site data is blocked, and writes throw on quota or in private modes — so
 * every access is guarded and a failure degrades to "nothing stored".
 */
export type StorageKind = 'local' | 'session'

function area(kind: StorageKind): Storage | null {
  try {
    return kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage
  } catch {
    return null
  }
}

export function readItem(kind: StorageKind, key: string): string | null {
  try {
    return area(kind)?.getItem(key) ?? null
  } catch {
    return null
  }
}

/** @returns whether the write landed. */
export function writeItem(kind: StorageKind, key: string, value: string): boolean {
  try {
    const store = area(kind)
    if (!store) return false
    store.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function removeItem(kind: StorageKind, key: string): void {
  try {
    area(kind)?.removeItem(key)
  } catch {
    // Nothing to clean up if storage can't be reached.
  }
}

export function readJson<T>(kind: StorageKind, key: string): T | null {
  const raw = readItem(kind, key)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
