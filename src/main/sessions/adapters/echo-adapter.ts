import { EventEmitter } from 'node:events'
import { UserMessageSchema, type UserMessage } from '../../../shared/session-model'
import type {
  SessionAdapter,
  SessionAdapterEvents,
  SessionHandle,
  SpawnSpec,
  Unsubscribe
} from '../adapter'

/** Deterministic, opt-in fixture for developing event-stream consumers. */
export class EchoAdapter implements SessionAdapter {
  readonly id = 'echo'
  readonly provider = 'echo'
  readonly transports = ['events'] as const
  private handles = new Map<string, EventEmitter>()
  private sequence = 0

  prepare(spec: SpawnSpec): SessionHandle {
    if (this.handles.has(spec.id)) throw new Error(`Echo session already exists: ${spec.id}`)
    this.handles.set(spec.id, new EventEmitter())
    return { id: spec.id }
  }

  async spawn(spec: SpawnSpec): Promise<SessionHandle> {
    return this.prepare(spec)
  }

  async attach(id: string): Promise<SessionHandle> {
    this.emitter({ id })
    return { id }
  }

  write(handle: SessionHandle, input: Uint8Array | UserMessage): void {
    const message = UserMessageSchema.parse(
      input instanceof Uint8Array
        ? { type: 'user_message', text: new TextDecoder().decode(input) }
        : input
    )
    const emitter = this.emitter(handle)
    const emit = (
      event: Extract<SessionAdapterEvents['stream'], { kind: 'event' }>['event']
    ): void => {
      emitter.emit('stream', { kind: 'event', event })
    }
    emit(message)
    emitter.emit('state', 'working')
    emit({ type: 'assistant_text', delta: message.text, final: true })
    const id = `${handle.id}:echo:${++this.sequence}`
    emit({ type: 'tool_call', id, name: 'echo', input: { text: message.text } })
    emit({ type: 'tool_result', id, output: message.text })
    emitter.emit('state', 'done')
  }

  kill(handle: SessionHandle): void {
    const emitter = this.handles.get(handle.id)
    if (!emitter) return
    this.handles.delete(handle.id)
    emitter.emit('exit', 0)
    emitter.removeAllListeners()
  }

  on<K extends keyof SessionAdapterEvents>(
    handle: SessionHandle,
    event: K,
    callback: (value: SessionAdapterEvents[K]) => void
  ): Unsubscribe {
    const emitter = this.emitter(handle)
    emitter.on(event, callback)
    return () => {
      emitter.off(event, callback)
    }
  }

  private emitter(handle: SessionHandle): EventEmitter {
    const emitter = this.handles.get(handle.id)
    if (!emitter) throw new Error(`Unknown echo session: ${handle.id}`)
    return emitter
  }
}
