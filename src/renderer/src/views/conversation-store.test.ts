import { beforeEach, describe, expect, it, vi } from 'vitest'
import { attachSessionLog, useConversationStore, type SessionLog } from './conversation-store'
import type { SessionStream } from '../../../shared/session-model'

type StreamListener = (stream: SessionStream) => void
const bridge = {
  streams: new Map<string, StreamListener[]>(),
  exits: new Map<string, ((code: number) => void)[]>(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn()
}
const electronAPI = {
  onSessionStream: (id: string, callback: StreamListener) => {
    const list = bridge.streams.get(id) ?? []
    bridge.streams.set(id, [...list, callback])
    return () =>
      bridge.streams.set(
        id,
        (bridge.streams.get(id) ?? []).filter((c) => c !== callback)
      )
  },
  onSessionStreamExit: (id: string, callback: (code: number) => void) => {
    const list = bridge.exits.get(id) ?? []
    bridge.exits.set(id, [...list, callback])
    return () =>
      bridge.exits.set(
        id,
        (bridge.exits.get(id) ?? []).filter((c) => c !== callback)
      )
  },
  sessionsSubscribe: (id: string) => bridge.subscribe(id),
  sessionsUnsubscribe: (id: string) => bridge.unsubscribe(id)
}
const emit = (id: string, text: string): void => {
  for (const listener of bridge.streams.get(id) ?? [])
    listener({ kind: 'event', event: { type: 'user_message', text } })
}
const logOf = (id: string): SessionLog | undefined => useConversationStore.getState().logs[id]
/** The log of a session this test has attached: absent is a failure, not a
 *  shape the assertions below should have to carry. */
const heldLog = (id: string): SessionLog => {
  const log = logOf(id)
  if (!log) throw new Error(`No log held for ${id}`)
  return log
}

beforeEach(() => {
  bridge.streams.clear()
  bridge.exits.clear()
  bridge.subscribe.mockReset().mockResolvedValue({ id: 'session' })
  bridge.unsubscribe.mockReset().mockResolvedValue(undefined)
  useConversationStore.setState({ logs: {} })
  ;(globalThis as { window?: unknown }).window = { electronAPI }
})

describe('the host-owned session log', () => {
  it('keeps every event that arrived, in order, with its arrival', async () => {
    const release = attachSessionLog('a')
    await Promise.resolve()
    expect(heldLog('a').ready).toBe(true)
    emit('a', 'first')
    emit('a', 'second')
    expect(heldLog('a').events.map((e) => e.event)).toEqual([
      { type: 'user_message', text: 'first' },
      { type: 'user_message', text: 'second' }
    ])
    expect(heldLog('a').events.every((e) => typeof e.at === 'number')).toBe(true)
    release()
  })
  it('subscribes once for many holders and releases on the last of them', async () => {
    const first = attachSessionLog('a')
    const second = attachSessionLog('a')
    await Promise.resolve()
    expect(bridge.subscribe).toHaveBeenCalledTimes(1)
    emit('a', 'kept')
    first()
    expect(bridge.unsubscribe).not.toHaveBeenCalled()
    // The log outlives a holder: this is what a view switch rests on.
    expect(heldLog('a').events).toHaveLength(1)
    second()
    expect(bridge.unsubscribe).toHaveBeenCalledExactlyOnceWith('a')
    expect(logOf('a')).toBeUndefined()
  })
  it("ignores a holder released twice rather than dropping another holder's claim", async () => {
    const first = attachSessionLog('a')
    const second = attachSessionLog('a')
    first()
    first()
    expect(bridge.unsubscribe).not.toHaveBeenCalled()
    expect(logOf('a')).toBeDefined()
    second()
    expect(bridge.unsubscribe).toHaveBeenCalledOnce()
  })
  it('records the exit code and a subscription that never came up', async () => {
    attachSessionLog('a')
    await Promise.resolve()
    for (const listener of bridge.exits.get('a') ?? []) listener(3)
    expect(heldLog('a').exitCode).toBe(3)
    bridge.subscribe.mockRejectedValueOnce(new Error('Unknown session'))
    attachSessionLog('b')
    await Promise.resolve()
    await Promise.resolve()
    expect(heldLog('b').error).toContain('Unknown session')
    expect(heldLog('b').ready).toBe(false)
  })
  it('holds nothing for a session with no event transport', () => {
    const release = attachSessionLog('')
    release()
    expect(bridge.subscribe).not.toHaveBeenCalled()
    expect(useConversationStore.getState().logs).toEqual({})
  })
})
