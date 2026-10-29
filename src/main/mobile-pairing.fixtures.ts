import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Effect, Layer, Schema } from 'effect'
import { Command, CommandHandler, HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import {
  defineFixture,
  defineScenario,
  makeCatalog,
  run,
  type RunReport
} from '@structure-ai/fixtures'
import type { DevicesView, DeviceSessionView } from '@clave/contract/devices'
import {
  AntasphereFixtureWorld,
  antasphereFixtureHandlers,
  StartLocalIssuer,
  SignInWithAntasphere,
  verifyAntasphereFixtures,
  cleanupAntasphereFixtures
} from './antasphere-account.fixtures'

// This scenario owns a local issuer, server and data directory. No production target is accepted.
const PairPhone = Command.define('mobile-fixtures/PairPhone', {
  payload: Schema.Struct({ runId: Schema.String, name: Schema.String }),
  success: Schema.Struct({ deviceId: Schema.String, pairingId: Schema.String, name: Schema.String })
})

const pairHandler = CommandHandler.make(PairPhone, ({ runId, name }) =>
  Effect.gen(function* () {
    const world = yield* AntasphereFixtureWorld
    const install = world.runs.get(runId)
    if (!install?.server) return yield* Effect.die('The fixture needs its signed-in server.')
    const { server, provider } = install
    return yield* Effect.promise(async () => {
      const json = async (route: string, body?: unknown, token: string | null = server.token) => {
        const response = await fetch(`${server.url}${route}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            ...(token && { authorization: `Bearer ${token}` }),
            'content-type': 'application/json'
          },
          ...(body !== undefined && { body: JSON.stringify(body) })
        })
        assert.equal(response.ok, true, `${route} answered ${response.status}`)
        return response.status === 204 ? null : response.json()
      }
      const redirect = 'clave://oauth/callback'
      const registration = await fetch(`${provider.issuer}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: [redirect],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code'],
          response_types: ['code']
        })
      })
      assert.equal(registration.ok, true)
      const { client_id: clientId } = (await registration.json()) as { client_id: string }
      const verifier = randomBytes(32).toString('base64url')
      const authorize = new URL(`${provider.issuer}/authorize`)
      authorize.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: 'code',
        scope: 'openid profile email',
        state: 'fixture',
        nonce: 'fixture',
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url')
      }).toString()
      const sent = await fetch(authorize, { redirect: 'manual' })
      const code = new URL(sent.headers.get('location')!).searchParams.get('code')!
      const exchange = await fetch(`${provider.issuer}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirect,
          client_id: clientId,
          code_verifier: verifier
        })
      })
      assert.equal(exchange.ok, true)
      const { id_token: idToken } = (await exchange.json()) as { id_token: string }
      const { pairingId } = (await json(
        '/devices/pair',
        { idToken, clientId, device: { name, platform: 'ios', appVersion: 'fixture' } },
        null
      )) as { pairingId: string }
      assert.deepEqual(await json(`/devices/pair?id=${pairingId}`, undefined, null), {
        status: 'pending'
      })
      await json('/devices/approve', { pairingId })
      const approved = (await json(`/devices/pair?id=${pairingId}`, undefined, null)) as {
        deviceSession: DeviceSessionView
      }
      const session = approved.deviceSession
      assert.equal(typeof session.token, 'string')
      assert.deepEqual(await json(`/devices/pair?id=${pairingId}`, undefined, null), {
        status: 'approved'
      })
      const me = (await json('/devices/me', undefined, session.token)) as { id: string }
      assert.equal(me.id, session.deviceId)
      const forbidden = await fetch(`${server.url}/accounts/antasphere`, {
        headers: { authorization: `Bearer ${session.token}` }
      })
      assert.equal(forbidden.status, 403)
      const document = fs.readFileSync(path.join(install.dataDir, 'devices.json'), 'utf8')
      assert.equal(document.includes(session.token), false)
      assert.equal(
        document.includes(createHash('sha256').update(session.token).digest('hex')),
        true
      )
      return { deviceId: session.deviceId, pairingId, name }
    })
  })
)

export const MobileFixturesLive = busesLayer.pipe(
  Layer.provide(HandlerRegistry.layer(...antasphereFixtureHandlers, pairHandler)),
  Layer.provideMerge(AntasphereFixtureWorld.layer)
)

export const mobileFixtureCatalog = makeCatalog({
  base: {},
  scenarios: [
    defineScenario({
      name: 'mobile/paired-phone',
      description: 'An owner approves a phone on an isolated local Clave server',
      input: Schema.Struct({}),
      fixtures: () => {
        const issuer = defineFixture({
          key: 'mobile/issuer',
          create: ({ dispatch, id, runId }) =>
            dispatch(StartLocalIssuer, {
              runId,
              subject: id('subject'),
              name: 'Fixture Owner',
              email: `${id('owner')}@fixtures.test`
            })
        })
        const owner = defineFixture({
          key: 'mobile/owner',
          dependencies: { issuer },
          create: ({ dispatch, dependencies, runId }) =>
            dispatch(SignInWithAntasphere, { runId, issuer: dependencies.issuer.issuer })
        })
        const phone = defineFixture({
          key: 'mobile/phone',
          dependencies: { owner },
          create: ({ dispatch, id, runId }) =>
            dispatch(PairPhone, { runId, name: `Fixture iPhone ${id('phone')}` })
        })
        return { issuer, owner, phone }
      }
    })
  ]
})

export const verifyMobileFixtures = (report: RunReport<Readonly<Record<string, unknown>>>) =>
  Effect.gen(function* () {
    yield* verifyAntasphereFixtures(report)
    const world = yield* AntasphereFixtureWorld
    const install = world.runs.get(report.runId)!
    const phone = report.values.phone as { deviceId: string; name: string }
    yield* Effect.promise(async () => {
      const response = await fetch(`${install.server!.url}/devices`, {
        headers: { authorization: `Bearer ${install.server!.token}` }
      })
      assert.equal(response.status, 200)
      const view = (await response.json()) as DevicesView
      assert.equal(
        view.devices.some((device) => device.id === phone.deviceId && device.name === phone.name),
        true
      )
      assert.equal(view.pending.length, 0)
      assert.equal(fs.statSync(path.join(install.dataDir, 'devices.json')).mode & 0o777, 0o600)
    })
  })

export const cleanupMobileFixtures = (runId: string) =>
  Effect.gen(function* () {
    const world = yield* AntasphereFixtureWorld
    const install = world.runs.get(runId)
    if (install?.server)
      yield* Effect.promise(async () => {
        const headers = {
          authorization: `Bearer ${install.server!.token}`,
          'content-type': 'application/json'
        }
        const response = await fetch(`${install.server!.url}/devices`, { headers })
        assert.equal(response.status, 200)
        const view = (await response.json()) as DevicesView
        for (const device of view.devices) {
          const revoked = await fetch(`${install.server!.url}/devices/revoke`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ deviceId: device.id })
          })
          assert.equal(revoked.status, 204)
        }
      })
    yield* cleanupAntasphereFixtures(runId)
  })

export const loadMobileScenario = () =>
  Effect.gen(function* () {
    const fixtures = yield* mobileFixtureCatalog.prepare('mobile/paired-phone', {})
    return yield* run({ fixtures, enabled: true, ready: verifyMobileFixtures, timeoutMs: 60_000 })
  })
