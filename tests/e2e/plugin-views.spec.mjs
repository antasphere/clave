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
  // The launch profile names the view its sessions open in. The development
  // profile is told to name one, so the path from a profile to the session
  // record is exercised here rather than left to inspection.
  const fixture = await openChat(
    'plugin-views',
    ['--dev-echo-view=clave.chat-view/compact'],
    '[data-view="compact"] input[aria-label="Message"]:not(:disabled)'
  )
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
    // Stamped at spawn from the profile, before any pane asked for anything.
    assert.equal(await viewIdOf(win, record.id), COMPACT)
    assert.equal(
      await win.locator('[data-view-id]:not([hidden])').getAttribute('data-view-id'),
      COMPACT
    )
    t.check('a session opens in the view its launch profile names', true)

    await inject(app, record.id, [
      { type: 'user_message', text: 'the first turn' },
      { type: 'assistant_text', delta: 'the answer to it', final: true }
    ])
    const rows = win.locator('[data-view="compact"] li')
    await until(async () => (await rows.count()) >= 2)
    const texts = await rows.allInnerTexts()
    assert.match(texts.join('\n'), /the first turn/)
    assert.match(texts.join('\n'), /the answer to it/)
    t.check('the view the profile named reads the session from the host log', true)

    const compactInput = win.locator('[data-view="compact"] input[aria-label="Message"]')
    await compactInput.fill('written from compact')
    await compactInput.press('Enter')
    assert.ok(
      await until(async () =>
        (await rows.allInnerTexts()).join('\n').includes('written from compact')
      )
    )
    t.check('a view other than the first writes to the session through the host bridge', true)

    await choose(win, picker, 'Chat')
    assert.ok(await until(async () => (await viewIdOf(win, record.id)) === CHAT))
    assert.equal(
      await win.locator('[data-view-id]:not([hidden])').getAttribute('data-view-id'),
      CHAT
    )
    t.check('choosing a view writes it onto the session record in main', true)

    // The conversation view was mounted and hidden the whole time, so it has
    // everything that arrived while the reader was looking elsewhere — the
    // turns injected before it was shown, and the one sent from the other view.
    assert.equal(
      await win.locator('.chat-turn[data-role="user"]').first().innerText(),
      'the first turn'
    )
    assert.ok(
      (await win.locator(`[data-view-id="${CHAT}"]`).innerText()).includes('written from compact')
    )
    t.check('the view that was never on screen has the whole conversation', true)

    // And the one left behind keeps its own, which is what the switch back rests on.
    const compactSlot = win.locator(`[data-view-id="${COMPACT}"]`)
    assert.equal(await compactSlot.count(), 1)
    assert.ok(await compactSlot.isHidden())
    assert.ok((await compactSlot.innerText()).includes('the first turn'))
    t.check('the view left behind stays mounted with its transcript', true)

    // This session stays on the view the reader chose. A second one opens on
    // the view the PROFILE names, so the choice belongs to one session's
    // record — never to the plugin, the profile or the window.
    await win.locator('.launcher-split .launcher-btn').click()
    const second = await until(async () =>
      (await win.evaluate(() => window.electronAPI.sessionsList())).find(
        (s) => s.adapterId === 'echo' && s.id !== record.id
      )
    )
    assert.ok(second)
    assert.equal(second.viewId, COMPACT)
    assert.equal(await viewIdOf(win, record.id), CHAT)
    await until(async () => (await win.locator(`[data-view-id="${CHAT}"]`).count()) === 2)
    t.check('the chosen view belongs to the session, not to the plugin or the window', true)

    // The choice lives on the record in main rather than in the pane that set
    // it. A renderer reload is where that is decidable today: an events session
    // is not rebuilt in the renderer after one on this base (no sidecar record,
    // the session map is in memory), so the pane does not come back — the
    // record does, carrying the view, which is what a restored session would
    // mount on once events sessions gain a restore path.
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    assert.equal(await viewIdOf(win, record.id), CHAT)
    assert.equal(await viewIdOf(win, second.id), COMPACT)
    t.check('the choice outlives the pane that made it, on the record in main', true)
  } finally {
    await fixture.close()
  }
}
