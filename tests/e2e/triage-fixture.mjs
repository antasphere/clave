import { Effect, Layer, Schema } from 'effect'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, makeCatalog, run } from '@structure-ai/fixtures'

// The supplied adapter creates sessions through Clave's application commands.
// No session store, event history or production resource is seeded directly.
export async function loadTriageScenario(create) {
  const scenario = defineScenario({
    name: 'triage/current-instance',
    description: 'Two windows, a hidden workspace, live terminal/chat and dormant chat.',
    input: Schema.Struct({}),
    fixtures: () => ({
      app: defineFixture({
        key: 'triage/current-instance',
        create: ({ runId, id }) => Effect.promise(() => create({ runId, id }))
      })
    })
  })
  return Effect.runPromise(
    makeCatalog({ base: {}, scenarios: [scenario] })
      .prepare(scenario.name, {})
      .pipe(
        Effect.flatMap((fixtures) =>
          run({ fixtures, enabled: true, ready: () => Effect.void, timeoutMs: 120_000 })
        ),
        Effect.provide(busesLayer.pipe(Layer.provide(HandlerRegistry.layer())))
      )
  )
}
