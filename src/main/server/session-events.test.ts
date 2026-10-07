import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import {
  hasServerEventPublisher,
  publishOrSend,
  sessionCleared,
  sessionPlanDetected,
  sessionTitleChanged,
  setServerEventPublisher
} from './session-events'

/** A window double that records what main sends it. */
const aWindow = (): { win: BrowserWindow; sent: unknown[][] } => {
  const sent: unknown[][] = []
  const win = {
    isDestroyed: () => false,
    webContents: { send: (...args: unknown[]) => sent.push(args) }
  } as unknown as BrowserWindow
  return { win, sent }
}

afterEach(() => setServerEventPublisher(null))

describe('a session’s news travels on one transport, never both', () => {
  it('goes to the window over IPC while no server runs', () => {
    const { win, sent } = aWindow()
    expect(hasServerEventPublisher()).toBe(false)
    sessionTitleChanged('s1', 'fix auth', win)
    sessionPlanDetected('s1', '/tmp/plan.md', win)
    sessionCleared('s1', 'rotated', win)
    expect(sent).toEqual([
      ['session:auto-title:s1', 'fix auth'],
      ['session:plan-detected:s1', '/tmp/plan.md'],
      ['session:clear-detected:s1', 'rotated']
    ])
  })
  it('goes to the server as the right event, and not to the window, once a publisher is set', async () => {
    const { win, sent } = aWindow()
    const published: unknown[] = []
    setServerEventPublisher(async (event) => {
      published.push(event)
    })
    expect(hasServerEventPublisher()).toBe(true)
    sessionTitleChanged('s1', 'fix auth', win)
    sessionPlanDetected('s1', '/tmp/plan.md', win)
    sessionCleared('s1', null, win)
    await Promise.resolve()
    expect(published).toEqual([
      { _tag: 'session.title_changed', id: 's1', title: 'fix auth' },
      { _tag: 'session.plan_detected', id: 's1', path: '/tmp/plan.md' },
      { _tag: 'session.cleared', id: 's1', providerSessionId: null }
    ])
    expect(sent).toEqual([])
  })
  it('a publisher that fails is logged, and the window is still not sent to', async () => {
    const { win, sent } = aWindow()
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    setServerEventPublisher(async () => {
      throw new Error('socket gone')
    })
    publishOrSend({ _tag: 'session.title_changed', id: 's1', title: 't' }, () =>
      win.webContents.send('legacy')
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sent).toEqual([])
    expect(quiet).toHaveBeenCalledWith(
      expect.stringContaining('session.title_changed not published'),
      expect.any(Error)
    )
    quiet.mockRestore()
  })
  it('a destroyed window is not sent to', () => {
    const sent: unknown[][] = []
    const win = {
      isDestroyed: () => true,
      webContents: { send: (...args: unknown[]) => sent.push(args) }
    } as unknown as BrowserWindow
    sessionTitleChanged('s1', 'fix auth', win)
    sessionTitleChanged('s1', 'fix auth', null)
    expect(sent).toEqual([])
  })
})
