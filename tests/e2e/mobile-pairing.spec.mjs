// A phone pairs with this Mac (mobile wave, lane A, issue #281, acceptances 3
// and 5) through the real app: the app signed in on a local issuer the way
// antasphere-account.spec.mjs does, a phone stood in by fetch and a WebSocket
// with an ID token the same issuer minted for the same person under the
// phone's own client id, the phone asking in Settings → Mobile, approved
// there, its device session reaching the sessions and refused on the test
// fixture route and the owner's routes, listed on the page, revoked from it,
// refused afterwards with its socket closed. The device records on disk
// carry the hash and never the token; the relay address lands in the
// preferences as an origin.
//
// The server the suite runs decides the arm: in-process when the suite is,
// otherwise the app ATTACHED to a standalone server of this spec's own (a
// separate suite runs this arm too, so the server never seals the login in
// the person's keychain: the standalone gets a keychain file of the run's
// own, created and deleted here, as antasphere-account-attached.spec.mjs does).
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { WebSocket } from 'ws'
import {
  fixturePath,
  launchApp,
  seedWorkspaces,
  serverEndpoint,
  serverMode,
  until,
  userDataDir
} from './harness.mjs'
import { startOidcProvider } from './fixtures/oidc-provider.mjs'

const ARM = serverMode() === 'in-process' ? 'in-process' : 'attached'
const DIR = userDataDir('mobile-pairing')
const ROOT = fixturePath('mobile-pairing-root')
const KEYCHAIN = fixturePath('mobile-pairing-keychain/e2e.keychain-db')
const SECURITY = '/usr/bin/security'
const WS = { id: 'mobile-ws', name: 'Mobile', rootDir: ROOT, profileFile: null, createdAt: 1 }
const OWNER = {
  sub: 'e2e-owner',
  name: 'E2E Owner',
  email: 'owner@example.test',
  email_verified: true
}
const PHONE = { name: 'E2E iPhone', platform: 'ios', appVersion: '0.1.0-e2e' }

function createKeychain() {
  rmSync(path.dirname(KEYCHAIN), { recursive: true, force: true })
  mkdirSync(path.dirname(KEYCHAIN), { recursive: true })
  execFileSync(SECURITY, ['create-keychain', '-p', '', KEYCHAIN], { stdio: 'ignore' })
  execFileSync(SECURITY, ['set-keychain-settings', KEYCHAIN], { stdio: 'ignore' })
}
function deleteKeychain() {
  try {
    execFileSync(SECURITY, ['delete-keychain', KEYCHAIN], { stdio: 'ignore' })
  } catch {
    // Never created, or already gone.
  }
  rmSync(path.dirname(KEYCHAIN), { recursive: true, force: true })
}

/** No browser on this machine: main records what it would have opened. */
async function stubBrowser(app) {
  await app.evaluate(({ shell }) => {
    globalThis.__antasphereOpened = []
    shell.openExternal = async (url) => {
      globalThis.__antasphereOpened.push(url)
    }
  })
  return () => app.evaluate(() => globalThis.__antasphereOpened ?? [])
}

/** The phone's side of the hub: its own registration (so its own client id,
 *  not the Mac's), one sign-in as the owner, the ID token kept. */
async function phoneSignsIn(provider) {
  const redirect = 'clave://oauth/callback'
  const registration = await fetch(`${provider.issuer}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Clave on a phone',
      application_type: 'native'
    })
  })
  const { client_id: clientId } = await registration.json()
  const verifier = randomBytes(32).toString('base64url')
  const authorize = new URL(`${provider.issuer}/authorize`)
  authorize.searchParams.set('client_id', clientId)
  authorize.searchParams.set('redirect_uri', redirect)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('scope', 'openid profile email offline_access')
  authorize.searchParams.set('state', randomBytes(8).toString('hex'))
  authorize.searchParams.set('nonce', randomBytes(8).toString('hex'))
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
  const { id_token: idToken } = await exchanged.json()
  return { idToken, clientId }
}

/** A raw client of the server, as a phone is one: a bearer, or none. */
function client(url, token) {
  const base = String(url).replace(/\/+$/, '')
  return async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    const text = await res.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = { raw: text }
    }
    return { status: res.status, body: parsed }
  }
}

/** A phone's push socket: its Origin is the server's own address, as React
 *  Native derives it from the URL it opened. */
function phoneSocket(url, token) {
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/push', {
    headers: { origin: new URL(url).origin }
  })
  const frames = []
  const waiting = []
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString())
    const next = waiting.shift()
    if (next) next(frame)
    else frames.push(frame)
  })
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)))
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return {
    ws,
    opened,
    closed,
    hello: () => ws.send(JSON.stringify({ _tag: 'hello', token, client: 'phone' })),
    next: (timeoutMs = 5000) =>
      frames.length
        ? Promise.resolve(frames.shift())
        : new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no frame')), timeoutMs)
            waiting.push((frame) => {
              clearTimeout(timer)
              resolve(frame)
            })
          })
  }
}

/** Settings → <page>: from the sessions sidebar through its footer button,
 *  or straight to the row when Settings is already open. */
async function openSettingsPage(win, id) {
  const footer = win.locator('.sidebar-footer-btn[aria-label="Settings"]')
  if ((await footer.count()) > 0) await footer.click()
  await win.click(`[data-settings-nav-row="${id}"]`)
  const page = win.locator(`[data-settings-page="${id}"]`)
  await page.waitFor()
  return page
}

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  const provider = await startOidcProvider({ registrationStatus: 200, user: OWNER })
  const attached = ARM === 'attached'
  if (attached) createKeychain()
  const env = {
    CLAVE_ANTASPHERE_ISSUER: provider.issuer,
    ...(attached ? { CLAVE_KEYCHAIN_FILE: KEYCHAIN } : {})
  }
  const errors = []
  const { app, win, server } = await launchApp(DIR, { env, server: ARM })
  win.on('pageerror', (e) => errors.push(e.message))
  try {
    t.check(`the arm is ${ARM}`, true)
    const opened = await stubBrowser(app)

    // ── The Mac signs in ─────────────────────────────────────────────────
    const accounts = await openSettingsPage(win, 'accounts')
    const section = accounts.locator('[data-antasphere-account]')
    await section.waitFor()
    const signIn = section.getByRole('button', { name: 'Sign in with Antasphere', exact: true })
    await until(async () => !(await signIn.isDisabled()))
    await signIn.click()
    const urls = await until(async () => {
      const u = await opened()
      return u.length ? u : null
    })
    await provider.browse(urls[0])
    await until(async () => (await section.getAttribute('data-antasphere-phase')) === 'signed-in')
    t.check('the Mac is signed in as the owner', true)

    // ── The server a phone reaches ───────────────────────────────────────
    const endpoint = attached
      ? { url: server.url, token: server.token, dataDir: server.dataDir }
      : await until(() => {
          const d = serverEndpoint(DIR)
          return d && d.ok && d.token ? { url: d.url, token: d.token, dataDir: DIR } : null
        })
    t.check('the server endpoint is known', !!endpoint?.url, endpoint)
    const owner = client(endpoint.url, endpoint.token)
    const stranger = client(endpoint.url, null)

    // ── Settings → Mobile, nobody asking yet ─────────────────────────────
    const mobile = await openSettingsPage(win, 'mobile')
    await until(
      async () => (await mobile.locator('[data-mobile-owner-phase="signed-in"]').count()) === 1
    )
    t.equal(
      'the page says the owner is signed in',
      await mobile.locator('[data-mobile-owner-phase]').getAttribute('data-mobile-owner-phase'),
      'signed-in'
    )
    t.equal('no phone is asking', await mobile.locator('[data-mobile-pending-empty]').count(), 1)
    t.equal('no phone is paired', await mobile.locator('[data-mobile-devices-empty]').count(), 1)

    // ── The phone asks ───────────────────────────────────────────────────
    const phone = await phoneSignsIn(provider)
    t.check('the phone has its own client id', phone.clientId && !urls[0].includes(phone.clientId))
    const asked = await stranger('POST', '/devices/pair', { ...phone, device: PHONE })
    t.equal('the pairing request is taken without any bearer', asked.status, 200)
    const pairingId = asked.body?.pairingId
    t.check(
      'with a pairing id and a deadline',
      typeof pairingId === 'string' && asked.body.expiresAt > Date.now(),
      asked.body
    )
    const pending = await stranger('GET', `/devices/pair?id=${pairingId}`)
    t.check('the pairing is pending', pending.body?.status === 'pending', pending.body)
    const row = mobile.locator(`[data-mobile-pending-row="${pairingId}"]`)
    await row.waitFor()
    const rowText = await row.textContent()
    t.check(
      'the phone appears in Settings → Mobile by name and platform',
      rowText.includes(PHONE.name) && rowText.includes('iPhone'),
      rowText
    )
    const notified = await until(async () => {
      const seen = await app.evaluate(() => globalThis.__claveE2E?.devicesNotified ?? [])
      return seen.length ? seen : null
    })
    t.check(
      'the Mac was asked to notify, no window being focused, by name and platform',
      notified?.length === 1 && notified[0].name === PHONE.name && notified[0].platform === 'ios',
      notified
    )
    t.check(
      'nothing is issued before the approval',
      !existsSync(path.join(endpoint.dataDir, 'devices.json'))
    )

    // ── Approved on the Mac, the session reaches the phone once ─────────
    await row.locator('[data-mobile-approve]').click()
    const approved = await until(async () => {
      const read = await stranger('GET', `/devices/pair?id=${pairingId}`)
      return read.body?.status === 'approved' ? read.body : null
    })
    t.check(
      'the pairing reads approved with the device session, once',
      !!approved?.deviceSession?.token,
      approved
    )
    const session = approved.deviceSession
    t.check(
      'the session names this server',
      session.serverId && typeof session.serverName === 'string',
      session
    )
    const again = await stranger('GET', `/devices/pair?id=${pairingId}`)
    t.check(
      'a second read carries no token',
      again.body?.status === 'approved' && !again.body.deviceSession,
      again.body
    )
    await until(
      async () =>
        (await mobile.locator(`[data-mobile-device-row="${session.deviceId}"]`).count()) === 1
    )
    t.equal(
      'the phone is listed as paired',
      await mobile.locator(`[data-mobile-device-row="${session.deviceId}"]`).count(),
      1
    )
    t.equal('and no longer as asking', await mobile.locator('[data-mobile-pending-row]').count(), 0)
    const record = path.join(endpoint.dataDir, 'devices.json')
    t.check(
      'the record is on disk, owner-only',
      existsSync(record) && (statSync(record).mode & 0o777) === 0o600
    )
    const recordText = readFileSync(record, 'utf-8')
    t.check(
      'it keeps the hash and never the token',
      recordText.includes(createHash('sha256').update(session.token).digest('hex')) &&
        !recordText.includes(session.token)
    )

    // ── The device session's reach ───────────────────────────────────────
    const device = client(endpoint.url, session.token)
    const sessions = await device('GET', '/sessions')
    t.equal('the device session reaches the sessions', sessions.status, 200)
    const me = await device('GET', '/devices/me')
    t.check('and its own record', me.status === 200 && me.body?.id === session.deviceId, me.body)
    const evaluate = await device('POST', '/e2e/evaluate', { source: '() => 1' })
    t.equal('the fixture route refuses it', evaluate.status, 403)
    t.check(
      'with the one sentence',
      evaluate.body?.message === 'A phone may not do this.',
      evaluate.body
    )
    t.equal('the owner’s device list refuses it', (await device('GET', '/devices')).status, 403)
    t.equal('the accounts refuse it', (await device('GET', '/accounts/antasphere')).status, 403)
    t.equal('the clients refuse it', (await device('GET', '/clients')).status, 403)
    const socket = phoneSocket(endpoint.url, session.token)
    await socket.opened
    socket.hello()
    const welcome = await socket.next()
    t.check(
      'the push channel welcomes the device session from the phone’s origin',
      welcome?._tag === 'welcome',
      welcome
    )

    // ── A second phone, refused ──────────────────────────────────────────
    const second = await phoneSignsIn(provider)
    const secondAsk = await stranger('POST', '/devices/pair', {
      ...second,
      device: { ...PHONE, name: 'E2E Android', platform: 'android' }
    })
    t.equal('a second phone asks', secondAsk.status, 200)
    const secondRow = mobile.locator(`[data-mobile-pending-row="${secondAsk.body.pairingId}"]`)
    await secondRow.waitFor()
    await secondRow.locator('[data-mobile-refuse]').click()
    const refused = await until(async () => {
      const read = await stranger('GET', `/devices/pair?id=${secondAsk.body.pairingId}`)
      return read.body?.status === 'refused' ? read.body : null
    })
    t.check(
      'Refuse ends the request',
      refused?.status === 'refused' && !refused.deviceSession,
      refused
    )
    t.equal(
      'and the list is back to one phone',
      await mobile.locator('[data-mobile-device-row]').count(),
      1
    )

    // ── Revoked from the same page ───────────────────────────────────────
    await mobile
      .locator(`[data-mobile-device-row="${session.deviceId}"] [data-mobile-revoke]`)
      .click()
    const closeCode = await Promise.race([
      socket.closed,
      new Promise((resolve) => setTimeout(() => resolve('still open'), 10_000))
    ])
    t.equal('the phone’s socket is closed with the revocation code', closeCode, 4011)
    const after = await until(async () => {
      const r = await device('GET', '/sessions')
      return r.status === 401 ? r : null
    })
    t.check('the next call is refused', after?.status === 401, after)
    await until(async () => (await mobile.locator('[data-mobile-devices-empty]').count()) === 1)
    t.equal(
      'and the page lists no phone',
      await mobile.locator('[data-mobile-device-row]').count(),
      0
    )
    t.check(
      'the record no longer holds it',
      !readFileSync(record, 'utf-8').includes(session.deviceId)
    )

    // ── The relay address ────────────────────────────────────────────────
    const input = mobile.locator('[data-mobile-relay-input]')
    await input.fill('https://Relay.Example.com/')
    await mobile.locator('[data-mobile-relay-save]').click()
    const relay = await until(async () => {
      const r = await owner('GET', '/devices/relay')
      return r.body?.url === 'https://relay.example.com' ? r.body : null
    })
    t.check(
      'the relay address is stored as an origin',
      relay?.url === 'https://relay.example.com',
      relay
    )
    const prefs = JSON.parse(readFileSync(path.join(endpoint.dataDir, 'preferences.json'), 'utf-8'))
    t.equal('in the preferences', prefs.mobileRelayUrl, 'https://relay.example.com')
    await input.fill('not an address')
    await mobile.locator('[data-mobile-relay-save]').click()
    await mobile.locator('[data-mobile-relay-error]').waitFor()
    t.equal(
      'a bad address is refused on the page',
      await mobile.locator('[data-mobile-relay-error]').count(),
      1
    )
    t.equal(
      'and the stored one stands',
      (await owner('GET', '/devices/relay')).body?.url,
      'https://relay.example.com'
    )

    // ── What the window can and cannot see ───────────────────────────────
    const bridge = await win.evaluate(() =>
      Object.keys(window.electronAPI)
        .filter((k) => /devices|mobileRelay/i.test(k))
        .sort()
    )
    t.check(
      'the bridge offers the owner’s six calls and the change signal, nothing that returns a session token',
      bridge.join() ===
        'devicesApprove,devicesList,devicesRefuse,devicesRevoke,mobileRelayGet,mobileRelaySet,onDevicesChanged',
      bridge
    )
    const listed = await win.evaluate(() => window.electronAPI.devicesList())
    t.check(
      'the owner’s list carries no token',
      !JSON.stringify(listed).includes(session.token),
      listed
    )
    t.equal('no renderer errors', errors.length, 0, errors)
  } finally {
    await app.close()
    await provider.close()
    if (attached) deleteKeychain()
  }
}
