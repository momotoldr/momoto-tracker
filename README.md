# @momotoldr/tracker

Event tracking for Momoto: page views, clicks and product events, sent in batches (or one
at a time when it matters) to our own ingest service. No dependencies, ESM only, ~6.5 KB
gzipped.

It is built for a page that is busy doing something else — in Momoto's case, live video on
a phone:

- **Nothing runs while idle.** A timer exists only while events are waiting to be sent.
- **Nothing is lost on close.** When the page is hidden or closed, what's queued goes out as
  `sendBeacon` requests, which the browser delivers even after the page is gone.
- **Nothing blocks.** `track()` never throws and never waits on the network.
- **Nothing personal by accident.** Event props are scalars only; the click plugin never
  reads text, labels or values; page views record route patterns, never raw URLs.

## Install

From a tag of this repo (there is no registry release):

```jsonc
// package.json
"@momotoldr/tracker": "git+https://github.com/momotoldr/momoto-tracker.git#v0.1.0"
```

Use the `git+https` form. The `github:` shorthand can be recorded as an SSH URL in
`package-lock.json`, which fails in CI where there is no SSH key. The package builds itself
on install (`prepare`).

## Use

```ts
import { createTracker } from '@momotoldr/tracker'
import { autocapture, pageViews } from '@momotoldr/tracker/plugins'

// Your taxonomy — a `type`, not an `interface`.
type AppEvents = {
  page_view: { route: string; fromRoute: string | null; msOnPrevious: number | null }
  click: { id: string | null; el: string; route: string; to?: string | null }
  shot_taken: { index: number }
}

// Once, at module scope — not inside a component.
export const tracker = createTracker<AppEvents>({
  event: { source: 'momoto-fe' },
  network: { baseUrl: 'https://e.momotoldr.com' },
  batch: { storage: { queue: { persistToSession: true } } },
  consent: { enabled: true, optOutKey: 'momoto.analytics.optout', sampleRate: 1 },
  context: () => ({ appVersion: '808bd75' }),
  debug: import.meta.env.DEV,
})

const normalize = (pathname: string) => matchRoutePattern(pathname) // '/room/AB12' → '/room/:roomId'
tracker.use(pageViews({ normalize }))
tracker.use(autocapture({ normalize }))

tracker.track('shot_taken', { index: 2 })
```

Name a control for click tracking with `data-track`:

```tsx
<Button data-track="booth.start_session">Start</Button>
```

Clicks on controls without one are recorded too, with `id: null`, so the gaps show up in the
data.

### React

```tsx
import { TrackerProvider, useTracker } from '@momotoldr/tracker/react'

;<TrackerProvider tracker={tracker}>
  <App />
</TrackerProvider>

const tracker = useTracker<AppEvents>() // call track() from effects and handlers, never render
```

### Identity

Every batch carries two anonymous random ids: `anon_id` (the browser, in localStorage) and
`session_id` (a visit, in sessionStorage, renewed after 30 idle minutes). The tracker never
knows who the user is. To link a visit to an account, call your own authenticated endpoint:

```ts
tracker.onIdentity(({ anonId }) => {
  if (signedIn) linkToAccount(anonId) // called now, and again whenever the ids change
})
tracker.resetIdentity() // on sign-out, so the next person on the device starts fresh
```

### Consent

`createTracker` returns a no-op tracker (same interface, does nothing — no listeners, no
timers, no requests) when `consent.enabled` is false, the browser sends Do Not Track or
Global Privacy Control, the user opted out, or this visit is sampled out.
`tracker.setOptOut(true)` stops tracking immediately and forgets the ids.

### Options

| option                                 | default                                              |                                                                                |
| -------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `event.mode`                           | `'BATCHED'`                                          | or `'REAL_TIME'`; per event via `event.classification` or `track(…, { mode })` |
| `network.endpoints`                    | `{ single: '/v1/e', batch: '/v1/b' }`                |                                                                                |
| `network.timeout`                      | `5000`                                               | ms                                                                             |
| `network.retries`                      | `{ maxRetries: 2, baseDelay: 1000, maxDelay: 8000 }` | exponential backoff with full jitter; 5xx, 408, 429 and network errors only    |
| `batch.maxBatchSize`                   | `20`                                                 |                                                                                |
| `batch.maxWaitTime`                    | `10000`                                              | ms a lone event waits for company                                              |
| `batch.flushingTimeout`                | `3000`                                               | ms `flush()` / `destroy()` may take                                            |
| `batch.storage.queue.maxQueueSize`     | `1000`                                               | events; the oldest are dropped first, and counted                              |
| `batch.storage.queue.maxMemorySize`    | `2`                                                  | MB                                                                             |
| `batch.storage.queue.persistToSession` | `false`                                              | survive a reload                                                               |
| `session.idleTimeoutMs`                | `1800000`                                            | 30 minutes                                                                     |
| `consent.respectDnt`                   | `true`                                               |                                                                                |
| `consent.sampleRate`                   | `1`                                                  | share of visits tracked                                                        |

## What is sent

`POST {baseUrl}/v1/b` with a `text/plain` JSON body (CORS-simple: no preflight, same as a
beacon), no credentials, no auth header:

```jsonc
{
  "request_id": "…",
  "source": "momoto-fe",
  "sdk": { "name": "momoto-tracker", "version": "0.1.0" },
  "anon_id": "…",
  "session_id": "…",
  "context": { "viewport": "390x844", "language": "id-ID", "connection": "4g", "appVersion": "…" },
  "sent_at": 1757300001234,
  "dropped": 0,
  "events": [
    {
      "event_id": "0192f1c4-…",
      "event_name": "shot_taken",
      "event_type": null,
      "timestamp": 1757300000000,
      "data": { "index": 2 },
    },
  ],
}
```

`event_id` is a UUIDv7 (time-ordered). Delivery is at-least-once — retries, the reload
backup and the close-time beacon can repeat an event — so **the server must dedupe on
`event_id`**. `dropped` counts events evicted from a full queue since the last batch. Any 2xx
is success; the body is never read.

## Develop

```bash
npm install
npm test          # vitest + happy-dom
npm run typecheck
npm run lint
npm run size      # size budgets, gzipped
```

Release: update `CHANGELOG.md` and the `version` in `package.json`, then tag `vX.Y.Z` on
`main`. A tag is the release.
