import { Effect, Layer, Schema } from 'effect'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, makeCatalog, run } from '@structure-ai/fixtures'

// The adapter creates an isolated app, server and buffered proxy. The app
// registers through the public API; no registry state or events are seeded.
export async function loadShellClientLifecycle(
  create,
  ready,
  { delivery = 'reserve-after-exit' } = {}
) {
  const scenario = defineScenario({
    name: `shell-client/${delivery}`,
    description: 'An owned shell quits while its public registration request is held.',
    input: Schema.Struct({}),
    fixtures: () => ({
      shell: defineFixture({
        key: 'shell-client/pending-registration',
        create: ({ runId, id }) => Effect.promise(() => create({ runId, id }))
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
          ready: ({ values }) => Effect.promise(() => ready(values.shell)),
          timeoutMs: 60_000
        })
      ),
      Effect.provide(busesLayer.pipe(Layer.provide(HandlerRegistry.layer())))
    )
  )
}
