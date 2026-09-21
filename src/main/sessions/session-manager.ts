import {
  SessionSchema,
  type AgentState,
  type Session,
  type SessionStream,
  type SessionInput,
  type ModelOption,
  type CommandOption
} from '../../shared/session-model'
import type { SessionAdapter, SessionHandle, SpawnSpec, Unsubscribe } from './adapter'

type Listener<T> = { callback: (value: T) => void; windowKey?: string }
interface Entry {
  session: Session
  handle: SessionHandle
  adapter: SessionAdapter
  off: Unsubscribe[]
  streams: Set<Listener<SessionStream>>
  exits: Set<Listener<number>>
  exited: boolean
  ready: boolean
}

/** Process-independent registry: closing a view never kills its provider. */
export class SessionManager {
  private adapters = new Map<string, SessionAdapter>()
  private entries = new Map<string, Entry>()
  private pending = new Set<string>()
  private removed = new Set<(id: string) => void>()
  private all = new Set<(id: string, stream: SessionStream) => void>()

  registerAdapter(adapter: SessionAdapter): void {
    const previous = this.adapters.get(adapter.id)
    if (previous && previous !== adapter)
      throw new Error(`Adapter already registered: ${adapter.id}`)
    this.adapters.set(adapter.id, adapter)
  }

  getAdapter(id: string): SessionAdapter | undefined {
    return this.adapters.get(id)
  }

  async create(spec: SpawnSpec): Promise<Session> {
    const session = SessionSchema.parse(spec)
    if (this.entries.has(session.id) || this.pending.has(session.id))
      throw new Error(`Session already exists: ${session.id}`)
    const adapter = this.adapters.get(session.adapterId)
    if (!adapter) throw new Error(`Unknown adapter: ${session.adapterId}`)
    if (!adapter.transports.includes(session.transport))
      throw new Error(`Unsupported transport: ${session.transport}`)
    this.pending.add(session.id)
    try {
      const handle = await adapter.spawn(spec)
      try {
        return this.adopt(session, handle, adapter)
      } catch (error) {
        await adapter.kill(handle)
        throw error
      }
    } finally {
      this.pending.delete(session.id)
    }
  }

  /** Registers an already prepared handle before its deferred PTY starts. */
  adopt(session: Session, handle: SessionHandle, adapter: SessionAdapter): Session {
    if (this.entries.has(session.id)) throw new Error(`Session already exists: ${session.id}`)
    const parsed = SessionSchema.parse(session)
    if (!adapter.transports.includes(parsed.transport))
      throw new Error(`Unsupported transport: ${parsed.transport}`)
    if (handle.id !== parsed.id) throw new Error('Adapter handle must match session id')
    const entry: Entry = {
      session: parsed,
      handle,
      adapter,
      off: [],
      streams: new Set(),
      exits: new Set(),
      exited: false,
      ready: false
    }
    this.entries.set(parsed.id, entry)
    try {
      this.bind(entry)
    } catch (error) {
      this.forget(parsed.id)
      throw error
    }
    return { ...parsed }
  }

  private bind(entry: Entry): void {
    const { adapter, handle, session } = entry
    entry.off = []
    entry.off.push(
      adapter.on(handle, 'stream', (stream) => {
        if (stream.kind === 'event' && stream.event.type === 'state_change') {
          this.setState(session.id, stream.event.state)
        } else this.publish(entry, stream)
      })
    )
    entry.off.push(adapter.on(handle, 'state', (state) => this.setState(session.id, state)))
    entry.off.push(
      adapter.on(handle, 'exit', (code) => {
        if (entry.exited) return
        entry.exited = true
        this.setState(session.id, 'ended')
        for (const listener of [...entry.exits]) this.notify(() => listener.callback(code))
        for (const off of entry.off) off()
        entry.off = []
      })
    )
  }

  async attach(id: string): Promise<SessionHandle> {
    const entry = this.require(id)
    const handle = await entry.adapter.attach(id)
    for (const off of entry.off) off()
    entry.handle = handle
    entry.exited = false
    this.bind(entry)
    return handle
  }

  ready(id: string): void {
    const entry = this.require(id)
    if (entry.ready) return
    try {
      entry.adapter.ready?.(entry.handle)
      entry.ready = true
    } catch (error) {
      this.publish(entry, {
        kind: 'event',
        event: {
          type: 'error',
          message: `Session readiness failed: ${error instanceof Error ? error.message : String(error)}`,
          fatal: false
        }
      })
    }
  }

  write(id: string, input: Uint8Array | SessionInput): void {
    const entry = this.require(id)
    entry.adapter.write(entry.handle, input)
  }
  async models(id: string): Promise<ModelOption[]> {
    const entry = this.require(id)
    return entry.adapter.models ? entry.adapter.models(entry.handle) : []
  }
  async commands(id: string): Promise<CommandOption[]> {
    const entry = this.require(id)
    return entry.adapter.commands ? entry.adapter.commands(entry.handle) : []
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.require(id)
    entry.adapter.resize?.(entry.handle, cols, rows)
  }

  kill(id: string): void | Promise<void> {
    const entry = this.require(id)
    return entry.adapter.kill(entry.handle)
  }

  get(id: string): Session | undefined {
    const session = this.entries.get(id)?.session
    return session && { ...session }
  }

  list(windowKey?: string): Session[] {
    return [...this.entries.values()]
      .filter(({ session }) => windowKey === undefined || session.windowKey === windowKey)
      .map(({ session }) => ({ ...session }))
  }

  update(
    id: string,
    patch: Partial<Pick<Session, 'cwd' | 'windowKey' | 'groupId' | 'title' | 'viewId'>>
  ): void {
    const entry = this.require(id)
    entry.session = SessionSchema.parse({ ...entry.session, ...patch })
  }

  /** The view the session is read in. The shape is checked here
   *  (`<pluginId>/<viewId>`, both halves non-empty); whether a plugin still
   *  offers it is the renderer's resolution, which falls back rather than
   *  failing, so disabling a plugin never strands a session on a dead view.
   *  null clears the choice and hands the session back to that fallback. */
  setView(id: string, viewId: string | null): Session {
    const entry = this.require(id)
    if (viewId !== null) {
      const parts = viewId.split('/')
      if (parts.length !== 2 || parts.some((part) => part.length === 0))
        throw new Error(`Invalid view id: ${viewId}`)
    }
    // Clearing drops the key rather than leaving it undefined: the record
    // crosses IPC and a JSON round trip, where an absent field and an undefined
    // one stop being the same thing.
    const next: Record<string, unknown> = { ...entry.session }
    delete next.viewId
    if (viewId !== null) next.viewId = viewId
    entry.session = SessionSchema.parse(next)
    return { ...entry.session }
  }

  setState(id: string, state: AgentState): void {
    const entry = this.entries.get(id)
    if (!entry || entry.session.state === state || (entry.exited && state !== 'ended')) return
    entry.session.state = state
    this.publish(entry, { kind: 'event', event: { type: 'state_change', state } })
  }

  subscribe(
    id: string,
    callback: (stream: SessionStream) => void,
    windowKey?: string
  ): Unsubscribe {
    const entry = this.require(id)
    const listener = { callback, windowKey }
    entry.streams.add(listener)
    return () => {
      entry.streams.delete(listener)
    }
  }

  subscribeExit(id: string, callback: (code: number) => void, windowKey?: string): Unsubscribe {
    const entry = this.require(id)
    const listener = { callback, windowKey }
    entry.exits.add(listener)
    return () => {
      entry.exits.delete(listener)
    }
  }

  subscribeAll(callback: (id: string, stream: SessionStream) => void): Unsubscribe {
    this.all.add(callback)
    return () => {
      this.all.delete(callback)
    }
  }

  subscribeRemoved(callback: (id: string) => void): Unsubscribe {
    this.removed.add(callback)
    return () => {
      this.removed.delete(callback)
    }
  }

  detachWindow(windowKey: string): void {
    for (const entry of this.entries.values()) {
      for (const listener of entry.streams)
        if (listener.windowKey === windowKey) entry.streams.delete(listener)
      for (const listener of entry.exits)
        if (listener.windowKey === windowKey) entry.exits.delete(listener)
    }
  }

  /** Release the registry entry after the caller has killed or transferred it. */
  forget(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    for (const off of entry.off) off()
    entry.streams.clear()
    entry.exits.clear()
    this.entries.delete(id)
    for (const callback of this.removed) this.notify(() => callback(id))
  }

  private notify(callback: () => void): void {
    try {
      callback()
    } catch (error) {
      console.error('Session consumer failed:', error)
    }
  }

  private publish(entry: Entry, stream: SessionStream): void {
    for (const listener of [...entry.streams]) this.notify(() => listener.callback(stream))
    for (const callback of [...this.all]) this.notify(() => callback(entry.session.id, stream))
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`Unknown session: ${id}`)
    return entry
  }
}

export const sessionManager = new SessionManager()
