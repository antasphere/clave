/**
 * The agent tools are served by the server, first part (PRDCT-3294) and the
 * last seven (PRDCT-3377, wave 4: a tab's rename, the page on its row, a
 * screen read, a message typed in, an account switch, a session opened, a
 * pinned group launched, each with no window asked). What
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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
  writeJournal,
  sidebarRows,
  until,
  userDataDir,
  fixturePath
} from './harness.mjs'

const ROOT = fixturePath('mcp-served-root')
// The pinned group comes from the workspace's own .clave, as real pins do.
const CLAVE = path.join(ROOT, 'served.clave')
const WS = {
  id: 'ededeced-0000-4000-8000-0000000000d4',
  name: 'Served tools',
  rootDir: ROOT,
  profileFile: CLAVE,
  createdAt: 1
}

const seed = (dir) => {
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(
    CLAVE,
    JSON.stringify({
      $schema: 'clave/1.0',
      name: 'Served pin',
      cwd: '.',
      sessions: [
        {
          cwd: '.',
          name: 'pinned shell',
          claudeMode: false,
          antigravityMode: false,
          codexMode: false,
          dangerousMode: false
        }
      ],
      terminals: [{ command: 'sleep 300', commandMode: 'auto', color: 'green' }]
    })
  )
  seedWorkspaces(dir, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(dir, [ROOT])
  // The switching mode of this workspace is automatic: a served switch is
  // made rather than proposed (a proposal is the window's, by design).
  writeFileSync(
    path.join(dir, 'clave-preferences.json'),
    JSON.stringify({ accountSwitchModeByWorkspace: { [WS.id]: 'automatic' } })
  )
}
/** The token of a tab the agent tools opened: its own mcp-config. */
const tokenOf = (dir, sessionId) => {
  const file = path.join(dir, 'mcp-configs', `${sessionId}.json`)
  if (!existsSync(file)) return null
  return (
    JSON.parse(readFileSync(file, 'utf-8')).mcpServers?.clave?.headers?.Authorization?.replace(
      /^Bearer /,
      ''
    ) ?? null
  )
}
/** The records main keeps, by id, as the window reads them. */
const recordsOf = (win, ids) =>
  win.evaluate((wanted) => window.electronAPI.listSessionRecords({ ids: wanted }), ids)
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

      // ── Wave 4: the last seven, each on the server road ──

      // clave_rename of a TAB: served; the record carries it, the window shows it.
      const renamedTab = await client.call('clave_rename', {
        target: 'session',
        id: agent.sessionId,
        name: 'Renamed by the server'
      })
      t.check('clave_rename of a tab answers', !toolErrored(renamedTab), renamedTab)
      t.equal('and took the server road', await lastRoad(app, 'rename'), 'server')
      const tabRecord = (await recordsOf(win, [agent.sessionId]))[0]
      t.check(
        'the record holds the name, protected from the auto-title',
        tabRecord?.displayName === 'Renamed by the server' && tabRecord?.userRenamed === true,
        tabRecord
      )
      const nameShown = await until(async () =>
        (await sidebarRows(win)).some((r) => r.includes('Renamed by the server')) ? true : null
      )
      t.check('the window shows the new name', nameShown === true, await sidebarRows(win))

      // clave_set_session_view: served; the page on the record, the serving
      // session started hidden by the server, the window's store follows.
      const viewSpawns = spawnJournal(DIR)
      const paged = toolPayload(
        await client.call('clave_set_session_view', {
          sessionId: agent.sessionId,
          url: 'http://127.0.0.1:1/tab-page',
          title: 'Tab page',
          command: 'sleep 300'
        })
      )
      t.equal(
        'clave_set_session_view answers the view',
        paged?.view?.url,
        'http://127.0.0.1:1/tab-page'
      )
      t.equal('and took the server road', await lastRoad(app, 'setSessionView'), 'server')
      const pageRecord = (await recordsOf(win, [agent.sessionId]))[0]
      t.check(
        'the record carries the page and its command',
        pageRecord?.view?.url === 'http://127.0.0.1:1/tab-page' &&
          pageRecord?.view?.command === 'sleep 300',
        pageRecord?.view
      )
      t.check(
        'the serving session was started as a terminal in the tab’s directory',
        (await viewSpawns()).some((x) => x.cwd === ROOT && !x.claudeMode),
        await viewSpawns()
      )
      const pageInStore = await until(async () => {
        const l = await callMcp(app, 'list', {})
        const v = l?.sessions?.find((x) => x.id === agent.sessionId)?.view
        return v?.url === 'http://127.0.0.1:1/tab-page' ? v : null
      })
      t.check('the window’s store shows the page on the tab', !!pageInStore, pageInStore)
      const detached = toolPayload(
        await client.call('clave_set_session_view', { sessionId: agent.sessionId, url: null })
      )
      t.equal('a detach answers no view', detached?.view, null)
      const pageGone = await until(async () => {
        const l = await callMcp(app, 'list', {})
        return l?.sessions?.find((x) => x.id === agent.sessionId)?.view ? null : true
      })
      t.check('and the window’s store shows none', pageGone === true)

      // clave_open_session of an agent tab: served; the window takes the tab in
      // from its record and names it.
      const worker = toolPayload(
        await client.call('clave_open_session', { cwd: ROOT, mode: 'claude', name: 'Worker' })
      )
      t.check('clave_open_session answers a session', typeof worker?.sessionId === 'string', worker)
      t.equal('and took the server road', await lastRoad(app, 'openSession'), 'server')
      const workerDrawn = await until(async () =>
        (await rowDrawn(win, worker.sessionId)) ? true : null
      )
      t.check('the window draws the tab the server opened', workerDrawn === true)
      const workerListed = await until(async () => {
        const l = await callMcp(app, 'list', {})
        const x = l?.sessions?.find((y) => y.id === worker.sessionId)
        return x?.name === 'Worker' ? x : null
      })
      t.check('and knows it by the name the agent gave', !!workerListed, workerListed)

      // clave_send_to_session into the tab it opened: served; the bytes reach
      // the worker's terminal as one bracketed paste under the header.
      const writes = writeJournal(DIR)
      const sent = toolPayload(
        await client.call('clave_send_to_session', {
          sessionId: worker.sessionId,
          message: 'hello from the server road\nsecond line'
        })
      )
      t.check('clave_send_to_session answers delivered', sent?.delivered === true, sent)
      t.equal('and took the server road', await lastRoad(app, 'sendToSession'), 'server')
      const typed = await until(async () => {
        const w = await writes(worker.sessionId)
        return w.includes('\x1b[201~\r') ? w : null
      })
      t.check(
        'the message was typed as one bracketed paste under its provenance header, then submitted',
        typeof typed === 'string' &&
          typed.includes('\x1b[200~[Message from Clave tab "Renamed by the server"') &&
          typed.includes('hello from the server road\nsecond line\x1b[201~') &&
          typed.endsWith('\x1b[201~\r'),
        typed
      )

      // The worker answers its parent: the link the server kept.
      const workerToken = await until(() => tokenOf(DIR, worker.sessionId))
      t.check('the worker holds a token of its own', !!workerToken)
      const workerClient = mcpHttpClient(mcpEndpoint(DIR), workerToken)
      await workerClient.init()
      const parentWrites = writeJournal(DIR)
      const back = toolPayload(
        await workerClient.call('clave_send_to_session', { sessionId: 'parent', message: 'done' })
      )
      t.equal('the worker reaches "parent"', back?.sessionId, agent.sessionId)
      const backTyped = await until(async () => {
        const w = await parentWrites(agent.sessionId)
        return w.includes('done\x1b[201~') ? w : null
      })
      t.check('and its message reaches the parent’s terminal', !!backTyped)

      // A tab nobody related opened is out of reach, and nothing is typed.
      const sharedToken = JSON.parse(readFileSync(path.join(DIR, 'mcp-server.json'), 'utf-8')).token
      const anonymous = mcpHttpClient(mcpEndpoint(DIR), sharedToken)
      await anonymous.init()
      const stranger = toolPayload(
        await anonymous.call('clave_open_session', { cwd: ROOT, mode: 'claude', name: 'Stranger' })
      )
      t.check('a tab opens with no caller', typeof stranger?.sessionId === 'string', stranger)
      const strangerWrites = writeJournal(DIR)
      const refused = await client.call('clave_send_to_session', {
        sessionId: stranger.sessionId,
        message: 'nope'
      })
      t.check(
        'a message to an unrelated tab is refused',
        toolErrored(refused) && JSON.stringify(refused).includes('not related to yours'),
        refused
      )
      await new Promise((r) => setTimeout(r, 400))
      t.equal('and nothing was typed into it', await strangerWrites(stranger.sessionId), '')

      // clave_read_session: served, off the server's retained output.
      const read = toolPayload(
        await client.call('clave_read_session', { sessionId: worker.sessionId, lines: 50 })
      )
      t.check(
        'clave_read_session answers the worker’s screen',
        read?.sessionId === worker.sessionId &&
          typeof read?.text === 'string' &&
          typeof read?.lines === 'number' &&
          read?.alive === true,
        read
      )
      t.equal('and took the server road', await lastRoad(app, 'readSession'), 'server')
      const readParent = toolPayload(
        await workerClient.call('clave_read_session', { sessionId: 'parent' })
      )
      t.equal('the worker reads its parent', readParent?.sessionId, agent.sessionId)

      // clave_switch_account: served in automatic mode; the tab's own pin and
      // mode asked of the window first.
      const switched = toolPayload(
        await client.call('clave_switch_account', {
          sessionId: agent.sessionId,
          account: 'default'
        })
      )
      t.check(
        'clave_switch_account answers a switch, not a proposal',
        switched?.switched === true && switched?.proposed === false,
        switched
      )
      t.equal('and took the server road', await lastRoad(app, 'switchAccount'), 'server')
      t.equal(
        'after asking the window for the tab’s pin and mode',
        await lastRoad(app, 'sessionSwitchState'),
        'window'
      )

      // clave_launch_group: served; the sessions start on the server, the group
      // is made, and the window links it to its pin.
      const pinKnown = await until(async () => {
        const l = await callMcp(app, 'list', {})
        const pin = l?.pinnedGroups?.find((pg) => pg.name === 'Served pin')
        const persisted = JSON.parse(readFileSync(path.join(DIR, 'workspace-state.json'), 'utf-8'))
        return pin && persisted.pins?.some((x) => x.name === 'Served pin') ? pin : null
      })
      t.check('the workspace’s pin is known to the window and to main', !!pinKnown, pinKnown)
      const pinSpawns = spawnJournal(DIR)
      const launched = toolPayload(await client.call('clave_launch_group', { group: 'Served pin' }))
      t.check(
        'clave_launch_group answers a launch',
        launched?.status === 'launched' && typeof launched?.groupId === 'string',
        launched
      )
      t.equal('and took the server road', await lastRoad(app, 'launchGroup'), 'server')
      t.check(
        'the pin’s session was started as a plain shell at the workspace root',
        (await pinSpawns()).some((x) => x.cwd === ROOT && !x.claudeMode),
        await pinSpawns()
      )
      const pinGroupDrawn = await until(
        async () =>
          (await drawnGroups(win)).find(
            (g) => g.id === launched?.groupId && g.name === 'Served pin'
          ) ?? null
      )
      t.check(
        'the window draws the group with its member',
        pinGroupDrawn?.rows?.length === 1,
        pinGroupDrawn
      )
      const pinLinked = await until(async () => {
        const l = await callMcp(app, 'list', {})
        const pin = l?.pinnedGroups?.find((pg) => pg.name === 'Served pin')
        return pin?.activeGroupId === launched?.groupId && pin?.state === 'active-visible'
          ? pin
          : null
      })
      t.check('and links the pin to the live group', !!pinLinked, pinLinked)
      const again = toolPayload(await client.call('clave_launch_group', { group: 'Served pin' }))
      t.equal('a second launch finds it running', again?.status, 'already-running')
      t.equal('with the window asked', await lastRoad(app, 'pinnedState'), 'window')
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
      // ── Wave 4: the last seven take the server road attached too. The
      // sessions are the standalone's; the sidebar stays the shell's, so a
      // tab the server opened is placed by main's own layouts and the window
      // hears it over IPC. The caller is a tab the server started: its token
      // is the server's, resolved by main through the server (lane C).
      const serverDir = fixturePath('mcp-served-tools-attached-server')
      const configsBefore = new Set(
        existsSync(path.join(serverDir, 'mcp-configs'))
          ? readdirSync(path.join(serverDir, 'mcp-configs'))
          : []
      )
      await win.click('.launcher-split .launcher-btn')
      const agentCfg = await until(() => {
        const d = path.join(serverDir, 'mcp-configs')
        if (!existsSync(d)) return null
        const f = readdirSync(d).find((x) => x.endsWith('.json') && !configsBefore.has(x))
        return f ? { sessionId: f.replace(/\.json$/, ''), file: path.join(d, f) } : null
      })
      t.check('the server minted a config for the agent tab', !!agentCfg, agentCfg)
      const agentToken = JSON.parse(
        readFileSync(agentCfg.file, 'utf-8')
      ).mcpServers?.clave?.headers?.Authorization?.replace(/^Bearer /, '')
      const agent = mcpHttpClient(mcpEndpoint(DIR), agentToken)
      await agent.init()

      // A tab opened, named and placed: served; the window takes it in.
      const worker = toolPayload(
        await agent.call('clave_open_session', { cwd: ROOT, mode: 'claude', name: 'Worker' })
      )
      t.check('clave_open_session answers a session', typeof worker?.sessionId === 'string', worker)
      t.equal('on the server road, attached', await lastRoad(app, 'openSession'), 'server')
      const workerDrawn = await until(async () =>
        (await rowDrawn(win, worker.sessionId)) ? true : null
      )
      t.check('the window draws the tab the server opened', workerDrawn === true)
      const onServer = await sessionOn(disc, worker.sessionId)
      t.check('and the standalone runs it', onServer.status === 200, onServer)

      // A rename: served; the standalone's record carries it, the window shows it.
      const renamed = await agent.call('clave_rename', {
        target: 'session',
        id: worker.sessionId,
        name: 'Renamed on the server'
      })
      t.check('a tab’s rename answers', !toolErrored(renamed), renamed)
      t.equal('on the server road, attached', await lastRoad(app, 'rename'), 'server')
      const shown = await until(async () =>
        (await sidebarRows(win)).some((r) => r.includes('Renamed on the server')) ? true : null
      )
      t.check('and the window shows the name', shown === true, await sidebarRows(win))
      const records = await fetch(`${disc.url}/sessions/records?ids=${worker.sessionId}`, {
        headers: { authorization: `Bearer ${disc.token}` }
      }).then((r) => r.json())
      t.check(
        'the standalone’s record holds the name',
        records?.[0]?.displayName === 'Renamed on the server',
        records
      )

      // A message typed into the worker: served; the bytes reach the
      // standalone's terminal, journaled there.
      const writes = writeJournal(DIR)
      const sent = toolPayload(
        await agent.call('clave_send_to_session', {
          sessionId: worker.sessionId,
          message: 'hello attached'
        })
      )
      t.check('clave_send_to_session answers delivered', sent?.delivered === true, sent)
      t.equal('on the server road, attached', await lastRoad(app, 'sendToSession'), 'server')
      const typed = await until(async () => {
        const w = await writes(worker.sessionId)
        return w.includes('hello attached\x1b[201~') ? w : null
      })
      t.check('the message was typed into the standalone’s terminal', !!typed, typed)

      // A screen read: served, off the standalone's retained output.
      const read = toolPayload(
        await agent.call('clave_read_session', { sessionId: worker.sessionId })
      )
      t.check(
        'clave_read_session answers the worker’s screen',
        read?.sessionId === worker.sessionId && typeof read?.text === 'string',
        read
      )
      t.equal('on the server road, attached', await lastRoad(app, 'readSession'), 'server')

      // A page on the worker's row: served; the standalone's record carries it.
      const paged = toolPayload(
        await agent.call('clave_set_session_view', {
          sessionId: worker.sessionId,
          url: 'http://127.0.0.1:1/attached-page',
          title: 'Attached page'
        })
      )
      t.equal(
        'clave_set_session_view answers',
        paged?.view?.url,
        'http://127.0.0.1:1/attached-page'
      )
      t.equal('on the server road, attached', await lastRoad(app, 'setSessionView'), 'server')
      const pageRecords = await fetch(`${disc.url}/sessions/records?ids=${worker.sessionId}`, {
        headers: { authorization: `Bearer ${disc.token}` }
      }).then((r) => r.json())
      t.equal(
        'the standalone’s record holds the page',
        pageRecords?.[0]?.view?.url,
        'http://127.0.0.1:1/attached-page'
      )
      const pageShown = await until(async () => {
        const l = await callMcp(app, 'list', {})
        return l?.sessions?.find((x) => x.id === worker.sessionId)?.view?.url ===
          'http://127.0.0.1:1/attached-page'
          ? true
          : null
      })
      t.check('and the window’s store shows it', pageShown === true)

      // A switch: served in automatic mode, the window asked for the tab's own pin first.
      const switched = toolPayload(
        await agent.call('clave_switch_account', {
          sessionId: worker.sessionId,
          account: 'default'
        })
      )
      t.check('clave_switch_account answers a switch', switched?.switched === true, switched)
      t.equal('on the server road, attached', await lastRoad(app, 'switchAccount'), 'server')

      // The wave 3 tools keep the window attached, as before.
      const grouped = toolPayload(
        await agent.call('clave_create_group', { name: 'Still the window' })
      )
      t.check('clave_create_group still answers', typeof grouped?.groupId === 'string', grouped)
      t.equal('through the window', await lastRoad(app, 'createGroup'), 'window')
    } finally {
      await app.close()
    }
  }
}
