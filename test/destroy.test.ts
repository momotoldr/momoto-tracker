import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { autocapture, pageViews } from '../src/plugins'
import { makeTracker, resetEnvironment, stubNetwork, trackerRegistry } from './helpers'

beforeEach(async () => {
  await resetEnvironment()
  vi.useFakeTimers()
})
afterEach(async () => {
  await resetEnvironment()
  vi.useRealTimers()
})

/** Counts listeners added minus removed, per target and type. */
function listenerLedger() {
  const live = new Map<string, number>()
  const key = (target: EventTarget, type: string) =>
    `${target === window ? 'window' : 'document'}:${type}`
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener.bind(target)
    const remove = target.removeEventListener.bind(target)
    vi.spyOn(target, 'addEventListener').mockImplementation((type, fn, opts) => {
      live.set(key(target, type), (live.get(key(target, type)) ?? 0) + 1)
      add(type, fn, opts)
    })
    vi.spyOn(target, 'removeEventListener').mockImplementation((type, fn, opts) => {
      live.set(key(target, type), (live.get(key(target, type)) ?? 0) - 1)
      remove(type, fn, opts)
    })
  }
  return () => [...live.entries()].filter(([, n]) => n !== 0)
}

describe('destroy()', () => {
  it('leaves no timers, listeners, patched history, storage keys or registry entry', async () => {
    const net = stubNetwork()
    const leaks = listenerLedger()
    const { pushState, replaceState } = history

    const tracker = makeTracker({ batch: { storage: { queue: { persistToSession: true } } } })
    const id = tracker.getId()
    tracker.use(pageViews({ normalize: (p) => p }))
    tracker.use(autocapture({ normalize: (p) => p }))
    void tracker.track('shot_taken', { index: 0 })
    await vi.advanceTimersByTimeAsync(1000) // backup written
    expect(sessionStorage.getItem(`mt-${id}-queue`)).not.toBeNull()
    expect(leaks().length).toBeGreaterThan(0)

    await tracker.destroy()

    expect(vi.getTimerCount()).toBe(0)
    expect(leaks()).toEqual([])
    expect(history.pushState).toBe(pushState)
    expect(history.replaceState).toBe(replaceState)
    expect(sessionStorage.getItem(`mt-${id}-queue`)).toBeNull()
    expect(sessionStorage.getItem('mt-test-app-tid')).toBeNull()
    expect(trackerRegistry().has(id)).toBe(false)
    // It flushed on the way out.
    expect(net.sentEvents.map((e) => e.event_name)).toContain('shot_taken')
  })

  it('is idempotent, and a destroyed tracker tracks nothing', async () => {
    const net = stubNetwork()
    const tracker = makeTracker()
    await tracker.destroy()
    await tracker.destroy()
    expect(await tracker.track('shot_taken', { index: 0 })).toEqual({ success: false })
    await vi.runAllTimersAsync()
    expect(net.fetchMock).not.toHaveBeenCalled()
  })

  it('createTracker returns the running instance for the same source in this tab', () => {
    stubNetwork()
    expect(makeTracker()).toBe(makeTracker())
  })
})
