/**
 * The Echo adapter with a conversation history, for the timeline's tests
 * (PRDCT-4448): what each session said, in the order its frames reached
 * their listeners, kept the way the mobile branch's Echo kept it (PR #333).
 * The production Echo replays nothing on purpose: the renderer-resource
 * workload observes its seed live (`scripts/performance/renderer-resource-
 * data.test.mjs`), so the history lives here, in a fixture the tests import.
 *
 * A frame is recorded once its listeners have all heard it, at the place it
 * held before they ran: a first listener that seeds from the history while
 * the frame is being delivered does not find it there and captures it live,
 * and a frame a listener emits in turn comes after it. Provider frames, state
 * changes and background-task lists are not conversation and are not kept.
 */
import type { EventEmitter } from 'node:events'
import type { HistoryItem, SessionStream } from '../../../shared/session-model'
import type { SessionHandle, SpawnSpec } from '../adapter'
import { EchoAdapter } from './echo-adapter'

const NOT_CONVERSATION = new Set(['provider_event', 'state_change', 'background_tasks'])

export class HistoryEchoAdapter extends EchoAdapter {
  private readonly past = new Map<string, HistoryItem[]>()

  override prepare(spec: SpawnSpec): SessionHandle {
    const handle = super.prepare(spec)
    const past: HistoryItem[] = []
    this.past.set(spec.id, past)
    const emitter = (this as unknown as { handles: Map<string, EventEmitter> }).handles.get(
      spec.id
    )!
    const emit = emitter.emit.bind(emitter)
    emitter.emit = (name: string | symbol, ...args: unknown[]): boolean => {
      const stream = args[0] as SessionStream | undefined
      if (name !== 'stream' || stream?.kind !== 'event' || NOT_CONVERSATION.has(stream.event.type))
        return emit(name, ...args)
      const offset = past.length
      try {
        return emit(name, ...args)
      } finally {
        past.splice(offset, 0, { event: stream.event, at: Date.now() })
      }
    }
    return handle
  }

  history(handle: SessionHandle): HistoryItem[] {
    return [...(this.past.get(handle.id) ?? [])]
  }

  override kill(handle: SessionHandle): void {
    super.kill(handle)
    this.past.delete(handle.id)
  }
}
