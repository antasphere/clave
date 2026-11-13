import { until } from './harness.mjs'
import { inject, openChat } from './chat-view.spec.mjs'

/* A turn's hover line (its time and copy button) sits under the message, out
   of the flow. The reader reaches it by moving the pointer down from the
   message onto the button, so the line must stay shown, and the button must
   be what is under the pointer, the whole way there; then a click copies.
   Checked on a user turn and on an assistant turn with a turn below it. */

export async function run(t) {
  const { win, record, fixture, close } = await openChat('chat-turn-copy')
  try {
    const view = win.locator('[data-testid="chat-view"]')
    const composer = view.locator('textarea')
    await composer.fill('Une question courte.')
    await composer.press('Enter')
    await view.locator('.chat-turn-wrap[data-side="end"]').first().waitFor()
    await inject(fixture, record.id, [
      { type: 'assistant_text', delta: 'Première réponse.', final: true }
    ])
    await inject(fixture, record.id, [
      { type: 'assistant_text', delta: 'Seconde réponse.', final: true }
    ])
    await until(async () =>
      (await view.locator('.chat-turn-wrap[data-side="start"]').count()) >= 2 ? true : null
    )

    const cases = [
      ['the user turn', view.locator('.chat-turn-wrap[data-side="end"]').first()],
      ['the first assistant turn', view.locator('.chat-turn-wrap[data-side="start"]').first()]
    ]
    for (const [name, wrap] of cases) {
      await wrap.locator('.chat-turn').hover()
      const copy = wrap.locator('.chat-turn-copy')
      const box = await copy.boundingBox()
      const turnBox = await wrap.locator('.chat-turn').boundingBox()
      // Walk the pointer from inside the message straight down to the button,
      // sampling every pixel row so a gap or a cover on the way is seen.
      const x = box.x + box.width / 2
      const startY = turnBox.y + turnBox.height - 2
      const endY = box.y + box.height / 2
      await win.mouse.move(x, startY)
      let lost = null
      for (let y = startY; y <= endY; y += 1) {
        await win.mouse.move(x, y)
        // The stylesheet shows the line while the turn is hovered or the line
        // holds focus; read that condition itself, not a mid-fade opacity.
        const shown = await wrap.evaluate(
          (el) =>
            el.matches(':hover') || el.querySelector('.chat-turn-meta').matches(':focus-within')
        )
        if (!shown && lost === null) lost = Math.round(y - startY)
      }
      await win.waitForTimeout(400)
      const top = await win.evaluate(
        ({ x, y }) => {
          const el = document.elementFromPoint(x, y)
          return el?.closest('.chat-turn-copy') ? 'copy' : (el?.className?.toString() ?? String(el))
        },
        { x, y: endY }
      )
      const opacity = await wrap
        .locator('.chat-turn-meta')
        .evaluate((el) => getComputedStyle(el).opacity)
      t.check(
        `${name}: the hover line stays on the whole way down to the copy button`,
        lost === null,
        { lostAtPx: lost }
      )
      t.check(`${name}: the copy button is what is under the pointer`, top === 'copy', { top })
      t.check(`${name}: the hover line is shown with the pointer on the button`, opacity === '1', {
        opacity
      })
      await win.mouse.down()
      await win.mouse.up()
      const copied = await until(async () =>
        (await copy.getAttribute('data-copied')) === 'true' ? true : null
      )
      t.check(`${name}: a click on the button copies`, !!copied)
      await win.mouse.move(5, 5)
    }
  } finally {
    await close()
  }
}
