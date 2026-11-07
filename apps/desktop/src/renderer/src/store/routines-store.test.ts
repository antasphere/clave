import { beforeAll, describe, expect, it } from 'vitest'
import type { RoutinesListing } from '@clave/contract/routines/model'

/**
 * The routines store reaching its server late (ADR 0004). A packaged app runs
 * its server as a child, so the window's first read goes to main's own arm,
 * which refuses ("this window has not reached it yet"). The store must read
 * again once the connection opens, and a good read must clear the refusal:
 * before, the toolbar stayed empty with the error on show until a routine
 * happened to change.
 */
const LISTING: RoutinesListing = { routines: [], viewer: { url: null, note: '' } }

const bridge = {
  connected: null as (() => void) | null,
  changed: null as (() => void) | null,
  reached: false,
  routinesList: async (): Promise<RoutinesListing> => {
    if (!bridge.reached)
      throw new Error("The routines are the server's: this window has not reached it yet")
    return LISTING
  },
  onRoutinesChanged: (cb: () => void) => {
    bridge.changed = cb
    return () => (bridge.changed = null)
  },
  onServerConnected: (cb: () => void) => {
    bridge.connected = cb
    return () => (bridge.connected = null)
  }
}

let mod: typeof import('./routines-store')

beforeAll(async () => {
  ;(globalThis as unknown as { window: unknown }).window = globalThis
  ;(globalThis as unknown as { electronAPI: unknown }).electronAPI = bridge
  mod = await import('./routines-store')
})

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('routines store', () => {
  it('reads again when the server connects, and the refusal clears', async () => {
    const stop = mod.initRoutinesStore()
    await settle()
    expect(mod.useRoutinesStore.getState().loaded).toBe(false)
    expect(mod.useRoutinesStore.getState().error).toMatch(/not reached it yet/)

    bridge.reached = true
    bridge.connected?.()
    await settle()
    expect(mod.useRoutinesStore.getState().loaded).toBe(true)
    expect(mod.useRoutinesStore.getState().error).toBeNull()

    stop()
    expect(bridge.connected).toBeNull()
    expect(bridge.changed).toBeNull()
  })
})
