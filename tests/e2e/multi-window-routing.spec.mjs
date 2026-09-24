/**
 * MCP routing across windows (PRDCT-1703). With several windows the sidebar
 * state is per window, so mcp-server resolves WHICH window's renderer runs
 * each call from the caller's per-session token — a path only the real HTTP
 * endpoint exercises (callMcpIn targets one window's dispatcher directly and
 * would bypass the routing under test).
 *
 * The rules: a call lands in the window holding its SUBJECT session; else in
 * the window named by the `window` argument; else in the CALLER's window.
 * The `workspace` argument never picks a window (any window opens work into
 * any workspace, hidden unless it shows it). clave_open_window opens a new
 * window; clave_move_session with `window` moves a tab across windows;
 * clave_list reports the windows and each tab's window, every tab once.
 *
 * Each routing assertion carries its inverse so the spec can fail: the call
 * that must reach the other window would error if the routing fell back to
 * the caller's window (that window's store has no such session).
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  callMcpIn,
  identityOf,
  openWindow,
  windows,
  killLeakedE2eTmux,
  mcpHttpClient,
  mcpEndpoint,
  spawnAgentTabIn,
  toolPayload,
  toolErrored,
  until,
  fixturePath
} from './harness.mjs'
import { mkdirSync } from 'node:fs'

const DIR = userDataDir('multi-window-routing')
const ROOT_A = fixturePath('mw-route-a')
const ROOT_B = fixturePath('mw-route-b')
const ROOT_C = fixturePath('mw-route-c')
const WS_A = { id: 'aaaaaaaa-0000-4000-8000-0000000000f1', name: 'RouteA', rootDir: ROOT_A, profileFile: null, createdAt: 1 }
const WS_B = { id: 'bbbbbbbb-0000-4000-8000-0000000000f2', name: 'RouteB', rootDir: ROOT_B, profileFile: null, createdAt: 2 }
const WS_C = { id: 'cccccccc-0000-4000-8000-0000000000f3', name: 'RouteC', rootDir: ROOT_C, profileFile: null, createdAt: 3 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const idsIn = (list) => (list?.sessions ?? []).map((s) => s.id)

export async function run(t) {
  killLeakedE2eTmux()
  for (const r of [ROOT_A, ROOT_B, ROOT_C]) mkdirSync(r, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS_A, WS_B, WS_C], activeWorkspaceId: WS_A.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT_A, ROOT_B, ROOT_C])

  let app = null
  const opened = []
  try {
    const launched = await launchApp(DIR, { settleMs: 5000 })
    app = launched.app
    const winA = launched.win
    const idA = await identityOf(winA)
    const url = mcpEndpoint(DIR)

    // ── two windows: A (primary, workspace A) and B (workspace B) ──
    const b = await openWindow(app, winA, WS_B.id, { settleMs: 1500 })
    const idB = await identityOf(b.page)
    t.equal('window B shows workspace B', idB?.workspaceId, WS_B.id)
    t.equal('two windows are open', (await windows(app)).length, 2)

    // Agent tabs (they mint per-session tokens) — one per window.
    const P = await spawnAgentTabIn(app, winA, DIR)
    t.check('an agent tab P minted a token in window A', !!P?.token, P?.sessionId)
    const Q = await spawnAgentTabIn(app, b.page, DIR)
    t.check('an agent tab Q minted a token in window B', !!Q?.token, Q?.sessionId)
    if (!P?.token || !Q?.token) return
    opened.push(P.sessionId, Q.sessionId)
    await sleep(2500)

    const mcpP = mcpHttpClient(url, P.token)
    const mcpQ = mcpHttpClient(url, Q.token)
    await mcpP.init()
    await mcpQ.init()

    // ── caller's window: a call from Q (window B) lands its UI in window B ──
    const openedInB = toolPayload(await mcpQ.call('clave_open_session', { cwd: ROOT_B, mode: 'terminal', name: 'from-Q' }))
    t.check('Q opened a session (caller window)', !!openedInB?.sessionId, openedInB)
    opened.push(openedInB?.sessionId)
    await sleep(1500)
    const listB = await callMcpIn(app, idB.windowId, 'list', {})
    const listA = await callMcpIn(app, idA.windowId, 'list', {})
    t.check('the new tab landed in window B', idsIn(listB).includes(openedInB.sessionId), idsIn(listB))
    t.check('and NOT in window A', !idsIn(listA).includes(openedInB.sessionId), idsIn(listA))

    // ── the workspace argument never picks a window: P opens into workspace
    //    B and the tab lands in P's OWN window A, hidden ──
    const hiddenInA = toolPayload(await mcpP.call('clave_open_session', { cwd: ROOT_B, mode: 'terminal', workspace: 'RouteB', name: 'hidden-in-A' }))
    t.check('P opened a workspace-B tab', !!hiddenInA?.sessionId, hiddenInA)
    opened.push(hiddenInA?.sessionId)
    await sleep(1500)
    const listA2 = await callMcpIn(app, idA.windowId, 'list', { workspace: 'all' })
    t.check("it landed in P's own window A (hidden there)", idsIn(listA2).includes(hiddenInA.sessionId), idsIn(listA2))
    t.check('and not in window B, though B shows workspace B', !idsIn(await callMcpIn(app, idB.windowId, 'list', {})).includes(hiddenInA.sessionId))
    t.equal('stamped with workspace B all the same', listA2.sessions.find((s) => s.id === hiddenInA.sessionId)?.workspaceId, WS_B.id)

    // ── the window argument DOES pick a window ──
    const childC = toolPayload(await mcpP.call('clave_open_session', { cwd: ROOT_B, mode: 'claude', window: idB.windowId, name: 'childC' }))
    t.check('P opened childC into window B by id', !!childC?.sessionId, childC)
    opened.push(childC?.sessionId)
    await sleep(2000)
    const listB2 = await callMcpIn(app, idB.windowId, 'list', {})
    t.check('childC landed in window B', idsIn(listB2).includes(childC.sessionId), idsIn(listB2))
    t.check('and not in window A', !idsIn(await callMcpIn(app, idA.windowId, 'list', {})).includes(childC.sessionId))
    const mine = toolPayload(await mcpQ.call('clave_open_session', { cwd: ROOT_B, mode: 'terminal', window: 'mine', name: 'mine-Q' }))
    opened.push(mine?.sessionId)
    await sleep(1000)
    t.check('window "mine" is the caller\'s own', idsIn(await callMcpIn(app, idB.windowId, 'list', {})).includes(mine?.sessionId))
    const bogus = await mcpP.call('clave_open_session', { cwd: ROOT_A, mode: 'terminal', window: 9999 })
    t.check('an unknown window id is an error, never a silent fallback', toolErrored(bogus), bogus)
    const groupInB = toolPayload(await mcpP.call('clave_create_group', { name: 'P group in B', window: idB.windowId }))
    t.check('P created a group in window B', !!groupInB?.groupId, groupInB)
    await sleep(800)
    t.check('the group is in window B', (await callMcpIn(app, idB.windowId, 'list', {})).groups.some((g) => g.id === groupInB.groupId))
    t.check('and not in window A', !(await callMcpIn(app, idA.windowId, 'list', {})).groups.some((g) => g.id === groupInB.groupId))

    // ── subject in window A runs in A though the caller is in B, and the
    //    discriminating direction: subject in the NON-primary window ──
    const focusPfromB = await mcpQ.call('clave_focus', { sessionId: P.sessionId })
    t.check('Q focusing P (in window A) by id succeeds — routed to A', !toolErrored(focusPfromB), focusPfromB)
    t.equal('the focus resolved P', toolPayload(focusPfromB)?.focused, P.sessionId)
    const focusQfromA = await mcpP.call('clave_focus', { sessionId: Q.sessionId })
    t.check('P focusing Q (in window B) by id succeeds — routed to B, not the primary', !toolErrored(focusQfromA), focusQfromA)
    t.equal('the focus resolved Q', toolPayload(focusQfromA)?.focused, Q.sessionId)

    // ── clave_list: every session exactly once, windows reported, tabs annotated ──
    const all = toolPayload(await mcpP.call('clave_list', { workspace: 'all' }))
    const allIds = (all?.sessions ?? []).map((s) => s.id)
    t.equal('clave_list all has no duplicate sessions', allIds.length, new Set(allIds).size)
    for (const s of [P.sessionId, Q.sessionId, openedInB.sessionId, childC.sessionId, hiddenInA.sessionId]) {
      t.check(`clave_list all includes ${s.slice(0, 8)} exactly once`, allIds.filter((x) => x === s).length === 1, allIds)
    }
    t.check('clave_list reports both windows', Array.isArray(all?.windows) && all.windows.length === 2, all?.windows)
    t.check('and marks the caller\'s window as mine', all?.windows?.find((w) => w.id === idA.windowId)?.mine === true && all?.callerWindowId === idA.windowId, all?.windows)
    t.equal('each tab carries its windowId (P in A)', all?.sessions?.find((s) => s.id === P.sessionId)?.windowId, idA.windowId)
    t.equal('each tab carries its windowId (Q in B)', all?.sessions?.find((s) => s.id === Q.sessionId)?.windowId, idB.windowId)
    t.equal('each group carries its windowId', all?.groups?.find((g) => g.id === groupInB.groupId)?.windowId, idB.windowId)
    const active = toolPayload(await mcpQ.call('clave_list', { workspace: 'active' }))
    t.check("scope active is the CALLER's window's workspace (Q's B), across windows", active?.sessions?.some((s) => s.id === hiddenInA.sessionId) && !active?.sessions?.some((s) => s.id === P.sessionId), active?.sessions?.map((s) => [s.id, s.workspaceId]))

    // ── cross-window NAME resolution + delivery ──
    const sendByName = toolPayload(await mcpP.call('clave_send_to_session', { sessionId: 'childC', message: 'HELLO-CROSS-WINDOW' }))
    t.equal('a name-addressed send to the other window delivers', sendByName?.delivered, true)
    t.equal('and it named childC', sendByName?.sessionId, childC.sessionId)
    const openedInA = toolPayload(await mcpP.call('clave_open_session', { cwd: ROOT_A, mode: 'terminal', name: 'dupe-name' }))
    opened.push(openedInA?.sessionId)
    const openedDupB = toolPayload(await mcpQ.call('clave_open_session', { cwd: ROOT_B, mode: 'terminal', name: 'dupe-name' }))
    opened.push(openedDupB?.sessionId)
    await sleep(1500)
    const ambiguous = await mcpP.call('clave_send_to_session', { sessionId: 'dupe-name', message: 'x' })
    t.check('a name that exists in BOTH windows is rejected as ambiguous', toolErrored(ambiguous), ambiguous)

    // ── clave_move_session with window: the tab travels, then joins the group ──
    await callMcpIn(app, idB.windowId, 'focus', { sessionId: openedInB.sessionId })
    await sleep(1500)
    const moved = await mcpQ.call('clave_move_session', { sessionId: openedInB.sessionId, groupId: 'root', window: idA.windowId })
    t.check('Q moved its terminal tab into window A', !toolErrored(moved), moved)
    t.check('the tab is now in window A', !!(await until(async () => (idsIn(await callMcpIn(app, idA.windowId, 'list', {})).includes(openedInB.sessionId) ? true : null))))
    t.check('and gone from window B', !!(await until(async () => (idsIn(await callMcpIn(app, idB.windowId, 'list', {})).includes(openedInB.sessionId) ? null : true))))
    const groupA = toolPayload(await mcpP.call('clave_create_group', { name: 'A target' }))
    const movedIntoGroup = await mcpQ.call('clave_move_session', { sessionId: childC.sessionId, groupId: groupA.groupId, window: idA.windowId })
    t.check('a move into a GROUP of another window succeeds', !toolErrored(movedIntoGroup), movedIntoGroup)
    const inGroup = await until(async () => {
      const l = await callMcpIn(app, idA.windowId, 'list', {})
      return l.groups.find((g) => g.id === groupA.groupId)?.sessionIds.includes(childC.sessionId) ? l : null
    })
    t.check('childC is in the target group in window A', !!inGroup, inGroup?.groups)
    // The SECOND cross-window move of the same tab: a sidebar move back to B
    // leaves an acknowledgement nobody waited for; the next MCP move must
    // still wait for its own adoption before placing the tab in the group.
    const backToB = await winA.evaluate(({ ids, target }) => window.electronAPI.windowMoveSessions(ids, target), { ids: [childC.sessionId], target: idB.windowId })
    t.check('a sidebar move took childC back to window B', backToB?.moved?.includes(childC.sessionId), backToB)
    t.check('and it arrived', !!(await until(async () => (idsIn(await callMcpIn(app, idB.windowId, 'list', {})).includes(childC.sessionId) ? true : null))))
    const movedAgain = await mcpQ.call('clave_move_session', { sessionId: childC.sessionId, groupId: groupA.groupId, window: idA.windowId })
    t.check('the same cross-window move succeeds a second time', !toolErrored(movedAgain), movedAgain)
    const inGroupAgain = await until(async () => {
      const l = await callMcpIn(app, idA.windowId, 'list', {})
      return l.groups.find((g) => g.id === groupA.groupId)?.sessionIds.includes(childC.sessionId) ? l : null
    })
    t.check('and childC is in the target group again', !!inGroupAgain, inGroupAgain?.groups)

    // ── clave_open_window ──
    const before = (await windows(app)).length
    const newWin = toolPayload(await mcpQ.call('clave_open_window', {}))
    await sleep(3000)
    t.check('Q opened a new window', typeof newWin?.windowId === 'number', newWin)
    t.equal('one more window is open', (await windows(app)).length, before + 1)
    t.equal("on Q's own workspace (B)", newWin?.workspaceId, WS_B.id)
    const newWinC = toolPayload(await mcpP.call('clave_open_window', { workspace: 'RouteC' }))
    await sleep(3000)
    t.equal('and one on a named workspace', newWinC?.workspaceId, WS_C.id)
    const pages = await windows(app)
    const idC = await identityOf(pages.find((w) => w.id === newWinC.windowId).page)
    t.equal('that window shows RouteC', idC?.workspaceId, WS_C.id)
    t.equal('the app now has four windows', pages.length, before + 2)
    const inNew = toolPayload(await mcpP.call('clave_open_session', { cwd: ROOT_C, mode: 'terminal', window: newWinC.windowId, name: 'in-new' }))
    opened.push(inNew?.sessionId)
    await sleep(1000)
    t.check('a tab opened by window id lands in the new window', idsIn(await callMcpIn(app, newWinC.windowId, 'list', {})).includes(inNew?.sessionId))

    // ── clave_switch_workspace flips the CALLER's window, never another ──
    const switched = await mcpQ.call('clave_switch_workspace', { workspace: 'RouteC' })
    t.check('Q (window B) switched to RouteC without error', !toolErrored(switched), switched)
    await sleep(1500)
    t.equal('window B — the caller — now shows RouteC', (await identityOf(b.page))?.workspaceId, WS_C.id)
    t.equal('window A — the primary — still shows RouteA', (await identityOf(winA))?.workspaceId, WS_A.id)
    const switchedToShown = await mcpQ.call('clave_switch_workspace', { workspace: 'RouteA' })
    t.check('switching to a workspace another window shows is allowed', !toolErrored(switchedToShown), switchedToShown)
    await sleep(1000)
    t.equal('window B now shows RouteA too', (await identityOf(b.page))?.workspaceId, WS_A.id)
    t.equal('and window A still shows RouteA', (await identityOf(winA))?.workspaceId, WS_A.id)

    for (const sid of opened) {
      if (sid) await callMcpIn(app, idA.windowId, 'closeSession', { sessionId: sid }).catch(() => {})
    }
  } finally {
    if (app) await app.close()
    killLeakedE2eTmux()
  }
}
