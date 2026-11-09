/**
 * The message trail reads a tab's conversation where it lives (PRDCT-4207): a
 * Claude tab on its own account directory under that directory, a Pi tab by its
 * Pi id. The render runs the trail's first read (effects run at render here), so
 * a call site that drops a field goes red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const state = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))

vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    // The first read is an effect: run it during the render.
    useEffect: (effect: () => void | (() => void)) => {
      effect()
    }
  }
})
vi.mock('../../store/session-store', () => ({
  useSessionStore: Object.assign(
    (select: (s: Record<string, unknown>) => unknown) => select(state.current),
    { getState: () => state.current }
  )
}))
vi.mock('../../lib/terminal-scroll', () => ({
  messageNeedle: () => '',
  scrollXtermToText: () => false
}))

import { MessageTrail } from './MessageTrail'

const g = globalThis as unknown as Record<string, unknown>
let historyConversation: ReturnType<typeof vi.fn>

function withTab(tab: Record<string, unknown>): void {
  state.current = {
    messageTrailEnabled: true,
    selectedSessionIds: [tab.id],
    sessions: [tab]
  }
}

beforeEach(() => {
  historyConversation = vi.fn(async () => ({ exists: true, turns: [] }))
  g.window = { electronAPI: { historyConversation } }
})

describe('the message trail reads the conversation where the tab keeps it', () => {
  it("reads a Claude tab's conversation under its own account directory", () => {
    withTab({
      id: 'tab-1',
      cwd: '/work',
      claudeMode: true,
      claudeSessionId: 'conv-1',
      claudeConfigDir: '/accounts/second'
    })
    renderToStaticMarkup(<MessageTrail sessionId="tab-1" />)
    expect(historyConversation).toHaveBeenCalled()
    for (const call of historyConversation.mock.calls)
      expect(call).toEqual(['/work', 'conv-1', 'claude', '/accounts/second'])
  })

  it('reads a Claude tab on the shared home with no directory', () => {
    withTab({ id: 'tab-2', cwd: '/work', claudeMode: true, claudeSessionId: 'conv-2' })
    renderToStaticMarkup(<MessageTrail sessionId="tab-2" />)
    expect(historyConversation.mock.calls[0]).toEqual(['/work', 'conv-2', 'claude', undefined])
  })

  it('reads a Pi tab by its Pi id, as Pi, never under a Claude directory', () => {
    withTab({
      id: 'tab-3',
      cwd: '/work',
      piMode: true,
      piSessionId: 'pi-3',
      claudeConfigDir: '/accounts/second'
    })
    renderToStaticMarkup(<MessageTrail sessionId="tab-3" />)
    expect(historyConversation.mock.calls[0]).toEqual(['/work', 'pi-3', 'pi', undefined])
  })
})
