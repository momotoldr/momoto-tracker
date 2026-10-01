import { uuidv4 } from '../lib/uuid'
import { readItem, readJson, removeItem, writeItem } from '../lib/webStorage'
import type { Identity } from '../types'

interface SessionRecord {
  id: string
  /** Last activity, ms. */
  last: number
  /** The sampling roll for this visit, 0–1, fixed for its lifetime. */
  roll: number
}

/** Activity timestamps are written at most this often — a burst of events is one write. */
const WRITE_THROTTLE_MS = 1000

/**
 * Two anonymous ids:
 * - `anonId` — the browser. localStorage, shared by its tabs, kept until cleared or reset.
 * - `sessionId` — a visit. sessionStorage (per tab), and a new one after `idleMs` without
 *   activity, so a tab left open overnight starts a new visit in the morning.
 *
 * Both are random v4 UUIDs: nothing derived from the device, and nothing that reveals when
 * it was made. If storage is unavailable they live in memory for this page only.
 */
export class IdentityManager {
  private readonly anonKey: string
  private readonly sessionKey: string
  private anonId: string
  private session: SessionRecord
  private lastWrite = 0
  private readonly listeners = new Set<(identity: Identity) => void>()

  constructor(
    namespace: string,
    private readonly idleMs: number
  ) {
    this.anonKey = `mt-${namespace}-aid`
    this.sessionKey = `mt-${namespace}-sid`

    this.anonId = readItem('local', this.anonKey) || this.newAnonId()
    const stored = readJson<SessionRecord>('session', this.sessionKey)
    const now = Date.now()
    this.session =
      stored && typeof stored.id === 'string' && now - stored.last <= idleMs
        ? stored
        : this.newSession(now)
  }

  get identity(): Identity {
    return { anonId: this.anonId, sessionId: this.session.id }
  }

  get sampleRoll(): number {
    return this.session.roll
  }

  /** Records activity, rolling to a new visit first if this one went idle. */
  touch(now: number = Date.now()): Identity {
    if (now - this.session.last > this.idleMs) {
      this.session = this.newSession(now)
      this.emit()
    } else {
      this.session.last = now
      if (now - this.lastWrite >= WRITE_THROTTLE_MS) this.write(now)
    }
    return this.identity
  }

  /** A new browser and a new visit — on sign-out, so the next person on a shared device
   *  isn't stitched to the last one. */
  reset(): void {
    this.anonId = this.newAnonId()
    this.session = this.newSession(Date.now())
    this.emit()
  }

  /** Removes both ids from storage (opt-out). The in-memory ids are left for the instance
   *  being torn down. */
  forget(): void {
    removeItem('local', this.anonKey)
    removeItem('session', this.sessionKey)
  }

  onChange(listener: (identity: Identity) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private newAnonId(): string {
    const id = uuidv4()
    writeItem('local', this.anonKey, id)
    return id
  }

  private newSession(now: number): SessionRecord {
    this.session = { id: uuidv4(), last: now, roll: Math.random() }
    this.write(now)
    return this.session
  }

  private write(now: number): void {
    this.lastWrite = now
    writeItem('session', this.sessionKey, JSON.stringify(this.session))
  }

  private emit(): void {
    const identity = this.identity
    for (const listener of this.listeners) {
      try {
        listener(identity)
      } catch {
        // A host callback must not break tracking.
      }
    }
  }
}
