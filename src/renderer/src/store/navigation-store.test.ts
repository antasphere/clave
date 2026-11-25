import { afterEach, beforeEach, expect, it, vi } from 'vitest'
// The stores read localStorage and the preload bridge when they load.
vi.hoisted(() => {
  const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  Object.assign(globalThis, { localStorage, window: { localStorage, electronAPI: {} } })
})
// The workspace switch (and the account and usage stores it loads, which listen on the
// window as they load) is never reached here: no place is restored.
vi.mock('../lib/workspace-actions', () => ({ setActiveWorkspace: vi.fn() }))
import { useSessionStore } from './session-store'
import { useWorkspaceStore } from './workspace-store'
import type { Session } from './session-types'
import { initNavigationHistory, SETTLE_MS, useNavigationStore } from './navigation-store'

/**
 * The recorder's start and stop (PRDCT-5155). React's StrictMode, in development, runs the
 * app shell's effect twice: start, stop, start. The second start must record the place on
 * screen as the first would have.
 */

beforeEach(() => {
  vi.useFakeTimers()
  useWorkspaceStore.setState({
    workspaces: [
      { id: 'ws-a', name: 'Alpha', rootDir: '/work/a', profileFile: null, createdAt: 1 }
    ],
    activeWorkspaceId: 'ws-a'
  })
  useSessionStore.setState({
    sessions: [{ id: 'tab-1', name: 'Tab one', workspaceId: 'ws-a' } as Session],
    fileTabs: [],
    groups: [],
    selectedSessionIds: ['tab-1'],
    focusedSessionId: 'tab-1',
    activeView: 'terminals',
    activeGroupViewId: null,
    activeSessionViewId: null
  })
})

afterEach(() => {
  vi.useRealTimers()
})

it('records the place on screen when started again after a stop, as StrictMode does', () => {
  const stop = initNavigationHistory()
  stop()
  const stopAgain = initNavigationHistory()
  vi.advanceTimersByTime(SETTLE_MS)
  const { history } = useNavigationStore.getState()
  expect(history.entries.map((p) => p.tabs)).toEqual([['tab-1']])
  expect(history.index).toBe(0)
  stopAgain()
})
