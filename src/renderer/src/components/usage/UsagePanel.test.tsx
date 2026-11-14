/**
 * Settings → Usage's Pi page (PRDCT-4551): each connection, the harness's
 * own sign-in, and "Other sessions", the records no Clave tab is known to
 * have made, as a row of its own with one plain sentence, never a sign-in.
 */
import { expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const store = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  }
  const noop = (): void => undefined
  Object.assign(globalThis, {
    localStorage,
    window: { localStorage, addEventListener: noop, removeEventListener: noop, electronAPI: {} },
    document: { addEventListener: noop, removeEventListener: noop, visibilityState: 'visible' }
  })
})

// A server render reads a store's initial state: the page reads the live one.
vi.mock('../../store/harness-usage-store', async (original) => {
  const real = await original<typeof import('../../store/harness-usage-store')>()
  return { ...real, useHarnessUsage: real.harnessUsageFor }
})
vi.mock('../../store/usage-store', async (original) => {
  const real = await original<typeof import('../../store/usage-store')>()
  const nav = { provider: 'pi', select: () => undefined }
  return {
    ...real,
    useUsageNavigation: (select: (s: typeof nav) => unknown) => select(nav)
  }
})

import { renderToStaticMarkup } from 'react-dom/server'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import { OTHER_SESSIONS_WORDS } from '@clave/contract/settings/harness-usage-view'
import { useHarnessUsageStore } from '../../store/harness-usage-store'
import { UsagePanel } from './UsagePanel'

const row = (over: Record<string, unknown>): Record<string, unknown> => ({
  harness: 'pi',
  connectionId: null,
  label: 'x',
  billing: 'signIn',
  removed: false,
  requests: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
  sessions: 0,
  ...over
})

it('lists "Other sessions" as its own row with its sentence, apart from the sign-in', () => {
  useHarnessUsageStore.setState({
    byKey: {
      [`${LOCAL_SERVER_ID}\u0000today`]: {
        status: 'ready',
        readAt: Date.now(),
        view: {
          range: 'today',
          rows: [
            row({ label: 'Pi sign-in', requests: 1, totalTokens: 10 }),
            row({ label: 'Other sessions', other: true, requests: 111, totalTokens: 1_600_000 })
          ],
          unavailable: []
        } as never
      }
    }
  })
  const html = renderToStaticMarkup(<UsagePanel />)
  const other = /<div[^>]*data-harness-usage-row="other"[^>]*>.*?<\/div><\/div>/s.exec(html)?.[0]
  expect(other).toContain('Other sessions')
  expect(other).toContain(OTHER_SESSIONS_WORDS)
  expect(other).toContain('111 requests · 1.6M tokens today')
  expect(other).not.toContain('sign-in')
  const signIn = /<div[^>]*data-harness-usage-row="sign-in"[^>]*>/.exec(html)
  expect(signIn).not.toBeNull()
  expect(OTHER_SESSIONS_WORDS).toBe(
    'Sessions Clave did not start, or that ran before Clave counted usage per connection.'
  )
})
