import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* The chat view's context meter, in the composer's footer: a bar and the
   count "used/window", filled as soon as the context holds anything (the
   model names the window before any result does), warning past 70% and
   alarming past 90%. The old "Enter to send" hint is gone. */

export async function run(t) {
  const chat = await openChat('chat-context-meter')
  const { win, record, fixture } = chat
  const view = win.locator('[data-testid="chat-view"]')
  try {
    const footer = view.locator('.chat-composer-footer')
    await footer.waitFor()
    t.check(
      'the footer no longer carries the keyboard hint',
      !(await footer.innerText()).includes('Enter to send'),
      await footer.innerText()
    )

    await inject(fixture, record.id, [
      { type: 'session_meta', model: 'claude-opus-5-5', providerSessionId: null },
      { type: 'context_usage', used: 12_000, window: null }
    ])
    const meter = footer.locator('.chat-context')
    await until(async () => (await meter.innerText()).includes('12k/1M'))
    const read = () =>
      meter.evaluate((el) => ({
        label: el.innerText,
        level: el.querySelector('.chat-context-bar').dataset.level ?? null,
        track: el.querySelector('.chat-context-bar').getBoundingClientRect().width,
        fill: el.querySelector('.chat-context-fill').getBoundingClientRect().width
      }))
    const low = await read()
    t.check(
      'a context of 12k shows "12k/1M" without parentheses and a visible fill',
      low.label === '12k/1M' && low.fill > 0 && low.level === null,
      low
    )

    await inject(fixture, record.id, [{ type: 'context_usage', used: 950_000, window: null }])
    // The fill's width is transitioned: wait for it to land.
    await until(async () => {
      const now = await read()
      return now.label === '950k/1M' && now.fill > now.track * 0.9
    })
    const high = await read()
    t.check(
      'at 95% the count follows and the bar alarms',
      high.label === '950k/1M' && high.level === 'high' && high.fill > high.track * 0.9,
      high
    )
  } finally {
    await chat.close()
  }
}
