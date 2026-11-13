import { Effect, Layer, Schema } from 'effect'
import { Command, CommandHandler, HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, makeCatalog, run } from '@structure-ai/fixtures'

// Issue #183: an install on its separate server, whose chat tabs (Claude and
// Codex, in a group and at the top level) the server already holds when the
// window reloads. The spec owns what the commands do (it seeds an isolated
// data folder and starts the app with the E2E harness); the scenario names the
// steps, runs them through the command bus and waits for every seeded tab to
// be one session of the window before handing the app over.
const SeedChats = Command.define('live-chat-restore/SeedChats', {
  payload: Schema.Struct({ runId: Schema.String, groupId: Schema.String }),
  success: Schema.Unknown,
  failure: Schema.String
})
const LaunchSeparate = Command.define('live-chat-restore/LaunchSeparate', {
  payload: Schema.Struct({ runId: Schema.String }),
  success: Schema.Unknown,
  failure: Schema.String
})

export async function loadLiveChatRestore({ seed, launch, ready }) {
  const handlers = HandlerRegistry.layer(
    CommandHandler.make(SeedChats, (payload) =>
      Effect.tryPromise(() => seed(payload)).pipe(Effect.mapError(String))
    ),
    CommandHandler.make(LaunchSeparate, (payload) =>
      Effect.tryPromise(() => launch(payload)).pipe(Effect.mapError(String))
    )
  )
  const chats = defineFixture({
    key: 'live-chat-restore/chats',
    create: ({ dispatch, runId, id }) => dispatch(SeedChats, { runId, groupId: id('group') })
  })
  const app = defineFixture({
    key: 'live-chat-restore/app',
    dependencies: { chats },
    create: ({ dispatch, runId }) => dispatch(LaunchSeparate, { runId })
  })
  const scenario = defineScenario({
    name: 'sessions/live-chat-restore',
    description:
      'Claude and Codex chat records in a saved group and at the top level, restored by an app on its separate server',
    input: Schema.Struct({}),
    fixtures: () => ({ chats, app })
  })
  const catalog = makeCatalog({ base: {}, scenarios: [scenario] })
  return Effect.runPromise(
    catalog.prepare(scenario.name, {}).pipe(
      Effect.flatMap((fixtures) =>
        run({
          fixtures,
          enabled: true,
          ready: ({ values }) => Effect.promise(() => ready(values)),
          timeoutMs: 90_000
        })
      ),
      Effect.provide(busesLayer.pipe(Layer.provide(handlers)))
    )
  )
}
