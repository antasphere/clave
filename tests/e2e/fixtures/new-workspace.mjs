import { Effect, Layer, Schema } from 'effect'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, makeCatalog, run } from '@structure-ai/fixtures'

export async function loadNewWorkspace(create, ready) {
  const scenario = defineScenario({
    name: 'workspaces/new-window',
    description: 'Register and open a workspace after the desktop has booted.',
    input: Schema.Struct({}),
    fixtures: () => ({
      workspace: defineFixture({
        key: 'workspaces/new-window/workspace',
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
            ready: ({ values }) => Effect.promise(() => ready(values.workspace))
          })
        ),
        Effect.provide(busesLayer.pipe(Layer.provide(HandlerRegistry.layer())))
      )
  )
}
