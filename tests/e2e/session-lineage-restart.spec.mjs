/**
 * A tab an agent opened stays that agent's child across a restart (#259).
 *
 * The parent link is what folds a delegated agent under the tab that opened
 * it (the sidebar's subagent selector, #216) and what `"parent"` resolves to
 * in `clave_send_to_session` / `clave_read_session`. This drives the road real
 * agents take — `clave_open_session` over the MCP endpoint with the parent
 * tab's own token, served by main — never the window's dispatcher
 * (`callMcp`), which is a road no agent uses.
 *
 * Proves, in order: the child's record names its parent; the child is folded
 * under its parent; the child reaches `"parent"`; and all three again after
 * a quit with the tmux sessions still running (reattach), and after a quit
 * with the tmux server gone (the records offered, restored and respawned).
 *
 * Fails if: the served open does not write the parent into the record, the
 * window builds the tab from its record without the link (the child gets an
 * ordinary row), or main's lineage is not rebuilt from the records at the
 * next launch (`"parent"` answers "no live parent").
 *
 * The agents are a stand-in `claude` on PATH (a process that waits): every
 * Claude-mode tab gets its MCP token, and no provider is called.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  until,
  userDataDir,
  fixturePath,
  killLeakedE2eTmux
} from './harness.mjs'

const DIR = userDataDir('session-lineage-restart')
const ROOT = fixturePath('session-lineage-restart-root')
const WS = {
  id: 'abababab-0000-4000-8000-0000000000e7',
  name: 'Lineage',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

/** A `claude` that only waits, and a login shell that puts it first on PATH. */
const seedStandIns = () => {
  mkdirSync(path.join(ROOT, 'bin'), { recursive: true })
  writeFileSync(
    path.join(ROOT, 'bin', 'claude'),
    `#!/bin/sh
echo "stand-in claude $CLAVE_SESSION_ID"
exec tail -f /dev/null
`,
    { mode: 0o755 }
  )
  writeFileSync(
    path.join(ROOT, 'bin', 'sh'),
    `#!/bin/sh
export PATH='${ROOT}/bin':"$PATH"
[ "$1" = '-l' ] && shift
exec /bin/sh "$@"
`,
    { mode: 0o755 }
  )
}
const ENV = { SHELL: path.join(ROOT, 'bin', 'sh'), PATH: `${ROOT}/bin:${process.env.PATH}` }

/** The token of a tab: its own mcp-config, as the agent inside it reads it. */
const tokenOf = (sessionId) => {
  const file = path.join(DIR, 'mcp-configs', `${sessionId}.json`)
  if (!existsSync(file)) return null
  return (
    JSON.parse(readFileSync(file, 'utf-8')).mcpServers?.clave?.headers?.Authorization?.replace(
      /^Bearer /,
      ''
    ) ?? null
  )
}
const clientOf = async (sessionId) => {
  const token = await until(() => tokenOf(sessionId))
  if (!token) return null
  const client = mcpHttpClient(mcpEndpoint(DIR), token)
  await client.init()
  return client
}
const recordOf = async (win, id) =>
  (
    await win.evaluate(
      (wanted) => window.electronAPI.listSessionRecords({ ids: [wanted] }),
      id
    )
  )?.[0] ?? null
const rows = (win, id) =>
  win.evaluate((sid) => document.querySelectorAll(`[data-sidebar-item-id="${sid}"]`).length, id)
const triggers = (win, id) =>
  win.evaluate(
    (sid) =>
      document.querySelectorAll(`[data-sidebar-item-id="${sid}"] .subagent-trigger`).length,
    id
  )

/** The three facts, checked on one running app. */
async function checkLineage(t, label, app, win, parent, child) {
  const listed = await until(async () => {
    const l = await callMcp(app, 'list', {})
    const ids = new Set((l?.sessions ?? []).filter((s) => s.alive).map((s) => s.id))
    return ids.has(parent) && ids.has(child) ? true : null
  })
  t.check(`${label}: parent and child are both open and alive`, listed === true)

  const record = await recordOf(win, child)
  t.equal(`${label}: the child's record names its parent`, record?.spawnedBy, parent)

  const folded = await until(
    async () =>
      (await rows(win, parent)) === 1 &&
      (await rows(win, child)) === 0 &&
      (await triggers(win, parent)) === 1
        ? true
        : null,
    { tries: 40, gapMs: 250 }
  )
  t.check(`${label}: the child is folded under its parent's selector`, folded === true, {
    parentRows: await rows(win, parent),
    childRows: await rows(win, child),
    parentTriggers: await triggers(win, parent)
  })

  const client = await clientOf(child)
  t.check(`${label}: the child holds an MCP token`, !!client)
  const read = client ? await client.call('clave_read_session', { sessionId: 'parent', lines: 5 }) : null
  t.check(`${label}: the child reaches "parent"`, !!read && !toolErrored(read), read)
}

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  rmSync(ROOT, { recursive: true, force: true })
  seedStandIns()
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  killLeakedE2eTmux()

  let app = null
  let parent = null
  let child = null
  try {
    // ── 1. Opened by an agent, on the agents' own road ──
    const first = await launchApp(DIR, { env: ENV })
    app = first.app
    const agent = await spawnAgentTabIn(app, first.win, DIR)
    t.check('a parent agent tab holds an MCP token', !!agent?.token, agent)
    parent = agent.sessionId
    const client = mcpHttpClient(mcpEndpoint(DIR), agent.token)
    await client.init()
    const opened = toolPayload(
      await client.call('clave_open_session', {
        cwd: ROOT,
        mode: 'claude',
        profile: 'builtin-claude',
        name: 'Delegated'
      })
    )
    child = opened?.sessionId ?? null
    t.check('the parent opens a child', typeof child === 'string', opened)
    const road = (await mcpRoads(app)).filter((r) => r.command === 'openSession').at(-1)?.road
    t.equal('on the server road, as real agents do', road, 'server')
    await checkLineage(t, 'opened', app, first.win, parent, child)

    // ── 2. A quit with the tmux sessions still running: reattached ──
    await app.close()
    app = null
    const second = await launchApp(DIR, { env: ENV, settleMs: 1500 })
    app = second.app
    await checkLineage(t, 'after a restart (reattached)', app, second.win, parent, child)

    // ── 3. A quit that takes the tmux server with it: respawned from the records ──
    await app.close()
    app = null
    killLeakedE2eTmux()
    const third = await launchApp(DIR, { env: ENV, settleMs: 1500 })
    app = third.app
    // Dead records are offered, not relaunched unasked (the restore prompt).
    const restore = third.win.getByRole('button', { name: 'Restore', exact: true })
    const prompted = await until(() => restore.isVisible().catch(() => false), { tries: 80 })
    t.check('the dead records are offered for relaunch', !!prompted)
    if (prompted) await restore.click()
    await checkLineage(t, 'after a restart (respawned)', app, third.win, parent, child)
  } finally {
    if (app) {
      for (const id of [child, parent])
        if (id) await callMcp(app, 'closeSession', { sessionId: id }).catch(() => {})
      await app.close().catch(() => {})
    }
    killLeakedE2eTmux()
  }
}
