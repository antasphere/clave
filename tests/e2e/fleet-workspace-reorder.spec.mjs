// Reordering server workspaces when one Mac is connected to two Clave servers
// (#257). The toolbar switcher lists both servers' workspaces in ONE list,
// each server's in its own registry: a row drags within its own server's
// workspaces only, never onto another server's, and a move writes that
// server's registry alone.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import {
  fleetWorld,
  connectMac,
  eventually,
  owned,
  request,
  step
} from './fixtures/fleet-world.mjs'

const item = (win, id) => win.locator(`[data-workspace-id="${id}"]`)

async function openSwitcher(win) {
  const add = win.getByRole('button', { name: 'Add workspace…', exact: true })
  if (await add.isVisible()) return
  await win.getByLabel('Switch workspace', { exact: true }).click()
  await add.waitFor()
}

/** Press on `from`, travel to the top quarter of `to`, and report the drop
 *  line shown there before releasing. */
async function dragAbove(win, from, to) {
  const a = await from.boundingBox()
  const b = await to.boundingBox()
  const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 }
  const end = { x: b.x + b.width / 2, y: b.y + b.height / 4 }
  await win.mouse.move(start.x, start.y)
  await win.mouse.down()
  for (let i = 1; i <= 12; i++) {
    await win.mouse.move(
      start.x + ((end.x - start.x) * i) / 12,
      start.y + ((end.y - start.y) * i) / 12
    )
  }
  await win.waitForTimeout(80)
  const line = await to.getAttribute('data-drop')
  await win.mouse.up()
  await win.waitForTimeout(150)
  return line
}

const ids = async (server) => (await request(server, '/workspaces')).workspaces.map((w) => w.id)

export async function run(t) {
  const world = await fleetWorld('workspace-reorder')
  try {
    const [one, two] = world.servers
    const mac = await world.mac('a')
    await connectMac(mac, world.servers, { ui: false })
    const [ownerOne, ownerTwo] = mac.owners.map((o) => o.id)

    // Two workspaces on each server, added through the Mac.
    const added = await step('each server holds two workspaces', async () => {
      const add = async (owner, server, suffix) => {
        const rootDir = `${server.root}-${suffix}`
        mkdirSync(rootDir, { recursive: true })
        return mac.win.evaluate(
          ({ owner, rootDir }) => window.electronAPI.fleetAddWorkspace(owner, { rootDir }),
          { owner, rootDir }
        )
      }
      const list = {
        one: [await add(ownerOne, one, 'first'), await add(ownerOne, one, 'second')],
        two: [await add(ownerTwo, two, 'first'), await add(ownerTwo, two, 'second')]
      }
      await eventually(async () => {
        await openSwitcher(mac.win)
        return (await mac.win.locator('[data-workspace-id][data-reorder-id]').count()) === 5
      }, 'the switcher lists the Mac workspace and the four server workspaces')
      return list
    })
    const raw = (ws) => decodeURIComponent(ws.id.split(':').pop())
    const oneBefore = await ids(one)
    const twoBefore = await ids(two)
    assert.deepEqual(oneBefore, added.one.map(raw))
    assert.deepEqual(twoBefore, added.two.map(raw))

    await step('a row of one server never drops onto another server’s row', async () => {
      await openSwitcher(mac.win)
      const line = await dragAbove(
        mac.win,
        item(mac.win, added.two[1].id),
        item(mac.win, added.one[0].id)
      )
      assert.equal(line, null, 'no drop line on another server’s row')
      await mac.win.waitForTimeout(500)
      assert.deepEqual(await ids(one), oneBefore, 'the first server’s registry is unchanged')
      assert.deepEqual(await ids(two), twoBefore, 'the second server’s registry is unchanged')
    })
    t.check('a server workspace has no drop target in another server’s list', true)

    await step('a move within one server writes that server alone', async () => {
      await openSwitcher(mac.win)
      const line = await dragAbove(
        mac.win,
        item(mac.win, added.two[1].id),
        item(mac.win, added.two[0].id)
      )
      assert.equal(line, 'before', 'the drop line shows within the same server')
      await eventually(
        async () => (await ids(two)).join() === [...twoBefore].reverse().join(),
        'the second server’s registry holds the new order'
      )
      assert.deepEqual(await ids(one), oneBefore, 'the first server’s registry is unchanged')
      const order = await mac.win.$$eval('[data-workspace-id][data-reorder-id]', (rows) =>
        rows.map((r) => r.getAttribute('data-workspace-id'))
      )
      // Servers are listed in the order they were heard; within each, its own.
      const ofServer = (owner, list) =>
        order.filter((id) => list.some((raw) => id === owned('workspace', owner, raw)))
      assert.deepEqual(
        ofServer(ownerOne, oneBefore),
        oneBefore.map((r) => owned('workspace', ownerOne, r))
      )
      assert.deepEqual(
        ofServer(ownerTwo, twoBefore),
        [...twoBefore].reverse().map((r) => owned('workspace', ownerTwo, r))
      )
    })
    t.check('a move within one server writes that server’s registry alone', true)
    assert.deepEqual(mac.errors, [])
  } finally {
    await world.close()
  }
}
