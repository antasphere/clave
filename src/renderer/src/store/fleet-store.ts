import { create } from 'zustand'
import {
  LOCAL_SERVER_ID,
  resourceKey,
  type SavedServerConnection,
  type ServerConnectionStatus,
  type ServerVersionStatus
} from '@clave/contract/fleet'
import type { LayoutSnapshot } from '@clave/contract/sidebar/layout'
import type { FleetPendingRequest as PendingRequest } from '../../../preload/fleet-types'
import type { FleetSnapshot } from '../../../preload/fleet-types'
import { useSessionStore } from './session-store'
import type { Session, SessionGroup } from './session-types'
import { isRemoteKey, ownerOf, partitionLayout } from '../lib/fleet-identity'
import { finishesTurn } from '../lib/tab-status'
import { createSavePipeline, type SavePipeline } from '../lib/sidebar-save-pipeline'
import { mergeLayouts } from '@clave/contract/sidebar/ops'

interface FleetState {
  connections: SavedServerConnection[]
  statuses: Record<string, ServerConnectionStatus>
  requests: Record<string, readonly PendingRequest[]>
  /** Each enabled server's version against this app's, as main decided it (issue #266). */
  versions: Record<string, ServerVersionStatus>
  error: string | null
}
export const useFleetStore = create<FleetState>(() => ({
  connections: [],
  statuses: {},
  requests: {},
  versions: {},
  error: null
}))
/** Main publishes every enabled server at once: a server it left out is
 *  disconnected or removed, and loses its line. */
export function applyServerVersions(statuses: readonly ServerVersionStatus[]): void {
  useFleetStore.setState({
    versions: Object.fromEntries(statuses.map((status) => [status.serverId, status]))
  })
}
export function reportFleetError(error: unknown): void {
  // Server errors can contain source details. The surface only needs a safe actionable notice.
  void error
  useFleetStore.setState({
    error: 'The server operation failed. Check its connection and try again.'
  })
}
/**
 * A tab a server's record names (who opened it, which tab it is nested under),
 * as this window names that server's tabs: its owner's key. The preload scopes
 * `spawnedBy` to a key before a snapshot gets here and leaves `openedBy` raw
 * (`scopeRecord`, fleet-desktop.ts), so a name is wrapped only when it is not
 * a key yet. Wrapping a key a second time names no tab at all: from 8
 * November 2026 until PRDCT-4997 a server's nested tabs were never folded on
 * a desktop, each side keying the same id and each side's test passing alone.
 */
export function ownedSessionRef(serverId: string, id: string | undefined): string | undefined {
  if (!id) return undefined
  return isRemoteKey(id) ? id : resourceKey('session', serverId, id)
}
type DesktopLayout = { groups: SessionGroup[]; displayOrder: string[] }
const bases = new Map<string, DesktopLayout>()
const pipelines = new Map<string, SavePipeline<LayoutSnapshot>>()
const connected = (id: string): boolean =>
  useFleetStore.getState().statuses[id]?.state === 'connected'
const layoutFor = (serverId: string): DesktopLayout => {
  const state = partitionLayout(useSessionStore.getState(), serverId)
  const files = new Set(state.fileTabs.map((f) => f.id))
  return {
    groups: state.groups.map((g) => ({
      ...g,
      collapsed: false,
      sessionIds: g.sessionIds.filter((id) => !files.has(id))
    })),
    displayOrder: state.displayOrder.filter((id) => !files.has(id))
  }
}
function applyLayout(serverId: string, snapshot: LayoutSnapshot): void {
  const base = bases.get(serverId)
  const current = layoutFor(serverId)
  const server = JSON.parse(
    JSON.stringify({ groups: snapshot.groups, displayOrder: snapshot.displayOrder })
  ) as DesktopLayout
  const merged = base ? mergeLayouts(base, current, server) : { ...server, dropped: [] }
  bases.set(serverId, server)
  useSessionStore.setState((state) => {
    const collapsed = new Map(state.groups.map((g) => [g.id, g.collapsed]))
    const files = new Set(state.fileTabs.map((f) => f.id))
    const groups = merged.groups.map((g) => ({
      ...g,
      sessionIds: [
        ...g.sessionIds,
        ...(state.groups.find((old) => old.id === g.id)?.sessionIds.filter((id) => files.has(id)) ??
          [])
      ],
      collapsed: collapsed.get(g.id) ?? false
    })) as SessionGroup[]
    const remainingOrder = state.displayOrder.filter(
      (id) => ownerOf(id) !== serverId || state.fileTabs.some((f) => f.id === id)
    )
    return {
      groups: [...state.groups.filter((g) => ownerOf(g.id) !== serverId), ...groups],
      displayOrder: [...remainingOrder, ...merged.displayOrder]
    }
  })
}
function pipeline(serverId: string): SavePipeline<LayoutSnapshot> {
  let p = pipelines.get(serverId)
  if (p) return p
  p = createSavePipeline<DesktopLayout, LayoutSnapshot>({
    current: () => {
      if (!connected(serverId) || !bases.has(serverId)) return null
      const layout = layoutFor(serverId)
      return JSON.stringify(layout) === JSON.stringify(bases.get(serverId)) ? null : layout
    },
    send: async (layout, revision) => {
      try {
        const result = await window.electronAPI.fleetSaveLayout(serverId, layout, revision)
        return { ok: true, revision: result.revision }
      } catch (error) {
        // Bridge errors lose tagged properties across contextBridge. Fetch the actual current revision.
        const current = await window.electronAPI.fleetSnapshot(serverId)
        if (current.layout.revision !== revision)
          return { ok: false, reason: 'conflict', current: current.layout }
        throw error
      }
    },
    apply: (snapshot) => applyLayout(serverId, snapshot),
    accepted: (layout) => {
      bases.set(serverId, layout)
    }
  })
  pipelines.set(serverId, p)
  return p
}
/**
 * A server's sessions as a snapshot lists them. A snapshot is read at every
 * connection (the catch-up after a socket died) and at every `session.*`
 * event, so it may be the first this desktop hears of a turn that ended while
 * it was away: a tab it knew as working, now at rest and not in view, is
 * marked unread here as `setAgentState` would have (PRDCT-4668).
 * `cached` is the boot path that applies the snapshot kept in localStorage:
 * its sessions are listed, but what ran then is not what runs now, so they
 * carry no agent state until the first live snapshot says.
 */
/**
 * What the cached snapshot said each session was doing when the app last ran,
 * kept out of sight: the first live snapshot of that server compares with it
 * when the tab carries no state, so a turn that ended while the app was quit
 * is still marked unread. Read once, then forgotten for that server.
 */
const cachedStates = new Map<string, Session['agentState']>()

/**
 * The tabs of a server whose close is under way (PRDCT-5315): their rows left
 * the sidebar the moment the person confirmed, and the server still lists
 * them until its stop returns. A snapshot landing in between leaves them out,
 * or the row would come back for the length of the stop. Released when the
 * stop returns, either way: a failed stop puts the tab back itself.
 */
const closingTabs = new Set<string>()
export function holdClosingTab(id: string): void {
  closingTabs.add(id)
}
export function releaseClosingTab(id: string): void {
  closingTabs.delete(id)
}

export function applyFleetSnapshot(
  snapshot: FleetSnapshot,
  options?: { readonly cached?: boolean }
): void {
  const cached = options?.cached === true
  const owner = snapshot.serverId
  if (cached)
    for (const s of snapshot.sessions)
      cachedStates.set(s.id, s.state === 'ended' ? undefined : s.state)
  // The live apply takes this server's cached states, once.
  const remembered = new Map<string, Session['agentState']>()
  if (!cached)
    for (const [id, value] of cachedStates)
      if (ownerOf(id) === owner) {
        remembered.set(id, value)
        cachedStates.delete(id)
      }
  if (!cached)
    try {
      const saved = JSON.parse(localStorage.getItem('clave-fleet-snapshots') ?? '{}')
      saved[snapshot.serverId] = snapshot
      localStorage.setItem('clave-fleet-snapshots', JSON.stringify(saved))
    } catch {
      /* unavailable browser storage does not block live discovery */
    }
  const serverId = snapshot.serverId
  const stateById = new Map(snapshot.sessions.map((s) => [s.id, s]))
  const records = new Map(snapshot.records.map((r) => [r.id, r]))
  const ids = new Set([...stateById.keys(), ...records.keys()].filter((id) => !closingTabs.has(id)))
  useSessionStore.setState((state) => {
    const previous = new Map<string, Session>(state.sessions.map((s) => [s.id, s] as const))
    const sessions: Session[] = [...ids].map((id) => {
      const wire = stateById.get(id)
      const record = records.get(id)
      const old = previous.get(id)
      const cwd = record?.cwd ?? wire?.cwd ?? old?.cwd ?? '/'
      const agentState = cached || wire?.state === 'ended' ? undefined : wire?.state
      const before = old?.agentState ?? remembered.get(id)
      const unread =
        !cached &&
        old !== undefined &&
        finishesTurn(before, agentState) &&
        !state.selectedSessionIds.includes(id)
      return {
        ...old,
        id,
        cwd,
        folderName: record?.folderName ?? cwd.split('/').pop() ?? cwd,
        name: record?.displayName ?? wire?.title ?? record?.folderName ?? old?.name ?? 'Session',
        alive: wire ? wire.state !== 'ended' : record?.running === true,
        // No dormant flag: mounting a recovered remote chat must never resume it.
        dormant: false,
        restoring: false,
        restartEpoch:
          old && !old.alive && wire && wire.state !== 'ended'
            ? (old.restartEpoch ?? 0) + 1
            : old?.restartEpoch,
        activityStatus: old?.activityStatus ?? 'idle',
        // Derived from the stream on this desktop, never from a snapshot: one
        // runs at every `session.*` event and must not wipe a prompt shown.
        promptWaiting: old?.promptWaiting ?? null,
        hasUnseenActivity: unread || (old?.hasUnseenActivity ?? false),
        agentState,
        claudeMode: record?.claudeMode ?? wire?.provider === 'claude',
        antigravityMode: record?.antigravityMode ?? wire?.provider === 'antigravity',
        codexMode: record?.codexMode ?? wire?.provider === 'codex',
        piMode: record?.piMode ?? wire?.provider === 'pi',
        opencodeMode: record?.opencodeMode ?? wire?.provider === 'opencode',
        claudeAgentsMode: record?.claudeAgentsMode ?? false,
        dangerousMode: record?.dangerousMode ?? false,
        sessionType: 'local',
        model: record?.model,
        claudeSessionId: record?.claudeSessionId ?? null,
        piSessionId: record?.piSessionId ?? null,
        launchProfileId: record?.launchProfileId,
        claudeProfileId: record?.claudeProfileId,
        claudeProfileLabel: record?.claudeProfileLabel,
        claudeConfigDir: record?.configDir,
        codexAccountId: record?.codexAccountId,
        codexAccountLabel: record?.codexAccountLabel,
        piProvider: record?.piProvider,
        piThinking: record?.piThinking,
        workspaceId: record?.workspaceId,
        // Who opened it on its server and which tab it is nested under, as
        // this window names that server's tabs (PRDCT-4193): the sidebar's
        // fold and the name tie-break compare keys. Keyed once, whichever
        // side already did (`ownedSessionRef`).
        spawnedBy: ownedSessionRef(serverId, record?.spawnedBy),
        openedBy: ownedSessionRef(serverId, record?.openedBy),
        // The writing style its agent was given, as its server's record keeps
        // it (PRDCT-5166), so this window's clave_list says it.
        writingStyle: record?.writingStyle,
        userRenamed: record?.userRenamed ?? false,
        planFilePath: old?.planFilePath ?? null,
        // A remote localhost page cannot be interpreted as a Mac-local preview.
        view: record?.view
          ? {
              ...record.view,
              serverSessionId:
                snapshot.records.find(
                  (r) => r.link?.kind === 'session-view' && r.link.ownerId === id
                )?.id ?? null
            }
          : undefined,
        detectedUrl: null,
        serverStatus: null,
        serverCommand: null
      }
    })
    const all = [...state.sessions.filter((s) => ownerOf(s.id) !== serverId), ...sessions]
    const removed = new Set(
      state.sessions.filter((s) => ownerOf(s.id) === serverId && !ids.has(s.id)).map((s) => s.id)
    )
    return {
      sessions: all,
      selectedSessionIds: state.selectedSessionIds.filter((id) => !removed.has(id)),
      focusedSessionId:
        state.focusedSessionId && removed.has(state.focusedSessionId)
          ? null
          : state.focusedSessionId
    }
  })
  const p = pipeline(serverId)
  if (!bases.has(serverId)) {
    p.setRevision(snapshot.layout.revision)
    applyLayout(serverId, snapshot.layout)
  } else if (snapshot.layout.revision < p.revision()) {
    // A server restart can reset an in-memory revision. Re-establish its authoritative base.
    p.setRevision(snapshot.layout.revision)
    bases.delete(serverId)
    applyLayout(serverId, snapshot.layout)
  } else p.incoming(snapshot.layout)
}
let started = false
export function startDesktopFleet(): void {
  if (started || !window.electronAPI?.fleetList) return
  started = true
  const api = window.electronAPI
  api.onFleetSnapshot(applyFleetSnapshot)
  api.onFleetRequests(({ serverId, pending }) =>
    useFleetStore.setState((s) => ({ requests: { ...s.requests, [serverId]: pending } }))
  )
  api.onFleetStatus((status) => {
    useFleetStore.setState((s) => ({
      statuses: { ...s.statuses, [status.serverId]: status },
      ...(status.state !== 'connected'
        ? { requests: { ...s.requests, [status.serverId]: [] } }
        : {})
    }))
  })
  api.onFleetConnectionsChanged((connections) => {
    useFleetStore.setState({ connections })
    const retained = new Set(connections.map((c) => c.id))
    try {
      const saved = JSON.parse(localStorage.getItem('clave-fleet-snapshots') ?? '{}') as Record<
        string,
        FleetSnapshot
      >
      for (const id of Object.keys(saved)) if (!retained.has(id)) delete saved[id]
      localStorage.setItem('clave-fleet-snapshots', JSON.stringify(saved))
      for (const id of retained)
        if (!bases.has(id) && saved[id]) applyFleetSnapshot(saved[id], { cached: true })
    } catch {
      /* live reads remain authoritative */
    }
    useSessionStore.setState((s) => ({
      sessions: s.sessions.filter(
        (v) => ownerOf(v.id) === LOCAL_SERVER_ID || retained.has(ownerOf(v.id))
      ),
      fileTabs: s.fileTabs.filter(
        (f) => ownerOf(f.id) === LOCAL_SERVER_ID || retained.has(ownerOf(f.id))
      ),
      selectedSessionIds: s.selectedSessionIds.filter(
        (id) => ownerOf(id) === LOCAL_SERVER_ID || retained.has(ownerOf(id))
      ),
      focusedSessionId:
        s.focusedSessionId &&
        (ownerOf(s.focusedSessionId) === LOCAL_SERVER_ID ||
          retained.has(ownerOf(s.focusedSessionId)))
          ? s.focusedSessionId
          : null,
      groups: s.groups.filter(
        (g) => ownerOf(g.id) === LOCAL_SERVER_ID || retained.has(ownerOf(g.id))
      ),
      displayOrder: s.displayOrder.filter(
        (id) => ownerOf(id) === LOCAL_SERVER_ID || retained.has(ownerOf(id))
      )
    }))
  })
  useSessionStore.subscribe((state, previous) => {
    if (state.groups === previous.groups && state.displayOrder === previous.displayOrder) return
    for (const p of pipelines.values()) p.save()
  })
  void api
    .fleetList()
    .then((connections) => useFleetStore.setState({ connections }), reportFleetError)
  // ── Issue #266: the servers' versions, read by main ──
  api.onFleetServerVersions?.(applyServerVersions)
  void api.fleetServerVersions?.().then(applyServerVersions, () => undefined)
}
