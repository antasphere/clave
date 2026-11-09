#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by node */
// The isolated stack the native iPhone app is tested against, on this Mac
// and nowhere else: a local OpenID Connect provider (tests/e2e/fixtures/
// oidc-provider.mjs, which approves on sight), this checkout's relay
// (apps/relay) pointed at that provider, and this checkout's standalone
// server as a daemon with the Echo adapter (a chat that repeats what it is
// told; no real agent provider ever runs), pointed at the provider and at the
// relay. The owner signs in, the server claims its machine on the relay, one
// Echo chat is seeded with a nonce, and the facts land in <tmpdir>/stack.json.
// Everything listens on 127.0.0.1.
//
//   node apps/mobile-ios/scripts/fixture-stack.mjs [--server 47101] [--relay 47102]
//        [--tmpdir /private/tmp/clave-native-a/stack] [--approve]
//        [--self-check | --once]
//
// --approve approves every pending pairing as the owner (GET /devices every
// second). --self-check proves the relay road end to end, prints PASS/FAIL
// lines and exits. --once brings the stack up, prints it and tears it down.
// Otherwise the stack runs until SIGINT/SIGTERM. The server's bearer token is
// written to <tmpdir>/owner-token (mode 0600) and nowhere else: never to
// stdout, stack.json or a log. Children's output goes to <tmpdir>/logs/.
//
// Import `startStack(options)` to drive the stack from another script.
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startOidcProvider } from '../../../tests/e2e/fixtures/oidc-provider.mjs'
import { call, ensureWorkspace } from '../../mobile/scripts/dev-server.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, '..', '..', '..')
const BUN = path.join(REPO, 'node_modules', '.bin', 'bun')
const STEP_MS = 30_000

export const DEFAULTS = {
  serverPort: 47101,
  relayPort: 47102,
  tmpdir: '/private/tmp/clave-native-a/stack'
}

const OWNER = {
  sub: 'fixture-owner',
  name: 'Fixture Owner',
  email: 'owner@fixture.test',
  email_verified: true
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Polls `probe` until it answers something truthy, or throws past `ms`. */
async function until(what, probe, { ms = STEP_MS, gapMs = 250 } = {}) {
  const deadline = Date.now() + ms
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (err) {
      lastError = err
    }
    await sleep(gapMs)
  }
  throw new Error(
    `${what}: not within ${ms / 1000} s${lastError ? ` (last error: ${lastError.message})` : ''}`
  )
}

/** A child process whose output goes to <logs>/<name>.log, the last lines
 *  of stderr kept for a failure, and every given secret redacted. */
function startChild(name, cmd, args, { env, logsDir, secrets }) {
  const file = createWriteStream(path.join(logsDir, `${name}.log`), { flags: 'a' })
  const child = spawn(cmd, args, {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const tail = []
  const redact = (text) => {
    let out = text
    for (const s of secrets) if (s) out = out.split(s).join('<redacted>')
    return out
  }
  let stdoutBuffer = ''
  const stdoutLines = []
  const lineWaiters = []
  child.stdout.on('data', (d) => {
    const text = String(d)
    file.write(redact(text))
    stdoutBuffer += text
    let nl
    while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, nl)
      stdoutBuffer = stdoutBuffer.slice(nl + 1)
      stdoutLines.push(line)
      for (const w of lineWaiters.splice(0)) w()
    }
  })
  child.stderr.on('data', (d) => {
    const text = redact(String(d))
    file.write(text)
    for (const line of text.split('\n')) if (line.trim()) tail.push(line)
    if (tail.length > 20) tail.splice(0, tail.length - 20)
  })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  return {
    name,
    child,
    stdoutLines,
    tail: () => tail.slice(-12).join('\n'),
    alive: () => child.exitCode === null && child.signalCode === null,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const hard = setTimeout(() => child.kill('SIGKILL'), 8_000)
        child.kill('SIGTERM')
        await exited
        clearTimeout(hard)
      }
      await new Promise((r) => file.end(r))
    }
  }
}

/** What a failed step says: the error, and the child's last stderr lines. */
function fail(step, err, child) {
  const detail = child ? `\n--- last lines of ${child.name}'s stderr ---\n${child.tail()}` : ''
  const error = new Error(`${step} failed: ${err.message}${detail}`)
  error.fixtureStep = step
  return error
}

async function readJson(url, bearer) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${bearer}` } })
  const text = await res.text()
  if (!res.ok)
    throw new Error(`GET ${new URL(url).pathname} answered ${res.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

const itemsHolding = (page, text) =>
  (page?.items ?? []).filter((item) => JSON.stringify(item).includes(text))

/** The Echo adapter's answer: an assistant text repeating `text`. */
const echoReplyOf = (page, text) =>
  (page?.items ?? []).find(
    (item) => item.event?.type === 'assistant_text' && String(item.event.delta).includes(text)
  )

/**
 * Brings the whole stack up. Resolves the facts (the same as stack.json)
 * with `stop()` (server, relay, provider, in that order) and `selfCheck()`.
 * On any failure everything started so far is stopped and the error thrown
 * names the step and the child's last stderr lines.
 */
export async function startStack({
  serverPort = DEFAULTS.serverPort,
  relayPort = DEFAULTS.relayPort,
  tmpdir = DEFAULTS.tmpdir,
  approve = false,
  log = (line) => process.stdout.write(`fixture-stack: ${line}\n`)
} = {}) {
  const startedAt = Date.now()
  rmSync(tmpdir, { recursive: true, force: true })
  const logsDir = path.join(tmpdir, 'logs')
  const serverDir = path.join(tmpdir, 'server')
  const relayDir = path.join(tmpdir, 'relay')
  const scratch = path.join(tmpdir, 'scratch')
  for (const dir of [tmpdir, logsDir, serverDir, relayDir, scratch])
    mkdirSync(dir, { recursive: true, mode: 0o700 })

  const secrets = []
  let provider = null
  let relay = null
  let server = null
  let approver = null
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    if (approver) approver.stop()
    if (server) await server.stop()
    if (relay) await relay.stop()
    if (provider) await provider.close()
  }

  try {
    // 1. The provider.
    try {
      provider = await startOidcProvider({ registrationStatus: 200, user: OWNER })
    } catch (err) {
      throw fail('start the provider', err)
    }
    log(`provider up at ${provider.issuer} (port ${provider.port})`)

    // 2. The relay, trusting that provider.
    relay = startChild(
      'relay',
      BUN,
      [
        path.join(REPO, 'apps', 'relay', 'src', 'main.ts'),
        '--port',
        String(relayPort),
        '--data-dir',
        relayDir,
        '--issuer',
        provider.issuer
      ],
      { env: {}, logsDir, secrets }
    )
    let relayUrl
    try {
      relayUrl = await until('the relay announcing its url', () => {
        if (!relay.alive()) throw new Error(`the relay exited (${relay.child.exitCode})`)
        const line = relay.stdoutLines.find((l) => l.trim().startsWith('{'))
        return line ? JSON.parse(line).url : null
      })
    } catch (err) {
      throw fail('start the relay', err, relay)
    }
    log(`relay up at ${relayUrl}`)

    // 3. The server daemon, Echo on, pointed at the provider and the relay.
    server = startChild(
      'server',
      BUN,
      [
        path.join(REPO, 'apps', 'server', 'src', 'main.ts'),
        '--data-dir',
        serverDir,
        '--daemon',
        '--port',
        String(serverPort),
        '--dev-echo-adapter',
        '--relay',
        relayUrl
      ],
      {
        env: {
          CLAVE_ANTASPHERE_ISSUER: provider.issuer,
          CLAVE_KEYCHAIN_FILE: path.join(serverDir, 'keychain.json')
        },
        logsDir,
        secrets
      }
    )
    let discovery
    try {
      discovery = await until('the server announcing itself', () => {
        if (!server.alive()) throw new Error(`the server exited (${server.child.exitCode})`)
        const value = JSON.parse(readFileSync(path.join(serverDir, 'clave-server.json'), 'utf8'))
        return value.pid === server.child.pid && typeof value.token === 'string' ? value : null
      })
    } catch (err) {
      throw fail('start the server', err, server)
    }
    const token = discovery.token
    secrets.push(token)
    const serverUrl = discovery.url
    log(`server up at ${serverUrl} (serverId ${discovery.serverId})`)

    // 4. The scratch workspace.
    let workspace
    try {
      workspace = await ensureWorkspace(serverUrl, token, scratch, 'scratch')
    } catch (err) {
      throw fail('register the scratch workspace', err, server)
    }
    log(`workspace "scratch" registered (${workspace.id})`)

    // 5. The owner signs in on the server, the provider playing the browser.
    try {
      const signIn = await call(serverUrl, token, 'POST', '/accounts/antasphere/sign-in', {})
      if (!signIn?.handoff?.url)
        throw new Error(`the sign-in answered no handoff (phase ${signIn?.status?.phase})`)
      await provider.browse(signIn.handoff.url)
      await until('the account reaching signed-in', async () => {
        const status = await call(serverUrl, token, 'GET', '/accounts/antasphere')
        return status?.phase === 'signed-in'
      })
    } catch (err) {
      throw fail('sign the owner in', err, server)
    }
    log(`owner ${OWNER.email} signed in`)

    // 6. The machine online on the relay, for the owner.
    const ownerBearer = provider.mintAccessToken({ sub: OWNER.sub })
    secrets.push(ownerBearer)
    let machine
    try {
      machine = await until('the machine online on the relay', async () => {
        const body = await readJson(`${relayUrl}/machines`, ownerBearer)
        const machines = body?.machines ?? []
        return machines.length === 1 && machines[0].online === true ? machines[0] : null
      })
    } catch (err) {
      throw fail('bring the machine online', err, server)
    }
    log(`machine ${machine.id} online on the relay ("${machine.name}", ${machine.platform})`)

    // 7. One Echo chat, seeded with a nonce.
    const nonce = `seeded-${randomBytes(4).toString('hex')}`
    let session
    try {
      session = await call(serverUrl, token, 'POST', '/sessions/start', {
        cwd: scratch,
        options: {
          claudeMode: true,
          launchProfileId: 'dev-echo-adapter',
          workspaceId: workspace.id
        }
      })
      await call(serverUrl, token, 'POST', '/sessions/write', {
        id: session.id,
        input: { type: 'user_message', text: nonce, clientMessageId: `m-seed-${nonce}` }
      })
      await until('the Echo reply to the nonce in the timeline', async () => {
        const page = await call(
          serverUrl,
          token,
          'GET',
          `/sessions/timeline?id=${encodeURIComponent(session.id)}`
        )
        return echoReplyOf(page, nonce)
      })
    } catch (err) {
      throw fail('seed the Echo chat', err, server)
    }
    log(`Echo chat ${session.id} seeded with ${nonce}`)

    // 8. The facts: the token to its own 0600 file, never anywhere else.
    const tokenFile = path.join(tmpdir, 'owner-token')
    writeFileSync(tokenFile, token, { mode: 0o600 })
    const facts = {
      issuer: provider.issuer,
      relay: relayUrl,
      server: serverUrl,
      serverId: discovery.serverId,
      machineId: machine.id,
      workspaceId: workspace.id,
      sessionId: session.id,
      nonce,
      scratch,
      tokenFile
    }
    writeFileSync(path.join(tmpdir, 'stack.json'), JSON.stringify(facts, null, 2) + '\n')

    if (approve) approver = startApprover({ serverUrl, token, log })

    const readyMs = Date.now() - startedAt
    log(`stack ready in ${(readyMs / 1000).toFixed(1)} s`)

    return {
      ...facts,
      readyMs,
      providerPort: provider.port,
      tmpdir,
      stop,
      selfCheck: () => selfCheck({ facts, token, log }),
      /** Resolves when the server or the relay exits on its own. */
      died: Promise.race([
        new Promise((r) => server.child.once('exit', () => r('server'))),
        new Promise((r) => relay.child.once('exit', () => r('relay')))
      ])
    }
  } catch (err) {
    await stop()
    throw err
  }
}

/** Approves every pending pairing, polling GET /devices every second. */
function startApprover({ serverUrl, token, log }) {
  let running = true
  const seen = new Set()
  ;(async () => {
    while (running) {
      try {
        const state = await call(serverUrl, token, 'GET', '/devices')
        for (const pending of state?.pending ?? []) {
          if (seen.has(pending.id)) continue
          seen.add(pending.id)
          try {
            await call(serverUrl, token, 'POST', '/devices/approve', { pairingId: pending.id })
            log(`approved pairing of "${pending.name}" (${pending.platform})`)
          } catch (err) {
            seen.delete(pending.id)
            log(`could not approve "${pending.name}": ${err.message}`)
          }
        }
      } catch (err) {
        if (running) log(`GET /devices failed: ${err.message}`)
      }
      await sleep(1000)
    }
  })()
  return {
    stop: () => {
      running = false
    }
  }
}

/** The end-to-end proof through the relay road. Resolves true on PASS. */
async function selfCheck({ facts, token, log }) {
  const road = `${facts.relay}/m/${facts.machineId}`
  const timeline = () =>
    readJson(`${road}/sessions/timeline?id=${encodeURIComponent(facts.sessionId)}`, token)
  let ok = true
  const report = (pass, what) => {
    process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${what}\n`)
    if (!pass) ok = false
  }

  try {
    const page = await timeline()
    report(
      itemsHolding(page, facts.nonce).length > 0,
      `the relay road reads the seeded chat's timeline holding ${facts.nonce} (${page.items?.length ?? 0} items)`
    )
  } catch (err) {
    report(false, `the relay road reads the seeded chat's timeline: ${err.message}`)
  }

  const text = `check-${randomBytes(4).toString('hex')}`
  try {
    const res = await fetch(`${road}/sessions/write`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: facts.sessionId,
        input: { type: 'user_message', text, clientMessageId: `m-check-${text}` }
      })
    })
    if (!res.ok)
      throw new Error(`the write answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const startedAt = Date.now()
    // The user's own message holds the text too; the proof is the assistant's.
    const reply = await until('the Echo reply', async () => echoReplyOf(await timeline(), text), {
      ms: 15_000,
      gapMs: 300
    })
    report(
      true,
      `a write through the relay road is answered by Echo (${reply.event.type} "${reply.event.delta}", sequence ${reply.position?.sequence}) in ${Date.now() - startedAt} ms`
    )
  } catch (err) {
    report(false, `a write through the relay road is answered by Echo: ${err.message}`)
  }
  log(ok ? 'self-check passed' : 'self-check failed')
  return ok
}

function parseArgs(argv) {
  const value = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
  }
  return {
    serverPort: Number(value('server', DEFAULTS.serverPort)),
    relayPort: Number(value('relay', DEFAULTS.relayPort)),
    tmpdir: path.resolve(value('tmpdir', DEFAULTS.tmpdir)),
    approve: argv.includes('--approve'),
    selfCheck: argv.includes('--self-check'),
    once: argv.includes('--once')
  }
}
export { parseArgs as parseStackArgs }

/** The stdout lines another tool reads. */
export function factLines(facts) {
  return [
    `CLAVE_FIXTURE_ISSUER_URL=${facts.issuer}`,
    `CLAVE_FIXTURE_RELAY_URL=${facts.relay}`,
    `CLAVE_FIXTURE_SERVER_URL=${facts.server}`,
    `CLAVE_FIXTURE_MACHINE_ID=${facts.machineId}`,
    `CLAVE_FIXTURE_WORKSPACE_ID=${facts.workspaceId}`,
    `CLAVE_FIXTURE_SESSION_ID=${facts.sessionId}`,
    `CLAVE_FIXTURE_NONCE=${facts.nonce}`,
    `CLAVE_FIXTURE_TOKEN_FILE=${facts.tokenFile}`
  ]
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const options = parseArgs(process.argv.slice(2))
  let stack = null
  let ending = false
  const end = async (code) => {
    if (ending) return
    ending = true
    if (stack) await stack.stop()
    process.stdout.write('fixture-stack: stopped\n')
    process.exit(code)
  }
  process.on('SIGINT', () => void end(0))
  process.on('SIGTERM', () => void end(0))
  try {
    stack = await startStack(options)
  } catch (err) {
    process.stderr.write(`fixture-stack: ${err.message}\n`)
    process.exit(1)
  }
  process.stdout.write(factLines(stack).join('\n') + '\n')
  process.stdout.write('fixture-stack: ready\n')
  if (options.selfCheck) {
    const ok = await stack.selfCheck()
    await end(ok ? 0 : 1)
  } else if (options.once) {
    await end(0)
  } else {
    const who = await stack.died
    process.stderr.write(`fixture-stack: the ${who} exited on its own; stopping\n`)
    await end(1)
  }
}
