// The terminal view's status line keeps to one line inside its width: as the
// pane narrows it drops its least needed items first (the permission mode,
// then the effort, then the folder, the running count, the account, the
// context), the model and the pin and attach buttons always stay, and nothing
// ever runs past the row's edge. The model, effort and mode chips sit at one
// even spacing.
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

const ORDER = ['7', '6', '5', '4', '3', '2']

export async function run(t) {
  const chat = await openChat(
    'term-status-fit',
    ['--dev-echo-view=clave.chat-view/terminal'],
    '[data-testid="terminal-view"] textarea:not(:disabled)'
  )
  const { app, win, record, fixture } = chat
  const row = win.locator('[data-testid="terminal-view"] .term-status')
  const read = () =>
    row.evaluate((el) => ({
      width: el.clientWidth,
      overflow: el.scrollWidth - el.clientWidth,
      hidden: [...el.querySelectorAll(':scope > [data-fit-hidden]')].map((n) => n.dataset.fitDrop),
      present: [...el.querySelectorAll(':scope > [data-fit-drop]')].map((n) => n.dataset.fitDrop),
      model: !!el.querySelector('.term-model:not([data-fit-drop]) .chat-model-trigger'),
      end: el.querySelector('.term-status-end')?.getBoundingClientRect().width ?? 0
    }))
  try {
    await inject(fixture, record.id, [
      { type: 'session_meta', model: 'claude-opus-5-5', providerSessionId: null },
      { type: 'context_usage', used: 150_000, window: null },
      { type: 'effort', effort: 'medium' },
      {
        type: 'permission_mode',
        mode: 'bypassPermissions',
        modes: [
          { id: 'default', label: 'Ask' },
          { id: 'bypassPermissions', label: 'YOLO' }
        ]
      }
    ])
    await row.locator('.term-mode').waitFor()
    await until(async () => ((await row.innerText()).includes('150k') ? true : null))

    const setWidth = (w) =>
      app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setSize(w, 900), w)

    await setWidth(1800)
    await until(async () => ((await read()).hidden.length === 0 ? true : null))
    const wide = await read()
    t.check(
      'wide: every item shows and the row fits',
      wide.hidden.length === 0 && wide.overflow <= 0,
      wide
    )

    // The chips' spacing: neighbouring chips (model, effort when the model
    // offers one, mode) touch box to box, so the space between their words is
    // their two paddings and nothing else, the same for every pair. The mode
    // used to carry the row's 12px gap on top, and read further away.
    const gaps = await row.evaluate((el) => {
      const chips = [
        el.querySelector('.term-model:not([data-fit-drop]) .chat-model-trigger'),
        el.querySelector('.term-model[data-fit-drop] .chat-model-trigger'),
        el.querySelector('.term-mode .chat-model-trigger')
      ].filter(Boolean)
      const out = []
      for (let i = 1; i < chips.length; i++) {
        const a = chips[i - 1]
        const b = chips[i]
        out.push({
          space: Math.round(b.getBoundingClientRect().left - a.getBoundingClientRect().right),
          padding: Math.round(
            parseFloat(getComputedStyle(a).paddingRight) +
              parseFloat(getComputedStyle(b).paddingLeft)
          )
        })
      }
      return out
    })
    t.check(
      'neighbouring chips sit apart by their own padding only, the same for every pair',
      gaps.length > 0 && gaps.every((g) => Math.abs(g.space) <= 1 && g.padding > 0),
      gaps
    )

    // No item may shrink: one that could let its text spill over its
    // neighbours without the row counting as too wide.
    const shrinkers = await row.evaluate((el) =>
      [...el.querySelectorAll(':scope > *, :scope > .term-fit > *')]
        .filter((n) => getComputedStyle(n).display !== 'contents')
        .filter((n) => getComputedStyle(n).flexShrink !== '0')
        .map((n) => n.className)
    )
    t.equal('no item of the row can shrink and spill over its neighbours', shrinkers.length, 0)

    let previous = []
    let ordered = true
    let fitted = true
    let kept = true
    for (let w = 1600; w >= 760; w -= 60) {
      await setWidth(w)
      await new Promise((r) => setTimeout(r, 150))
      const now = await read()
      if (now.overflow > 0) fitted = false
      if (!now.model || now.end < 20) kept = false
      // What is hidden is always the top of the drop order, never a gap in it.
      const expected = ORDER.filter((n) => now.present.includes(n)).slice(0, now.hidden.length)
      if (JSON.stringify([...now.hidden].sort()) !== JSON.stringify([...expected].sort()))
        ordered = false
      if (now.hidden.length < previous.length) ordered = false
      previous = now.hidden
    }
    t.check('narrowing never lets the row run past its edge', fitted)
    t.check('items go in the order: mode, effort, folder, running, account, context', ordered)
    t.check('the model and the pin and attach buttons always stay', kept)
    t.check('at the narrowest, items were dropped', previous.length > 0, previous)

    await setWidth(1800)
    const back = await until(async () => ((await read()).hidden.length === 0 ? true : null))
    t.check('widening brings every item back', !!back)
  } finally {
    await chat.close()
  }
}
