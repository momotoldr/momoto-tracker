import type { ContextValue } from '../types'

type Context = Record<string, ContextValue>

/** Device facts every batch carries. Nothing here identifies a person. */
export function defaultContext(): Context {
  const context: Context = {}
  if (typeof window !== 'undefined') {
    context.viewport = `${window.innerWidth}x${window.innerHeight}`
  }
  if (typeof navigator !== 'undefined') {
    context.language = navigator.language ?? null
    const connection = (navigator as Navigator & { connection?: { effectiveType?: string } })
      .connection
    context.connection = connection?.effectiveType ?? null
  }
  return context
}

/** Defaults, overlaid with the host's own context. A host function that throws costs only
 *  its own fields. */
export function createContextProvider(host?: () => Context): () => Context {
  return () => {
    let extra: Context = {}
    try {
      extra = host?.() ?? {}
    } catch {
      // Keep the defaults.
    }
    return { ...defaultContext(), ...extra }
  }
}
