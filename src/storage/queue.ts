import type { QueueInfo } from '../types'

interface Item {
  id: string
  memoryUsage: number
}

export interface Queue<T extends Item> {
  readonly items: readonly T[]
  readonly size: number
  /** Bytes. */
  readonly memoryUsage: number
  enqueue(item: T): void
  /** Removes and returns up to `limit` items from the front (all of them if omitted). */
  retrieve(limit?: number): T[]
  /** Removes and returns the oldest item. */
  shift(): T | undefined
  peek(): T | undefined
  remove(ids: string[]): void
  clear(): void
  getInfo(isPersisted: boolean): QueueInfo<T>
}

const MB = 1024 * 1024

/** A FIFO queue that keeps a running total of its items' estimated memory. */
export function createQueue<T extends Item>(): Queue<T> {
  let items: T[] = []
  let bytes = 0

  return {
    get items() {
      return items
    },
    get size() {
      return items.length
    },
    get memoryUsage() {
      return bytes
    },
    enqueue(item) {
      items.push(item)
      bytes += item.memoryUsage
    },
    retrieve(limit = items.length) {
      const taken = items.splice(0, limit)
      for (const item of taken) bytes -= item.memoryUsage
      return taken
    },
    shift() {
      const item = items.shift()
      if (item) bytes -= item.memoryUsage
      return item
    },
    peek() {
      return items[0]
    },
    remove(ids) {
      if (ids.length === 0) return
      const drop = new Set(ids)
      items = items.filter((item) => {
        if (!drop.has(item.id)) return true
        bytes -= item.memoryUsage
        return false
      })
    },
    clear() {
      items = []
      bytes = 0
    },
    getInfo(isPersisted) {
      return { size: items.length, memoryUsage: bytes / MB, isPersisted, items: [...items] }
    },
  }
}
