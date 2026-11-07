import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  hasServerEventPublisher,
  publishOrSend,
  sessionCleared,
  sessionPlanDetected,
  sessionTitleChanged,
  setServerEventPublisher
} from './session-events'
import {
  inMemorySessionWindows,
  installSessionWindows,
  type SessionWindowsPort
} from '../sessions/windows'

/** A windows port that records what the per-window arm sends, by key. */
const windows = (): { port: SessionWindowsPort; sent: unknown[][] } => {
  const sent: unknown[][] = []
  const port: SessionWindowsPort = {
    ...inMemorySessionWindows(),
    send: (windowKey, channel, ...args) => {
      if (windowKey === 'w1') sent.push([channel, ...args])
    }
  }
  installSessionWindows(port)
  return { port, sent }
}

afterEach(() => {
  setServerEventPublisher(null)
  installSessionWindows(null)
})

describe('a session’s news travels on one transport, never both', () => {
  it('goes to the window over IPC while no server runs', () => {
    const { sent } = windows()
    expect(hasServerEventPublisher()).toBe(false)
    sessionTitleChanged('s1', 'fix auth', 'w1')
    sessionPlanDetected('s1', '/tmp/plan.md', 'w1')
    sessionCleared('s1', 'rotated', 'w1')
    expect(sent).toEqual([
      ['session:auto-title:s1', 'fix auth'],
      ['session:plan-detected:s1', '/tmp/plan.md'],
      ['session:clear-detected:s1', 'rotated']
    ])
  })
  it('goes to the server as the right event, and not to the window, once a publisher is set', async () => {
    const { sent } = windows()
    const published: unknown[] = []
    setServerEventPublisher(async (event) => {
      published.push(event)
    })
    expect(hasServerEventPublisher()).toBe(true)
    sessionTitleChanged('s1', 'fix auth', 'w1')
    sessionPlanDetected('s1', '/tmp/plan.md', 'w1')
    sessionCleared('s1', null, 'w1')
    await Promise.resolve()
    expect(published).toEqual([
      { _tag: 'session.title_changed', id: 's1', title: 'fix auth' },
      { _tag: 'session.plan_detected', id: 's1', path: '/tmp/plan.md' },
      { _tag: 'session.cleared', id: 's1', providerSessionId: null }
    ])
    expect(sent).toEqual([])
  })
  it('a publisher that fails is logged, and the window is still not sent to', async () => {
    const { sent } = windows()
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    setServerEventPublisher(async () => {
      throw new Error('socket gone')
    })
    publishOrSend({ _tag: 'session.title_changed', id: 's1', title: 't' }, () =>
      sent.push(['legacy'])
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sent).toEqual([])
    expect(quiet).toHaveBeenCalledWith(
      expect.stringContaining('session.title_changed not published'),
      expect.any(Error)
    )
    quiet.mockRestore()
  })
  it('a key naming no window, or no key at all, is not sent to', () => {
    const { sent } = windows()
    sessionTitleChanged('s1', 'fix auth', 'gone')
    sessionTitleChanged('s1', 'fix auth', null)
    expect(sent).toEqual([])
  })
  it('with no port installed nothing is sent and nothing throws', () => {
    installSessionWindows(null)
    expect(() => sessionTitleChanged('s1', 'fix auth', 'w1')).not.toThrow()
  })
})
