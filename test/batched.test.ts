import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SDK } from '../src/services/TransportService'
import { BASE_URL, makeTracker, resetEnvironment, stubNetwork } from './helpers'

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }

beforeEach(async () => {
  await resetEnvironment()
  vi.useFakeTimers()
})
afterEach(async () => {
  await resetEnvironment()
  vi.useRealTimers()
})

describe('batched delivery', () => {
  it('1,000 events go out in at most 50 requests of ≤ 20', async () => {
    const net = stubNetwork()
    const tracker = makeTracker()
    for (let i = 0; i < 1000; i++) void tracker.track('shot_taken', { index: i % 4 })
    await vi.runAllTimersAsync()

    expect(net.requests.length).toBeLessThanOrEqual(50)
    expect(Math.max(...net.requests.map((r) => r.body.events.length))).toBeLessThanOrEqual(20)
    expect(net.sentEvents).toHaveLength(1000)
    expect(new Set(net.sentEvents.map((e) => e.event_id)).size).toBe(1000)
  })

  it('has no timer at all while the queue is empty', async () => {
    stubNetwork()
    const tracker = makeTracker()
    expect(vi.getTimerCount()).toBe(0)
    void tracker.track('shot_taken', { index: 0 })
    expect(vi.getTimerCount()).toBe(1)
    await vi.runAllTimersAsync()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a lone event waits maxWaitTime for company; a full batch goes at once', async () => {
    const net = stubNetwork()
    const tracker = makeTracker({ batch: { maxWaitTime: 10_000, maxBatchSize: 3 } })
    void tracker.track('shot_taken', { index: 0 })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(net.requests).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(net.requests).toHaveLength(1)

    for (let i = 0; i < 3; i++) void tracker.track('shot_taken', { index: i })
    await vi.advanceTimersByTimeAsync(0)
    expect(net.requests).toHaveLength(2)
    expect(net.requests[1].body.events).toHaveLength(3)
  })

  it('sends the documented envelope as text/plain to the batch endpoint', async () => {
    const net = stubNetwork()
    const tracker = makeTracker({ context: () => ({ appVersion: 'abc1234' }) })
    await tracker.track('shot_taken', { index: 2 })
    await vi.runAllTimersAsync()

    const [request] = net.requests
    expect(request.url).toBe(`${BASE_URL}/v1/b`)
    expect((request.init.headers as Record<string, string>)['Content-Type']).toBe(
      'text/plain;charset=UTF-8'
    )
    const { identity } = { identity: tracker.getIdentity()! }
    expect(request.body).toMatchObject({
      source: 'test-app',
      sdk: SDK,
      anon_id: identity.anonId,
      session_id: identity.sessionId,
      dropped: 0,
      context: { appVersion: 'abc1234', viewport: expect.any(String) },
      events: [{ event_name: 'shot_taken', event_type: null, data: { index: 2 } }],
    })
    expect(typeof request.body.sent_at).toBe('number')
    expect(request.body.events[0].event_id).toMatch(/^[0-9a-f-]{14}7/)
  })

  it('reports the package version as the SDK version', () => {
    expect(SDK).toEqual({ name: 'momoto-tracker', version })
  })

  it('drops undefined and non-scalar props', async () => {
    const net = stubNetwork()
    const tracker = makeTracker()
    // A JS caller can pass anything; nested objects must never reach the wire.
    await tracker.track('click', {
      id: null,
      el: 'a',
      route: '/',
      to: undefined,
      nested: { a: 1 },
    } as never)
    await vi.runAllTimersAsync()
    expect(net.sentEvents[0].data).toEqual({ id: null, el: 'a', route: '/' })
  })

  it('retries a failed batch with backoff and never resends what succeeded', async () => {
    let down = true
    const net = stubNetwork(() => (down ? 503 : 202))
    const tracker = makeTracker({ batch: { maxWaitTime: 1000 } })
    void tracker.track('shot_taken', { index: 0 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(net.requests).toHaveLength(1)
    expect(tracker.getStorageInfo()!.batchRetryQueueInfo.size).toBe(1)

    down = false
    await vi.runAllTimersAsync()
    expect(net.requests).toHaveLength(2)
    expect(net.requests[1].body.events[0].event_id).toBe(net.requests[0].body.events[0].event_id)
    expect(tracker.getStorageInfo()!.batchRetryQueueInfo.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('abandons a batch the server rejects outright and reports it as dropped', async () => {
    let reject = true
    const net = stubNetwork(() => (reject ? 400 : 202))
    const tracker = makeTracker()
    void tracker.track('shot_taken', { index: 0 })
    await vi.runAllTimersAsync()
    reject = false
    void tracker.track('shot_taken', { index: 1 })
    await vi.runAllTimersAsync()
    expect(net.requests).toHaveLength(2)
    expect(net.requests[1].body.dropped).toBe(1)
  })

  it('holds everything while offline and resumes when back online', async () => {
    const net = stubNetwork()
    const tracker = makeTracker()
    void tracker.track('shot_taken', { index: 0 })
    window.dispatchEvent(new Event('offline'))
    await vi.runAllTimersAsync()
    expect(net.requests).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    window.dispatchEvent(new Event('online'))
    await vi.runAllTimersAsync()
    expect(net.requests).toHaveLength(1)
  })

  it('back from hidden or offline, a failed batch is retried at once', async () => {
    let down = true
    const net = stubNetwork(() => (down ? 503 : 202))
    const tracker = makeTracker({ batch: { maxWaitTime: 1000 } })
    void tracker.track('shot_taken', { index: 0 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(tracker.getStorageInfo()!.batchRetryQueueInfo.size).toBe(1)
    window.dispatchEvent(new Event('offline'))
    down = false
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(net.requests).toHaveLength(2)
  })

  it('pause() stops sending until resume()', async () => {
    const net = stubNetwork()
    const tracker = makeTracker()
    void tracker.track('shot_taken', { index: 0 })
    await tracker.pause()
    void tracker.track('shot_taken', { index: 1 })
    await vi.runAllTimersAsync()
    expect(net.requests).toHaveLength(0)
    await tracker.resume()
    await vi.runAllTimersAsync()
    expect(net.sentEvents).toHaveLength(2)
  })

  it('flush() sends now', async () => {
    const net = stubNetwork()
    const tracker = makeTracker()
    void tracker.track('shot_taken', { index: 0 })
    await tracker.flush()
    expect(net.requests).toHaveLength(1)
  })
})
