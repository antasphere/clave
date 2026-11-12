/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test of a plain JS script */
/**
 * The owner's pairing script (`phone-pairing.mjs`, PRDCT-4448) against a real
 * server in this process: it approves the one pairing it names and nothing
 * else, refuses before sending anything when a check fails, never prints the
 * server's token, and never reads the pairing route, so the phone still
 * collects its device session itself.
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startOidcProvider } from '../tests/e2e/fixtures/oidc-provider.mjs'
import { startEmbedded } from '../packages/server/src/embedded'
import { memoryDeviceStorage } from '../packages/server/src/devices/port'
import { FakeSource, aSession } from '../packages/server/src/test-support'
import {
  APPROVAL_MARGIN_MS,
  Refused,
  approve,
  list,
  readDiscovery,
  refuse,
  revoke
} from './phone-pairing.mjs'

const run = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('./phone-pairing.mjs', import.meta.url))
const OWNER = 'user-7f3a'
const PHONE = { name: 'Pixel 9', platform: 'android', appVersion: '1.0.0' }

let provider
let server
let dir
let discovery

beforeAll(async () => {
  provider = await startOidcProvider()
})
afterAll(async () => {
  await provider.close()
})
beforeEach(async () => {
  server = await startEmbedded({
    ports: {
      sessions: new FakeSource(aSession('s1')),
      devices: {
        storage: memoryDeviceStorage(),
        owner: () => OWNER,
        issuer: provider.issuer,
        serverName: () => 'the-mac'
      }
    }
  })
  dir = mkdtempSync(join(tmpdir(), 'clave-phone-pairing-'))
  discovery = join(dir, 'clave-server.json')
  writeFileSync(
    discovery,
    JSON.stringify({ url: server.url, token: server.token, ok: true, mode: 'separate' }),
    { mode: 0o600 }
  )
})
afterEach(async () => {
  await server.stop()
  rmSync(dir, { recursive: true, force: true })
})

async function mintIdToken() {
  const redirect = 'clave-android://oauth/callback'
  const registration = await fetch(`${provider.issuer}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      client_name: 'Clave on Android'
    })
  })
  const { client_id: clientId } = await registration.json()
  const verifier = randomBytes(32).toString('base64url')
  const authorize = new URL(`${provider.issuer}/authorize`)
  authorize.searchParams.set('client_id', clientId)
  authorize.searchParams.set('redirect_uri', redirect)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('scope', 'openid profile email')
  authorize.searchParams.set('state', 's')
  authorize.searchParams.set('nonce', 'n')
  authorize.searchParams.set(
    'code_challenge',
    createHash('sha256').update(verifier).digest('base64url')
  )
  authorize.searchParams.set('code_challenge_method', 'S256')
  const sent = await fetch(authorize, { redirect: 'manual' })
  const code = new URL(sent.headers.get('location')).searchParams.get('code')
  const exchanged = await fetch(`${provider.issuer}/token`, {
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
  return { idToken: (await exchanged.json()).id_token, clientId }
}

/** The phone asks to pair, through the open route: the pairing id to approve. */
async function phoneAsks() {
  const response = await fetch(`${server.url}/devices/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...(await mintIdToken()), device: PHONE })
  })
  expect(response.status).toBe(200)
  return (await response.json()).pairingId
}

/** The script as the owner runs it, with a bare environment and no stdin. */
async function cli(...args) {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      [SCRIPT, '--discovery', discovery, ...args],
      {
        timeout: 20_000,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }
      }
    )
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

const ownerList = async () =>
  (
    await fetch(`${server.url}/devices`, { headers: { authorization: `Bearer ${server.token}` } })
  ).json()

describe('the owner approves one phone, by its pairing id, from this Mac', () => {
  it('lists the phone asking, approves only the id it names, and never prints the token', async () => {
    const pairingId = await phoneAsks()
    const listed = await cli('--list')
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain(pairingId)
    expect(listed.stdout).toContain('Pixel 9')
    const wrong = await cli('--approve', 'not-this-one')
    expect(wrong.code).toBe(2)
    expect(wrong.stderr).toContain('No pending pairing')
    const misnamed = await cli('--approve', pairingId, '--expect-name', 'Another phone')
    expect(misnamed.code).toBe(2)
    expect((await ownerList()).pending.map((p) => p.id)).toEqual([pairingId])
    const approved = await cli('--approve', pairingId, '--expect-name', 'Pixel 9')
    expect(approved.code, approved.stderr).toBe(0)
    expect(approved.stdout).toContain('Approved: Pixel 9')
    for (const output of [listed, wrong, misnamed, approved])
      expect(output.stdout + output.stderr).not.toContain(server.token)
    // The script did not collect the session: the phone's own read still gets it, once.
    const read = await (await fetch(`${server.url}/devices/pair?id=${pairingId}`)).json()
    expect(read.status).toBe('approved')
    expect(read.deviceSession.token).toBeTruthy()
    // Revoking it from here ends its session.
    const revoked = await cli('--revoke', read.deviceSession.deviceId)
    expect(revoked.code, revoked.stderr).toBe(0)
    const after = await fetch(`${server.url}/sessions`, {
      headers: { authorization: `Bearer ${read.deviceSession.token}` }
    })
    expect(after.status).toBe(401)
  })

  it('refuses a pairing about to lapse, and approves nothing by a name alone', async () => {
    const pairingId = await phoneAsks()
    const local = readDiscovery(discovery)
    const pending = (await list(local)).pending[0]
    await expect(
      approve(local, pairingId, { now: pending.expiresAt - APPROVAL_MARGIN_MS })
    ).rejects.toBeInstanceOf(Refused)
    await expect(approve(local, '', {})).rejects.toBeInstanceOf(Refused)
    expect((await cli('--approve')).code).toBe(2)
    expect((await cli('--expect-name', 'Pixel 9')).code).toBe(2)
    expect((await ownerList()).pending.map((p) => p.id)).toEqual([pairingId])
  })

  it('never reads the pairing route, whatever it does', async () => {
    const pairingId = await phoneAsks()
    const local = readDiscovery(discovery)
    const asked = []
    const recording = (url, init) => {
      asked.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`)
      return fetch(url, init)
    }
    await list(local, recording)
    const { device } = await approve(local, pairingId, { fetchImpl: recording })
    await revoke(local, device.id, recording)
    const second = await phoneAsks()
    await refuse(local, second, recording)
    expect(asked.every((request) => !request.endsWith(' /devices/pair'))).toBe(true)
    expect(asked).toContain('POST /devices/approve')
  })
})

describe('the discovery file the token is read from', () => {
  it('sends the token to this Mac’s loopback only', async () => {
    writeFileSync(
      discovery,
      JSON.stringify({ url: 'http://100.69.0.1:443', token: server.token, ok: true }),
      { mode: 0o600 }
    )
    const answer = await cli('--list')
    expect(answer.code).toBe(2)
    expect(answer.stderr).toContain('loopback')
    expect(answer.stderr).not.toContain(server.token)
  })

  it('refuses a file anyone else can read, a server that is not up, or no file', async () => {
    chmodSync(discovery, 0o644)
    expect((await cli('--list')).code).toBe(2)
    writeFileSync(discovery, JSON.stringify({ url: server.url, token: server.token, ok: false }), {
      mode: 0o600
    })
    chmodSync(discovery, 0o600)
    expect((await cli('--list')).code).toBe(2)
    rmSync(discovery)
    expect((await cli('--list')).code).toBe(2)
  })
})
