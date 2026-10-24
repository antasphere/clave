import { createFleetClient } from '@clave/client/fleet'
import type { Backing, Endpoint } from '@clave/client/router'
import {
  FLEET_IPC,
  LOCAL_SERVER_ID,
  parseResourceKey,
  parseSessionKey,
  resourceKey,
  sessionKey,
  type SavedServerConnection,
  type ServerConnectionStatus
} from '@clave/contract/fleet'
import type { LayoutSnapshot, WindowLayout } from '@clave/contract/sidebar'
import type { SessionWrite } from '@clave/contract/sessions'
import type { AttachmentSource as FileAttachmentSource } from '@clave/contract/files'
import type { ServerEvent } from '@clave/contract/events'
import type { SessionEvent, SessionStream, SessionInput } from '../shared/session-model'
import type { Attachment, AttachmentSource } from '../shared/attachments'
import { BUILT_IN_LAUNCH_PROFILES } from '../shared/agent-launch'
import type { Workspace } from '../shared/workspace-types'
import type { ElectronAPI, SessionRecord, SessionInfo } from './index.d'
import type { FleetDesktopAPI, FleetSnapshot, FleetRequests, FleetWorkspaces } from './fleet-types'

interface FleetPorts {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  changed(callback: () => void): () => void
  connect(endpoint: Endpoint): Promise<Backing>
}
const noop = (): void => {}
const remote = (id: string): boolean => parseSessionKey(id).serverId !== LOCAL_SERVER_ID
const key = (serverId: string, id: string): string => sessionKey({ serverId, sessionId: id })

/** Only identities are transformed. Paths and transcript contents remain wire data. */
export function ownedLayout(serverId: string, layout: LayoutSnapshot): LayoutSnapshot {
  const groups = new Set(layout.groups.map((g) => g.id))
  return {
    ...layout,
    groups: layout.groups.map((g) => ({
      ...g,
      id: resourceKey('group', serverId, g.id),
      sessionIds: g.sessionIds.map((id) => key(serverId, id)),
      workspaceId: g.workspaceId ? resourceKey('workspace', serverId, g.workspaceId) : undefined,
      terminals: g.terminals.map((t) => ({
        ...t,
        sessionId: t.sessionId ? key(serverId, t.sessionId) : null
      }))
    })),
    displayOrder: layout.displayOrder.map((id) =>
      resourceKey(groups.has(id) ? 'group' : 'session', serverId, id)
    )
  }
}
export function wireLayout(serverId: string, layout: WindowLayout): WindowLayout {
  const decode = (kind: 'session' | 'group' | 'workspace', value: string): string => {
    const ref = parseResourceKey(kind, value)
    if (ref.serverId !== serverId)
      throw new Error('A shared layout cannot contain another server owner.')
    return ref.id
  }
  const groupIds = new Set(layout.groups.map((g) => g.id))
  return {
    groups: layout.groups.map((g) => ({
      ...g,
      id: decode('group', g.id),
      collapsed: false,
      sessionIds: g.sessionIds.map((id) => decode('session', id)),
      workspaceId: g.workspaceId ? decode('workspace', g.workspaceId) : undefined,
      terminals: g.terminals.map((t) => ({
        ...t,
        sessionId: t.sessionId ? decode('session', t.sessionId) : null
      }))
    })),
    displayOrder: layout.displayOrder.map((id) =>
      decode(groupIds.has(id) ? 'group' : 'session', id)
    )
  }
}

/** Preserve the existing local bridge; remote IDs can only reach their exact backing. */
export function createFleetDesktop(local: ElectronAPI, ports: FleetPorts): ElectronAPI {
  const snapshotListeners = new Set<(snapshot: FleetSnapshot) => void>()
  const requestListeners = new Set<(snapshot: FleetRequests) => void>()
  const statusListeners = new Set<(status: ServerConnectionStatus) => void>()
  const connectionListeners = new Set<(connections: SavedServerConnection[]) => void>()
  const workspaceListeners = new Set<(update: FleetWorkspaces) => void>()
  let connections: SavedServerConnection[] = []
  const watched = new Map<string, { backing: Backing; off: () => void }>()
  const pendingSnapshots = new Map<string, Promise<FleetSnapshot>>()
  const queuedSnapshots = new Set<string>()
  const lastSnapshots = new Map<string, FleetSnapshot>()
  const streamRefs = new Map<string, { refs: number; release: () => void }>()
  const chains = new Map<string, Promise<void>>()
  const attachmentSessions = new Map<string, string>()
  const generations = new Map<string, number>()
  const invalidate = (serverId: string): void => {
    generations.set(serverId, (generations.get(serverId) ?? 0) + 1)
    pendingSnapshots.delete(serverId)
    queuedSnapshots.delete(serverId)
    for (const [id, held] of streamRefs)
      if (parseSessionKey(id).serverId === serverId) {
        held.release()
        streamRefs.delete(id)
      }
  }
  const fleet = createFleetClient({
    resolve: async (serverId) =>
      (await ports.invoke(FLEET_IPC.endpoint, serverId)) as Endpoint | null,
    connect: (endpoint) => ports.connect(endpoint)
  })
  const backing = (serverId: string): Promise<Backing> => fleet.backing(serverId)
  const scopeRecord = (serverId: string, record: SessionRecord): SessionRecord => ({
    ...record,
    id: key(serverId, record.id),
    workspaceId: record.workspaceId
      ? resourceKey('workspace', serverId, record.workspaceId)
      : undefined,
    link:
      record.link?.kind === 'group-terminal'
        ? { ...record.link, groupId: resourceKey('group', serverId, record.link.groupId) }
        : record.link?.kind === 'session-view'
          ? { ...record.link, ownerId: key(serverId, record.link.ownerId) }
          : record.link
  })
  const watchRequests = (serverId: string, b: Backing): void => {
    if (watched.get(serverId)?.backing === b) return
    watched.get(serverId)?.off()
    const off = b.api.requests.watch(
      b.push,
      (snapshot) => {
        const scoped: FleetRequests = {
          serverId,
          revision: snapshot.revision,
          pending: snapshot.pending.map((r) => ({
            ...r,
            id: resourceKey('request', serverId, r.id),
            sessionId: key(serverId, r.sessionId)
          }))
        }
        for (const listener of requestListeners) listener(scoped)
      },
      noop
    )
    watched.set(serverId, { backing: b, off })
  }
  const snapshot = (serverId: string): Promise<FleetSnapshot> => {
    const running = pendingSnapshots.get(serverId)
    if (running) return running
    const generation = generations.get(serverId) ?? 0
    const read = (async (): Promise<FleetSnapshot> => {
      const b = await backing(serverId)
      watchRequests(serverId, b)
      const [sessions, records, layout] = await Promise.all([
        b.api.sessions.list(),
        b.api.sessions.listAdoptable(),
        b.api.sidebar.getLayout('server')
      ])
      const result: FleetSnapshot = {
        serverId,
        sessions: sessions.map((s) => ({
          ...s,
          id: key(serverId, s.id),
          groupId: s.groupId ? resourceKey('group', serverId, s.groupId) : undefined
        })),
        records: records.map((r) => scopeRecord(serverId, r as SessionRecord)),
        layout: ownedLayout(serverId, layout)
      }
      if (
        generation !== (generations.get(serverId) ?? 0) ||
        !connections.some((c) => c.id === serverId && c.enabled)
      )
        throw new Error('Server discovery was cancelled.')
      lastSnapshots.set(serverId, result)
      for (const listener of snapshotListeners) listener(result)
      return result
    })()
    pendingSnapshots.set(serverId, read)
    void read
      .finally(() => {
        if (pendingSnapshots.get(serverId) !== read) return
        pendingSnapshots.delete(serverId)
        if (queuedSnapshots.delete(serverId)) refresh(serverId)
      })
      .catch(noop)
    return read
  }
  const refresh = (serverId: string): void => {
    if (pendingSnapshots.has(serverId)) {
      queuedSnapshots.add(serverId)
      return
    }
    void snapshot(serverId).catch(noop)
  }
  // ── Server workspaces (#241) ──────────────────────────────────────────────
  // A server keeps its own workspace registry; the desktop reads it per
  // server, wraps each id as a remote key, and hears every change through the
  // server's `workspaces.state_changed` event. What reaches the renderer is
  // ordered by arrival, since two instances of a restarted server carry no
  // order between them: a push comes over the one live socket, in order, and
  // is always taken (unless the same instance already sent a newer one); a
  // read or a write answer is taken only when no push arrived after it was
  // sent and no answer sent later has been taken already. A slow answer, from
  // the same instance or from one the server has since been restarted out of,
  // never rolls back a newer list, and of two answers in flight the one sent
  // last wins whatever their order. A write replaces the server's whole list, so it is made against the
  // stamp it read and the server refuses it as `stale` when another Mac wrote
  // in between; it is then read and applied again.
  type Stamp = { revision: number; instance: string }
  const stamps = new Map<string, Stamp>()
  /** Per server: how many pushes were taken, the last request number handed
   *  out, and the request number of the last answer taken. */
  const pushes = new Map<string, number>()
  const requests = new Map<string, number>()
  const answered = new Map<string, number>()
  type Sent = { pushes: number; request: number }
  const sending = (serverId: string): Sent => {
    const request = (requests.get(serverId) ?? 0) + 1
    requests.set(serverId, request)
    return { pushes: pushes.get(serverId) ?? 0, request }
  }
  const scopeWorkspace = (serverId: string, ws: Workspace): Workspace => ({
    id: resourceKey('workspace', serverId, ws.id),
    name: ws.name,
    rootDir: ws.rootDir,
    profileFile: ws.profileFile,
    createdAt: ws.createdAt
  })
  /** `sent` is what a read or a write noted when it went out; a push has none. */
  const publishWorkspaces = (
    serverId: string,
    list: readonly Workspace[],
    stamp: Stamp,
    sent?: Sent
  ): Workspace[] => {
    const workspaces = list.map((ws) => scopeWorkspace(serverId, ws))
    if (
      sent &&
      (sent.pushes !== (pushes.get(serverId) ?? 0) || sent.request < (answered.get(serverId) ?? 0))
    )
      return workspaces
    const last = stamps.get(serverId)
    if (last && last.instance === stamp.instance && stamp.revision < last.revision)
      return workspaces
    stamps.set(serverId, { revision: stamp.revision, instance: stamp.instance })
    if (sent) answered.set(serverId, sent.request)
    else pushes.set(serverId, (pushes.get(serverId) ?? 0) + 1)
    for (const listener of workspaceListeners) listener({ serverId, workspaces })
    return workspaces
  }
  const loadWorkspaces = async (serverId: string): Promise<Workspace[]> => {
    const b = await backing(serverId)
    const sent = sending(serverId)
    const state = await b.api.settings.workspaces.load()
    return publishWorkspaces(serverId, state.workspaces as Workspace[], state, sent)
  }
  const registryChains = new Map<string, Promise<unknown>>()
  const STALE_RETRIES = 5
  const editRegistry = <T>(
    serverId: string,
    edit: (current: Workspace[]) => { next: Workspace[]; result: T }
  ): Promise<T> => {
    const run = (registryChains.get(serverId) ?? Promise.resolve()).catch(noop).then(async () => {
      const b = await backing(serverId)
      for (let attempt = 0; ; attempt++) {
        const state = await b.api.settings.workspaces.load()
        const { next, result } = edit([...(state.workspaces as Workspace[])])
        const sent = sending(serverId)
        const written = await b.api.settings.workspaces.updateRegistry(next, undefined, {
          revision: state.revision,
          instance: state.instance
        })
        if (written.ok) {
          publishWorkspaces(serverId, written.workspaces as Workspace[], written, sent)
          return result
        }
        if (written.reason !== 'stale' || attempt >= STALE_RETRIES)
          throw new Error('The server refused the workspace list.')
      }
    })
    registryChains.set(serverId, run)
    return run
  }
  const insideRoot = (root: string, p: string): boolean =>
    p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`)
  fleet.onStatus((status) => {
    for (const listener of statusListeners) listener(status)
    if (status.state === 'connected') {
      invalidate(status.serverId)
      refresh(status.serverId)
      void loadWorkspaces(status.serverId).catch(noop)
    }
  })
  fleet.onEvent(({ serverId, value }) => {
    const tag = value.event._tag
    if (tag === 'sidebar.layout_changed' || tag.startsWith('session.')) refresh(serverId)
    if (value.event._tag === 'workspaces.state_changed')
      publishWorkspaces(serverId, value.event.workspaces as Workspace[], value.event)
  })
  let savedRead: Promise<SavedServerConnection[]> | null = null
  let watchingChanges = false
  let syncQueued = false
  const sync = (): Promise<SavedServerConnection[]> => {
    if (!watchingChanges) {
      watchingChanges = true
      ports.changed(() => {
        void sync().catch(noop)
      })
    }
    if (savedRead) {
      syncQueued = true
      return savedRead
    }
    const run = (async () => {
      const next = (await ports.invoke(FLEET_IPC.list)) as SavedServerConnection[] | null
      const previous = connections
      connections = Array.isArray(next) ? next : []
      for (const old of previous) {
        if (!connections.some((c) => c.id === old.id && c.enabled)) {
          invalidate(old.id)
          if (!connections.some((c) => c.id === old.id)) lastSnapshots.delete(old.id)
          watched.get(old.id)?.off()
          watched.delete(old.id)
          await fleet.disconnect(old.id)
        }
      }
      for (const listener of connectionListeners) listener(connections)
      // One stalled owner cannot hold back discovery or any other owner's boot.
      for (const connection of connections) {
        if (connection.enabled) void fleet.connect(connection.id).catch(noop)
      }
      return connections
    })()
    savedRead = run
    void run
      .finally(() => {
        if (savedRead === run) savedRead = null
        if (syncQueued) {
          syncQueued = false
          void sync().catch(noop)
        }
      })
      .catch(noop)
    return run
  }
  const route = async <T>(
    id: string,
    localCall: (id: string) => Promise<T>,
    call: (b: Backing, wireId: string) => Promise<T>
  ): Promise<T> => {
    const ref = parseSessionKey(id)
    return ref.serverId === LOCAL_SERVER_ID
      ? localCall(ref.sessionId)
      : call(await backing(ref.serverId), ref.sessionId)
  }
  const listen = <T>(
    id: string,
    localCall: () => () => void,
    bind: (b: Backing, wireId: string, callback: (value: T) => void) => () => void,
    callback: (value: T) => void
  ): (() => void) => {
    const ref = parseSessionKey(id)
    if (ref.serverId === LOCAL_SERVER_ID) return localCall()
    let gone = false
    let off = noop
    let bound: Backing | null = null
    const bindCurrent = (): void => {
      void backing(ref.serverId).then((b) => {
        if (gone || bound === b) return
        off()
        bound = b
        off = bind(b, ref.sessionId, callback)
      }, noop)
    }
    const stopStatus = fleet.onStatus((status) => {
      if (status.serverId !== ref.serverId) return
      if (status.state === 'connected') bindCurrent()
      if (status.state === 'disconnected') {
        off()
        off = noop
        bound = null
      }
    })
    bindCurrent()
    return () => {
      gone = true
      stopStatus()
      off()
    }
  }
  const terminal = (
    id: string,
    localCall: () => void | Promise<void>,
    call: (b: Backing, wireId: string) => Promise<void>
  ): Promise<void> => {
    if (!remote(id)) return Promise.resolve(localCall())
    const next = (chains.get(id) ?? Promise.resolve())
      .catch(noop)
      .then(() => route(id, async () => {}, call))
    chains.set(id, next)
    void next
      .finally(() => {
        if (chains.get(id) === next) chains.delete(id)
      })
      .catch(noop)
    return next
  }
  const fileLocation = (
    root: string,
    path: string
  ): { serverId: string; root: string; path: string } => {
    const ref = parseResourceKey('file', root)
    const file = path.startsWith('clave-owner:')
      ? parseResourceKey('file', path)
      : { serverId: ref.serverId, id: path }
    if (file.serverId !== ref.serverId)
      throw new Error('File and root have different server owners.')
    return { serverId: ref.serverId, root: ref.id, path: file.id }
  }
  const fileRoute = async <T>(
    root: string,
    path: string,
    localCall: () => Promise<T>,
    call: (b: Backing, location: { root: string; path: string }) => Promise<T>
  ): Promise<T> => {
    const location = fileLocation(root, path)
    return location.serverId === LOCAL_SERVER_ID
      ? localCall()
      : call(await backing(location.serverId), location)
  }
  const scopeEvent = (sessionId: string, event: SessionEvent): SessionEvent => {
    if (event.type !== 'user_message' || !event.attachments) return event
    const ref = parseSessionKey(sessionId)
    return {
      ...event,
      attachments: event.attachments.map((file) => {
        const path = resourceKey('file', ref.serverId, file.path)
        attachmentSessions.set(path, ref.sessionId)
        return { ...file, path }
      })
    }
  }
  const wireOptions = async (
    serverId: string,
    options: Parameters<ElectronAPI['spawnSession']>[1]
  ): Promise<Parameters<ElectronAPI['spawnSession']>[1]> => {
    if (!options) return options
    if (options.adoptSessionId)
      throw new Error('Remote recovered sessions require explicit Resume.')
    const decode = (kind: 'workspace' | 'group' | 'session', id: string): string => {
      const ref = parseResourceKey(kind, id)
      if (ref.serverId !== serverId) throw new Error('Launch context belongs to another server.')
      return ref.id
    }
    const decoded = {
      ...options,
      workspaceId: options.workspaceId ? decode('workspace', options.workspaceId) : undefined,
      link:
        options.link?.kind === 'group-terminal'
          ? { ...options.link, groupId: decode('group', options.link.groupId) }
          : options.link?.kind === 'session-view'
            ? { ...options.link, ownerId: decode('session', options.link.ownerId) }
            : options.link
    }
    if (options.launchProfileId && !options.launchProfile) {
      const prefs = await local.launchProfilesList()
      const profile = [...BUILT_IN_LAUNCH_PROFILES, ...prefs.customProfiles].find(
        (profile) => profile.id === options.launchProfileId
      )
      if (profile)
        decoded.launchProfile = {
          id: profile.id,
          name: profile.name,
          family: profile.family,
          command: [...profile.command],
          additionalArgs: [...profile.additionalArgs],
          ...(profile.sourceProfileId ? { sourceProfileId: profile.sourceProfileId } : {}),
          ...(profile.pi ? { pi: profile.pi } : {})
        }
    }
    return decoded
  }
  const eventListener = <T extends ServerEvent['_tag']>(
    tag: T,
    callback: (event: Extract<ServerEvent, { _tag: T }>, serverId: string) => void
  ): (() => void) =>
    fleet.onEvent(({ serverId, value }) => {
      if (value.event._tag === tag)
        callback(value.event as Extract<ServerEvent, { _tag: T }>, serverId)
    })
  const both =
    (a: () => void, b: () => void): (() => void) =>
    () => {
      a()
      b()
    }
  const shared: FleetDesktopAPI = {
    fleetList: sync,
    fleetSave: async (input) => {
      const saved = (await ports.invoke(FLEET_IPC.save, input)) as SavedServerConnection
      if (input.id) {
        invalidate(input.id)
        watched.get(input.id)?.off()
        watched.delete(input.id)
        await fleet.disconnect(input.id)
      }
      await sync()
      return saved
    },
    fleetConnect: async (id) => {
      await ports.invoke(FLEET_IPC.connect, id)
      await sync()
      await fleet.connect(id)
    },
    fleetDisconnect: async (id) => {
      invalidate(id)
      await ports.invoke(FLEET_IPC.disconnect, id)
      watched.get(id)?.off()
      watched.delete(id)
      await fleet.disconnect(id)
      await sync()
    },
    fleetRemove: async (id) => {
      invalidate(id)
      lastSnapshots.delete(id)
      await ports.invoke(FLEET_IPC.remove, id)
      watched.get(id)?.off()
      watched.delete(id)
      await fleet.remove(id)
      await sync()
    },
    fleetSnapshot: snapshot,
    fleetStart: async (serverId, cwd, options) => {
      if (serverId === LOCAL_SERVER_ID) return local.spawnSession(cwd, options)
      const b = await backing(serverId)
      const info = await b.api.sessions.start({
        cwd,
        options: await wireOptions(serverId, options)
      })
      refresh(serverId)
      return { ...info, id: key(serverId, info.id) } as SessionInfo
    },
    fleetLaunchSettings: async (serverId) => {
      const { api } = await backing(serverId)
      const [profiles, claudeAccounts, codexAccounts] = await Promise.all([
        api.settings.launchProfiles.list(),
        api.settings.claudeAccounts.list(),
        api.settings.codexAccounts.list()
      ])
      return {
        profiles: profiles as LaunchSettings['profiles'],
        claudeAccounts: [...claudeAccounts],
        codexAccounts: [...codexAccounts]
      }
    },
    fleetSaveLayout: async (serverId, layout, baseRevision) => {
      const b = await backing(serverId)
      const result = await b.api.sidebar.saveLayout({
        windowKey: 'server',
        baseRevision,
        ...wireLayout(serverId, layout)
      })
      return ownedLayout(serverId, result)
    },
    fleetWorkspaces: loadWorkspaces,
    fleetAddWorkspace: async (serverId, input) => {
      const rootDir = input.rootDir.trim().replace(/(.)\/+$/, '$1')
      if (!rootDir.startsWith('/')) throw new Error('Choose an absolute folder on the server.')
      const b = await backing(serverId)
      const info = await b.api.files.stat({ root: '/', path: rootDir })
      if (info.type !== 'directory') throw new Error('That path on the server is not a folder.')
      return editRegistry(serverId, (current) => {
        if (
          current.some((ws) => insideRoot(ws.rootDir, rootDir) || insideRoot(rootDir, ws.rootDir))
        )
          throw new Error('That folder overlaps a workspace already on this server.')
        const base = rootDir.split('/').pop()?.replace(/^\.+/, '') ?? ''
        const ws: Workspace = {
          id: crypto.randomUUID(),
          name:
            input.name?.trim() || (base ? base.charAt(0).toUpperCase() + base.slice(1) : rootDir),
          rootDir,
          profileFile: input.profileFile ?? null,
          createdAt: Date.now()
        }
        return { next: [...current, ws], result: scopeWorkspace(serverId, ws) }
      })
    },
    fleetRemoveWorkspace: async (workspaceId) => {
      const ref = parseResourceKey('workspace', workspaceId)
      if (ref.serverId === LOCAL_SERVER_ID) throw new Error('Not a server workspace.')
      await editRegistry(ref.serverId, (current) => ({
        next: current.filter((ws) => ws.id !== ref.id),
        result: undefined
      }))
    },
    fleetResolve: async (requestKey, response) => {
      const ref = parseResourceKey('request', requestKey)
      const b = await backing(ref.serverId)
      return b.api.requests.resolve({ requestId: ref.id, response })
    },
    fleetDownload: (root, path, open = false) =>
      fileRoute(
        root,
        path,
        async () => {
          throw new Error('Use local file actions for local files.')
        },
        async (b, location) => {
          const file = await b.api.files.download(location)
          await ports.invoke(open ? 'fs:open-download' : 'fs:save-download', file)
        }
      ),
    fleetUpload: (root, path, sourcePath) =>
      fileRoute(
        root,
        path,
        async () => {
          throw new Error('Use local file actions for local files.')
        },
        async (b, location) => {
          const source = (await ports.invoke('sessions:files', {
            type: 'upload-source',
            source: { path: sourcePath }
          })) as Extract<FileAttachmentSource, { kind: 'upload' }>
          await b.api.files.upload({ ...location, base64: source.base64 })
        }
      ),
    onFleetSnapshot: (callback) => {
      snapshotListeners.add(callback)
      return () => {
        snapshotListeners.delete(callback)
      }
    },
    onFleetRequests: (callback) => {
      requestListeners.add(callback)
      return () => {
        requestListeners.delete(callback)
      }
    },
    onFleetStatus: (callback) => {
      statusListeners.add(callback)
      for (const status of fleet.list()) callback(status)
      return () => {
        statusListeners.delete(callback)
      }
    },
    onFleetConnectionsChanged: (callback) => {
      connectionListeners.add(callback)
      return () => {
        connectionListeners.delete(callback)
      }
    },
    onFleetWorkspaces: (callback) => {
      workspaceListeners.add(callback)
      return () => {
        workspaceListeners.delete(callback)
      }
    }
  }
  type LaunchSettings = Awaited<ReturnType<FleetDesktopAPI['fleetLaunchSettings']>>
  const api: ElectronAPI = {
    ...local,
    ...shared,
    sessionsList: async () => {
      const own = await local.sessionsList()
      return [...own, ...connections.flatMap((c) => lastSnapshots.get(c.id)?.sessions ?? [])]
    },
    sessionsHistory: (id, before, limit) =>
      route(
        id,
        (wireId) => local.sessionsHistory(wireId, before, limit),
        async (b, wireId) => {
          const page = await b.api.sessions.history(wireId, before, limit)
          return {
            ...page,
            items: page.items.map((item) => ({
              ...item,
              event: scopeEvent(id, item.event as SessionEvent)
            }))
          }
        }
      ),
    sessionsModels: (id) =>
      route(id, local.sessionsModels, async (b, wireId) =>
        (await b.api.sessions.models(wireId)).map((m) => ({
          ...m,
          efforts: m.efforts ? [...m.efforts] : undefined
        }))
      ),
    sessionsCommands: (id) =>
      route(
        id,
        local.sessionsCommands,
        async (b, wireId) =>
          [...(await b.api.sessions.commands(wireId))] as Awaited<
            ReturnType<ElectronAPI['sessionsCommands']>
          >
      ),
    sessionsCapabilities: (id) =>
      route(id, local.sessionsCapabilities, (b, wireId) => b.api.sessions.capabilities(wireId)),
    sessionsSetView: (id, viewId) =>
      route(
        id,
        (wireId) => local.sessionsSetView(wireId, viewId),
        async (b, wireId) => ({ ...(await b.api.sessions.setView(wireId, viewId)), id })
      ),
    sessionsWrite: (id, input) =>
      route(
        id,
        (wireId) => local.sessionsWrite(wireId, input),
        (b, wireId) =>
          b.api.sessions.write(
            wireId,
            input instanceof Uint8Array ? { type: 'bytes', data: input } : (input as SessionWrite)
          )
      ),
    killSession: (id) =>
      route(id, local.killSession, async (b, wireId) => {
        await b.api.sessions.stop(wireId)
        refresh(parseSessionKey(id).serverId)
      }),
    restartSession: (id, overrides, requestId) =>
      route(
        id,
        (wireId) => local.restartSession(wireId, overrides, requestId),
        async (b, wireId) => {
          const { resendRejected, ...account } = overrides
          const result = await b.api.sessions.restart(wireId, account, resendRejected, requestId)
          refresh(parseSessionKey(id).serverId)
          return { ...result, id } as Awaited<ReturnType<ElectronAPI['restartSession']>>
        }
      ),
    setSessionDisplayName: (id, name, renamed) =>
      route(
        id,
        (wireId) => local.setSessionDisplayName(wireId, name, renamed),
        (b, wireId) =>
          b.api.sessions.keepOnRecord(wireId, { name: { displayName: name, userRenamed: renamed } })
      ),
    setSessionViewRecord: (id, view) =>
      route(
        id,
        (wireId) => local.setSessionViewRecord(wireId, view),
        (b, wireId) => b.api.sessions.keepOnRecord(wireId, { page: view })
      ),
    setSessionWorkspace: (id, workspaceId) =>
      route(
        id,
        (wireId) => local.setSessionWorkspace(wireId, workspaceId),
        (b, wireId) => {
          const ref = workspaceId ? parseResourceKey('workspace', workspaceId) : null
          if (ref && ref.serverId !== parseSessionKey(id).serverId)
            throw new Error('Workspace belongs to another server.')
          return b.api.sessions.keepOnRecord(wireId, { workspaceId: ref?.id ?? null })
        }
      ),
    writeSession: (id, data) =>
      terminal(
        id,
        () => local.writeSession(id, data),
        (b, wireId) =>
          b.api.sessions.write(wireId, { type: 'bytes', data: new TextEncoder().encode(data) })
      ),
    startSession: (id, cols, rows) =>
      terminal(
        id,
        () => local.startSession(id, cols, rows),
        (b, wireId) => b.api.sessions.resize(wireId, cols, rows)
      ),
    resizeSession: (id, cols, rows) =>
      terminal(
        id,
        () => local.resizeSession(id, cols, rows),
        (b, wireId) => b.api.sessions.resize(wireId, cols, rows)
      ),
    sessionsSubscribe: (id) =>
      route(id, local.sessionsSubscribe, async (b, wireId) => {
        let held = streamRefs.get(id)
        if (!held) {
          held = { refs: 0, release: b.push.subscribe(wireId, noop) }
          streamRefs.set(id, held)
        }
        held.refs++
        try {
          return { ...(await b.push.subscribed(wireId)), id } as Awaited<
            ReturnType<ElectronAPI['sessionsSubscribe']>
          >
        } catch (error) {
          if (--held.refs === 0) {
            held.release()
            streamRefs.delete(id)
          }
          throw error
        }
      }),
    sessionsUnsubscribe: async (id) => {
      if (!remote(id)) return local.sessionsUnsubscribe(id)
      const held = streamRefs.get(id)
      if (held && --held.refs === 0) {
        held.release()
        streamRefs.delete(id)
      }
    },
    onSessionStream: (id, cb) =>
      listen(
        id,
        () => local.onSessionStream(id, cb),
        (b, wireId, callback) =>
          b.push.subscribe(wireId, (value) => {
            const stream = value as SessionStream
            callback(
              stream.kind === 'event' ? { ...stream, event: scopeEvent(id, stream.event) } : stream
            )
          }),
        cb
      ),
    onSessionStreamExit: (id, cb) =>
      listen(
        id,
        () => local.onSessionStreamExit(id, cb),
        (b, wireId, callback) => b.push.subscribe(wireId, noop, callback),
        cb
      ),
    onSessionData: (id, cb) =>
      listen(
        id,
        () => local.onSessionData(id, cb),
        (b, wireId, callback) => {
          const decoder = new TextDecoder()
          // The daemon replays its retained terminal checkpoint on each subscription.
          // Reset before welcome's resubscribe so that history replaces old paint.
          const reset = (): void => callback('\x1bc')
          const offStatus = b.push.onStatus((status) => {
            if (status === 'open') reset()
          })
          reset()
          const offStream = b.push.subscribe(wireId, (s) => {
            const stream = s as SessionStream
            if (stream.kind === 'pty') callback(decoder.decode(stream.data, { stream: true }))
          })
          return () => {
            offStatus()
            offStream()
          }
        },
        cb
      ),
    onSessionExit: (id, cb) =>
      listen(
        id,
        () => local.onSessionExit(id, cb),
        (b, wireId, callback) => b.push.subscribe(wireId, noop, callback),
        cb
      ),
    spawnSession: (cwd, options) => {
      const target =
        options?.link?.kind === 'group-terminal'
          ? parseResourceKey('group', options.link.groupId).serverId
          : options?.link?.kind === 'session-view'
            ? parseSessionKey(options.link.ownerId).serverId
            : LOCAL_SERVER_ID
      return target === LOCAL_SERVER_ID
        ? local.spawnSession(cwd, options)
        : shared.fleetStart(target, cwd, options)
    },
    onSessionAutoTitle: (id, cb) =>
      remote(id)
        ? eventListener('session.title_changed', (event, owner) => {
            if (key(owner, event.id) === id) cb(event.title)
          })
        : local.onSessionAutoTitle(id, cb),
    onAgentState: (id, cb) =>
      remote(id)
        ? eventListener('session.state_changed', (event, owner) => {
            if (key(owner, event.id) === id) cb(event.state)
          })
        : local.onAgentState(id, cb),
    onPlanDetected: (id, cb) =>
      remote(id)
        ? eventListener('session.plan_detected', (event, owner) => {
            if (key(owner, event.id) === id) cb(resourceKey('file', owner, event.path))
          })
        : local.onPlanDetected(id, cb),
    onClearDetected: (id, cb) =>
      remote(id)
        ? eventListener('session.cleared', (event, owner) => {
            if (key(owner, event.id) === id) cb(event.providerSessionId)
          })
        : local.onClearDetected(id, cb),
    onSessionRenamed: (cb) =>
      both(
        local.onSessionRenamed(cb),
        eventListener('session.renamed', (event, owner) =>
          cb({ id: key(owner, event.id), name: event.name })
        )
      ),
    onSessionTyped: (cb) =>
      both(
        local.onSessionTyped(cb),
        eventListener('session.typed', (event, owner) =>
          cb({ id: key(owner, event.id), from: event.from })
        )
      ),
    onSessionRestarting: (cb) =>
      both(
        local.onSessionRestarting(cb),
        eventListener('session.restarting', (event, owner) => cb({ id: key(owner, event.id) }))
      ),
    onSessionRestarted: (cb) =>
      both(
        local.onSessionRestarted(cb),
        eventListener('session.restarted', (event, owner) =>
          cb({ ...event, id: key(owner, event.id) })
        )
      ),
    sessionsReportState: (id, state) =>
      remote(id) ? Promise.resolve() : local.sessionsReportState(id, state),
    openPath: async (path) => {
      const ref = parseResourceKey('file', path)
      if (ref.serverId === LOCAL_SERVER_ID) return local.openPath(path)
      await shared.fleetDownload(resourceKey('file', ref.serverId, '/'), ref.id, true)
      return ''
    },
    readImageAsDataUrl: (path) => {
      const ref = parseResourceKey('file', path)
      return ref.serverId === LOCAL_SERVER_ID
        ? local.readImageAsDataUrl(path)
        : backing(ref.serverId).then(
            async (b) =>
              (
                await b.api.files.previewAttachment({
                  sessionId: 'file-preview',
                  root: '/',
                  path: ref.id
                })
              ).image ?? null
          )
    },
    sessionsFiles: {
      ...local.sessionsFiles,
      prepare: (id: string, source: AttachmentSource) =>
        route(
          id,
          (wireId) => local.sessionsFiles.prepare(wireId, source),
          async (b, wireId) => {
            let upload: FileAttachmentSource
            if (source.path?.startsWith('clave-owner:')) {
              const file = parseResourceKey('file', source.path)
              if (file.serverId !== parseSessionKey(id).serverId)
                throw new Error('File belongs to another server.')
              upload = { kind: 'file', root: '/', path: file.id }
            } else
              upload = (await ports.invoke('sessions:files', {
                type: 'upload-source',
                source
              })) as FileAttachmentSource
            const attachment = await b.api.files.prepareAttachment({
              sessionId: wireId,
              source: upload
            })
            return {
              ...attachment,
              path: resourceKey('file', parseSessionKey(id).serverId, attachment.path)
            }
          }
        ),
      preview: async (file: Attachment) => {
        const ref = parseResourceKey('file', file.path)
        if (ref.serverId === LOCAL_SERVER_ID) return local.sessionsFiles.preview(file)
        const { api } = await backing(ref.serverId)
        // Managed attachment paths include their server-local session directory.
        const sessionId = attachmentSessions.get(file.path)
        if (!sessionId) throw new Error('The attachment owner session is required.')
        return api.files.previewAttachment({ sessionId, path: ref.id })
      },
      open: async (file) => {
        const ref = parseResourceKey('file', file.path)
        if (ref.serverId === LOCAL_SERVER_ID) return local.sessionsFiles.open(file)
        const { api } = await backing(ref.serverId)
        await ports.invoke(
          'fs:open-download',
          await api.files.download({ root: '/', path: ref.id })
        )
      }
    },
    listFiles: async (root) => {
      const ref = parseResourceKey('file', root)
      if (ref.serverId === LOCAL_SERVER_ID) return local.listFiles(root)
      const b = await backing(ref.serverId)
      const queue = ['.']
      const files: string[] = []
      let index = 0
      let scanned = 0
      let truncated = false
      while (index < queue.length && index < 100 && scanned < 5000) {
        const listing = await b.api.files.list({ root: ref.id, path: queue[index++] })
        truncated ||= listing.truncated
        for (const entry of listing.entries) {
          if (++scanned > 5000) {
            truncated = true
            break
          }
          if (entry.type === 'file') files.push(entry.path)
          else if (!['.git', 'node_modules'].includes(entry.name)) queue.push(entry.path)
        }
      }
      return { files, truncated: truncated || index < queue.length }
    },
    pluginsViewLease: (pluginId, viewId, id) =>
      remote(id)
        ? Promise.reject(
            new Error('Remote plugin surface views are unavailable. Use a native session view.')
          )
        : local.pluginsViewLease(pluginId, viewId, id),
    // Focus can name a file tab as well as a session. No remote resource is
    // a session hosted by the Mac's plugin runtime.
    pluginsContext: (id) =>
      id?.startsWith('clave-owner:') ? Promise.resolve() : local.pluginsContext(id),
    readDir: (root, path) =>
      fileRoute(
        root,
        path,
        () => local.readDir(root, path),
        async (b, location) =>
          [...(await b.api.files.list(location)).entries] as Awaited<
            ReturnType<ElectronAPI['readDir']>
          >
      ),
    readFile: (root, path) =>
      fileRoute(
        root,
        path,
        () => local.readFile(root, path),
        async (b, location) => ({ ...(await b.api.files.read(location)) })
      ),
    statFile: (root, path) =>
      fileRoute(
        root,
        path,
        () => local.statFile(root, path),
        async (b, location) => ({ ...(await b.api.files.stat(location)) })
      ),
    writeFile: (root, path, content) =>
      fileRoute(
        root,
        path,
        () => local.writeFile(root, path, content),
        (b, location) => b.api.files.write({ ...location, content })
      ),
    createFile: (root, path) =>
      fileRoute(
        root,
        path,
        () => local.createFile(root, path),
        (b, location) => b.api.files.createFile(location)
      ),
    createDirectory: (root, path) =>
      fileRoute(
        root,
        path,
        () => local.createDirectory(root, path),
        (b, location) => b.api.files.createDirectory(location)
      ),
    watchDir: async (root, dirs) => {
      if (parseResourceKey('file', root).serverId === LOCAL_SERVER_ID)
        await local.watchDir(root, dirs)
    },
    showItemInFolder: async (path) => {
      if (parseResourceKey('file', path).serverId !== LOCAL_SERVER_ID)
        throw new Error('Remote files cannot be revealed on this Mac.')
      await local.showItemInFolder(path)
    },
    existsSync: (root, path) => {
      if (parseResourceKey('file', root).serverId !== LOCAL_SERVER_ID)
        throw new Error('Remote filesystem checks are asynchronous.')
      return local.existsSync(root, path)
    }
  }
  const prepare = api.sessionsFiles.prepare
  api.sessionsFiles.prepare = async (id, source) => {
    if (
      source.path?.startsWith('clave-owner:') &&
      parseResourceKey('file', source.path).serverId !== parseSessionKey(id).serverId
    )
      throw new Error('File belongs to another server.')
    const file = await prepare(id, source)
    if (remote(id)) attachmentSessions.set(file.path, parseSessionKey(id).sessionId)
    return file
  }
  // Strip UI attachment identities at the send boundary, without altering message text.
  const write = api.sessionsWrite
  api.sessionsWrite = (id, input) => {
    if (!(input instanceof Uint8Array) && input.type === 'user_message' && input.attachments) {
      const owner = parseSessionKey(id).serverId
      input = {
        ...input,
        attachments: input.attachments.map((file) => {
          const ref = parseResourceKey('file', file.path)
          if (ref.serverId !== owner) throw new Error('Attachment belongs to a different server.')
          return remote(id) ? { ...file, path: ref.id } : file
        })
      } as SessionInput
    }
    return write(id, input)
  }
  return api
}
