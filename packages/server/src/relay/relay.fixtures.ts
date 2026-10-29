import { Effect, Schema } from 'effect'
import { defineFixture, defineScenario, makeCatalog } from '@structure-ai/fixtures'
import type { MachineCredential } from '@clave/contract/relay'

/** Claims go through the relay's authenticated HTTP API, not its registry file. */
export function relayFixtureCatalog(
  claim: (subject: string, name: string) => Promise<MachineCredential>
) {
  const machine = (key: string) =>
    defineFixture({
      key,
      create: ({ id }) =>
        Effect.tryPromise(async () => {
          const subject = id('owner')
          const credential = await claim(subject, `Fixture ${id('machine')}`)
          return { subject, machineId: credential.machineId }
        })
    })
  return makeCatalog({
    base: {},
    scenarios: [
      defineScenario({
        name: 'mobile-relay/isolated-owners',
        description: 'Two owners claim machines and see only their own directory entries.',
        input: Schema.Struct({}),
        fixtures: () => ({
          first: machine('relay/first-owner'),
          second: machine('relay/second-owner')
        })
      })
    ]
  })
}
