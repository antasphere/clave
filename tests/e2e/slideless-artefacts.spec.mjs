// HTML artefacts run on Slideless (PRDCT-4261, PRDCT-4262, PRDCT-4263), in
// the real app. Part one boots a Clave that has never seen Slideless with a
// registry that offers it: the app installs the command line by itself, an
// agent opens a folder through the real MCP, the panel shows it through
// Slideless, an edit reloads it, and each finished turn (the Stop hook's word,
// written where Claude's hook writes it) saves a version. Part two boots a
// Clave with no registry: the panel shows the page as before under the
// install card, and still reloads it when the file changes (PRDCT-4261).
//
// The command line is the real one: SLIDELESS_E2E_CLI, else the published
// package Clave keeps as a dev dependency, packed here into a registry of one.
// Pinned to the in-process server like linked-documents.spec.mjs: the agent
// tools that open the panel answer from main.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
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
  recordsRootOf,
  fixturePath,
  callMcp
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

/** A ustar archive, the way npm packs a package. */
function tar(files) {
  const blocks = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const header = Buffer.alloc(512)
    header.write(name, 0, 100)
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
    header.write('00000000000\0', 136)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    header.fill(' ', 148, 156)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

/** A registry offering one release of @antasphere/slideless: the real CLI, packed. */
async function registry() {
  const version = '0.14.1'
  const tgz = gzipSync(
    tar({
      'package/package.json': JSON.stringify({ name: '@antasphere/slideless', version }),
      'package/dist/bin.js': readFileSync(CLI)
    })
  )
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`
  const hits = []
  const server = createServer((req, res) => {
    hits.push(req.url)
    if (req.url === '/@antasphere%2fslideless/latest') {
      res.writeHead(200, { 'content-type': 'application/json' })
      const port = server.address().port
      return res.end(
        JSON.stringify({
          version,
          dist: { tarball: `http://127.0.0.1:${port}/slideless.tgz`, integrity }
        })
      )
    }
    if (req.url === '/slideless.tgz') {
      res.writeHead(200)
      return res.end(tgz)
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, hits, version, server }
}

async function fakeAgent(win, root, wsId) {
  writeFileSync(`${root}/fake-agent.sh`, '#!/bin/sh\nexec sleep 3600\n')
  chmodSync(`${root}/fake-agent.sh`, 0o755)
  await win.evaluate(
    async ({ root, ws }) => {
      await window.electronAPI.launchProfileUpsert({
        id: 'slideless-fake-claude',
        name: 'Synthetic agent',
        family: 'claude',
        command: [root + '/fake-agent.sh'],
        additionalArgs: []
      })
      await window.electronAPI.launchProfileSetWorkspace(ws, 'claude', 'slideless-fake-claude')
    },
    { root, ws: wsId }
  )
}

/** The Stop hook's word, written where the process running the session reads it. */
function hookWord(dir, sessionId, word) {
  const stateDir = path.join(recordsRootOf(dir), 'agent-state')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(path.join(stateDir, `${sessionId}.state`), word)
}

export async function run(t) {
  t.check('the Slideless command line to test with exists', existsSync(CLI), CLI)
  if (!existsSync(CLI)) return

  // ── Part one: installed by Clave, shown through Slideless, a version per turn.
  const DIR = userDataDir('slideless-artefacts')
  const ROOT = fixturePath('slideless-artefacts-root')
  rmSync(ROOT, { recursive: true, force: true })
  const BRIEF = `${ROOT}/brief`
  mkdirSync(BRIEF, { recursive: true })
  writeFileSync(`${BRIEF}/index.html`, '<!doctype html><h1 id="t">first draft</h1>')
  const WS = {
    id: 'aaaa0000-0000-4000-8000-000000000431',
    name: 'Slideless artefacts',
    rootDir: ROOT,
    profileFile: null,
    createdAt: 1
  }
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const reg = await registry()
  let liveSrc = ''
  let { app, win } = await launchApp(DIR, {
    server: 'in-process',
    env: { CLAVE_TEST_SLIDELESS_REGISTRY: reg.url, CLAVE_SLIDELESS_CLI: '' }
  })
  try {
    const ready = await until(async () => {
      const s = await win.evaluate(() => window.electronAPI.slideless.getState())
      return s.phase === 'ready' ? s : null
    }, 300)
    t.check(
      'a Clave that never had Slideless installs it at start, from the registry',
      !!ready,
      ready
    )
    t.equal('the version installed is the registry release', ready?.version, reg.version)
    t.check(
      'the registry was asked for the release and its package, nothing else',
      reg.hits.includes('/@antasphere%2fslideless/latest') && reg.hits.includes('/slideless.tgz'),
      reg.hits
    )
    t.check(
      'the command line lives in Clave’s own data folder',
      existsSync(path.join(DIR, 'slideless', 'cli', reg.version, 'bin.js')),
      DIR
    )

    await fakeAgent(win, ROOT, WS.id)
    const agent = await spawnAgentTabIn(app, win, DIR)
    t.check('an authenticated agent tab', !!agent?.token)
    const client = mcpHttpClient(mcpEndpoint(DIR), agent.token)
    await client.init()
    const opened = await client.call('clave_open_side_panel', { path: BRIEF })
    t.check('the real MCP opens a FOLDER in the panel', !toolErrored(opened), opened)
    const doc = toolPayload(opened)
    t.equal('the panel remembers the folder', doc?.root, BRIEF)

    const frame = win.locator('[data-testid="slideless-artefact"]')
    await frame.waitFor({ state: 'visible', timeout: 20000 })
    const src = await frame.getAttribute('src')
    t.check(
      'the panel frames the local Slideless page',
      /^http:\/\/127\.0\.0\.1:\d+\/$/.test(src),
      src
    )
    const deckText = () =>
      win
        .frameLocator('[data-testid="slideless-artefact"]')
        .frameLocator('#deck')
        .locator('#t')
        .textContent({ timeout: 2000 })
        .catch(() => null)
    t.equal('the deck shows the folder’s page', await until(deckText), 'first draft')

    writeFileSync(`${BRIEF}/index.html`, '<!doctype html><h1 id="t">second draft</h1>')
    const reloaded = await until(async () => ((await deckText()) === 'second draft' ? 'yes' : null))
    t.check('an edit to the file reloads the panel by itself', !!reloaded, await deckText())

    const versions = async () => (await (await fetch(`${src}__slideless/versions`)).json()).versions
    t.equal('no version before the first turn ends', (await versions()).length, 0)
    hookWord(DIR, agent.sessionId, 'working')
    await sleep(600)
    hookWord(DIR, agent.sessionId, 'done')
    const one = await until(async () => ((await versions()).length === 1 ? true : null))
    t.check('a finished turn saves version 1', !!one, await versions())

    writeFileSync(`${BRIEF}/index.html`, '<!doctype html><h1 id="t">third draft</h1>')
    hookWord(DIR, agent.sessionId, 'working')
    await sleep(600)
    hookWord(DIR, agent.sessionId, 'done')
    const two = await until(async () => ((await versions()).length === 2 ? true : null))
    t.check('the next finished turn saves version 2', !!two, await versions())

    hookWord(DIR, agent.sessionId, 'working')
    await sleep(600)
    hookWord(DIR, agent.sessionId, 'done')
    await sleep(1500)
    t.equal('a turn that changed nothing saves no version', (await versions()).length, 2)

    // A turn that has only started is not a version: the edit waits for its end.
    writeFileSync(`${BRIEF}/index.html`, '<!doctype html><h1 id="t">mid-turn draft</h1>')
    hookWord(DIR, agent.sessionId, 'working')
    await sleep(1500)
    t.equal('a turn still running saves nothing', (await versions()).length, 2)
    hookWord(DIR, agent.sessionId, 'done')
    const three = await until(async () => ((await versions()).length === 3 ? true : null))
    t.check('and its end saves the edit as version 3', !!three, await versions())

    const options = await win
      .frameLocator('[data-testid="slideless-artefact"]')
      .locator('#sel option')
      .allTextContents()
    t.check(
      'the panel’s version bar lists both versions',
      options.some((o) => o.startsWith('v1 ')) && options.some((o) => o.startsWith('v2 ')),
      options
    )
    const stored = path.join(DIR, 'slideless', 'versions')
    t.check('the versions are kept in Clave’s own store, never in the folder', existsSync(stored))
    t.check('nothing was written into the artefact folder', !existsSync(`${BRIEF}/.slideless`))

    const again = await client.call('clave_open_side_panel', { path: BRIEF })
    t.check('opening the folder again is harmless', !toolErrored(again), again)

    // The Source view keeps the server: a turn ended there still saves a version.
    await win.getByRole('button', { name: 'Source', exact: true }).click()
    writeFileSync(`${BRIEF}/index.html`, '<!doctype html><h1 id="t">edited under Source</h1>')
    hookWord(DIR, agent.sessionId, 'working')
    await sleep(600)
    hookWord(DIR, agent.sessionId, 'done')
    const four = await until(async () => ((await versions()).length === 4 ? true : null))
    t.check(
      'a turn ended while the panel shows Source still saves a version',
      !!four,
      await versions()
    )
    await win.getByRole('button', { name: 'Rendered', exact: true }).click()

    // Closing the session lets go of its server.
    const up = (url) =>
      fetch(url).then(
        () => true,
        () => false
      )
    await callMcp(app, 'closeSession', { sessionId: agent.sessionId })
    const stopped = await until(async () => ((await up(src)) ? null : true))
    t.check('closing the session stops its Slideless server', !!stopped)

    // Another agent shows the same folder: one server again, for the quit below.
    const second = await spawnAgentTabIn(app, win, DIR)
    const client2 = mcpHttpClient(mcpEndpoint(DIR), second.token)
    await client2.init()
    await client2.call('clave_open_side_panel', { path: BRIEF })
    await frame.waitFor({ state: 'visible', timeout: 20000 })
    liveSrc = await frame.getAttribute('src')
    t.check(
      'another session shows it again on a server of its own',
      !!(await until(() => up(liveSrc))),
      liveSrc
    )
  } finally {
    await app.close()
    reg.server.close()
  }
  const quitDown = await until(async () =>
    (await fetch(liveSrc).then(
      () => true,
      () => false
    ))
      ? null
      : true
  )
  t.check('quitting Clave stops every Slideless server it started', !!quitDown, liveSrc)

  // ── Part two: no Slideless, the page as before under the install card; it
  // still follows its file (PRDCT-4261).
  const DIR2 = userDataDir('slideless-artefacts-missing')
  const ROOT2 = fixturePath('slideless-artefacts-missing-root')
  rmSync(ROOT2, { recursive: true, force: true })
  mkdirSync(ROOT2, { recursive: true })
  writeFileSync(`${ROOT2}/page.html`, '<h1>before</h1>')
  writeFileSync(`${ROOT2}/notes.md`, '# Notes\n\nfirst words\n')
  const WS2 = { ...WS, id: 'aaaa0000-0000-4000-8000-000000000432', rootDir: ROOT2 }
  seedWorkspaces(DIR2, { workspaces: [WS2], activeWorkspaceId: WS2.id, fresh: true })
  seedTrustedRoots(DIR2, [ROOT2])
  ;({ app, win } = await launchApp(DIR2, {
    server: 'in-process',
    env: { CLAVE_TEST_SLIDELESS_REGISTRY: '', CLAVE_SLIDELESS_CLI: '' }
  }))
  try {
    await fakeAgent(win, ROOT2, WS2.id)
    const agent = await spawnAgentTabIn(app, win, DIR2)
    const client = mcpHttpClient(mcpEndpoint(DIR2), agent.token)
    await client.init()
    t.check(
      'the agent opens a plain HTML file',
      !toolErrored(await client.call('clave_open_side_panel', { path: `${ROOT2}/page.html` }))
    )
    const card = win.locator('[data-testid="slideless-install-card"]')
    await card.waitFor({ state: 'visible', timeout: 10000 })
    t.check(
      'without Slideless the panel offers to install it, in one button',
      (await card.getByRole('button', { name: 'Install Slideless' }).count()) === 1
    )
    const previewText = () =>
      win
        .frameLocator('[data-testid="linked-document-panel"] iframe[sandbox="allow-scripts"]')
        .locator('h1')
        .textContent({ timeout: 2000 })
        .catch(() => null)
    t.equal('and still shows the page', await until(previewText), 'before')
    writeFileSync(`${ROOT2}/page.html`, '<h1>after the agent edit</h1>')
    const followed = await until(async () =>
      (await previewText()) === 'after the agent edit' ? true : null
    )
    t.check(
      'an agent’s edit to the file reloads the panel within seconds',
      !!followed,
      await previewText()
    )

    // Markdown follows its file the same way.
    t.check(
      'the agent opens a Markdown file',
      !toolErrored(await client.call('clave_open_side_panel', { path: `${ROOT2}/notes.md` }))
    )
    const editor = win.locator('[data-testid="linked-document-panel"] .markdown-page-content')
    await editor.waitFor({ state: 'visible', timeout: 10000 })
    const editorText = () => editor.textContent().catch(() => '')
    t.check(
      'it shows the file',
      !!(await until(async () => (await editorText()).includes('first words')))
    )
    writeFileSync(`${ROOT2}/notes.md`, '# Notes\n\nthe agent rewrote this\n')
    t.check(
      'an agent’s edit to a Markdown file reloads it too',
      !!(await until(async () => (await editorText()).includes('the agent rewrote this'))),
      await editorText()
    )

    // A file gone for a moment (a checkout, an agent's rm then write) never
    // locks the panel, and the panel follows it back.
    rmSync(`${ROOT2}/notes.md`)
    await sleep(1200)
    const alerts = await win.locator('[data-testid="linked-document-panel"] [role="alert"]').count()
    t.equal('a deleted file raises no error in the panel', alerts, 0)
    writeFileSync(`${ROOT2}/notes.md`, '# Notes\n\nback again\n')
    t.check(
      'and the recreated file shows',
      !!(await until(async () => (await editorText()).includes('back again'))),
      await editorText()
    )
    const read = await client.call('clave_side_panel', { action: 'read' })
    t.check(
      'the agent still reads the panel',
      !toolErrored(read) && JSON.stringify(toolPayload(read)).includes('back again'),
      read
    )

    // The panel's own saves never reload it under the person's cursor.
    await editor.locator('p').last().click()
    await win.keyboard.press('End')
    for (const ch of ['x', 'y', 'z']) {
      await win.keyboard.type(ch)
      await sleep(700)
    }
    const typed = await editorText()
    const focused = await win.evaluate(() =>
      Boolean(document.activeElement?.closest('.markdown-page-content'))
    )
    t.check('typing through three saves keeps every key', typed.includes('back againxyz'), typed)
    t.check('and keeps the focus in the editor', focused)
    t.check(
      'and the keys reach the file',
      !!(await until(() => readFileSync(`${ROOT2}/notes.md`, 'utf8').includes('xyz')))
    )
  } finally {
    await app.close()
  }
}
