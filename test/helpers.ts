import { vi } from 'vitest'

import { createTracker } from '../src'
import type { EventMap, TrackerConfig } from '../src'

export interface SentRequest {
  url: string
  body: Envelope
  init: RequestInit
}

export interface Envelope {
  request_id: string
  source: string
  sdk: { name: string; version: string }
  anon_id: string
  session_id: string
  context: Record<string, unknown>
  sent_at: number
  dropped: number
  events: Array<{
    event_id: string
    event_name: string
    event_type: string | null
    timestamp: number
    data: Record<string, unknown>
  }>
}

type Responder = (
  request: SentRequest
) => number | { status: number; retryAfter?: string } | 'network-error'

/** Replaces `fetch` and `navigator.sendBeacon` with recorders. */
export function stubNetwork(respond: Responder = () => 202) {
  const requests: SentRequest[] = []
  const beacons: Array<{ url: string; blob: Blob }> = []
  let beaconAccepts = true

  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const request = { url, body: JSON.parse(String(init.body)) as Envelope, init }
    requests.push(request)
    const outcome = respond(request)
    if (outcome === 'network-error') throw new TypeError('Failed to fetch')
    const { status, retryAfter } = typeof outcome === 'number' ? { status: outcome } : outcome
    return new Response(null, {
      status,
      headers: retryAfter ? { 'Retry-After': retryAfter } : undefined,
    })
  })
  vi.stubGlobal('fetch', fetchMock)

  const sendBeacon = vi.fn((url: string, blob: Blob) => {
    if (!beaconAccepts) return false
    beacons.push({ url, blob })
    return true
  })
  Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true })

  return {
    requests,
    beacons,
    fetchMock,
    sendBeacon,
    set beaconAccepts(value: boolean) {
      beaconAccepts = value
    },
    /** Events across every fetch request, in send order. */
    get sentEvents() {
      return requests.flatMap((r) => r.body.events)
    },
    async beaconBodies(): Promise<Envelope[]> {
      return Promise.all(beacons.map(async (b) => JSON.parse(await b.blob.text()) as Envelope))
    },
  }
}

/** The live-tracker registry `createTracker` keeps on `globalThis`. */
type LiveTracker = { destroy(flush?: boolean): Promise<void> }

export function trackerRegistry(): Map<string, LiveTracker> {
  const scope = globalThis as unknown as Record<string, Map<string, LiveTracker>>
  return (scope.__momotoTrackers__ ??= new Map<string, LiveTracker>())
}

/** Fresh storage, no live trackers, no global stubs. */
export async function resetEnvironment(): Promise<void> {
  const registry = trackerRegistry()
  {
    for (const tracker of [...registry.values()]) await tracker.destroy(false)
    registry.clear()
  }
  localStorage.clear()
  sessionStorage.clear()
  setVisibility('visible')
}

export function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}

export function hide(): void {
  setVisibility('hidden')
  document.dispatchEvent(new Event('visibilitychange'))
}

export function show(): void {
  setVisibility('visible')
  document.dispatchEvent(new Event('visibilitychange'))
}

export const BASE_URL = 'https://e.example.test'

export type TestEvents = {
  shot_taken: { index: number }
  page_view: { route: string; fromRoute: string | null; msOnPrevious: number | null }
  click: { id: string | null; el: string; route: string; to?: string | null }
  payment_succeeded: { amountIdr: number }
  client_error: { source: string }
}

export function makeTracker(overrides: Partial<TrackerConfig<TestEvents>> = {}) {
  return createTracker<TestEvents>({
    event: { source: 'test-app', ...overrides.event },
    network: { baseUrl: BASE_URL, retries: { maxRetries: 0 }, ...overrides.network },
    batch: overrides.batch,
    session: overrides.session,
    consent: overrides.consent,
    context: overrides.context,
    debug: false,
  })
}

export type AnyMap = EventMap
