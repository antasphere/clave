// A row's open "Manage" menu holds while the page is drawn again under it
// (PRDCT-4552). Rows of Settings → Connections are redrawn often: a rename or
// a removal pushed back by a machine, an account's usage read, a change of
// the pool's order, and the connection's own usage, which the window asks
// again every 2 s while the host still reads. Once open, a row's menu stays
// open and its entries act on that same connection until the person picks
// one, presses Escape or clicks away; so do the removal's question and a
// form open on a row.
//
// Fails if: an open menu closes or loses its entries when its row is drawn
// again (on this Mac or on a Clave server's page), an entry picked after the
// redraw acts on another connection, or the question or a form open on a
// row is closed by a redraw.
//
// Every value is made up; nothing reaches a provider or models.dev.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { until } from './harness.mjs'
import { connectMac, fleetWorld, openServersPage, request } from './fixtures/fleet-world.mjs'

const KIMI_KEY = 'sk-test-steady-kimi-' + 'k'.repeat(32)

/** True once `fn` answers truthy, false after about ten seconds. */
const settled = async (fn) => !!(await until(fn, { tries: 100, gapMs: 100 }))

async function pickMachine(win, name, value) {
  const picker = win.locator('[data-settings-select="settings-machine"]')
  const item = win.getByRole('menuitem', { name })
  for (let attempt = 0; attempt < 3; attempt++) {
    await picker.click()
    const offered = await item.waitFor({ state: 'visible', timeout: 1500 }).then(
      () => true,
      () => false
    )
    if (offered) await item.click({ timeout: 3000 }).catch(() => undefined)
    if ((await picker.getAttribute('data-value')) === value) return
    await win.keyboard.press('Escape')
  }
  throw new Error(`the machine picker never took ${String(name)}`)
}

export async function run(t) {
  const world = await fleetWorld('connections-menu-steady', { count: 1 })
  try {
    const [server] = world.servers
    const mac = await world.mac('a')
    const { app, win } = mac
    writeFileSync(
      path.join(mac.dir, 'models-catalog.json'),
      JSON.stringify({ fetchedAt: Date.now(), providers: [] })
    )
    // The host "still reads" OpenCode on every answer, with figures that move:
    // the window asks again every 2 s and redraws each connection's row.
    await app.evaluate(() => {
      const settings = globalThis.__claveE2E?.settings
      if (!settings) throw new Error('no settings source')
      let reads = 0
      settings.harnessUsage.read = async ({ range }) => {
        reads++
        const connections = await settings.providerConnections.list()
        return {
          range,
          rows: connections.map((c) => ({
            harness: 'pi',
            connectionId: c.id,
            label: c.label,
            billing: 'plan',
            removed: false,
            requests: reads,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: reads * 100,
            cost: 0,
            sessions: 1
          })),
          unavailable: [],
          reading: ['opencode']
        }
      }
      globalThis.__steadyReads = () => reads
      const original = globalThis.fetch
      globalThis.fetch = async (url, init) => {
        if (String(url).includes('models.dev')) throw new Error('models.dev is not reached here')
        return original(url, init)
      }
    })
    const ids = await win.evaluate(async (KIMI_KEY) => {
      const api = window.electronAPI
      const a = await api.claudeAccountAdd({ label: 'Alpha' })
      const b = await api.claudeAccountAdd({ label: 'Beta' })
      const kimi = await api.providerConnectionAdd({ company: 'moonshot', label: 'Kimi' })
      await api.providerConnectionSetKey(kimi.id, KIMI_KEY)
      const other = await api.providerConnectionAdd({ company: 'moonshot', label: 'Other' })
      return { a: a.id, b: b.id, kimi: kimi.id, other: other.id }
    }, KIMI_KEY)
    await connectMac(mac, world.servers, { ui: false })
    const [owner] = mac.owners

    await openServersPage(win)
    await win.locator('[data-settings-nav-row="accounts"]').click()
    const page = win.locator('[data-settings-page="accounts"]')
    await page.locator(`[data-provider-connection-row="${ids.kimi}"]`).waitFor()

    const entriesOf = (id) => win.locator(`[data-connection-menu-entries="${id}"]`)
    const openMenu = async (scope, id) => {
      await scope.locator(`[data-connection-menu="${id}"]`).click()
      await entriesOf(id).waitFor({ state: 'visible', timeout: 3000 })
    }
    const stillOpen = async (id) =>
      (await entriesOf(id).count()) === 1 && (await entriesOf(id).isVisible())
    const readsNow = () => app.evaluate(() => globalThis.__steadyReads())

    // ── 1. A stored connection's menu, through the usage rereads and a rename ──
    await openMenu(page, ids.kimi)
    const before = await readsNow()
    await settled(async () => (await readsNow()) >= before + 2)
    t.check(
      "1a. the menu stays open while the row's own usage is read again (twice, 2 s apart)",
      (await readsNow()) >= before + 2 && (await stillOpen(ids.kimi)),
      { reads: (await readsNow()) - before, open: await stillOpen(ids.kimi) }
    )
    await win.evaluate(
      (id) => window.electronAPI.providerConnectionRename(id, 'Kimi renamed'),
      ids.kimi
    )
    const renamed = await settled(
      async () =>
        ((await page.locator(`[data-provider-connection-label="${ids.kimi}"]`).textContent()) ??
          '') === 'Kimi renamed'
    )
    t.check(
      '1b. the menu stays open while a rename pushed back redraws its row',
      renamed && (await stillOpen(ids.kimi)),
      {
        renamed,
        open: await stillOpen(ids.kimi)
      }
    )
    await win.evaluate((id) => window.electronAPI.providerConnectionRemove(id), ids.other)
    const otherGone = await settled(
      async () =>
        (await page.locator(`[data-provider-connection-row="${ids.other}"]`).count()) === 0
    )
    t.check(
      '1c. the menu stays open while another row of its card is removed by a push',
      otherGone && (await stillOpen(ids.kimi)),
      { otherGone, open: await stillOpen(ids.kimi) }
    )
    await entriesOf(ids.kimi)
      .locator(`[data-provider-remove="${ids.kimi}"]`)
      .click({ timeout: 3000 })
    const question = page.locator(`[data-connection-remove-question="${ids.kimi}"]`)
    t.check(
      '1d. its Remove, picked after the redraws, asks about that same connection',
      (await question.waitFor({ timeout: 3000 }).then(
        () => true,
        () => false
      )) && /Remove Kimi renamed\?/.test(await question.innerText())
    )

    // ── 2. The removal's question holds through a rename and the rereads ──
    await win.evaluate(
      (id) => window.electronAPI.providerConnectionRename(id, 'Kimi again'),
      ids.kimi
    )
    const before2 = await readsNow()
    await settled(async () => (await readsNow()) >= before2 + 2)
    t.check(
      "2. the removal's question stays open through a rename and two usage reads",
      (await question.count()) === 1 && (await question.isVisible())
    )
    await page.locator(`[data-connection-remove-cancel="${ids.kimi}"]`).click()

    // ── 3. A form open on a row holds too ──
    await openMenu(page, ids.kimi)
    await entriesOf(ids.kimi).locator(`[data-provider-key="${ids.kimi}"]`).click({ timeout: 3000 })
    const keyForm = page.locator(`[data-provider-key-form="${ids.kimi}"]`)
    await keyForm.waitFor()
    await keyForm.locator('[data-provider-key-input]').fill('typed-but-not-saved')
    await win.evaluate(
      (id) => window.electronAPI.providerConnectionRename(id, 'Kimi third'),
      ids.kimi
    )
    const before3 = await readsNow()
    await settled(async () => (await readsNow()) >= before3 + 2)
    t.check(
      '3. a key form open on the row keeps its field and what was typed through the redraws',
      (await keyForm.count()) === 1 &&
        (await keyForm.locator('[data-provider-key-input]').inputValue()) === 'typed-but-not-saved'
    )
    await page.locator('[data-provider-key-cancel]').click()

    // ── 4. A Claude row's menu through a change of the pool's order and a usage read ──
    await openMenu(page, ids.b)
    await win.evaluate((order) => window.electronAPI.claudeAccountReorder(order), [ids.b, ids.a])
    const reordered = await settled(async () => {
      const rows = await page
        .locator('[data-claude-account-row]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-claude-account-row')))
      return rows.indexOf(ids.b) < rows.indexOf(ids.a) && rows.indexOf(ids.b) > 0
    })
    t.check(
      '4a. the menu stays open while the pool is reordered under it',
      reordered && (await stillOpen(ids.b)),
      {
        reordered,
        open: await stillOpen(ids.b)
      }
    )
    await win.evaluate(
      (id) => window.electronAPI.getUsageLimits(id, { force: true }).catch(() => null),
      ids.b
    )
    await win.waitForTimeout(500)
    t.check("4b. and while the account's usage is read again", await stillOpen(ids.b))
    await entriesOf(ids.b)
      .locator(`[data-claude-account-remove="${ids.b}"]`)
      .click({ timeout: 3000 })
    t.check(
      '4c. its Remove asks about that same account',
      /Remove Beta\?/.test(
        await page.locator(`[data-connection-remove-question="${ids.b}"]`).innerText()
      )
    )
    await page.locator(`[data-connection-remove-cancel="${ids.b}"]`).click()

    // ── 5. On a Clave server's page: a rename made on the server, pushed back ──
    const zai = await request(server, '/connections/providers', { company: 'zai', label: 'GLM' })
    await pickMachine(win, /^Personal VPS 1/, owner.id)
    const serverPage = page.locator(`[data-server-settings="${owner.id}"]`)
    await serverPage.locator(`[data-provider-connection-row="${zai.id}"]`).waitFor()
    await openMenu(serverPage, zai.id)
    await request(server, '/connections/providers/rename', { id: zai.id, label: 'GLM renamed' })
    const serverRenamed = await settled(
      async () =>
        ((await serverPage.locator(`[data-provider-connection-label="${zai.id}"]`).textContent()) ??
          '') === 'GLM renamed'
    )
    t.check(
      "5a. a server row's menu stays open while the server's rename is pushed back",
      serverRenamed && (await stillOpen(zai.id)),
      { serverRenamed, open: await stillOpen(zai.id) }
    )
    await entriesOf(zai.id).locator(`[data-provider-remove="${zai.id}"]`).click({ timeout: 3000 })
    t.check(
      '5b. its Remove asks about that same connection',
      /Remove GLM renamed\?/.test(
        await serverPage.locator(`[data-connection-remove-question="${zai.id}"]`).innerText()
      )
    )
    await serverPage.locator(`[data-connection-remove-cancel="${zai.id}"]`).click()

    // ── 6. Menu, question, menu again: the press that opens it is never undone ──
    // A closed menu kept mounted for its fade, its fade's end never reported,
    // kept its outside listener armed: the next press on Manage opened the
    // menu and that listener closed it at once (what `provider-connections`
    // met after its rename). Each round closes a menu by a pick (Rename, then
    // Remove whose question takes the focus), then opens it on one press.
    const lingering = () =>
      win.evaluate(() => document.querySelectorAll('[data-connection-menu-entries]').length)
    const trail = []
    for (let round = 1; round <= 3; round++) {
      const left = await lingering()
      await openMenu(serverPage, zai.id)
      await entriesOf(zai.id).locator(`[data-provider-rename="${zai.id}"]`).click({ timeout: 3000 })
      const input = serverPage.locator('[data-provider-rename-input]')
      await input.waitFor({ timeout: 3000 })
      await input.fill(`GLM round ${round}`)
      await input.press('Enter')
      await settled(
        async () =>
          ((await serverPage
            .locator(`[data-provider-connection-label="${zai.id}"]`)
            .textContent()) ?? '') === `GLM round ${round}`
      )
      const leftAfterRename = await lingering()
      await serverPage.locator(`[data-connection-menu="${zai.id}"]`).click()
      // Held a moment: a menu closed by a stale listener is gone by then.
      await win.waitForTimeout(400)
      const shown = await entriesOf(zai.id)
        .waitFor({ state: 'visible', timeout: 3000 })
        .then(
          () => true,
          () => false
        )
      const picked = shown
        ? await entriesOf(zai.id)
            .locator(`[data-provider-remove="${zai.id}"]`)
            .click({ timeout: 3000 })
            .then(
              () => true,
              () => false
            )
        : false
      const asked = await serverPage
        .locator(`[data-connection-remove-question="${zai.id}"]`)
        .waitFor({ timeout: 3000 })
        .then(
          () => true,
          () => false
        )
      trail.push({ round, left, leftAfterRename, shown, picked, asked })
      if (asked) await serverPage.locator(`[data-connection-remove-cancel="${zai.id}"]`).click()
      else await win.keyboard.press('Escape')
    }
    t.check(
      '6a. no closed menu stays mounted after a pick',
      trail.every((r) => r.left === 0 && r.leftAfterRename === 0),
      trail
    )
    t.check(
      '6b. after a rename and after a question, the menu opens on one press, stays, and Remove asks',
      trail.every((r) => r.shown && r.picked && r.asked),
      trail
    )
    await pickMachine(win, 'This Mac', 'local')

    t.check('no page error', mac.errors.length === 0, mac.errors)
  } finally {
    await world.close()
  }
}
