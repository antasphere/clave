/**
 * The provider connections of each machine as Settings → Connections shows
 * them (PRDCT-4426): this Mac's and every saved server's, by machine id
 * (`LOCAL_SERVER_ID` for this Mac), on the model of the integrations store.
 * Nothing here is a truth of its own: the key is sealed on the machine, every
 * read and write goes there (the `fleetProviderConnection*` members, which
 * keep this Mac's on its own route), and what is kept is that machine's last
 * answer. A key a person pastes passes through one call and is kept nowhere
 * here: not in the state, not in a closure, not in a log.
 */
import { create } from 'zustand'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import type {
  ProviderCompanyId,
  ProviderConnection,
  ProviderWireFormat
} from '../../../preload/index.d'
import type { FleetSettingsEvent } from '../../../preload/fleet-types'

export interface MachineProviderConnections {
  connections: ProviderConnection[]
  loading: boolean
  /** One safe sentence, never the raw error. */
  error: string | null
}

export const EMPTY_MACHINE_PROVIDER_CONNECTIONS: MachineProviderConnections = {
  connections: [],
  loading: false,
  error: null
}

/** What the add form hands over; the key goes on to the machine and no further. */
export interface ProviderConnectionAddRequest {
  company: ProviderCompanyId
  label?: string
  baseUrl?: string
  wireFormat?: ProviderWireFormat
  apiKey?: string
}

/** A server released before the provider connections says so in this sentence. */
const NEED_UPDATE = 'This server needs an update to show its provider connections.'

/** The sentences a machine says that are meant for the person; anything
 *  else (a socket error, a stack) is said with the fallback. */
const SENTENCES =
  /^(Paste the key first\.|The base URL must start with http:\/\/ or https:\/\/|Give the base URL and the wire format of the provider\.|No such connection\.|Unknown provider connection|A secret outside printable ASCII cannot be filed in the Keychain through security\.|.+ takes no key\.|OS encryption is unavailable here, so the key cannot be stored securely\.|This server needs an update to show its provider connections\.)$/

export const SAVE_FAILED = 'The connection could not be saved.'

/** The message of a `SettingsRefused` (the server's refusal, in the words
 *  meant for the person), whatever shape it arrives in: the tagged error the
 *  client throws (`_tag`, or only its `name` once it crossed the bridge), or
 *  an error carrying it as its `cause`. Null when it is no refusal. */
function refusalMessage(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== 'object' || depth > 3) return null
  const tagged = error as { _tag?: unknown; name?: unknown; message?: unknown; cause?: unknown }
  if (
    (tagged._tag === 'SettingsRefused' || tagged.name === 'SettingsRefused') &&
    typeof tagged.message === 'string' &&
    tagged.message.trim()
  ) {
    return tagged.message.trim()
  }
  return refusalMessage(tagged.cause, depth + 1)
}

export function providerSentenceOf(error: unknown, fallback: string = SAVE_FAILED): string {
  const message = error instanceof Error ? error.message : ''
  if (message.includes(NEED_UPDATE)) return NEED_UPDATE
  const refused = refusalMessage(error)
  if (refused) return refused
  // IPC wraps a refusal ("Error invoking remote method '…': Error: <sentence>").
  const sentence = (message.split(/\b(?:Error|SettingsRefused): /).pop() ?? '').trim()
  if (/\bSettingsRefused: /.test(message) && sentence) return sentence
  return SENTENCES.test(sentence) ? sentence : fallback
}

interface ProviderConnectionsState {
  byMachine: Record<string, MachineProviderConnections>
  load: (machine: string) => Promise<void>
  /** Creates the connection, then stores its key when one is given. The
   *  created view, or null when the connection could not be made. */
  add: (machine: string, input: ProviderConnectionAddRequest) => Promise<ProviderConnection | null>
  rename: (machine: string, id: string, label: string) => Promise<boolean>
  remove: (machine: string, id: string) => Promise<boolean>
  setKey: (machine: string, id: string, apiKey: string) => Promise<boolean>
  clearError: (machine: string) => void
}

function patchMachine(
  machine: string,
  next: (current: MachineProviderConnections) => MachineProviderConnections
): void {
  useProviderConnectionsStore.setState((state) => ({
    byMachine: {
      ...state.byMachine,
      [machine]: next(state.byMachine[machine] ?? EMPTY_MACHINE_PROVIDER_CONNECTIONS)
    }
  }))
}

/** One connection's latest view, in place, or appended when it is new. */
function upsert(machine: string, view: ProviderConnection): void {
  patchMachine(machine, (current) => {
    const at = current.connections.findIndex((c) => c.id === view.id)
    const connections =
      at === -1
        ? [...current.connections, view]
        : current.connections.map((c, i) => (i === at ? view : c))
    return { ...current, connections, error: null }
  })
}

function fail(machine: string, error: unknown, fallback?: string): void {
  const sentence = providerSentenceOf(error, fallback)
  patchMachine(machine, (current) => ({ ...current, loading: false, error: sentence }))
}

export const useProviderConnectionsStore = create<ProviderConnectionsState>(() => ({
  byMachine: {},

  load: async (machine) => {
    patchMachine(machine, (current) => ({ ...current, loading: true, error: null }))
    try {
      const connections = await window.electronAPI.fleetProviderConnections(machine)
      applyProviderConnections(machine, connections)
    } catch (error) {
      fail(machine, error, 'The connections could not be read from this machine.')
    }
  },

  add: async (machine, input) => {
    const { apiKey, ...connection } = input
    let created: ProviderConnection
    try {
      created = await window.electronAPI.fleetProviderConnectionAdd(machine, connection)
      upsert(machine, created)
    } catch (error) {
      fail(machine, error)
      return null
    }
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      try {
        upsert(
          machine,
          await window.electronAPI.fleetProviderConnectionSetKey(machine, created.id, apiKey)
        )
      } catch (error) {
        // The connection stays; its row says the key is missing.
        fail(machine, error)
        return created
      }
    }
    return created
  },

  rename: async (machine, id, label) => {
    try {
      upsert(machine, await window.electronAPI.fleetProviderConnectionRename(machine, id, label))
      return true
    } catch (error) {
      fail(machine, error)
      return false
    }
  },

  remove: async (machine, id) => {
    try {
      await window.electronAPI.fleetProviderConnectionRemove(machine, id)
      patchMachine(machine, (current) => ({
        ...current,
        connections: current.connections.filter((c) => c.id !== id),
        error: null
      }))
      return true
    } catch (error) {
      fail(machine, error, 'The connection could not be removed.')
      return false
    }
  },

  setKey: async (machine, id, apiKey) => {
    try {
      upsert(machine, await window.electronAPI.fleetProviderConnectionSetKey(machine, id, apiKey))
      return true
    } catch (error) {
      fail(machine, error)
      return false
    }
  },

  clearError: (machine) => patchMachine(machine, (current) => ({ ...current, error: null }))
}))

/** A machine's whole list, as its answer or its push says it. */
export function applyProviderConnections(
  machine: string,
  connections: readonly ProviderConnection[]
): void {
  patchMachine(machine, (current) => ({
    ...current,
    connections: [...connections],
    loading: false,
    error: null
  }))
}

/** One pushed change of a server's settings: the provider connections only. */
export function applyProviderConnectionsEvent(event: FleetSettingsEvent): void {
  if (event.kind === 'provider-connections')
    applyProviderConnections(event.serverId, event.connections)
}

let started = false
/** Once per window: this Mac's changes on its own event, a server's on the
 *  fleet's settings pushes. */
export function startProviderConnectionsEvents(): void {
  if (started) return
  started = true
  window.electronAPI.onProviderConnectionsChanged?.((connections) =>
    applyProviderConnections(LOCAL_SERVER_ID, connections)
  )
  window.electronAPI.onFleetSettingsEvent?.(applyProviderConnectionsEvent)
}
