import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* The Terminal view's pinned questions and what the agent asks. What this spec
   holds in the real app:
   - a pinned question is plain sticky: whole, never clipped, on a backdrop,
     moved by the scroll in the same frame and pushed out by the next one;
   - a message is never capped nor scrolled inside: a long one stands whole
     and, too tall to pin, scrolls away with its exchange;
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
    const QL = 'line 1 of a very long message'
    const Q2 = 'line 1 of a three-line message'
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
          clip: getComputedStyle(row).clipPath,
          messageClip: getComputedStyle(message).clipPath,
          rowHeight: r.height,
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
      'a pinned question keeps its whole box, nothing clipped',
      single && single.clip === 'none' && single.messageClip === 'none',
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
      return s.pinnedAt < 20 ? s : null
    })
    const note = await rowOf(Q1).locator('.chat-turn-note').isVisible()
    t.check(
      'a pinned interrupted question keeps its note with it',
      interrupted && interrupted.clip === 'none' && note,
      { interrupted, note }
    )

    /* 3. A message taller than the pane: whole, no inner scroll, not pinned. */
    const long = Array.from({ length: 120 }, (_, i) => `line ${i + 1} of a very long message`).join(
      '\n'
    )
    await inject(app, record.id, [
      { type: 'user_message', text: long },
      ...filler(60),
      { type: 'assistant_text', delta: 'Done.', final: true },
      // A short message pinned and pushed by the one after it (3b).
      { type: 'user_message', text: `${Q2}\nline 2\nline 3` },
      ...filler(60),
      { type: 'assistant_text', delta: 'Done.', final: true },
      // Another exchange after it, so the transcript's end never stops the
      // short one from scrolling to the top.
      { type: 'user_message', text: Q3 },
      ...filler(40),
      { type: 'assistant_text', delta: 'Done.', final: true },
      { type: 'state_change', state: 'idle' }
    ])
    await reveal(Q3)
    await scrollInto(QL, 40)
    const whole = await until(async () => {
      const s = await rowState(QL)
      return s.tall ? s : null
    })
    t.check(
      'a message taller than the pane stands whole, never scrolling inside',
      whole && whole.messageScroll <= whole.messageClient + 1 && whole.messageHeight > whole.pane,
      whole
    )
    t.check(
      'a message too tall to pin scrolls away with its exchange',
      whole && whole.pinnedAt < -20,
      whole
    )
    t.check('a short message is not marked too tall to pin', single && single.tall === null, single)

    /* 3b. Pinned on its backdrop, pushed by the scroll, gone over the top edge. */
    const scrollNextTo = (prefix, offset) => scrollInto(prefix, -offset)
    const pair = () =>
      win.evaluate(() => {
        const root = window.__tq.root()
        const row = window.__tq.row('line 1 of a three-line message')
        const next = window.__tq.row('and after that')
        const r = row.getBoundingClientRect()
        const backdrop = getComputedStyle(row, '::before')
        const nextBand =
          next.getBoundingClientRect().top +
          (Number.parseFloat(getComputedStyle(next, '::before').top) || 0)
        return {
          top: r.top - root.getBoundingClientRect().top,
          gap: next.getBoundingClientRect().top - r.bottom,
          // How far the next question's backdrop reaches over this one.
          overlap: r.bottom - nextBand,
          backdrop: backdrop.content !== 'none' ? backdrop.backgroundColor : null,
          clip: getComputedStyle(row).clipPath
        }
      })
    // The next question well below: the short one is pinned, whole, at its place.
    await scrollNextTo(Q3, 400)
    const pinnedLong = await until(async () => {
      const s = await pair()
      return s.top > 0 && Math.abs(s.top - 8) <= 1 ? s : null
    })
    t.check(
      'a pinned multi-line message sits under the top edge, whole, on a backdrop',
      pinnedLong && pinnedLong.backdrop !== null && pinnedLong.clip === 'none',
      pinnedLong
    )
    // The next question close under it: pushed up by it, off its sticky place.
    await scrollNextTo(Q3, 50)
    const pushed = await pair()
    t.check(
      'the next question pushes a pinned one off its place, 8px between them, its backdrop short of it',
      pushed.top < 8 && pushed.gap >= 7 && pushed.gap <= 9 && pushed.overlap <= 0.5,
      pushed
    )
    // Pushed by the scroll itself: within the same frame as a scroll, before
    // any script has run, the pushed question has moved by exactly as much.
    const drift = await win.evaluate(() => {
      const root = window.__tq.root()
      const row = window.__tq.row('line 1 of a three-line message')
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
    // It stays in the document until it is off screen: the virtualiser once
    // unmounted it as soon as its exchange's box had left the top, while the
    // pushed question still hung, visible, in the gap above the next one.
    const blink = await win.evaluate(async () => {
      const root = window.__tq.root()
      const edge = () => root.getBoundingClientRect().top
      const gone = []
      for (let i = 0; i < 40; i++) {
        root.scrollTop += 2
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        const row = window.__tq.row('line 1 of a three-line message')
        if (!row) {
          gone.push(i)
          continue
        }
        if (row.getBoundingClientRect().bottom <= edge()) break
      }
      return gone
    })
    t.check('a pushed question is never unmounted while it is on screen', blink.length === 0, {
      unmountedAtSteps: blink
    })
    // Further: the pushed question leaves over the top edge.
    await scrollNextTo(Q3, 20)
    const leaving = await pair()
    t.check('a pushed question scrolls on over the top edge', leaving.top < 0, leaving)

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
