import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* The question dock in the Terminal view. What this spec holds in the real app:
   - it reads in the Chat view's face, not the composer's monospace;
   - a multi-select shows a box on every option before anything is picked;
   - a click on the dock's own words keeps its keys: a digit picks an option
     and never lands in the prompt;
   - an option takes a note, which travels with it in the answer, and a single
     choice with a note waits for Enter instead of sending on the click. */

export async function run(t) {
  const chat = await openChat(
    'terminal-dock',
    ['--dev-echo-view=clave.chat-view/terminal'],
    '[data-testid="terminal-view"] textarea:not(:disabled)'
  )
  const { win, record, fixture } = chat
  const view = win.locator('[data-testid="terminal-view"]')
  try {
    await fixture.evaluate(() => {
      globalThis.__dock = []
      const host = globalThis.__claveE2E.sessionHost
      const write = host.write
      host.write = (id, input) => {
        globalThis.__dock.push(input)
        if (input.type === 'permission_response') return Promise.resolve()
        return write.call(host, id, input)
      }
    })
    const answers = () =>
      fixture.evaluate(() =>
        globalThis.__dock.filter((w) => w.type === 'permission_response').map((w) => w.answers)
      )
    await inject(fixture, record.id, [
      { type: 'user_message', text: 'check it' },
      {
        type: 'permission_request',
        id: 'multi',
        description: 'Claude asks',
        toolName: 'AskUserQuestion',
        input: {},
        questions: [
          {
            question: 'Which checks should run?',
            multiSelect: true,
            options: [
              { label: 'Unit tests', description: 'vitest' },
              { label: 'E2E', description: 'the Electron suite' },
              { label: 'Lint', description: 'eslint' }
            ]
          }
        ],
        options: [
          { id: 'answer', label: 'Submit' },
          { id: 'deny', label: 'Skip' }
        ]
      }
    ])
    const dock = view.locator('.chat-prompt')
    await dock.waitFor()
    const look = await dock.evaluate((el) => ({
      font: getComputedStyle(el).fontFamily,
      mono: getComputedStyle(document.querySelector('.term-prompt textarea')).fontFamily,
      boxes: el.querySelectorAll('.chat-prompt-option .chat-prompt-box').length
    }))
    t.check(
      "the dock reads in the Chat view's face and a multi-select shows its boxes",
      look.font !== look.mono && look.boxes === 3,
      look
    )

    await dock.locator('.chat-prompt-title').click()
    await win.keyboard.press('2')
    const composer = view.getByRole('textbox', { name: 'Message', exact: true })
    t.check(
      "a click on the dock's words keeps its keys: 2 picks, the prompt stays empty",
      (await dock.getByRole('checkbox', { name: /E2E/ }).getAttribute('aria-checked')) === 'true' &&
        (await composer.inputValue()) === '',
      await composer.inputValue()
    )

    await dock.locator('.chat-prompt-choice').nth(2).hover()
    await dock.getByRole('button', { name: 'Add a note to Lint' }).click()
    await win.keyboard.type('only the changed files')
    await win.keyboard.press('Enter')
    // Enter again sends from the review.
    await dock.locator('.chat-prompt-review').waitFor()
    await win.keyboard.press('Enter')
    await dock.waitFor({ state: 'detached' })
    const multi = (await answers())[0]
    t.check(
      'a note travels with its option in the answer',
      multi?.['Which checks should run?'] === 'E2E, Lint — only the changed files',
      multi
    )

    await inject(fixture, record.id, [
      {
        type: 'permission_request',
        id: 'single',
        description: 'Claude asks',
        toolName: 'AskUserQuestion',
        input: {},
        questions: [
          {
            question: 'Where should the report go?',
            options: [{ label: 'The chat' }, { label: 'A file' }]
          }
        ],
        options: [
          { id: 'answer', label: 'Submit' },
          { id: 'deny', label: 'Skip' }
        ]
      }
    ])
    await dock.waitFor()
    await dock.locator('.chat-prompt-choice').nth(1).hover()
    await dock.getByRole('button', { name: 'Add a note to A file' }).click()
    await win.keyboard.type('reports/checks.md')
    const waited = (await answers()).length === 1
    await dock.getByRole('radio', { name: /A file/ }).click()
    const stillUp = (await dock.count()) === 1 && (await answers()).length === 1
    await dock.getByRole('button', { name: /Review/ }).click()
    await dock.getByRole('button', { name: /Send/ }).click()
    const single = await until(async () => (await answers())[1])
    t.check(
      'a single choice with a note waits for Review, and sends the note with it',
      waited && stillUp && single['Where should the report go?'] === 'A file — reports/checks.md',
      { waited, stillUp, single }
    )
  } finally {
    await chat.close()
  }
}
