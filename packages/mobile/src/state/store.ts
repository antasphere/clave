/**
 * The phone's one store (Zustand): the machines and their reachability, each
 * machine's workspaces, sessions and pending requests, the open conversations
 * with their page cursors, and the actions that move them through the
 * server client and the push client of each machine. The connections live
 * beside the store (a Map), never in its state: a socket is not data.
 *
 * Everything the store needs of the platform comes in through `Services`,
 * so the store runs under Node in the tests with stubs for fetch, the
 * socket, the storage and the secure store.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { ClaveServerClient, type ClaveServerClientOptions } from '../api/client'
import { ServerError, messageOf } from '../api/errors'
import {
  ClavePushClient,
  type PushClientOptions,
  type PushStatus,
  type PushStatusDetail
} from '../api/push'
import type { Drafts, KeyValueStore } from '../chat/drafts'
import type { BetaServices } from '../platform/beta'
import type { DeliveryController } from '../reconnect/controller'
import type { UnknownSend } from '../reconnect/ledger'
import { buildUserMessage } from '../attachments/compose'
import {
  applyFirstPage,
  mergeBufferedHistory,
  applyOlderPage,
  freshCursor,
  TimelineChanged,
  type BufferedItem,
  shouldLoadOlder,
  type HistoryCursor
} from '../chat/history'
import { type Conversation, emptyConversation, reduceConversation } from '../chat/reducer'
import type {
  Attachment,
  FileText,
  LaunchProfilePreferencesView,
  LaunchProfileView,
  RequestResponse,
  RequestSnapshot,
  ResolveOutcome,
  ServerEventEnvelope,
  Session,
  SessionPosition,
  SessionInfo,
  SpawnOptions,
  WorkspaceView
} from '../contract/types'
import type { DeveloperMachineSource } from '../machines/developer'
import type { BuildKind } from '../machines/transport-policy'
import type { CredentialStore, Machine, MachineSource } from '../machines/types'
import { sendMessage, type SendOutcome as DeliveryOutcome } from '../chat/send'
import type { Reachability } from './session-state'

export interface Services {
  readonly beta?: BetaServices
  readonly delivery?: DeliveryController
  /** Which build this is: decides the addresses a credential may go to. */
  readonly build: BuildKind
  readonly credentials: CredentialStore
  readonly sources: {
    /** The relay of the team, once the sign-in (lane D) supplies its token. */
    readonly relay: MachineSource | null
    /** Development builds only. */
    readonly developer: DeveloperMachineSource | null
  }
  readonly kv: KeyValueStore
  readonly drafts: Drafts
  readonly clientOptions?: ClaveServerClientOptions
  readonly pushOptions?: Omit<PushClientOptions, 'url' | 'token'>
  /** How the phone names itself to the server: `clave-mobile/ios`. */
  readonly clientName: string
  readonly now?: () => number
  readonly mintMessageId?: () => string
}

export interface Connection {
  readonly machine: Machine
  readonly client: ClaveServerClient
  readonly push: ClavePushClient
  readonly release: () => void
}

export interface ConversationState {
  readonly conversation: Conversation
  readonly cursor: HistoryCursor
  readonly error: string | null
  /** The push subscription is live for this conversation. */
  readonly subscribed: boolean
}

export interface RequestsState {
  readonly snapshot: RequestSnapshot | null
  /** The server has no requests port (an in-process server): the chat's
   *  own permission cards are the way to answer. */
  readonly unavailable: boolean
  readonly error: string | null
  readonly loading: boolean
}

export interface SendOutcome {
  readonly ok: boolean
  readonly error?: string
}

export const conversationKey = (machineId: string, sessionId: string): string =>
  `${machineId}\u0000${sessionId}`

export interface StoreState {
  readonly machines: Machine[]
  readonly machinesLoading: boolean
  readonly machinesError: string | null
  readonly mainMachineId: string | null
  readonly reachability: Readonly<Record<string, Reachability>>
  readonly workspaces: Readonly<Record<string, WorkspaceView[]>>
  readonly workspacesError: Readonly<Record<string, string | null>>
  readonly sessions: Readonly<Record<string, Session[]>>
  readonly sessionsError: Readonly<Record<string, string | null>>
  /** machine id → session id → the workspace the record is stamped with. */
  readonly stamps: Readonly<Record<string, Readonly<Record<string, string | undefined>>>>
  /** Conversation key → the last fatal error its stream carried. */
  readonly fatal: Readonly<Record<string, string>>
  readonly conversations: Readonly<Record<string, ConversationState>>
  readonly requests: Readonly<Record<string, RequestsState>>
  readonly profiles: Readonly<Record<string, LaunchProfilePreferencesView | null>>
  readonly profilesError: Readonly<Record<string, string | null>>

  loadMachines(): Promise<void>
  addDeveloperMachine(serverUrl: string, token: string, name?: string): Promise<Machine>
  removeDeveloperMachine(machineId: string): Promise<void>
  setMainMachine(machineId: string): Promise<void>
  connect(machineId: string): Promise<Connection>
  disconnect(machineId: string): void
  disconnectAll(): void
  loadWorkspaces(machineId: string): Promise<void>
  loadSessions(machineId: string): Promise<void>
  openChat(machineId: string, sessionId: string): Promise<() => void>
  loadOlder(machineId: string, sessionId: string): Promise<void>
  /** Refresh only currently subscribed conversations. Never dispatch a draft. */
  refreshOpenHistory(machineId: string): Promise<void>
  /** One send under an id the phone minted (or the one given); the outcome
   *  follows the table of `chat/send.ts`. The draft is cleared on `sent` only. */
  send(
    machineId: string,
    sessionId: string,
    text: string,
    clientMessageId?: string,
    attachments?: readonly Attachment[]
  ): Promise<DeliveryOutcome>
  answerInChat(
    machineId: string,
    sessionId: string,
    requestId: string,
    optionId: string,
    answers?: Record<string, string>
  ): Promise<SendOutcome>
  interrupt(machineId: string, sessionId: string): Promise<SendOutcome>
  loadRequests(machineId: string): Promise<void>
  resolveRequest(
    machineId: string,
    requestId: string,
    response: RequestResponse
  ): Promise<ResolveOutcome>
  loadProfiles(machineId: string): Promise<void>
  startSession(
    machineId: string,
    workspace: WorkspaceView,
    profile: LaunchProfileView
  ): Promise<SessionInfo>
  readFile(machineId: string, root: string, path: string): Promise<FileText>
}

const familyBoolean = (profile: LaunchProfileView): Partial<SpawnOptions> => {
  switch (profile.family) {
    case 'claude':
      return { claudeMode: true }
    case 'codex':
      return { codexMode: true }
    case 'pi':
      return { piMode: true }
    case 'antigravity':
      return { antigravityMode: true }
  }
}

/** The start payload the phone sends: the family boolean, the profile by id
 *  and its full definition (the seam the Mac uses for a server today), and
 *  the workspace. The target's accounts stay its own: none is carried. */
export function startPayload(
  workspace: WorkspaceView,
  profile: LaunchProfileView
): { cwd: string; options: SpawnOptions } {
  return {
    cwd: workspace.rootDir,
    options: {
      ...familyBoolean(profile),
      launchProfileId: profile.id,
      launchProfile: {
        id: profile.id,
        name: profile.name,
        family: profile.family,
        command: [...profile.command],
        additionalArgs: [...profile.additionalArgs],
        ...(profile.sourceProfileId ? { sourceProfileId: profile.sourceProfileId } : {}),
        ...(profile.pi ? { pi: profile.pi } : {})
      },
      workspaceId: workspace.id
    }
  }
}

/** The id the phone mints for a message, 8 to 64 characters. */
export function mintMessageId(random: () => number = Math.random): string {
  let hex = ''
  while (hex.length < 24) hex += Math.floor(random() * 16).toString(16)
  return `m-${hex.slice(0, 24)}`
}

const reachabilityOf = (status: PushStatus, detail: PushStatusDetail): Reachability => {
  switch (status) {
    case 'open':
      return 'reachable'
    case 'connecting':
    case 'idle':
      return 'connecting'
    case 'reconnecting':
      return 'unreachable'
    case 'closed':
      return detail.final === 'unauthorized' ? 'refused' : 'unreachable'
  }
}

/** Chats first, then the rest, each group by name: the launch form's order. */
export function orderProfiles(profiles: readonly LaunchProfileView[]): LaunchProfileView[] {
  const isChat = (p: LaunchProfileView): boolean =>
    p.id === 'claude-chat' ||
    p.id === 'codex-chat' ||
    p.id.startsWith('chat:') ||
    p.id === 'dev-echo-adapter'
  return [...profiles].sort(
    (a, b) => Number(isChat(b)) - Number(isChat(a)) || a.name.localeCompare(b.name)
  )
}

export function createStore(services: Services): UseBoundStore<StoreApi<StoreState>> {
  const connections = new Map<string, Connection>()
  const openHistory = new Map<
    string,
    {
      machineId: string
      refresh: () => Promise<void>
      close: () => void
      position: () => SessionPosition | undefined
    }
  >()
  const requestLoads = new Map<string, number>()
  const now = services.now ?? (() => Date.now())
  const mint = services.mintMessageId ?? (() => mintMessageId())

  return create<StoreState>()((set, get) => {
    const patch = <K extends keyof StoreState>(
      key: K,
      machineId: string,
      value: StoreState[K] extends Readonly<Record<string, infer V>> ? V : never
    ): void =>
      set((state) => ({
        [key]: { ...(state[key] as Record<string, unknown>), [machineId]: value }
      }))

    const conversationOf = (key: string): ConversationState =>
      get().conversations[key] ?? {
        conversation: emptyConversation,
        cursor: freshCursor,
        error: null,
        subscribed: false
      }
    const setConversation = (key: string, next: Partial<ConversationState>): void =>
      set((state) => ({
        conversations: {
          ...state.conversations,
          [key]: { ...conversationOf(key), ...next }
        }
      }))

    const applySessionEvent = (machineId: string, envelope: ServerEventEnvelope): void => {
      const event = envelope.event
      switch (event._tag) {
        case 'session.state_changed': {
          const sessions = get().sessions[machineId]
          if (!sessions) return
          patch(
            'sessions',
            machineId,
            sessions.map((s) => (s.id === event.id ? { ...s, state: event.state } : s))
          )
          return
        }
        case 'session.title_changed':
        case 'session.renamed': {
          const sessions = get().sessions[machineId]
          if (!sessions) return
          const title = event._tag === 'session.renamed' ? event.name : event.title
          patch(
            'sessions',
            machineId,
            sessions.map((s) => (s.id === event.id ? { ...s, title } : s))
          )
          return
        }
        case 'requests.changed':
          void get().loadRequests(machineId)
          return
        case 'workspaces.state_changed':
          patch('workspaces', machineId, [...event.workspaces])
          return
        default:
          return
      }
    }

    const fail = (error: unknown): string => messageOf(error)

    return {
      machines: [],
      machinesLoading: false,
      machinesError: null,
      mainMachineId: null,
      reachability: {},
      workspaces: {},
      workspacesError: {},
      sessions: {},
      sessionsError: {},
      stamps: {},
      fatal: {},
      conversations: {},
      requests: {},
      profiles: {},
      profilesError: {},

      async loadMachines() {
        set({ machinesLoading: true, machinesError: null })
        const found: Machine[] = []
        const problems: string[] = []
        for (const source of [services.sources.relay, services.sources.developer])
          if (source)
            try {
              found.push(...(await source.list()))
            } catch (error) {
              problems.push(fail(error))
            }
        const mainMachineId = await services.credentials.mainMachineId()
        set({
          machines: found,
          machinesLoading: false,
          machinesError: problems.length ? problems.join(' ') : null,
          mainMachineId: mainMachineId ?? found[0]?.id ?? null
        })
      },

      async addDeveloperMachine(serverUrl, token, name) {
        const developer = services.sources.developer
        if (!developer)
          throw new Error('The developer connection exists in development builds only.')
        const machine = await developer.add(serverUrl, token, name, services.clientOptions)
        await get().loadMachines()
        return machine
      },

      async removeDeveloperMachine(machineId) {
        get().disconnect(machineId)
        await services.sources.developer?.remove(machineId)
        await get().loadMachines()
      },

      async setMainMachine(machineId) {
        await services.credentials.setMainMachineId(machineId)
        set({ mainMachineId: machineId })
      },

      async connect(machineId) {
        const existing = connections.get(machineId)
        if (existing) return existing
        const machine = get().machines.find((m) => m.id === machineId)
        if (!machine) throw new Error('That machine is not in the list.')
        const credential = await services.credentials.get(machineId)
        const connected = connections.get(machineId)
        if (connected) return connected
        if (!credential) throw new Error(`No credential is kept for ${machine.name}.`)
        const client = new ClaveServerClient(
          { serverUrl: machine.baseUrl, bearer: credential.bearer },
          { build: services.build, ...services.clientOptions }
        )
        const push = new ClavePushClient({
          build: services.build,
          ...services.pushOptions,
          url: machine.pushUrl,
          token: credential.bearer,
          client: services.clientName
        })
        const offStatus = push.onStatus((status, detail) => {
          patch('reachability', machineId, reachabilityOf(status, detail))
          if (status === 'open') {
            void get().loadRequests(machineId)
            void services.delivery
              ?.reconnect({
                machineId,
                client,
                openConversations: [],
                refreshRequests: (id) => get().loadRequests(id),
                refreshHistory: async () => {}
              })
              .catch((error) => patch('sessionsError', machineId, fail(error)))
          }
        })
        const offEvents = push.onEvent((envelope) => applySessionEvent(machineId, envelope))
        const connection: Connection = {
          machine,
          client,
          push,
          release: () => {
            offStatus()
            offEvents()
            push.close()
          }
        }
        connections.set(machineId, connection)
        patch('reachability', machineId, 'connecting')
        push.connect()
        return connection
      },

      disconnect(machineId) {
        for (const open of [...openHistory.values()]) if (open.machineId === machineId) open.close()
        const connection = connections.get(machineId)
        if (!connection) return
        connections.delete(machineId)
        connection.release()
        set((state) => {
          const conversations = { ...state.conversations }
          for (const key of Object.keys(conversations))
            if (key.startsWith(`${machineId}\u0000`))
              conversations[key] = { ...conversations[key]!, subscribed: false }
          return { conversations }
        })
      },

      disconnectAll() {
        for (const id of [...connections.keys()]) get().disconnect(id)
      },

      async loadWorkspaces(machineId) {
        try {
          const { client } = await get().connect(machineId)
          const state = await client.workspaces.load()
          patch('workspaces', machineId, [...state.workspaces])
          patch('workspacesError', machineId, null)
        } catch (error) {
          patch('workspacesError', machineId, fail(error))
        }
      },

      async loadSessions(machineId) {
        try {
          const { client } = await get().connect(machineId)
          const sessions = await client.sessions.list()
          patch('sessions', machineId, sessions)
          patch('sessionsError', machineId, null)
          const records = await client.sessions.records(sessions.map((s) => s.id))
          const stamps: Record<string, string | undefined> = {}
          for (const record of records) stamps[record.id] = record.workspaceId
          patch('stamps', machineId, stamps)
        } catch (error) {
          patch('sessionsError', machineId, fail(error))
        }
      },

      async openChat(machineId, sessionId) {
        const key = conversationKey(machineId, sessionId)
        // A second mount adopts a fresh subscription; an old async page cannot overwrite it.
        openHistory.get(key)?.close()
        const { client, push } = await get().connect(machineId)
        openHistory.get(key)?.close()
        let active = true
        let buffering = true
        let buffered: BufferedItem[] = []
        let overflow = false
        let watermark: SessionPosition | undefined
        let exitCode: number | undefined
        let inFlight: Promise<void> | undefined
        const publish = (conversation: Conversation): void => {
          if (!active) return
          setConversation(key, { conversation })
          if (conversation.fatal && !get().fatal[key])
            set((state) => ({ fatal: { ...state.fatal, [key]: conversation.fatal! } }))
        }
        const refresh = (): Promise<void> => {
          if (!active) return Promise.resolve()
          if (inFlight) return inFlight
          buffering = true
          buffered = []
          const run = async (): Promise<void> => {
            try {
              // The ack means the server has bound its listeners, before taking the snapshot.
              await push.subscribed(sessionId)
              for (let attempt = 0; attempt < 3 && active; attempt++) {
                const page = await client.sessions.timeline(sessionId)
                if (!active) return
                try {
                  if (overflow) throw new TimelineChanged()
                  const joined = mergeBufferedHistory(page, buffered)
                  const applied = applyFirstPage(emptyConversation, joined)
                  watermark = buffered.reduce(
                    (position, item) =>
                      item.position && item.position.sequence > position.sequence
                        ? item.position
                        : position,
                    page.cursor
                  )
                  setConversation(key, { cursor: applied.cursor, error: null })
                  publish(
                    exitCode === undefined
                      ? applied.conversation
                      : reduceConversation(applied.conversation, { exit: exitCode })
                  )
                  return
                } catch (error) {
                  if (!(error instanceof TimelineChanged) || attempt === 2) throw error
                  // The next snapshot starts after all frames buffered so far.
                  buffered = []
                  overflow = false
                }
              }
            } catch (error) {
              if (active) setConversation(key, { error: fail(error) })
            } finally {
              buffering = false
              buffered = []
            }
          }
          inFlight = run().finally(() => {
            inFlight = undefined
          })
          return inFlight
        }
        const off = push.subscribe(
          sessionId,
          (stream) => {
            if (!active || stream.kind !== 'event') return
            const item: BufferedItem = { event: stream.event, at: now(), position: stream.position }
            if (buffering) {
              const latest = [...buffered].reverse().find((entry) => entry.position)?.position
              if (latest && item.position && latest.generation !== item.position.generation)
                buffered = []
              buffered.push(item)
              return
            }
            if (item.position) {
              if (
                !watermark ||
                item.position.generation !== watermark.generation ||
                item.position.sequence > watermark.sequence + 1
              ) {
                void refresh()
                buffered.push(item)
                return
              }
              if (item.position.sequence <= watermark.sequence) return
              watermark = item.position
            }
            publish(reduceConversation(conversationOf(key).conversation, item))
          },
          (code) => {
            if (!active) return
            exitCode = code
            publish(reduceConversation(conversationOf(key).conversation, { exit: code }))
          }
        )
        const close = (): void => {
          if (!active) return
          active = false
          off()
          openHistory.delete(key)
          setConversation(key, { subscribed: false })
        }
        openHistory.set(key, { machineId, refresh, close, position: () => watermark })
        setConversation(key, { subscribed: true, error: null })
        await refresh()
        return close
      },

      async refreshOpenHistory(machineId) {
        await Promise.all(
          [...openHistory.values()]
            .filter((open) => open.machineId === machineId)
            .map((open) => open.refresh())
        )
      },

      async loadOlder(machineId, sessionId) {
        const key = conversationKey(machineId, sessionId)
        const current = conversationOf(key)
        const open = openHistory.get(key)
        if (!open || !shouldLoadOlder(current.cursor) || current.cursor.before === null) return
        const position = open.position()
        setConversation(key, { cursor: { ...current.cursor, loading: true } })
        try {
          const { client } = await get().connect(machineId)
          const page = await client.sessions.timeline(sessionId, current.cursor.before)
          if (openHistory.get(key) !== open) return
          if (page.cursor.generation !== position?.generation) {
            await open.refresh()
            return
          }
          const latest = conversationOf(key)
          // A concurrent refresh has already replaced the page and its cursor.
          if (latest.cursor.before !== current.cursor.before) return
          setConversation(key, applyOlderPage(latest.conversation, page))
        } catch (error) {
          if (openHistory.get(key) !== open) return
          const latest = conversationOf(key)
          setConversation(key, { cursor: { ...latest.cursor, loading: false }, error: fail(error) })
        }
      },

      async send(machineId, sessionId, text, clientMessageId = mint(), attachments = []) {
        const trimmed = text.trim()
        if (!trimmed && !attachments.length)
          return { kind: 'failed', clientMessageId, reason: 'Nothing to send.' } as DeliveryOutcome
        let client
        try {
          client = (await get().connect(machineId)).client
        } catch (error) {
          return { kind: 'failed', clientMessageId, reason: fail(error) } as DeliveryOutcome
        }
        const message = buildUserMessage(trimmed, attachments, clientMessageId)
        const send: UnknownSend = {
          machineId,
          sessionId,
          clientMessageId,
          text: message.text,
          draftText: text,
          at: now(),
          ...(attachments.length ? { attachments } : {})
        }
        try {
          await services.delivery?.begin(send)
        } catch {
          return {
            kind: 'failed',
            clientMessageId,
            reason: 'The send could not be saved safely. Nothing was sent.'
          }
        }
        const outcome = await sendMessage(clientMessageId, {
          write: () => client.sessions.write(sessionId, message),
          status: (id) => client.sessions.writeStatus(sessionId, id),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now
        })
        await services.delivery?.finish(send, outcome)
        if (outcome.kind === 'sent' && (await services.drafts.get(machineId, sessionId)) === text)
          await services.drafts.clear(machineId, sessionId)
        return outcome
      },

      async answerInChat(machineId, sessionId, requestId, optionId, answers) {
        const key = conversationKey(machineId, sessionId)
        try {
          const { client } = await get().connect(machineId)
          await client.sessions.write(sessionId, {
            type: 'permission_response',
            id: requestId,
            optionId,
            ...(answers ? { answers } : {})
          })
          const current = conversationOf(key)
          setConversation(key, {
            conversation: reduceConversation(current.conversation, {
              answer: requestId,
              optionId,
              ...(answers ? { answers } : {})
            })
          })
          return { ok: true }
        } catch (error) {
          return { ok: false, error: fail(error) }
        }
      },

      async interrupt(machineId, sessionId) {
        try {
          const { client } = await get().connect(machineId)
          await client.sessions.write(sessionId, { type: 'interrupt' })
          return { ok: true }
        } catch (error) {
          return { ok: false, error: fail(error) }
        }
      },

      async loadRequests(machineId) {
        const generation = (requestLoads.get(machineId) ?? 0) + 1
        requestLoads.set(machineId, generation)
        const current = get().requests[machineId]
        patch('requests', machineId, {
          snapshot: current?.snapshot ?? null,
          unavailable: current?.unavailable ?? false,
          error: null,
          loading: true
        })
        try {
          const { client } = await get().connect(machineId)
          const snapshot = await client.requests.list()
          if (requestLoads.get(machineId) !== generation) return
          patch('requests', machineId, {
            snapshot,
            unavailable: false,
            error: null,
            loading: false
          })
        } catch (error) {
          if (requestLoads.get(machineId) !== generation) return
          const unavailable = error instanceof ServerError && error.capabilityUnavailable
          patch('requests', machineId, {
            snapshot: unavailable ? { revision: 0, pending: [] } : (current?.snapshot ?? null),
            unavailable,
            error: unavailable ? null : fail(error),
            loading: false
          })
        }
      },

      async resolveRequest(machineId, requestId, response) {
        const { client } = await get().connect(machineId)
        try {
          return await client.requests.resolve(requestId, response)
        } finally {
          void get().loadRequests(machineId)
        }
      },

      async loadProfiles(machineId) {
        try {
          const { client } = await get().connect(machineId)
          const prefs = await client.launchProfiles.list()
          patch('profiles', machineId, prefs)
          patch('profilesError', machineId, null)
        } catch (error) {
          patch('profilesError', machineId, fail(error))
        }
      },

      async startSession(machineId, workspace, profile) {
        const { client } = await get().connect(machineId)
        const info = await client.sessions.start(startPayload(workspace, profile))
        void get().loadSessions(machineId)
        return info
      },

      async readFile(machineId, root, path) {
        const { client } = await get().connect(machineId)
        return client.files.read(root, path)
      }
    }
  })
}

export type Store = ReturnType<typeof createStore>
