import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* The Terminal view's status line and its subagent stack. What this spec
   holds in the real app:
   - the context bar fills as soon as the context holds anything: the model
     names the window before any result does;
   - the model reads by name, the same before and after its menu is opened,
     and in the pane's header;
   - a subagent row names the model its agent runs on and counts its steps;
     it carries neither the word "background" nor its last command, which is
     in the row's tooltip;
   - the row says its model without offering it; picking another model in
     the agent's window asks first, then stops that one task and asks the
     conversation to launch it again on the model picked;
   - a background shell joins the same stack behind the terminal glyph, with
     no model and no relaunch, and leaves with the list;
   - the status line counts the agents and the commands apart ("1 agent",
     then "1 agent · 1 command"), a command the turn waits on counts no more
     than it shows, and the count goes once the stack is empty. */

export async function run(t) {
  const chat = await openChat(
    'terminal-subagents',
    ['--dev-echo-view=clave.chat-view/terminal'],
    '[data-testid="terminal-view"] textarea:not(:disabled)'
  )
  const { win, record, fixture } = chat
  const view = win.locator('[data-testid="terminal-view"]')
  // What the pane writes to the session, in order.
  await fixture.evaluate(() => {
    globalThis.__writes = []
    const host = globalThis.__claveE2E.sessionHost
    const write = host.write
    host.write = (id, input) => {
      globalThis.__writes.push(input)
      return write.call(host, id, input)
    }
  })
  const writes = () => fixture.evaluate(() => globalThis.__writes)
  try {
    /* 1. A context of 12k on a model whose window is known: the bar fills. */
    await inject(fixture, record.id, [
      { type: 'session_meta', model: 'claude-opus-5-5', providerSessionId: null },
      { type: 'context_usage', used: 12_000, window: null }
    ])
    const meter = view.locator('.term-context')
    await until(async () => (await meter.innerText()).includes('12k/1M'))
    const bar = await meter.evaluate((el) => ({
      label: el.innerText,
      track: el.querySelector('.term-context-bar').getBoundingClientRect().width,
      fill: el.querySelector('.term-context-fill').getBoundingClientRect().width
    }))
    t.check(
      'a context that holds anything shows fill, on a bar of 24 spacing units',
      bar.label.includes('12k/1M') && bar.fill > 0 && Math.round(bar.track) === 96,
      bar
    )

    /* 2. The model chip names the model the same way, menu opened or not. */
    const chip = view.locator('.term-model .chat-model-trigger-label')
    const before = await chip.innerText()
    await view.locator('.term-model .chat-model-trigger').click()
    await win.locator('.chat-model-menu').waitFor()
    await until(async () => (await win.locator('.chat-model-menu').innerText()).includes('Echo'))
    const opened = await chip.innerText()
    await win.keyboard.press('Escape')
    const header = await win.locator('.chat-header .pane-header-meta').innerText()
    t.check(
      'the model reads "Opus 5.5" on the chip, before and after its menu opens, and in the header',
      before === 'Opus 5.5' && opened === 'Opus 5.5' && header === 'Opus 5.5',
      { before, opened, header }
    )

    /* 3. A background subagent at work. */
    await inject(fixture, record.id, [
      {
        type: 'tool_call',
        id: 'call-1',
        name: 'Agent',
        input: { subagent_type: 'Explore', description: 'Map the views', run_in_background: true }
      },
      {
        type: 'background_tasks',
        tasks: [
          {
            id: 'task-9',
            kind: 'agent',
            description: 'Map the views',
            toolUseId: 'call-1',
            startedAt: Date.now()
          }
        ]
      },
      { type: 'subagent_model', parent: 'call-1', model: 'claude-sonnet-5-5' },
      { type: 'tool_call', id: 's1', name: 'Grep', input: { pattern: 'view' }, parent: 'call-1' },
      {
        type: 'tool_call',
        id: 's2',
        name: 'Read',
        input: { file_path: '/repo/src/registry.tsx' },
        parent: 'call-1'
      }
    ])
    const row = view.locator('.term-agent').first()
    await until(async () => (await row.innerText()).includes('2 steps'))
    const cards = () => view.locator('.term-agent:not([data-leaving])').count()
    t.check('one subagent is one card under the composer', (await cards()) === 1)
    const seen = await row.evaluate((el) => ({
      text: el.innerText,
      title: el.querySelector('.work-card-open').getAttribute('title'),
      model: el.querySelector('.term-agent-model')?.textContent
    }))
    t.check(
      'a row names its model and counts its steps, without "background" or its last command',
      seen.model === 'Sonnet 5.5' &&
        !/background/i.test(seen.text) &&
        !seen.text.includes('registry.tsx') &&
        /registry\.tsx/.test(seen.title ?? ''),
      seen
    )

    /* 3b. The row opens a window onto the agent: its brief, its tool runs
       and its words, rendered as the transcript renders the conversation,
       with no field to type in; nothing of the subagent is in the transcript
       itself. Escape closes it. */
    await inject(fixture, record.id, [
      { type: 'user_message', text: 'Map every view the registry knows', parent: 'call-1' },
      { type: 'tool_result', id: 's1', output: 'registry.tsx: 2 matches', parent: 'call-1' },
      {
        type: 'assistant_text',
        delta: 'Two views registered, both native.',
        final: true,
        parent: 'call-1'
      }
    ])
    await row.locator('button.work-card-open').click()
    const peek = win.locator('.term-peek')
    await peek.waitFor()
    await until(async () =>
      (await peek.innerText()).includes('Two views registered') ? true : null
    )
    const peeked = await peek.evaluate((el) => ({
      head: el.querySelector('.term-peek-head')?.innerText ?? '',
      brief: el.querySelector('.chat-turn[data-role="user"]')?.innerText ?? '',
      runs: el.querySelectorAll('.term-tools').length,
      words: el.querySelector('.chat-turn[data-role="assistant"]')?.innerText ?? '',
      fields: el.querySelectorAll('textarea, input, [contenteditable="true"]').length
    }))
    // The transcript holds the Agent call's own run, and nothing the agent did.
    const inTranscript = await view.locator('.chat-transcript .term-tools').evaluateAll((runs) => ({
      runs: runs.length,
      text: runs.map((el) => el.innerText).join(' | ')
    }))
    t.check(
      'the window names the agent, shows its brief, one run of its tools and its words, and no field',
      /Explore/.test(peeked.head) &&
        /Map the views/.test(peeked.head) &&
        peeked.brief === 'Map every view the registry knows' &&
        peeked.runs === 1 &&
        peeked.words === 'Two views registered, both native.' &&
        peeked.fields === 0,
      peeked
    )
    t.check(
      "the subagent's calls are not in the transcript's run",
      inTranscript.runs === 1 && !/registry\.tsx|Grep|Search|Read/.test(inTranscript.text),
      inTranscript
    )
    await win.keyboard.press('Escape')
    await until(async () => ((await win.locator('.term-peek').count()) === 0 ? true : null))
    t.check('Escape closes the window', (await win.locator('.term-peek').count()) === 0)

    /* 4. Relaunch on Haiku, from the agent's window (the card only says its
       model): asked first, then the task stopped, then the ask. */
    t.check(
      'the card says the model and offers no menu',
      (await row.locator('button.term-agent-model').count()) === 0 &&
        (await row.locator('.term-agent-model').innerText()) === 'Sonnet 5.5'
    )
    await row.locator('button.work-card-open').click()
    await win.locator('.term-peek').waitFor()
    await win.locator('.term-peek button.term-agent-model').click()
    const menu = win.locator('.chat-model-menu[aria-label="Relaunch on"]')
    await menu.waitFor()
    const items = await menu.locator('.chat-model-option').allInnerTexts()
    await menu.locator('.chat-model-option', { hasText: 'Haiku 4.5' }).click()
    const dialog = win.getByRole('dialog', { name: /Relaunch on/ })
    await dialog.waitFor()
    const nothingYet = (await writes()).filter((w) => w?.type === 'stop_task').length === 0
    await dialog.getByRole('button', { name: 'Relaunch' }).click()
    const sent = await until(async () => {
      const all = (await writes()).filter((w) => w && typeof w === 'object')
      const stop = all.findIndex((w) => w.type === 'stop_task')
      const ask = all.findIndex((w) => w.type === 'user_message' && /model "haiku"/.test(w.text))
      return stop >= 0 && ask > stop ? { stop: all[stop], ask: all[ask].text } : null
    })
    t.check(
      'the menu offers the four families by version, and nothing is stopped before the confirm',
      items.join('|') === 'Opus 5.5|Fable 5.1|Sonnet 5.5|Haiku 4.5' && nothingYet,
      { items, nothingYet }
    )
    t.check(
      'the confirm stops that one task, then asks for it again on Haiku',
      sent?.stop?.taskId === 'task-9' && /Map the views/.test(sent?.ask ?? ''),
      sent
    )

    /* 5. A background shell beside the agent: the same stack, the terminal
       glyph for its dot, no model and no relaunch; the agent keeps its model. */
    await inject(fixture, record.id, [
      {
        type: 'tool_call',
        id: 'bash-1',
        name: 'Bash',
        input: { command: 'npm run dev', run_in_background: true }
      },
      { type: 'tool_result', id: 'bash-1', output: 'Command running in background with ID: b1' },
      {
        type: 'background_tasks',
        tasks: [
          {
            id: 'task-9',
            kind: 'agent',
            description: 'Map the views',
            toolUseId: 'call-1',
            startedAt: Date.now()
          },
          {
            id: 'b1',
            kind: 'shell',
            description: 'npm run dev',
            toolUseId: 'bash-1',
            startedAt: Date.now()
          }
        ]
      },
      { type: 'state_change', state: 'done' }
    ])
    const shellRow = view.locator('.term-agent[data-kind="shell"]')
    await until(async () => (await shellRow.count()) === 1)
    const stack = await view.locator('.term-agent:not([data-leaving])').evaluateAll((items) =>
      items.map((el) => ({
        kind: el.getAttribute('data-kind'),
        description: el.querySelector('.term-agent-description')?.textContent,
        drawing: el.querySelector('svg.work-drawing')?.getAttribute('data-kind') ?? null,
        model: el.querySelector('.term-agent-model')?.textContent ?? null,
        relaunch: !!el.querySelector('button.term-agent-model')
      }))
    )
    t.check(
      'a background shell is a card after the agent, with the terminal drawing and no model; the agent keeps its model',
      stack.length === 2 &&
        stack[0].kind === 'agent' &&
        stack[0].drawing === 'agent' &&
        stack[0].model === 'Sonnet 5.5' &&
        stack[1].kind === 'shell' &&
        stack[1].description === 'npm run dev' &&
        stack[1].drawing === 'shell' &&
        stack[1].model === null &&
        !stack[1].relaunch,
      stack
    )
    /* 6. A command the turn waits on is off the cards (PR #256): still one
       agent and one command while the call is in flight. A context reading
       is the sync point, since nothing on the line is expected to change. */
    await inject(fixture, record.id, [
      { type: 'tool_call', id: 'bash-2', name: 'Bash', input: { command: 'git status -sb' } },
      { type: 'context_usage', used: 13_000, window: null }
    ])
    await until(async () => (await meter.innerText()).includes('13k/1M'))
    const waited = { rows: await cards() }
    await inject(fixture, record.id, [
      { type: 'tool_result', id: 'bash-2', output: '## main' },
      { type: 'context_usage', used: 14_000, window: null }
    ])
    await until(async () => (await meter.innerText()).includes('14k/1M'))
    const answered = { rows: await view.locator('.term-agent').count() }
    t.check(
      'a command the turn waits on is not a card, in flight or answered',
      waited.rows === 2 && answered.rows === 2,
      { waited, answered }
    )
    await inject(fixture, record.id, [{ type: 'background_tasks', tasks: [] }])
    const cleared = await until(async () => (await view.locator('.term-agent').count()) === 0)
    t.check('an empty list folds both cards away', !!cleared)
  } finally {
    await chat.close()
  }
}
