// Messages written while an agent works, in an OpenCode or a Pi chat
// (PRDCT-4566), against the stand-ins' `long turn` (an answer that streams in
// three pieces, `*_STAND_IN_LONG_TURN_MS` apart). Shared by opencode-chat and
// pi-chat. What it holds in the real app:
//   - written during a turn, the person's own message and another tab's wait
//     in the stack above the composer (`[data-waiting-stack]`), in the order
//     written, the other tab's by its name, each saying when it goes; neither
//     is in the conversation while the turn's text still streams;
//   - each enters the conversation when the agent takes it, and every answer
//     is drawn under the message it answers (the DOM order of the bubbles,
//     the other tab's card and the answers, not a count);
//   - a withdrawn message leaves the stack, comes back into the empty
//     composer, and the agent never answers it;
//   - Escape with two messages waiting stops the turn and puts both back in
//     the composer, in order, a blank line between, none answered;
//   - the conversation copied as Markdown reads in the same order, the other
//     tab's message under its name, without its bracketed header.
// With `CLAVE_E2E_SHOTS` set, the stack with two messages waiting (one from
// another tab) is photographed there.
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { callMcp, until } from './harness.mjs'

/**
 * @param {object} t the runner's checks
 * @param {object} o
 * @param {'opencode' | 'pi'} o.mode the harness, as `openSession` names it
 * @param {string} o.agent its name in the chat (OpenCode, Pi)
 * @param {string} o.when what a waiting row says of when it goes
 * @param {string} o.cwd where the chats open
 * @param {() => string[]} o.handed the texts the agent was handed so far
 */
export async function waitingMessages(
  t,
  { app, win, chat, pane, say, mode, agent, when, cwd, handed }
) {
  const open = async (name) => {
    const opened = await callMcp(app, 'openSession', { cwd, mode, chat: true, name })
    return opened.sessionId
  }
  const id = await open(`${agent} order`)
  const lane = await open('Lane B')
  t.check('a chat and a second tab to write from opened', !!id && !!lane, { id, lane })
  const { groupId } = await callMcp(app, 'createGroup', { name: `${agent} order` })
  for (const sid of [id, lane]) await callMcp(app, 'moveSession', { sessionId: sid, groupId })
  await callMcp(app, 'focus', { sessionId: id })
  await chat(id).waitFor({ timeout: 20_000 })
  const view = chat(id)
  const composer = view.locator('textarea[aria-label="Message"]')
  await composer.waitFor()
  await until(async () => ((await composer.isEnabled()) ? true : null), { tries: 80 })
  const stack = view.locator('[data-waiting-stack]')
  const rows = stack.locator('[data-waiting-message]')
  const write = async (text) => {
    await composer.fill(text)
    await composer.press('Enter')
  }
  const started = (text) =>
    until(() => (handed().some((h) => h.includes(text)) ? true : null), {
      tries: 100,
      gapMs: 100
    })
  const answered = (text) =>
    until(
      async () =>
        (await view
          .locator('.chat-turn[data-role="assistant"]')
          .filter({ hasText: `You said: ${text}` })
          .count()) > 0
          ? true
          : null,
      { tries: 150, gapMs: 200 }
    )
  const rowCount = (n) =>
    until(async () => ((await rows.count()) === n ? true : null), { tries: 60, gapMs: 100 })
  const bubbles = (text) =>
    view.locator('.chat-turn[data-role="user"]').filter({ hasText: text }).count()
  // What the session streams to this window, in short, for a check's detail.
  await win.evaluate((sessionId) => {
    const heard = []
    window.__waitingHeard = heard
    window.electronAPI.onSessionStream(sessionId, (stream) => {
      if (stream.kind !== 'event') return
      const e = stream.event
      heard.push(
        e.type === 'waiting_messages'
          ? `waiting ${e.messages.map((m) => m.text.slice(-12)).join('|')}${e.returned ? ` back:${e.returned.why}` : ''}`
          : e.type === 'user_message'
            ? `user ${e.text.slice(-12)}`
            : e.type === 'state_change'
              ? `state ${e.state}`
              : e.type
      )
    })
  }, id)
  const heard = () => win.evaluate(() => window.__waitingHeard ?? [])

  // ── Three messages during one long turn, one of them another tab's ──
  await say(id, 'order one, a long turn')
  await started('order one, a long turn')
  await until(
    async () =>
      (await view
        .locator('.chat-turn[data-role="assistant"]')
        .filter({ hasText: 'You said:' })
        .count()) > 0
        ? true
        : null,
    { tries: 100, gapMs: 100 }
  )
  await write('order two, my own')
  const delivery = await callMcp(app, 'sendToSession', {
    sessionId: id,
    message: 'order three, from the other tab',
    callerSessionId: lane
  })
  const waitingTwo = await rowCount(2)
  const faces = await rows.evaluateAll((els) =>
    els.map((el) => ({
      from: el.querySelector('.chat-waiting-from')?.textContent ?? null,
      gist: el.querySelector('.chat-waiting-gist')?.textContent ?? '',
      when: el.querySelector('.chat-waiting-when')?.textContent ?? '',
      withdraw: el.querySelector('[data-waiting-withdraw]')?.getAttribute('aria-label') ?? null
    }))
  )
  t.check(
    'while the turn runs, the two messages wait in the stack above the composer, in the order written',
    !!waitingTwo &&
      delivery?.delivered !== false &&
      JSON.stringify(faces) ===
        JSON.stringify([
          { from: null, gist: 'order two, my own', when, withdraw: 'Withdraw' },
          { from: 'Lane B', gist: 'order three, from the other tab', when, withdraw: 'Withdraw' }
        ]),
    { faces, delivery, heard: await heard() }
  )
  const placed = await stack.evaluate((el) => {
    const composer = el.parentElement?.querySelector('.chat-composer, .term-prompt, .term-files')
    return !!composer && !!(el.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING)
  })
  t.check('the stack is docked above the composer', placed)
  t.check(
    'neither is in the conversation while the turn’s text still streams',
    (await bubbles('order two')) === 0 &&
      (await view.locator('.exchange-timeline').filter({ hasText: 'order three' }).count()) === 0
  )
  const shots = process.env.CLAVE_E2E_SHOTS
  if (shots) {
    mkdirSync(shots, { recursive: true })
    // Once the rows' fold has settled.
    await win.waitForTimeout(800)
    await pane(id).screenshot({ path: path.join(shots, `chat-waiting-stack-${mode}.png`) })
  }
  t.check('the first answer arrives', !!(await answered('order one, a long turn')))
  t.check('the second, under its own message', !!(await answered('order two, my own')))
  const third = await until(
    async () =>
      (await view
        .locator('.chat-turn[data-role="assistant"]')
        .filter({ hasText: 'order three, from the other tab' })
        .count()) > 0
        ? true
        : null,
    { tries: 150, gapMs: 200 }
  )
  t.check('the third, under the other tab’s card', !!third)
  t.check(
    'the stack folds away once the agent has taken them all',
    !!(await until(async () => ((await stack.count()) === 0 ? true : null), { tries: 60 }))
  )
  const sequence = await view.evaluate((root) =>
    [
      ...root.querySelectorAll(
        '.chat-turn[data-role="user"], .chat-turn[data-role="assistant"], .exchange-timeline'
      )
    ]
      .map((el) =>
        el.matches('.exchange-timeline')
          ? `card: ${el.querySelector('.exchange-from')?.textContent ?? ''} · ${el.querySelector('.exchange-gist')?.textContent ?? ''}`
          : `${el.getAttribute('data-role')}: ${(el.textContent ?? '').replace(/\s+/g, ' ').trim()}`
      )
      .filter((line) => line.includes('order '))
  )
  const expected = [
    /^user: order one, a long turn$/,
    /^assistant: You said: order one, a long turn$/,
    /^user: order two, my own$/,
    /^assistant: You said: order two, my own$/,
    /^card: Lane B · order three, from the other tab$/,
    /^assistant: You said: .*order three, from the other tab/
  ]
  t.check(
    'in the DOM, each answer comes right after the message it answers',
    sequence.length === expected.length && expected.every((re, i) => re.test(sequence[i])),
    sequence
  )

  // ── A withdrawn message: back in the composer, never answered ──
  await say(id, 'order four, another long turn')
  await started('order four, another long turn')
  await write('order five, never mind')
  t.check('the message written during the turn waits', !!(await rowCount(1)))
  await rows.first().locator('[data-waiting-withdraw]').click()
  t.check(
    'withdrawn, it leaves the stack',
    !!(await until(async () => ((await stack.count()) === 0 ? true : null), { tries: 60 }))
  )
  const back = await until(async () => {
    const value = await composer.inputValue()
    return value ? value : null
  })
  t.check('and comes back into the empty composer', back === 'order five, never mind', back)
  t.check('the turn goes on to its answer', !!(await answered('order four, another long turn')))
  await win.waitForTimeout(1500)
  t.check(
    'the withdrawn message is never answered, nor drawn',
    (await bubbles('order five')) === 0 &&
      (await view
        .locator('.chat-turn[data-role="assistant"]')
        .filter({ hasText: 'order five' })
        .count()) === 0
  )
  await composer.fill('')

  // ── Escape with two messages waiting: both back in the composer, in order ──
  await say(id, 'order six, a long turn to stop')
  await started('order six, a long turn to stop')
  await until(
    async () =>
      (await view.locator('.chat-turn[data-role="assistant"]').last().innerText()).includes(
        'You said:'
      )
        ? true
        : null,
    { tries: 100, gapMs: 100 }
  )
  await write('order seven, first waiting')
  await write('order eight, second waiting')
  t.check('two messages wait behind the running turn', !!(await rowCount(2)))
  await composer.press('Escape')
  const restored = await until(
    async () => {
      const value = await composer.inputValue()
      return value.includes('order eight') ? value : null
    },
    { tries: 60, gapMs: 100 }
  )
  t.check(
    'Escape puts both back in the composer, in order, a blank line between',
    restored === 'order seven, first waiting\n\norder eight, second waiting',
    restored
  )
  t.check(
    'the stack is empty and the turn is stopped',
    !!(await until(async () => ((await stack.count()) === 0 ? true : null), { tries: 60 })) &&
      !!(await until(
        async () =>
          (await view
            .locator('.chat-turn-wrap[data-interrupted="true"]')
            .filter({ hasText: 'order six' })
            .count()) > 0
            ? true
            : null,
        { tries: 60 }
      ))
  )
  await win.waitForTimeout(1500)
  t.check(
    'neither was answered, nor drawn',
    (await bubbles('order seven')) === 0 &&
      (await bubbles('order eight')) === 0 &&
      (await view
        .locator('.chat-turn[data-role="assistant"]')
        .filter({ hasText: /order (seven|eight)/ })
        .count()) === 0
  )
  await composer.fill('')

  // ── The conversation copied as Markdown reads in the same order ──
  await app.evaluate(({ clipboard }) => clipboard.writeText('__not-copied-yet__'))
  await pane(id).getByLabel('Session menu', { exact: true }).click()
  const menu = win.locator('[role="menu"][aria-label="Session menu"]')
  await menu.getByRole('menuitem', { name: 'Copy as Markdown' }).click()
  const copied = await until(async () => {
    const text = await app.evaluate(({ clipboard }) => clipboard.readText())
    return text.includes('order six') ? text : null
  })
  const at = (words) => (typeof copied === 'string' ? copied.indexOf(words) : -1)
  const marks = [
    'order one, a long turn',
    'You said: order one, a long turn',
    'order two, my own',
    'You said: order two, my own',
    'order three, from the other tab',
    'order four, another long turn'
  ].map(at)
  t.check(
    'copied as Markdown, it reads in the order shown, the other tab’s message under its name and without its header',
    typeof copied === 'string' &&
      marks.every((index, i) => index >= 0 && (i === 0 || index > marks[i - 1])) &&
      /^## Lane B · \d\d:\d\d\n\norder three, from the other tab$/m.test(copied) &&
      !copied.includes('order five') &&
      !copied.includes('order seven'),
    copied
  )
  await win.keyboard.press('Escape').catch(() => undefined)
}
