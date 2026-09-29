import { openChat } from './chat-view.spec.mjs'
import { callMcp, until } from './harness.mjs'

/* A message from another tab (clave_send_to_session), received in a chat tab.
   What this spec holds in the real app:
   - it ARRIVES: a chat tab has no terminal, and a paste addressed to one was
     dropped in main while the tool answered delivered: true;
   - it reads as the other tab's, not the reader's: the agents' tint, the
     sender in a chip, the bracketed header gone from the words;
   - the chip opens the sender's tab;
   - the ↑ recall of past messages skips it: the reader never wrote it. */

export async function run(t) {
  const fixture = await openChat(
    'chat-tab-delivery',
    ['--dev-echo-view=clave.chat-view/terminal'],
    '[data-testid="terminal-view"] textarea:not(:disabled)'
  )
  const { app, win, record: target } = fixture
  try {
    // A second chat tab, the sender.
    await win.locator('.launcher-split .launcher-btn').click()
    const sender = await until(async () =>
      (await win.evaluate(() => window.electronAPI.sessionsList())).find(
        (s) => s.adapterId === 'echo' && s.id !== target.id
      )
    )
    // Tabs reach each other within a group.
    const { groupId } = await callMcp(app, 'createGroup', { name: 'Delivery' })
    for (const id of [target.id, sender.id])
      await callMcp(app, 'moveSession', { sessionId: id, groupId })
    const result = await callMcp(app, 'sendToSession', {
      sessionId: target.id,
      message: 'MERGED · PR 12',
      callerSessionId: sender.id
    })
    // Back to the target, where the message should be.
    await callMcp(app, 'focus', { sessionId: target.id })
    const pane = win.locator(`[data-session-id="${target.id}"] [data-testid="terminal-view"]`)
    const delivered = pane.locator('.chat-turn[data-from="tab"]')
    const arrived = await until(async () => (await delivered.count()) === 1, 8000)
    t.check('a message sent to a chat tab arrives there', arrived === true && result.delivered, {
      arrived,
      result
    })
    const seen = await delivered.evaluate((el) => ({
      text: el.innerText,
      chip: el.querySelector('.chat-turn-from')?.textContent ?? null,
      button: el.querySelector('.chat-turn-from')?.tagName ?? null,
      tint: getComputedStyle(el).backgroundImage
    }))
    t.check(
      'it reads as the other tab’s: sender in a chip, no bracketed header, its own tint',
      !!seen.chip &&
        !seen.chip.includes('[') &&
        seen.text.includes('MERGED · PR 12') &&
        !seen.text.includes('[Message from Clave tab') &&
        !seen.text.includes('clave_send_to_session'),
      seen
    )
    // The chip opens the sender's tab.
    await delivered.locator('button.chat-turn-from').click()
    const opened = await until(
      async () =>
        (await win.locator(`[data-session-id="${sender.id}"]`).count()) === 1 &&
        (await win.locator(`[data-session-id="${sender.id}"]`).isVisible()),
      5000
    )
    t.check('the chip opens the sender’s tab', seen.button === 'BUTTON' && opened === true, {
      button: seen.button,
      opened
    })
    // ↑ in the target's empty composer recalls nothing: the reader never wrote it.
    await callMcp(app, 'focus', { sessionId: target.id })
    const field = pane.locator('textarea')
    await field.click()
    await field.press('ArrowUp')
    const recalled = await field.inputValue()
    t.check('↑ does not recall a message another tab sent', recalled === '', { recalled })
  } finally {
    await fixture.close()
  }
}
