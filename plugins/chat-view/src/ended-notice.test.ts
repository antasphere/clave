import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { resourceKey } from '@clave/contract/fleet'
import type { Session } from '../../../src/renderer/src/store/session-types'

/** The ended notice of a tab at its limit with no way on offered (PRDCT-4328):
 *  this Mac's policy never proposes for a server tab, so a server tab reading
 *  "add one in Settings → Accounts" would send the reader to this Mac's
 *  accounts while the server's others sit on the tab's account chip. */
const state = vi.hoisted(() => ({ sessions: [] as Partial<Session>[] }))
// The plugin's `.tsx` compiles to the classic runtime under vitest (only the
// renderer's tsconfig sets `react-jsx`), and ChatView's imports draw at load.
await vi.hoisted(async () => {
  ;(globalThis as Record<string, unknown>).React = await import('react')
})
vi.mock('../../../src/renderer/src/store/session-store', () => ({
  useSessionStore: Object.assign(() => null, {
    getState: () => ({ sessions: [] }),
    subscribe: () => () => {}
  })
}))
vi.mock('../../../src/renderer/src/views/session-store', () => ({
  useViewSessionStore: (select: (s: { sessions: Partial<Session>[] }) => unknown) =>
    select({ sessions: state.sessions })
}))
vi.mock('./limit-words', () => ({
  useLimitSentence: () => 'Work is out on Fable, back in 2d 5h.'
}))
import { EndedNotice } from './ChatView'

const text = (sessionId: string): string =>
  renderToStaticMarkup(createElement(EndedNotice, { sessionId })).replace(/<[^>]+>/g, '')
const atLimit = (id: string): Partial<Session> => ({
  id,
  alive: false,
  limitReported: { scope: { family: 'Fable' } },
  accountProposal: null
})

beforeEach(() => {
  state.sessions = []
})

describe('EndedNotice at a limit with no rung', () => {
  it("points a server tab to its account chip, never to this Mac's Settings", () => {
    const id = resourceKey('session', 'studio', 'tab-1')
    state.sessions = [atLimit(id)]
    const words = text(id)
    expect(words).toBe(
      'Work is out on Fable, back in 2d 5h. Pick another account of this server from the account chip to continue.'
    )
    expect(words).not.toContain('Settings → Accounts')
  })
  it("keeps this Mac's tab on Settings → Accounts", () => {
    state.sessions = [atLimit('tab-1')]
    expect(text('tab-1')).toBe(
      'Work is out on Fable, back in 2d 5h. No other account has headroom: add one in Settings → Accounts to continue.'
    )
  })
})
