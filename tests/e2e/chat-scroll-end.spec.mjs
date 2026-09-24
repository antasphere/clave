// The way back down in the chat view: the transcript follows the stream while
// the reader is at its end, leaves a reader who scrolled up where they are,
// and offers a control over its foot for as long as the end is out of view.
import assert from 'node:assert/strict'
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

const paragraph = (n) =>
  `Paragraph ${n}. ` +
  'The transcript has to overflow its pane for this check to mean anything at all. '.repeat(6)
// Alternating roles so every event is its own turn: consecutive assistant
// text would fold into one entry.
const turn = (n) =>
  n % 2 === 0
    ? { type: 'user_message', text: paragraph(n) }
    : { type: 'assistant_text', delta: paragraph(n), final: true }

export async function run(t) {
  const fixture = await openChat('chat-scroll-end')
  const { app, win, record } = fixture
  try {
    // Scoped to the conversation view: the compact view is mounted on the
    // same session behind it and scrolls on its own.
    const view = win.locator('[data-testid="chat-view"]')
    const scroller = view.locator('.chat-scroll')
    const turns = view.locator('.chat-turn')
    const button = view.getByRole('button', { name: 'Scroll to end', exact: true })
    const geometry = () =>
      scroller.evaluate((el) => ({
        top: el.scrollTop,
        height: el.scrollHeight,
        client: el.clientHeight
      }))
    const atEnd = async () => {
      const g = await geometry()
      return g.height - g.top - g.client < 2
    }

    const count = 40
    await inject(
      app,
      record.id,
      Array.from({ length: count }, (_, i) => turn(i))
    )
    await turns.nth(count - 1).waitFor()
    const filled = await until(async () => {
      const g = await geometry()
      return g.height > g.client * 2 ? g : null
    })
    assert.ok(filled, `the transcript overflows its pane: ${JSON.stringify(await geometry())}`)
    t.check(
      'a stream the reader follows stays pinned to its end',
      await until(atEnd),
      await geometry()
    )
    assert.equal(await button.count(), 0, 'no control while the end is in view')

    await scroller.evaluate((el) => {
      el.scrollTop = 0
    })
    await button.waitFor()
    t.check('scrolling up shows the way back down', true)

    await inject(app, record.id, [turn(count)])
    await turns.nth(count).waitFor()
    assert.equal((await geometry()).top, 0, 'new text does not move a reader who scrolled up')
    assert.equal(await button.count(), 1, 'the control stays while the end is out of view')
    t.check('new text leaves a reader who scrolled up where they are', true)

    await button.click()
    t.check('the control takes the transcript to its end', await until(atEnd), await geometry())
    assert.ok(
      await until(async () => (await button.count()) === 0),
      'the control leaves once the end is in view'
    )

    await inject(app, record.id, [turn(count + 1)])
    await turns.nth(count + 1).waitFor()
    t.check(
      'after the jump the transcript follows the stream again',
      await until(atEnd),
      await geometry()
    )
    assert.equal(await button.count(), 0)
  } finally {
    await fixture.close()
  }
}
