import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConnection } from '../../../preload/index.d'
import type { FleetSettingsEvent } from '../../../preload/fleet-types'

// Settings → Connections' store of the provider connections (PRDCT-4426):
// every read and write goes to the machine the page names, the key passes
// through one call and is kept nowhere, and a refusal is said in its sentence.

let store: typeof import('./provider-connections-store')

const KEY = 'sk-test-store-0123456789'

const view = (over: Partial<ProviderConnection> = {}): ProviderConnection => ({
  id: 'pc-1',
  label: 'Moonshot',
  company: 'moonshot',
  kind: 'key',
  pool: 'moonshot',
  endpoints: [{ wireFormat: 'openai-chat', baseUrl: 'https://api.kimi.ai/coding/v1' }],
  needsKey: true,
  hasKey: false,
  keySetAt: null,
  createdAt: 1,
  ...over
})

let settingsListener: ((event: FleetSettingsEvent) => void) | null = null
let localListener: ((connections: ProviderConnection[]) => void) | null = null

const api = {
  fleetProviderConnections: vi.fn(),
  fleetProviderConnectionAdd: vi.fn(),
  fleetProviderConnectionRename: vi.fn(),
  fleetProviderConnectionRemove: vi.fn(),
  fleetProviderConnectionSetKey: vi.fn(),
  onProviderConnectionsChanged: vi.fn((cb: (connections: ProviderConnection[]) => void) => {
    localListener = cb
    return () => {}
  }),
  onFleetSettingsEvent: vi.fn((cb: (event: FleetSettingsEvent) => void) => {
    settingsListener = cb
    return () => {}
  })
}

beforeAll(async () => {
  vi.stubGlobal('window', { electronAPI: api, addEventListener: () => {} })
  store = await import('./provider-connections-store')
})
beforeEach(() => {
  for (const fn of [
    api.fleetProviderConnections,
    api.fleetProviderConnectionAdd,
    api.fleetProviderConnectionRename,
    api.fleetProviderConnectionRemove,
    api.fleetProviderConnectionSetKey
  ])
    fn.mockReset()
  store.useProviderConnectionsStore.setState({ byMachine: {} })
})

const state = (): ReturnType<typeof store.useProviderConnectionsStore.getState> =>
  store.useProviderConnectionsStore.getState()

describe('the machine the page names', () => {
  it('load fills that machine’s connections, and that machine’s alone', async () => {
    api.fleetProviderConnections.mockResolvedValue([view()])
    await state().load('server-b')
    expect(api.fleetProviderConnections).toHaveBeenCalledWith('server-b')
    expect(Object.keys(state().byMachine)).toEqual(['server-b'])
    expect(state().byMachine['server-b']).toMatchObject({
      loading: false,
      error: null,
      connections: [{ id: 'pc-1' }]
    })
  })

  it('add with a key creates the connection, then stores the key on the id returned, and keeps the key nowhere', async () => {
    api.fleetProviderConnectionAdd.mockResolvedValue(view({ id: 'pc-new' }))
    api.fleetProviderConnectionSetKey.mockResolvedValue(
      view({ id: 'pc-new', hasKey: true, keySetAt: 2 })
    )
    const created = await state().add('server-b', {
      company: 'moonshot',
      label: 'Moonshot',
      apiKey: KEY
    })
    expect(created?.id).toBe('pc-new')
    expect(api.fleetProviderConnectionAdd).toHaveBeenCalledWith('server-b', {
      company: 'moonshot',
      label: 'Moonshot'
    })
    expect(JSON.stringify(api.fleetProviderConnectionAdd.mock.calls)).not.toContain(KEY)
    expect(api.fleetProviderConnectionSetKey).toHaveBeenCalledWith('server-b', 'pc-new', KEY)
    expect(state().byMachine['server-b'].connections).toEqual([
      view({ id: 'pc-new', hasKey: true, keySetAt: 2 })
    ])
    expect(JSON.stringify(state())).not.toContain(KEY)
  })

  it('a key refused after the connection was made keeps the connection and says why', async () => {
    api.fleetProviderConnectionAdd.mockResolvedValue(view({ id: 'pc-new' }))
    api.fleetProviderConnectionSetKey.mockRejectedValue(new Error('Paste the key first.'))
    const created = await state().add('local', { company: 'moonshot', apiKey: KEY })
    expect(created?.id).toBe('pc-new')
    expect(state().byMachine.local.connections.map((c) => c.id)).toEqual(['pc-new'])
    expect(state().byMachine.local.error).toBe('Paste the key first.')
    expect(JSON.stringify(state())).not.toContain(KEY)
  })

  it('a manager’s refusal lands as its sentence, through IPC too', async () => {
    api.fleetProviderConnectionSetKey.mockRejectedValue(new Error('Paste the key first.'))
    expect(await state().setKey('local', 'pc-1', KEY)).toBe(false)
    expect(state().byMachine.local.error).toBe('Paste the key first.')
    api.fleetProviderConnectionAdd.mockRejectedValue(
      new Error(
        "Error invoking remote method 'provider-connections:add': Error: The base URL must start with http:// or https://"
      )
    )
    expect(await state().add('local', { company: 'generic', baseUrl: 'ftp://x' })).toBeNull()
    expect(state().byMachine.local.error).toBe('The base URL must start with http:// or https://')
    api.fleetProviderConnectionRename.mockRejectedValue(new Error('No such connection.'))
    expect(await state().rename('local', 'gone', 'x')).toBe(false)
    expect(state().byMachine.local.error).toBe('No such connection.')
    state().clearError('local')
    expect(state().byMachine.local.error).toBeNull()
  })

  it('a key form save keeps the key nowhere in the state', async () => {
    api.fleetProviderConnectionSetKey.mockResolvedValue(view({ hasKey: true, keySetAt: 3 }))
    expect(await state().setKey('server-b', 'pc-1', KEY)).toBe(true)
    expect(api.fleetProviderConnectionSetKey).toHaveBeenCalledWith('server-b', 'pc-1', KEY)
    expect(state().byMachine['server-b'].connections).toEqual([view({ hasKey: true, keySetAt: 3 })])
    expect(JSON.stringify(state())).not.toContain(KEY)
  })

  it('a server’s refusal lands as its message, in the shape the client throws it', async () => {
    // The client throws the server's declared failure as the tagged error it
    // is (`SettingsRefused`, its message the sentence meant for the person).
    const refused = Object.assign(new Error('Pick another label, this one is taken.'), {
      _tag: 'SettingsRefused',
      name: 'SettingsRefused'
    })
    api.fleetProviderConnectionSetKey.mockRejectedValue(refused)
    expect(await state().setKey('server-b', 'pc-1', KEY)).toBe(false)
    expect(state().byMachine['server-b'].error).toBe('Pick another label, this one is taken.')
    // Its name alone, once it crossed the bridge without its tag.
    const named = new Error('Only the name says so.')
    named.name = 'SettingsRefused'
    api.fleetProviderConnectionRename.mockRejectedValue(named)
    expect(await state().rename('server-b', 'pc-1', 'x')).toBe(false)
    expect(state().byMachine['server-b'].error).toBe('Only the name says so.')
    // Carried as the cause of another error.
    api.fleetProviderConnectionRemove.mockRejectedValue(
      new Error('wrapped', { cause: { _tag: 'SettingsRefused', message: 'Carried as a cause.' } })
    )
    expect(await state().remove('server-b', 'pc-1')).toBe(false)
    expect(state().byMachine['server-b'].error).toBe('Carried as a cause.')
  })

  it('the unknown-connection and the Keychain refusals pass through IPC as their sentences', async () => {
    api.fleetProviderConnectionSetKey.mockRejectedValue(
      new Error(
        "Error invoking remote method 'provider-connections:set-key': Error: Unknown provider connection"
      )
    )
    expect(await state().setKey('local', 'gone', KEY)).toBe(false)
    expect(state().byMachine.local.error).toBe('Unknown provider connection')
    api.fleetProviderConnectionSetKey.mockRejectedValue(
      new Error(
        "Error invoking remote method 'provider-connections:set-key': Error: A secret outside printable ASCII cannot be filed in the Keychain through security."
      )
    )
    expect(await state().setKey('local', 'pc-1', KEY)).toBe(false)
    expect(state().byMachine.local.error).toBe(
      'A secret outside printable ASCII cannot be filed in the Keychain through security.'
    )
    // Bare, as the bridge hands a server's message over.
    api.fleetProviderConnectionSetKey.mockRejectedValue(
      new Error(
        'A secret outside printable ASCII cannot be filed in the Keychain through security.'
      )
    )
    expect(await state().setKey('server-b', 'pc-1', KEY)).toBe(false)
    expect(state().byMachine['server-b'].error).toBe(
      'A secret outside printable ASCII cannot be filed in the Keychain through security.'
    )
    expect(JSON.stringify(state())).not.toContain(KEY)
  })

  it('an unknown error is said with the generic sentence, never raw', async () => {
    api.fleetProviderConnectionSetKey.mockRejectedValue(new Error(`socket closed: ${KEY}`))
    expect(await state().setKey('server-c', 'pc-1', KEY)).toBe(false)
    expect(state().byMachine['server-c'].error).toBe('The connection could not be saved.')
    expect(JSON.stringify(state())).not.toContain(KEY)
  })

  it('rename and remove go to that machine and update its list', async () => {
    api.fleetProviderConnections.mockResolvedValue([view(), view({ id: 'pc-2', label: 'Two' })])
    await state().load('local')
    api.fleetProviderConnectionRename.mockResolvedValue(view({ label: 'Work' }))
    expect(await state().rename('local', 'pc-1', 'Work')).toBe(true)
    expect(api.fleetProviderConnectionRename).toHaveBeenCalledWith('local', 'pc-1', 'Work')
    expect(state().byMachine.local.connections.map((c) => c.label)).toEqual(['Work', 'Two'])
    api.fleetProviderConnectionRemove.mockResolvedValue(true)
    expect(await state().remove('local', 'pc-2')).toBe(true)
    expect(api.fleetProviderConnectionRemove).toHaveBeenCalledWith('local', 'pc-2')
    expect(state().byMachine.local.connections.map((c) => c.id)).toEqual(['pc-1'])
  })
})

describe('the pushes', () => {
  it('a server’s provider-connections push replaces its list and leaves the other machine’s', async () => {
    api.fleetProviderConnections.mockResolvedValue([view()])
    await state().load('local')
    await state().load('server-b')
    store.startProviderConnectionsEvents()
    store.startProviderConnectionsEvents()
    expect(api.onFleetSettingsEvent).toHaveBeenCalledTimes(1)
    settingsListener?.({
      serverId: 'server-b',
      kind: 'provider-connections',
      connections: [view({ id: 'pc-9', label: 'Pushed' })]
    })
    expect(state().byMachine['server-b'].connections.map((c) => c.id)).toEqual(['pc-9'])
    expect(state().byMachine.local.connections.map((c) => c.id)).toEqual(['pc-1'])
    // Another kind of settings push is not this store's.
    settingsListener?.({ serverId: 'server-b', kind: 'claude-accounts', accounts: [] })
    expect(state().byMachine['server-b'].connections.map((c) => c.id)).toEqual(['pc-9'])
    // This Mac's own event lands under LOCAL_SERVER_ID.
    localListener?.([view({ id: 'pc-local' })])
    expect(state().byMachine.local.connections.map((c) => c.id)).toEqual(['pc-local'])
    expect(state().byMachine['server-b'].connections.map((c) => c.id)).toEqual(['pc-9'])
  })
})
