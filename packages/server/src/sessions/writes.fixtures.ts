import { Effect, Schema } from 'effect'
import { defineFixture, defineScenario, makeCatalog } from '@structure-ai/fixtures'
import { WriteSession } from '@clave/contract/sessions'

/** Dispatch through the application command twice with one client identity. */
export const writeFixtureCatalog = makeCatalog({
  base: {},
  scenarios: [
    defineScenario({
      name: 'mobile-notify/write-once',
      description: 'A phone retries one identified message and receives the original acceptance.',
      input: Schema.Struct({ sessionId: Schema.NonEmptyString }),
      fixtures: ({ sessionId }) => ({
        write: defineFixture({
          key: 'mobile-notify/write',
          create: ({ dispatch, id }) =>
            Effect.gen(function* () {
              const clientMessageId = id('message').slice(0, 64)
              const payload = {
                id: sessionId,
                input: { type: 'user_message' as const, text: 'Fixture reply', clientMessageId }
              }
              const first = yield* dispatch(WriteSession, payload)
              const second = yield* dispatch(WriteSession, payload)
              return { sessionId, clientMessageId, first, second }
            })
        })
      })
    })
  ]
})
