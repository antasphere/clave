// Beta acceptance on a real standalone server. OIDC and echo are local fixtures;
// the push transport records delivery, while DeviceSessions owns the targets.
// Restart durability is deliberately unexercised: this harness owns the server lifetime.
import { mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { WebSocket } from 'ws'
import { fixturePath, until } from './harness.mjs'
import { openChat, inject } from './chat-view.spec.mjs'
import { startOidcProvider } from './fixtures/oidc-provider.mjs'
const KEYCHAIN = fixturePath('mobile-d-beta-keychain/e2e.keychain-db')
const SECURITY = '/usr/bin/security'
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

export async function run(t) {
  createKeychain()
  const provider = await startOidcProvider({
    registrationStatus: 200,
    user: {
      sub: 'beta-owner',
      name: 'Beta Owner',
      email: 'beta@example.test',
      email_verified: true
    }
  })
  let chat
  try {
    chat = await openChat(
      'mobile-d-beta',
      ['--push-fake-transports'],
      undefined,
      {
        CLAVE_ANTASPHERE_ISSUER: provider.issuer,
        CLAVE_KEYCHAIN_FILE: KEYCHAIN
      },
      null,
      { server: 'attached' }
    )
    const { app, win, server, fixture, record } = chat
    const opened = await stubBrowser(app)
    await win.locator('.sidebar-footer-btn[aria-label="Settings"]').click()
    await win.click('[data-settings-nav-row="accounts"]')
    const section = win.locator('[data-antasphere-account]')
    const signIn = section.getByRole('button', { name: 'Sign in with Antasphere', exact: true })
    await until(async () => !(await signIn.isDisabled()))
    await signIn.click()
    const urls = await until(async () => {
      const urls = await opened()
      return urls.length ? urls : null
    })
    await provider.browse(urls[0])
    t.check(
      'local OIDC owner signed in',
      !!(await until(
        async () => (await section.getAttribute('data-antasphere-phase')) === 'signed-in'
      ))
    )
    const owner = client(server.url, server.token)
    const publicCall = client(server.url)
    const phone = await phoneSignsIn(provider)
    const asked = await publicCall('POST', '/devices/pair', {
      ...phone,
      device: { name: 'Beta fixture phone', platform: 'ios', appVersion: 'e2e' }
    })
    t.equal('owner phone requests pairing', asked.status, 200)
    t.equal(
      'desktop approves pairing',
      (await owner('POST', '/devices/approve', { pairingId: asked.body?.pairingId })).status,
      200
    )
    const approved = await publicCall('GET', `/devices/pair?id=${asked.body?.pairingId}`)
    const session = approved.body?.deviceSession
    t.check('paired phone gets device credential', !!session?.token)
    if (!session?.token) throw new Error('pairing did not issue a credential')
    const device = client(server.url, session.token)
    const originalUser = provider.state.user
    provider.state.user = { ...originalUser, sub: 'beta-stranger' }
    const stranger = await phoneSignsIn(provider)
    provider.state.user = originalUser
    const refused = await publicCall('POST', '/devices/pair', {
      ...stranger,
      device: { name: 'Stranger fixture', platform: 'ios', appVersion: 'e2e' }
    })
    t.check('another signed subject cannot pair', refused.status >= 400)
    const pushToken = 'mobile-d-fixture-native-token'
    t.equal(
      'phone registers native push token',
      (await device('POST', '/devices/me/push-token', { token: pushToken, platform: 'ios' }))
        .status,
      204
    )
    t.equal(
      'real device registration creates one notify target',
      (await owner('GET', '/notify/status')).body?.targets,
      1
    )
    const socket = phoneSocket(server.url, session.token)
    await socket.opened
    socket.hello()
    t.equal('phone socket welcomed', (await socket.next())._tag, 'welcome')
    socket.ws.close()
    await socket.closed
    await inject(fixture, record.id, [
      {
        type: 'permission_request',
        id: 'beta-ask',
        description: 'Echo fixture question',
        toolName: 'AskUserQuestion',
        input: {},
        options: [{ id: 'answer', label: 'Submit' }],
        questions: [{ question: 'Ship beta?', options: [] }]
      }
    ])
    const pushes = await until(async () => {
      const sent = await fixture.evaluate(() => globalThis.__claveE2E.notify.sent())
      return sent.some((s) => s.payload.category === 'question') ? sent : null
    })
    const push = pushes?.find((s) => s.payload.category === 'question')
    t.check(
      'disconnected paired device receives question push',
      push?.deviceId === session.deviceId && push?.payload?.sessionId === record.id
    )
    const response = { type: 'permission', optionId: 'answer', answers: { 'Ship beta?': 'yes' } }
    const participants = [owner, device]
    t.check(
      'desktop owner and paired phone answer through different clients',
      participants[0] !== participants[1]
    )
    const answers = await Promise.all(
      participants.map((send) =>
        send('POST', '/requests/resolve', { requestId: push?.payload?.requestId, response })
      )
    )
    t.check(
      'both owner and phone receive valid resolution results',
      answers.every((answer) => answer.status === 200)
    )
    t.equal(
      'desktop owner and phone have exactly one answer winner',
      answers.filter((a) => a.body?.accepted === true).length,
      1
    )
    const clientMessageId = 'mobile-d-beta-message-0001'
    const text = 'beta disconnected message'
    const writes = await Promise.all(
      [1, 2].map(() =>
        device('POST', '/sessions/write', {
          id: record.id,
          input: { type: 'user_message', text, clientMessageId }
        })
      )
    )
    t.check(
      'both duplicate device writes succeed',
      writes.every((w) => w.status === 200)
    )
    const history = await until(async () => {
      const result = await device('GET', `/sessions/history?id=${record.id}`)
      return result.body?.items?.some(
        (i) => i.event.type === 'assistant_text' && i.event.delta === text
      )
        ? result
        : null
    })
    t.equal('disconnected phone can read history', history?.status, 200)
    t.equal(
      'one user message reaches history',
      history?.body?.items?.filter(
        (i) => i.event.type === 'user_message' && i.event.clientMessageId === clientMessageId
      ).length,
      1
    )
    t.equal(
      'echo provider answers once',
      history?.body?.items?.filter(
        (i) => i.event.type === 'assistant_text' && i.event.delta === text
      ).length,
      1
    )
    t.equal(
      'sessions remain accessible disconnected',
      (await device('GET', '/sessions')).status,
      200
    )
    t.equal(
      'write status is accepted',
      (await device('GET', `/sessions/writes?id=${record.id}&clientMessageId=${clientMessageId}`))
        .body?.status,
      'accepted'
    )
  } finally {
    await chat?.close()
    await provider.close()
    deleteKeychain()
  }
}
