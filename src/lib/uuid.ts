function randomBytes(): Uint8Array {
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes)
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  return bytes
}

function format(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * UUIDv7 (RFC 9562): a 48-bit millisecond timestamp, then randomness. Used for event ids,
 * which the server keeps as a primary key — time-ordered keys only ever append to the
 * index, where random v4 keys would split pages all over it.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes()
  let t = now
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256
    t = Math.floor(t / 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return format(bytes)
}

/** UUIDv4: fully random. For ids that must not reveal when they were made (visit, browser). */
export function uuidv4(): string {
  const bytes = randomBytes()
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return format(bytes)
}
