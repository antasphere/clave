import { Effect, Layer, Schema } from 'effect'
import { Command, CommandHandler, HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, makeCatalog, run } from '@structure-ai/fixtures'

// Issue #227: a running install with two windows on two workspaces (the
// second one hidden from the first window), a terminal in a group of the
// first window, a chat in the second, and a dormant chat record whose title
// Clave generated. The spec owns what each command does (it seeds an
// isolated data folder, starts the app with the E2E harness and opens the
// sessions through the app's own tools); the scenario names the steps, runs
// them through the command bus and waits for every session to be live
// before handing the app over to the triage checks.
const SeedInstall = Command.define('triage-snapshot/SeedInstall', {
  payload: Schema.Struct({ runId: Schema.String, mode: Schema.String }),
  success: Schema.Unknown,
  failure: Schema.String
})
const LaunchApp = Command.define('triage-snapshot/LaunchApp', {
  payload: Schema.Struct({ runId: Schema.String, mode: Schema.String }),
  success: Schema.Unknown,
  failure: Schema.String
})
const OpenSessions = Command.define('triage-snapshot/OpenSessions', {
  payload: Schema.Struct({ runId: Schema.String, groupName: Schema.String }),
  success: Schema.Unknown,
  failure: Schema.String
})

export async function loadTriageSnapshot({ mode, seed, launch, open, ready }) {
  const handlers = HandlerRegistry.layer(
    CommandHandler.make(SeedInstall, (payload) =>
      Effect.tryPromise(() => seed(payload)).pipe(Effect.mapError(String))
    ),
    CommandHandler.make(LaunchApp, (payload) =>
      Effect.tryPromise(() => launch(payload)).pipe(Effect.mapError(String))
    ),
    CommandHandler.make(OpenSessions, (payload) =>
      Effect.tryPromise(() => open(payload)).pipe(Effect.mapError(String))
    )
  )
  const install = defineFixture({
    key: `triage-snapshot/${mode}/install`,
    create: ({ dispatch, runId }) => dispatch(SeedInstall, { runId, mode })
  })
  const app = defineFixture({
    key: `triage-snapshot/${mode}/app`,
    dependencies: { install },
    create: ({ dispatch, runId }) => dispatch(LaunchApp, { runId, mode })
  })
  const sessions = defineFixture({
    key: `triage-snapshot/${mode}/sessions`,
    dependencies: { app },
    create: ({ dispatch, runId, id }) =>
      dispatch(OpenSessions, { runId, groupName: id('triage-group') })
  })
  const scenario = defineScenario({
    name: `diagnostics/triage-snapshot-${mode}`,
    description:
      'Two windows on two workspaces, a terminal in a group, a live chat and a dormant chat record, on an app whose server runs ' +
      mode,
    input: Schema.Struct({}),
    fixtures: () => ({ install, app, sessions })
  })
  const catalog = makeCatalog({ base: {}, scenarios: [scenario] })
  return Effect.runPromise(
    catalog.prepare(scenario.name, {}).pipe(
      Effect.flatMap((fixtures) =>
        run({
          fixtures,
          enabled: true,
          ready: ({ values }) => Effect.promise(() => ready(values)),
          timeoutMs: 120_000
        })
      ),
      Effect.provide(busesLayer.pipe(Layer.provide(handlers)))
    )
  )
}
