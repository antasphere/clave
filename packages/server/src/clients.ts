/**
 * The clients domain on the server: who is attached. The registry is
 * in-memory for the life of the server; registering and leaving are commands
 * whose events every other client hears.
 */
import { Context, Effect, Layer, Ref } from 'effect'
import { CommandHandler, QueryHandler } from '@structure-ai/cqrs'
import {
  type Client,
  ClientNotFound,
  ListClients,
  RegisterClient,
  UnregisterClient
} from '@clave/contract/clients'
import { ServerEvents } from './events'

export interface RegisterInput {
  readonly kind: Client['kind']
  readonly name: string
  readonly pid?: number | undefined
}

export interface ClientRegistryService {
  readonly register: (input: RegisterInput) => Effect.Effect<Client>
  readonly unregister: (id: string) => Effect.Effect<void, ClientNotFound>
  readonly list: () => Effect.Effect<ReadonlyArray<Client>>
}

export class ClientRegistry extends Context.Tag('@clave/server/ClientRegistry')<
  ClientRegistry,
  ClientRegistryService
>() {
  static readonly layer: Layer.Layer<ClientRegistry> = Layer.effect(
    ClientRegistry,
    Effect.gen(function* () {
      const clients = yield* Ref.make<ReadonlyMap<string, Client>>(new Map())
      return {
        register: (input) =>
          Effect.gen(function* () {
            const client: Client = {
              id: crypto.randomUUID(),
              kind: input.kind,
              name: input.name,
              ...(input.pid !== undefined && { pid: input.pid }),
              registeredAt: Date.now()
            }
            yield* Ref.update(clients, (map) => new Map(map).set(client.id, client))
            return client
          }),
        unregister: (id) =>
          Ref.modify(clients, (map) => {
            if (!map.has(id)) return [false, map] as const
            const next = new Map(map)
            next.delete(id)
            return [true, next] as const
          }).pipe(
            Effect.flatMap((removed) =>
              removed ? Effect.void : Effect.fail(new ClientNotFound({ id }))
            )
          ),
        list: () => Effect.map(Ref.get(clients), (map) => [...map.values()])
      }
    })
  )
}

export const clientHandlers = [
  CommandHandler.make(RegisterClient, (payload) =>
    Effect.gen(function* () {
      const registry = yield* ClientRegistry
      const events = yield* ServerEvents
      const client = yield* registry.register(payload)
      yield* events.publish({ _tag: 'client.registered', client })
      return client
    })
  ),
  CommandHandler.make(UnregisterClient, (payload) =>
    Effect.gen(function* () {
      const registry = yield* ClientRegistry
      const events = yield* ServerEvents
      yield* registry.unregister(payload.id)
      yield* events.publish({ _tag: 'client.unregistered', id: payload.id })
    })
  ),
  QueryHandler.make(ListClients, () =>
    Effect.flatMap(ClientRegistry, (registry) => registry.list())
  )
] as const
