import type { TrackerPlugin } from '../core/types'

export interface PageViewsOptions {
  /**
   * Maps a pathname to the route **pattern** to record (`/room/AB12` → `/room/:roomId`), or
   * `null` to skip the page. Required on purpose: there is no default that sends raw
   * paths, because raw paths carry ids, codes and tokens.
   */
  normalize: (pathname: string) => string | null
  /** Default `'page_view'`. */
  eventName?: string
}

type HistoryMethod = 'pushState' | 'replaceState'

/**
 * Emits `page_view { route, fromRoute, msOnPrevious }` on load and on every route change.
 *
 * It watches the History API (`pushState` / `replaceState`, patched once) and `popstate`,
 * which covers React Router and any other client-side router. Only `location.pathname` is
 * read — **never the query string or hash** — and consecutive views of the same route are
 * one view (a `replaceState` that only changes the query emits nothing).
 */
export function pageViews(options: PageViewsOptions): TrackerPlugin {
  const eventName = options.eventName ?? 'page_view'
  return {
    name: 'pageViews',
    setup(host) {
      if (typeof window === 'undefined' || typeof history === 'undefined') return () => {}

      let current: string | null = null
      let since = Date.now()

      const check = () => {
        let route: string | null
        try {
          route = options.normalize(window.location.pathname)
        } catch (error) {
          host.log('pageViews: normalize threw', error)
          return
        }
        if (route === null || route === current) return
        const now = Date.now()
        void host.track(eventName, {
          route,
          fromRoute: current,
          msOnPrevious: current === null ? null : now - since,
        })
        current = route
        since = now
      }

      const originals = {} as Record<HistoryMethod, History[HistoryMethod]>
      const patched = {} as Record<HistoryMethod, History[HistoryMethod]>
      for (const method of ['pushState', 'replaceState'] as const) {
        const original = history[method]
        originals[method] = original
        patched[method] = function (this: History, ...args: Parameters<History['pushState']>) {
          const result = original.apply(this, args)
          check()
          return result
        }
        history[method] = patched[method]
      }
      window.addEventListener('popstate', check)
      check()

      return () => {
        window.removeEventListener('popstate', check)
        for (const method of ['pushState', 'replaceState'] as const) {
          // Only unwrap our own patch: if something patched over it since, restoring the
          // original would silently remove theirs.
          if (history[method] === patched[method]) history[method] = originals[method]
        }
      }
    },
  }
}
