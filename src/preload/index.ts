import type {
  Session,
  SessionStream,
  SessionInput,
  SessionEvent,
  ModelOption,
  CommandOption,
  HistoryPage
} from '../shared/session-model'
import type { Attachment, AttachmentPreview, AttachmentSource } from '../shared/attachments'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { UpdaterState } from '../shared/updater-types'
import type { AgentUpdateId, AgentUpdatesState } from '../shared/agent-updates'
import type { LaunchProfile, LauncherFamily } from '../shared/agent-launch'
import type { GitBatchProgress } from '../shared/git-batch'
import type { GitRangeDirection } from '../shared/git-range'
import type { MergeMethod, PullRef, ReviewEvent } from '../shared/github-pull'
import type { WindowIdentity } from '../shared/workspace-types'
import type { SessionInfo } from './index.d'
import { createMethodRouter, type Endpoint } from '@clave/client/router'
import { IPC_SERVER_ENDPOINT } from '@clave/contract/env'
import type { ServerEvent } from '@clave/contract/events'
import type { SessionWrite } from '@clave/contract/sessions'

/** Creates a typed IPC event listener with cleanup function. */
function createIpcListener<T extends unknown[]>(
  channel: string,
  callback: (...args: T) => void
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: T): void => callback(...args)
  ipcRenderer.on(channel, listener)
  return (): void => {
    ipcRenderer.removeListener(channel, listener)
  }
}

// One main-process subscription per renderer/session; each view owns a ref.
const sessionSubscriptionRefs = new Map<string, number>()

// ── The server client (lane A) ──
// The renderer keeps calling `electronAPI` by the same names; a method moves
// to Clave's server here, one at a time, by taking a `server` arm. Until the
// shell has started the server (main answers null) every method goes over IPC
// as before; once the server is in use, its failure reaches the caller and
// nothing falls back. Main over IPC is the ONLY source of the address: an
// address in this process's environment is somebody else's server (a Clave
// started from a Clave tab inherits the outer one's) and is never read.
// The client itself (Effect and the framework underneath) loads on the first
// routed call that finds an endpoint, never at window start: measured at about
// 700 ms of synchronous requires per window when it was a static import.
const serverRouter = createMethodRouter({
  resolve: async (): Promise<Endpoint | null> =>
    ((await ipcRenderer.invoke(IPC_SERVER_ENDPOINT)) as Endpoint | null) ?? null,
  connect: async (endpoint) => {
    // The calls leave through NODE, not the page: this preload runs with
    // Node available (`sandbox: false`), so the request client goes out
    // through `@effect/platform-node` and the push socket through `ws`
    // (`@clave/client/node`). Nothing of the window's origin travels: the
    // packaged `file://` page sends no Origin, meets no Content Security
    // Policy and no preflight, and the server's CORS rules are for browser
    // pages only (ADR 0003; the round-2 verifier of lane F watched the
    // page's own fetch be refused by its CSP, with the chat view never
    // mounting behind it). The push socket is opened by the first routed
    // subscription, not before.
    const { connectThroughNode } = await import('@clave/client/node')
    const backing = await connectThroughNode(endpoint, { client: 'clave-preload' })
    // Every push listener waiting for the server joins it now (below).
    queueMicrotask(() => announceServer(backing))
    return backing
  }
})

/**
 * The one "server became available" signal of this preload, for every
 * domain's push listeners (the sessions here; the sidebar joins it at its
 * lane's rebase). A window that boots before the server is up makes its
 * first calls over IPC, and the shell stops its per-window sends the moment
 * the server runs, so a listener bound early would hear nothing until its
 * next routed call: `onServerAvailable` runs `wire` at once when the backing
 * is known, else the moment it is, either because a routed call connected
 * (`connect` above announces it) or because the watch below found it, asking
 * main every two seconds. A window on IPC for good (an app whose server did
 * not start) keeps asking cheaply and hears IPC. A domain that must catch up
 * on what went by between the shell's switch and the wiring does its read in
 * its own `wire`.
 */
type Backing = import('@clave/client/router').Backing
let serverBacking: Backing | null = null
const serverWaiters = new Set<(backing: Backing) => void>()
let serverWatching = false
const announceServer = (backing: Backing): void => {
  if (serverBacking) return
  serverBacking = backing
  backing.push.connect()
  for (const wire of [...serverWaiters]) wire(backing)
  serverWaiters.clear()
}
const watchForServer = (): void => {
  if (serverBacking || serverWatching) return
  serverWatching = true
  const ask = (): void => {
    void serverRouter.backing().then(
      (backing) => {
        if (backing) announceServer(backing)
        else if (!serverBacking) setTimeout(ask, 2000)
      },
      () => {
        if (!serverBacking) setTimeout(ask, 2000)
      }
    )
  }
  ask()
}
/** Run `wire` once the server is there (at once when it already is); the
 *  returned function withdraws a wait that has not fired. */
function onServerAvailable(wire: (backing: Backing) => void): () => void {
  if (serverBacking) {
    wire(serverBacking)
    return noop
  }
  serverWaiters.add(wire)
  watchForServer()
  return () => {
    serverWaiters.delete(wire)
  }
}
/**
 * What the server said it cannot do, for the page. A declared
 * `CapabilityUnavailable` (a standalone server with no terminal process
 * refusing the sessions) is caught here, at the client boundary, because the
 * page cannot read it off the rejection: an Error crossing the context bridge
 * keeps its message and loses every other property, the tag included. The
 * refusal still rejects the call; the page's notice hears it through
 * `onServerRefusal`, and hears `null` when a routed call next succeeds.
 */
type ServerRefusal = { capability: string; message: string }
const refusalListeners = new Set<(refusal: ServerRefusal | null) => void>()
let refused = false
const refusalOf = (error: unknown): ServerRefusal | null => {
  if (!error || typeof error !== 'object') return null
  const tagged = error as { _tag?: unknown; capability?: unknown; message?: unknown }
  return tagged._tag === 'CapabilityUnavailable' &&
    typeof tagged.capability === 'string' &&
    typeof tagged.message === 'string'
    ? { capability: tagged.capability, message: tagged.message }
    : null
}
const tellRefusal = (refusal: ServerRefusal | null): void => {
  for (const listener of refusalListeners) listener(refusal)
}
/** `serverRouter.route`, with the refusal relay around every routed call. */
const viaServer = <A extends unknown[], R>(
  route: Parameters<typeof serverRouter.route<A, R>>[0]
): ((...args: A) => Promise<R>) => {
  const routed = serverRouter.route<A, R>(route)
  return async (...args) => {
    try {
      const result = await routed(...args)
      if (refused) {
        refused = false
        tellRefusal(null)
      }
      return result
    } catch (error) {
      const refusal = refusalOf(error)
      if (refusal) {
        refused = true
        tellRefusal(refusal)
      }
      throw error
    }
  }
}
/** The wire subscriptions `sessionsSubscribe` holds on the server, per session. */
const heldSubscriptions = new Map<string, () => void>()
/** Which transport a session's subscription was taken on: it is released on
 *  the same one, whatever the router would pick now, and a stream listener
 *  stays on IPC while the subscription is IPC's. */
const subscribedVia = new Map<string, 'ipc' | 'server'>()
const noop = (): void => {}
/** One subscription on the server's push channel, held until the matching
 *  unsubscribe; the answer is the server's own `subscribed` frame, which
 *  comes once the session is ready and its listeners bound, as the IPC
 *  answer did. An unknown session is the server's refusal, thrown. */
const subscribeRoute = viaServer<[string], Session>({
  ipc: async (id) => {
    const session = (await ipcRenderer.invoke('sessions:subscribe', id)) as Session
    subscribedVia.set(id, 'ipc')
    return session
  },
  server: async ({ push }, id) => {
    push.connect()
    heldSubscriptions.get(id)?.()
    const release = push.subscribe(id, noop)
    heldSubscriptions.set(id, release)
    try {
      const session = (await push.subscribed(id)) as Session
      subscribedVia.set(id, 'server')
      return session
    } catch (error) {
      release()
      heldSubscriptions.delete(id)
      throw error
    }
  }
})
/** A subscription is released on the transport it was taken on; one taken
 *  over IPC and released over the server would leak in main and double every
 *  frame of a later subscription (round 1 of the verifier). */
const unsubscribeRoute = async (id: string): Promise<void> => {
  const via = subscribedVia.get(id)
  subscribedVia.delete(id)
  if (via === 'server') {
    heldSubscriptions.get(id)?.()
    heldSubscriptions.delete(id)
    return
  }
  await ipcRenderer.invoke('sessions:unsubscribe', id)
}
/** A session's subscription, taken again: on the transport it is already
 *  on, else on whatever the router picks. */
const subscribeAgain = (id: string): Promise<Session> =>
  subscribedVia.get(id) === 'ipc'
    ? (ipcRenderer.invoke('sessions:subscribe', id) as Promise<Session>)
    : subscribeRoute(id)
/** The window's own key: the server lists sessions per window the way
 *  `sessions:list` answers for the asking window. */
const windowKey = (): Promise<string | null> =>
  ipcRenderer
    .invoke('window:identity')
    .then((identity: WindowIdentity | null) => identity?.windowKey ?? null)

/**
 * A listener on both transports. The IPC channel is bound at once, the push
 * subscription once the server is available (`onServerAvailable`, at once or
 * later); a window the server has not reached hears IPC, a window on the
 * server hears the push channel, and main sends on one or the other, never
 * both (`src/main/server/session-events.ts`). `unless` keeps a stream
 * listener off the push channel while the session's subscription was taken
 * over IPC: main serves that subscription over IPC until it is released, and
 * binding push beside it would deliver every frame twice.
 */
function onBothTransports(
  ipcOff: () => void,
  bind: (push: import('@clave/client').PushClient) => () => void,
  unless: () => boolean = () => false
): () => void {
  let pushOff: (() => void) | null = null
  let gone = false
  const withdraw = onServerAvailable((backing) => {
    if (gone || unless()) return
    pushOff = bind(backing.push)
  })
  return () => {
    gone = true
    withdraw()
    ipcOff()
    pushOff?.()
  }
}
/** A server event about one session, on the push channel. */
function onSessionEvent<E extends ServerEvent['_tag']>(
  push: import('@clave/client').PushClient,
  tag: E,
  sessionId: string,
  callback: (event: Extract<ServerEvent, { _tag: E }>) => void
): () => void {
  return push.onEvent((envelope) => {
    const event = envelope.event
    if (event._tag === tag && 'id' in event && event.id === sessionId)
      callback(event as Extract<ServerEvent, { _tag: E }>)
  })
}

const electronAPI = {
  // ── The server (lane A): what it refused, for the page's notice ──
  onServerRefusal: (callback: (refusal: ServerRefusal | null) => void): (() => void) => {
    refusalListeners.add(callback)
    return () => {
      refusalListeners.delete(callback)
    }
  },
  // ── Sessions (lane A): every call goes to the server once main names it ──
  sessionsList: viaServer<[], Session[]>({
    ipc: () => ipcRenderer.invoke('sessions:list'),
    server: async ({ api }) => {
      const key = await windowKey()
      return key ? [...(await api.sessions.list(key))] : []
    }
  }),
  sessionsSubscribe: async (id: string): Promise<Session> => {
    sessionSubscriptionRefs.set(id, (sessionSubscriptionRefs.get(id) ?? 0) + 1)
    try {
      return await subscribeAgain(id)
    } catch (error) {
      const refs = (sessionSubscriptionRefs.get(id) ?? 1) - 1
      if (refs > 0) sessionSubscriptionRefs.set(id, refs)
      else sessionSubscriptionRefs.delete(id)
      throw error
    }
  },
  sessionsUnsubscribe: (id: string): Promise<void> => {
    const refs = sessionSubscriptionRefs.get(id) ?? 0
    if (refs > 1) {
      sessionSubscriptionRefs.set(id, refs - 1)
      return Promise.resolve()
    }
    sessionSubscriptionRefs.delete(id)
    return unsubscribeRoute(id)
  },
  sessionsWrite: viaServer<[string, Uint8Array | SessionInput], void>({
    ipc: (id, input) => ipcRenderer.invoke('sessions:write', id, input),
    server: ({ api }, id, input) =>
      api.sessions.write(
        id,
        input instanceof Uint8Array ? { type: 'bytes', data: input } : (input as SessionWrite)
      )
  }),
  sessionsSetView: viaServer<[string, string | null], Session>({
    ipc: (id, viewId) => ipcRenderer.invoke('sessions:set-view', id, viewId),
    server: ({ api }, id, viewId) => api.sessions.setView(id, viewId) as Promise<Session>
  }),
  sessionsModels: viaServer<[string], ModelOption[]>({
    ipc: (id) => ipcRenderer.invoke('sessions:models', id),
    server: async ({ api }, id) => [...(await api.sessions.models(id))] as ModelOption[]
  }),
  sessionsCommands: viaServer<[string], CommandOption[]>({
    ipc: (id) => ipcRenderer.invoke('sessions:commands', id),
    server: async ({ api }, id) => [...(await api.sessions.commands(id))] as CommandOption[]
  }),
  sessionsCapabilities: viaServer<[string], { images: boolean }>({
    ipc: (id) => ipcRenderer.invoke('sessions:capabilities', id),
    server: ({ api }, id) => api.sessions.capabilities(id)
  }),
  sessionsHistory: viaServer<[string, number?, number?], HistoryPage>({
    ipc: (id, before, limit) => ipcRenderer.invoke('sessions:history', id, before, limit),
    server: ({ api }, id, before, limit) =>
      api.sessions.history(id, before, limit) as Promise<HistoryPage>
  }),
  // The composer's files: prepared into a session's attachment records here,
  // read again in main when the message is sent.
  sessionsFiles: {
    prepare: (sessionId: string, source: AttachmentSource): Promise<Attachment> =>
      ipcRenderer.invoke('sessions:files', { type: 'prepare', sessionId, source }),
    pick: (): Promise<string[]> => ipcRenderer.invoke('sessions:files', { type: 'pick' }),
    preview: (file: Attachment): Promise<AttachmentPreview> =>
      ipcRenderer.invoke('sessions:files', { type: 'preview', file }),
    open: (file: Attachment): Promise<void> =>
      ipcRenderer.invoke('sessions:files', { type: 'open', file })
  },
  onSessionStream: (id: string, callback: (stream: SessionStream) => void) =>
    onBothTransports(
      createIpcListener(`sessions:stream:${id}`, callback),
      (push) => push.subscribe(id, callback as (stream: unknown) => void),
      () => subscribedVia.get(id) === 'ipc'
    ),
  onSessionStreamExit: (id: string, callback: (code: number) => void) =>
    onBothTransports(
      createIpcListener(`sessions:exit:${id}`, callback),
      (push) => push.subscribe(id, noop, callback),
      () => subscribedVia.get(id) === 'ipc'
    ),

  pluginsList: () => ipcRenderer.invoke('plugins:list'),
  pluginsViewLease: (pluginId: string, viewId: string, sessionId: string) =>
    ipcRenderer.invoke('plugins:view-lease', pluginId, viewId, sessionId),
  pluginsViewRequest: (leaseId: string, method: string, params?: unknown) =>
    ipcRenderer.invoke('plugins:view-request', leaseId, method, params),
  pluginsViewRevoke: (leaseId: string) => ipcRenderer.invoke('plugins:view-revoke', leaseId),
  onPluginViewEvent: (leaseId: string, callback: (event: SessionEvent) => void) =>
    createIpcListener(`plugins:view-event:${leaseId}`, callback),
  pluginsEnable: (id: string, grants: import('@clave/plugin-sdk').PluginPermission[]) =>
    ipcRenderer.invoke('plugins:enable', id, grants),
  pluginsDisable: (id: string) => ipcRenderer.invoke('plugins:disable', id),
  pluginsLink: (folder?: string) => ipcRenderer.invoke('plugins:link', folder),
  pluginsRemove: (id: string) => ipcRenderer.invoke('plugins:remove', id),
  pluginsCommand: (id: string, command: string) =>
    ipcRenderer.invoke('plugins:command', id, command),
  pluginsPanel: (id: string, panel: string) => ipcRenderer.invoke('plugins:panel', id, panel),
  pluginsContext: (sessionId: string | null) => ipcRenderer.invoke('plugins:context', sessionId),
  pluginsSecrets: () => ipcRenderer.invoke('plugins:secrets'),
  pluginsSecretReply: (id: string, value: string | null) =>
    ipcRenderer.invoke('plugins:secret-reply', id, value),
  onPluginsChanged: (callback: () => void) => createIpcListener('plugins:changed', callback),
  /** Which OS the window is on. The renderer needs it for exactly one class of
   *  decision: chrome that holds room for the platform's own window buttons.
   *  Only macOS puts them INSIDE our chrome (`titleBarStyle: 'hiddenInset'`,
   *  src/main/index.ts); Windows and Linux keep a native frame and draw them
   *  above it, so clearance held on those platforms is a hole. Sync, not an
   *  invoke: it is a constant for the life of the process and chrome laid out
   *  after a round-trip would jump on first paint. */
  platform: process.platform,

  launchProfilesList: () => ipcRenderer.invoke('launch-profiles:list'),
  launchProfileUpsert: (profile: LaunchProfile) =>
    ipcRenderer.invoke('launch-profiles:upsert', profile),
  launchProfileDelete: (profileId: string) =>
    ipcRenderer.invoke('launch-profiles:delete', profileId),
  launchProfileSetGlobal: (family: LauncherFamily, profileId: string | null) =>
    ipcRenderer.invoke('launch-profiles:set-global', { family, profileId }),
  launchProfileSetWorkspace: (
    workspaceId: string,
    family: LauncherFamily,
    profileId: string | null
  ) => ipcRenderer.invoke('launch-profiles:set-workspace', { workspaceId, family, profileId }),
  spawnSession: viaServer<
    [
      string,
      {
        dangerousMode?: boolean
        model?: string
        claudeMode?: boolean
        antigravityMode?: boolean
        codexMode?: boolean
        piMode?: boolean
        claudeAgentsMode?: boolean
        resumeSessionId?: string
        claudeSessionId?: string
        piSessionId?: string
        launchProfileId?: string
        piProvider?: string
        piThinking?: import('../shared/agent-launch').PiThinkingLevel
        initialCommand?: string
        autoExecute?: boolean
        initialPrompt?: string
        tmuxMode?: boolean
        adoptTmuxName?: string
        adoptSessionId?: string
        configDir?: string
        claudeProfileId?: string
        claudeProfileLabel?: string
        workspaceId?: string
        link?:
          | { kind: 'group-terminal'; groupId: string; terminalId: string }
          | { kind: 'session-view'; ownerId: string }
          | { kind: 'toolbar'; key: string }
      }?
    ],
    SessionInfo
  >({
    ipc: (cwd, options) => ipcRenderer.invoke('pty:spawn', cwd, options),
    server: async ({ api }, cwd, options) => {
      const key = await windowKey()
      return (await api.sessions.start({
        cwd,
        ...(key && { windowKey: key }),
        ...(options && { options })
      })) as SessionInfo
    }
  }),

  writeSession: (id: string, data: string) => ipcRenderer.send('pty:write', id, data),

  startSession: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:start', id, cols, rows),

  resizeSession: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', id, cols, rows),

  killSession: viaServer<[string], void>({
    ipc: (id) => ipcRenderer.invoke('pty:kill', id),
    server: ({ api }, id) => api.sessions.stop(id)
  }),

  listSessions: () => ipcRenderer.invoke('pty:list'),

  setSessionDisplayName: (id: string, displayName: string | null, userRenamed: boolean) =>
    ipcRenderer.invoke('session:set-display-name', id, displayName, userRenamed),
  setSessionViewRecord: (
    id: string,
    view: { url: string; title?: string; command?: string; cwd?: string } | null
  ) => ipcRenderer.invoke('session:set-view', id, view),

  setSessionWorkspace: (id: string, workspaceId: string | null) =>
    ipcRenderer.invoke('session:set-workspace', id, workspaceId),

  tmuxAvailable: () => ipcRenderer.invoke('tmux:available'),

  // This window's own records (plus the orphans, for the primary); `ids`
  // fetches specific records whatever their window (the re-home path).
  listSessionRecords: (filter?: { ids?: string[] }) =>
    ipcRenderer.invoke('records:list-adoptable', filter),

  discardSessionRecord: (key: string) => ipcRenderer.invoke('records:discard', key),

  // Sessions handed to this window to take in — a closing window's (with its
  // groups), or tabs moved here — as ids; the records carry the rest.
  onSessionRehome: (
    callback: (payload: { sessionIds: string[]; layout: unknown | null; focus: boolean }) => void
  ) =>
    createIpcListener<[{ sessionIds: string[]; layout: unknown | null; focus: boolean }]>(
      'session:rehome',
      callback
    ),
  // A session this window held just MOVED to another window: drop the tab
  // without touching the pty.
  onSessionRemovedForRehome: (callback: (sessionId: string) => void) =>
    createIpcListener<[string]>('session:removed-for-rehome', callback),
  // A group this window held just MOVED whole to another window: drop it
  // here without touching any pty.
  onGroupRemovedForMove: (callback: (groupId: string) => void) =>
    createIpcListener<[string]>('group:removed-for-move', callback),
  // Acknowledge a `session:rehome` once adopted (a cross-window MCP move
  // waits on it before placing the tab in a group here).
  ackRehomed: (sessionIds: string[]) => ipcRenderer.send('window:rehomed', sessionIds),

  onSessionData: (id: string, callback: (data: string) => void) =>
    createIpcListener<[string]>(`pty:data:${id}`, callback),

  onSessionExit: (id: string, callback: (exitCode: number) => void) =>
    createIpcListener<[number]>(`pty:exit:${id}`, callback),

  // A session's title, plan and clear are server events on the push channel
  // once the server runs, and per-window sends before (one or the other,
  // src/main/server/session-events.ts); a listener hears both transports.
  onSessionAutoTitle: (sessionId: string, callback: (title: string) => void) =>
    onBothTransports(
      createIpcListener<[string]>(`session:auto-title:${sessionId}`, callback),
      (push) =>
        onSessionEvent(push, 'session.title_changed', sessionId, (event) => callback(event.title))
    ),

  onPlanDetected: (sessionId: string, callback: (planPath: string) => void) =>
    onBothTransports(
      createIpcListener<[string]>(`session:plan-detected:${sessionId}`, callback),
      (push) =>
        onSessionEvent(push, 'session.plan_detected', sessionId, (event) => callback(event.path))
    ),

  // A chat session's CLI reported its account's limit (ADR 0002): the policy
  // reads the account and proposes or makes the move.
  onSessionLimitReported: (callback: (sessionId: string) => void) =>
    createIpcListener<[string]>('session:limit-reported', callback),
  onClearDetected: (sessionId: string, callback: (newClaudeSessionId: string | null) => void) =>
    onBothTransports(
      createIpcListener<[string | null]>(`session:clear-detected:${sessionId}`, callback),
      (push) =>
        onSessionEvent(push, 'session.cleared', sessionId, (event) =>
          callback(event.providerSessionId)
        )
    ),

  // A terminal's hook state still arrives over IPC from the PTY handlers; a
  // chat session's comes as `session.state_changed` once the server runs.
  onAgentState: (sessionId: string, callback: (state: string) => void) =>
    onBothTransports(createIpcListener<[string]>(`agent:state:${sessionId}`, callback), (push) =>
      onSessionEvent(push, 'session.state_changed', sessionId, (event) => callback(event.state))
    ),

  onMcpCommand: (
    callback: (msg: { requestId: string; command: string; payload: unknown }) => void
  ) =>
    createIpcListener<[{ requestId: string; command: string; payload: unknown }]>(
      'mcp:command',
      callback
    ),

  mcpRespond: (response: { requestId: string; ok: boolean; result?: unknown; error?: string }) =>
    ipcRenderer.send('mcp:response', response),

  // Exchange capture: fire-and-forget observability writes — the renderer
  // never waits on these, so a capture failure can't delay a delivery.
  captureExchangeMessage: (payload: {
    ts: string
    sender: unknown
    target: unknown
    text: string
    provenance: string
    delivered: boolean
  }) => ipcRenderer.send('exchange:capture-message', payload),

  captureTabSpawn: (payload: {
    ts: string
    spawner: unknown
    session: unknown
    prompt: string | null
    model: string | null
  }) => ipcRenderer.send('exchange:capture-tab-spawn', payload),

  captureSessionState: (payload: {
    ts: string
    session: unknown
    state: string
    previous: string | null
    source: string
  }) => ipcRenderer.send('exchange:capture-session-state', payload),

  captureTabClosed: (payload: { ts: string; session: unknown; by: string; closer: unknown }) =>
    ipcRenderer.send('exchange:capture-tab-closed', payload),

  // Session history (PRDCT-1738): the ledger row is fire-and-forget like the
  // capture above; the list is the dialog's one read.
  historyStamp: (row: unknown) => ipcRenderer.send('history:stamp', row),
  historyList: () => ipcRenderer.invoke('history:list'),
  historyConversation: (cwd: string, claudeSessionId: string, provider?: 'claude' | 'pi') =>
    ipcRenderer.invoke('history:conversation', { cwd, claudeSessionId, provider }),
  scrollSessionToText: (id: string, needle: string, fromBottom: number) =>
    ipcRenderer.invoke('session:scroll-to-text', id, needle, fromBottom),
  historySearch: (request: {
    requestId: string
    query: string
    scopes: string[]
    claudeSessionIds: string[]
  }) => ipcRenderer.invoke('history:search', request),
  historySearchCancel: (requestId: string) => ipcRenderer.send('history:search-cancel', requestId),
  onHistorySearchHits: (callback: (progress: { requestId: string; hits: unknown[] }) => void) =>
    createIpcListener<[{ requestId: string; hits: unknown[] }]>('history:search-hits', callback),
  setSessionClaudeSessionId: (id: string, claudeSessionId: string) =>
    ipcRenderer.invoke('session:set-claude-session-id', id, claudeSessionId),

  secretList: () => ipcRenderer.invoke('secret:list'),

  secretSubmit: (id: string, secret: string) => ipcRenderer.invoke('secret:submit', id, secret),

  secretDismiss: (id: string) => ipcRenderer.invoke('secret:dismiss', id),

  onSecretRequestsChanged: (callback: (requests: unknown[]) => void) =>
    createIpcListener<[unknown[]]>('secret:requests-changed', callback),

  linkedDocuments: {
    getDefaultSignature: () => ipcRenderer.invoke('linked-documents:get-default-signature'),
    setDefaultSignature: (path: string) =>
      ipcRenderer.invoke('linked-documents:set-default-signature', path),
    list: () => ipcRenderer.invoke('linked-documents:list'),
    open: (sessionId: string, input: unknown) =>
      ipcRenderer.invoke('linked-documents:open', sessionId, input),
    update: (id: string, revision: number, input: unknown) =>
      ipcRenderer.invoke('linked-documents:update', id, revision, input),
    openAttachment: (id: string, attachmentId: string) =>
      ipcRenderer.invoke('linked-documents:open-attachment', id, attachmentId),
    chooseFiles: (signature?: boolean) =>
      ipcRenderer.invoke('linked-documents:choose-files', signature),
    onChanged: (callback: () => void) => createIpcListener<[]>('linked-documents:changed', callback)
  },
  copyOfferList: () => ipcRenderer.invoke('copy-offer:list'),

  copyOfferCopy: (id: string) => ipcRenderer.invoke('copy-offer:copy', id),

  copyOfferDismiss: (id: string) => ipcRenderer.invoke('copy-offer:dismiss', id),

  copyOfferDismissSession: (sessionId: string) =>
    ipcRenderer.invoke('copy-offer:dismiss-session', sessionId),

  onCopyOffersChanged: (callback: (offers: unknown[]) => void) =>
    createIpcListener<[unknown[]]>('copy-offer:changed', callback),

  saveDiscussion: (
    cwd: string,
    claudeSessionId: string,
    sessionName: string,
    extras?: { sessionType?: string | null; locationId?: string | null }
  ) => ipcRenderer.invoke('session:save-discussion', cwd, claudeSessionId, sessionName, extras),

  savePlan: (
    cwd: string,
    claudeSessionId: string,
    sessionName: string,
    extras?: { sessionType?: string | null; locationId?: string | null }
  ) => ipcRenderer.invoke('session:save-plan', cwd, claudeSessionId, sessionName, extras),

  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  // The GitHub pull request panel (plugins/github). Main runs the user's own
  // `gh`; every call answers with a GithubResult rather than throwing, so the
  // panel can tell "gh is missing" from "not signed in" from "gh said no".
  githubPull: (ref: PullRef) => ipcRenderer.invoke('github:pull', ref),
  githubPullDiff: (ref: PullRef) => ipcRenderer.invoke('github:pull-diff', ref),
  githubPullComment: (ref: PullRef, body: string) =>
    ipcRenderer.invoke('github:pull-comment', ref, body),
  githubPullReview: (ref: PullRef, event: ReviewEvent, body: string) =>
    ipcRenderer.invoke('github:pull-review', ref, event, body),
  githubPullMerge: (ref: PullRef, method: MergeMethod) =>
    ipcRenderer.invoke('github:pull-merge', ref, method),
  checkPort: (port: number) => ipcRenderer.invoke('net:check-port', port) as Promise<boolean>,
  probeServerUrl: (url: string, timeoutMs?: number) =>
    ipcRenderer.invoke('net:probe-url', url, timeoutMs) as Promise<boolean>,

  openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),

  registerHtmlPreview: (filePath: string) =>
    ipcRenderer.invoke('preview:register', filePath) as Promise<{ url: string }>,

  openFolderDialog: (defaultPath?: string) => ipcRenderer.invoke('dialog:openFolder', defaultPath),

  onUpdateAvailable: (callback: (version: string) => void) =>
    createIpcListener<[string]>('updater:update-available', callback),

  onUpdateDownloaded: (callback: (version: string) => void) =>
    createIpcListener<[string]>('updater:update-downloaded', callback),

  onDownloadProgress: (
    callback: (progress: {
      percent: number
      bytesPerSecond: number
      transferred: number
      total: number
    }) => void
  ) =>
    createIpcListener<
      [{ percent: number; bytesPerSecond: number; transferred: number; total: number }]
    >('updater:download-progress', callback),

  onDownloadError: (callback: (message: string) => void) =>
    createIpcListener<[string]>('updater:download-error', callback),

  onUpdaterState: (callback: (state: UpdaterState) => void) =>
    createIpcListener<[UpdaterState]>('updater:state', callback),

  onOpenSettingsSection: (callback: (section: string) => void) =>
    createIpcListener<[string]>('menu:open-settings-section', callback),

  onMissionControlEntered: (callback: () => void) =>
    createIpcListener<[]>('mission-control:entered', callback),
  onMissionControlExited: (callback: () => void) =>
    createIpcListener<[]>('mission-control:exited', callback),
  missionControlGetEnabled: () =>
    ipcRenderer.invoke('mission-control:get-enabled') as Promise<boolean>,
  missionControlSetEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('mission-control:set-enabled', enabled),

  setAppIcon: (icon: string) => ipcRenderer.invoke('app:set-icon', icon),
  hapticTick: (pattern?: 'alignment' | 'generic' | 'level') =>
    ipcRenderer.send('haptic:tick', pattern ?? 'alignment'),
  getUsername: () => ipcRenderer.invoke('app:get-username') as Promise<string | null>,
  saveAvatar: (sourcePath: string) =>
    ipcRenderer.invoke('app:save-avatar', sourcePath) as Promise<string | null>,
  getAppVersion: () => ipcRenderer.invoke('app:get-version') as Promise<string>,

  installUpdate: () => ipcRenderer.invoke('updater:install'),
  startDownload: (attempt?: 'first' | 'retry') =>
    ipcRenderer.invoke('updater:start-download', attempt),
  openUpdaterLog: () => ipcRenderer.invoke('updater:open-log'),
  openReleasesPage: () => ipcRenderer.invoke('updater:open-releases'),
  cancelDownload: () => ipcRenderer.invoke('updater:cancel-download'),
  getUpdaterState: () => ipcRenderer.invoke('updater:get-state') as Promise<UpdaterState>,
  checkForUpdates: () => ipcRenderer.invoke('updater:check') as Promise<UpdaterState>,
  setPrereleaseUpdates: (enabled: boolean) =>
    ipcRenderer.invoke('updater:set-prerelease-updates', enabled) as Promise<UpdaterState>,

  getAgentUpdates: () =>
    ipcRenderer.invoke('agent-updates:get-state') as Promise<AgentUpdatesState>,
  checkAgentUpdates: () => ipcRenderer.invoke('agent-updates:check') as Promise<AgentUpdatesState>,
  updateAgent: (id: AgentUpdateId) =>
    ipcRenderer.invoke('agent-updates:update', id) as Promise<AgentUpdatesState>,
  setAgentAutoUpdate: (enabled: boolean) =>
    ipcRenderer.invoke('agent-updates:set-auto', enabled) as Promise<AgentUpdatesState>,
  onAgentUpdatesState: (callback: (state: AgentUpdatesState) => void) =>
    createIpcListener<[AgentUpdatesState]>('agent-updates:state', callback),

  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  persistDroppedFile: (sourcePath: string) =>
    ipcRenderer.invoke('files:persist-dropped', sourcePath) as Promise<string | null>,

  // File system
  listFiles: (cwd: string) => ipcRenderer.invoke('fs:list-files', cwd),
  readDir: (rootCwd: string, dirPath: string) =>
    ipcRenderer.invoke('fs:read-dir', rootCwd, dirPath),
  existsSync: (rootCwd: string, relPath: string): boolean =>
    ipcRenderer.sendSync('fs:exists-sync', rootCwd, relPath),
  readFile: (rootCwd: string, filePath: string) =>
    ipcRenderer.invoke('fs:read-file', rootCwd, filePath),
  statFile: (rootCwd: string, filePath: string) => ipcRenderer.invoke('fs:stat', rootCwd, filePath),
  writeFile: (rootCwd: string, filePath: string, content: string) =>
    ipcRenderer.invoke('fs:write-file', rootCwd, filePath, content),
  createFile: (rootCwd: string, filePath: string) =>
    ipcRenderer.invoke('fs:create-file', rootCwd, filePath),
  createDirectory: (rootCwd: string, dirPath: string) =>
    ipcRenderer.invoke('fs:create-directory', rootCwd, dirPath),
  showItemInFolder: (fullPath: string) => ipcRenderer.invoke('shell:showItemInFolder', fullPath),

  // File system watching
  watchDir: (cwd: string, dirs?: string[]) => ipcRenderer.invoke('fs:watch', cwd, dirs ?? []),
  unwatchDir: () => ipcRenderer.invoke('fs:unwatch'),
  onFsChanged: (callback: (cwd: string, changedDirs: string[]) => void) =>
    createIpcListener<[string, string[]]>('fs:changed', callback),

  // Sidebar layout (session groups + display order), ONE FILE PER WINDOW —
  // main-process JSON storage so the groups survive a hard kill that drops
  // Chromium's lazily-flushed localStorage. A window reads and writes its own
  // file only (main resolves it from the sender); the primary's load also
  // takes in the orphans of windows that no longer exist.
  sidebarLayoutLoad: () => ipcRenderer.invoke('sidebar-layout:load'),
  sidebarLayoutSave: (data: { groups: unknown[]; displayOrder: string[] }) =>
    ipcRenderer.invoke('sidebar-layout:save', data),

  // Workspace registry + pins — main-process JSON storage, same crash-safety
  // rationale as the sidebar layouts, written FIELD BY FIELD: several windows
  // share the file, and a whole-file save was last-writer-wins.
  workspaceLoad: () => ipcRenderer.invoke('workspace:load'),
  workspaceUpdateRegistry: (workspaces: unknown[]) =>
    ipcRenderer.invoke('workspace:update-registry', workspaces),
  workspaceUpdatePins: (scope: string | null | 'all', pins: unknown[]) =>
    ipcRenderer.invoke('workspace:update-pins', scope, pins),
  workspaceSetLastActive: (workspaceId: string | null) =>
    ipcRenderer.invoke('workspace:set-last-active', workspaceId),
  onWorkspaceStateChanged: (
    callback: (state: { workspaces: unknown[]; pins: unknown[] }) => void
  ) =>
    createIpcListener<[{ workspaces: unknown[]; pins: unknown[] }]>(
      'workspace:state-changed',
      callback
    ),

  // This window's identity — its id, its persisted key, the workspace it
  // shows, whether it is the primary. A renderer only ever learns its own;
  // pushed again when the primary is re-elected.
  windowIdentity: () => ipcRenderer.invoke('window:identity'),
  onWindowIdentityChanged: (callback: (identity: unknown) => void) =>
    createIpcListener<[unknown]>('window:identity-changed', callback),
  // Tell main this window now shows a workspace (persisted; the next spawn
  // stamps against it). Any window may show any workspace.
  windowSetWorkspace: (workspaceId: string | null) =>
    ipcRenderer.invoke('window:set-workspace', workspaceId),
  // Whether THIS window is fullscreen — macOS hides the traffic lights there,
  // so the chrome that keeps clear of them closes the gap.
  windowIsFullScreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  onWindowFullScreenChanged: (callback: (fullScreen: boolean) => void) =>
    createIpcListener<[boolean]>('window:fullscreen-changed', callback),
  // Every open window, for the "move to window" pickers.
  windowList: () => ipcRenderer.invoke('window:list'),
  // A new window — the app once more — on a workspace (default: this one's).
  windowOpen: (workspaceId?: string) => ipcRenderer.invoke('window:open', workspaceId),
  // Move live tabs (tmux-backed) to another window, id and scrollback kept.
  windowMoveSessions: (sessionIds: string[], targetWindowId: number) =>
    ipcRenderer.invoke('window:move-sessions', sessionIds, targetWindowId),
  // Move a whole group (its object + its live members) to another window.
  windowMoveGroup: (group: unknown, targetWindowId: number) =>
    ipcRenderer.invoke('window:move-group', group, targetWindowId),

  // Usage. The Claude read is per account (the machine login when omitted);
  // main polls every account on its own clock and pushes each result.
  getUsageLimits: (accountId?: string, options?: { force?: boolean }) =>
    ipcRenderer.invoke('usage:get-limits', accountId, options),
  getClaudeUsageSnapshot: () => ipcRenderer.invoke('usage:claude-snapshot'),
  onClaudeAccountUsage: (callback: (update: { accountId: string; result: unknown }) => void) =>
    createIpcListener<[{ accountId: string; result: unknown }]>('usage:claude-account', callback),

  // Claude accounts: the list crosses; a token goes in and never comes back.
  claudeAccountsList: () => ipcRenderer.invoke('claude-accounts:list'),
  claudeAccountsMigrated: () => ipcRenderer.invoke('claude-accounts:migrated'),
  claudeAccountAdd: (input: { label: string }) => ipcRenderer.invoke('claude-accounts:add', input),
  claudeAccountUpdate: (id: string, updates: { label?: string }) =>
    ipcRenderer.invoke('claude-accounts:update', id, updates),
  claudeAccountReorder: (ids: string[]) => ipcRenderer.invoke('claude-accounts:reorder', ids),
  claudeAccountRemove: (id: string) => ipcRenderer.invoke('claude-accounts:remove', id),
  claudeAccountSetToken: (id: string, token: string) =>
    ipcRenderer.invoke('claude-accounts:set-token', id, token),
  claudeAccountClearToken: (id: string) => ipcRenderer.invoke('claude-accounts:clear-token', id),
  onClaudeAccountsChanged: (callback: (accounts: unknown[]) => void) =>
    createIpcListener<[unknown[]]>('claude-accounts:changed', callback),
  // Codex accounts (ADR 0002): a home per account; no credential crosses.
  codexAccountsList: () => ipcRenderer.invoke('codex-accounts:list'),
  codexAccountAdd: (input: { label: string; kind?: 'chatgpt' | 'apiKey' }) =>
    ipcRenderer.invoke('codex-accounts:add', input),
  codexAccountUpdate: (id: string, updates: { label?: string }) =>
    ipcRenderer.invoke('codex-accounts:update', id, updates),
  codexAccountReorder: (ids: string[]) => ipcRenderer.invoke('codex-accounts:reorder', ids),
  codexAccountRemove: (id: string) => ipcRenderer.invoke('codex-accounts:remove', id),
  codexAccountClearCredential: (id: string) =>
    ipcRenderer.invoke('codex-accounts:clear-credential', id),
  onCodexAccountsChanged: (callback: (accounts: unknown[]) => void) =>
    createIpcListener<[unknown[]]>('codex-accounts:changed', callback),
  // The login flows: a job's status, link and reason cross; nothing else.
  accountLoginStart: (provider: 'claude' | 'codex', accountId: string) =>
    ipcRenderer.invoke('accounts:login-start', provider, accountId),
  accountLoginApiKey: (accountId: string, apiKey: string) =>
    ipcRenderer.invoke('accounts:login-api-key', accountId, apiKey),
  accountLoginInput: (jobId: string, text: string) =>
    ipcRenderer.invoke('accounts:login-input', jobId, text),
  accountLoginCancel: (jobId: string) => ipcRenderer.invoke('accounts:login-cancel', jobId),
  accountLoginList: () => ipcRenderer.invoke('accounts:login-list'),
  onAccountLoginProgress: (callback: (job: unknown) => void) =>
    createIpcListener<[unknown]>('accounts:login-progress', callback),
  // Codex usage is per account like Claude's (the machine's home when omitted).
  getCodexUsageLimits: (accountId?: string, options?: { force?: boolean }) =>
    ipcRenderer.invoke('usage:get-codex-limits', accountId, options),
  getCodexUsageSnapshot: () => ipcRenderer.invoke('usage:codex-snapshot'),
  onCodexAccountUsage: (callback: (update: { accountId: string; result: unknown }) => void) =>
    createIpcListener<[{ accountId: string; result: unknown }]>('usage:codex-account', callback),
  // A session moved to another account: the same tab, its process restarted
  // on the account with the conversation resumed (ADR 0002).
  restartSession: (
    id: string,
    overrides: {
      claudeProfileId?: string
      claudeProfileLabel?: string
      codexAccountId?: string
      codexAccountLabel?: string
      /** Send the message the limit rejected again on the new account. */
      resendRejected?: boolean
    }
  ) => ipcRenderer.invoke('pty:restart', id, overrides),
  getPiUsage: (range: 'today' | '7d' | '30d' | 'all') => ipcRenderer.invoke('usage:get-pi', range),

  // Git
  gitCheckIgnored: (cwd: string, paths: string[]) =>
    ipcRenderer.invoke('git:check-ignored', cwd, paths),
  getGitStatus: (cwd: string) => ipcRenderer.invoke('git:status', cwd),
  getGitStatusBatch: (paths: string[]) => ipcRenderer.invoke('git:status-batch', paths),
  gitFetch: (cwd: string) => ipcRenderer.invoke('git:fetch', cwd),
  gitFetchBatch: (paths: string[]) => ipcRenderer.invoke('git:fetch-batch', paths),
  discoverGitRepos: (cwd: string, force?: boolean) =>
    ipcRenderer.invoke('git:discover-repos', cwd, force),
  gitStage: (cwd: string, files: string[]) => ipcRenderer.invoke('git:stage', cwd, files),
  gitUnstage: (cwd: string, files: string[]) => ipcRenderer.invoke('git:unstage', cwd, files),
  gitCommit: (cwd: string, message: string) => ipcRenderer.invoke('git:commit', cwd, message),
  gitPush: (cwd: string) => ipcRenderer.invoke('git:push', cwd),
  gitPublishBranch: (cwd: string) => ipcRenderer.invoke('git:publish-branch', cwd),
  gitPull: (cwd: string, strategy?: 'auto' | 'merge' | 'rebase' | 'ff-only') =>
    ipcRenderer.invoke('git:pull', cwd, strategy),
  gitDiscard: (cwd: string, files: Array<{ path: string; status: string; staged: boolean }>) =>
    ipcRenderer.invoke('git:discard', cwd, files),
  gitDiff: (cwd: string, filePath: string, staged: boolean, isUntracked: boolean) =>
    ipcRenderer.invoke('git:diff', cwd, filePath, staged, isUntracked),
  gitLog: (cwd: string, maxCount?: number) => ipcRenderer.invoke('git:log', cwd, maxCount),
  gitOutgoingCommits: (cwd: string) => ipcRenderer.invoke('git:outgoing-commits', cwd),
  gitIncomingCommits: (cwd: string) => ipcRenderer.invoke('git:incoming-commits', cwd),
  gitRangeFiles: (cwd: string, direction: GitRangeDirection) =>
    ipcRenderer.invoke('git:range-files', cwd, direction),
  gitRangeDiff: (cwd: string, direction: GitRangeDirection, filePath: string) =>
    ipcRenderer.invoke('git:range-diff', cwd, direction, filePath),
  gitCommitFiles: (cwd: string, hash: string) => ipcRenderer.invoke('git:commit-files', cwd, hash),
  gitCommitDiff: (cwd: string, hash: string, filePath: string) =>
    ipcRenderer.invoke('git:commit-diff', cwd, hash, filePath),
  gitGenerateCommitMessage: (cwd: string) => ipcRenderer.invoke('git:generate-commit-message', cwd),
  gitMagicSync: (repoPaths: string[]) => ipcRenderer.invoke('git:magic-sync', repoPaths),
  gitMagicPull: (repoPaths: string[]) => ipcRenderer.invoke('git:magic-pull', repoPaths),
  gitRefreshRemotes: (repoPaths: string[]) => ipcRenderer.invoke('git:refresh-remotes', repoPaths),
  // One channel for both batch ops — the payload's `op` says which.
  onGitBatchProgress: (callback: (progress: GitBatchProgress) => void) =>
    createIpcListener<[GitBatchProgress]>('git:batch-progress', callback),
  gitJourney: (cwd: string, maxCount?: number) => ipcRenderer.invoke('git:journey', cwd, maxCount),
  gitSummarizePush: (cwd: string, commitMessages: string[], diffStats: string) =>
    ipcRenderer.invoke('git:summarize-push', cwd, commitMessages, diffStats),

  showNotification: (options: { title: string; body: string; sessionId: string }) =>
    ipcRenderer.invoke('notification:show', options),

  onNotificationClicked: (callback: (sessionId: string) => void) =>
    createIpcListener<[string]>('notification:clicked', callback),

  // ── Locations ──
  locationList: () => ipcRenderer.invoke('location:list'),
  locationAdd: (loc: unknown, password?: string) =>
    ipcRenderer.invoke('location:add', loc, password),
  locationUpdate: (id: string, updates: unknown) =>
    ipcRenderer.invoke('location:update', id, updates),
  locationRemove: (id: string) => ipcRenderer.invoke('location:remove', id),
  locationTestConnection: (id: string) => ipcRenderer.invoke('location:test-connection', id),
  locationInstallPlugin: (id: string) => ipcRenderer.invoke('location:install-plugin', id),

  // ── SSH / Remote Terminal ──
  sshConnect: (locationId: string) => ipcRenderer.invoke('ssh:connect', locationId),
  sshDisconnect: (locationId: string) => ipcRenderer.invoke('ssh:disconnect', locationId),
  sshOpenShell: (locationId: string, cwd?: string) =>
    ipcRenderer.invoke('ssh:open-shell', locationId, cwd),
  sshShellWrite: (shellId: string, data: string) =>
    ipcRenderer.send('ssh:shell-write', shellId, data),
  sshShellResize: (shellId: string, cols: number, rows: number) =>
    ipcRenderer.send('ssh:shell-resize', shellId, cols, rows),
  sshExec: (locationId: string, command: string) =>
    ipcRenderer.invoke('ssh:exec', locationId, command),
  sshShellClose: (shellId: string) => ipcRenderer.invoke('ssh:shell-close', shellId),
  onSshShellData: (shellId: string, callback: (data: string) => void) =>
    createIpcListener<[string]>(`ssh:shell-data:${shellId}`, callback),
  onSshShellExit: (shellId: string, callback: (exitCode: number) => void) =>
    createIpcListener<[number]>(`ssh:shell-exit:${shellId}`, callback),
  onSshConnectionClosed: (callback: (locationId: string) => void) =>
    createIpcListener<[string]>('ssh:connection-closed', callback),

  // ── Remote FS (SFTP) ──
  sftpReadDir: (locationId: string, dirPath: string) =>
    ipcRenderer.invoke('sftp:read-dir', locationId, dirPath),
  sftpReadFile: (locationId: string, filePath: string) =>
    ipcRenderer.invoke('sftp:read-file', locationId, filePath),
  sftpStat: (locationId: string, filePath: string) =>
    ipcRenderer.invoke('sftp:stat', locationId, filePath),

  // ── Agents ──
  agentList: (locationId: string) => ipcRenderer.invoke('agent:list', locationId),
  agentConnect: (locationId: string) => ipcRenderer.invoke('agent:connect', locationId),
  agentDisconnect: (locationId: string) => ipcRenderer.invoke('agent:disconnect', locationId),
  agentSessions: (locationId: string) => ipcRenderer.invoke('agent:sessions', locationId),
  agentChatHistory: (locationId: string, sessionKey: string) =>
    ipcRenderer.invoke('agent:chat-history', locationId, sessionKey),
  agentSend: (agentId: string, locationId: string, content: string) =>
    ipcRenderer.invoke('agent:send', agentId, locationId, content),
  onAgentMessage: (agentId: string, callback: (message: unknown) => void) =>
    createIpcListener<[unknown]>(`agent:on-message:${agentId}`, callback),
  onAgentsUpdated: (callback: (locationId: string, agents: unknown[]) => void) =>
    createIpcListener<[string, unknown[]]>('agent:agents-updated', callback),

  // ── .clave files ──
  readClaveFile: (absolutePath: string, rootDir?: string) =>
    ipcRenderer.invoke('clave:read-file', absolutePath, rootDir),
  writeClaveFile: (absolutePath: string, data: unknown, rootDir?: string) =>
    ipcRenderer.invoke('clave:write-file', absolutePath, data, rootDir),
  watchClaveFile: (absolutePath: string) => ipcRenderer.invoke('clave:watch-file', absolutePath),
  unwatchClaveFile: (absolutePath: string) =>
    ipcRenderer.invoke('clave:unwatch-file', absolutePath),
  onClaveFileChanged: (callback: (filePath: string) => void) =>
    createIpcListener<[string]>('clave:file-changed', callback),
  saveFileDialog: (defaultName: string, filters: { name: string; extensions: string[] }[]) =>
    ipcRenderer.invoke('dialog:saveFile', defaultName, filters),
  getDownloadsPath: () => ipcRenderer.invoke('app:get-downloads-path') as Promise<string>,
  getUserDataPath: () => ipcRenderer.invoke('app:get-user-data-path') as Promise<string>,
  claveFileExists: (absolutePath: string) =>
    ipcRenderer.invoke('clave:file-exists', absolutePath) as Promise<boolean>,
  discoverClaveFiles: (folderPath: string) =>
    ipcRenderer.invoke('clave:discover-files', folderPath) as Promise<
      { name: string; path: string; rootDir: string | null }[]
    >,
  discoverClaveFilesRecursive: (
    rootDir: string,
    config?: { patterns?: string[]; exclude?: string[]; maxDepth?: number; workspaceId?: string }
  ) =>
    ipcRenderer.invoke('clave:discover-files-recursive', rootDir, config) as Promise<
      { name: string; path: string; rootDir: string }[]
    >,
  readAutoDiscoverConfig: (filePath: string) =>
    ipcRenderer.invoke('clave:read-auto-discover', filePath) as Promise<{
      enabled: boolean
      patterns?: string[]
      exclude?: string[]
      maxDepth?: number
    } | null>,
  readImageAsDataUrl: (absolutePath: string) =>
    ipcRenderer.invoke('clave:read-image', absolutePath) as Promise<string | null>,
  skinsList: () => ipcRenderer.invoke('skins:list'),
  skinsActivate: (id: string) => ipcRenderer.invoke('skins:activate', id),
  skinsImport: (source?: string) => ipcRenderer.invoke('skins:import', source),
  skinsRemove: (id: string) => ipcRenderer.invoke('skins:remove', id),
  onSkinsChanged: (callback: (state: import('@clave/skins/types').SkinState) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: import('@clave/skins/types').SkinState
    ): void => callback(state)
    ipcRenderer.on('skins:changed', listener)
    return () => {
      ipcRenderer.removeListener('skins:changed', listener)
    }
  },
  preferencesGet: (key: string) => ipcRenderer.invoke('preferences:get', key),
  preferencesSet: (key: string, value: unknown) =>
    ipcRenderer.invoke('preferences:set', key, value),
  keymapsLoad: () => ipcRenderer.invoke('keymaps:load'),
  keymapsSave: (value: unknown) => ipcRenderer.invoke('keymaps:save', value),
  keymapsImport: () => ipcRenderer.invoke('keymaps:import') as Promise<string | null>,
  keymapsExport: (json: string) => ipcRenderer.invoke('keymaps:export', json) as Promise<boolean>,
  onKeymapsChanged: (callback: (value: unknown) => void) =>
    createIpcListener<[unknown]>('keymaps:changed', callback),
  trustWorkspaceRoot: (root: string) =>
    ipcRenderer.invoke('clave:trust-root', root) as Promise<void>,
  untrustWorkspaceRoot: (root: string) =>
    ipcRenderer.invoke('clave:untrust-root', root) as Promise<void>,
  listTrustedRoots: () => ipcRenderer.invoke('clave:list-trusted-roots') as Promise<string[]>,

  // ── Extensions (inventory of installed plugins/skills/MCP + management) ──
  extensionsGetInventory: (configDir?: string) =>
    ipcRenderer.invoke('extensions:get-inventory', configDir),
  extensionsInstallPlugin: (pluginId: string, scope: string, configDir?: string) =>
    ipcRenderer.invoke('extensions:install-plugin', pluginId, scope, configDir),
  extensionsUninstallPlugin: (pluginId: string, scope: string, configDir?: string) =>
    ipcRenderer.invoke('extensions:uninstall-plugin', pluginId, scope, configDir),
  extensionsSetPluginEnabled: (
    pluginId: string,
    enabled: boolean,
    scope: string,
    configDir?: string
  ) => ipcRenderer.invoke('extensions:set-plugin-enabled', pluginId, enabled, scope, configDir),
  extensionsAddMarketplace: (source: string, configDir?: string) =>
    ipcRenderer.invoke('extensions:add-marketplace', source, configDir),
  extensionsRemoveMarketplace: (name: string, configDir?: string) =>
    ipcRenderer.invoke('extensions:remove-marketplace', name, configDir),

  // ── Telemetry ──
  telemetryGetState: () =>
    ipcRenderer.invoke('telemetry:get-state') as Promise<{
      enabled: boolean
      installId: string | null
      lastPingAt: string | null
      noticeShown: boolean
    }>,
  telemetrySetEnabled: (enabled: boolean) => ipcRenderer.invoke('telemetry:set-enabled', enabled),
  telemetrySetNoticeShown: () => ipcRenderer.invoke('telemetry:set-notice-shown'),

  // ── Feedback ──
  feedbackGetState: () =>
    ipcRenderer.invoke('feedback:get-state') as Promise<{ collapsed: boolean }>,
  feedbackSetCollapsed: () => ipcRenderer.invoke('feedback:set-collapsed'),
  feedbackSubmit: (submission: { email: string; message?: string }) =>
    ipcRenderer.invoke('feedback:submit', submission) as Promise<
      { ok: true } | { ok: false; error: string }
    >

  // ── Lane C: settings behind ports ──

  // ── Lane F: the shell ──
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

/**
 * `--test-no-activate` again, this time so the RENDERER can see it.
 *
 * The main process reads this flag off the app's own command line
 * (`src/main/test-mode.ts`) and, when it is set, repeats it into the window's
 * `additionalArguments` — which is what puts it on the argv read here. A
 * preload's own `process.argv` is the RENDERER process's command line and
 * carries Chromium's switches, not the app's, so without that repeat this
 * lookup finds nothing.
 *
 * What it gates: the E2E-only seams that must not exist in a shipped app, such
 * as the updater store handle a spec writes through. Never passed in a build a
 * user runs, so those seams are absent there.
 */
contextBridge.exposeInMainWorld('__claveTestMode', process.argv.includes('--test-no-activate'))
