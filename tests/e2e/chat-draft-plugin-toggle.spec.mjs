// PRDCT-2620: what the reader has typed into a chat composer survives a plugin
// being switched off, linked, or restarted, and the next Enter sends it.
//
// Three things are proven, each of which fails on its own mutation:
//  - another plugin switched off leaves the draft where it is;
//  - a plugin LINKED restarts every plugin, the chat plugin included, and the
//    composer is the same element with the same text (`resolution.ts` keeps a
//    native view through `starting`; revert that and the element is replaced);
//  - the chat plugin itself switched off and on again brings the composer back
//    with its text (`draft-store.ts` holds it; keep it in the view's own state
//    and the text is gone).
// Then the kept draft is sent and read back as the user's turn. Two more
// checks close the draft store's own seams: the compact view reads the same
// draft (keep it in CompactView's own state and it is gone after a toggle),
// and the draft is keyed by session (key it globally and a second tab opens
// with the first tab's text).
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { openChat } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

const CHAT = 'clave.chat-view'
const OTHER = 'clave.github'

export async function run(t) {
  const chat = await openChat('chat-draft-plugin-toggle')
  const { win, record } = chat
  try {
    const composer = win.locator('[data-testid="chat-view"] textarea:not(:disabled)')
    const tag = () =>
      win.evaluate(() => {
        document.querySelector('[data-testid="chat-view"] textarea').dataset.probe = 'kept'
      })
    const composerState = () =>
      win.evaluate(() => {
        const el = document.querySelector('[data-testid="chat-view"] textarea')
        return { value: el?.value ?? null, same: el?.dataset.probe === 'kept' }
      })
    const status = async (id) =>
      (await win.evaluate(() => window.electronAPI.pluginsList())).find((p) => p.id === id)?.status

    // ── Another plugin switched off while typing ─────────────────────────────
    await composer.click()
    await win.keyboard.type('first draft')
    await tag()
    t.check(
      'the other plugin starts active',
      (await status(OTHER)) === 'active',
      await status(OTHER)
    )
    await win.evaluate((id) => window.electronAPI.pluginsDisable(id), OTHER)
    await until(async () => (await status(OTHER)) === 'disabled')
    await win.waitForTimeout(300)
    let state = await composerState()
    t.check(
      'another plugin switched off: the composer keeps its text',
      state.same && state.value === 'first draft',
      state
    )

    // ── A plugin linked: every plugin restarts, the chat plugin included ─────
    const linked = path.join(record.cwd, 'noop-plugin')
    mkdirSync(linked, { recursive: true })
    writeFileSync(
      path.join(linked, 'clave-plugin.json'),
      JSON.stringify({
        id: 'test.noop',
        name: 'Noop',
        version: '1.0.0',
        kind: 'plugin',
        engines: { clave: '*' },
        ui: 'none',
        main: 'main.mjs',
        permissions: [],
        contributes: {}
      })
    )
    writeFileSync(path.join(linked, 'main.mjs'), 'export default { activate() {} }\n')
    await win.keyboard.type(' and more')
    await win.evaluate((folder) => window.electronAPI.pluginsLink(folder), linked)
    // The link reloads every plugin; wait for the chat plugin to be back.
    await until(async () => (await status('test.noop')) !== undefined)
    await until(async () => (await status(CHAT)) === 'active')
    await win.waitForTimeout(300)
    state = await composerState()
    t.check(
      'a plugin linked restarts every plugin, and the composer is the same element with its text',
      state.same && state.value === 'first draft and more',
      state
    )

    // ── The chat plugin itself switched off, then on again ───────────────────
    await win.evaluate((id) => window.electronAPI.pluginsDisable(id), CHAT)
    await until(async () => (await win.locator('[data-testid="chat-view"]').count()) === 0)
    t.check('the chat plugin switched off takes the pane to the terminal', true)
    await win.evaluate(
      (id) => window.electronAPI.pluginsEnable(id, ['sessions.read', 'sessions.write']),
      CHAT
    )
    await composer.waitFor()
    state = await composerState()
    t.check(
      'switched back on, a fresh composer comes back with the draft',
      !state.same && state.value === 'first draft and more',
      state
    )

    // ── The next Enter sends what was kept ───────────────────────────────────
    await composer.press('Enter')
    const turn = win
      .locator('.chat-turn[data-role="user"]')
      .filter({ hasText: 'first draft and more' })
    await turn.first().waitFor()
    t.check("the next Enter sends the kept draft as the user's turn", (await turn.count()) >= 1)
    state = await composerState()
    t.check('and the composer is empty after the send', state.value === '', state)

    // ── The compact view keeps its draft the same way ────────────────────────
    const switchTo = async (title) => {
      await win.getByLabel('Change view', { exact: true }).click()
      const item = win.locator('.menu-item', { hasText: title })
      await item.waitFor()
      await win.waitForTimeout(500)
      await item.click({ force: true })
      await win.waitForTimeout(300)
    }
    await switchTo(/^Compact$/)
    const compact = win.locator('[data-view="compact"] input:not(:disabled)')
    await compact.waitFor()
    await compact.click()
    await win.keyboard.type('compact draft')
    await win.evaluate((id) => window.electronAPI.pluginsDisable(id), CHAT)
    await until(async () => (await win.locator('[data-view="compact"]').count()) === 0)
    await win.evaluate(
      (id) => window.electronAPI.pluginsEnable(id, ['sessions.read', 'sessions.write']),
      CHAT
    )
    await compact.waitFor()
    const compactValue = await compact.inputValue()
    t.check(
      'the compact view, its plugin switched off and on, comes back with the draft',
      compactValue === 'compact draft',
      compactValue
    )

    // ── Each tab keeps its own draft ─────────────────────────────────────────
    await switchTo(/^Chat$/)
    const first = win.locator(
      `section.chat-host[data-session-id="${record.id}"] [data-testid="chat-view"] textarea`
    )
    await first.waitFor()
    await win.locator('.launcher-split .launcher-btn').click()
    const second = await until(async () => {
      const list = await win.evaluate(() => window.electronAPI.sessionsList())
      return list.find((s) => s.adapterId === 'echo' && s.id !== record.id) ?? null
    })
    const secondField = win.locator(
      `section.chat-host[data-session-id="${second?.id}"] textarea:not(:disabled)`
    )
    await secondField.waitFor()
    const drafts = { first: await first.inputValue(), second: await secondField.inputValue() }
    t.check(
      "a second chat tab opens with an empty composer, the first tab's draft still its own",
      drafts.first === 'compact draft' && drafts.second === '',
      drafts
    )
  } finally {
    await chat.close()
  }
}
