/**
 * A group a person makes names itself after the projects its tabs work on
 * (PRDCT-5179), on the built app, against a stub of TypeSafe on a local port
 * (`CLAVE_JEV_BASE_URL`, honoured under the harness only): nothing here
 * reaches the service, and every key, project, person and path is invented.
 *
 * The workspace holds three projects, Quill, Atlas and Lumen: the groups of
 * its TRUSTED `.clave` file, each with a folder of its own and a prompt that
 * says what it is. Every tab is a Claude Code tab whose `claude` is a
 * stand-in that waits; what a tab said and what its tools touched is a
 * transcript seeded where the app reads one (`CLAVE_TRANSCRIPTS_ROOT`). The
 * stub records every request it gets (the path, whether the bearer is exactly
 * the good key, the body) and answers a decision from a table the spec sets
 * per step, keyed on a word of the tab's first message.
 *
 * Each road is proven by what the STUB RECEIVED and what the WINDOW SHOWS:
 *
 *  1. the key: a wrong one is refused in the stub's words; the good one is set
 *     and checked, with `/v1/models` asked under its bearer and no decision;
 *  2. the switch: Settings → Helpers lists « Tab project », on;
 *  3. one project: two Quill tabs grouped by the keymap are « Group N » at
 *     once, then « Quill »; one request per tab, each body carrying the tab's
 *     own first message, no absolute path anywhere, relative folder keys and
 *     the three projects as the criteria;
 *  4. two projects (grouped from the sidebar's menu): « Atlas | Quill », the
 *     larger mean share first, which is not the tabs' order;
 *  5. a close call (0.63 / 0.23): the name stays, two chips with the shares,
 *     a click on the first names the group and the chips go;
 *  6. no project (`fits` 0.20): nothing named, nothing suggested;
 *  7. a person's name is theirs: renamed by hand, a tab dragged in moves
 *     nothing and asks nothing;
 *  8. a group Clave named follows its tabs: « Quill » → « Quill | Atlas »;
 *  9. the same tabs ask nothing twice: ungrouped and grouped again;
 * 10. switched off: « Group N », the server answers `disabled`, no request;
 * 11. no key: « Group N », the server answers `no-key`, no request;
 * 12. a restart: the readings still on the records (`clave_list`), the names
 *     kept, and no request at boot, though one group was never read and one
 *     tab's transcript moved while the app was down. Run it attached too
 *     (`CLAVE_E2E_SERVER=attached`), where the tabs come back after the boot;
 * 13. an agent's group (`clave_create_group`, `clave_move_session`) keeps the
 *     name it was given, and nothing is asked for it.
 */
import { createServer } from 'node:http'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  callMcp,
  mcpHttpClient,
  mcpEndpoint,
  toolPayload,
  toolErrored,
  until,
  userDataDir,
  fixturePath,
  serverDataDirOf,
  serverMode,
  killLeakedE2eTmux
} from './harness.mjs'
import { runKeychain } from './fixtures/run-keychain.mjs'

export const deadlineMs = 15 * 60 * 1000

const DIR = userDataDir('decisions-tab-project')
const ROOT = fixturePath('decisions-tab-project-root')
const BIN = fixturePath('decisions-tab-project-bin')
const TRANSCRIPTS = fixturePath('decisions-tab-project-transcripts')
const CLAVE = path.join(ROOT, '.clave', 'workspaces', 'default.clave')
const WS = {
  id: 'dcdcdcdc-0000-4000-8000-000000005179',
  name: 'Decisions',
  rootDir: ROOT,
  profileFile: CLAVE,
  createdAt: 1
}
const MODE = serverMode()
const MAC = process.platform === 'darwin'
// A server of its own process files its secrets in a keychain FILE of the
// run's own, never a personal keychain (fixtures/run-keychain.mjs).
const OWN_SERVER = MODE !== 'in-process'
const keychain = runKeychain(fixturePath('decisions-tab-project-keychain/e2e.keychain-db'))

const GOOD = 'ts-test-good-key-quill-atlas-lumen'
const WRONG = 'ts-test-wrong-key'
const MODEL = 'jev-1.14.0'
/** Long enough for the naming's debounce (300 ms), a request and its answer. */
const SETTLE_MS = 2500

const P = (rel) => path.join(ROOT, rel)

/** The three projects: the groups of the workspace's `.clave` file. */
const PROJECTS = [
  {
    name: 'Quill',
    cwd: 'quill',
    prompt:
      'Quill is a markdown editor for writers: the ink parser that reads a page, the preview pane beside it and the export to PDF.'
  },
  {
    name: 'Atlas',
    cwd: 'atlas',
    prompt:
      'Atlas is a map tile server: it cuts tiles from a world map, keeps them in a cache and serves them to the viewer by projection.'
  },
  {
    name: 'Lumen',
    cwd: 'lumen',
    prompt:
      'Lumen is the photo library of a small studio: albums, the lightbox where a client picks prints, and the print orders.'
  }
]

/** What each kind of tab said and touched. A Quill tab names an absolute
 *  path of the workspace and a home folder in its FIRST message, which the
 *  app must make relative before anything leaves. */
const SAY = {
  quill: (n) => ({
    first: `Quill ${n}: the ink parser in ${P('quill/src/ink.ts')} drops the heading after a table. My notes are in /Users/ada/notes/quill.md, read them first.`,
    latest: [`Run the ink tests again in ${P('quill')}.`],
    touched: [P('quill/src/ink.ts'), P('quill/src/ink.ts'), P('quill/README.md')]
  }),
  atlas: (n) => ({
    first: `Atlas ${n}: the tile cache in ${P('atlas/cache/tiles.go')} serves a stale tile after a reprojection.`,
    latest: [],
    touched: [P('atlas/cache/tiles.go'), P('atlas/cache/tiles_test.go')]
  }),
  close: {
    first: 'The lightbox shows the wrong print size for an order placed from the map view.',
    latest: [],
    touched: [P('lumen/web/lightbox.tsx'), P('atlas/web/map.tsx')]
  },
  train: {
    first: 'Book me a train to Lyon on Friday morning, back on Sunday evening.',
    latest: [],
    touched: []
  }
}
/** A Quill tab's first message as it must leave: relative, home as `~`. */
const sentFirst = (n) =>
  `Quill ${n}: the ink parser in quill/src/ink.ts drops the heading after a table. My notes are in ~/notes/quill.md, read them first.`
const QUILL_FOLDERS = { 'quill/src': 2, quill: 1 }

const shares = (quill, atlas, lumen) => ({ Quill: quill, Atlas: atlas, Lumen: lumen })
const ANSWERS = {
  quill: { probabilities: shares(0.97, 0.02, 0.01), fits: 0.95 },
  atlas: { probabilities: shares(0.05, 0.93, 0.02), fits: 0.94 },
  lightbox: { probabilities: shares(0.14, 0.23, 0.63), fits: 0.9 },
  // The choice still names a project at 0.97; the companion question says no.
  train: { probabilities: shares(0.97, 0.02, 0.01), fits: 0.2 }
}

/** Every string that would be an absolute path of this machine in a body. */
function absoluteMarks() {
  const marks = new Set([
    ROOT,
    TRANSCRIPTS,
    os.homedir(),
    '/Users/',
    '/home/',
    '/private/',
    '/tmp/'
  ])
  try {
    marks.add(realpathSync(ROOT))
  } catch {
    // Not created yet: the run creates it before any request.
  }
  return [...marks]
}

// ── The stub of TypeSafe ────────────────────────────────────────────────────

function answerOf(entry) {
  const ranked = Object.entries(entry.probabilities).sort((a, b) => b[1] - a[1])
  return {
    model: MODEL,
    answers: {
      project: {
        type: 'choice',
        choice: ranked[0][0],
        confidence: ranked[0][1],
        probabilities: entry.probabilities
      },
      fits: { type: 'noul', noul: entry.fits }
    },
    usage: { input_tokens: 812, output_tokens: 4 }
  }
}

/** `GET /v1/models` (200 for the good key, 401 in TypeSafe's words for any
 *  other) and `POST /v1/systemone` (the table's answer for the first word of
 *  it the tab's first message holds). Every request is recorded. While
 *  `hold()` is on, the decisions' answers wait for `release()`. */
function startStub() {
  const seen = []
  const waiting = []
  const state = { holding: false, table: {} }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const { pathname } = new URL(req.url, 'http://stub')
      let body = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = { unparsed: raw }
      }
      const authOk = req.headers.authorization === `Bearer ${GOOD}`
      seen.push({ method: req.method, path: pathname, authOk, body, raw })
      const json = (status, payload) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
      if (!authOk) return json(401, { detail: 'Invalid API key' })
      if (req.method === 'GET' && pathname === '/v1/models')
        return json(200, { data: [{ id: MODEL }, { id: 'jev-latest' }] })
      if (req.method === 'POST' && pathname === '/v1/systemone') {
        const first = String(body?.state?.sessions?.[0]?.first_message ?? '').toLowerCase()
        const word = Object.keys(state.table).find((w) => first.includes(w))
        const answer = () =>
          json(
            200,
            answerOf(
              word ? state.table[word] : { probabilities: shares(0.34, 0.33, 0.33), fits: 0.1 }
            )
          )
        if (state.holding) return waiting.push(answer)
        return answer()
      }
      return json(404, { detail: 'Not Found' })
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        seen,
        /** The decisions asked so far, oldest first. */
        decisions: () => seen.filter((r) => r.path === '/v1/systemone'),
        /** The table for the steps to come, merged over the last one. */
        answer: (entries) => Object.assign(state.table, entries),
        hold: () => (state.holding = true),
        release: () => {
          state.holding = false
          for (const answer of waiting.splice(0)) answer()
        },
        close: () => new Promise((done) => server.close(() => done()))
      })
    )
  )
}

// ── The workspace, the stand-in agent, the transcripts ──────────────────────

function seedFixture() {
  for (const dir of [ROOT, BIN, TRANSCRIPTS]) rmSync(dir, { recursive: true, force: true })
  for (const project of PROJECTS) mkdirSync(P(project.cwd), { recursive: true })
  mkdirSync(path.dirname(CLAVE), { recursive: true })
  writeFileSync(
    CLAVE,
    JSON.stringify(
      {
        groups: PROJECTS.map((p) => ({
          name: p.name,
          cwd: p.cwd,
          prompt: p.prompt,
          sessions: [],
          terminals: []
        }))
      },
      null,
      2
    )
  )
  mkdirSync(BIN, { recursive: true })
  mkdirSync(TRANSCRIPTS, { recursive: true })
  // A `claude` that only waits (a one-shot `-p` answers a line and ends), and
  // a login shell that puts it first on PATH.
  writeFileSync(
    path.join(BIN, 'claude'),
    `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "-p" ]; then cat > /dev/null; echo "A stand-in title"; exit 0; fi
done
echo "stand-in claude $CLAVE_SESSION_ID"
exec tail -f /dev/null
`,
    { mode: 0o755 }
  )
  writeFileSync(
    path.join(BIN, 'sh'),
    `#!/bin/sh
export PATH='${BIN}':"$PATH"
[ "$1" = '-l' ] && shift
exec /bin/sh "$@"
`,
    { mode: 0o755 }
  )
}

const transcriptOf = (tab) =>
  path.join(TRANSCRIPTS, tab.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${tab.sid}.jsonl`)

/** The tab's transcript as Claude Code writes one: what the person said, and
 *  the agent's tool calls with their results. */
function writeTranscript(tab) {
  const file = transcriptOf(tab)
  mkdirSync(path.dirname(file), { recursive: true })
  const at = (n) => new Date(Date.now() - 3_600_000 + n * 1000).toISOString()
  const lines = [
    {
      type: 'user',
      cwd: tab.cwd,
      timestamp: at(0),
      message: { role: 'user', content: tab.say.first }
    }
  ]
  tab.say.touched.forEach((file, i) => {
    const id = `toolu_${i}`
    lines.push(
      {
        type: 'assistant',
        timestamp: at(i + 1),
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: file } }]
        }
      },
      {
        type: 'user',
        timestamp: at(i + 1),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }]
        }
      }
    )
  })
  for (const said of tab.say.latest)
    lines.push({ type: 'user', timestamp: at(50), message: { role: 'user', content: said } })
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
}

/** One more thing the person said, appended as a tab that kept working would. */
function appendSaid(tab, said) {
  appendFileSync(
    transcriptOf(tab),
    JSON.stringify({
      type: 'user',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: said }
    }) + '\n'
  )
}

// ── The window ──────────────────────────────────────────────────────────────

const rowSel = (id) => `[data-sidebar-item-id="${id}"]`
const textOf = async (locator) => ((await locator.textContent()) ?? '').trim()

const groupsNow = (win) =>
  win.evaluate(() =>
    window.__claveSessionStoreForTests.getState().groups.map((g) => ({
      id: g.id,
      name: g.name,
      sessionIds: [...g.sessionIds],
      autoNamed: g.autoNamed === true
    }))
  )
const groupOfTab = async (win, id) =>
  (await groupsNow(win)).find((g) => g.sessionIds.includes(id)) ?? null
const sessionOf = (win, id) =>
  win.evaluate((id) => {
    const s = window.__claveSessionStoreForTests.getState().sessions.find((x) => x.id === id)
    return s
      ? { id: s.id, claudeSessionId: s.claudeSessionId ?? null, projects: s.projects ?? null }
      : null
  }, id)
const sessionIdsNow = (win) =>
  win.evaluate(() => window.__claveSessionStoreForTests.getState().sessions.map((s) => s.id))

/** The name the group's row shows. */
const shownName = (win, groupId) =>
  win
    .locator(`${rowSel(groupId)} span.truncate`)
    .first()
    .textContent({ timeout: 5000 })
    .then((text) => (text ?? '').trim())
    .catch(() => null)
const waitName = async (win, groupId, name, tries = 80) =>
  (await until(async () => ((await shownName(win, groupId)) === name ? name : null), {
    tries,
    gapMs: 125
  })) ?? (await shownName(win, groupId))
const isGroupN = (name) => /^Group \d+$/.test(name ?? '')

/** The suggestion chips on a group's row, as a person reads them. */
const chipsOf = (win, groupId) =>
  win.evaluate(
    (id) =>
      [...document.querySelectorAll(`[data-group-suggestions="${id}"] .badge`)].map((b) =>
        (b.textContent ?? '').trim()
      ),
    groupId
  )

async function openSettings(win, section) {
  const page = win.locator(`[data-settings-page="${section}"]`)
  if (!(await page.isVisible().catch(() => false))) {
    if (
      !(await win
        .locator('[data-settings-nav-row]')
        .first()
        .isVisible()
        .catch(() => false))
    )
      await win.locator('.sidebar-footer-btn[aria-label="Settings"]').click()
    await win.locator(`[data-settings-nav-row="${section}"]`).click()
  }
  await page.waitFor()
  return page
}
async function openJevCard(win) {
  const page = await openSettings(win, 'integrations')
  const card = page.locator('[data-integration="jev"]')
  await card.waitFor()
  return card
}
const backToSessions = async (win) => {
  await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
  await win
    .locator('[data-settings-nav-row]')
    .first()
    .waitFor({ state: 'detached' })
    .catch(() => {})
}

async function pasteJev(card, key) {
  const field = card.locator('[data-testid="jev-key-input"]')
  await field.waitFor()
  await field.fill(key)
  await card.locator('[data-testid="jev-key-save"]').click()
}
const cardLine = async (card, testId) => {
  const line = card.locator(`[data-testid="${testId}"]`)
  return (await line.count()) ? (await textOf(line)) || null : null
}

async function setTabProject(win, enabled) {
  const page = await openSettings(win, 'helpers')
  const row = page.locator('[data-decision-row="tab-project"]')
  await row.waitFor()
  const toggle = row.getByRole('switch', { name: 'Tab project' })
  if ((await toggle.getAttribute('aria-checked')) !== String(enabled)) await toggle.click()
  return until(async () =>
    (await toggle.getAttribute('aria-checked')) === String(enabled) ? true : null
  )
}

/** A Claude Code tab on the stand-in, out of any group, and its transcript. */
async function openTab(app, win, name, cwd, say) {
  const opened = await callMcp(app, 'openSession', {
    cwd,
    mode: 'claude',
    name,
    profile: 'builtin-claude'
  })
  const id = opened?.sessionId
  if (!id) throw new Error(`openSession for ${name} answered ${JSON.stringify(opened)}`)
  const sid = await until(async () => (await sessionOf(win, id))?.claudeSessionId ?? null, {
    tries: 120,
    gapMs: 250
  })
  if (!sid) throw new Error(`the tab ${name} has no conversation id`)
  await win.locator(rowSel(id)).first().waitFor()
  const tab = { id, sid, name, cwd, say }
  writeTranscript(tab)
  return tab
}

/** Select these tabs the way a person does: a click, then Cmd-clicks. */
async function selectTabs(win, ids) {
  await win.locator(rowSel(ids[0])).first().click()
  for (const id of ids.slice(1))
    await win
      .locator(rowSel(id))
      .first()
      .click({ modifiers: ['Meta'] })
  const selected = await until(async () => {
    const now = await win.evaluate(() => [
      ...window.__claveSessionStoreForTests.getState().selectedSessionIds
    ])
    return now.length === ids.length && ids.every((id) => now.includes(id)) ? true : null
  })
  if (!selected) throw new Error(`the tabs ${ids.join(', ')} could not be selected`)
}

const waitGroupOf = async (win, ids) => {
  const group = await until(
    async () => {
      const g = await groupOfTab(win, ids[0])
      return g && ids.every((id) => g.sessionIds.includes(id)) ? g : null
    },
    { tries: 60, gapMs: 100 }
  )
  if (!group) throw new Error(`no group holds ${ids.join(', ')}`)
  return group
}

/** The keymap's « Group selected sessions » (Mod+G). */
async function groupByKeymap(win, ids) {
  await selectTabs(win, ids)
  await win.keyboard.press('Meta+g')
  return waitGroupOf(win, ids)
}

/** The sidebar menu's « Group », on the selected tabs. */
async function groupByMenu(win, ids) {
  await selectTabs(win, ids)
  await win
    .locator(rowSel(ids[ids.length - 1]))
    .first()
    .click({ button: 'right' })
  await win
    .getByRole('menuitem', { name: /^Group(\W|$)/ })
    .first()
    .click()
  return waitGroupOf(win, ids)
}

/** The keymap's « Ungroup selected sessions » (Mod+Alt+G), on a group's tabs. */
async function ungroupByKeymap(win, group) {
  await selectTabs(win, group.sessionIds)
  await win.keyboard.press('Meta+Alt+g')
  return until(async () => ((await groupsNow(win)).some((g) => g.id === group.id) ? null : true))
}

/** A person's rename, from the group's menu. */
async function renameByHand(win, groupId, name) {
  await win
    .locator(`${rowSel(groupId)} .group-header`)
    .first()
    .click({ button: 'right' })
  await win.getByRole('menuitem', { name: 'Rename' }).first().click()
  const field = win.locator(`${rowSel(groupId)} input`).first()
  await field.waitFor()
  await field.fill(name)
  await field.press('Enter')
}

async function centerOf(win, selector, yFraction = 0.5) {
  const box = await win.locator(selector).first().boundingBox()
  if (!box) throw new Error(`no box for ${selector}`)
  return { x: box.x + box.width / 2, y: box.y + box.height * yFraction }
}

/** A real pointer drag of a tab's row onto a group's header (its lower part:
 *  inside), in steps past the drag threshold, as sidebar-dnd does. */
async function dragInto(win, tabId, groupId) {
  const from = await centerOf(win, rowSel(tabId))
  await win.mouse.move(from.x, from.y)
  await win.mouse.down()
  let at = from
  for (let round = 0; round < 3; round++) {
    const to = await centerOf(win, `${rowSel(groupId)} .group-header`, 0.75)
    for (let i = 1; i <= 10; i++) {
      await win.mouse.move(at.x + ((to.x - at.x) * i) / 10, at.y + ((to.y - at.y) * i) / 10)
      await win.waitForTimeout(20)
    }
    at = to
    await win.waitForTimeout(150)
  }
  await win.mouse.up()
  await win.waitForTimeout(600)
}

// ── The run ─────────────────────────────────────────────────────────────────

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  seedFixture()
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  killLeakedE2eTmux()
  if (OWN_SERVER && MAC) keychain.create()
  const stub = await startStub()
  const env = {
    SHELL: path.join(BIN, 'sh'),
    PATH: `${BIN}:${process.env.PATH}`,
    CLAVE_TRANSCRIPTS_ROOT: TRANSCRIPTS,
    CLAVE_JEV_BASE_URL: stub.url,
    ...(OWN_SERVER && MAC ? { CLAVE_KEYCHAIN_FILE: keychain.file } : {})
  }
  const integrationsFile = () => path.join(serverDataDirOf(DIR), 'integrations.json')
  const integrationsText = () =>
    existsSync(integrationsFile()) ? readFileSync(integrationsFile(), 'utf-8') : ''
  const errors = []
  let app = null
  let clients = new Map()
  /** An agent's MCP client, on a tab's own token. */
  const clientOf = async (sessionId) => {
    if (clients.has(sessionId)) return clients.get(sessionId)
    const token = await until(() => {
      const file = path.join(serverDataDirOf(DIR), 'mcp-configs', `${sessionId}.json`)
      if (!existsSync(file)) return null
      return (
        JSON.parse(readFileSync(file, 'utf-8')).mcpServers?.clave?.headers?.Authorization?.replace(
          /^Bearer /,
          ''
        ) ?? null
      )
    })
    if (!token) throw new Error(`no MCP token for ${sessionId}`)
    const client = mcpHttpClient(mcpEndpoint(DIR), token)
    await client.init()
    clients.set(sessionId, client)
    return client
  }
  const call = async (client, tool, args) => {
    const rpc = await client.call(tool, args)
    if (toolErrored(rpc)) throw new Error(`${tool} ${JSON.stringify(args)}: ${JSON.stringify(rpc)}`)
    return toolPayload(rpc)
  }
  /** Each tab's reading as `clave_list` says it, read off the records. */
  const listedProjects = async (client) => {
    const listed = await call(client, 'clave_list', {})
    return new Map((listed?.sessions ?? []).map((s) => [s.id, s.projects ?? null]))
  }
  const asked = () => stub.decisions().length

  try {
    let launched = await launchApp(DIR, { env })
    app = launched.app
    let win = launched.win
    win.on('pageerror', (e) => errors.push(e.message))

    // ── 1. The key ──
    let card = await openJevCard(win)
    await pasteJev(card, WRONG)
    const refusal = await until(() => cardLine(card, 'jev-check-error'))
    t.equal(
      '1. a wrong key: the card says TypeSafe refused it, in the stub’s words',
      refusal,
      'TypeSafe refused the key: Invalid API key.'
    )
    t.check(
      '1. the stub was asked the list of models under the wrong key',
      stub.seen.some((r) => r.method === 'GET' && r.path === '/v1/models' && !r.authOk),
      stub.seen.map((r) => `${r.method} ${r.path} ${r.authOk}`)
    )
    await card.locator('[data-testid="jev-replace"]').click()
    await pasteJev(card, GOOD)
    const checked = await until(async () => {
      const line = await cardLine(card, 'jev-checked')
      return line && line.startsWith('Checked on ') ? line : null
    })
    t.check('1. the good key: set and checked', /^Checked on /.test(checked ?? ''), checked)
    t.equal(
      '1. no refusal is said any more',
      await card.locator('[data-testid="jev-check-error"]').count(),
      0
    )
    t.check(
      '1. the stub saw /v1/models with the good key as the bearer',
      stub.seen.some((r) => r.method === 'GET' && r.path === '/v1/models' && r.authOk),
      stub.seen.map((r) => `${r.method} ${r.path} ${r.authOk}`)
    )
    t.equal('1. and no /v1/systemone at all', asked(), 0)
    t.check(
      '1. neither key is on disk in the clear',
      integrationsText() !== '' &&
        !integrationsText().includes(GOOD) &&
        !integrationsText().includes(WRONG),
      integrationsFile()
    )
    t.check(
      '1. the window reads no key back',
      !JSON.stringify(await win.evaluate(() => window.electronAPI.integrationsRead())).includes(
        GOOD
      )
    )

    // ── 2. The switch ──
    const helpers = await openSettings(win, 'helpers')
    const decisionRow = helpers.locator('[data-decision-row="tab-project"]')
    await decisionRow.waitFor()
    t.equal(
      '2. Settings → Helpers lists « Tab project »',
      await textOf(decisionRow.locator('.settings-row-title')),
      'Tab project'
    )
    t.equal(
      '2. on',
      await decisionRow.getByRole('switch', { name: 'Tab project' }).getAttribute('aria-checked'),
      'true'
    )
    t.equal(
      '2. with a key, no notice says one is missing',
      await helpers.locator('[data-decisions-need-key]').count(),
      0
    )
    await backToSessions(win)

    // ── 3. One project ──
    stub.answer({ quill: ANSWERS.quill })
    const q1 = await openTab(app, win, 'Quill one', P('quill'), SAY.quill(1))
    q1.n = 1
    const q2 = await openTab(app, win, 'Quill two', P('quill'), SAY.quill(2))
    q2.n = 2
    const before3 = asked()
    stub.hold()
    const g3 = await groupByKeymap(win, [q1.id, q2.id])
    t.check('3. the keymap makes a person’s group of the two tabs', g3.autoNamed === true, g3)
    t.check(
      '3. it is « Group N » at once',
      isGroupN(await shownName(win, g3.id)),
      await shownName(win, g3.id)
    )
    const held = await until(() => (asked() - before3 >= 2 ? true : null), {
      tries: 120,
      gapMs: 100
    })
    const whileAsked = await shownName(win, g3.id)
    t.check(
      '3. and still « Group N » while Jev is being asked',
      held === true && isGroupN(whileAsked),
      { held, whileAsked }
    )
    stub.release()
    t.equal('3. then it is « Quill »', await waitName(win, g3.id, 'Quill'), 'Quill')
    const sent3 = stub.decisions().slice(before3)
    t.equal('3. the stub received one request per tab', sent3.length, 2)
    const firstOf = (r) => r.body?.state?.sessions?.[0]?.first_message ?? null
    for (const q of [q1, q2])
      t.check(
        `3. ${q.name}: state.sessions[0].first_message is the tab’s own, made relative`,
        sent3.some((r) => firstOf(r) === sentFirst(q.n)),
        sent3.map(firstOf)
      )
    sent3.forEach((r, i) => {
      const text = r.raw
      const leaks = absoluteMarks().filter((mark) => text.includes(mark))
      t.equal(`3. request ${i + 1}: no absolute path anywhere in the body`, leaks.join(' '), '')
      t.check(
        `3. request ${i + 1}: under the good key’s bearer, on the versioned model`,
        r.authOk && r.body?.model === MODEL,
        {
          authOk: r.authOk,
          model: r.body?.model
        }
      )
      const folders = r.body?.state?.sessions?.[0]?.folders_its_tools_touched ?? null
      const keys = Object.keys(folders ?? {})
      t.check(
        `3. request ${i + 1}: the keys of folders_its_tools_touched are relative`,
        keys.length > 0 && keys.every((k) => !k.startsWith('/') && !k.startsWith('~')),
        folders
      )
      t.equal(
        `3. request ${i + 1}: and they are the project's own folders`,
        JSON.stringify(folders),
        JSON.stringify(QUILL_FOLDERS)
      )
      t.equal(
        `3. request ${i + 1}: criteria names exactly Quill, Atlas, Lumen`,
        Object.keys(r.body?.questions?.project?.criteria ?? {})
          .sort()
          .join(', '),
        'Atlas, Lumen, Quill'
      )
    })
    t.equal(
      '3. the tab’s reading reached the window',
      (await sessionOf(win, q1.id))?.projects?.picks?.map((p) => p.name).join(),
      'Quill'
    )

    // ── 4. Two projects, from the sidebar's menu ──
    // Atlas holds more than Quill, and the Quill tab comes first: the name
    // can only follow the shares.
    stub.answer({
      quill: { probabilities: shares(0.91, 0.06, 0.03), fits: 0.95 },
      atlas: { probabilities: shares(0.005, 0.99, 0.005), fits: 0.95 }
    })
    const q3 = await openTab(app, win, 'Quill three', P('quill'), SAY.quill(3))
    const a1 = await openTab(app, win, 'Atlas one', P('atlas'), SAY.atlas(1))
    const before4 = asked()
    const g4 = await groupByMenu(win, [q3.id, a1.id])
    t.check('4. the menu’s « Group » makes a person’s group', g4.autoNamed === true, g4)
    t.equal(
      '4. a Quill tab and an Atlas tab: « Atlas | Quill », the larger mean share first',
      await waitName(win, g4.id, 'Atlas | Quill'),
      'Atlas | Quill'
    )
    t.equal('4. one request per tab', asked() - before4, 2)
    stub.answer({ quill: ANSWERS.quill, atlas: ANSWERS.atlas })

    // ── 5. A close call ──
    stub.answer({ lightbox: ANSWERS.lightbox })
    const c1 = await openTab(app, win, 'Close call', P('lumen'), SAY.close)
    const before5 = asked()
    const g5 = await groupByKeymap(win, [c1.id])
    const chips5 = await until(async () => {
      const chips = await chipsOf(win, g5.id)
      return chips.length === 2 ? chips : null
    })
    t.equal(
      '5. two chips, reading « 63% » and « 23% » with the two names',
      JSON.stringify(chips5),
      JSON.stringify(['Lumen 63%', 'Atlas 23%'])
    )
    t.check(
      '5. the group keeps « Group N »',
      isGroupN(await shownName(win, g5.id)),
      await shownName(win, g5.id)
    )
    t.equal('5. one request', asked() - before5, 1)
    await win.locator(`[data-group-suggestions="${g5.id}"] .badge`).first().click()
    t.equal(
      '5. a click on the first names the group after it',
      await waitName(win, g5.id, 'Lumen'),
      'Lumen'
    )
    t.equal(
      '5. and the chips go',
      await until(async () => ((await chipsOf(win, g5.id)).length === 0 ? 0 : null)),
      0
    )
    t.check(
      '5. the name is the person’s from then on',
      (await groupsNow(win)).find((g) => g.id === g5.id)?.autoNamed === false
    )

    // ── 6. No project ──
    stub.answer({ train: ANSWERS.train })
    const n1 = await openTab(app, win, 'Train', ROOT, SAY.train)
    const before6 = asked()
    const g6 = await groupByKeymap(win, [n1.id])
    const read6 = await until(async () =>
      (await sessionOf(win, n1.id))?.projects?.status === 'none' ? true : null
    )
    t.check(
      '6. the stub was asked once and the tab’s reading is « none »',
      asked() - before6 === 1 && read6 === true,
      {
        requests: asked() - before6,
        reading: (await sessionOf(win, n1.id))?.projects
      }
    )
    await win.waitForTimeout(500)
    t.check('6. nothing named', isGroupN(await shownName(win, g6.id)), await shownName(win, g6.id))
    t.equal('6. nothing suggested', (await chipsOf(win, g6.id)).length, 0)

    // ── 7. A person's name is theirs ──
    const q4 = await openTab(app, win, 'Quill four', P('quill'), SAY.quill(4))
    const g7 = await groupByKeymap(win, [q4.id])
    t.equal('7. Clave names the group first', await waitName(win, g7.id, 'Quill'), 'Quill')
    await renameByHand(win, g7.id, 'Ink and margins')
    t.equal(
      '7. a person renames it',
      await waitName(win, g7.id, 'Ink and margins'),
      'Ink and margins'
    )
    const a2 = await openTab(app, win, 'Atlas two', P('atlas'), SAY.atlas(2))
    const before7 = asked()
    await dragInto(win, a2.id, g7.id)
    t.equal('7. a tab dragged into it joins it', (await groupOfTab(win, a2.id))?.id, g7.id)
    await win.waitForTimeout(SETTLE_MS)
    t.equal('7. the name does not move', await shownName(win, g7.id), 'Ink and margins')
    t.equal('7. and Jev is not asked for it', asked() - before7, 0)

    // ── 8. A group Clave named follows its tabs ──
    const q5 = await openTab(app, win, 'Quill five', P('quill'), SAY.quill(5))
    const g8 = await groupByKeymap(win, [q5.id])
    t.equal('8. « Quill » first', await waitName(win, g8.id, 'Quill'), 'Quill')
    const a3 = await openTab(app, win, 'Atlas three', P('atlas'), SAY.atlas(3))
    const before8 = asked()
    await dragInto(win, a3.id, g8.id)
    t.equal('8. a tab dragged into it joins it', (await groupOfTab(win, a3.id))?.id, g8.id)
    t.equal(
      '8. a second project’s tab: « Quill | Atlas »',
      await waitName(win, g8.id, 'Quill | Atlas'),
      'Quill | Atlas'
    )
    t.equal('8. Jev was asked about the tab that joined, and only it', asked() - before8, 1)

    // ── 9. The same tabs ask nothing twice ──
    const before9 = asked()
    t.check('9. the group of road 3 is ungrouped', (await ungroupByKeymap(win, g3)) === true)
    const g9 = await groupByKeymap(win, [q1.id, q2.id])
    t.equal('9. grouped again, the name comes back', await waitName(win, g9.id, 'Quill'), 'Quill')
    await win.waitForTimeout(SETTLE_MS)
    t.equal('9. and the stub’s count of requests has not moved', asked() - before9, 0)

    // ── 10. Switched off ──
    t.check(
      '10. « Tab project » is switched off in Helpers',
      (await setTabProject(win, false)) === true
    )
    await backToSessions(win)
    const f1 = await openTab(app, win, 'Quill six', P('quill'), SAY.quill(6))
    const f2 = await openTab(app, win, 'Quill seven', P('quill'), SAY.quill(7))
    const before10 = asked()
    let g10 = await groupByKeymap(win, [f1.id, f2.id])
    await win.waitForTimeout(SETTLE_MS)
    t.check(
      '10. grouping two fresh tabs leaves « Group N »',
      isGroupN(await shownName(win, g10.id)),
      await shownName(win, g10.id)
    )
    const off = await win.evaluate((ids) => window.electronAPI.readTabProjects(ids), [f1.id])
    t.check(
      '10. the server answers « disabled », with no reading',
      off?.tabs?.[0]?.reason === 'disabled' && off?.tabs?.[0]?.projects === null,
      off
    )
    t.equal('10. and the stub’s count has not moved', asked() - before10, 0)
    t.check('10. switched back on after', (await setTabProject(win, true)) === true)
    await backToSessions(win)

    // ── 11. No key ──
    card = await openJevCard(win)
    await card.locator('[data-testid="jev-remove"]').click()
    t.check(
      '11. the key is removed on the card',
      (await until(async () =>
        (await card.locator('[data-testid="jev-key-input"]').count()) ? true : null
      )) === true
    )
    const noKeyPage = await openSettings(win, 'helpers')
    t.check(
      '11. Helpers says the decisions wait for a key, with a way to Integrations',
      (await until(async () =>
        (await noKeyPage.locator('[data-decisions-need-key="true"]').count()) === 1 &&
        (await noKeyPage.locator('[data-decisions-integrations-link]').count()) === 1
          ? true
          : null
      )) === true
    )
    await backToSessions(win)
    const before11 = asked()
    t.check('11. the switched-off group is ungrouped', (await ungroupByKeymap(win, g10)) === true)
    const g11 = await groupByKeymap(win, [f1.id, f2.id])
    await win.waitForTimeout(SETTLE_MS)
    t.check(
      '11. grouping leaves « Group N »',
      isGroupN(await shownName(win, g11.id)),
      await shownName(win, g11.id)
    )
    const noKey = await win.evaluate((ids) => window.electronAPI.readTabProjects(ids), [f1.id])
    t.check(
      '11. the server answers « no-key », with no reading',
      noKey?.tabs?.[0]?.reason === 'no-key' && noKey?.tabs?.[0]?.projects === null,
      noKey
    )
    t.equal('11. and the stub’s count has not moved', asked() - before11, 0)
    // The key back, so a read at the next boot would reach the stub.
    card = await openJevCard(win)
    await pasteJev(card, GOOD)
    t.check(
      '11. the good key is set again before the restart',
      /^Checked on /.test(
        (await until(async () => {
          const line = await cardLine(card, 'jev-checked')
          return line && line.startsWith('Checked on ') ? line : null
        })) ?? ''
      )
    )
    await backToSessions(win)
    t.equal('11. still no decision asked', asked() - before11, 0)

    // ── 12. A restart ──
    const named = [
      [g9.id, 'Quill'],
      [g4.id, 'Atlas | Quill'],
      [g5.id, 'Lumen'],
      [g7.id, 'Ink and margins'],
      [g8.id, 'Quill | Atlas']
    ]
    const unread = [g6.id, g11.id]
    const unreadNames = new Map()
    for (const id of unread) unreadNames.set(id, await shownName(win, id))
    const readTabs = [q1, q2, q3, a1, c1, n1, q4, a2, q5, a3]
    const allTabs = [...readTabs, f1, f2]
    const listedBefore = await listedProjects(await clientOf(n1.id))
    t.check(
      '12. before the restart, clave_list carries each read tab’s projects',
      readTabs.every((tab) => listedBefore.get(tab.id)?.status) &&
        !listedBefore.get(f1.id) &&
        !listedBefore.get(f2.id),
      Object.fromEntries([...listedBefore].filter(([id]) => allTabs.some((tab) => tab.id === id)))
    )
    const before12 = asked()
    await app.close()
    app = null
    clients = new Map()
    // While the app is down, a tab of a named group says one more thing: a
    // read of it at boot would be a new request, as a read of the group that
    // was never read would be.
    appendSaid(q1, 'And keep the spacing under each heading as it was.')
    launched = await launchApp(DIR, { env })
    app = launched.app
    win = launched.win
    win.on('pageerror', (e) => errors.push(e.message))
    const back = await until(
      async () => {
        const ids = await sessionIdsNow(win)
        return allTabs.every((tab) => ids.includes(tab.id)) ? true : null
      },
      { tries: 160, gapMs: 250 }
    )
    t.check(`12. [${MODE}] every tab comes back in the window`, back === true)
    // The naming's debounce and more: a read at boot would have reached the stub.
    await win.waitForTimeout(4000)
    t.equal(`12. [${MODE}] no request reached the stub during the boot`, asked() - before12, 0)
    for (const [id, name] of named)
      t.equal(
        `12. [${MODE}] « ${name} » still has its name`,
        await waitName(win, id, name, 40),
        name
      )
    for (const id of unread)
      t.equal(
        `12. [${MODE}] a group never named is still « ${unreadNames.get(id)} »`,
        await shownName(win, id),
        unreadNames.get(id)
      )
    t.check(
      `12. [${MODE}] the groups Clave named still wait on their tabs, the others do not`,
      await (async () => {
        const now = await groupsNow(win)
        const flag = (id) => now.find((g) => g.id === id)?.autoNamed
        return flag(g9.id) && flag(g4.id) && flag(g8.id) && !flag(g5.id) && !flag(g7.id)
      })()
    )
    const listedAfter = await listedProjects(await clientOf(n1.id))
    for (const tab of readTabs)
      t.equal(
        `12. [${MODE}] ${tab.name} still carries its reading, read through the app`,
        JSON.stringify(listedAfter.get(tab.id) ?? null),
        JSON.stringify(listedBefore.get(tab.id) ?? null)
      )
    t.equal(
      `12. [${MODE}] and the window holds it`,
      (await sessionOf(win, q1.id))?.projects?.picks?.map((p) => p.name).join(),
      'Quill'
    )
    t.equal(`12. [${MODE}] and still nothing reached the stub`, asked() - before12, 0)

    // ── 13. Agents' groups are left alone ──
    stub.answer({ quill: ANSWERS.quill })
    const agent = await clientOf(n1.id)
    const made = await call(agent, 'clave_create_group', { name: 'Agent quill' })
    const groupId = made?.groupId
    t.check('13. an agent makes a group with clave_create_group', !!groupId, made)
    const m1 = await openTab(app, win, 'Quill eight', P('quill'), SAY.quill(8))
    const m2 = await openTab(app, win, 'Quill nine', P('quill'), SAY.quill(9))
    const before13 = asked()
    for (const tab of [m1, m2])
      await call(agent, 'clave_move_session', { sessionId: tab.id, groupId })
    const moved = await until(async () => {
      const g = (await groupsNow(win)).find((x) => x.id === groupId)
      return g && g.sessionIds.includes(m1.id) && g.sessionIds.includes(m2.id) ? g : null
    })
    t.check('13. and moves two Quill tabs into it', !!moved, await groupsNow(win))
    await win.waitForTimeout(SETTLE_MS)
    t.equal('13. its name is the one it was given', await shownName(win, groupId), 'Agent quill')
    t.check('13. it is not a person’s group', moved?.autoNamed === false, moved)
    t.equal('13. and no request was sent for it', asked() - before13, 0)

    t.equal('no page error', errors.join(' | '), '')
  } finally {
    if (app) await app.close().catch(() => {})
    await stub.close()
    killLeakedE2eTmux()
    if (OWN_SERVER && MAC) keychain.remove()
  }
}
