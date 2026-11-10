import assert from 'node:assert/strict'
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* What the agent waits on. What this spec holds in the real app: the agent's
   own question is the form's card (PRDCT-4322), its questions one below
   another, answered by choosing or in the person's own words, never by
   "allowing" it; an answer is edited in place from its folded line; the reply
   that crosses the write IPC carries one string per question keyed by the
   question, the shape the Claude CLI turns into the model's answer. A tool
   permission answers from the keyboard. Every answer leaves its record in the
   transcript. */

export async function run(t) {
  const chat = await openChat('chat-prompt-dock')
  const { win, record, fixture } = chat
  const view = win.locator('[data-testid="chat-view"]')
  try {
    await fixture.evaluate(() => {
      const host = globalThis.__claveE2E.sessionHost
      const write = host.write
      globalThis.__dockWrites = []
      host.write = (id, input) => {
        globalThis.__dockWrites.push(input)
        if (input.type === 'permission_response') return Promise.resolve()
        return write.call(host, id, input)
      }
    })
    const writes = () => fixture.evaluate(() => globalThis.__dockWrites)
    await inject(fixture, record.id, [
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
    // The agent's own question is the form's card (PRDCT-4322): both questions
    // stand one below another, the first open, the second folded to its line.
    const fields = dock.locator('.chat-ask-field')
    assert.equal(await fields.count(), 2)
    assert.equal(await fields.nth(0).getAttribute('data-state'), 'active')
    assert.equal(await fields.nth(1).getAttribute('data-state'), 'upcoming')
    assert.match(await fields.nth(1).innerText(), /Who else to copy\?/)
    // The adapter's « Claude asks 2 questions » is not said again under the eyebrow.
    assert.equal(await dock.locator('.chat-prompt-ask').count(), 0)
    // Next with nothing chosen moves nowhere and says why.
    await dock.getByRole('button', { name: 'Next', exact: true }).click()
    await dock.locator('.chat-field-problem').filter({ hasText: 'An answer is needed' }).waitFor()
    assert.equal(await dock.locator('.chat-prompt-step').innerText(), '1/2')
    // A single choice is the answer: one click moves on, no Next to press.
    await dock.getByRole('radio', { name: /Draft only/ }).click()
    await dock.locator('.chat-prompt-step').filter({ hasText: '2/2' }).waitFor()
    assert.equal(await fields.nth(0).getAttribute('data-state'), 'done')
    assert.match(await fields.nth(0).innerText(), /Send now or draft\?\s*Draft only/)
    assert.equal(await dock.locator('.chat-ask-fields').getAttribute('data-direction'), 'forward')
    t.check(
      'a question docks with its options, the next one folded below, one choice moves on',
      true
    )

    // The answer is edited where it stands: the folded line reopens the
    // question with the caret at the end of its answer line.
    await fields.nth(0).locator('.chat-ask-folded').click()
    await dock.locator('.chat-prompt-step').filter({ hasText: '1/2' }).waitFor()
    assert.equal(await dock.locator('.chat-ask-fields').getAttribute('data-direction'), 'back')
    const answerLine = fields.nth(0).getByRole('textbox', { name: 'Your answer' })
    await until(() => answerLine.evaluate((el) => el === document.activeElement))
    assert.equal(await answerLine.inputValue(), 'Draft only')
    await win.keyboard.type(', and show it to me first')
    // The option the answer starts from stays picked as it is edited.
    assert.equal(
      await dock.getByRole('radio', { name: /Draft only/ }).getAttribute('aria-checked'),
      'true'
    )
    await win.keyboard.press('Enter')
    await dock.locator('.chat-prompt-step').filter({ hasText: '2/2' }).waitFor()
    assert.match(
      await fields.nth(0).innerText(),
      /Draft only, and show it to me first/,
      'the edited answer folds into its line'
    )
    t.check('a folded answer reopens to be edited in place, and folds back edited', true)

    // The second question is multi-select, answered by digit keys and own words.
    await dock.getByRole('checkbox', { name: /Romain/ }).waitFor()
    // Moving on kept the focus in the card, so a digit picks at once.
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
    await dock.getByPlaceholder('Add your own words').fill('the client')
    // The last question's button sends: no separate review page.
    assert.equal((await writes()).length, 0, 'nothing is sent before the last button')
    await dock.getByRole('button', { name: 'Send', exact: true }).click()
    await until(async () => (await writes()).length === 1)
    assert.deepEqual((await writes())[0], {
      type: 'permission_response',
      id: 'ask',
      optionId: 'answer',
      answers: {
        'Send now or draft?': 'Draft only, and show it to me first',
        'Who else to copy?': 'Romain, Valentin, the client'
      }
    })
    t.check(
      'the answers cross the write IPC keyed by question, one string each, own words last',
      true
    )

    await until(async () => (await view.locator('.chat-prompt').count()) === 0)
    const row = view.locator('.chat-permission-row[data-kind="question"]')
    assert.match(await row.innerText(), /Answered/i)
    assert.match(await row.innerText(), /Send now or draft\?\s*Draft only, and show it to me first/)
    assert.match(await row.innerText(), /Who else to copy\?\s*Romain, Valentin, the client/)
    t.check('an answered question closes into the card it was, every answer on its line', true)

    // A pick on the last question never sends: every answer folds into its
    // line above the button that sends them, and only that button sends.
    await inject(fixture, record.id, [
      {
        type: 'permission_request',
        id: 'ask-two',
        description: 'Claude asks 2 questions',
        toolName: 'AskUserQuestion',
        input: {},
        questions: [
          { question: 'Ship today?', options: [{ label: 'Yes' }, { label: 'No' }] },
          { question: 'Tell the client?', options: [{ label: 'Now' }, { label: 'Tomorrow' }] }
        ],
        options: [
          { id: 'answer', label: 'Submit' },
          { id: 'deny', label: 'Skip' }
        ]
      }
    ])
    await dock.waitFor()
    await dock.getByRole('radio', { name: /Yes/ }).click()
    await dock.locator('.chat-prompt-step').filter({ hasText: '2/2' }).waitFor()
    await dock.getByRole('radio', { name: /Tomorrow/ }).click()
    await until(
      async () => (await dock.locator('.chat-ask-field[data-folded="true"]').count()) === 2
    )
    assert.equal((await writes()).length, 1, 'the last pick sends nothing')
    assert.match(await dock.innerText(), /Ship today\?\s*Yes/)
    assert.match(await dock.innerText(), /Tell the client\?\s*Tomorrow/)
    // A question reopened and picked again goes back to the stack, not to
    // the next question, already answered.
    await dock.locator('.chat-ask-field').first().locator('.chat-ask-folded').click()
    await dock.locator('.chat-prompt-step').filter({ hasText: '1/2' }).waitFor()
    await dock.getByRole('radio', { name: /No/ }).click()
    await until(
      async () => (await dock.locator('.chat-ask-field[data-folded="true"]').count()) === 2
    )
    assert.equal(await dock.locator('.chat-prompt-step').count(), 0, 'the stack, no step open')
    await dock.getByRole('button', { name: 'Send', exact: true }).click()
    await until(async () => (await writes()).length === 2)
    assert.deepEqual((await writes())[1].answers, {
      'Ship today?': 'No',
      'Tell the client?': 'Tomorrow'
    })
    t.check(
      'a pick on the last question folds every answer above Send, a re-pick returns there, only Send sends',
      true
    )

    // A plugin's question carries no questions of its own: its choice IS the
    // answer, sent as that option's own id, with no answer line to edit.
    await inject(fixture, record.id, [
      {
        type: 'permission_request',
        id: 'plugin-ask',
        description: 'Install the helper now?',
        options: [
          { id: 'opt-install', label: 'Install' },
          { id: 'opt-later', label: 'Later' }
        ]
      }
    ])
    await dock.waitFor()
    assert.match(await dock.innerText(), /Install the helper now\?/)
    assert.equal(await dock.getByRole('textbox', { name: 'Your answer' }).count(), 0)
    await dock.getByRole('radio', { name: /Later/ }).click()
    await until(async () => (await writes()).length === 3)
    assert.deepEqual((await writes())[2], {
      type: 'permission_response',
      id: 'plugin-ask',
      optionId: 'opt-later'
    })
    t.check("a plugin's question is answered by the option clicked, by its own id", true)

    // Codex's question in words alone answers on Enter, key by key; a private
    // answer that starts like an option ticks nothing, which would show how
    // it starts (round 1).
    await inject(fixture, record.id, [
      {
        type: 'permission_request',
        id: 'codex-ask',
        description: 'Codex asks 2 questions',
        toolName: 'item/tool/requestUserInput',
        input: {
          questions: [
            { id: 'why', question: 'Why now?' },
            { id: 'env', question: 'Which environment?', isSecret: true }
          ]
        },
        questions: [
          { id: 'why', question: 'Why now?', options: [] },
          {
            id: 'env',
            question: 'Which environment?',
            options: [{ label: 'prod' }, { label: 'staging' }]
          }
        ],
        options: [
          { id: 'answer', label: 'Submit' },
          { id: 'deny', label: 'Skip' }
        ]
      }
    ])
    await dock.waitFor()
    const why = dock.getByRole('textbox', { name: 'Why now?' })
    await why.click()
    await win.keyboard.type('the client asked')
    await win.keyboard.press('Enter')
    await dock.locator('.chat-prompt-step').filter({ hasText: '2/2' }).waitFor()
    const privateLine = dock.locator('input[type="password"]')
    await privateLine.click()
    await win.keyboard.type('prod-eu-secret')
    assert.equal(
      await dock.getByRole('radio', { name: /^prod/ }).getAttribute('aria-checked'),
      'false',
      'a private answer ticks no option it only starts like'
    )
    await dock.getByRole('button', { name: 'Send', exact: true }).click()
    await until(async () => (await writes()).length === 4)
    assert.deepEqual((await writes())[3].answers, {
      why: 'the client asked',
      env: 'prod-eu-secret'
    })
    t.check(
      'a question in words alone answers on Enter; a private answer ticks nothing it starts like',
      true
    )

    // A multi-select's own words, typed key by key, are never taken for the
    // option they read like on the way, nor after Escape and a digit (round 2).
    await inject(fixture, record.id, [
      {
        type: 'permission_request',
        id: 'yes-no',
        description: 'Which apply?',
        toolName: 'AskUserQuestion',
        input: {},
        questions: [
          {
            question: 'Which apply?',
            multiSelect: true,
            options: [{ label: 'No' }, { label: 'Yes' }]
          }
        ],
        options: [
          { id: 'answer', label: 'Submit' },
          { id: 'deny', label: 'Skip' }
        ]
      }
    ])
    await dock.waitFor()
    const words = dock.getByRole('textbox', { name: 'Your own words' })
    await words.click()
    await win.keyboard.type('No')
    await win.keyboard.press('Escape')
    await until(() =>
      win.evaluate(() => document.activeElement?.classList.contains('chat-prompt-body') ?? false)
    )
    await win.keyboard.press('2')
    await until(
      async () =>
        (await dock.getByRole('checkbox', { name: /Yes/ }).getAttribute('aria-checked')) === 'true'
    )
    assert.equal(
      await dock.getByRole('checkbox', { name: /No/ }).getAttribute('aria-checked'),
      'false'
    )
    assert.equal(await words.inputValue(), 'No', 'the words stay in their line')
    await words.click()
    await win.keyboard.press('End')
    await win.keyboard.type(' idea')
    assert.equal(
      await dock.getByRole('checkbox', { name: /No/ }).getAttribute('aria-checked'),
      'false'
    )
    await dock.getByRole('button', { name: 'Send', exact: true }).click()
    await until(async () => (await writes()).length === 5)
    assert.deepEqual((await writes())[4].answers, { 'Which apply?': 'Yes, No idea' })
    t.check('own words typed key by key stay words, through Escape and a digit', true)

    // A tool permission answers from the keyboard: Escape denies.
    await inject(fixture, record.id, [
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
    await until(async () => (await writes()).length === 6)
    assert.deepEqual((await writes())[5], {
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
    await chat.close()
  }
}
