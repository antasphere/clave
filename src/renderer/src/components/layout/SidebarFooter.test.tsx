/**
 * The sidebar foot follows a model switch made from the chip (seam A/B,
 * PRDCT-4255 over PRDCT-4256): main pushes the model the CLI applied, the
 * served-events listener writes it on the session in the store, and the foot
 * reads the caps for THAT model. A foot that read no model (or the one the
 * tab was opened on) keeps showing the shared week after a switch to Fable,
 * whose cap is out: the reader is told there is room while the chat stops.
 *
 * The real session store (read live, see the mock), the real listener and the real readout functions;
 * only the account's read is canned, and the bridge is a fake that lets the
 * test push the change as main does.
 */
import { beforeEach, expect, it, vi } from 'vitest'

const g = vi.hoisted(() => {
  const store = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size
    }
  }
  const modelChanged: ((p: { id: string; model: string }) => void)[] = []
  const window = {
    localStorage,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    electronAPI: {
      onSessionModelChanged: (cb: (p: { id: string; model: string }) => void) => {
        modelChanged.push(cb)
        return () => undefined
      }
    } as Record<string, unknown>
  }
  const document = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    visibilityState: 'visible'
  }
  Object.assign(globalThis, { localStorage, window, document })
  const week = Date.now() + 3 * 86_400_000
  const windows = [
    {
      key: 'weekly_all',
      label: 'Weekly · all models',
      kind: 'weekly_all',
      scope: null,
      usedPercentage: 38,
      resetsAt: week,
      severity: 'normal'
    },
    {
      key: 'weekly_scoped:Fable',
      label: 'Weekly · Fable',
      kind: 'weekly_scoped',
      scope: 'Fable',
      usedPercentage: 100,
      resetsAt: week,
      severity: 'critical'
    }
  ]
  return { modelChanged, windows }
})

vi.mock('../../store/usage-store', async (original) => {
  const real = await original<typeof import('../../store/usage-store')>()
  const read = { status: 'ready', data: { windows: g.windows }, error: null, load: async () => {} }
  return {
    ...real,
    claudeUsageStore: () => () => read,
    codexUsageStore: () => () => read,
    piUsageStores: { today: () => ({ status: 'idle', data: null, load: async () => {} }) }
  }
})
// A server render reads a zustand store's INITIAL state (its server
// snapshot), so the hook reads the live one instead; getState and setState
// stay the real store's, which the listener writes through.
vi.mock('../../store/session-store', async (original) => {
  const real = await original<typeof import('../../store/session-store')>()
  const live = Object.assign(
    (select: (s: ReturnType<typeof real.useSessionStore.getState>) => unknown) =>
      select(real.useSessionStore.getState()),
    real.useSessionStore
  )
  return { ...real, useSessionStore: live }
})
vi.mock('../../lib/switch-account', () => ({
  accountForLaunch: () => ({ id: 'default', label: 'Default' })
}))

import { renderToStaticMarkup } from 'react-dom/server'
import { useSessionStore } from '../../store/session-store'
import { initServedToolsEvents } from '../../lib/served-events'
import { SidebarFooter } from './SidebarFooter'

const capShown = (): string | null =>
  /data-usage-cap="([^"]*)"/.exec(renderToStaticMarkup(<SidebarFooter />))?.[1] ?? null

beforeEach(() => {
  useSessionStore.setState({
    sessions: [
      {
        id: 'tab',
        cwd: '/repo',
        sessionType: 'local',
        claudeMode: true,
        claudeProfileId: 'default',
        model: 'claude-opus-5-5'
      } as never
    ],
    focusedSessionId: 'tab'
  })
})

it('the foot follows the model main pushes after a chip switch', () => {
  initServedToolsEvents()
  // On Opus: the Fable cap is not this tab's; the shared week governs.
  expect(capShown()).toBe('Overall')
  // The person picks Fable from the chip; the CLI applies it; main pushes it.
  for (const cb of g.modelChanged) cb({ id: 'tab', model: 'claude-fable-5-1' })
  expect(useSessionStore.getState().sessions[0].model).toBe('claude-fable-5-1')
  expect(capShown()).toBe('Fable')
  // And back: the foot leaves the Fable cap when the tab leaves Fable.
  for (const cb of g.modelChanged) cb({ id: 'tab', model: 'claude-opus-5-5' })
  expect(capShown()).toBe('Overall')
})
