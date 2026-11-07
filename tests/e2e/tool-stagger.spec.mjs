// Opening a tool run brings its calls in one after another: each row fades
// and settles with a delay of its place in the list (a fifth of the open
// transition per row, capped at the tenth), the Terminal view's hairline fades
// in rather than being uncovered by the height, closing runs no animation,
// and the reader who asked for no motion gets the rows at once.
import { openChat, inject } from './chat-view.spec.mjs'

const CALLS = 13

export async function run(t) {
  const chat = await openChat(
    'tool-stagger',
    ['--dev-echo-view=clave.chat-view/terminal'],
    '[data-testid="terminal-view"] textarea:not(:disabled)'
  )
  const { win, record, fixture } = chat
  const view = win.locator('[data-testid="terminal-view"]')
  try {
    const events = [{ type: 'user_message', text: 'read them all' }]
    for (let i = 0; i < CALLS; i++) {
      events.push({
        type: 'tool_call',
        id: `r${i}`,
        name: 'Read',
        input: { file_path: `/repo/f${i}.ts` }
      })
      events.push({ type: 'tool_result', id: `r${i}`, output: 'x' })
    }
    events.push({ type: 'assistant_text', delta: 'Done.', final: true })
    events.push({ type: 'state_change', state: 'idle' })
    await inject(fixture, record.id, events)
    const run = view.locator('.term-tools').first()
    await run.waitFor()

    const read = () =>
      run.evaluate((el) => ({
        rows: [...el.querySelectorAll(':scope > .term-tools-body > .term-call')].map((r) => {
          const cs = getComputedStyle(r)
          return { name: cs.animationName, delay: cs.animationDelay }
        }),
        hairline: getComputedStyle(el.querySelector('.term-tools-body')).animationName
      }))

    await run.locator(':scope > summary').click()
    const open = await read()
    t.equal('every call of the run is a row', open.rows.length, CALLS)
    t.check(
      'every row comes in with the stagger animation',
      open.rows.every((r) => r.name === 'chat-stagger-in'),
      open.rows.map((r) => r.name)
    )
    const ms = open.rows.map((r) =>
      Math.round(parseFloat(r.delay) * (r.delay.endsWith('ms') ? 1 : 1000))
    )
    t.check(
      'each row waits 30ms more than the one above, up to the tenth step',
      ms.every((d, i) => d === Math.min(i, 10) * 30),
      ms
    )
    t.equal('the hairline fades in', open.hairline, 'term-hairline-in')
    const curves = await run.evaluate((el) => {
      const open = getComputedStyle(el, '::details-content').transitionTimingFunction
      el.open = false
      const closed = getComputedStyle(el, '::details-content').transitionTimingFunction
      el.open = true
      return { open, closed }
    })
    t.check(
      'the height opens on a spring that overshoots (the bounce)',
      /linear\(.*1\.07/.test(curves.open),
      curves
    )
    t.check(
      'and closes with a give before it folds',
      /cubic-bezier\(0\.36, 0, 0\.66, -0\.3\)/.test(curves.closed),
      curves
    )

    await run.locator(':scope > summary').click()
    const closed = await read()
    t.check(
      'closing runs no animation on the rows',
      closed.rows.every((r) => r.name === 'none'),
      closed.rows.map((r) => r.name)
    )

    await win.emulateMedia({ reducedMotion: 'reduce' })
    await run.locator(':scope > summary').click()
    const still = await read()
    t.check(
      'with reduced motion the rows appear at once',
      still.rows.every((r) => r.name === 'none') && still.hairline === 'none',
      still
    )
  } finally {
    await chat.close()
  }
}
