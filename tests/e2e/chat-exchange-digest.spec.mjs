import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* The exchange timeline's digest: what the reader needs from the messages
   other tabs sent, read by a one-shot model call once the timeline holds
   still. Under the harness no model runs; the spec hands main the model's
   reply (CLAVE_E2E_DIGEST_REPLY). What this spec holds, in both views:
   - the timeline says it is reading, then shows the digest under its senders;
   - the card the digest came from is marked, the others are not;
   - the digest is filed under the tab's session id, and a timeline scrolled
     out of view is read and filed all the same;
   - with no digest to be had, the timeline shows its messages and one quiet
     line saying it was not read, and no Ask again: a failure of no known
     class is not one asking again can change (PRDCT-4327). */

const header = (name, id) =>
  `[Message from Clave tab "${name}" — reply with clave_send_to_session sessionId="${id}"]\n`
const MESSAGES = [
  { type: 'user_message', text: 'Coordinate with the verifier.' },
  { type: 'assistant_text', delta: 'Asking the verifier.', final: true },
  { type: 'user_message', text: header('Verifier', 'v1') + 'VERIFY-ACK: starting.' },
  {
    type: 'user_message',
    text: header('Verifier', 'v1') + 'VERIFY-REPORT: one blocking finding. Fix it here or later?'
  },
  { type: 'assistant_text', delta: 'Waiting.', final: true }
]
const SUMMARY = 'The verifier asks you whether the blocking fix goes in this PR.'
const REPLY = JSON.stringify({ needs_you: true, message: 2, summary: SUMMARY })

export async function run(t) {
  for (const mode of ['chat', 'terminal']) {
    const args = mode === 'terminal' ? ['--dev-echo-view=clave.chat-view/terminal'] : []
    const ready = `[data-testid="${mode}-view"] textarea:not(:disabled)`
    const chat = await openChat(`exchange-digest-${mode}`, args, ready, {
      CLAVE_E2E_DIGEST_REPLY: REPLY
    })
    try {
      const { win, record, fixture } = chat
      const view = win.locator(`[data-testid="${mode}-view"]`)
      await inject(fixture, record.id, MESSAGES)
      const timeline = view.locator('.exchange-timeline')
      await timeline.waitFor()
      const reading = await until(
        async () => (await timeline.getAttribute('data-digest')) === 'reading',
        15000
      )
      const done = await until(
        async () => (await timeline.getAttribute('data-digest')) === 'done',
        15000
      )
      const shown = {
        reading,
        done,
        text: await timeline.locator('.exchange-digest-text').innerText(),
        needs: await timeline.getAttribute('data-needs-you'),
        flagged: await timeline
          .locator('.exchange')
          .evaluateAll((items) => items.map((li) => li.hasAttribute('data-needs-you')))
      }
      t.check(
        `${mode}: the timeline reads, then shows the digest and marks the message it came from`,
        shown.reading &&
          shown.done &&
          shown.text === SUMMARY &&
          shown.needs === 'true' &&
          JSON.stringify(shown.flagged) === '[false,true]',
        shown
      )
      // Filed by the tab's id in the data folder of the server that runs the
      // tab (main's in-process, `userData/server` separate, PRDCT-4327), so a
      // remount or a restart finds it: read back through the window's road.
      const filed = () =>
        chat.win.evaluate(
          async (id) => Object.keys(await window.electronAPI.exchangeDigestsOf(id)),
          record.id
        )
      const saved = await until(async () => ((await filed()).length === 1 ? true : null), 8000)
      t.check(`${mode}: the digest is filed under the tab's session id`, saved === true, {
        filed: await filed()
      })
      // A new timeline scrolled far out of view at once is still read and
      // filed: the view asks, not the card on screen.
      await inject(fixture, record.id, [
        { type: 'user_message', text: header('Deploy bot', 'd1') + 'Staging is green.' },
        ...Array.from({ length: 40 }, (_, i) =>
          i % 2 === 0
            ? { type: 'user_message', text: `Filler ${i}` }
            : { type: 'assistant_text', delta: 'A long answer. '.repeat(80), final: true }
        )
      ])
      const offscreen = await until(async () => ((await filed()).length === 2 ? true : null), 15000)
      t.check(
        `${mode}: a timeline scrolled out of view is read and filed all the same`,
        offscreen === true,
        { filed: await filed() }
      )
    } finally {
      await chat.close()
    }

    const quiet = await openChat(`exchange-digest-none-${mode}`, args, ready)
    try {
      const { win, record, fixture } = quiet
      const view = win.locator(`[data-testid="${mode}-view"]`)
      await inject(fixture, record.id, MESSAGES)
      const timeline = view.locator('.exchange-timeline')
      await timeline.waitFor()
      const failed = await until(
        async () => (await timeline.getAttribute('data-digest')) === 'failed',
        15000
      )
      const state = {
        failed,
        digestText: await timeline.locator('.exchange-digest-text').count(),
        unread: await timeline.locator('.digest-unread-words').allInnerTexts(),
        retry: await timeline.getByRole('button', { name: 'Ask again', exact: true }).count(),
        cards: await timeline.locator('.exchange').count()
      }
      t.check(
        `${mode}: with no digest to be had, the timeline shows its messages and says it was not read`,
        state.failed &&
          state.digestText === 0 &&
          JSON.stringify(state.unread) === '["Not read: something went wrong."]' &&
          state.retry === 0 &&
          state.cards === 2,
        state
      )
    } finally {
      await quiet.close()
    }
  }
}
