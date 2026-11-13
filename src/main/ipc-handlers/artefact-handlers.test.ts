/**
 * The artefacts' IPC arm (PRDCT-4474): each channel reaches the server main
 * named through its typed client, with the arguments the window gave; with
 * no server named, every channel refuses with one sentence and asks nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaveApiClient } from '@clave/client'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  }
}))
vi.mock('../mcp/server-client', () => ({ serverClient: { api: async () => null } }))

import { registerArtefactHandlers, SERVER_NOT_READY } from './artefact-handlers'

const calls: Array<{ method: string; args: unknown[] }> = []
const recorded =
  (method: string, answer: unknown) =>
  async (...args: unknown[]): Promise<unknown> => {
    calls.push({ method, args })
    return answer
  }
const api = {
  artefacts: {
    list: recorded('list', [{ sessionId: 's1' }]),
    hold: recorded('hold', { holdId: 'h1', lease: 'l', url: 'u', ttlMs: 90_000 }),
    release: recorded('release', undefined),
    saveVersion: recorded('saveVersion', { version: 2, created: true }),
    close: recorded('close', undefined),
    slidelessState: recorded('slidelessState', { phase: 'ready', version: '1', error: null }),
    installSlideless: recorded('installSlideless', {
      phase: 'installing',
      version: null,
      error: null
    })
  }
} as unknown as ClaveApiClient

let named = true
const invoke = (channel: string, ...args: unknown[]): unknown =>
  handlers.get(channel)!({ sender: {} }, ...args)

beforeEach(() => {
  handlers.clear()
  calls.length = 0
  named = true
  registerArtefactHandlers({ named: () => named, api: async () => api })
})

describe('the artefacts over IPC', () => {
  it('registers one channel per member', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'artefacts:close',
      'artefacts:hold',
      'artefacts:installSlideless',
      'artefacts:list',
      'artefacts:release',
      'artefacts:saveVersion',
      'artefacts:slidelessState',
      'artefacts:versions'
    ])
  })

  it('each channel reaches the client with the window’s arguments', async () => {
    await expect(invoke('artefacts:list')).resolves.toEqual([{ sessionId: 's1' }])
    await expect(invoke('artefacts:hold', 's1')).resolves.toMatchObject({ holdId: 'h1' })
    await invoke('artefacts:hold', 's1', 'h1')
    await invoke('artefacts:release', 's1', 'h1')
    await expect(invoke('artefacts:saveVersion', 's1')).resolves.toEqual({
      version: 2,
      created: true
    })
    await invoke('artefacts:close', 's1')
    await expect(invoke('artefacts:slidelessState')).resolves.toMatchObject({ phase: 'ready' })
    await expect(invoke('artefacts:installSlideless')).resolves.toMatchObject({
      phase: 'installing'
    })
    expect(calls).toEqual([
      { method: 'list', args: [] },
      { method: 'hold', args: ['s1', undefined] },
      { method: 'hold', args: ['s1', 'h1'] },
      { method: 'release', args: ['s1', 'h1'] },
      { method: 'saveVersion', args: ['s1'] },
      { method: 'close', args: ['s1'] },
      { method: 'slidelessState', args: [] },
      { method: 'installSlideless', args: [] }
    ])
  })

  it('with no server named, every channel refuses with the sentence and asks nothing', async () => {
    named = false
    for (const channel of handlers.keys())
      await expect(invoke(channel, 's1', 'h1')).rejects.toThrow(SERVER_NOT_READY)
    expect(calls).toEqual([])
    expect(SERVER_NOT_READY).toBe("Clave's server is not ready yet.")
  })
})
