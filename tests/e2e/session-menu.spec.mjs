/**
 * The chat pane's header after the session menu pass (8 November 2026):
 *
 * 1. An agent's copy offer (clave_offer_copy) shows its button in a CHAT
 *    pane's header. Only the terminal header mounted it, so an agent in a chat
 *    tab pointed the reader at a button nobody could see.
 * 2. The composer is drawn above the transcript's fade: its hairline is a
 *    box-shadow, and the half pixel of it above the box lay under the fade's
 *    solid foot, which cut the composer's top edge.
 * 3. The ⋯ session menu replaced the view picker: the views as radio tiles,
 *    the transcript copied as Markdown (read from the MAIN process clipboard,
 *    so the check sees what actually landed), the folder path.
 *
 * Each check fails on the code before the pass: no copy button in the chat
 * header, the composer at z-index auto under a fade at 5, no "Session menu".
 */
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

const readClipboard = (app) => app.evaluate(({ clipboard }) => clipboard.readText())

export async function run(t) {
  const chat = await openChat('session-menu')
  const { app, win, record, fixture } = chat
  try {
    const host = win.locator(`.chat-host[data-session-id="${record.id}"]`)
    await inject(fixture, record.id, [
      { type: 'user_message', text: 'Why is the composer edge cut? marker-7c1' },
      { type: 'assistant_text', delta: 'The fade paints over it. marker-9e4', final: true }
    ])
    await host.getByText('marker-9e4').waitFor()

    // ── 1. The copy offer reaches the chat header ─────────────────────────────
    const copyButton = host.getByRole('button', { name: 'Copyable values', exact: true })
    t.equal('no copy button before the agent offers anything', await copyButton.count(), 0)
    // Main's own broadcast, as copy-offer-manager sends it after a
    // clave_offer_copy from this session's agent.
    await app.evaluate(({ BrowserWindow }, id) => {
      for (const w of BrowserWindow.getAllWindows())
        w.webContents.send('copy-offer:changed', [
          {
            id: 'offer-1',
            callerSessionId: id,
            label: 'The deploy command',
            preview: 'npm run deploy',
            truncated: false,
            lineCount: 1,
            charCount: 14,
            sensitive: false,
            createdAt: Date.now()
          }
        ])
    }, record.id)
    t.check(
      'the offer shows its copy button in the chat pane header',
      await until(async () => ((await copyButton.count()) === 1 ? true : null))
    )
    await copyButton.click()
    t.check(
      'and the button opens the offered value',
      await until(async () =>
        (await win.getByText('The deploy command').count()) > 0 ? true : null
      )
    )
    await win.keyboard.press('Escape')

    // ── 2. The composer sits above the transcript's fade ──────────────────────
    const stacking = await host.evaluate((el) => {
      const composer = el.querySelector('.chat-composer')
      const transcript = el.querySelector('.chat-transcript')
      return {
        composer: getComputedStyle(composer).zIndex,
        position: getComputedStyle(composer).position,
        fade: getComputedStyle(transcript, '::after').zIndex
      }
    })
    t.check(
      'the composer is stacked above the fade at the transcript foot',
      stacking.position !== 'static' &&
        Number(stacking.composer) > Number(stacking.fade) &&
        Number.isFinite(Number(stacking.fade)),
      stacking
    )

    // ── 3. The session menu ───────────────────────────────────────────────────
    const trigger = host.getByRole('button', { name: 'Session menu', exact: true })
    t.equal(
      'the menu names the view on screen',
      await trigger.getAttribute('data-view-title'),
      'Chat'
    )
    await trigger.click()
    const menu = win.locator('[role="menu"][aria-label="Session menu"]')
    await menu.waitFor()
    const tiles = menu.getByRole('menuitemradio')
    const titles = (await tiles.allInnerTexts()).map((s) => s.trim())
    t.check('the views are tiles in the menu, Chat among them', titles.includes('Chat'), titles)
    t.equal(
      'the view on screen is the checked tile',
      await menu
        .getByRole('menuitemradio', { name: 'Chat', exact: true })
        .getAttribute('aria-checked'),
      'true'
    )
    t.check(
      'every tile carries its drawing',
      (await menu.locator('.view-tile svg.view-drawing').count()) === titles.length
    )
    for (const row of ['Copy as Markdown', 'Save as Markdown…', 'Copy folder path'])
      t.check(
        `the menu offers "${row}"`,
        (await menu.getByRole('menuitem', { name: row }).count()) === 1
      )

    await app.evaluate(({ clipboard }) => clipboard.writeText('__not-copied-yet__'))
    await menu.getByRole('menuitem', { name: 'Copy as Markdown' }).click()
    const copied = await until(async () => {
      const text = await readClipboard(app)
      return text.includes('marker-9e4') ? text : null
    })
    t.check('Copy as Markdown puts the conversation on the clipboard', copied, copied)
    t.check(
      'as Markdown: who spoke, then what they said, in order',
      typeof copied === 'string' &&
        /^## You · \d\d:\d\d$/m.test(copied) &&
        copied.indexOf('marker-7c1') < copied.indexOf('marker-9e4'),
      copied
    )
    t.check(
      'the menu closes itself once the copy is done',
      await until(async () => ((await menu.count()) === 0 ? true : null))
    )
  } finally {
    await chat.close()
  }
}
