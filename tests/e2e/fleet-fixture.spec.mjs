import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fleetWorld, request } from './fixtures/fleet-world.mjs'

export async function run(t) {
  const world = await fleetWorld('fixture')
  try {
    world.load({ enabled: false })
    for (const server of world.servers) assert.deepEqual(await request(server, '/sessions'), [])
    t.check('personal fleet fixture is disabled unless the isolated target enables it', true)
    const report = world.load()
    const first = report.values.first
    const second = report.values.second
    assert.equal(first.sessionId, second.sessionId)
    assert.equal(first.groupId, second.groupId)
    assert.notEqual(first.root, second.root)
    for (const [index, value] of [first, second].entries()) {
      const server = world.servers[index]
      assert.equal(readFileSync(path.join(server.root, value.file), 'utf8'), value.content)
      const history = await request(server, `/sessions/history?id=${value.sessionId}`)
      assert.ok(
        JSON.stringify(history).includes(value.content),
        'fixture history is real server history'
      )
    }
    t.check(
      'named fixture creates colliding IDs, owner files and retained live history through commands',
      true
    )
    const next = world.load({ generation: 'two' })
    assert.notEqual(next.runId, report.runId)
    assert.notEqual(next.values.first.sessionId, first.sessionId)
    assert.equal(readFileSync(path.join(first.root, first.file), 'utf8'), first.content)
    t.check(
      'each fixture invocation has fresh IDs and preserves the earlier receipt and data',
      true
    )
  } finally {
    await world.close()
  }
}
