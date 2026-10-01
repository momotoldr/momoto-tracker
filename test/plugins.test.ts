import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { autocapture, pageViews } from '../src/plugins'
import { makeTracker, resetEnvironment, stubNetwork } from './helpers'

/** Like momoto-fe's route table: ids in the path become parameters. */
const normalize = (pathname: string) =>
  pathname.startsWith('/room/') ? '/room/:roomId' : pathname === '/private' ? null : pathname

beforeEach(async () => {
  await resetEnvironment()
  history.replaceState(null, '', '/')
  vi.useFakeTimers()
})
afterEach(async () => {
  await resetEnvironment()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

async function sent(net: ReturnType<typeof stubNetwork>, name: string) {
  await vi.runAllTimersAsync()
  return net.sentEvents.filter((e) => e.event_name === name).map((e) => e.data)
}

describe('pageViews', () => {
  it('records the initial page and each route change as a pattern', async () => {
    const net = stubNetwork()
    const tracker = makeTracker()
    tracker.use(pageViews({ normalize }))
    vi.advanceTimersByTime(1500)
    history.pushState(null, '', '/room/AB12CD?token=secret#frag')
    history.pushState(null, '', '/cart')

    const views = await sent(net, 'page_view')
    expect(views).toEqual([
      { route: '/', fromRoute: null, msOnPrevious: null },
      { route: '/room/:roomId', fromRoute: '/', msOnPrevious: 1500 },
      { route: '/cart', fromRoute: '/room/:roomId', msOnPrevious: 0 },
    ])
    expect(JSON.stringify(net.requests)).not.toMatch(/AB12CD|secret|frag/)
  })

  it('passes only the pathname to normalize — never the query or hash', () => {
    stubNetwork()
    const seen: string[] = []
    const tracker = makeTracker()
    tracker.use(pageViews({ normalize: (p) => (seen.push(p), p) }))
    history.pushState(null, '', '/reset-password?token=abc#x')
    expect(seen).toEqual(['/', '/reset-password'])
  })

  it('one view per route: a query-only replaceState emits nothing', async () => {
    const net = stubNetwork()
    const tracker = makeTracker()
    tracker.use(pageViews({ normalize }))
    history.replaceState(null, '', '/?mode=date')
    history.pushState(null, '', '/room/A')
    history.pushState(null, '', '/room/B') // same pattern
    expect((await sent(net, 'page_view')).map((v) => v.route)).toEqual(['/', '/room/:roomId'])
  })

  it('follows back/forward (popstate) and skips pages normalize returns null for', async () => {
    const net = stubNetwork()
    const tracker = makeTracker()
    tracker.use(pageViews({ normalize }))
    history.pushState(null, '', '/private')
    history.pushState(null, '', '/cart')
    history.replaceState(null, '', '/gallery')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect((await sent(net, 'page_view')).map((v) => v.route)).toEqual(['/', '/cart', '/gallery'])
  })

  it('teardown restores history, unless something patched over it since', () => {
    stubNetwork()
    const original = history.pushState
    const tracker = makeTracker()
    const remove = tracker.use(pageViews({ normalize }))
    expect(history.pushState).not.toBe(original)
    remove()
    expect(history.pushState).toBe(original)

    const removeAgain = tracker.use(pageViews({ normalize }))
    const theirs = function (this: History, ...args: Parameters<History['pushState']>) {
      return original.apply(this, args)
    }
    history.pushState = theirs
    removeAgain()
    expect(history.pushState).toBe(theirs)
    history.pushState = original
  })
})

describe('autocapture', () => {
  function click(html: string, selector: string) {
    document.body.innerHTML = html
    ;(document.querySelector(selector) as HTMLElement).click()
  }

  it('records data-track ids, and untracked clicks as null', async () => {
    const net = stubNetwork()
    history.replaceState(null, '', '/room/XYZ')
    makeTracker().use(autocapture({ normalize }))
    click('<button data-track="booth.start_session"><span id="in">Start</span></button>', '#in')
    click('<div role="button" id="r">Hi</div>', '#r')
    click('<div id="plain">not a control</div>', '#plain')

    expect(await sent(net, 'click')).toEqual([
      { id: 'booth.start_session', el: 'button', route: '/room/:roomId' },
      { id: null, el: 'role', route: '/room/:roomId' },
    ])
  })

  it('never records what the user can see or type', async () => {
    const net = stubNetwork()
    makeTracker().use(autocapture({ normalize }))
    click(
      '<button id="b" aria-label="dina@example.com" title="Dina Putri" value="INV-4821">Signed in as dina@example.com</button>',
      '#b'
    )
    await vi.runAllTimersAsync()
    expect(JSON.stringify(net.requests)).not.toMatch(/dina|Dina|INV-4821/)
  })

  it('records link targets as routes, external hosts or schemes', async () => {
    const net = stubNetwork()
    makeTracker().use(autocapture({ normalize }))
    click('<a id="a" href="/room/QQQ?x=1">Join</a>', '#a')
    click('<a id="b" href="https://instagram.com/momoto/abc">IG</a>', '#b')
    click('<a id="c" href="mailto:help@momoto.test">Mail</a>', '#c')
    const clicks = await sent(net, 'click')
    expect(clicks.map((c) => c.to)).toEqual([
      '/room/:roomId',
      'external:instagram.com',
      'external:mailto',
    ])
  })

  it('teardown removes the listener', async () => {
    const net = stubNetwork()
    const remove = makeTracker().use(autocapture({ normalize }))
    remove()
    click('<button id="b">x</button>', '#b')
    expect(await sent(net, 'click')).toEqual([])
  })
})
