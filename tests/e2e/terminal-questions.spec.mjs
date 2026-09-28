import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* The Terminal view's pinned questions and what the agent asks. What this spec
   holds in the real app:
   - a one-line question pinned at the top keeps its whole box: nothing of it
     is clipped, and only what hangs under it (the "Interrupted" note) folds;
   - a message taller than the pane is capped and scrolls inside, the cap moved
     by the grip on its bottom edge, kept, and reset by a double-click;
   - the "Other" answer wraps as it is typed, and its record in the transcript
     wraps too and says Answered, even when the agent's state moved on before
     the answer's write came back. */

const ANSWER =
  'a free answer long enough to run well past the width of the dock and of the transcript column, ' +
  'repeated so no pane is wide enough to hold it on one line: ' +
  'a free answer long enough to run well past the width of the dock and of the transcript column'

const filler = (n) =>
  Array.from({ length: n }, (_, i) => ({
    type: 'assistant_text',
    delta: `Paragraph ${i + 1} of the answer, long enough to take a line of its own.\n\n`,
    final: false
  }))

export async function run(t) {
  const fixture = await openChat(
    'terminal-questions',
    ['--dev-echo-view=clave.chat-view/terminal'],
    '[data-testid="terminal-view"] textarea:not(:disabled)'
  )
  const { app, win, record } = fixture
  const view = win.locator('[data-testid="terminal-view"]')
  try {
    await win.evaluate(() => localStorage.removeItem('clave-terminal-question-height'))
    // Pinning is the default; make sure of it.
    const pin = view.getByRole('button', { name: 'Pin the question while its answer scrolls' })
    if ((await pin.getAttribute('aria-pressed')) !== 'true') await pin.click()

    /* 1. A bare one-line question, scrolled past: pinned, never folded. */
    await inject(app, record.id, [
      { type: 'user_message', text: 'one line question' },
      ...filler(40),
      { type: 'assistant_text', delta: 'Done.', final: true },
      { type: 'state_change', state: 'idle' }
    ])
    /* The exchanges are virtualised (rows.tsx): only those near the viewport
       are in the document, so an exchange is found by the start of its
       question, and one out of reach is brought into reach by scrolling down
       from the top until it mounts. */
    const Q0 = 'one line question'
    const Q1 = 'OK well archive the sessions'
    const Q2 = 'line 1 of a very long message'
    const Q3 = 'and after that'
    await win.evaluate(() => {
      const root = () => document.querySelector('[data-testid="terminal-view"] .chat-scroll')
      const turn = (prefix) =>
        [...root().querySelectorAll('.term-turn')].find((section) =>
          section
            .querySelector(':scope > .chat-turn-wrap .chat-turn[data-role="user"]')
            ?.textContent.startsWith(prefix)
        )
      window.__tq = {
        root,
        turn,
        row: (prefix) => turn(prefix)?.querySelector(':scope > .chat-turn-wrap[data-side="end"]')
      }
    })
    const rowOf = (prefix) =>
      view
        .locator('.term-turn', {
          has: win.locator('.chat-turn[data-role="user"]', { hasText: prefix })
        })
        .locator('> .chat-turn-wrap[data-side="end"]')
    const reveal = async (prefix) => {
      if (await win.evaluate((prefix) => !!window.__tq.turn(prefix), prefix)) return
      await win.evaluate(() => (window.__tq.root().scrollTop = 0))
      for (let i = 0; i < 80; i++) {
        await win.waitForTimeout(40)
        if (await win.evaluate((prefix) => !!window.__tq.turn(prefix), prefix)) return
        await win.evaluate(() => {
          const root = window.__tq.root()
          root.scrollTop += root.clientHeight * 0.6
        })
      }
      throw new Error(`exchange never mounted: ${prefix}`)
    }
    // Brings an exchange's head to `by` px above the top edge (negative: below),
    // again once the virtualiser has measured what it laid out at an estimate.
    const scrollInto = async (prefix, by) => {
      await reveal(prefix)
      for (let i = 0; i < 3; i++) {
        await win.evaluate(
          ({ prefix, by }) => {
            const root = window.__tq.root()
            const section = window.__tq.turn(prefix)
            root.scrollTop +=
              section.getBoundingClientRect().top - root.getBoundingClientRect().top + by
          },
          { prefix, by }
        )
        await win.waitForTimeout(60)
      }
    }
    await view.getByText(Q0).waitFor()
    const rowState = (prefix) =>
      win.evaluate((prefix) => {
        const root = window.__tq.root()
        const row = window.__tq.row(prefix)
        const message = row.querySelector('.chat-turn[data-role="user"]')
        const r = row.getBoundingClientRect()
        const m = message.getBoundingClientRect()
        return {
          folded: row.dataset.folded ?? null,
          cut: row.dataset.foldCut ?? null,
          fold: Number.parseFloat(row.style.getPropertyValue('--fold')) || 0,
          rowHeight: r.height,
          // How much of the message's box the fold leaves painted.
          messageShown:
            Math.min(
              m.bottom,
              r.bottom - (Number.parseFloat(row.style.getPropertyValue('--fold')) || 0)
            ) - m.top,
          messageHeight: m.height,
          pinnedAt: r.top - root.getBoundingClientRect().top,
          tall: row.dataset.tall ?? null,
          messageClient: message.clientHeight,
          messageScroll: message.scrollHeight,
          pane: root.clientHeight
        }
      }, prefix)
    await scrollInto(Q0, 300)
    const single = await until(async () => {
      const s = await rowState(Q0)
      return s.pinnedAt < 20 ? s : null
    })
    t.check(
      'a one-line question pinned at the top is not folded',
      single && single.folded === null && single.fold === 0,
      single
    )

    /* 2. An interrupted one-line question: the note folds away, the box stays whole. */
    await inject(app, record.id, [
      { type: 'user_message', text: 'OK well archive the sessions and close their tabs' },
      { type: 'turn_interrupted' },
      ...filler(40),
      { type: 'assistant_text', delta: 'Done.', final: true },
      { type: 'state_change', state: 'idle' }
    ])
    await scrollInto(Q1, 300)
    await rowOf(Q1).locator('.chat-turn-note').waitFor()
    const interrupted = await until(async () => {
      const s = await rowState(Q1)
      return s.pinnedAt < 20 && s.folded ? s : null
    })
    t.check(
      'an interrupted one-line question folds only its note, never into its own box',
      interrupted &&
        interrupted.cut === null &&
        Math.abs(interrupted.messageShown - interrupted.messageHeight) < 1 &&
        interrupted.fold > 0,
      interrupted
    )

    /* 3. A message taller than the pane: capped, scrolling inside, resizable. */
    const long = Array.from({ length: 120 }, (_, i) => `line ${i + 1} of a very long message`).join(
      '\n'
    )
    await inject(app, record.id, [
      { type: 'user_message', text: long },
      ...filler(60),
      { type: 'assistant_text', delta: 'Done.', final: true },
      // Another exchange after it, so the transcript's end never stops the
      // long one from scrolling to the top.
      { type: 'user_message', text: 'and after that' },
      ...filler(40),
      { type: 'assistant_text', delta: 'Done.', final: true },
      { type: 'state_change', state: 'idle' }
    ])
    await reveal(Q3)
    await scrollInto(Q2, -20)
    const tall = await until(async () => {
      const s = await rowState(Q2)
      return s.tall && s.pinnedAt > 0 && s.pinnedAt < 60 ? s : null
    })
    t.check(
      'a message taller than the pane is capped at a share of it and scrolls inside',
      tall &&
        tall.messageClient <= tall.pane * 0.75 + 1 &&
        tall.messageScroll > tall.messageClient + 100,
      tall
    )
    const grip = rowOf(Q2).locator('.term-question-grip')
    await rowOf(Q2).locator('.chat-turn[data-role="user"]').hover()
    // The turns arrive with a short slide; drag once the grip has settled.
    let last = null
    const box = await until(async () => {
      const now = await grip.boundingBox()
      const still = now && last && now.y === last.y
      last = now
      if (!still) await win.waitForTimeout(100)
      return still ? now : null
    })
    t.check(
      'a long message shows its grip on hover',
      !!box && (await grip.isVisible()),
      await grip.evaluate((el) => ({
        display: getComputedStyle(el).display,
        row: { ...el.closest('.chat-turn-wrap').dataset },
        rect: el.getBoundingClientRect().toJSON()
      }))
    )
    const before = tall.messageClient
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await win.mouse.down()
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, { steps: 6 })
    await win.mouse.up()
    const grown = await rowState(Q2)
    const stored = await win.evaluate(() => localStorage.getItem('clave-terminal-question-height'))
    t.check(
      'dragging the grip down raises the cap, and the cap is kept',
      Math.abs(grown.messageClient - (before + 60)) <= 2 && stored !== null,
      { before, after: grown.messageClient, stored }
    )
    const gripNow = await grip.boundingBox()
    await win.mouse.move(gripNow.x + gripNow.width / 2, gripNow.y + gripNow.height / 2)
    await win.mouse.down()
    await win.mouse.move(gripNow.x + gripNow.width / 2, gripNow.y + 4000, { steps: 4 })
    await win.mouse.up()
    const maxed = await rowState(Q2)
    t.check(
      'the cap never goes past three quarters of the pane',
      maxed.messageClient <= maxed.pane * 0.75 + 1 && maxed.messageClient > before + 60,
      maxed
    )
    const gripAgain = await grip.boundingBox()
    await win.mouse.dblclick(gripAgain.x + gripAgain.width / 2, gripAgain.y + gripAgain.height / 2)
    const reset = await rowState(Q2)
    t.check(
      'a double-click on the grip resets the cap',
      Math.abs(reset.messageClient - before) <= 1 &&
        (await win.evaluate(() => localStorage.getItem('clave-terminal-question-height'))) === null,
      { before, after: reset.messageClient }
    )

    /* 3b. Folded, pushed, and gone over the top edge on its own backdrop. */
    const scrollNextTo = (prefix, offset) => scrollInto(prefix, -offset)
    const pair = () =>
      win.evaluate(() => {
        const root = window.__tq.root()
        const row = window.__tq.row('line 1 of a very long message')
        const next = window.__tq.row('and after that')
        const r = row.getBoundingClientRect()
        const fold = Number.parseFloat(row.style.getPropertyValue('--fold')) || 0
        const backdrop = getComputedStyle(row, '::before')
        return {
          stuck: row.dataset.stuck ?? null,
          shown: r.height - fold,
          top: r.top - root.getBoundingClientRect().top,
          gap: next.getBoundingClientRect().top - (r.bottom - fold),
          backdrop: backdrop.content !== 'none' ? backdrop.backgroundColor : null,
          mask: getComputedStyle(root).maskImage
        }
      })
    // The next question well below: the long one is pinned and folded.
    await scrollNextTo(Q3, 400)
    const pinnedLong = await until(async () => {
      const s = await pair()
      return s.stuck && s.top > 0 ? s : null
    })
    t.check(
      'a folded long message is exactly as tall as a one-line message, on a backdrop',
      pinnedLong &&
        Math.abs(pinnedLong.shown - single.messageHeight) <= 1 &&
        // At its sticky place under the top edge, not pushed off it.
        Math.abs(pinnedLong.top - 12) <= 1 &&
        pinnedLong.backdrop !== null &&
        pinnedLong.mask === 'none',
      { pinnedLong, oneLine: single.messageHeight }
    )
    // The next question close under it: pushed, a small gap between the two.
    await scrollNextTo(Q3, 50)
    const pushed = await until(async () => {
      const s = await pair()
      return s.stuck ? s : null
    })
    t.check(
      'the next question pushes a folded one with a small gap, whatever its unfolded height',
      pushed && pushed.gap >= 6 && pushed.gap <= 10,
      pushed
    )
    // Pushed by the scroll itself: within the same frame as a scroll, before
    // any script has run, the pushed question has moved by exactly as much.
    const drift = await win.evaluate(() => {
      const root = window.__tq.root()
      const row = window.__tq.row('line 1 of a very long message')
      const steps = []
      for (let i = 0; i < 5; i++) {
        const before = row.getBoundingClientRect().top
        root.scrollTop += 3
        steps.push(before - row.getBoundingClientRect().top)
      }
      return { steps, translate: getComputedStyle(row).translate }
    })
    t.check(
      'a pushed question moves with the scroll in the same frame, never after it',
      drift.steps.every((d) => Math.abs(d - 3) < 0.5) && drift.translate === 'none',
      drift
    )
    // Further: the pushed question leaves over the top edge, not under a strip.
    await scrollNextTo(Q3, 20)
    const leaving = await pair()
    t.check(
      'a pushed question scrolls on over the top edge',
      leaving.top < 0 && leaving.gap >= 6 && leaving.gap <= 10,
      leaving
    )

    /* 4. "Other": the field wraps, the record wraps and says Answered. */
    await app.evaluate(({ ipcMain, BrowserWindow }, id) => {
      const original = ipcMain._invokeHandlers.get('sessions:write')
      ipcMain._invokeHandlers.set('sessions:write', (event, sid, input) => {
        if (input.type !== 'permission_response') return original(event, sid, input)
        // The adapter leaves blocked the moment it has the reply: that state
        // reaches the pane before the write's own answer does.
        BrowserWindow.getAllWindows()[0].webContents.send(`sessions:stream:${id}`, {
          kind: 'event',
          event: { type: 'state_change', state: 'working' }
        })
      })
    }, record.id)
    await inject(app, record.id, [
      { type: 'user_message', text: 'ask me something' },
      {
        type: 'permission_request',
        id: 'ask-other',
        description: 'Claude asks a question',
        toolName: 'AskUserQuestion',
        input: {},
        questions: [
          {
            question: 'Which one?',
            options: [{ label: 'This' }, { label: 'That' }]
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
    const other = dock.getByPlaceholder('Type your own answer')
    await other.fill(ANSWER)
    const field = await other.evaluate((el) => ({
      tag: el.tagName,
      height: el.clientHeight,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      line: Number.parseFloat(getComputedStyle(el).lineHeight)
    }))
    t.check(
      'the Other answer wraps onto more lines as it is typed',
      field.tag === 'TEXTAREA' &&
        field.height > field.line * 1.5 &&
        field.scrollWidth <= field.clientWidth,
      field
    )
    await other.press('Enter')
    await dock.locator('.chat-prompt-review').waitFor()
    await win.keyboard.press('Enter')
    await dock.waitFor({ state: 'detached' })
    // The dock leaves on the state change, before the answer lands on the record.
    // The record sits in the last exchange: bring the end into reach.
    await reveal('ask me something')
    await win.evaluate(() => {
      const root = window.__tq.root()
      root.scrollTop = root.scrollHeight
    })
    const row = view.locator('.chat-permission-row').last()
    await until(async () => (await row.locator('.chat-permission-row-answer').count()) === 1)
    const record_ = await row.evaluate((el) => {
      const column = el.closest('.chat-column').getBoundingClientRect()
      const answer = el.querySelector('.chat-permission-row-answer').getBoundingClientRect()
      return {
        text: el.innerText,
        state: el.dataset.state,
        overflow: answer.right - column.right,
        lines: answer.height
      }
    })
    t.check(
      "the answer's record says Answered and stays inside the column",
      /Answered/.test(record_.text) &&
        !/No longer awaiting/.test(record_.text) &&
        record_.state === 'answered' &&
        record_.overflow <= 0.5,
      record_
    )
  } finally {
    await fixture.close()
  }
}
