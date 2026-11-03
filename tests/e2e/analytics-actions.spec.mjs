// The actions a plugin contributes, through the first plugin that contributes them: the
// bundled Analytics plugin (on by default). Every assertion is about what the person can
// click in the real app: the entry in a tab's menu with its preview card, the entry in a
// group's menu, the workspace button in the toolbar, the page each one opens in the content
// column, and the way back; then the plugin switched off and every entry gone. The failure
// mode of all of this is silence (an unread manifest field draws nothing and reports
// nothing), so the checks are on the DOM and on the page the plugin actually served.
import assert from 'node:assert/strict'
import { callMcp, until } from './harness.mjs'
import { openChat } from './chat-view.spec.mjs'

const PLUGIN = 'clave.analytics'
const PAGE = `[data-plugin-page="${PLUGIN}"]`
/** Runs a script inside the page pane's web view guest, from the host (the guest is a
 *  separate web contents, not a frame of the window); null until the guest can answer. */
const inGuest = (win, script) =>
  win.evaluate(
    async ([selector, code]) => {
      const wv = document.querySelector(selector)
      if (!wv) return null
      try {
        return await wv.executeJavaScript(code)
      } catch {
        return null
      }
    },
    [`${PAGE} webview`, script]
  )
/** The served page's title, once its script drew it. */
const deckTitle = (win, expected) =>
  until(async () => {
    const text = await inGuest(win, `document.querySelector('.deck-title')?.textContent ?? ''`)
    return typeof text === 'string' && text.trim() === expected ? text.trim() : null
  })
const guestList = (win, selector, wanted) =>
  until(async () => {
    const names = await inGuest(
      win,
      `[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent)`
    )
    return Array.isArray(names) && names.includes(wanted) ? names : null
  })
const menuItems = (win) => win.locator('[role="menu"] [role="menuitem"]')
const menuItem = (win, label) => menuItems(win).filter({ hasText: label })
const rowButton = (win, id) => win.locator(`[data-sidebar-item-id="${id}"] button`).first()
const closeMenu = async (win) => {
  await win.keyboard.press('Escape')
  await menuItems(win)
    .first()
    .waitFor({ state: 'detached', timeout: 5_000 })
    .catch(() => undefined)
}

export async function run(t) {
  const chat = await openChat('analytics-actions')
  const { app, win, record } = chat
  try {
    // The plugin ships on, so a fresh profile runs it: its toolbar button is there and its
    // record says so.
    const active = await until(async () => {
      const plugin = (await win.evaluate(() => window.electronAPI.pluginsList())).find(
        (p) => p.id === PLUGIN
      )
      return plugin?.enabled && plugin.status === 'active' && plugin.actions.includes('deck')
        ? plugin
        : null
    })
    t.check('the Analytics plugin runs on a fresh profile with its actions registered', !!active)
    await win.locator('[data-plugin-action="home"]').waitFor({ timeout: 10_000 })
    t.check('the workspace action is a button in the toolbar', true)

    // The tab's menu carries the plugin's entry, and highlighting it shows the preview card
    // with the figures the plugin answered.
    await rowButton(win, record.id).click({ button: 'right' })
    await menuItems(win).first().waitFor()
    const entry = menuItem(win, 'Analytics')
    t.equal('the tab menu holds one Analytics entry', await entry.count(), 1)
    await entry.hover()
    const preview = win.locator('[data-plugin-action-preview="deck"]')
    await preview.waitFor({ timeout: 5_000 })
    const previewText = await until(async () => {
      const text = await preview.innerText().catch(() => '')
      return text.includes('Cost') && text.includes('Tool calls') ? text : null
    })
    t.check('the preview card lists the figures the plugin answered', !!previewText)

    // Clicking it opens the session page in the content column, served by the plugin.
    await entry.click()
    await win.locator(PAGE).waitFor({ timeout: 10_000 })
    const src = await win.locator(`${PAGE} webview`).getAttribute('src')
    t.check(
      'the page pane shows the plugin-served session page',
      !!src && src.startsWith('http://127.0.0.1:') && src.includes(`/session/${record.id}`)
    )
    t.check('the served page draws the session by its name', !!(await deckTitle(win, record.title)))
    const dataKind = await until(() =>
      inGuest(win, `JSON.parse(document.getElementById('slideless-data').textContent).kind`)
    )
    t.equal('the page carries its data block, a session view', dataKind, 'session')

    // The page follows the app's theme live: the app applies a theme as inline tokens on its
    // root and the page pane inserts them into the guest, so activating coffee (a theme no
    // machine starts on) changes the page's own surface token to the app's coffee value.
    const surface = `getComputedStyle(document.documentElement).getPropertyValue('--surface-0').trim()`
    const before = await until(() => inGuest(win, surface))
    const previousSkin = await win.evaluate(
      async () => (await window.electronAPI.skinsList()).activeId
    )
    const coffeeSurface = await win.evaluate(async () => {
      const state = await window.electronAPI.skinsActivate('coffee')
      return state.skins.find((skin) => skin.id === 'coffee').tokens['--surface-0'].trim()
    })
    const followed = await until(async () => {
      const now = await inGuest(win, surface)
      return now === coffeeSurface && now !== before ? now : null
    })
    t.check(
      'the page follows the app theme live through the inserted tokens',
      !!followed,
      JSON.stringify({ before, coffeeSurface, guestNow: await inGuest(win, surface) })
    )
    if (previousSkin) await win.evaluate((id) => window.electronAPI.skinsActivate(id), previousSkin)

    // The way back.
    await win.locator(`${PAGE} [aria-label="Back to sessions"]`).click()
    await win.locator(PAGE).waitFor({ state: 'detached', timeout: 5_000 })
    t.check('back closes the page pane', true)

    // A group's menu carries the entry too, and its page lists the group's session.
    const { groupId } = await callMcp(app, 'createGroup', { name: 'Analytics group' })
    await callMcp(app, 'moveSession', { sessionId: record.id, groupId })
    const groupRow = win.locator(`[data-sidebar-item-id="${groupId}"]`)
    await groupRow.waitFor({ timeout: 10_000 })
    await groupRow.locator('button').first().click({ button: 'right' })
    await menuItems(win).first().waitFor()
    t.equal('the group menu holds one Analytics entry', await menuItem(win, 'Analytics').count(), 1)
    await menuItem(win, 'Analytics').click()
    await win.locator(PAGE).waitFor({ timeout: 10_000 })
    const groupSrc = await win.locator(`${PAGE} webview`).getAttribute('src')
    t.check(
      'the group page is served for that group',
      !!groupSrc && groupSrc.includes(`/group/${groupId}`)
    )
    t.check(
      'the group page is titled with the group name',
      !!(await deckTitle(win, 'Analytics group'))
    )
    t.check(
      'the group table lists the session',
      !!(await guestList(win, 'tbody .name-text', record.title))
    )

    // The toolbar button opens the workspace page.
    await win.locator('[data-plugin-action="home"]').click()
    await until(async () => {
      const s = await win
        .locator(`${PAGE} webview`)
        .getAttribute('src')
        .catch(() => null)
      return s && s.includes('/workspace') ? s : null
    })
    t.check('the workspace page is served', !!(await deckTitle(win, 'Workspace')))
    t.check(
      'the workspace page has a card for the group',
      !!(await guestList(win, '.card-name', 'Analytics group'))
    )

    // Switched off, the plugin leaves no entry and no page behind.
    await win.evaluate((id) => window.electronAPI.pluginsDisable(id), PLUGIN)
    await win.locator(PAGE).waitFor({ state: 'detached', timeout: 10_000 })
    t.check('disabling the plugin closes its page', true)
    await win.locator('[data-plugin-action="home"]').waitFor({ state: 'detached', timeout: 10_000 })
    t.check('and removes its toolbar button', true)
    await rowButton(win, record.id).click({ button: 'right' })
    await menuItems(win).first().waitFor()
    t.equal('and its entry is gone from the tab menu', await menuItem(win, 'Analytics').count(), 0)
    await closeMenu(win)
  } finally {
    await chat.close()
  }
}

assert.ok(run)
