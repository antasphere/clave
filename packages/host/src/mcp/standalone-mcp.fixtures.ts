/** A server sidebar group and a tab, made through the application's own
 *  commands, for the standalone agent tools to organise and delegate into.
 *  The scenario never writes layouts or session records directly. */
import { Schema } from 'effect'
import { defineFixture, defineScenario, makeCatalog } from '@structure-ai/fixtures'
import { CreateGroup, SERVER_LAYOUT_KEY } from '@clave/contract/sidebar'
import { StartSession } from '@clave/contract/sessions'

export const agentSessionFixtureCatalog = makeCatalog({
  base: {},
  scenarios: [
    defineScenario({
      name: 'agent-sessions/delegation-group',
      description:
        'A run-scoped server sidebar group and a terminal tab that an agent then moves, renames and delegates into.',
      input: Schema.Struct({ cwd: Schema.NonEmptyString, groupName: Schema.NonEmptyString }),
      fixtures: ({ cwd, groupName }) => ({
        group: defineFixture({
          key: 'agent-sessions/group',
          create: ({ dispatch }) =>
            dispatch(CreateGroup, { windowKey: SERVER_LAYOUT_KEY, group: { name: groupName } })
        }),
        tab: defineFixture({
          key: 'agent-sessions/tab',
          create: ({ dispatch }) =>
            dispatch(StartSession, {
              cwd,
              windowKey: SERVER_LAYOUT_KEY,
              options: { claudeMode: false }
            })
        })
      })
    })
  ]
})
