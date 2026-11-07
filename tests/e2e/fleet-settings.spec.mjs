import assert from 'node:assert/strict'
import { fleetWorld, openServersPage, eventually, request } from './fixtures/fleet-world.mjs'

export async function run(t) {
  const world = await fleetWorld('settings')
  try {
    const [a, b] = world.servers
    await request(a, '/accounts/claude', { label: 'Fixture login' })
    const claudeAccounts = await request(a, '/accounts/claude')
    const codexAccounts = await request(a, '/accounts/codex')
    const mac = await world.mac('a')
    const { win } = mac
    const list = () => win.evaluate(() => window.electronAPI.fleetList())
    const page = win.locator('[data-settings-page="servers"]')
    const tokenInput = win.getByLabel('Server bearer token', { exact: true })
    const add = async (name, url, token) => {
      await win.getByLabel('Server name', { exact: true }).fill(name)
      await win.getByLabel('Server address', { exact: true }).fill(url)
      await tokenInput.fill(token)
      await win.getByRole('button', { name: 'Add server', exact: true }).click()
    }

    await openServersPage(win)
    t.check('Settings opens the Servers page', await page.isVisible())
    t.check(
      'an empty server list explains how to add one',
      await page
        .getByText('No server yet. Add one below with the token the install script printed.', {
          exact: true
        })
        .isVisible()
    )
    t.equal(
      'the Servers navigation row is selected',
      await win.locator('[data-settings-nav-row="servers"]').getAttribute('data-selected'),
      'true'
    )

    await add('Personal VPS 1', a.url, a.token)
    await eventually(async () => (await list()).length === 1, 'the first server is saved')
    const [first] = await list()
    const firstRow = page.locator(`[data-server-id="${first.id}"]`)
    await eventually(
      async () => (await firstRow.locator('.status-text').innerText()) === 'Connected',
      'the saved server connects'
    )
    t.check('saving a server exposes no token in the connection list', !('token' in first))
    t.equal('the token field is emptied after adding a server', await tokenInput.inputValue(), '')
    t.check(
      'the server row shows its name and address',
      (await firstRow.getByText('Personal VPS 1', { exact: true }).isVisible()) &&
        (await firstRow.getByText(a.url, { exact: true }).isVisible())
    )
    t.equal(
      'the first server reports its live connected state',
      await firstRow.locator('.status-text').innerText(),
      'Connected'
    )
    t.check(
      'the saved token never appears in the page text',
      !(await page.innerText()).includes(a.token)
    )
    t.check(
      'the token input masks new credentials',
      (await tokenInput.getAttribute('type')) === 'password'
    )
    t.equal(
      'Servers settings has no session launch button',
      await page.getByRole('button', { name: 'New session', exact: true }).count(),
      0
    )

    for (const account of [...claudeAccounts, ...codexAccounts]) {
      await eventually(
        async () =>
          (
            await firstRow.locator(`[data-server-login="${account.id}"]`).allTextContents()
          ).includes(account.label),
        'the connected server lists each of its own login labels'
      )
    }
    t.check(
      'connected servers show their own Claude and Codex logins read-only',
      (await firstRow.getByText('Logins on this server', { exact: true }).isVisible()) &&
        (await firstRow.getByText('Fixture login', { exact: true }).isVisible()) &&
        (await firstRow.getByText('Claude', { exact: true }).isVisible()) &&
        (await firstRow.getByText('Codex', { exact: true }).isVisible()) &&
        (await firstRow
          .locator('[data-server-login] button, [data-server-login] input')
          .count()) === 0
    )

    await add('Personal VPS 2', b.url, b.token + 'x')
    await eventually(async () => (await list()).length === 2, 'the second server is saved')
    const second = (await list())[1]
    const secondRow = page.locator(`[data-server-id="${second.id}"]`)
    await eventually(
      async () => (await secondRow.locator('.status-text').innerText()) === 'Token refused',
      'the server reports a refused token'
    )
    t.check(
      'a refused token shows the connection error under its server row',
      (await secondRow.getByRole('alert').innerText()).includes('refused the token')
    )
    t.equal(
      'a refused connection has no login chips',
      await secondRow.locator('[data-server-login]').count(),
      0
    )
    t.equal('a refused token also leaves the input empty', await tokenInput.inputValue(), '')
    t.check(
      'a refused token stays out of page text',
      !(await page.innerText()).includes(b.token + 'x')
    )

    await firstRow.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await eventually(
      async () =>
        (await list()).find((connection) => connection.id === first.id)?.enabled === false &&
        (await firstRow.locator('.status-text').innerText()) === 'Disconnected',
      'disconnect disables the saved connection and updates its state'
    )
    t.check(
      'disconnect offers Connect and drops the server logins',
      (await firstRow.getByRole('button', { name: 'Connect', exact: true }).isVisible()) &&
        (await firstRow.locator('[data-server-login]').count()) === 0
    )
    await firstRow.getByRole('button', { name: 'Connect', exact: true }).click()
    await eventually(
      async () =>
        (await list()).find((connection) => connection.id === first.id)?.enabled === true &&
        (await firstRow.locator('.status-text').innerText()) === 'Connected',
      'Connect enables the saved connection and reconnects'
    )
    t.check(
      'Connect returns the server to Connected',
      await firstRow.getByRole('button', { name: 'Disconnect', exact: true }).isVisible()
    )

    await secondRow.getByRole('button', { name: 'Remove', exact: true }).click()
    await eventually(
      async () => (await list()).length === 1 && (await secondRow.count()) === 0,
      'Remove forgets the second connection'
    )
    t.check(
      'Remove deletes the saved connection and its row',
      (await list()).length === 1 && (await secondRow.count()) === 0
    )

    await add('Broken', 'not a server address', 'whatever')
    const addError = page.getByTestId('servers-add-error')
    await addError.waitFor()
    t.check(
      'a bad address shows the registry sentence on the add form',
      (await addError.innerText()).includes('valid Clave server')
    )
    t.equal('a rejected address saves no connection', (await list()).length, 1)
    t.equal('a failed add also empties the token input', await tokenInput.inputValue(), '')

    await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
    t.equal(
      'the sidebar has no Servers button',
      await win.getByLabel('Manage Clave servers', { exact: true }).count(),
      0
    )
    assert.deepEqual(mac.errors, [])
  } finally {
    await world.close()
  }
}
