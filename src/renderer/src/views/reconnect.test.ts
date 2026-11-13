import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resourceKey } from '@clave/contract/fleet'
import type { ServerConnectionStatus } from '@clave/contract/fleet'
import { bindReconnectReset } from '../../../../plugins/chat-view/src/reconnect'

/**
 * The reset the three panes bind before any frame (PRDCT-4191, round 2 of
 * the lane's verifier): a server's connection coming back forgets the run,
 * for that server alone, on `connected` alone, never for a tab of this Mac,
 * and never once the pane unbound it.
 */
let status: ((value: ServerConnectionStatus) => void) | null = null
const stop = vi.fn()
const bound = vi.fn()
beforeEach(() => {
  status = null
  stop.mockReset()
  bound.mockReset()
  vi.stubGlobal('window', {
    electronAPI: {
      onFleetStatus: (callback: typeof status) => {
        bound()
        status = callback
        return stop
      }
    }
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('bindReconnectReset', () => {
  const key = resourceKey('session', 'server-a', 'chat-1')
  it('fires on the owner coming back connected, and on nothing else', () => {
    const reset = vi.fn()
    const off = bindReconnectReset(key, reset)
    status!({ serverId: 'server-b', state: 'connected' })
    status!({ serverId: 'server-a', state: 'connecting' })
    status!({ serverId: 'server-a', state: 'disconnected' })
    expect(reset).not.toHaveBeenCalled()
    status!({ serverId: 'server-a', state: 'connected' })
    expect(reset).toHaveBeenCalledTimes(1)
    off()
    expect(stop).toHaveBeenCalledOnce()
    // A frame after the pane unbound it, should the bridge still deliver one.
    status!({ serverId: 'server-a', state: 'connected' })
    expect(reset).toHaveBeenCalledTimes(1)
  })
  it('binds nothing for a tab of this Mac', () => {
    const reset = vi.fn()
    const off = bindReconnectReset('6f1c2c8e-1b9a-4d6e-9b1a-2f3c4d5e6f70', reset)
    expect(bound).not.toHaveBeenCalled()
    off()
    expect(stop).not.toHaveBeenCalled()
  })
  it('binds nothing on a bridge with no fleet status', () => {
    vi.stubGlobal('window', { electronAPI: {} })
    expect(() => bindReconnectReset(key, vi.fn())()).not.toThrow()
  })
})
