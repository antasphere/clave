// Server-owned workspace pins and trust, through the real desktop preload.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  fleetWorld,
  connectMac,
  showServer,
  showMac,
  request,
  owned,
  eventually,
  clickReady,
  ownerReady,
  step
} from './fixtures/fleet-world.mjs'
import { assertFileEndpoint } from './fixtures/fleet-http-observer.mjs'
import { spawnJournal, stubReviewDialog } from './harness.mjs'

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
async function listed(mac, name, launch = false) {
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
    if (launch) {
      await mac.win.locator('.group-picker-card').filter({ hasText: name }).click()
      await mac.win
        .getByRole('dialog', { name: 'Add a group', exact: true })
        .waitFor({ state: 'hidden' })
    }
  } finally {
    const dialog = mac.win.getByRole('dialog', { name: 'Add a group', exact: true })
    if (await dialog.isVisible()) {
      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
    }
  }
}

export async function run(t) {
  const world = await fleetWorld('workspace-files')
  try {
    // Reuse the named @structure-ai fixture scenario and its owned command rail.
    const fixture = world.load()
    const [server, peer] = world.servers
    const observers = await world.observeFiles()
    const mark = () => observers.map((observer) => observer.entries.length)
    writeFileSync(path.join(server.root, 'server-only.txt'), 'Only on the server')
    mkdirSync(path.join(server.root, 'watched-folder'))
    const profile = path.join(server.root, '.clave', 'workspaces', 'default.clave')
    mkdirSync(path.dirname(profile), { recursive: true })
    writeFileSync(profile, JSON.stringify(blueprint('Server file pin')))
    const mac = await world.mac('files')
    writeFileSync(path.join(mac.root, 'mac-only.txt'), 'Only on the Mac')
    await connectMac(mac, world.servers, { ui: false })
    const spawns = spawnJournal(mac.dir)
    const before = new Set((await request(server, '/sessions')).map((s) => s.id))
    const peerBefore = (await request(peer, '/sessions')).map((s) => s.id).sort()
    const opening = mark()
    const workspaceId = await showServer(mac, 0)
    const fixtureSession = owned('session', mac.owners[0].id, fixture.values.first.sessionId)
    await ownerReady(mac, mac.owners[0].id, fixtureSession)
    const fixtureRow = mac.win.locator(`[data-sidebar-item-id="${fixtureSession}"] .sidebar-item`)
    await clickReady(fixtureRow)
    await fixtureRow.click({ modifiers: ['Meta'] })
    await mac.win.getByText('Select a session', { exact: true }).waitFor({ state: 'visible' })
    const tree = mac.win.locator(
      `[data-file-tree-root="${owned('file', mac.owners[0].id, server.root)}"]`
    )
    await step('the empty server workspace shows its live file tree', async () => {
      // The fixture's tab was deselected through the sidebar. The workspace
      // itself owns the panel, with no session or file tab focused.
      assert.equal(
        await mac.win.locator('[data-sidebar-item-id] [data-selected="true"]').count(),
        0
      )
      if (!(await tree.isVisible())) await clickReady(mac.win.getByTitle(/^File tree/))
      await tree.locator('[data-tree-name="server-only.txt"]').waitFor({ state: 'visible' })
      assert.equal(await tree.locator('[data-tree-name="mac-only.txt"]').count(), 0)
      assert.equal(await mac.win.locator(`[data-file-tree-root="${mac.root}"]`).count(), 0)
      assert.equal(
        await mac.win.locator('[data-panel-scope]').getAttribute('data-panel-scope'),
        'workspace'
      )
      assert.equal(await mac.win.locator('.panel-path').getAttribute('title'), server.root)
      assertFileEndpoint(observers, opening, 0, '/files/list')

      const watching = mark()
      const folder = tree.locator('[data-tree-name="watched-folder"]')
      await clickReady(folder)
      // Wait for the real watch request before creating either file. No UI
      // action follows these disk writes until both new rows have appeared.
      await eventually(
        () =>
          observers[0].entries
            .slice(watching[0])
            .some((e) => e.path === '/files/watch' && e.status === 200),
        'the expanded folder watch reaches its owner'
      )
      const changes = mark()
      writeFileSync(path.join(server.root, 'appeared-at-root.txt'), 'root watch sentinel')
      writeFileSync(
        path.join(server.root, 'watched-folder', 'appeared-in-folder.txt'),
        'folder watch sentinel'
      )
      await tree
        .locator('[data-tree-name="appeared-at-root.txt"]')
        .waitFor({ state: 'visible', timeout: 5000 })
      await tree
        .locator('[data-tree-name="appeared-in-folder.txt"]')
        .waitFor({ state: 'visible', timeout: 5000 })
      assert.equal(await folder.getAttribute('data-tree-expanded'), 'true')
      assertFileEndpoint(observers, changes, 0, '/files/list')
      t.check(
        'an unfocused server workspace shows its own tree and refreshes root and expanded folders from disk',
        true
      )
    })
    await step('a file opened from the workspace tree saves on its server', async () => {
      const reading = mark()
      await tree.locator('[data-tree-name="server-only.txt"]').click({ button: 'right' })
      await clickReady(mac.win.getByRole('menuitem', { name: 'Open in Tab', exact: true }))
      const editor = mac.win.locator('.cm-content[contenteditable="true"]:visible')
      await editor.waitFor()
      assertFileEndpoint(observers, reading, 0, '/files/read')
      const editing = mark()
      await editor.fill('Saved through the workspace file tree')
      await editor.press('Meta+s')
      await eventually(
        () =>
          readFileSync(path.join(server.root, 'server-only.txt'), 'utf8') ===
          'Saved through the workspace file tree',
        'the workspace tree editor saves real server bytes'
      )
      assertFileEndpoint(observers, editing, 0, '/files/write')
      await showMac(mac)
      const macTree = mac.win.locator(`[data-file-tree-root="${mac.root}"]`)
      await macTree.locator('[data-tree-name="mac-only.txt"]').waitFor({ state: 'visible' })
      assert.equal(await macTree.locator('[data-tree-name="server-only.txt"]').count(), 0)
      assert.equal(await tree.count(), 0)
      assert.deepEqual(mac.errors, [], 'watch changes never reject into the renderer')
      t.check('workspace tree edits save on the server and showMac restores the Mac root', true)
      await showServer(mac, 0)
    })
    await step('server file pins are listed and launch on their owner', async () => {
      await listed(mac, 'Server file pin', true)
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
    await step(
      'an unreachable workspace owner shows a Git error without a renderer rejection',
      async () => {
        await showServer(mac, 0)
        await clickReady(fixtureRow)
        await fixtureRow.click({ modifiers: ['Meta'] })
        await mac.win.getByText('Select a session', { exact: true }).waitFor({ state: 'visible' })
        await clickReady(mac.win.getByRole('button', { name: 'Files', exact: true }))
        const folder = tree.locator('[data-tree-name="watched-folder"]')
        await folder.waitFor({ state: 'visible' })
        const owner = mac.owners[0].id
        const connected = () =>
          mac.win.evaluate(
            (id) =>
              window.electronAPI.fleetSnapshot(id).then(
                () => true,
                () => false
              ),
            owner
          )
        await server.stop()
        // world.restart and world.close both stop their owned daemon again.
        server.stop = async () => {}
        await eventually(async () => !(await connected()), 'the workspace owner is unreachable')
        await clickReady(folder)
        // The observer does not record its own 502 when no daemon answers.
        // Observe the outgoing request before releasing it to the stopped owner.
        const offlineRead = observers[0].holdRequest((_method, route) => route === '/git/status')
        try {
          await clickReady(mac.win.getByRole('button', { name: 'Git', exact: true }))
          await eventually(() => offlineRead.taken, 'the Git read is sent to the unreachable owner')
        } finally {
          offlineRead.release()
        }
        await mac.win
          .getByText("Could not read this folder's git status.", { exact: true })
          .waitFor({ state: 'visible' })
        await mac.win.waitForTimeout(4000)
        assert.deepEqual(
          mac.errors,
          [],
          'offline tree and Git reads never reject into the renderer'
        )
        t.check(
          'an unfocused offline workspace shows the Git error banner without an uncaught rejection',
          true
        )

        const reconnecting = mark()
        await world.restart(0)
        await eventually(connected, 'the workspace owner is connected again')
        await clickReady(mac.win.getByRole('button', { name: 'Files', exact: true }))
        await eventually(
          () =>
            observers[0].entries
              .slice(reconnecting[0])
              .some((e) => e.path === '/files/watch' && e.status === 200),
          'the tree watch is resent after the outage'
        )
        writeFileSync(path.join(server.root, 'after-outage.txt'), 'watch restored')
        await tree
          .locator('[data-tree-name="after-outage.txt"]')
          .waitFor({ state: 'visible', timeout: 5000 })
        assert.deepEqual(mac.errors, [])
        t.check('the tree resumes its live watch when the workspace owner restarts', true)
      }
    )
    assert.deepEqual(mac.errors, [], 'the desktop reports no uncaught renderer errors')
  } finally {
    await world.close()
  }
}
