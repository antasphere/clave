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
 *  1. the key: the Jev section says what leaves, the workspace’s projects
 *     with it; a wrong key is refused in the stub’s words; the good one is set
 *     and checked, with `/v1/models` asked under its bearer and no decision;
 *  2. the switch: Settings → Helpers lists « Tab project », on, its row saying
 *     what it sends;
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
 *     name it was given, and nothing is asked for it;
 * 14. an agent's rename (`clave_rename`) of a person's group Clave named makes
 *     the name the agent's in every mode (in-process it lands on the server's
 *     layout): a tab dragged in after moves nothing and asks nothing;
 * 15. a person who renames a group to the very name Clave gave it takes it:
 *     a tab dragged in after moves nothing and asks nothing;
 * 16. a group offering the two nearest projects whose only agent tab is
 *     closed stays, and its offer goes.
 *
 * Roads 10 and 11 also regroup two tabs read EARLIER, whose records carry a
 * reading: the host's own check of the switch and of the key serves none.
 *
 * At the end, after the sweep, no session started under the run's fixture
 * root is left on the shared tmux socket, whatever its name: the sweep takes
 * only a session named for the suite, so a tab of the world that started in
 * a folder of another name would outlive every run.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
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
  fixturePath,
  fixtureRoot,
  serverDataDirOf,
  serverMode,
  killLeakedE2eTmux
} from './harness.mjs'
import { runKeychain } from './fixtures/run-keychain.mjs'
import {
  JEV_TEST_MODEL,
  shares,
  sentFirst,
  jevWorld,
  startJevStub,
  textOf,
  groupsNow,
  groupOfTab,
  sessionOf,
  sessionIdsNow,
  shownName,
  waitName,
  isGroupN,
  chipsOf,
  openSettings,
  openJevCard,
  backToSessions,
  pasteJev,
  cardLine,
  setTabProject,
  groupByKeymap,
  groupByMenu,
  ungroupByKeymap,
  renameByHand,
  dragInto
} from './fixtures/jev-world.mjs'

export const deadlineMs = 15 * 60 * 1000

// The workspace, the stand-in agent, the transcripts and the window's roads
// are the decisions' world (fixtures/jev-world.mjs), shared with the look and
// the real check in scripts/.
const world = jevWorld('decisions-tab-project')
const { DIR, ROOT, BIN, TRANSCRIPTS, WS, P, SAY } = world
const MODE = serverMode()
const MAC = process.platform === 'darwin'
// A server of its own process files its secrets in a keychain FILE of the
// run's own, never a personal keychain (fixtures/run-keychain.mjs).
const OWN_SERVER = MODE !== 'in-process'
const keychain = runKeychain(fixturePath('decisions-tab-project-keychain/e2e.keychain-db'))

const GOOD = 'ts-test-good-key-quill-atlas-lumen'
const WRONG = 'ts-test-wrong-key'
const MODEL = JEV_TEST_MODEL
/** Long enough for the naming's debounce (300 ms), a request and its answer. */
const SETTLE_MS = 2500

/** The folders a Quill tab's tools touched, as the state must name them. */
const QUILL_FOLDERS = { 'quill/src': 2, quill: 1 }
const ANSWERS = {
  quill: { probabilities: shares(0.97, 0.02, 0.01), fits: 0.95 },
  atlas: { probabilities: shares(0.05, 0.93, 0.02), fits: 0.94 },
  lightbox: { probabilities: shares(0.14, 0.23, 0.63), fits: 0.9 },
  // The choice still names a project at 0.97; the companion question says no.
  train: { probabilities: shares(0.97, 0.02, 0.01), fits: 0.2 }
}

const absoluteMarks = world.absoluteMarks
const seedFixture = world.seed
const appendSaid = world.appendSaid
const openTab = world.openTab
const startStub = () => startJevStub({ good: GOOD, model: MODEL })

/** The sessions on the app's socket started under this run's fixture root,
 *  as `name|start path`: the root in its /tmp and its real form, as the
 *  sweep's `leakedE2eSessions` scopes them, but WITHOUT its name rule. No
 *  tmux, or no server on the socket, is none; any other failure to list is
 *  an entry of its own, so the check cannot pass on a listing it never got. */
function sessionsUnderRun() {
  let rows
  try {
    rows = execFileSync(
      'tmux',
      ['-L', 'clave', 'list-sessions', '-F', '#{session_name}|#{session_path}'],
      { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }
    )
  } catch (error) {
    if (
      error?.code === 'ENOENT' ||
      /no server running|error connecting/.test(String(error?.stderr))
    )
      return []
    return [`(the socket could not be listed: ${String(error?.message ?? error).split('\n')[0]})`]
  }
  const roots = [fixtureRoot(), fixtureRoot({ real: true })]
  return rows
    .split('\n')
    .filter(Boolean)
    .filter((row) => {
      const start = row.slice(row.indexOf('|') + 1)
      return roots.some((root) => start === root || start.startsWith(`${root}/`))
    })
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
  /** Each tab's reading as an agent's `clave_list` says it: the served road
   *  in-process (off the records), the window's road attached. */
  const listedProjects = async (client) => {
    const listed = await call(client, 'clave_list', {})
    return new Map((listed?.sessions ?? []).map((s) => [s.id, s.projects ?? null]))
  }
  /** The same, as the window's own listing says it (the dispatcher's
   *  `list`, which the specs on `work` read). */
  const windowListed = async (app) => {
    const listed = await callMcp(app, 'list', {})
    return new Map((listed?.sessions ?? []).map((s) => [s.id, s.projects ?? null]))
  }
  const sameReadings = (a, b, tabs) =>
    tabs.every(
      (tab) => JSON.stringify(a.get(tab.id) ?? null) === JSON.stringify(b.get(tab.id) ?? null)
    )
  const asked = () => stub.decisions().length

  try {
    let launched = await launchApp(DIR, { env })
    app = launched.app
    let win = launched.win
    win.on('pageerror', (e) => errors.push(e.message))

    // ── 1. The key ──
    let card = await openJevCard(win)
    const sectionText = (await textOf(await openSettings(win, 'integrations'))) ?? ''
    t.check(
      '1. before a key, the Jev section says the workspace’s projects leave too',
      sectionText.includes(
        'with the name, the folder and the prompt of each project of the workspace'
      ),
      sectionText.slice(0, 600)
    )
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
      '2. its row says what it sends, the workspace’s projects with it',
      await textOf(decisionRow.locator('.settings-row-description')),
      'Which project a tab works on, to name the groups you make. Sends the tab’s first and latest messages, the folders its tools touched and the workspace’s projects.'
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
    // No chip to click is already red above: the roads after this one still run.
    if (chips5) await win.locator(`[data-group-suggestions="${g5.id}"] .badge`).first().click()
    t.equal(
      '5. a click on the first names the group after it',
      await waitName(win, g5.id, 'Lumen'),
      'Lumen'
    )
    const gone = await until(async () => ((await chipsOf(win, g5.id)).length === 0 ? true : null))
    t.check('5. and the chips go', gone === true, await chipsOf(win, g5.id))
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
    // Two tabs read EARLIER first: their records carry a reading, which the
    // host must not serve once the decision is off.
    const e1 = await openTab(app, win, 'Quill fourteen', P('quill'), SAY.quill(14))
    const e2 = await openTab(app, win, 'Quill fifteen', P('quill'), SAY.quill(15))
    const ge = await groupByKeymap(win, [e1.id, e2.id])
    t.equal(
      '10. two tabs read while it is on: « Quill »',
      await waitName(win, ge.id, 'Quill'),
      'Quill'
    )
    t.check('10. and ungrouped', (await ungroupByKeymap(win, ge)) === true)
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
    const ge10 = await groupByKeymap(win, [e1.id, e2.id])
    await win.waitForTimeout(SETTLE_MS)
    t.check(
      '10. grouping the two tabs read earlier leaves « Group N » too',
      isGroupN(await shownName(win, ge10.id)),
      await shownName(win, ge10.id)
    )
    const offRead = await win.evaluate((ids) => window.electronAPI.readTabProjects(ids), [e1.id])
    t.check(
      '10. and for a tab read earlier the server answers « disabled », serving no reading',
      offRead?.tabs?.[0]?.reason === 'disabled' && offRead?.tabs?.[0]?.projects === null,
      offRead
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
    t.check(
      '11. the group of the tabs read earlier is ungrouped',
      (await ungroupByKeymap(win, ge10)) === true
    )
    const ge11 = await groupByKeymap(win, [e1.id, e2.id])
    await win.waitForTimeout(SETTLE_MS)
    t.check(
      '11. grouping the two tabs read earlier leaves « Group N »',
      isGroupN(await shownName(win, ge11.id)),
      await shownName(win, ge11.id)
    )
    const noKeyRead = await win.evaluate((ids) => window.electronAPI.readTabProjects(ids), [e1.id])
    t.check(
      '11. and for a tab read earlier the server answers « no-key », serving no reading',
      noKeyRead?.tabs?.[0]?.reason === 'no-key' && noKeyRead?.tabs?.[0]?.projects === null,
      noKeyRead
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
    const unread = [g6.id, g11.id, ge11.id]
    const unreadNames = new Map()
    for (const id of unread) unreadNames.set(id, await shownName(win, id))
    const readTabs = [q1, q2, q3, a1, c1, n1, q4, q5, a3, e1, e2]
    // Never read: the tab that joined a group named by hand (road 7), and the
    // two grouped while switched off and without a key (roads 10 and 11).
    const neverRead = [a2, f1, f2]
    const allTabs = [...readTabs, ...neverRead]
    const listedBefore = await listedProjects(await clientOf(n1.id))
    t.check(
      '12. before the restart, clave_list carries each read tab’s projects, and none for the others',
      readTabs.every((tab) => listedBefore.get(tab.id)?.status) &&
        neverRead.every((tab) => listedBefore.has(tab.id) && !listedBefore.get(tab.id)),
      Object.fromEntries([...listedBefore].filter(([id]) => allTabs.some((tab) => tab.id === id)))
    )
    const windowBefore = await windowListed(app)
    t.check(
      '12. and the window’s own listing says the same',
      sameReadings(windowBefore, listedBefore, allTabs),
      Object.fromEntries([...windowBefore].filter(([id]) => allTabs.some((tab) => tab.id === id)))
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
      t.check(
        `12. [${MODE}] ${tab.name} still carries its reading, read through the app`,
        !!listedAfter.get(tab.id)?.status && sameReadings(listedAfter, listedBefore, [tab]),
        { before: listedBefore.get(tab.id) ?? null, after: listedAfter.get(tab.id) ?? null }
      )
    t.check(
      `12. [${MODE}] and the window’s own listing says the same`,
      sameReadings(await windowListed(app), listedAfter, allTabs)
    )
    t.check(
      `12. [${MODE}] and the tabs never read still carry none`,
      neverRead.every((tab) => listedAfter.has(tab.id) && !listedAfter.get(tab.id)),
      neverRead.map((tab) => [tab.name, listedAfter.get(tab.id) ?? null])
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

    // ── 14. An agent's rename makes the name theirs ──
    // In-process the agent's `clave_rename` lands on the server's layout, in
    // the other modes on the window's: either way the group leaves Clave's
    // naming, and a tab dragged in after asks nothing.
    const r1 = await openTab(app, win, 'Quill ten', P('quill'), SAY.quill(10))
    const r2 = await openTab(app, win, 'Quill eleven', P('quill'), SAY.quill(11))
    const g14 = await groupByKeymap(win, [r1.id, r2.id])
    t.equal('14. Clave names a person’s group first', await waitName(win, g14.id, 'Quill'), 'Quill')
    await call(agent, 'clave_rename', { target: 'group', id: g14.id, name: 'Agent picked' })
    t.equal(
      `14. [${MODE}] an agent renames it with clave_rename`,
      await waitName(win, g14.id, 'Agent picked'),
      'Agent picked'
    )
    const left14 = await until(async () =>
      (await groupsNow(win)).find((g) => g.id === g14.id)?.autoNamed === false ? true : null
    )
    t.check(
      `14. [${MODE}] and the group leaves Clave’s naming`,
      left14 === true,
      (await groupsNow(win)).find((g) => g.id === g14.id)
    )
    const a4 = await openTab(app, win, 'Atlas four', P('atlas'), SAY.atlas(4))
    const before14 = asked()
    await dragInto(win, a4.id, g14.id)
    t.equal('14. an Atlas tab dragged into it joins it', (await groupOfTab(win, a4.id))?.id, g14.id)
    await win.waitForTimeout(SETTLE_MS)
    t.equal(
      `14. [${MODE}] the name stays the agent’s`,
      await shownName(win, g14.id),
      'Agent picked'
    )
    t.equal(`14. [${MODE}] and no request reached the stub`, asked() - before14, 0)

    // ── 15. A person who confirms Clave's name takes the group ──
    const s1 = await openTab(app, win, 'Quill twelve', P('quill'), SAY.quill(12))
    const s2 = await openTab(app, win, 'Quill thirteen', P('quill'), SAY.quill(13))
    const g15 = await groupByKeymap(win, [s1.id, s2.id])
    t.equal('15. Clave names a person’s group first', await waitName(win, g15.id, 'Quill'), 'Quill')
    await renameByHand(win, g15.id, 'Quill')
    const took15 = await until(async () =>
      (await groupsNow(win)).find((g) => g.id === g15.id)?.autoNamed === false ? true : null
    )
    t.check(
      `15. [${MODE}] renamed by hand to the name it shows, the group leaves Clave’s naming`,
      took15 === true,
      (await groupsNow(win)).find((g) => g.id === g15.id)
    )
    const a5 = await openTab(app, win, 'Atlas five', P('atlas'), SAY.atlas(5))
    const before15 = asked()
    await dragInto(win, a5.id, g15.id)
    t.equal('15. an Atlas tab dragged into it joins it', (await groupOfTab(win, a5.id))?.id, g15.id)
    await win.waitForTimeout(SETTLE_MS)
    t.equal(`15. [${MODE}] the name stays the person’s`, await shownName(win, g15.id), 'Quill')
    t.equal(`15. [${MODE}] and no request reached the stub`, asked() - before15, 0)

    // ── 16. A group whose last agent tab goes loses its offer ──
    stub.answer({ lightbox: ANSWERS.lightbox })
    const c2 = await openTab(app, win, 'Close call two', P('lumen'), SAY.close)
    const g16 = await groupByKeymap(win, [c2.id])
    const chips16 = await until(async () => {
      const chips = await chipsOf(win, g16.id)
      return chips.length === 2 ? chips : null
    })
    t.equal(
      '16. Jev hesitates: the group offers the two nearest',
      JSON.stringify(chips16),
      JSON.stringify(['Lumen 63%', 'Atlas 23%'])
    )
    await callMcp(app, 'closeSession', { sessionId: c2.id })
    const closed16 = await until(async () => ((await groupOfTab(win, c2.id)) ? null : true))
    t.check('16. its only agent tab is closed', closed16 === true)
    await win.waitForTimeout(SETTLE_MS)
    t.check(
      `16. [${MODE}] the group is still there, with no agent tab`,
      (await groupsNow(win)).some((g) => g.id === g16.id),
      await groupsNow(win)
    )
    t.equal(
      `16. [${MODE}] and its offer is gone`,
      JSON.stringify(await chipsOf(win, g16.id)),
      JSON.stringify([])
    )

    t.equal('no page error', errors.join(' | '), '')
  } finally {
    if (app) await app.close().catch(() => {})
    await stub.close()
    killLeakedE2eTmux()
    if (OWN_SERVER && MAC) keychain.remove()
    const left = sessionsUnderRun()
    t.check(
      'after the sweep, no session started under the run’s fixture root is left on the socket',
      left.length === 0,
      { left: left.length, sessions: left }
    )
  }
}
