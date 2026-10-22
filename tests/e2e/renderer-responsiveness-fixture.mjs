import assert from 'node:assert/strict'
import { Effect, Layer, Schema } from 'effect'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import {
  defineFixture,
  defineScenario,
  makeCatalog,
  run as runFixtures
} from '@structure-ai/fixtures'

// The caller creates sessions through app commands and the recording adapter.
// Each invocation owns its application data and receives a fixture run identity.
export async function loadRendererResponsiveness(create) {
  const scenario = defineScenario({
    name: 'chat/renderer-responsiveness',
    description: 'One hundred echo chats, with long histories and a live Markdown answer.',
    input: Schema.Struct({}),
    fixtures: () => ({
      workload: defineFixture({
        key: 'chat/renderer-responsiveness',
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
            timeoutMs: 120_000,
            ready: ({ values }) =>
              Effect.sync(() => {
                assert.equal(values.workload.records.length, 100)
                assert.equal(new Set(values.workload.records).size, 100)
                assert.equal(values.workload.groups.length, 10)
              })
          })
        ),
        Effect.provide(busesLayer.pipe(Layer.provide(HandlerRegistry.layer())))
      )
  )
}
