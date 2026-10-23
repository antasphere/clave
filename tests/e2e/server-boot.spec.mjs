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
 *     holds confirmation until released during quit) still ends with the app deregistered: no
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
 *     neither process behind; and the app's own documents were carried into
 *     the server's directory at that first boot (the migration of the second
 *     pull request). In separate mode part 1 adds: the harness
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
  launchApp as launchHarnessApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  serverEndpoint,
  serverClient,
  serverFixture,
  serverMode,
  separateServerDataDir,
  startE2eServer as startHarnessServer,
  freePorts,
  listeningPorts,
  mcpEndpoint,
  callMcp,
  callMcpIn,
  identityOf,
  until,
  CHILD_CALL_TIMEOUT_MS,
  CLOSE_TIMEOUT_MS,
  REPO
} from './harness.mjs'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// These boot fixtures never need a machine account or personal history. Keep
// the actual terminal shell, but opt out before the first renderer mounts.
const usageIsolation = () => {
  const root = fixturePath('server-boot-provider-homes')
  const env = {
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    CODEX_HOME: path.join(root, 'codex'),
    PI_CODING_AGENT_DIR: path.join(root, 'pi'),
    CLAVE_TRANSCRIPTS_ROOT: path.join(root, 'claude-transcripts'),
    CLAVE_CODEX_ROOT: path.join(root, 'codex-transcripts'),
    CLAVE_PI_ROOT: path.join(root, 'pi-transcripts')
  }
  for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true })
  return { ...env, CLAVE_KEYCHAIN_FILE: path.join(root, 'keychain.json') }
}
const isolatedOptions = (options = {}) => ({
  ...options,
  args: [...(options.args ?? []), '--test-no-activate', '--test-no-machine-usage'],
  env: { ...options.env, ...usageIsolation() }
})
const startE2eServer = async (name, options) => {
  const server = await startHarnessServer(name, isolatedOptions(options))
  const isolation = await serverFixture(server.url, server.token).evaluate(() => {
    const noActivate = process.argv.includes('--test-no-activate')
    const noMachineUsage = process.argv.includes('--test-no-machine-usage')
    return { noActivate, noMachineUsage, effectiveNoMachineUsage: noActivate && noMachineUsage }
  })
  if (!isolation.noActivate || !isolation.noMachineUsage || !isolation.effectiveNoMachineUsage) {
    await server.stop()
    throw new Error('server-boot standalone fixture did not disable machine usage before launch')
  }
  console.log('STANDALONE_USAGE_ISOLATION', JSON.stringify({ name, ...isolation }))
  return server
}
const launchApp = async (dir, options) => {
  const launched = await launchHarnessApp(dir, isolatedOptions(options))
  const optedOut = await launched.app.evaluate(
    () =>
      process.argv.includes('--test-no-activate') &&
      process.argv.includes('--test-no-machine-usage')
  )
  if (!optedOut) {
    await launched.app.close()
    throw new Error('server-boot fixture did not disable machine usage before launch')
  }
  return launched
}

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
    // The terminal retains the user's shell, which may be Nushell or Fish.
    // Interpret this POSIX fixture program explicitly. Its marker contains
    // no apostrophes, and the echoed command has $$ rather than output digits.
    command: `/bin/sh -c 'echo "${marker} $$ END"; sleep 300'`,
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
function delayingProxy(
  target,
  {
    delayMs = null,
    holdResponse = false,
    registrationPath = '/clients/registrations/v1/confirm'
  } = {}
) {
  const t = new URL(target)
  // Allowlisted causal receipts: never headers, tokens or request bodies.
  const receipts = []
  const record = (phase, req, detail = {}) => {
    receipts.push({ at: Date.now(), phase, method: req.method, path: req.url, ...detail })
  }
  // Held until `release()` (or 20 s, a ceiling for a spec that dies) when no
  // delay is given: a fixed clock let the registration land before the quit
  // whenever the app booted slower than it, on a loaded runner (CI on #175,
  // and rounds 2 and 3 of the verifier).
  const waiting = []
  let released = false
  // Each held registration's answer from the server, so a spec can wait for
  // it to have LANDED before it asks who is registered: a read before that
  // finds no client whatever the app did (the ghost check passed at its
  // first read with the quit's wait on the boot removed).
  const answered = []
  const hold = (fn) => {
    if (released) return fn()
    waiting.push(fn)
    setTimeout(() => {
      const i = waiting.indexOf(fn)
      if (i >= 0) waiting.splice(i, 1)[0]()
    }, 20_000)
  }
  const server = http.createServer((req, res) => {
    record('received', req)
    res.once('close', () => record('downstream-closed', req))
    // The body is read as it arrives and forwarded from this copy: a client
    // that dies while its request is held has already sent it whole, and the
    // server must still receive it (otherwise a quit that does not wait on
    // its registration looks clean here, which is the defect this proxy is
    // for).
    const chunks = []
    let ended = false
    let pendingForward = null
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      ended = true
      record('body-complete', req)
      if (pendingForward) pendingForward()
    })
    const forward = () => {
      if (!ended) {
        pendingForward = forward
        return
      }
      record('forwarded', req, { downstreamDestroyed: res.destroyed })
      const up = http.request(
        {
          host: t.hostname,
          port: Number(t.port),
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: t.host }
        },
        (upRes) => {
          record('upstream-response', req, { status: upRes.statusCode })
          // The server's answer is what "landed" means, whatever became of
          // the client that asked.
          upRes.once('end', () => {
            record('upstream-complete', req, { status: upRes.statusCode })
            req.landed?.()
          })
          if (holdResponse && req.url === registrationPath && req.method === 'POST') {
            const responseChunks = []
            upRes.on('data', (chunk) => responseChunks.push(chunk))
            upRes.once('end', () => {
              record('response-withheld', req)
              hold(() => {
                record('response-released', req, { downstreamDestroyed: res.destroyed })
                if (!res.destroyed) {
                  res.writeHead(upRes.statusCode ?? 502, upRes.headers)
                  res.end(Buffer.concat(responseChunks))
                }
              })
            })
            return
          }
          if (res.destroyed) return upRes.resume()
          res.writeHead(upRes.statusCode ?? 502, upRes.headers)
          upRes.pipe(res)
        }
      )
      up.on('error', () => {
        record('upstream-error', req)
        req.landed?.()
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
      up.end(Buffer.concat(chunks))
    }
    if (req.method === 'POST' && req.url === registrationPath) {
      let landed
      answered.push(new Promise((resolve) => (landed = resolve)))
      req.landed = () => landed()
      if (holdResponse) forward()
      else if (delayMs !== null) setTimeout(forward, delayMs)
      else hold(forward)
    } else forward()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        /** Let every held registration through, and any later one at once. */
        release: () => {
          released = true
          for (const fn of waiting.splice(0)) fn()
        },
        /** How many registrations are being held now. */
        held: () => waiting.length,
        /** Resolves once every registration seen so far has had its answer. */
        landed: () => Promise.all(answered),
        receipts: () => receipts.map((row) => ({ ...row })),
        close: () =>
          new Promise((r) => {
            server.close(() => r())
            server.closeAllConnections()
          })
      })
    )
  })
}

// Also exported for a focused causal run through the same assertion runner.
// Each named scenario controls request or response delivery around the shell's
// bounded registration call, using the actual public reservation protocol.
export async function runDelayedRegistrationAfterQuit(t, { scenario = 'reserve-after-exit' } = {}) {
  const modulePath = fixturePath('shell-client-lifecycle-fixture.mjs')
  await build({
    entryPoints: [path.join(REPO, 'tests/e2e/fixtures/shell-client-lifecycle.mjs')],
    outfile: modulePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
    }
  })
  const { loadShellClientLifecycle } = await import(pathToFileURL(modulePath).href)
  let own
  let proxy
  let app
  let client
  let removeOutputListeners = () => {}
  const receipt = { scenario: `shell-client/${scenario}`, events: [] }
  const record = (phase, detail = {}) => receipt.events.push({ at: Date.now(), phase, ...detail })
  try {
    const fixture = await loadShellClientLifecycle(
      async ({ runId, id }) => {
        receipt.runId = runId
        const root = fixturePath(`shell-client-${runId}`)
        const dir = path.join(root, 'install')
        const workspaceId = id('workspace')
        mkdirSync(root, { recursive: true })
        seedWorkspaces(dir, {
          workspaces: [{ ...WS, id: workspaceId, rootDir: root }],
          activeWorkspaceId: workspaceId,
          fresh: true
        })
        seedTrustedRoots(dir, [root])
        own = await startE2eServer(`shell-client-${runId}`)
        proxy = await delayingProxy(own.url, {
          holdResponse: scenario.endsWith('lost-response'),
          registrationPath:
            '/clients/registrations/v1/' + (scenario.startsWith('reserve-') ? 'reserve' : 'confirm')
        })
        client = serverClient(own.url, own.token)
        const launched = await launchApp(dir, {
          server: { url: proxy.url, token: own.token },
          settleMs: 300,
          waitForServer: false
        })
        app = launched.app
        const keepLifecycleLines = (chunk) => {
          for (const line of String(chunk).split(/\r?\n/)) {
            if (/\[server\] not available:|\[quit\]/.test(line))
              record('app-lifecycle-output', { line: line.slice(0, 1000) })
          }
        }
        const process = app.process()
        process.stdout?.on('data', keepLifecycleLines)
        process.stderr?.on('data', keepLifecycleLines)
        removeOutputListeners = () => {
          process.stdout?.off('data', keepLifecycleLines)
          process.stderr?.off('data', keepLifecycleLines)
        }
        receipt.appPid = process.pid
        return { dir }
      },
      async () => {
        const held = await until(() => (proxy.held() > 0 ? true : null), {
          tries: 80,
          gapMs: 250
        })
        if (!held) throw new Error('The isolated proxy never received the registration')
      },
      { delivery: scenario }
    )
    const { dir } = fixture.values.shell
    receipt.fixtureIds = fixture.ids
    receipt.beforeQuit = {
      held: proxy.held(),
      listed: (await client.clients()).body,
      decided: serverEndpoint(dir)?.ok ?? null
    }
    t.check(
      'causal fixture holds a registration before the shell has decided',
      receipt.beforeQuit.held > 0 &&
        receipt.beforeQuit.listed.length === (scenario === 'confirm-lost-response' ? 1 : 0) &&
        receipt.beforeQuit.decided === null,
      receipt.beforeQuit
    )
    const exited = new Promise((resolve) => {
      app.process().once('exit', (code) => {
        record('app-exit', { code })
        resolve(true)
      })
    })
    record('quit-requested')
    const quitting = app
      .evaluate(({ app: electronApp }) => electronApp.quit())
      .catch(() => undefined)
    if (scenario === 'during-quit') {
      await new Promise((resolve) => setTimeout(resolve, 300))
      record('registration-released-during-quit')
      proxy.release()
    }
    const didExit = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve(false), 15_000))
    ])
    t.check(
      'the shell quits within the existing 15 s bound with registration held',
      didExit === true
    )
    await quitting
    const discovery = serverEndpoint(dir)
    receipt.discoveryAfterQuit = discovery
      ? { ok: discovery.ok, clientId: discovery.clientId, error: discovery.error }
      : null
    receipt.beforeRelease = (await client.clients()).body
    if (scenario !== 'during-quit') record('registration-released-after-quit', { didExit })
    proxy.release()
    const landed = await Promise.race([
      proxy.landed().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 10_000))
    ])
    record('upstream-landed-barrier', { landed })
    t.check('the real upstream registration completed before the query', landed === true)
    receipt.afterUpstream = (await client.clients()).body
    receipt.proxy = proxy.receipts()
    const registrationResponse = receipt.proxy.find(
      (event) =>
        event.phase === 'upstream-complete' &&
        event.path ===
          '/clients/registrations/v1/' + (scenario.startsWith('reserve-') ? 'reserve' : 'confirm')
    )
    t.equal(
      'the held command has the expected upstream result',
      registrationResponse?.status,
      scenario === 'confirm-after-exit' ? 422 : 200
    )
    t.check(
      'the shell published the expected registration outcome',
      scenario === 'during-quit'
        ? receipt.discoveryAfterQuit?.ok === true &&
            typeof receipt.discoveryAfterQuit.clientId === 'string'
        : receipt.discoveryAfterQuit?.ok === false &&
            receipt.discoveryAfterQuit.clientId === null &&
            /registering with .* failed:/.test(receipt.discoveryAfterQuit.error ?? ''),
      receipt.discoveryAfterQuit
    )
    const clean = await until(
      async () => {
        const list = (await client.clients()).body ?? []
        return list.some((entry) => entry.pid === receipt.appPid) ? null : true
      },
      { tries: 40, gapMs: 250 }
    )
    receipt.afterQuit = (await client.clients()).body
    t.check('and the app still left no ghost client on the server', clean === true, {
      clients: receipt.afterQuit
    })
    t.equal('the attached server remains live', (await client.live()).status, 200)
  } finally {
    // Retain the failure before disposing only this fixture's public clients.
    try {
      if (client) {
        receipt.beforeFixtureCleanup = (await client.clients()).body
        for (const entry of receipt.beforeFixtureCleanup ?? []) {
          if (entry.pid === receipt.appPid) await client.deregister(entry.id)
        }
        receipt.afterFixtureCleanup = (await client.clients()).body
      }
    } catch (error) {
      receipt.fixtureCleanupError = error.name
    }
    if (proxy) receipt.proxy = proxy.receipts()
    writeFileSync(
      fixturePath(`shell-client-lifecycle-${scenario}-receipt.json`),
      JSON.stringify(receipt, null, 2)
    )
    console.log(`LIFECYCLE_RECEIPT ${JSON.stringify(receipt)}`)
    removeOutputListeners()
    await app?.close().catch(() => {})
    await proxy?.close()
    await own?.stop()
  }
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
          command: `/bin/sh -c 'echo "PROBE url=[$CLAVE_SERVER_URL] tokenlen=[\${#CLAVE_SERVER_TOKEN}] asnode=[$ELECTRON_RUN_AS_NODE] END"'`,
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
    const proxy = await delayingProxy(own.url)
    try {
      const DIR = userDataDir('server-boot-quit-race')
      seed(DIR)
      const client = serverClient(own.url, own.token)
      // The launch must return BEFORE the registration lands: the proxy
      // holds it until the quit is asked for, and the harness is told not to
      // wait for the server's discovery file, which that very registration
      // writes.
      const { app } = await launchApp(DIR, {
        server: { url: proxy.url, token: own.token },
        settleMs: 300,
        waitForServer: false
      })
      const pid = app.process().pid
      const held = await until(() => (proxy.held() > 0 ? true : null), { tries: 80, gapMs: 250 })
      t.check(
        'the registration had not landed when the quit came',
        held === true && !(await client.clients()).body?.some?.((c) => c.pid === pid),
        { held: proxy.held() }
      )
      // Quit the way the user does (Cmd+Q: `app.quit()`, the before-quit
      // ladder, the process ending on its own), and wait for the process to
      // be gone. The driver's own `close()` tears the process down on its
      // schedule, which can land before the quit cleanup finishes and would
      // make this pin measure the driver, not the app.
      const exited = new Promise((resolve) => app.process().once('exit', () => resolve(true)))
      // The process may end before the call answers: that is the quit.
      const quitting = app
        .evaluate(({ app: electronApp }) => electronApp.quit())
        .catch(() => undefined)
      // The registration lands only now, while the quit waits on the boot
      // (inside the quit's 8 s ceiling), which is the race this part pins.
      await new Promise((r) => setTimeout(r, 300))
      proxy.release()
      await quitting
      // The registration has reached the server (and, with the app gone,
      // the server has registered it) before anything asks who is there.
      const landed = await Promise.race([
        proxy.landed().then(() => true),
        new Promise((r) => setTimeout(() => r(false), 10_000))
      ])
      t.check('the held confirmation reached its actual upstream result', landed === true)
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

  for (const scenario of [
    'reserve-after-exit',
    'reserve-lost-response',
    'confirm-after-exit',
    'confirm-lost-response',
    'during-quit'
  ]) {
    await runDelayedRegistrationAfterQuit(t, { scenario })
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
      // The app's data carried into the server's directory at this first
      // separate boot (the second pull request of PRDCT-3434): the workspace
      // registry the spec seeded for the app is the server's too, and the
      // marker says the migration was done, with nothing to re-seal here.
      const migrated = (() => {
        try {
          return JSON.parse(
            readFileSync(path.join(separateServerDataDir(DIR), 'migrated-from-app.json'), 'utf-8')
          )
        } catch {
          return null
        }
      })()
      t.check("the app's data was carried into the server's directory once", !!migrated, migrated)
      t.check(
        'the workspace registry among it',
        migrated?.copied?.includes('workspace-state.json') === true,
        migrated?.copied
      )
      t.check(
        "and the window shows the app's workspace on the separate server",
        (await win.evaluate(() => document.body.innerText)).includes(WS.name),
        WS.name
      )
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
          testFlag: process.argv.includes('--test-no-activate'),
          noMachineUsage: process.argv.includes('--test-no-machine-usage')
        }))
        .catch((error) => ({ error: String(error && error.message ? error.message : error) }))
      t.check(
        "the shell's test flag reached the child (its evaluate route answers)",
        childEnv.testFlag === true,
        childEnv
      )
      t.equal('the child disables machine usage before boot', childEnv.noMachineUsage, true)
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
      // ITSELF: both are gone the instant the app's process is. The two
      // parent polls would end them too, later, which a wait of seconds
      // could not tell from the stops (the round-1 verifier skipped the
      // child's stop and the handle's stop and this part stayed green).
      const started = Date.now()
      await app.close()
      closed = true
      const closeMs = Date.now() - started
      t.check(
        'the server was gone when the app finished quitting (stopped, not polled)',
        !alive(serverPid),
        serverPid
      )
      // The server's stop waits for its terminal process to exit before the
      // server exits, so the process is gone at the same instant; its own
      // parent poll would end it up to 2 s after the server, which a window
      // of half a second caught one time in three (round 2's verifier).
      t.check(
        'and so was its terminal process (stopped by the server, not polled)',
        !alive(restarted?.terminalProcessPid),
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
