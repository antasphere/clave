// The Terminal view's transcript is virtualised one exchange per row, like the
// conversation view's turns: only the exchanges near the viewport are in the
// document, the view still opens on its end, the pinned question still sticks
// and folds within its own exchange, and the first exchange is one scroll away.
import assert from 'node:assert/strict'
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

const EXCHANGES = 40
const answer = (n, times) =>
  `Answer ${n}. ` + 'An answer long enough to give the exchange some height. '.repeat(times)

export async function run(t) {
  const fixture = await openChat(
    'chat-terminal-rows',
    ['--dev-echo-view=clave.chat-view/terminal'],
    '[data-testid="terminal-view"] textarea:not(:disabled)'
  )
  const { app, win, record } = fixture
  try {
    const view = win.locator('[data-testid="terminal-view"]')
    const scroller = view.locator('.chat-scroll')
    const sections = view.locator('.term-turn')
    const questions = view.locator('.term-turn > .chat-turn-wrap[data-side="end"] .chat-turn')
    const frames = () =>
      win.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
      )
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

    // Every exchange a question and a short answer; the last one's answer is
    // taller than the pane, so its question has something to stay pinned over.
    await inject(
      app,
      record.id,
      Array.from({ length: EXCHANGES }, (_, n) => [
        { type: 'user_message', text: `question ${n}` },
        {
          type: 'assistant_text',
          delta: answer(n, n === EXCHANGES - 1 ? 120 : 3),
          final: true
        }
      ]).flat()
    )
    await view.getByText(`question ${EXCHANGES - 1}`, { exact: true }).waitFor()
    t.check('the view follows the stream to its end', await until(atEnd), await geometry())
    const mounted = await sections.count()
    t.check(
      'only the exchanges near the viewport are in the document',
      mounted > 0 && mounted < EXCHANGES / 2,
      { mounted, of: EXCHANGES }
    )

    // Inside the tall exchange, its question stays pinned, whole: plain
    // sticky, nothing clipped (terminal-questions).
    await scroller.evaluate((el) => {
      const last = [...el.querySelectorAll('.term-turn')].at(-1)
      el.scrollTop += last.getBoundingClientRect().top - el.getBoundingClientRect().top + 300
    })
    const pinned = view
      .locator('.term-turn')
      .filter({ hasText: `question ${EXCHANGES - 1}` })
      .locator('> .chat-turn-wrap[data-side="end"]')
    const pinnedWhole = await until(async () =>
      pinned.evaluate((row) => {
        const edge = row.closest('.chat-scroll').getBoundingClientRect().top
        const at = row.getBoundingClientRect().top - edge
        return Math.abs(at - 8) <= 1 && getComputedStyle(row).clipPath === 'none'
      })
    )
    const stuck = await pinned.evaluate((row) => {
      const edge = row.closest('.chat-scroll').getBoundingClientRect().top
      return {
        position: getComputedStyle(row).position,
        offset: row.getBoundingClientRect().top - edge
      }
    })
    t.check(
      'the question of the exchange being read stays pinned at the top, whole',
      pinnedWhole && stuck.position === 'sticky' && stuck.offset >= 0 && stuck.offset < 40,
      stuck
    )

    // Back to the first exchange, then read down: every exchange once, in order.
    const top = await until(
      async () => {
        await scroller.evaluate((el) => {
          el.scrollTop = 0
        })
        await frames()
        return (await questions.first().innerText()) === 'question 0'
      },
      { tries: 60 }
    )
    t.check('the first exchange is reached by scrolling up', !!top)
    const texts = []
    for (let guard = 0; guard < 500; guard++) {
      for (const text of await questions.allInnerTexts())
        if (!texts.includes(text)) texts.push(text)
      const moved = await scroller.evaluate((el) => {
        const from = el.scrollTop
        el.scrollTop = from + el.clientHeight / 2
        return el.scrollTop > from
      })
      if (!moved) break
      await frames()
    }
    assert.ok(texts.length > 0)
    t.check(
      'every exchange is there once, in order',
      texts.length === EXCHANGES && texts.every((text, n) => text === `question ${n}`),
      { count: texts.length, head: texts.slice(0, 3), tail: texts.slice(-3) }
    )
  } finally {
    await fixture.close()
  }
}
