import type {
  AgentState,
  Session,
  SessionStream,
  Transport,
  SessionInput
} from '../../shared/session-model'

export type SpawnSpec = Session & { options?: unknown }
export interface SessionHandle {
  id: string
}
export interface SessionAdapterEvents {
  stream: SessionStream
  exit: number
  state: AgentState
}
export type Unsubscribe = () => void

/** Adapters own provider processes; the manager owns records and consumers. */
export interface SessionAdapter {
  readonly id: string
  readonly provider: string
  readonly transports: readonly Transport[]
  spawn(spec: SpawnSpec): Promise<SessionHandle>
  attach(sessionId: string): Promise<SessionHandle>
  /** Called after consumer listeners are bound; completed once, retried if it throws. */
  ready?(handle: SessionHandle): void
  write(handle: SessionHandle, input: Uint8Array | SessionInput): void
  resize?(handle: SessionHandle, cols: number, rows: number): void
  kill(handle: SessionHandle): void | Promise<void>
  on<K extends keyof SessionAdapterEvents>(
    handle: SessionHandle,
    event: K,
    callback: (value: SessionAdapterEvents[K]) => void
  ): Unsubscribe
}
