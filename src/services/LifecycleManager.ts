export interface LifecycleHandlers {
  /** The page is hidden or going away: send what's queued, then go quiet. */
  hidden(): void
  visible(): void
  online(): void
  offline(): void
}

/**
 * Wires the browser's page lifecycle to the tracker.
 *
 * `visibilitychange → hidden` is the last event reliably fired on mobile — tab switch, app
 * switch, the OS killing the tab — so that is where the queue is flushed. `pagehide` is a
 * second chance on desktop. `unload` / `beforeunload` are never used: they break the
 * back/forward cache and don't fire reliably on phones. `pageshow` covers a page restored
 * from that cache, where `visibilitychange` may not fire.
 */
export class LifecycleManager {
  private readonly removers: Array<() => void> = []

  constructor(private readonly handlers: LifecycleHandlers) {}

  start(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    this.listen(document, 'visibilitychange', () =>
      document.visibilityState === 'hidden' ? this.handlers.hidden() : this.handlers.visible()
    )
    this.listen(window, 'pagehide', () => this.handlers.hidden())
    // Only a restore from the back/forward cache: `pageshow` also fires on every normal
    // load, where "visible again" would send the first event at once instead of batching.
    this.listen(window, 'pageshow', (event) => {
      if ((event as PageTransitionEvent).persisted) this.handlers.visible()
    })
    this.listen(window, 'online', () => this.handlers.online())
    this.listen(window, 'offline', () => this.handlers.offline())
  }

  stop(): void {
    while (this.removers.length) this.removers.pop()!()
  }

  private listen(target: EventTarget, type: string, handler: (event: Event) => void): void {
    target.addEventListener(type, handler)
    this.removers.push(() => target.removeEventListener(type, handler))
  }
}
