import { describe, expect, it } from 'vitest'

import { InMemoryStorageManager } from '../src/storage/InMemoryStorageManager'
import { createQueue } from '../src/storage/queue'
import type { QueuedEvent } from '../src/types'

function event(id: string, opts: Partial<QueuedEvent> = {}): QueuedEvent {
  return {
    id,
    eventPayload: { event_id: id, event_name: 'e', event_type: null, timestamp: 0, data: {} },
    sessionId: 's1',
    anonId: 'a1',
    memoryUsage: 100,
    retryCount: 0,
    ...opts,
  }
}

function storage(limits: Partial<ConstructorParameters<typeof InMemoryStorageManager>[0]> = {}) {
  return new InMemoryStorageManager({
    maxQueueSize: 1000,
    maxMemorySize: 2,
    maxRetryBatches: 20,
    persisted: false,
    ...limits,
  })
}

describe('createQueue', () => {
  it('is FIFO and tracks memory', () => {
    const q = createQueue<QueuedEvent>()
    q.enqueue(event('a'))
    q.enqueue(event('b', { memoryUsage: 50 }))
    expect(q.memoryUsage).toBe(150)
    expect(q.shift()?.id).toBe('a')
    expect(q.memoryUsage).toBe(50)
    q.enqueue(event('c'))
    q.remove(['b'])
    expect(q.items.map((e) => e.id)).toEqual(['c'])
    expect(q.retrieve().map((e) => e.id)).toEqual(['c'])
    expect(q.size).toBe(0)
    expect(q.memoryUsage).toBe(0)
  })
})

describe('InMemoryStorageManager', () => {
  it('cuts priority events into the batch first', () => {
    const s = storage()
    s.addNewEvent(event('n1'))
    s.addNewEvent(event('p1', { priority: 1 }))
    s.addNewEvent(event('n2'))
    const batch = s.createBatch(2)!
    expect(batch.events.map((e) => e.id)).toEqual(['p1', 'n1'])
    expect(s.createBatch(2)!.events.map((e) => e.id)).toEqual(['n2'])
    expect(s.createBatch(2)).toBeUndefined()
  })

  it('never mixes two visits in one batch', () => {
    const s = storage()
    s.addNewEvent(event('old1'))
    s.addNewEvent(event('old2'))
    s.addNewEvent(event('new1', { sessionId: 's2' }))
    expect(s.createBatch(20)!.events.map((e) => e.id)).toEqual(['old1', 'old2'])
    expect(s.createBatch(20)!.events.map((e) => e.id)).toEqual(['new1'])
  })

  it('evicts the oldest normal events over the count cap and counts them', () => {
    const s = storage({ maxQueueSize: 3 })
    s.addNewEvent(event('p', { priority: 1 }))
    for (const id of ['a', 'b', 'c', 'd']) s.addNewEvent(event(id))
    expect(s.totalEvents).toBe(3)
    expect(s.eventQueue.items.map((e) => e.id)).toEqual(['c', 'd'])
    expect(s.priorityEventQueue.size).toBe(1)
    expect(s.takeDropped()).toBe(2)
    expect(s.takeDropped()).toBe(0)
  })

  it('enforces the memory cap', () => {
    const s = storage({ maxMemorySize: 250 / (1024 * 1024) })
    for (const id of ['a', 'b', 'c']) s.addNewEvent(event(id))
    expect(s.totalBytes).toBeLessThanOrEqual(250)
    expect(s.eventQueue.items.map((e) => e.id)).toEqual(['b', 'c'])
    expect(s.getInfo().dropped).toBe(1)
  })

  it('keeps a batch queued until it is removed, and caps the retry queue', () => {
    const s = storage({ maxRetryBatches: 1 })
    s.addNewEvent(event('a'))
    s.addNewEvent(event('b'))
    const first = s.createBatch(1)!
    const second = s.createBatch(1)!
    expect(s.getBatchForProcessing()?.id).toBe(first.id)
    s.addBatchToRetry(first)
    expect(s.batchRetryQueue.items[0].retryCount).toBe(1)
    s.addBatchToRetry(second)
    expect(s.batchRetryQueue.items.map((b) => b.id)).toEqual([second.id])
    expect(s.takeDropped()).toBe(1)
    s.removeBatch(second.id)
    expect(s.isEmpty()).toBe(true)
  })

  it('round-trips through snapshot/restore', () => {
    const s = storage()
    s.addNewEvent(event('a'))
    s.addNewEvent(event('b'))
    s.createBatch(1)
    s.countDropped(3)
    const copy = storage()
    copy.restore(JSON.parse(JSON.stringify(s.snapshot())))
    expect(copy.totalEvents).toBe(2)
    expect(copy.takeDropped()).toBe(3)
  })
})
