import assert from 'node:assert/strict'
import { Effect, Layer, Schema } from 'effect'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import {
  defineFixture,
  defineScenario,
  makeCatalog,
  run as runFixtures
} from '@structure-ai/fixtures'

export async function loadRendererResource(create, ready) {
  const scenario = defineScenario({
    name: 'chat/renderer-resource',
    description:
      '100 echo sessions, 20 original 200-turn histories and one disposable public-renderer probe.',
    input: Schema.Struct({}),
    fixtures: () => ({
      workload: defineFixture({
        key: 'chat/renderer-resource',
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
            timeoutMs: 120000,
            ready: ({ values }) =>
              Effect.promise(async () => {
                assert.equal(values.workload.records.length, 100)
                assert.equal(new Set(values.workload.records).size, 100)
                assert.equal(values.workload.groups.length, 10)
                await ready(values.workload)
              })
          })
        ),
        Effect.provide(busesLayer.pipe(Layer.provide(HandlerRegistry.layer())))
      )
  )
}
