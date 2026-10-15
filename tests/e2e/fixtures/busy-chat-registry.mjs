import { Effect, Layer, Schema } from 'effect'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, makeCatalog, run } from '@structure-ai/fixtures'

// Only the isolated E2E harness enables this scenario. The echo adapter replaces
// provider traffic; session activity travels through the app's real listener.
export async function loadBusyChatRegistry(create) {
  const scenario = defineScenario({
    name: 'chat/busy-registry',
    description: 'A chat whose native view loads while another session keeps changing state.',
    input: Schema.Struct({}),
    fixtures: () => ({
      chat: defineFixture({
        key: 'chat/busy-registry/session',
        create: ({ runId }) => Effect.promise(() => create(runId))
      })
    })
  })
  const catalog = makeCatalog({ base: {}, scenarios: [scenario] })
  return Effect.runPromise(
    catalog.prepare(scenario.name, {}).pipe(
      Effect.flatMap((fixtures) =>
        run({
          fixtures,
          enabled: true,
          ready: ({ values }) =>
            Effect.promise(() =>
              values.chat.win.locator('[data-testid="chat-view"] textarea').waitFor()
            ),
          timeoutMs: 60_000
        })
      ),
      Effect.provide(busesLayer.pipe(Layer.provide(HandlerRegistry.layer())))
    )
  )
}
