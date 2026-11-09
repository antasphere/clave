#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by node */
// The environment the native Android app is developed and tested against, on
// 127.0.0.1 only: a local OpenID Connect provider standing in for the hub
// (tests/e2e/fixtures/oidc-provider.mjs), the relay and a Clave daemon with
// the Echo adapter, both from this checkout under the repository's Bun. The
// owner is signed in on the daemon, the daemon claims its machine on the
// relay, a scratch workspace holds one Echo session with one message in it.
//
//   node apps/mobile-android/scripts/fixture-env.mjs --server 47201 --relay 47202 \
//     --issuer 47203 --tmpdir /private/tmp/clave-native-b/fixture [--check] [--approve]
//
// Writes <tmpdir>/fixture.json and prints CLAVE_FIXTURE_* lines. The daemon's
// bearer is in a mode-0600 file (tokenFile); no token is ever printed.
// --check plays a phone over HTTP through the relay and exits 0 or 1.
// --approve keeps running and approves every phone that asks to pair.
// Otherwise it keeps running until SIGINT/SIGTERM, which stops every child.
//
// The issuer: the provider is bound on <issuer> itself, not behind a proxy.
// Its discovery `issuer` and every token's `iss` are derived from the port it
// listens on, and both the daemon (discovery metadata) and the pairing (`iss`)
// compare them with the configured origin, so a forwarder on another port
// would make every check fail.
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { ensureWorkspace } from '../../mobile/scripts/dev-server.mjs'
import { startOidcProvider } from '../../../tests/e2e/fixtures/oidc-provider.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const BUN = path.join(REPO, 'node_modules', '.bin', 'bun')

const OWNER = {
  sub: 'fixture-owner',
  name: 'Fixture Owner',
  email: 'owner@fixture.test',
  email_verified: true
}
const PHONE_REDIRECT = 'clave-android://oauth/callback'
const PHONE = { name: 'fixture check phone', platform: 'android', appVersion: '0.1.0' }

// ── Arguments ───────────────────────────────────────────────────────────────

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}
const flag = (name) => process.argv.includes(`--${name}`)
function portArg(name, fallback) {
  const value = Number(arg(name, String(fallback)))
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    process.stderr.write(`fixture: --${name} must be a port, got ${arg(name)}\n`)
    process.exit(2)
  }
  return value
}

const SERVER_PORT = portArg('server', 47201)
const RELAY_PORT = portArg('relay', 47202)
const ISSUER_PORT = portArg('issuer', 47203)
const TMPDIR = path.resolve(arg('tmpdir', '/private/tmp/clave-native-b/fixture'))
const CHECK = flag('check')
const APPROVE = flag('approve')

const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}`
const ISSUER_URL = `http://127.0.0.1:${ISSUER_PORT}`
const SERVER_DATA = path.join(TMPDIR, 'server')

/** A directory of agent stubs that exit 1, so the daemon's title generator never spawns a
 *  real agent under the person's login from the fixture environment. */
function agentShims() {
  const dir = path.join(TMPDIR, 'shims')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const name of ['claude', 'codex']) {
    const file = path.join(dir, name)
    writeFileSync(file, '#!/bin/sh\necho "fixture: no real agent runs here (' + name + ' disabled)" >&2\nexit 1\n', { mode: 0o755 })
  }
  return dir
}
const RELAY_DATA = path.join(TMPDIR, 'relay')
const SCRATCH = path.join(TMPDIR, 'scratch')
const TOKEN_FILE = path.join(TMPDIR, 'server-token')
const FIXTURE_FILE = path.join(TMPDIR, 'fixture.json')

const say = (line) => process.stdout.write(`${line}\n`)
const note = (line) => process.stderr.write(`fixture: ${line}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hex = (n) => randomBytes(n).toString('hex')

// ── The children, and stopping them ─────────────────────────────────────────

/** Every process this script spawned, and nothing else. */
const children = []
let provider = null
let stopping = null

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const hard = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, 8_000)
    child.once('exit', () => {
      clearTimeout(hard)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

function stopAll() {
  if (!stopping)
    stopping = (async () => {
      // The daemon first, so it tells the relay goodbye while the relay listens.
      for (const child of [...children].reverse()) await stopChild(child)
      if (provider) await provider.close().catch(() => {})
    })()
  return stopping
}

async function exitWith(code) {
  await stopAll()
  process.exit(code)
}

process.on('SIGINT', () => void exitWith(130))
process.on('SIGTERM', () => void exitWith(143))
process.on('uncaughtException', (error) => {
  note(`error: ${error?.message ?? error}`)
  void exitWith(1)
})
process.on('unhandledRejection', (error) => {
  note(`error: ${error?.message ?? error}`)
  void exitWith(1)
})
// A last resort for an exit that bypassed the handlers: no child outlives us.
process.on('exit', () => {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
})

/** A child under the repository's Bun, its output prefixed and passed through. */
function spawnBun(label, args, env) {
  const child = spawn(BUN, args, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  const tail = []
  const relayLines = (stream, sink) => {
    let partial = ''
    stream.on('data', (d) => {
      partial += String(d)
      const lines = partial.split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        tail.push(line)
        if (tail.length > 200) tail.shift()
        sink(line)
      }
    })
  }
  const stdoutLines = []
  relayLines(child.stdout, (line) => {
    stdoutLines.push(line)
    process.stderr.write(`${label}: ${line}\n`)
  })
  relayLines(child.stderr, (line) => process.stderr.write(`${label}: ${line}\n`))
  return { child, tail, stdoutLines }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

/** A raw client: a bearer or none; answers `{status, body}` and never throws on a status. */
function client(base, token) {
  const root = String(base).replace(/\/+$/, '')
  return async (method, route, body) => {
    const res = await fetch(root + route, {
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
      parsed = { raw: text.slice(0, 400) }
    }
    return { status: res.status, body: parsed }
  }
}

/** Polls `probe` until it answers something truthy, or null at the deadline. */
async function until(probe, timeoutMs, everyMs = 250) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe().catch(() => null)
    if (value) return value
    if (Date.now() > deadline) return null
    await sleep(everyMs)
  }
}

function portBusy(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

// ── Step 1: the provider, the relay, the daemon ─────────────────────────────

/** The fixture binds port 0; for its start alone, that bind is the issuer port. */
async function startProviderOn(port) {
  const original = net.Server.prototype.listen
  net.Server.prototype.listen = function (...args) {
    if (args[0] === 0 && args[1] === '127.0.0.1') args[0] = port
    return original.apply(this, args)
  }
  try {
    return await startOidcProvider({ registrationStatus: 200, user: OWNER })
  } finally {
    net.Server.prototype.listen = original
  }
}

async function startRelay() {
  mkdirSync(RELAY_DATA, { recursive: true, mode: 0o700 })
  const run = spawnBun(
    'relay',
    [
      path.join(REPO, 'apps', 'relay', 'src', 'main.ts'),
      '--port',
      String(RELAY_PORT),
      '--data-dir',
      RELAY_DATA,
      '--issuer',
      ISSUER_URL
    ],
    { ...process.env }
  )
  const url = await until(async () => {
    if (run.child.exitCode !== null) throw new Error('exited')
    for (const line of run.stdoutLines) {
      try {
        const value = JSON.parse(line)
        if (typeof value.url === 'string') return value.url
      } catch {
        /* not the announcement */
      }
    }
    return null
  }, 30_000, 100)
  if (!url) throw new Error(`the relay did not announce itself (exit ${run.child.exitCode})`)
  return run
}

async function startDaemon() {
  mkdirSync(SERVER_DATA, { recursive: true, mode: 0o700 })
  const run = spawnBun(
    'server',
    [
      path.join(REPO, 'apps', 'server', 'src', 'main.ts'),
      '--data-dir',
      SERVER_DATA,
      '--daemon',
      '--port',
      String(SERVER_PORT),
      '--dev-echo-adapter',
      '--relay',
      RELAY_URL
    ],
    {
      ...process.env,
      // The daemon's title generator runs the real `claude -p` under the person's own login
      // on a chat's first message, by name through the PATH (title-generator.ts, execFile).
      // The fixture must never reach a real agent: a shim directory holding `claude` and
      // `codex` stubs that exit 1 goes first on the PATH, so the title falls back to the
      // default and nothing leaves the loopback. The Echo adapter runs in process and needs
      // neither binary.
      PATH: `${agentShims()}:${process.env.PATH ?? ''}`,
      CLAVE_ANTASPHERE_ISSUER: ISSUER_URL,
      CLAVE_KEYCHAIN_FILE: path.join(SERVER_DATA, 'keychain.json')
    }
  )
  const discoveryFile = path.join(SERVER_DATA, 'clave-server.json')
  const discovery = await until(async () => {
    if (run.child.exitCode !== null) throw new Error('exited')
    const value = JSON.parse(readFileSync(discoveryFile, 'utf8'))
    return value.pid === run.child.pid &&
      typeof value.url === 'string' &&
      typeof value.token === 'string'
      ? value
      : null
  }, 60_000, 100)
  if (!discovery)
    throw new Error(`the daemon did not announce itself (exit ${run.child.exitCode})`)
  return { ...run, url: discovery.url, token: discovery.token, serverId: discovery.serverId }
}

// ── Step 2: the owner signs in on the daemon ────────────────────────────────

async function signOwnerIn(owner) {
  const started = await owner('POST', '/accounts/antasphere/sign-in', {})
  const handoff = started.body?.handoff
  if (started.status !== 200 || !handoff?.url)
    throw new Error(
      `sign-in answered ${started.status}, phase ${started.body?.status?.phase ?? '?'}, failure ${
        started.body?.status?.lastFailure ?? started.body?._tag ?? 'none'
      }`
    )
  // The shell's own confirmation before it opens the browser (a read).
  await owner('POST', '/accounts/antasphere/handoff/confirm', handoff)
  const browsed = await provider.browse(handoff.url)
  const callbackStatus = browsed.response.status
  let last = null
  const signed = await until(async () => {
    const read = await owner('GET', '/accounts/antasphere')
    last = read.body
    return read.body?.phase === 'signed-in' ? read.body : null
  }, 20_000)
  if (!signed)
    throw new Error(
      `the owner is not signed in: phase ${last?.phase ?? '?'}, failure ${
        last?.lastFailure ?? 'none'
      }, callback ${callbackStatus}`
    )
  return signed
}

// ── Step 3: the relay lists the machine ─────────────────────────────────────

async function waitForMachine(relayRun) {
  const ownerAtRelay = client(RELAY_URL, provider.mintAccessToken({ sub: OWNER.sub }))
  let last = null
  const machine = await until(async () => {
    const read = await ownerAtRelay('GET', '/machines')
    last = read
    return read.body?.machines?.find((m) => m.online) ?? null
  }, 30_000, 500)
  if (!machine) {
    for (const line of relayRun.tail.slice(-30)) process.stderr.write(`relay (tail): ${line}\n`)
    throw new Error(
      `no machine online on the relay after 30 s (last answer ${last?.status}, ${
        last?.body?.machines?.length ?? 0
      } machine(s))`
    )
  }
  return machine
}

// ── Step 4: the scratch workspace and one Echo session ──────────────────────

const FAMILY_FLAG = {
  claude: 'claudeMode',
  antigravity: 'antigravityMode',
  codex: 'codexMode',
  pi: 'piMode'
}

async function timelineItems(call, sessionId) {
  const read = await call('GET', `/sessions/timeline?id=${encodeURIComponent(sessionId)}`)
  if (read.status !== 200) return { status: read.status, items: null, body: read.body }
  return { status: 200, items: read.body?.items ?? [] }
}
const userMessages = (items, text) =>
  items.filter((i) => i.event?.type === 'user_message' && i.event.text === text)
const echoReplied = (items, text) =>
  items.some(
    (i) =>
      i.event?.type === 'assistant_text' &&
      typeof i.event.delta === 'string' &&
      i.event.delta.includes(text)
  )

async function startEchoSession(daemon, owner) {
  const workspace = await ensureWorkspace(daemon.url, daemon.token, SCRATCH, 'scratch')
  const profiles = await owner('GET', '/launch-profiles')
  if (profiles.status !== 200) throw new Error(`/launch-profiles answered ${profiles.status}`)
  const echo = (profiles.body?.customProfiles ?? []).find(
    (p) => p.id === 'dev-echo-adapter' || /echo/i.test(p.name)
  )
  if (!echo) throw new Error('no Echo profile in /launch-profiles (is --dev-echo-adapter on?)')
  const familyFlag = FAMILY_FLAG[echo.family]
  const started = await owner('POST', '/sessions/start', {
    cwd: SCRATCH,
    options: {
      launchProfileId: echo.id,
      launchProfile: echo,
      workspaceId: workspace.id,
      ...(familyFlag ? { [familyFlag]: true } : {})
    }
  })
  if (started.status !== 200 || !started.body?.id)
    throw new Error(
      `/sessions/start answered ${started.status}: ${JSON.stringify(started.body).slice(0, 400)}`
    )
  const sessionId = started.body.id
  const nonce = `fixture-${hex(6)}`
  const written = await owner('POST', '/sessions/write', {
    id: sessionId,
    input: { type: 'user_message', text: nonce, clientMessageId: `fixture-cmid-${hex(8)}` }
  })
  if (written.status !== 200)
    throw new Error(
      `/sessions/write answered ${written.status}: ${JSON.stringify(written.body).slice(0, 400)}`
    )
  const replied = await until(async () => {
    const { items } = await timelineItems(owner, sessionId)
    return items && echoReplied(items, nonce)
  }, 20_000)
  if (!replied) throw new Error(`the Echo did not reply to ${nonce} within 20 s`)
  return { workspace, sessionId, nonce, profile: echo }
}

// ── Step 7: a phone, over HTTP ──────────────────────────────────────────────

/** The phone's own registration at the issuer and its PKCE code flow. */
async function phoneSignsIn() {
  const registration = await fetch(`${ISSUER_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [PHONE_REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Clave on Android (fixture check)',
      application_type: 'native'
    })
  })
  if (registration.status !== 200) throw new Error(`register answered ${registration.status}`)
  const { client_id: clientId } = await registration.json()
  const verifier = randomBytes(32).toString('base64url')
  const authorize = new URL(`${ISSUER_URL}/authorize`)
  authorize.searchParams.set('client_id', clientId)
  authorize.searchParams.set('redirect_uri', PHONE_REDIRECT)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('scope', 'openid profile email offline_access')
  authorize.searchParams.set('state', hex(8))
  authorize.searchParams.set('nonce', hex(8))
  authorize.searchParams.set(
    'code_challenge',
    createHash('sha256').update(verifier).digest('base64url')
  )
  authorize.searchParams.set('code_challenge_method', 'S256')
  const sent = await fetch(authorize, { redirect: 'manual' })
  if (sent.status !== 302) throw new Error(`authorize answered ${sent.status}`)
  const back = new URL(sent.headers.get('location'))
  const code = back.searchParams.get('code')
  if (!code) throw new Error(`authorize redirected without a code (${back.searchParams.get('error')})`)
  const exchanged = await fetch(`${ISSUER_URL}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: PHONE_REDIRECT,
      client_id: clientId,
      code_verifier: verifier
    })
  })
  if (exchanged.status !== 200) throw new Error(`token answered ${exchanged.status}`)
  const tokens = await exchanged.json()
  if (!tokens.id_token || !tokens.access_token) throw new Error('token answered no ID token')
  return { clientId, idToken: tokens.id_token, accessToken: tokens.access_token }
}

/** A push socket through the relay road, its frames queued. */
function pushSocket(url, origin) {
  const ws = new WebSocket(url, { headers: { origin } })
  const frames = []
  const waiting = []
  ws.on('message', (data) => {
    let frame
    try {
      frame = JSON.parse(data.toString())
    } catch {
      return
    }
    const next = waiting.shift()
    if (next) next(frame)
    else frames.push(frame)
  })
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade answered ${res.statusCode}`)))
  })
  const next = (timeoutMs) =>
    frames.length
      ? Promise.resolve(frames.shift())
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no frame')), timeoutMs)
          waiting.push((frame) => {
            clearTimeout(timer)
            resolve(frame)
          })
        })
  /** The first frame of `tag`, skipping the others (stream frames after a subscribe). */
  const nextOf = async (tag, timeoutMs = 8_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`no ${tag} frame`)
      const frame = await next(left)
      if (frame?._tag === tag) return frame
      if (frame?._tag === 'error' || frame?._tag === 'refused')
        throw new Error(`${frame._tag}: ${frame.message ?? frame.reason ?? ''}`)
    }
  }
  return { ws, opened, nextOf, send: (frame) => ws.send(JSON.stringify(frame)) }
}

async function runCheck(env) {
  const results = []
  let failed = false
  const step = async (name, fn) => {
    if (failed) {
      results.push(`- ${name} (not run)`)
      say(`- ${name} (not run)`)
      return undefined
    }
    try {
      const detail = await fn()
      const line = `✓ ${name}${detail ? ` (${detail})` : ''}`
      results.push(line)
      say(line)
      return true
    } catch (error) {
      failed = true
      const line = `✗ ${name}: ${error?.message ?? error}`
      results.push(line)
      say(line)
      return false
    }
  }
  const expect = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const brief = (body) => JSON.stringify(body ?? null).slice(0, 300)

  const owner = client(env.serverUrl, env.serverToken)
  const stranger = client(`${RELAY_URL}/m/${env.machineId}`, null)
  let phone, pairingId, deviceSession, device, checkText, checkCmid, firstWrite

  await step('the phone registers its own client at the issuer and signs in (PKCE)', async () => {
    phone = await phoneSignsIn()
    return `client ${phone.clientId}`
  })
  await step('the relay lists the machine to the phone', async () => {
    const read = await client(RELAY_URL, phone.accessToken)('GET', '/machines')
    expect(read.status === 200, `GET /machines answered ${read.status}`)
    const machine = read.body?.machines?.find((m) => m.id === env.machineId)
    expect(machine, `machine ${env.machineId} not listed`)
    expect(machine.online, 'the machine is offline')
    return `${machine.id}, ${machine.name}, online`
  })
  await step('the phone asks to pair through the relay, no bearer', async () => {
    const asked = await stranger('POST', '/devices/pair', {
      idToken: phone.idToken,
      clientId: phone.clientId,
      device: PHONE
    })
    expect(
      asked.status === 200 && typeof asked.body?.pairingId === 'string',
      `POST /devices/pair answered ${asked.status}: ${brief(asked.body)}`
    )
    pairingId = asked.body.pairingId
    return `pairing ${pairingId}`
  })
  await step('the pairing reads pending', async () => {
    const read = await stranger('GET', `/devices/pair?id=${encodeURIComponent(pairingId)}`)
    expect(read.body?.status === 'pending', `answered ${read.status}: ${brief(read.body)}`)
    return 'pending'
  })
  await step('the owner approves it on the daemon', async () => {
    const approved = await owner('POST', '/devices/approve', { pairingId })
    expect(
      approved.status === 200 && approved.body?.id,
      `POST /devices/approve answered ${approved.status}: ${brief(approved.body)}`
    )
    return `device ${approved.body.id}`
  })
  await step('the pairing reads approved with the device session, once', async () => {
    const read = await stranger('GET', `/devices/pair?id=${encodeURIComponent(pairingId)}`)
    expect(
      read.body?.status === 'approved' && read.body.deviceSession?.token,
      `answered ${read.status}, status ${read.body?.status}, session ${read.body?.deviceSession ? 'present' : 'absent'}`
    )
    deviceSession = read.body.deviceSession
    const again = await stranger('GET', `/devices/pair?id=${encodeURIComponent(pairingId)}`)
    expect(
      again.body?.status === 'approved' && !again.body.deviceSession,
      `the second read answered ${again.status}, status ${again.body?.status}, session ${again.body?.deviceSession ? 'present' : 'absent'}`
    )
    device = client(`${RELAY_URL}/m/${env.machineId}`, deviceSession.token)
    return `device ${deviceSession.deviceId}, server ${deviceSession.serverId}; second read without it`
  })
  await step('GET /devices/me through the relay', async () => {
    const me = await device('GET', '/devices/me')
    expect(me.status === 200 && me.body?.id === deviceSession.deviceId, `answered ${me.status}: ${brief(me.body)}`)
    return `200, ${me.body.name}, ${me.body.platform}`
  })
  await step('GET /sessions through the relay holds the Echo session', async () => {
    const read = await device('GET', '/sessions')
    expect(read.status === 200, `answered ${read.status}`)
    const list = Array.isArray(read.body) ? read.body : (read.body?.sessions ?? [])
    expect(list.some((s) => s.id === env.sessionId), `session ${env.sessionId} not listed`)
    return `200, ${list.length} session(s)`
  })
  await step('GET /devices through the relay is refused (the device-session boundary)', async () => {
    const read = await device('GET', '/devices')
    const detail = `${read.status} ${read.body?.error ?? ''}: ${read.body?.message ?? ''}`
    expect(
      read.status === 403 &&
        read.body?.error === 'Forbidden' &&
        read.body?.message === 'A phone may not do this.',
      `answered ${detail}`
    )
    return detail
  })
  await step('GET /sessions/timeline through the relay holds the nonce with a position', async () => {
    const { status, items } = await timelineItems(device, env.sessionId)
    expect(items, `answered ${status}`)
    const hit = userMessages(items, env.nonce)[0]
    expect(hit, `${env.nonce} not in ${items.length} item(s)`)
    expect(hit.position !== undefined && hit.position !== null, 'the item has no position')
    return `${env.nonce} at ${JSON.stringify(hit.position)}`
  })
  await step('POST /sessions/write through the relay is accepted', async () => {
    checkText = `check-${hex(6)}`
    checkCmid = `check-cmid-${hex(8)}`
    const written = await device('POST', '/sessions/write', {
      id: env.sessionId,
      input: { type: 'user_message', text: checkText, clientMessageId: checkCmid }
    })
    expect(
      written.status === 200 && written.body?.status === 'accepted',
      `answered ${written.status}: ${brief(written.body)}`
    )
    firstWrite = written.body
    return `${checkText}, accepted`
  })
  await step('the same clientMessageId again answers the same, and writes nothing', async () => {
    const again = await device('POST', '/sessions/write', {
      id: env.sessionId,
      input: { type: 'user_message', text: checkText, clientMessageId: checkCmid }
    })
    expect(
      again.status === 200 && again.body?.status === 'accepted',
      `answered ${again.status}: ${brief(again.body)}`
    )
    expect(
      again.body.at === firstWrite.at,
      `the second answer's time differs (${again.body.at} vs ${firstWrite.at})`
    )
    return 'accepted, same answer'
  })
  await step("the Echo replies to the check text, and the timeline holds it once", async () => {
    let count = 0
    const replied = await until(async () => {
      const { items } = await timelineItems(device, env.sessionId)
      if (!items) return null
      count = userMessages(items, checkText).length
      return echoReplied(items, checkText)
    }, 20_000)
    expect(replied, `no Echo reply to ${checkText} within 20 s`)
    await sleep(500)
    const { items } = await timelineItems(device, env.sessionId)
    count = userMessages(items ?? [], checkText).length
    expect(count === 1, `${checkText} is in the timeline ${count} time(s)`)
    return 'replied; once'
  })
  await step('GET /sessions/writes reads accepted', async () => {
    const read = await device(
      'GET',
      `/sessions/writes?id=${encodeURIComponent(env.sessionId)}&clientMessageId=${encodeURIComponent(checkCmid)}`
    )
    expect(read.status === 200 && read.body?.status === 'accepted', `answered ${read.status}: ${brief(read.body)}`)
    return 'accepted'
  })
  await step('the push channel through the relay: welcome, then subscribed', async () => {
    const socket = pushSocket(
      `ws://127.0.0.1:${RELAY_PORT}/m/${env.machineId}/push`,
      new URL(RELAY_URL).origin
    )
    try {
      await socket.opened
      socket.send({ _tag: 'hello', token: deviceSession.token, client: 'fixture-check' })
      const welcome = await socket.nextOf('welcome')
      socket.send({ _tag: 'subscribe', sessionId: env.sessionId })
      const subscribed = await socket.nextOf('subscribed')
      expect(subscribed.sessionId === env.sessionId, `subscribed to ${subscribed.sessionId}`)
      return `welcome (protocol ${welcome.protocol ?? '?'}), subscribed ${subscribed.sessionId}`
    } finally {
      socket.ws.close()
    }
  })
  await step('the owner revokes the device; its next GET /sessions is refused', async () => {
    const revoked = await owner('POST', '/devices/revoke', { deviceId: deviceSession.deviceId })
    expect(
      revoked.status === 204 || revoked.status === 200,
      `POST /devices/revoke answered ${revoked.status}: ${brief(revoked.body)}`
    )
    let last = null
    const refused = await until(async () => {
      last = await device('GET', '/sessions')
      return last.status === 401
    }, 10_000)
    expect(refused, `GET /sessions answered ${last?.status} after the revocation`)
    return `revoke ${revoked.status}; GET /sessions 401`
  })
  return !failed
}

// ── Step 6: approve every phone that asks ───────────────────────────────────

async function approveForever(owner) {
  const seen = new Set()
  for (;;) {
    const read = await owner('GET', '/devices').catch(() => null)
    for (const pending of read?.body?.pending ?? []) {
      if (seen.has(pending.id)) continue
      seen.add(pending.id)
      const approved = await owner('POST', '/devices/approve', { pairingId: pending.id })
      if (approved.status === 200)
        say(
          `approved: ${pending.name} (${pending.platform}), device ${approved.body?.id}, pairing ${pending.id}`
        )
      else note(`approve of pairing ${pending.id} answered ${approved.status}`)
    }
    await sleep(2_000)
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(BUN)) throw new Error(`bun not found at ${BUN}`)
  for (const port of [SERVER_PORT, RELAY_PORT, ISSUER_PORT])
    if (await portBusy(port)) throw new Error(`port ${port} is in use on 127.0.0.1: stopping`)

  // A fresh run: the folder's own contents only.
  mkdirSync(TMPDIR, { recursive: true, mode: 0o700 })
  for (const entry of readdirSync(TMPDIR))
    rmSync(path.join(TMPDIR, entry), { recursive: true, force: true })

  provider = await startProviderOn(ISSUER_PORT)
  if (provider.issuer !== ISSUER_URL)
    throw new Error(`the provider's issuer is ${provider.issuer}, not ${ISSUER_URL}`)
  note(`issuer ${provider.issuer}`)

  const relayRun = await startRelay()
  note(`relay ${RELAY_URL}`)

  const daemon = await startDaemon()
  note(`server ${daemon.url} (server id ${daemon.serverId ?? '?'})`)
  writeFileSync(TOKEN_FILE, daemon.token, { mode: 0o600 })
  chmodSync(TOKEN_FILE, 0o600)
  const owner = client(daemon.url, daemon.token)

  const signed = await signOwnerIn(owner)
  note(`owner signed in as ${signed.account?.email ?? OWNER.email}`)

  const machine = await waitForMachine(relayRun)
  note(`machine ${machine.id} (${machine.name}) online on the relay`)

  const echo = await startEchoSession(daemon, owner)
  note(`session ${echo.sessionId} in workspace ${echo.workspace.id}, Echo replied to ${echo.nonce}`)

  const fixture = {
    serverUrl: daemon.url,
    relayUrl: RELAY_URL,
    issuerUrl: ISSUER_URL,
    machineId: machine.id,
    machineName: machine.name,
    workspaceId: echo.workspace.id,
    sessionId: echo.sessionId,
    nonce: echo.nonce,
    owner: { sub: OWNER.sub, email: OWNER.email },
    tokenFile: TOKEN_FILE
  }
  writeFileSync(FIXTURE_FILE, JSON.stringify(fixture, null, 2) + '\n', { mode: 0o600 })
  say(`CLAVE_FIXTURE_SERVER_URL=${fixture.serverUrl}`)
  say(`CLAVE_FIXTURE_RELAY_URL=${fixture.relayUrl}`)
  say(`CLAVE_FIXTURE_ISSUER_URL=${fixture.issuerUrl}`)
  say(`CLAVE_FIXTURE_TOKEN_FILE=${fixture.tokenFile}`)
  say(`CLAVE_FIXTURE_MACHINE_ID=${fixture.machineId}`)
  say(`CLAVE_FIXTURE_WORKSPACE_ID=${fixture.workspaceId}`)
  say(`CLAVE_FIXTURE_SESSION_ID=${fixture.sessionId}`)
  say(`CLAVE_FIXTURE_NONCE=${fixture.nonce}`)
  say(`fixture: ${FIXTURE_FILE}`)

  if (CHECK) {
    const ok = await runCheck({ ...fixture, serverToken: daemon.token })
    say(ok ? 'check: passed' : 'check: FAILED')
    return exitWith(ok ? 0 : 1)
  }

  for (const run of [relayRun, daemon])
    run.child.once('exit', (code, signal) => {
      if (stopping) return
      note(`a child exited (${code ?? signal}); stopping`)
      void exitWith(1)
    })
  if (APPROVE) {
    say('fixture: running; approving every phone that asks; Ctrl-C stops it')
    await approveForever(owner)
  } else {
    say('fixture: running; Ctrl-C stops it')
  }
}

main().catch((error) => {
  note(`error: ${error?.message ?? error}`)
  void exitWith(1)
})

