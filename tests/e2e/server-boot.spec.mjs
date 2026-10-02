/**
 * The Electron shell boots its server, or attaches to one (ADR 0003,
 * PRDCT-3154). Everything here is asserted through the server's own HTTP API
 * and the discovery file the app writes, never through a hook inside main.
 *
 * Three parts, and the first follows the suite's mode (CLAVE_E2E_SERVER):
 *
 *  1. The app launched the suite's way ends up on a server: the discovery
 *     file says so, the server answers, it lists THIS app by its pid, and it
 *     refuses a wrong token. Attached: the server is the one the harness
 *     started.
 *  2. Whatever the suite's mode, an app attached by CLAVE_SERVER_URL to a
 *     server of this spec's own registers on it, and deregisters on quit,
 *     leaving that server up.
 *  3. Attached to a url nothing answers, the app still opens, says the
 *     attach failed, names the url it was given, and starts NO server of
 *     its own in its place: a misconfigured attach is visible, never papered
 *     over.
 *
 * What makes this spec able to fail: drop the boot from main/index.ts and 1
 * goes red on every line; fall back to in-process on a dead url and 3 goes
 * red; skip the registration and 1 and 2 go red; stop checking the token in
 * the stub and 1 goes red on the 401.
 */
import {
  launchApp,
  seedWorkspaces,
  userDataDir,
  fixturePath,
  serverEndpoint,
  serverClient,
  serverMode,
  startE2eServer,
  freePorts,
  until
} from './harness.mjs'
import { mkdirSync } from 'node:fs'

const MODE = serverMode()
const ROOT = fixturePath('root-server-boot')
const WS = {
  id: 'eeeeeeee-0000-4000-8000-00000000000e',
  name: 'ServerBoot',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

/** The discovery file once the app has decided (ok true or false). */
const decided = (dir) =>
  until(() => {
    const d = serverEndpoint(dir)
    return d && typeof d.ok === 'boolean' ? d : null
  })

const seed = (dir) =>
  seedWorkspaces(dir, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })

  // ── 1. The suite's way ──
  {
    const DIR = userDataDir('server-boot')
    seed(DIR)
    const { app, server } = await launchApp(DIR)
    try {
      const pid = app.process().pid
      const disc = await decided(DIR)
      t.check('the app wrote clave-server.json', !!disc, disc)
      t.equal('and it says the server is usable', disc?.ok, true)
      t.equal(`the mode is the suite's (${MODE})`, disc?.mode, MODE)
      t.check(
        'the server is on the loopback',
        disc && new URL(disc.url).hostname === '127.0.0.1',
        disc?.url
      )
      if (MODE === 'attached') {
        t.equal('attached: it is the server the harness started', disc?.url, server?.url)
      } else {
        t.check('in-process: the harness started no server', server === null, server)
      }
      const client = serverClient(disc.url, disc.token)
      t.equal('/health/live answers', (await client.live()).status, 200)
      const listed = await client.clients()
      t.equal('the client list answers with the token', listed.status, 200)
      const mine = listed.body?.find?.((c) => c.kind === 'shell' && c.pid === pid)
      t.check('and lists this app by its pid', !!mine, { pid, listed })
      t.equal('the id in the file is the id the server gave', disc?.clientId, mine?.id)
      t.equal(
        'a wrong token is refused',
        (await serverClient(disc.url, 'wrong').clients()).status,
        401
      )
      t.equal('and no token at all', (await serverClient(disc.url, null).clients()).status, 401)
    } finally {
      await app.close()
    }
  }

  // ── 2. Attached to a server of this spec's own, whatever the suite runs ──
  {
    const own = await startE2eServer('server-boot-explicit')
    try {
      const DIR = userDataDir('server-boot-attached')
      seed(DIR)
      const client = serverClient(own.url, own.token)
      const before = await client.clients()
      t.equal('the server starts with no client', before.body?.length, 0)
      const { app } = await launchApp(DIR, { server: { url: own.url, token: own.token } })
      const pid = app.process().pid
      let closed = false
      try {
        const seen = await until(async () =>
          (await client.clients()).body?.find?.((c) => c.pid === pid)
        )
        t.check('an app attached by CLAVE_SERVER_URL registers on that server', !!seen, { pid })
        const disc = await decided(DIR)
        t.equal('its discovery file names that server', disc?.url, own.url)
        t.equal('and the mode is attached', disc?.mode, 'attached')
        await app.close()
        closed = true
        const gone = await until(async () => {
          const list = (await client.clients()).body ?? []
          return list.some((c) => c.pid === pid) ? null : true
        })
        t.check('on quit the app deregisters', gone === true)
        t.equal('and the server it was attached to is still up', (await client.live()).status, 200)
      } finally {
        if (!closed) await app.close()
      }
    } finally {
      await own.stop()
    }
  }

  // ── 3. Attached to a url nothing answers ──
  {
    const [port] = await freePorts(1)
    const dead = `http://127.0.0.1:${port}`
    const DIR = userDataDir('server-boot-dead')
    seed(DIR)
    const { app } = await launchApp(DIR, { server: { url: dead, token: 'irrelevant' } })
    try {
      t.check('the app still opened a window', app.windows().length >= 1, app.windows().length)
      const disc = await decided(DIR)
      t.equal('the discovery file says the attach failed', disc?.ok, false)
      t.equal('names the url it was given', disc?.url, dead)
      t.equal('as attached, not in-process', disc?.mode, 'attached')
      t.check('and says nothing answers there', /nothing answers/.test(disc?.error ?? ''), disc)
      t.equal('no token is left in the file', disc?.token, null)
      const answers = await fetch(`${dead}/health/live`).then(
        () => true,
        () => false
      )
      t.check('and no server of its own was started in its place', answers === false)
    } finally {
      await app.close()
    }
  }
}
