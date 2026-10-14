/**
 * The Electron shell boots its server, or attaches to one (ADR 0003,
 * PRDCT-3154). Everything here is asserted through the server's own HTTP API,
 * the discovery file the app writes, what the OS says the main process
 * listens on, and what a spawned terminal sees in its environment; never
 * through a hook inside main.
 *
 * Six parts, and the first follows the suite's mode (CLAVE_E2E_SERVER):
 *
 *  1. The app launched the suite's way ends up on a server: the discovery
 *     file says so, the server answers, it lists THIS app by its pid, and it
 *     refuses a wrong token. The main process listens on exactly the MCP port
 *     and (in-process) the server's port. Attached: the server is the one the
 *     harness started, and the windows are told its address in both modes
 *     (wave 2: the sessions live on the server; wave 3: the standalone
 *     server runs the app's own session host, so a renderer-routed list
 *     answers attached as in-process). In both modes a terminal the app's
 *     agent tools spawn (on main's own host until lane D moves the tools to
 *     the server) sees neither CLAVE_SERVER_URL nor CLAVE_SERVER_TOKEN: the
 *     token belongs to what is meant to call the server, never to a session
 *     or a helper by inheritance.
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
 *  6. In separate mode, the server child SIGKILLed under the running app:
 *     the discovery file turns `ok: false` with the exit named, its token
 *     out and the dead pid kept, the terminal process follows its parent,
 *     the window stays, and the quit stays inside the bound.
 *  5. Whatever the suite's mode, an app launched with `--server=separate`
 *     (wave 5, PRDCT-3434) starts its server as a child of its own and the
 *     terminal process as a child of the server, from the bundles it
 *     carries, under its own binary as Node; a terminal runs on it; the
 *     terminal process killed under the running app is started again (a
 *     new pid, generation 2, readiness true again), the terminal it held
 *     ends, and a new terminal runs on the new process; the quit leaves
 *     neither process behind. In separate mode part 1 adds: the harness
 *     started no server, the discovery names the child by its pid, and a
 *     spawned terminal sees no ELECTRON_RUN_AS_NODE either.
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
  serverFixture,
  serverMode,
  separateServerDataDir,
  startE2eServer,
  freePorts,
  listeningPorts,
  mcpEndpoint,
  callMcp,
  callMcpIn,
  identityOf,
  until,
  CHILD_CALL_TIMEOUT_MS,
  CLOSE_TIMEOUT_MS
} from './harness.mjs'
import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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

/** Whether a pid is alive, by the OS. */
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The parent pid of `pid`, by the OS, or null when it is gone. */
const ppidOf = (pid) => {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: CHILD_CALL_TIMEOUT_MS
    }).trim()
    return out ? Number(out) : null
  } catch {
    return null
  }
}

const untilDead = (pid, { tries = 40, gapMs = 250 } = {}) =>
  until(() => (alive(pid) ? null : true), { tries, gapMs })

/** What a separate server the app started says of itself and of its
 *  terminal process, read off its own `clave-server.json`. */
const separateServerDiscovery = (dir) => {
  try {
    return JSON.parse(
      readFileSync(path.join(separateServerDataDir(dir), 'clave-server.json'), 'utf-8')
    )
  } catch {
    return null
  }
}

/** The server's readiness, through its own API. */
const readiness = async (url) => (await fetch(`${url}/health/ready`)).json()

/** Open a terminal through the agent tools that prints `marker` and waits,
 *  and resolve once the marker is on its screen (null when it never is). */
async function terminalPrinting(app, win, groupId, marker) {
  const id = await identityOf(win)
  const s = await callMcp(app, 'openSession', {
    cwd: ROOT,
    mode: 'terminal',
    groupId,
    command: `echo "${marker} $$ END"; sleep 300`,
    autoRun: true
  })
  const seen = await until(
    async () => {
      const read = await callMcpIn(app, id.windowId, 'readSession', {
        sessionId: s.sessionId,
        lines: 80,
        callerSessionId: s.sessionId
      })
      const text = typeof read === 'string' ? read : JSON.stringify(read)
      return new RegExp(`${marker} \\d+ END`).test(text) ? true : null
    },
    { tries: 60, gapMs: 500 }
  )
  return { sessionId: s.sessionId, seen }
}

/** What the main process serves, told by what each listening port ANSWERS:
 *  a Clave server answers `/health/live` 200 `{ status: "live" }` with no
 *  token, the MCP server answers `/health` 200 with `{ app: "clave" }`. The
 *  driver's two debugging endpoints (`--inspect=0`, `--remote-debugging-port=0`)
 *  answer neither (a 400 or a 404, or they hang), so they never count, and
 *  a server started "in place of" one that could not be reached would
 *  answer the live probe on its own port and show up here. Positive
 *  identification, so a debugging endpoint that stops answering (Chrome's
 *  did, mid-lane) cannot turn the check red for the wrong reason. */
async function appPorts(pid) {
  const all = listeningPorts(pid)
  const answers = async (port, p, want) => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(5000) })
      if (r.status !== 200) return false
      const body = await r.json().catch(() => null)
      return want(body)
    } catch {
      return false
    }
  }
  const servers = []
  const mcp = []
  for (const port of all) {
    if (await answers(port, '/health/live', (b) => b?.status === 'live')) servers.push(port)
    else if (await answers(port, '/health', (b) => b?.app === 'clave')) mcp.push(port)
  }
  return { all, servers, mcp }
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
      } else if (MODE === 'separate') {
        t.check('separate: the harness started no server', server === null, server)
        t.check(
          'separate: the discovery names the child server by its pid',
          Number.isInteger(disc?.serverPid) && disc.serverPid !== pid,
          { serverPid: disc?.serverPid, pid }
        )
        t.equal('and that child is a child of the app', ppidOf(disc?.serverPid), pid)
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

      // What the main process serves, by the OS and by what answers: the MCP
      // server, plus exactly one Clave server when it runs in-process, none
      // when attached (the server is another process), and never a second.
      const mcp = await mcpPort(DIR)
      const ports = await appPorts(pid)
      t.check('main serves the MCP server on its port', ports.mcp.includes(mcp), { ...ports, mcp })
      if (MODE === 'in-process') {
        t.check(
          'main serves exactly one Clave server, on the published port',
          JSON.stringify(ports.servers) === JSON.stringify([Number(new URL(disc.url).port)]),
          { ...ports, published: disc.url }
        )
      } else {
        t.check(
          'main serves no Clave server of its own (the server is another process)',
          ports.servers.length === 0,
          ports
        )
      }

      // What main tells the windows on the contract's channel: the published
      // url and token, the same as the file's, in BOTH modes since wave 2
      // (the sessions live on the server, so an attached window asks the
      // attached server, which says what it cannot do). The handler is lane
      // A's; it is read the way `spyPtySpawn` reads main's invoke handlers,
      // and fails loudly if that map moves.
      const published = await app.evaluate(({ ipcMain }) => {
        const handlers = ipcMain._invokeHandlers
        const handler =
          handlers && typeof handlers.get === 'function' && handlers.get('server:endpoint')
        if (!handler)
          return { error: 'no server:endpoint handler, or ipcMain._invokeHandlers moved' }
        return handler({})
      })
      // Masked: a failing check must not print the token into the run's log
      // (CI's included).
      t.check(
        `server:endpoint answers the windows the ${MODE} server's url and token`,
        published && published.url === disc.url && published.token === disc.token,
        { published: published && { ...published, token: published.token ? '<set>' : null } }
      )
      // A renderer-routed call reaches the server through the preload's Node
      // side (no page origin, no CSP, no preflight; the round-2 blocker of
      // wave 1): in-process it lists the sessions, and attached too since the
      // standalone server runs the app's own session host (wave 3, lane C;
      // server-sessions-attached.spec.mjs proves a terminal there).
      const routed = await win.evaluate(() =>
        window.electronAPI.sessionsList().then(
          (sessions) => ({ ok: true, count: Array.isArray(sessions) ? sessions.length : -1 }),
          (error) => ({ ok: false, error: String(error && error.message ? error.message : error) })
        )
      )
      t.check(
        `${MODE}: a renderer-routed sessionsList() succeeds over the server`,
        routed.ok === true && routed.count >= 0,
        routed
      )

      // A terminal the app spawns sees none of the three variables. What
      // this proves, exactly: the environment of a tmux session on the
      // shared `clave` socket, which tmux gives the SERVER's environment
      // plus `update-environment`, so a variable the spawning process holds
      // never reaches it this way (the round-1 verifier of wave 5 rebuilt
      // the entry without its deletion and watched this line stay green).
      // The claim about the process itself is proven below, in separate
      // mode, through the server child's own evaluate route.
      const id = await identityOf(win)
      const g = await callMcp(app, 'createGroup', { name: 'probe' })
      {
        const s = await callMcp(app, 'openSession', {
          cwd: ROOT,
          mode: 'terminal',
          groupId: g.groupId,
          command:
            'echo "PROBE url=[$CLAVE_SERVER_URL] tokenlen=[${#CLAVE_SERVER_TOKEN}] asnode=[$ELECTRON_RUN_AS_NODE] END"',
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
            const m = /PROBE url=\[([^\]]*)\] tokenlen=\[(\d*)\] asnode=\[([^\]]*)\] END/.exec(text)
            return m ? { url: m[1], tokenLen: Number(m[2]), asNode: m[3] } : null
          },
          { tries: 60, gapMs: 500 }
        )
        t.check('a spawned terminal printed the probe line', !!probe, probe)
        t.equal('and saw no CLAVE_SERVER_URL', probe?.url, '')
        t.equal('and no CLAVE_SERVER_TOKEN', probe?.tokenLen, 0)
        // The variable that runs the app's binary as Node for its children
        // (wave 5) is taken out by each of them at boot: a session, whoever
        // spawned it, never sees it, or a Clave started from a Clave tab
        // would start as a bare Node process.
        t.equal('and no ELECTRON_RUN_AS_NODE', probe?.asNode, '')
      }
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
      const ports = await appPorts(pid)
      t.check('main still serves the MCP server', ports.mcp.includes(mcp), { ...ports, mcp })
      t.check(
        'and no Clave server of its own took the place of the one asked for, on any port',
        ports.servers.length === 0,
        ports
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
      // The launch must return BEFORE the registration lands (the proxy
      // holds it 3 s): the harness is told not to wait for the server's
      // discovery file, which is written by that very registration.
      const { app } = await launchApp(DIR, {
        server: { url: proxy.url, token: own.token },
        settleMs: 300,
        waitForServer: false
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

  // ── 5. The app's own separate server, whatever the suite runs (wave 5) ──
  {
    const DIR = userDataDir('server-boot-separate')
    seed(DIR)
    const { app, win, server } = await launchApp(DIR, { server: 'separate' })
    let closed = false
    try {
      const pid = app.process().pid
      t.check('separate: the harness started no server', server === null, server)
      const disc = await decided(DIR)
      t.equal('the app runs on a separate server', disc?.mode, 'separate')
      t.equal('and says it is usable', disc?.ok, true)
      const serverPid = disc?.serverPid
      t.check('the server is a child process of the app', ppidOf(serverPid) === pid, {
        serverPid,
        ppid: ppidOf(serverPid),
        pid
      })
      const serverDisc = await until(() => {
        const d = separateServerDiscovery(DIR)
        return d && d.terminalProcessPid ? d : null
      })
      t.check("the server's own discovery names its terminal process", !!serverDisc, serverDisc)
      t.equal('the server the app attached to is that child', disc?.url, serverDisc?.url)
      const firstTp = serverDisc?.terminalProcessPid
      t.equal('the terminal process is a child of the server', ppidOf(firstTp), serverPid)
      t.equal('generation 1', serverDisc?.terminalProcessGeneration, 1)
      t.check(
        'readiness answers true with the terminals check',
        (await readiness(disc.url)).ready === true,
        await readiness(disc.url)
      )
      // The child's own environment, read in its process through the
      // test-only route: the route exists only when the shell passed its
      // test flag on (the child's flags, unseen by any other check), and
      // the three variables are out of the environment the child's
      // sessions and login shell inherit (its deletion of the run-as-Node
      // variable, main's removal of the server pair).
      const childEnv = await serverFixture(disc.url, disc.token)
        .evaluate(() => ({
          asNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
          url: process.env.CLAVE_SERVER_URL ?? null,
          token: process.env.CLAVE_SERVER_TOKEN ?? null,
          testFlag: process.argv.includes('--test-no-activate')
        }))
        .catch((error) => ({ error: String(error && error.message ? error.message : error) }))
      t.check(
        "the shell's test flag reached the child (its evaluate route answers)",
        childEnv.testFlag === true,
        childEnv
      )
      t.equal('the child took ELECTRON_RUN_AS_NODE out of its environment', childEnv.asNode, null)
      t.equal('and holds no CLAVE_SERVER_URL', childEnv.url, null)
      t.equal('nor CLAVE_SERVER_TOKEN', childEnv.token, null)

      // A terminal on the pair as started, and the window listening for its
      // exit the way the pane does (`onSessionExit`, off the push channel on
      // a server in another process).
      const g = await callMcp(app, 'createGroup', { name: 'separate' })
      const first = await terminalPrinting(app, win, g.groupId, 'FIRST')
      t.check('a terminal started on the separate server runs', first.seen === true, first)
      await win.evaluate((sid) => {
        window.__e2eExits = []
        window.electronAPI.onSessionExit(sid, (code) => window.__e2eExits.push(code))
      }, first.sessionId)

      // The terminal process killed under the running app: started again.
      process.kill(firstTp, 'SIGKILL')
      const restarted = await until(
        () => {
          const d = separateServerDiscovery(DIR)
          return d && d.terminalProcessPid && d.terminalProcessPid !== firstTp ? d : null
        },
        { tries: 80, gapMs: 250 }
      )
      t.check(
        'a terminal process killed under the running app is started again, with a new pid',
        !!restarted,
        restarted ?? separateServerDiscovery(DIR)
      )
      t.equal('as generation 2', restarted?.terminalProcessGeneration, 2)
      t.check('the old pid is gone', !alive(firstTp), firstTp)
      t.equal(
        'the new process is a child of the server too',
        ppidOf(restarted?.terminalProcessPid),
        serverPid
      )
      const readyAgain = await until(
        async () => ((await readiness(disc.url)).ready ? true : null),
        {
          tries: 40,
          gapMs: 250
        }
      )
      t.check('readiness answers true again', readyAgain === true, await readiness(disc.url))
      // The terminal the old process held ended with its exit, said to the
      // window: the lost exit the port reports (code 1), heard by the
      // listener bound before the kill.
      const exits = await until(
        async () => {
          const seen = await win.evaluate(() => window.__e2eExits ?? [])
          return seen.length > 0 ? seen : null
        },
        { tries: 40, gapMs: 250 }
      )
      t.check('the terminal the old process held ended, its exit told to the window', !!exits, {
        sessionId: first.sessionId,
        exits
      })
      t.equal('with the lost exit code', exits?.[0], 1)
      // A new terminal runs on the new process.
      const second = await terminalPrinting(app, win, g.groupId, 'SECOND')
      t.check(
        'a terminal started after the restart runs on the new process',
        second.seen === true,
        second
      )

      // The quit stops both, inside the harness's bound, and stops them
      // ITSELF: the server is gone the instant the app's process is, and
      // the terminal process within a moment of it. The two parent polls
      // would end them too, 1.4 to 3.4 s later (measured), which a wait of
      // ten seconds here could not tell from the stops (the round-1
      // verifier skipped the child's stop and the handle's stop and this
      // part stayed green).
      const started = Date.now()
      await app.close()
      closed = true
      const closeMs = Date.now() - started
      t.check(
        'the server was gone when the app finished quitting (stopped, not polled)',
        !alive(serverPid),
        serverPid
      )
      t.check(
        'and its terminal process within half a second of it',
        (await untilDead(restarted?.terminalProcessPid, { tries: 5, gapMs: 100 })) === true,
        restarted?.terminalProcessPid
      )
      t.check(
        `the quit took less than the harness's ${CLOSE_TIMEOUT_MS} ms bound`,
        closeMs < CLOSE_TIMEOUT_MS,
        closeMs
      )
    } finally {
      if (!closed) await app.close()
    }
  }

  // ── 6. The server child dies while the app runs (separate) ──
  {
    const DIR = userDataDir('server-boot-child-dies')
    seed(DIR)
    const { app, win } = await launchApp(DIR, { server: 'separate' })
    let closed = false
    try {
      const disc = await decided(DIR)
      const serverPid = disc?.serverPid
      const serverDisc = await until(() => {
        const d = separateServerDiscovery(DIR)
        return d && d.terminalProcessPid ? d : null
      })
      const tp = serverDisc?.terminalProcessPid
      process.kill(serverPid, 'SIGKILL')
      // The app says so where a reader looks: the discovery file, no longer
      // a live-looking server, the dead pid kept for the record; the
      // terminal process follows its parent; the app itself runs on.
      const gone = await until(
        () => {
          const d = serverEndpoint(DIR)
          return d && d.ok === false ? d : null
        },
        { tries: 40, gapMs: 250 }
      )
      t.check('the discovery file says the server is gone', !!gone, serverEndpoint(DIR))
      t.check(
        'with the exit named',
        /exited \(SIGKILL\) while the app was running/.test(gone?.error ?? ''),
        gone?.error
      )
      t.equal('the token taken out', gone?.token, null)
      t.equal('the dead server pid kept for the record', gone?.serverPid, serverPid)
      t.check('the terminal process followed its parent', (await untilDead(tp)) === true, tp)
      t.check(
        'the window is still there',
        (await win.evaluate(() => document.readyState)) === 'complete'
      )
      const started = Date.now()
      await app.close()
      closed = true
      t.check(
        'a quit with the server already gone stays inside the bound',
        Date.now() - started < CLOSE_TIMEOUT_MS,
        Date.now() - started
      )
    } finally {
      if (!closed) await app.close()
    }
  }
}
