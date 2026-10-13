import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { Effect } from 'effect'
import {
  AntasphereFixturesLive,
  antasphereFixtureCatalog,
  cleanupAntasphereFixtures,
  fixtureDataDir,
  loadAntasphereScenario
} from './antasphere-account.fixtures'

/**
 * The fixture scenario loaded for real (`npx vitest run
 * src/main/antasphere-account.fixtures.test.ts`): the receipt it prints is
 * the one the handoff quotes. Each run is its own provider, its own Clave
 * server and its own install directory; the sign-in goes through the
 * server's commands and the verification through its query. The world's
 * scope closes with the effect: the provider, the server and the manager
 * go, the run's files stay until the explicit cleanup.
 */
describe('the antasphere-account/signed-in scenario', () => {
  it('lists, loads, verifies, keeps its files when the world closes, and cleans up on request', async () => {
    const listed = await Effect.runPromise(antasphereFixtureCatalog.list)
    expect(listed.map((s) => s.name)).toContain('antasphere-account/signed-in')

    const report = await Effect.runPromise(
      loadAntasphereScenario('antasphere-account/signed-in', { name: 'Fixture Person' }).pipe(
        Effect.tap((report) =>
          Effect.sync(() => {
            // The receipt: run id, completed keys, generated ids. Never a token.
            console.log(
              JSON.stringify({
                scenario: 'antasphere-account/signed-in',
                runId: report.runId,
                completed: report.completed,
                ids: report.ids
              })
            )
          })
        ),
        Effect.tap((report) =>
          Effect.sync(() => {
            expect(report.completed).toEqual([
              'antasphere-account/local-issuer',
              'antasphere-account/session'
            ])
            const session = report.values.session as {
              phase: string
              email: string | null
              name: string | null
              renewable: boolean
              dataDir: string
              serverUrl: string
            }
            expect(session.phase).toBe('signed-in')
            expect(session.name).toBe('Fixture Person')
            expect(session.email).toBe(
              `${report.ids['antasphere-account/local-issuer'].user}@fixtures.test`
            )
            expect(session.renewable).toBe(true)
            expect(session.dataDir).toBe(fixtureDataDir(report.runId))
            expect(session.serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
          })
        ),
        Effect.provide(AntasphereFixturesLive)
      )
    )
    // The world's scope has closed: the provider is gone, the files are not.
    const dataDir = fixtureDataDir(report.runId)
    expect(fs.existsSync(`${dataDir}/antasphere-account-session.json`)).toBe(true)
    expect(fs.existsSync(`${dataDir}/antasphere-account-client.json`)).toBe(true)
    const issuer = (report.values.issuer as { issuer: string }).issuer
    await expect(fetch(`${issuer}/.well-known/openid-configuration`)).rejects.toThrow()
    const serverUrl = (report.values.session as { serverUrl: string }).serverUrl
    await expect(fetch(`${serverUrl}/health/live`)).rejects.toThrow()

    // The explicit cleanup, from a fresh world as another process would.
    await Effect.runPromise(
      cleanupAntasphereFixtures(report.runId).pipe(Effect.provide(AntasphereFixturesLive))
    )
    expect(fs.existsSync(dataDir)).toBe(false)
    // A provider, a Clave server and a login, then a cleanup from a fresh
    // world: well inside this alone, past vitest's default under a full
    // suite's load (one such timeout was measured on 2026-10-07).
  }, 20_000)

  it('refuses an input the scenario does not declare', async () => {
    const outcome = await Effect.runPromiseExit(
      loadAntasphereScenario('antasphere-account/signed-in', { surprise: 1 }).pipe(
        Effect.provide(AntasphereFixturesLive)
      )
    )
    expect(outcome._tag).toBe('Failure')
  })
})
