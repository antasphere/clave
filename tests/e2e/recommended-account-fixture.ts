import { Effect, Layer, Schema } from 'effect'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import {
  defineFixture,
  defineScenario,
  makeCatalog,
  run,
  type RunReport
} from '@structure-ai/fixtures'

/** Creates the account through Settings commands in an isolated Electron app.
 * Usage and provider processes are test adapters, with no real account reads. */
export async function loadRecommendedAccountFixture(
  createAccount: (label: string) => Promise<{ id: string }>
): Promise<RunReport<Readonly<Record<string, unknown>>>> {
  const catalog = makeCatalog({
    base: {},
    scenarios: [
      defineScenario({
        name: 'recommended-account/weekly-reset',
        description:
          'A usable subscription whose weekly allowance resets before the selected account',
        input: Schema.Struct({}),
        fixtures: () => ({
          account: defineFixture({
            key: 'recommended-account/subscription',
            create: ({ id }) => Effect.tryPromise(() => createAccount(`Recommended ${id('label')}`))
          })
        })
      })
    ]
  })
  return Effect.runPromise(
    Effect.gen(function* () {
      const fixtures = yield* catalog.prepare('recommended-account/weekly-reset', {})
      return yield* run({ fixtures, enabled: true, ready: () => Effect.void })
    }).pipe(Effect.provide(busesLayer.pipe(Layer.provide(HandlerRegistry.layer()))))
  )
}
