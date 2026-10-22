import { Effect, Layer, Schema } from 'effect'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import {
  defineFixture,
  defineScenario,
  makeCatalog,
  run,
  type RunReport,
  type FixtureError
} from '@structure-ai/fixtures'
import type { SettingsSourceService } from '@clave/server'

/** Accounts created through the application's settings commands. Callers own
 * an isolated settings source with recording usage providers, never production. */
export function loadUsageClockScenario(
  settings: SettingsSourceService
): Effect.Effect<RunReport<Readonly<Record<string, unknown>>>, FixtureError> {
  const catalog = makeCatalog({
    base: {},
    scenarios: [
      defineScenario({
        name: 'usage-clock/accounts',
        description: 'Both providers, including an account introduced after the clock starts',
        input: Schema.Struct({}),
        fixtures: () => ({
          accounts: defineFixture({
            key: 'usage-clock/accounts',
            create: ({ runId }) =>
              Effect.tryPromise({
                try: async () => ({
                  claude: await settings.claudeAccounts.add(`Clock Claude ${runId}`),
                  codex: await settings.codexAccounts.add(`Clock Codex ${runId}`, 'chatgpt')
                }),
                catch: (cause) => new Error('Could not create clock fixture accounts', { cause })
              })
          })
        })
      })
    ]
  })
  return Effect.gen(function* () {
    const fixtures = yield* catalog.prepare('usage-clock/accounts', {})
    return yield* run({
      fixtures,
      enabled: true,
      ready: () =>
        Effect.tryPromise({
          try: async () => {
            const claude = await settings.claudeAccounts.list()
            const codex = await settings.codexAccounts.list()
            if (
              !claude.some((a) => a.label.startsWith('Clock Claude ')) ||
              !codex.some((a) => a.label.startsWith('Clock Codex '))
            )
              throw new Error('Clock fixture accounts are missing from settings queries')
          },
          catch: (cause) => new Error('Clock fixture is not ready', { cause })
        })
    })
  }).pipe(Effect.provide(busesLayer.pipe(Layer.provide(HandlerRegistry.layer()))))
}
