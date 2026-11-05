// Find in one chat session (PaneSearch + the view's useTranscriptSearch).
// The transcript is virtualised, so most rows are not in the page; the search
// still counts the whole conversation, the same at every scroll position, and
// walks to a match far out of view by scrolling its row in and marking the
// word there. The field opens from Cmd+F on a focused chat pane, in that
// pane's own header; a spinner shows while the query settles; Enter walks
// older, Shift+Enter newer; text streaming in is counted; Escape clears the
// marks and gives the composer back.
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

const NOTES = 80

const marks = (win) =>
  win.evaluate(() => ({
    current: [...(CSS.highlights.get('pane-search-current') ?? [])].map((r) => ({
      text: r.toString(),
      row: r.startContainer.parentElement
        ?.closest('[data-row-index]')
        ?.getAttribute('data-row-index'),
      note: r.startContainer.textContent
    }))
  }))

export async function run(t) {
  const chat = await openChat('chat-pane-search')
  const { win, record, fixture } = chat
  try {
    const pane = `.chat-host[data-session-id="${record.id}"]`
    const events = []
    for (let i = 1; i <= NOTES; i++) {
      events.push({ type: 'user_message', text: `question ${i}` })
      events.push({ type: 'assistant_text', delta: `Note ${i}: the zebra is here.`, final: true })
    }
    events.push({ type: 'state_change', state: 'done' })
    await inject(fixture, record.id, events)
    await win.locator(`${pane} .chat-column`).getByText(`Note ${NOTES}:`).waitFor()
    const scroller = win.locator(`${pane} [data-testid="chat-view"] .chat-scroll`)
    const mounted = await scroller.evaluate((el) => el.querySelectorAll('[data-row-index]').length)
    t.check(
      'the transcript is virtualised: far fewer rows in the page than notes',
      mounted < NOTES,
      mounted
    )

    await win.locator(`${pane} [data-testid="chat-view"] textarea`).click()
    await win.keyboard.press('Meta+f')
    const field = win.locator(`${pane} .pane-header-lead [data-pane-search] input`)
    await field.waitFor()
    await until(async () =>
      (await field.evaluate((el) => document.activeElement === el)) ? true : null
    )
    t.check('Cmd+F opens the field in the pane header with the focus', true)

    await field.type('zebra')
    const busy = await win
      .locator(`${pane} [data-pane-search][data-busy="true"] .pane-search-spinner`)
      .count()
    t.equal('a spinner shows while the query settles', busy, 1)
    const count = win.locator(`${pane} .pane-search-count`)
    await until(async () =>
      (await count.innerText().catch(() => '')) === `1 of ${NOTES}` ? true : null
    )
    t.equal(
      'every note in the session is counted, newest current',
      await count.innerText(),
      `1 of ${NOTES}`
    )
    t.equal(
      'the spinner goes once it has settled',
      await win.locator(`${pane} .pane-search-spinner`).count(),
      0
    )
    const newest = await until(async () => {
      const m = await marks(win)
      return m.current[0]?.text === 'zebra' ? m.current[0] : null
    })
    t.check(
      'the newest zebra is marked',
      !!newest && newest.note.includes(`Note ${NOTES}:`),
      newest
    )

    // The count does not depend on where the reader is.
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight / 2))
    await win.waitForTimeout(500)
    t.equal(
      'scrolled to the middle, the count is the same',
      await count.innerText(),
      `1 of ${NOTES}`
    )

    // Walk far up, out of the page's rows.
    for (let i = 0; i < 60; i++) await field.press('Enter')
    await until(async () => ((await count.innerText()) === `61 of ${NOTES}` ? true : null))
    t.equal('Enter walks older, one match a press', await count.innerText(), `61 of ${NOTES}`)
    const far = await until(async () => {
      const m = await marks(win)
      return m.current[0]?.note?.includes(`Note ${NOTES - 60}:`) ? m.current[0] : null
    })
    t.check(
      'the row of a match far out of view is brought in and its word marked',
      !!far,
      await marks(win)
    )
    const inView = await win.evaluate((sel) => {
      const r = [...(CSS.highlights.get('pane-search-current') ?? [])][0]?.getBoundingClientRect()
      const f = document.querySelector(sel).getBoundingClientRect()
      return !!r && r.top >= f.top && r.bottom <= f.bottom
    }, `${pane} [data-testid="chat-view"] .chat-scroll`)
    t.check('and it is on screen', inView)

    await field.press('Shift+Enter')
    await until(async () => ((await count.innerText()) === `60 of ${NOTES}` ? true : null))
    t.check('Shift+Enter walks back towards the present', true)

    await inject(fixture, record.id, [
      { type: 'assistant_text', delta: 'A late zebra.', final: true }
    ])
    await until(async () => ((await count.innerText()).endsWith(`of ${NOTES + 1}`) ? true : null))
    t.check(
      'a message arriving while the field is open is counted',
      (await count.innerText()).endsWith(`of ${NOTES + 1}`),
      await count.innerText()
    )

    await field.fill('no-such-word-anywhere')
    await until(async () =>
      /No matches/.test(await count.innerText().catch(() => '')) ? true : null
    )
    t.check('a query with no match says so', /No matches/.test(await count.innerText()))

    await field.press('Escape')
    await field.waitFor({ state: 'detached' })
    const after = await win.evaluate(() => ({
      all: CSS.highlights.get('pane-search')?.size ?? 0,
      current: CSS.highlights.get('pane-search-current')?.size ?? 0
    }))
    t.check(
      'Escape closes the field and clears the marks',
      after.all === 0 && after.current === 0,
      after
    )
    t.check(
      'and gives the composer back',
      await win
        .locator(`${pane} [data-testid="chat-view"] textarea`)
        .evaluate((el) => document.activeElement === el)
    )
  } finally {
    await chat.close()
  }
}
