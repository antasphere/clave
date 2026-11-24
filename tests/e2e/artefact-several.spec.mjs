// A session keeps several artefacts (PRDCT-5022), in the real app, through
// the real Slideless. An agent opens one deck, then another: the second shows
// in front, and the panel's title becomes a picker of both, newest first.
// Picking the first shows it; a finished turn saves a version of each. The
// agent presents the second: the presentation follows a pick of the first.
// Opened again, the first comes back in front. Closing one leaves the other,
// and the title is a plain title again.
//
// It runs on the in-process server here, and on the app's own separate server
// from artefact-several-separate.spec.mjs.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
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
  recordsRootOf,
  serverDataDirOf,
  fixturePath
} from './harness.mjs'

const CLI =
  process.env.SLIDELESS_E2E_CLI || path.resolve('node_modules/@antasphere/slideless/dist/bin.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** The harness's equal compares with ===: lists are compared by their contents. */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
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
        id: 'several-fake-claude',
        name: 'Synthetic agent',
        family: 'claude',
        command: [root + '/fake-agent.sh'],
        additionalArgs: []
      })
      await window.electronAPI.launchProfileSetWorkspace(ws, 'claude', 'several-fake-claude')
    },
    { root, ws: wsId }
  )
}

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

/** One turn of the agent: started, then ended (the Stop hook's word). */
async function turn(dir, sessionId) {
  const stateDir = path.join(recordsRootOf(dir), 'agent-state')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(path.join(stateDir, `${sessionId}.state`), 'working')
  await sleep(600)
  writeFileSync(path.join(stateDir, `${sessionId}.state`), 'done')
}

/** The versions the server keeps of a folder, read off its Slideless store. */
function versionsOf(dir, target) {
  const store = path.join(serverDataDirOf(dir), 'slideless', 'versions', 'folders')
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

export async function run(t, server = 'in-process') {
  t.check('the Slideless command line to test with exists', existsSync(CLI), CLI)
  if (!existsSync(CLI)) return
  const DIR = userDataDir(`artefact-several-${server}`)
  const ROOT = fixturePath(`artefact-several-root-${server}`)
  rmSync(ROOT, { recursive: true, force: true })
  const FIRST = `${ROOT}/first`
  const SECOND = `${ROOT}/second`
  for (const [folder, text] of [
    [FIRST, 'first deck'],
    [SECOND, 'second deck']
  ]) {
    mkdirSync(folder, { recursive: true })
    writeFileSync(`${folder}/index.html`, `<!doctype html><h1 id="t">${text}</h1>`)
  }
  const WS = {
    id: 'aaaa0000-0000-4000-8000-000000005022',
    name: 'Several',
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

    const frame = win.locator('[data-testid="slideless-artefact"]')
    const deckText = () =>
      win
        .frameLocator('[data-testid="slideless-artefact"]')
        .frameLocator('#deck')
        .locator('#t')
        .textContent({ timeout: 2000 })
        .catch(() => null)
    const shows = (text) => until(async () => ((await deckText()) === text ? text : null), 150)
    const picker = win.getByRole('button', { name: 'Artefact shown' })

    // ── One deck: a plain title.
    t.check(
      'the agent opens a first deck',
      !toolErrored(await client.call('clave_open_artefact', { path: FIRST }))
    )
    await frame.waitFor({ state: 'visible', timeout: 20000 })
    t.equal('the panel shows it', await shows('first deck'), 'first deck')
    t.equal('with one deck, the title is no picker', await picker.count(), 0)

    // ── A second deck joins it, in front.
    t.check(
      'the agent opens a second deck',
      !toolErrored(await client.call('clave_open_artefact', { path: SECOND }))
    )
    t.equal('the second shows in front', await shows('second deck'), 'second deck')
    const listed = await win.evaluate(() => window.electronAPI.artefacts.list())
    const titles = listed.filter((a) => a.sessionId === agent.sessionId).map((a) => a.title)
    t.check(
      'the session keeps both, the second in front',
      same(titles, ['first', 'second']),
      titles
    )
    await picker.waitFor({ state: 'visible', timeout: 10000 })
    await picker.click()
    const rows = win.locator('[aria-label="Artefacts"] [role="menuitem"]')
    await rows.first().waitFor({ state: 'visible', timeout: 5000 })
    const targets = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-target')))
    t.check('the title is a picker of both, newest first', same(targets, [SECOND, FIRST]), targets)

    // ── The person picks the first.
    await win.locator(`[aria-label="Artefacts"] [role="menuitem"][data-target="${FIRST}"]`).click()
    t.equal('picked, the first shows again', await shows('first deck'), 'first deck')
    t.check(
      'and its own preview frames it',
      !!(await until(async () => {
        const src = await frame.getAttribute('src')
        return src && /^http:\/\/127\.0\.0\.1:\d+\/\?bar=0$/.test(src) ? src : null
      }))
    )

    // ── A finished turn saves a version of each.
    await turn(DIR, agent.sessionId)
    t.check(
      'a finished turn saves a version of each deck',
      !!(await until(() => versionsOf(DIR, FIRST) === 1 && versionsOf(DIR, SECOND) === 1, 150)),
      { first: versionsOf(DIR, FIRST), second: versionsOf(DIR, SECOND) }
    )

    // ── Presented, the second; a pick of the first moves the presentation.
    const presented = await client.call('clave_open_artefact', { path: SECOND, present: true })
    t.check('the agent presents the second', !toolErrored(presented), presented)
    t.equal('presented, the second shows in front again', await shows('second deck'), 'second deck')
    const presentations = () =>
      app.evaluate(() => globalThis.__claveE2E?.presentations?.list() ?? [])
    const stageText = async () => {
      const [p] = (await presentations()).filter((x) => x.sessionId === agent.sessionId)
      if (!p) return null
      const page = app.windows().find((w) => w.url().startsWith(new URL(p.url).origin))
      return page
        ? page
            .frameLocator('#deck')
            .locator('#t')
            .textContent({ timeout: 2000 })
            .catch(() => null)
        : null
    }
    t.equal(
      'the presentation shows the second',
      await until(async () => ((await stageText()) === 'second deck' ? 'second deck' : null), 200),
      'second deck'
    )
    await picker.click()
    await win.locator(`[aria-label="Artefacts"] [role="menuitem"][data-target="${FIRST}"]`).click()
    t.equal(
      'a pick of the first in the bar moves the presentation to it',
      await until(async () => ((await stageText()) === 'first deck' ? 'first deck' : null), 200),
      'first deck'
    )
    t.equal('still one presentation', (await presentations()).length, 1)

    // ── The first opened again comes back in front.
    await client.call('clave_open_artefact', { path: FIRST })
    t.equal('opened again, the first shows in front', await shows('first deck'), 'first deck')
    const after = (await win.evaluate(() => window.electronAPI.artefacts.list()))
      .filter((a) => a.sessionId === agent.sessionId)
      .map((a) => a.title)
    t.check('and the session lists it last, in front', same(after, ['second', 'first']), after)

    // ── Closing one leaves the other, and a plain title.
    await win.evaluate(({ id, target }) => window.electronAPI.artefacts.close(id, target), {
      id: agent.sessionId,
      target: SECOND
    })
    t.check(
      'closing one leaves the other, its title no picker',
      !!(await until(async () => ((await picker.count()) === 0 ? true : null))) &&
        (await shows('first deck')) === 'first deck'
    )
    await win.evaluate((id) => window.electronAPI.artefacts.close(id), agent.sessionId)
    t.check(
      'closing them all closes the panel and the presentation',
      !!(await until(async () =>
        (await frame.count()) === 0 && (await presentations()).length === 0 ? true : null
      )),
      await presentations()
    )
  } finally {
    await app.close()
  }
}
