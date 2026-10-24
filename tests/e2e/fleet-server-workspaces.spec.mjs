// Workspaces that live on a Clave server (#241), on the fleet harness: two
// Macs connected to the same standalone server. A workspace added on the
// server from Mac A appears on Mac B; in it the normal launch flow starts
// sessions on the server at the workspace root (Cmd+N, Cmd+T, and ⌥ through
// the server folder picker); a Mac workspace shows none of them; and with
// the server stopped its workspace shows offline and a launch is refused
// with a notice, starting nothing anywhere.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import {
  fleetWorld,
  connectMac,
  eventually,
  owned,
  request,
  showMac,
  step
} from './fixtures/fleet-world.mjs'

const row = (win, id) => win.locator(`[data-sidebar-item-id="${id}"]`)
const item = (win, id) => win.locator(`[data-workspace-id="${id}"]`)
const sameDir = (a, b) => realpathSync(a) === realpathSync(b)

async function openSwitcher(win) {
  await win.getByLabel('Switch workspace', { exact: true }).click()
  await win.getByText('Workspaces', { exact: true }).waitFor()
}

async function switchTo(win, id) {
  await openSwitcher(win)
  await item(win, id).click()
  await eventually(async () => {
    await openSwitcher(win)
    const selected = (await item(win, id).getAttribute('data-selected')) === 'true'
    await win.keyboard.press('Escape')
    return selected
  }, `window shows ${id}`)
}

export async function run(t) {
  const world = await fleetWorld('server-workspaces')
  try {
    const [server] = world.servers
    const sub = path.join(server.root, 'sub')
    mkdirSync(sub, { recursive: true })
    const macA = await world.mac('a')
    const macB = await world.mac('b')
    await connectMac(macA, [server], { ui: false })
    await connectMac(macB, [server], { ui: false })
    const owner = macA.owners[0].id
    const ownerOnB = macB.owners[0].id

    const workspaceId = await step('Mac A adds a workspace on the server', async () => {
      const win = macA.win
      await openSwitcher(win)
      await win.getByRole('button', { name: 'Add workspace…', exact: true }).click()
      await win.getByText('Add a workspace on', { exact: true }).waitFor()
      await win.getByRole('button', { name: 'Personal VPS 1', exact: true }).click()
      // The server folder picker, reading the server's disk.
      await win.getByTitle('Edit path', { exact: true }).first().click()
      const input = win.getByPlaceholder('/path/to/directory')
      await input.fill(server.root)
      await input.press('Enter')
      await win.getByTitle('sub').first().waitFor()
      await win.getByRole('button', { name: 'Open', exact: true }).click()
      let added
      await eventually(async () => {
        const state = await request(server, '/workspaces')
        added = state.workspaces.find((w) => sameDir(w.rootDir, server.root))
        return !!added
      }, 'the server registry holds the new workspace')
      const id = owned('workspace', owner, added.id)
      await eventually(async () => {
        await openSwitcher(win)
        const selected = (await item(win, id).getAttribute('data-selected')) === 'true'
        await win.keyboard.press('Escape')
        return selected
      }, 'Mac A shows the server workspace it added')
      return { remote: added.id, id }
    })
    const local = JSON.parse(readFileSync(path.join(macA.dir, 'workspace-state.json'), 'utf8'))
    assert.deepEqual(
      local.workspaces.map((w) => w.id),
      ['mac-a'],
      'the server workspace is never written to the Mac registry'
    )
    t.check('a workspace added on the server from Mac A lives in the server registry', true)

    const onB = owned('workspace', ownerOnB, workspaceId.remote)
    await step('Mac B sees the workspace, labelled with the server', async () => {
      await eventually(async () => {
        await openSwitcher(macB.win)
        const count = await item(macB.win, onB).count()
        const text = count ? await item(macB.win, onB).innerText() : ''
        await macB.win.keyboard.press('Escape')
        return count === 1 && text.includes('Personal VPS 1') && !text.includes('offline')
      }, 'the server workspace is listed on Mac B with the server name')
    })
    t.check('the workspace added on Mac A appears on Mac B, connected to the same server', true)

    const localBefore = await macA.win.evaluate(() => window.electronAPI.listSessions())
    const known = new Set((await request(server, '/sessions')).map((s) => s.id))
    const created = async (match, message) => {
      let found
      await eventually(async () => {
        found = (await request(server, '/sessions')).find((s) => !known.has(s.id) && match(s))
        return !!found
      }, message)
      known.add(found.id)
      return found
    }

    const claude = await step('Cmd+N starts Claude on the server at the root', async () => {
      await macA.win.keyboard.press('Meta+N')
      const session = await created((s) => s.provider === 'claude', 'Cmd+N started on the server')
      assert.ok(sameDir(session.cwd, server.root), 'Cmd+N starts at the workspace root')
      await row(macA.win, owned('session', owner, session.id)).waitFor()
      return session
    })
    await step('Cmd+T starts a terminal on the server at the root', async () => {
      await macA.win.keyboard.press('Meta+T')
      const session = await created(
        (s) => s.provider !== 'claude' && s.transport === 'pty',
        'Cmd+T started a terminal on the server'
      )
      assert.ok(sameDir(session.cwd, server.root), 'Cmd+T starts at the workspace root')
    })
    await step('⌥ picks a folder on the server', async () => {
      await macA.win.keyboard.press('Meta+Alt+N')
      await macA.win.getByTitle('sub').first().click()
      await macA.win.getByRole('button', { name: 'Open', exact: true }).click()
      const session = await created((s) => s.provider === 'claude', '⌥ started on the server')
      assert.ok(sameDir(session.cwd, sub), '⌥ starts in the folder picked on the server')
    })
    assert.deepEqual(
      await macA.win.evaluate(() => window.electronAPI.listSessions()),
      localBefore,
      'no launch in the server workspace started a session on the Mac'
    )
    t.check(
      'in the server workspace Cmd+N, Cmd+T and ⌥ start on the server, at the root or the picked folder',
      true
    )

    await step('Mac B sees the server session in the same workspace', async () => {
      await switchTo(macB.win, onB)
      await row(macB.win, owned('session', ownerOnB, claude.id)).waitFor()
    })
    await step('a Mac workspace shows none of the server sessions', async () => {
      await showMac(macA)
      await eventually(
        async () => (await row(macA.win, owned('session', owner, claude.id)).count()) === 0,
        'the server session is hidden in the Mac workspace'
      )
    })
    t.check(
      'the server workspace shows the server sessions on both Macs, and a Mac workspace none',
      true
    )

    await step('with the server stopped, its workspace is offline and refuses', async () => {
      await server.stop()
      await eventually(async () => {
        await openSwitcher(macA.win)
        const offline = await item(macA.win, workspaceId.id).getAttribute('data-offline')
        const text = await item(macA.win, workspaceId.id).innerText()
        await macA.win.keyboard.press('Escape')
        return offline === 'true' && text.includes('offline')
      }, 'the server workspace shows offline in the switcher')
      await switchTo(macA.win, workspaceId.id)
      const before = await macA.win.evaluate(() => window.electronAPI.listSessions())
      await macA.win.keyboard.press('Meta+N')
      const notice = macA.win.getByTestId('launch-notice')
      await notice.waitFor()
      assert.match(await notice.innerText(), /offline/)
      assert.deepEqual(
        await macA.win.evaluate(() => window.electronAPI.listSessions()),
        before,
        'the refused launch started nothing on the Mac'
      )
    })
    t.check('with the server stopped, its workspace shows offline and a launch is refused', true)
    assert.deepEqual(macA.errors, [])
    assert.deepEqual(macB.errors, [])
  } finally {
    await world.close()
  }
}
