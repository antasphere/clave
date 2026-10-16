/** Reuse a real agent-created pending approval. The scenario answers through
 * the application command; it never inserts records or fabricates events. */
import { Schema } from 'effect'
import { defineFixture, defineScenario, makeCatalog } from '@structure-ai/fixtures'
import { ResolvePendingRequest } from '../../../contract/src/requests'

export const requestFixtureCatalog = makeCatalog({
  base: {},
  scenarios: [
    defineScenario({
      name: 'shared-requests/answered-approval',
      description: 'Resolve a run-scoped agent approval through the first-valid command.',
      input: Schema.Struct({ requestId: Schema.NonEmptyString }),
      fixtures: ({ requestId }) => ({
        approval: defineFixture({
          key: 'shared-requests/approval',
          create: ({ dispatch }) =>
            dispatch(ResolvePendingRequest, {
              requestId,
              response: { type: 'permission', optionId: 'approve' }
            })
        })
      })
    })
  ]
})
