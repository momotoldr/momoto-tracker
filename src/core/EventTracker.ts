import type { Logger } from '../lib/log'
import { uuidv7 } from '../lib/uuid'
import { removeItem, writeItem } from '../lib/webStorage'
import { ApiClient } from '../services/ApiClient'
import { LifecycleManager } from '../services/LifecycleManager'
import { RetryManager } from '../services/RetryManager'
import { TransportService } from '../services/TransportService'
import { sampledIn } from '../session/ConsentGate'
import { createContextProvider } from '../session/ContextProvider'
import type { IdentityManager } from '../session/IdentityManager'
import type {
  EventData,
  EventMap,
  EventOptions,
  Identity,
  InMemoryStorageInfo,
  QueuedEvent,
  Scalar,
  TrackerConfig,
  TrackerMode,
  TrackerResult,
} from '../types'
import { BatchedTracker } from './BatchedTracker'
import { classify } from './classify'
import { RealTimeTracker } from './RealTimeTracker'
import type { PluginHost, Tracker, TrackerPlugin } from './types'

const NOT_TRACKED: TrackerResult = { success: false }

/** Drops `undefined` and anything that isn't a scalar — a JS caller can pass anything. */
function cleanData(data: EventData | undefined): Record<string, Scalar> {
  const out: Record<string, Scalar> = {}
  if (!data) return out
  for (const key of Object.keys(data)) {
    const value = data[key]
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[key] = value as Scalar
    }
  }
  return out
}

function joinUrl(base: string | URL, path: string): string {
  return String(base).replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '')
}

/** One live tracker. Built by `createTracker`, which owns the one-per-tab registry. */
export class EventTracker<E extends EventMap> implements Tracker<E> {
  readonly enabled = true
  private readonly transport: TransportService
  private readonly lifecycle: LifecycleManager
  private batchedTracker: BatchedTracker | null = null
  private realTimeTracker: RealTimeTracker | null = null
  private readonly plugins = new Set<() => void>()
  private destroyed = false

  constructor(
    private readonly trackerId: string,
    private readonly config: TrackerConfig<E>,
    private readonly identity: IdentityManager,
    private readonly log: Logger,
    private readonly onDestroy: () => void
  ) {
    const { network } = config
    this.transport = new TransportService(
      {
        url: {
          single: joinUrl(network.baseUrl, network.endpoints?.single ?? '/v1/e'),
          batch: joinUrl(network.baseUrl, network.endpoints?.batch ?? '/v1/b'),
        },
        headers: network.headers,
        timeoutMs: network.timeout ?? 5000,
        source: config.event.source,
      },
      {
        api: new ApiClient(),
        retry: new RetryManager({
          maxRetries: network.retries?.maxRetries ?? 2,
          baseDelay: network.retries?.baseDelay ?? 1000,
          maxDelay: network.retries?.maxDelay ?? 8000,
        }),
        context: createContextProvider(config.context),
        takeDropped: () => this.batchedTracker?.storage.takeDropped() ?? 0,
        returnDropped: (n) => this.batched().storage.countDropped(n),
        log,
      }
    )
    this.lifecycle = new LifecycleManager({
      hidden: () => this.batchedTracker?.onHidden(),
      visible: () => this.batchedTracker?.onVisible(),
      online: () => this.batchedTracker?.setOnline(true),
      offline: () => this.batchedTracker?.setOnline(false),
    })

    // A backup from the previous page of this tab is sent without waiting for a new event.
    if (BatchedTracker.hasBackup(trackerId)) this.batched()
  }

  getId(): string {
    return this.trackerId
  }

  getCurrentMode(): TrackerMode {
    return this.config.event.mode ?? 'BATCHED'
  }

  async track<K extends keyof E & string>(
    name: K,
    data: E[K],
    options?: EventOptions
  ): Promise<TrackerResult> {
    if (this.destroyed) return NOT_TRACKED
    try {
      const now = Date.now()
      const { anonId, sessionId } = this.identity.touch(now)
      if (!sampledIn(this.identity.sampleRoll, this.config.consent?.sampleRate)) {
        return NOT_TRACKED
      }
      const { mode, highPriority, eventType } = classify(this.config.event, name, options)
      const eventPayload = {
        event_id: uuidv7(now),
        event_name: name,
        event_type: eventType,
        timestamp: now,
        data: cleanData(data),
      }
      const event: QueuedEvent = {
        id: eventPayload.event_id,
        eventPayload,
        sessionId,
        anonId,
        priority: highPriority ? 1 : undefined,
        memoryUsage: JSON.stringify(eventPayload).length * 2,
        retryCount: 0,
      }
      this.log('track', name, eventPayload.data, mode)

      if (mode === 'REAL_TIME') return await this.realTime().track(event)
      this.batched().track(event)
      return { success: true, data: { eventId: event.id } }
    } catch (error) {
      this.log('track failed', error)
      return { success: false, error: error as Error }
    }
  }

  async pause(): Promise<void> {
    await this.batchedTracker?.pause()
  }

  async resume(): Promise<void> {
    await this.batchedTracker?.resume()
  }

  getStorageInfo(): InMemoryStorageInfo | null {
    return this.batchedTracker?.getStorageInfo() ?? null
  }

  async flush(): Promise<void> {
    await this.batchedTracker?.flush()
  }

  async destroy(flush = true): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    for (const teardown of [...this.plugins].reverse()) this.safely(teardown)
    this.plugins.clear()
    this.lifecycle.stop()
    await this.batchedTracker?.destroy(flush)
    this.batchedTracker = null
    this.realTimeTracker = null
    removeItem('session', `mt-${this.config.event.source}-tid`)
    this.onDestroy()
    this.log('destroyed')
  }

  getIdentity(): Identity | null {
    return this.identity.identity
  }

  onIdentity(listener: (identity: Identity) => void): () => void {
    const unsubscribe = this.identity.onChange(listener)
    this.safely(() => listener(this.identity.identity))
    return unsubscribe
  }

  resetIdentity(): void {
    this.identity.reset()
  }

  setOptOut(optedOut: boolean): void {
    const key = this.config.consent?.optOutKey
    if (!key) {
      this.log('no optOutKey')
      return
    }
    if (!optedOut) {
      removeItem('local', key)
      return
    }
    writeItem('local', key, 'true')
    this.identity.forget()
    void this.destroy(false)
  }

  use(plugin: TrackerPlugin): () => void {
    if (this.destroyed) return () => {}
    const host: PluginHost = {
      track: (name, data, options) =>
        this.track(name as keyof E & string, data as E[keyof E & string], options),
      getIdentity: () => this.getIdentity(),
      log: this.log,
    }
    let teardown: () => void = () => {}
    this.safely(() => (teardown = plugin.setup(host)))
    let done = false
    const remove = () => {
      if (done) return
      done = true
      this.plugins.delete(remove)
      this.safely(teardown)
    }
    this.plugins.add(remove)
    this.log('plugin', plugin.name)
    return remove
  }

  private batched(): BatchedTracker {
    if (!this.batchedTracker) {
      const queue = this.config.batch?.storage?.queue ?? {}
      const batch = this.config.batch ?? {}
      this.batchedTracker = new BatchedTracker(
        {
          trackerId: this.trackerId,
          limits: {
            maxQueueSize: queue.maxQueueSize ?? 1000,
            maxMemorySize: queue.maxMemorySize ?? 2,
            maxRetryBatches: queue.maxRetryBatches ?? 20,
            persisted: queue.persistToSession ?? false,
          },
          scheduler: {
            maxBatchSize: batch.maxBatchSize ?? 20,
            maxWaitTime: batch.maxWaitTime ?? 10_000,
            flushingTimeout: batch.flushingTimeout ?? 3000,
            maxBatchRetries: 10,
          },
        },
        this.transport,
        this.log
      )
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        this.batchedTracker.setOnline(false)
      }
      // Listeners exist only once there is something to flush — a real-time-only tracker
      // whose sends all succeed never installs them.
      this.lifecycle.start()
    }
    return this.batchedTracker
  }

  private realTime(): RealTimeTracker {
    if (!this.realTimeTracker) {
      this.realTimeTracker = new RealTimeTracker(
        this.transport,
        (event) => this.batched().track(event),
        this.log
      )
    }
    return this.realTimeTracker
  }

  private safely(fn: () => void): void {
    try {
      fn()
    } catch (error) {
      this.log('callback threw', error)
    }
  }
}
