// The actions a plugin contributes, through the first plugin that contributes them: the
// bundled Analytics plugin (on by default). Every assertion is about what the person can
// click in the real app: the entry in a tab's menu with its preview card, the entry in a
// group's menu, the workspace button in the toolbar, the page each one opens in the content
// column, and the way back; then the plugin switched off and every entry gone. The failure
// mode of all of this is silence (an unread manifest field draws nothing and reports
// nothing), so the checks are on the DOM and on the page the plugin actually served. The
// second slice's drawings and settings page are checked here too: the session page's
// timeline, the group page's swimlane, the workspace home's animation with the tab's dot in
// its group's lane on the brand field, and the settings page reached from the footer's gear,
// where the activity gap is changed and seen on the page's footer right after.
import assert from 'node:assert/strict'
import { callMcp, until } from './harness.mjs'
import { openChat } from './chat-view.spec.mjs'

export const PLUGIN = 'clave.analytics'
export const PAGE = `[data-plugin-page="${PLUGIN}"]`
/** Runs a script inside the page pane's web view guest, from the host (the guest is a
 *  separate web contents, not a frame of the window); null until the guest can answer. */
export const inGuest = (win, script) =>
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
export const menuItems = (win) => win.locator('[role="menu"] [role="menuitem"]')
export const menuItem = (win, label) => menuItems(win).filter({ hasText: label })
export const rowButton = (win, id) => win.locator(`[data-sidebar-item-id="${id}"] button`).first()
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
    // The plugin's entry is the menu's last section: a hairline right above it, Delete right
    // below, and the app's own window entries (which arrive a beat later) before the hairline.
    const windowEntry = await until(async () =>
      (await menuItem(win, 'Move to new window').count()) === 1 ? true : null
    )
    t.check('the window entries arrived in the tab menu', !!windowEntry)
    const rows = await win
      .locator('[role="menu"] > *')
      .evaluateAll((nodes) =>
        nodes.map((n) => (n.getAttribute('role') === 'separator' ? 'sep' : n.textContent.trim()))
      )
    const at = rows.findIndex((r) => r === 'Analytics')
    t.check(
      'a hairline sits right above the plugin entry, Delete right below, the window entries before',
      at > 0 &&
        rows[at - 1] === 'sep' &&
        rows[at + 1] === 'Delete' &&
        rows.indexOf('Move to new window') < at,
      JSON.stringify(rows)
    )
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
    // The timeline is there, and says so for a tab that has not worked yet.
    const timeline = await until(() =>
      inGuest(win, `document.querySelector('figure.timeline .figure-empty')?.textContent ?? null`)
    )
    t.equal(
      'the session page carries its timeline, empty for a tab that has not worked',
      timeline,
      'No activity measured yet.'
    )

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

    // The toolbar's home button lights for its own page only, not for a tab's page.
    const homeLit = () =>
      win
        .locator('[data-plugin-action="home"]')
        .evaluate((el) => el.className.includes('text-accent'))
    t.check('the home button is unlit while a tab page shows', !(await homeLit()))

    // The page is bare: no bar over it, so no back arrow, no title tab, no close cross.
    t.equal(
      'the page carries no bar of controls over it',
      await win.locator(`${PAGE} button, ${PAGE} .panel-tab`).count(),
      0
    )
    // The way back is the sidebar: picking the tab the page stood in for, even the one
    // still selected, puts the session back.
    await rowButton(win, record.id).click()
    await win.locator(PAGE).waitFor({ state: 'detached', timeout: 5_000 })
    t.check('picking a tab in the sidebar closes the page', true)

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
    const swimlane = await until(() =>
      inGuest(win, `document.querySelector('figure.swimlane .figure-empty')?.textContent ?? null`)
    )
    t.equal(
      'the group page carries its swimlane, empty in this range',
      swimlane,
      'No activity measured in this range yet.'
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
    t.check('the home button is lit while its own page shows', await homeLit())
    t.check(
      'the workspace page has a card for the group',
      !!(await guestList(win, '.card-name', 'Analytics group'))
    )
    // The animation: the tab is a dot in its group's lane, at the column of its state, on
    // the brand field's canvas.
    const dot = await until(() =>
      inGuest(
        win,
        `(() => {
          const d = document.querySelector('.live-dot[data-session=${JSON.stringify(record.id)}]')
          if (!d) return null
          const label = document.querySelectorAll('.live-lane-label')[Number(d.dataset.lane)]
          const canvas = document.querySelector('canvas.live-ground')
          return {
            state: d.dataset.state,
            column: d.dataset.column,
            lane: label ? label.textContent : null,
            canvas: !!canvas && canvas.width > 0 && canvas.height > 0,
            hollow: d.classList.contains('kind-terminal')
          }
        })()`
      )
    )
    t.check(
      "the workspace animation places the tab as a dot in its group's lane on the brand field",
      !!dot &&
        dot.lane === 'Analytics group' &&
        dot.canvas &&
        ['working', 'idle', 'blocked'].includes(dot.column) &&
        dot.hollow === false,
      JSON.stringify(dot)
    )

    // The footer's gear opens the settings page in the same pane; the gap saved there is on
    // the page's footer the moment the live stream brings the next frame.
    await inGuest(win, `document.querySelector('.gear').click(); true`)
    const settingsTitle = await until(() =>
      inGuest(
        win,
        `document.querySelector('.deck-title')?.textContent === 'Analytics settings' || null`
      )
    )
    t.check('the footer gear opens the settings page', !!settingsTitle)
    await inGuest(
      win,
      `(() => {
        const gap = document.getElementById('gap')
        gap.value = '20'
        gap.dispatchEvent(new Event('input', { bubbles: true }))
        document.querySelector('[data-action="save-gap"]').click()
        return true
      })()`
    )
    const saved = await until(() =>
      inGuest(
        win,
        `(document.querySelector('.settings-status')?.textContent === 'Saved' && document.getElementById('gap')?.value === '20') || null`
      )
    )
    t.check('the activity gap saves from the settings page', !!saved)
    await inGuest(win, `document.querySelector('.settings-back').click(); true`)
    const footer = await until(async () => {
      const text = await inGuest(
        win,
        `document.querySelector('.deck-foot .foot-text')?.textContent ?? ''`
      )
      return typeof text === 'string' && text.includes('less than 20 minutes apart') ? text : null
    })
    t.check('back on the page, the footer counts with the new gap', !!footer, String(footer))

    // The home button is a toggle: pressed again on its own page, it puts the sessions back.
    await win.locator('[data-plugin-action="home"]').click()
    await win.locator(PAGE).waitFor({ state: 'detached', timeout: 5_000 })
    t.check('the home button pressed again closes its own page', !(await homeLit()))
    await win.locator('[data-plugin-action="home"]').click()
    await win.locator(PAGE).waitFor({ timeout: 10_000 })

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
