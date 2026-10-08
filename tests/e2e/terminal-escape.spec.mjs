import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* Escape while the agent works, in the Terminal view. What this spec holds in
   the real app:
   - before the agent has answered anything, the message is taken back: it
     leaves the transcript and is in the composer again, to edit;
   - once an answer has begun, the message stays in the transcript, marked
     Interrupted, and the composer is left empty;
   - an answer already on its way when the message was taken back brings the
     message back to the transcript. */

export async function run(t) {
  const chat = await openChat(
    'terminal-escape',
    ['--dev-echo-view=clave.chat-view/terminal'],
    '[data-testid="terminal-view"] textarea:not(:disabled)'
  )
  const { win, record, fixture } = chat
  const view = win.locator('[data-testid="terminal-view"]')
  const input = view.locator('textarea')
  // The echo adapter answers at once; here the agent answers only when the
  // spec says so. A sent message is echoed as the adapter would, working.
  await fixture.evaluate((id) => {
    globalThis.__interrupts = 0
    const host = globalThis.__claveE2E.sessionHost
    const write = host.write
    host.write = (sid, input) => {
      const send = (e) => globalThis.__claveE2E.echo.inject(id, { kind: 'event', event: e })
      if (input?.type === 'user_message') {
        send({ type: 'user_message', text: input.text })
        send({ type: 'state_change', state: 'working' })
        return Promise.resolve()
      }
      if (input?.type === 'interrupt') {
        globalThis.__interrupts += 1
        send({ type: 'turn_interrupted' })
        send({ type: 'state_change', state: 'idle' })
        return Promise.resolve()
      }
      return write.call(host, sid, input)
    }
  }, record.id)
  const questions = () =>
    view.locator('.chat-turn[data-role="user"]').evaluateAll((els) => els.map((e) => e.innerText))
  const sendText = async (text) => {
    await input.fill(text)
    await input.press('Enter')
    await until(async () => (await questions()).includes(text))
    await view.locator('.chat-send[data-kind="stop"]').waitFor()
  }
  try {
    /* 1. Nothing answered yet: taken back. */
    await sendText('first try, not quite right')
    await input.press('Escape')
    const gone = await until(
      async () => !(await questions()).includes('first try, not quite right')
    )
    const back = await input.inputValue()
    t.check(
      'Escape before any answer takes the message back into the composer, out of the transcript',
      gone === true && back === 'first try, not quite right',
      { gone, back, questions: await questions() }
    )

    /* 2. An answer has begun: the message stays, Interrupted; the composer empty. */
    await input.fill('')
    await sendText('explain the layout')
    await inject(fixture, record.id, [
      { type: 'assistant_text', delta: 'The layout has three parts', final: false }
    ])
    await view.getByText('The layout has three parts').waitFor()
    await input.press('Escape')
    const marked = await until(
      async () =>
        (await view
          .locator('.chat-turn[data-role="user"][data-interrupted="true"]', {
            hasText: 'explain the layout'
          })
          .count()) === 1
    )
    const composer = await input.inputValue()
    t.check(
      'Escape once an answer has begun leaves the message Interrupted and the composer empty',
      marked === true && composer === '',
      { marked, composer }
    )

    /* 3. An answer already on its way: the message shows again. */
    await sendText('one more thing')
    await input.press('Escape')
    await until(async () => !(await questions()).includes('one more thing'))
    await inject(fixture, record.id, [
      { type: 'assistant_text', delta: 'Already answering', final: false }
    ])
    const again = await until(async () => (await questions()).includes('one more thing'))
    t.check('a late answer brings a taken-back message back to the transcript', again === true, {
      questions: await questions()
    })
  } finally {
    await chat.close()
  }
}
