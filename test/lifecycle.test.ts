import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTracker } from '../src'
import { UNLOAD_CHUNK_BYTES } from '../src/services/TransportService'
import {
  trackerRegistry,
  hide,
  makeTracker,
  resetEnvironment,
  show,
  stubNetwork,
  type TestEvents,
} from './helpers'

beforeEach(async () => {
  await resetEnvironment()
  vi.useFakeTimers()
})
afterEach(async () => {
  await resetEnvironment()
  vi.useRealTimers()
})

describe('page hidden / closed', () => {
  it('beacons everything queued, then goes quiet', async () => {
    const net = stubNetwork()
    const tracker = makeTracker()
    for (let i = 0; i < 3; i++) void tracker.track('shot_taken', { index: i })
    hide()

    expect(net.sendBeacon).toHaveBeenCalledTimes(1)
    expect(net.fetchMock).not.toHaveBeenCalled()
    const [body] = await net.beaconBodies()
    expect(body.events).toHaveLength(3)
    expect(net.beacons[0].blob.type).toBe('text/plain;charset=utf-8') // Blob lowercases it
    expect(tracker.getStorageInfo()!.batchQueueInfo.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    // Hidden: new events queue but nothing is scheduled until the page is visible again —
    // and then they still wait their usual turn rather than going at once.
    void tracker.track('shot_taken', { index: 9 })
    expect(vi.getTimerCount()).toBe(0)
    show()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(net.sentEvents).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(net.sentEvents.map((e) => e.data.index)).toEqual([9])
  })

  it('a normal load’s pageshow does not send early; a back/forward restore resumes', async () => {
    const net = stubNetwork()
    const tracker = makeTracker({ batch: { maxWaitTime: 60_000 } })
    void tracker.track('shot_taken', { index: 0 })
    const pageshow = (persisted: boolean) =>
      Object.assign(new Event('pageshow'), { persisted }) as Event
    window.dispatchEvent(pageshow(false))
    await vi.advanceTimersByTimeAsync(1000)
    expect(net.requests).toHaveLength(0)

    await tracker.pause() // as if frozen in the back/forward cache
    window.dispatchEvent(pageshow(true))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(net.requests).toHaveLength(1)
  })

  it('pagehide after hidden sends nothing twice', async () => {
    const net = stubNetwork()
    const tracker = makeTracker()
    void tracker.track('shot_taken', { index: 0 })
    hide()
    window.dispatchEvent(new Event('pagehide'))
    expect(net.sendBeacon).toHaveBeenCalledTimes(1)
  })

  it('splits large batches under the beacon budget', async () => {
    const net = stubNetwork()
    const tracker = createTracker<{ big: { blob: string } }>({
      event: { source: 'test-app' },
      network: { baseUrl: 'https://e.example.test' },
      batch: { maxBatchSize: 1000 },
    })
    for (let i = 0; i < 40; i++) void tracker.track('big', { blob: 'x'.repeat(5_000) })
    hide()
    const bodies = await net.beaconBodies()
    expect(bodies.length).toBeGreaterThan(1)
    for (const b of net.beacons) expect(b.blob.size).toBeLessThan(UNLOAD_CHUNK_BYTES)
    expect(bodies.flatMap((b) => b.events)).toHaveLength(40)
  })

  it('falls back to a keepalive fetch when sendBeacon refuses', async () => {
    const net = stubNetwork()
    net.beaconAccepts = false
    const tracker = makeTracker()
    void tracker.track('shot_taken', { index: 0 })
    hide()
    expect(net.fetchMock).toHaveBeenCalledTimes(1)
    expect(net.requests[0].init.keepalive).toBe(true)
  })

  it('beacons a batch that is still in flight (the server dedupes the repeat)', async () => {
    let release: (r: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve)))
    )
    const beacon = vi.fn(() => true)
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })

    const tracker = makeTracker()
    void tracker.track('shot_taken', { index: 0 })
    await vi.advanceTimersByTimeAsync(10_000) // send starts, never answers
    hide()
    expect(beacon).toHaveBeenCalledTimes(1)
    release(new Response(null, { status: 503 }))
    await vi.runAllTimersAsync()
    // Already beaconed, so the failure does not put it back for a third copy.
    expect(tracker.getStorageInfo()!.batchRetryQueueInfo.size).toBe(0)
  })
})

describe('reload (persistToSession)', () => {
  const persisted = { batch: { storage: { queue: { persistToSession: true } } } }

  it('restores the previous page’s queue and sends it with the same event ids', async () => {
    const net = stubNetwork()
    const first = makeTracker(persisted)
    void first.track('shot_taken', { index: 0 })
    void first.track('shot_taken', { index: 1 })
    await vi.advanceTimersByTimeAsync(1000) // debounced backup lands
    const ids = first.getStorageInfo()!.eventQueueInfo.items.map((e) => e.id)

    // The page dies without a chance to flush: its timers and registry entry go,
    // sessionStorage stays.
    vi.clearAllTimers()
    trackerRegistry().clear()

    const second = makeTracker(persisted)
    expect(second.getId()).toBe(first.getId())
    await vi.runAllTimersAsync()
    expect(net.sentEvents.map((e) => e.event_id)).toEqual(ids)
  })

  it('a tab never restores another tab’s backup', async () => {
    stubNetwork()
    const tracker = makeTracker(persisted)
    void tracker.track('shot_taken', { index: 0 })
    await vi.advanceTimersByTimeAsync(1000)
    const backupKey = `mt-${tracker.getId()}-queue`
    expect(sessionStorage.getItem(backupKey)).not.toBeNull()
    // Another tab has its own trackerId (sessionStorage is per tab), so a different key.
    expect(Object.keys(sessionStorage).filter((k) => k.endsWith('-queue'))).toEqual([backupKey])
  })

  it('clears the backup once the queue is beaconed, so a reload resends nothing', async () => {
    stubNetwork()
    const tracker = makeTracker(persisted)
    void tracker.track('shot_taken', { index: 0 })
    await vi.advanceTimersByTimeAsync(1000)
    hide()
    expect(sessionStorage.getItem(`mt-${tracker.getId()}-queue`)).toBeNull()
  })
})

describe('storage unavailable', () => {
  it('still tracks, in memory only', async () => {
    const net = stubNetwork()
    const blocked = () => {
      throw new DOMException('blocked', 'SecurityError')
    }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
    const tracker = makeTracker({ batch: { storage: { queue: { persistToSession: true } } } })
    await tracker.track('shot_taken', { index: 0 })
    await vi.runAllTimersAsync()
    expect(net.sentEvents).toHaveLength(1)
    expect(tracker.getIdentity()!.anonId).toMatch(/^[0-9a-f-]{36}$/)
  })
})

export type { TestEvents }
