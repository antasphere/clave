/**
 * The Electron shell boots its server, or attaches to one (ADR 0003,
 * PRDCT-3154). Everything here is asserted through the server's own HTTP API,
 * the discovery file the app writes, what the OS says the main process
 * listens on, and what a spawned terminal sees in its environment; never
 * through a hook inside main.
 *
 * Four parts, and the first follows the suite's mode (CLAVE_E2E_SERVER):
 *
 *  1. The app launched the suite's way ends up on a server: the discovery
 *     file says so, the server answers, it lists THIS app by its pid, and it
 *     refuses a wrong token. The main process listens on exactly the MCP port
 *     and (in-process) the server's port. Attached: the server is the one the
 *     harness started. And a terminal the app spawns sees neither
 *     CLAVE_SERVER_URL nor CLAVE_SERVER_TOKEN: the token belongs to what is
 *     meant to call the server, never to a session or a helper by inheritance.
 *  2. Whatever the suite's mode, an app attached by CLAVE_SERVER_URL to a
 *     server of this spec's own registers on it, and deregisters on quit,
 *     leaving that server up.
 *  3. Attached to a url nothing answers, the app still opens, says the
 *     attach failed, names the url it was given, and listens on NO port but
 *     the MCP server's: no server of its own was started in its place, on
 *     any port.
 *  4. A quit that comes while the registration is still in flight (a proxy
 *     holds POST /clients for 3 s) still ends with the app deregistered: no
 *     ghost client stays on the server.
 *
 * What makes this spec able to fail, each proven by the round-1 verifier or
 * by the lane: drop the boot from main/index.ts and 1 goes red on every
 * line; fall back to in-process on a dead url, discovery file rewritten or
 * not, and 3 goes red on the ports; skip the registration and 1 and 2 go
 * red; stop checking the token in the stub and 1 goes red on the 401;
 * export the pair into main's process.env and 1 goes red on the terminal
 * probe only if the sessions inherit it (they do not today: that line pins
 * the claim, not the mechanism); quit without awaiting the boot and 4 goes
 * red.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  serverEndpoint,
  serverClient,
  serverMode,
  startE2eServer,
  freePorts,
  listeningPorts,
  mcpEndpoint,
  callMcp,
  callMcpIn,
  identityOf,
  until
} from './harness.mjs'
import { mkdirSync, existsSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'

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

/** The MCP server's port, once mcp-server.json is written. */
const mcpPort = (dir) =>
  until(() =>
    existsSync(path.join(dir, 'mcp-server.json')) ? Number(new URL(mcpEndpoint(dir)).port) : null
  )

const seed = (dir) => {
  seedWorkspaces(dir, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(dir, [ROOT])
}

/** The ports of the main process that are the DRIVER's, not the app's: the
 *  two debugging endpoints Playwright launches Electron with (`--inspect=0`,
 *  the Node inspector, and `--remote-debugging-port=0`, Chrome's), told apart
 *  by what answers there: `/json/version` with a `Protocol-Version`, which
 *  both speak and nothing of the app's does (the MCP server answers 404,
 *  the server 401). Everything else main listens on is the app's own and is
 *  what the ports checks are about. */
async function driverPorts(ports) {
  const out = []
  for (const port of ports) {
    const isDriver = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500)
    })
      .then(async (r) => r.ok && typeof (await r.json())?.['Protocol-Version'] === 'string')
      .catch(() => false)
    if (isDriver) out.push(port)
  }
  return out
}

/** What main serves, by the OS, minus the driver's ports. */
async function servedPorts(pid) {
  const all = listeningPorts(pid)
  const driver = await driverPorts(all)
  return { all, driver, served: all.filter((p) => !driver.includes(p)) }
}

/** A loopback proxy in front of `target` that holds `POST /clients` for
 *  `delayMs` and forwards everything else at once. */
function delayingProxy(target, { delayMs }) {
  const t = new URL(target)
  const server = http.createServer((req, res) => {
    const forward = () => {
      const up = http.request(
        {
          host: t.hostname,
          port: Number(t.port),
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: t.host }
        },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers)
          upRes.pipe(res)
        }
      )
      up.on('error', () => {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
      req.pipe(up)
    }
    if (req.method === 'POST' && req.url === '/clients') setTimeout(forward, delayMs)
    else forward()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((r) => {
            server.close(() => r())
            server.closeAllConnections()
          })
      })
    )
  })
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })

  // ── 1. The suite's way ──
  {
    const DIR = userDataDir('server-boot')
    seed(DIR)
    const { app, win, server } = await launchApp(DIR)
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

      // What the main process listens on, by the OS: the MCP port, plus the
      // server's own port when it runs in-process, and nothing else.
      const mcp = await mcpPort(DIR)
      const expected = [mcp, ...(MODE === 'in-process' ? [Number(new URL(disc.url).port)] : [])]
        .filter((p) => Number.isInteger(p))
        .sort((a, b) => a - b)
      const ports = await servedPorts(pid)
      t.check(
        MODE === 'in-process'
          ? 'main serves exactly the MCP port and the server port'
          : 'main serves exactly the MCP port (the server is another process)',
        JSON.stringify(ports.served) === JSON.stringify(expected),
        { ...ports, expected }
      )

      // A terminal the app spawns sees neither variable: the token is not
      // inherited by sessions, nor by anything else main starts.
      const id = await identityOf(win)
      const g = await callMcp(app, 'createGroup', { name: 'probe' })
      const s = await callMcp(app, 'openSession', {
        cwd: ROOT,
        mode: 'terminal',
        groupId: g.groupId,
        command: 'echo "PROBE url=[$CLAVE_SERVER_URL] tokenlen=[${#CLAVE_SERVER_TOKEN}] END"',
        autoRun: true
      })
      const probe = await until(
        async () => {
          const read = await callMcpIn(app, id.windowId, 'readSession', {
            sessionId: s.sessionId,
            lines: 80,
            callerSessionId: s.sessionId
          })
          const text = typeof read === 'string' ? read : JSON.stringify(read)
          const m = /PROBE url=\[([^\]]*)\] tokenlen=\[(\d*)\] END/.exec(text)
          return m ? { url: m[1], tokenLen: Number(m[2]) } : null
        },
        { tries: 60, gapMs: 500 }
      )
      t.check('a spawned terminal printed the probe line', !!probe, probe)
      t.equal('and saw no CLAVE_SERVER_URL', probe?.url, '')
      t.equal('and no CLAVE_SERVER_TOKEN', probe?.tokenLen, 0)
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
      const pid = app.process().pid
      t.check('the app still opened a window', app.windows().length >= 1, app.windows().length)
      const disc = await decided(DIR)
      t.equal('the discovery file says the attach failed', disc?.ok, false)
      t.equal('names the url it was given', disc?.url, dead)
      t.equal('as attached, not in-process', disc?.mode, 'attached')
      t.check('and says nothing answers there', /nothing answers/.test(disc?.error ?? ''), disc)
      t.equal('no token is left in the file', disc?.token, null)
      const mcp = await mcpPort(DIR)
      const ports = await servedPorts(pid)
      t.check(
        'main serves the MCP port only: no server of its own took the place of the one asked for',
        JSON.stringify(ports.served) === JSON.stringify([mcp]),
        { ...ports, mcp }
      )
    } finally {
      await app.close()
    }
  }

  // ── 4. A quit while the registration is still in flight ──
  {
    const own = await startE2eServer('server-boot-slow')
    const proxy = await delayingProxy(own.url, { delayMs: 3000 })
    try {
      const DIR = userDataDir('server-boot-quit-race')
      seed(DIR)
      const client = serverClient(own.url, own.token)
      const { app } = await launchApp(DIR, {
        server: { url: proxy.url, token: own.token },
        settleMs: 300
      })
      const pid = app.process().pid
      t.check(
        'the registration had not landed when the quit came',
        !(await client.clients()).body?.some?.((c) => c.pid === pid)
      )
      // Quit the way the user does (Cmd+Q: `app.quit()`, the before-quit
      // ladder, the process ending on its own), and wait for the process to
      // be gone. The driver's own `close()` tears the process down on its
      // schedule, which can land before the quit cleanup finishes and would
      // make this pin measure the driver, not the app.
      const exited = new Promise((resolve) => app.process().once('exit', () => resolve(true)))
      await app.evaluate(({ app: electronApp }) => electronApp.quit())
      t.check(
        'the app quit on its own within 15 s',
        (await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 15_000))])) ===
          true
      )
      const clean = await until(
        async () => {
          const list = (await client.clients()).body ?? []
          return list.some((c) => c.pid === pid) ? null : true
        },
        { tries: 40, gapMs: 250 }
      )
      t.check('and the app still left no ghost client on the server', clean === true, {
        clients: (await client.clients()).body
      })
      await app.close().catch(() => {})
    } finally {
      await proxy.close()
      await own.stop()
    }
  }
}
