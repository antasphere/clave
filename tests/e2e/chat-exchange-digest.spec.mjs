import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* The exchange timeline's digest: what the reader needs from the messages
   other tabs sent, read by a one-shot model call once the timeline holds
   still. Under the harness no model runs; the spec hands main the model's
   reply (CLAVE_E2E_DIGEST_REPLY). What this spec holds, in both views:
   - the timeline says it is reading, then shows the digest under its senders;
   - the card the digest came from is marked, the others are not;
   - with no digest to be had, the timeline shows its messages and nothing
     else: no error, no empty line. */

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
        cards: await timeline.locator('.exchange').count()
      }
      t.check(
        `${mode}: with no digest to be had, the timeline shows its messages and nothing else`,
        state.failed && state.digestText === 0 && state.cards === 2,
        state
      )
    } finally {
      await quiet.close()
    }
  }
}
