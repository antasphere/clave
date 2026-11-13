/* eslint-disable @typescript-eslint/explicit-function-return-type -- executable look script */
// The states an artefact adds to the app, put on screen in the four themes
// (PRDCT-4474), for a person to look at: the artefact panel with its page,
// the install card (missing, installing, error) and the refusal notice, the
// chip of a hidden artefact (alone and beside a hidden linked document),
// Settings → Software Update → Slideless (this Mac and a connected server),
// and the page the frame shows while a server cannot show it (unreachable,
// refused, gone; in a light and a dark frame).
//
// The real app, hidden (`--test-no-activate` through the harness), on
// throwaway user-data folders under the run's own /tmp namespace, removed at
// the end. Three launches, one after the other: a Mac installing Slideless
// from a registry this script holds (installing, then error, then ready), a
// Mac with no Slideless (missing, then a command line that cannot start), and
// a Mac attached to one standalone server (the server named in the card and
// in Settings, then the server stopped). One PNG per state and theme under
// /tmp/clave-artefact-look/ (never in the repository). Exits non-zero when a
// state cannot be reached.
//
//   npx electron-vite build && node scripts/look-artefact-states.mjs
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

process.env.CLAVE_E2E_NS = 'clave-e2e-artefact-look'
const OUT = '/tmp/clave-artefact-look'
const THEMES = ['dark', 'light', 'coffee', 'charcoal']
const CLI = path.resolve('node_modules/@antasphere/slideless/dist/bin.js')

const {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  mcpEndpoint,
  mcpHttpClient,
  spawnAgentTabIn,
  toolErrored,
  serverDataDirOf,
  fixturePath,
  finishRun,
  until
} = await import('../tests/e2e/harness.mjs')
const { fleetWorld, connectMac, owned, request, showServer } =
  await import('../tests/e2e/fixtures/fleet-world.mjs')
const { awayPage } = await import('../src/main/forwards/away-page.ts')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
function need(what, ok) {
  if (ok) return
  failed++
  throw new Error(`could not reach: ${what}`)
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

/**
 * A registry offering the real Slideless, in one of three moods: `hang` keeps
 * the request open (the machine shows "installing"), `fail` answers 500 (and
 * fails every request held), `ok` serves the release.
 */
async function registry() {
  const version = '0.14.1'
  const tgz = gzipSync(
    tar({
      'package/package.json': JSON.stringify({ name: '@antasphere/slideless', version }),
      'package/dist/bin.js': readFileSync(CLI)
    })
  )
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`
  let mood = 'hang'
  const held = []
  const server = createServer((req, res) => {
    if (req.url === '/@antasphere%2fslideless/latest') {
      if (mood === 'hang') return held.push(res)
      if (mood === 'fail') {
        res.writeHead(500)
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(
        JSON.stringify({
          version,
          dist: { tarball: `http://127.0.0.1:${server.address().port}/slideless.tgz`, integrity }
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
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    set(next) {
      mood = next
      if (next === 'hang') return
      for (const res of held.splice(0)) {
        res.writeHead(500)
        res.end()
      }
    },
    close: () => {
      for (const res of held.splice(0)) res.destroy()
      server.closeAllConnections()
      server.close()
    }
  }
}

/** The away page's three variants, served as the forward serves them. */
async function awayServer() {
  const server = createServer((req, res) => {
    const reason = req.url.slice(1)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(awayPage(['unreachable', 'refused', 'gone'].includes(reason) ? reason : 'gone'))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: (reason) => `http://127.0.0.1:${server.address().port}/${reason}`,
    close: () => {
      server.closeAllConnections()
      server.close()
    }
  }
}

async function theme(win, id) {
  const surface = await win.evaluate(async (id) => {
    const state = await window.electronAPI.skinsActivate(id)
    return state.skins.find((skin) => skin.id === id).tokens['--surface-0'].trim()
  }, id)
  need(
    `the ${id} theme`,
    await until(() =>
      win.evaluate(
        (expected) =>
          document.documentElement.style.getPropertyValue('--surface-0').trim() === expected,
        surface
      )
    )
  )
  // The colour transitions run 150 ms.
  await sleep(400)
}

/** One shot of `locator` (with a margin of the window around it) per theme. */
async function shoot(win, state, locator, { themes = THEMES, pad = 12, before } = {}) {
  await locator.first().waitFor({ state: 'visible', timeout: 20_000 })
  for (const id of themes) {
    await theme(win, id)
    if (before) await before(id)
    const box = await locator.first().boundingBox()
    need(`${state}: a box to shoot`, !!box)
    const view = win.viewportSize()
    const x = Math.max(0, box.x - pad)
    const y = Math.max(0, box.y - pad)
    const file = path.join(OUT, `${state}-${id}.png`)
    await win.screenshot({
      path: file,
      clip: {
        x,
        y,
        width: Math.min(view.width - x, box.width + 2 * pad),
        height: Math.min(view.height - y, box.height + 2 * pad)
      }
    })
    console.log(`  ${file}`)
  }
}

async function openUpdates(win) {
  const usage = win.locator('.sidebar-footer-line').first()
  if (await usage.count()) await usage.click()
  else await win.getByRole('button', { name: 'Settings', exact: true }).click()
  await win.locator('[data-settings-nav-row="updates"]').click()
}

async function closeSettings(win) {
  await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
}

const slidelessSection = (win) =>
  win.locator('section').filter({ has: win.locator('[data-slideless-status]') })

/** The smallest box holding every Slideless row: the section of the settings page. */
async function settingsShot(win, state, rows) {
  await openUpdates(win)
  const status = win.locator('[data-slideless-status]')
  need(
    `${state}: ${rows} Slideless rows`,
    await until(async () => (await status.count()) === rows, { tries: 120 })
  )
  const section = slidelessSection(win).last()
  await section.scrollIntoViewIfNeeded()
  await shoot(win, state, section)
  await closeSettings(win)
}

async function fakeAgent(win, root, wsId) {
  writeFileSync(`${root}/fake-agent.sh`, '#!/bin/sh\nexec sleep 3600\n')
  chmodSync(`${root}/fake-agent.sh`, 0o755)
  await win.evaluate(
    async ({ root, ws }) => {
      await window.electronAPI.launchProfileUpsert({
        id: 'look-fake-claude',
        name: 'Synthetic agent',
        family: 'claude',
        command: [root + '/fake-agent.sh'],
        additionalArgs: []
      })
      await window.electronAPI.launchProfileSetWorkspace(ws, 'claude', 'look-fake-claude')
    },
    { root, ws: wsId }
  )
}

async function agentClient(app, win, dir) {
  const root = serverDataDirOf(dir)
  const agent = await spawnAgentTabIn(app, win, root)
  need('an agent tab', !!agent?.token)
  const config = JSON.parse(
    readFileSync(path.join(root, 'mcp-configs', `${agent.sessionId}.json`), 'utf8')
  )
  const client = mcpHttpClient(config.mcpServers?.clave?.url ?? mcpEndpoint(dir), agent.token)
  await client.init()
  return client
}

function deck(folder, title) {
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    path.join(folder, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 system-ui;margin:40px}h1{font-size:28px}</style>
<h1 id="t">Quarterly review</h1><p>Three numbers, one decision, the next step.</p>`
  )
}

async function launch(name, env) {
  const dir = userDataDir(name)
  const root = fixturePath(`${name}-root`)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const ws = {
    id: 'aaaa0000-0000-4000-8000-000000000474',
    name: 'Look',
    rootDir: root,
    profileFile: null,
    createdAt: 1
  }
  seedWorkspaces(dir, { workspaces: [ws], activeWorkspaceId: ws.id, fresh: true })
  seedTrustedRoots(dir, [root])
  const { app, win } = await launchApp(dir, { server: 'in-process', env })
  await win.setViewportSize({ width: 1280, height: 800 })
  await fakeAgent(win, root, ws.id)
  return { app, win, dir, root }
}

const card = (win) => win.locator('[data-testid="slideless-install-card"]')
const phaseIs = (win, owner, phase) =>
  until(
    () =>
      win.evaluate(
        ({ owner, phase }) =>
          window.electronAPI.artefacts
            .slidelessState(owner === 'local' ? undefined : owner)
            .then((s) => s.phase === phase),
        { owner, phase }
      ),
    { tries: 200 }
  )

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

try {
  // ── A Mac that installs Slideless: installing, error, then the page ──
  console.log('A Mac installing Slideless')
  const reg = await registry()
  let a = null
  try {
    a = await launch('look-install', {
      CLAVE_TEST_SLIDELESS_REGISTRY: reg.url,
      CLAVE_SLIDELESS_CLI: ''
    })
    const { app, win, dir, root } = a
    deck(`${root}/quarterly-review`, 'Quarterly review')
    need('installing on this Mac', await phaseIs(win, 'local', 'installing'))
    const client = await agentClient(app, win, dir)
    need(
      'the artefact opened',
      !toolErrored(await client.call('clave_open_artefact', { path: `${root}/quarterly-review` }))
    )
    const panel = win.locator('[data-testid="artefact-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 20_000 })
    await card(win).waitFor({ state: 'visible', timeout: 20_000 })
    await shoot(win, 'card-installing-this-mac', panel)
    await settingsShot(win, 'settings-installing-this-mac', 1)

    reg.set('fail')
    need('the install failed on this Mac', await phaseIs(win, 'local', 'error'))
    await card(win).getByRole('button', { name: 'Try again' }).waitFor({ timeout: 10_000 })
    await shoot(win, 'card-error-this-mac', panel)
    await settingsShot(win, 'settings-error-this-mac', 1)

    reg.set('ok')
    await card(win).getByRole('button', { name: 'Try again' }).click()
    need('Slideless ready on this Mac', await phaseIs(win, 'local', 'ready'))
    const frame = win.locator('[data-testid="slideless-artefact"]')
    await frame.waitFor({ state: 'visible', timeout: 30_000 })
    need(
      'the deck in the frame',
      await until(
        () =>
          win
            .frameLocator('[data-testid="slideless-artefact"]')
            .frameLocator('#deck')
            .locator('#t')
            .textContent({ timeout: 2000 })
            .then((t) => t === 'Quarterly review')
            .catch(() => false),
        { tries: 120 }
      )
    )
    // The pane: the conversation and the panel beside it.
    const pane = panel.locator('xpath=ancestor::*[contains(@class, "linked-document-frame")][1]')
    await shoot(win, 'panel', (await pane.count()) ? pane : panel, {
      before: async () => {
        // The tooltip of the first icon button, as a person hovering it sees it.
        await panel.getByRole('button', { name: "Open the page's source" }).hover()
        await sleep(900)
      }
    })
    await win.mouse.move(5, 795)
    await settingsShot(win, 'settings-ready-this-mac', 1)

    // Hidden: the chip alone, then beside a hidden linked document.
    await win.getByRole('button', { name: 'Hide artefact', exact: true }).click()
    await panel.waitFor({ state: 'detached', timeout: 10_000 })
    const chip = win.getByRole('button', { name: 'Open artefact', exact: true })
    const chipRow = chip.locator('xpath=..')
    await shoot(win, 'chip-alone', chipRow, { pad: 16 })
    writeFileSync(`${root}/release-notes.md`, '# Release notes\n\nWhat changed this week.\n')
    need(
      'a linked document opened',
      !toolErrored(await client.call('clave_open_side_panel', { path: `${root}/release-notes.md` }))
    )
    await win.locator('[data-testid="linked-document-panel"]').waitFor({ timeout: 10_000 })
    await win.getByRole('button', { name: 'Hide linked document', exact: true }).click()
    await win
      .getByRole('button', { name: 'Open linked document', exact: true })
      .waitFor({ timeout: 10_000 })
    await shoot(win, 'chip-beside-document', chipRow, { pad: 16 })
  } finally {
    await a?.app.close()
    reg.close()
  }

  // ── A Mac with no Slideless, then one whose command line cannot start ──
  console.log('A Mac with no Slideless')
  let b = null
  try {
    const cliDir = fixturePath('look-missing-cli')
    rmSync(cliDir, { recursive: true, force: true })
    mkdirSync(cliDir, { recursive: true })
    const fake = path.join(cliDir, 'slideless.cjs')
    b = await launch('look-missing', {
      CLAVE_TEST_SLIDELESS_REGISTRY: '',
      CLAVE_SLIDELESS_CLI: fake
    })
    const { app, win, dir, root } = b
    deck(`${root}/quarterly-review`, 'Quarterly review')
    const client = await agentClient(app, win, dir)
    need(
      'the artefact opened',
      !toolErrored(await client.call('clave_open_artefact', { path: `${root}/quarterly-review` }))
    )
    const panel = win.locator('[data-testid="artefact-panel"]')
    await card(win).waitFor({ state: 'visible', timeout: 20_000 })
    await shoot(win, 'card-missing-this-mac', panel)
    await settingsShot(win, 'settings-missing-this-mac', 1)

    // The command line appears and cannot start: the hold is refused.
    writeFileSync(fake, "console.error('Error: the preview could not start'); process.exit(1)\n")
    // The window reads a machine's Slideless once: a reload reads it again.
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    const alert = win.locator('[data-testid="artefact-panel"] [role="alert"]')
    await alert.waitFor({ state: 'visible', timeout: 20_000 })
    await shoot(win, 'card-refusal', panel)
  } finally {
    await b?.app.close()
  }

  // ── A Mac attached to a server: the server named, then the server away ──
  console.log('A Mac attached to a server')
  const reg2 = await registry()
  const away = await awayServer()
  const world = await fleetWorld('look-fleet', {
    count: 1,
    env: { CLAVE_TEST_SLIDELESS_REGISTRY: reg2.url, CLAVE_SLIDELESS_CLI: '' }
  })
  try {
    const [server] = world.servers
    const DECK = path.join(server.root, 'quarterly-review')
    deck(DECK, 'Quarterly review')
    await request(server, '/launch-profiles', {
      profile: {
        id: 'look-stub',
        name: 'Look stream stub',
        family: 'claude',
        command: [process.execPath, path.resolve('tests/e2e/fixtures/claude-stream-stub.mjs')],
        additionalArgs: []
      }
    })
    const started = await request(server, '/sessions/start', {
      cwd: server.root,
      options: { claudeMode: true, launchProfileId: 'chat:claude:look-stub' }
    })
    await request(server, '/artefacts/open', { sessionId: started.id, path: DECK })
    const mac = await world.mac('a', {
      env: { CLAVE_TEST_SLIDELESS_REGISTRY: '', CLAVE_SLIDELESS_CLI: '' }
    })
    const { win } = mac
    await win.setViewportSize({ width: 1280, height: 800 })
    await connectMac(mac, world.servers, { ui: false })
    const owner = mac.owners[0].id
    await showServer(mac, 0)
    await win.locator(`[data-sidebar-item-id="${owned('session', owner, started.id)}"]`).click()
    const panel = win.locator('[data-testid="artefact-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 30_000 })
    need('installing on the server', await phaseIs(win, owner, 'installing'))
    await card(win).waitFor({ state: 'visible', timeout: 20_000 })
    await shoot(win, 'card-installing-server', panel)
    await settingsShot(win, 'settings-two-machines', 2)

    reg2.set('fail')
    need('the install failed on the server', await phaseIs(win, owner, 'error'))
    await card(win).getByRole('button', { name: 'Try again' }).waitFor({ timeout: 10_000 })
    await shoot(win, 'card-error-server', panel)
    await settingsShot(win, 'settings-two-machines-error', 2)

    reg2.set('ok')
    await card(win).getByRole('button', { name: 'Try again' }).click()
    need('Slideless ready on the server', await phaseIs(win, owner, 'ready'))
    const frame = win.locator('[data-testid="slideless-artefact"]')
    await frame.waitFor({ state: 'visible', timeout: 30_000 })

    await server.stop()
    const heading = () =>
      win
        .frameLocator('[data-testid="slideless-artefact"]')
        .locator('h1')
        .first()
        .textContent({ timeout: 2000 })
        .catch(() => null)
    need(
      'the frame saying the server cannot be reached',
      await until(async () => /cannot reach/.test((await heading()) ?? ''), { tries: 120 })
    )
    // The away page follows the system's appearance, not the app's theme: a
    // light system under the light theme, a dark one under the dark theme.
    // A hidden test window does not follow nativeTheme, so the appearance is
    // emulated (it reaches the frame's own process too).
    const scheme = async (id) => {
      await win.emulateMedia({ colorScheme: id === 'dark' ? 'dark' : 'light' })
      await sleep(800)
    }
    await shoot(win, 'away-unreachable', panel, { themes: ['light', 'dark'], before: scheme })
    for (const reason of ['refused', 'gone']) {
      await frame.evaluate((el, url) => el.setAttribute('src', url), away.url(reason))
      await shoot(win, `away-${reason}`, panel, {
        themes: ['light', 'dark'],
        before: async (id) => {
          await scheme(id)
          await frame.evaluate((el, url) => el.setAttribute('src', url), away.url(reason))
          await sleep(800)
        }
      })
    }
    await win.emulateMedia({ colorScheme: null })
  } finally {
    await world.close()
    reg2.close()
    away.close()
  }
} catch (error) {
  failed = Math.max(failed, 1)
  console.error(String(error?.stack ?? error))
} finally {
  finishRun({ failed })
}
if (!existsSync(OUT)) failed = 1
console.log(failed ? 'FAILED' : `done: ${OUT}`)
process.exit(failed ? 1 : 0)
