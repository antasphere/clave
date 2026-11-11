/**
 * This Mac's own tab, on an account its server knows, gets its digest read
 * by that server (PRDCT-4327). The app's sessions run on a server: in-process
 * (the same process as main), a SEPARATE child with its own data folder
 * (`userData/server`), or an attached daemon. An account added in Settings
 * once the app is up lives on that server alone when it is not in-process,
 * so a digest read in main for a tab on it is refused: main's account list
 * does not have it. Under the harness no model runs: the reply comes from
 * CLAVE_E2E_DIGEST_REPLY, its `{account}` standing for the account the read
 * ran on, and an account the reading process does not know fails as the CLI
 * would be refused (`exchange-digest.ts`, `testAccount`).
 *
 * The check that tells the roads apart runs in `separate` (and `attached`):
 * there, the window sending a tab's digest to main instead of its server
 * reads "Not read: this account is signed out." In-process the two are one
 * process, and the spec only shows the digest read on the tab's account.
 */
import { openChat, inject } from './chat-view.spec.mjs'
import { serverMode, until } from './harness.mjs'

const header = (name, id) =>
  `[Message from Clave tab "${name}" — reply with clave_send_to_session sessionId="${id}"]\n`
const REPLY = JSON.stringify({ needs_you: true, message: 1, summary: 'Read on {account}.' })

export async function run(t) {
  const chat = await openChat('digest-server-account', [], undefined, {
    CLAVE_E2E_DIGEST_REPLY: REPLY
  })
  try {
    const { win, record, fixture } = chat
    // An account added through Settings' API once the app is up: on the
    // server that runs the sessions, and nowhere else unless in-process.
    const account = await win.evaluate(async () => {
      const added = await window.electronAPI.claudeAccountAdd({ label: 'Added after boot' })
      await window.electronAPI.claudeAccountSetToken(added.id, `sk-ant-oat01-${'y'.repeat(80)}`)
      return added.id
    })
    // The tab moves to it through the session's own restart, the call the
    // Switch account menu makes (the echo fixture offers no menu entry).
    const moved = await win.evaluate(
      ({ id, account }) => window.electronAPI.restartSession(id, { claudeProfileId: account }),
      { id: record.id, account }
    )
    t.check('the tab restarted on the account added after boot', !moved?.error, moved)
    const view = win.locator('[data-testid="chat-view"]').first()
    await view.locator('textarea:not(:disabled)').waitFor({ timeout: 30_000 })
    await inject(fixture, record.id, [
      { type: 'user_message', text: 'Coordinate with the verifier.' },
      { type: 'assistant_text', delta: 'Asking.', final: true },
      { type: 'user_message', text: header('Verifier', 'v1') + 'VERIFY-REPORT: merge now?' },
      { type: 'assistant_text', delta: 'Waiting.', final: true }
    ])
    const timeline = view.locator('.exchange-timeline').last()
    await timeline.waitFor({ timeout: 30_000 })
    const settled = await until(
      async () => ['done', 'failed'].includes(await timeline.getAttribute('data-digest')),
      30_000
    )
    const shown = {
      mode: serverMode(),
      settled,
      state: await timeline.getAttribute('data-digest'),
      text:
        (await timeline.locator('.exchange-digest-text').count()) > 0
          ? await timeline.locator('.exchange-digest-text').innerText()
          : await timeline.locator('.digest-unread-words').allInnerTexts()
    }
    t.check(
      `${serverMode()}: a tab of this Mac on an account added after boot gets its digest read on that account by the server that runs it`,
      shown.state === 'done' && shown.text === `Read on ${account}.`,
      shown
    )
  } finally {
    await chat.close()
  }
}
