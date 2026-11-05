import { Effect, Layer, Schema } from 'effect'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, makeCatalog, run } from '@structure-ai/fixtures'

export async function loadWorkspaceOwnership(create, ready) {
  const scenario = defineScenario({
    name: 'workspaces/ownership',
    description: 'Open a file through the authenticated agent tool and await its sidebar row.',
    input: Schema.Struct({}),
    fixtures: () => ({
      viewer: defineFixture({
        key: 'workspaces/ownership/viewer',
        create: ({ runId }) => Effect.promise(() => create(runId))
      })
    })
  })
  return Effect.runPromise(
    makeCatalog({ base: {}, scenarios: [scenario] })
      .prepare(scenario.name, {})
      .pipe(
        Effect.flatMap((fixtures) =>
          run({
            fixtures,
            enabled: true,
            ready: ({ values }) => Effect.promise(() => ready(values.viewer))
          })
        ),
        Effect.provide(busesLayer.pipe(Layer.provide(HandlerRegistry.layer())))
      )
  )
}
