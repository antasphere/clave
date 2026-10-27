import assert from 'node:assert/strict'
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

// A provider that restarted numbers its requests from zero again, so the
// next question can carry the id of one the reader was halfway through. The
// dock must start the new question fresh: a private draft typed for the old
// one must never become the new public answer (#261, verification round 3,
// V4). Both the old request ending first and a direct replacement, in both
// views, with a distinct-id control.
const question = (id, turn, secret) => ({
  type: 'permission_request',
  id,
  description: secret ? 'Previous private question' : 'Current public question',
  toolName: 'item/tool/requestUserInput',
  input: {
    turnId: turn,
    questions: [
      {
        id: 'value',
        question: secret ? 'Previous private value?' : 'Current public value?',
        isSecret: secret
      }
    ]
  },
  questions: [
    {
      id: 'value',
      question: secret ? 'Previous private value?' : 'Current public value?',
      options: []
    }
  ],
  options: [
    { id: 'answer', label: 'Answer' },
    { id: 'deny', label: 'Deny' }
  ]
})

export async function run(t) {
  for (const terminal of [false, true]) {
    for (const { reused, endOld } of [
      { reused: true, endOld: true },
      { reused: true, endOld: false },
      { reused: false, endOld: true }
    ]) {
      const mode = terminal ? 'terminal' : 'chat'
      const selector = terminal ? '[data-testid="terminal-view"]' : '[data-testid="chat-view"]'
      const chat = await openChat(
        `request-replacement-${mode}-${reused ? 'reused' : 'distinct'}-${endOld ? 'ended' : 'direct'}`,
        terminal ? ['--dev-echo-view=clave.chat-view/terminal'] : [],
        `${selector} textarea:not(:disabled)`
      )
      const { win, record, fixture } = chat
      try {
        await fixture.evaluate(() => {
          const host = globalThis.__claveE2E.sessionHost
          const original = host.write
          globalThis.__replacementWrites = []
          host.write = (id, input) => {
            if (input.type === 'permission_response') {
              globalThis.__replacementWrites.push(input)
              return Promise.resolve()
            }
            return original.call(host, id, input)
          }
        })
        const newId = reused ? 'old-question' : 'new-question'
        await inject(fixture, record.id, [question('old-question', 'old-turn', true)])
        const view = win.locator(selector)
        const dock = view.locator('.chat-prompt')
        const privateField = dock.locator('input.chat-prompt-other')
        await privateField.waitFor()
        assert.equal(await privateField.getAttribute('type'), 'password')
        const secret = 'srvq-synthetic-draft-of-the-previous-private-question'
        await privateField.fill(secret)
        // Both frames in one burst, as a queued stream delivers them.
        await inject(fixture, record.id, [
          ...(endOld ? [{ type: 'state_change', state: 'done' }] : []),
          question(newId, 'new-turn', false)
        ])
        assert.ok(
          await until(async () => (await dock.innerText()).includes('Current public value?')),
          'the current public question takes the dock'
        )
        const publicField = dock.locator('textarea.chat-prompt-other')
        await publicField.waitFor()
        assert.equal(await publicField.inputValue(), '', 'the new question starts empty')
        await publicField.fill('fresh public answer')
        await dock.getByRole('button', { name: 'Review', exact: true }).click()
        assert.equal((await dock.innerText()).includes(secret), false, 'nothing old at review')
        await dock.getByRole('button', { name: 'Send', exact: true }).click()
        assert.ok(
          await until(
            async () => (await fixture.evaluate(() => globalThis.__replacementWrites)).length === 1
          ),
          'one answer reaches the host'
        )
        const [write] = await fixture.evaluate(() => globalThis.__replacementWrites)
        assert.equal(write.id, newId)
        assert.deepEqual(write.answers, { value: 'fresh public answer' })
        assert.ok(await until(async () => (await dock.count()) === 0), 'the dock settles')
        assert.equal(
          (await view.innerText()).includes(secret),
          false,
          'nothing old in the transcript'
        )
        t.check(
          `${mode}: a ${reused ? 'reused' : 'distinct'} id ${endOld ? 'after the old request ended' : 'replacing the old request'} starts the new question fresh`,
          true
        )
      } finally {
        await chat.close()
      }
    }
  }
}
