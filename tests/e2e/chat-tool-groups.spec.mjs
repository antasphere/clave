import assert from 'node:assert/strict'
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'
import { choose } from './plugin-views.spec.mjs'

/* A run of tool calls is ONE row between two messages. What this spec holds, in
   the real app, that a unit test cannot: the row renders, a click opens it, the
   reader's choice survives a result arriving, and a failure never opens the row
   by itself.

   Every locator is scoped to the conversation view. Two views of this plugin are
   mounted on the session at once and `hidden` takes the other out of sight but
   not out of the DOM, so a window-wide class query resolves to both copies and
   fails on strictness (src/renderer/src/views/README.md). */

export async function run(t) {
  const fixture = await openChat('chat-tool-groups')
  const { app, win, record } = fixture
  const view = win.locator('[data-testid="chat-view"]')
  const compact = win.locator('.chat-view[data-view="compact"]')
  try {
    // A run of four tools between two messages, one of them still running.
    await inject(app, record.id, [
      { type: 'user_message', text: 'look around' },
      { type: 'tool_call', id: 'g1', name: 'Read', input: { file_path: '/one.ts' } },
      { type: 'tool_result', id: 'g1', output: 'first file' },
      { type: 'tool_call', id: 'g2', name: 'Read', input: { file_path: '/two.ts' } },
      { type: 'tool_result', id: 'g2', output: 'second file' },
      { type: 'tool_call', id: 'g3', name: 'Bash', input: { command: 'npm test' } },
      { type: 'tool_result', id: 'g3', output: 'ok' },
      { type: 'tool_call', id: 'g4', name: 'Read', input: { file_path: '/three.ts' } }
    ])
    const run1 = view.locator('.chat-tool-run').first()
    await run1.waitFor()
    assert.equal(await view.locator('.chat-tool-run').count(), 1)
    assert.equal(await run1.getAttribute('data-tools'), '4')
    assert.equal(await run1.getAttribute('data-state'), 'running')
    assert.equal(
      await run1.locator('.chat-tool-run-summary').innerText(),
      'Read 3 files · Ran 1 command'
    )
    await run1.locator('> summary [aria-label="Running"]').waitFor()
    t.check('four consecutive tools render as one row, counted by kind, with a loader', true)

    // The run is closed until the reader says otherwise, and while closed it
    // puts none of its tools' bodies in the document.
    assert.equal(await run1.evaluate((el) => el.open), false)
    assert.equal(await run1.locator('.chat-tool-item').count(), 0)
    await run1.locator('> summary').click()
    assert.equal(await run1.evaluate((el) => el.open), true)
    // The bodies are built on the first open, so they arrive a tick later.
    await until(async () => (await run1.locator('.chat-tool-item').count()) === 4)
    const first = run1.locator('.chat-tool-item').first()
    assert.equal(await first.locator('.chat-tool-name').innerText(), 'Read')
    assert.equal(await first.locator('.chat-tool-summary').innerText(), '/one.ts')
    // Each call is a row of its own, closed, with no panel until it is opened.
    assert.equal(await first.evaluate((el) => el.open), false)
    assert.equal(await first.locator('.chat-tool-panel').count(), 0)
    await first.locator('> summary').click()
    await first.locator('.chat-tool-panel').waitFor()
    assert.match(await first.locator('.chat-tool-panel').innerText(), /first file/)
    // The command row reads as Codex writes it, and opens to the command as code.
    const shell = run1.locator('.chat-tool-item').nth(2)
    assert.equal(await shell.locator('.chat-tool-name').innerText(), 'Ran')
    await shell.locator('> summary').click()
    await shell.locator('.chat-tool-section[data-label="Command"] code.language-bash').waitFor()
    assert.match(
      await shell.locator('.chat-tool-section[data-label="Command"] pre').innerText(),
      /^\$ npm test$/
    )
    t.check('the row opens to one row per call, each opening to its own panel', true)

    // Hovering a row names the kind of call in a few words.
    await first.locator('> summary').hover()
    await win.getByRole('tooltip').filter({ hasText: 'File read' }).waitFor()
    await run1.locator('> summary').hover()
    await win.getByRole('tooltip').filter({ hasText: '4 external calls' }).waitFor()
    t.check('hovering a row names what kind of call it was', true)

    // The raw input and output the task brief asks for. Nothing covered this:
    // the base asserted the raw input through `.chat-tool-card pre`, and this
    // lane rewrote that line to read the Output preview instead, so emptying
    // the raw block left every spec green.
    const raw = first.locator('details.chat-tool-raw')
    assert.equal(await raw.evaluate((el) => el.open), false)
    await raw.locator('> summary').click()
    const rawText = await raw.innerText()
    assert.match(rawText, /\/one\.ts/, 'the raw block shows the recorded input')
    assert.match(rawText, /first file/, 'the raw block shows the recorded output')
    t.check('each call keeps its raw input and output behind its own toggle', true)

    // The reader's choice survives a NEW CALL joining the open run. This is the
    // commoner live case — the agent keeps calling tools while the row is open —
    // and keying the row on the run's length rather than its first tool id
    // passes every other check here while closing the row under the reader.
    await inject(app, record.id, [
      { type: 'tool_call', id: 'g5', name: 'Grep', input: { pattern: 'TODO' } }
    ])
    await until(async () => (await run1.locator('.chat-tool-item').count()) === 5)
    assert.equal(
      await run1.evaluate((el) => el.open),
      true,
      'an opened run must stay open when a new call joins it'
    )
    assert.equal(await run1.getAttribute('data-tools'), '5')
    t.check('a new call joining an open run leaves it open', true)

    // And the choice survives the last results arriving.
    await inject(app, record.id, [
      { type: 'tool_result', id: 'g5', output: 'one match' },
      { type: 'tool_result', id: 'g4', output: 'third file' }
    ])
    await run1.locator('> summary [aria-label="Complete"]').waitFor()
    assert.equal(await run1.getAttribute('data-state'), 'complete')
    assert.equal(await run1.evaluate((el) => el.open), true)
    assert.equal(await run1.locator('.chat-tool-item').count(), 5)
    t.check('a result arriving mid-run leaves an opened row open', true)

    // A message ends the run; a permission card does not.
    await inject(app, record.id, [
      { type: 'assistant_text', delta: 'Here is what I found.', final: true },
      { type: 'tool_call', id: 'h1', name: 'Read', input: { file_path: '/four.ts' } },
      { type: 'tool_result', id: 'h1', output: 'fourth' },
      {
        type: 'permission_request',
        id: 'perm-1',
        description: 'Write to /four.ts?',
        options: [{ id: 'allow', label: 'Allow' }]
      },
      { type: 'tool_call', id: 'h2', name: 'Write', input: { file_path: '/four.ts' } },
      { type: 'tool_result', id: 'h2', output: 'written' }
    ])
    await until(async () => (await view.locator('.chat-tool-run').count()) === 2)
    const run2 = view.locator('.chat-tool-run').nth(1)
    assert.equal(await run2.getAttribute('data-tools'), '2')
    assert.equal(await view.locator('.chat-permission-row').count(), 1)
    t.check('a message breaks the run into two rows; a permission card inside one does not', true)

    // A failure is counted, shown, and NEVER opens the row by itself.
    await inject(app, record.id, [
      { type: 'assistant_text', delta: 'Trying something.', final: true },
      { type: 'tool_call', id: 'f1', name: 'Bash', input: { command: 'false' } },
      { type: 'tool_result', id: 'f1', output: 'boom', error: true },
      { type: 'tool_call', id: 'f2', name: 'Read', input: { file_path: '/five.ts' } },
      // Reads exactly like a failure and is not one: no adapter flagged it.
      { type: 'tool_result', id: 'f2', output: 'Error: nothing here' }
    ])
    await until(async () => (await view.locator('.chat-tool-run').count()) === 3)
    const failed = view.locator('.chat-tool-run').nth(2)
    await failed.locator('> summary [aria-label="Failed"]').waitFor()
    assert.equal(await failed.getAttribute('data-state'), 'failed')
    assert.equal(await failed.getAttribute('data-failures'), '1')
    assert.equal(await failed.locator('.chat-tool-failures').innerText(), '1 failed')
    assert.equal(
      await failed.evaluate((el) => el.open),
      false,
      'a failed run must not expand itself: the reader decides what to open'
    )
    t.check('a failure is counted from the adapter flag alone and never auto-expands', true)

    // The compact view reads the same runs, one line each, no bodies. Its rows
    // are virtualised like the conversation's: they are mounted once the view
    // is on screen, so the reader switches to it first.
    const picker = win.getByLabel('Change view', { exact: true })
    await choose(win, picker, 'Compact')
    const compactRows = compact.locator('li[data-kind="tool-group"]')
    await until(async () => (await compactRows.count()) === 3)
    assert.equal(await compactRows.first().locator('span').first().innerText(), 'Tools')
    assert.equal(
      await compactRows.first().locator('span').nth(1).innerText(),
      'Read 3 files · Ran 1 command · Searched once'
    )
    assert.equal(await compactRows.nth(2).getAttribute('data-state'), 'failed')
    assert.equal(await compactRows.nth(2).getAttribute('data-failures'), '1')
    assert.match(await compactRows.nth(2).innerText(), /1 failed/)
    assert.equal(await compact.locator('.chat-tool-item').count(), 0)
    t.check('the compact view groups the same runs as one line each, with no tool bodies', true)

    // The rows are virtualised: a row scrolled far out of view leaves the
    // document, and the reader's open rows must come back open. A <details>
    // keeps its state in the DOM, so without the view's memory of it
    // (ToolDisclosure) the first run returns closed.
    await choose(win, picker, 'Chat')
    const scroller = view.locator('.chat-scroll')
    const opened = view.locator('.chat-tool-run[data-tools="5"]')
    const filler = 'A long answer that pushes the first run far out of view. '.repeat(12)
    await inject(
      app,
      record.id,
      Array.from({ length: 40 }, (_, i) =>
        i % 2 === 0
          ? { type: 'user_message', text: `filler ${i}` }
          : { type: 'assistant_text', delta: filler, final: true }
      )
    )
    assert.ok(
      await until(async () => (await opened.count()) === 0),
      'the first run leaves the document once it is far out of view'
    )
    await scroller.evaluate((el) => {
      el.scrollTop = 0
    })
    await opened.waitFor()
    assert.equal(await opened.evaluate((el) => el.open), true, 'the opened run comes back open')
    assert.equal(await opened.locator('.chat-tool-item').count(), 5)
    const back = opened.locator('.chat-tool-item').first()
    assert.equal(await back.evaluate((el) => el.open), true, 'and so does the call opened in it')
    assert.match(await back.locator('.chat-tool-panel').innerText(), /first file/)
    assert.equal(
      await view
        .locator('.chat-tool-run')
        .nth(2)
        .evaluate((el) => el.open),
      false,
      'a row never opened comes back closed'
    )
    t.check('an opened row scrolled out of the document comes back open', true)
    // What the column gained plays its entrance on its first mount only: the
    // run came back as a row scrolled into view, not as something new.
    assert.equal(
      await opened.evaluate((el) => el.closest('.chat-row').dataset.arrive ?? null),
      null
    )
    t.check('a row scrolled back into view does not replay its entrance', true)
  } finally {
    await fixture.close()
  }
}
