import type { Logger } from '../lib/log'
import { isRetryable } from '../services/RetryManager'
import type { TransportService } from '../services/TransportService'
import type { QueuedEvent, TrackerResult } from '../types'

/**
 * Sends each event the moment it's tracked. If that fails after retries, the event isn't
 * lost: it is handed to the batched path as high priority, so it goes out first in the
 * next batch. Only a request the server rejected outright (a 4xx other than 408/429) is
 * dropped — it would be rejected again.
 */
export class RealTimeTracker {
  constructor(
    private readonly transport: TransportService,
    private readonly fallback: (event: QueuedEvent) => void,
    private readonly log: Logger
  ) {}

  async track(event: QueuedEvent): Promise<TrackerResult> {
    const data = { eventId: event.id }
    const response = await this.transport.sendEvent(event)
    if (response.success) return { success: true, data }
    if (!isRetryable(response)) {
      return { success: false, data, error: new Error(`rejected with ${response.status}`) }
    }
    this.log('real-time failed; re-queued')
    this.fallback({ ...event, priority: 1 })
    return { success: true, data }
  }
}
