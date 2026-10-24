/** The server owns both invisible reservations and visible client presence. */
import { Context, Effect, Layer } from 'effect'
import { CommandHandler, QueryHandler } from '@structure-ai/cqrs'
import {
  type Client,
  type ClientRegistrationReservation,
  CLIENT_REGISTRATION_TTL_MS,
  CLIENT_REGISTRATION_PENDING_LIMIT,
  ClientNotFound,
  ClientRegistrationCapacity,
  ClientRegistrationUnavailable,
  ListClients,
  RegisterClient,
  UnregisterClient,
  ReserveClientRegistration,
  ConfirmClientRegistration,
  ReleaseClientRegistration
} from '@clave/contract/clients'
import { ServerEvents } from '../events'

export interface RegisterInput {
  readonly kind: Client['kind']
  readonly name: string
  readonly pid?: number | undefined
}

type Entry =
  | { readonly state: 'pending'; readonly identity: RegisterInput; readonly expires: bigint }
  | { readonly state: 'active'; readonly client: Client; readonly protocol: 'legacy' | 1 }

export interface ClientRegistryService {
  readonly register: (input: RegisterInput) => Effect.Effect<Client>
  readonly unregister: (id: string) => Effect.Effect<void, ClientNotFound>
  readonly list: () => Effect.Effect<ReadonlyArray<Client>>
  readonly reserve: (
    input: RegisterInput
  ) => Effect.Effect<ClientRegistrationReservation, ClientRegistrationCapacity>
  readonly confirm: (
    id: string
  ) => Effect.Effect<{ client: Client; created: boolean }, ClientRegistrationUnavailable>
  readonly release: (id: string) => Effect.Effect<Client | undefined>
  /** Mutation and its events share one ordering, including HTTP interruption. */
  readonly serialize: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class ClientRegistry extends Context.Tag('@clave/server/ClientRegistry')<
  ClientRegistry,
  ClientRegistryService
>() {
  static readonly layer: Layer.Layer<ClientRegistry> = Layer.scoped(
    ClientRegistry,
    Effect.gen(function* () {
      const clock = yield* Effect.clock
      const entries = new Map<string, Entry>()
      const lock = yield* Effect.makeSemaphore(1)
      const serialize = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        lock.withPermits(1)(Effect.uninterruptible(effect))
      const expire = (): void => {
        const now = clock.unsafeCurrentTimeNanos()
        for (const [id, entry] of entries)
          if (entry.state === 'pending' && now >= entry.expires) entries.delete(id)
      }
      yield* Effect.forkScoped(
        Effect.forever(Effect.sleep(1000).pipe(Effect.zipRight(Effect.sync(expire))))
      )
      return {
        serialize,
        register: (input) =>
          Effect.sync(() => {
            const client: Client = { ...input, id: crypto.randomUUID(), registeredAt: Date.now() }
            entries.set(client.id, { state: 'active', client, protocol: 'legacy' })
            return client
          }),
        unregister: (id) =>
          Effect.suspend(() => {
            const entry = entries.get(id)
            if (entry?.state !== 'active') return Effect.fail(new ClientNotFound({ id }))
            entries.delete(id)
            return Effect.void
          }),
        list: () =>
          Effect.sync(() =>
            [...entries.values()].flatMap((entry) =>
              entry.state === 'active' ? [entry.client] : []
            )
          ),
        reserve: (input) =>
          Effect.suspend(() => {
            expire()
            const pending = [...entries.values()].filter(
              (entry) => entry.state === 'pending'
            ).length
            if (pending >= CLIENT_REGISTRATION_PENDING_LIMIT)
              return Effect.fail(
                new ClientRegistrationCapacity({ limit: CLIENT_REGISTRATION_PENDING_LIMIT })
              )
            const id = crypto.randomUUID()
            entries.set(id, {
              state: 'pending',
              identity: { ...input },
              expires:
                clock.unsafeCurrentTimeNanos() + BigInt(CLIENT_REGISTRATION_TTL_MS) * 1_000_000n
            })
            return Effect.succeed({
              protocol: 1 as const,
              reservationId: id,
              expiresInMs: CLIENT_REGISTRATION_TTL_MS
            })
          }),
        confirm: (id) =>
          Effect.suspend<
            { client: Client; created: boolean },
            ClientRegistrationUnavailable,
            never
          >(() => {
            expire()
            const entry = entries.get(id)
            if (!entry || (entry.state === 'active' && entry.protocol === 'legacy'))
              return Effect.fail(new ClientRegistrationUnavailable({ id }))
            if (entry.state === 'active')
              return Effect.succeed({ client: entry.client, created: false })
            const client: Client = { ...entry.identity, id, registeredAt: Date.now() }
            entries.delete(id)
            entries.set(id, { state: 'active', client, protocol: 1 })
            return Effect.succeed({ client, created: true })
          }),
        release: (id) =>
          Effect.sync(() => {
            const entry = entries.get(id)
            // Legacy presence still belongs to the legacy unregister command.
            if (entry?.state === 'active' && entry.protocol === 'legacy') return undefined
            entries.delete(id)
            return entry?.state === 'active' ? entry.client : undefined
          })
      }
    })
  )
}

export const clientHandlers = [
  CommandHandler.make(RegisterClient, (payload) =>
    Effect.gen(function* () {
      const registry = yield* ClientRegistry
      const events = yield* ServerEvents
      return yield* registry.serialize(
        Effect.gen(function* () {
          const client = yield* registry.register(payload)
          yield* events.publish({ _tag: 'client.registered', client })
          return client
        })
      )
    })
  ),
  CommandHandler.make(UnregisterClient, (payload) =>
    Effect.gen(function* () {
      const registry = yield* ClientRegistry
      const events = yield* ServerEvents
      yield* registry.serialize(
        Effect.gen(function* () {
          yield* registry.unregister(payload.id)
          yield* events.publish({ _tag: 'client.unregistered', id: payload.id })
        })
      )
    })
  ),
  CommandHandler.make(ReserveClientRegistration, (payload) =>
    Effect.gen(function* () {
      const registry = yield* ClientRegistry
      return yield* registry.serialize(registry.reserve(payload))
    })
  ),
  CommandHandler.make(ConfirmClientRegistration, (payload) =>
    Effect.gen(function* () {
      const registry = yield* ClientRegistry
      const events = yield* ServerEvents
      return yield* registry.serialize(
        Effect.gen(function* () {
          const result = yield* registry.confirm(payload.id)
          if (result.created)
            yield* events.publish({ _tag: 'client.registered', client: result.client })
          return result.client
        })
      )
    })
  ),
  CommandHandler.make(ReleaseClientRegistration, (payload) =>
    Effect.gen(function* () {
      const registry = yield* ClientRegistry
      const events = yield* ServerEvents
      yield* registry.serialize(
        Effect.gen(function* () {
          const client = yield* registry.release(payload.id)
          if (client) yield* events.publish({ _tag: 'client.unregistered', id: client.id })
        })
      )
    })
  ),
  QueryHandler.make(ListClients, () =>
    Effect.flatMap(ClientRegistry, (registry) => registry.list())
  )
] as const
