// Several views per plugin, chosen per session from the pane header.
//
// The spec asserts and exits non-zero through the runner: every check below
// fails the run. What it proves, in order: the picker lists every view the
// plugin contributes for this transport; choosing one changes what the pane
// renders and writes the choice onto the session record in main; the transcript
// survives the switch in BOTH directions; the second view can write to the
// session; and the choice outlives a renderer reload.
import assert from 'node:assert/strict'
import { until } from './harness.mjs'
import { openChat, inject } from './chat-view.spec.mjs'

const CHAT = 'clave.chat-view/chat'
const COMPACT = 'clave.chat-view/compact'

/** Walk the menu to a label with the arrows, one press per poll so the
 *  highlight has settled before the next read — pressing faster than the menu
 *  updates overshoots and lands on a neighbour. */
async function choose(win, picker, label) {
  const items = win.getByRole('menuitem')
  await picker.click()
  await items.first().waitFor()
  const highlighted = win.locator('[role="menuitem"][data-highlighted]')
  const landed = await until(
    async () => {
      const current = await highlighted.innerText().catch(() => '')
      if (current.trim() === label) return true
      await win.keyboard.press('ArrowDown')
      return false
    },
    { tries: 12, gapMs: 120 }
  )
  assert.ok(landed, `never highlighted ${label}`)
  await win.keyboard.press('Enter')
  await items.first().waitFor({ state: 'detached' })
}
const viewIdOf = (win, id) =>
  win.evaluate(
    async (sessionId) =>
      (await window.electronAPI.sessionsList()).find((s) => s.id === sessionId)?.viewId ?? null,
    id
  )

export async function run(t) {
  const fixture = await openChat('plugin-views')
  const { app, win, record } = fixture
  try {
    const picker = win.getByLabel('Change view', { exact: true })
    await picker.waitFor()
    await picker.click()
    const items = win.getByRole('menuitem')
    assert.deepEqual(await items.allInnerTexts(), ['Chat', 'Compact'])
    t.check('the pane picker lists both views the plugin contributes', true)

    await win.keyboard.press('Escape')
    await items.first().waitFor({ state: 'detached' })
    assert.equal(await viewIdOf(win, record.id), null)
    assert.equal(
      await win.locator('[data-view-id]:not([hidden])').getAttribute('data-view-id'),
      CHAT
    )
    t.check('a session naming no view opens on the first that renders it', true)

    await inject(app, record.id, [
      { type: 'user_message', text: 'the first turn' },
      { type: 'assistant_text', delta: 'the answer to it', final: true }
    ])
    await win.locator('.chat-turn[data-role="assistant"]').waitFor()

    await choose(win, picker, 'Compact')
    await win.locator('[data-view="compact"]').waitFor()
    assert.ok(await until(async () => (await viewIdOf(win, record.id)) === COMPACT))
    t.check('choosing a view writes it onto the session record in main', true)

    const rows = win.locator('[data-view="compact"] li')
    await until(async () => (await rows.count()) >= 2)
    const texts = await rows.allInnerTexts()
    assert.match(texts.join('\n'), /the first turn/)
    assert.match(texts.join('\n'), /the answer to it/)
    t.check('the second view renders the turns that arrived before it was opened', true)

    // The chat view is still mounted, hidden: that is what makes the switch back
    // lose nothing, and it is the thing a mutation would silently break.
    const chatSlot = win.locator(`[data-view-id="${CHAT}"]`)
    assert.equal(await chatSlot.count(), 1)
    assert.ok(await chatSlot.isHidden())
    assert.equal(
      await win.locator(`[data-view-id="${CHAT}"] .chat-turn[data-role="user"]`).count(),
      1
    )
    t.check('the view left behind stays mounted with its transcript', true)

    const compactInput = win.locator('[data-view="compact"] input[aria-label="Message"]')
    await compactInput.fill('written from compact')
    await compactInput.press('Enter')
    assert.ok(
      await until(async () =>
        (await rows.allInnerTexts()).join('\n').includes('written from compact')
      )
    )
    t.check('the second view writes to the session through the host bridge', true)

    await choose(win, picker, 'Chat')
    await until(async () => (await viewIdOf(win, record.id)) === CHAT)
    assert.equal(
      await win.locator('[data-view-id]:not([hidden])').getAttribute('data-view-id'),
      CHAT
    )
    assert.equal(
      await win.locator('.chat-turn[data-role="user"]').first().innerText(),
      'the first turn'
    )
    assert.ok(
      (await win.locator(`[data-view-id="${CHAT}"]`).innerText()).includes('written from compact')
    )
    t.check('switching back finds the first view as it was left, nothing lost', true)

    await choose(win, picker, 'Compact')
    await until(async () => (await viewIdOf(win, record.id)) === COMPACT)

    // A second session beside it opens on the default view: the choice belongs
    // to one session's record, never to the plugin or the window.
    await win.locator('.launcher-split .launcher-btn').click()
    const second = await until(async () =>
      (await win.evaluate(() => window.electronAPI.sessionsList())).find(
        (s) => s.adapterId === 'echo' && s.id !== record.id
      )
    )
    assert.ok(second)
    assert.equal(second.viewId ?? null, null)
    await until(async () => (await win.locator(`[data-view-id="${CHAT}"]`).count()) === 2)
    assert.equal(await viewIdOf(win, record.id), COMPACT)
    t.check('the chosen view belongs to the session, not to the plugin or the window', true)

    // The choice lives on the record in main rather than in the pane that set
    // it. A renderer reload is where that is decidable today: an events session
    // is not rebuilt in the renderer after one on this base (no sidecar record,
    // the session map is in memory), so the pane does not come back — the
    // record does, carrying the view, which is what a restored session would
    // mount on once events sessions gain a restore path.
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    assert.equal(await viewIdOf(win, record.id), COMPACT)
    assert.equal(await viewIdOf(win, second.id), null)
    t.check('the choice outlives the pane that made it, on the record in main', true)
  } finally {
    await fixture.close()
  }
}
