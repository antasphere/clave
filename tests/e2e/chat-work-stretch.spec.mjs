import assert from 'node:assert/strict'
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* The agent's WORKING NOTES fold into one card once the turn is over
   (PRDCT-4212), in both views. What this spec holds on the real app, that
   the unit tests of the rule (chat-stretches.test.ts) cannot:
   - while the turn runs, every note is in the transcript at full size;
   - once the conversation goes idle, the notes fold into one card and the
     answer stays outside it, in the transcript;
   - the card's face: the counts, the first note until the digest lands, then
     the digest's title, and the note the digest flagged verbatim in accent;
   - the card opens to one step per note, each with its tool run under it,
     and the flagged step is marked;
   - an agent that carries on after its answer without a new message (a
     background task reporting back) starts a new turn: the answer stays;
   - a question the agent asked is a boundary: it stays on its own row, and
     the notes on each side fold into two cards; a permission the agent asked
     for a tool folds inside;
   - a message that arrives while the agent works ends nothing: the work
     before it stays as it is until the turn is over, then folds apart;
   - the preference: off in Settings → Appearance, every line is back; the
     toolbar button turns it on again, and the choice is kept.
   Under the harness no model runs: the digest's reply comes from
   CLAVE_E2E_WORK_DIGEST_REPLY, read as a real one would be. */

const working = { type: 'state_change', state: 'working' }
const idle = { type: 'state_change', state: 'idle' }
let n = 0
const call = (name = 'Bash') => {
  const id = `ws-${++n}`
  return [
    {
      type: 'tool_call',
      id,
      name,
      input: name === 'Bash' ? { command: `cmd ${id}` } : { file_path: `/${id}.ts` }
    },
    { type: 'tool_result', id, output: 'ok' }
  ]
}
const note = (text, calls = 1) => [
  { type: 'assistant_text', delta: text, final: true },
  ...Array.from({ length: calls }, () => call()).flat()
]

const NOTES = [
  '```ts\nconst fix = 1\n```\nFormatting the first fix, then investigating the second error.',
  'Typecheck: web is clean; node has 8 errors that exist on dev too.',
  'Still tracing where the **composer** builds the tab attachment.\n\nShould I keep the `legacy` path?',
  'Write path understood: the server client validates the dropped tab.'
]
/** A phrase of each note the open card must show (markdown rendered). */
const NOTE_KEYS = [
  'Formatting the first fix',
  'Typecheck: web is clean',
  'Should I keep the legacy path?',
  'Write path understood'
]
/** The flagged note as the face reads it: whole, its marks dropped. */
const FLAG_TEXT =
  'Still tracing where the composer builds the tab attachment.\nShould I keep the legacy path?'
/** The first note's first plain line, the title before the digest lands. */
const FALLBACK_TITLE = 'Formatting the first fix, then investigating the second error.'
const ANSWER = 'I fixed both errors and the unit tests for the new code pass.'
const TITLE = 'Traced and fixed the attachment check'
const REPLY = JSON.stringify({ title: TITLE, needs_you: true, note: 3 })

export async function run(t) {
  for (const mode of ['chat', 'terminal']) {
    const args = mode === 'terminal' ? ['--dev-echo-view=clave.chat-view/terminal'] : []
    const ready = `[data-testid="${mode}-view"] textarea:not(:disabled)`
    const chat = await openChat(`work-stretch-${mode}`, args, ready, {
      CLAVE_E2E_WORK_DIGEST_REPLY: REPLY
    })
    const { win, record, fixture } = chat
    const view = win.locator(`[data-testid="${mode}-view"]`)
    const cards = view.locator('.work-stretch')
    const toolRow = mode === 'chat' ? '.chat-tool-run' : '.term-tools'
    /** The agent's turns outside any card, by their text. */
    const outside = () =>
      view
        .locator('.chat-turn[data-role="assistant"]')
        .evaluateAll((els) =>
          els.filter((el) => !el.closest('.work-stretch')).map((el) => el.textContent.trim())
        )
    try {
      // 1. The turn runs: four notes, each with its work, then the answer.
      await inject(fixture, record.id, [
        working,
        { type: 'user_message', text: 'fix both errors' },
        ...note(NOTES[0]),
        ...note(NOTES[1], 2),
        ...note(NOTES[2]),
        ...note(NOTES[3]),
        { type: 'assistant_text', delta: ANSWER, final: true }
      ])
      await view.locator('.chat-turn[data-role="assistant"]', { hasText: ANSWER }).waitFor()
      const streaming = { cards: await cards.count(), outside: await outside() }
      t.check(
        `${mode}: while the turn runs, every note stays in the transcript at full size`,
        streaming.cards === 0 && streaming.outside.length === 5,
        streaming
      )

      // 2. The turn ends: the notes fold, the answer stays.
      await inject(fixture, record.id, [idle])
      await cards.first().waitFor()
      const card = cards.first()
      const folded = {
        cards: await cards.count(),
        notes: await card.getAttribute('data-notes'),
        tools: await card.getAttribute('data-tools'),
        fresh: await card.getAttribute('data-fresh'),
        outside: await outside(),
        eyebrow: await card.locator('.stretch-eyebrow').innerText(),
        title: await card.locator('.stretch-title-words').innerText(),
        open: await card.locator('details.stretch-card').evaluate((el) => el.open)
      }
      t.check(
        `${mode}: once the turn is over the notes fold into one closed card and the answer stays outside`,
        folded.cards === 1 &&
          folded.notes === '4' &&
          folded.tools === '5' &&
          folded.fresh === 'true' &&
          folded.outside.length === 1 &&
          folded.outside[0] === ANSWER &&
          folded.eyebrow.startsWith('4 notes · 5 tool calls') &&
          folded.title === FALLBACK_TITLE &&
          !folded.open,
        folded
      )

      // 3. The digest: the title lands, the flagged note is on the face.
      const read = await until(
        async () => ((await card.getAttribute('data-digest')) === 'done' ? true : null),
        15000
      )
      const face = {
        read,
        title: await card.locator('.stretch-title-words').innerText(),
        needs: await card.getAttribute('data-needs-you'),
        flag: await card.locator('.stretch-flag-words').innerText()
      }
      t.check(
        `${mode}: the digest titles the card and puts the note that needs the reader on its face`,
        face.read === true &&
          face.title === TITLE &&
          face.needs === 'true' &&
          face.flag === FLAG_TEXT,
        face
      )
      // Filed under the tab, in a bucket of its own beside the exchange digests.
      const filed = await until(async () => {
        // Read back through the window's road: titles are filed by the server
        // that runs the tab (main's folder in-process, `userData/server`
        // separate, PRDCT-4327), never read off one process's file.
        const keys = await chat.win.evaluate(async (id) => {
          const work = await window.electronAPI.workDigestsOf(id)
          const plain = await window.electronAPI.exchangeDigestsOf(id)
          return { work: Object.keys(work ?? {}), plain: Object.keys(plain ?? {}) }
        }, record.id)
        return keys && keys.work.length === 1 ? keys : null
      }, 8000)
      t.check(
        `${mode}: the title is filed under the tab's own work bucket, apart from the exchange digests`,
        !!filed && filed.work.length === 1 && filed.plain.length === 0,
        filed
      )

      // 4. Open: one step per note, its work under it, the flagged step marked.
      await card.locator('.stretch-summary').click()
      await until(async () => ((await card.locator('.stretch-step').count()) === 4 ? true : null))
      const opened = {
        steps: await card.locator('.stretch-step').count(),
        flagged: await card
          .locator('.stretch-step')
          .evaluateAll((els) => els.map((el) => el.hasAttribute('data-needs-you'))),
        notes: await card
          .locator('.stretch-step .chat-turn[data-role="assistant"]')
          .evaluateAll((els) => els.map((el) => el.textContent.replace(/\s+/g, ' ').trim())),
        runs: await card.locator(`.stretch-step ${toolRow}`).count()
      }
      t.check(
        `${mode}: open, the card is one step per note with its tool run, the flagged step marked`,
        opened.steps === 4 &&
          JSON.stringify(opened.flagged) === '[false,false,true,false]' &&
          opened.notes.length === 4 &&
          NOTE_KEYS.every((key, i) => opened.notes[i].includes(key)) &&
          opened.runs === 4,
        opened
      )
      await card.locator('.stretch-summary').click()
      await until(async () =>
        (await card.locator('details.stretch-card').evaluate((el) => el.open)) ? null : true
      )

      // 4a. Find: words that live only inside the closed card (not on its
      // face, where the flagged note already shows) open it and are marked
      // there (the way chat-pane-search drives the field).
      await view.locator('textarea').click()
      await win.keyboard.press('Meta+f')
      const field = win.locator('[data-pane-search] input')
      await field.waitFor()
      await until(async () =>
        (await field.evaluate((el) => document.activeElement === el)) ? true : null
      )
      await field.type('web is clean')
      const found = await until(async () => {
        const state = await win.evaluate(() => ({
          count: document.querySelector('.pane-search-count')?.textContent ?? '',
          current: CSS.highlights.get('pane-search-current')?.size ?? 0,
          open: !!document.querySelector('.work-stretch details.stretch-card[open]')
        }))
        return state.current === 1 && state.open ? state : null
      }, 10000)
      const findState = await win.evaluate(() => ({
        count: document.querySelector('.pane-search-count')?.textContent ?? '',
        field: document.querySelector('[data-pane-search] input')?.value ?? null,
        all: CSS.highlights.get('pane-search')?.size ?? 0,
        current: CSS.highlights.get('pane-search-current')?.size ?? 0,
        open: [...document.querySelectorAll('.work-stretch details.stretch-card')].map(
          (d) => d.open
        ),
        rows: document.querySelectorAll('[data-row-index]').length
      }))
      t.check(
        `${mode}: Find opens the closed card holding the words and marks them`,
        !!found && found.count === '1 of 1',
        { found, findState }
      )
      await field.press('Escape')
      await card.locator('.stretch-summary').click()
      await until(async () =>
        (await card.locator('details.stretch-card').evaluate((el) => el.open)) ? null : true
      )
      // Find scrolled the transcript to the match: back to its end, where the
      // turns to come are mounted.
      await view.locator('.chat-scroll').evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await win.waitForTimeout(400)

      // 4b. The agent carries on after its answer with no new message (a
      // background task reporting back): a new turn, the answer stays.
      await inject(fixture, record.id, [
        working,
        ...call(),
        ...note('Picked up the background result.'),
        { type: 'assistant_text', delta: 'All green now.', final: true },
        idle
      ])
      await view
        .locator('.chat-turn[data-role="assistant"]', { hasText: 'All green now.' })
        .waitFor()
      const carried = { cards: await cards.count(), outside: await outside() }
      t.check(
        `${mode}: an agent carrying on after its answer leaves that answer where it was`,
        carried.cards === 1 &&
          carried.outside.includes(ANSWER) &&
          carried.outside.includes('Picked up the background result.') &&
          carried.outside.includes('All green now.'),
        carried
      )

      // 5. A question mid-stretch is a boundary; a tool permission folds in.
      await inject(fixture, record.id, [
        working,
        { type: 'user_message', text: 'now the other one' },
        ...note('Reading the second report summary.'),
        ...note('Comparing with dev.'),
        {
          type: 'permission_request',
          id: 'ws-perm',
          description: 'Edit /x.ts?',
          toolName: 'Edit',
          input: { file_path: '/x.ts' },
          options: [{ id: 'allow', label: 'Allow' }]
        },
        { type: 'permission_withdrawn', id: 'ws-perm' },
        ...note('Edit applied, running the checks.'),
        {
          type: 'permission_request',
          id: 'ws-q',
          description: 'Which option?',
          options: [{ id: 'a', label: 'Keep it' }],
          questions: [{ question: 'Which option?', options: [{ label: 'Keep it' }] }]
        },
        working,
        ...note('Going with the first option.'),
        ...note('Checks are green.'),
        ...note('Writing the summary.'),
        {
          type: 'assistant_text',
          delta: 'Done with the other one, summary written; summary mailed.',
          final: true
        },
        idle
      ])
      await until(async () => ((await cards.count()) === 3 ? true : null))
      const split = {
        cards: await cards.count(),
        notes: await cards.evaluateAll((els) => els.map((el) => el.dataset.notes)),
        question: await view.locator('text=Which option?').count(),
        order: await view
          .locator('.work-stretch, .chat-prompt, .chat-permission-row')
          .evaluateAll((els) =>
            els
              .filter((el) => !el.closest('.work-stretch') || el.classList.contains('work-stretch'))
              .map((el) => (el.classList.contains('work-stretch') ? 'card' : 'card-free row'))
          )
      }
      t.check(
        `${mode}: a question splits the stretch into two cards around it, a tool permission folds inside`,
        split.cards === 3 &&
          JSON.stringify(split.notes) === '["4","3","3"]' &&
          split.question >= 1 &&
          split.order.join(',') === 'card,card,card-free row,card',
        split
      )
      const second = cards.nth(1)
      await second.locator('.stretch-summary').click()
      await until(async () => ((await second.locator('.stretch-step').count()) === 3 ? true : null))
      const inside = await second.locator('.stretch-step .chat-permission-row').count()
      t.check(
        `${mode}: the tool permission is inside the card, as part of the work`,
        inside === 1,
        {
          inside
        }
      )

      // 5c. Find over a whole turn, walking older (Enter; Shift+Enter walks
      // newer): the word is in a card the
      // reader opened and closed (its body built), in a card never opened,
      // and twice in the answer. The two answer matches are marked in place
      // without opening anything (the built card's words count as on screen,
      // the unopened card's do not); the older ones open their card and are
      // marked inside. In the Terminal view the turn is one row.
      const openCards = view.locator('.work-stretch details.stretch-card[open] > .stretch-summary')
      while (await openCards.count()) await openCards.first().click()
      await until(async () =>
        (await view.locator('.work-stretch details.stretch-card[open]').count()) === 0 ? true : null
      )
      await view.locator('textarea').click()
      await win.keyboard.press('Meta+f')
      const field2 = win.locator('[data-pane-search] input')
      await field2.waitFor()
      await until(async () =>
        (await field2.evaluate((el) => document.activeElement === el)) ? true : null
      )
      await field2.type('summary')
      const placeOf = () =>
        win.evaluate(() => {
          const range = [...(CSS.highlights.get('pane-search-current') ?? [])][0]
          const el = range?.startContainer?.parentElement ?? null
          return {
            count: document.querySelector('.pane-search-count')?.textContent ?? '',
            words: range?.toString() ?? null,
            after: range
              ? range.endContainer.textContent.slice(range.endOffset, range.endOffset + 8)
              : null,
            inCard: el ? !!el.closest('.work-stretch') : null,
            opened: document.querySelectorAll('.work-stretch details.stretch-card[open]').length
          }
        })
      // The count moves at once and the mark follows a beat later (the card
      // it opens, a beat after that): a step settles before it is read.
      const step = async (count) => {
        await win.waitForTimeout(700)
        return until(async () => {
          const place = await placeOf()
          return place.count === count && place.words === 'summary' ? place : null
        }, 10000)
      }
      const walk = [await step('1 of 4')]
      await field2.press('Enter')
      walk.push(await step('2 of 4'))
      await field2.press('Enter')
      walk.push(await step('3 of 4'))
      await field2.press('Enter')
      walk.push(await step('4 of 4'))
      t.check(
        `${mode}: the two answer matches are marked in place, the right word each, with no card opened`,
        !!walk[0] &&
          walk[0].after.startsWith(' mailed') &&
          walk[0].inCard === false &&
          walk[0].opened === 0 &&
          !!walk[1] &&
          walk[1].after.startsWith(' written') &&
          walk[1].inCard === false &&
          walk[1].opened === 0,
        walk.slice(0, 2)
      )
      t.check(
        `${mode}: the older matches open the card never opened, then the one the reader had closed, and are marked inside`,
        !!walk[2] &&
          walk[2].inCard === true &&
          walk[2].opened === 1 &&
          !!walk[3] &&
          walk[3].inCard === true &&
          walk[3].opened === 2,
        walk.slice(2)
      )
      await field2.press('Escape')
      // Close what Find opened, then back to the end of the transcript.
      while (await openCards.count()) await openCards.first().click()
      await until(async () =>
        (await view.locator('.work-stretch details.stretch-card[open]').count()) === 0 ? true : null
      )
      await win.waitForTimeout(400)
      await view.locator('.chat-scroll').evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await win.waitForTimeout(400)

      // 5b. A message that arrives while the agent works ends nothing.
      await inject(fixture, record.id, [
        working,
        { type: 'user_message', text: 'one more thing' },
        ...note('Starting on it.'),
        ...note('Reading the module.'),
        ...note('Found the place.'),
        ...note('Changing it.'),
        { type: 'user_message', text: 'and also rename the flag' }
      ])
      await view.locator('.chat-scroll').evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await view
        .locator('.chat-turn[data-role="user"]', { hasText: 'and also rename the flag' })
        .waitFor({ state: 'attached' })
      await inject(fixture, record.id, [
        ...note('Noted, renaming too.'),
        ...note('Running the checks.'),
        ...note('Both done.')
      ])
      await view.locator('.chat-turn[data-role="assistant"]', { hasText: 'Both done.' }).waitFor()
      // The rows are virtualised, so turns above may be out of the document:
      // what holds is that the notes near the end are still turns of their
      // own, and that no card holds this turn's notes.
      const midTurn = {
        outside: await outside(),
        inCards: await cards.evaluateAll(
          (els) =>
            els.filter((el) => /Changing it\.|Noted, renaming too\./.test(el.textContent)).length
        )
      }
      t.check(
        `${mode}: a message arriving mid-turn folds nothing while the agent still works`,
        ['Changing it.', 'Noted, renaming too.', 'Running the checks.', 'Both done.'].every(
          (text) => midTurn.outside.includes(text)
        ) && midTurn.inCards === 0,
        midTurn
      )
      await inject(fixture, record.id, [
        { type: 'assistant_text', delta: 'Done, flag renamed as well.', final: true },
        idle
      ])
      await until(async () => ((await cards.count()) >= 2 ? true : null))
      // The two newest cards, the ones of this turn: three notes each.
      const newest = await cards.evaluateAll((els) => els.slice(-2).map((el) => el.dataset.notes))
      const after = { newest, outside: await outside() }
      t.check(
        `${mode}: once that turn is over, the notes on each side of the message fold apart and the words before it stay`,
        JSON.stringify(after.newest) === '["3","3"]' &&
          after.outside.includes('Changing it.') &&
          after.outside.includes('Done, flag renamed as well.') &&
          !after.outside.includes('Starting on it.') &&
          !after.outside.includes('Noted, renaming too.'),
        after
      )

      // 6. The preference: off in Settings, on from the toolbar, kept.
      await win.evaluate(() =>
        document.querySelector('.sidebar-footer-btn[aria-label="Settings"]')?.click()
      )
      await win.waitForTimeout(600)
      await win.evaluate(() =>
        [...document.querySelectorAll('button')]
          .find((e) => e.textContent.trim() === 'Appearance')
          ?.click()
      )
      const toggle = win.locator('[role="switch"][aria-label="Fold the agent\'s working notes"]')
      await toggle.waitFor()
      assert.equal(await toggle.getAttribute('aria-checked'), 'true')
      await toggle.click()
      await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
      await until(async () => ((await cards.count()) === 0 ? true : null))
      // The chat view's rows are virtualised, so only the turns near the end
      // are in the document: the second turn's last notes and its answer.
      const off = { cards: await cards.count(), outside: await outside() }
      t.check(
        `${mode}: off in Settings → Appearance, every line is back in the transcript`,
        off.cards === 0 &&
          ['Noted, renaming too.', 'Running the checks.', 'Done, flag renamed as well.'].every(
            (text) => off.outside.includes(text)
          ),
        off
      )
      const button = win.locator('[data-testid="fold-notes-toggle"]')
      assert.equal(await button.getAttribute('aria-pressed'), 'false')
      await button.click()
      await until(async () => ((await cards.count()) >= 2 ? true : null))
      const on = {
        cards: await cards.count(),
        pressed: await button.getAttribute('aria-pressed'),
        kept: await win.evaluate(() => localStorage.getItem('clave-fold-work-notes'))
      }
      t.check(
        `${mode}: the toolbar button folds them again and the choice is kept`,
        on.cards >= 2 && on.pressed === 'true' && on.kept === 'on',
        on
      )
    } finally {
      await chat.close()
    }
  }
}
