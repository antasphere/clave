/**
 * A session's artefact on a connected Clave server (PRDCT-4474): the server
 * owns the link, the Slideless preview and the versions; a Mac attached to
 * it frames the preview through a loopback port of its own (the forwarder of
 * PRDCT-4473), and nothing of the artefact is the Mac's.
 *
 * One standalone daemon told the real Slideless command line through
 * CLAVE_SLIDELESS_CLI, one hidden in-process Mac. The session is a Claude
 * chat on the daemon over the stream-json stand-in
 * (`fixtures/claude-stream-stub.mjs`): the server keeps a record of it, so it
 * is still the server's session after the restart of step 6.
 *
 *  1. a session on the server; its artefact opened through the server's API
 *     while NO Mac is attached; a turn ends there: the server's store holds
 *     one version;
 *  2. the Mac attaches and shows the server's workspace: the session's panel
 *     is there, framed on a loopback port of the Mac that is neither the
 *     server's port nor its preview's;
 *  3. inside the frame the version bar page shows the deck; an edit on the
 *     server's disk changes the text without the panel loading again;
 *  4. the frame's own Save version saves on the server: one more version;
 *  5. a plain request to the Mac's port from this process is refused (403):
 *     the port is the windows' alone; a page of a target this spec serves,
 *     registered on the server and framed in the Mac's window, opens a
 *     WebSocket that echoes across both hops (the window gate stamps the
 *     handshake a real window sends), and the same handshake from this
 *     process is refused;
 *  6. the server stopped, the frame says it cannot be reached; started again
 *     on the same port and data folder, the deck shows again unopened;
 *  7. hidden with its button, brought back by the chip; a second open on
 *     another folder shows the new one.
 *
 * Fails if: the window serves or versions anything itself, a server's
 * session id reaches the panel unkeyed, the frame points at the server's own
 * loopback, the forward answers a stranger, or the hold is not renewed once
 * its server is back.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import {
  fleetWorld,
  connectMac,
  owned,
  request,
  showServer,
  step
} from './fixtures/fleet-world.mjs'
import { WebSocket, WebSocketServer } from 'ws'
import { REPO, fixturePath, until } from './harness.mjs'

const CLI =
  process.env.SLIDELESS_E2E_CLI || path.resolve('node_modules/@antasphere/slideless/dist/bin.js')

/** The versions a server keeps of a folder, read off its Slideless store. */
function versionsOf(server, target) {
  const store = path.join(server.dataDir, 'slideless', 'versions', 'folders')
  if (!existsSync(store)) return 0
  const root = realpathSync(target)
  for (const folder of readdirSync(store)) {
    let meta = null
    try {
      meta = JSON.parse(readFileSync(path.join(store, folder, 'folder.json'), 'utf8'))
    } catch {
      continue
    }
    if (meta?.root !== root) continue
    const versions = path.join(store, folder, 'versions')
    return existsSync(versions)
      ? readdirSync(versions).filter((f) => f.endsWith('.json')).length
      : 0
  }
  return 0
}

/** One turn of the chat: a message the stand-in answers, written through the server's API. */
const endTurn = (server, id, text) =>
  request(server, '/sessions/write', { id, input: { type: 'user_message', text } })

function deck(folder, text) {
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'index.html'), `<!doctype html><h1 id="t">${text}</h1>`)
}

/** What the target's page says once its socket has answered. */
const SOCKET_TEXT = 'ping from the window'
const SOCKET_PAGE = `<!doctype html><meta charset="utf-8"><title>socket</title>
<h1 id="loaded">page loaded</h1><p id="echo"></p>
<script>
const echo = document.getElementById('echo')
const ws = new WebSocket('ws://' + location.host + '/ws')
ws.onopen = () => ws.send(${JSON.stringify(SOCKET_TEXT)})
ws.onmessage = (event) => { echo.textContent = String(event.data) }
ws.onerror = () => { echo.textContent = 'socket error' }
</script>`

/** A target on this process's loopback: one page at `/`, an echo of every frame on `/ws`. */
async function socketTarget() {
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(SOCKET_PAGE)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  const sockets = new WebSocketServer({ server, path: '/ws' })
  sockets.on('connection', (ws) => ws.on('message', (data, binary) => ws.send(data, { binary })))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    close: async () => {
      for (const client of sockets.clients) client.terminate()
      await new Promise((resolve) => sockets.close(() => resolve()))
      server.closeAllConnections()
      await new Promise((resolve) => server.close(() => resolve()))
    }
  }
}

/** The status a WebSocket handshake gets from this process, with no window header. */
const handshakeStatus = (url) =>
  new Promise((resolve) => {
    const ws = new WebSocket(url)
    ws.once('open', () => {
      ws.terminate()
      resolve(101)
    })
    ws.once('unexpected-response', (_req, res) => {
      res.resume()
      ws.terminate()
      resolve(res.statusCode ?? 0)
    })
    ws.once('error', () => resolve(0))
  })

/** Wait for `fn` to answer true, `ms` at most. */
async function within(ms, fn) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/** What the window and the server say when the deck does not come back. */
async function picture(mac, server, sessionId) {
  const src = await mac.win
    .locator('[data-testid="slideless-artefact"]')
    .getAttribute('src', { timeout: 1000 })
    .catch(() => null)
  const window = await mac.win
    .evaluate(async () => ({
      listed: await window.electronAPI.artefacts.list().catch((e) => String(e)),
      statuses: await window.electronAPI.fleetList().catch((e) => String(e))
    }))
    .catch((e) => String(e))
  const listed = await request(server, '/artefacts').catch((e) => String(e))
  const alert = await mac.win
    .locator('[data-testid="artefact-panel"]')
    .innerText({ timeout: 1000 })
    .catch(() => null)
  return { src, window, listed, alert, sessionId }
}

export async function run(t) {
  t.check('the Slideless command line to test with exists', existsSync(CLI), CLI)
  if (!existsSync(CLI)) return
  const world = await fleetWorld('fleet-artefacts', {
    count: 1,
    env: {
      CLAVE_SLIDELESS_CLI: CLI,
      CLAVE_TRANSCRIPTS_ROOT: fixturePath(`fleet-artefacts-transcripts-${process.pid}`)
    }
  })
  try {
    const [server] = world.servers
    const DECK = path.join(server.root, 'deck')
    deck(DECK, 'first draft')

    // ── 1. Opened and versioned on the server, no Mac anywhere ──
    const started = await step('a session on the server, its artefact opened', async () => {
      await request(server, '/launch-profiles', {
        profile: {
          id: 'artefacts-stub',
          name: 'Artefacts stream stub',
          family: 'claude',
          command: [process.execPath, path.join(REPO, 'tests/e2e/fixtures/claude-stream-stub.mjs')],
          additionalArgs: []
        }
      })
      const started = await request(server, '/sessions/start', {
        cwd: server.root,
        options: { claudeMode: true, launchProfileId: 'chat:claude:artefacts-stub' }
      })
      const opened = await request(server, '/artefacts/open', {
        sessionId: started.id,
        path: DECK
      })
      t.equal(
        'the server links the folder’s entry page',
        opened.page,
        path.join(DECK, 'index.html')
      )
      return started
    })
    await endTurn(server, started.id, 'Make the deck.')
    t.check(
      'a turn ended on the server saves a version there, with no Mac attached',
      !!(await until(() => versionsOf(server, DECK) === 1, { tries: 150, gapMs: 100 })),
      versionsOf(server, DECK)
    )

    // ── 2. The Mac attaches: the panel frames a port of its own ──
    const mac = await world.mac('a')
    await connectMac(mac, world.servers, { ui: false })
    const key = owned('session', mac.owners[0].id, started.id)
    await showServer(mac, 0)
    await mac.win.locator(`[data-sidebar-item-id="${key}"]`).click()
    const panel = mac.win.locator('[data-testid="artefact-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 30_000 })
    const frame = mac.win.locator('[data-testid="slideless-artefact"]')
    await frame.waitFor({ state: 'visible', timeout: 30_000 })
    const src = await frame.getAttribute('src')
    const preview = await request(server, '/artefacts/hold', { sessionId: started.id })
    await request(server, '/artefacts/release', { sessionId: started.id, holdId: preview.holdId })
    const port = (url) => Number(new URL(url).port)
    t.check(
      'the frame is a loopback port of the Mac, neither the server’s nor its preview’s',
      /^http:\/\/127\.0\.0\.1:\d+\/$/.test(src) &&
        port(src) !== port(preview.url) &&
        port(src) !== port(server.url),
      { src, preview: preview.url, server: port(server.url) }
    )

    // ── 3. The deck, and an edit on the server's disk, in place ──
    const deckText = () =>
      mac.win
        .frameLocator('[data-testid="slideless-artefact"]')
        .frameLocator('#deck')
        .locator('#t')
        .textContent({ timeout: 1000 })
        .catch(() => null)
    t.equal(
      'inside the frame, the version bar page shows the deck',
      await until(deckText, { tries: 150, gapMs: 100 }),
      'first draft'
    )
    await frame.evaluate((el) => (el.dataset.e2eMark = 'kept'))
    deck(DECK, 'second draft')
    t.check(
      'an edit on the server’s disk changes the text in the frame',
      !!(await until(async () => (await deckText()) === 'second draft', {
        tries: 150,
        gapMs: 100
      })),
      await deckText()
    )
    t.equal(
      'without the panel loading again',
      await frame.evaluate((el) => el.dataset.e2eMark ?? null),
      'kept'
    )

    // ── 4. The frame's own Save version ──
    const before = versionsOf(server, DECK)
    await mac.win.frameLocator('[data-testid="slideless-artefact"]').locator('#snap').click()
    t.check(
      'the frame’s own Save version saves one more version on the server',
      !!(await until(() => versionsOf(server, DECK) === before + 1, { tries: 150, gapMs: 100 })),
      { before, after: versionsOf(server, DECK) }
    )

    // ── 5. The Mac's port is the windows' alone ──
    const stranger = await fetch(src).then(
      (r) => r.status,
      () => 0
    )
    t.equal('a plain request to the Mac’s port without the window header is refused', stranger, 403)

    // A socket a real Clave window opens: a page of this spec's own target,
    // registered on the server, forwarded to the Mac the way the window's
    // IPC handler forwards, and framed in the Mac's window by hand.
    const target = await socketTarget()
    try {
      const lease = await server.fixture.evaluate(
        (port) => globalThis.__claveE2E.forwards.register(port).lease,
        target.port
      )
      const forwarded = await mac.app.evaluate(
        (_electron, { serverId, lease }) => globalThis.__claveE2E.openForward(serverId, lease),
        { serverId: mac.owners[0].id, lease }
      )
      await mac.win.evaluate((url) => {
        const frame = document.createElement('iframe')
        frame.id = 'e2e-socket-frame'
        frame.src = url
        document.body.appendChild(frame)
      }, forwarded)
      const inFrame = (selector) =>
        mac.win
          .frameLocator('#e2e-socket-frame')
          .locator(selector)
          .textContent({ timeout: 1000 })
          .catch(() => null)
      t.equal(
        'a page behind a forward loads in a Clave window',
        await until(() => inFrame('#loaded'), { tries: 150, gapMs: 100 }),
        'page loaded'
      )
      t.equal(
        'a socket the page opens echoes back across both hops',
        await until(async () => (await inFrame('#echo')) || null, { tries: 150, gapMs: 100 }),
        SOCKET_TEXT
      )
      t.equal(
        'a socket from outside the window is refused',
        await handshakeStatus(`${forwarded.replace(/^http/, 'ws')}ws`),
        403
      )
      await mac.win.evaluate(() => document.getElementById('e2e-socket-frame')?.remove())
    } finally {
      await target.close()
    }

    // ── 6. The server away, then back on the same port and data folder ──
    await step('the server stops', () => server.stop())
    const outerText = () =>
      mac.win
        .frameLocator('[data-testid="slideless-artefact"]')
        .locator('h1')
        .first()
        .textContent({ timeout: 2000 })
        .catch(() => null)
    t.check(
      'the frame shows the page that says the server cannot be reached',
      !!(await until(async () => /cannot reach/.test((await outerText()) ?? ''), {
        tries: 300,
        gapMs: 100
      })),
      await outerText()
    )
    await step('the server starts again', () => world.restart(0))
    const back = await within(90_000, async () => (await deckText()) === 'second draft')
    t.check(
      'started again, the panel shows the deck again without being reopened',
      back,
      back || (await picture(mac, server, started.id))
    )

    // ── 7. Hidden, brought back; another open replaces it ──
    await mac.win.getByRole('button', { name: 'Hide artefact', exact: true }).click()
    await panel.waitFor({ state: 'detached', timeout: 10_000 })
    t.check('the panel hides with its button', (await panel.count()) === 0)
    await mac.win.getByRole('button', { name: 'Open artefact', exact: true }).click()
    await panel.waitFor({ state: 'visible', timeout: 10_000 })
    t.check('the chip in the session’s header brings it back', (await panel.count()) === 1)
    const OTHER = path.join(server.root, 'other')
    deck(OTHER, 'another deck')
    await request(server, '/artefacts/open', { sessionId: started.id, path: OTHER })
    t.check(
      'a second open on another folder shows the new one',
      !!(await until(async () => (await deckText()) === 'another deck', {
        tries: 300,
        gapMs: 100
      })),
      await deckText()
    )
    assert.deepEqual(mac.errors, [])
  } finally {
    await world.close()
  }
}
