#!/usr/bin/env node
// Product screenshots of the REAL Clave app for the website.
//
//   npx electron-vite build && node scripts/website-shots/capture.mjs --out <dir>
//
// It launches the built app on an isolated user-data folder (the e2e harness,
// `--test-no-activate`: no window on screen, no Dock icon, nothing of the
// installed Clave touched), stages a fixed scene (a workspace on a small shop
// project, three sidebar groups, a Claude chat tab fed by a stand-in CLI, a
// Codex-like reviewer tab, a dev server with the group's live view), and
// captures each shot at 2x. No model is ever called. See README.md.
//
// Exit 0 only when every required shot was written at its expected pixel size.
import assert from 'node:assert/strict'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The fixture namespace must be set before the harness (and namespace.mjs)
// read it: every folder of this run lives under /tmp/<namespace>/.
process.env.CLAVE_E2E_NS ||= 'website-shots'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  callMcp,
  until,
  fixturePath,
  fixtureRoot,
  freePorts
} = await import('../../tests/e2e/harness.mjs')

// ── Options ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}
const OUT = path.resolve(opt('--out', '/tmp/clave-shots'))
const KEEP = argv.includes('--keep') // leave the fixture folder for inspection
const SCALE = 2

// ── The scene ────────────────────────────────────────────────────────────────
// `real: true`: /private/tmp, so git's resolved repo root matches the path the
// app discovers (the /tmp symlink otherwise makes the repo look nested).
const NS_ROOT = fixtureRoot({ real: true })
const DATA = fixturePath('userdata', { real: true })
const ROOT = path.join(NS_ROOT, 'atelier-nord') // the workspace: the shop project
const BIN = fixturePath('bin', { real: true }) // stand-in CLIs, first on PATH
const HOME_STUBS = fixturePath('history', { real: true }) // empty transcript roots
const WS = {
  id: 'a7e1e000-0000-4000-8000-0000000a7e11',
  name: 'Atelier Nord',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const PLAN = path.join(ROOT, 'docs', 'checkout-plan.md')

const SHOTS = [
  { file: 'hero.png', width: 1440, height: 900, required: true },
  { file: 'chat.png', width: 1200, height: 800, required: true },
  { file: 'side-panel.png', width: 1200, height: 800, required: true },
  { file: 'group-view.png', width: 1200, height: 800, required: true },
  { file: 'git.png', width: 1200, height: 800, required: false },
  { file: 'chat-permission.png', width: 1200, height: 800, required: true }
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[shots]', ...a)

function git(...args) {
  execFileSync(
    'git',
    [
      '-C',
      ROOT,
      '-c',
      'user.name=Lena Maes',
      '-c',
      'user.email=lena@atelier-nord.example',
      ...args
    ],
    {
      stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    }
  )
}

/** The shop project as a git repo: four commits, one uncommitted change. */
function stageProject() {
  const src = path.join(HERE, 'project')
  const put = (...rels) => {
    for (const rel of rels) {
      mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true })
      cpSync(path.join(src, rel), path.join(ROOT, rel))
    }
  }
  mkdirSync(ROOT, { recursive: true })
  git('init', '-q', '-b', 'main')
  const commit = (message, date) =>
    execFileSync(
      'git',
      [
        '-C',
        ROOT,
        '-c',
        'user.name=Lena Maes',
        '-c',
        'user.email=lena@atelier-nord.example',
        'commit',
        '-qm',
        message
      ],
      {
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
          GIT_CONFIG_GLOBAL: '/dev/null'
        }
      }
    )
  put('package.json', 'README.md', 'server.mjs', 'public/index.html')
  writeFileSync(path.join(ROOT, '.gitignore'), 'node_modules\n')
  git('add', '-A')
  commit('Scaffold the shop and its dev server', '2026-09-28T09:12:00+02:00')
  put('src/cart/cart.ts', 'test-watch.mjs')
  git('add', '-A')
  commit('Cart: line items, subtotal and free shipping threshold', '2026-09-30T14:40:00+02:00')
  put(
    'src/checkout/CheckoutForm.tsx',
    'src/checkout/address.ts',
    'src/checkout/orderDraft.ts',
    'src/lib/validate.ts'
  )
  git('add', '-A')
  commit('Checkout form with email validation', '2026-10-02T11:05:00+02:00')
  put('docs/checkout-plan.md')
  git('add', '-A')
  commit('Plan the checkout address validation', '2026-10-05T16:22:00+02:00')
  git('checkout', '-q', '-b', 'lane/checkout')
  // The uncommitted change the git shot shows.
  cpSync(path.join(HERE, 'changes', 'validate.ts'), path.join(ROOT, 'src/lib/validate.ts'))
}

/** Stand-in CLIs on PATH: `claude` (stream-json) and a login-shell shim. */
function stageBin() {
  mkdirSync(BIN, { recursive: true })
  writeFileSync(
    path.join(BIN, 'claude'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(HERE, 'fake-claude.cjs')}" "$@"\n`
  )
  chmodSync(path.join(BIN, 'claude'), 0o755)
  // The login-shell probe must keep the stub-first PATH (as the e2e specs do),
  // and an interactive shell gets a quiet, plausible prompt and no rc files.
  writeFileSync(
    path.join(BIN, 'bash'),
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; exit 0; fi\n' +
      "export BASH_SILENCE_DEPRECATION_WARNING=1 PS1='atelier-nord % '\n" +
      'shift; exec /bin/bash --noprofile --norc "$@"\n'
  )
  chmodSync(path.join(BIN, 'bash'), 0o755)
  mkdirSync(path.join(HOME_STUBS, 'claude'), { recursive: true })
  mkdirSync(path.join(HOME_STUBS, 'codex'), { recursive: true })
  mkdirSync(path.join(HOME_STUBS, 'pi'), { recursive: true })
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
/** tmux sessions on the app's socket whose start path is under this run's
 *  namespace: the only ones this script may kill, and by exact name. */
function ourTmuxSessions() {
  let rows = ''
  try {
    rows = execFileSync(
      'tmux',
      ['-L', 'clave', 'list-sessions', '-F', '#{session_name}|#{session_path}'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      }
    )
  } catch {
    return []
  }
  const roots = [NS_ROOT, fixtureRoot()]
  return rows
    .split('\n')
    .filter(Boolean)
    .map((r) => r.split('|'))
    .filter(([, p]) => p && roots.some((root) => p === root || p.startsWith(root + '/')))
    .map(([n]) => n)
}
function killOurTmux() {
  for (const n of ourTmuxSessions()) {
    try {
      execFileSync('tmux', ['-L', 'clave', 'kill-session', '-t', `=${n}`], { stdio: 'ignore' })
    } catch {
      // Gone already.
    }
  }
}
function cleanFixtures() {
  killOurTmux()
  if (!KEEP) rmSync(NS_ROOT, { recursive: true, force: true })
}

// ── Capture ──────────────────────────────────────────────────────────────────
/** Size the window's CONTENT, then wait for layout and motion to settle. */
async function sizeContent(app, win, width, height) {
  await app.evaluate(
    ({ BrowserWindow }, { width, height }) => {
      const w = [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0]
      w.setContentSize(width, height)
    },
    { width, height }
  )
  await until(
    async () => {
      const s = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
      return s.w === width && s.h === height
    },
    { tries: 40, gapMs: 100 }
  )
  await settle(win)
}

/** Fonts loaded, no running animation, two quiet frames. */
async function settle(win, extraMs = 400) {
  await win.evaluate(async () => {
    await document.fonts.ready
    const deadline = performance.now() + 5000
    while (performance.now() < deadline) {
      const running = document
        .getAnimations()
        .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)
      if (!running.length) break
      await new Promise((r) => setTimeout(r, 50))
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
  await sleep(extraMs)
}

/** PNG width and height, read from the IHDR chunk. */
function pngSize(file) {
  const b = readFileSync(file)
  assert.equal(b.toString('ascii', 1, 4), 'PNG', `${file} is not a PNG`)
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

async function shoot(app, win, shot) {
  const file = path.join(OUT, shot.file)
  // The composited window, webviews included, at the device scale factor.
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const w = [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0]
    const image = await w.webContents.capturePage(undefined, { stayHidden: true })
    return image.toPNG().toString('base64')
  })
  writeFileSync(file, Buffer.from(png, 'base64'))
  const size = pngSize(file)
  const want = { width: shot.width * SCALE, height: shot.height * SCALE }
  if (size.width !== want.width || size.height !== want.height) rmSync(file, { force: true })
  assert.deepEqual(
    size,
    want,
    `${shot.file}: ${size.width}x${size.height}, expected ${want.width}x${want.height}`
  )
  log(`${shot.file} ${size.width}x${size.height}`)
  return file
}

// ── The app's chrome: nothing a first run shows, nothing personal ────────────
async function quietChrome(app, win) {
  // A fixed usage reading for the sidebar foot (no account is read).
  await app.evaluate(({ ipcMain }) => {
    const reading = () => ({
      windows: [
        {
          key: 'session:shots',
          label: 'session',
          kind: 'session',
          scope: null,
          usedPercentage: 31,
          resetsAt: Date.now() + 3 * 3600_000,
          severity: null
        },
        {
          key: 'weekly:shots',
          label: 'weekly',
          kind: 'weekly',
          scope: null,
          usedPercentage: 22,
          resetsAt: Date.now() + 4 * 86400_000,
          severity: null
        }
      ],
      fetchedAt: Date.now()
    })
    const h = ipcMain._invokeHandlers
    for (const get of ['usage:get-limits', 'usage:get-codex-limits']) h.set(get, () => reading())
    for (const snap of ['usage:claude-snapshot', 'usage:codex-snapshot'])
      h.set(snap, () => ({ default: reading() }))
  })
  await win.evaluate(async () => {
    localStorage.setItem('clave-theme', 'light')
    localStorage.setItem(
      'clave-user-profile',
      JSON.stringify({ name: 'Lena Maes', avatarIcon: 'bolt', avatarField: 'reef', avatarSeed: 7 })
    )
    await window.electronAPI.telemetrySetNoticeShown()
    await window.electronAPI.feedbackSetCollapsed()
  })
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.locator('.launcher-split .launcher-btn').waitFor()
  await sleep(1500)
  assert.equal(
    await win.evaluate(() => document.documentElement.dataset.theme ?? null),
    'light',
    'light theme'
  )
}

// ── The sidebar, the tabs and the live view ──────────────────────────────────
const ids = {}
let devPort = 0

async function stageScene(app, win) {
  // The Verifier tab's "Codex": the python stand-in, through a launch profile.
  await win.evaluate(
    async (script) => {
      await window.electronAPI.launchProfileUpsert({
        id: 'shots-codex',
        name: 'Codex',
        family: 'codex',
        command: ['/usr/bin/python3', script],
        additionalArgs: []
      })
      await window.electronAPI.launchProfileSetGlobal('codex', 'shots-codex')
    },
    path.join(HERE, 'fake-codex.py')
  )
  ;[devPort] = await freePorts(1)
  const open = async (payload) =>
    (await callMcp(app, 'openSession', { cwd: ROOT, ...payload })).sessionId
  const group = async (name) => (await callMcp(app, 'createGroup', { name })).groupId
  const move = (sessionId, groupId) => callMcp(app, 'moveSession', { sessionId, groupId })

  const checkout = await group('Checkout')
  const storefront = await group('Storefront')
  const docs = await group('Docs')
  ids.groups = { checkout, storefront, docs }

  ids.chat = await open({ mode: 'claude', chat: true, name: 'Lane · checkout' })
  await move(ids.chat, checkout)
  ids.verifier = await open({ mode: 'codex', name: 'Verifier' })
  await move(ids.verifier, checkout)
  ids.dev = await open({
    mode: 'terminal',
    name: 'dev server',
    command: `PORT=${devPort} node server.mjs`,
    autoRun: true
  })
  await move(ids.dev, checkout)
  // The watcher's output comes from a script in the fixture; `clear` wipes
  // the typed command so the tab reads as a running `npm test -- --watch`.
  ids.tests = await open({
    mode: 'terminal',
    name: 'tests',
    command: 'clear; node test-watch.mjs',
    autoRun: true
  })
  await move(ids.tests, checkout)

  // The other groups, so the sidebar looks lived in; collapsed below.
  ids.grid = await open({ mode: 'terminal', name: 'Product grid' })
  await move(ids.grid, storefront)
  ids.story = await open({ mode: 'terminal', name: 'storybook' })
  await move(ids.story, storefront)
  ids.guide = await open({ mode: 'terminal', name: 'Shipping guide' })
  await move(ids.guide, docs)

  // The chat's finished turn.
  await callMcp(app, 'focus', { sessionId: ids.chat })
  await win.getByTestId('chat-view').first().waitFor()
  await win.evaluate(
    (id) =>
      window.electronAPI.sessionsWrite(id, {
        type: 'user_message',
        text: 'Add address validation to the checkout form and run the tests'
      }),
    ids.chat
  )
  assert.ok(
    await until(
      () =>
        win
          .locator('[data-testid="chat-view"] .chat-turn[data-role="assistant"]')
          .filter({ hasText: '41 tests pass' })
          .count(),
      { tries: 80 }
    ),
    'the chat turn rendered'
  )

  // The dev server answers, and has logged a few requests.
  const url = `http://127.0.0.1:${devPort}/checkout`
  assert.ok(
    await until(async () => (await fetch(url).catch(() => null))?.ok, { tries: 60 }),
    'dev server is up'
  )
  for (const p of ['/checkout', '/checkout/shipping'])
    await fetch(`http://127.0.0.1:${devPort}${p}`).catch(() => {})
  await callMcp(app, 'setGroupView', { groupId: checkout, url, title: 'Checkout preview' })

  // Every tab visited once so its terminal has mounted and drawn.
  for (const id of [ids.verifier, ids.dev, ids.tests, ids.grid, ids.story, ids.guide, ids.chat]) {
    await callMcp(app, 'focus', { sessionId: id })
    await sleep(700)
  }

  // Storefront and Docs folded.
  for (const g of [storefront, docs])
    await win.locator(`[data-sidebar-item-id="${g}"] .group-header > .sidebar-tab-icon`).click()
  return win
}

const row = (win, name) =>
  win
    .locator('.sidebar-item')
    .filter({ has: win.locator(`[data-testid="session-tab-name"]:text-is("${name}")`) })
    .first()

async function captureAll(app, win) {
  const shot = (file) => SHOTS.find((s) => s.file === file)
  const attempt = async (file, stage) => {
    const s = shot(file)
    try {
      await sizeContent(app, win, s.width, s.height)
      await stage()
      // Park the pointer in a quiet corner so no row keeps a hover state.
      await win.mouse.move(s.width - 3, s.height - 3)
      await settle(win, 600)
      results.set(file, await shoot(app, win, s))
    } catch (err) {
      results.set(file, err)
      console.error(`[shots] ${file} FAILED: ${err?.message ?? err}`)
    }
  }

  // 1. The three Checkout tabs tiled, as a shift-click selects them.
  await attempt('hero.png', async () => {
    await row(win, 'Lane · checkout').click()
    await row(win, 'tests').click({ modifiers: ['Shift'] })
    assert.ok(
      await until(async () => (await win.locator('.floating-card').count()) >= 4),
      'four tiles'
    )
    // The chat cell opens on the answer's heading, not mid-sentence.
    await settle(win, 300)
    const heading = win
      .locator('[data-testid="chat-view"] h2')
      .filter({ hasText: 'Address validation is in' })
      .first()
    await heading.waitFor()
    const offset = await heading.evaluate((h) => {
      const scroller = h.closest('.chat-scroll')
      scroller.scrollTop +=
        h.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 14
      return h.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    })
    assert.ok(Math.abs(offset - 14) < 2, `the chat cell starts at its heading (offset ${offset})`)
    // Scrolled up, the chat offers its "Scroll to end" button over the code
    // block; hidden for this shot only (removed right after it).
    await win
      .addStyleTag({
        content: '[aria-label="Scroll to end"] { visibility: hidden !important }'
      })
      .then((h) => h.evaluate((el) => (el.id = 'shots-hide-jump')))
    const status = (name) =>
      row(win, name).locator('.sidebar-tab-icon').first().getAttribute('data-status')
    assert.equal(await status('Verifier'), 'needs-you', 'the Verifier tab waits on the user')
    assert.ok(
      ['idle', 'done'].includes(await status('Lane · checkout')),
      'the chat turn is finished'
    )
  })

  // 2. The chat tab alone.
  await win.evaluate(() => document.getElementById('shots-hide-jump')?.remove())
  const toolRun = win.locator('[data-testid="chat-view"] .chat-tool-run > summary').first()
  await attempt('chat.png', async () => {
    await row(win, 'Lane · checkout').click()
    // The grouped tool calls, opened to their five rows.
    await toolRun.click()
    await until(
      async () => (await win.locator('[data-testid="chat-view"] .chat-tool-item').count()) === 5
    )
  })
  await toolRun.click().catch(() => {})

  // 4. The plan in the side panel beside the chat (clave_open_side_panel).
  await attempt('side-panel.png', async () => {
    await callMcp(app, 'openLinkedDocument', { callerSessionId: ids.chat, input: { path: PLAN } })
    await sleep(1500)
  })

  // 3. The group's live view on the dev server.
  await attempt('group-view.png', async () => {
    await win.locator(`[data-sidebar-item-id="${ids.groups.checkout}"] .group-header`).click()
    // The live view's page has loaded: a guest on the dev server, idle.
    const loaded = await until(
      () =>
        app.evaluate(
          ({ webContents }, port) =>
            webContents
              .getAllWebContents()
              .some((wc) => wc.getURL().includes(`:${port}/checkout`) && !wc.isLoading()),
          devPort
        ),
      { tries: 60 }
    )
    assert.ok(loaded, 'the group view loaded the shop page')
    await sleep(800)
  })

  // 5. The git panel on the shop repo, with the uncommitted change's diff.
  await attempt('git.png', async () => {
    await row(win, 'Lane · checkout').click()
    const hide = win.getByLabel('Hide linked document')
    if (await hide.count()) await hide.first().click()
    await win.click('button[title^="File tree"]')
    await win.locator('.panel-tab').filter({ hasText: 'Git' }).first().click()
    const file = win.getByText('validate.ts', { exact: true }).first()
    await file.waitFor({ timeout: 15_000 })
    await file.click()
    await sleep(1500)
  })

  // 2b. The chat tab with a pending Edit permission above the composer.
  await attempt('chat-permission.png', async () => {
    await win.keyboard.press('Escape')
    await win.click('button[title^="File tree"]').catch(() => {})
    await row(win, 'Lane · checkout').click()
    await win.evaluate(
      (id) =>
        window.electronAPI.sessionsWrite(id, {
          type: 'user_message',
          text: 'Also keep the validated address on the order draft'
        }),
      ids.chat
    )
    const prompt = win.locator('[data-testid="chat-view"] .chat-prompt-actions').first()
    await prompt.waitFor({ timeout: 15_000 })
  })
}

// ── Run ──────────────────────────────────────────────────────────────────────
const started = Date.now()
const results = new Map()
let app = null
try {
  cleanFixtures()
  mkdirSync(OUT, { recursive: true })
  for (const s of SHOTS) rmSync(path.join(OUT, s.file), { force: true })
  stageProject()
  stageBin()
  seedWorkspaces(DATA, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DATA, [ROOT])
  ;({ app } = await launchApp(DATA, {
    settleMs: 3000,
    args: [`--force-device-scale-factor=${SCALE}`],
    env: {
      SHELL: path.join(BIN, 'bash'),
      PATH: `${BIN}:${process.env.PATH}`,
      PS1: 'atelier-nord % ',
      BASH_SILENCE_DEPRECATION_WARNING: '1',
      CLAVE_TRANSCRIPTS_ROOT: path.join(HOME_STUBS, 'claude'),
      CLAVE_CODEX_ROOT: path.join(HOME_STUBS, 'codex'),
      CLAVE_PI_ROOT: path.join(HOME_STUBS, 'pi')
    }
  }))
  let win = await app.firstWindow()
  await quietChrome(app, win)
  win = await stageScene(app, win)
  await captureAll(app, win)
} catch (err) {
  console.error('[shots] FAILED:', err?.stack ?? err)
  process.exitCode = 1
} finally {
  if (app) await app.close().catch(() => {})
  cleanFixtures()
}

// What this run left behind: nothing of its own may survive it.
const leftovers = []
if (ourTmuxSessions().length) leftovers.push(`tmux sessions: ${ourTmuxSessions().join(', ')}`)
if (!KEEP && existsSync(NS_ROOT)) leftovers.push(`fixture folder ${NS_ROOT}`)
if (
  devPort &&
  (await fetch(`http://127.0.0.1:${devPort}/`).then(
    () => true,
    () => false
  ))
)
  leftovers.push(`dev server still answering on :${devPort}`)
for (const l of leftovers) console.error(`[shots] LEFT BEHIND: ${l}`)

let failed = process.exitCode === 1 || leftovers.length > 0
for (const s of SHOTS) {
  const r = results.get(s.file)
  const ok = typeof r === 'string'
  if (!ok && s.required) failed = true
  console.log(
    `[shots] ${ok ? 'ok     ' : s.required ? 'MISSING' : 'skipped'} ${s.file}${ok ? '' : ` (${r?.message ?? 'not attempted'})`}`
  )
}
log(
  `${failed ? 'FAILED' : 'all required shots written'} to ${OUT} in ${((Date.now() - started) / 1000).toFixed(1)}s`
)
process.exit(failed ? 1 : 0)
