/**
 * The workspace IPC route over the settings source: the writer is named by
 * its window key, or by its web contents when the registry does not know it
 * yet, and the change fanned out over IPC skips the writer either way (round
 * 2's verifier found the web-contents skip caught by nothing).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (event: unknown) => void
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const subscribers: Listener[] = []
const sent: Array<{ id: number; channel: string; payload: unknown }> = []
const writes: Array<{ scope: unknown; origin: unknown }> = []

const win = (
  id: number
): { id: number; webContents: { id: number; send: (c: string, p: unknown) => void } } => ({
  id,
  // A BrowserWindow id and a webContents id are separate counters in
  // Electron; the fake keeps them apart (window 1 has web contents 11) so a
  // skip keyed on the wrong one shows.
  webContents: { id: id + 10, send: (channel, payload) => sent.push({ id, channel, payload }) }
})
const windows = [win(1), win(2), win(3)]
const keys: Record<number, string | null> = { 1: 'k1', 2: 'k2', 3: null }

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: never) => handlers.set(channel, fn) },
  BrowserWindow: {
    fromWebContents: (wc: { id: number }) => windows.find((w) => w.webContents.id === wc.id) ?? null
  }
}))
vi.mock('../window-registry', () => ({
  windowRegistry: {
    listWindows: () => windows,
    getKeyForWindow: (id: number) => keys[id] ?? null
  }
}))
vi.mock('../settings/shell-source', () => ({
  shellSettingsSource: {
    workspaces: {
      load: () => ({ workspaces: [], pins: [] }),
      updateRegistry: () => ({ ok: true }),
      updatePins: (scope: unknown, _pins: unknown, origin: unknown) => {
        writes.push({ scope, origin })
        return { ok: true }
      },
      setLastActive: () => undefined
    },
    subscribe: (listener: Listener) => {
      subscribers.push(listener)
      return () => undefined
    }
  }
}))

const { registerWorkspaceHandlers } = await import('./workspace-handlers')

const changed = (origin: string | null): unknown => ({
  _tag: 'workspaces.state_changed',
  workspaces: [],
  pins: [],
  origin
})

describe('the workspace writes over IPC name their writer and skip it on the way back', () => {
  beforeEach(() => {
    sent.length = 0
    writes.length = 0
  })
  it('registers once and subscribes to the source', () => {
    registerWorkspaceHandlers()
    expect(handlers.has('workspace:update-pins')).toBe(true)
    expect(subscribers).toHaveLength(1)
  })
  it('a window the registry knows is named by its key and skipped by it', async () => {
    await handlers.get('workspace:update-pins')!({ sender: { id: 11 } }, null, [])
    expect(writes).toEqual([{ scope: null, origin: 'k1' }])
    subscribers[0](changed('k1'))
    expect(sent.map((s) => s.id)).toEqual([2, 3])
  })
  it('a window the registry does not know is named by its web contents and skipped by it', async () => {
    await handlers.get('workspace:update-pins')!({ sender: { id: 13 } }, null, [])
    expect(writes).toEqual([{ scope: null, origin: 'webContents:13' }])
    subscribers[0](changed('webContents:13'))
    expect(sent.map((s) => s.id)).toEqual([1, 2])
  })
  it('a change with no writer reaches every window', () => {
    subscribers[0](changed(null))
    expect(sent.map((s) => s.id)).toEqual([1, 2, 3])
    expect(sent[0]).toMatchObject({
      channel: 'workspace:state-changed',
      payload: { workspaces: [], pins: [] }
    })
  })
})
