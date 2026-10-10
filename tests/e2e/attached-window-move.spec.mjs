// A tab moves between the windows of an attached app (wave 4, lane C,
// PRDCT-3376). Attached, the sessions are the standalone server's, so main
// keeps no process binding for them: the move releases the session on the
// server (it alone owns the process and decides what can move), then main
// runs the same layout logic with that outcome and the target window
// re-adopts the tab through the server. The session is created THROUGH the
// app, so its record lives in the server's data folder the way a real one
// does, and no fixture is seeded by hand.
//
// What makes it able to fail: leave the move on main's own terminals (wave
// 3's gap) and the release refuses every id (main has no such session), so
// nothing moves; drop the record re-stamp and a restart would bring the tab
// back in the wrong window; route the move's layout the old way and the
// source keeps the tab.
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  callMcpIn,
  identityOf,
  openWindow,
  mcpEndpoint,
  mcpHttpClient,
  toolErrored,
  until
} from './harness.mjs'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT_A = fixturePath('root-attached-move-a')
const ROOT_B = fixturePath('root-attached-move-b')
const WS_A = {
  id: 'aaaaaaaa-0000-4000-8000-0000000000a9',
  name: 'MoveA',
  rootDir: ROOT_A,
  profileFile: null,
  createdAt: 1
}
const WS_B = {
  id: 'bbbbbbbb-0000-4000-8000-0000000000b9',
  name: 'MoveB',
  rootDir: ROOT_B,
  profileFile: null,
  createdAt: 2
}

const idsIn = (list) => (list?.sessions ?? []).map((s) => s.id)

function recordOf(serverDir, id) {
  const dir = path.join(serverDir, 'session-records')
  if (!existsSync(dir)) return null
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const r = JSON.parse(readFileSync(path.join(dir, f), 'utf-8'))
    if (r.id === id) return r
  }
  return null
}

export async function run(t) {
  for (const r of [ROOT_A, ROOT_B]) mkdirSync(r, { recursive: true })
  const DIR = userDataDir('attached-window-move')
  seedWorkspaces(DIR, { workspaces: [WS_A, WS_B], activeWorkspaceId: WS_A.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT_A, ROOT_B])

  const launched = await launchApp(DIR, { server: 'attached', settleMs: 6000 })
  const { app, win: win1 } = launched
  const serverDir = launched.server?.dataDir
  try {
    const id1 = await identityOf(win1)
    t.equal('the app is attached', (launched.server && 'attached') || 'in-process', 'attached')
    t.check('window 1 has its key', typeof id1?.windowKey === 'string', id1)

    // A tmux-backed terminal, created through the app: the server runs it.
    const before = new Set(idsIn(await callMcpIn(app, id1.windowId, 'list', {})))
    await win1.click('.launcher-row button')
    const sessionId = await until(async () => {
      const now = idsIn(await callMcpIn(app, id1.windowId, 'list', {}))
      return now.find((s) => !before.has(s)) ?? null
    })
    t.check('a terminal launched in window 1', !!sessionId, sessionId)
    if (!sessionId) return
    t.check('its record is in the server’s data folder', !!recordOf(serverDir, sessionId))
    t.equal('and carries window 1’s key', recordOf(serverDir, sessionId)?.windowKey, id1.windowKey)

    // A second window on workspace B.
    const w2 = await openWindow(app, win1, WS_B.id, { settleMs: 2500 })
    const id2 = await identityOf(w2.page)
    t.equal('window 2 shows workspace B', id2?.workspaceId, WS_B.id)
    t.check(
      'the session is only in window 1 before the move',
      !idsIn(await callMcpIn(app, id2.windowId, 'list', {})).includes(sessionId)
    )

    // The move, from window 1 to window 2.
    const result = await win1.evaluate(
      ({ ids, target }) => window.electronAPI.windowMoveSessions(ids, target),
      { ids: [sessionId], target: id2.windowId }
    )
    t.check('the move reports the session moved', result?.moved?.includes(sessionId), result)

    t.check(
      'the session left window 1',
      !!(await until(async () =>
        idsIn(await callMcpIn(app, id1.windowId, 'list', {})).includes(sessionId) ? null : true
      ))
    )
    t.check(
      'and arrived in window 2',
      !!(await until(async () =>
        idsIn(await callMcpIn(app, id2.windowId, 'list', {})).includes(sessionId) ? true : null
      ))
    )
    t.equal(
      'the record now carries window 2’s key',
      await until(() => {
        const r = recordOf(serverDir, sessionId)
        return r?.windowKey === id2.windowKey ? r.windowKey : null
      }),
      id2.windowKey
    )

    // After the move the record is the server's and names window 2: a
    // RESTART would bring the tab back in window 2, not window 1 (the
    // re-stamp above is what makes that true; asserted here as the record,
    // since a second restart in one spec is covered by terminal-reattach).
    // Moving an id the server does not run is refused, never a false move.
    const bogus = await win1.evaluate(
      ({ target }) =>
        window.electronAPI.windowMoveSessions(['00000000-0000-4000-8000-000000000000'], target),
      { target: id2.windowId }
    )
    t.check(
      'an unknown id is refused, not moved',
      (bogus?.moved?.length ?? 0) === 0 && (bogus?.refused?.length ?? 0) > 0,
      bogus
    )

    // ── F1 (round-1 Major): the agent tools follow a TOKENED tab across a
    //    move. An agent tab started by the server mints a per-session token
    //    under the server's mcp-configs; a first tool call binds it to
    //    window 1 in main; after the move a subject-session tool must route
    //    to window 2, where the tab now lives. With the old stale binding it
    //    routed to window 1 (the tab's old window) and errored. ──
    const configsDir = path.join(serverDir, 'mcp-configs')
    const seen = new Set(existsSync(configsDir) ? readdirSync(configsDir) : [])
    await win1.click('.launcher-split .launcher-btn')
    const agent = await until(
      () => {
        if (!existsSync(configsDir)) return null
        const f = readdirSync(configsDir).find((x) => x.endsWith('.json') && !seen.has(x))
        if (!f) return null
        const cfg = JSON.parse(readFileSync(path.join(configsDir, f), 'utf-8'))
        const auth = cfg.mcpServers?.clave?.headers?.Authorization
        if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null
        return { id: f.replace(/\.json$/, ''), token: auth.slice('Bearer '.length) }
      },
      { tries: 80, gapMs: 250 }
    )
    t.check('an agent tab in window 1 minted a token on the server', !!agent, agent)
    if (agent) {
      const mcp = mcpHttpClient(mcpEndpoint(DIR), agent.token)
      await mcp.init()
      // Binds the agent session to window 1 in main (first authenticated call).
      await mcp.call('clave_list', {})
      // Move it to window 2.
      const moved2 = await win1.evaluate(
        ({ ids, target }) => window.electronAPI.windowMoveSessions(ids, target),
        { ids: [agent.id], target: id2.windowId }
      )
      t.check('the agent tab moved to window 2', moved2?.moved?.includes(agent.id), moved2)
      await until(async () =>
        idsIn(await callMcpIn(app, id2.windowId, 'list', {})).includes(agent.id) ? true : null
      )
      // A subject-session tool via the SAME token must now land in window 2.
      // Old code: main's binding still named window 1, so the rename reached
      // a window that no longer holds the tab and errored.
      const renamed = await mcp.call('clave_rename', {
        target: 'session',
        id: agent.id,
        name: 'Moved tab'
      })
      t.check(
        'a tool call after the move routes to window 2, not the old window',
        !toolErrored(renamed),
        renamed
      )
    }
  } finally {
    await app.close()
  }
}
