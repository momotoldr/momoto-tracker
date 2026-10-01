import type { Logger } from '../lib/log'
import type {
  EventData,
  EventMap,
  EventOptions,
  Identity,
  InMemoryStorageInfo,
  TrackerMode,
  TrackerResult,
} from '../types'

/** What a plugin can do: emit events (by name, untyped — plugins don't know the host's
 *  taxonomy) and read the current identity. */
export interface PluginHost {
  track(name: string, data: EventData, options?: EventOptions): Promise<TrackerResult>
  getIdentity(): Identity | null
  log: Logger
}

export interface TrackerPlugin {
  name: string
  /** Installs the plugin; returns its teardown, which must undo everything it did. */
  setup(host: PluginHost): () => void
}

/** The public tracker. A disabled tracker (consent, DNT, opt-out, sampling) has the same
 *  shape and does nothing — callers never branch on whether tracking is on. */
export interface Tracker<E extends EventMap = EventMap> {
  /** `false` for the no-op tracker. */
  readonly enabled: boolean
  /** Stable for this tab across reloads. Empty for the no-op tracker. */
  getId(): string
  /** Never throws, never blocks the caller. */
  track<K extends keyof E & string>(
    name: K,
    data: E[K],
    options?: EventOptions
  ): Promise<TrackerResult>
  getCurrentMode(): TrackerMode
  /** Batched only: stop / restart the scheduler. Events keep queuing while paused. */
  pause(): Promise<void>
  resume(): Promise<void>
  getStorageInfo(): InMemoryStorageInfo | null
  /** Send everything queued now (bounded by `flushingTimeout`); keeps running after. */
  flush(): Promise<void>
  /** Flush, then remove every timer, listener, patched method and queue key. Idempotent. */
  destroy(): Promise<void>
  /** `null` for the no-op tracker. */
  getIdentity(): Identity | null
  /** Called when the visit rolls over or the identity is reset — and once immediately, so a
   *  host can link the current ids to an account. Returns an unsubscribe. */
  onIdentity(listener: (identity: Identity) => void): () => void
  /** New browser + visit ids (call on sign-out). */
  resetIdentity(): void
  /**
   * `true`: stop now, discard what's queued, forget the ids, and stay off on later loads.
   * `false`: clear the opt-out; tracking resumes on the next page load.
   */
  setOptOut(optedOut: boolean): void
  /** Installs a plugin; returns its teardown. `destroy()` tears down every plugin. */
  use(plugin: TrackerPlugin): () => void
}
