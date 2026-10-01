import { createContext, createElement, useContext, type ReactNode } from 'react'

import type { Tracker } from '../core/types'
import type { EventMap } from '../types'

const TrackerContext = createContext<Tracker<EventMap> | null>(null)

export interface TrackerProviderProps<E extends EventMap> {
  /** Created once at module scope with `createTracker` — never inside a component. */
  tracker: Tracker<E>
  children?: ReactNode
}

/** Makes the tracker available to `useTracker()` below it. */
export function TrackerProvider<E extends EventMap>({
  tracker,
  children,
}: TrackerProviderProps<E>) {
  return createElement(
    TrackerContext.Provider,
    { value: tracker as unknown as Tracker<EventMap> },
    children
  )
}

/**
 * The tracker from the nearest `<TrackerProvider>`. Call `track` from effects and event
 * handlers, never during render — render can run more than once for one update.
 */
export function useTracker<E extends EventMap = EventMap>(): Tracker<E> {
  const tracker = useContext(TrackerContext)
  if (!tracker) throw new Error('useTracker() needs a <TrackerProvider> above it')
  return tracker as unknown as Tracker<E>
}
