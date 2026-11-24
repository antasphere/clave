/**
 * With no workspace on this Mac, a connected server's tabs show among the
 * Mac's own, and each carries the server's tag (PRDCT-5033).
 *
 * Inside a server's own workspace the rows draw no server mark: every tab
 * there is the server's, and the workspace switcher names the server once.
 * Anywhere else a server's tab sits among this Mac's, and the tag is what
 * tells them apart: in a Mac workspace paired with the server
 * (fleet-paired-workspace.spec.mjs), and with no workspace at all, where
 * every tab shows. This spec is the last case.
 *
 * Fails if: a server's tab in no-workspace mode draws no tag, or a tab of
 * this Mac draws one.
 */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { fixturePath, seedTrustedRoots } from './harness.mjs'
import { fleetWorld, connectMac, request, owned, eventually } from './fixtures/fleet-world.mjs'
import { openTab } from './nest-helpers.mjs'

const row = (win, id) => win.locator(`[data-sidebar-item-id="${id}"]`)

export async function run(t) {
  const world = await fleetWorld('no-workspace-mark', { count: 1 })
  try {
    const [server] = world.servers
    // A Mac with no workspace: its folder seeded with a trusted root alone.
    const dir = fixturePath(`${world.run}-mac-bare`)
    const root = fixturePath(`${world.run}-local-bare`)
    mkdirSync(dir, { recursive: true })
    mkdirSync(root, { recursive: true })
    seedTrustedRoots(dir, [root])
    const mac = await world.mac('bare', { reuse: dir })
    await connectMac(mac, world.servers, { ui: false })
    const owner = mac.owners[0]
    const { win } = mac

    const local = await openTab(mac.app, root, 'A tab of this Mac', { mode: 'terminal' })
    const started = await request(server, '/sessions/start', {
      cwd: server.root,
      options: { claudeMode: false }
    })
    const remote = owned('session', owner.id, started.id)
    await row(win, local).waitFor()
    await eventually(
      async () => (await row(win, remote).count()) === 1,
      'the server tab shows among this Mac’s'
    )

    const tag = row(win, remote).locator('> .sidebar-item [data-fleet-badge="session"]')
    await tag.waitFor()
    assert.equal((await tag.innerText()).trim(), owner.name, 'the tag names the server')
    t.check('with no workspace, a server’s tab carries the server’s tag', true)
    assert.equal(await row(win, local).locator('[data-fleet-badge]').count(), 0)
    assert.equal(await row(win, local).locator('[data-fleet-owner]').count(), 0)
    t.check('and a tab of this Mac carries none', true)
  } finally {
    await world.close()
  }
}
