/**
 * A session that is the HIDDEN HALF of something else comes back as that
 * half, never as a tab (PRDCT-1756).
 *
 * The bug: the session record is all that survives a quit, and it did not say
 * what its session was FOR. So on the next launch a group's `npm run dev`, a
 * session view's serving process and a toolbar button's dev server were all
 * adopted as ordinary tabs — mystery rows in the sidebar beside the groups,
 * while the owner showed "not running" and its start action spawned a SECOND
 * server on the same port. Two paths made it happen and both are covered:
 *
 *  1. the group whose members did not come back was pruned outright, which
 *     un-nested its still-running terminal;
 *  2. the session view's `serverSessionId` is renderer-only by design, so the
 *     serving process came back with nothing holding it — every restart.
 *
 * The check is the RESTART: state before, quit, relaunch on the same
 * user-data dir, assert on what the sidebar layout and clave_list say. The
 * top-level order is the assertion that matters — a hidden half must not be
 * in it.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  callMcp,
  persistedWindows,
  windowLayout,
  until,
  killLeakedE2eTmux,
  fixturePath,
  freePorts
} from './harness.mjs'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DIR = userDataDir('hidden-session-restore')
const ROOT = fixturePath('hidden-root')
// A port nothing serves: asked of the OS, so another run's server is never on it.
const [VIEW_PORT] = await freePorts(1)
const CLAVE = `${ROOT}/toolbar.clave`
const TOOLBAR_CMD = 'sleep 901'
const WS = {
  id: 'dddddddd-0000-4000-8000-00000000000d',
  name: 'Hidden',
  rootDir: ROOT,
  profileFile: CLAVE,
  createdAt: 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Every session record on disk, so a spec can read a record's `link`. */
function sessionRecords() {
  const dir = path.join(DIR, 'session-records')
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf-8')))
  } catch {
    return []
  }
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  // A toolbar button with a persistent terminal: the third owner of a hidden
  // session, and the one with no sidebar identity at all.
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

  let app = null
  try {
    // ── Before the restart: a group whose last tab is closed while its
    //    quick-launch terminal keeps running, and a tab with a served view ──
    const first = await launchApp(DIR)
    app = first.app
    let win = first.win

    const group = await callMcp(app, 'createGroup', { name: 'Lane', cwd: ROOT })
    const member = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'terminal',
      groupId: group.groupId
    })
    const terminal = await callMcp(app, 'addGroupTerminal', {
      groupId: group.groupId,
      // Long-lived so the tmux session is still there after the quit; harmless.
      command: 'sleep 900',
      commandMode: 'auto',
      cwd: ROOT
    })
    t.check('the group terminal spawned a session', !!terminal.sessionId, terminal)

    const viewer = await callMcp(app, 'openSession', { cwd: ROOT, mode: 'terminal' })
    await callMcp(app, 'setSessionView', {
      sessionId: viewer.sessionId,
      url: `http://127.0.0.1:${VIEW_PORT}`,
      command: 'sleep 900',
      cwd: ROOT
    })
    await sleep(1500)
    const beforeList = await callMcp(app, 'list', {})
    const viewerBefore = beforeList.sessions.find((s) => s.id === viewer.sessionId)
    t.check('the viewer tab carries its view', !!viewerBefore?.view, viewerBefore?.view)

    // The records are what the next launch reads — they must name the owner.
    const termRecord = sessionRecords().find((r) => r.id === terminal.sessionId)
    t.check(
      "the group terminal's record names its group and terminal",
      termRecord?.link?.kind === 'group-terminal' &&
        termRecord.link.groupId === group.groupId &&
        termRecord.link.terminalId === terminal.terminalId,
      termRecord?.link
    )
    const serverRecord = sessionRecords().find(
      (r) => r.link?.kind === 'session-view' && r.link.ownerId === viewer.sessionId
    )
    t.check("the view server's record names its owning tab", !!serverRecord, serverRecord?.link)

    // Close the group's only tab: the group now has nothing BUT the running
    // terminal. This is the case that used to prune the group and orphan it.
    await callMcp(app, 'closeSession', { sessionId: member.sessionId })
    await sleep(1000)
    const emptied = await callMcp(app, 'list', {})
    t.check(
      'the group survives losing its last tab, terminal still linked',
      emptied.groups.find((g) => g.id === group.groupId)?.terminals?.[0]?.sessionId ===
        terminal.sessionId,
      emptied.groups.find((g) => g.id === group.groupId)
    )

    // ── The toolbar button: click it once, then leave it running ──
    await win.click(`button[title="${TOOLBAR_CMD}"]`)
    await sleep(2500)
    await win.keyboard.press('Escape')
    await sleep(800)
    const toolbarRecords = sessionRecords().filter((r) => r.link?.kind === 'toolbar')
    t.equal('the toolbar terminal left exactly one record', toolbarRecords.length, 1)
    const toolbarId = toolbarRecords[0]?.id
    t.check(
      "and the record names the button it belongs to, not a tab",
      typeof toolbarRecords[0]?.link?.key === 'string' && toolbarRecords[0].link.key.endsWith(':0'),
      toolbarRecords[0]?.link
    )

    const key = persistedWindows(DIR)[0]?.key
    t.check('the window persisted a layout key', !!key, persistedWindows(DIR))

    // ── The restart ──
    await app.close()
    app = null
    await sleep(1500)
    const second = await launchApp(DIR, { settleMs: 8000 })
    app = second.app
    win = second.win

    const after = await until(async () => {
      const list = await callMcp(app, 'list', {})
      return list.groups.some((g) => g.id === group.groupId) ? list : null
    })
    t.check('the group came back', !!after, 'group never reappeared')

    const backGroup = after?.groups.find((g) => g.id === group.groupId)
    t.check(
      'and its quick-launch terminal is linked to the SAME session, still alive',
      backGroup?.terminals?.[0]?.sessionId === terminal.sessionId &&
        after?.sessions.find((s) => s.id === terminal.sessionId)?.alive === true,
      backGroup?.terminals
    )

    const layout = windowLayout(DIR, key)
    t.check(
      "the terminal's session is NOT a top-level row",
      !!layout && !layout.displayOrder.includes(terminal.sessionId),
      layout?.displayOrder
    )

    const backViewer = after?.sessions.find((s) => s.id === viewer.sessionId)
    t.check('the viewer tab came back with its view', !!backViewer?.view, backViewer?.view)
    const serverId = serverRecord?.id
    t.check(
      "the view's serving session is NOT a top-level row either",
      !!layout && !!serverId && !layout.displayOrder.includes(serverId),
      { serverId, displayOrder: layout?.displayOrder }
    )
    t.check(
      'and it is back, hidden, attached to its owner',
      !!serverId &&
        after?.sessions.some((s) => s.id === serverId) &&
        !after?.sessions.find((s) => s.id === serverId)?.groupId,
      after?.sessions.map((s) => s.id)
    )

    // ── The toolbar survivor: no row, and the button REATTACHES to it ──
    t.check(
      "the toolbar terminal is not in the sidebar order either",
      !!layout && !!toolbarId && !layout.displayOrder.includes(toolbarId),
      { toolbarId, displayOrder: layout?.displayOrder }
    )
    t.check(
      'and it is not a tab in the store at all',
      !!toolbarId && !after?.sessions.some((s) => s.id === toolbarId),
      after?.sessions.map((s) => s.id)
    )
    await win.click(`button[title="${TOOLBAR_CMD}"]`)
    await sleep(2500)
    const afterClick = sessionRecords().filter((r) => r.link?.kind === 'toolbar')
    t.equal('clicking the button again spawns no SECOND server', afterClick.length, 1)
    t.equal('it reattached the very session that survived', afterClick[0]?.id, toolbarId)
    await win.keyboard.press('Escape')
    await sleep(500)

    // The whole point, stated once: neither hidden half is a row on screen.
    const rowIds = await win.evaluate(() =>
      [...document.querySelectorAll('[data-sidebar-item-type="session"]')].map((r) =>
        r.getAttribute('data-sidebar-item-id')
      )
    )
    const hiddenIds = [terminal.sessionId, serverId, toolbarId].filter(Boolean)
    t.check(
      'neither hidden half draws a row in the sidebar',
      hiddenIds.every((id) => !rowIds.includes(id)),
      { rowIds, hiddenIds }
    )
    t.check(
      'and the group itself is on screen (a running terminal keeps it)',
      await win.evaluate(
        (id) => !!document.querySelector(`[data-sidebar-item-id="${id}"]`),
        group.groupId
      ),
      group.groupId
    )
  } finally {
    if (app) await app.close()
    await sleep(500)
    killLeakedE2eTmux()
  }
}
