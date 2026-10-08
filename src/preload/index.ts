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
import type {
  LaunchProfile,
  LaunchProfilePreferences,
  LauncherFamily
} from '../shared/agent-launch'
import type { GitBatchProgress } from '../shared/git-batch'
import type { GitRangeDirection } from '../shared/git-range'
import type { MergeMethod, PullRef, ReviewEvent } from '../shared/github-pull'
import type { WindowIdentity, Workspace, WorkspaceStateFile } from '../shared/workspace-types'
import type { SessionInfo } from './index.d'
import { createMethodRouter, type Endpoint } from '@clave/client/router'
import { dualListener, workspaceStatePick } from './dual-listener'
import { createReviewRelay, createWatchLedger } from './workspace-files-relay'
import { IPC_SERVER_ENDPOINT } from '@clave/contract/env'
import type { ServerEvent } from '@clave/contract/events'
import type { SessionWrite } from '@clave/contract/sessions'
import type { SidebarGroup } from '@clave/contract/sidebar'

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
  resolve: async (): Promise<Endpoint | null> => {
    const found = (await ipcRenderer.invoke(IPC_SERVER_ENDPOINT)) as
      | (Endpoint & { mode?: ServerMode })
      | null
    // The endpoint's mode is learned here too, so the terminal pane's road
    // (below) is known by the time a session started through the server has
    // a pane: a routed call always precedes one.
    if (found?.mode) serverModeKnown = found.mode
    return found ?? null
  },
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
// ── Lane D (wave 3): the view requests this window received from the server,
// by id, so their answers go back through the server and not over IPC. ──
const serverViewRequests = new Set<string>()
const serverWaiters = new Set<(backing: Backing) => void>()
let serverWatching = false
const announceServer = (backing: Backing): void => {
  if (serverBacking) return
  serverBacking = backing
  // The terminal pane's road needs the mode (below): asked now, so a pane
  // mounted after the announce already knows it.
  void serverMode()
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
    // Stamped BEFORE the round trip: a server announced while the IPC
    // subscribe is in flight would otherwise find no stamp, bind the stream
    // listener on push too, and the subscription would be held on both
    // transports for its life (the verifier's round 2).
    subscribedVia.set(id, 'ipc')
    try {
      return (await ipcRenderer.invoke('sessions:subscribe', id)) as Session
    } catch (error) {
      if (subscribedVia.get(id) === 'ipc') subscribedVia.delete(id)
      throw error
    }
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

// ── The sidebar's road (lane C) ──
// Which transport the sidebar takes is the shell's decision, not a failure's:
// `server` when the server runs inside the app (the same instance main
// holds), `shell` when the app is attached to a server elsewhere, which has
// no windows to host. Null until the boot has decided; asked again on each
// call until it answers, and every call before that goes over IPC, which
// lands on the same instance either way. Once `server`, a server failure
// reaches the caller: nothing here falls back on an error.
type SidebarTransport = 'server' | 'shell'
let sidebarTransportKnown: SidebarTransport | null = null
const sidebarTransport = async (): Promise<SidebarTransport | null> => {
  if (sidebarTransportKnown) return sidebarTransportKnown
  const answer = (await ipcRenderer.invoke('sidebar:transport')) as SidebarTransport | null
  if (answer) sidebarTransportKnown = answer
  return answer
}
const viaSidebar = <A extends unknown[], R>(route: {
  ipc: (...args: A) => Promise<R>
  server: (backing: Backing, ...args: A) => Promise<R>
}): ((...args: A) => Promise<R>) => {
  // The server's road goes through `viaServer` and its refusal relay; the
  // IPC road never enters the relay, since nothing of it reached the server
  // and a sidebar edit must not take down a notice the sessions put up.
  const routed = viaServer<A, R>({ ipc: route.ipc, server: route.server })
  return async (...args) =>
    (await sidebarTransport()) === 'server' ? routed(...args) : route.ipc(...args)
}
/** The persisted key of a window named by its id, from the live list. */
const keyOfWindow = async (windowId: number): Promise<string | null> => {
  const list = (await ipcRenderer.invoke('window:list')) as WindowIdentity[]
  return list.find((w) => w.windowId === windowId)?.windowKey ?? null
}
// What the window hears about its sidebar: the shell sends every change over
// IPC while the sidebar's road is IPC; once it is the server, the push
// channel carries it (`sidebar.layout_changed` events) and the shell sends
// nothing, so a change is heard once. The push listener is wired on the
// first routed sidebar call, so the client is never loaded for it alone.
type SidebarLayoutSnapshot = {
  readonly windowKey: string
  readonly revision: number
  readonly groups: ReadonlyArray<unknown>
  readonly displayOrder: ReadonlyArray<string>
}
type SidebarLayoutChanged = {
  _tag: 'sidebar.layout_changed'
  layout: SidebarLayoutSnapshot
  cause: string
}
type SidebarSaveResult =
  | { ok: true; layout: SidebarLayoutSnapshot }
  | { ok: false; reason: 'no-window' }
  | { ok: false; reason: 'conflict'; current: SidebarLayoutSnapshot }
type MoveResult = {
  readonly moved: ReadonlyArray<string>
  readonly refused: ReadonlyArray<{
    readonly sessionId: string
    readonly reason: 'not-live' | 'not-tmux' | 'same-window'
  }>
}
const sidebarListeners = new Set<(event: SidebarLayoutChanged) => void>()
let sidebarPushWired: Backing | null = null
const listenToSidebarPush = (backing: Backing): void => {
  if (sidebarPushWired === backing) return
  sidebarPushWired = backing
  backing.push.onEvent((envelope) => {
    const event = envelope.event as { _tag: string }
    if (event._tag !== 'sidebar.layout_changed') return
    for (const listener of [...sidebarListeners]) listener(event as SidebarLayoutChanged)
  })
  backing.push.connect()
  // The catch-up: between the moment the shell's road became the server's
  // (its IPC mirror stops) and this wiring, a change may have gone by with
  // nobody to hear it. The layout is read once the socket is WELCOMED (the
  // hub sends events to welcomed peers only, so a read before the welcome
  // would leave a write between the two unheard) and handed to the
  // listeners as a change; one at or below the revision the window knows
  // is dropped by the store, so the read costs nothing when nothing moved.
  void Promise.all([windowKey(), backing.push.whenOpen()]).then(
    async ([key]) => {
      if (!key) return
      try {
        const layout = await backing.api.sidebar.getLayout(key)
        const event: SidebarLayoutChanged = {
          _tag: 'sidebar.layout_changed',
          layout,
          cause: 'command'
        }
        for (const listener of [...sidebarListeners]) listener(event)
      } catch {
        // The next change arrives on the push channel; the next call tells the caller.
      }
    },
    () => {
      // The socket gave up (a refused token, a closed client): nothing to catch up on.
    }
  )
}
/** The sidebar's wire on lane A's shared signal (`onServerAvailable`): at
 *  once when the backing is known, else when it becomes known, so a window
 *  that booted before the server was up hears the sidebar the moment the
 *  server answers (with the catch-up read above). On the IPC road for good
 *  (attached mode) nothing is wired: the shell mirrors every change over
 *  IPC, and a push socket to a server that holds no layout would only read
 *  nothing from it. */
const wireSidebarPush = (backing: Backing): void => {
  void sidebarTransport().then((road) => {
    if (road === 'server') listenToSidebarPush(backing)
  })
}

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
// ── The terminal pane's road (lane C of wave 3) ──
// A terminal's start, its resizes and its bytes go over IPC inside the app,
// where the bytes are ordered and cost nothing, and to the server only when
// the app is ATTACHED to one, whose terminals run in that process (the shell
// of an attached app has none to write to). The mode is the endpoint's own
// word (`mode`, `src/main/server/endpoint.ts`), asked of main once it names
// one. The bytes keep their order over HTTP by chaining per session; the
// pane's listeners hear the bytes and the exit over IPC as always and, when
// attached, off the push channel's `pty` frames and exit instead, never both.
type ServerMode = 'in-process' | 'attached'
let serverModeKnown: ServerMode | null = null
const serverMode = async (): Promise<ServerMode | null> => {
  if (serverModeKnown) return serverModeKnown
  const found = (await ipcRenderer.invoke(IPC_SERVER_ENDPOINT)) as { mode?: ServerMode } | null
  if (found?.mode) serverModeKnown = found.mode
  return found?.mode ?? null
}
// The mode is asked for as the window starts and again whenever the server
// is announced, so by the time a terminal pane exists it is known: inside
// the app the pane's calls then stay SYNCHRONOUS sends, as they always were
// (a write that waited on a promise first reordered against the pane's
// own start and resize), and only an app known to be attached takes the
// server road.
void serverMode()
const terminalChains = new Map<string, Promise<void>>()
const viaAttachedServer =
  <A extends unknown[]>(route: {
    ipc: (...args: A) => void
    server: (backing: Backing, ...args: A) => Promise<void>
  }) =>
  async (...args: A): Promise<void> => {
    if (serverModeKnown !== 'attached') {
      route.ipc(...args)
      if (!serverModeKnown) void serverMode()
      return
    }
    const backing = await serverRouter.backing()
    if (!backing) throw new Error('The app is attached to a server it cannot reach')
    const id = String(args[0])
    const next = (terminalChains.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => route.server(backing, ...args))
    terminalChains.set(id, next)
    try {
      await next
    } finally {
      if (terminalChains.get(id) === next) terminalChains.delete(id)
    }
  }
/** The IPC listener always; the push binding only once the server is there
 *  AND the app is attached to it. */
function onAttachedPush(
  ipcOff: () => void,
  bind: (push: import('@clave/client').PushClient) => () => void
): () => void {
  let pushOff: (() => void) | null = null
  let gone = false
  const withdraw = onServerAvailable((backing) => {
    void serverMode().then((mode) => {
      if (gone || mode !== 'attached') return
      pushOff = bind(backing.push)
    })
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

/**
 * A settings listener (lane D): main fans a settings change out on BOTH
 * transports from the one source (`src/main/settings/source.ts`: the IPC
 * handlers and the server's events bridge), and the window hears exactly one
 * of them, IPC while the push socket is not open and the push channel while
 * it is (`dual-listener.ts` beside this file, tested there). This differs from
 * `onBothTransports` above on purpose: there main picks the transport, here
 * the window does, so a window whose first call came before the server was up
 * still hears every change, and a reconnection loses none. `pick` turns the
 * event into what the callback has always received; `undefined` drops it (a
 * window's own echo).
 */
function viaServerEvent<E extends ServerEvent['_tag'], T>(
  channel: string,
  tag: E,
  pick: (event: Extract<ServerEvent, { _tag: E }>) => T | undefined
): (callback: (value: T) => void) => () => void {
  return dualListener<E, T>({
    bindIpc: (callback) => createIpcListener<[T]>(channel, callback),
    backing: () => serverRouter.backing().then((backing) => backing?.push ?? null),
    tag,
    pick
  })
}

/** The contract's answers are readonly through and through; the renderer's
 *  types are not. Same shape (the contract was written from them). */
const loose = <T>(value: unknown): T => value as T

/** The sign-in's answer as the server (or main, before it) gives it: the
 *  status and the handoff. Routed like every settings call; the method on
 *  the bridge splits it so the handoff never reaches the page. */
type AntasphereSignInAnswer = {
  status: unknown
  handoff: { url: string; generation: number } | null
}
const antasphereSignIn = viaServer<[], AntasphereSignInAnswer>({
  ipc: () => ipcRenderer.invoke('antasphere-account:sign-in'),
  server: ({ api }) => api.settings.antasphere.signIn().then(loose<AntasphereSignInAnswer>)
})
/** Whether the handoff is still the one issued for the login in flight,
 *  asked of the manager that issued it right before the browser opens: a
 *  cancel, a sign-out or a new login since the sign-in's answer, and the
 *  link opens nothing. A read, never a start. A server that cannot answer
 *  (gone, refusing) is a no: the browser never opens on a guess. */
const antasphereConfirmHandoff = viaServer<[{ url: string; generation: number }], boolean>({
  ipc: (handoff) => ipcRenderer.invoke('antasphere-account:confirm-handoff', handoff),
  server: ({ api }, handoff) => api.settings.antasphere.confirmHandoff(handoff)
})
/**
 * This preload's own order of the account's operations, the guard between
 * the confirmation and the open. The server's confirmation is a read of the
 * manager's state when it answered; its reply can be delayed, and a cancel,
 * a sign-out or a newer sign-in can finish here before an older `true`
 * lands. So a sign-in takes a number when it starts, each of those bumps
 * the number synchronously, before anything is awaited, and the sign-in
 * checks its number after every await and once more right before the open:
 * behind, it opens nothing and answers the status it was given (the page's
 * store drops a stale answer in its turn). A status heard from the server
 * saying the login is no longer in flight (another window cancelled, the
 * browser came back, a sign-out elsewhere) bumps it too; the start's own
 * `signing-in` push does not, since that is the flow being opened.
 *
 * The boundary, stated plainly: the confirmation and the OS opening the
 * browser are two steps, not one transaction. What this guard closes is
 * everything this preload hears before it hands the URL to main; a cancel
 * on the server in the microseconds after that still lands on the manager's
 * callback check (a stale state opens nothing there), not on the browser.
 */
const antasphereCancel = viaServer<[], unknown>({
  ipc: () => ipcRenderer.invoke('antasphere-account:cancel'),
  server: ({ api }) => api.settings.antasphere.cancel()
})
const antasphereSignOut = viaServer<[], unknown>({
  ipc: () => ipcRenderer.invoke('antasphere-account:sign-out'),
  server: ({ api }) => api.settings.antasphere.signOut()
})
const antasphereChanged = viaServerEvent(
  'antasphere-account:changed',
  'accounts.antasphere_changed',
  (event) => event.status as unknown
)
let accountOp = 0
const nextAccountOp = (): number => ++accountOp
const onAccountStatus = (status: unknown): void => {
  const phase = (status as { phase?: unknown } | null)?.phase
  if (phase !== 'signing-in') nextAccountOp()
}
const profiles = loose<LaunchProfilePreferences>
type UsageRead = typeof import('@clave/contract/settings').UsageReadView.Type
type PiUsageTotals = typeof import('@clave/contract/settings').PiUsageTotalsView.Type
type AppIcon = typeof import('@clave/contract/settings').AppIconSchema.Type
type RegistryWriteResult =
  typeof import('@clave/contract/settings').UpdateWorkspaceRegistry.success.Type
type PinsWriteResult = typeof import('@clave/contract/settings').UpdateWorkspacePins.success.Type

// ── The workspace files (wave 3, lane A): the review round trip and the watches ──
// A `.clave` read that goes through the server may need a review; the server
// publishes it on the push channel with the requestId this window sent, and
// the relay below shows the SHELL's dialog (over IPC, Electron's own) and
// answers the server. The listener joins the push channel the moment the
// server is known, before any read goes out (the read itself also waits for
// the welcome). The watches a window holds move to the server with it.
type ClaveFileReadResult = import('../preload/index.d').ClaveFileReadResult
type ClaveFileWriteData = import('../preload/index.d').ClaveFileWriteData
type ReviewNeeded = Extract<ServerEvent, { _tag: 'workspace_files.review_needed' }>
let answerReviewOn: Backing | null = null
const workspaceFilesRelay = createReviewRelay({
  showDialog: (review: ReviewNeeded) =>
    ipcRenderer.invoke('clave:review-dialog', {
      path: review.path,
      folder: review.folder,
      autoCommands: [...review.autoCommands],
      prompts: [...review.prompts],
      dangerous: review.dangerous
    }) as Promise<{ response: 0 | 1 | 2; checkboxChecked: boolean }>,
  answer: (reviewId, answer) => {
    if (!answerReviewOn) return Promise.reject(new Error('no server to answer the review on'))
    return answerReviewOn.api.workspaceFiles.answerReview(reviewId, answer)
  }
})
// This window names itself as the HOLDER of its watches, one name per road:
// in the shipped app the two roads reach the one instance main holds, and a
// watch handed from IPC to the server must be released on the IPC name and
// kept on the server's, or the hand-over would close the watcher (round 1
// of the lane's verifier). Two windows on one file are two holders.
const windowHolder = crypto.randomUUID()
const workspaceFileWatches = createWatchLedger({
  ipc: {
    watch: (p) => ipcRenderer.invoke('clave:watch-file', p, `ipc:${windowHolder}`) as Promise<void>,
    unwatch: (p) =>
      ipcRenderer.invoke('clave:unwatch-file', p, `ipc:${windowHolder}`) as Promise<void>
  },
  server: {
    watch: async (p) => {
      const backing = await serverRouter.backing()
      if (!backing) throw new Error('no server to watch on')
      await backing.api.workspaceFiles.watch(p, `server:${windowHolder}`)
    },
    unwatch: async (p) => {
      const backing = await serverRouter.backing()
      if (!backing) throw new Error('no server to unwatch on')
      await backing.api.workspaceFiles.unwatch(p, `server:${windowHolder}`)
    }
  }
})
/** The push welcome, or a failure after fifteen seconds: a socket stuck
 *  reconnecting must fail a read the way the HTTP road fails, not hang it. */
const PUSH_OPEN_DEADLINE_MS = 15_000
const pushOpenOrFail = (push: import('@clave/client').PushClient): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The server’s push channel did not open in time.')),
      PUSH_OPEN_DEADLINE_MS
    )
    push.whenOpen().then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
/** Join the server for the workspace files: the review listener on the push
 *  channel, the answer road, the watches moved. Wired on the first routed
 *  read (which also waits for the welcome) or on the first watch, never at
 *  window start, so the client is never loaded for it alone. */
let workspaceFilesWired: Backing | null = null
const wireWorkspaceFiles = (backing: Backing): void => {
  if (workspaceFilesWired === backing) return
  workspaceFilesWired = backing
  answerReviewOn = backing
  backing.push.onEvent(workspaceFilesRelay.onEvent)
  backing.push.connect()
  void workspaceFileWatches.moveToServer()
}
let workspaceFilesWaiting = false
const watchWorkspaceFilesServer = (): void => {
  if (workspaceFilesWaiting) return
  workspaceFilesWaiting = true
  onServerAvailable(wireWorkspaceFiles)
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

  // ── Settings (lane D): launch profiles, every one with a server arm ──
  launchProfilesList: viaServer<[], LaunchProfilePreferences>({
    ipc: () => ipcRenderer.invoke('launch-profiles:list'),
    server: async ({ api }) => profiles(await api.settings.launchProfiles.list())
  }),
  launchProfileUpsert: viaServer<[LaunchProfile], LaunchProfilePreferences>({
    ipc: (profile) => ipcRenderer.invoke('launch-profiles:upsert', profile),
    server: async ({ api }, profile) => profiles(await api.settings.launchProfiles.upsert(profile))
  }),
  launchProfileDelete: viaServer<[string], LaunchProfilePreferences>({
    ipc: (profileId) => ipcRenderer.invoke('launch-profiles:delete', profileId),
    server: async ({ api }, profileId) =>
      profiles(await api.settings.launchProfiles.delete(profileId))
  }),
  launchProfileSetGlobal: viaServer<[LauncherFamily, string | null], LaunchProfilePreferences>({
    ipc: (family, profileId) =>
      ipcRenderer.invoke('launch-profiles:set-global', { family, profileId }),
    server: async ({ api }, family, profileId) =>
      profiles(await api.settings.launchProfiles.setGlobal(family, profileId))
  }),
  launchProfileSetWorkspace: viaServer<
    [string, LauncherFamily, string | null],
    LaunchProfilePreferences
  >({
    ipc: (workspaceId, family, profileId) =>
      ipcRenderer.invoke('launch-profiles:set-workspace', { workspaceId, family, profileId }),
    server: async ({ api }, workspaceId, family, profileId) =>
      profiles(await api.settings.launchProfiles.setWorkspace(workspaceId, family, profileId))
  }),
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

  writeSession: viaAttachedServer<[string, string]>({
    ipc: (id, data) => ipcRenderer.send('pty:write', id, data),
    server: ({ api }, id, data) =>
      api.sessions.write(id, { type: 'bytes', data: new TextEncoder().encode(data) })
  }),

  startSession: viaAttachedServer<[string, number, number]>({
    ipc: (id, cols, rows) => ipcRenderer.send('pty:start', id, cols, rows),
    server: ({ api }, id, cols, rows) => api.sessions.resize(id, cols, rows)
  }),

  resizeSession: viaAttachedServer<[string, number, number]>({
    ipc: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    server: ({ api }, id, cols, rows) => api.sessions.resize(id, cols, rows)
  }),

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
    onAttachedPush(createIpcListener<[string]>(`pty:data:${id}`, callback), (push) => {
      // One decoder per listener: a multibyte character split across two
      // frames is finished by the next one, as the shell's own decoder did.
      const decoder = new TextDecoder()
      return push.subscribe(id, (stream) => {
        const frame = stream as SessionStream
        if (frame.kind === 'pty') callback(decoder.decode(frame.data, { stream: true }))
      })
    }),

  onSessionExit: (id: string, callback: (exitCode: number) => void) =>
    onAttachedPush(createIpcListener<[number]>(`pty:exit:${id}`, callback), (push) =>
      push.subscribe(id, noop, callback)
    ),

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

  // ── Lane D (wave 3): the agent tools reach this window through the server ──
  // The app's MCP server asks a window through a view request: a `request`
  // frame on the push channel carrying the key of the window it is for, which
  // this window answers through the server's `views.answer` command. The IPC
  // pair (`mcp:command` in, `mcp:response` out) stays for the harness's
  // `callMcp`, which drives the dispatcher directly; the app never sends it.
  // Both roads deliver to the one dispatcher, and an answer goes back the way
  // its request came.
  onMcpCommand: (
    callback: (msg: { requestId: string; command: string; payload: unknown }) => void
  ) => {
    const offIpc = createIpcListener<[{ requestId: string; command: string; payload: unknown }]>(
      'mcp:command',
      callback
    )
    let offPush: (() => void) | null = null
    const withdraw = onServerAvailable((backing) => {
      const mine = windowKey()
      offPush = backing.push.onRequest((request) => {
        void mine.then((key) => {
          if (!key || request.windowKey !== key) return
          serverViewRequests.add(request.requestId)
          callback({
            requestId: request.requestId,
            command: request.command,
            payload: request.payload
          })
        })
      })
    })
    return () => {
      offIpc()
      withdraw()
      offPush?.()
    }
  },

  mcpRespond: (response: { requestId: string; ok: boolean; result?: unknown; error?: string }) => {
    if (!serverViewRequests.delete(response.requestId)) {
      ipcRenderer.send('mcp:response', response)
      return
    }
    const backing = serverBacking
    if (!backing) return
    void backing.api.views
      .answer({
        requestId: response.requestId,
        ok: response.ok,
        ...(response.result !== undefined && { result: response.result }),
        ...(response.error !== undefined && { error: response.error })
      })
      .catch((error: unknown) => {
        // A late answer to a request the server gave up on is nothing to do.
        console.warn('[mcp] the view request could not be answered', error)
      })
  },

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

  // ── Settings (lane D): the app icon ──
  setAppIcon: viaServer<[string], void>({
    ipc: (icon) => ipcRenderer.invoke('app:set-icon', icon),
    server: ({ api }, icon) => api.settings.preferences.setAppIcon(icon as AppIcon)
  }),
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

  // ── The sidebar (lane C, PRDCT-3241) ──
  // A window's groups, terminals, views and order live on the server, one
  // layout per window key with a revision. The window reads its own at boot
  // and writes it whole with the revision it last saw; a stale write is
  // refused with the current snapshot (`reason: 'conflict'`), never merged,
  // and every change made by anyone arrives through onSidebarLayoutChanged.
  // Routed through the client when the server runs inside the app, over IPC
  // when the app is attached to a server elsewhere: that server has no
  // windows to host, so the shell keeps the sidebar (`sidebar:transport`,
  // asked until main has decided). Both roads end on one instance.
  sidebarLayoutLoad: viaSidebar<[], SidebarLayoutSnapshot>({
    ipc: () => ipcRenderer.invoke('sidebar-layout:load'),
    server: async (backing) => {
      const key = await windowKey()
      if (!key) return { windowKey: '', revision: 0, groups: [], displayOrder: [] }
      listenToSidebarPush(backing)
      return backing.api.sidebar.getLayout(key)
    }
  }),
  sidebarLayoutSave: viaSidebar<
    [data: { groups: unknown[]; displayOrder: string[] }, baseRevision?: number],
    SidebarSaveResult
  >({
    ipc: (data, baseRevision) => ipcRenderer.invoke('sidebar-layout:save', data, baseRevision),
    server: async (backing, data, baseRevision) => {
      const key = await windowKey()
      if (!key) return { ok: false, reason: 'no-window' }
      listenToSidebarPush(backing)
      try {
        const layout = await backing.api.sidebar.saveLayout({
          windowKey: key,
          ...(baseRevision !== undefined && { baseRevision }),
          groups: data.groups as unknown as ReadonlyArray<SidebarGroup>,
          displayOrder: data.displayOrder
        })
        return { ok: true, layout }
      } catch (error) {
        const conflict = error as { _tag?: string; current?: SidebarLayoutSnapshot }
        if (conflict && conflict._tag === 'LayoutConflict' && conflict.current) {
          return { ok: false, reason: 'conflict', current: conflict.current }
        }
        throw error
      }
    }
  }),
  onSidebarLayoutChanged: (callback: (event: SidebarLayoutChanged) => void): (() => void) => {
    sidebarListeners.add(callback)
    const withdraw = onServerAvailable(wireSidebarPush)
    const offIpc = createIpcListener<[SidebarLayoutChanged]>('sidebar:layout-changed', callback)
    return () => {
      sidebarListeners.delete(callback)
      withdraw()
      offIpc()
    }
  },

  // Workspace registry + pins — main-process JSON storage, same crash-safety
  // rationale as the sidebar layouts, written FIELD BY FIELD: several windows
  // share the file, and a whole-file save was last-writer-wins.
  // ── Settings (lane D): the workspaces. Through the server the write
  // carries this window's key as its origin, and the change event carries it
  // back so this window drops its own echo, the way the IPC handler skips
  // the sender. ──
  workspaceLoad: viaServer<[], WorkspaceStateFile>({
    ipc: () => ipcRenderer.invoke('workspace:load'),
    server: async ({ api }) => loose<WorkspaceStateFile>(await api.settings.workspaces.load())
  }),
  workspaceUpdateRegistry: viaServer<[unknown[]], RegistryWriteResult>({
    ipc: (workspaces) => ipcRenderer.invoke('workspace:update-registry', workspaces),
    server: async ({ api }, workspaces) =>
      api.settings.workspaces.updateRegistry(
        workspaces as Workspace[],
        (await windowKey()) ?? undefined
      )
  }),
  workspaceUpdatePins: viaServer<[string | null | 'all', unknown[]], PinsWriteResult>({
    ipc: (scope, pins) => ipcRenderer.invoke('workspace:update-pins', scope, pins),
    server: async ({ api }, scope, pins) =>
      api.settings.workspaces.updatePins(scope, pins, (await windowKey()) ?? undefined)
  }),
  workspaceSetLastActive: viaServer<[string | null], { ok: true }>({
    ipc: (workspaceId) => ipcRenderer.invoke('workspace:set-last-active', workspaceId),
    server: async ({ api }, workspaceId) => {
      await api.settings.workspaces.setLastActive(workspaceId)
      return { ok: true as const }
    }
  }),
  onWorkspaceStateChanged: (
    callback: (state: { workspaces: unknown[]; pins: unknown[] }) => void
  ): (() => void) => {
    // This window's key, read once: the echo test needs it synchronously.
    let mine: string | null = null
    void windowKey().then((key) => {
      mine = key
    })
    return viaServerEvent(
      'workspace:state-changed',
      'workspaces.state_changed',
      workspaceStatePick(() => mine)
    )(callback)
  },

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
  // Move live tabs (tmux-backed) to another window, id and scrollback kept:
  // a command of the sidebar domain, which detaches and re-homes through
  // the shell. The pickers name a window by id; the wire names it by key.
  windowMoveSessions: viaSidebar<[sessionIds: string[], targetWindowId: number], MoveResult>({
    ipc: (sessionIds, targetWindowId) =>
      ipcRenderer.invoke('window:move-sessions', sessionIds, targetWindowId),
    server: async (backing, sessionIds, targetWindowId) => {
      const targetWindowKey = await keyOfWindow(targetWindowId)
      if (!targetWindowKey) {
        return {
          moved: [],
          refused: sessionIds.map((id) => ({ sessionId: id, reason: 'not-live' }))
        }
      }
      return backing.api.sidebar.moveSessions({ sessionIds, targetWindowKey, focus: true })
    }
  }),
  // Move a whole group (its live members and terminals with it) to another
  // window. The domain holds the group; the renderer names it by id.
  windowMoveGroup: viaSidebar<
    [group: unknown, targetWindowId: number],
    MoveResult & { ok: boolean }
  >({
    ipc: (group, targetWindowId) => ipcRenderer.invoke('window:move-group', group, targetWindowId),
    server: async (backing, group, targetWindowId) => {
      const groupId = (group as { id?: unknown } | null)?.id
      const [windowKeyOfMine, targetWindowKey] = await Promise.all([
        windowKey(),
        keyOfWindow(targetWindowId)
      ])
      if (typeof groupId !== 'string' || !windowKeyOfMine || !targetWindowKey) {
        return { ok: false, moved: [], refused: [] }
      }
      if (windowKeyOfMine === targetWindowKey) return { ok: false, moved: [], refused: [] }
      try {
        return await backing.api.sidebar.moveGroup({
          windowKey: windowKeyOfMine,
          groupId,
          targetWindowKey
        })
      } catch (error) {
        if ((error as { _tag?: string })?._tag === 'GroupNotFound') {
          return { ok: false, moved: [], refused: [] }
        }
        throw error
      }
    }
  }),

  // Usage. The Claude read is per account (the machine login when omitted);
  // main polls every account on its own clock and pushes each result.
  // ── Settings (lane D): usage, accounts, logins, every one with a server arm ──
  getUsageLimits: viaServer<[string?, { force?: boolean }?], UsageRead>({
    ipc: (accountId, options) => ipcRenderer.invoke('usage:get-limits', accountId, options),
    server: ({ api }, accountId, options) =>
      api.settings.usage.readClaude(accountId, options).then(loose<UsageRead>)
  }),
  getClaudeUsageSnapshot: viaServer<[], Record<string, UsageRead>>({
    ipc: () => ipcRenderer.invoke('usage:claude-snapshot'),
    server: ({ api }) => api.settings.usage.claudeSnapshot().then(loose<Record<string, UsageRead>>)
  }),
  onClaudeAccountUsage: viaServerEvent('usage:claude-account', 'usage.claude_read', (event) => ({
    accountId: event.accountId,
    result: event.result as unknown
  })),

  // Claude accounts: the list crosses; a token goes in and never comes back.
  // Through the server the token is the one field of one command, redacted
  // in the contract, opened in the handler, and in no answer or event.
  claudeAccountsList: viaServer<[], unknown[]>({
    ipc: () => ipcRenderer.invoke('claude-accounts:list'),
    server: async ({ api }) => [...(await api.settings.claudeAccounts.list())]
  }),
  claudeAccountsMigrated: viaServer<[], string[]>({
    ipc: () => ipcRenderer.invoke('claude-accounts:migrated'),
    server: async ({ api }) => [...(await api.settings.claudeAccounts.migrated())]
  }),
  claudeAccountAdd: viaServer<[{ label: string }], unknown>({
    ipc: (input) => ipcRenderer.invoke('claude-accounts:add', input),
    server: ({ api }, input) => api.settings.claudeAccounts.add(input.label)
  }),
  claudeAccountUpdate: viaServer<[string, { label?: string }], unknown>({
    ipc: (id, updates) => ipcRenderer.invoke('claude-accounts:update', id, updates),
    server: ({ api }, id, updates) => api.settings.claudeAccounts.rename(id, updates)
  }),
  claudeAccountReorder: viaServer<[string[]], void>({
    ipc: (ids) => ipcRenderer.invoke('claude-accounts:reorder', ids),
    server: ({ api }, ids) => api.settings.claudeAccounts.reorder(ids)
  }),
  claudeAccountRemove: viaServer<[string], boolean>({
    ipc: (id) => ipcRenderer.invoke('claude-accounts:remove', id),
    server: ({ api }, id) => api.settings.claudeAccounts.remove(id)
  }),
  claudeAccountSetToken: viaServer<[string, string], UsageRead>({
    ipc: (id, token) => ipcRenderer.invoke('claude-accounts:set-token', id, token),
    server: ({ api }, id, token) =>
      api.settings.claudeAccounts.setToken(id, token).then(loose<UsageRead>)
  }),
  claudeAccountClearToken: viaServer<[string], void>({
    ipc: (id) => ipcRenderer.invoke('claude-accounts:clear-token', id),
    server: ({ api }, id) => api.settings.claudeAccounts.clearToken(id)
  }),
  onClaudeAccountsChanged: viaServerEvent(
    'claude-accounts:changed',
    'accounts.claude_changed',
    (event) => [...event.accounts] as unknown[]
  ),
  // Codex accounts (ADR 0002): a home per account; no credential crosses.
  codexAccountsList: viaServer<[], unknown[]>({
    ipc: () => ipcRenderer.invoke('codex-accounts:list'),
    server: async ({ api }) => [...(await api.settings.codexAccounts.list())]
  }),
  codexAccountAdd: viaServer<[{ label: string; kind?: 'chatgpt' | 'apiKey' }], unknown>({
    ipc: (input) => ipcRenderer.invoke('codex-accounts:add', input),
    server: ({ api }, input) => api.settings.codexAccounts.add(input.label, input.kind)
  }),
  codexAccountUpdate: viaServer<[string, { label?: string }], unknown>({
    ipc: (id, updates) => ipcRenderer.invoke('codex-accounts:update', id, updates),
    server: ({ api }, id, updates) => api.settings.codexAccounts.rename(id, updates)
  }),
  codexAccountReorder: viaServer<[string[]], void>({
    ipc: (ids) => ipcRenderer.invoke('codex-accounts:reorder', ids),
    server: ({ api }, ids) => api.settings.codexAccounts.reorder(ids)
  }),
  codexAccountRemove: viaServer<[string], boolean>({
    ipc: (id) => ipcRenderer.invoke('codex-accounts:remove', id),
    server: ({ api }, id) => api.settings.codexAccounts.remove(id)
  }),
  codexAccountClearCredential: viaServer<[string], void>({
    ipc: (id) => ipcRenderer.invoke('codex-accounts:clear-credential', id),
    server: ({ api }, id) => api.settings.codexAccounts.clearCredential(id)
  }),
  onCodexAccountsChanged: viaServerEvent(
    'codex-accounts:changed',
    'accounts.codex_changed',
    (event) => [...event.accounts] as unknown[]
  ),
  // The login flows: a job's status, link and reason cross; nothing else.
  // The API key is the one field of one command, redacted in the contract.
  accountLoginStart: viaServer<['claude' | 'codex', string], unknown>({
    ipc: (provider, accountId) => ipcRenderer.invoke('accounts:login-start', provider, accountId),
    server: ({ api }, provider, accountId) => api.settings.logins.start(provider, accountId)
  }),
  accountLoginApiKey: viaServer<[string, string], unknown>({
    ipc: (accountId, apiKey) => ipcRenderer.invoke('accounts:login-api-key', accountId, apiKey),
    server: ({ api }, accountId, apiKey) => api.settings.logins.startApiKey(accountId, apiKey)
  }),
  accountLoginInput: viaServer<[string, string], void>({
    ipc: (jobId, text) => ipcRenderer.invoke('accounts:login-input', jobId, text),
    server: ({ api }, jobId, text) => api.settings.logins.input(jobId, text)
  }),
  accountLoginCancel: viaServer<[string], void>({
    ipc: (jobId) => ipcRenderer.invoke('accounts:login-cancel', jobId),
    server: ({ api }, jobId) => api.settings.logins.cancel(jobId)
  }),
  accountLoginList: viaServer<[], unknown[]>({
    ipc: () => ipcRenderer.invoke('accounts:login-list'),
    server: async ({ api }) => [...(await api.settings.logins.list())]
  }),
  onAccountLoginProgress: viaServerEvent(
    'accounts:login-progress',
    'accounts.login_progressed',
    (event) => event.job as unknown
  ),
  // The Antasphere account (PRDCT-3259): the status crosses, in and out;
  // the login itself and its tokens stay on the server. A sign-in answers
  // this preload the browser handoff (the authorization URL, bound to the
  // login's generation), which goes to main to open and never to the page:
  // the page gets the status. A browser main refuses or cannot open is not
  // a failed sign-in: the login waits, and the status says so.
  antasphereAccountGet: viaServer<[], unknown>({
    ipc: () => ipcRenderer.invoke('antasphere-account:get'),
    server: ({ api }) => api.settings.antasphere.status()
  }),
  antasphereAccountSignIn: async (): Promise<unknown> => {
    const mine = nextAccountOp()
    const { status, handoff } = await antasphereSignIn()
    if (handoff && mine === accountOp) {
      // Confirmed with the login's own manager at the last moment, then
      // opened by main, which checks the target against its own issuer. A
      // confirmation that fails or cannot be had opens nothing; neither
      // outcome is a failed sign-in, since the login waits regardless.
      const current = await antasphereConfirmHandoff(handoff).catch(() => false)
      if (current === true && mine === accountOp) {
        await ipcRenderer.invoke('antasphere-account:open-browser', handoff).catch(() => undefined)
      }
    }
    return status
  },
  antasphereAccountCancel: (): Promise<unknown> => {
    nextAccountOp()
    return antasphereCancel()
  },
  antasphereAccountSignOut: (): Promise<unknown> => {
    nextAccountOp()
    return antasphereSignOut()
  },
  antasphereAccountDismiss: viaServer<[], unknown>({
    ipc: () => ipcRenderer.invoke('antasphere-account:dismiss'),
    server: ({ api }) => api.settings.antasphere.dismiss()
  }),
  onAntasphereAccountChanged: (callback: (status: unknown) => void): (() => void) =>
    antasphereChanged((status) => {
      onAccountStatus(status)
      callback(status)
    }),
  // Codex usage is per account like Claude's (the machine's home when omitted).
  getCodexUsageLimits: viaServer<[string?, { force?: boolean }?], UsageRead>({
    ipc: (accountId, options) => ipcRenderer.invoke('usage:get-codex-limits', accountId, options),
    server: ({ api }, accountId, options) =>
      api.settings.usage.readCodex(accountId, options).then(loose<UsageRead>)
  }),
  getCodexUsageSnapshot: viaServer<[], Record<string, UsageRead>>({
    ipc: () => ipcRenderer.invoke('usage:codex-snapshot'),
    server: ({ api }) => api.settings.usage.codexSnapshot().then(loose<Record<string, UsageRead>>)
  }),
  onCodexAccountUsage: viaServerEvent('usage:codex-account', 'usage.codex_read', (event) => ({
    accountId: event.accountId,
    result: event.result as unknown
  })),
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
  getPiUsage: viaServer<['today' | '7d' | '30d' | 'all'], PiUsageTotals>({
    ipc: (range) => ipcRenderer.invoke('usage:get-pi', range),
    server: ({ api }, range) => api.settings.usage.readPi(range).then(loose<PiUsageTotals>)
  }),

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

  // ── The workspace files (wave 3, lane A): every call goes to the server
  // once main names it, over IPC before; the review dialog stays the shell's
  // either way (`workspaceFilesRelay` above and `clave:review-dialog`). ──
  readClaveFile: viaServer<[string, string?], ClaveFileReadResult | null>({
    ipc: (absolutePath, rootDir) => ipcRenderer.invoke('clave:read-file', absolutePath, rootDir),
    server: async (backing, absolutePath, rootDir) => {
      const { api, push } = backing
      // The review this read may need arrives on the push channel: the
      // listener is bound and the socket WELCOMED before the read goes out,
      // or the server could publish the review before this window hears
      // events and the read would wait for an answer nobody can give (wave
      // 2's lost-event shape).
      wireWorkspaceFiles(backing)
      await pushOpenOrFail(push)
      const read = workspaceFilesRelay.begin()
      try {
        return loose<ClaveFileReadResult | null>(
          await api.workspaceFiles.read(absolutePath, {
            requestId: read.requestId,
            ...(rootDir !== undefined && { rootDir })
          })
        )
      } finally {
        read.done()
      }
    }
  }),
  writeClaveFile: viaServer<[string, ClaveFileWriteData, string?], void>({
    ipc: (absolutePath, data, rootDir) =>
      ipcRenderer.invoke('clave:write-file', absolutePath, data, rootDir),
    // The preload's write type is the contract's shape with the renderer's
    // mutability (the contract was written from it); the cast is of that alone.
    server: ({ api }, absolutePath, data, rootDir) =>
      api.workspaceFiles.write(absolutePath, loose(data), rootDir)
  }),
  watchClaveFile: (absolutePath: string): Promise<void> => {
    watchWorkspaceFilesServer()
    return serverRouter.backing().then(
      (backing) => workspaceFileWatches.watch(absolutePath, backing ? 'server' : 'ipc'),
      () => workspaceFileWatches.watch(absolutePath, 'ipc')
    )
  },
  unwatchClaveFile: (absolutePath: string): Promise<void> =>
    workspaceFileWatches.unwatch(absolutePath),
  // The change listener's push side binds when the server IS there, not
  // when the listener is bound: a window that boots before main names the
  // server binds this at start, the router answers "no backing" then, and
  // the one-shot ask of `viaServerEvent` would leave the listener on IPC for
  // good; attached, once the ledger moved the watch to the server, nothing
  // came over IPC any more and the hot reload was lost (round 5 of the
  // lane's verifier, on the real app). `onServerAvailable` is the preload's
  // own signal for exactly this, the one the sessions' listeners wait on.
  onClaveFileChanged: dualListener<'workspace_files.changed', string>({
    bindIpc: (callback) => createIpcListener<[string]>('clave:file-changed', callback),
    backing: () =>
      new Promise((resolve) => {
        onServerAvailable((backing) => resolve(backing.push))
      }),
    tag: 'workspace_files.changed',
    pick: (event) => event.path
  }),
  saveFileDialog: (defaultName: string, filters: { name: string; extensions: string[] }[]) =>
    ipcRenderer.invoke('dialog:saveFile', defaultName, filters),
  getDownloadsPath: () => ipcRenderer.invoke('app:get-downloads-path') as Promise<string>,
  getUserDataPath: () => ipcRenderer.invoke('app:get-user-data-path') as Promise<string>,
  claveFileExists: viaServer<[string], boolean>({
    ipc: (absolutePath) => ipcRenderer.invoke('clave:file-exists', absolutePath),
    server: ({ api }, absolutePath) => api.workspaceFiles.exists(absolutePath)
  }),
  discoverClaveFiles: viaServer<[string], { name: string; path: string; rootDir: string | null }[]>(
    {
      ipc: (folderPath) => ipcRenderer.invoke('clave:discover-files', folderPath),
      server: async ({ api }, folderPath) =>
        loose([...(await api.workspaceFiles.discover(folderPath))])
    }
  ),
  discoverClaveFilesRecursive: viaServer<
    [string, { patterns?: string[]; exclude?: string[]; maxDepth?: number; workspaceId?: string }?],
    { name: string; path: string; rootDir: string }[]
  >({
    ipc: (rootDir, config) => ipcRenderer.invoke('clave:discover-files-recursive', rootDir, config),
    server: async ({ api }, rootDir, config) =>
      loose([...(await api.workspaceFiles.discoverRecursive(rootDir, config))])
  }),
  readAutoDiscoverConfig: viaServer<
    [string],
    { enabled: boolean; patterns?: string[]; exclude?: string[]; maxDepth?: number } | null
  >({
    ipc: (filePath) => ipcRenderer.invoke('clave:read-auto-discover', filePath),
    server: async ({ api }, filePath) => loose(await api.workspaceFiles.autoDiscover(filePath))
  }),
  readImageAsDataUrl: viaServer<[string], string | null>({
    ipc: (absolutePath) => ipcRenderer.invoke('clave:read-image', absolutePath),
    server: ({ api }, absolutePath) => api.workspaceFiles.image(absolutePath)
  }),
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
  trustWorkspaceRoot: viaServer<[string], void>({
    ipc: (root) => ipcRenderer.invoke('clave:trust-root', root),
    server: ({ api }, root) => api.workspaceFiles.trustRoot(root)
  }),
  untrustWorkspaceRoot: viaServer<[string], void>({
    ipc: (root) => ipcRenderer.invoke('clave:untrust-root', root),
    server: ({ api }, root) => api.workspaceFiles.untrustRoot(root)
  }),
  listTrustedRoots: viaServer<[], string[]>({
    ipc: () => ipcRenderer.invoke('clave:list-trusted-roots'),
    server: async ({ api }) => [...(await api.workspaceFiles.trustedRoots())]
  }),

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

  // ── Lane D: the settings are served (their methods sit in their sections above) ──

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
