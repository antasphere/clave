import { Effect, Schema } from 'effect'
import { defineFixture, defineScenario, makeCatalog } from '@structure-ai/fixtures'
import { StartSession, WriteSession } from '@clave/contract/sessions'

export const timelineFixtureCatalog = makeCatalog({
  base: {},
  scenarios: [
    defineScenario({
      name: 'sessions/timeline-repeated-messages',
      description:
        'Start a run-scoped session and send identical desktop and phone messages through the command bus.',
      input: Schema.Struct({}),
      fixtures: () => ({
        conversation: defineFixture({
          key: 'sessions/timeline-conversation',
          create: ({ dispatch, id }) =>
            Effect.gen(function* () {
              const session = yield* dispatch(StartSession, {
                cwd: `/tmp/clave-mobile-f/${id('session')}`
              })
              yield* dispatch(WriteSession, {
                id: session.id,
                input: { type: 'user_message', text: 'Repeated fixture message' }
              })
              yield* dispatch(WriteSession, {
                id: session.id,
                input: {
                  type: 'user_message',
                  text: 'Repeated fixture message',
                  clientMessageId: id('phone-message')
                }
              })
              return { sessionId: session.id }
            })
        })
      })
    })
  ]
})
