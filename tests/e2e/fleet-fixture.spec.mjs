import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fixtureRoot } from './harness.mjs'
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
    const receipt = readdirSync(fixtureRoot())
      .filter(
        (name) => name.startsWith(`clave-e2e-${world.run}-`) && name.endsWith('-receipt.json')
      )
      .map((name) => path.join(fixtureRoot(), name))
    assert.equal(receipt.length, 1)
    const priorReceipt = readFileSync(receipt[0], 'utf8')
    const next = world.load()
    assert.equal(
      readFileSync(receipt[0], 'utf8'),
      priorReceipt,
      'default retry retains prior receipt bytes'
    )
    assert.notEqual(next.runId, report.runId)
    assert.notEqual(next.values.first.sessionId, first.sessionId)
    assert.equal(readFileSync(path.join(first.root, first.file), 'utf8'), first.content)
    assert.ok(
      JSON.stringify(
        await request(world.servers[0], `/sessions/history?id=${first.sessionId}`)
      ).includes(first.content)
    )
    t.check(
      'each fixture invocation has fresh IDs and preserves the earlier receipt and data',
      true
    )
    const before = await Promise.all(world.servers.map((server) => request(server, '/sessions')))
    assert.throws(() => world.load({ receipt: receipt[0] }), /fixture load failed/)
    assert.equal(readFileSync(receipt[0], 'utf8'), priorReceipt)
    assert.deepEqual(
      await Promise.all(world.servers.map((server) => request(server, '/sessions'))),
      before,
      'refusing an existing receipt happens before creating any records'
    )
    assert.equal(readFileSync(path.join(first.root, first.file), 'utf8'), first.content)
    t.check('an explicit receipt collision refuses before commands and preserves prior bytes', true)
  } finally {
    await world.close()
  }
}
