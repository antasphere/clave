// Provider connections on Settings → Connections (PRDCT-4426, lane B of the
// harness wave): a key pasted once for a company's coding plan or API, a
// local Ollama, or another provider's endpoint, on this Mac and on a saved
// server's page. The key goes in through one call and comes back in no
// answer, no page, no file in the clear and no server output; on a server it
// is filed in the run's own keychain file (macOS), and removing the
// connection forgets it. Each machine keeps its own connections. Every key
// here is invented; nothing reaches a provider.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { until } from './harness.mjs'
import { connectMac, fleetWorld, openServersPage, request } from './fixtures/fleet-world.mjs'

const KEY_MAC = 'sk-test-mac-' + 'm'.repeat(40)
const KEY_SERVER = 'sk-test-server-' + 's'.repeat(40)
const KEY_GENERIC = 'sk-test-generic-' + 'g'.repeat(40)
const KEY_DRAFT = 'sk-test-draft-' + 'd'.repeat(40)
const KEY_MAC2 = 'sk-test-mac2-' + 'n'.repeat(40)
const KEYS = [KEY_MAC, KEY_SERVER, KEY_GENERIC, KEY_DRAFT, KEY_MAC2]

const CONNECTIONS_FILE = 'provider-connections.json'
const CREDENTIALS_FILE = 'provider-connections-credentials.json'

/** True once `fn` answers truthy, false after about twelve seconds. */
const settled = async (fn) => !!(await until(fn, { tries: 120, gapMs: 100 }))

/** Whether a text holds any of the run's keys. */
const holdsKey = (text) => KEYS.some((key) => String(text ?? '').includes(key))

/** A file of a data folder: at its root, else the first one found below it. */
function findFile(dir, name) {
  const direct = path.join(dir, name)
  if (existsSync(direct)) return direct
  try {
    const hit = readdirSync(dir, { recursive: true }).find(
      (entry) => path.basename(String(entry)) === name
    )
    return hit ? path.join(dir, String(hit)) : null
  } catch {
    return null
  }
}
const readText = (file) => (file && existsSync(file) ? readFileSync(file, 'utf8') : '')

/** Pick a machine in the settings sidebar's picker (as `fleet-settings-machine`). */
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

/** Open a Connect menu and pick a company: the menu animates in, so the open is waited for. */
async function connectPick(win, trigger, company) {
  const item = win.locator(`[data-connect-company="${company}"]`)
  for (let attempt = 0; attempt < 3; attempt++) {
    await trigger.click()
    const offered = await item.waitFor({ state: 'visible', timeout: 1500 }).then(
      () => true,
      () => false
    )
    if (offered) {
      await item.click({ timeout: 3000 }).catch(() => undefined)
      const form = win.locator(`[data-provider-add-form="${company}"]`)
      if (
        await form.waitFor({ state: 'visible', timeout: 3000 }).then(
          () => true,
          () => false
        )
      )
        return form
    }
    await win.keyboard.press('Escape')
  }
  throw new Error(`the Connect menu never opened the ${company} form`)
}

const macList = (win) => win.evaluate(() => window.electronAPI.providerConnectionsList())
const textOf = async (locator) =>
  (await locator.count()) ? ((await locator.first().textContent()) ?? '').trim() : null

export async function run(t) {
  const world = await fleetWorld('provider-connections', { count: 1 })
  try {
    const [server] = world.servers
    const mac = await world.mac('a')
    const { win } = mac
    // The Mac's own output (its main process hosts the in-process server):
    // Playwright pipes the app's stdout and stderr; both are kept from here.
    let macOutput = ''
    const macStreams = []
    for (const stream of [mac.app.process().stdout, mac.app.process().stderr]) {
      if (stream && typeof stream.on === 'function' && stream.readable !== false) {
        stream.on('data', (chunk) => {
          macOutput += String(chunk)
        })
        macStreams.push(stream === mac.app.process().stdout ? 'stdout' : 'stderr')
      }
    }
    await connectMac(mac, world.servers, { ui: false })
    const [owner] = mac.owners

    await openServersPage(win)
    await win.locator('[data-settings-nav-row="accounts"]').click()
    const page = win.locator('[data-settings-page="accounts"]')
    await page.locator('[data-connect]').waitFor()

    // ── 1. Moonshot, on this Mac ──
    const moonForm = await connectPick(win, page.locator('[data-connect]'), 'moonshot')
    const moonLabel = await moonForm.locator('[data-provider-add-label]').inputValue()
    await moonForm.locator('[data-provider-add-key]').fill(KEY_MAC)
    await moonForm.locator('[data-provider-add-save]').click()
    t.check('1. Connect → Moonshot opens its form, labelled Moonshot', moonLabel === 'Moonshot', {
      label: moonLabel
    })

    // ── 2. Its row, with the key stored ──
    const moonRow = page.locator(
      '[data-provider-company-section="moonshot"] [data-provider-connection-row]'
    )
    const moonShown = await settled(
      async () =>
        (await moonRow.count()) === 1 &&
        (await textOf(moonRow.locator('[data-provider-connection-key-state]'))) === 'Key stored' &&
        (await win.locator('[data-provider-add-form]').count()) === 0
    )
    const moonId = (await moonRow.count())
      ? await moonRow.getAttribute('data-provider-connection-row')
      : null
    const moonState = moonId
      ? await textOf(page.locator(`[data-provider-connection-key-state="${moonId}"]`))
      : null
    t.check(
      '2. a Moonshot row appears and reads "Key stored"',
      moonShown && moonState === 'Key stored',
      {
        rows: await moonRow.count(),
        state: holdsKey(moonState) ? '[key]' : moonState
      }
    )

    // ── 3. The window's read: one connection, the key held, never carried ──
    const listed = await macList(win)
    const moon = listed.filter((c) => c.company === 'moonshot')
    t.check(
      '3. the Mac lists one Moonshot connection with its key held and never the key',
      moon.length === 1 &&
        moon[0].hasKey === true &&
        moon[0].id === moonId &&
        moon[0].endpoints.length === 2 &&
        !JSON.stringify(listed).includes(KEY_MAC),
      {
        count: moon.length,
        hasKey: moon[0]?.hasKey,
        endpoints: moon[0]?.endpoints.length,
        leaked: JSON.stringify(listed).includes(KEY_MAC)
      }
    )

    // ── 4. The page: neither in its text nor in any attribute ──
    const inText = (await win.evaluate(() => document.body.innerText)).includes(KEY_MAC)
    const inHtml = (await win.evaluate(() => document.documentElement.outerHTML)).includes(KEY_MAC)
    t.check('4. the key is nowhere on the page, text or attribute', !inText && !inHtml, {
      inText,
      inHtml
    })

    // ── 5. The Mac's files: sealed, the credential under the connection's id ──
    const macConnections = findFile(mac.dir, CONNECTIONS_FILE)
    const macCredentials = findFile(mac.dir, CREDENTIALS_FILE)
    t.check(
      "5. the Mac's two files exist, neither holds the key, the credentials name the connection",
      !!macConnections &&
        !!macCredentials &&
        !readText(macConnections).includes(KEY_MAC) &&
        !readText(macCredentials).includes(KEY_MAC) &&
        !!moonId &&
        readText(macCredentials).includes(moonId),
      {
        connections: !!macConnections,
        credentials: !!macCredentials,
        clearInConnections: readText(macConnections).includes(KEY_MAC),
        clearInCredentials: readText(macCredentials).includes(KEY_MAC)
      }
    )

    // ── 6. Another provider: a base URL, the default wire format, a key ──
    const genericForm = await connectPick(win, page.locator('[data-connect]'), 'generic')
    await genericForm.locator('[data-provider-add-label]').fill('Lab box')
    await genericForm.locator('[data-provider-add-base-url]').fill('https://llm.example.test/v1')
    const wireFormat = await genericForm
      .locator('[data-provider-add-wire-format]')
      .getAttribute('data-provider-add-wire-format')
    await genericForm.locator('[data-provider-add-key]').fill(KEY_GENERIC)
    await genericForm.locator('[data-provider-add-save]').click()
    const genericRow = page.locator(
      '[data-provider-company-section="generic"] [data-provider-connection-row]'
    )
    const genericShown = await settled(
      async () =>
        (await genericRow.count()) === 1 &&
        (await genericRow.innerText()).includes('llm.example.test')
    )
    t.check(
      '6. another provider gets its row, showing the endpoint host',
      genericShown && wireFormat === 'openai-chat',
      { rows: await genericRow.count(), wireFormat }
    )

    // ── 7. Ollama: a prefilled base URL and no key ──
    const ollamaForm = await connectPick(win, page.locator('[data-connect]'), 'ollama')
    const ollamaUrl = await ollamaForm.locator('[data-provider-add-base-url]').inputValue()
    const ollamaKeyFields = await ollamaForm.locator('[data-provider-add-key]').count()
    await ollamaForm.locator('[data-provider-add-save]').click()
    const ollamaRow = page.locator(
      '[data-provider-company-section="ollama"] [data-provider-connection-row]'
    )
    const ollamaShown = await settled(async () => (await ollamaRow.count()) === 1)
    const ollamaId = ollamaShown
      ? await ollamaRow.getAttribute('data-provider-connection-row')
      : null
    const ollamaState = ollamaId
      ? await textOf(page.locator(`[data-provider-connection-key-state="${ollamaId}"]`))
      : null
    t.check(
      '7. Ollama: the base URL is prefilled, no key field, the row reads "No key needed"',
      ollamaUrl === 'http://localhost:11434/v1' &&
        ollamaKeyFields === 0 &&
        ollamaState === 'No key needed',
      { url: ollamaUrl, keyFields: ollamaKeyFields, state: ollamaState }
    )

    // ── 7b. The key form on the Moonshot row: a cancelled key is gone, a saved one replaces ──
    const keyButton = page.locator(`[data-provider-key="${moonId}"]`)
    const keyInput = page.locator('[data-provider-key-input]')
    await keyButton.click()
    await keyInput.waitFor()
    await keyInput.fill(KEY_DRAFT)
    await page.locator('[data-provider-key-cancel]').click()
    const draftClosed = await settled(async () => (await keyInput.count()) === 0)
    await keyButton.click()
    await keyInput.waitFor()
    const reopenedValue = await keyInput.inputValue()
    const draftOnPage =
      (await win.evaluate(() => document.documentElement.outerHTML)).includes(KEY_DRAFT) ||
      (await win.evaluate(() => document.body.innerText)).includes(KEY_DRAFT)
    await keyInput.fill(KEY_MAC2)
    await page.locator('[data-provider-key-save]').click()
    const keyFormClosed = await settled(
      async () => (await page.locator('[data-provider-key-form]').count()) === 0
    )
    const replacedState = moonId
      ? await textOf(page.locator(`[data-provider-connection-key-state="${moonId}"]`))
      : null
    const afterReplace = JSON.stringify(await macList(win))
    const replacePage =
      (await win.evaluate(() => document.documentElement.outerHTML)) +
      (await win.evaluate(() => document.body.innerText))
    t.check(
      '7b. the key form: a cancelled key does not come back, a saved one leaves "Key stored" and no key anywhere',
      draftClosed &&
        reopenedValue === '' &&
        !draftOnPage &&
        keyFormClosed &&
        replacedState === 'Key stored' &&
        !afterReplace.includes(KEY_MAC) &&
        !afterReplace.includes(KEY_MAC2) &&
        !holdsKey(replacePage),
      {
        draftClosed,
        reopenedEmpty: reopenedValue === '',
        draftOnPage,
        keyFormClosed,
        state: holdsKey(replacedState) ? '[key]' : replacedState,
        inList: holdsKey(afterReplace),
        onPage: holdsKey(replacePage)
      }
    )

    // ── The server, from the Mac ──
    await pickMachine(win, /^Personal VPS 1/, owner.id)
    const serverPage = page.locator(`[data-server-settings="${owner.id}"]`)
    await serverPage.waitFor()
    const connectProviders = page.locator('[data-connect-providers]')
    await connectProviders.waitFor()

    // ── 8. The read-only accounts stay as they were ──
    const claudeCard = await serverPage.locator('[data-server-claude-accounts]').count()
    const codexCard = await serverPage.locator('[data-server-codex-accounts]').count()
    const addButtons = await page.locator('[data-claude-add-account]').count()
    t.check(
      '8. the server page keeps its read-only Claude and Codex cards and no add button',
      claudeCard === 1 && codexCard === 1 && addButtons === 0,
      { claudeCard, codexCard, addButtons }
    )

    // ── 9. Z.ai, on the server ──
    if (!world.keychain) t.check('keychain checks skipped: not macOS', true, process.platform)
    const before = world.keychain ? world.keychain.items() : null
    const zaiForm = await connectPick(win, connectProviders, 'zai')
    await zaiForm.locator('[data-provider-add-key]').fill(KEY_SERVER)
    await zaiForm.locator('[data-provider-add-save]').click()
    const zaiRow = serverPage.locator(
      '[data-provider-company-section="zai"] [data-provider-connection-row]'
    )
    // The row comes with the connection, then its key: the state and the
    // form's close are waited for before the page is read.
    const zaiShown = await settled(
      async () =>
        (await zaiRow.count()) === 1 &&
        (await textOf(serverPage.locator('[data-provider-connection-key-state]'))) ===
          'Key stored' &&
        (await win.locator('[data-provider-add-form]').count()) === 0
    )
    const zaiId = (await zaiRow.count())
      ? await zaiRow.getAttribute('data-provider-connection-row')
      : null
    const zaiState = zaiId
      ? await textOf(serverPage.locator(`[data-provider-connection-key-state="${zaiId}"]`))
      : null
    const serverPageHtml = await win.evaluate(() => document.documentElement.outerHTML)
    const serverPageText = await win.evaluate(() => document.body.innerText)
    t.check(
      '9. a Z.ai row appears on the server page, "Key stored", the key nowhere on the page',
      zaiShown &&
        zaiState === 'Key stored' &&
        !serverPageHtml.includes(KEY_SERVER) &&
        !serverPageText.includes(KEY_SERVER),
      {
        rows: await zaiRow.count(),
        state: holdsKey(zaiState) ? '[key]' : zaiState,
        onPage: serverPageHtml.includes(KEY_SERVER) || serverPageText.includes(KEY_SERVER)
      }
    )

    // ── 10. Filed in the run's own keychain ──
    if (world.keychain) {
      const after = world.keychain.items()
      t.check("10. the key is one more item in the run's keychain file", after === before + 1, {
        before,
        after
      })
    }

    // ── 11. The server's answer ──
    const served = await request(server, '/connections/providers')
    t.check(
      "11. the server's GET answers one Z.ai connection, its key held and never carried",
      served.length === 1 &&
        served[0].company === 'zai' &&
        served[0].hasKey === true &&
        served[0].id === zaiId &&
        !JSON.stringify(served).includes(KEY_SERVER),
      {
        count: served.length,
        company: served[0]?.company,
        hasKey: served[0]?.hasKey,
        leaked: JSON.stringify(served).includes(KEY_SERVER)
      }
    )

    // ── 12. The server's files and output ──
    const serverConnections = findFile(server.dataDir, CONNECTIONS_FILE)
    const serverCredentials = findFile(server.dataDir, CREDENTIALS_FILE)
    // The daemon's stderr and stdout are both kept (their last 16 KB each).
    const stderr = typeof server.stderr === 'function' ? server.stderr() : ''
    const stdout = typeof server.stdout === 'function' ? server.stdout() : null
    // The daemon announces itself on stdout ({"url":…}): its line proves the copy is taken.
    const stdoutKept = stdout !== null && stdout.includes('"url":')
    t.check(
      "12. the server's two files exist, neither holds the key, nor do its stderr and stdout",
      !!serverConnections &&
        !!serverCredentials &&
        !readText(serverConnections).includes(KEY_SERVER) &&
        !readText(serverCredentials).includes(KEY_SERVER) &&
        !stderr.includes(KEY_SERVER) &&
        stdoutKept &&
        !stdout.includes(KEY_SERVER),
      {
        connections: !!serverConnections,
        credentials: !!serverCredentials,
        clearInFiles:
          readText(serverConnections).includes(KEY_SERVER) ||
          readText(serverCredentials).includes(KEY_SERVER),
        clearInStderr: stderr.includes(KEY_SERVER),
        stdoutKept,
        stdoutBytes: stdout?.length ?? 0,
        clearInStdout: !!stdout?.includes(KEY_SERVER)
      }
    )

    // ── 13. Each machine keeps its own ──
    const macNow = await macList(win)
    const serverNow = await request(server, '/connections/providers')
    t.check(
      '13. the Mac has no Z.ai connection and the server no Moonshot one',
      !macNow.some((c) => c.company === 'zai') && !serverNow.some((c) => c.company === 'moonshot'),
      {
        mac: macNow.map((c) => c.company),
        server: serverNow.map((c) => c.company)
      }
    )

    // ── 14. Rename on the server page ──
    await serverPage.locator(`[data-provider-rename="${zaiId}"]`).click()
    const renameInput = serverPage.locator('[data-provider-rename-input]')
    await renameInput.waitFor()
    await renameInput.fill('Work plan')
    await renameInput.press('Enter')
    const renamedOnPage = await settled(
      async () =>
        (await textOf(serverPage.locator(`[data-provider-connection-label="${zaiId}"]`))) ===
        'Work plan'
    )
    const renamedServed = await settled(async () =>
      (await request(server, '/connections/providers')).some(
        (c) => c.id === zaiId && c.label === 'Work plan'
      )
    )
    t.check(
      '14. renamed on the server page, the row and the server read "Work plan"',
      renamedOnPage && renamedServed,
      { onPage: renamedOnPage, served: renamedServed }
    )

    // ── 15. Remove on the server page ──
    await serverPage.locator(`[data-provider-remove="${zaiId}"]`).click()
    const rowGone = await settled(async () => (await zaiRow.count()) === 0)
    const servedEmpty = await settled(
      async () => (await request(server, '/connections/providers')).length === 0
    )
    const keychainBack = world.keychain
      ? await settled(async () => world.keychain.items() === before)
      : true
    t.check(
      '15. removed on the server page: the row goes, the server lists none, the keychain item goes',
      rowGone && servedEmpty && keychainBack,
      {
        rowGone,
        servedEmpty,
        keychain: world.keychain ? { before, after: world.keychain.items() } : 'skipped'
      }
    )

    // ── 17. A server's push reaches the Mac's page ──
    // Added on the server by another client, after check 15 so its keychain
    // arithmetic stands (Mistral here gets no key, so no item is filed), and
    // removed through the page before the Mac's own checks.
    const mistralSection = serverPage.locator('[data-provider-company-section="mistral"]')
    const pushed = await request(server, '/connections/providers', { company: 'mistral' })
    const pushedShown = await settled(async () => (await mistralSection.count()) === 1)
    t.check(
      "17. a connection added on the server by another client appears on the Mac's server page, unprompted",
      pushedShown && typeof pushed?.id === 'string',
      { shown: pushedShown, added: typeof pushed?.id === 'string' }
    )
    if (pushedShown) {
      await serverPage.locator(`[data-provider-remove="${pushed.id}"]`).click()
    } else if (typeof pushed?.id === 'string') {
      await request(server, '/connections/providers/remove', { id: pushed.id })
    }
    const pushedGone = await settled(
      async () => (await request(server, '/connections/providers')).length === 0
    )
    t.check('17b. the pushed connection is removed again, the server lists none', pushedGone, {
      gone: pushedGone
    })

    // ── 16. Remove on this Mac ──
    await pickMachine(win, 'This Mac', 'local')
    await page.locator('[data-connect]').waitFor()
    const moonRemove = page.locator(`[data-provider-remove="${moonId}"]`)
    await moonRemove.waitFor()
    await moonRemove.click()
    const moonGone = await settled(async () => (await moonRow.count()) === 0)
    const moonUnlisted = await settled(
      async () => !(await macList(win)).some((c) => c.id === moonId)
    )
    const credentialsForget = !readText(findFile(mac.dir, CREDENTIALS_FILE)).includes(moonId)
    t.check(
      "16. removed on this Mac: the row, the list entry and the credential's id are gone",
      moonGone && moonUnlisted && credentialsForget,
      { rowGone: moonGone, unlisted: moonUnlisted, credentialsForget }
    )

    // ── 18. The Mac's own output ──
    // Bytes asked for too: a capture that read nothing would prove nothing.
    t.check(
      "18. the Mac's own output holds no key",
      macStreams.length > 0 && macOutput.length > 0 && !holdsKey(macOutput),
      { streams: macStreams, bytes: macOutput.length, leaked: holdsKey(macOutput) }
    )

    assert.deepEqual(mac.errors, [])
  } finally {
    await world.close()
  }
}
