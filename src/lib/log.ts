export type Logger = (...args: unknown[]) => void

/** `console.debug` with a prefix when debugging, otherwise nothing at all. */
export function createLogger(debug: boolean | undefined): Logger {
  return debug ? (...args) => console.debug('[tracker]', ...args) : () => {}
}

/** Bytes of a string as UTF-8 — what actually counts against beacon/keepalive budgets. */
export function byteLength(text: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length
}
