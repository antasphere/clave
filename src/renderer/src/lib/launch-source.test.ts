/**
 * The launch sources' provider half (PRDCT-4496): no stored provider
 * connection until lane B's store lands (PRDCT-4426), and the catalogue and
 * usage lines read from the machine's own entry of the models-catalog store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The module reaches the stores, which read the browser's storage at import.
vi.hoisted(() => {
  const memory = new Map<string, string>()
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
      removeItem: (key: string) => memory.delete(key)
    }
  })
})

import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import type { ModelsCatalogView } from '@clave/contract/settings/models-catalog-view'
import { localLaunchSource, serverLaunchSource } from './launch-source'
import {
  ensureModelsCatalog,
  ensureUsageLine,
  resetModelsCatalogStores
} from '../store/models-catalog-store'
import type { ServerSettings } from '../store/server-settings-store'

const VIEW: ModelsCatalogView = { fetchedAt: 1, stale: false, providers: [] }
const SETTINGS = {
  status: 'ready',
  error: null,
  claude: [],
  codex: [],
  migrated: [],
  profiles: null,
  usage: { claude: {}, codex: {} }
} as unknown as ServerSettings

beforeEach(() => resetModelsCatalogStores())

describe('the provider half of a launch source', () => {
  it('lists no provider connection on either machine yet', () => {
    expect(localLaunchSource(null).providerConnections('pi')).toEqual([])
    expect(serverLaunchSource('s1', 'Box', SETTINGS).providerConnections('opencode')).toEqual([])
  })

  it('reads its own machine’s catalogue: loading before a read, then the view', async () => {
    const local = localLaunchSource(null)
    const server = serverLaunchSource('s1', 'Box', SETTINGS)
    expect(local.catalog()).toBe('loading')
    await ensureModelsCatalog(LOCAL_SERVER_ID, async () => VIEW)
    expect(local.catalog()).toBe(VIEW)
    expect(server.catalog()).toBe('loading')
    await ensureModelsCatalog('s1', async () => {
      throw new Error('offline')
    })
    expect(server.catalog()).toBeNull()
  })

  it('reads a connection’s usage line from its own machine', async () => {
    const local = localLaunchSource(null)
    expect(local.usageLine('c1')).toBeNull()
    await ensureUsageLine(LOCAL_SERVER_ID, 'c1', async () => ({ kind: 'plan' }))
    expect(local.usageLine('c1')).toBe('Coding plan')
    expect(serverLaunchSource('s1', 'Box', SETTINGS).usageLine('c1')).toBeNull()
  })
})
