import { createHash, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync
} from 'node:fs'
import { join } from 'node:path'
import {
  applyConversationEvent,
  type ConversationOptions,
  type ConversationSnapshot,
  type ConversationEnvelope,
  type ConversationEvent,
  type AgentResponse
} from '../../shared/agent-session'
import type { AdapterFactory, AdapterLaunch, ConversationAdapter } from './adapter'
import { MAX_FRAME } from './wire'
import type { AttachedSessionView, LegacyImportState } from '../../shared/session-migration'
import type {
  ArtifactInput,
  ConversationArtifact,
  PluginBindings,
  PluginPin
} from '../../shared/runtime-plugins'
import {
  parseArtifactInput,
  parsePluginBindings,
  parsePluginPin,
  providerIdSchema
} from './plugin-records'

interface RecordState {
  snapshot: ConversationSnapshot
  commands: string[]
  events: ConversationEnvelope[]
  capacityReached?: boolean
}
interface Live {
  record: RecordState
  adapter?: ConversationAdapter
  launch?: AdapterLaunch
  busy: boolean
  responding?: boolean
  interrupting?: boolean
  generation: number
  broken?: boolean
  pending?: Extract<ConversationEvent, { type: 'text-delta' }>
  pendingBytes?: number
  timer?: NodeJS.Timeout
}
const MAX_COMMANDS = 10000
const MAX_RECORD_BYTES = 4 * 1024 * 1024
const MAX_EVENT_BYTES = 256 * 1024
const CAPACITY_ERROR =
  'Conversation reached the 4 MiB history limit; close it and start a new conversation. Existing history is preserved.'
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
const OPTION_KEYS = [
  'provider',
  'cwd',
  'title',
  'workspaceId',
  'windowKey',
  'launchProfileId',
  'claudeProfileId',
  'configDir',
  'model',
  'piProvider',
  'piThinking',
  'dangerousMode',
  'resumeSessionId'
] as const

export function validateAttachedView(value: AttachedSessionView): AttachedSessionView {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid attached view')
  const result = {} as AttachedSessionView
  for (const key of Object.keys(value)) {
    if (!['url', 'title', 'command', 'cwd'].includes(key))
      throw new Error('Invalid attached view field')
    const text = value[key as keyof AttachedSessionView]
    if (typeof text !== 'string' || text.length > 8192 || text.includes('\0'))
      throw new Error('Invalid attached view field')
    Object.assign(result, { [key]: text })
  }
  if (!result.url || !['http:', 'https:'].includes(new URL(result.url).protocol))
    throw new Error('Invalid attached view URL')
  return result
}

/** Allowlist prevents accidental persistence of a launch environment supplied by a caller. */
function safeOptions(options: ConversationOptions): ConversationOptions {
  if (!providerIdSchema.safeParse(options.provider).success || typeof options.cwd !== 'string')
    throw new Error('Invalid conversation options')
  const result = {} as ConversationOptions
  for (const key of OPTION_KEYS) {
    const value = options[key]
    if (value !== undefined) {
      if (
        key === 'dangerousMode'
          ? typeof value !== 'boolean'
          : typeof value !== 'string' || value.length > 8192
      )
        throw new Error('Invalid conversation option')
      Object.assign(result, { [key]: value })
    }
  }
  if (options.pluginBindings) result.pluginBindings = parsePluginBindings(options.pluginBindings)
  return result
}

async function deadline<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Adapter operation timed out')), 20000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Single-process owner. Mutations reserve their session before yielding to provider IO. */
export class ConversationService {
  private sessions = new Map<string, Live>()
  private archived = new Set<string>()
  private listeners = new Set<(event: ConversationEnvelope) => void>()

  constructor(
    private directory: string,
    private factory: AdapterFactory
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    for (const file of readdirSync(directory)) {
      if (!/^conversation-[a-f0-9-]+\.json$/.test(file)) continue
      const record = JSON.parse(readFileSync(join(directory, file), 'utf8')) as RecordState
      if (file !== `${record.snapshot.session.id}.json` || !Array.isArray(record.commands))
        throw new Error('Invalid conversation record')
      if (record.snapshot.session.status === 'closed') {
        this.archived.add(record.snapshot.session.id)
        continue
      }
      const live: Live = { record, busy: false, generation: 0 }
      this.sessions.set(record.snapshot.session.id, live)
      this.emit(live, { type: 'status', status: 'stopped' })
    }
  }

  private get(id: string): Live {
    if (this.archived.has(id)) {
      const record = JSON.parse(
        readFileSync(join(this.directory, `${id}.json`), 'utf8')
      ) as RecordState
      return { record, busy: false, generation: 0 }
    }
    const live = this.sessions.get(id)
    if (!live) throw new Error('Conversation not found')
    if (live.broken)
      throw new Error('Conversation storage failed; restart the service before continuing')
    return live
  }

  private save(live: Live): void {
    const target = join(this.directory, `${live.record.snapshot.session.id}.json`)
    const temporary = `${target}.tmp`
    let fd: number | undefined
    try {
      fd = openSync(temporary, 'w', 0o600)
      writeFileSync(fd, JSON.stringify(live.record))
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temporary, target)
      if (process.platform !== 'win32') {
        fd = openSync(this.directory, 'r')
        fsyncSync(fd)
        closeSync(fd)
        fd = undefined
      }
    } catch {
      live.broken = true
      throw new Error('Conversation storage failed')
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  private detach(live: Live): ConversationAdapter | undefined {
    ++live.generation
    const adapter = live.adapter
    live.adapter = undefined
    return adapter
  }

  private flush(live: Live): void {
    clearTimeout(live.timer)
    live.timer = undefined
    const event = live.pending
    live.pending = undefined
    live.pendingBytes = 0
    if (event) this.emit(live, event)
  }

  private accept(live: Live, event: ConversationEvent): void {
    const generation = live.generation
    if (event.type !== 'text-delta') {
      this.flush(live)
      if (generation === live.generation) this.emit(live, event)
      return
    }
    const size = bytes(event)
    if (size > MAX_EVENT_BYTES) {
      this.flush(live)
      if (generation === live.generation) this.emit(live, event)
      return
    }
    if (
      live.pending &&
      (live.pending.messageId !== event.messageId ||
        (live.pendingBytes ?? 0) + size > MAX_EVENT_BYTES)
    )
      this.flush(live)
    if (!live.adapter) return
    if (live.pending) live.pending.text += event.text
    else live.pending = { ...event }
    live.pendingBytes = (live.pendingBytes ?? 0) + size
    if (!live.timer)
      live.timer = setTimeout(() => {
        try {
          this.flush(live)
        } catch {
          void this.detach(live)
            ?.dispose()
            .catch(() => {})
        }
      }, 40)
  }

  private emit(live: Live, event: ConversationEvent): void {
    if (live.broken) throw new Error('Conversation storage failed')
    if (live.record.capacityReached && event.type === 'status' && event.status !== 'closed') {
      event = { type: 'status', status: 'error', error: CAPACITY_ERROR }
    }
    let overflow =
      bytes(event) > MAX_EVENT_BYTES
        ? 'Provider event exceeded size limit; provider stopped'
        : undefined
    if (event.type === 'request' && live.record.snapshot.requests.length >= 32)
      overflow = 'Too many pending requests; provider stopped'
    const envelope: ConversationEnvelope = {
      sessionId: live.record.snapshot.session.id,
      sequence: live.record.snapshot.sequence + 1,
      timestamp: new Date().toISOString(),
      event
    }
    const next = overflow ? undefined : applyConversationEvent(live.record.snapshot, envelope)
    if (
      next &&
      bytes(next) > MAX_RECORD_BYTES &&
      !['status', 'request-resolved'].includes(event.type)
    )
      overflow = CAPACITY_ERROR
    if (overflow) {
      if (overflow === CAPACITY_ERROR) live.record.capacityReached = true
      void this.detach(live)
        ?.dispose()
        .catch(() => {})
      envelope.event = { type: 'status', status: 'error', error: overflow }
    }
    live.record.snapshot = overflow ? applyConversationEvent(live.record.snapshot, envelope) : next!
    live.record.events = [...live.record.events, envelope].slice(-128)
    while (bytes(live.record.events) > 512 * 1024) live.record.events.shift()
    this.save(live)
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(envelope))
      } catch {
        this.listeners.delete(listener)
      }
    }
  }

  onEvent(callback: (event: ConversationEnvelope) => void): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }
  list(): ConversationSnapshot['session'][] {
    for (const live of this.sessions.values()) this.flush(live)
    const result = [...this.sessions.values()]
      .filter((live) => live.record.snapshot.session.status !== 'closed')
      .map((live) => structuredClone(live.record.snapshot.session))
    if (bytes(result) > MAX_FRAME - 1024)
      throw new Error('Conversation list exceeds transport limit; close sessions before listing')
    return result
  }
  snapshot(id: string): ConversationSnapshot {
    const live = this.get(id)
    this.flush(live)
    if (bytes(live.record.snapshot) > MAX_FRAME - 1024)
      throw new Error('Conversation snapshot exceeds transport limit')
    return { ...structuredClone(live.record.snapshot), providerConnected: !!live.adapter }
  }

  legacyImportMappings(): Record<string, string> {
    const result: Record<string, string> = {}
    for (const id of [...this.sessions.keys(), ...this.archived]) {
      const session = this.get(id).record.snapshot.session
      if (session.legacyImport) result[session.legacyImport.sourceId] = id
    }
    return result
  }

  updateMetadata(
    id: string,
    metadata: {
      title?: string
      workspaceId?: string | null
      windowKey?: string
      view?: AttachedSessionView | null
    }
  ): void {
    const live = this.get(id)
    this.flush(live)
    const view =
      metadata.view === undefined || metadata.view === null
        ? metadata.view
        : validateAttachedView(metadata.view)
    for (const key of ['title', 'workspaceId', 'windowKey'] as const) {
      if (key === 'workspaceId' && metadata[key] === null) {
        delete live.record.snapshot.session.workspaceId
        continue
      }
      if (metadata[key] !== undefined) {
        if (typeof metadata[key] !== 'string' || metadata[key]!.length > 8192)
          throw new Error('Invalid metadata')
        live.record.snapshot.session[key] = metadata[key] as string
      }
    }
    if (view === null) delete live.record.snapshot.session.view
    else if (view !== undefined) live.record.snapshot.session.view = view
    this.emit(live, {
      type: 'status',
      status: live.record.snapshot.session.status,
      error: live.record.snapshot.session.error
    })
  }

  bindPlugins(id: string, bindings: PluginBindings): void {
    const live = this.get(id)
    const validated = parsePluginBindings(bindings)
    const existing = live.record.snapshot.session.pluginBindings
    if (existing) {
      if (JSON.stringify(existing.provider) !== JSON.stringify(validated.provider)) {
        throw new Error('Conversation provider revision is already pinned')
      }
      return
    }
    live.record.snapshot.session.pluginBindings = validated
    this.updateMetadata(id, {})
  }

  pinView(id: string, pin: PluginPin): PluginPin {
    const live = this.get(id)
    const validated = parsePluginPin(pin)
    const bindings = live.record.snapshot.session.pluginBindings
    if (!bindings) throw new Error('Conversation plugins have not been bound')
    const existing = bindings.views.find((item) => item.pluginId === validated.pluginId)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(validated)) {
        throw new Error('This conversation already uses another revision of the view plugin')
      }
      return structuredClone(existing)
    }
    if (bindings.views.length >= 64) throw new Error('Conversation view plugin limit reached')
    bindings.views.push(validated)
    this.updateMetadata(id, {})
    return structuredClone(validated)
  }

  publishArtifact(id: string, input: ArtifactInput, commandId: string): ConversationArtifact {
    const live = this.get(id)
    this.flush(live)
    if (live.record.snapshot.session.status === 'closed') throw new Error('Conversation is closed')
    if (typeof commandId !== 'string' || !commandId || commandId.length > 128)
      throw new Error('Invalid command ID')
    const data = parseArtifactInput(input)
    const artifact: ConversationArtifact = {
      kind: 'artifact',
      id: `artifact-${createHash('sha256').update(`${id}:${commandId}`).digest('hex')}`,
      ...data
    }
    const existing = live.record.snapshot.entries.find((entry) => entry.id === artifact.id)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(artifact))
        throw new Error('Artifact command ID already used')
      return structuredClone(artifact)
    }
    if (live.record.capacityReached) throw new Error(CAPACITY_ERROR)
    if (live.record.commands.length >= MAX_COMMANDS)
      throw new Error('Conversation command limit reached')
    live.record.commands.push(`artifact:${commandId}`)
    this.emit(live, { type: 'artifact', artifact })
    if (live.record.capacityReached) throw new Error(CAPACITY_ERROR)
    return structuredClone(artifact)
  }

  private async start(live: Live, launch: AdapterLaunch): Promise<void> {
    const options = safeOptions({
      ...live.record.snapshot.session,
      launchProfileId:
        launch.options.launchProfileId ?? live.record.snapshot.session.launchProfileId
    })
    if (launch.options.provider !== options.provider)
      throw new Error('A conversation cannot change provider')
    if (options.launchProfileId !== live.record.snapshot.session.launchProfileId) {
      live.record.snapshot.session.launchProfileId = options.launchProfileId
      this.save(live)
    }
    const generation = ++live.generation
    const adapter = this.factory(
      {
        ...launch,
        options,
        providerSessionId: live.record.snapshot.session.providerSessionId ?? options.resumeSessionId
      },
      (event) => {
        if (generation !== live.generation) return
        try {
          this.accept(live, event)
          if (event.type === 'status' && ['stopped', 'error', 'closed'].includes(event.status)) {
            ++live.generation
            const stopped = live.adapter
            live.adapter = undefined
            void stopped?.dispose().catch(() => {})
          }
        } catch {
          live.broken = true
          ++live.generation
          void live.adapter?.dispose().catch(() => {})
        }
      }
    )
    live.adapter = adapter
    this.emit(live, { type: 'status', status: 'starting' })
    this.emit(live, { type: 'capabilities', capabilities: adapter.capabilities })
    if (generation !== live.generation) throw new Error('Conversation start cancelled')
    await deadline(adapter.start())
    if (generation !== live.generation) throw new Error('Conversation start cancelled')
    this.emit(live, { type: 'status', status: 'idle' })
  }

  async prepareLegacyImport(
    options: ConversationOptions,
    launch: AdapterLaunch,
    legacyImport: LegacyImportState,
    view?: AttachedSessionView
  ): Promise<ConversationSnapshot> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        legacyImport.sourceId
      ) ||
      legacyImport.recordKey !== (legacyImport.tmuxName ?? legacyImport.sourceId) ||
      (legacyImport.tmuxName !== undefined && !/^clave-[A-Za-z0-9_-]+$/.test(legacyImport.tmuxName))
    )
      throw new Error('Invalid legacy import')
    const id = `conversation-${legacyImport.sourceId}`
    if (this.sessions.has(id) || this.archived.has(id)) {
      const existing = this.snapshot(id)
      if (existing.session.legacyImport?.sourceId !== legacyImport.sourceId)
        throw new Error('Legacy import ID collision')
      return existing
    }
    return this.createRecord(
      options,
      launch,
      id,
      {
        sourceId: legacyImport.sourceId,
        recordKey: legacyImport.recordKey,
        tmuxName: legacyImport.tmuxName,
        complete: false
      },
      view
    )
  }

  completeLegacyImport(id: string): ConversationSnapshot {
    const live = this.get(id)
    if (live.record.snapshot.session.status === 'closed')
      throw new Error('Legacy conversation is closed')
    if (!live.record.snapshot.session.legacyImport) throw new Error('Not a legacy import')
    live.record.snapshot.session.legacyImport.complete = true
    this.updateMetadata(id, {})
    return this.snapshot(id)
  }

  async create(options: ConversationOptions, launch: AdapterLaunch): Promise<ConversationSnapshot> {
    return this.createRecord(options, launch, `conversation-${randomUUID()}`)
  }

  private createRecord(
    options: ConversationOptions,
    launch: AdapterLaunch,
    id: string,
    legacyImport?: LegacyImportState,
    view?: AttachedSessionView
  ): ConversationSnapshot {
    if (
      [...this.sessions.values()].filter((live) => live.record.snapshot.session.status !== 'closed')
        .length >= 1000
    )
      throw new Error('Conversation limit reached')
    const now = new Date().toISOString()
    const snapshot: ConversationSnapshot = {
      session: {
        ...safeOptions({
          ...options,
          launchProfileId: launch.options.launchProfileId ?? options.launchProfileId
        }),
        id,
        ...(legacyImport ? { legacyImport } : {}),
        ...(view ? { view: validateAttachedView(view) } : {}),
        createdAt: now,
        updatedAt: now,
        status: 'starting',
        capabilities: {
          permissions: false,
          questions: false,
          resume: false,
          notice:
            options.provider === 'pi'
              ? 'Pi does not provide tool approval prompts through this connection. Its tools may execute without asking. Other capabilities are checked on connection.'
              : 'Provider capabilities are unknown until the first connection.'
        }
      },
      sequence: 0,
      entries: [],
      requests: []
    }
    if (launch.options.provider !== options.provider)
      throw new Error('A conversation cannot change provider')
    snapshot.session.status = 'idle'
    const live: Live = {
      record: { snapshot, commands: [], events: [] },
      launch,
      busy: false,
      generation: 0
    }
    this.sessions.set(snapshot.session.id, live)
    this.save(live)
    return this.snapshot(snapshot.session.id)
  }

  async send(id: string, text: string, commandId: string, launch?: AdapterLaunch): Promise<void> {
    const live = this.get(id)
    this.flush(live)
    if (live.record.snapshot.session.legacyImport?.complete === false)
      throw new Error('Legacy migration is not complete')
    if (
      typeof commandId !== 'string' ||
      !commandId ||
      commandId.length > 200 ||
      commandId.startsWith('plugin:')
    )
      throw new Error('Invalid command ID')
    if (live.record.commands.includes(commandId)) return
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 128 * 1024)
      throw new Error('Invalid message')
    if (live.record.capacityReached) throw new Error(CAPACITY_ERROR)
    if (
      live.busy ||
      live.responding ||
      live.interrupting ||
      ['starting', 'running', 'waiting'].includes(live.record.snapshot.session.status)
    )
      throw new Error('Conversation is already running')
    if (live.record.snapshot.session.status === 'closed') throw new Error('Conversation is closed')
    if (live.record.commands.length >= MAX_COMMANDS)
      throw new Error('Conversation command limit reached; create a new conversation')
    if (!live.adapter && !launch && !live.launch)
      throw new Error('A fresh launch is required to resume this conversation')
    live.busy = true
    let submitted = false
    let generation = live.generation
    try {
      live.record.commands.push(commandId)
      this.emit(live, {
        type: 'message',
        message: { kind: 'message', id: commandId, role: 'user', text }
      })
      if (live.record.snapshot.session.error === CAPACITY_ERROR) throw new Error(CAPACITY_ERROR)
      // Consume the transient launch once. Failed starts must receive fresh credentials.
      const nextLaunch = launch ?? live.launch
      live.launch = undefined
      generation = live.generation + (live.adapter ? 0 : 1)
      if (!live.adapter) await this.start(live, nextLaunch!)
      // Persist acceptance BEFORE touching the provider. An uncertain send is never replayed.
      this.emit(live, { type: 'status', status: 'running' })
      submitted = true
      await deadline(live.adapter!.send(text))
    } catch (cause) {
      if (live.broken) {
        void this.detach(live)
          ?.dispose()
          .catch(() => {})
        throw new Error('Conversation storage failed')
      }
      if (generation !== live.generation)
        throw new Error(
          live.record.snapshot.session.error ??
            'Conversation command cancelled; it will not be replayed'
        )
      void this.detach(live)
        ?.dispose()
        .catch(() => {})
      const safeMessage =
        cause &&
        typeof cause === 'object' &&
        'safeMessage' in cause &&
        typeof cause.safeMessage === 'string'
          ? cause.safeMessage.slice(0, 512)
          : undefined
      const error = submitted
        ? 'Provider send failed; the message may have executed. It will not be replayed.'
        : `Provider initialization failed; message not submitted. ${safeMessage ?? 'Check the executable and provider connection, then send a new message.'}`
      this.emit(live, { type: 'status', status: 'error', error })
      throw new Error(error)
    } finally {
      live.busy = false
    }
  }

  async respond(id: string, response: AgentResponse): Promise<void> {
    const live = this.get(id)
    this.flush(live)
    const request = live.record.snapshot.requests.find(
      (pending) => pending.id === response.requestId
    )
    if (!request || !live.adapter || live.responding || live.interrupting)
      throw new Error('No matching pending request')
    if (
      request.kind === 'permission'
        ? !('decision' in response) || !['allow', 'deny'].includes(response.decision)
        : !('answer' in response) ||
          typeof response.answer !== 'string' ||
          Buffer.byteLength(response.answer) > 128 * 1024
    )
      throw new Error('Wrong response kind')
    live.responding = true
    const generation = live.generation
    try {
      this.emit(live, { type: 'request-resolved', requestId: request.id })
      await deadline(live.adapter.respond(response))
    } catch {
      if (generation !== live.generation) throw new Error('Conversation response cancelled')
      ++live.generation
      void live.adapter?.dispose().catch(() => {})
      live.adapter = undefined
      this.emit(live, { type: 'status', status: 'error', error: 'Provider response failed' })
      throw new Error('Provider response failed')
    } finally {
      live.responding = false
    }
  }

  async interrupt(id: string): Promise<void> {
    const live = this.get(id)
    this.flush(live)
    if (live.interrupting) return
    const status = live.record.snapshot.session.status
    if (status === 'starting') {
      // There is no running turn to interrupt during the initial handshake.
      const adapter = this.detach(live)
      this.emit(live, { type: 'status', status: 'stopped' })
      if (adapter) await deadline(adapter.dispose())
      return
    }
    const adapter = live.adapter
    if (!adapter || !['running', 'waiting'].includes(status)) return
    const generation = live.generation
    live.interrupting = true
    try {
      await deadline(adapter.interrupt())
      // The command acknowledgement is not completion. The adapter emits
      // turn-end only after the provider's terminal event, keeping sends gated.
    } catch {
      if (generation === live.generation) {
        void this.detach(live)
          ?.dispose()
          .catch(() => {})
        this.emit(live, {
          type: 'status',
          status: 'error',
          error: 'Provider interrupt failed; the connection was stopped'
        })
      }
      throw new Error('Provider interrupt failed')
    } finally {
      live.interrupting = false
    }
  }

  async close(id: string): Promise<void> {
    const live = this.get(id)
    this.flush(live)
    const adapter = this.detach(live)
    this.emit(live, { type: 'status', status: 'closed' })
    this.archived.add(id)
    this.sessions.delete(id)
    live.launch = undefined
    if (adapter) {
      try {
        await deadline(adapter.dispose())
      } catch {
        throw new Error('Provider disposal failed')
      }
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.values()].map(async (live) => {
        const adapter = this.detach(live)
        try {
          this.flush(live)
          if (live.record.snapshot.session.status !== 'closed')
            this.emit(live, { type: 'status', status: 'stopped' })
        } finally {
          await adapter?.dispose()
        }
      })
    )
  }
}
