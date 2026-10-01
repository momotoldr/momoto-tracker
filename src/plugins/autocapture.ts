import type { TrackerPlugin } from '../core/types'

export interface AutocaptureOptions {
  /** Same normaliser as `pageViews` — the click's page, and a link's target, are recorded
   *  as route patterns. */
  normalize: (pathname: string) => string | null
  /** What counts as clickable. Default `'button, a, [role=button], [data-track]'`. */
  selector?: string
  /** The attribute that names a control. Default `'data-track'`. */
  attr?: string
  /** Default `'click'`. */
  eventName?: string
}

function kind(el: Element): string {
  const tag = el.tagName.toLowerCase()
  if (tag === 'button' || tag === 'a') return tag
  return el.getAttribute('role') === 'button' ? 'role' : 'other'
}

/**
 * Emits `click { id, el, route, to? }` for every click on a control, through one passive,
 * capture-phase listener on `document`.
 *
 * - `id` is the control's own `data-track` value, or `null` when it has none. Untracked
 *   clicks are recorded too, so the gaps in tagging are visible in the data.
 * - **Nothing the user can see or type is read**: no text content, no `value`, no
 *   `aria-label`, no `title`. Labels can hold names, emails or codes, and they change with
 *   the locale anyway.
 * - `to` (links only) is the normalised route for same-origin links, else
 *   `external:<host>` (or `external:<scheme>` for `mailto:` and the like).
 */
export function autocapture(options: AutocaptureOptions): TrackerPlugin {
  const selector = options.selector ?? 'button, a, [role=button], [data-track]'
  const attr = options.attr ?? 'data-track'
  const eventName = options.eventName ?? 'click'

  return {
    name: 'autocapture',
    setup(host) {
      if (typeof document === 'undefined') return () => {}

      const route = (pathname: string): string | null => {
        try {
          return options.normalize(pathname)
        } catch {
          return null
        }
      }

      const onClick = (event: Event) => {
        const target = event.target
        if (!(target instanceof Element)) return
        const el = target.closest(selector)
        if (!el) return
        const page = route(window.location.pathname)
        if (page === null) return

        const data: Record<string, string | null> = {
          id: el.getAttribute(attr) || null,
          el: kind(el),
          route: page,
        }
        const href = el.tagName.toLowerCase() === 'a' ? el.getAttribute('href') : null
        if (href !== null) {
          try {
            const url = new URL(href, window.location.href)
            if (url.origin === window.location.origin) data.to = route(url.pathname)
            else if (url.host) data.to = `external:${url.host}`
            else data.to = `external:${url.protocol.replace(':', '')}`
          } catch {
            // An unparsable href just goes without `to`.
          }
        }
        void host.track(eventName, data)
      }

      document.addEventListener('click', onClick, { capture: true, passive: true })
      return () => document.removeEventListener('click', onClick, { capture: true })
    },
  }
}
