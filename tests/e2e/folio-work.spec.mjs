import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* Folio's work dock (PRDCT-4833) and its spine's turn buttons (PRDCT-4834),
   on the real app with the echo adapter. In Folio the work running now (the
   subagents, the commands left in the background) leaves the strip under
   the composer for a pill of marks in the desk's bottom-right corner, which
   grows a card on approach. What this spec holds:
   1. two agents and a background command: three marks of the right kinds,
      no strip in Folio's composer, and the page and the composer did not
      move by a pixel, before the work, with it, and after it all ended;
   2. the pointer over the pill opens the card after its beat, three rows
      with the type, the task, the last step, the steps, the context, the
      time and the model; the pointer gone, it closes;
   3. the keyboard: the pill takes the focus, Enter pins it, the rows are
      reachable, Escape closes it and gives the focus back to the pill; work
      starting while the composer has the caret leaves the caret there;
   4. a row opens its window, the card staying open under it; another model
      picked there asks first, then writes stop_task and the relaunch; a
      command's row opens the shell's window;
   5. a quiet agent: its mark and its row say so, its mark stills;
   6. an agent ending takes its mark and the count with it; the last one
      ending takes the dock out of the DOM once its fold is over;
   7. another tab chosen and this one again: no transition under the dock on
      any frame after (the frame sampler of chat-work-cards-reveal);
   8. reduced motion: no animation under the dock, closed or open;
   9. the spine: Next page right after Previous page, both before the
      ticks, side by side, each still turning the page.
   Every name in the work is invented. */

const FOLIO = ['--dev-echo-view=clave.chat-view/lab']
const READY = '[data-testid="folio-view"] textarea:not(:disabled)'

/** The frame sampler of chat-work-cards-reveal: every painted frame with a
 *  CSS transition running under `selector`, or a mark not fully opaque. */
const sampler = ([selector, frames]) => {
  globalThis.__workSample = new Promise((resolve) => {
    const seen = []
    let n = 0
    const tick = () => {
      const root = document.querySelector(selector)
      if (root && root.getClientRects().length) {
        const moving = root
          .getAnimations({ subtree: true })
          .filter((a) => typeof a.transitionProperty === 'string')
          .map((a) => a.transitionProperty)
        const opacities = [...root.querySelectorAll('.folio-work-mark')].map(
          (mark) => +getComputedStyle(mark).opacity
        )
        const faint = opacities.length ? Math.min(...opacities) : 1
        if (moving.length || faint < 1) seen.push({ frame: n, moving, faint })
      }
      if (++n < frames) requestAnimationFrame(() => setTimeout(tick, 0))
      else resolve(seen)
    }
    requestAnimationFrame(() => setTimeout(tick, 0))
  })
}

const agentTask = (id, call, description, startedAt = Date.now()) => ({
  id,
  kind: 'agent',
  description,
  toolUseId: call,
  startedAt
})
const shellTask = (id, call, description) => ({
  id,
  kind: 'shell',
  description,
  toolUseId: call,
  startedAt: Date.now()
})

async function ask(view, text) {
  const input = view.locator('textarea[aria-label="Message"]')
  await input.fill(text)
  await input.press('Enter')
}

export async function run(t) {
  const chat = await openChat('folio-work', FOLIO, READY)
  const { win, record, fixture } = chat
  const tile = `[data-terminal-tile="${record.id}"]`
  const shown = `${tile} .chat-content-slot:not([hidden])`
  const view = win.locator(`${shown} [data-testid="folio-view"]`)
  const dockSel = `${shown} [data-testid="folio-work"]`
  const dock = win.locator(dockSel)
  const pill = win.locator(`${dockSel} [data-testid="folio-work-pill"]`)
  const marks = win.locator(`${dockSel} [data-testid="folio-work-mark"]:not([data-leaving])`)
  const rows = win.locator(`${dockSel} [data-testid="folio-work-row"]:not([data-leaving])`)
  const textarea = view.locator('textarea[aria-label="Message"]')
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
  /** The top of the page's first block and of the composer, to the pixel. */
  const geometry = () =>
    view.evaluate((el) => {
      const first = el.querySelector('.folio-page [data-block], .folio-page .folio-head')
      return {
        page: Math.round(first.getBoundingClientRect().top),
        composer: Math.round(el.querySelector('.folio-composer').getBoundingClientRect().top)
      }
    })
  const open = () => dock.getAttribute('data-open')
  try {
    /* 9. The spine, on a book of two pages. */
    await ask(view, 'First question about the invented garden planner.')
    await until(async () => (await view.locator('.folio-count').innerText()).includes('1'))
    await ask(view, 'Second question about the invented garden planner.')
    await until(async () =>
      (await view.locator('.folio-count').innerText()).replace(/\s/g, '') === '2/2' ? true : null
    )
    const spine = await view.locator('.folio-spine').evaluate((nav) => {
      const prev = nav.querySelector('[aria-label="Previous page"]')
      const next = nav.querySelector('[aria-label="Next page"]')
      const ticks = nav.querySelector('.folio-ticks')
      const p = prev.getBoundingClientRect()
      const n = next.getBoundingClientRect()
      const before = (el) =>
        !!(el.compareDocumentPosition(ticks) & Node.DOCUMENT_POSITION_FOLLOWING)
      return {
        adjacent: prev.nextElementSibling === next,
        beforeTicks: before(prev) && before(next),
        gap: Math.round(n.left - p.right),
        sameRow: Math.round(p.top) === Math.round(n.top)
      }
    })
    t.check(
      'Next page is the element right after Previous page, both before the ticks, side by side',
      spine.adjacent && spine.beforeTicks && spine.sameRow && spine.gap >= 0 && spine.gap <= 8,
      spine
    )
    const count = () => view.locator('.folio-count').innerText()
    await view.locator('.folio-spine [aria-label="Previous page"]').click()
    const back = await until(async () =>
      (await count()).replace(/\s/g, '') === '1/2' ? true : null
    )
    await view.locator('.folio-spine [aria-label="Next page"]').click()
    const forth = await until(async () =>
      (await count()).replace(/\s/g, '') === '2/2' ? true : null
    )
    t.check('a click on each still turns the page', !!back && !!forth, { now: await count() })
    await win.waitForTimeout(600)

    /* 1. Two agents and a command start: three marks, no strip, nothing moved. */
    const before = await geometry()
    await inject(fixture, record.id, [
      {
        type: 'tool_call',
        id: 'call-a',
        name: 'Agent',
        input: {
          subagent_type: 'Explore',
          description: 'Survey the seed catalogue',
          run_in_background: true
        }
      },
      {
        type: 'tool_call',
        id: 'call-b',
        name: 'Agent',
        input: {
          subagent_type: 'Plan',
          description: 'Draft the watering rota',
          run_in_background: true
        }
      },
      {
        type: 'tool_call',
        id: 'bash-c',
        name: 'Bash',
        input: { command: 'npm run serve -- --port 4400', run_in_background: true }
      },
      { type: 'tool_result', id: 'bash-c', output: 'Command running in background with ID: c1' },
      {
        type: 'background_tasks',
        tasks: [
          agentTask('task-a', 'call-a', 'Survey the seed catalogue'),
          agentTask('task-b', 'call-b', 'Draft the watering rota'),
          shellTask('c1', 'bash-c', 'npm run serve -- --port 4400')
        ]
      },
      { type: 'subagent_model', parent: 'call-a', model: 'claude-sonnet-5-5' },
      { type: 'tool_call', id: 'a1', name: 'Grep', input: { pattern: 'tulip' }, parent: 'call-a' },
      {
        type: 'tool_call',
        id: 'a2',
        name: 'Read',
        input: { file_path: '/garden/catalogue.md' },
        parent: 'call-a'
      },
      { type: 'context_usage', used: 48_000, window: null, parent: 'call-a' },
      { type: 'state_change', state: 'done' }
    ])
    await until(async () => (await marks.count()) === 3)
    await win.waitForTimeout(700)
    const kinds = await marks.evaluateAll((els) => els.map((el) => el.getAttribute('data-kind')))
    const strip = await view.locator('.folio-composer .work-cards').count()
    const during = await geometry()
    t.check(
      'two agents and a command are three marks of their kinds, and no strip in the composer',
      kinds.join(',') === 'agent,agent,shell' && strip === 0,
      { kinds, strip }
    )
    t.check(
      'the page and the composer did not move when the work started',
      during.page === before.page && during.composer === before.composer,
      { before, during }
    )
    const label = await pill.getAttribute('aria-label')
    t.check(
      "the pill's label says what its marks show",
      label === 'Running now: 2 agents, 1 command',
      label
    )

    /* 2. The pointer over the pill: open after the beat, three rows. */
    await pill.hover()
    const early = await open()
    const hovered = await until(async () => ((await open()) === 'hover' ? true : null), {
      tries: 20,
      gapMs: 50
    })
    await win.waitForTimeout(500)
    const card = await rows.evaluateAll((els) => els.map((el) => el.innerText))
    const head = await win.locator(`${dockSel} .folio-work-head`).innerText()
    t.check(
      'the pointer over the pill opens the card after a beat, not at once',
      early === null && !!hovered,
      { early, hovered }
    )
    t.check(
      'the card counts in the Terminal view’s words and carries a row per running thing',
      /Running now/i.test(head) && head.includes('2 agents · 1 command') && card.length === 3,
      { head, card }
    )
    const [a, b, c] = card
    t.check(
      "an agent's row: the type, the task, the last step, the steps, the context, the time and the model",
      /Explore/.test(a) &&
        /Survey the seed catalogue/.test(a) &&
        /catalogue\.md/.test(a) &&
        /2 steps/.test(a) &&
        /48k ctx/.test(a) &&
        /\d+s/.test(a) &&
        /Sonnet 5\.5/.test(a) &&
        /Plan/.test(b) &&
        /No step yet/.test(b) &&
        /npm run serve -- --port 4400/.test(c),
      { a, b, c }
    )
    await win.mouse.move(5, 5)
    const closed = await until(async () => ((await open()) === null ? true : null), {
      tries: 20,
      gapMs: 50
    })
    t.check('the pointer gone, the card closes', !!closed)
    const after = await geometry()
    t.check(
      'opening and closing the card moved neither the page nor the composer',
      after.page === before.page && after.composer === before.composer,
      { before, after }
    )

    /* 3. The keyboard. */
    await textarea.focus()
    let reached = false
    for (let i = 0; i < 6 && !reached; i++) {
      await win.keyboard.press('Shift+Tab')
      reached = await pill.evaluate((el) => document.activeElement === el)
    }
    const focusOpen = await until(async () => ((await open()) === 'focus' ? true : null), {
      tries: 10,
      gapMs: 50
    })
    await win.keyboard.press('Enter')
    const pinned = await open()
    const expanded = await pill.getAttribute('aria-expanded')
    await win.keyboard.press('Tab')
    const onRow = await win.evaluate(
      () => !!document.activeElement?.closest('[data-testid="folio-work-row"]')
    )
    await win.keyboard.press('Escape')
    await win.waitForTimeout(100)
    const afterEscape = {
      open: await open(),
      onPill: await pill.evaluate((el) => document.activeElement === el)
    }
    t.check(
      'the pill takes the focus and opens, Enter pins it, the rows are reachable',
      reached && !!focusOpen && pinned === 'pinned' && expanded === 'true' && onRow,
      { reached, focusOpen, pinned, expanded, onRow }
    )
    t.check(
      'Escape closes it and the focus is back on the pill',
      afterEscape.open === null && afterEscape.onPill,
      afterEscape
    )
    await textarea.click()
    await inject(fixture, record.id, [
      {
        type: 'tool_call',
        id: 'call-d',
        name: 'Agent',
        input: {
          subagent_type: 'Explore',
          description: 'Check the frost dates',
          run_in_background: true
        }
      },
      {
        type: 'background_tasks',
        tasks: [
          agentTask('task-a', 'call-a', 'Survey the seed catalogue'),
          agentTask('task-b', 'call-b', 'Draft the watering rota'),
          shellTask('c1', 'bash-c', 'npm run serve -- --port 4400'),
          agentTask('task-d', 'call-d', 'Check the frost dates')
        ]
      }
    ])
    await until(async () => (await marks.count()) === 4)
    const caret = await textarea.evaluate((el) => document.activeElement === el)
    t.check(
      'work that starts while the composer has the caret leaves the caret there',
      caret && (await open()) === null,
      { caret, open: await open() }
    )

    /* 4. A row opens its window; the card stays open under it. */
    await pill.click()
    await until(async () => ((await open()) === 'pinned' ? true : null))
    await win.waitForTimeout(500)
    await rows.first().locator('button.folio-work-open').click()
    const peek = win.locator('.term-peek')
    await peek.waitFor()
    const underWindow = await open()
    t.check(
      "a click on an agent's row opens its window, and the card stays open under it",
      /Survey the seed catalogue/.test(await peek.innerText()) && underWindow === 'pinned',
      { underWindow }
    )
    await win.locator('.term-peek button.term-agent-model').click()
    const menu = win.locator('.chat-model-menu[aria-label="Relaunch on"]')
    await menu.waitFor()
    const offered = await menu.locator('.chat-model-option').allInnerTexts()
    await menu.locator('.chat-model-option').last().click()
    const dialog = win.getByRole('dialog', { name: /Relaunch on/ })
    await dialog.waitFor()
    const nothingYet = (await writes()).filter((w) => w?.type === 'stop_task').length === 0
    const underDialog = await open()
    await dialog.getByRole('button', { name: 'Relaunch' }).click()
    const sent = await until(async () => {
      const all = (await writes()).filter((w) => w && typeof w === 'object')
      const stop = all.findIndex((w) => w.type === 'stop_task')
      const askAgain = all.findIndex(
        (w) => w.type === 'user_message' && /model "[a-z0-9.-]+"/.test(w.text)
      )
      return stop >= 0 && askAgain > stop ? { stop: all[stop], ask: all[askAgain].text } : null
    })
    t.check(
      'another model asks first, the card still open, then stop_task and the relaunch are written',
      nothingYet &&
        underDialog === 'pinned' &&
        sent?.stop?.taskId === 'task-a' &&
        /Survey the seed catalogue/.test(sent?.ask ?? ''),
      { offered, nothingYet, underDialog, sent }
    )
    if (await win.locator('.term-peek').count()) await win.keyboard.press('Escape')
    await until(async () => ((await win.locator('.term-peek').count()) === 0 ? true : null))
    if ((await open()) !== 'pinned') {
      await pill.click()
      await until(async () => ((await open()) === 'pinned' ? true : null))
    }
    await win.waitForTimeout(500)
    await win.locator(`${dockSel} [data-testid="folio-work-row"][data-kind="shell"] button`).click()
    const shellPeek = await until(async () => {
      const el = win.locator('.term-peek[aria-label^="Output of"]')
      return (await el.count()) ? true : null
    })
    t.check("a click on a command's row opens the shell's window", !!shellPeek)
    await win.keyboard.press('Escape')
    await until(async () => ((await win.locator('.term-peek').count()) === 0 ? true : null))
    await win.keyboard.press('Escape')
    await win.mouse.move(5, 5)
    await until(async () => ((await open()) === null ? true : null))

    /* 5. A quiet agent: no step for two minutes. */
    await inject(fixture, record.id, [
      {
        type: 'background_tasks',
        tasks: [
          agentTask('task-a', 'call-a', 'Survey the seed catalogue'),
          shellTask('c1', 'bash-c', 'npm run serve -- --port 4400'),
          agentTask('task-q', 'call-q', 'Sort the compost notes', Date.now() - 130_000)
        ]
      }
    ])
    const quietMark = win.locator(`${dockSel} [data-testid="folio-work-mark"][data-quiet]`)
    await until(async () => (await quietMark.count()) === 1)
    const quietRow = win.locator(`${dockSel} [data-testid="folio-work-row"][data-quiet]`)
    const quiet = {
      marks: await quietMark.count(),
      rows: await quietRow.count(),
      says: (await quietRow.count()) ? await quietRow.innerText() : '',
      animations: await quietMark.evaluate(
        (el) => el.getAnimations({ subtree: true }).filter((a) => a.animationName).length
      ),
      othersBreathe: await win
        .locator(`${dockSel} [data-testid="folio-work-mark"]:not([data-quiet])`)
        .first()
        .evaluate(
          (el) => el.getAnimations({ subtree: true }).filter((a) => a.animationName).length
        )
    }
    t.check(
      'a quiet agent: its mark and its row carry data-quiet, the row says quiet, the mark is still',
      quiet.marks === 1 &&
        quiet.rows === 1 &&
        /quiet \d+m/.test(quiet.says) &&
        quiet.animations === 0 &&
        quiet.othersBreathe > 0,
      quiet
    )

    /* 7. Another tab and back: nothing under the dock moves. The marks that
          left in step 5 have folded away first. */
    await until(async () =>
      (await win.locator(`${dockSel} [data-leaving]`).count()) === 0 ? true : null
    )
    await win.locator('.launcher-split .launcher-btn').click()
    const second = await until(async () => {
      const list = await win.evaluate(() => window.electronAPI.sessionsList())
      return list.find((s) => s.adapterId === 'echo' && s.id !== record.id) ?? null
    })
    await win
      .locator(`section.chat-host[data-session-id="${second?.id}"] [data-testid="folio-view"] textarea:not(:disabled)`)
      .first()
      .waitFor()
    await until(async () =>
      (await win.evaluate((sel) => getComputedStyle(document.querySelector(sel)).display, tile)) ===
      'none'
        ? true
        : null
    )
    await win.evaluate(sampler, [dockSel, 30])
    await win.locator(`[data-sidebar-item-id="${record.id}"]`).first().click()
    const frames = await win.evaluate(() => globalThis.__workSample)
    t.check(
      'the tab chosen again shows the dock as it stood, no transition on any frame',
      (await marks.count()) === 3 && frames.length === 0,
      { marks: await marks.count(), frames: frames.slice(0, 3) }
    )
    await textarea.waitFor()

    /* 8. Reduced motion: nothing moves under the dock, closed or open. */
    await win.emulateMedia({ reducedMotion: 'reduce' })
    await win.waitForTimeout(200)
    const stillClosed = await dock.evaluate((el) => el.getAnimations({ subtree: true }).length)
    await pill.click()
    const stillOpen = await dock.evaluate((el) => el.getAnimations({ subtree: true }).length)
    const openedAtOnce = await open()
    t.check(
      'under reduced motion no animation runs under the dock, closed or open',
      stillClosed === 0 && stillOpen === 0 && openedAtOnce === 'pinned',
      { stillClosed, stillOpen, openedAtOnce }
    )
    await pill.click()
    await win.emulateMedia({ reducedMotion: 'no-preference' })

    /* 6. Work ends: a mark leaves and the count follows; the last, the dock. */
    await inject(fixture, record.id, [
      {
        type: 'background_tasks',
        tasks: [
          agentTask('task-a', 'call-a', 'Survey the seed catalogue'),
          shellTask('c1', 'bash-c', 'npm run serve -- --port 4400')
        ]
      }
    ])
    await until(async () => (await marks.count()) === 2)
    const shrunk = await pill.getAttribute('aria-label')
    t.check(
      'an agent ends: its mark leaves and the count follows',
      (await marks.count()) === 2 && shrunk === 'Running now: 1 agent, 1 command',
      shrunk
    )
    await inject(fixture, record.id, [{ type: 'background_tasks', tasks: [] }])
    const gone = await until(async () => ((await dock.count()) === 0 ? true : null), {
      tries: 20,
      gapMs: 100
    })
    const ended = await geometry()
    t.check('the last one ends: the dock is out of the DOM once its fold is over', !!gone)
    t.check(
      'the page and the composer stand where they stood before any work',
      ended.page === before.page && ended.composer === before.composer,
      { before, ended }
    )
  } finally {
    await chat.close()
  }
}
