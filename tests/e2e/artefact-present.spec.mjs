// A session presents its deck full screen in a window of its own (PRDCT-4980),
// in the real app, through the real Slideless. An agent asks with
// `clave_open_artefact`'s `present` through the real MCP: the window holding
// its tab holds the preview and main shows it alone in a presentation window
// (the deck readable in it, the loopback preview without Slideless's bar, no
// preload, on the presentations' own session), never an app window. Asked
// again, the same window comes forward, never a second one. Escape pressed
// with the focus inside the deck's own frame closes it. Present in the
// artefact's menu presents it for the person, and closing the artefact ends
// the presentation. Under test mode no window is ever shown, so full screen
// itself is not seen here: the display picked for it is.
//
// It runs on the in-process server here, and on the app's own separate
// server from artefact-present-separate.spec.mjs: there the tab's tools are
// the standalone server's MCP, which is what a packaged app's tabs call.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  mcpEndpoint,
  mcpHttpClient,
  spawnAgentTabIn,
  toolErrored,
  toolPayload,
  serverDataDirOf,
  fixturePath
} from './harness.mjs'

const CLI =
  process.env.SLIDELESS_E2E_CLI || path.resolve('node_modules/@antasphere/slideless/dist/bin.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, tries = 100) {
  for (let i = 0; i < tries; i++) {
    const v = await fn()
    if (v) return v
    await sleep(100)
  }
  return null
}

async function fakeAgent(win, root, wsId) {
  writeFileSync(`${root}/fake-agent.sh`, '#!/bin/sh\nexec sleep 3600\n')
  chmodSync(`${root}/fake-agent.sh`, 0o755)
  await win.evaluate(
    async ({ root, ws }) => {
      await window.electronAPI.launchProfileUpsert({
        id: 'present-fake-claude',
        name: 'Synthetic agent',
        family: 'claude',
        command: [root + '/fake-agent.sh'],
        additionalArgs: []
      })
      await window.electronAPI.launchProfileSetWorkspace(ws, 'claude', 'present-fake-claude')
    },
    { root, ws: wsId }
  )
}

/** An agent tab and its MCP client, on the server that runs the tab. */
async function agentClient(app, win, dir) {
  const root = serverDataDirOf(dir)
  const agent = await spawnAgentTabIn(app, win, root)
  if (!agent?.token) return { agent: null, client: null }
  const config = JSON.parse(
    readFileSync(path.join(root, 'mcp-configs', `${agent.sessionId}.json`), 'utf8')
  )
  const client = mcpHttpClient(config.mcpServers?.clave?.url ?? mcpEndpoint(dir), agent.token)
  await client.init()
  return { agent, client }
}

/** The presentation windows main has open, from its test hooks. */
const presentations = (app) =>
  app.evaluate(() => globalThis.__claveE2E?.presentations?.list() ?? [])

/** What the presentation window's page was given and runs on. */
const windowFacts = (app, windowId) =>
  app.evaluate(({ BrowserWindow, session }, id) => {
    const w = BrowserWindow.fromId(id)
    if (!w || w.isDestroyed()) return null
    const prefs = w.webContents.getLastWebPreferences?.() ?? {}
    return {
      preload: prefs.preload ?? null,
      sandbox: prefs.sandbox ?? null,
      nodeIntegration: prefs.nodeIntegration ?? null,
      defaultSession: w.webContents.session === session.defaultSession,
      url: w.webContents.getURL()
    }
  }, windowId)

export async function run(t, server = 'in-process') {
  t.check('the Slideless command line to test with exists', existsSync(CLI), CLI)
  if (!existsSync(CLI)) return
  const DIR = userDataDir(`artefact-present-${server}`)
  const ROOT = fixturePath(`artefact-present-root-${server}`)
  rmSync(ROOT, { recursive: true, force: true })
  const DECK = `${ROOT}/talk`
  mkdirSync(DECK, { recursive: true })
  writeFileSync(
    `${DECK}/index.html`,
    '<!doctype html><title>own title</title><h1 id="t">on the big screen</h1>'
  )
  const WS = {
    id: 'aaaa0000-0000-4000-8000-000000004980',
    name: 'Present',
    rootDir: ROOT,
    profileFile: null,
    createdAt: 1
  }
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const { app, win } = await launchApp(DIR, {
    server,
    env: { CLAVE_SLIDELESS_CLI: CLI, CLAVE_TEST_SLIDELESS_REGISTRY: '' }
  })
  try {
    const ready = await until(async () => {
      const s = await win.evaluate(() => window.electronAPI.artefacts.slidelessState())
      return s.phase === 'ready' ? s : null
    }, 300)
    t.check('Slideless is ready on this Mac', !!ready, ready)
    await fakeAgent(win, ROOT, WS.id)
    const { agent, client } = await agentClient(app, win, DIR)
    t.check('an authenticated agent tab', !!agent?.token)
    if (!agent?.token) return
    t.equal('nothing is presented before anyone asks', (await presentations(app)).length, 0)

    // ── The agent presents.
    const opened = await client.call('clave_open_artefact', { path: DECK, present: true })
    t.check('the real MCP opens the folder and presents it', !toolErrored(opened), opened)
    t.equal(
      'the tool answers that the presentation was requested',
      toolPayload(opened)?.present,
      'requested'
    )
    const ofTab = async () =>
      (await presentations(app)).filter((p) => p.sessionId === agent.sessionId)
    const shown = (await until(async () => (await ofTab())[0] ?? null, 200)) ?? null
    t.check(
      'the window holding the tab presents it in a window of its own',
      !!shown,
      await presentations(app)
    )
    if (!shown) return
    t.check(
      'the presentation shows the loopback preview without Slideless’s bar',
      /^http:\/\/127\.0\.0\.1:\d+\/\?bar=0$/.test(shown.url),
      shown.url
    )
    t.check('on a display of this Mac', typeof shown.displayId === 'number', shown.displayId)
    const facts = await windowFacts(app, shown.windowId)
    t.check(
      'the presentation window has no preload, no Node, a sandbox, and a session of its own',
      facts &&
        !facts.preload &&
        facts.nodeIntegration !== true &&
        facts.sandbox === true &&
        facts.defaultSession === false,
      facts
    )
    t.equal('it carries the artefact’s title', shown.title, 'talk')
    const listed = await win.evaluate(() => window.electronAPI.windowList())
    t.equal('it is no app window: the windows listed are still one', listed?.length, 1)

    const origin = new URL(shown.url).origin
    const page = await until(() => app.windows().find((p) => p.url().startsWith(origin)) ?? null)
    t.check(
      'the presentation window is a page of its own',
      !!page,
      app.windows().map((p) => p.url())
    )
    if (!page) return
    const deckText = () =>
      page
        .frameLocator('#deck')
        .locator('#t')
        .textContent({ timeout: 2000 })
        .catch(() => null)
    t.equal('the deck shows in the presentation window', await until(deckText), 'on the big screen')
    writeFileSync(`${DECK}/index.html`, '<!doctype html><h1 id="t">edited live</h1>')
    t.equal(
      'an edit to the deck reloads the presentation by itself',
      await until(async () => ((await deckText()) === 'edited live' ? 'edited live' : null)),
      'edited live'
    )

    // ── What the page may do: no permission beyond full screen and copy, never
    // leave its preview (a web link goes to the browser instead), no window of its own.
    t.equal(
      'the deck is refused a permission it was not given',
      await page.evaluate(
        async () => (await navigator.permissions.query({ name: 'geolocation' })).state
      ),
      'denied'
    )
    const refused = await win.evaluate(() =>
      window.electronAPI.presentation.show('anything', 'https://example.com/', 'x', 'p-other').then(
        () => 'shown',
        () => 'refused'
      )
    )
    t.equal('main refuses to present a page off this Mac’s loopback', refused, 'refused')
    t.equal('nothing more is presented', (await presentations(app)).length, 1)

    // ── Asked again: the same window, never a second one.
    const again = await client.call('clave_open_artefact', { path: DECK, present: true })
    t.check('asked again, the tool answers', !toolErrored(again), again)
    await sleep(1500)
    const afterAgain = await ofTab()
    t.check(
      'asked again, the same presentation window comes forward, never a second one',
      afterAgain.length === 1 && afterAgain[0].windowId === shown.windowId,
      afterAgain
    )

    // ── A second app window of this Mac, which does not hold the tab: the
    // agent's ask is the holding window's alone.
    const answers = () => app.evaluate(() => globalThis.__claveE2E.presentations.answers())
    await win.evaluate(() => window.electronAPI.windowOpen())
    const other = await until(
      () => app.windows().find((p) => p !== win && !/^http:/.test(p.url())) ?? null
    )
    const otherReady = other
      ? await until(() => other.evaluate(() => !!window.__clavePresenterForTests), 300)
      : null
    t.check('a second app window is ready', !!otherReady)
    await other?.evaluate(() => {
      window.__heard = []
      window.electronAPI.artefacts.onPresentRequested((id) => window.__heard.push(id))
    })
    const asked = (await answers()).length
    const third = await client.call('clave_open_artefact', { path: DECK, present: true })
    t.check('asked once more with a second window open', !toolErrored(third), third)
    const answeredNow = await until(async () => {
      const fresh = (await answers()).slice(asked)
      return fresh.length > 0 ? fresh : null
    })
    const heard = other
      ? await until(async () =>
          (await other.evaluate(() => window.__heard)).includes(agent.sessionId) ? true : null
        )
      : null
    t.check('the second window hears the ask too', !!heard)
    await sleep(2000)
    const fresh = (await answers()).slice(asked)
    t.check(
      'only the window holding the tab asks main to present it',
      !!answeredNow &&
        fresh.length > 0 &&
        fresh.every((a) => a.ownerWebContentsId === shown.ownerWebContentsId),
      fresh
    )

    // ── Escape, the focus inside the deck's own frame, ends it, though the deck
    // guards its unload (the click below gives that guard its effect). The key goes
    // in the way the keyboard's does, through the browser side of the page
    // (`sendInputEvent`): the debugger's key injection, which
    // `page.keyboard.press` uses, skips `before-input-event` altogether
    // (measured: no event seen with it, one with this).
    // The guard a deck may set: a page refusing its unload would cancel the close.
    // Playwright hears of the dialog Clave overrides, and must not fail on it.
    page.on('dialog', (dialog) => void dialog.dismiss().catch(() => {}))
    await page
      .frameLocator('#deck')
      .locator('#t')
      .evaluate(() =>
        addEventListener('beforeunload', (event) => {
          event.preventDefault()
          event.returnValue = ''
        })
      )
    await page.frameLocator('#deck').locator('#t').click({ timeout: 5000 })
    await app.evaluate(({ BrowserWindow }, id) => {
      const w = BrowserWindow.fromId(id)
      if (w && !w.isDestroyed())
        w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    }, shown.windowId)
    const gone = await until(async () => ((await ofTab()).length === 0 ? true : null))
    t.check('Escape pressed inside the deck closes the presentation', !!gone, await ofTab())
    t.check(
      'its window is gone',
      (await windowFacts(app, shown.windowId)) === null,
      await windowFacts(app, shown.windowId)
    )
    const late = await win.evaluate(
      ({ id, url, presentationId }) =>
        window.electronAPI.presentation.show(id, url, 'late', presentationId),
      { id: agent.sessionId, url: shown.url, presentationId: shown.presentationId }
    )
    t.equal('main refuses a late show of the presentation the person closed', late, false)
    t.equal('and opens nothing for it', (await ofTab()).length, 0)

    // ── The person presents from the artefact's menu.
    const present = async () => {
      // A menu still closing would swallow the click that opens the next one.
      await win.locator('[role="menu"]').waitFor({ state: 'detached', timeout: 5000 })
      await win.getByRole('button', { name: 'Artefact menu' }).click()
      await win.getByRole('menuitem', { name: 'Present' }).click()
    }
    await present()
    const fromMenu = await until(async () => (await ofTab())[0] ?? null, 200)
    t.check('Present in the artefact’s menu presents it', !!fromMenu, await presentations(app))
    t.check(
      'in a new window, the one Escape closed being gone',
      !!fromMenu && fromMenu.windowId !== shown.windowId,
      fromMenu
    )
    await present()
    await sleep(1000)
    const afterSecond = await ofTab()
    t.check(
      'a second Present keeps the one presentation window',
      afterSecond.length === 1 && afterSecond[0].windowId === fromMenu?.windowId,
      afterSecond
    )

    // ── The page never leaves its preview: a web link it opens or goes to is
    // sent to the browser, and no window is made for it. Done last on this
    // window: the debugger then waits on the navigation that was stopped.
    const stage = fromMenu
      ? await until(
          () => app.windows().find((p) => p.url().startsWith(new URL(fromMenu.url).origin)) ?? null
        )
      : null
    if (stage) {
      const windowsBefore = app.windows().length
      await stage.evaluate(() => {
        window.open('https://example.com/popup', '_blank')
        location.href = 'https://example.com/away'
      })
      await sleep(800)
      t.equal('the page stays on its preview when it tries to leave', stage.url(), fromMenu.url)
      t.check(
        'a link it opens goes to the browser, never into a Clave window',
        await until(async () => {
          const opened = await app.evaluate(() => globalThis.__claveE2E.presentations.linksOpened())
          return opened.includes('https://example.com/popup') &&
            opened.includes('https://example.com/away')
            ? opened
            : null
        }),
        await app.evaluate(() => globalThis.__claveE2E.presentations.linksOpened())
      )
      t.equal('and no window was made for it', app.windows().length, windowsBefore)
    } else t.check('the window the menu opened is a page of its own', false)

    // ── Closing the artefact ends the presentation.
    await win.evaluate((id) => window.electronAPI.artefacts.close(id), agent.sessionId)
    const ended = await until(async () => ((await ofTab()).length === 0 ? true : null))
    t.check('closing the artefact ends its presentation', !!ended, await ofTab())

    // ── The app window that presents it reloads: its hold died, the deck goes with it.
    const again2 = await client.call('clave_open_artefact', { path: DECK, present: true })
    t.check('presented once more', !toolErrored(again2), again2)
    const before = await until(async () => (await ofTab())[0] ?? null, 200)
    t.check('presented again by the agent', !!before, await presentations(app))
    // A show of the presentation being closed is refused: nothing is left up.
    const same = await win.evaluate(
      ({ id, url, presentationId }) =>
        Promise.all([
          window.electronAPI.presentation.close(id),
          window.electronAPI.presentation.show(id, url, 'same', presentationId)
        ]).then((answers) => answers[1]),
      { id: agent.sessionId, url: before?.url ?? '', presentationId: before?.presentationId ?? '' }
    )
    t.equal('a show of the presentation being closed is refused', same, false)
    t.check(
      'and no window is left up',
      !!(await until(async () => ((await ofTab()).length === 0 ? true : null))) &&
        (await windowFacts(app, before?.windowId ?? -1)) === null,
      await ofTab()
    )
    const again3 = await client.call('clave_open_artefact', { path: DECK, present: true })
    t.check('presented once more, again', !toolErrored(again3), again3)
    const before2 = await until(async () => (await ofTab())[0] ?? null, 200)
    t.check('presented again by the agent, a third time', !!before2, await presentations(app))

    // A show that arrives while the window is closing opens a window of its own:
    // the closing one must not take it, or its close would mark it closed.
    await win.evaluate(
      ({ id, url }) =>
        Promise.all([
          window.electronAPI.presentation.close(id),
          window.electronAPI.presentation.show(id, url, 'race', 'p-race')
        ]),
      { id: agent.sessionId, url: before2?.url ?? '' }
    )
    const raced = await until(async () => {
      const now = await ofTab()
      return now.length === 1 &&
        now[0].presentationId === 'p-race' &&
        now[0].windowId !== before2?.windowId &&
        (await windowFacts(app, before2?.windowId ?? -1)) === null
        ? now[0]
        : null
    })
    t.check(
      'a show while the window closes gets a window of its own, and stays up',
      !!raced,
      await ofTab()
    )
    await win.reload()
    const afterReload = await until(async () => ((await ofTab()).length === 0 ? true : null))
    t.check('the app window reloaded, its presentation is closed', !!afterReload, await ofTab())
  } finally {
    await app.close()
  }
}
