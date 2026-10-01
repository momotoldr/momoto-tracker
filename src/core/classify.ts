import type { EventConfig, EventMap, EventOptions, EventType, TrackerMode } from '../types'

export interface ResolvedClassification {
  mode: TrackerMode
  highPriority: boolean
  eventType: EventType | null
}

/** Per-call options win, then the event's configured classification, then the global mode. */
export function classify<E extends EventMap>(
  config: EventConfig<E>,
  name: string,
  options: EventOptions = {}
): ResolvedClassification {
  const configured = config.classification?.[name as keyof E] ?? {}
  return {
    mode: options.mode ?? configured.mode ?? config.mode ?? 'BATCHED',
    highPriority: options.highPriority ?? configured.highPriority ?? false,
    eventType: configured.eventType ?? null,
  }
}
