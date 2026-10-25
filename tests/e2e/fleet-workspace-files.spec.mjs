// Server-owned workspace pins and trust, through the real desktop preload.
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  fleetWorld,
  connectMac,
  showServer,
  showMac,
  request,
  owned,
  eventually,
  step
} from './fixtures/fleet-world.mjs'
import { callMcp, spawnJournal, stubReviewDialog } from './harness.mjs'

const blueprint = (name) => ({
  $schema: 'clave/1.0',
  name,
  cwd: '.',
  color: 'teal',
  sessions: ['One', 'Two'].map((name) => ({
    name,
    cwd: '.',
    claudeMode: false,
    antigravityMode: false,
    codexMode: false,
    piMode: false,
    dangerousMode: false
  })),
  terminals: []
})
async function listed(mac, name) {
  const add = mac.win.getByRole('button', { name: 'Add a group', exact: true })
  await add.click()
  try {
    await eventually(
      async () =>
        (await mac.win.locator('.group-picker-card').allTextContents()).some((s) =>
          s.includes(name)
        ),
      `pin ${name} is listed in the window`
    )
  } finally {
    const dialog = mac.win.getByRole('dialog', { name: 'Add a group', exact: true })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
  }
}

export async function run(t) {
  const world = await fleetWorld('workspace-files')
  try {
    // Reuse the named @structure-ai fixture scenario and its owned command rail.
    world.load()
    const [server, peer] = world.servers
    const profile = path.join(server.root, '.clave', 'workspaces', 'default.clave')
    mkdirSync(path.dirname(profile), { recursive: true })
    writeFileSync(profile, JSON.stringify(blueprint('Server file pin')))
    const mac = await world.mac('files')
    await connectMac(mac, world.servers, { ui: false })
    const spawns = spawnJournal(mac.dir)
    const before = new Set((await request(server, '/sessions')).map((s) => s.id))
    const peerBefore = (await request(peer, '/sessions')).map((s) => s.id).sort()
    const workspaceId = await showServer(mac, 0)
    await step('server file pins are listed and launch on their owner', async () => {
      await listed(mac, 'Server file pin')
      const result = await callMcp(mac.app, 'launchGroup', {
        group: 'Server file pin'
      })
      assert.equal(result.status, 'launched')
      let started
      await eventually(async () => {
        started = (await request(server, '/sessions')).filter((s) => !before.has(s.id))
        return started.length === 2
      }, 'both pinned sessions exist on the owning server')
      assert.ok(started.every((s) => s.cwd === server.root))
      assert.deepEqual(await spawns(), [], 'the Mac never spawned a pinned server session')
      assert.deepEqual((await request(peer, '/sessions')).map((s) => s.id).sort(), peerBefore)
      const rawWorkspace = decodeURIComponent(workspaceId.split(':').at(-1))
      await eventually(async () => {
        const layout = await request(server, '/sidebar/layout?windowKey=server')
        return layout.groups.some(
          (g) =>
            g.name === 'Server file pin' &&
            g.workspaceId === rawWorkspace &&
            g.sessionIds.length === 2
        )
      }, 'the group and workspace stamp are saved in the server sidebar')
      t.check(
        'server pins launch both sessions and save their group on their owner without a Mac spawn',
        true
      )
    })
    await step('an edit on server disk reloads the pin', async () => {
      writeFileSync(profile, JSON.stringify(blueprint('Renamed on server disk')))
      await listed(mac, 'Renamed on server disk')
      t.check('server disk edits reload the pin in the window', true)
    })
    await step('server trust review names its owner and grants only that owner', async () => {
      await showMac(mac)
      const reviewFile = path.join(peer.root, '.clave', 'workspaces', 'default.clave')
      mkdirSync(path.dirname(reviewFile), { recursive: true })
      writeFileSync(
        reviewFile,
        JSON.stringify({
          ...blueprint('Reviewed on server'),
          terminals: [
            {
              command: 'echo review-only',
              commandMode: 'auto',
              cwd: '.',
              color: 'teal',
              icon: 'terminal'
            }
          ]
        })
      )
      const dialogs = await stubReviewDialog(mac.app, { response: 0, checkboxChecked: true })
      const macRoots = await mac.win.evaluate(() => window.electronAPI.listTrustedRoots())
      assert.ok(
        !(await request(peer, '/workspace-files/trust/roots')).includes(realpathSync(peer.root))
      )
      await showServer(mac, 1)
      await eventually(
        async () =>
          (await dialogs()).some(
            (d) => d.message.includes('default.clave') && d.message.includes(mac.owners[1].name)
          ),
        'the review dialog names the file and its owning server'
      )
      await eventually(
        async () =>
          (await request(peer, '/workspace-files/trust/roots')).includes(realpathSync(peer.root)),
        'the checked folder grant is in the owning server trust store'
      )
      const roots = await mac.win.evaluate(() => window.electronAPI.listTrustedRoots())
      assert.deepEqual(
        roots.filter((r) => !r.startsWith('clave-owner:')),
        macRoots.filter((r) => !r.startsWith('clave-owner:')),
        'Mac trusted roots are unchanged'
      )
      assert.ok(roots.includes(owned('file', mac.owners[1].id, realpathSync(peer.root))))
      assert.ok(
        !(await request(server, '/workspace-files/trust/roots')).includes(realpathSync(peer.root)),
        'the other server did not receive the grant'
      )
      t.check(
        'server review names the owner and grants folder trust there without trusting the Mac',
        true
      )
    })
    assert.deepEqual(mac.errors, [], 'the desktop reports no uncaught renderer errors')
  } finally {
    await world.close()
  }
}
