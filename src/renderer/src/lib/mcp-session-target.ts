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
  /** Where the tab opens on a server when nothing names a workspace there
   *  (PRDCT-4193): the directory it opens in, matched against the server's
   *  workspace roots, and the server workspaces paired with the caller's
   *  local one (`pairedServerWorkspaces`), which win when exactly one is
   *  that server's. Absent, a server tab opened from a Mac tab lands in no
   *  workspace, as before. */
  cwd?: string
  pairedWorkspaceIds?: readonly string[]
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
    throw new Error(
      'The target group belongs to another server. Omit groupId, or pass a group of that server from clave_list.'
    )
  if (workspace && ownerOf(workspace.id) !== serverId)
    throw new Error('The target workspace belongs to another server.')
  if (workspace && input.group?.workspaceId && workspace.id !== input.group.workspaceId)
    throw new Error('The target group belongs to another workspace.')
  const candidate = workspace?.id ?? input.group?.workspaceId ?? input.defaultWorkspaceId
  if (candidate && ownerOf(candidate) === serverId) return { serverId, workspaceId: candidate }
  // A server tab with nothing naming a workspace of that server (PRDCT-4193):
  // the server workspace paired with the caller's, else the one whose root
  // holds the directory, so the tab shows where the coordinator works
  // instead of in no workspace at all.
  if (serverId !== LOCAL_SERVER_ID) {
    const placed = placeOnServer(serverId, input.workspaces, input.pairedWorkspaceIds, input.cwd)
    if (placed) return { serverId, workspaceId: placed }
  }
  return { serverId }
}

/** The server workspace a tab lands in when its open names none: the one
 *  paired with the caller's local workspace when exactly one is this
 *  server's, else the server workspace whose root holds `cwd`, the deepest
 *  root winning; undefined when neither applies. */
function placeOnServer(
  serverId: string,
  workspaces: Workspace[],
  paired: readonly string[] | undefined,
  cwd: string | undefined
): string | undefined {
  // A pairing names a workspace the server may no longer have (removed there
  // since the pairing was made): only one the server still lists is taken
  // (round 3, C3); otherwise the directory decides.
  const listed = new Set(workspaces.filter((w) => ownerOf(w.id) === serverId).map((w) => w.id))
  const own = (paired ?? []).filter((id) => ownerOf(id) === serverId && listed.has(id))
  if (own.length === 1) return own[0]
  if (!cwd) return undefined
  // A root saved with a trailing slash holds its own directory too (round 1, N4).
  const holds = (root: string): boolean => {
    const bare = root.replace(/\/+$/, '')
    return cwd.replace(/\/+$/, '') === bare || cwd.startsWith(bare + '/')
  }
  const holder = workspaces
    .filter((w) => ownerOf(w.id) === serverId && holds(w.rootDir))
    .sort((a, b) => b.rootDir.length - a.rootDir.length)[0]
  return holder?.id
}
