import { Effect, Layer, Schema } from 'effect'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import {
  defineFixture,
  defineScenario,
  makeCatalog,
  run,
  type RunReport
} from '@structure-ai/fixtures'

/** Create the run's chat through Clave's own open-session command. The provider
 * is a recording executable; this scenario never reaches subscription APIs. */
export async function loadElicitationFixture(
  openSession: (name: string) => Promise<{ sessionId: string }>
): Promise<RunReport<Readonly<Record<string, { sessionId: string }>>>> {
  const catalog = makeCatalog({
    base: {},
    scenarios: [
      defineScenario({
        name: 'codex/empty-elicitation',
        description: 'A Codex tool approval, a form needing input and a URL request',
        input: Schema.Struct({}),
        fixtures: () => ({
          chat: defineFixture({
            key: 'codex/elicitation-chat',
            create: ({ id }) => Effect.tryPromise(() => openSession(`MCP approval ${id('name')}`))
          })
        })
      })
    ]
  })
  return Effect.runPromise(
    Effect.gen(function* () {
      const fixtures = yield* catalog.prepare('codex/empty-elicitation', {})
      return yield* run({ fixtures, enabled: true, ready: () => Effect.void })
    }).pipe(Effect.provide(busesLayer.pipe(Layer.provide(HandlerRegistry.layer()))))
  )
}
