import { EventEmitter } from 'node:events'
import {
  SessionInputSchema,
  userMessageEvent,
  providerPrompt,
  type CommandOption,
  type ModelOption,
  type SessionInput
} from '../../../shared/session-model'
import type {
  SessionAdapter,
  SessionAdapterEvents,
  SessionHandle,
  SpawnSpec,
  Unsubscribe
} from '../adapter'

const ECHO_MODELS: ModelOption[] = [
  { id: 'echo-1', label: 'Echo 1', hint: 'Repeats what you say' },
  { id: 'echo-2', label: 'Echo 2', hint: 'Repeats it again' }
]

const ECHO_COMMANDS: CommandOption[] = [
  { name: 'help', description: 'Show what echo can do', insert: '/help ' },
  { name: 'shout', description: 'Echo it in capitals', insert: '/shout ' }
]

/** Deterministic, opt-in fixture for developing event-stream consumers. */
export class EchoAdapter implements SessionAdapter {
  readonly id = 'echo'
  readonly provider = 'echo'
  readonly transports = ['events'] as const
  readonly images = true
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

  ready(handle: SessionHandle): void {
    this.emitter(handle).emit('stream', {
      kind: 'event',
      event: { type: 'session_meta', model: ECHO_MODELS[0].id, providerSessionId: null }
    })
  }

  async commands(): Promise<CommandOption[]> {
    return ECHO_COMMANDS
  }

  /** A fixed menu, so the model picker can be exercised without a provider. */
  async models(): Promise<ModelOption[]> {
    return ECHO_MODELS
  }

  write(handle: SessionHandle, input: Uint8Array | SessionInput): void {
    const value = SessionInputSchema.parse(
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
    if (value.type === 'set_model') {
      emit({
        type: 'session_meta',
        model: value.model ?? ECHO_MODELS[0].id,
        providerSessionId: null
      })
      return
    }
    if (value.type !== 'user_message') return
    const message = userMessageEvent(value)
    emit(message)
    emitter.emit('state', 'working')
    const prompt = providerPrompt(value)
    const reply = prompt.images.length
      ? `${prompt.text}\n(${prompt.images.length} image${prompt.images.length === 1 ? '' : 's'} received)`
      : prompt.text
    emit({ type: 'assistant_text', delta: reply, final: true })
    const id = `${handle.id}:echo:${++this.sequence}`
    emit({ type: 'tool_call', id, name: 'echo', input: { text: prompt.text } })
    emit({ type: 'tool_result', id, output: prompt.text })
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
