/**
 * The fixtures CLI for the Antasphere login (PRDCT-3259), on Bun, the
 * framework's own runtime for its CLI:
 *
 *   CLAVE_FIXTURES=1 bun scripts/antasphere-account-fixtures.ts fixtures list
 *   CLAVE_FIXTURES=1 bun scripts/antasphere-account-fixtures.ts fixtures plan antasphere-account/signed-in
 *   CLAVE_FIXTURES=1 bun scripts/antasphere-account-fixtures.ts fixtures load antasphere-account/signed-in --input '{"name":"Ada"}'
 *   CLAVE_FIXTURES=1 bun scripts/antasphere-account-fixtures.ts fixtures cleanup <run-id>
 *
 * `load` prints the receipt (run id, completed keys, generated ids) on
 * stdout and the progress on stderr. The scenario starts its own issuer on
 * 127.0.0.1 and signs a temp install into it; `CLAVE_FIXTURES=1` is the
 * capability, off by default, and there is no flag that points it anywhere
 * but the loopback. A `cleanup` from another process removes that run's
 * install directory (the provider died with its process).
 */
import { Effect } from 'effect'
import { Command, defineCommand, runCli, withSubcommands } from '@structure-ai/cli'
import { fixturesCommand } from '@structure-ai/fixtures/cli'
import {
  AntasphereFixturesLive,
  antasphereFixtureCatalog,
  cleanupAntasphereFixtures,
  verifyAntasphereFixtures
} from '../src/main/antasphere-account.fixtures'

const root = withSubcommands(
  defineCommand({ name: 'clave-fixtures', handler: () => Effect.void }),
  [
    fixturesCommand(antasphereFixtureCatalog, {
      enabled: process.env.CLAVE_FIXTURES === '1',
      ready: verifyAntasphereFixtures,
      cleanup: cleanupAntasphereFixtures,
      timeoutMs: 60_000
    })
  ]
).pipe(Command.provide(AntasphereFixturesLive))

runCli({ name: 'clave-fixtures', version: '0.0.0', root })
