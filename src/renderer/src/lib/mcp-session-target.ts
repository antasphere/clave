import { LOCAL_SERVER_ID, type SavedServerConnection } from '@clave/contract/fleet'
import type { Workspace } from '../../../shared/workspace-types'
import { ownerOf } from './fleet-identity'

/** Resolve ownership before reading accounts or creating a session. Names
 * are conveniences only; the launch always carries the stable server ID. */
export function resolveSessionTarget(input: {
  server?: string
  workspace?: string
  group?: { id: string; workspaceId?: string | null } | null
  defaultWorkspaceId?: string
  callerServerId?: string
  workspaces: Workspace[]
  connections: SavedServerConnection[]
}): { serverId: string; workspaceId?: string } {
  let explicitOwner: string | undefined
  if (input.server !== undefined) {
    if (input.server === LOCAL_SERVER_ID) explicitOwner = LOCAL_SERVER_ID
    else {
      const byId = input.connections.find((c) => c.id === input.server)
      const named = byId
        ? [byId]
        : input.connections.filter((c) => c.name.toLowerCase() === input.server!.toLowerCase())
      if (named.length !== 1)
        throw new Error(
          named.length
            ? `Ambiguous server "${input.server}". Use a server id from clave_list.`
            : `Unknown server "${input.server}". Use clave_list to see servers.`
        )
      if (!named[0].enabled) throw new Error(`Server "${named[0].name}" is disconnected.`)
      explicitOwner = named[0].id
    }
  }
  let workspace: Workspace | undefined
  if (input.workspace) {
    const byId = input.workspaces.find((w) => w.id === input.workspace)
    const named = byId
      ? [byId]
      : input.workspaces.filter(
          (w) =>
            w.name.toLowerCase() === input.workspace!.toLowerCase() &&
            (explicitOwner === undefined || ownerOf(w.id) === explicitOwner)
        )
    if (named.length !== 1)
      throw new Error(
        named.length
          ? `Ambiguous workspace "${input.workspace}". Use its id or select a server.`
          : `No workspace "${input.workspace}" on the selected server.`
      )
    workspace = named[0]
  }
  const serverId =
    explicitOwner ??
    (input.group
      ? ownerOf(input.group.id)
      : workspace
        ? ownerOf(workspace.id)
        : (input.callerServerId ?? ownerOf(input.defaultWorkspaceId)))
  if (input.group && ownerOf(input.group.id) !== serverId)
    throw new Error('The target group belongs to another server.')
  if (workspace && ownerOf(workspace.id) !== serverId)
    throw new Error('The target workspace belongs to another server.')
  if (workspace && input.group?.workspaceId && workspace.id !== input.group.workspaceId)
    throw new Error('The target group belongs to another workspace.')
  const candidate = workspace?.id ?? input.group?.workspaceId ?? input.defaultWorkspaceId
  return {
    serverId,
    ...(candidate && ownerOf(candidate) === serverId ? { workspaceId: candidate } : {})
  }
}
