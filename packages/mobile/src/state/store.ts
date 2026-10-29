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
import {
  applyFirstPage,
  applyOlderPage,
  freshCursor,
  shouldLoadOlder,
  type HistoryCursor
} from '../chat/history'
import { type Conversation, emptyConversation, reduceConversation } from '../chat/reducer'
import type {
  FileText,
  LaunchProfilePreferencesView,
  LaunchProfileView,
  RequestResponse,
  RequestSnapshot,
  ResolveOutcome,
  ServerEventEnvelope,
  Session,
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
  /** One send under an id the phone minted (or the one given); the outcome
   *  follows the table of `chat/send.ts`. The draft is cleared on `sent` only. */
  send(
    machineId: string,
    sessionId: string,
    text: string,
    clientMessageId?: string
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
        const offStatus = push.onStatus((status, detail) =>
          patch('reachability', machineId, reachabilityOf(status, detail))
        )
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
        const { client, push } = await get().connect(machineId)
        const off = push.subscribe(
          sessionId,
          (stream) => {
            if (stream.kind !== 'event') return
            const current = conversationOf(key)
            const conversation = reduceConversation(current.conversation, {
              event: stream.event,
              at: now()
            })
            setConversation(key, { conversation })
            if (conversation.fatal && !get().fatal[key])
              set((state) => ({ fatal: { ...state.fatal, [key]: conversation.fatal! } }))
          },
          (code) => {
            const current = conversationOf(key)
            setConversation(key, {
              conversation: reduceConversation(current.conversation, { exit: code })
            })
          }
        )
        setConversation(key, { subscribed: true, error: null })
        try {
          const page = await client.sessions.history(sessionId)
          const current = conversationOf(key)
          const applied = applyFirstPage(
            current.cursor.loaded ? current.conversation : emptyConversation,
            page
          )
          setConversation(key, {
            conversation: current.cursor.loaded ? current.conversation : applied.conversation,
            cursor: applied.cursor
          })
          if (applied.conversation.fatal && !get().fatal[key])
            set((state) => ({ fatal: { ...state.fatal, [key]: applied.conversation.fatal! } }))
        } catch (error) {
          setConversation(key, { error: fail(error) })
        }
        return () => {
          off()
          setConversation(key, { subscribed: false })
        }
      },

      async loadOlder(machineId, sessionId) {
        const key = conversationKey(machineId, sessionId)
        const current = conversationOf(key)
        if (!shouldLoadOlder(current.cursor) || current.cursor.before === null) return
        setConversation(key, { cursor: { ...current.cursor, loading: true } })
        try {
          const { client } = await get().connect(machineId)
          const page = await client.sessions.history(sessionId, current.cursor.before)
          const latest = conversationOf(key)
          const applied = applyOlderPage(latest.conversation, page)
          setConversation(key, applied)
        } catch (error) {
          const latest = conversationOf(key)
          setConversation(key, {
            cursor: { ...latest.cursor, loading: false },
            error: fail(error)
          })
        }
      },

      async send(machineId, sessionId, text, clientMessageId = mint()) {
        const trimmed = text.trim()
        if (!trimmed)
          return { kind: 'failed', clientMessageId, reason: 'Nothing to send.' } as DeliveryOutcome
        let client
        try {
          client = (await get().connect(machineId)).client
        } catch (error) {
          return { kind: 'failed', clientMessageId, reason: fail(error) } as DeliveryOutcome
        }
        const outcome = await sendMessage(clientMessageId, {
          write: (id) =>
            client.sessions.write(sessionId, {
              type: 'user_message',
              text: trimmed,
              clientMessageId: id
            }),
          status: (id) => client.sessions.writeStatus(sessionId, id),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now
        })
        if (outcome.kind === 'sent') await services.drafts.clear(machineId, sessionId)
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
          patch('requests', machineId, {
            snapshot,
            unavailable: false,
            error: null,
            loading: false
          })
        } catch (error) {
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
