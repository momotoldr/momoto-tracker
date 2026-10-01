import { readItem, readJson, removeItem, writeItem } from '../lib/webStorage'
import type { StorageSnapshot } from './InMemoryStorageManager'

/**
 * Backs the queues up to **sessionStorage** so a reload doesn't lose them.
 *
 * sessionStorage, not localStorage: it is per tab, so each tab restores only its own
 * backup. localStorage is shared by every tab of the origin — two tabs would both restore,
 * and send, the same events.
 */
export class SessionPersistence {
  private readonly key: string
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(trackerId: string) {
    this.key = `mt-${trackerId}-queue`
  }

  /** Writes now. An empty snapshot clears the key instead of storing an empty backup. */
  backup(snapshot: StorageSnapshot): void {
    this.cancelPending()
    if (snapshot.events.length === 0 && snapshot.batches.length === 0 && !snapshot.dropped) {
      removeItem('session', this.key)
      return
    }
    // A full quota just means no backup this time; the queue itself is unaffected.
    writeItem('session', this.key, JSON.stringify(snapshot))
  }

  /** Coalesces bursts of enqueues into one write a second later. */
  scheduleBackup(read: () => StorageSnapshot, delayMs = 1000): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.backup(read())
    }, delayMs)
  }

  hasBackup(): boolean {
    return readItem('session', this.key) !== null
  }

  /** Reads and removes the backup — once restored, the queue in memory owns those events. */
  restore(): StorageSnapshot | null {
    const snapshot = readJson<StorageSnapshot>('session', this.key)
    removeItem('session', this.key)
    if (!snapshot || !Array.isArray(snapshot.events) || !Array.isArray(snapshot.batches)) {
      return null
    }
    return { events: snapshot.events, batches: snapshot.batches, dropped: snapshot.dropped || 0 }
  }

  clear(): void {
    this.cancelPending()
    removeItem('session', this.key)
  }

  private cancelPending(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
