// Runs in BOTH modes (wave 5, lane B, PRDCT-3432). An app quit and relaunched
// comes back as it was left: the same groups with the same members, its dead
// records offered for relaunch, attached to a separate server as inside the
// app. Attached, the boot's records read is main's own folder, empty, and the
// layout merge pruned every group member the server runs; persistence then
// wrote the flattened layout back before the top-up brought the tabs, at the
// top level. And the top-up brought live tabs and hidden halves only, so a
// dead record was never offered. The session is created THROUGH the app, so
// its record lives where the launch's terminal manager keeps it; the one
// record seeded by hand goes through `seedSessionRecord`, which writes it
// where the next launch reads it.
//
// What makes it able to fail: prune the saved layout's ids at the attached
// merge again (bootSurvivors with the listing read as complete) and the group
// comes back with no members, its tabs at the top level; drop the dead tabs
// from the top-up's plan and no prompt is offered attached; skip the prune
// after the top-up and the layout keeps a member that never came back.
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  seedSessionRecord,
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
const WS = {
  id: 'aaaaaaaa-0000-4000-8000-0000000000c4',
  name: 'AsLeft',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const sorted = (ids) => [...(ids ?? [])].sort()

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  killLeakedE2eTmux()

  let app = null
  let group = null
  let members = []
  let solo = null
  let key = null
  const deadId = randomUUID()
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

    // ── The quit, and a dead record left for the next launch ──
    await app.close()
    app = null
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
