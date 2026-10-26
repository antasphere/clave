import {
  isServerWorkspaceId,
  type WindowIdentity,
  type Workspace,
  type WorkspaceStamp
} from '../../../shared/workspace-types'
import {
  allWorkspaces,
  findWorkspace,
  useWorkspaceStore,
  workspaceServer
} from '../store/workspace-store'
import {
  usePinnedStore,
  hydratePinnedGroups,
  serializePinnedGroups,
  dedupePinsById,
  refreshWorkspacePins,
  type PinnedGroup,
  type PinnedGroupBlueprint
} from '../store/pinned-store'
import { useSessionStore } from '../store/session-store'
import { isRemoteKey } from './fleet-identity'
import { useFleetStore } from '../store/fleet-store'
import type { ServerConnectionStatus } from '@clave/contract/fleet'

/** Orchestration layer above the stores. The stores stay import-acyclic
 *  (session→workspace, pinned→workspace); everything that has to touch several
 *  of them — activation side effects, add/remove cascades, persistence — lives
 *  here. UI and MCP call these, never store internals.
 *
 *  Multi-window (PRDCT-1703): a window is the whole app once more. This
 *  window's workspace is a per-window value main hands over at boot
 *  (`window:identity`), and every switch TELLS MAIN FIRST so the next spawn
 *  is stamped against it. The state file is written field by field
 *  (registry, pins, last-active) by whichever window changed a field; what
 *  other windows change arrives as `workspace:state-changed` and is folded
 *  in below. */

// ── Persistence ──────────────────────────────────────────────────────────────
// Same latch pattern as enableSidebarPersistence: hydration must never be able
// to clobber the state file before it has been read.

let persistEnabled = false
/** Per pins partition, the JSON last handed to main — re-sent only on change. */
const lastPersistedPins = new Map<string | null, string>()

// ── The stamp (wave 5, lane A, PRDCT-3405) ───────────────────────────────────
// The state, every change event and every landed write's answer carry a
// stamp: the revision of the registry and the pins in the process holding
// them, and that process's id (`WorkspaceStamp`). This window keeps the last
// stamp it loaded, wrote or took in, and a fold that is not newer is
// dropped: the catch-up read the push socket makes at its welcome used to
// hand the server's copy to the fold whatever its age, and a copy read
// before the boot refresh wrote and answered after it reset the pins that
// refresh had just loaded (the listener's own guard, this window's echo
// heard while the read was out, misses an answer that lands first). A fold
// that arrives while this window's own writes are in flight is held and
// folded once they have landed; applied in between, it would revert the
// first write and record the reverted content as persisted. A landed write
// answers the whole state as it left it, and the window folds that answer
// like a change: the writes are per partition while the stamp is for the
// whole state, so without the answer a change of another window that landed
// between this window's read and its write was dropped as older than the
// write's own stamp and clobbered at the next write of its partition (round
// 1 of the lane's verifier). A stamp from another instance (an attached
// window that booted on main's copy and reached the server later) is
// adopted by merging: this window keeps the partitions it wrote this
// session and writes them to the new source, and takes the other instance's
// copy of every other partition and of the registry.

/** What arrives on `workspace:state-changed` and in a landed write's answer:
 *  the registry, the pins and the stamp (absent from nothing this build
 *  sends; tolerated for a fold with none, which is applied as before). */
export type ExternalWorkspaceState = {
  workspaces: Workspace[]
  pins: unknown[]
} & Partial<WorkspaceStamp>

/** Where a copy came from: a change heard, or this window's own write
 *  landing (which partition or the registry, for the adoption below). */
type Provenance =
  | { own: false }
  | { own: true; landed: { partition: string | null } | { registry: true } }
const heard: Provenance = { own: false }

/** The last stamp this window loaded, wrote or took in; null until the boot
 *  read answers, and outside Electron. */
let known: WorkspaceStamp | null = null
/** This window's writes still in flight, and the newest copy held meanwhile. */
let writesInFlight = 0
let deferred: { state: ExternalWorkspaceState; from: Provenance } | null = null
/** The pins partitions this window wrote this session, and whether it wrote
 *  the registry: what it keeps as its own when it adopts another instance. */
const writtenPartitions = new Set<string | null>()
let registryWritten = false
/** The pins partitions whose last write was refused or failed, each with
 *  what this window held as persisted for it when the failed write went out
 *  (pin id to its serialised blueprint): a copy applied before they land
 *  again gets this window's changes to them against that base (pins it
 *  added or edited win, pins it removed stay out), and the partition is sent
 *  again, since the copy does not hold what failed to reach the source; a
 *  pin this window did not touch is the copy's (round 2 of the lane's
 *  verifier, F7, F7b and F8). */
const failedPartitions = new Map<string | null, Map<string, string>>()

function persistedBase(key: string | null): Map<string, string> {
  const json = lastPersistedPins.get(key)
  const list = json ? (JSON.parse(json) as Array<{ id: string }>) : []
  return new Map(list.map((bp) => [bp.id, JSON.stringify(bp)]))
}

function stampOf(value: Partial<WorkspaceStamp> | null | undefined): WorkspaceStamp | null {
  return value && typeof value.revision === 'number' && typeof value.instance === 'string'
    ? { revision: value.revision, instance: value.instance }
    : null
}

/** Newer than what this window holds: the same instance and a higher
 *  revision. Nothing is known yet: everything is newer. */
function isNewer(stamp: WorkspaceStamp): boolean {
  return !known || (stamp.instance === known.instance && stamp.revision > known.revision)
}

/** What this window holds, for a test or a reader. */
export function knownWorkspaceStamp(): WorkspaceStamp | null {
  return known
}

/** The state a landed write answered, folded like a change. */
function foldWritten(
  res: { ok: boolean; workspaces?: Workspace[]; pins?: unknown[] } & Partial<WorkspaceStamp>,
  landed: { partition: string | null } | { registry: true }
): void {
  if (!res.ok || !Array.isArray(res.workspaces) || !Array.isArray(res.pins)) return
  foldExternalState(
    { workspaces: res.workspaces, pins: res.pins, revision: res.revision, instance: res.instance },
    { own: true, landed }
  )
}

/** One write of this window is out; its landing releases the copy held
 *  meanwhile once nothing else is in flight. */
function writeStarted(): void {
  writesInFlight += 1
}
function writeLanded(): void {
  writesInFlight -= 1
  if (writesInFlight > 0 || !deferred) return
  const held = deferred
  deferred = null
  foldExternalState(held.state, held.from)
}

function pinPartition(pin: { workspaceId?: string | null }): string | null {
  return pin.workspaceId ?? null
}

/** Write every pins partition that changed since it was last written (or
 *  folded in from another window). Pins are per workspace and global to the
 *  app; every window holds the same list. */
function persistPins(): void {
  const groups = usePinnedStore.getState().pinnedGroups
  const keys = new Set<string | null>()
  for (const pg of groups) keys.add(pinPartition(pg))
  for (const key of lastPersistedPins.keys()) keys.add(key)
  // A partition this window emptied is written empty to a source that has
  // not seen it yet (the adoption below): it is among the written ones.
  for (const key of writtenPartitions) keys.add(key)
  for (const key of keys) {
    if (isServerWorkspaceId(key)) continue
    const partition = serializePinnedGroups(groups.filter((pg) => pinPartition(pg) === key))
    const json = JSON.stringify(partition)
    if (lastPersistedPins.get(key) === json) continue
    const write = window.electronAPI?.workspaceUpdatePins?.(key, partition)
    if (!write) continue
    writtenPartitions.add(key)
    // What this window held as persisted when the write went out: the base
    // its change is read against if the write fails (the first failure's
    // base is kept while the partition stays failed).
    const base = failedPartitions.get(key) ?? persistedBase(key)
    writeStarted()
    void write
      .then((res) => {
        if (!res?.ok) {
          failedPartitions.set(key, base)
          return
        }
        failedPartitions.delete(key)
        lastPersistedPins.set(key, json)
        foldWritten(res, { partition: key })
      })
      .catch((error: unknown) => {
        // The partition stays unrecorded and goes out again at the next
        // change, or at the next copy applied (`failedPartitions`); the
        // failure is said, since the window shows nothing of it.
        failedPartitions.set(key, base)
        console.error('[workspace] the pins write failed:', error)
      })
      .then(writeLanded)
  }
}

/** The registry is global: any window may rewrite the list of workspaces. */
export function persistWorkspaceRegistry(): Promise<unknown> {
  const { workspaces } = useWorkspaceStore.getState()
  const write = window.electronAPI?.workspaceUpdateRegistry?.(workspaces)
  if (!write) return Promise.resolve()
  registryWritten = true
  writeStarted()
  return write
    .then((res) => {
      if (res?.ok) foldWritten(res, { registry: true })
      return res
    })
    .finally(writeLanded)
}

function enableWorkspacePersistence(): void {
  if (persistEnabled) return
  persistEnabled = true
  // Pins persist on every pinnedGroups identity change (mutations used to call
  // a localStorage write inline; the subscription replaces that). Workspace
  // registry mutations all run through this module and persist explicitly.
  let prevPins = usePinnedStore.getState().pinnedGroups
  usePinnedStore.subscribe((state) => {
    if (state.pinnedGroups === prevPins) return
    prevPins = state.pinnedGroups
    persistPins()
  })
}

// ── Identity and the other windows ───────────────────────────────────────────

let subscribed = false

function applyIdentity(identity: WindowIdentity): void {
  useWorkspaceStore.setState({
    windowId: identity.windowId,
    windowKey: identity.windowKey,
    isPrimary: identity.isPrimary
  })
}

/** Record `blueprints` as what the state file holds, partition by partition,
 *  so the next persist rewrites exactly the partitions that changed — and
 *  rewrites a partition a pin LEFT as empty. Without the seed a pin re-stamped
 *  from null to a workspace id is written into its new partition while the
 *  null partition, never having been "persisted" by this window, is not
 *  touched: the stale copy survives in the file and hydrates beside the
 *  re-stamped one at the next boot. */
function seedPersistedPins(blueprints: PinnedGroupBlueprint[]): void {
  const byKey = new Map<string | null, PinnedGroupBlueprint[]>()
  for (const bp of blueprints) {
    const key = pinPartition(bp)
    byKey.set(key, [...(byKey.get(key) ?? []), bp])
  }
  lastPersistedPins.clear()
  for (const [key, list] of byKey) {
    lastPersistedPins.set(key, JSON.stringify(serializePinnedGroups(list as PinnedGroup[])))
  }
  // A partition this window emptied has no pin to put it in the record, and
  // a record without it would send it empty again at the next persist, and
  // again at the fold of that write's answer, without end: it is recorded
  // as the empty list the copy holds for it.
  for (const key of writtenPartitions) {
    if (!lastPersistedPins.has(key)) lastPersistedPins.set(key, '[]')
  }
}

/** The blueprints of `pins` that are objects with an id, one per id. */
function blueprintsOf(pins: unknown[]): PinnedGroupBlueprint[] {
  return dedupePinsById(
    (pins as PinnedGroupBlueprint[]).filter(
      (bp) => typeof bp === 'object' && bp !== null && typeof bp.id === 'string'
    )
  )
}

/** This window now writes to another instance than the one it loaded from
 *  (attached, the server reached after a boot on main's copy): its stamp is
 *  the window's from here on. The two copies merge by partition: what this
 *  window wrote this session is its own and is written to the new source
 *  (except what `landed` names as just written there), the other instance's
 *  copy of every other partition and of the registry is taken, since it may
 *  hold what other windows wrote there and what the source kept across the
 *  app's restarts, which main's copy never gets once the server is named. */
function adoptSource(
  copy: ExternalWorkspaceState,
  stamp: WorkspaceStamp,
  landed?: { partition: string | null } | { registry: true }
): void {
  known = stamp
  const ours = serializePinnedGroups(usePinnedStore.getState().pinnedGroups)
  const merged = [
    ...blueprintsOf(copy.pins).filter((bp) => !writtenPartitions.has(pinPartition(bp))),
    ...ours.filter((bp) => writtenPartitions.has(pinPartition(bp)))
  ]
  const workspaces = registryWritten ? useWorkspaceStore.getState().workspaces : copy.workspaces
  applyExternalState({ workspaces, pins: merged })
  const landedPartition = landed && 'partition' in landed ? landed.partition : undefined
  for (const key of writtenPartitions) {
    if (landedPartition !== undefined && key === landedPartition) continue
    lastPersistedPins.delete(key)
  }
  if (persistEnabled) persistPins()
  if (registryWritten && !(landed && 'registry' in landed)) void persistWorkspaceRegistry()
}

/** A change another window made, the server's copy read at a welcome, or
 *  this window's own write landing: folded only when its stamp is newer
 *  than what this window holds, held while this window's own writes are in
 *  flight, merged in when it comes from another instance (the stamp,
 *  above). Exported for the unit test; the listener bound at boot and the
 *  write results are its callers in the app. */
export function foldExternalState(state: ExternalWorkspaceState, from: Provenance = heard): void {
  const stamp = stampOf(state)
  if (stamp) {
    if (writesInFlight > 0) {
      const held = stampOf(deferred?.state)
      if (!held || held.instance !== stamp.instance || stamp.revision > held.revision)
        deferred = { state, from }
      return
    }
    if (known && stamp.instance !== known.instance) {
      adoptSource(state, stamp, from.own ? from.landed : undefined)
      return
    }
    if (!isNewer(stamp)) return
  }
  applyExternalState(state)
  if (stamp) known = stamp
}

/** The registry is taken whole; the pin blueprints are replaced from the
 *  copy, keeping the runtime state (the launched group, visibility) of every
 *  pin already known here, and this window's own content for a partition
 *  whose last write failed. Groups and sessions are never touched. */
function applyExternalState(state: { workspaces: Workspace[]; pins: unknown[] }): void {
  // Whether this window's own registry still had the workspace it shows: a
  // copy that lacks it then means someone else removed it, and the window
  // lands elsewhere. When this window removed it itself, its registry lacks
  // it already and `removeWorkspace` lands it. The rule holds for a change
  // heard and for the answer of a write of this window's own alike: an
  // answer carries what another window did meanwhile (round 2 of the lane's
  // verifier, F6, found the answers never landing the window).
  const { activeWorkspaceId: shown, workspaces: before } = useWorkspaceStore.getState()
  const hadShown = shown !== null && before.some((w) => w.id === shown)
  useWorkspaceStore.setState({ workspaces: state.workspaces })
  // A partition whose last write failed: this window's change to it, read
  // against what it held as persisted when the write went out, is laid over
  // the copy (a pin it added or edited wins, a pin it removed stays out); a
  // pin it did not touch is the copy's, so another window's edit of it
  // stands. A partition the copy already holds as this window changed it is
  // settled; any other is sent again (round 2 of the verifier, F7, F7b, F8).
  const copied = blueprintsOf(state.pins).filter((bp) => !isServerWorkspaceId(bp.workspaceId))
  const copiedById = new Map(
    serializePinnedGroups(copied as PinnedGroup[]).map((bp) => [bp.id, JSON.stringify(bp)])
  )
  const held = serializePinnedGroups(usePinnedStore.getState().pinnedGroups)
  const winning = new Map<string, PinnedGroupBlueprint>()
  const removed = new Map<string, string | null>()
  const resend = new Set<string | null>()
  for (const [key, base] of failedPartitions) {
    const mine = held.filter((bp) => pinPartition(bp) === key)
    const mineIds = new Set(mine.map((bp) => bp.id))
    for (const bp of mine) {
      const json = JSON.stringify(bp)
      if (base.get(bp.id) === json) continue
      winning.set(bp.id, bp)
      if (copiedById.get(bp.id) !== json) resend.add(key)
    }
    for (const id of base.keys()) {
      if (mineIds.has(id)) continue
      removed.set(id, key)
      if (copiedById.has(id)) resend.add(key)
    }
  }
  for (const key of [...failedPartitions.keys()]) if (!resend.has(key)) failedPartitions.delete(key)
  const blueprints = [
    ...copied
      .filter((bp) => !(removed.has(bp.id) && removed.get(bp.id) === pinPartition(bp)))
      .map((bp) => winning.get(bp.id) ?? bp),
    ...[...winning.values()].filter((bp) => !copiedById.has(bp.id))
  ]
  const current = new Map(usePinnedStore.getState().pinnedGroups.map((pg) => [pg.id, pg]))
  const next: PinnedGroup[] = blueprints.map((bp) => {
    const prev = current.get(bp.id)
    return {
      ...bp,
      sessions: (Array.isArray(bp.sessions) ? bp.sessions : []).map((sess) => ({
        ...sess,
        antigravityMode:
          sess.antigravityMode ?? (sess as { geminiMode?: boolean }).geminiMode ?? false
      })),
      activeGroupId: prev?.activeGroupId ?? null,
      visible: prev?.visible ?? false
    }
  })
  next.push(
    ...usePinnedStore.getState().pinnedGroups.filter((pg) => isServerWorkspaceId(pg.workspaceId))
  )
  // Recorded as persisted BEFORE the store is set (PRDCT-3264): the
  // persistence subscriber runs on the set and compares each partition with
  // this record. Seeded after the set, it found every folded partition
  // changed and wrote it back with this window's origin, and the other
  // window answered in kind, so one change landed as three writes. What is
  // recorded is the store's own content, normalised, so the comparison holds.
  seedPersistedPins(serializePinnedGroups(next))
  // A failed partition with pins of this window's own is not what the source
  // holds: left out of the record, the persistence pass the set below runs
  // sends it again.
  for (const key of resend) lastPersistedPins.delete(key)
  usePinnedStore.setState({ pinnedGroups: next })
  if (!hadShown) return
  // The workspace this window shows was removed from another window: land on
  // the first remaining one, else the unscoped state.
  const { activeWorkspaceId, workspaces } = useWorkspaceStore.getState()
  if (activeWorkspaceId && !workspaces.some((w) => w.id === activeWorkspaceId)) {
    const landed = workspaces[0]?.id ?? null
    void claimWorkspace(landed)
    useSessionStore.getState().applyWorkspaceSwitch(activeWorkspaceId, landed)
  }
}

function subscribeToMain(): void {
  if (subscribed) return
  subscribed = true
  window.electronAPI?.onWindowIdentityChanged?.((identity) => applyIdentity(identity))
  window.electronAPI?.onWorkspaceStateChanged?.((state) => foldExternalState(state))
  window.electronAPI?.onFleetWorkspaces?.(({ serverId, workspaces }) =>
    applyServerWorkspaces(serverId, workspaces)
  )
  window.electronAPI?.onFleetStatus?.((status) => {
    if (status.state !== 'connected') return
    const state = useWorkspaceStore.getState()
    const shown = findWorkspace(state, state.activeWorkspaceId)
    if (shown && workspaceServer(shown.id) === status.serverId) refreshServerPins(shown, status)
  })
  window.electronAPI?.onFleetConnectionsChanged?.((connections) =>
    retainServerWorkspaces(new Set(connections.map((c) => c.id)))
  )
}

// ── Server workspaces (#241) ─────────────────────────────────────────────────
// A connected server's own registry, heard from the preload at each connect
// and each change, kept per server beside this Mac's list. The last list of
// every server is cached here so a window that boots while its server is
// down still lists that server's workspaces, offline, and can come back on
// one. Nothing of them is written to this Mac's registry.

const SERVER_WORKSPACES_KEY = 'clave-server-workspaces'

function cacheServerWorkspaces(): void {
  try {
    localStorage.setItem(
      SERVER_WORKSPACES_KEY,
      JSON.stringify(useWorkspaceStore.getState().serverWorkspaces)
    )
  } catch {
    /* the live read stays authoritative */
  }
}

function cachedServerWorkspaces(): Record<string, Workspace[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(SERVER_WORKSPACES_KEY) ?? '{}') as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, Workspace[]> = {}
    for (const [serverId, list] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue
      out[serverId] = (list as Workspace[]).filter(
        (w) => isServerWorkspaceId(w?.id) && typeof w.rootDir === 'string'
      )
    }
    return out
  } catch {
    return {}
  }
}

/** One server's list, as its server holds it now. When the workspace this
 *  window shows is gone from it (removed from another Mac), the window lands
 *  on the first workspace left. Exported for the unit test. */
const pinRefreshStatus = new Map<string, { status: unknown; workspace: string }>()

function refreshPinsForWindow(ws: Workspace): Promise<void> {
  const refresh = refreshWorkspacePins(ws)
  if (!workspaceServer(ws.id)) return refresh
  return refresh.catch((error) => {
    console.warn('[workspace] Server pins could not be refreshed:', error)
  })
}

function refreshServerPins(ws: Workspace, status: ServerConnectionStatus | undefined): void {
  const owner = workspaceServer(ws.id)!
  const workspace = JSON.stringify([ws.id, ws.rootDir, ws.profileFile])
  const last = pinRefreshStatus.get(owner)
  if (last && last.status === status && last.workspace === workspace) return
  pinRefreshStatus.set(owner, { status, workspace })
  void refreshPinsForWindow(ws)
}

export function applyServerWorkspaces(serverId: string, workspaces: Workspace[]): void {
  const { activeWorkspaceId, serverWorkspaces } = useWorkspaceStore.getState()
  const owned = workspaces.filter((w) => workspaceServer(w.id) === serverId)
  useWorkspaceStore.setState({ serverWorkspaces: { ...serverWorkspaces, [serverId]: owned } })
  cacheServerWorkspaces()
  const shown = owned.find((w) => w.id === activeWorkspaceId)
  const status = useFleetStore.getState().statuses[serverId]
  if (shown) refreshServerPins(shown, status)
  if (
    workspaceServer(activeWorkspaceId) === serverId &&
    !owned.some((w) => w.id === activeWorkspaceId)
  ) {
    landElsewhere(activeWorkspaceId!)
  }
}

/** Drop the lists of servers no longer saved on this Mac. */
function retainServerWorkspaces(retained: Set<string>): void {
  const { serverWorkspaces, activeWorkspaceId } = useWorkspaceStore.getState()
  const gone = Object.keys(serverWorkspaces).filter((id) => !retained.has(id))
  if (gone.length === 0) return
  const next = { ...serverWorkspaces }
  for (const id of gone) delete next[id]
  useWorkspaceStore.setState({ serverWorkspaces: next })
  cacheServerWorkspaces()
  const shownOn = workspaceServer(activeWorkspaceId)
  if (shownOn && gone.includes(shownOn)) landElsewhere(activeWorkspaceId!)
}

function landElsewhere(from: string): void {
  const landed = allWorkspaces(useWorkspaceStore.getState())[0]?.id ?? null
  void claimWorkspace(landed)
  useSessionStore.getState().applyWorkspaceSwitch(from, landed)
}

/** Register a folder on a connected server as one of its workspaces; every
 *  Mac connected to that server hears it. Throws the server's refusal. */
export async function addServerWorkspace(
  serverId: string,
  rootDir: string,
  name?: string
): Promise<Workspace> {
  const api = window.electronAPI
  if (!api?.fleetAddWorkspace) throw new Error('Clave servers are not available here.')
  const added = await api.fleetAddWorkspace(serverId, { rootDir, name })
  // The server's list carrying it arrives as the change event on its live
  // socket; wait briefly for it so a caller can switch to it at once. It is
  // never inserted here: the server's list is the only truth (another Mac may
  // have removed it already).
  const has = (): boolean =>
    (useWorkspaceStore.getState().serverWorkspaces[serverId] ?? []).some((w) => w.id === added.id)
  if (!has())
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, 3_000)
      const off = useWorkspaceStore.subscribe(() => {
        if (has()) done()
      })
      function done(): void {
        clearTimeout(timer)
        off()
        resolve()
      }
    })
  return added
}

/** The sentences an add or a removal of a server workspace refuses with, as
 *  the preload and this file word them: shown as they are. */
const SERVER_WORKSPACE_REFUSALS = new Set([
  'Clave servers are not available here.',
  'Choose an absolute folder on the server.',
  'That path on the server is not a folder.',
  'That folder overlaps a workspace already on this server.',
  'The server refused the workspace list.'
])

/** What to tell the person when adding or removing a server workspace
 *  failed: a refusal as worded, anything else (the server went away, a
 *  transport error) in plain words rather than the transport's. */
export function serverWorkspaceError(
  err: unknown,
  serverName: string,
  action: 'add' | 'remove'
): string {
  if (err instanceof Error && SERVER_WORKSPACE_REFUSALS.has(err.message)) return err.message
  return `${serverName} could not ${action} the workspace. Check that it is connected, then try again.`
}

/** Remove a server workspace from its server's registry. This window, when
 *  it shows it, lands on another workspace once the server's list arrives. */
export async function removeServerWorkspace(id: string): Promise<void> {
  if (!isServerWorkspaceId(id)) return
  await window.electronAPI?.fleetRemoveWorkspace?.(id)
}

/** Make this window SHOW `id` (null = unscoped): main is told first — so its
 *  registry is current when the next pty:spawn stamps its record (IPC is
 *  FIFO) and the window comes back on this workspace at the next boot — then
 *  the store follows. Only an unknown workspace is refused. Does NOT run the
 *  view switch; callers that need it call applyWorkspaceSwitch themselves. */
async function claimWorkspace(id: string | null): Promise<boolean> {
  const res = (await window.electronAPI?.windowSetWorkspace?.(id)) ?? { ok: true as const }
  if (!res.ok) return false
  useWorkspaceStore.setState({ activeWorkspaceId: id })
  return true
}

// ── Boot ─────────────────────────────────────────────────────────────────────

/** Renderer-side path prefix test (no node path module here). Roots are
 *  normalized absolute paths; candidate paths come from pin blueprints. */
function isUnderRoot(rootDir: string, p: string): boolean {
  return p === rootDir || p.startsWith(rootDir.endsWith('/') ? rootDir : rootDir + '/')
}

function matchWorkspaceByPath(
  workspaces: Workspace[],
  p: string | null | undefined
): Workspace | null {
  if (!p) return null
  let best: Workspace | null = null
  for (const ws of workspaces) {
    if (isUnderRoot(ws.rootDir, p) && (!best || ws.rootDir.length > best.rootDir.length)) {
      best = ws
    }
  }
  return best
}

function dirOf(filePath: string): string {
  return filePath.replace(/[\\/][^\\/]*$/, '') || filePath
}

/** Migration Phase B: import the retired localStorage pin store into the new
 *  workspace state file, stamping each pin by path against registered roots.
 *  File-backed pins that match no root are dropped — they are recoverable by
 *  re-registering their root folder as a workspace (this is also the cleanup
 *  that removes orphans from workspaces that left the old registry uncleanly).
 *  Ad-hoc pins (no filePath) are unrecoverable, so they are never dropped:
 *  matched by cwd, else stamped to the active workspace. */
function migrateLocalStoragePins(
  workspaces: Workspace[],
  activeWorkspaceId: string | null
): PinnedGroupBlueprint[] {
  let legacy: PinnedGroupBlueprint[] = []
  try {
    legacy = JSON.parse(localStorage.getItem('clave-pinned-groups') ?? '[]')
  } catch {
    legacy = []
  }

  const migrated: PinnedGroupBlueprint[] = []
  for (const bp of legacy) {
    if (bp.filePath) {
      const candidate =
        bp.workspaceRoot ??
        bp.rootDir ??
        dirOf(bp.filePath) ??
        (bp.discoveredBy ? dirOf(bp.discoveredBy) : null)
      const ws = matchWorkspaceByPath(workspaces, candidate)
      if (!ws) continue // orphan — see doc comment
      migrated.push({ ...bp, workspaceId: ws.id })
    } else {
      const ws = matchWorkspaceByPath(workspaces, bp.cwd)
      migrated.push({ ...bp, workspaceId: ws?.id ?? activeWorkspaceId })
    }
  }
  return migrated
}

/** Boot hydration — the single owner (called from AppShell's boot effect,
 *  before session adoption so adoption can stamp against the registry).
 *  This window's workspace comes from main's registry (`window:identity`),
 *  never from the state file; outside Electron there is no identity and the
 *  renderer behaves as the sole, primary window on the last-active one. */
export async function bootWorkspaces(): Promise<void> {
  const identity = (await window.electronAPI?.windowIdentity?.().catch(() => null)) ?? null
  const state = await window.electronAPI?.workspaceLoad?.().catch(() => null)
  // What this window holds from here on; a fold must be newer to land.
  known = stampOf(state)
  const workspaces = state?.workspaces ?? []
  const activeWorkspaceId = identity
    ? identity.workspaceId
    : (state?.lastActiveWorkspaceId ?? state?.activeWorkspaceId ?? null)

  useWorkspaceStore.setState({
    workspaces,
    serverWorkspaces: cachedServerWorkspaces(),
    activeWorkspaceId,
    loaded: true,
    windowId: identity?.windowId ?? null,
    windowKey: identity?.windowKey ?? null,
    isPrimary: identity?.isPrimary ?? true
  })
  subscribeToMain()

  let pins: PinnedGroupBlueprint[]
  if (state && !state.pinsMigrated) {
    pins = migrateLocalStoragePins(workspaces, activeWorkspaceId)
  } else {
    pins = (state?.pins ?? []) as PinnedGroupBlueprint[]
  }

  // Reconciliation: a pin stamped with a workspace that is no longer
  // registered can never be shown or refreshed — drop it. This is what makes
  // the old "orphaned pins pile up forever" state structurally impossible.
  const validIds = new Set(workspaces.map((w) => w.id))
  pins = pins.filter((p) => p.workspaceId == null || validIds.has(p.workspaceId))

  hydratePinnedGroups(pins)
  // What the file holds is what this window has "persisted": the boot refresh
  // that follows re-stamps and prunes against it, and a partition that empties
  // must be written back empty.
  seedPersistedPins(serializePinnedGroups(usePinnedStore.getState().pinnedGroups))
  enableWorkspacePersistence()

  if (state && !state.pinsMigrated) {
    // Persist the migrated pins — the whole list at once, this being the sole
    // window of the very first boot of the workspace model (flips
    // pinsMigrated true) — then retire the localStorage key for good.
    const migrated = await window.electronAPI?.workspaceUpdatePins?.(
      'all',
      serializePinnedGroups(usePinnedStore.getState().pinnedGroups)
    )
    if (migrated) foldWritten(migrated, { partition: null })
    localStorage.removeItem('clave-pinned-groups')
  }
}

/** Post-adoption boot tail: refresh the active workspace's pins from its
 *  files. Separate from bootWorkspaces so adoption doesn't wait on file IO. */
export async function refreshActiveWorkspacePins(): Promise<void> {
  const state = useWorkspaceStore.getState()
  const active = findWorkspace(state, state.activeWorkspaceId)
  if (active) await refreshPinsForWindow(active)
}

// ── Workspace mutations ──────────────────────────────────────────────────────

/** Pure view switch for THIS window. Main is told BEFORE anything changes
 *  here, so its registry is current when the next pty:spawn stamps its
 *  record (IPC is FIFO); other windows are untouched. */
export async function setActiveWorkspace(id: string): Promise<void> {
  const state = useWorkspaceStore.getState()
  const { activeWorkspaceId } = state
  if (id === activeWorkspaceId) return
  const target = findWorkspace(state, id)
  if (!target) return

  if (!(await claimWorkspace(id))) return
  useSessionStore.getState().applyWorkspaceSwitch(activeWorkspaceId, id)
  // NOTE (§3.6 third bullet, deferred): an IN-WINDOW switch does not re-home
  // sessions in this slice. Re-homing on switch means the window both GAINS
  // one workspace's sessions and RELEASES another's to the primary while both
  // windows' layouts re-home too — the same load-bearing ordering as the
  // first-workspace transition, and no numbered invariant (§6) requires it
  // (invariant 11 is the NEW-window case, invariant 3 the window-close case,
  // both re-homed here). A secondary window switching workspaces keeps its
  // previous workspace's sessions hidden-hosted in it — fully reachable
  // (clave_send_to_session, clave_list) — rather than moving them. The
  // heavy path is left for a follow-up so its risk does not ride into this
  // slice untested. `setActiveWorkspace` is the only switch entry (the UI and
  // clave_switch_workspace both call it), so this note governs both.
  // Refresh from files in the background — the switch itself must be instant.
  void refreshPinsForWindow(target)
}

export function cycleWorkspace(dir: 1 | -1): void {
  const { activeWorkspaceId } = useWorkspaceStore.getState()
  const workspaces = allWorkspaces(useWorkspaceStore.getState())
  if (workspaces.length < 2) return
  const idx = workspaces.findIndex((w) => w.id === activeWorkspaceId)
  const next = workspaces[(idx + dir + workspaces.length) % workspaces.length]
  void setActiveWorkspace(next.id)
}

function workspaceNameFromRoot(rootDir: string): string {
  const base = rootDir.split(/[\\/]/).pop()?.replace(/^\.+/, '') ?? ''
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : rootDir
}

/** Register a root folder as a workspace. Returns null (with no state change)
 *  when the root nests inside — or swallows — an existing workspace root. */
export async function addWorkspace(
  rootDir: string,
  profileFile: string | null,
  name?: string
): Promise<Workspace | null> {
  const { workspaces } = useWorkspaceStore.getState()
  const clean = rootDir.replace(/\/+$/, '')
  for (const ws of workspaces) {
    if (isUnderRoot(ws.rootDir, clean) || isUnderRoot(clean, ws.rootDir)) return null
  }

  await window.electronAPI?.trustWorkspaceRoot(clean)
  const ws: Workspace = {
    id: crypto.randomUUID(),
    name: name?.trim() || workspaceNameFromRoot(clean),
    rootDir: clean,
    profileFile,
    createdAt: Date.now()
  }

  // Leaving no-workspace mode only: a window already on a server workspace
  // (#241) stays there, and nothing is stamped behind its back.
  const isFirst = workspaces.length === 0 && useWorkspaceStore.getState().activeWorkspaceId === null
  useWorkspaceStore.setState((s) => ({ workspaces: [...s.workspaces, ws] }))

  if (isFirst) {
    // Leaving no-workspace mode. The current unscoped sidebar IS this
    // workspace's content: make it active and stamp every unscoped
    // session/group/pin into it, in-store, before main learns the registry
    // change. Invariant: active is null ⟺ zero workspaces.
    useWorkspaceStore.setState({ activeWorkspaceId: ws.id })
    stampUnowned(ws.id)
  }

  // Main learns the workspace (and, on the first, that this window shows it).
  await persistWorkspaceRegistry()
  if (isFirst) await claimWorkspace(ws.id)

  await refreshWorkspacePins(ws)
  return ws
}

/** Stamp every unowned session/group/pin of this Mac with the given
 *  workspace. Used when the FIRST workspace is created (no-workspace mode
 *  ends). A server's tab or group is never stamped with a Mac workspace: it
 *  belongs to its server's workspaces (#241). */
function stampUnowned(workspaceId: string): void {
  const sessionState = useSessionStore.getState()
  const unowned = (x: { id: string; workspaceId?: string | null }): boolean =>
    x.workspaceId == null && !isRemoteKey(x.id)
  useSessionStore.setState({
    sessions: sessionState.sessions.map((s) => (unowned(s) ? { ...s, workspaceId } : s)),
    groups: sessionState.groups.map((g) => (unowned(g) ? { ...g, workspaceId } : g))
  })
  for (const s of sessionState.sessions) {
    if (unowned(s) && s.sessionType === 'local') {
      // Non-fatal, like the name: the stamp applies for this run either way.
      void window.electronAPI?.setSessionWorkspace(s.id, workspaceId).catch(() => {})
    }
  }
  usePinnedStore.setState((s) => ({
    pinnedGroups: s.pinnedGroups.map((pg) => (pg.workspaceId == null ? { ...pg, workspaceId } : pg))
  }))
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) return
  useWorkspaceStore.setState((s) => ({
    workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name: trimmed } : w))
  }))
  await persistWorkspaceRegistry()
}

export async function setWorkspaceProfile(id: string, profileFile: string | null): Promise<void> {
  useWorkspaceStore.setState((s) => ({
    workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, profileFile } : w))
  }))
  await persistWorkspaceRegistry()
  const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === id)
  if (ws) await refreshWorkspacePins(ws)
}

/** How a removal would cascade — surfaced by the Settings confirm dialog. */
export function describeWorkspaceRemoval(id: string): {
  sessionCount: number
  pinCount: number
  target: Workspace | null
} {
  const { workspaces, activeWorkspaceId } = useWorkspaceStore.getState()
  const remaining = workspaces.filter((w) => w.id !== id)
  const target =
    (id === activeWorkspaceId ? remaining[0] : remaining.find((w) => w.id === activeWorkspaceId)) ??
    null
  return {
    sessionCount: useSessionStore.getState().sessions.filter((s) => s.workspaceId === id).length,
    pinCount: usePinnedStore.getState().pinnedGroups.filter((pg) => pg.workspaceId === id).length,
    target
  }
}

/** Remove a workspace. Its pins die with it (recoverable from their files);
 *  its sessions and groups are reassigned ALIVE to the target workspace (the
 *  active one, or the first remaining when removing the active one, or to the
 *  unscoped world when it was the last). */
export async function removeWorkspace(id: string): Promise<void> {
  const { workspaces, activeWorkspaceId } = useWorkspaceStore.getState()
  if (!workspaces.some((w) => w.id === id)) return
  const { target } = describeWorkspaceRemoval(id)
  const targetId = target?.id ?? null

  // Cascade pins first (removePinnedGroup handles per-file unwatching).
  const pinned = usePinnedStore.getState()
  for (const pg of pinned.pinnedGroups.filter((p) => p.workspaceId === id)) {
    pinned.removePinnedGroup(pg.id)
  }

  // Reassign sessions/groups — never kill anything on registry changes.
  const sessionState = useSessionStore.getState()
  const affectedSessions = sessionState.sessions.filter((s) => s.workspaceId === id)
  useSessionStore.setState({
    sessions: sessionState.sessions.map((s) =>
      s.workspaceId === id ? { ...s, workspaceId: targetId ?? undefined } : s
    ),
    groups: sessionState.groups.map((g) =>
      g.workspaceId === id ? { ...g, workspaceId: targetId ?? undefined } : g
    )
  })
  for (const s of affectedSessions) {
    if (s.sessionType === 'local') {
      void window.electronAPI?.setSessionWorkspace(s.id, targetId).catch(() => {})
    }
  }

  const wasActive = id === activeWorkspaceId
  useWorkspaceStore.setState((s) => ({ workspaces: s.workspaces.filter((w) => w.id !== id) }))
  await persistWorkspaceRegistry()
  if (wasActive) {
    // Land on the preferred target, else the first remaining workspace, else
    // the unscoped state. (Another window showing the removed workspace
    // lands the same way when the registry change reaches it.)
    const remaining = useWorkspaceStore.getState().workspaces.map((w) => w.id)
    const landed = targetId ?? remaining[0] ?? null
    await claimWorkspace(landed)
    useSessionStore.getState().applyWorkspaceSwitch(id, landed)
  }
}
