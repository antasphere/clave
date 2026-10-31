import { describe, expect, it, vi } from 'vitest'
import { Effect, Either, TestClock, TestContext, Layer, Context } from 'effect'
import { ClientRegistry } from './handlers'

const identity = { kind: 'shell' as const, name: 'shell', pid: 42 }
const run = <A, E>(effect: Effect.Effect<A, E, ClientRegistry>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(ClientRegistry.layer), Effect.provide(TestContext.TestContext))
  )

describe('server-owned registration state', () => {
  it('keeps pending invisible, confirms once and refuses recreation after release', () =>
    run(
      Effect.gen(function* () {
        const registry = yield* ClientRegistry
        const reserved = yield* registry.reserve(identity)
        expect(yield* registry.list()).toEqual([])
        const first = yield* registry.confirm(reserved.reservationId)
        const duplicate = yield* registry.confirm(reserved.reservationId)
        expect(first.created).toBe(true)
        expect(duplicate).toEqual({ client: first.client, created: false })
        expect(yield* registry.release(reserved.reservationId)).toEqual(first.client)
        expect(yield* registry.release(reserved.reservationId)).toBeUndefined()
        expect(yield* registry.list()).toEqual([])
        const late = yield* Effect.either(registry.confirm(reserved.reservationId))
        expect(Either.isLeft(late) && late.left._tag).toBe('ClientRegistrationUnavailable')
      })
    ))
  it('release before confirmation and unknown cancellation allocate no authority', () =>
    run(
      Effect.gen(function* () {
        const registry = yield* ClientRegistry
        const reserved = yield* registry.reserve(identity)
        yield* registry.release(reserved.reservationId)
        for (const id of [reserved.reservationId, crypto.randomUUID()]) {
          yield* registry.release(id)
          expect(Either.isLeft(yield* Effect.either(registry.confirm(id)))).toBe(true)
        }
        expect(yield* registry.list()).toEqual([])
      })
    ))
  it('expires pending without extending duplicates, reclaims capacity and keeps active clients', () =>
    run(
      Effect.gen(function* () {
        const registry = yield* ClientRegistry
        const active = yield* registry.reserve(identity)
        yield* registry.confirm(active.reservationId)
        const reservations: string[] = []
        for (let n = 0; n < 256; n++)
          reservations.push((yield* registry.reserve(identity)).reservationId)
        const full = yield* Effect.either(registry.reserve(identity))
        expect(Either.isLeft(full) && full.left._tag).toBe('ClientRegistrationCapacity')
        yield* TestClock.adjust(15000)
        expect(Either.isLeft(yield* Effect.either(registry.confirm(reservations[0])))).toBe(true)
        const after = yield* registry.reserve(identity)
        expect(after.reservationId).not.toBe(reservations[0])
        expect((yield* registry.list()).map((client) => client.id)).toEqual([active.reservationId])
      })
    ))
  it('legacy unregister removes all authority while retaining not-found semantics', () =>
    run(
      Effect.gen(function* () {
        const registry = yield* ClientRegistry
        const reserved = yield* registry.reserve(identity)
        yield* registry.confirm(reserved.reservationId)
        yield* registry.unregister(reserved.reservationId)
        expect(Either.isLeft(yield* Effect.either(registry.confirm(reserved.reservationId)))).toBe(
          true
        )
        const twice = yield* Effect.either(registry.unregister(reserved.reservationId))
        expect(Either.isLeft(twice) && twice.left._tag).toBe('ClientNotFound')
        const legacy = yield* registry.register(identity)
        expect(Either.isLeft(yield* Effect.either(registry.confirm(legacy.id)))).toBe(true)
        yield* registry.release(legacy.id)
        expect(yield* registry.list()).toEqual([legacy])
      })
    ))
  it('does not treat clock skew or a reused PID as presence ownership', () =>
    run(
      Effect.gen(function* () {
        const registry = yield* ClientRegistry
        const first = yield* registry.reserve(identity)
        const second = yield* registry.reserve(identity)
        const wall = vi.spyOn(Date, 'now').mockReturnValue(9_000_000_000_000)
        try {
          const later = yield* registry.confirm(second.reservationId)
          wall.mockReturnValue(1)
          const earlier = yield* registry.confirm(first.reservationId)
          expect((yield* registry.list()).map((client) => client.id)).toEqual([
            later.client.id,
            earlier.client.id
          ])
          yield* registry.release(first.reservationId)
          expect(yield* registry.list()).toEqual([later.client])
        } finally {
          wall.mockRestore()
        }
      })
    ))
  it('owns exactly one sweep and cancels it with the registry scope', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(ClientRegistry.layer)
            const registry = Context.get(context, ClientRegistry)
            yield* registry.reserve(identity)
            yield* Effect.yieldNow()
            expect(yield* TestClock.sleeps()).toHaveLength(1)
            yield* TestClock.adjust(1000)
            expect(yield* TestClock.sleeps()).toHaveLength(1)
          })
        )
        // TestClock retains canceled sleep receipts until their scheduled time.
        // Advancing beyond it must not schedule another sweep after scope disposal.
        yield* TestClock.adjust(10000)
        expect(yield* TestClock.sleeps()).toHaveLength(0)
      }).pipe(Effect.provide(TestContext.TestContext))
    ))
})
