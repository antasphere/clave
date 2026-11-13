import { Effect, Layer, Schema } from 'effect'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, makeCatalog, run } from '@structure-ai/fixtures'

// The adapter starts an isolated Electron shell. Settings use the public preload API.
export async function loadShellPreferences(create) {
  const scenario = defineScenario({
    name: 'shell/preferences',
    description: 'Shell-owned preferences applied to Electron while sessions use a server.',
    input: Schema.Struct({}),
    fixtures: () => ({
      workspace: defineFixture({
        key: 'shell/preferences/app',
        create: ({ runId, id }) => Effect.promise(() => create({ runId, id: id('workspace') }))
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
            Effect.promise(() => values.workspace.win.waitForLoadState('domcontentloaded')),
          timeoutMs: 60_000
        })
      ),
      Effect.provide(busesLayer.pipe(Layer.provide(HandlerRegistry.layer())))
    )
  )
}
