import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* The work cards under a chat's composer stand still when the tab comes
   back (PRDCT-4419). A chat tab nobody is looking at is hidden with
   `display: none`, and leaving it started every entering transition again:
   the cards that stood still a moment ago folded open once more at each
   return. What this spec holds in the real app:
   - a card that arrives while the chat is on screen still folds open (the
     sampler below sees it, which is what makes its silence later mean
     something);
   - another tab chosen hides the chat; choosing the chat again shows its
     cards as they stood, no transition running on any frame after;
   - the same between the views of one tab, Chat to Enclave and back. */

/** Watch `selector` for `frames` frames and report each frame that was
 *  painted with a CSS transition running under it, or a card not fully
 *  opaque. Read after the frame (a timer queued from its animation frame
 *  callback runs once it is painted): a read inside the callback itself
 *  forces the style there, before the frame's resize observations, and would
 *  report what the page settles before anything is painted. */
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
        const opacities = [...root.querySelectorAll('.work-card')].map(
          (card) => +getComputedStyle(card).opacity
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

const shell = (id, command) => ({
  id,
  kind: 'shell',
  description: command,
  toolUseId: `bash-${id}`,
  startedAt: Date.now()
})

export async function run(t) {
  const chat = await openChat('chat-work-cards-reveal')
  const { win, record, fixture } = chat
  const tile = `[data-terminal-tile="${record.id}"]`
  // Every view of the tab is mounted, the ones not on screen hidden.
  const shownView = `${tile} .chat-content-slot:not([hidden])`
  const cards = win.locator(`${shownView} .work-card:not([data-leaving])`)
  try {
    /* 1. A command left running: its card, settled. */
    await inject(fixture, record.id, [
      {
        type: 'tool_call',
        id: 'bash-b1',
        name: 'Bash',
        input: { command: 'npm run dev', run_in_background: true }
      },
      { type: 'tool_result', id: 'bash-b1', output: 'Command running in background with ID: b1' },
      { type: 'background_tasks', tasks: [shell('b1', 'npm run dev')] },
      { type: 'state_change', state: 'done' }
    ])
    await until(async () => (await cards.count()) === 1)
    await win.waitForTimeout(800)

    /* 2. A second command arrives while the chat is on screen: it folds open. */
    await win.evaluate(sampler, [`${shownView} .work-cards`, 60])
    await inject(fixture, record.id, [
      { type: 'background_tasks', tasks: [shell('b1', 'npm run dev'), shell('b2', 'npm test')] }
    ])
    const arrival = await win.evaluate(() => globalThis.__workSample)
    t.check(
      'a card that arrives while the chat is on screen folds open',
      (await cards.count()) === 2 && arrival.length > 0,
      { cards: await cards.count(), frames: arrival.length }
    )
    await win.waitForTimeout(800)

    /* 3. Another tab chosen: the chat is hidden. */
    await win.locator('.launcher-split .launcher-btn').click()
    const second = await until(async () => {
      const list = await win.evaluate(() => window.electronAPI.sessionsList())
      return list.find((s) => s.adapterId === 'echo' && s.id !== record.id) ?? null
    })
    await win
      .locator(
        `section.chat-host[data-session-id="${second?.id}"] [data-testid="chat-view"] textarea:not(:disabled)`
      )
      .waitFor()
    const hidden = await until(async () =>
      (await win.evaluate((sel) => getComputedStyle(document.querySelector(sel)).display, tile)) ===
      'none'
        ? true
        : null
    )
    t.check('choosing another tab hides the chat', hidden === true)

    /* 4. The chat chosen again: its cards stand as they stood. */
    await win.evaluate(sampler, [`${shownView} .work-cards`, 30])
    await win.locator(`[data-sidebar-item-id="${record.id}"]`).first().click()
    const back = await win.evaluate(() => globalThis.__workSample)
    const shown = await win.evaluate(
      (sel) => getComputedStyle(document.querySelector(sel)).display,
      tile
    )
    t.check(
      'the chat chosen again shows its cards at once, no transition on any frame',
      shown !== 'none' && (await cards.count()) === 2 && back.length === 0,
      { shown, cards: await cards.count(), frames: back }
    )

    /* 5. Another view of the same tab, then back: the cards of each stand as
          they stood (the slot of a view not on screen is `hidden`). */
    const switchTo = async (title) => {
      await win.locator(`${tile} [aria-label="Session menu"]`).click()
      const item = win.locator('.view-tile', { hasText: title })
      await item.waitFor()
      await win.waitForTimeout(500)
      await win.evaluate(sampler, [`${shownView} .work-cards`, 30])
      await item.click({ force: true })
      return win.evaluate(() => globalThis.__workSample)
    }
    const enclave = await switchTo(/^Enclave$/)
    await win.locator(`${tile} .terminal-view textarea:not(:disabled)`).waitFor()
    const inEnclave = await cards.count()
    await win.waitForTimeout(500)
    const chatAgain = await switchTo(/^Chat$/)
    await win.locator(`${tile} [data-testid="chat-view"] textarea:not(:disabled)`).waitFor()
    t.check(
      'switching the tab to the Enclave view and back moves no card on either side',
      inEnclave === 2 && enclave.length === 0 && chatAgain.length === 0,
      { inEnclave, enclave, chatAgain }
    )
  } finally {
    await chat.close()
  }
}
