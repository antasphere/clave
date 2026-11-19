/**
 * A chat shows its first message and its answer (PRDCT-4664): the gate that
 * was missing when every Claude chat of v3.0.0-beta.25 stayed empty.
 *
 * A tab an agent opens is given its first message at the start (the opener's
 * prompt). On the separate server, the packaged default, the session is made
 * ready the moment it starts: the agent names its model, takes the prompt and
 * answers before any view of the tab exists. The view that binds afterwards
 * is told the session's current state without a position (its model, among
 * others) and reads the conversation's snapshot. The reader of #388 accepted
 * such a frame only when its type was on a list, the model was not on it, and
 * the snapshot never committed: the pane stayed empty while the conversation
 * went on. In-process the first view binds before the session is made ready,
 * so nothing is told without a position, which is why the suite, run
 * in-process, saw nothing of it.
 *
 * So the workflow runs this spec both ways (`checks.yml`, two gate steps):
 * in-process it holds the plain promise, and on the separate server it holds
 * the order that broke.
 *
 * Fails if: the pane of a tab opened with a prompt does not show that prompt
 * as the person's message, or not the answer under it; or shows either twice.
 * Proven red, on the separate server, on the reader as it shipped in
 * v3.0.0-beta.25 (2ad1f4f3): four checks of four, while in-process it stayed
 * green.
 */
import assert from 'node:assert/strict'
import { callMcp, until } from './harness.mjs'
import { openChat } from './chat-view.spec.mjs'

const BRIEF = 'Read the brief its opener gave it, then answer.'

/** The turns the conversation view of one tab shows, in order. */
async function turns(win, id) {
  return win
    .locator(`[data-terminal-tile="${id}"] [data-testid="chat-view"] .chat-turn`)
    .evaluateAll((els) =>
      els.map((el) => ({ role: el.getAttribute('data-role'), text: el.innerText.trim() }))
    )
}
const said = (list, role) => list.filter((turn) => turn.role === role && turn.text.includes(BRIEF))

/** The tab's conversation, once its view has drawn both sides of it. */
async function conversation(win, id) {
  return until(
    async () => {
      const list = await turns(win, id)
      return said(list, 'user').length > 0 && said(list, 'assistant').length > 0 ? list : null
    },
    { tries: 60, gapMs: 250 }
  )
}

export async function run(t) {
  const chat = await openChat('chat-shows-first-message')
  const { app, win } = chat
  try {
    const root = (await win.evaluate(() => window.electronAPI.sessionsList()))[0].cwd
    // An agent opens a tab and gives it its first message. It is not focused:
    // the tab works on its own, as a lane a coordinator opened does.
    const opened = await callMcp(app, 'openSession', {
      cwd: root,
      mode: 'claude',
      name: 'Opened by an agent',
      prompt: BRIEF
    })
    assert.ok(opened?.sessionId, JSON.stringify(opened))
    const id = opened.sessionId
    const row = win.locator('.sidebar-item', { hasText: 'Opened by an agent' }).first()
    await row.waitFor()
    await row.click()

    const first = await conversation(win, id)
    t.check('the tab shows the first message it was given', !!first, await turns(win, id))
    t.equal('once', said(first ?? [], 'user').length, 1)
    t.equal('and its answer, once', said(first ?? [], 'assistant').length, 1)
    t.check(
      'the message stands before its answer',
      !!first &&
        first.findIndex((turn) => turn.role === 'user') <
          first.findIndex((turn) => turn.role === 'assistant'),
      first
    )
  } finally {
    await chat.close()
  }
}
