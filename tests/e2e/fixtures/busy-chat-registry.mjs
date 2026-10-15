import { Effect, Layer, Schema } from 'effect'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, makeCatalog, run } from '@structure-ai/fixtures'

// Only the isolated E2E harness enables this scenario. The echo adapter replaces
// provider traffic; session activity travels through the app's real listener.
export async function loadBusyChatRegistry(create, scenarioName = 'chat/busy-registry') {
  let created = null
  const scenario = defineScenario({
    name: scenarioName,
    description: 'An isolated event chat with controllable registry reads.',
    input: Schema.Struct({}),
    fixtures: () => ({
      chat: defineFixture({
        key: `${scenarioName}/session`,
        create: ({ runId }) =>
          Effect.promise(async () => {
            created = await create(runId)
            return created
          })
      })
    })
  })
  const catalog = makeCatalog({ base: {}, scenarios: [scenario] })
  try {
    return await Effect.runPromise(
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
  } catch (error) {
    // If readiness fails after creation, close this fixture immediately.
    await created?.close().catch(() => {})
    throw error
  }
}
