import assert from 'node:assert/strict'
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

export async function run(t) {
  for (const terminal of [false, true]) {
    const selector = terminal ? '[data-testid="terminal-view"]' : '[data-testid="chat-view"]'
    const chat = await openChat(
      `desktop-question-privacy-${terminal ? 'terminal' : 'chat'}`,
      terminal ? ['--dev-echo-view=clave.chat-view/terminal'] : [],
      `${selector} textarea:not(:disabled)`
    )
    const { win, record, fixture } = chat
    try {
      await fixture.evaluate(() => {
        const host = globalThis.__claveE2E.sessionHost
        const original = host.write
        globalThis.__privateQuestionWrites = []
        host.write = (id, input) => {
          if (input.type === 'permission_response') {
            globalThis.__privateQuestionWrites.push(input)
            return Promise.resolve()
          }
          return original.call(host, id, input)
        }
      })
      await inject(fixture, record.id, [
        {
          type: 'permission_request',
          id: 'private-local',
          description: 'Private local question',
          toolName: 'item/tool/requestUserInput',
          input: { questions: [{ question: 'Local private answer', isSecret: true }] },
          questions: [{ question: 'Local private answer', options: [] }],
          options: [
            { id: 'answer', label: 'Answer' },
            { id: 'deny', label: 'Deny' }
          ]
        }
      ])
      const view = win.locator(selector)
      const dock = view.locator('.chat-prompt')
      const input = dock.locator('.chat-prompt-other')
      await input.waitFor()
      assert.equal(await input.getAttribute('type'), 'password')
      await input.fill('synthetic-local-private-answer')
      await input.press('End')
      await input.pressSequentially('123')
      assert.equal(await input.inputValue(), 'synthetic-local-private-answer123')
      await dock.getByRole('button', { name: 'Review', exact: true }).click()
      assert.equal((await dock.innerText()).includes('synthetic-local-private-answer'), false)
      await dock.getByRole('button', { name: 'Send', exact: true }).click()
      assert.ok(
        await until(
          async () =>
            (await fixture.evaluate(() => globalThis.__privateQuestionWrites)).length === 1
        )
      )
      assert.deepEqual(
        (await fixture.evaluate(() => globalThis.__privateQuestionWrites))[0].answers,
        { 'Local private answer': 'synthetic-local-private-answer123' }
      )
      await until(async () => (await dock.count()) === 0)
      assert.equal((await view.innerText()).includes('synthetic-local-private-answer'), false)
      t.check(
        `${terminal ? 'terminal' : 'chat'} local private input is masked, reaches its host once and stays out of review/transcript`,
        true
      )
    } finally {
      await chat.app.close()
    }
  }
}
