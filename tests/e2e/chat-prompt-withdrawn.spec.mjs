import assert from 'node:assert/strict'
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* A request the agent withdrew stays out of the dock when the next request
   arrives, and an answer the host refuses because the request is gone retires
   the card. What this spec holds in the real app: the dock shows the live
   request, with nothing queued behind it, after the agent cancelled the one
   before; the live request is answered once; a card whose answer the host no
   longer holds leaves the dock with no answer recorded and one plain sentence
   in the transcript; and a failure of any other kind keeps the card for a
   second try (PRDCT-4032). */

const ask = (id, description) => ({
  type: 'permission_request',
  id,
  description,
  toolName: 'Bash',
  input: { command: `echo ${id}` },
  options: [
    { id: 'allow-once', label: 'Allow once' },
    { id: 'deny', label: 'Deny' }
  ]
})

export async function run(t) {
  const chat = await openChat('chat-prompt-withdrawn')
  const { win, record, fixture } = chat
  const view = win.locator('[data-testid="chat-view"]')
  const dock = view.locator('.chat-prompt[data-kind="permission"]')
  const allow = () => dock.locator('.chat-prompt-btn[data-primary="true"]').click()
  const writes = () => fixture.evaluate(() => globalThis.__dockWrites)
  try {
    // The host answers a permission response the way the request store would:
    // the request `gone` is no longer held, `flaky` fails once and then takes
    // the answer, every other one is taken at once.
    await fixture.evaluate(() => {
      const host = globalThis.__claveE2E.sessionHost
      const write = host.write
      globalThis.__dockWrites = []
      globalThis.__flakyFailed = false
      host.write = (id, input) => {
        if (input.type !== 'permission_response') return write.call(host, id, input)
        globalThis.__dockWrites.push(input)
        if (input.id === 'gone') return Promise.reject(new Error('No such provider request.'))
        if (input.id === 'flaky' && !globalThis.__flakyFailed) {
          globalThis.__flakyFailed = true
          return Promise.reject(new Error('The server is stopping.'))
        }
        return Promise.resolve()
      }
    })

    // The agent asks, then withdraws the request (the adapter's word for the
    // provider's cancel, since a provider's raw frame never reaches a window)
    // and goes on working.
    await inject(fixture, record.id, [
      { type: 'user_message', text: 'make the slides' },
      ask('old', 'Allow Bash: echo old'),
      { type: 'state_change', state: 'blocked' }
    ])
    await dock.waitFor()
    assert.match(await dock.innerText(), /echo old/)
    await inject(fixture, record.id, [
      { type: 'permission_withdrawn', id: 'old' },
      { type: 'state_change', state: 'working' }
    ])
    await until(async () => (await view.locator('.chat-prompt').count()) === 0)
    // The next request puts the view back on blocked: the live one is docked,
    // alone, and the withdrawn one reads as settled in the transcript.
    await inject(fixture, record.id, [
      ask('current', 'Allow Bash: echo current'),
      { type: 'state_change', state: 'blocked' }
    ])
    await dock.waitFor()
    assert.match(await dock.innerText(), /echo current/)
    assert.equal(await view.locator('.chat-prompt-queue').count(), 0, 'nothing queues behind it')
    await view
      .locator('.chat-permission-row[data-state="elsewhere"]')
      .filter({ hasText: 'No longer awaiting an answer' })
      .waitFor()
    t.check('a request the agent withdrew stays out of the dock when the next one arrives', true)

    await allow()
    await until(async () => (await writes()).length === 1)
    assert.deepEqual((await writes())[0], {
      type: 'permission_response',
      id: 'current',
      optionId: 'allow-once'
    })
    await until(async () => (await view.locator('.chat-prompt').count()) === 0)
    await view
      .locator('.chat-permission-row[data-state="answered"]')
      .filter({ hasText: 'Allow once' })
      .waitFor()
    t.check('the live request is answered once, without a restart', true)

    // A card the host no longer holds: the answer is refused, the card leaves
    // with no answer recorded, and the reader is told in one sentence.
    await inject(fixture, record.id, [
      ask('gone', 'Allow Bash: echo gone'),
      { type: 'state_change', state: 'blocked' }
    ])
    await dock.waitFor()
    assert.match(await dock.innerText(), /echo gone/)
    await allow()
    await until(async () => (await writes()).length === 2)
    await until(async () => (await view.locator('.chat-prompt').count()) === 0)
    assert.equal(await view.locator('.chat-permission-row[data-state="elsewhere"]').count(), 2)
    assert.equal(await view.locator('.chat-permission-row[data-state="answered"]').count(), 1)
    await view
      .locator('.chat-notice[data-tone="error"]')
      .filter({ hasText: 'This request is no longer waiting.' })
      .waitFor()
    t.check(
      'an answer refused because the request is gone retires the card, no answer recorded',
      true
    )

    // Any other failure keeps the card: the second click answers it.
    await inject(fixture, record.id, [
      ask('flaky', 'Allow Bash: echo flaky'),
      { type: 'state_change', state: 'blocked' }
    ])
    await dock.waitFor()
    await allow()
    await until(async () => (await writes()).length === 3)
    await view
      .locator('.chat-notice[data-tone="error"]')
      .filter({ hasText: 'The server is stopping.' })
      .waitFor()
    assert.equal(await dock.count(), 1, 'the card stays for another try')
    await until(
      async () => !(await dock.locator('.chat-prompt-btn[data-primary="true"]').isDisabled())
    )
    await allow()
    await until(async () => (await writes()).length === 4)
    await until(async () => (await view.locator('.chat-prompt').count()) === 0)
    assert.equal(await view.locator('.chat-permission-row[data-state="answered"]').count(), 2)
    t.check('a failure of another kind keeps the card, and the next click answers it', true)
  } finally {
    await chat.close()
  }
}
