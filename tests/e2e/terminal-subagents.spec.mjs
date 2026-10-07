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
   - picking another model on a row asks first, then stops that one task and
     asks the conversation to launch it again on the model picked. */

export async function run(t) {
  const fixture = await openChat(
    'terminal-subagents',
    ['--dev-echo-view=clave.chat-view/terminal'],
    '[data-testid="terminal-view"] textarea:not(:disabled)'
  )
  const { app, win, record } = fixture
  const view = win.locator('[data-testid="terminal-view"]')
  // What the pane writes to the session, in order.
  await app.evaluate(() => {
    globalThis.__writes = []
    const host = globalThis.__claveE2E.sessionHost
    const write = host.write
    host.write = (id, input) => {
      globalThis.__writes.push(input)
      return write.call(host, id, input)
    }
  })
  const writes = () => app.evaluate(() => globalThis.__writes)
  try {
    /* 1. A context of 12k on a model whose window is known: the bar fills. */
    await inject(app, record.id, [
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
    await inject(app, record.id, [
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
    const seen = await row.evaluate((el) => ({
      text: el.innerText,
      title: el.querySelector('.term-agent-row').getAttribute('title'),
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

    /* 4. Relaunch on Haiku: asked first, then the task stopped, then the ask. */
    await row.locator('button.term-agent-model').click()
    const menu = win.locator('.chat-model-menu[aria-label="Relaunch on"]')
    await menu.waitFor()
    const items = await menu.locator('.chat-model-option').allInnerTexts()
    await menu.locator('.chat-model-option', { hasText: 'Haiku 4.5' }).click()
    const dialog = win.getByRole('dialog')
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
  } finally {
    await fixture.close()
  }
}
