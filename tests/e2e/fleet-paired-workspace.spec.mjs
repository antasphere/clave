/**
 * A server workspace paired with the same tree on this Mac shows both
 * machines' tabs in the Mac workspace, badged by machine (PRDCT-4151), on the
 * fleet harness: two standalone servers, one Mac whose own workspace is a
 * clone of server one's repository (the same git remote on both machines).
 *
 * Clave notices the match once the server workspace exists and proposes the
 * pairing over the stage; before the person answers, the server's tab is not
 * in the Mac workspace. Confirmed, the server's tab shows there with a badge
 * naming the server, its pane header says so, and the side panel on it names
 * the server too; a tab opened on this Mac still starts here, and the
 * launcher's "Run on <server>" row starts one on the server, in the server
 * workspace, shown here as well. The server's own workspace shows only the
 * server's tabs, never the Mac's. The switch in Settings, Servers takes the
 * server's tabs out of the Mac workspace and back; the pairing is written on
 * this Mac alone. A second Mac whose workspace is not a clone is proposed
 * nothing and shows no server tab in its own workspace.
 *
 * Fails if: a server tab shows in a Mac workspace with no pairing confirmed,
 * a confirmed pairing shows no badge or no tab, a Mac tab leaks into the
 * server workspace, the switch off leaves the server tab on screen, or the
 * launcher's row starts the session anywhere but on the server.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  fleetWorld,
  connectMac,
  eventually,
  owned,
  request,
  clickReady,
  step
} from './fixtures/fleet-world.mjs'
import { fixturePath } from './harness.mjs'

const row = (win, id) => win.locator(`[data-sidebar-item-id="${id}"]`)
const item = (win, id) => win.locator(`[data-workspace-id="${id}"]`)
const sameDir = (a, b) => realpathSync(a) === realpathSync(b)
const rawOf = (remoteKey) => decodeURIComponent(remoteKey.split(':')[3])

async function closeSwitcher(win) {
  const add = win.getByRole('button', { name: 'Add workspace…', exact: true })
  if (await add.isVisible()) await win.keyboard.press('Escape')
  await add.waitFor({ state: 'hidden' })
}
async function switchTo(win, id) {
  await eventually(async () => {
    const target = item(win, id)
    if (!(await target.count())) {
      await win.getByLabel('Switch workspace', { exact: true }).click()
      await target.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {})
    }
    if (!(await target.count())) {
      await closeSwitcher(win)
      return false
    }
    if (
      (await target.getAttribute('data-selected', { timeout: 2_000 }).catch(() => null)) === 'true'
    ) {
      await closeSwitcher(win)
      return true
    }
    await target.click({ timeout: 3_000 }).catch(() => {})
    return false
  }, `the window shows workspace ${id}`)
}
/** The sidebar has settled on whether `id` is drawn: `present` true waits for
 *  the row, false waits until the server's snapshot reached the window and the
 *  row is still absent. */
async function settled(mac, owner, serverSessionId, present) {
  const id = owned('session', owner, serverSessionId)
  if (present) {
    await row(mac.win, id).waitFor()
    return
  }
  await eventually(async () => {
    const snapshot = await mac.win.evaluate((o) => window.electronAPI.fleetSnapshot(o), owner)
    return snapshot.sessions.some((s) => s.id === id)
  }, 'the server snapshot reached the window')
  assert.equal(await row(mac.win, id).count(), 0, `${id} is not drawn`)
}

export async function run(t) {
  const world = await fleetWorld('paired', { gitRepo: true })
  try {
    const [server, other] = world.servers
    // The Mac's own workspace is a clone of the server repository's origin:
    // the same tree on two machines, as Steward lays it. Cloned into the root
    // the Mac will be seeded with, before its window boots.
    const rootA = fixturePath(`${world.run}-local-a`)
    execFileSync('git', ['clone', '-q', server.origin, rootA], { stdio: 'inherit' })
    // The server tree declares a toolbar button; the Mac clone does not share
    // it (a bare Mac workspace has no pins), so a pin that leaked would be
    // the only toolbar button in the Mac workspace (verifier, round 1).
    mkdirSync(path.join(server.root, '.clave', 'workspaces'), { recursive: true })
    writeFileSync(
      path.join(server.root, '.clave', 'workspaces', 'default.clave'),
      JSON.stringify({
        $schema: 'clave/1.0',
        groups: [
          {
            name: 'Server toolbar',
            cwd: '.',
            toolbar: true,
            sessions: [],
            terminals: [
              {
                name: 'Server button',
                command: 'echo paired-toolbar-probe',
                commandMode: 'prefill',
                color: 'teal'
              }
            ]
          }
        ]
      })
    )
    const macA = await world.mac('a')
    assert.ok(sameDir(macA.root, rootA), 'the Mac workspace is the clone')
    await connectMac(macA, world.servers, { ui: false })
    const owner = macA.owners[0].id
    const { win } = macA

    const serverWs = await step('the server repository becomes a server workspace', async () => {
      const added = await win.evaluate(
        ({ owner, root }) => window.electronAPI.fleetAddWorkspace(owner, { rootDir: root }),
        { owner, root: server.root }
      )
      assert.ok(added.id.startsWith('clave-owner:workspace:'), 'a remote key')
      return added
    })
    const raw = rawOf(serverWs.id)

    await step('both roots read the same remote, each through its own machine', async () => {
      const [local, remote] = await win.evaluate(
        ({ root, key }) =>
          Promise.all([
            window.electronAPI.gitRemoteUrl(root),
            window.electronAPI.gitRemoteUrl(key)
          ]),
        { root: macA.root, key: owned('file', owner, server.root) }
      )
      assert.ok(local, 'the Mac root has an origin')
      assert.equal(remote, local, 'the server root has the same origin')
    })
    const notice = win.getByTestId('pairing-proposal')
    await step('Clave proposes the pairing in the Mac workspace', async () => {
      await notice.waitFor()
      const text = await notice.innerText()
      assert.match(text, /Combine Personal VPS 1/, 'names the server')
      assert.match(text, /with this workspace/, 'asks about this workspace')
    })
    t.check(
      'a server workspace that is the same tree as the Mac workspace is proposed as a pairing',
      true
    )

    // A tab on the server, in that server workspace, before the answer.
    const first = await request(server, '/sessions/start', {
      cwd: server.root,
      options: { claudeMode: false, workspaceId: raw }
    })
    await settled(macA, owner, first.id, false)
    t.check('before the pairing is confirmed, the server tab stays out of the Mac workspace', true)

    await step('the person confirms once', async () => {
      await clickReady(notice.getByRole('button', { name: 'Combine', exact: true }))
      await notice.waitFor({ state: 'hidden' })
    })
    const firstRow = row(win, owned('session', owner, first.id))
    await firstRow.waitFor()
    const badge = firstRow.locator('[data-fleet-badge="session"]')
    await badge.waitFor()
    assert.equal(await badge.innerText(), 'Personal VPS 1', 'the badge names the server')
    assert.equal(await badge.getAttribute('data-fleet-owner'), owner)
    t.check(
      'confirmed, the server tab shows in the Mac workspace, badged with the server’s name',
      true
    )

    const saved = JSON.parse(readFileSync(path.join(macA.dir, 'server-pairings.json'), 'utf8'))
    assert.equal(saved.servers[owner].combine, true)
    assert.deepEqual(saved.servers[owner].pairs, { [raw]: 'mac-a' })
    assert.equal(
      JSON.parse(readFileSync(path.join(macA.dir, 'workspace-state.json'), 'utf8')).workspaces
        .length,
      1,
      'the Mac registry is untouched'
    )
    t.check('the pairing is written on this Mac, keyed by server and server workspace', true)

    await step('the pane header and the side panel say which machine', async () => {
      await clickReady(firstRow)
      const pane = win.locator(`[data-terminal-tile="${owned('session', owner, first.id)}"]`)
      await pane.locator('.pane-header [data-fleet-badge="session"]').waitFor()
      const tabs = win.locator('[data-panel-bar="tabs"]')
      if (!(await tabs.isVisible())) await clickReady(win.getByTitle(/^File tree/))
      const chip = win.locator(`[data-panel-machine="${owner}"]`)
      await chip.waitFor()
      assert.equal(await chip.innerText(), 'Personal VPS 1')
    })
    t.check('the pane header and the side panel name the server the tab runs on', true)

    const localBefore = await win.evaluate(() => window.electronAPI.listSessions())
    await step('a new tab in the combined workspace still starts on this Mac', async () => {
      await closeSwitcher(win)
      await win.keyboard.press('Meta+T')
      await eventually(
        async () =>
          (await win.evaluate(() => window.electronAPI.listSessions())).length ===
          localBefore.length + 1,
        'Cmd+T started a session on the Mac'
      )
    })
    const localSession = (await win.evaluate(() => window.electronAPI.listSessions())).find(
      (s) => !localBefore.some((b) => b.id === s.id)
    )
    assert.ok(sameDir(localSession.cwd, macA.root), 'at the Mac workspace root')
    await row(win, localSession.id).waitFor()
    assert.equal(await row(win, localSession.id).locator('[data-fleet-badge]').count(), 0)
    t.check('a new tab in the combined workspace starts on this Mac, unbadged', true)

    const known = new Set((await request(server, '/sessions')).map((s) => s.id))
    const onServer = await step(
      '"Run on Personal VPS 1" starts a terminal on the server',
      async () => {
        await clickReady(win.locator('.launcher-caret'))
        const section = win.locator(`[data-run-on-server="${owner}"]`)
        await section.waitFor()
        await clickReady(section.getByRole('menuitem', { name: 'Terminal', exact: true }))
        let started
        await eventually(async () => {
          started = (await request(server, '/sessions')).find((s) => !known.has(s.id))
          return !!started
        }, 'the server started a session')
        assert.ok(sameDir(started.cwd, server.root), 'in the server workspace root')
        const records = await request(server, '/sessions/records')
        const record = records.find((r) => r.id === started.id)
        assert.equal(record?.workspaceId, raw, 'stamped with the server workspace')
        return started
      }
    )
    await settled(macA, owner, onServer.id, true)
    assert.equal((await request(other, '/sessions')).length, 0, 'the other server started nothing')
    t.check(
      'the launcher’s Run on row starts the tab on the server, in its workspace, shown here',
      true
    )

    await step('the server workspace shows only the server’s tabs', async () => {
      await switchTo(win, serverWs.id)
      await row(win, owned('session', owner, first.id)).waitFor()
      await row(win, owned('session', owner, onServer.id)).waitFor()
      assert.equal(await row(win, localSession.id).count(), 0, 'the Mac tab is not there')
      // In the server's own workspace the badge is the plain icon, not the name.
      assert.equal(
        await row(win, owned('session', owner, first.id))
          .locator('[data-fleet-badge]')
          .count(),
        0
      )
      // The server tree's toolbar button shows here, in the server workspace.
      await eventually(
        async () =>
          (await win
            .locator('[data-toolbar-row] button[title^="echo paired-toolbar-probe"]')
            .count()) === 1,
        'the server workspace shows its toolbar button'
      )
      await switchTo(win, 'mac-a')
      await row(win, localSession.id).waitFor()
      // ...and not in the Mac workspace it is paired with: the Mac's pins are its own.
      await eventually(
        async () => (await row(win, owned('session', owner, first.id)).count()) === 1,
        'back in the Mac workspace, the server tab is still combined'
      )
      assert.equal(
        await win.locator('[data-toolbar-row] button[title^="echo paired-toolbar-probe"]').count(),
        0,
        'the server’s pin does not leak into the Mac workspace'
      )
    })
    t.check('the server’s own workspace shows the server’s tabs and never the Mac’s', true)
    t.check('the server tree’s pinned toolbar button stays out of the paired Mac workspace', true)

    await step('the switch in Settings takes the server’s tabs out, and back', async () => {
      await win.click('.sidebar-footer-btn[aria-label="Settings"]')
      await win.click('[data-settings-nav-row="servers"]')
      const combine = win.locator(`[data-server-combine="${owner}"]`)
      await combine.waitFor()
      assert.equal(await combine.getAttribute('data-combine'), 'on')
      assert.ok(
        (await combine.locator(`[data-server-pair="${raw}"]`).innerText()).includes('Mac a'),
        'the pairing row names the Mac workspace'
      )
      await clickReady(combine.getByRole('switch'))
      await eventually(
        async () => (await combine.getAttribute('data-combine')) === 'off',
        'the switch reads off'
      )
      await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
      await eventually(
        async () => (await row(win, owned('session', owner, first.id)).count()) === 0,
        'the server tab left the Mac workspace'
      )
      await row(win, localSession.id).waitFor()
      await win.click('.sidebar-footer-btn[aria-label="Settings"]')
      await win.click('[data-settings-nav-row="servers"]')
      await clickReady(combine.getByRole('switch'))
      await eventually(
        async () => (await combine.getAttribute('data-combine')) === 'on',
        'the switch reads on again'
      )
      await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
      await row(win, owned('session', owner, first.id)).waitFor()
    })
    t.check(
      'the per-server switch hides the server’s tabs from the Mac workspace, and shows them again',
      true
    )

    await step('a Mac whose workspace is another tree is proposed nothing', async () => {
      const macB = await world.mac('b')
      await connectMac(macB, [server], { ui: false })
      const ownerOnB = macB.owners[0].id
      await settled(macB, ownerOnB, first.id, false)
      assert.equal(await macB.win.getByTestId('pairing-proposal').count(), 0, 'no proposal')
      assert.deepEqual(macB.errors, [])
    })
    t.check(
      'another Mac, whose workspace is not the same tree, sees no proposal and no server tab',
      true
    )
    assert.deepEqual(macA.errors, [])
  } finally {
    await world.close()
  }
}
