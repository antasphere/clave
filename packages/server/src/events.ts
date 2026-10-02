/**
 * The server's own events: what it tells every attached client as it
 * happens. Each one is appended to the event store (the in-memory adapter in
 * this wave) under one stream, numbered by `seq`, then handed to every
 * listener; the push hub is one of them. A client that reconnects can later
 * ask for what it missed from that stream, which is why the log is the store
 * and not a ring buffer of the hub's.
 */
import { Context, Effect, Layer, Schema } from 'effect'
import { EventStore } from '@structure-ai/eventsourcing'
import { ServerEvent, type ServerEventEnvelope } from '@clave/contract/events'
import type { Unsubscribe } from './ports'

export interface ServerEventsService {
  readonly publish: (event: ServerEvent) => Effect.Effect<ServerEventEnvelope>
  readonly subscribe: (listener: (envelope: ServerEventEnvelope) => void) => Unsubscribe
  /** The stream the envelopes are appended to in the event store. */
  readonly stream: string
}

export class ServerEvents extends Context.Tag('@clave/server/ServerEvents')<
  ServerEvents,
  ServerEventsService
>() {
  static layer(serverId: string): Layer.Layer<ServerEvents, never, EventStore> {
    return Layer.effect(ServerEvents, make(serverId))
  }
}

const encodeEvent = Schema.encodeSync(ServerEvent)

const make = (serverId: string): Effect.Effect<ServerEventsService, never, EventStore> =>
  Effect.gen(function* () {
    const store = yield* EventStore
    // One publish at a time: the append's expected version is the last seq,
    // and two publishes racing would hand one of them a concurrency conflict.
    const lock = yield* Effect.makeSemaphore(1)
    const listeners = new Set<(envelope: ServerEventEnvelope) => void>()
    // The category before the first `-` names the aggregate for the store.
    const stream = `server-${serverId}`
    let seq = 0
    const publish = (event: ServerEvent): Effect.Effect<ServerEventEnvelope> =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const at = Date.now()
          const envelope: ServerEventEnvelope = {
            id: crypto.randomUUID(),
            seq: seq + 1,
            at,
            event
          }
          yield* store
            .append(stream, seq, [
              {
                type: event._tag,
                schemaVersion: 1,
                payload: encodeEvent(event),
                metadata: {
                  eventId: envelope.id,
                  occurredAt: new Date(at).toISOString(),
                  aggregateName: 'server',
                  aggregateId: serverId,
                  aggregateVersion: envelope.seq
                }
              }
            ])
            // The lock makes the version right by construction; a conflict
            // here is a bug in this file, not a condition to handle.
            .pipe(Effect.orDie)
          seq = envelope.seq
          for (const listener of [...listeners]) {
            try {
              listener(envelope)
            } catch (error) {
              console.error('[clave-server] event listener failed', error)
            }
          }
          return envelope
        })
      )
    return {
      publish,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      stream
    }
  })
