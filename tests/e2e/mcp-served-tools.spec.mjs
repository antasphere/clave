/**
 * The agent tools are served by the server, first part (PRDCT-3294). What
 * this proves on the real app, over the real MCP endpoint with a tab's own
 * token, that no other spec does: a tool whose work is a server command is
 * answered by the server (the road main records says `server`), the change
 * is on the server's layout AND drawn in the window; a tool that needs the
 * window reaches it through the server's view request (the road says
 * `window`) and still does its work; a tab closed through the server leaves
 * the sidebar instead of being saved back; a quick-launch terminal the
 * server started is taken in by the window. Attached to a server that hosts
 * no windows, the same tools keep the window through the view request and
 * the standalone holds no layout.
 *
 * Fails if: a served tool goes back to asking the window (its road reads
 * `window`), the window does not hear a served change (the group is not
 * drawn), the view request road is broken (clave_focus never answers), the
 * closed tab is saved back (a row stays drawn, or the layout holds it), or
 * the adopted terminal never reaches the window's store (the window's own
 * listing lacks it).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  spawnAgentTabIn,
  mcpHttpClient,
  mcpEndpoint,
  mcpRoads,
  toolPayload,
  toolErrored,
  callMcp,
  identityOf,
  serverEndpoint,
  spawnJournal,
  until,
  userDataDir,
  fixturePath
} from './harness.mjs'

const ROOT = fixturePath('mcp-served-root')
const WS = {
  id: 'ededeced-0000-4000-8000-0000000000d4',
  name: 'Served tools',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

const seed = (dir) => {
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(dir, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(dir, [ROOT])
}
const decided = (dir) => until(() => serverEndpoint(dir), { tries: 80, gapMs: 250 })

/** The server's layout of one window, through its API. */
const layoutOf = async (disc, key) => {
  const res = await fetch(`${disc.url}/sidebar/layout?windowKey=${key}`, {
    headers: { authorization: `Bearer ${disc.token}` }
  })
  return res.status === 200 ? res.json() : null
}
const sessionOn = async (disc, id) => {
  const res = await fetch(`${disc.url}/sessions/by-id?id=${id}`, {
    headers: { authorization: `Bearer ${disc.token}` }
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}
/** The rendered groups, by id, with their member rows. */
const drawnGroups = (win) =>
  win.evaluate(() =>
    [...document.querySelectorAll('.group-scope')].map((card) => {
      const header = card.querySelector('[data-sidebar-item-type="group"]')
      return {
        id: header?.dataset.sidebarItemId ?? null,
        name: header?.querySelector('span.truncate')?.textContent ?? null,
        rows: [...card.querySelectorAll('.group-rail [data-sidebar-item-id]')].map(
          (row) => row.dataset.sidebarItemId
        )
      }
    })
  )
const rowDrawn = (win, id) =>
  win.evaluate((sid) => !!document.querySelector(`[data-sidebar-item-id="${sid}"]`), id)
/** The road the last call of this command took, as main recorded it. */
const lastRoad = async (app, command) =>
  (await mcpRoads(app)).filter((r) => r.command === command).at(-1)?.road ?? null

export async function run(t) {
  // ── 1. In the app: the mapped tools are served, the others reach the window through the server ──
  {
    const DIR = userDataDir('mcp-served-tools')
    seed(DIR)
    const { app, win } = await launchApp(DIR, { server: 'in-process' })
    try {
      const disc = await decided(DIR)
      t.equal('the app is on its in-process server', disc?.mode, 'in-process')
      const key = (await identityOf(win))?.windowKey
      t.check('the window has a persisted key', typeof key === 'string', key)
      const agent = await spawnAgentTabIn(app, win, DIR)
      t.check('an agent tab holds an MCP token', !!agent?.token, agent)
      const client = mcpHttpClient(mcpEndpoint(DIR), agent.token)
      await client.init()

      // clave_create_group: served, on the server's layout, drawn in the window.
      const created = toolPayload(await client.call('clave_create_group', { name: 'Served' }))
      const groupId = created?.groupId
      t.check('clave_create_group answers a group id', typeof groupId === 'string', created)
      t.equal('and took the server road', await lastRoad(app, 'createGroup'), 'server')
      t.equal('the group carries the caller’s workspace', created?.workspaceId, WS.id)
      const onServer = await until(async () =>
        (await layoutOf(disc, key))?.groups.some((g) => g.id === groupId) ? true : null
      )
      t.check('the server’s layout holds the group', onServer === true)
      const drawn = await until(async () =>
        (await drawnGroups(win)).some((g) => g.id === groupId && g.name === 'Served') ? true : null
      )
      t.check('the window draws the group the server made', drawn === true, {
        groups: await drawnGroups(win)
      })

      // clave_rename of the group: served.
      const renamed = await client.call('clave_rename', {
        target: 'group',
        id: groupId,
        name: 'Served and renamed'
      })
      t.check('clave_rename answers', !toolErrored(renamed), renamed)
      t.equal('and took the server road', await lastRoad(app, 'rename'), 'server')
      const renamedDrawn = await until(async () =>
        (await drawnGroups(win)).some((g) => g.id === groupId && g.name === 'Served and renamed')
          ? true
          : null
      )
      t.check('the window shows the new name', renamedDrawn === true)

      // clave_set_group_view: served, the view on the server's layout.
      const viewed = toolPayload(
        await client.call('clave_set_group_view', {
          groupId,
          url: 'http://127.0.0.1:1/served',
          title: 'A page'
        })
      )
      t.equal(
        'clave_set_group_view answers the view',
        viewed?.view?.url,
        'http://127.0.0.1:1/served'
      )
      t.equal('and took the server road', await lastRoad(app, 'setGroupView'), 'server')
      const viewOnServer = await until(async () => {
        const g = (await layoutOf(disc, key))?.groups.find((g) => g.id === groupId)
        return g?.view?.url === 'http://127.0.0.1:1/served' ? g.view : null
      })
      t.check('the server’s layout carries the view', !!viewOnServer, viewOnServer)

      // clave_move_session into the group: served, the tab inside the group.
      const moved = toolPayload(
        await client.call('clave_move_session', { sessionId: agent.sessionId, groupId })
      )
      t.equal('clave_move_session answers the group', moved?.groupId, groupId)
      t.equal('and took the server road', await lastRoad(app, 'moveSession'), 'server')
      const inGroup = await until(async () =>
        (await drawnGroups(win)).some((g) => g.id === groupId && g.rows.includes(agent.sessionId))
          ? true
          : null
      )
      t.check('the window draws the tab inside the group', inGroup === true, {
        groups: await drawnGroups(win)
      })

      // clave_add_group_terminal: served, the terminal's session started by the
      // server with its link, linked on the layout, taken in by the window.
      const spawns = spawnJournal(DIR)
      const terminal = toolPayload(
        await client.call('clave_add_group_terminal', {
          groupId,
          command: 'sleep 300',
          launch: true
        })
      )
      t.check(
        'clave_add_group_terminal answers a terminal and its session',
        typeof terminal?.terminalId === 'string' && typeof terminal?.sessionId === 'string',
        terminal
      )
      t.equal('and took the server road', await lastRoad(app, 'addGroupTerminal'), 'server')
      const linked = await until(async () => {
        const g = (await layoutOf(disc, key))?.groups.find((g) => g.id === groupId)
        const term = g?.terminals.find((x) => x.id === terminal?.terminalId)
        return term?.sessionId === terminal?.sessionId ? term : null
      })
      t.check('the layout links the terminal to its session', !!linked, linked)
      t.check(
        'the terminal’s process was started as a terminal',
        (await spawns()).some((s) => s.cwd === ROOT && !s.claudeMode),
        await spawns()
      )
      const adopted = await until(async () => {
        const listing = await callMcp(app, 'list', {})
        return listing?.sessions?.some((s) => s.id === terminal?.sessionId) ? true : null
      })
      t.check('the window took the terminal’s session into its own store', adopted === true)

      // A tool that needs the window: through the view request, still done.
      const focused = toolPayload(await client.call('clave_focus', { sessionId: agent.sessionId }))
      t.equal('clave_focus answers', focused?.focused, agent.sessionId)
      t.equal('and took the window road', await lastRoad(app, 'focus'), 'window')

      // clave_list: served, the same shape, with the window's own part.
      const listing = toolPayload(await client.call('clave_list', {}))
      t.equal('clave_list took the server road', await lastRoad(app, 'list'), 'server')
      t.check(
        'clave_list carries the tab, the group and the windows',
        listing?.sessions?.some((s) => s.id === agent.sessionId && s.groupId === groupId) &&
          listing?.groups?.some(
            (g) => g.id === groupId && g.sessionIds.includes(agent.sessionId)
          ) &&
          Array.isArray(listing?.windows) &&
          Array.isArray(listing?.pinnedGroups) &&
          listing?.callerSessionId === agent.sessionId &&
          listing?.callerGroupId === groupId,
        listing
      )
      t.check(
        'and the tab’s account as before',
        listing?.sessions?.find((s) => s.id === agent.sessionId)?.account?.id !== undefined,
        listing?.sessions?.find((s) => s.id === agent.sessionId)
      )

      // clave_close_session: served; the tab leaves the window and the layout.
      const opened = toolPayload(
        await client.call('clave_open_session', { cwd: ROOT, mode: 'terminal', groupId })
      )
      t.check('a second tab opens in the group', typeof opened?.sessionId === 'string', opened)
      const openedDrawn = await until(async () =>
        (await rowDrawn(win, opened.sessionId)) ? true : null
      )
      t.check('and is drawn', openedDrawn === true)
      const closed = toolPayload(
        await client.call('clave_close_session', { sessionId: opened.sessionId })
      )
      t.equal('clave_close_session answers the closed id', closed?.closed, opened.sessionId)
      t.equal('and took the server road', await lastRoad(app, 'closeSession'), 'server')
      const gone = await until(async () => ((await rowDrawn(win, opened.sessionId)) ? null : true))
      t.check('the closed tab leaves the sidebar', gone === true)
      await new Promise((r) => setTimeout(r, 1500))
      const stillGone = !(await rowDrawn(win, opened.sessionId))
      const layoutAfter = await layoutOf(disc, key)
      t.check('and is not saved back', stillGone, { drawn: !stillGone })
      t.check(
        'the server’s layout no longer holds it',
        !layoutAfter?.displayOrder.includes(opened.sessionId) &&
          !layoutAfter?.groups.some((g) => g.sessionIds.includes(opened.sessionId)),
        layoutAfter
      )
      const record = await sessionOn(disc, opened.sessionId)
      t.check(
        'the server no longer runs it',
        record.status !== 200 || record.body?.state === 'ended',
        record
      )
    } finally {
      await app.close()
    }
  }

  // ── 2. Attached to a server with no windows: the tools keep the window through the view request ──
  {
    const DIR = userDataDir('mcp-served-tools-attached')
    seed(DIR)
    const { app, win } = await launchApp(DIR, { server: 'attached' })
    try {
      const disc = await decided(DIR)
      t.equal('the app is attached', disc?.mode, 'attached')
      const token = await until(() =>
        existsSync(path.join(DIR, 'mcp-server.json'))
          ? JSON.parse(readFileSync(path.join(DIR, 'mcp-server.json'), 'utf-8')).token
          : null
      )
      const client = mcpHttpClient(mcpEndpoint(DIR), token)
      await client.init()
      const created = toolPayload(
        await client.call('clave_create_group', { name: 'Through the window' })
      )
      t.check('clave_create_group answers', typeof created?.groupId === 'string', created)
      t.equal(
        'through the window, since the standalone hosts none',
        await lastRoad(app, 'createGroup'),
        'window'
      )
      const drawn = await until(async () =>
        (await drawnGroups(win)).some((g) => g.id === created?.groupId) ? true : null
      )
      t.check('the window draws it', drawn === true, { groups: await drawnGroups(win) })
      const layouts = await fetch(`${disc.url}/sidebar/layouts`, {
        headers: { authorization: `Bearer ${disc.token}` }
      }).then((r) => r.json())
      t.check(
        'the standalone holds no layout for it',
        !layouts.some((l) => l.groups.some((g) => g.id === created?.groupId)),
        layouts
      )
    } finally {
      await app.close()
    }
  }
}
