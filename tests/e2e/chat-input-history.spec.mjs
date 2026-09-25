import assert from 'node:assert/strict'
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

async function reloadChat(win, input) {
  await win.evaluate(() => window.electronAPI.pluginsDisable('clave.chat-view'))
  await input.waitFor({ state: 'detached' })
  await win.evaluate(() =>
    window.electronAPI.pluginsEnable('clave.chat-view', ['sessions.read', 'sessions.write'])
  )
  await input.waitFor()
  assert.ok(await until(async () => await input.isEnabled()))
}

export async function run(t) {
  const fixture = await openChat('chat-input-history')
  const { app, win, record } = fixture
  try {
    const input = win.locator('[data-testid="chat-view"] textarea')
    await input.press('ArrowUp')
    assert.equal(await input.inputValue(), '')
    await inject(app, record.id, [
      { type: 'user_message', text: 'First message\nwith another line' },
      { type: 'assistant_text', delta: 'Do not recall this reply', final: true },
      { type: 'user_message', text: 'Latest message' },
      { type: 'user_message', text: '' }
    ])
    await win.locator('[data-testid="chat-view"] .chat-turn[data-role="user"]').nth(1).waitFor()
    await input.press('ArrowUp')
    assert.equal(await input.inputValue(), 'Latest message', 'empty input recalls latest user text')
    await input.press('ArrowUp')
    assert.equal(await input.inputValue(), 'First message\nwith another line')
    await input.press('ArrowUp')
    assert.equal(await input.inputValue(), 'First message\nwith another line', 'stop at oldest')
    await input.press('ArrowDown')
    assert.equal(await input.inputValue(), 'Latest message')
    await input.press('ArrowDown')
    assert.equal(await input.inputValue(), '', 'past latest returns to empty composer')
    t.check('Up and Down navigate only user text, preserving multiline messages and bounds', true)

    await input.fill('Unsent\ndraft')
    await input.press('ArrowUp')
    assert.equal(await input.inputValue(), 'Unsent\ndraft', 'drafts are never replaced')
    await input.fill('')
    await input.press('Shift+ArrowUp')
    assert.equal(await input.inputValue(), '', 'modified arrows do not recall')
    await input.dispatchEvent('keydown', { key: 'ArrowUp', isComposing: true })
    assert.equal(await input.inputValue(), '', 'IME arrows do not recall')
    await input.press('ArrowUp')
    await input.fill('Edited recalled message')
    await input.press('ArrowDown')
    assert.equal(await input.inputValue(), 'Edited recalled message', 'editing exits browsing')
    await input.press('Enter')
    assert.ok(await until(async () => (await input.inputValue()) === ''))
    await input.press('ArrowUp')
    assert.equal(await input.inputValue(), 'Edited recalled message', 'sent edits enter history')
    t.check('drafts, modified arrows, IME and editing are safe; recalled text can be resent', true)

    await input.fill('')
    await inject(app, record.id, [{ type: 'user_message', text: '/help' }])
    await win
      .locator('[data-testid="chat-view"] .chat-turn[data-role="user"]')
      .filter({ hasText: '/help' })
      .waitFor()
    await input.press('ArrowUp')
    assert.equal(await input.inputValue(), '/help')
    await input.press('ArrowUp')
    assert.equal(await input.inputValue(), 'Edited recalled message', 'slash recall keeps browsing')
    t.check('recalled slash commands do not trap arrows in the completion menu', true)
    await reloadChat(win, input)
    assert.equal(
      await input.inputValue(),
      'Edited recalled message',
      'recalled text survives reload'
    )
    await input.press('ArrowDown')
    assert.equal(
      await input.inputValue(),
      'Edited recalled message',
      'reload ends history browsing'
    )
    t.check('a recalled chat draft survives its plugin restarting', true)
    await win.locator('.launcher-split .launcher-btn').click()
    const fresh = win.locator('[data-testid="chat-view"] textarea:visible')
    await fresh.waitFor()
    assert.ok(await until(async () => await fresh.isEnabled()))
    await fresh.press('ArrowUp')
    assert.equal(await fresh.inputValue(), '', 'another session has its own history')
    t.check('history stays within its session', true)
  } finally {
    await fixture.close()
  }
  const compact = await openChat(
    'compact-input-history',
    ['--dev-echo-view=clave.chat-view/compact'],
    '[data-view="compact"] input:not(:disabled)'
  )
  try {
    const input = compact.win.locator('[data-view="compact"] input')
    await input.fill('Sent from compact')
    await input.press('Enter')
    assert.ok(await until(async () => (await input.inputValue()) === ''))
    await input.press('ArrowUp')
    assert.equal(await input.inputValue(), 'Sent from compact')
    await input.press('ArrowDown')
    assert.equal(await input.inputValue(), '')
    t.check('compact chat also recalls sent messages', true)
    await input.press('ArrowUp')
    await reloadChat(compact.win, input)
    assert.equal(await input.inputValue(), 'Sent from compact', 'compact recall survives reload')
    t.check('a recalled compact draft survives its plugin restarting', true)
  } finally {
    await compact.close()
  }
}
