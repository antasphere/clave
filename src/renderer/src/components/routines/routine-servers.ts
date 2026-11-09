import { LOCAL_SERVER_ID, resourceKey, type ServerPairings } from '@clave/contract/fleet'
import type {
  RoutineDeclaration,
  RoutineView,
  RoutinesListing
} from '@clave/contract/routines/model'

/**
 * One toolbar for every server's routines (PRDCT-4149). A `.clave` file may
 * name the server that runs a routine; every server that reads the file lists
 * the routine, and only the named one runs it. This Mac reads its own
 * server's listing and the listing of every connected server, and this module
 * decides, purely, which view of each routine the toolbar shows: the one of
 * the server that RUNS it, since that is where its runs, its badge and its
 * report live, placed in the Mac workspace the person looks at.
 */
export interface RoutineSurface {
  /** The view as the owning server lists it. */
  view: RoutineView
  /** LOCAL_SERVER_ID or the connected server's id: where the acts go. */
  serverId: string
  /** The listing server's own name, or the Mac's connection name as a fallback. */
  serverName: string
  /** Where the routine runs. */
  runsOn: 'here' | 'server'
  /** False when a pinned routine's server is not connected (its view is then the LOCAL listing's). */
  reachable: boolean
  /** The workspace id the toolbar filters by. */
  workspaceId: string
  /** Where the declaration says it runs (PRDCT-4241): `every`, a machine's
   *  own name or id as written, or null when it says nothing (it is then
   *  invalid and runs nowhere). */
  placement: string | null
  /** A routine placed on a machine this Mac cannot reach: `offline` when the
   *  name is a server saved here (by its connection label or a name heard
   *  from it), `unknown` when no machine this Mac knows answers to it; null
   *  for a routine that runs here or on a connected server. */
  problem: 'offline' | 'unknown' | null
}

export interface RoutineSurfacesInput {
  local: RoutinesListing | null
  /** By server id, the last listing heard. */
  remote: Record<string, RoutinesListing>
  /** Server ids whose status is `connected`. */
  connected: ReadonlySet<string>
  /** Server id → the Mac's saved name for the connection. */
  connectionNames: Record<string, string>
  /** Server id → the server's own name, as the version sync last read it
   *  (`ServerVersionStatus.serverName`): what tells a saved server that is
   *  away from a name nobody has. */
  knownNames?: Record<string, string>
  pairings: ServerPairings['servers']
}

/** A routine's identity across machines: its file relative to the file's
 *  root, and its name. Two machines hold the same tree at different paths;
 *  the same routine is the same file under each root. */
export function relId(decl: Pick<RoutineDeclaration, 'rootDir' | 'file' | 'name'>): string {
  const root = decl.rootDir.replace(/\/+$/, '')
  const file =
    root && decl.file.startsWith(`${root}/`) ? decl.file.slice(root.length + 1) : decl.file
  return `${file}::${decl.name}`
}

/** Whether the listing server runs the view's routine. A server older than
 *  the field lists no `runsHere` at all, and it ran every routine it read. */
const runsThere = (view: RoutineView): boolean => view.routine.runsHere !== false

/** A listing's own name: an older server sends no identity. */
const listingName = (
  listing: RoutinesListing,
  serverId: string,
  names: Record<string, string>
): string => listing.server?.name ?? names[serverId] ?? serverId

/** The server ids to read, one per listing identity (`listing.server.id`):
 *  of two connections to one server, the connected one, else the first in
 *  order; a listing without an identity (an older server) stands on its own. */
export function dedupeByIdentity(
  remote: Record<string, RoutinesListing>,
  connected: ReadonlySet<string>
): string[] {
  const ids = Object.keys(remote).sort()
  const chosen = new Map<string, string>()
  const standalone: string[] = []
  for (const id of ids) {
    const identity = remote[id].server?.id
    if (!identity) {
      standalone.push(id)
      continue
    }
    const current = chosen.get(identity)
    if (!current || (!connected.has(current) && connected.has(id))) chosen.set(identity, id)
  }
  return ids.filter((id) => standalone.includes(id) || chosen.get(remote[id].server!.id) === id)
}

export function mergeRoutineSurfaces(input: RoutineSurfacesInput): RoutineSurface[] {
  const { local, remote, connected, connectionNames, pairings } = input
  const knownNames = input.knownNames ?? {}
  const surfaces: RoutineSurface[] = []
  const placed = new Set<string>()
  const add = (surface: RoutineSurface): void => {
    const id = `${surface.serverId}\u0000${surface.view.routine.key}`
    if (placed.has(id)) return
    placed.add(id)
    surfaces.push(surface)
  }
  // One server saved twice on this Mac (a LAN and a tailnet address, round 1,
  // Note 1) answers with one identity: its routines surface once, through
  // the connection that is up, else the first saved.
  const serverIds = dedupeByIdentity(remote, connected)
  // The remote views a local routine placed on a server took over: surfaced
  // once, under the local workspace, and never again as a remote routine of
  // their own.
  const consumed = new Set<string>()

  // The server a placement names, by its id or its own name; a connected one
  // wins when two listings answer to the same name.
  const ownerOf = (name: string): string | null => {
    const wanted = name.trim()
    const lower = wanted.toLowerCase()
    const matches = serverIds.filter((id) => {
      const server = remote[id].server
      return !!server && (server.id === wanted || server.name.trim().toLowerCase() === lower)
    })
    return matches.find((id) => connected.has(id)) ?? matches[0] ?? null
  }
  // A saved server that answers to the name, by its connection label or the
  // own name last heard from it, whether or not it is up right now.
  const savedOf = (name: string): string | null => {
    const lower = name.trim().toLowerCase()
    for (const [id, label] of Object.entries(connectionNames))
      if (label.trim().toLowerCase() === lower || id === name.trim()) return id
    for (const [id, own] of Object.entries(knownNames))
      if (own.trim().toLowerCase() === lower) return id
    return null
  }

  for (const view of local?.routines ?? []) {
    const decl = view.routine
    const placement = decl.runsOn ?? null
    if (runsThere(view)) {
      add({
        view,
        serverId: LOCAL_SERVER_ID,
        serverName: local?.server?.name ?? 'This Mac',
        runsOn: 'here',
        reachable: true,
        workspaceId: decl.workspaceId,
        placement,
        problem: null
      })
      continue
    }
    // Placed nowhere (no runsOn, or the field it replaced): listed here as
    // invalid, with the reason the declaration carries; no server to look for.
    if (!placement) {
      add({
        view,
        serverId: LOCAL_SERVER_ID,
        serverName: local?.server?.name ?? 'This Mac',
        runsOn: 'here',
        reachable: true,
        workspaceId: decl.workspaceId,
        placement: null,
        problem: null
      })
      continue
    }
    const owner = ownerOf(placement)
    const id = relId(decl)
    const twin = owner
      ? remote[owner].routines.find((v) => runsThere(v) && relId(v.routine) === id)
      : undefined
    // The owner's twin is this routine: it never surfaces again on its own,
    // even while its server is away (the local view stands for it then).
    if (owner && twin) consumed.add(`${owner}\u0000${id}`)
    if (owner && twin && connected.has(owner)) {
      add({
        view: twin,
        serverId: owner,
        serverName: listingName(remote[owner], owner, connectionNames),
        runsOn: 'server',
        reachable: true,
        workspaceId: decl.workspaceId,
        placement,
        problem: null
      })
      continue
    }
    const saved = owner ?? savedOf(placement)
    add({
      view,
      serverId: LOCAL_SERVER_ID,
      serverName: owner
        ? listingName(remote[owner], owner, connectionNames)
        : saved
          ? (connectionNames[saved] ?? knownNames[saved] ?? placement)
          : placement,
      runsOn: 'server',
      reachable: false,
      workspaceId: decl.workspaceId,
      placement,
      problem: saved ? 'offline' : 'unknown'
    })
  }

  for (const serverId of serverIds) {
    const listing = remote[serverId]
    for (const view of listing.routines) {
      if (!runsThere(view)) continue
      const decl = view.routine
      if (consumed.has(`${serverId}\u0000${relId(decl)}`)) continue
      const pairing = pairings[serverId]
      const paired = pairing?.combine === true ? pairing.pairs[decl.workspaceId] : undefined
      add({
        view,
        serverId,
        serverName: listingName(listing, serverId, connectionNames),
        runsOn: 'server',
        reachable: connected.has(serverId),
        workspaceId: paired ?? resourceKey('workspace', serverId, decl.workspaceId),
        placement: decl.runsOn ?? null,
        problem: null
      })
    }
  }
  return surfaces
}
