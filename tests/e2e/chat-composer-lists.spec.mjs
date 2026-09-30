import assert from 'node:assert/strict'
import { openChat } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* The composer carries a list on across Shift+Enter: the reader types the
   items, the markers come by themselves, and an empty item ends the list.
   Enter alone still sends. */

export async function run(t) {
  const fixture = await openChat('chat-composer-lists')
  const { win } = fixture
  const textarea = win.locator('[data-testid="chat-view"] textarea')
  const value = () => textarea.inputValue()
  const caret = () => textarea.evaluate((el) => el.selectionStart)
  try {
    await textarea.click()
    await win.keyboard.type('- first')
    await win.keyboard.press('Shift+Enter')
    assert.ok(await until(async () => (await value()) === '- first\n- '), await value())
    assert.equal(await caret(), 10, 'the caret sits after the new marker')
    await win.keyboard.type('second')
    await win.keyboard.press('Shift+Enter')
    await win.keyboard.press('Shift+Enter')
    assert.ok(await until(async () => (await value()) === '- first\n- second\n'), await value())
    t.check('a bullet carries on with Shift+Enter and an empty item ends the list', true)

    await win.keyboard.type('1. one')
    await win.keyboard.press('Shift+Enter')
    await win.keyboard.type('two')
    await win.keyboard.press('Shift+Enter')
    assert.ok(
      await until(async () => (await value()) === '- first\n- second\n1. one\n2. two\n3. '),
      await value()
    )
    t.check('a numbered list counts up', true)

    // A plain line is the textarea's own new line, untouched.
    await win.keyboard.press('Shift+Enter')
    await win.keyboard.type('plain')
    await win.keyboard.press('Shift+Enter')
    assert.ok(
      await until(async () => (await value()) === '- first\n- second\n1. one\n2. two\nplain\n'),
      await value()
    )
    t.check('a plain line is left to the textarea', true)
  } finally {
    await fixture.close()
  }
}
