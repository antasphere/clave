import { Effect, Layer, Schema } from 'effect'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import {
  defineFixture,
  defineScenario,
  makeCatalog,
  run as runFixtures
} from '@structure-ai/fixtures'
// Reusable scenario over the existing recording route and echo adapter. Sessions
// are created and written through application commands, never a seeded store.
export async function loadHiddenStreaming(create) {
  const scenario = defineScenario({
    name: 'chat/hidden-streaming',
    description: 'An isolated echo chat with both native transcript views.',
    input: Schema.Struct({}),
    fixtures: () => ({
      chat: defineFixture({
        key: 'chat/hidden-streaming',
        create: ({ runId }) => Effect.promise(() => create(runId))
      })
    })
  })
  return Effect.runPromise(
    makeCatalog({ base: {}, scenarios: [scenario] })
      .prepare(scenario.name, {})
      .pipe(
        Effect.flatMap((fixtures) =>
          runFixtures({
            fixtures,
            enabled: true,
            ready: ({ values }) =>
              Effect.promise(() =>
                values.chat.win
                  .locator('[data-testid="chat-view"] textarea:not(:disabled)')
                  .waitFor()
              ),
            timeoutMs: 60_000
          })
        ),
        Effect.provide(busesLayer.pipe(Layer.provide(HandlerRegistry.layer())))
      )
  )
}
