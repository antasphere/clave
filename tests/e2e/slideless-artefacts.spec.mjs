// HTML artefacts on the server a session runs on (PRDCT-4472, PRDCT-4474), in
// the real app, through the real Slideless. Part one boots a Clave that has
// never seen Slideless with a registry that offers it: the app's server
// installs the command line by itself, an agent opens a folder with
// `clave_open_artefact` through the real MCP, the panel shows it through
// Slideless, an edit reloads it, and each finished turn (the Stop hook's word,
// written where Claude's hook writes it) saves a version ON THE SERVER, the
// panel hidden or not: the window saves nothing. The side panel refuses the
// folder with the sentence that names the tool. The app is then quit and
// launched again on the same data folder: the tab comes back, and its artefact
// with it, the agent opening nothing again. Part two boots a Clave with no
// registry: the panel names this Mac in the install card and shows the page
// under it as before, following its file; Markdown still opens in the side
// panel and follows its file (PRDCT-4261). Part three: a preview that dies is
// held again a few times, then the panel says so.
//
// The command line is the real one: SLIDELESS_E2E_CLI, else the published
// package Clave keeps as a dev dependency, packed here into a registry of one.
// It runs on the in-process server here and on the app's own separate server
// from slideless-artefacts-separate.spec.mjs, which calls `run` with the other
// mode: the artefact is the server's whichever process the server is, and a
// tab in a terminal says a turn ended to both (its Stop hook's word, read by
// the app in-process and by the standalone entry apart from it).
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
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
  serverDataDirOf,
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

/** One turn of the agent: started, then ended (the Stop hook's word). */
async function turn(dir, sessionId) {
  hookWord(dir, sessionId, 'working')
  await sleep(600)
  hookWord(dir, sessionId, 'done')
}

/**
 * An agent tab and its MCP client, on the server that runs the tab: the tab's
 * own MCP config names the endpoint (the app's in-process, the standalone
 * server's MCP in `separate` mode), written in that server's data folder.
 */
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

const REFUSAL = 'An HTML page or a folder opens with clave_open_artefact, not in the side panel.'

export async function run(t, server = 'in-process') {
  t.check('the Slideless command line to test with exists', existsSync(CLI), CLI)
  if (!existsSync(CLI)) return

  // ── Part one: installed by the server, shown through Slideless, a version per turn.
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
  /** The tab still showing the folder at the quit: it comes back with the next launch. */
  let keptId = null
  let { app, win } = await launchApp(DIR, {
    server,
    env: { CLAVE_TEST_SLIDELESS_REGISTRY: reg.url, CLAVE_SLIDELESS_CLI: '' }
  })
  try {
    const ready = await until(async () => {
      const s = await win.evaluate(() => window.electronAPI.artefacts.slidelessState())
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
      'the command line lives in the server’s own data folder',
      existsSync(path.join(serverDataDirOf(DIR), 'slideless', 'cli', reg.version, 'bin.js')),
      serverDataDirOf(DIR)
    )

    await fakeAgent(win, ROOT, WS.id)
    const { agent, client } = await agentClient(app, win, DIR)
    t.check('an authenticated agent tab', !!agent?.token)
    const refused = await client.call('clave_open_side_panel', { path: BRIEF })
    t.check(
      'the side panel refuses a folder with the sentence that names the tool',
      toolErrored(refused) && JSON.stringify(refused).includes(REFUSAL),
      refused
    )
    const opened = await client.call('clave_open_artefact', { path: BRIEF })
    t.check('the real MCP opens a FOLDER as the session’s artefact', !toolErrored(opened), opened)
    t.equal('the tool answers the entry page', toolPayload(opened)?.page, `${BRIEF}/index.html`)

    const panel = win.locator('[data-testid="artefact-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 20000 })
    const frame = win.locator('[data-testid="slideless-artefact"]')
    await frame.waitFor({ state: 'visible', timeout: 20000 })
    const src = await frame.getAttribute('src')
    t.check(
      'the panel frames the local Slideless page',
      /^http:\/\/127\.0\.0\.1:\d+\/\?bar=0$/.test(src),
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

    const versions = () => versionsOf(DIR, BRIEF)
    t.equal('no version before the first turn ends', versions(), 0)
    await turn(DIR, agent.sessionId)
    t.check('a finished turn saves version 1', !!(await until(() => versions() === 1)), versions())

    writeFileSync(`${BRIEF}/index.html`, '<!doctype html><h1 id="t">third draft</h1>')
    await turn(DIR, agent.sessionId)
    t.check(
      'the next finished turn saves version 2',
      !!(await until(() => versions() === 2)),
      versions()
    )

    await turn(DIR, agent.sessionId)
    await sleep(1500)
    t.equal('a turn that changed nothing saves no version', versions(), 2)

    // The versions are chosen from Clave's bar, Slideless's own bar hidden in
    // the frame (PRDCT-4494).
    t.check(
      'the frame asks the preview for its page without Slideless’s bar',
      ((await frame.getAttribute('src')) ?? '').includes('bar=0'),
      await frame.getAttribute('src')
    )
    await win.locator('[aria-label="Version shown"]:visible').click()
    // The menu reads the list again as it opens: its rows arrive a moment after.
    const rows = win.locator('[aria-label="Versions"] [role="menuitem"]')
    const both = (texts) =>
      texts.some((o) => o.startsWith('v1')) && texts.some((o) => o.startsWith('v2'))
    const options =
      (await until(async () => {
        const texts = await rows.allTextContents()
        return both(texts) ? texts : null
      }, 50)) ?? (await rows.allTextContents())
    await win.keyboard.press('Escape')
    t.check(
      'the version chip in the panel’s bar lists both versions',
      options.some((o) => o.startsWith('v1')) && options.some((o) => o.startsWith('v2')),
      options
    )
    t.check('nothing was written into the artefact folder', !existsSync(`${BRIEF}/.slideless`))

    // The server saves the versions: with the panel hidden, a turn still saves one.
    await win.getByRole('button', { name: 'Hide artefact', exact: true }).click()
    await panel.waitFor({ state: 'detached', timeout: 10000 })
    t.check('the panel hides with its button', (await panel.count()) === 0)
    writeFileSync(`${BRIEF}/index.html`, '<!doctype html><h1 id="t">edited while hidden</h1>')
    await turn(DIR, agent.sessionId)
    t.check(
      'a turn ended while the panel is hidden still saves a version, on the server',
      !!(await until(() => versions() === 3)),
      versions()
    )
    await win.getByRole('button', { name: 'Open artefact', exact: true }).click()
    await frame.waitFor({ state: 'visible', timeout: 20000 })
    t.equal(
      'the chip brings the panel back on the latest page',
      await until(async () => ((await deckText()) === 'edited while hidden' ? 'yes' : null)),
      'yes'
    )

    const again = await client.call('clave_open_artefact', { path: BRIEF })
    t.check('opening the folder again is harmless', !toolErrored(again), again)

    // Closing the session lets go of its preview.
    const shown = await frame.getAttribute('src')
    const up = (url) =>
      fetch(url).then(
        () => true,
        () => false
      )
    await callMcp(app, 'closeSession', { sessionId: agent.sessionId })
    const stopped = await until(async () => ((await up(shown)) ? null : true))
    t.check('closing the session stops its Slideless preview', !!stopped)

    // Another agent shows the same folder: one preview again, for the quit below.
    const { agent: agent2, client: client2 } = await agentClient(app, win, DIR)
    keptId = agent2?.sessionId ?? null
    await client2.call('clave_open_artefact', { path: BRIEF })
    await frame.waitFor({ state: 'visible', timeout: 20000 })
    liveSrc = await frame.getAttribute('src')
    t.check(
      'another session shows it again on a preview of its own',
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
  t.check('quitting Clave stops every Slideless preview it started', !!quitDown, liveSrc)

  // The same Clave launched again: the tab that showed the folder comes back
  // (a terminal tab, kept by tmux across the quit), and its artefact with it,
  // the agent opening nothing. The server finds such a tab's record by its id
  // only once the window has taken it back, so a server that forgot the links
  // of the sessions it did not know at start lost this one.
  ;({ app, win } = await launchApp(DIR, {
    server,
    settleMs: 6000,
    env: { CLAVE_TEST_SLIDELESS_REGISTRY: '', CLAVE_SLIDELESS_CLI: '' }
  }))
  try {
    const live = () =>
      win.evaluate(() => window.electronAPI.sessionsList().then((all) => all.map((s) => s.id)))
    const back = await until(async () => ((await live()).includes(keptId) ? true : null), 150)
    t.check('the tab that showed the folder comes back after a restart', !!back, {
      wanted: keptId,
      live: await live()
    })
    const panel = win.locator('[data-testid="artefact-panel"]')
    const shownAgain = await panel
      .waitFor({ state: 'visible', timeout: 20000 })
      .then(() => true)
      .catch(() => false)
    t.check('the artefact comes back with its tab after a restart', shownAgain)
    const deckAgain = () =>
      win
        .frameLocator('[data-testid="slideless-artefact"]')
        .frameLocator('#deck')
        .locator('#t')
        .textContent({ timeout: 2000 })
        .catch(() => null)
    t.equal(
      'its preview shows the deck again',
      await until(async () => ((await deckAgain()) === 'edited while hidden' ? 'yes' : null), 200),
      'yes'
    )
    if (keptId) await callMcp(app, 'closeSession', { sessionId: keptId })
  } finally {
    await app.close()
  }

  // ── Part two: no Slideless, the page as before under the install card,
  // naming this Mac; it still follows its file (PRDCT-4261). Markdown keeps
  // the side panel.
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
    server,
    // Every reload from disk held 3 s in main: the window in which a
    // keystroke crosses one, opened on purpose (round 3 of the review).
    env: {
      CLAVE_TEST_SLIDELESS_REGISTRY: '',
      CLAVE_SLIDELESS_CLI: '',
      CLAVE_TEST_LINKED_RELOAD_HOLD_MS: '3000'
    }
  }))
  try {
    await fakeAgent(win, ROOT2, WS2.id)
    const { client } = await agentClient(app, win, DIR2)
    t.check(
      'the agent opens a plain HTML file as its artefact',
      !toolErrored(await client.call('clave_open_artefact', { path: `${ROOT2}/page.html` }))
    )
    const card = win.locator('[data-testid="slideless-install-card"]')
    await card.waitFor({ state: 'visible', timeout: 10000 })
    t.check(
      'without Slideless the panel offers to install it on this Mac, in one button',
      /on this Mac/.test((await card.textContent()) ?? '') &&
        (await card.getByRole('button', { name: 'Install Slideless' }).count()) === 1,
      await card.textContent()
    )
    const previewText = () =>
      win
        .frameLocator('[data-testid="artefact-panel"] iframe[sandbox="allow-scripts"]')
        .locator('h1')
        .textContent({ timeout: 2000 })
        .catch(() => null)
    t.equal('and still shows the page under the card', await until(previewText), 'before')
    writeFileSync(`${ROOT2}/page.html`, '<h1>after the agent edit</h1>')
    const followed = await until(async () =>
      (await previewText()) === 'after the agent edit' ? true : null
    )
    t.check(
      'an agent’s edit to the file reloads the plain page within seconds',
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
    const editorText = () => editor.textContent({ timeout: 2000 }).catch(() => '')
    t.check(
      'it shows the file',
      !!(await until(async () => (await editorText()).includes('first words')))
    )
    // The panel reconciles once its watch is set, so an edit made in that moment is seen.
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
    await sleep(4000)

    // A key typed while the agent's rewrite is being loaded never erases it.
    const disk = () => readFileSync(`${ROOT2}/notes.md`, 'utf8')
    const alert = win.locator('[data-testid="linked-document-panel"] [role="alert"]')
    writeFileSync(`${ROOT2}/notes.md`, '# Notes\n\nthe agent wrote this during your typing\n')
    // The watcher has seen the write and its reload is held in main.
    await sleep(1000)
    await win.keyboard.type('Q')
    const conflicted = await until(async () =>
      /changed on disk while you typed/.test(
        (await alert.textContent({ timeout: 2000 }).catch(() => '')) ?? ''
      )
        ? true
        : null
    )
    t.check(
      'a key typed during the reload is kept as a conflict',
      !!conflicted,
      await alert.textContent({ timeout: 2000 }).catch(() => '')
    )
    t.check('and the agent’s file is left as it was', disk().includes('during your typing'), disk())
    await editor.click({ timeout: 5000 })
    await win.keyboard.type('R')
    await sleep(1500)
    t.check('the next keys do not erase it either', disk().includes('during your typing'), disk())
    t.check('and the conflict stands', (await alert.count()) > 0)
    // Bounded: with no conflict there is no button, and the check below says so.
    await win
      .getByRole('button', { name: 'Load saved version' })
      .click({ timeout: 5000 })
      .catch(() => {})
    t.check(
      'loading the file shows the agent’s text and ends the conflict',
      !!(await until(async () =>
        (await editorText()).includes('during your typing') && (await alert.count()) === 0
          ? true
          : null
      )),
      await editorText()
    )
  } finally {
    await app.close()
  }

  // ── Part three: a preview that dies is held again a few times, then the
  // panel says so; one that cannot start is started once, its error shown
  // (round 2 of the review of PRDCT-4262: a failing start was restarted forever).
  const DIR3 = userDataDir('slideless-artefacts-dying')
  const ROOT3 = fixturePath('slideless-artefacts-dying-root')
  rmSync(ROOT3, { recursive: true, force: true })
  mkdirSync(`${ROOT3}/deck`, { recursive: true })
  writeFileSync(`${ROOT3}/deck/index.html`, '<h1>deck</h1>')
  const fake = `${ROOT3}/fake-slideless.cjs`
  const starts = `${ROOT3}/starts.log`
  const mode = `${ROOT3}/mode.txt`
  writeFileSync(
    fake,
    `const fs = require('fs'), http = require('http');
fs.appendFileSync(${JSON.stringify(starts)}, 'start\\n');
if (fs.readFileSync(${JSON.stringify(mode)}, 'utf8').trim() === 'fail') { console.error('Error: cannot start'); process.exit(1); }
const a = process.argv.slice(2); const port = Number(a[a.indexOf('--port') + 1]);
http.createServer((q, r) => { r.writeHead(200); r.end('<h1>fake</h1>'); }).listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ url: 'http://127.0.0.1:' + port + '/' }));
  setTimeout(() => process.exit(3), 400);
});`
  )
  writeFileSync(mode, 'die')
  const WS3 = { ...WS, id: 'aaaa0000-0000-4000-8000-000000000433', rootDir: ROOT3 }
  seedWorkspaces(DIR3, { workspaces: [WS3], activeWorkspaceId: WS3.id, fresh: true })
  seedTrustedRoots(DIR3, [ROOT3])
  ;({ app, win } = await launchApp(DIR3, {
    server,
    env: { CLAVE_TEST_SLIDELESS_REGISTRY: '', CLAVE_SLIDELESS_CLI: fake }
  }))
  const count = () =>
    existsSync(starts) ? readFileSync(starts, 'utf8').split('\n').filter(Boolean).length : 0
  try {
    await fakeAgent(win, ROOT3, WS3.id)
    const { client } = await agentClient(app, win, DIR3)
    await client.call('clave_open_artefact', { path: `${ROOT3}/deck` })
    await sleep(8000)
    t.check('a server that died under the panel is served again', count() >= 2, count())
    t.check('at most three times a minute', count() <= 4, count())
    const notice = await win
      .locator('[data-testid="artefact-panel"] [role="alert"]')
      .textContent({ timeout: 2000 })
      .catch(() => '')
    t.check(
      'then the panel says it stopped again and again',
      /stopped again and again/.test(notice ?? ''),
      notice
    )

    writeFileSync(mode, 'fail')
    rmSync(starts, { force: true })
    mkdirSync(`${ROOT3}/other`, { recursive: true })
    writeFileSync(`${ROOT3}/other/index.html`, '<h1>other</h1>')
    await client.call('clave_open_artefact', { path: `${ROOT3}/other` })
    await sleep(5000)
    t.equal('a command line that cannot start is started once, not again and again', count(), 1)
    const failed = await win
      .locator('[data-testid="artefact-panel"] [role="alert"]')
      .textContent({ timeout: 2000 })
      .catch(() => '')
    t.check('and its error shows', /cannot start/.test(failed ?? ''), failed)
  } finally {
    await app.close()
  }
}
