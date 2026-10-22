import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resourceKey } from '@clave/contract/fleet'
import { bindFleetCatchup } from '../../../../plugins/chat-view/src/fleet-sync'
import { emptyConversation, reduceConversation } from '../../../../plugins/chat-view/src/reducer'
import type { ServerConnectionStatus } from '@clave/contract/fleet'
import type { HistoryPage } from '../../../shared/session-model'

let status: (value: ServerConnectionStatus) => void
const history = vi.fn()
const stop = vi.fn()
const key = resourceKey('session', 'server-a', 'same')
const page: HistoryPage = {
  items: [{ event: { type: 'user_message', text: 'missed while offline' }, at: 1 }],
  before: null
}
const emit = (state: ServerConnectionStatus['state'], serverId = 'server-a'): void =>
  status({ serverId, state })
beforeEach(() => {
  vi.useFakeTimers()
  history.mockReset().mockResolvedValue(page)
  stop.mockReset()
  vi.stubGlobal('window', {
    electronAPI: {
      sessionsHistory: history,
      onFleetStatus: (callback: typeof status) => {
        status = callback
        return stop
      }
    }
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('remote transcript catch-up', () => {
  it('refreshes only its owner after reconnect, then releases the listener', async () => {
    const take = vi.fn()
    const connection = bindFleetCatchup(key, take)
    emit('disconnected', 'server-b')
    emit('connected', 'server-b')
    await vi.advanceTimersByTimeAsync(60)
    expect(history).not.toHaveBeenCalled()
    emit('disconnected')
    emit('connected')
    await vi.advanceTimersByTimeAsync(60)
    expect(history).toHaveBeenCalledWith(key)
    expect(take).toHaveBeenCalledExactlyOnceWith(page)
    connection.close()
    expect(stop).toHaveBeenCalledOnce()
  })
  it('cannot replace a newer stream or a new connection with an older HTTP result', async () => {
    let resolve!: (value: HistoryPage) => void
    history.mockImplementationOnce(
      () =>
        new Promise<HistoryPage>((done) => {
          resolve = done
        })
    )
    const take = vi.fn()
    const connection = bindFleetCatchup(key, take)
    emit('disconnected')
    emit('connected')
    await vi.advanceTimersByTimeAsync(60)
    connection.changed()
    emit('disconnected')
    emit('connected')
    resolve({ items: [], before: null })
    await vi.advanceTimersByTimeAsync(260)
    expect(take).toHaveBeenCalledExactlyOnceWith(page)
    expect(history).toHaveBeenCalledTimes(2)
    connection.close()
  })
  it('does not duplicate a transcript when the newest checkpoint contains existing turns', () => {
    const existing = reduceConversation(emptyConversation, {
      event: { type: 'user_message', text: 'earlier' },
      at: 1
    })
    const checkpoint: HistoryPage['items'] = [
      { event: { type: 'user_message', text: 'earlier' }, at: 1 },
      ...page.items,
      { event: { type: 'state_change', state: 'done' }, at: 2 }
    ]
    const next = reduceConversation(existing, { sync: checkpoint })
    expect(next.entries.map((entry) => (entry.kind === 'user' ? entry.text : entry.kind))).toEqual([
      'earlier',
      'missed while offline'
    ])
    expect(next.state).toBe('done')
    expect(reduceConversation(next, { sync: checkpoint }).entries).toEqual(next.entries)
  })
})
