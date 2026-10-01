import type { RetryConfig } from '../types'
import type { ApiResponse } from './ApiClient'

/** A `Retry-After` longer than this isn't waited out in place: the batch goes back to the
 *  retry queue and the scheduler tries again later, so one send can't hold the line. */
const MAX_IN_PLACE_WAIT_MS = 30_000

/** No response, a server error, a timeout or a rate limit. Any other 4xx is the request's
 *  own fault and would fail the same way again. */
export function isRetryable(response: ApiResponse): boolean {
  if (response.success) return false
  const { status } = response
  return status === 0 || status >= 500 || status === 408 || status === 429
}

export class RetryManager {
  constructor(
    private readonly config: RetryConfig,
    private readonly random: () => number = Math.random
  ) {}

  /**
   * Runs `operation`, retrying up to `maxRetries` times with exponential backoff and full
   * jitter (`random(0, base × 2^n)`, capped). Full jitter spreads a crowd of clients that
   * all failed at the same moment, rather than having them retry in lockstep.
   */
  async execute(
    operation: () => Promise<ApiResponse>,
    maxRetries: number = this.config.maxRetries
  ): Promise<ApiResponse> {
    let response = await operation()
    for (let attempt = 0; attempt < maxRetries && isRetryable(response); attempt++) {
      const backoff = Math.min(
        this.config.maxDelay,
        this.random() * this.config.baseDelay * 2 ** attempt
      )
      const wait = (!response.success && response.retryAfterMs) || backoff
      if (wait > MAX_IN_PLACE_WAIT_MS) break
      await new Promise((resolve) => setTimeout(resolve, wait))
      response = await operation()
    }
    return response
  }
}
