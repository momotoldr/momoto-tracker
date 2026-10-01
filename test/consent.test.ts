import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTracker } from '../src'
import { pageViews } from '../src/plugins'
import { makeTracker, resetEnvironment, stubNetwork, trackerRegistry } from './helpers'

beforeEach(async () => {
  await resetEnvironment()
  vi.useFakeTimers()
})
afterEach(async () => {
  await resetEnvironment()
  vi.useRealTimers()
  for (const key of ['doNotTrack', 'globalPrivacyControl']) {
    delete (navigator as unknown as Record<string, unknown>)[key]
  }
})

function setNavigator(key: string, value: unknown) {
  Object.defineProperty(navigator, key, { value, configurable: true })
}

const cases: Array<[string, () => Parameters<typeof makeTracker>[0]]> = [
  ['disabled', () => ({ consent: { enabled: false } })],
  ['Do Not Track', () => (setNavigator('doNotTrack', '1'), {})],
  ['Global Privacy Control', () => (setNavigator('globalPrivacyControl', true), {})],
  [
    'opted out',
    () => (localStorage.setItem('app.optout', 'true'), { consent: { optOutKey: 'app.optout' } }),
  ],
  ['sampled out', () => ({ consent: { sampleRate: 0 } })],
]

describe('consent', () => {
  it.each(cases)('%s → a no-op tracker: no listeners, no timers, no requests', async (_, setup) => {
    const net = stubNetwork()
    const addWindow = vi.spyOn(window, 'addEventListener')
    const addDocument = vi.spyOn(document, 'addEventListener')
    const pushState = history.pushState

    const tracker = makeTracker(setup())
    tracker.use(pageViews({ normalize: (p) => p }))
    const result = await tracker.track('shot_taken', { index: 0 })
    await vi.runAllTimersAsync()

    expect(tracker.enabled).toBe(false)
    expect(result.success).toBe(false)
    expect(net.fetchMock).not.toHaveBeenCalled()
    expect(net.sendBeacon).not.toHaveBeenCalled()
    expect(addWindow).not.toHaveBeenCalled()
    expect(addDocument).not.toHaveBeenCalled()
    expect(history.pushState).toBe(pushState)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('respectDnt: false ignores the signal', () => {
    setNavigator('doNotTrack', '1')
    expect(makeTracker({ consent: { respectDnt: false } }).enabled).toBe(true)
  })

  it('the sample roll is fixed for the visit', () => {
    const roll = vi.spyOn(Math, 'random').mockReturnValue(0.4)
    expect(makeTracker({ consent: { sampleRate: 0.5 } }).enabled).toBe(true)
    roll.mockReturnValue(0.9) // a later roll must not matter within the same visit
    trackerRegistry().clear()
    expect(makeTracker({ consent: { sampleRate: 0.5 } }).enabled).toBe(true)
  })

  it('setOptOut(true) stops at once, discards the queue and forgets the ids', async () => {
    const net = stubNetwork()
    const tracker = makeTracker({ consent: { optOutKey: 'app.optout' } })
    void tracker.track('shot_taken', { index: 0 })
    tracker.setOptOut(true)
    await vi.runAllTimersAsync()
    expect(net.fetchMock).not.toHaveBeenCalled()
    expect(localStorage.getItem('app.optout')).toBe('true')
    expect(localStorage.getItem('mt-test-app-aid')).toBeNull()
    expect(makeTracker({ consent: { optOutKey: 'app.optout' } }).enabled).toBe(false)

    tracker.setOptOut(false)
    expect(localStorage.getItem('app.optout')).toBeNull()
  })

  it('debug mode logs calls on the no-op tracker without sending', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const tracker = createTracker<{ x: { a: number } }>({
      event: { source: 'test-app' },
      network: { baseUrl: 'https://e.example.test' },
      consent: { enabled: false },
      debug: true,
    })
    await tracker.track('x', { a: 1 })
    expect(debug).toHaveBeenCalledWith('[tracker]', 'track (not sent: disabled)', 'x', { a: 1 }, '')
  })
})

describe('identity', () => {
  it('keeps the visit across reloads and rolls it after 30 idle minutes', async () => {
    stubNetwork()
    const tracker = makeTracker()
    const first = tracker.getIdentity()!
    const seen: string[] = []
    tracker.onIdentity((id) => seen.push(id.sessionId))
    expect(seen).toEqual([first.sessionId]) // called once immediately

    vi.advanceTimersByTime(29 * 60_000)
    await tracker.track('shot_taken', { index: 0 })
    expect(tracker.getIdentity()!.sessionId).toBe(first.sessionId)

    vi.advanceTimersByTime(31 * 60_000)
    await tracker.track('shot_taken', { index: 1 })
    const second = tracker.getIdentity()!
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(second.anonId).toBe(first.anonId)
    expect(seen).toEqual([first.sessionId, second.sessionId])
  })

  it('events queued before a rollover keep their own visit id', async () => {
    const net = stubNetwork()
    const tracker = makeTracker({ batch: { maxWaitTime: 60 * 60_000 } })
    const before = tracker.getIdentity()!.sessionId
    void tracker.track('shot_taken', { index: 0 })
    vi.setSystemTime(Date.now() + 31 * 60_000)
    void tracker.track('shot_taken', { index: 1 })
    await tracker.flush()
    expect(net.requests.map((r) => r.body.session_id)).toEqual([
      before,
      tracker.getIdentity()!.sessionId,
    ])
  })

  it('resetIdentity() gives a new browser and visit id', () => {
    stubNetwork()
    const tracker = makeTracker()
    const before = tracker.getIdentity()!
    tracker.resetIdentity()
    const after = tracker.getIdentity()!
    expect(after.anonId).not.toBe(before.anonId)
    expect(after.sessionId).not.toBe(before.sessionId)
    expect(localStorage.getItem('mt-test-app-aid')).toBe(after.anonId)
  })
})
