import { Effect, Layer, Schema } from 'effect'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, makeCatalog, run } from '@structure-ai/fixtures'

// No business records are needed. The adapter boots an isolated workspace;
// the spec asks the real guest session for synthetic audio and opens Audio.
export async function loadMicrophoneWorkspace(create) {
  const scenario = defineScenario({
    name: 'microphone/default-input',
    description: 'A hidden workspace with synthetic input and local guest pages.',
    input: Schema.Struct({}),
    fixtures: () => ({
      workspace: defineFixture({
        key: 'microphone/workspace',
        create: ({ runId, id }) => Effect.promise(() => create({ runId, id: id('workspace') }))
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
            ready: ({ values }) =>
              Effect.promise(() => values.workspace.win.locator('body').waitFor()),
            timeoutMs: 60_000
          })
        ),
        Effect.provide(busesLayer.pipe(Layer.provide(HandlerRegistry.layer())))
      )
  )
}
