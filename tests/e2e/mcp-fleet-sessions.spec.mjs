import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  fleetWorld,
  connectMac,
  eventually,
  request,
  owned,
  showServer
} from './fixtures/fleet-world.mjs'
import { mcpHttpClient, mcpEndpoint, toolPayload, toolErrored } from './harness.mjs'

export async function run(t) {
  const world = await fleetWorld('mcp-session')
  try {
    const fixture = world.load()
    const mac = await world.mac('mcp')
    await connectMac(mac, world.servers, { ui: false })
    const state = JSON.parse(readFileSync(path.join(mac.dir, 'mcp-server.json'), 'utf8'))
    const mcp = mcpHttpClient(mcpEndpoint(mac.dir), state.token)
    await mcp.init()
    const list = toolPayload(await mcp.call('clave_list', {}))
    assert.ok(
      list.servers?.some((s) => s.id === mac.owners[0].id),
      'MCP discovers remote servers'
    )
    t.check('MCP lists connected servers with usable IDs', true)
    const before = await Promise.all(world.servers.map((s) => request(s, '/sessions')))
    const result = await mcp.call('clave_open_session', {
      server: mac.owners[1].name,
      cwd: world.servers[1].root,
      mode: 'claude',
      profile: 'dev-echo-adapter',
      name: 'MCP remote proof',
      prompt: 'mcp remote marker'
    })
    assert.equal(toolErrored(result), false, JSON.stringify(result))
    const created = toolPayload(result)
    assert.equal(created.serverId, mac.owners[1].id)
    assert.ok(created.sessionId.startsWith(owned('session', mac.owners[1].id, '')))
    await eventually(
      async () =>
        JSON.stringify(await request(world.servers[1], '/sessions')).includes('MCP remote proof'),
      'destination has named session'
    )
    assert.equal((await request(world.servers[0], '/sessions')).length, before[0].length)
    await showServer(mac, 1)
    await eventually(
      async () =>
        (await mac.win.locator(`[data-sidebar-item-id="${created.sessionId}"]`).count()) > 0,
      'remote session is visible'
    )
    t.check('HTTP MCP opens a named agent on the selected server and shows its tab', true)
    for (const args of [
      { server: 'unknown' },
      {
        server: mac.owners[1].id,
        groupId: owned('group', mac.owners[0].id, fixture.values.first.groupId)
      }
    ]) {
      const denied = await mcp.call('clave_open_session', {
        cwd: mac.root,
        mode: 'terminal',
        ...args
      })
      assert.equal(toolErrored(denied), true, 'bad target refused before spawn')
    }
    const after = await Promise.all(world.servers.map((s) => request(s, '/sessions')))
    assert.equal(after[0].length, before[0].length)
    assert.equal(after[1].length, before[1].length + 1)
    t.check('unknown and conflicting servers create no sessions', true)
    const local = await mcp.call('clave_open_session', {
      cwd: mac.root,
      mode: 'terminal',
      server: 'local',
      name: 'MCP local proof'
    })
    assert.equal(toolErrored(local), false, JSON.stringify(local))
    assert.ok(!toolPayload(local).sessionId.startsWith('clave-owner:'))
    t.check('explicit local launch stays on the Mac with a connected fleet', true)
  } finally {
    await world.close()
  }
}
