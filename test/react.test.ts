import { act, createElement, StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Link, Outlet, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { pageViews } from '../src/plugins'
import { TrackerProvider, useTracker } from '../src/react'
import { makeTracker, resetEnvironment, stubNetwork, type TestEvents } from './helpers'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const normalize = (pathname: string) => (pathname.startsWith('/room/') ? '/room/:roomId' : pathname)

beforeEach(async () => {
  await resetEnvironment()
  history.replaceState(null, '', '/')
  document.body.innerHTML = '<div id="root"></div>'
})
afterEach(async () => {
  await resetEnvironment()
})

function Shot() {
  const tracker = useTracker<TestEvents>()
  // From an effect, never render — StrictMode runs this twice on mount in development,
  // which is exactly why momoto-fe tracks from store subscriptions where it can.
  useEffect(() => {
    void tracker.track('shot_taken', { index: 0 })
  }, [tracker])
  return null
}

describe('React Router 7 under StrictMode', () => {
  it('one page_view per navigation', async () => {
    const net = stubNetwork()
    const tracker = makeTracker()
    tracker.use(pageViews({ normalize }))

    const router = createBrowserRouter([
      {
        path: '/',
        element: createElement(Outlet),
        children: [
          { index: true, element: createElement(Link, { to: '/room/AB12', id: 'go' }, 'go') },
          { path: 'room/:roomId', element: createElement(Shot) },
        ],
      },
    ])
    const root = createRoot(document.getElementById('root')!)
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(TrackerProvider, { tracker }, createElement(RouterProvider, { router }))
        )
      )
    })
    await act(async () => {
      ;(document.getElementById('go') as HTMLElement).click()
    })
    await act(async () => {
      void router.navigate('/cart')
    })
    await tracker.flush()

    const views = net.sentEvents
      .filter((e) => e.event_name === 'page_view')
      .map((e) => e.data.route)
    expect(views).toEqual(['/', '/room/:roomId', '/cart'])
    root.unmount()
  })

  it('useTracker outside a provider throws a clear error', () => {
    const root = createRoot(document.getElementById('root')!)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() =>
      act(() => {
        root.render(createElement(Shot))
      })
    ).toThrow(/TrackerProvider/)
    errors.mockRestore()
  })
})
