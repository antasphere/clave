/**
 * `clave_attach_session` nests a tab that exists under another, and takes it
 * out, on every road an agent reaches it by (PRDCT-4997).
 *
 * 1. The desktop's served road: an agent tab's own token over the desktop's
 *    MCP, answered by the server (`mcpRoads` says `server`).
 * 2. A Clave server with no desktop: its own tools, over its MCP, with a
 *    caller chat's own config.
 * 3. A desktop with tabs of a second server: the window's road (a subject
 *    that is a tab of another server, `mcpRoads` says `window`), and the
 *    sidebar's own nesting through the desktop's store.
 *
 * For each: an attach answers `{ sessionId, nestedUnder, changed: true }`,
 * `clave_list` says `nestedUnder`, the record has `spawnedBy`, the layout
 * holds the tab right after its parent with its own nested tabs behind it,
 * the window shows the count; a second identical attach answers `changed:
 * false`; `detach: true` clears it; `"mine"` names the caller on both
 * arguments; a stopped tab nests; and the refusals come back in the rule's
 * words. Runs in every server mode (the desktop part follows
 * CLAVE_E2E_SERVER; the server parts run their own daemons).
 *
 * Fails if: the tool is missing or unlisted on a road, an attach writes no
 * record or no layout, a repeat claims a change, a detach leaves the link,
 * "mine" is not the caller, a refusal is lost or worded otherwise, or a tab
 * of the Mac is nested under a tab of a server.
 *
 * Agents are stand-ins (nest-helpers.mjs, fixtures/claude-stream-stub.mjs):
 * no provider, no account, no network.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  REPO,
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  callMcp,
  until,
  mcpRoads,
  mcpEndpoint,
  serverEndpoint,
  serverDataDirOf,
  spawnAgentTabIn,
  identityOf,
  toolPayload,
  toolErrored
} from './harness.mjs'
import {
  fleetWorld,
  connectMac,
  eventually,
  request,
  owned,
  showServer
} from './fixtures/fleet-world.mjs'
import {
  writeRecordingCli,
  openTab,
  toggleOf,
  recordOf,
  recordIn,
  mcpClient,
  errorText,
  nestBy,
  detachBy
} from './nest-helpers.mjs'

const DIR = userDataDir('nest-tools')
const ROOT = fixturePath('nest-tools-root')
const WS = {
  id: 'nest-tools',
  name: 'Nest tools',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const TOOL = 'clave_attach_session'
const NEEDS_TAB = `${TOOL} must be called from inside a Clave agent tab — this request has no tab identity.`
const BOTH_OR_NEITHER =
  'Pass exactly one of: to (the tab it goes under) or detach: true (take it out)'
const SELF = 'A tab cannot be nested under itself'
const LOOP = 'That tab is nested under this one: take it out first, or nest this tab under another'

/** The flat order of a server layout: top-level ids, a group's sessions in
 *  place of the group. */
const flat = (layout) => {
  if (!layout) return []
  const groups = new Map((layout.groups ?? []).map((g) => [g.id, g]))
  return (layout.displayOrder ?? []).flatMap((id) =>
    groups.has(id) ? [id, ...(groups.get(id).sessionIds ?? [])] : [id]
  )
}
/** What the desktop holds and draws for a nested pair: the store's links and
 *  the rows (a failing check's detail). */
const sidebarFacts = (win, a, b) =>
  win.evaluate(
    ([a, b]) => {
      const s = window.__claveSessionStoreForTests.getState()
      const of = (id) => s.sessions.find((x) => x.id === id)
      return {
        storeA: { spawnedBy: of(a)?.spawnedBy ?? null, type: of(a)?.sessionType ?? null },
        storeB: { found: !!of(b), type: of(b)?.sessionType ?? null },
        rowsA: document.querySelectorAll(`[data-sidebar-item-id="${a}"]`).length,
        rowsB: document.querySelectorAll(`[data-sidebar-item-id="${b}"]`).length,
        nestedRows: document.querySelectorAll('[data-sidebar-nested-root]').length,
        toggles: document.querySelectorAll('.sidebar-nest-toggle').length
      }
    },
    [a, b]
  )
const consecutive = (order, ids) => {
  const at = order.indexOf(ids[0])
  return at >= 0 && ids.every((id, i) => order[at + i] === id)
}

export async function run(t) {
  const eq = (name, actual, expected, detail) =>
    t.check(
      name,
      JSON.stringify(actual) === JSON.stringify(expected),
      detail ?? { expected, got: actual }
    )
  /** One refusal: an error whose text carries the rule's words. */
  const refused = (name, rpc, words) =>
    t.check(name, toolErrored(rpc) && errorText(rpc).includes(words), {
      words,
      got: errorText(rpc)
    })

  let desktopDescription = null
  // ── 1. The desktop's served road ──
  {
    mkdirSync(ROOT, { recursive: true })
    const env = writeRecordingCli(ROOT)
    seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
    seedTrustedRoots(DIR, [ROOT])
    const { app, win } = await launchApp(DIR, { env })
    try {
      const agent = await spawnAgentTabIn(app, win, serverDataDirOf(DIR))
      t.check('an agent tab holds its MCP token', !!agent?.token, agent)
      const me = agent.sessionId
      const client = mcpClient(mcpEndpoint(DIR), agent.token)
      await client.init()
      const tools = await client.tools()
      const listed = tools.find((x) => x.name === TOOL)
      t.check(
        'the desktop lists clave_attach_session',
        !!listed,
        tools.map((x) => x.name)
      )
      desktopDescription = listed?.description ?? null
      t.check(
        'with sessionId, to and detach',
        ['sessionId', 'to', 'detach'].every((k) => k in (listed?.inputSchema?.properties ?? {})),
        listed?.inputSchema
      )

      const lead = await openTab(app, ROOT, 'Lane · Invoice export')
      const verifier = await openTab(app, ROOT, 'Verifier · round 2')
      const notes = await openTab(app, ROOT, 'Release notes')
      const worker = await openTab(app, ROOT, 'Lane · Ledger connector')
      const ended = await openTab(app, ROOT, 'Verifier · round 1')
      await win.evaluate((id) => window.electronAPI.writeSession(id, 'quit\n'), ended)
      const stopped = await until(async () => {
        const l = await callMcp(app, 'list', {})
        return l.sessions.find((s) => s.id === ended)?.alive === false ? true : null
      })
      t.check('the first verifier is stopped, its tab kept', stopped === true)

      const attach = async (args) => client.call(TOOL, args)
      const listing = async () =>
        Object.fromEntries(
          (toolPayload(await client.call('clave_list', {}))?.sessions ?? []).map((s) => [
            s.id,
            s.nestedUnder ?? null
          ])
        )
      const disc = serverEndpoint(DIR)
      const key = (await identityOf(win))?.windowKey
      const serverLayout = async () => {
        const res = await fetch(`${disc.url}/sidebar/layout?windowKey=${key}`, {
          headers: { authorization: `Bearer ${disc.token}` }
        })
        return res.status === 200 ? res.json() : null
      }
      const road = async () =>
        (await mcpRoads(app)).filter((r) => r.command === 'attachSession').at(-1)?.road ?? null

      // The notes under the verifier, then the verifier (and the notes behind
      // it) under the lead.
      const first = toolPayload(await attach({ sessionId: notes, to: verifier }))
      eq('an attach answers the tab, its parent and changed: true', first, {
        sessionId: notes,
        nestedUnder: verifier,
        changed: true
      })
      eq('on the server road', await road(), 'server')
      const second = toolPayload(await attach({ sessionId: verifier, to: lead }))
      eq('a tab with a nested tab is attached the same way', second, {
        sessionId: verifier,
        nestedUnder: lead,
        changed: true
      })
      {
        const l = await listing()
        eq('clave_list says nestedUnder', [l[verifier], l[notes]], [lead, verifier])
        const rec = await until(() =>
          recordOf(DIR, verifier)?.spawnedBy === lead ? recordOf(DIR, verifier) : null
        )
        t.check('the record has spawnedBy', !!rec, recordOf(DIR, verifier))
        // The window's own layout (what the person sees, in every mode), and
        // the server's copy of it.
        const storeOrder = () =>
          win.evaluate(() => {
            const s = window.__claveSessionStoreForTests.getState()
            return { displayOrder: s.displayOrder, groups: s.groups }
          })
        let mine = []
        const placedHere = await until(async () => {
          mine = flat(await storeOrder())
          return consecutive(mine, [lead, verifier, notes]) ? true : null
        })
        t.check(
          'the window’s layout holds the tab right after its parent, its own nested tab behind it',
          placedHere === true,
          mine
        )
        // The server's copy: in-process it is the window's layout; a server
        // running apart may keep no order for the window at all (an empty
        // displayOrder), which is said, not taken for a misplacement.
        let order = []
        let held = null
        const placed = await until(async () => {
          held = await serverLayout()
          order = flat(held)
          return consecutive(order, [lead, verifier, notes]) ? true : null
        })
        const keepsOrder = order.includes(lead)
        t.check(
          'the server’s layout of the window, where it keeps the tabs’ order, holds it there too',
          placed === true || !keepsOrder,
          { mode: disc?.mode, serverLayout: held === null ? 'none for this window' : order }
        )
        console.log(
          `        [${disc?.mode}] the server's layout of the window ${
            keepsOrder ? 'keeps the order' : 'keeps no order of these tabs'
          }; placed right after the parent there: ${placed === true}`
        )
        const shown = await until(async () =>
          (await toggleOf(win, lead))?.count === 2 ? true : null
        )
        t.check('the window shows the count', shown === true, await toggleOf(win, lead))
      }
      eq(
        'a second identical attach answers changed: false',
        toolPayload(await attach({ sessionId: verifier, to: lead })),
        { sessionId: verifier, nestedUnder: lead, changed: false }
      )

      // "mine" on both arguments, and a stopped tab.
      eq(
        '"mine" as the tab names the caller',
        toolPayload(await attach({ sessionId: 'mine', to: lead })),
        { sessionId: me, nestedUnder: lead, changed: true }
      )
      eq(
        'a stopped tab nests, under "mine" as the parent',
        toolPayload(await attach({ sessionId: ended, to: 'mine' })),
        { sessionId: ended, nestedUnder: me, changed: true }
      )
      {
        const rec = await until(() =>
          recordOf(DIR, ended)?.spawnedBy === me ? recordOf(DIR, ended) : null
        )
        t.check("the stopped tab's record has spawnedBy", !!rec, recordOf(DIR, ended))
        eq('clave_list says so for the stopped tab', (await listing())[ended], me)
      }

      // The refusals, in the rule's words.
      refused('itself', await attach({ sessionId: lead, to: lead }), SELF)
      refused('under a tab nested under it', await attach({ sessionId: verifier, to: notes }), LOOP)
      const work = await client.call('clave_set_work', {
        sessionId: worker,
        unit: 'lane-ledger',
        kind: 'lane',
        label: 'Ledger connector',
        role: 'lead'
      })
      t.check('the worker is given a lane', !toolErrored(work), work)
      refused(
        'a tab that works on a lane',
        await attach({ sessionId: worker, to: lead }),
        'This tab works on the lane "Ledger connector", whose entry shows it.'
      )
      refused('neither to nor detach', await attach({ sessionId: notes }), BOTH_OR_NEITHER)
      refused(
        'both to and detach',
        await attach({ sessionId: notes, to: lead, detach: true }),
        BOTH_OR_NEITHER
      )
      refused(
        'an unknown tab',
        await attach({ sessionId: 'no-such-tab', to: lead }),
        'No session with id "no-such-tab"'
      )
      refused(
        'an unknown parent',
        await attach({ sessionId: notes, to: 'no-such-tab' }),
        'No session with id "no-such-tab"'
      )
      {
        const shared = JSON.parse(readFileSync(path.join(DIR, 'mcp-server.json'), 'utf-8')).token
        const anonymous = mcpClient(mcpEndpoint(DIR), shared)
        await anonymous.init()
        refused(
          'no tab identity',
          await anonymous.call(TOOL, { sessionId: notes, to: lead }),
          NEEDS_TAB
        )
      }
      eq(
        'and the refusals wrote nothing',
        await listing().then((l) => [l[lead], l[verifier], l[notes], l[worker]]),
        [null, lead, verifier, null]
      )

      // detach: true clears it.
      eq(
        'detach: true answers the tab out',
        toolPayload(await attach({ sessionId: verifier, detach: true })),
        { sessionId: verifier, nestedUnder: null, changed: true }
      )
      {
        eq('clave_list says nestedUnder null', (await listing())[verifier], null)
        const rec = await until(() => (!recordOf(DIR, verifier)?.spawnedBy ? true : null))
        t.check('the record has no spawnedBy', rec === true, recordOf(DIR, verifier))
        const count = await until(async () =>
          (await toggleOf(win, lead))?.count === 2 ? true : null
        )
        t.check(
          'the window’s count drops (left under the lead: the caller and the tab under it)',
          count === true,
          await toggleOf(win, lead)
        )
        eq('its own nested tab stays under it', (await listing())[notes], verifier)
      }
      eq(
        '"mine" detaches the caller',
        toolPayload(await attach({ sessionId: 'mine', detach: true })),
        { sessionId: me, nestedUnder: null, changed: true }
      )
      // "parent": a tab an agent opened keeps its opener once nested
      // elsewhere; a tab nobody opened answers the tab it is nested under.
      {
        const opened = toolPayload(
          await client.call('clave_open_session', {
            cwd: ROOT,
            mode: 'terminal',
            name: 'Page · invoice export'
          })
        )?.sessionId
        eq(
          'a tab the agent opened is nested under the lead',
          toolPayload(await attach({ sessionId: opened, to: lead }))?.nestedUnder,
          lead
        )
        const rows = toolPayload(await client.call('clave_list', {}))?.sessions ?? []
        const openedRow = rows.find((s) => s.id === opened)
        eq(
          'a tab an agent opened keeps its opener as parentId once nested elsewhere',
          [openedRow?.parentId ?? null, openedRow?.nestedUnder ?? null],
          [me, lead]
        )
        const notesRow = rows.find((s) => s.id === notes)
        eq(
          'a tab nobody opened, once nested, answers its parent as parentId',
          notesRow?.parentId ?? null,
          verifier
        )
        // The agent's own tab was opened by the person (the launcher): once
        // nested, its "parent" for messages is the tab it is nested under.
        eq(
          'the caller (a person’s tab) is nested under the lead',
          toolPayload(await attach({ sessionId: 'mine', to: lead }))?.nestedUnder,
          lead
        )
        const meRow = (toolPayload(await client.call('clave_list', {}))?.sessions ?? []).find(
          (s) => s.id === me
        )
        eq('and clave_list gives it the lead as parentId', meRow?.parentId ?? null, lead)
        const read = await client.call('clave_read_session', { sessionId: 'parent', lines: 5 })
        t.check(
          'and "parent" in the messaging tools reaches the lead',
          !toolErrored(read) && toolPayload(read)?.sessionId === lead,
          errorText(read)
        )
      }
    } finally {
      await app.close()
    }
  }

  // ── 2. A Clave server with no desktop ──
  {
    const world = await fleetWorld('nest-tools-server', { count: 1 })
    try {
      const [server] = world.servers
      await request(server, '/launch-profiles', {
        profile: {
          id: 'nest-tools-stub',
          name: 'Nest tools stream stub',
          family: 'claude',
          command: [process.execPath, path.join(REPO, 'tests/e2e/fixtures/claude-stream-stub.mjs')],
          additionalArgs: []
        }
      })
      const caller = await request(server, '/sessions/start', {
        cwd: server.root,
        options: { claudeMode: true, launchProfileId: 'chat:claude:nest-tools-stub' }
      })
      await request(server, '/sessions/type', { id: caller.id, text: 'caller first message' })
      const configFile = path.join(server.dataDir, 'mcp-configs', `${caller.id}.json`)
      await eventually(() => existsSync(configFile), 'the caller CLI gets its config')
      const entry = JSON.parse(readFileSync(configFile, 'utf8')).mcpServers.clave
      const mcp = mcpClient(entry.url, entry.headers.Authorization.replace(/^Bearer /, ''))
      await mcp.init()
      const tools = await mcp.tools()
      const listed = tools.find((x) => x.name === TOOL)
      t.check(
        'the server lists clave_attach_session',
        !!listed,
        tools.map((x) => x.name)
      )
      eq(
        'with the same description as the desktop’s',
        listed?.description ?? null,
        desktopDescription
      )
      const open = async (name, extra = {}) =>
        toolPayload(
          await mcp.call('clave_open_session', {
            cwd: server.root,
            mode: 'terminal',
            name,
            ...extra
          })
        )?.sessionId
      const lead = await open('Lane · Invoice export')
      const helper = await open('Ledger · fixtures')
      // A stopped tab: a chat whose CLI exited (a daemon drops a terminal
      // whose process ended, record and all, but holds a chat as ended).
      const done = await open('Verifier · round 1', {
        mode: 'claude',
        profile: 'chat:claude:nest-tools-stub'
      })
      const states = async () =>
        Object.fromEntries((await request(server, '/sessions')).map((s) => [s.id, s.state]))
      await request(server, '/sessions/type', { id: done, text: 'verifier first message' })
      const doneConfig = path.join(server.dataDir, 'mcp-configs', `${done}.json`)
      const stubProcesses = () => {
        const f = path.join(server.root, 'claude-stub-processes.jsonl')
        return existsSync(f)
          ? readFileSync(f, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((l) => JSON.parse(l))
          : []
      }
      await eventually(
        () => stubProcesses().some((p) => p.argv.includes(doneConfig)),
        'the verifier chat’s CLI starts'
      )
      process.kill(
        stubProcesses()
          .filter((p) => p.argv.includes(doneConfig))
          .at(-1).pid,
        'SIGTERM'
      )
      const stoppedOk = await until(async () => ((await states())[done] === 'ended' ? true : null))
      t.check('a stopped tab is on the server (its process ended, its record kept)', !!stoppedOk, {
        state: (await states())[done] ?? '(not listed)',
        record: !!recordIn(server.dataDir, done)
      })
      const attach = (args) => mcp.call(TOOL, args)
      eq(
        'an attach on the server answers changed: true',
        toolPayload(await attach({ sessionId: helper, to: lead })),
        { sessionId: helper, nestedUnder: lead, changed: true }
      )
      eq(
        'a stopped tab nests on the server',
        toolPayload(await attach({ sessionId: done, to: lead })),
        { sessionId: done, nestedUnder: lead, changed: true }
      )
      eq(
        'a repeat answers changed: false',
        toolPayload(await attach({ sessionId: helper, to: lead })),
        { sessionId: helper, nestedUnder: lead, changed: false }
      )
      const listing = async () =>
        Object.fromEntries(
          (toolPayload(await mcp.call('clave_list', {}))?.sessions ?? []).map((s) => [
            s.id,
            s.nestedUnder ?? null
          ])
        )
      eq(
        'clave_list on the server says nestedUnder',
        await listing().then((l) => [l[helper], l[done]]),
        [lead, lead]
      )
      t.equal(
        "the record on the server's disk has spawnedBy",
        recordIn(server.dataDir, helper)?.spawnedBy,
        lead
      )
      t.equal("the stopped tab's record too", recordIn(server.dataDir, done)?.spawnedBy, lead)
      {
        const layouts = await request(server, '/sidebar/layouts')
        const all = Array.isArray(layouts) ? layouts : Object.values(layouts ?? {})
        const orders = all.map((l) => flat(l.layout ?? l))
        t.check(
          "the server's sidebar layout holds the tab right after its parent",
          orders.some((o) => consecutive(o, [lead, done]) || consecutive(o, [lead, helper])),
          layouts
        )
      }
      refused('a refusal on the server', await attach({ sessionId: lead, to: lead }), SELF)
      refused('the argument rule on the server', await attach({ sessionId: lead }), BOTH_OR_NEITHER)
      eq('detach on the server', toolPayload(await attach({ sessionId: helper, detach: true })), {
        sessionId: helper,
        nestedUnder: null,
        changed: true
      })
      t.equal('clave_list says it is out', (await listing())[helper], null)
      t.equal(
        "and the server's record has no spawnedBy",
        recordIn(server.dataDir, helper)?.spawnedBy ?? null,
        null
      )
      eq(
        '"mine" names the caller on the server',
        toolPayload(await attach({ sessionId: helper, to: 'mine' })),
        { sessionId: helper, nestedUnder: caller.id, changed: true }
      )
    } finally {
      await world.close()
    }
  }

  // ── 3. A desktop with tabs of a second server ──
  {
    const world = await fleetWorld('nest-tools-fleet')
    try {
      const mac = await world.mac('nest')
      await connectMac(mac, world.servers, { ui: false })
      const [server] = world.servers
      const owner = mac.owners[0]
      const state = JSON.parse(readFileSync(path.join(mac.dir, 'mcp-server.json'), 'utf8'))
      const shared = mcpClient(mcpEndpoint(mac.dir), state.token)
      await shared.init()
      const openOn = async (name) =>
        toolPayload(
          await shared.call('clave_open_session', {
            server: owner.name,
            cwd: server.root,
            mode: 'terminal',
            name
          })
        )?.sessionId
      const a = await openOn('Lane · Invoice export · gen 1')
      const b = await openOn('Lane · Invoice export')
      const c = await openOn('Verifier · round 2')
      const raw = (key) => key.slice(owned('session', owner.id, '').length)
      t.check(
        'three tabs are opened on the server',
        [a, b, c].every(
          (k) => typeof k === 'string' && k.startsWith(owned('session', owner.id, ''))
        ),
        [a, b, c]
      )
      await showServer(mac, 0)
      await eventually(
        async () => (await mac.win.locator(`[data-sidebar-item-id="${b}"]`).count()) > 0,
        'the server tabs are in the sidebar'
      )
      // The sidebar's nesting, through the desktop's store, with the keys.
      eq('the store nests a server tab under another', await nestBy(mac.win, a, b), { ok: true })
      const serverRecord = async (key) =>
        (await request(server, `/sessions/records?ids=${raw(key)}`))?.[0] ?? null
      {
        let rec = null
        const ok = await until(async () => {
          rec = await serverRecord(a)
          return rec?.spawnedBy === raw(b) ? true : null
        })
        t.check(
          "the server's record has spawnedBy with the server's own id, not the key",
          ok === true,
          rec
        )
        const shown = await until(async () =>
          (await toggleOf(mac.win, b))?.count === 1 ? true : null
        )
        t.check('the desktop’s sidebar shows the count', shown === true, {
          toggle: await toggleOf(mac.win, b),
          sidebar: await sidebarFacts(mac.win, a, b)
        })
      }
      // A fresh snapshot: the window reloads and reads the server again.
      await mac.win.reload()
      await mac.win.waitForSelector('html[data-boot="complete"]', { timeout: 30_000 })
      await showServer(mac, 0)
      {
        const kept = await until(async () =>
          (await toggleOf(mac.win, b))?.count === 1 ? true : null
        )
        t.check('a fresh snapshot keeps the nesting', kept === true, {
          toggle: await toggleOf(mac.win, b),
          sidebar: await sidebarFacts(mac.win, a, b)
        })
      }
      eq('the store takes it out', await detachBy(mac.win, a), { ok: true })
      {
        let rec = null
        const ok = await until(async () => {
          rec = await serverRecord(a)
          return rec && !rec.spawnedBy ? true : null
        })
        t.check("the detach clears the server's record", ok === true, rec)
      }
      // A tab of this Mac under a tab of the server: refused, nothing written.
      const local = toolPayload(
        await shared.call('clave_open_session', {
          server: 'local',
          cwd: mac.root,
          mode: 'terminal',
          name: 'Scratch terminal'
        })
      )?.sessionId
      await eventually(
        async () =>
          (await mac.win.evaluate(
            (id) => window.__claveSessionStoreForTests.getState().sessions.some((s) => s.id === id),
            local
          )) === true,
        'the local tab is in the store'
      )
      const cross = await nestBy(mac.win, local, b)
      t.check(
        'a tab of this Mac under a tab of the server is refused in words',
        cross?.ok === false && /different machines/.test(cross?.error ?? ''),
        cross
      )
      t.equal(
        "and writes nothing on the Mac's record",
        recordOf(mac.dir, local)?.spawnedBy ?? null,
        null
      )
      t.equal("nor on the server's", (await serverRecord(b))?.spawnedBy ?? null, null)

      // The window's road: an agent tab of this Mac nests two server tabs.
      const parent = toolPayload(
        await shared.call('clave_open_session', {
          server: 'local',
          cwd: mac.root,
          mode: 'claude',
          profile: 'fleet-title-fixture',
          name: 'Coordinator'
        })
      )
      let token = null
      await eventually(async () => {
        try {
          const config = JSON.parse(
            readFileSync(path.join(mac.dir, 'mcp-configs', parent.sessionId + '.json'), 'utf8')
          )
          token = config.mcpServers.clave.headers.Authorization.replace(/^Bearer /, '')
          return !!token
        } catch {
          return false
        }
      }, 'the local agent tab has its MCP token')
      const agent = mcpClient(mcpEndpoint(mac.dir), token)
      await agent.init()
      const viaWindow = await agent.call(TOOL, { sessionId: c, to: b })
      eq('on the window’s road, an attach answers changed: true', toolPayload(viaWindow), {
        sessionId: c,
        nestedUnder: b,
        changed: true
      })
      eq(
        'and the road is the window',
        (await mcpRoads(mac.app)).filter((r) => r.command === 'attachSession').at(-1)?.road ?? null,
        'window'
      )
      {
        let rec = null
        const ok = await until(async () => {
          rec = await serverRecord(c)
          return rec?.spawnedBy === raw(b) ? true : null
        })
        t.check("the window's road writes the server's record", ok === true, rec)
        const shown = await until(async () =>
          (await toggleOf(mac.win, b))?.count === 1 ? true : null
        )
        t.check('and the sidebar counts it', shown === true, {
          toggle: await toggleOf(mac.win, b),
          sidebar: await sidebarFacts(mac.win, c, b)
        })
      }
      eq(
        'a repeat on the window’s road answers changed: false',
        toolPayload(await agent.call(TOOL, { sessionId: c, to: b })),
        { sessionId: c, nestedUnder: b, changed: false }
      )
      refused(
        'a refusal on the window’s road, in the rule’s words',
        await agent.call(TOOL, { sessionId: b, to: b }),
        SELF
      )
      refused(
        'a Mac tab under a server tab, on the window’s road',
        await agent.call(TOOL, { sessionId: 'mine', to: b }),
        'different machines'
      )
      eq(
        'detach on the window’s road',
        toolPayload(await agent.call(TOOL, { sessionId: c, detach: true })),
        { sessionId: c, nestedUnder: null, changed: true }
      )
      {
        let rec = null
        const ok = await until(async () => {
          rec = await serverRecord(c)
          return rec && !rec.spawnedBy ? true : null
        })
        t.check("and the server's record is cleared", ok === true, rec)
      }
    } finally {
      await world.close()
    }
  }
}
