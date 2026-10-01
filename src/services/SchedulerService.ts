import type { Logger } from '../lib/log'
import type { InMemoryStorageManager } from '../storage/InMemoryStorageManager'
import type { BatchedEvents, InMemoryStorageInfo, QueuedEvent } from '../types'
import { isRetryable } from './RetryManager'
import type { TransportService } from './TransportService'

export interface SchedulerConfig {
  maxBatchSize: number
  maxWaitTime: number
  flushingTimeout: number
  /** A batch that has failed this many ticks is abandoned (and counted as dropped). */
  maxBatchRetries: number
}

/** After consecutive failures the next attempt waits `maxWaitTime × 2^(n-1)`, up to this. */
const MAX_FAILURE_BACKOFF_MS = 5 * 60_000

const TIMED_OUT = Symbol('timed out')

/** Resolves with the promise's value, or `TIMED_OUT` after `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), ms))),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Decides when batches go out.
 *
 * A re-armed `setTimeout`, never a `setInterval`: the timer exists only while something is
 * waiting. A lone event waits `maxWaitTime` for company; a full batch goes at once; an
 * empty queue has no timer at all. With live video on a phone there is no budget for a
 * tracker that wakes up every few seconds to find nothing to do.
 */
export class SchedulerService {
  private timer: ReturnType<typeof setTimeout> | null = null
  private dueAt = 0
  private running = true
  private online = true
  private inFlight: Promise<void> | null = null
  private failures = 0

  constructor(
    private readonly storage: InMemoryStorageManager,
    private readonly transport: TransportService,
    private readonly config: SchedulerConfig,
    private readonly onChange: () => void,
    private readonly log: Logger
  ) {}

  scheduleNewEvent(event: QueuedEvent): void {
    this.storage.addNewEvent(event)
    this.onChange()
    this.arm(this.storage.pendingEvents >= this.config.maxBatchSize ? 0 : this.config.maxWaitTime)
  }

  getStorageInfo(): InMemoryStorageInfo {
    return this.storage.getInfo()
  }

  /** Not stopped (it may still be idle, with no timer, when there is nothing to send). */
  getIsRunning(): boolean {
    return this.running
  }

  /** Stops sending. With `triggerFinalBatch`, drains first (bounded by `flushingTimeout`). */
  async stop(triggerFinalBatch = false): Promise<void> {
    if (triggerFinalBatch) await this.flush()
    this.running = false
    this.clearTimer()
  }

  /** Resumes. Failed or already-cut batches go at once; fresh events still wait to be
   *  batched — an app switch on a phone is not a reason to send early. */
  async restart(): Promise<void> {
    this.running = true
    this.arm(this.nextDelay())
  }

  setOnline(online: boolean): void {
    this.online = online
    if (online) this.arm(this.nextDelay())
    else this.clearTimer()
  }

  /** Sends everything queued now, each batch once, for at most `flushingTimeout`. What
   *  doesn't make it stays queued. */
  async flush(): Promise<void> {
    const deadline = Date.now() + this.config.flushingTimeout
    if (this.inFlight) await within(this.inFlight, this.config.flushingTimeout)
    this.storage.createAllBatches(this.config.maxBatchSize)
    for (const batch of this.storage.getAllBatchesForProcessing()) {
      const left = deadline - Date.now()
      if (left <= 0) break
      if ((await within(this.send(batch, 0), left)) === TIMED_OUT) break
    }
  }

  /** Arms the timer to fire in `delay` ms — unless it's already due sooner. */
  private arm(delay: number): void {
    if (!this.running || !this.online || this.storage.isEmpty()) return
    const due = Date.now() + delay
    if (this.timer && this.dueAt <= due) return
    this.clearTimer()
    this.dueAt = due
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, delay)
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** One batch in flight at a time; when it settles, decide when to go again. */
  private async tick(): Promise<void> {
    if (!this.running || !this.online || this.inFlight) return
    this.storage.createAllBatches(this.config.maxBatchSize)
    const batch = this.storage.getBatchForProcessing()
    if (!batch) return
    this.inFlight = this.send(batch)
    await this.inFlight
    this.inFlight = null

    this.arm(
      this.failures > 0
        ? Math.min(this.config.maxWaitTime * 2 ** (this.failures - 1), MAX_FAILURE_BACKOFF_MS)
        : this.nextDelay()
    )
  }

  /** 0 when a batch is ready (cut, waiting for retry, or a full one pending); otherwise a
   *  lone event's usual wait. */
  private nextDelay(): number {
    const ready =
      this.storage.batchQueue.size > 0 ||
      this.storage.batchRetryQueue.size > 0 ||
      this.storage.pendingEvents >= this.config.maxBatchSize
    return ready ? 0 : this.config.maxWaitTime
  }

  private async send(batch: BatchedEvents, maxRetries?: number): Promise<void> {
    const response = await this.transport.sendBatch(batch.events, maxRetries)
    // Gone from storage = an unload beacon already took it; nothing left to do either way.
    const stillQueued = this.storage
      .getAllBatchesForProcessing()
      .some((queued) => queued.id === batch.id)

    if (response.success) {
      this.failures = 0
      this.storage.removeBatch(batch.id)
    } else if (!stillQueued) {
      // Already beaconed.
    } else if (!isRetryable(response) || batch.retryCount + 1 >= this.config.maxBatchRetries) {
      this.log('abandoned', batch.size, response.status)
      this.storage.removeBatch(batch.id)
      this.storage.countDropped(batch.size)
    } else {
      this.failures++
      this.storage.addBatchToRetry(batch)
    }
    this.onChange()
  }
}
