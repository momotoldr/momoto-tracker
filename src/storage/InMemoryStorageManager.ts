import { uuidv4 } from '../lib/uuid'
import type { BatchedEvents, InMemoryStorageInfo, QueuedEvent } from '../types'
import { createQueue } from './queue'

export interface StorageLimits {
  maxQueueSize: number
  /** MB. */
  maxMemorySize: number
  maxRetryBatches: number
  persisted: boolean
}

export interface StorageSnapshot {
  events: QueuedEvent[]
  batches: BatchedEvents[]
  dropped: number
}

const MB = 1024 * 1024

/**
 * Four queues:
 * - `eventQueue` / `priorityEventQueue` — events not yet cut into a batch;
 * - `batchQueue` — batches ready to send;
 * - `batchRetryQueue` — batches whose send failed.
 *
 * Caps apply across all four. Over a cap, the oldest *normal* data goes first (FIFO), and
 * every evicted event is counted in `dropped`, which the next batch reports — a truncated
 * stream says it was truncated instead of quietly lying.
 */
export class InMemoryStorageManager {
  readonly eventQueue = createQueue<QueuedEvent>()
  readonly priorityEventQueue = createQueue<QueuedEvent>()
  readonly batchQueue = createQueue<BatchedEvents>()
  readonly batchRetryQueue = createQueue<BatchedEvents>()
  private dropped = 0

  constructor(private readonly limits: StorageLimits) {}

  addNewEvent(event: QueuedEvent): void {
    if (event.priority) this.priorityEventQueue.enqueue(event)
    else this.eventQueue.enqueue(event)
    this.enforceCaps()
  }

  /** Events waiting to be cut into batches. */
  get pendingEvents(): number {
    return this.eventQueue.size + this.priorityEventQueue.size
  }

  get totalEvents(): number {
    let n = this.pendingEvents
    for (const b of this.batchQueue.items) n += b.size
    for (const b of this.batchRetryQueue.items) n += b.size
    return n
  }

  get totalBytes(): number {
    return (
      this.eventQueue.memoryUsage +
      this.priorityEventQueue.memoryUsage +
      this.batchQueue.memoryUsage +
      this.batchRetryQueue.memoryUsage
    )
  }

  isEmpty(): boolean {
    return this.totalEvents === 0
  }

  /**
   * Cuts one batch of at most `maxBatchSize` — priority events first — and queues it.
   * A batch never mixes visits or browsers: the envelope carries one `session_id` and
   * `anon_id`, so the cut stops where the identity of the next event changes.
   */
  createBatch(maxBatchSize: number): BatchedEvents | undefined {
    const events: QueuedEvent[] = []
    for (const queue of [this.priorityEventQueue, this.eventQueue]) {
      while (events.length < maxBatchSize) {
        const next = queue.peek()
        if (!next) break
        const first = events[0]
        if (first && (next.sessionId !== first.sessionId || next.anonId !== first.anonId)) break
        events.push(queue.shift()!)
      }
    }
    if (events.length === 0) return undefined
    const batch: BatchedEvents = {
      id: uuidv4(),
      events,
      createdAt: Date.now(),
      retryCount: 0,
      size: events.length,
      memoryUsage: events.reduce((sum, e) => sum + e.memoryUsage, 0),
    }
    this.batchQueue.enqueue(batch)
    return batch
  }

  /** Cuts every pending event into batches. */
  createAllBatches(maxBatchSize: number): void {
    while (this.createBatch(maxBatchSize));
  }

  /** The next batch to send, without removing it: it stays queued until it's acknowledged,
   *  so an unload while it's in flight still beacons it (the server dedupes the repeat). */
  getBatchForProcessing(): BatchedEvents | undefined {
    return this.batchQueue.peek() ?? this.batchRetryQueue.peek()
  }

  getAllBatchesForProcessing(): BatchedEvents[] {
    return [...this.batchQueue.items, ...this.batchRetryQueue.items]
  }

  /** Acknowledged (or abandoned): forget it. */
  removeBatch(batchId: string): void {
    this.batchQueue.remove([batchId])
    this.batchRetryQueue.remove([batchId])
  }

  addBatchToRetry(batch: BatchedEvents): void {
    this.removeBatch(batch.id)
    this.batchRetryQueue.enqueue({ ...batch, retryCount: batch.retryCount + 1 })
    while (this.batchRetryQueue.size > this.limits.maxRetryBatches) {
      this.countDropped(this.batchRetryQueue.shift()!.size)
    }
    this.enforceCaps()
  }

  countDropped(events: number): void {
    this.dropped += events
  }

  /** Reads and resets the dropped counter (it rides on the next batch envelope). */
  takeDropped(): number {
    const n = this.dropped
    this.dropped = 0
    return n
  }

  snapshot(): StorageSnapshot {
    return {
      events: [...this.priorityEventQueue.items, ...this.eventQueue.items],
      batches: this.getAllBatchesForProcessing(),
      dropped: this.dropped,
    }
  }

  restore(snapshot: StorageSnapshot): void {
    for (const batch of snapshot.batches) this.batchRetryQueue.enqueue(batch)
    for (const event of snapshot.events) this.addNewEvent(event)
    this.dropped += snapshot.dropped
    this.enforceCaps()
  }

  clear(): void {
    this.eventQueue.clear()
    this.priorityEventQueue.clear()
    this.batchQueue.clear()
    this.batchRetryQueue.clear()
    this.dropped = 0
  }

  getInfo(): InMemoryStorageInfo {
    const persisted = this.limits.persisted
    return {
      eventQueueInfo: this.eventQueue.getInfo(persisted),
      priorityEventQueueInfo: this.priorityEventQueue.getInfo(persisted),
      batchQueueInfo: this.batchQueue.getInfo(persisted),
      batchRetryQueueInfo: this.batchRetryQueue.getInfo(persisted),
      totalMemoryUsage: this.totalBytes / MB,
      maxSize: this.limits.maxQueueSize,
      maxMemoryUsage: this.limits.maxMemorySize,
      dropped: this.dropped,
    }
  }

  /** Evicts the oldest data until both caps hold. Normal events go before failed batches,
   *  which go before batches never tried; priority events go last. */
  private enforceCaps(): void {
    const maxBytes = this.limits.maxMemorySize * MB
    while (this.totalEvents > this.limits.maxQueueSize || this.totalBytes > maxBytes) {
      if (this.eventQueue.shift()) this.countDropped(1)
      else if (this.batchRetryQueue.size) this.countDropped(this.batchRetryQueue.shift()!.size)
      else if (this.batchQueue.size) this.countDropped(this.batchQueue.shift()!.size)
      else if (this.priorityEventQueue.shift()) this.countDropped(1)
      else break
    }
  }
}
