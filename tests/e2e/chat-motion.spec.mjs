// The conversation view's motion, in the running app: the send button is one
// element that turns into stop and back (never two swapped, or the colour and
// glyph could not cross over), what the column gains arrives on a transition
// that never touches layout, and the slash menu grows from the slash that
// opened it. The stylesheet's own rules are held by chat-motion.test.ts; this
// is the part only a real window can tell.
import assert from 'node:assert/strict'
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

export async function run(t) {
  const fixture = await openChat('chat-motion')
  const { app, win, record } = fixture
  try {
    const view = win.locator('[data-testid="chat-view"]')
    const input = view.getByRole('textbox', { name: 'Message', exact: true })
    const send = view.getByRole('button', { name: 'Send message', exact: true })
    await send.evaluate((el) => {
      el.dataset.probe = 'same-element'
    })
    await inject(app, record.id, [{ type: 'state_change', state: 'working' }])
    const stop = view.getByRole('button', { name: 'Interrupt', exact: true })
    await stop.waitFor()
    t.check(
      'send turns into stop in place: the same element, its kind changed',
      (await stop.getAttribute('data-probe')) === 'same-element' &&
        (await stop.getAttribute('data-kind')) === 'stop',
      await stop.evaluate((el) => el.outerHTML.slice(0, 200))
    )
    // The glyphs cross over on a transition: read them once it has settled.
    const glyphs = () =>
      stop.evaluate((el) => {
        const glyph = (kind) => getComputedStyle(el.querySelector(`[data-glyph="${kind}"]`))
        return { stop: glyph('stop').opacity, send: glyph('send').opacity }
      })
    t.check(
      'both glyphs are in the button, the stop one shown and the arrow hidden',
      await until(async () => {
        const g = await glyphs()
        return g.stop === '1' && g.send === '0'
      }),
      await glyphs()
    )
    await inject(app, record.id, [{ type: 'state_change', state: 'ready' }])
    await send.waitFor()
    t.check(
      'and back: the same element again, send once more',
      (await send.getAttribute('data-probe')) === 'same-element' &&
        (await send.getAttribute('data-kind')) === 'send' &&
        (await send.getAttribute('type')) === 'submit'
    )
    await inject(app, record.id, [{ type: 'user_message', text: 'Arrived.' }])
    const turn = view.locator('.chat-turn-wrap').last()
    await turn.waitFor()
    const arrival = await turn.evaluate((el) => {
      const style = getComputedStyle(el)
      return { properties: style.transitionProperty, duration: style.transitionDuration }
    })
    t.check(
      'a turn arrives on an opacity and translate transition, nothing that lays out',
      /opacity/.test(arrival.properties) &&
        /translate/.test(arrival.properties) &&
        !/height|margin|padding/.test(arrival.properties) &&
        arrival.duration !== '0s',
      arrival
    )
    await input.fill('/')
    const menu = view.locator('.chat-slash-menu')
    await menu.waitFor()
    // offsetHeight, not the client rect: the menu is still scaling in, and
    // the rect reads the transformed box while the origin is set on the laid-out one.
    const origin = await menu.evaluate((el) => ({
      origin: getComputedStyle(el).transformOrigin,
      height: el.offsetHeight
    }))
    const [x, y] = origin.origin.split(' ').map(parseFloat)
    t.check(
      'the slash menu grows from its bottom-left corner, where the slash was typed',
      x === 0 && Math.abs(y - origin.height) < 1,
      origin
    )
    await input.fill('')
    assert.ok(await until(async () => (await menu.count()) === 0))
  } finally {
    await fixture.close()
  }
}
