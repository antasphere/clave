import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import {
  SessionEventSchema,
  SessionInputSchema,
  providerPrompt,
  type CommandOption,
  type ModelOption,
  type SessionEvent,
  type SessionInput
} from '../../shared/session-model'
import { pluginFile, type PluginRecord } from '../plugins/plugin-store'
import { sessionManager } from './session-manager'
import type {
  SessionAdapter,
  SessionAdapterEvents,
  SessionHandle,
  SpawnSpec,
  Unsubscribe
} from './adapter'
import type { PluginAdapterCapabilities } from '@clave/plugin-sdk'

/** The subset of PluginStore this module reads; it never writes to the store. */
export interface PluginAdapterSource {
  list(): PluginRecord[]
}

/** What the host hands a plugin at session start. Frozen: the plugin may not edit it. */
export interface PluginAdapterLaunch {
  readonly sessionId: string
  readonly cwd: string
  /** The manifest's command, verbatim: what this provider's process is. */
  readonly command: readonly string[]
  readonly options: {
    readonly resume?: string
    readonly model?: string
    readonly permissionMode?: string
  }
}

/** What `createAdapter(launch, emit)` must return. */
export interface PluginAdapterInstance {
  start(): void | Promise<void>
  send(text: string): void | Promise<void>
  interrupt(): void | Promise<void>
  respond(response: {
    id: string
    optionId: string
    answers?: Record<string, string>
  }): void | Promise<void>
  dispose(): void | Promise<void>
  models?(): ModelOption[] | Promise<ModelOption[]>
  commands?(): CommandOption[] | Promise<CommandOption[]>
  setModel?(model: string | null): void | Promise<void>
}
const REQUIRED_METHODS = ['start', 'send', 'interrupt', 'respond', 'dispose'] as const

/** A launch profile a plugin contributes, before the profile manager dresses it. */
export interface PluginAdapterProfile {
  id: string
  name: string
  command: string[]
  pluginId: string
  enabled: boolean
}

/** Launch-profile ids the host owns; a plugin adapter id may not shadow one. */
const RESERVED_PROFILE_IDS = new Set([
  'dev-echo-adapter',
  'builtin-claude',
  'builtin-antigravity',
  'builtin-codex',
  'builtin-pi'
])
/** Emissions kept while no consumer is bound yet; a session that floods is not a reason to grow. */
const BUFFER_LIMIT = 1000
/** The most one event may carry. Plugin code mints these and they cross the IPC
 *  boundary into a renderer, so an unbounded one is an unbounded renderer payload. */
const EVENT_LIMIT = 256 * 1024

interface Contribution {
  pluginId: string
  adapterId: string
  name: string
  entry: string
  command: string[]
  capabilities: PluginAdapterCapabilities
  directory: string
  digest: string
  enabled: boolean
}

interface Live {
  emitter: EventEmitter
  buffered: SessionAdapterEvents['stream'][]
  instance?: PluginAdapterInstance
  capabilities: PluginAdapterCapabilities
  pluginId: string
  /** The content digest this session's module was loaded from, pinned at spawn. */
  digest: string
  /** False until readiness drains the buffer; see `emit`. */
  flushed: boolean
  exited: boolean
}

/**
 * One registered adapter per contributed id. The plugin's module is resolved and
 * evaluated in `spawn()` and nowhere else — discovery, install and listing never
 * load plugin code. Validation here is a protocol boundary, not a sandbox: a
 * plugin's module runs with main-process privileges, as `src/main/plugins/README.md`
 * already says of plugin code in general.
 */
class PluginSessionAdapter implements SessionAdapter {
  readonly transports = ['events'] as const
  private live = new Map<string, Live>()

  constructor(
    readonly id: string,
    private readonly registry: PluginAdapterRegistry
  ) {}

  /** A plugin adapter is its own provider; the id is unique across installed plugins. */
  get provider(): string {
    return this.id
  }

  async spawn(spec: SpawnSpec): Promise<SessionHandle> {
    if (this.live.has(spec.id)) throw new Error(`Session already exists: ${spec.id}`)
    const contribution = this.registry.requireEnabled(this.id)
    const options = (spec.options ?? {}) as PluginAdapterLaunch['options']
    if (options.resume && !contribution.capabilities.resume)
      throw new Error(`${contribution.name} cannot resume a previous session`)
    const live: Live = {
      emitter: new EventEmitter(),
      buffered: [],
      capabilities: contribution.capabilities,
      pluginId: contribution.pluginId,
      digest: contribution.digest,
      flushed: false,
      exited: false
    }
    this.live.set(spec.id, live)
    try {
      const factory = this.registry.loadFactory(contribution)
      const launch: PluginAdapterLaunch = Object.freeze({
        sessionId: spec.id,
        cwd: spec.cwd,
        command: Object.freeze([...contribution.command]),
        options: Object.freeze({ ...options })
      })
      live.instance = validateInstance(
        factory(launch, (value: unknown) => this.accept(live, value)),
        contribution.name
      )
      await live.instance.start()
      if (contribution.capabilities.notice)
        this.emit(live, {
          type: 'provider_event',
          provider: this.id,
          payload: { notice: contribution.capabilities.notice }
        })
    } catch (error) {
      this.live.delete(spec.id)
      // An adapter that got as far as being built may already own something.
      try {
        await live.instance?.dispose()
      } catch (disposeError) {
        console.error(`[plugin-adapter:${this.id}] dispose after a failed start:`, disposeError)
      }
      throw error
    }
    return { id: spec.id }
  }

  /** Rebinding is refused once the plugin's bytes have changed under the session. */
  async attach(sessionId: string): Promise<SessionHandle> {
    const live = this.require({ id: sessionId })
    if (this.registry.contribution(this.id)?.digest !== live.digest)
      throw new Error(`${this.id} changed since this session started`)
    return { id: sessionId }
  }

  /**
   * The manager calls this once a consumer's listeners are bound. Everything the
   * plugin said while starting was buffered until now: the manager publishes to
   * its consumers as they are at the moment of the call, so an event emitted
   * between spawn and the first subscribe would otherwise reach nobody.
   */
  ready(handle: SessionHandle): void {
    const live = this.require(handle)
    if (live.flushed) return
    live.flushed = true
    const pending = live.buffered
    live.buffered = []
    for (const stream of pending) live.emitter.emit('stream', stream)
  }

  write(handle: SessionHandle, input: Uint8Array | SessionInput): void {
    const live = this.require(handle)
    if (input instanceof Uint8Array)
      throw new Error(`${this.id} takes typed session input, not raw bytes`)
    const value = SessionInputSchema.parse(input)
    const instance = live.instance
    if (!instance) throw new Error(`${this.id} has not started`)
    switch (value.type) {
      case 'user_message':
        this.call(live, () => instance.send(providerPrompt(value).text))
        return
      case 'interrupt':
        this.call(live, () => instance.interrupt())
        return
      case 'permission_response': {
        if (!live.capabilities.permissions && !live.capabilities.questions)
          throw new Error(`${this.id} does not ask for permission`)
        // The prefix was added on the way out; the plugin only knows its own id.
        const id = stripPrefix(value.id, live.pluginId)
        this.call(live, () =>
          instance.respond({
            id,
            optionId: value.optionId,
            ...(value.answers ? { answers: value.answers } : {})
          })
        )
        return
      }
      case 'set_model':
        if (!instance.setModel) {
          this.emit(live, {
            type: 'error',
            message: `${this.id} does not offer a model choice`,
            fatal: false
          })
          return
        }
        this.call(live, () => instance.setModel!(value.model))
        return
    }
  }

  async models(handle: SessionHandle): Promise<ModelOption[]> {
    const live = this.require(handle)
    return live.instance?.models ? [...(await live.instance.models())] : []
  }

  async commands(handle: SessionHandle): Promise<CommandOption[]> {
    const live = this.require(handle)
    return live.instance?.commands ? [...(await live.instance.commands())] : []
  }

  async kill(handle: SessionHandle): Promise<void> {
    const live = this.live.get(handle.id)
    if (!live || live.exited) return
    live.exited = true
    this.live.delete(handle.id)
    try {
      await live.instance?.dispose()
    } catch (error) {
      console.error(`[plugin-adapter:${this.id}] dispose failed:`, error)
    }
    live.emitter.emit('exit', 0)
    live.emitter.removeAllListeners()
  }

  on<K extends keyof SessionAdapterEvents>(
    handle: SessionHandle,
    event: K,
    callback: (value: SessionAdapterEvents[K]) => void
  ): Unsubscribe {
    const live = this.require(handle)
    live.emitter.on(event, callback)
    return () => {
      live.emitter.off(event, callback)
    }
  }

  /** Every event a plugin emits crosses this, or it does not reach the session. */
  private accept(live: Live, value: unknown): void {
    if (live.exited) return
    const parsed = SessionEventSchema.safeParse(value)
    if (!parsed.success) {
      console.error(
        `[plugin-adapter:${this.id}] dropped an invalid session event:`,
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      )
      return
    }
    const event = parsed.data
    const size = byteLength(event)
    if (size === null || size > EVENT_LIMIT) {
      console.error(
        `[plugin-adapter:${this.id}] dropped a ${event.type} event of ${size ?? 'unmeasurable'} bytes (limit ${EVENT_LIMIT})`
      )
      return
    }
    if (event.type === 'permission_request') {
      // A request naming a tool is a permission; one naming none is a question.
      const allowed = event.toolName ? live.capabilities.permissions : live.capabilities.questions
      if (!allowed) {
        console.error(
          `[plugin-adapter:${this.id}] dropped a ${event.toolName ? 'permission' : 'question'} request it does not declare`
        )
        return
      }
    }
    this.emit(live, prefixIds(event, live.pluginId))
  }

  private emit(live: Live, event: SessionEvent): void {
    const stream: SessionAdapterEvents['stream'] = { kind: 'event', event }
    if (!live.flushed) {
      if (live.buffered.length < BUFFER_LIMIT) live.buffered.push(stream)
      return
    }
    live.emitter.emit('stream', stream)
  }

  /** A plugin's rejection is this session's error, never the app's crash. */
  private call(live: Live, run: () => void | Promise<void>): void {
    try {
      const result = run()
      if (result instanceof Promise) void result.catch((error: unknown) => this.failed(live, error))
    } catch (error) {
      this.failed(live, error)
    }
  }

  private failed(live: Live, error: unknown): void {
    this.emit(live, {
      type: 'error',
      message: `${this.id}: ${error instanceof Error ? error.message : String(error)}`,
      fatal: false
    })
  }

  private require(handle: SessionHandle): Live {
    const live = this.live.get(handle.id)
    if (!live) throw new Error(`Unknown ${this.id} session: ${handle.id}`)
    return live
  }
}

/** The event's size on the wire, or null when it cannot be measured at all. */
function byteLength(event: SessionEvent): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(event) ?? '', 'utf8')
  } catch {
    return null
  }
}

/** Ids a plugin mints cannot collide with the host's own or another plugin's. */
export function prefixIds(event: SessionEvent, pluginId: string): SessionEvent {
  switch (event.type) {
    case 'tool_call':
    case 'tool_result':
    case 'permission_request':
      return { ...event, id: `${pluginId}:${event.id}` }
    default:
      return event
  }
}
function stripPrefix(id: string, pluginId: string): string {
  return id.startsWith(`${pluginId}:`) ? id.slice(pluginId.length + 1) : id
}

function validateInstance(value: unknown, name: string): PluginAdapterInstance {
  if (!value || typeof value !== 'object')
    throw new Error(`${name}: createAdapter must return an adapter`)
  for (const method of REQUIRED_METHODS)
    if (typeof (value as Record<string, unknown>)[method] !== 'function')
      throw new Error(`${name}: adapter is missing ${method}()`)
  return value as PluginAdapterInstance
}

type PluginAdapterFactory = (launch: PluginAdapterLaunch, emit: (value: unknown) => void) => unknown

export class PluginAdapterRegistry {
  private contributions = new Map<string, Contribution>()
  private adapters = new Map<string, PluginSessionAdapter>()
  private loaded = new Map<string, { digest: string; factory: PluginAdapterFactory }>()
  /** Every adapter id this run has registered, with the last name it went by.
   *  An adapter stays registered for the life of the app, so a launch naming one
   *  whose plugin has since been removed is refused BY NAME instead of quietly
   *  becoming a terminal. */
  private known = new Map<string, { name: string; command: string[]; pluginId: string }>()

  /**
   * Recomputes what the installed plugins contribute. An adapter id is claimed by
   * the first plugin that declares it; a later claim is reported and ignored, so a
   * second plugin can never take over a running provider's id.
   */
  sync(source: PluginAdapterSource): { conflicts: { pluginId: string; reason: string }[] } {
    const next = new Map<string, Contribution>()
    const conflicts: { pluginId: string; reason: string }[] = []
    const records = source.list()
    const installed = new Set(records.map((record) => record.id))
    for (const record of records) {
      const adapters = record.manifest?.contributes.adapters ?? []
      if (!adapters.length || record.error) continue
      for (const adapter of adapters) {
        const reason = this.claimable(adapter.id, record.id, next, installed)
        if (reason) {
          conflicts.push({ pluginId: record.id, reason })
          continue
        }
        next.set(adapter.id, {
          pluginId: record.id,
          adapterId: adapter.id,
          name: adapter.name,
          entry: adapter.entry,
          command: [...adapter.command],
          capabilities: { ...adapter.capabilities },
          directory: record.directory,
          digest: record.contentDigest ?? '',
          // The grant matters as much as the declaration: a revoked permission
          // must stop new launches even while the plugin still reads as enabled.
          enabled: record.enabled && record.permissionsGranted.includes('sessions.write')
        })
      }
    }
    this.contributions = next
    // Registration is for the life of the app: a disabled plugin must not kill
    // the sessions already running on its adapter, only stop new ones.
    for (const [id, contribution] of next) {
      this.register(id)
      this.known.set(id, {
        name: contribution.name,
        command: [...contribution.command],
        pluginId: contribution.pluginId
      })
    }
    return { conflicts }
  }

  private claimable(
    adapterId: string,
    pluginId: string,
    next: Map<string, Contribution>,
    installed: Set<string>
  ): string | undefined {
    // The incumbent keeps its id for as long as it is installed, so a plugin
    // added later cannot take over a provider already in use. Once the
    // incumbent is gone the id is free again, to whoever claims it first.
    const previous = this.contributions.get(adapterId)
    const taken =
      next.get(adapterId) ?? (previous && installed.has(previous.pluginId) ? previous : undefined)
    if (taken && taken.pluginId !== pluginId)
      return `adapter id ${adapterId} is already contributed by ${taken.pluginId}`
    if (RESERVED_PROFILE_IDS.has(adapterId)) return `adapter id ${adapterId} is reserved by Clave`
    const registered = sessionManager.getAdapter(adapterId)
    if (registered && !(registered instanceof PluginSessionAdapter))
      return `adapter id ${adapterId} is a built-in adapter`
    return undefined
  }

  private register(id: string): void {
    let adapter = this.adapters.get(id)
    if (!adapter) {
      adapter = new PluginSessionAdapter(id, this)
      this.adapters.set(id, adapter)
    }
    sessionManager.registerAdapter(adapter)
  }

  contribution(adapterId: string): Contribution | undefined {
    return this.contributions.get(adapterId)
  }

  requireEnabled(adapterId: string): Contribution {
    const contribution = this.contributions.get(adapterId)
    if (!contribution)
      throw new Error(this.unavailable(adapterId) ?? `Adapter unavailable: ${adapterId}`)
    if (!contribution.enabled)
      throw new Error(`${contribution.name} is not enabled; enable it in Settings → Plugins`)
    return contribution
  }

  /**
   * Why this id cannot start a session, in words a launcher can show, or
   * undefined when it can. An id this run never saw is not ours to explain.
   */
  unavailable(adapterId: string): string | undefined {
    const contribution = this.contributions.get(adapterId)
    if (contribution)
      return contribution.enabled
        ? undefined
        : `${contribution.name} is not enabled; enable it in Settings → Plugins`
    const gone = this.known.get(adapterId)
    return gone ? `${gone.name} is no longer installed` : undefined
  }

  /**
   * The module is evaluated here and only here. The plugin's content digest is
   * pinned per session: a revision the store has re-hashed since is loaded afresh
   * rather than served from Node's module cache, and sessions already running keep
   * the factory they started on.
   */
  loadFactory(contribution: Contribution): PluginAdapterFactory {
    const entryPath = pluginFile(contribution.directory, contribution.entry)
    const cached = this.loaded.get(entryPath)
    if (cached && cached.digest === contribution.digest) return cached.factory
    const require = createRequire(entryPath)
    delete require.cache[entryPath]
    const module: unknown = require(entryPath)
    const factory = (module as Record<string, unknown> | null)?.['createAdapter']
    if (typeof factory !== 'function')
      throw new Error(`${contribution.name}: module must export createAdapter(launch, emit)`)
    const typed = factory as PluginAdapterFactory
    this.loaded.set(entryPath, { digest: contribution.digest, factory: typed })
    return typed
  }

  /**
   * Every adapter profile this run knows, enabled or not and installed or not, so
   * a stale launch id resolves to its adapter and is refused by name there rather
   * than falling through to a terminal. Only the enabled ones are ever offered.
   */
  profiles(): PluginAdapterProfile[] {
    return [...this.known].map(([id, last]) => {
      const contribution = this.contributions.get(id)
      return {
        id,
        name: contribution?.name ?? last.name,
        command: [...(contribution?.command ?? last.command)],
        pluginId: contribution?.pluginId ?? last.pluginId,
        enabled: contribution?.enabled ?? false
      }
    })
  }
}

export const pluginAdapterRegistry = new PluginAdapterRegistry()

/** Recompute contributions after any change to the installed plugins. */
export function syncPluginAdapters(source: PluginAdapterSource): void {
  const { conflicts } = pluginAdapterRegistry.sync(source)
  for (const conflict of conflicts)
    console.error(`[plugins] ${conflict.pluginId}: ${conflict.reason}`)
}

/** The launch profiles the adapter plugins contribute, enabled or not. */
export function pluginAdapterProfiles(): PluginAdapterProfile[] {
  return pluginAdapterRegistry.profiles()
}

/** Why a contributed adapter id cannot start a session, or undefined when it can. */
export function unavailablePluginAdapter(adapterId: string): string | undefined {
  return pluginAdapterRegistry.unavailable(adapterId)
}
