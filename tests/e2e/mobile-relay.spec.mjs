// The relay (lane E of the mobile wave, decision 4 of the mobile spec)
// through the real app, with the server IN-PROCESS: the app signs in on a
// local OIDC provider through Settings → Accounts (the browser stood in by a
// fetch that follows the issuer's redirect, as antasphere-account.spec.mjs
// does), its server claims a machine credential from a relay this spec
// starts on 127.0.0.1 (the repository's Bun running the relay's own entry)
// and connects to it, and a client of the spec, holding the server's own
// token where a phone would hold its device session, reaches the server's
// sessions and its push channel through `<relay>/m/<machineId>/...`.
// Proven on the relay's own API and on the machine's answers, never through
// a hook inside main: the relay lists the Mac to its owner's bearer and to
// nobody else's, keeps the secret hashed, and lists the Mac offline once the
// app quits and online again, under the same id, once it relaunches.
// Nothing here reaches account.antasphere.com.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { WebSocket } from 'ws'
import {
  REPO,
  fixturePath,
  freePorts,
  launchApp,
  seedWorkspaces,
  serverEndpoint,
  until,
  userDataDir
} from './harness.mjs'
import { startOidcProvider } from './fixtures/oidc-provider.mjs'
import { bunBinary } from '../../scripts/server-process.mjs'

const DIR = userDataDir('mobile-relay')
const ROOT = fixturePath('mobile-relay-root')
const RELAY_DATA = fixturePath('mobile-relay-relay')
const WS = {
  id: 'mobile-relay-ws',
  name: 'Mobile relay',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const RELAY_FILE = path.join(DIR, 'relay.json')
const OWNER = {
  sub: 'e2e-owner',
  name: 'E2E Owner',
  email: 'owner@example.test',
  email_verified: true
}

/** The relay as its own process, the way the team runs it: the entry under
 *  the repository's Bun, announcing its url on stdout. The port is the
 *  band's when CLAVE_E2E_RELAY_PORT names one, a free one otherwise. */
async function startRelay(issuer) {
  const port = Number(process.env.CLAVE_E2E_RELAY_PORT) || (await freePorts())[0]
  const child = spawn(
    bunBinary(process.env, REPO),
    [
      path.join(REPO, 'packages/server/src/relay/main.ts'),
      '--port',
      String(port),
      '--data-dir',
      RELAY_DATA,
      '--issuer',
      issuer
    ],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += d
  })
  const url = await new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(
      () => reject(new Error(`the relay did not announce itself\n${stderr}`)),
      15_000
    )
    child.stdout.on('data', (d) => {
      out += d
      const nl = out.indexOf('\n')
      if (nl < 0) return
      clearTimeout(timer)
      try {
        resolve(JSON.parse(out.slice(0, nl)).url)
      } catch (err) {
        reject(err)
      }
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`the relay exited (${code ?? signal}) before announcing itself\n${stderr}`))
    })
  })
  return {
    url,
    port,
    stderr: () => stderr,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        const hard = setTimeout(() => child.kill('SIGKILL'), 5000)
        child.once('exit', () => {
          clearTimeout(hard)
          resolve()
        })
        child.kill('SIGTERM')
      })
  }
}

async function listMachines(relayUrl, bearer) {
  const res = await fetch(`${relayUrl}/machines`, {
    headers: { authorization: `Bearer ${bearer}` }
  })
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() }
}

/** The one machine the owner's bearer lists, once it is `online` (or not,
 *  when `online` is false), or null past the budget. */
function machineOf(relayUrl, bearer, online, tries = 80) {
  return until(
    async () => {
      const { body } = await listMachines(relayUrl, bearer)
      const machine = body?.machines?.[0]
      return machine && machine.online === online ? machine : null
    },
    { tries, gapMs: 250 }
  )
}

/** A phone's push socket through the relay: hello with the bearer, the
 *  welcome, a ping and its pong. */
function pushThroughRelay(road, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${road.replace(/^http/, 'ws')}/push`)
    const seen = {}
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error(`the push channel did not answer: ${JSON.stringify(seen)}`))
    }, 15_000)
    socket.on('open', () =>
      socket.send(JSON.stringify({ _tag: 'hello', token, client: 'e2e-phone' }))
    )
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString())
      seen[frame._tag] = frame
      if (frame._tag === 'welcome') socket.send(JSON.stringify({ _tag: 'ping' }))
      if (frame._tag === 'pong') {
        clearTimeout(timer)
        socket.close(1000, 'done')
        resolve(seen)
      }
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
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

async function openAccounts(win) {
  await win.click('.sidebar-footer-btn[aria-label="Settings"]')
  await win.click('[data-settings-nav-row="accounts"]')
  const page = win.locator('[data-settings-page="accounts"]')
  await page.waitFor()
  const section = page.locator('[data-antasphere-account]')
  await section.waitFor()
  return { page, section }
}

const phaseOf = (section) => section.getAttribute('data-antasphere-phase')
const waitPhase = (section, phase) =>
  until(async () => ((await phaseOf(section)) === phase ? phase : null))

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  rmSync(RELAY_DATA, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  const provider = await startOidcProvider({ registrationStatus: 200, user: OWNER })
  const relay = await startRelay(provider.issuer)
  // The preference Settings → Mobile writes (lane A's): the relay's address.
  writeFileSync(path.join(DIR, 'preferences.json'), JSON.stringify({ mobileRelayUrl: relay.url }))
  const env = { CLAVE_ANTASPHERE_ISSUER: provider.issuer }
  const errors = []
  // What main says of the relay client, kept beside the relay's data with the
  // relay's own stderr: the two sides of the road, for a failed check.
  const appLines = []
  const watchMain = (child) => {
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (d) => {
        for (const line of String(d).split('\n'))
          if (/mobile-relay|antasphere/.test(line)) appLines.push(line)
      })
    }
  }
  let { app, win } = await launchApp(DIR, { env, server: 'in-process' })
  watchMain(app.process())
  win.on('pageerror', (e) => errors.push(e.message))
  const diagnostics = () => ({
    app: appLines.slice(-12),
    relay: relay.stderr().split('\n').slice(-12)
  })
  try {
    const owner = provider.mintAccessToken({ sub: OWNER.sub })
    const stranger = provider.mintAccessToken({ sub: 'e2e-stranger' })

    // ── Before the login: nothing claimed, nothing listed ────────────────
    await new Promise((r) => setTimeout(r, 1500))
    const before = await listMachines(relay.url, owner)
    t.check(
      'before the login the relay lists no machine of the owner',
      before.status === 200 && before.body.machines.length === 0,
      before
    )
    t.check('and the server claimed no credential', !existsSync(RELAY_FILE))

    // ── The login, through Settings → Accounts ───────────────────────────
    const opened = await stubBrowser(app)
    const { section } = await openAccounts(win)
    await section.getByRole('button', { name: 'Sign in with Antasphere', exact: true }).click()
    const urls = await until(async () => {
      const u = await opened()
      return u.length ? u : null
    })
    await provider.browse(urls[0])
    t.equal('the app is signed in', await waitPhase(section, 'signed-in'), 'signed-in')

    // ── The server claims and connects ───────────────────────────────────
    const online = await machineOf(relay.url, owner, true)
    t.check('the relay lists the Mac online for its owner', online !== null, relay.stderr())
    if (!online) throw new Error('no machine online: ' + relay.stderr())
    t.check(
      'the record names this host, macOS, the app version and no direct address',
      online.platform === 'macos' &&
        /^\d+\.\d+\.\d+/.test(online.version) &&
        online.name.length > 0 &&
        online.direct.length === 0,
      online
    )
    const strangers = await listMachines(relay.url, stranger)
    t.check(
      'another Antasphere account lists no machine',
      strangers.status === 200 && strangers.body.machines.length === 0,
      strangers
    )
    const refused = await listMachines(relay.url, 'at-nonsense')
    t.equal('a made-up bearer is refused by the relay', refused.status, 401)
    const noBearer = await fetch(`${relay.url}/machines`)
    t.equal('and so is no bearer', noBearer.status, 401)
    t.check(
      'the machine credential is kept under the app’s data, owner-only, its secret sealed',
      existsSync(RELAY_FILE) &&
        (statSync(RELAY_FILE).mode & 0o777) === 0o600 &&
        !readFileSync(RELAY_FILE, 'utf8').includes('cms_'),
      existsSync(RELAY_FILE) ? readFileSync(RELAY_FILE, 'utf8').slice(0, 200) : 'no file'
    )
    const store = readFileSync(path.join(RELAY_DATA, 'machines.json'), 'utf8')
    t.check(
      'the relay keeps the secret hashed, with the owner and the machine id',
      !store.includes('cms_') && store.includes(OWNER.sub) && store.includes(online.id),
      store.slice(0, 300)
    )

    // ── The road: the server's own token stands in for a device session ──
    const endpoint = serverEndpoint(DIR)
    const road = `${relay.url}/m/${online.id}`
    const live = await fetch(`${road}/health/live`)
    t.equal('the machine answers its health probe through the relay', live.status, 200)
    const noToken = await fetch(`${road}/sessions?windowKey=w`)
    t.equal('the machine, not the relay, refuses a request without its bearer', noToken.status, 401)
    const sessions = await fetch(`${road}/sessions?windowKey=w`, {
      headers: { authorization: `Bearer ${endpoint.token}` }
    })
    t.equal('the sessions list answers through the relay', sessions.status, 200)
    const list = await sessions.json()
    t.check('as the list the server keeps', Array.isArray(list), list)
    const unknown = await fetch(`${relay.url}/m/m_0000000000000000/sessions`)
    t.equal('an unknown machine is 404 at the relay', unknown.status, 404)
    const frames = await pushThroughRelay(road, endpoint.token)
    t.check(
      'the push channel welcomes the client through the relay, with the server’s id',
      frames.welcome && typeof frames.welcome.serverId === 'string',
      frames
    )
    t.check('and answers a ping through it', frames.pong !== undefined, frames)

    // ── Signed out: the Mac leaves the relay; signed in again: it is back ─
    await section.locator('[data-antasphere-sign-out]').click()
    t.equal('sign out: signed out', await waitPhase(section, 'signed-out'), 'signed-out')
    const gone = await machineOf(relay.url, owner, false, 40)
    t.check('signed out, the relay lists the Mac offline', gone !== null && gone.id === online.id, {
      gone,
      ...diagnostics()
    })
    await section.getByRole('button', { name: 'Sign in with Antasphere', exact: true }).click()
    const urls2 = await until(async () => {
      const u = await opened()
      return u.length > urls.length ? u : null
    })
    await provider.browse(urls2.at(-1))
    t.equal('signed in again', await waitPhase(section, 'signed-in'), 'signed-in')
    const back = await machineOf(relay.url, owner, true, 60)
    t.check(
      'signed in again, the Mac is back online under the same machine id',
      back !== null && back.id === online.id,
      back
    )

    // ── Quit and relaunch ────────────────────────────────────────────────
    await app.close()
    const offline = await machineOf(relay.url, owner, false, 40)
    t.check(
      'after the app quits the relay lists the Mac offline, last seen kept',
      offline !== null && typeof offline.lastSeen === 'number',
      offline
    )
    ;({ app, win } = await launchApp(DIR, { env, server: 'in-process' }))
    watchMain(app.process())
    win.on('pageerror', (e) => errors.push(e.message))
    const again = await machineOf(relay.url, owner, true, 80)
    const machines = JSON.parse(readFileSync(path.join(RELAY_DATA, 'machines.json'), 'utf8'))
    t.check(
      'relaunched, the Mac comes back online under the same id, without a new claim',
      again !== null && again.id === online.id && machines.machines.length === 1,
      { again, known: machines.machines.length }
    )
    t.equal('no renderer errors', errors.length, 0, errors)
  } finally {
    await app.close()
    await relay.stop()
    await provider.close()
    writeFileSync(path.join(RELAY_DATA, 'app.log'), appLines.join('\n') + '\n')
    writeFileSync(path.join(RELAY_DATA, 'relay.stderr.log'), relay.stderr())
  }
}
