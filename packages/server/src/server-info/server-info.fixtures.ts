/** The upgrade a Mac asks of a server, through the application command: the
 * scenario dispatches `RequestServerUpgrade` and never writes the upgrade's
 * state or fabricates an event. Whatever runs behind the port is the test's;
 * the scenario's own test gives it a recording runner, never a real install. */
import { Schema } from 'effect'
import { defineFixture, defineScenario, makeCatalog } from '@structure-ai/fixtures'
import { RequestServerUpgrade } from '../../../contract/src/server-info'

export const serverUpgradeFixtureCatalog = makeCatalog({
  base: {},
  scenarios: [
    defineScenario({
      name: 'server-upgrade/requested-when-idle',
      description: 'Ask the server to upgrade to a release version once none of its agents works.',
      input: Schema.Struct({ version: Schema.NonEmptyString }),
      fixtures: ({ version }) => ({
        upgrade: defineFixture({
          key: 'server-upgrade/request',
          create: ({ dispatch }) =>
            dispatch(RequestServerUpgrade, { version, when: 'idle' as const })
        })
      })
    })
  ]
})
