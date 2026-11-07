import { Effect } from 'effect'
import { Command, defineCommand, runCli, withSubcommands } from '@structure-ai/cli'
import { fixturesCommand } from '@structure-ai/fixtures/cli'
import {
  MobileFixturesLive,
  mobileFixtureCatalog,
  verifyMobileFixtures,
  cleanupMobileFixtures
} from '../src/main/mobile-pairing.fixtures'

const root = withSubcommands(
  defineCommand({ name: 'clave-mobile-fixtures', handler: () => Effect.void }),
  [
    fixturesCommand(mobileFixtureCatalog, {
      enabled: process.env.CLAVE_FIXTURES === '1',
      ready: verifyMobileFixtures,
      cleanup: cleanupMobileFixtures,
      timeoutMs: 60_000
    })
  ]
).pipe(Command.provide(MobileFixturesLive))
runCli({ name: 'clave-mobile-fixtures', version: '0.0.0', root })
