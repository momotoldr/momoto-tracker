import { createLogger } from '../lib/log'
import { uuidv4 } from '../lib/uuid'
import { readItem, writeItem } from '../lib/webStorage'
import { consentDenial, sampledIn } from '../session/ConsentGate'
import { IdentityManager } from '../session/IdentityManager'
import type { EventMap, TrackerConfig } from '../types'
import { EventTracker } from './EventTracker'
import { NoopTracker } from './NoopTracker'
import type { Tracker } from './types'

const REGISTRY = '__momotoTrackers__'

/** On `globalThis`, so even a second copy of this module (a duplicated dependency, a
 *  re-evaluated chunk) finds the instance already running in this tab. */
function registry(): Map<string, Tracker<EventMap>> {
  const scope = globalThis as unknown as Record<string, Map<string, Tracker<EventMap>>>
  return (scope[REGISTRY] ??= new Map())
}

/** Stable per tab: sessionStorage survives reloads but is not shared between tabs. */
function trackerIdFor(source: string): string {
  const key = `mt-${source}-tid`
  const existing = readItem('session', key)
  if (existing) return existing
  const id = uuidv4()
  writeItem('session', key, id)
  return id
}

/**
 * Creates the tracker for this tab — or returns the one already running for this `source`.
 *
 * Call it once at **module scope**, not inside a component: React StrictMode runs effects
 * twice and HMR re-runs modules, and either would otherwise start a second tracker. (A
 * repeat call returns the existing instance with its original config.)
 *
 * When tracking must not run — `consent.enabled: false`, Do Not Track / GPC, opted out, or
 * this visit sampled out — it returns a no-op tracker with the same interface.
 */
export function createTracker<E extends EventMap>(config: TrackerConfig<E>): Tracker<E> {
  const log = createLogger(config.debug)
  const consent = config.consent ?? {}
  const denial = consentDenial(consent)
  if (denial) {
    log('tracking off:', denial)
    return new NoopTracker<E>(log, denial, consent.optOutKey)
  }

  const trackerId = trackerIdFor(config.event.source)
  const existing = registry().get(trackerId)
  if (existing) return existing as unknown as Tracker<E>

  const identity = new IdentityManager(
    config.event.source,
    config.session?.idleTimeoutMs ?? 30 * 60_000
  )
  if (!sampledIn(identity.sampleRoll, consent.sampleRate)) {
    log('tracking off: sampled out')
    return new NoopTracker<E>(log, 'sampled out', consent.optOutKey)
  }

  const tracker = new EventTracker<E>(trackerId, config, identity, log, () =>
    registry().delete(trackerId)
  )
  registry().set(trackerId, tracker as unknown as Tracker<EventMap>)
  log('tracker', trackerId, 'started')
  return tracker
}
