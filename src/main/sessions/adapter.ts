import type {
  AgentState,
  Session,
  SessionStream,
  Transport,
  UserMessage
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
  write(handle: SessionHandle, input: Uint8Array | UserMessage): void
  resize?(handle: SessionHandle, cols: number, rows: number): void
  kill(handle: SessionHandle): void | Promise<void>
  on<K extends keyof SessionAdapterEvents>(
    handle: SessionHandle,
    event: K,
    callback: (value: SessionAdapterEvents[K]) => void
  ): Unsubscribe
}
