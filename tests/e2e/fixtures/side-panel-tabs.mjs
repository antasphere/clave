import { Effect, Layer, Schema } from 'effect'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, makeCatalog, run } from '@structure-ai/fixtures'

// This layout scenario needs no business records. Its adapter opens an isolated
// Electron workspace using the E2E harness; resizing and tab changes use the UI.
export async function loadSidePanelTabs(create) {
  const scenario = defineScenario({
    name: 'side-panel/responsive-tabs',
    description: 'An empty workspace with Files, Git and the bundled GitHub tab.',
    input: Schema.Struct({}),
    fixtures: () => ({
      workspace: defineFixture({
        key: 'side-panel/workspace',
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
            Effect.promise(() =>
              values.workspace.win.locator('button[title^="File tree"]').waitFor()
            ),
          timeoutMs: 60_000
        })
      ),
      Effect.provide(busesLayer.pipe(Layer.provide(HandlerRegistry.layer())))
    )
  )
}
