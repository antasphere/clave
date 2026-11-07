import { openChat, inject } from './chat-view.spec.mjs'
import { callMcp, until } from './harness.mjs'

/* Opening the other tab at an exchange. A message one tab received is word for
   word what the other tab sent, so a card's "Open in" finds the place there.
   What this spec holds in the real app, with two tabs of one group:
   - the card's button selects the other tab, scrolled to the row holding the
     send, far up its transcript, and flashes that row;
   - a message the other tab never sent with its own tool (here, one Clave sent
     for it) is not found: the tab opens, and the pill says the exchange is
     not in that conversation. */

const filler = (prefix, n) =>
  Array.from({ length: n }, (_, i) =>
    i % 2 === 0
      ? { type: 'user_message', text: `${prefix} question ${i}` }
      : { type: 'assistant_text', delta: `${prefix} answer. `.repeat(80), final: true }
  )

export async function run(t) {
  const fixture = await openChat(
    'chat-exchange-jump',
    ['--dev-echo-view=clave.chat-view/terminal'],
    '[data-testid="terminal-view"] textarea:not(:disabled)'
  )
  const { app, win, record: target } = fixture
  try {
    await win.locator('.launcher-split .launcher-btn').click()
    const sender = await until(async () =>
      (await win.evaluate(() => window.electronAPI.sessionsList())).find(
        (s) => s.adapterId === 'echo' && s.id !== target.id
      )
    )
    const { groupId } = await callMcp(app, 'createGroup', { name: 'Jump' })
    for (const id of [target.id, sender.id])
      await callMcp(app, 'moveSession', { sessionId: id, groupId })
    // The sender's own record of the send, far up its transcript.
    await inject(fixture.fixture, sender.id, [
      ...filler('Before', 30),
      {
        type: 'tool_call',
        id: 'send-1',
        name: 'mcp__clave__clave_send_to_session',
        input: { sessionId: target.id, message: 'MERGED · PR 12' }
      },
      { type: 'tool_result', id: 'send-1', output: '{"delivered":true}' },
      ...filler('After', 40)
    ])
    await callMcp(app, 'sendToSession', {
      sessionId: target.id,
      message: 'MERGED · PR 12',
      callerSessionId: sender.id
    })
    await callMcp(app, 'focus', { sessionId: target.id })
    const pane = win.locator(`[data-session-id="${target.id}"] [data-testid="terminal-view"]`)
    const card = pane.locator('.exchange-card').first()
    await card.waitFor()
    await card.locator('> summary').click()
    await card.locator('.exchange-open').click()

    const other = win.locator(`[data-session-id="${sender.id}"] [data-testid="terminal-view"]`)
    const landed = await until(
      () =>
        other.evaluate((view) => {
          const scroller = view.querySelector('.chat-scroll')
          const row = view.querySelector('[data-row-index][data-jump-flash]')
          if (!scroller || !row) return null
          const box = row.getBoundingClientRect()
          const port = scroller.getBoundingClientRect()
          return {
            inView: box.bottom > port.top && box.top < port.bottom,
            awayFromEnd: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 200,
            holdsBefore: row.textContent.includes('Before question 28')
          }
        }),
      8000
    )
    t.check(
      "the card's button opens the other tab at the row holding the send, far up, and flashes it",
      !!landed && landed.inView && landed.awayFromEnd && landed.holdsBefore,
      landed
    )

    // A message the sender's agent never sent itself: nowhere to land.
    await callMcp(app, 'sendToSession', {
      sessionId: target.id,
      message: 'Sent by Clave, not by the agent',
      callerSessionId: sender.id
    })
    await callMcp(app, 'focus', { sessionId: target.id })
    const second = pane.locator('.exchange-card', { hasText: 'Sent by Clave' })
    await second.waitFor()
    await second.locator('> summary').click()
    await second.locator('.exchange-open').click()
    const pill = other.locator('.chat-jump-pill[data-tone="missing"]')
    const said = await until(() => pill.isVisible(), 8000)
    t.check(
      'a message the other tab never sent opens the tab and says the exchange is not there',
      said === true && (await pill.innerText()).includes('not in this conversation'),
      { said }
    )
  } finally {
    await fixture.close()
  }
}
