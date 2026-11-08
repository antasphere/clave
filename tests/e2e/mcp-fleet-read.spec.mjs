/**
 * An agent reads back a tab it opened on a connected server (PRDCT-4166):
 * clave_read_session resolves the tab by the key clave_open_session returned
 * (`clave-owner:session:<serverId>:<id>`) and by its exact name, and answers
 * the recent output the owning server keeps. On the fleet harness: one
 * standalone server, one Mac, a Claude tab on the Mac as the caller (its own
 * token is what gives the read a tab identity and the reach rule a parent).
 *
 * Fails if: the read of the returned key or of the name says no such
 * session (what 7 November 2026 showed), or the text read is not what the
 * server tab printed.
 */
import assert from 'node:assert/strict'
import { fleetWorld, connectMac, eventually, request, owned } from './fixtures/fleet-world.mjs'
import {
  mcpHttpClient,
  mcpEndpoint,
  toolPayload,
  toolErrored,
  spawnAgentTabIn,
  until
} from './harness.mjs'

export async function run(t) {
  const world = await fleetWorld('mcp-read', { count: 1 })
  try {
    const [server] = world.servers
    const mac = await world.mac('read')
    await connectMac(mac, world.servers, { ui: false })
    const owner = mac.owners[0]
    const { win } = mac

    // The caller: a Claude tab of this Mac, whose token names it to the tools.
    const caller = await spawnAgentTabIn(mac.app, win, mac.dir)
    assert.ok(caller?.token, 'the caller tab has an MCP token')
    const mcp = mcpHttpClient(mcpEndpoint(mac.dir), caller.token)
    await mcp.init()

    const marker = `fleet-read-marker-${world.run.slice(-8)}`
    const name = 'Read me on the server'
    const opened = await mcp.call('clave_open_session', {
      server: owner.name,
      cwd: server.root,
      mode: 'terminal',
      command: `echo ${marker}`,
      name
    })
    assert.equal(toolErrored(opened), false, JSON.stringify(opened))
    const created = toolPayload(opened)
    t.check(
      'the tab opened on the server carries the server’s key',
      created.sessionId.startsWith(owned('session', owner.id, '')),
      created
    )
    await eventually(
      async () =>
        (await request(server, '/sessions')).some((s) => created.sessionId.endsWith(s.id)),
      'the server lists the tab'
    )

    // By the key the open returned.
    const byId = await until(async () => {
      const answer = await mcp.call('clave_read_session', { sessionId: created.sessionId })
      if (toolErrored(answer)) return { error: answer }
      const payload = toolPayload(answer)
      return payload?.text?.includes(marker) ? payload : null
    })
    t.check(
      'clave_read_session resolves the server tab by the key clave_open_session returned',
      byId && !byId.error && byId.sessionId === created.sessionId,
      byId
    )
    t.check('and answers what the tab printed on the server', !!byId?.text?.includes(marker))
    t.equal('the read names the tab', byId?.name, name)
    t.check('and says it is alive', byId?.alive === true, byId)

    // By its exact name.
    const byNameRaw = await mcp.call('clave_read_session', { sessionId: name, lines: 20 })
    const byName = toolPayload(byNameRaw)
    t.check(
      'clave_read_session resolves the server tab by its name',
      !toolErrored(byNameRaw) && byName?.sessionId === created.sessionId,
      byNameRaw
    )
    t.check('and reads the same output', !!byName?.text?.includes(marker))

    // A tab nobody related opened stays out of reach, on a server as here.
    const sharedToken = JSON.parse(
      (await import('node:fs')).readFileSync(`${mac.dir}/mcp-server.json`, 'utf-8')
    ).token
    const anonymous = mcpHttpClient(mcpEndpoint(mac.dir), sharedToken)
    await anonymous.init()
    const refused = await anonymous.call('clave_read_session', { sessionId: created.sessionId })
    t.check(
      'a caller with no tab identity is refused the server tab',
      toolErrored(refused),
      refused
    )

    assert.deepEqual(mac.errors, [])
  } finally {
    await world.close()
  }
}
