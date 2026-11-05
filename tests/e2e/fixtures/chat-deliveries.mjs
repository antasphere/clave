import { Effect, Layer, Schema } from 'effect'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, makeCatalog, run } from '@structure-ai/fixtures'

export const deliveredMessage = (name, body) => ({
  type: 'user_message',
  text: name
    ? `[Message from Clave tab "${name}" — reply with clave_send_to_session sessionId="${name}"]\n${body}`
    : `[Message from a Clave agent]\n${body}`
})

/** What the agent tells the reader after the other tabs wrote: the stream's
 *  opening, three numbered choices, then the question. The scenario leaves the
 *  turn streaming after the choices; the spec sends the closing frame itself
 *  once it has read the stream (the 5 November 2026 regression: a collapsed
 *  deck hid exactly this text). */
export const EXPLANATION_START =
  'Here is where things stand.\n\n1. Merge the fix now.\n2. Wait for the verifier.\n3. Drop the change.\n\n'
export const EXPLANATION_END = "So I'm waiting on one answer from you: option 1, 2 or 3."

/** Echo transport only, in an isolated app. No real provider or external send. */
export async function loadChatDeliveries(inject, ready) {
  const scenario = defineScenario({
    name: 'chat/cross-session-stacks',
    description:
      "Messages from other tabs stack in decks; the agent's replies, its tool runs and the question it asks the reader stay in the transcript, in their place.",
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
              { type: 'assistant_text', delta: 'Reply to the coordinator.', final: true },
              {
                type: 'tool_call',
                id: 'fixture-agent-tool',
                name: 'Bash',
                input: { command: 'echo checked' }
              },
              { type: 'tool_result', id: 'fixture-agent-tool', output: 'checked' },
              deliveredMessage('Lane verifier', 'Second payload, no omitted words.'),
              deliveredMessage(null, 'Third anonymous payload.'),
              deliveredMessage('Wave coordinator', 'Fourth payload, the merge is pre-authorised.'),
              {
                type: 'tool_call',
                id: 'fixture-options-tool',
                name: 'Bash',
                input: { command: 'echo options' }
              },
              { type: 'tool_result', id: 'fixture-options-tool', output: 'options' },
              { type: 'assistant_text', delta: EXPLANATION_START, final: false }
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
