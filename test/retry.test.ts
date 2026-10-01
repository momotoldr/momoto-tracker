import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiResponse } from '../src/services/ApiClient'
import { ApiClient } from '../src/services/ApiClient'
import { isRetryable, RetryManager } from '../src/services/RetryManager'
import { stubNetwork } from './helpers'

const manager = () => new RetryManager({ maxRetries: 2, baseDelay: 1000, maxDelay: 8000 }, () => 1)

function sequence(...responses: ApiResponse[]) {
  return vi.fn(async () => responses.shift() ?? { success: true as const, status: 202 })
}

describe('isRetryable', () => {
  it('retries network errors, 5xx, 408 and 429 — not other 4xx', () => {
    for (const status of [0, 500, 503, 408, 429]) {
      expect(isRetryable({ success: false, status })).toBe(true)
    }
    for (const status of [400, 401, 404, 413]) {
      expect(isRetryable({ success: false, status })).toBe(false)
    }
  })
})

describe('RetryManager', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('retries a 5xx with exponential backoff, then succeeds', async () => {
    const op = sequence({ success: false, status: 503 }, { success: false, status: 502 })
    const done = manager().execute(op)
    await vi.advanceTimersByTimeAsync(999)
    expect(op).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1) // 1000 × 2^0
    expect(op).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2000) // 1000 × 2^1
    await expect(done).resolves.toEqual({ success: true, status: 202 })
    expect(op).toHaveBeenCalledTimes(3)
  })

  it('never retries a 400', async () => {
    const op = sequence({ success: false, status: 400 })
    await expect(manager().execute(op)).resolves.toMatchObject({ status: 400 })
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('honours Retry-After on a 429', async () => {
    const op = sequence({ success: false, status: 429, retryAfterMs: 5000 })
    const done = manager().execute(op)
    await vi.advanceTimersByTimeAsync(4999)
    expect(op).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(done).resolves.toMatchObject({ success: true })
  })

  it('gives up instead of waiting out a very long Retry-After', async () => {
    const op = sequence({ success: false, status: 429, retryAfterMs: 120_000 })
    await expect(manager().execute(op)).resolves.toMatchObject({ status: 429 })
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('stops after maxRetries', async () => {
    const op = vi.fn(async (): Promise<ApiResponse> => ({ success: false, status: 500 }))
    const done = manager().execute(op)
    await vi.runAllTimersAsync()
    await expect(done).resolves.toMatchObject({ status: 500 })
    expect(op).toHaveBeenCalledTimes(3)
  })
})

describe('ApiClient', () => {
  it('posts text/plain without credentials and never throws', async () => {
    const net = stubNetwork((r) => (r.url.endsWith('/down') ? 'network-error' : 202))
    const api = new ApiClient()
    await expect(
      api.post('https://x.test/ok', '{"events":[]}', { timeoutMs: 1000 })
    ).resolves.toEqual({
      success: true,
      status: 202,
    })
    const init = net.requests[0].init
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'text/plain;charset=UTF-8'
    )
    expect(init.credentials).toBe('omit')
    await expect(
      api.post('https://x.test/down', '{"events":[]}', { timeoutMs: 1000 })
    ).resolves.toMatchObject({
      success: false,
      status: 0,
    })
  })

  it('reads Retry-After in seconds', async () => {
    stubNetwork(() => ({ status: 429, retryAfter: '7' }))
    await expect(
      new ApiClient().post('https://x.test', '{"events":[]}', { timeoutMs: 1000 })
    ).resolves.toMatchObject({ status: 429, retryAfterMs: 7000 })
  })
})
