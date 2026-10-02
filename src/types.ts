/** A value an event may carry. Free-form objects are refused by type, so nothing nested
 *  (and nothing accidentally personal, like a whole user object) can ride along. */
export type Scalar = string | number | boolean | null

/** One event's props. `undefined` is allowed so optional props type-check; it is
 *  dropped before sending. */
export type EventData = { [key: string]: Scalar | undefined }

/**
 * The host's event taxonomy: event name → its props. Declare it as a `type` alias, not an
 * `interface` — only aliases get the implicit index signature this constraint needs.
 *
 * ```ts
 * type AppEvents = { shot_taken: { index: number }; page_view: { route: string } }
 * ```
 */
export type EventMap = { [name: string]: EventData }

export type TrackerMode = 'REAL_TIME' | 'BATCHED'
export type EventType = 'PAGE' | 'COMPONENT'

export interface EventOptions {
  /** Overrides the event's classification and the global mode for this one call. */
  mode?: TrackerMode
  /** Batched only: goes out before normal events. Real-time failures are re-queued with it. */
  highPriority?: boolean
}

export interface TrackerResult {
  success: boolean
  data?: { eventId: string }
  error?: Error
}

/** One event as it goes over the wire (snake_case, as the ingest contract has it). */
export interface EventPayload {
  event_id: string
  event_name: string
  event_type: EventType | null
  timestamp: number
  data: Record<string, Scalar>
}

export interface QueuedEvent {
  id: string
  eventPayload: EventPayload
  /** Visit and browser the event belongs to. Kept per event, not read at send time, so a
   *  session rollover or identity reset never relabels events that were already queued. */
  sessionId: string
  anonId: string
  priority?: number
  /** Estimated bytes (UTF-16), computed once at enqueue. */
  memoryUsage: number
  retryCount: number
  lastRetryAt?: number
}

export interface BatchedEvents {
  id: string
  events: QueuedEvent[]
  createdAt: number
  retryCount: number
  /** Number of events. */
  size: number
  memoryUsage: number
}

export interface QueueInfo<T = QueuedEvent | BatchedEvents> {
  size: number
  /** MB. */
  memoryUsage: number
  isPersisted: boolean
  items: T[]
}

export interface InMemoryStorageInfo {
  eventQueueInfo: QueueInfo<QueuedEvent>
  priorityEventQueueInfo: QueueInfo<QueuedEvent>
  batchQueueInfo: QueueInfo<BatchedEvents>
  batchRetryQueueInfo: QueueInfo<BatchedEvents>
  /** MB. */
  totalMemoryUsage: number
  maxSize: number
  /** MB. */
  maxMemoryUsage: number
  /** Events evicted since the last batch went out. */
  dropped: number
}

export interface Identity {
  anonId: string
  sessionId: string
}

// ── Config ──────────────────────────────────────────────────────────────────────────

export interface RetryConfig {
  /** Attempts after the first. Default 2. */
  maxRetries: number
  /** Backoff base in ms; attempt n waits up to `baseDelay × 2^n` (full jitter). Default 1000. */
  baseDelay: number
  /** Backoff cap in ms. Default 8000. */
  maxDelay: number
}

export interface NetworkConfig {
  baseUrl: string | URL
  /** Paths appended to `baseUrl`. Default `{ single: '/v1/e', batch: '/v1/b' }`. */
  endpoints?: { single?: string; batch?: string }
  /**
   * Extra request headers for normal sends. **Unload sends cannot carry them** — a beacon
   * has no headers — so never rely on a header for authentication. Any header also makes
   * the request non-simple, adding a CORS preflight.
   */
  headers?: Record<string, string>
  /** Request timeout in ms. Default 5000. */
  timeout?: number
  retries?: Partial<RetryConfig>
}

export interface QueueConfig {
  /** Max events held across all queues. Default 1000. */
  maxQueueSize?: number
  /** Max estimated memory across all queues, in MB. Default 2. */
  maxMemorySize?: number
  /** Back queues up to sessionStorage so a reload doesn't lose them. Default false. */
  persistToSession?: boolean
  /** Max failed batches kept for retry. Default 20. */
  maxRetryBatches?: number
}

export interface BatchConfig {
  /** Default 20. */
  maxBatchSize?: number
  /** ms a lone event waits for company before it's sent anyway. Default 10000. */
  maxWaitTime?: number
  /** ms `flush()` / `destroy()` will spend draining. Default 3000. */
  flushingTimeout?: number
  storage?: { type?: 'IN_MEMORY'; queue?: QueueConfig }
}

export interface Classification {
  mode?: TrackerMode
  highPriority?: boolean
  eventType?: EventType
}

export interface EventConfig<E extends EventMap = EventMap> {
  /** Names the sending app in every batch, e.g. `'momoto-fe'`. Also namespaces storage keys. */
  source: string
  /** Default mode. Default `'BATCHED'`. */
  mode?: TrackerMode
  /** Per-event defaults: real-time, high priority, PAGE/COMPONENT type. */
  classification?: { [K in keyof E]?: Classification }
}

export interface SessionConfig {
  /** A visit ends after this much inactivity. Default 30 minutes. */
  idleTimeoutMs?: number
}

export interface ConsentConfig {
  /** Master switch. `false` returns a no-op tracker. Default true. */
  enabled?: boolean
  /** Honour Do Not Track and Global Privacy Control. Default true. */
  respectDnt?: boolean
  /** localStorage key; the value `'true'` means opted out. */
  optOutKey?: string
  /** Share of visits tracked, 0–1, rolled once per session. Default 1. */
  sampleRate?: number
}

export type ContextValue = Scalar | ContextValue[] | { [key: string]: ContextValue }

export interface TrackerConfig<E extends EventMap = EventMap> {
  event: EventConfig<E>
  network: NetworkConfig
  batch?: BatchConfig
  session?: SessionConfig
  consent?: ConsentConfig
  /** Extra per-batch context (app version, flags, locale…). Called at send time. */
  context?: () => Record<string, ContextValue>
  /** `console.debug` every event and decision. */
  debug?: boolean
  /**
   * Called once for every event the tracker accepts — from `track()` and from plugins
   * alike — just before it is queued or sent. For logging or mirroring events; it must not
   * throw (a throw is caught and ignored) and must not be slow. Not called for events the
   * tracker drops (disabled, opted out, sampled out, destroyed).
   */
  onTrack?: (event: TrackedEvent) => void
}

/** What `onTrack` receives. */
export interface TrackedEvent {
  name: string
  data: Record<string, Scalar>
  eventId: string
  mode: TrackerMode
  type: EventType | null
  sessionId: string
}
