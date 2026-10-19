import { Effect, Layer, Schema } from 'effect'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import {
  defineFixture,
  defineScenario,
  makeCatalog,
  run,
  type Fixture,
  type RunReport
} from '@structure-ai/fixtures'

/** Session creation uses Clave's own MCP command, injected by the Electron
 * harness. Usage reads are recording adapters; no real account is queried. */
export async function loadModelQuotaFixture(
  openSession: (input: { name: string; model?: string }) => Promise<{ sessionId: string }>
): Promise<RunReport<Readonly<Record<string, unknown>>>> {
  const session = (key: string, model?: string): Fixture<{ sessionId: string }, unknown> =>
    defineFixture({
      key: `model-quota/${key}`,
      create: ({ id }) =>
        Effect.tryPromise(() => openSession({ name: `${key}-${id('name')}`, model }))
    })
  const catalog = makeCatalog({
    base: {},
    scenarios: [
      defineScenario({
        name: 'model-quota/fable-exhausted',
        description: 'Fable quota exhausted with shared Claude quota available',
        input: Schema.Struct({}),
        fixtures: () => ({
          opus: session('opus', 'claude-opus-5-5'),
          fable: session('fable', 'claude-fable-5'),
          unknown: session('unknown')
        })
      })
    ]
  })
  return Effect.runPromise(
    Effect.gen(function* () {
      const fixtures = yield* catalog.prepare('model-quota/fable-exhausted', {})
      return yield* run({ fixtures, enabled: true, ready: () => Effect.void })
    }).pipe(Effect.provide(busesLayer.pipe(Layer.provide(HandlerRegistry.layer()))))
  )
}
