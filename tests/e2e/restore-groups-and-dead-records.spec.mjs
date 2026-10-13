// Runs in BOTH modes (wave 5, lane B, PRDCT-3432). An app quit and relaunched
// comes back as it was left: the same groups with the same members, its dead
// records offered for relaunch, its toolbar terminal reattached by its button,
// attached to a separate server as inside the app. Attached, the boot's
// records read is main's own folder, empty, and the layout merge pruned every
// group member the server runs; persistence then wrote the flattened layout
// back before the top-up brought the tabs, at the top level. And the top-up
// brought live tabs and hidden halves only, so a dead record was never offered
// and a toolbar survivor was never parked for its button. The sessions are
// created THROUGH the app, so their records live where the launch's terminal
// manager keeps them; the one record seeded by hand goes through
// `seedSessionRecord`, which writes it where the next launch reads it.
//
// What makes it able to fail: prune the saved layout's ids at the attached
// merge again (bootSurvivors with the listing read as complete) and the group
// comes back with no members, its tabs at the top level; drop the dead tabs
// from the top-up's plan and no prompt is offered attached; drop the toolbar
// from it and the button starts a second server; skip the prune after the
// top-up and the layout keeps the member no record backs (a ghost id written
// into the saved group between the two launches, round-1 verifier G2).
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  seedSessionRecord,
  recordsRootOf,
  userDataDir,
  fixturePath,
  callMcp,
  until,
  persistedWindows,
  windowLayout,
  killLeakedE2eTmux
} from './harness.mjs'

const DIR = userDataDir('restore-groups-dead')
const ROOT = fixturePath('root-restore-groups-dead')
const CLAVE = `${ROOT}/toolbar.clave`
const TOOLBAR_CMD = 'sleep 902'
const WS = {
  id: 'aaaaaaaa-0000-4000-8000-0000000000c4',
  name: 'AsLeft',
  rootDir: ROOT,
  profileFile: CLAVE,
  createdAt: 1
}
const sorted = (ids) => [...(ids ?? [])].sort()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The toolbar terminals' records, where the launch that wrote them keeps them. */
function toolbarRecords() {
  const dir = path.join(recordsRootOf(DIR), 'session-records')
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf-8')))
      .filter((r) => r.link?.kind === 'toolbar')
  } catch {
    return []
  }
}

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  // A toolbar button with a persistent terminal: the one record kind that is
  // no sidebar citizen, parked for its button at the next launch.
  writeFileSync(
    CLAVE,
    JSON.stringify({
      $schema: 'clave/1.0',
      groups: [
        {
          name: 'Toolbar',
          cwd: '.',
          toolbar: true,
          sessions: [],
          terminals: [
            {
              command: TOOLBAR_CMD,
              commandMode: 'auto',
              color: 'teal',
              icon: 'eye',
              cwd: ROOT,
              persistent: true
            }
          ]
        }
      ]
    })
  )
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  killLeakedE2eTmux()

  let app = null
  let group = null
  let members = []
  let solo = null
  let key = null
  let toolbarId = null
  const deadId = randomUUID()
  // A member the saved layout names but no record backs: gone for good, and
  // the relaunch must say so instead of keeping it as a shell.
  const ghostId = randomUUID()
  try {
    // ── Before the quit: a group with two terminals, a tab beside it ──
    const first = await launchApp(DIR)
    app = first.app
    group = await callMcp(app, 'createGroup', { name: 'Kept', cwd: ROOT })
    for (let i = 0; i < 2; i++) {
      const m = await callMcp(app, 'openSession', {
        cwd: ROOT,
        mode: 'terminal',
        groupId: group.groupId
      })
      members.push(m.sessionId)
    }
    solo = (await callMcp(app, 'openSession', { cwd: ROOT, mode: 'terminal' })).sessionId
    const alive = await until(async () => {
      const list = await callMcp(app, 'list', {})
      const g = list.groups.find((x) => x.id === group.groupId)
      const ok =
        g &&
        sorted(g.sessionIds).join() === sorted(members).join() &&
        [...members, solo].every((id) => list.sessions.find((s) => s.id === id)?.alive === true)
      return ok ? list : null
    })
    t.check('the group holds its two terminals, all three tabs alive', !!alive, alive?.groups)
    key = persistedWindows(DIR)[0]?.key
    t.check('the window persisted a layout key', !!key, persistedWindows(DIR))
    const saved = await until(() => {
      const layout = windowLayout(DIR, key)
      const g = layout?.groups.find((x) => x.id === group.groupId)
      return g && sorted(g.sessionIds).join() === sorted(members).join() ? layout : null
    })
    t.check('the saved layout names both members in their group', !!saved, saved?.groups)

    // ── The toolbar button: opened once, its terminal left running ──
    await first.win.click(`button[title="${TOOLBAR_CMD}"]`)
    await sleep(2500)
    await first.win.keyboard.press('Escape')
    const toolbar = await until(() => (toolbarRecords().length === 1 ? toolbarRecords() : null))
    t.check(
      'the toolbar terminal left exactly one record, for its button',
      !!toolbar,
      toolbarRecords()
    )
    toolbarId = toolbar?.[0]?.id ?? null

    // ── The quit, a dead record left for the next launch, a ghost in the saved group ──
    await app.close()
    app = null
    const layoutFile = path.join(DIR, 'sidebar-layouts', 'windows', `${key}.json`)
    const savedLayout = JSON.parse(readFileSync(layoutFile, 'utf-8'))
    savedLayout.groups.find((g) => g.id === group.groupId).sessionIds.push(ghostId)
    writeFileSync(layoutFile, JSON.stringify(savedLayout))
    t.check(
      'the saved layout now also names a member no record backs',
      windowLayout(DIR, key)
        ?.groups.find((g) => g.id === group.groupId)
        ?.sessionIds.includes(ghostId) === true
    )
    // A plain record (no tmux session behind it) in the folder the next launch
    // reads: the restore prompt's case, in-process and attached alike.
    seedSessionRecord(DIR, {
      id: deadId,
      cwd: ROOT,
      folderName: 'root-restore-groups-dead',
      claudeMode: false,
      antigravityMode: false,
      codexMode: false,
      piMode: false,
      claudeAgentsMode: false,
      dangerousMode: false,
      workspaceId: WS.id,
      windowKey: key
    })

    // ── The relaunch ──
    const second = await launchApp(DIR, { settleMs: 1500 })
    app = second.app
    const { win } = second
    const restore = win.getByRole('button', { name: 'Restore', exact: true })
    const prompted = await until(() => restore.isVisible().catch(() => false), { tries: 80 })
    t.check('the dead record is offered for relaunch', !!prompted)
    if (prompted) await restore.click()

    const back = await until(async () => {
      const list = await callMcp(app, 'list', {})
      const g = list.groups.find((x) => x.id === group.groupId)
      const ok =
        g &&
        sorted(g.sessionIds).join() === sorted(members).join() &&
        members.every((id) => list.sessions.find((s) => s.id === id)?.alive === true)
      return ok ? list : null
    })
    t.check(
      'the group comes back with the same two members, alive',
      !!back,
      (await callMcp(app, 'list', {})).groups
    )
    const listed = back ?? (await callMcp(app, 'list', {}))
    t.check(
      'the tab beside the group is back too',
      listed.sessions.find((s) => s.id === solo)?.alive === true,
      listed.sessions.map((s) => s.id)
    )
    const relaunched = await until(async () =>
      (await callMcp(app, 'list', {})).sessions.find((s) => s.id === deadId)
    )
    t.check('the relaunched dead record is a tab with its own id', !!relaunched, deadId)

    const layoutAfter = await until(() => {
      const layout = windowLayout(DIR, key)
      const g = layout?.groups.find((x) => x.id === group.groupId)
      return g && sorted(g.sessionIds).join() === sorted(members).join() ? layout : null
    })
    t.check(
      'the saved layout still names both members in their group, never flattened',
      !!layoutAfter,
      windowLayout(DIR, key)?.groups
    )
    t.check(
      'and the member no record backed is gone from the group and the order',
      !!layoutAfter &&
        !layoutAfter.groups.some((g) => g.sessionIds.includes(ghostId)) &&
        !layoutAfter.displayOrder.includes(ghostId) &&
        !listed.sessions.some((s) => s.id === ghostId),
      layoutAfter?.groups
    )
    t.check(
      'and no member sits at the top level',
      !!layoutAfter && members.every((id) => !layoutAfter.displayOrder.includes(id)),
      layoutAfter?.displayOrder
    )
    t.check(
      'while the tab beside the group and the relaunched one do',
      !!layoutAfter &&
        layoutAfter.displayOrder.includes(solo) &&
        layoutAfter.displayOrder.includes(deadId),
      layoutAfter?.displayOrder
    )

    // ── The toolbar survivor: no row, no tab, and the button reattaches to it ──
    t.check(
      'the toolbar terminal is neither a row nor a tab after the relaunch',
      !!toolbarId &&
        !!layoutAfter &&
        !layoutAfter.displayOrder.includes(toolbarId) &&
        !listed.sessions.some((s) => s.id === toolbarId),
      { toolbarId, displayOrder: layoutAfter?.displayOrder }
    )
    await win.click(`button[title="${TOOLBAR_CMD}"]`)
    await sleep(2500)
    const afterClick = toolbarRecords()
    t.equal('clicking its button again starts no second terminal', afterClick.length, 1)
    t.equal('it reattached the very terminal that survived', afterClick[0]?.id ?? null, toolbarId)
    await win.keyboard.press('Escape')
  } finally {
    if (app) {
      for (const id of [...members, solo, deadId].filter(Boolean)) {
        await callMcp(app, 'closeSession', { sessionId: id }).catch(() => {})
      }
      await app.close().catch(() => {})
    }
    killLeakedE2eTmux()
  }
}
