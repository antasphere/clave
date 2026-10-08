/**
 * What the server tests stand on: a session host the test drives by hand,
 * and a WebSocket peer that hands frames back one at a time. Test-only; the
 * tests import it, nothing else does.
 */
import { WebSocket } from 'ws'
import type {
  CommandOption,
  HistoryPage,
  ModelOption,
  Session,
  SessionInfo,
  SessionStream,
  SessionWrite
} from '@clave/contract/sessions'
import {
  type ServerFrame,
  decodeServerFrame,
  encodeClientFrame,
  type ClientFrame
} from '@clave/contract/push'
import { Either } from 'effect'
import type { SessionHostService, StartInput, Unsubscribe } from './ports'

export const aSession = (id: string, windowKey = 'w1'): Session => ({
  id,
  provider: 'echo',
  transport: 'events',
  cwd: '/work',
  windowKey,
  state: 'idle',
  createdAt: 1,
  adapterId: 'echo',
  title: id
})

/** A host whose sessions the test emits into and exits by hand. Every
 *  call is recorded; a start mints a record under the cwd's last segment. */
export class FakeSource implements SessionHostService {
  readonly sessions = new Map<string, Session>()
  readonly streams = new Map<string, Set<(stream: SessionStream) => void>>()
  readonly exits = new Map<string, Set<(code: number) => void>>()
  readonly writes: Array<{ id: string; input: unknown }> = []
  readonly starts: StartInput[] = []
  readonly stops: string[] = []
  readonly views: Array<{ id: string; viewId: string | null }> = []
  readonly resizes: Array<{ id: string; cols: number; rows: number }> = []
  /** What `models`, `commands` and `history` answer. */
  modelsOf: ModelOption[] = [{ id: 'm1', label: 'Model one' }]
  commandsOf: CommandOption[] = [{ name: 'help', insert: '/help ' }]
  historyOf: HistoryPage = { items: [], before: null }
  /** Set to make the next write or start refuse. */
  refuse: Error | null = null

  constructor(...sessions: Session[]) {
    for (const session of sessions) this.sessions.set(session.id, session)
  }
  list = (windowKey?: string): Session[] =>
    [...this.sessions.values()].filter((s) => windowKey === undefined || s.windowKey === windowKey)
  get = (id: string): Session | undefined => this.sessions.get(id)
  subscribe = (id: string, listener: (stream: SessionStream) => void): Unsubscribe => {
    if (!this.sessions.has(id)) throw new Error(`Unknown session: ${id}`)
    const set = this.streams.get(id) ?? new Set()
    set.add(listener)
    this.streams.set(id, set)
    return () => {
      set.delete(listener)
    }
  }
  subscribeExit = (id: string, listener: (code: number) => void): Unsubscribe => {
    if (!this.sessions.has(id)) throw new Error(`Unknown session: ${id}`)
    const set = this.exits.get(id) ?? new Set()
    set.add(listener)
    this.exits.set(id, set)
    return () => {
      set.delete(listener)
    }
  }
  write = async (id: string, input: SessionWrite): Promise<void> => {
    if (!this.sessions.has(id)) throw new Error(`Unknown session: ${id}`)
    if (this.refuse) throw this.refuse
    this.writes.push({ id, input })
  }
  start = async (input: StartInput): Promise<SessionInfo> => {
    if (this.refuse) throw this.refuse
    this.starts.push(input)
    const id = `started-${this.starts.length}`
    const folderName = input.cwd.split('/').pop() || input.cwd
    this.sessions.set(id, {
      ...aSession(id, input.windowKey ?? ''),
      cwd: input.cwd,
      title: folderName
    })
    return { id, cwd: input.cwd, folderName, alive: true, claudeSessionId: null, piSessionId: null }
  }
  stop = async (id: string): Promise<void> => {
    this.stops.push(id)
    this.sessions.delete(id)
  }
  resize = (id: string, cols: number, rows: number): void => {
    if (!this.sessions.has(id)) throw new Error(`Unknown session: ${id}`)
    if (this.refuse) throw this.refuse
    this.resizes.push({ id, cols, rows })
  }
  setView = (id: string, viewId: string | null): Session => {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Unknown session: ${id}`)
    if (viewId !== null && viewId.split('/').length !== 2)
      throw new Error(`Invalid view id: ${viewId}`)
    this.views.push({ id, viewId })
    const next = viewId === null ? { ...session, viewId: undefined } : { ...session, viewId }
    if (viewId === null) delete (next as { viewId?: string }).viewId
    this.sessions.set(id, next)
    return next
  }
  models = async (id: string): Promise<ModelOption[]> => {
    if (!this.sessions.has(id)) throw new Error(`Unknown session: ${id}`)
    return this.modelsOf
  }
  commands = async (id: string): Promise<CommandOption[]> => {
    if (!this.sessions.has(id)) throw new Error(`Unknown session: ${id}`)
    return this.commandsOf
  }
  capabilities = (id: string): { images: boolean } => {
    if (!this.sessions.has(id)) throw new Error(`Unknown session: ${id}`)
    return { images: true }
  }
  history = (id: string, before?: number, limit?: number): HistoryPage => {
    if (!this.sessions.has(id)) throw new Error(`Unknown session: ${id}`)
    this.historyAsked.push({ id, before, limit })
    return this.historyOf
  }
  readonly historyAsked: Array<{ id: string; before?: number; limit?: number }> = []
  /** What the test does to a session. */
  emit(id: string, stream: SessionStream): void {
    for (const listener of [...(this.streams.get(id) ?? [])]) listener(stream)
  }
  exit(id: string, code: number): void {
    for (const listener of [...(this.exits.get(id) ?? [])]) listener(code)
  }
  listeners(id: string): number {
    return (this.streams.get(id)?.size ?? 0) + (this.exits.get(id)?.size ?? 0)
  }
}

/** A WebSocket peer whose frames and close are read one at a time. */
export class Peer {
  readonly ws: WebSocket
  private readonly frames: ServerFrame[] = []
  private readonly waiting: Array<(frame: ServerFrame) => void> = []
  readonly closed: Promise<{ code: number; reason: string }>
  readonly opened: Promise<void>

  constructor(url: string, headers?: Record<string, string>) {
    this.ws = new WebSocket(url, { headers })
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve())
      this.ws.once('error', reject)
    })
    this.closed = new Promise((resolve) =>
      this.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    )
    this.ws.on('message', (data) => {
      const decoded = decodeServerFrame(data.toString())
      if (Either.isLeft(decoded)) throw new Error(`Undecodable server frame: ${data.toString()}`)
      const next = this.waiting.shift()
      if (next) next(decoded.right)
      else this.frames.push(decoded.right)
    })
  }
  send(frame: ClientFrame): void {
    this.ws.send(encodeClientFrame(frame))
  }
  raw(text: string): void {
    this.ws.send(text)
  }
  next(timeoutMs = 2000): Promise<ServerFrame> {
    const queued = this.frames.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No frame within the timeout')), timeoutMs)
      this.waiting.push((frame) => {
        clearTimeout(timer)
        resolve(frame)
      })
    })
  }
  /** Proves nothing arrives for a while. */
  async silence(ms = 150): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return this.frames.length === 0
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))
