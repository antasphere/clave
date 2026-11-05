import assert from 'node:assert/strict'
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* The Terminal view carries the same dock as the chat view and took the same
   two changes. What this spec holds in the real app, on that view: a card
   whose answer the host refuses because the request is gone leaves the dock
   with no answer recorded and one plain sentence, and the live request behind
   it is answered once; a withdrawn request stays out of the dock when the
   next one arrives (PRDCT-4032, the verifier's second gap). */

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
  const chat = await openChat(
    'terminal-prompt-withdrawn',
    ['--dev-echo-view=clave.chat-view/terminal'],
    '[data-testid="terminal-view"] textarea:not(:disabled)'
  )
  const { win, record, fixture } = chat
  const view = win.locator('[data-testid="terminal-view"]')
  const dock = view.locator('.chat-prompt[data-kind="permission"]')
  const allow = () => dock.locator('.chat-prompt-btn[data-primary="true"]').click()
  const writes = () => fixture.evaluate(() => globalThis.__dockWrites)
  try {
    await fixture.evaluate(() => {
      const host = globalThis.__claveE2E.sessionHost
      const write = host.write
      globalThis.__dockWrites = []
      host.write = (id, input) => {
        if (input.type !== 'permission_response') return write.call(host, id, input)
        globalThis.__dockWrites.push(input)
        if (input.id === 'gone') return Promise.reject(new Error('No such provider request.'))
        return Promise.resolve()
      }
    })

    // A card the host no longer holds, in front of a live one.
    await inject(fixture, record.id, [
      { type: 'user_message', text: 'make the slides' },
      ask('gone', 'Allow Bash: echo gone'),
      ask('live', 'Allow Bash: echo live'),
      { type: 'state_change', state: 'blocked' }
    ])
    await dock.waitFor()
    assert.match(await dock.innerText(), /echo gone/)
    assert.match(await dock.innerText(), /1 of 2 waiting/)
    await allow()
    await until(async () => (await writes()).length === 1)
    await view
      .locator('.chat-notice[data-tone="error"]')
      .filter({ hasText: 'This request is no longer waiting.' })
      .waitFor()
    await until(async () => /echo live/.test(await dock.innerText()))
    assert.equal(await view.locator('.chat-prompt-queue').count(), 0, 'nothing queues behind it')
    assert.equal(await view.locator('.chat-permission-row[data-state="elsewhere"]').count(), 1)
    assert.equal(await view.locator('.chat-permission-row[data-state="answered"]').count(), 0)
    t.check(
      'on the Terminal view, a refused answer retires the gone card with no answer recorded',
      true
    )

    await allow()
    await until(async () => (await writes()).length === 2)
    assert.deepEqual((await writes())[1], {
      type: 'permission_response',
      id: 'live',
      optionId: 'allow-once'
    })
    await until(async () => (await view.locator('.chat-prompt').count()) === 0)
    assert.equal(await view.locator('.chat-permission-row[data-state="answered"]').count(), 1)
    t.check('the live request behind it is answered once', true)

    // A withdrawn request stays out when the next one arrives.
    await inject(fixture, record.id, [
      ask('old', 'Allow Bash: echo old'),
      { type: 'state_change', state: 'blocked' },
      { type: 'permission_withdrawn', id: 'old' },
      { type: 'state_change', state: 'working' },
      ask('current', 'Allow Bash: echo current'),
      { type: 'state_change', state: 'blocked' }
    ])
    await until(async () => /echo current/.test(await dock.innerText()))
    assert.equal(await view.locator('.chat-prompt-queue').count(), 0, 'the withdrawn one stays out')
    assert.equal(await view.locator('.chat-permission-row[data-state="elsewhere"]').count(), 2)
    t.check(
      'a withdrawn request stays out of the Terminal view dock when the next one arrives',
      true
    )
  } finally {
    await chat.close()
  }
}
