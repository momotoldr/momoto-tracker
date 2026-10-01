import { byteLength, type Logger } from '../lib/log'
import { uuidv4 } from '../lib/uuid'
import type { ContextValue, QueuedEvent } from '../types'
import type { ApiClient, ApiResponse } from './ApiClient'
import type { RetryManager } from './RetryManager'

declare const __SDK_VERSION__: string

/** `version` is `package.json`'s, injected at build time. */
export const SDK = { name: 'momoto-tracker', version: __SDK_VERSION__ }

/** Beacons and keepalive fetches share a 64 KB in-flight budget per page; stay under it. */
export const UNLOAD_CHUNK_BYTES = 60_000

export interface TransportConfig {
  url: { single: string; batch: string }
  headers?: Record<string, string>
  timeoutMs: number
  source: string
}

export interface TransportDeps {
  api: ApiClient
  retry: RetryManager
  /** Per-batch context, evaluated at send time. Must not throw (see ContextProvider). */
  context: () => Record<string, ContextValue>
  /** Reads and resets the evicted-events counter. */
  takeDropped: () => number
  /** Gives a counter back when the batch that carried it didn't arrive. */
  returnDropped: (n: number) => void
  log: Logger
}

/** The envelope's identity comes from the events (all from one visit — see createBatch),
 *  never from "now", so a batch sent after a session rollover keeps its own visit's id. */
function envelope(
  config: TransportConfig,
  deps: TransportDeps,
  events: QueuedEvent[],
  dropped: number
): string {
  return JSON.stringify({
    request_id: uuidv4(),
    source: config.source,
    sdk: SDK,
    anon_id: events[0].anonId,
    session_id: events[0].sessionId,
    context: deps.context(),
    sent_at: Date.now(),
    dropped,
    events: events.map((e) => e.eventPayload),
  })
}

export class TransportService {
  constructor(
    private readonly config: TransportConfig,
    private readonly deps: TransportDeps
  ) {}

  /** One event, right now (real-time mode). Same envelope as a batch of one. */
  sendEvent(event: QueuedEvent): Promise<ApiResponse> {
    return this.post(this.config.url.single, [event])
  }

  sendBatch(events: QueuedEvent[], maxRetries?: number): Promise<ApiResponse> {
    return this.post(this.config.url.batch, events, maxRetries)
  }

  /**
   * The page is going away. A normal `fetch` would be cancelled with it, so each batch goes
   * out as a beacon — queued by the browser itself, surviving the page — falling back to a
   * keepalive fetch where `sendBeacon` is missing or refuses (over its quota).
   *
   * Synchronous and fire-and-forget: nothing here can be awaited, and nothing can be
   * learned about the outcome. Delivery is at-least-once; the server dedupes by event id.
   */
  sendOnUnload(batches: QueuedEvent[][]): void {
    if (this.config.headers && Object.keys(this.config.headers).length > 0) {
      this.deps.log('unload: sent without headers')
    }
    let dropped = this.deps.takeDropped()
    for (const events of batches) {
      for (const body of this.chunk(events, dropped)) {
        dropped = 0
        this.beacon(this.config.url.batch, body)
      }
    }
  }

  private async post(url: string, events: QueuedEvent[], maxRetries?: number) {
    const dropped = this.deps.takeDropped()
    const body = envelope(this.config, this.deps, events, dropped)
    const response = await this.deps.retry.execute(
      () =>
        this.deps.api.post(url, body, {
          headers: this.config.headers,
          timeoutMs: this.config.timeoutMs,
        }),
      maxRetries
    )
    if (!response.success && dropped) this.deps.returnDropped(dropped)
    this.deps.log(response.success ? 'sent' : 'send failed', events.length, response.status)
    return response
  }

  /** Splits a batch until every body fits the unload budget. A single event too big to fit
   *  is sent anyway: the browser may refuse it, but that is no worse than not trying. */
  private chunk(events: QueuedEvent[], dropped: number): string[] {
    const body = envelope(this.config, this.deps, events, dropped)
    if (events.length <= 1 || byteLength(body) < UNLOAD_CHUNK_BYTES) return [body]
    const middle = Math.ceil(events.length / 2)
    return [...this.chunk(events.slice(0, middle), dropped), ...this.chunk(events.slice(middle), 0)]
  }

  private beacon(url: string, body: string): void {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const blob = new Blob([body], { type: 'text/plain;charset=UTF-8' })
        if (navigator.sendBeacon(url, blob)) return
      }
    } catch {
      // Fall through to keepalive.
    }
    if (typeof fetch === 'undefined') return
    fetch(url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      keepalive: true,
      credentials: 'omit',
    }).catch(() => {})
  }
}
