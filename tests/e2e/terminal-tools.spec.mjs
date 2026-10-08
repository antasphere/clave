import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* The Terminal view's tool runs. What this spec holds in the real app:
   - every run has a title counting what was done, a lone call included, and
     the title carries no kind icon, only its chevron; the calls, each with its
     kind icon, are one level down;
   - a run opens and closes by animating its height;
   - a run in flight says what it waits on; a call left without a result by
     its turn ending is no longer running, it says it got no result;
   - a failure is counted in the title and marked on its call. */

export async function run(t) {
  const chat = await openChat(
    'terminal-tools',
    ['--dev-echo-view=clave.chat-view/terminal'],
    '[data-testid="terminal-view"] textarea:not(:disabled)'
  )
  const { win, record, fixture } = chat
  const view = win.locator('[data-testid="terminal-view"]')
  const runs = view.locator('.term-tools')
  try {
    /* 1. A lone call: a title of its own, no kind icon on it. */
    await inject(fixture, record.id, [
      { type: 'user_message', text: 'read it' },
      { type: 'tool_call', id: 't1', name: 'Read', input: { file_path: '/repo/src/app.ts' } },
      { type: 'tool_result', id: 't1', output: 'export const app = 1' },
      { type: 'assistant_text', delta: 'Read.', final: true },
      { type: 'state_change', state: 'idle' }
    ])
    await runs.first().waitFor()
    const lone = await runs.first().evaluate((el) => ({
      title: el.querySelector('.term-tools-title')?.textContent,
      rowIcons: el.querySelectorAll(':scope > summary svg').length,
      chevron: !!el.querySelector(':scope > summary .term-tools-chevron'),
      calls: el.querySelectorAll('.term-call').length
    }))
    t.check(
      'a lone call has a counted title with only the chevron on it',
      lone.title === 'Read 1 file' && lone.rowIcons === 1 && lone.chevron && lone.calls === 1,
      lone
    )

    /* 2. Opening animates the height, and the call keeps its kind icon. */
    const heights = await runs.first().evaluate(async (el) => {
      const body = el.querySelector('.term-tools-body')
      el.querySelector('summary').click()
      const seen = []
      for (let i = 0; i < 30; i++) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        seen.push(Math.round(el.getBoundingClientRect().height))
      }
      return { seen, body: body.getBoundingClientRect().height }
    })
    const first = heights.seen[0]
    const last = heights.seen.at(-1)
    const between = heights.seen.filter((h) => h > first && h < last).length
    t.check(
      'a run opens by growing through intermediate heights',
      last > first && between >= 2,
      heights.seen
    )
    const call = runs.first().locator('.term-call')
    t.check(
      'an opened call is led by its kind icon',
      (await call.locator('.term-call-icon').count()) === 1 &&
        /Read\s*\/repo\/src\/app\.ts/.test(await call.locator('.term-call-row').innerText()),
      await call.innerText()
    )

    // A call shows its way in on approach: a chevron at the row's end.
    const chevron = call.locator('.term-call-chevron')
    const opacity = () => chevron.evaluate((el) => Number(getComputedStyle(el).opacity))
    await view.locator('.chat-transcript').hover({ position: { x: 5, y: 5 } })
    const resting = await until(async () => (await opacity()) === 0)
    await call.locator('.term-call-row').hover()
    const approached = await until(async () => (await opacity()) === 1)
    t.check(
      'a call row shows a chevron at its end on hover, none at rest',
      resting === true && approached === true,
      { resting, approached }
    )

    /* 3. In flight, then left without a result by an interrupted turn. */
    await inject(fixture, record.id, [
      { type: 'user_message', text: 'run the tests' },
      { type: 'state_change', state: 'working' },
      { type: 'tool_call', id: 'c1', name: 'Bash', input: { command: 'npm test' } },
      { type: 'tool_result', id: 'c1', output: 'ok' },
      { type: 'tool_call', id: 'c2', name: 'Bash', input: { command: 'npm run e2e' } }
    ])
    await until(async () => (await runs.count()) === 2)
    const live = runs.nth(1)
    await until(async () => (await live.getAttribute('data-state')) === 'running')
    const flight = await live.evaluate((el) => ({
      title: el.querySelector('.term-tools-title')?.textContent,
      now: el.querySelector('.term-tools-now')?.textContent,
      animation: getComputedStyle(el.querySelector('.term-tools-title')).animationName
    }))
    t.check(
      'a run in flight shimmers and names the call it waits on',
      flight.title === 'Ran 2 commands' &&
        /npm run e2e/.test(flight.now ?? '') &&
        flight.animation === 'term-shimmer',
      flight
    )
    await inject(fixture, record.id, [
      { type: 'turn_interrupted' },
      { type: 'state_change', state: 'idle' }
    ])
    await until(async () => (await live.getAttribute('data-state')) !== 'running')
    const stopped = await live.evaluate((el) => ({
      state: el.dataset.state,
      now: el.querySelectorAll('.term-tools-now').length,
      calls: [...el.querySelectorAll('.term-call')].map((c) => c.dataset.state),
      note: el.querySelector('.term-call[data-state="stopped"] .term-call-note')?.textContent
    }))
    t.check(
      'a call its turn left without a result stops running and says so',
      stopped.now === 0 &&
        stopped.calls.join() === 'complete,stopped' &&
        stopped.note === 'no result',
      stopped
    )

    /* 4. A failure: counted in the title, marked on its call. */
    await inject(fixture, record.id, [
      { type: 'user_message', text: 'try again' },
      { type: 'state_change', state: 'working' },
      { type: 'tool_call', id: 'f1', name: 'Bash', input: { command: 'false' } },
      { type: 'tool_result', id: 'f1', output: 'exit 1', error: true },
      { type: 'tool_call', id: 'f2', name: 'Edit', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'f2', output: 'done' },
      { type: 'assistant_text', delta: 'Done.', final: true },
      { type: 'state_change', state: 'idle' }
    ])
    await until(async () => (await runs.count()) === 3)
    const failed = await runs.nth(2).evaluate((el) => ({
      title: el.querySelector('.term-tools-title')?.textContent,
      failed: el.querySelector('.term-tools-failed')?.textContent,
      calls: [...el.querySelectorAll('.term-call')].map((c) => c.dataset.state),
      // The failed call's mark is red, its neighbour's is not.
      inks: [...el.querySelectorAll('.term-call-icon')].map((i) => getComputedStyle(i).color)
    }))
    t.check(
      'a failure is counted in the title and marked on its call',
      failed.title === 'Ran 1 command, edited 1 file' &&
        failed.failed === '1 failed' &&
        failed.calls.join() === 'failed,complete' &&
        failed.inks[0] !== failed.inks[1],
      failed
    )

    /* 5. A run sits closer to the words that led to it than to what follows. */
    await inject(fixture, record.id, [
      { type: 'user_message', text: 'look around' },
      { type: 'assistant_text', delta: 'Checking the layout first.', final: true },
      { type: 'tool_call', id: 'g1', name: 'Grep', input: { pattern: 'layout' } },
      { type: 'tool_result', id: 'g1', output: 'src/layout.ts' },
      { type: 'assistant_text', delta: 'Found it in the layout file.', final: true },
      { type: 'state_change', state: 'idle' }
    ])
    const spaced = view.locator('.term-turn').last()
    await until(async () => (await spaced.locator('.term-tools').count()) === 1)
    const gaps = await spaced.evaluate((turn) => {
      const run = turn.querySelector(':scope > .term-tools')
      const above = run.previousElementSibling.getBoundingClientRect()
      const below = run.nextElementSibling.getBoundingClientRect()
      const own = run.getBoundingClientRect()
      return { above: own.top - above.bottom, below: below.top - own.bottom }
    })
    t.check(
      'a tool run is nearer the text above it than the text below',
      gaps.above > 0 && gaps.below - gaps.above >= 8,
      gaps
    )
  } finally {
    await chat.close()
  }
}
