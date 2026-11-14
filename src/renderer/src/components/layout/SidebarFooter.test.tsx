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
  /** Pi's local totals of the day, when a test sets them. */
  const pi = { data: null as null | { totalTokens: number; cost: number } }
  return { modelChanged, windows, pi }
})

vi.mock('../../store/usage-store', async (original) => {
  const real = await original<typeof import('../../store/usage-store')>()
  const read = { status: 'ready', data: { windows: g.windows }, error: null, load: async () => {} }
  return {
    ...real,
    claudeUsageStore: () => () => read,
    codexUsageStore: () => () => read,
    piUsageStores: {
      today: () => ({
        status: g.pi.data ? 'ready' : 'idle',
        data: g.pi.data,
        load: async () => {}
      })
    }
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

it('an OpenCode tab’s connection line is a control like the usage lines, not plain text (PRDCT-4427)', () => {
  useSessionStore.setState({
    sessions: [
      {
        id: 'oc',
        cwd: '/repo',
        sessionType: 'local',
        claudeMode: false,
        opencodeMode: true,
        connectionId: 'conn-ds',
        connectionLabel: 'DeepSeek'
      } as never
    ],
    focusedSessionId: 'oc'
  })
  const html = renderToStaticMarkup(<SidebarFooter />)
  const line = /<(\w+)[^>]*data-connection-line="conn-ds"[^>]*>/.exec(html)
  // A button (keyboard reach, a click that opens Settings on Connections),
  // with the class the foot's other lines carry.
  expect(line?.[1]).toBe('button')
  expect(line?.[0]).toContain('class="sidebar-footer-line"')
  expect(line?.[0]).toContain('title="OpenCode · Connection: DeepSeek"')
  expect(html).toContain('>OpenCode · DeepSeek</span></button>')
})

// T1 of the tester's fourth pass: a Pi tab on a connection read
// `Moonshot · 10.4K tokens · $0.01 today` and opened Usage › Pi. Pi's figures
// are its local totals of the day on any connection or none: the connection
// and the usage are two lines and two controls.
it('a Pi tab on a connection: its connection line as an OpenCode tab’s, and Pi’s usage line as it was', () => {
  g.pi.data = { totalTokens: 10_400, cost: 0.01 }
  try {
    useSessionStore.setState({
      sessions: [
        {
          id: 'pi',
          cwd: '/repo',
          sessionType: 'local',
          claudeMode: false,
          piMode: true,
          connectionId: 'conn-moon',
          connectionLabel: 'Moonshot'
        } as never
      ],
      focusedSessionId: 'pi'
    })
    const html = renderToStaticMarkup(<SidebarFooter />)
    const line = /<(\w+)[^>]*data-connection-line="conn-moon"[^>]*>/.exec(html)
    expect(line?.[1]).toBe('button')
    expect(line?.[0]).toContain('class="sidebar-footer-line"')
    expect(line?.[0]).toContain('title="Pi · Connection: Moonshot"')
    expect(html).toContain('>Pi · Moonshot</span></button>')
    // The usage line: its own text and title, the connection nowhere in it.
    const usage = /<button[^>]*data-usage-provider="pi"[^>]*>.*?<\/button>/.exec(html)?.[0]
    expect(usage).toBeDefined()
    expect(usage).toContain(
      'title="Pi · 10.4K tokens · $0.01 today · Local totals, not account quota"'
    )
    expect(usage).not.toContain('Moonshot')
    // The connection line is not the usage line (two controls).
    expect(line?.[0]).not.toContain('data-usage-provider')
  } finally {
    g.pi.data = null
  }
})
