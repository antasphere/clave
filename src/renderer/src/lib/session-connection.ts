import { listedProviderConnection } from '../../../shared/provider-connection-pick'
import {
  useProviderConnectionsStore,
  type MachineProviderConnections
} from '../store/provider-connections-store'
import { ownerOf } from './fleet-identity'

/**
 * The stored connection a Pi or OpenCode tab runs on, named where a Claude
 * tab names its account (PRDCT-4427): the chat's composer, the terminal's
 * header, the sidebar's foot and the row's menu. The rule is the one
 * `clave_list` follows: the connection the tab's record names is the key its
 * process was handed, so only the record's own `connectionId` is shown, never
 * a guess. Its label is the store's current one on the tab's own machine,
 * else the one the record kept, else "Removed connection". Null for a tab on
 * no stored connection.
 */
export interface SessionConnectionFields {
  id: string
  piMode?: boolean
  opencodeMode?: boolean
  connectionId?: string
  connectionLabel?: string
}

export function sessionConnection(
  session: SessionConnectionFields | null | undefined,
  byMachine: Record<string, MachineProviderConnections>
): { id: string; label: string } | null {
  if (!session) return null
  const listed = listedProviderConnection(
    {
      piMode: session.piMode === true,
      opencodeMode: session.opencodeMode === true,
      connectionId: session.connectionId,
      connectionLabel: session.connectionLabel
    },
    (id) => byMachine[ownerOf(session.id)]?.connections.find((c) => c.id === id)?.label
  )
  return listed && { id: listed.id, label: listed.label }
}

/** `sessionConnection`, redrawn when a connection is renamed or removed. */
export function useSessionConnection(
  session: SessionConnectionFields | null | undefined
): { id: string; label: string } | null {
  const byMachine = useProviderConnectionsStore((s) => s.byMachine)
  return sessionConnection(session, byMachine)
}
