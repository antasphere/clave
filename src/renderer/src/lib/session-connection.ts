import {
  listedProviderConnection,
  providerConnectionLeft
} from '../../../shared/provider-connection-pick'
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
 * no stored connection, and for one whose process left it (PRDCT-4540): that
 * one says so instead (`sessionConnectionLeft`).
 */
export interface SessionConnectionFields {
  id: string
  piMode?: boolean
  opencodeMode?: boolean
  connectionId?: string
  connectionLabel?: string
  connectionLeftFor?: string
}

const ruleFields = (
  session: SessionConnectionFields
): Parameters<typeof listedProviderConnection>[0] => ({
  piMode: session.piMode === true,
  opencodeMode: session.opencodeMode === true,
  connectionId: session.connectionId,
  connectionLabel: session.connectionLabel,
  connectionLeftFor: session.connectionLeftFor
})

export function sessionConnection(
  session: SessionConnectionFields | null | undefined,
  byMachine: Record<string, MachineProviderConnections>
): { id: string; label: string } | null {
  if (!session) return null
  const listed = listedProviderConnection(
    ruleFields(session),
    (id) => byMachine[ownerOf(session.id)]?.connections.find((c) => c.id === id)?.label
  )
  return listed && { id: listed.id, label: listed.label }
}

/** PRDCT-4540: the sentence a tab whose process left its connection says
 *  where it named the connection (`providerConnectionLeft`, the rule
 *  `clave_list` follows too); null otherwise. */
export function sessionConnectionLeft(
  session: SessionConnectionFields | null | undefined
): string | null {
  return session ? providerConnectionLeft(ruleFields(session)) : null
}

/** `sessionConnection`, redrawn when a connection is renamed or removed. */
export function useSessionConnection(
  session: SessionConnectionFields | null | undefined
): { id: string; label: string } | null {
  const byMachine = useProviderConnectionsStore((s) => s.byMachine)
  return sessionConnection(session, byMachine)
}
