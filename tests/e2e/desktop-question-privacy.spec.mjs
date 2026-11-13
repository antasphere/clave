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
          input: {
            questions: [
              { question: 'Local private answer', isSecret: true },
              { question: 'Keep it local?' }
            ]
          },
          questions: [
            { question: 'Local private answer', options: [] },
            { question: 'Keep it local?', options: [{ label: 'Yes' }, { label: 'No' }] }
          ],
          options: [
            { id: 'answer', label: 'Answer' },
            { id: 'deny', label: 'Deny' }
          ]
        }
      ])
      const view = win.locator(selector)
      const dock = view.locator('.chat-prompt')
      const input = dock.locator('input[type="password"]')
      await input.waitFor()
      assert.equal(await input.getAttribute('aria-label'), 'Local private answer')
      await input.fill('synthetic-local-private-answer')
      await input.press('End')
      await input.pressSequentially('123')
      assert.equal(await input.inputValue(), 'synthetic-local-private-answer123')
      // Enter moves on; the private answer folds into its line as dots
      // (PRDCT-4322), the one shown above the next question and the stack.
      await input.press('Enter')
      await dock.locator('.chat-prompt-step').filter({ hasText: '2/2' }).waitFor()
      const folded = dock.locator('.chat-ask-field').first()
      assert.match(await folded.innerText(), /Local private answer\s*••••••/)
      assert.equal((await dock.innerText()).includes('synthetic-local-private-answer'), false)
      await dock.getByRole('radio', { name: /Yes/ }).click()
      await until(
        async () => (await dock.locator('.chat-ask-field[data-folded="true"]').count()) === 2
      )
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
        { 'Local private answer': 'synthetic-local-private-answer123', 'Keep it local?': 'Yes' }
      )
      await until(async () => (await dock.count()) === 0)
      assert.equal((await view.innerText()).includes('synthetic-local-private-answer'), false)
      t.check(
        `${terminal ? 'terminal' : 'chat'} local private input is masked, folds as dots, reaches its host once and stays out of the transcript`,
        true
      )
    } finally {
      await chat.app.close()
    }
  }
}
