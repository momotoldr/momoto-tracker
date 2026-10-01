import type { Logger } from '../lib/log'
import { removeItem, writeItem } from '../lib/webStorage'
import type { EventMap, EventOptions, Identity, TrackerMode, TrackerResult } from '../types'
import type { Tracker } from './types'

const NOT_TRACKED: TrackerResult = { success: false }

/**
 * What `createTracker` returns when tracking must not run (disabled, DNT/GPC, opted out,
 * sampled out). Same interface, and it does nothing: no listeners, no timers, no storage,
 * no requests. With `debug` on it still logs each call, so instrumentation can be checked
 * in development without anything being sent.
 */
export class NoopTracker<E extends EventMap> implements Tracker<E> {
  readonly enabled = false

  constructor(
    private readonly log: Logger,
    private readonly reason: string,
    private readonly optOutKey?: string
  ) {}

  getId(): string {
    return ''
  }

  async track<K extends keyof E & string>(
    name: K,
    data: E[K],
    options?: EventOptions
  ): Promise<TrackerResult> {
    this.log(`track (not sent: ${this.reason})`, name, data, options ?? '')
    return NOT_TRACKED
  }

  getCurrentMode(): TrackerMode {
    return 'BATCHED'
  }

  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  getStorageInfo() {
    return null
  }
  async flush(): Promise<void> {}
  async destroy(): Promise<void> {}

  getIdentity(): Identity | null {
    return null
  }

  onIdentity(): () => void {
    return () => {}
  }

  resetIdentity(): void {}

  setOptOut(optedOut: boolean): void {
    if (!this.optOutKey) return
    if (optedOut) writeItem('local', this.optOutKey, 'true')
    else removeItem('local', this.optOutKey)
  }

  use(): () => void {
    return () => {}
  }
}
