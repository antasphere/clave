import { until } from './harness.mjs'
import { inject, openChat } from './chat-view.spec.mjs'

/* The last turn and the composer. A turn's hover line (its time and copy
   button) sits out of the flow under the message, in the column's gap; the
   last turn has no gap under it, so the column's foot must hold that line, and
   still leave air before the composer. Measured at the transcript's end with
   the line shown: it must be neither clipped by the scroller nor touching the
   composer's box. */

export async function run(t) {
  const { win, record, fixture, close } = await openChat('chat-turn-foot')
  try {
    const view = win.locator('[data-testid="chat-view"]')
    await inject(fixture, record.id, [
      {
        type: 'assistant_text',
        delta: Array.from({ length: 60 }, (_, i) => `Ligne ${i} du message.`).join('\n\n'),
        final: true
      }
    ])
    const turn = view.locator('.chat-turn-wrap[data-side="start"]').last()
    await turn.waitFor()
    // Hover the turn's last line once it is in view at the end, so the hover
    // itself has nothing to scroll.
    const scroller = view.locator('.chat-scroll')
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight))
    await until(() =>
      scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 1)
    )
    await turn.locator('.chat-turn p').last().hover()

    let last = null
    const geometry = await until(async () => {
      const g = (last = await win.evaluate(() => {
        const view = document.querySelector('[data-testid="chat-view"]')
        const turns = view.querySelectorAll('.chat-turn-wrap[data-side="start"]')
        const last = turns[turns.length - 1]
        const meta = last.querySelector('.chat-turn-meta').getBoundingClientRect()
        const text = last.querySelector('.chat-turn').getBoundingClientRect()
        const scroller = view.querySelector('.chat-scroll')
        return {
          atEnd: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 1,
          shown: getComputedStyle(last.querySelector('.chat-turn-meta')).opacity === '1',
          metaBottom: meta.bottom,
          scrollerBottom: scroller.getBoundingClientRect().bottom,
          composerTop: view.querySelector('.chat-composer').getBoundingClientRect().top,
          textBottom: text.bottom
        }
      }))
      return g.atEnd && g.shown ? g : null
    })
    t.check('the transcript sits at its end with the last turn hovered', !!geometry, last)
    if (!geometry) return
    t.check(
      "the last turn's hover line is inside the scroller, not clipped at its foot",
      geometry.metaBottom <= geometry.scrollerBottom,
      geometry
    )
    t.check(
      "the hover line keeps at least 16px of air from the composer's box",
      geometry.composerTop - geometry.metaBottom >= 16,
      geometry
    )
  } finally {
    await close()
  }
}
