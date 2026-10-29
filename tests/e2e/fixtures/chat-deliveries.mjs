import { Effect, Layer, Schema } from 'effect'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, makeCatalog, run } from '@structure-ai/fixtures'

export const deliveredMessage = (name, body) => ({
  type: 'user_message',
  text: name
    ? `[Message from Clave tab "${name}" — reply with clave_send_to_session sessionId="${name}"]\n${body}`
    : `[Message from a Clave agent]\n${body}`
})

/** Echo transport only, in an isolated app. No real provider or external send. */
export async function loadChatDeliveries(inject, ready) {
  const scenario = defineScenario({
    name: 'chat/cross-session-stacks',
    description: 'Consecutive named and anonymous deliveries among human turns and command runs.',
    input: Schema.Struct({}),
    fixtures: () => ({
      transcript: defineFixture({
        key: 'chat/cross-session-stacks/transcript',
        create: ({ runId }) =>
          Effect.promise(async () => {
            await inject([
              { type: 'user_message', text: 'Keep my conversation readable.' },
              { type: 'assistant_text', delta: 'I will report progress here.', final: true },
              deliveredMessage(
                'Wave coordinator',
                `First payload ${runId}\n` + 'Recovery details. '.repeat(80)
              ),
              deliveredMessage('Lane verifier', 'Second payload, no omitted words.'),
              deliveredMessage(null, 'Third anonymous payload.')
            ])
            return { runId }
          })
      })
    })
  })
  return Effect.runPromise(
    makeCatalog({ base: {}, scenarios: [scenario] })
      .prepare(scenario.name, {})
      .pipe(
        Effect.flatMap((fixtures) =>
          run({
            fixtures,
            enabled: true,
            ready: ({ values }) => Effect.promise(() => ready(values.transcript))
          })
        ),
        Effect.provide(busesLayer.pipe(Layer.provide(HandlerRegistry.layer())))
      )
  )
}
