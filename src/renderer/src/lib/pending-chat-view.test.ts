import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deliverPendingChatView, pendingChatView, setPendingChatView } from './pending-chat-view'

/**
 * The walk's chat style reaches the process that opens sessions on the first
 * chat launched after it, once, and only through a chat (events) session.
 */
describe('the chat style waiting for a session', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k)
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  const api = (
    transport: 'events' | 'pty'
  ): {
    sessionsList: ReturnType<typeof vi.fn>
    sessionsSetView: ReturnType<typeof vi.fn>
  } => ({
    sessionsList: vi.fn(async () => [{ id: 's1', transport }]),
    sessionsSetView: vi.fn(async () => ({}))
  })

  it('is set on the first chat session, then forgotten', async () => {
    setPendingChatView('clave.chat-view/lab')
    const chat = api('events')
    expect(await deliverPendingChatView('s1', chat)).toBe(true)
    expect(chat.sessionsSetView).toHaveBeenCalledWith('s1', 'clave.chat-view/lab')
    expect(pendingChatView()).toBeNull()
    expect(await deliverPendingChatView('s1', chat)).toBe(false)
    expect(chat.sessionsSetView).toHaveBeenCalledTimes(1)
  })

  it('waits through a terminal session, which has no view to set', async () => {
    setPendingChatView('clave.chat-view/terminal')
    const terminal = api('pty')
    expect(await deliverPendingChatView('s1', terminal)).toBe(false)
    expect(terminal.sessionsSetView).not.toHaveBeenCalled()
    expect(pendingChatView()).toBe('clave.chat-view/terminal')
  })

  it('stays pending when the set fails', async () => {
    setPendingChatView('clave.chat-view/lab')
    const failing = api('events')
    failing.sessionsSetView.mockRejectedValueOnce(new Error('offline'))
    expect(await deliverPendingChatView('s1', failing)).toBe(false)
    expect(pendingChatView()).toBe('clave.chat-view/lab')
  })
})
