import { describe, expect, it, vi } from 'vitest'
import { loadBusyChatRegistry } from './busy-chat-registry.mjs'

describe('registry fixture teardown', () => {
  it('closes a created app when the readiness check fails', async () => {
    const close = vi.fn(async () => {})
    const chat = {
      close,
      win: {
        locator: () => ({
          waitFor: async () => {
            throw new Error('fixture readiness failed')
          }
        })
      }
    }
    await expect(loadBusyChatRegistry(async () => chat, 'chat/failed-ready')).rejects.toThrow(
      /fixture readiness failed/
    )
    expect(close).toHaveBeenCalledOnce()
  })
})
