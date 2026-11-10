/**
 * Every reader that draws a server tab's account loads it itself
 * (PRDCT-4328): the chip, the tab menu's header and the row's limit badge
 * each read the server's settings as they draw, whatever else did or did not
 * (the launcher reads only the servers it shows). Drawn here with no load
 * anywhere else; each test goes red when its component stops asking.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { resourceKey } from '@clave/contract/fleet'
import type { Session } from '../store/session-types'

// The chat view's files are compiled with the classic JSX runtime, and the
// row imports some of them: React is in scope before any import.
await vi.hoisted(async () => {
  Object.assign(globalThis, { React: await import('react') })
})
const held = vi.hoisted(() => ({ host: null as Session | null }))
vi.mock('../views/session-store', () => ({
  useViewSessionStore: (select: (s: { sessions: Session[] }) => unknown) =>
    select({ sessions: held.host ? [held.host] : [] })
}))
vi.mock('../store/session-store', () => ({
  useSessionStore: Object.assign(
    (select: (s: { sessions: Session[] }) => unknown) =>
      select({ sessions: held.host ? [held.host] : [] }),
    { getState: () => ({ sessions: held.host ? [held.host] : [] }) }
  )
}))
import { useServerSettingsStore } from '../store/server-settings-state'
import { resetAccountKicks } from './session-accounts'
import { AccountMenuHeader } from '../components/layout/AccountMenuHeader'
import { AccountLimitBadge } from '../components/session/SessionItem'

const SERVER = 'srv-mount'
const tab = (): Session =>
  ({
    id: resourceKey('session', SERVER, 'tab-1'),
    sessionType: 'local',
    claudeMode: true,
    alive: true,
    claudeProfileId: 'srv-one',
    claudeProfileLabel: 'Work'
  }) as Session

let fleetAccounts: ReturnType<typeof vi.fn>
beforeEach(() => {
  resetAccountKicks()
  useServerSettingsStore.setState({ byServer: {} })
  fleetAccounts = vi.fn(async () => ({ claude: [], codex: [], migrated: [] }))
  vi.stubGlobal('window', {
    electronAPI: {
      fleetAccounts,
      fleetLaunchSettings: vi.fn(async () => ({ profiles: null })),
      fleetUsageSnapshot: vi.fn(async () => ({})),
      fleetUsage: vi.fn(async () => ({ error: 'x' }))
    }
  })
  held.host = tab()
})
afterEach(() => {
  vi.unstubAllGlobals()
  held.host = null
})

const loadsTheServer = async (): Promise<void> => {
  await vi.waitFor(() => expect(fleetAccounts).toHaveBeenCalledWith(SERVER), { timeout: 2000 })
}

describe('a server tab’s account is read by whatever draws it', () => {
  it('the tab menu header', async () => {
    renderToStaticMarkup(<AccountMenuHeader session={tab()} />)
    await loadsTheServer()
  })

  it('the chat chip', async () => {
    const { AccountChip } = await import('../../../../plugins/chat-view/src/AccountChip')
    renderToStaticMarkup(<AccountChip sessionId={tab().id} />)
    await loadsTheServer()
  })

  it('the row’s limit badge', async () => {
    renderToStaticMarkup(<AccountLimitBadge session={tab()} />)
    await loadsTheServer()
  })

  it('a tab on this Mac asks no server', async () => {
    held.host = { ...tab(), id: 'local-1' }
    renderToStaticMarkup(<AccountMenuHeader session={held.host} />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fleetAccounts).not.toHaveBeenCalled()
  })
})
