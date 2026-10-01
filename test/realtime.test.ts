import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BASE_URL, makeTracker, resetEnvironment, stubNetwork } from './helpers'

beforeEach(async () => {
  await resetEnvironment()
  vi.useFakeTimers()
})
afterEach(async () => {
  await resetEnvironment()
  vi.useRealTimers()
})

describe('real-time mode', () => {
  it('sends at once to the single endpoint and installs nothing while it works', async () => {
    const net = stubNetwork()
    const add = vi.spyOn(window, 'addEventListener')
    const tracker = makeTracker({
      event: { source: 'test-app', classification: { payment_succeeded: { mode: 'REAL_TIME' } } },
    })
    const result = await tracker.track('payment_succeeded', { amountIdr: 13_000 })
    expect(result.success).toBe(true)
    expect(net.requests).toHaveLength(1)
    expect(net.requests[0].url).toBe(`${BASE_URL}/v1/e`)
    expect(vi.getTimerCount()).toBe(0)
    expect(add).not.toHaveBeenCalled()
  })

  it('a failed real-time event goes first in the next batch, then the scheduler stops', async () => {
    let down = true
    const net = stubNetwork(() => (down ? 503 : 202))
    const tracker = makeTracker()
    void tracker.track('shot_taken', { index: 0 })
    await tracker.track('payment_succeeded', { amountIdr: 13_000 }, { mode: 'REAL_TIME' })
    expect(tracker.getStorageInfo()!.priorityEventQueueInfo.size).toBe(1)

    down = false
    await vi.runAllTimersAsync()
    const last = net.requests[net.requests.length - 1]
    const batch = last.body.events.map((e) => e.event_name)
    expect(batch).toEqual(['payment_succeeded', 'shot_taken'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a rejected real-time event (400) is not re-queued', async () => {
    stubNetwork(() => 400)
    const tracker = makeTracker()
    const result = await tracker.track('payment_succeeded', { amountIdr: 1 }, { mode: 'REAL_TIME' })
    expect(result.success).toBe(false)
    expect(tracker.getStorageInfo()).toBeNull()
  })

  it('classification sets the event type', async () => {
    const net = stubNetwork()
    const tracker = makeTracker({
      event: { source: 'test-app', classification: { page_view: { eventType: 'PAGE' } } },
    })
    void tracker.track('page_view', { route: '/', fromRoute: null, msOnPrevious: null })
    await vi.runAllTimersAsync()
    expect(net.sentEvents[0].event_type).toBe('PAGE')
  })
})
