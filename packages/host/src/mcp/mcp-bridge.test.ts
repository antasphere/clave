import { describe, expect, it, vi } from 'vitest'
import { createBridge, viewError } from './mcp-bridge'

/**
 * The bridge over the view request (wave 3): a command for a window goes to
 * the server as a request carrying that window's key, the answer's result
 * comes back as the command's, and the server's two failures read as the
 * errors the tools always threw. Over fakes: the client's `views.request`
 * and the shell's windows.
 */
type Win = { id: number; isDestroyed?: () => boolean }
const win = (id: number, destroyed = false): Win => ({ id, isDestroyed: () => destroyed })

function fakes(
  windows: Win[],
  keys: Record<number, string>,
  fallback: Win | null = windows[0]
): { request: ReturnType<typeof vi.fn>; bridge: ReturnType<typeof createBridge<Win>> } {
  const request = vi.fn(async (input: { windowKey: string; command: string }) => ({
    result: { ran: input.command }
  }))
  const bridge = createBridge<Win>({
    views: async () => ({ request }),
    windows: {
      keyOf: (w) => keys[w.id] ?? null,
      list: () => windows,
      fallback: () => fallback
    }
  })
  return { request, bridge }
}

describe('callRenderer over the view request', () => {
  it('asks the server for the window of the given key and answers its result', async () => {
    const { request, bridge } = fakes([win(1), win(2)], { 1: 'k1', 2: 'k2' })
    const result = await bridge.callRenderer('list', { workspace: 'all' }, win(2))
    expect(result).toEqual({ ran: 'list' })
    expect(request).toHaveBeenCalledWith({
      windowKey: 'k2',
      command: 'list',
      payload: { workspace: 'all' },
      timeoutMs: 10_000
    })
  })
  it('falls to the focused or primary window when none is given or the given one is gone', async () => {
    const { request, bridge } = fakes([win(1)], { 1: 'k1' })
    await bridge.callRenderer('focus', {}, null)
    await bridge.callRenderer('focus', {}, win(7, true))
    expect(request.mock.calls.map((c) => c[0].windowKey)).toEqual(['k1', 'k1'])
  })
  it('refuses when there is no window at all, before touching the server', async () => {
    const { request, bridge } = fakes([], {}, null)
    await expect(bridge.callRenderer('focus', {}, null)).rejects.toThrow(
      'Clave window not available'
    )
    expect(request).not.toHaveBeenCalled()
  })
  it('throws the window’s own message on a refusal and the deadline on a timeout', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce({ _tag: 'ViewRequestRefused', message: 'No group with id "x"' })
      .mockRejectedValueOnce({ _tag: 'ViewRequestTimeout', timeoutMs: 500 })
    const bridge = createBridge<Win>({
      views: async () => ({ request }),
      windows: { keyOf: () => 'k1', list: () => [win(1)], fallback: () => win(1) }
    })
    await expect(bridge.callRenderer('rename', {}, win(1))).rejects.toThrow('No group with id "x"')
    await expect(bridge.callRenderer('rename', {}, win(1), 500)).rejects.toThrow(
      'Clave did not respond to "rename" within 500ms'
    )
  })
})

describe('callRendererAll', () => {
  it('asks every live window by its key and reports each one’s outcome', async () => {
    const request = vi.fn(async (input: { windowKey: string }) => {
      if (input.windowKey === 'k2') throw { _tag: 'ViewRequestRefused', message: 'not here' }
      return { result: { found: true } }
    })
    const bridge = createBridge<Win>({
      views: async () => ({ request }),
      windows: {
        keyOf: (w) => ({ 1: 'k1', 2: 'k2' })[w.id] ?? null,
        list: () => [win(1), win(2), win(3)],
        fallback: () => win(1)
      }
    })
    const replies = await bridge.callRendererAll('resolveSessionRef', { ref: 'x' })
    expect(replies).toEqual([
      { windowId: 1, ok: true, result: { found: true } },
      { windowId: 2, ok: false, error: 'not here' },
      { windowId: 3, ok: false, error: 'Clave window not available' }
    ])
  })
})

describe('viewError', () => {
  it('keeps any other error as it is', () => {
    const error = new Error('boom')
    expect(viewError(error, 'x', 1)).toBe(error)
    expect(viewError('text', 'x', 1).message).toBe('text')
  })
})
