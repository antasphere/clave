// Settings → Helpers with a saved server picked (PRDCT-4330): the page is
// the server's, read over its connection; a switch, a model and an account
// set there are stored on the server, whose runner reads them at each call,
// and this Mac's own preference is untouched. The accounts offered are the
// server's. `settings-helpers.spec.mjs` drives this Mac's page and the
// spawned arguments.
import {
  connectMac,
  eventually,
  fleetWorld,
  openServersPage,
  request
} from './fixtures/fleet-world.mjs'

async function pickFrom(win, select, name, value) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await select.click()
    const item = win.getByRole('menuitem', { name })
    const offered = await item.waitFor({ state: 'visible', timeout: 1500 }).then(
      () => true,
      () => false
    )
    if (offered) await item.click({ timeout: 3000 }).catch(() => undefined)
    if ((await select.getAttribute('data-value')) === value) return
    await win.keyboard.press('Escape')
  }
  throw new Error(`the select never took ${String(name)}`)
}

export async function run(t) {
  const world = await fleetWorld('settings-helpers', { count: 1 })
  try {
    const [a] = world.servers
    const studio = await request(a, '/accounts/claude', { label: 'Helpers login' })
    const mac = await world.mac('a')
    const { win } = mac
    await connectMac(mac, world.servers, { ui: false })
    const [owner] = mac.owners
    await openServersPage(win)

    const picker = win.locator('[data-settings-select="settings-machine"]')
    await pickFrom(win, picker, owner.name, owner.id)
    await win.locator('[data-settings-nav-row="helpers"]').click()
    const page = win.locator('[data-settings-page="helpers"]')
    await page.locator(`[data-server-settings="${owner.id}"]`).waitFor()
    const row = page.locator('[data-helper-row="exchange-digest"]')
    await row.waitFor()
    t.check(
      "the page lists the server's helpers",
      (await page.locator('[data-helper-row]').count()) >= 5
    )

    // A model and an account of the server, then the switch.
    const model = row.locator('[data-settings-select="helper-model-exchange-digest"]')
    await pickFrom(win, model, /^Opus/, 'opus')
    const account = row.locator('[data-settings-select="helper-account-exchange-digest"]')
    await pickFrom(win, account, 'Helpers login', `account:${studio.id}`)
    await row.getByRole('switch', { name: 'Exchange digests' }).click()
    await eventually(
      async () =>
        (await row
          .getByRole('switch', { name: 'Exchange digests' })
          .getAttribute('aria-checked')) === 'false',
      'the switch turns off'
    )

    const onServer = (await request(a, '/helpers')).helpers.find((h) => h.id === 'exchange-digest')
    t.check(
      'the server holds the model, the account and the switch',
      onServer?.model === 'opus' &&
        onServer?.enabled === false &&
        onServer?.account?.kind === 'account' &&
        onServer?.account?.accountId === studio.id,
      onServer
    )
    t.check(
      'the row says what an off digest gives instead',
      /no digest/.test((await row.locator('[data-helper-when-off]').textContent()) ?? '')
    )
    const onMac = (await win.evaluate(() => window.electronAPI.helpersList())).find(
      (h) => h.id === 'exchange-digest'
    )
    t.check(
      "this Mac's own preference is untouched",
      onMac?.enabled === true && onMac?.model === 'haiku' && onMac?.account?.kind === 'session',
      onMac
    )

    // Back to this Mac: its page shows its own, not the server's.
    await pickFrom(win, picker, 'This Mac', 'local')
    await page.locator('[data-helpers="local"]').waitFor()
    t.equal(
      "this Mac's page shows its own switch",
      await page
        .locator('[data-helper-row="exchange-digest"]')
        .getByRole('switch', { name: 'Exchange digests' })
        .getAttribute('aria-checked'),
      'true'
    )
  } finally {
    await world.close()
  }
}
