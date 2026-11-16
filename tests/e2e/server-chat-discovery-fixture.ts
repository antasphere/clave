import { Effect, Layer, Schema } from 'effect'
import { HandlerRegistry, layer as buses } from '@structure-ai/cqrs'
import {
  defineFixture,
  defineScenario,
  makeCatalog,
  run,
  type RunReport
} from '@structure-ai/fixtures'

/** The callback runs StartSession over the real server API, outside the
 * desktop launcher. Its provider is a recording executable, never a login. */
export async function loadServerChatFixture(
  start: (name: string) => Promise<{ id: string }>,
  verify: () => Promise<void>
): Promise<RunReport<Readonly<Record<string, unknown>>>> {
  const catalog = makeCatalog({
    base: {},
    scenarios: [
      defineScenario({
        name: 'desktop/server-chat-discovery',
        description: 'A windowless server chat keeps its identity when the desktop discovers it.',
        input: Schema.Struct({}),
        fixtures: () => ({
          chat: defineFixture({
            key: 'desktop/windowless-chat',
            create: ({ id }) => Effect.tryPromise(() => start(`Server chat ${id('name')}`))
          })
        })
      })
    ]
  })
  return Effect.runPromise(
    Effect.gen(function* () {
      const fixtures = yield* catalog.prepare('desktop/server-chat-discovery', {})
      return yield* run({
        fixtures,
        enabled: true,
        ready: () => Effect.tryPromise(verify)
      })
    }).pipe(Effect.provide(buses.pipe(Layer.provide(HandlerRegistry.layer()))))
  )
}
