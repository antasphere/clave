import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context, Effect, Layer, Schema } from 'effect'
import {
  Command,
  CommandBus,
  CommandHandler,
  HandlerRegistry,
  layer as busesLayer
} from '@structure-ai/cqrs'
import {
  defineFixture,
  defineScenario,
  FixtureError,
  makeCatalog,
  run,
  type RunReport
} from '@structure-ai/fixtures'
import { startEmbedded, SettingsSource, type EmbeddedServer } from '@clave/server'
import { startOidcProvider, type OidcProvider } from '../../tests/e2e/fixtures/oidc-provider.mjs'
import { AntasphereAccountManager } from './antasphere-account'
import { electronTestPorts } from './ports/testing'
import type {
  AntasphereAccountStatus,
  AntasphereSignInResult
} from '../shared/antasphere-account-types'

/**
 * The Antasphere login as a fixture scenario (`@structure-ai/fixtures`,
 * PRDCT-3259): `antasphere-account/signed-in` stands up a local signed OIDC
 * provider on 127.0.0.1 and a Clave server of the run's own (`@clave/server`
 * over a settings source that holds the real manager, the way the shell's
 * and the standalone's do), signs the install in THROUGH THE SERVER'S OWN
 * COMMANDS (`POST /accounts/antasphere/sign-in` behind the bearer, the
 * handoff it answers followed by the provider as the browser, the
 * confirmation, the sealed session), and verifies the result by the
 * server's own query (`GET /accounts/antasphere`) and the files it wrote.
 * The run is isolated by construction: the issuer is always the provider
 * the run started, the install is a temp directory named for the run, and
 * nothing here can be pointed at account.antasphere.com.
 *
 * Two commands carry it, dispatched through a command bus of this module's
 * own: `StartLocalIssuer` and `SignInWithAntasphere`. Loaded from a test
 * (`antasphere-account.fixtures.test.ts`) or the Bun CLI
 * (`scripts/antasphere-account-fixtures.ts`).
 *
 * Ownership: the world that holds a run's provider, server and manager is a
 * scoped layer. When its scope closes (the CLI command ends, the test's
 * effect completes) every manager is shut down and every provider and
 * server closed, so the process exits; the run's files stay where they are
 * for inspection until an explicit `cleanup <run-id>` removes them.
 */

interface FixtureRun {
  provider: OidcProvider
  dataDir: string
  manager: AntasphereAccountManager | null
  server: EmbeddedServer | null
  expectedEmail: string
}

/** One call on the run's server, behind its bearer. */
async function serverCall<T>(
  server: EmbeddedServer,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${server.token}`,
      ...(body !== undefined && { 'content-type': 'application/json' })
    },
    ...(body !== undefined && { body: JSON.stringify(body) })
  })
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}`)
  return (await res.json()) as T
}

/** The runs this process started, by run id: what `ready` reads and
 *  `cleanup` ends. Closing the world releases every run's listener,
 *  provider and timer; the files are the run's to keep. */
export class AntasphereFixtureWorld extends Context.Tag('clave/AntasphereFixtureWorld')<
  AntasphereFixtureWorld,
  { readonly runs: Map<string, FixtureRun> }
>() {
  static readonly layer = Layer.scoped(
    AntasphereFixtureWorld,
    Effect.acquireRelease(
      Effect.sync(() => ({ runs: new Map<string, FixtureRun>() })),
      (world) =>
        Effect.promise(async () => {
          for (const run of world.runs.values()) {
            run.manager?.shutdown()
            await run.server?.stop()
            await run.provider.close()
          }
          world.runs.clear()
        })
    )
  )
}

/** Where a run keeps its install: derived from the run id alone, so a
 *  cleanup from another process finds it. */
export const fixtureDataDir = (runId: string): string =>
  path.join(os.tmpdir(), `clave-antasphere-fixture-${runId}`)

export const StartLocalIssuer = Command.define('antasphere-fixtures/StartLocalIssuer', {
  payload: Schema.Struct({
    runId: Schema.String,
    subject: Schema.String,
    name: Schema.String.pipe(Schema.maxLength(80)),
    email: Schema.String.pipe(Schema.maxLength(120))
  }),
  success: Schema.Struct({ issuer: Schema.String, port: Schema.Number, email: Schema.String })
})

export const SignInWithAntasphere = Command.define('antasphere-fixtures/SignInWithAntasphere', {
  payload: Schema.Struct({ runId: Schema.String, issuer: Schema.String }),
  success: Schema.Struct({
    phase: Schema.Literal('signed-out', 'signing-in', 'signed-in'),
    subject: Schema.NullOr(Schema.String),
    email: Schema.NullOr(Schema.String),
    name: Schema.NullOr(Schema.String),
    renewable: Schema.Boolean,
    dataDir: Schema.String,
    /** The run's server, for whoever inspects the run; its token stays in the world. */
    serverUrl: Schema.String
  })
})

/** The status, by the server's own query, once the login is no longer in
 *  flight; a login that never settles is a defect of the fixture, not a
 *  business failure. */
const settled = (server: EmbeddedServer): Effect.Effect<AntasphereAccountStatus> =>
  Effect.promise(async () => {
    const deadline = Date.now() + 20_000
    for (;;) {
      const status = await serverCall<AntasphereAccountStatus>(
        server,
        'GET',
        '/accounts/antasphere'
      )
      if (status.phase !== 'signing-in') return status
      if (Date.now() > deadline) throw new Error('the login did not settle')
      await new Promise((r) => setTimeout(r, 20))
    }
  })

export const antasphereFixtureHandlers = [
  CommandHandler.make(StartLocalIssuer, (payload) =>
    Effect.gen(function* () {
      const world = yield* AntasphereFixtureWorld
      const provider = yield* Effect.promise(() =>
        startOidcProvider({
          user: {
            sub: payload.subject,
            name: payload.name,
            email: payload.email,
            email_verified: true
          }
        })
      )
      const dataDir = fixtureDataDir(payload.runId)
      fs.mkdirSync(dataDir, { recursive: true })
      world.runs.set(payload.runId, {
        provider,
        dataDir,
        manager: null,
        server: null,
        expectedEmail: payload.email
      })
      return { issuer: provider.issuer, port: provider.port, email: payload.email }
    })
  ),
  CommandHandler.make(SignInWithAntasphere, (payload) =>
    Effect.gen(function* () {
      const world = yield* AntasphereFixtureWorld
      const run = world.runs.get(payload.runId)
      if (!run || run.provider.issuer !== payload.issuer) {
        return yield* Effect.die(
          new Error('SignInWithAntasphere needs the issuer this run started')
        )
      }
      const provider = run.provider
      const manager = new AntasphereAccountManager({
        ports: electronTestPorts(run.dataDir),
        env: { CLAVE_ANTASPHERE_ISSUER: provider.issuer },
        log: () => {}
      })
      run.manager = manager
      // The run's own Clave server, holding the manager the way the app's
      // settings source does: every settings call but the account refuses.
      const server = yield* Effect.promise(() =>
        startEmbedded({
          ports: {
            settings: {
              ...SettingsSource.none,
              antasphere: {
                status: () => manager.status(),
                signIn: () => manager.start(),
                confirmHandoff: (handoff) => manager.confirmHandoff(handoff),
                cancel: () => manager.cancel(),
                signOut: () => manager.signOut(),
                dismiss: () => manager.dismissFailure()
              },
              subscribe: (listener) =>
                manager.onChange((status) =>
                  listener({ _tag: 'accounts.antasphere_changed', status })
                )
            }
          }
        })
      )
      run.server = server
      // The sign-in through the server's command: the handoff it answers is
      // confirmed the way the shell confirms it, then followed by the
      // provider standing in for the browser.
      const signedIn = yield* Effect.promise(() =>
        serverCall<AntasphereSignInResult>(server, 'POST', '/accounts/antasphere/sign-in', {})
      )
      if (!signedIn.handoff) {
        return yield* Effect.die(
          new Error(
            `the server answered no handoff: ${signedIn.status.lastFailure ?? 'no failure'}`
          )
        )
      }
      const confirmed = yield* Effect.promise(() =>
        serverCall<{ current: boolean }>(
          server,
          'POST',
          '/accounts/antasphere/handoff/confirm',
          signedIn.handoff
        )
      )
      if (!confirmed.current) {
        return yield* Effect.die(new Error('the server did not confirm the handoff it issued'))
      }
      yield* Effect.promise(() => provider.browse(signedIn.handoff!.url))
      const status = yield* settled(server)
      return {
        phase: status.phase,
        subject: status.account?.subject ?? null,
        email: status.account?.email ?? null,
        name: status.account?.name ?? null,
        renewable: status.renewable,
        dataDir: run.dataDir,
        serverUrl: server.url
      }
    })
  )
] as const

/** The bus with the two handlers, over the world. Scoped through the
 *  world: whoever provides this layer owns the runs' lifetime. */
export const AntasphereFixturesLive = busesLayer.pipe(
  Layer.provide(HandlerRegistry.layer(...antasphereFixtureHandlers)),
  Layer.provideMerge(AntasphereFixtureWorld.layer)
)

const localIssuer = (name: string): ReturnType<typeof defineFixture> =>
  defineFixture({
    key: 'antasphere-account/local-issuer',
    create: ({ dispatch, id, runId }) =>
      dispatch(StartLocalIssuer, {
        runId,
        subject: id('subject'),
        name,
        email: `${id('user')}@fixtures.test`
      })
  })

const signedIn = (issuer: ReturnType<typeof localIssuer>): ReturnType<typeof defineFixture> =>
  defineFixture({
    key: 'antasphere-account/session',
    dependencies: { issuer },
    create: ({ dispatch, dependencies, runId }) =>
      dispatch(SignInWithAntasphere, {
        runId,
        issuer: (dependencies.issuer as { issuer: string }).issuer
      })
  })

export const antasphereFixtureCatalog = makeCatalog({
  base: {},
  scenarios: [
    defineScenario({
      name: 'antasphere-account/signed-in',
      description: 'A Clave install signed in to a local Antasphere-shaped issuer',
      input: Schema.Struct({
        name: Schema.optionalWith(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80)), {
          default: () => 'Fixture Person'
        })
      }),
      fixtures: ({ name }) => {
        const issuer = localIssuer(name)
        return { issuer, session: signedIn(issuer) }
      }
    })
  ]
})

/** Readiness: the login is a login. The run's server says signed in as the
 *  person the issuer knows, and the sealed session is on disk, owner-only. */
export const verifyAntasphereFixtures = (
  report: RunReport<Readonly<Record<string, unknown>>>
): Effect.Effect<void, Error, AntasphereFixtureWorld> =>
  Effect.gen(function* () {
    const world = yield* AntasphereFixtureWorld
    const run = world.runs.get(report.runId)
    if (!run) return yield* Effect.fail(new Error(`run ${report.runId} is unknown here`))
    if (!run.manager || !run.server)
      return yield* Effect.fail(new Error('no sign-in was attempted'))
    const status = yield* Effect.tryPromise({
      try: () => serverCall<AntasphereAccountStatus>(run.server!, 'GET', '/accounts/antasphere'),
      catch: (e) => new Error(`the server's status could not be read: ${(e as Error).message}`)
    })
    if (status.phase !== 'signed-in' || !status.account) {
      return yield* Effect.fail(
        new Error(`not signed in: ${status.phase} (${status.lastFailure ?? 'no failure'})`)
      )
    }
    if (status.account.email !== run.expectedEmail) {
      return yield* Effect.fail(new Error('signed in as someone else'))
    }
    const file = path.join(run.dataDir, 'antasphere-account-session.json')
    if (!fs.existsSync(file)) return yield* Effect.fail(new Error('no session on disk'))
    if ((fs.statSync(file).mode & 0o777) !== 0o600) {
      return yield* Effect.fail(new Error('the session file is not owner-only'))
    }
    const text = fs.readFileSync(file, 'utf-8')
    if (text.includes(run.expectedEmail)) {
      return yield* Effect.fail(new Error('the session file carries the identity in clear'))
    }
  })

/** Cleanup for one run, the explicit act: whatever of the run this process
 *  still holds is released, and the install's directory (the session, the
 *  registration) is removed. Safe after a partial run, safe to repeat, and
 *  safe from another process, where only the directory is left to remove. */
export const cleanupAntasphereFixtures = (
  runId: string
): Effect.Effect<void, never, AntasphereFixtureWorld> =>
  Effect.gen(function* () {
    const world = yield* AntasphereFixtureWorld
    const run = world.runs.get(runId)
    if (run) {
      run.manager?.signOut()
      run.manager?.shutdown()
      yield* Effect.promise(async () => {
        await run.server?.stop()
        await run.provider.close()
      })
      world.runs.delete(runId)
    }
    fs.rmSync(fixtureDataDir(runId), { recursive: true, force: true })
  })

/** Load one scenario in this process and verify it: what the test and the
 *  CLI both do. Returns the receipt (no fixture outputs) and the typed values. */
export const loadAntasphereScenario = (
  name: string,
  input: unknown = {}
): Effect.Effect<
  RunReport<Readonly<Record<string, unknown>>>,
  FixtureError,
  AntasphereFixtureWorld | CommandBus
> =>
  Effect.gen(function* () {
    const fixtures = yield* antasphereFixtureCatalog.prepare(name, input)
    // The catalog's roots are heterogeneous, so their requirements are
    // erased; the two handlers above are everything the bus needs.
    return yield* run({
      fixtures,
      enabled: true,
      ready: verifyAntasphereFixtures,
      timeoutMs: 60_000
    }) as Effect.Effect<
      RunReport<Readonly<Record<string, unknown>>>,
      FixtureError,
      AntasphereFixtureWorld | CommandBus
    >
  })
