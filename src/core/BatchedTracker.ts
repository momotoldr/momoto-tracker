import type { Logger } from '../lib/log'
import { SchedulerService, type SchedulerConfig } from '../services/SchedulerService'
import type { TransportService } from '../services/TransportService'
import { InMemoryStorageManager, type StorageLimits } from '../storage/InMemoryStorageManager'
import { SessionPersistence } from '../storage/SessionPersistence'
import type { InMemoryStorageInfo, QueuedEvent } from '../types'

export interface BatchedTrackerOptions {
  trackerId: string
  limits: StorageLimits
  scheduler: SchedulerConfig
}

/** Queues events in memory and lets the scheduler send them in batches. */
export class BatchedTracker {
  readonly storage: InMemoryStorageManager
  readonly scheduler: SchedulerService
  private readonly persistence: SessionPersistence | null

  constructor(
    options: BatchedTrackerOptions,
    private readonly transport: TransportService,
    private readonly log: Logger
  ) {
    this.storage = new InMemoryStorageManager(options.limits)
    this.persistence = options.limits.persisted ? new SessionPersistence(options.trackerId) : null
    this.scheduler = new SchedulerService(
      this.storage,
      transport,
      options.scheduler,
      () => this.persistence?.scheduleBackup(() => this.storage.snapshot()),
      log
    )

    const restored = this.persistence?.restore()
    if (restored && (restored.events.length || restored.batches.length)) {
      this.log('restored', restored.events.length, restored.batches.length)
      this.storage.restore(restored)
      void this.scheduler.restart()
    }
  }

  /** Whether the previous page of this tab left a backup to restore. */
  static hasBackup(trackerId: string): boolean {
    return new SessionPersistence(trackerId).hasBackup()
  }

  track(event: QueuedEvent): void {
    this.scheduler.scheduleNewEvent(event)
  }

  pause(): Promise<void> {
    return this.scheduler.stop()
  }

  resume(): Promise<void> {
    return this.scheduler.restart()
  }

  getStorageInfo(): InMemoryStorageInfo {
    return this.scheduler.getStorageInfo()
  }

  flush(): Promise<void> {
    return this.scheduler.flush()
  }

  /** Page hidden or going away: everything queued leaves now as beacons, then the
   *  scheduler goes quiet until the page is visible again. */
  onHidden(): void {
    this.storage.createAllBatches(Number.MAX_SAFE_INTEGER)
    const batches = this.storage.getAllBatchesForProcessing()
    if (batches.length > 0) {
      this.log('unload', batches.length)
      this.transport.sendOnUnload(batches.map((batch) => batch.events))
      for (const batch of batches) this.storage.removeBatch(batch.id)
    }
    // Empty now, so this clears the backup rather than leaving a copy to resend on reload.
    this.persistence?.backup(this.storage.snapshot())
    void this.scheduler.stop()
  }

  onVisible(): void {
    void this.scheduler.restart()
  }

  setOnline(online: boolean): void {
    this.scheduler.setOnline(online)
  }

  async destroy(flush: boolean): Promise<void> {
    await this.scheduler.stop(flush)
    this.persistence?.clear()
    this.storage.clear()
  }
}
