import assert from 'node:assert/strict'
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* What the agent waits on docks above the composer. What this spec holds in the
   real app: a question is answered by choosing, never by "allowing" it, and the
   reply that crosses the write IPC carries the reader's choices keyed by the
   question — the shape the Claude CLI turns into the model's answer. A tool
   permission answers from the keyboard. Every answer leaves the dock and
   leaves its record in the transcript. */

export async function run(t) {
  const fixture = await openChat('chat-prompt-dock')
  const { app, win, record } = fixture
  const view = win.locator('[data-testid="chat-view"]')
  try {
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('sessions:write')
      globalThis.__dockWrites = []
      ipcMain._invokeHandlers.set('sessions:write', (event, id, input) => {
        globalThis.__dockWrites.push(input)
        if (input.type === 'permission_response') return
        return original(event, id, input)
      })
    })
    const writes = () => app.evaluate(() => globalThis.__dockWrites)
    await inject(app, record.id, [
      { type: 'user_message', text: 'send the email' },
      {
        type: 'permission_request',
        id: 'ask',
        description: 'Claude asks 2 questions',
        toolName: 'AskUserQuestion',
        input: {},
        questions: [
          {
            question: 'Send now or draft?',
            header: 'Send email',
            options: [
              { label: 'Send now', description: 'Send immediately' },
              { label: 'Draft only', description: 'Create a Gmail draft instead' }
            ]
          },
          {
            question: 'Who else to copy?',
            options: [{ label: 'Romain' }, { label: 'Valentin' }],
            multiSelect: true
          }
        ],
        options: [
          { id: 'answer', label: 'Submit' },
          { id: 'deny', label: 'Skip' }
        ]
      }
    ])
    const dock = view.locator('.chat-prompt[data-kind="question"]')
    await dock.waitFor()
    assert.match(await dock.innerText(), /Send now or draft\?/)
    assert.equal(await dock.locator('.chat-prompt-step').innerText(), '1/2')
    // No "Allow" anywhere: a question is answered, not permitted.
    assert.equal(await view.getByRole('button', { name: /Allow/ }).count(), 0)
    const next = dock.getByRole('button', { name: 'Next', exact: true })
    assert.equal(await next.isDisabled(), true, 'nothing chosen, nothing to send')
    // A single choice is the answer: one click moves on, no Next to press.
    await dock.getByRole('radio', { name: /Draft only/ }).click()
    await dock.locator('.chat-prompt-step').filter({ hasText: '2/2' }).waitFor()
    // The page that came in is the one that swipes, from the right.
    assert.equal(await dock.locator('.chat-prompt-page').getAttribute('data-direction'), 'forward')
    // Back keeps the choice and reverses the swipe; the choice again moves on.
    await dock.getByRole('button', { name: 'Back', exact: true }).click()
    await dock.locator('.chat-prompt-step').filter({ hasText: '1/2' }).waitFor()
    assert.equal(await dock.locator('.chat-prompt-page').getAttribute('data-direction'), 'back')
    assert.equal(
      await dock.getByRole('radio', { name: /Draft only/ }).getAttribute('aria-checked'),
      'true'
    )
    await dock.getByRole('radio', { name: /Draft only/ }).click()
    t.check('a question docks with its options and one choice moves it on at once', true)

    // The second question is multi-select, answered by digit keys and own words.
    await dock.locator('.chat-prompt-step').filter({ hasText: '2/2' }).waitFor()
    await dock.getByRole('checkbox', { name: /Romain/ }).waitFor()
    // Moving on kept focus in the dock, so a digit picks at once.
    await win.keyboard.press('2')
    assert.ok(
      await until(
        async () =>
          (await dock.getByRole('checkbox', { name: /Valentin/ }).getAttribute('aria-checked')) ===
          'true'
      ),
      'the digit key picks the second option'
    )
    await dock.getByRole('checkbox', { name: /Romain/ }).click()
    await dock.getByPlaceholder('Type your own answer').fill('the client')
    await dock.getByRole('button', { name: 'Submit', exact: true }).click()
    await until(async () => (await writes()).length === 1)
    assert.deepEqual((await writes())[0], {
      type: 'permission_response',
      id: 'ask',
      optionId: 'answer',
      answers: {
        'Send now or draft?': 'Draft only',
        'Who else to copy?': 'Valentin, Romain, the client'
      }
    })
    t.check('the answers cross the write IPC keyed by question, choices and own words joined', true)

    await until(async () => (await view.locator('.chat-prompt').count()) === 0)
    const row = view.locator('.chat-permission-row[data-kind="question"]')
    assert.match(await row.innerText(), /Answered/)
    assert.match(await row.innerText(), /Draft only; Valentin, Romain, the client/)
    t.check('an answered question leaves the dock and records its answer in the transcript', true)

    // A tool permission answers from the keyboard: Escape denies.
    await inject(app, record.id, [
      {
        type: 'permission_request',
        id: 'write',
        description: 'Allow Write?',
        toolName: 'Write',
        detail: 'Path is outside allowed working directories',
        input: { file_path: '/Users/me/Desktop/demo.txt', content: 'Safe to delete.' },
        options: [
          { id: 'allow-once', label: 'Allow once' },
          { id: 'allow-always', label: 'Always allow' },
          { id: 'deny', label: 'Deny' }
        ]
      }
    ])
    const permission = view.locator('.chat-prompt[data-kind="permission"]')
    await permission.waitFor()
    assert.match(await permission.innerText(), /Allow the agent to write demo\.txt\?/)
    assert.match(await permission.innerText(), /Path is outside allowed working directories/)
    assert.match(await permission.locator('.chat-prompt-code').innerText(), /Safe to delete\./)
    // Deny on the left, the provider's default last, where the eye ends.
    assert.deepEqual(
      await permission
        .locator('.chat-prompt-btn')
        .allInnerTexts()
        .then((all) =>
          all.map((text) =>
            text
              .split('\n')[0]
              .replace(/[0-9]|Esc|⌘↩/g, '')
              .trim()
          )
        ),
      ['Deny', 'Always allow', 'Allow once']
    )
    assert.equal(
      await permission
        .locator('.chat-prompt-btn[data-primary="true"]')
        .innerText()
        .then((s) =>
          s
            .split('\n')[0]
            .replace(/[0-9]|⌘↩/g, '')
            .trim()
        ),
      'Allow once'
    )
    // The dock takes focus as it arrives, so its keys work without a click.
    await until(() =>
      win.evaluate(() => document.activeElement?.classList.contains('chat-prompt-body') ?? false)
    )
    await win.keyboard.press('Escape')
    await until(async () => (await writes()).length === 2)
    assert.deepEqual((await writes())[1], {
      type: 'permission_response',
      id: 'write',
      optionId: 'deny'
    })
    await view
      .locator('.chat-permission-row[data-state="answered"]')
      .filter({ hasText: 'Deny' })
      .waitFor()
    t.check('a permission reads as a sentence, orders its buttons, and Escape denies', true)
  } finally {
    await fixture.close()
  }
}
