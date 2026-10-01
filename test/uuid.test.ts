import { describe, expect, it } from 'vitest'

import { uuidv4, uuidv7 } from '../src/lib/uuid'

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('uuid', () => {
  it('v7 carries the millisecond timestamp, so ids sort by time', () => {
    const t = 1757300000000
    const id = uuidv7(t)
    expect(id).toMatch(V7)
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(t)
    expect(uuidv7(t) < uuidv7(t + 1)).toBe(true)
  })

  it('v4 is random', () => {
    const a = uuidv4()
    expect(a).toMatch(V4)
    expect(uuidv4()).not.toBe(a)
  })
})
