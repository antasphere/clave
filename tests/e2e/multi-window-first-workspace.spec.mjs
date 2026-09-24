/**
 * Registering the FIRST workspace must not destroy existing groups
 * (PRDCT-1703 — the single-window regression floor). This is the F1
 * regression of the halted build: groups created in no-workspace mode are
 * UNSTAMPED, and registering the first workspace used to re-read an empty
 * per-workspace layout and prune every unstamped group as member-less,
 * silently emptying the sidebar. With one layout file per window there is
 * nothing to re-read; this pins that it stays that way.
 *
 * Entirely production paths: MCP createGroup + openSession in no-workspace
 * mode, then the real Settings → "Add Workspace" button with only the native
 * folder dialog stubbed. The session cwd is OUTSIDE the workspace root, so
 * nothing places the groups by cwd — the only signal is the workspace stamp.
 *
 * Fails (before the fix) with the groups gone from both the running app and
 * the workspace's layout file; the legacy file is renamed to .migrated-backup
 * where the groups survive but the app never reads it.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  stubFolderDialog,
  callMcp,
  until,
  killLeakedE2eTmux,
  windowLayout,
  fixturePath
} from './harness.mjs'
import { mkdirSync } from 'node:fs'

const DIR = userDataDir('multi-window-first-workspace')
// The workspace root, and a session cwd OUTSIDE it (so no cwd placement).
const ROOT_W = fixturePath('firstws-w')
const ROOT_S = fixturePath('firstws-s')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const groupNames = (l) => (l?.groups ?? []).map((g) => g.name).sort()

export async function run(t) {
  killLeakedE2eTmux()
  mkdirSync(ROOT_W, { recursive: true })
  mkdirSync(ROOT_S, { recursive: true })
  // Zero workspaces: the app runs unscoped, exactly as before the workspace
  // model — createGroup then stamps activeWorkspaceId, which is null here.
  seedWorkspaces(DIR, { workspaces: [], activeWorkspaceId: null, fresh: true })
  seedTrustedRoots(DIR, [ROOT_W, ROOT_S])

  let app = null
  const opened = []
  try {
    const launched = await launchApp(DIR, { settleMs: 5000 })
    app = launched.app
    const win = launched.win
    const idBefore = await win.evaluate(() => window.electronAPI.windowIdentity())
    t.equal('the app starts in no-workspace mode', idBefore?.workspaceId, null)

    // Two groups, each with a real session (a member-less group is dropped by
    // a pre-existing rule, so both must be filled before the next is made).
    const g1 = await callMcp(app, 'createGroup', { name: 'ORPHAN ONE' })
    const s1 = await callMcp(
      app,
      'openSession',
      { cwd: ROOT_S, mode: 'terminal', groupId: g1.groupId },
      20000
    )
    opened.push(s1.sessionId)
    const g2 = await callMcp(app, 'createGroup', { name: 'ORPHAN TWO' })
    const s2 = await callMcp(
      app,
      'openSession',
      { cwd: ROOT_S, mode: 'terminal', groupId: g2.groupId },
      20000
    )
    opened.push(s2.sessionId)
    await sleep(3000)

    const before = await callMcp(app, 'list', {})
    t.check(
      'both groups exist before registering a workspace',
      JSON.stringify(before.groups.map((g) => g.name).sort()) ===
        JSON.stringify(['ORPHAN ONE', 'ORPHAN TWO']),
      before.groups.map((g) => g.name)
    )
    // In no-workspace mode both groups are unstamped.
    t.check(
      'the groups are unstamped in no-workspace mode',
      before.groups.every((g) => g.workspaceId === null),
      before.groups.map((g) => ({ n: g.name, ws: g.workspaceId }))
    )

    // ── Register the FIRST workspace through the real Settings button ──
    await stubFolderDialog(app, { returns: ROOT_W })
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu:open-settings-section', 'general')
    })
    await win.waitForTimeout(1200)
    await win.click('.settings-row-action:has-text("Add Workspace")')
    const state = await until(async () => {
      const s = await win.evaluate(() => window.electronAPI.workspaceLoad())
      return s?.workspaces?.length === 1 ? s : null
    })
    t.check('the first workspace was registered', state !== null)
    const wsId = state.workspaces[0].id
    await sleep(4000)

    // ── The groups must survive, in the running app AND on disk ──
    const after = await callMcp(app, 'list', {})
    t.check(
      'both groups still exist in the app after registering the first workspace',
      JSON.stringify(after.groups.map((g) => g.name).sort()) ===
        JSON.stringify(['ORPHAN ONE', 'ORPHAN TWO']),
      after.groups.map((g) => g.name)
    )
    t.check(
      'and they are now stamped with the new workspace',
      after.groups.length > 0 && after.groups.every((g) => g.workspaceId === wsId),
      after.groups.map((g) => ({ n: g.name, ws: g.workspaceId }))
    )
    const idAfter = await win.evaluate(() => window.electronAPI.windowIdentity())
    t.equal('the window now shows the new workspace', idAfter?.workspaceId, wsId)

    // The window's own layout file carries both groups, now stamped.
    const wFile = await until(() => {
      const l = windowLayout(DIR, idAfter?.windowKey)
      return l && (l.groups ?? []).every((g) => g.workspaceId === wsId) && l.groups.length === 2 ? l : null
    })
    t.check(
      "the window's layout file carries both groups, stamped with the workspace",
      JSON.stringify(groupNames(wFile)) === JSON.stringify(['ORPHAN ONE', 'ORPHAN TWO']),
      groupNames(windowLayout(DIR, idAfter?.windowKey))
    )

    // Restart: the groups come back from the workspace file around the
    // re-adopted sessions (the single-window restore floor).
    await app.close()
    app = null
    await sleep(1500)
    const relaunched = await launchApp(DIR, { settleMs: 6000 })
    app = relaunched.app
    const listed =
      (await until(async () => {
        const l = await callMcp(app, 'list', {})
        return l.groups.length >= 2 ? l : null
      })) ?? (await callMcp(app, 'list', {}))
    t.check(
      'both groups come back after a restart, scoped to the workspace',
      JSON.stringify(listed.groups.map((g) => g.name).sort()) ===
        JSON.stringify(['ORPHAN ONE', 'ORPHAN TWO']) &&
        listed.groups.every((g) => g.workspaceId === wsId),
      listed.groups.map((g) => ({ n: g.name, ws: g.workspaceId }))
    )

    for (const sid of opened) await callMcp(app, 'closeSession', { sessionId: sid }).catch(() => {})
  } finally {
    if (app) await app.close()
    killLeakedE2eTmux()
  }
}
