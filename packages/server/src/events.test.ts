import { describe, expect, it } from 'vitest'
import { Effect, Layer, Stream } from 'effect'
import { EventStore, InMemoryAll } from '@structure-ai/eventsourcing'
import { ServerEvents } from './events'
import { SessionSource } from './ports'
import { ServicesLive } from './runtime'

describe('the server event log', () => {
  it('appends every published event to the event store, numbered, and fans it out', async () => {
    const heard: number[] = []
    const program = Effect.gen(function* () {
      const events = yield* ServerEvents
      const store = yield* EventStore
      events.subscribe((envelope) => heard.push(envelope.seq))
      const first = yield* events.publish({ _tag: 'client.unregistered', id: 'a' })
      const second = yield* events.publish({
        _tag: 'session.state_changed',
        id: 's',
        state: 'done'
      })
      expect([first.seq, second.seq]).toEqual([1, 2])
      expect(first.id).not.toBe(second.id)
      const stored = yield* Stream.runCollect(store.read(events.stream))
      return [...stored]
    }).pipe(
      Effect.provide(ServicesLive({ token: 't', serverId: 'srv', sessions: SessionSource.empty })),
      Effect.scoped
    )
    const stored = await Effect.runPromise(program)
    expect(heard).toEqual([1, 2])
    expect(stored.map((e) => [e.version, e.type])).toEqual([
      [1, 'client.unregistered'],
      [2, 'session.state_changed']
    ])
    expect(stored[1].payload).toEqual({ _tag: 'session.state_changed', id: 's', state: 'done' })
    expect(stored[0].metadata).toMatchObject({ aggregateName: 'server', aggregateId: 'srv' })
  })
  it('keeps the numbering right under concurrent publishes, with the store slow to append', async () => {
    // The in-memory store appends in one step, so twenty publishes would
    // never contend; a store that sleeps a random moment first makes the
    // lock around publish the thing under test.
    const slow = Layer.effect(
      EventStore,
      Effect.map(EventStore, (store) =>
        EventStore.of({
          ...store,
          append: (stream, expected, events) =>
            Effect.sleep(Math.floor(Math.random() * 5)).pipe(
              Effect.zipRight(store.append(stream, expected, events))
            )
        })
      )
    )
    const program = Effect.gen(function* () {
      const events = yield* ServerEvents
      const envelopes = yield* Effect.all(
        Array.from({ length: 20 }, (_, i) =>
          events.publish({ _tag: 'client.unregistered', id: String(i) })
        ),
        { concurrency: 'unbounded' }
      )
      return envelopes.map((e) => e.seq).sort((a, b) => a - b)
    }).pipe(
      Effect.provide(
        ServerEvents.layer('srv').pipe(Layer.provide(slow), Layer.provide(InMemoryAll))
      ),
      Effect.scoped
    )
    expect(await Effect.runPromise(program)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
  })
})
