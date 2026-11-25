/** Settings → Usage's Antigravity page: the CLI's windows, charted by group of models. */
import { expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const noop = (): void => undefined
  const localStorage = {
    getItem: () => null,
    setItem: noop,
    removeItem: noop,
    clear: noop,
    key: () => null,
    length: 0
  }
  Object.assign(globalThis, {
    localStorage,
    window: { localStorage, addEventListener: noop, removeEventListener: noop, electronAPI: {} },
    document: { addEventListener: noop, removeEventListener: noop, visibilityState: 'visible' }
  })
})
const read = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('../../store/usage-store', async (original) => {
  const real = await original<typeof import('../../store/usage-store')>()
  const nav = { provider: 'antigravity', select: () => undefined }
  return {
    ...real,
    useUsageNavigation: (select: (s: typeof nav) => unknown) => select(nav),
    useAntigravityUsageStore: () => read.state
  }
})

import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@clave/ui/components'
import { UsagePanel } from './UsagePanel'

const render = (): string =>
  renderToStaticMarkup(
    <TooltipProvider>
      <UsagePanel />
    </TooltipProvider>
  )

const window_ = (key: string, scope: string, kind: string): Record<string, unknown> => ({
  key,
  scope,
  kind,
  label: key,
  usedPercentage: 25,
  resetsAt: null,
  severity: null
})

it('charts the weekly and the five-hour window of each group', () => {
  read.state = {
    status: 'ready',
    error: null,
    load: async () => {},
    data: {
      fetchedAt: Date.now(),
      windows: [
        window_('gemini-weekly', 'Gemini', 'weekly_scoped'),
        window_('3p-5h', 'Claude/GPT', 'session')
      ]
    }
  }
  const html = render()
  expect(html).toContain('data-usage-chart="weekly"')
  expect(html).toContain('data-usage-chart="session"')
  expect(html).toContain('Gemini')
  expect(html).toContain('Claude/GPT')
  expect(html).not.toContain('available yet')
})

it('says why a read failed', () => {
  read.state = {
    status: 'error',
    error: 'Sign in to Antigravity',
    load: async () => {},
    data: null
  }
  expect(render()).toContain('Sign in to Antigravity')
})
