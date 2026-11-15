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
//   - Escape with messages waiting stops the turn and puts the person's own
//     back in the composer, in order, a blank line between, none answered;
//     another tab's never goes there: one line says it was not sent, a
//     quiet line of the conversation, never the red of a failure;
//   - the conversation copied as Markdown reads in the same order, the other
//     tab's message under its name, without its bracketed header;
//   - two messages written in the same tick: each answer under its own;
//   - Escape before any answer with two waiting: the turn's own message and
//     both waiting ones back, each once, in order;
//   - (OpenCode) six waiting: past four rows the list scrolls inside the
//     stack, its count line in view, the stack within about a third of the
//     pane; a long message opens in place by a click or Enter, and closes;
//   - in each skin (Enclave, Folio, Chat): while the agent works, a draft
//     turns the stop into Send message, which queues it in that skin's
//     stack; withdrawn, its words and its file come back to that skin's
//     composer, and still together, to that skin alone, when they come back
//     while another tab is on screen; an empty composer keeps the stop, and
//     Escape stops.
// With `CLAVE_E2E_SHOTS` set, the stack with two messages waiting (one from
// another tab), the conversation with the line saying the other tab's was
// not sent, the stack with six waiting and a row opened to a long message
// (OpenCode) are photographed there.
import { mkdirSync, writeFileSync } from 'node:fs'
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

  // ── Escape with messages waiting: the person's two back in the composer,
  // in order; another tab's never, one line saying it was not sent ──
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
  const unsent = await callMcp(app, 'sendToSession', {
    sessionId: id,
    message: 'order seven-b, from the other tab',
    callerSessionId: lane
  })
  await write('order eight, second waiting')
  t.check(
    'three messages wait behind the running turn, one of them another tab’s',
    !!(await rowCount(3)) && unsent?.delivered !== false,
    unsent
  )
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
  const notSent = view.locator('.chat-notice').filter({
    hasText: 'A message from Lane B was not sent.'
  })
  t.check(
    'the other tab’s message never reaches the composer: one line in the conversation says it was not sent',
    !String(restored).includes('seven-b') &&
      !!(await until(async () => ((await notSent.count()) === 1 ? true : null), { tries: 40 })),
    { restored, lines: await view.locator('.chat-notice').allInnerTexts() }
  )
  // Nothing failed: the person stopped the turn. The line is a quiet line of
  // the conversation, the mode line's look (small, grey, no edge) in the ink
  // of the "Interrupted" under the stopped message, never the red of a
  // failure (PRDCT-4566).
  const lookOf = (locator) =>
    locator.evaluate((el) => {
      const style = getComputedStyle(el)
      return {
        tone: el.getAttribute('data-tone'),
        role: el.getAttribute('role'),
        color: style.color,
        size: style.fontSize,
        edge: style.borderTopWidth
      }
    })
  const lineLook = await lookOf(notSent)
  const noteLook = await lookOf(
    view
      .locator('.chat-turn-wrap[data-interrupted="true"]')
      .filter({ hasText: 'order six' })
      .locator('.chat-turn-note')
      .first()
  )
  t.check(
    'the line is a quiet line of the conversation, never the red of a failure',
    lineLook.tone === 'quiet' &&
      lineLook.role === 'status' &&
      lineLook.color === noteLook.color &&
      lineLook.size === noteLook.size &&
      lineLook.edge === '0px',
    { line: lineLook, interrupted: noteLook }
  )
  if (shots) await pane(id).screenshot({ path: path.join(shots, `chat-not-sent-${mode}.png`) })
  await win.waitForTimeout(1500)
  t.check(
    'none was answered, nor drawn',
    (await bubbles('order seven')) === 0 &&
      (await bubbles('order eight')) === 0 &&
      (await view.locator('.exchange-timeline').filter({ hasText: 'order seven-b' }).count()) ===
        0 &&
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

  // The session's own word on whether its agent still works.
  const idle = () =>
    until(
      async () => {
        const list = await win.evaluate(() => window.electronAPI.sessionsList())
        return list.find((s) => s.id === id)?.state !== 'working' ? true : null
      },
      { tries: 100, gapMs: 100 }
    )
  const lines = (pattern) =>
    view.evaluate(
      (root, source) =>
        [
          ...root.querySelectorAll(
            '.chat-turn[data-role="user"], .chat-turn[data-role="assistant"]'
          )
        ]
          .map(
            (el) =>
              `${el.getAttribute('data-role')}: ${(el.textContent ?? '').replace(/\s+/g, ' ').trim()}`
          )
          .filter((line) => new RegExp(source).test(line)),
      pattern
    )

  // ── Two messages written in the same tick (verifier 3's finding 1): the
  // second enters when the agent takes it, each answer under its own ──
  await win.evaluate(
    (sessionId) =>
      Promise.all([
        window.electronAPI.sessionsWrite(sessionId, { type: 'user_message', text: 'tick one' }),
        window.electronAPI.sessionsWrite(sessionId, { type: 'user_message', text: 'tick two' })
      ]),
    id
  )
  t.check('the second of two in the same tick is answered', !!(await answered('tick two')))
  await idle()
  const ticks = await lines('tick (one|two)')
  const tickOrder = [
    /^user: tick one$/,
    /^assistant: You said: tick one/,
    /^user: tick two$/,
    /^assistant: You said: tick two/
  ]
  t.check(
    'two messages written in the same tick: in the DOM, each answer right after its own message',
    ticks.length === tickOrder.length && tickOrder.every((re, i) => re.test(ticks[i])),
    ticks
  )

  // ── Escape before any answer, two messages waiting (verifier 3's M30): the
  // turn's own message and both waiting ones back, each once, in order ──
  await say(id, 'order nine, slow')
  await started('order nine, slow')
  await until(async () => ((await bubbles('order nine')) === 1 ? true : null), { tries: 60 })
  await write('order ten, waiting')
  await write('order eleven, waiting')
  t.check('two messages wait behind a turn that has said nothing', !!(await rowCount(2)))
  await composer.press('Escape')
  const allBack = await until(
    async () => {
      const value = await composer.inputValue()
      return value.includes('order eleven') ? value : null
    },
    { tries: 60, gapMs: 100 }
  )
  t.check(
    'Escape before any answer: the turn’s own message and the two waiting come back, each once, in order',
    allBack === 'order nine, slow\n\norder ten, waiting\n\norder eleven, waiting',
    allBack
  )
  await idle()
  await win.waitForTimeout(1500)
  t.check(
    'the turn’s message left the conversation, and none of the three was answered',
    (await bubbles('order nine')) === 0 &&
      (await bubbles('order ten')) === 0 &&
      (await bubbles('order eleven')) === 0 &&
      (await lines('You said: order (nine|ten|eleven)')).length === 0,
    await lines('order (nine|ten|eleven)')
  )
  await composer.fill('')

  // ── Six messages waiting (verifier 3's finding 4): past four rows the list
  // scrolls inside the stack, its count line in view; and a long message
  // opens in place to its whole text (finding 5). OpenCode holds every
  // message for the whole turn ──
  if (mode === 'opencode') {
    await say(id, 'order twelve, slow')
    await started('order twelve, slow')
    for (const text of ['order 13', 'order 14', 'order 15', 'order 16', 'order 17'])
      await write(text)
    const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a long message`).join('\n')
    await composer.fill(long)
    await composer.press('Enter')
    t.check('six messages wait', !!(await rowCount(6)))
    const measure = () =>
      stack.evaluate((el) => {
        const list = el.querySelector('.chat-waiting-list')
        const count = el.querySelector('[data-waiting-count]')
        const pane = el.closest('[data-testid="chat-view"]')
        const s = el.getBoundingClientRect()
        const c = count?.getBoundingClientRect()
        return {
          count: count?.textContent ?? null,
          scrolls: !!list && list.scrollHeight > list.clientHeight + 1,
          stack: Math.round(s.height),
          pane: Math.round(pane?.getBoundingClientRect().height ?? 0),
          countInView: !!c && c.top >= s.top && c.bottom <= s.bottom
        }
      })
    await win.waitForTimeout(800)
    await stack.locator('.chat-waiting-list').evaluate((el) => (el.scrollTop = el.scrollHeight))
    const six = await measure()
    t.check(
      'past four rows the list scrolls inside the stack, the count line in view, the stack within about a third of the pane',
      six.count === '6 messages waiting' &&
        six.scrolls &&
        six.countInView &&
        six.stack <= six.pane * 0.36,
      six
    )
    const shots = process.env.CLAVE_E2E_SHOTS
    if (shots) await pane(id).screenshot({ path: path.join(shots, `chat-waiting-six-${mode}.png`) })
    const longRow = rows.last()
    const longLine = longRow.locator('.chat-waiting-text')
    const state = () =>
      longRow.evaluate((el) => {
        const withdraw = el.querySelector('[data-waiting-withdraw]')?.getBoundingClientRect()
        return {
          open: el.hasAttribute('data-open'),
          expanded: el.querySelector('.chat-waiting-text')?.getAttribute('aria-expanded') ?? null,
          text: el.querySelector('.chat-waiting-gist')?.textContent ?? '',
          // How far down the row its withdraw sits: on the first line.
          withdrawTop: withdraw ? Math.round(withdraw.top - el.getBoundingClientRect().top) : null
        }
      })
    await longLine.click()
    const opened = await state()
    await win.waitForTimeout(400)
    await stack.locator('.chat-waiting-list').evaluate((list) => {
      const row = list.lastElementChild
      if (row) list.scrollTop = row.offsetTop - list.offsetTop
    })
    const openBox = await measure()
    t.check(
      'a click opens the row in place to the whole message, scrollable inside the stack, its withdraw on its first line',
      opened.open &&
        opened.expanded === 'true' &&
        opened.text.includes('line 40 of a long message') &&
        opened.withdrawTop !== null &&
        opened.withdrawTop < 30 &&
        openBox.scrolls &&
        openBox.countInView &&
        openBox.stack <= openBox.pane * 0.36,
      { opened: { ...opened, text: opened.text.slice(-40) }, openBox }
    )
    if (shots)
      await pane(id).screenshot({ path: path.join(shots, `chat-waiting-open-${mode}.png`) })
    await longLine.click()
    const closed = await state()
    await longLine.focus()
    await longLine.press('Enter')
    const byKey = await state()
    await longLine.press('Enter')
    const shutByKey = await state()
    t.check(
      'a second click closes it; Enter on the row opens and closes it the same way',
      !closed.open && closed.text === 'line 1 of a long message' && byKey.open && !shutByKey.open,
      { closed: closed.open, byKey: byKey.open, shutByKey: shutByKey.open }
    )
    await composer.press('Escape')
    await idle()
    await until(async () => ((await stack.count()) === 0 ? true : null), { tries: 60 })
    await composer.fill('')
  }

  // ── Each skin (verifier 3's finding 9, M31 and M32; the send button as
  // ruled): while the agent works, a draft turns the stop into Send message,
  // which queues it as Enter does; the stack is drawn in that skin; and a
  // withdrawn message comes back to that skin's composer, words and file ──
  const switchTo = async (title) => {
    await pane(id).getByLabel('Session menu', { exact: true }).click()
    const tile = win.locator('.view-tile', { hasText: title })
    await tile.waitFor()
    await win.waitForTimeout(500)
    await tile.click({ force: true })
    await win.waitForTimeout(300)
  }
  for (const [title, testId] of [
    [/^Enclave$/, 'terminal-view'],
    [/^Folio$/, 'folio-view'],
    [/^Chat$/, 'chat-view']
  ]) {
    await switchTo(title)
    const skin = pane(id).locator(`[data-testid="${testId}"]`).first()
    await skin.waitFor()
    const box = skin.locator('textarea[aria-label="Message"]')
    const button = skin.locator('button.chat-send')
    const kind = () => button.getAttribute('data-kind')
    const file = `notes-${testId}.md`
    const words = `${testId}, by the button`
    await say(id, `skin ${testId}, slow`)
    await started(`skin ${testId}, slow`)
    const stopShown = await until(async () => ((await kind()) === 'stop' ? true : null), {
      tries: 60
    })
    t.check(
      `${testId}: while the agent works, an empty composer keeps the stop button`,
      !!stopShown && (await button.getAttribute('aria-label')) === 'Interrupt'
    )
    await box.fill(words)
    // A made-up file on disk, dropped by its path as another app drops one.
    const notes = path.join(cwd, file)
    writeFileSync(notes, '# made-up notes\n')
    await win.evaluate(
      ({ selector, uri }) => {
        const dt = new DataTransfer()
        dt.setData('text/uri-list', uri)
        document
          .querySelector(selector)
          .dispatchEvent(
            new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })
          )
      },
      {
        selector: `.chat-host[data-session-id="${id}"] [data-testid="${testId}"]`,
        uri: `file://${notes}`
      }
    )
    const chip = skin.locator('.chat-attachment-name', { hasText: file })
    const ready = await until(
      async () => ((await chip.count()) === 1 && (await button.isEnabled()) ? true : null),
      { tries: 80 }
    )
    t.check(
      `${testId}: with a draft, the button reads Send message`,
      !!ready &&
        (await kind()) === 'send' &&
        (await button.getAttribute('aria-label')) === 'Send message'
    )
    await button.click()
    const skinRows = skin.locator('[data-waiting-stack] [data-waiting-message]')
    const queued = await until(
      async () =>
        (await skinRows.count()) === 1 &&
        (await box.inputValue()) === '' &&
        (await chip.count()) === 0
          ? true
          : null,
      { tries: 60 }
    )
    t.check(
      `${testId}: it waits in this skin's stack, as Enter would have queued it, and the button is the stop again`,
      !!queued &&
        ((await skinRows.first().locator('.chat-waiting-gist').textContent()) ?? '').includes(
          words
        ) &&
        (await kind()) === 'stop',
      { rows: await skinRows.count(), value: await box.inputValue() }
    )
    await skinRows.first().locator('[data-waiting-withdraw]').click()
    // The words as sent, the file's marker after them, and the file's chip.
    const back = await until(
      async () =>
        (await box.inputValue()).startsWith(words) && (await chip.count()) === 1 ? true : null,
      { tries: 60 }
    )
    t.check(
      `${testId}: withdrawn, its words and its file come back to this skin's composer`,
      !!back,
      { value: await box.inputValue(), chips: await chip.count() }
    )
    // Handed back while another tab is on screen (the verifier's closing
    // look, finding 1): the words and the file still come back together, to
    // this skin's composer, the session's chosen view, and to no other.
    await button.click()
    const queuedAgain = await until(
      async () => ((await skinRows.count()) === 1 && (await chip.count()) === 0 ? true : null),
      { tries: 60 }
    )
    const waitingId = await skinRows.first().getAttribute('data-waiting-message')
    const returns = async () => (await heard()).filter((h) => h.endsWith('back:withdrawn')).length
    const returnsBefore = await returns()
    await callMcp(app, 'focus', { sessionId: lane })
    const away = await until(async () => ((await skin.isVisible()) ? null : true), { tries: 40 })
    await win.evaluate(
      ({ sessionId, message }) =>
        window.electronAPI.sessionsWrite(sessionId, { type: 'withdraw_message', id: message }),
      { sessionId: id, message: waitingId }
    )
    const handedBack = await until(async () => ((await returns()) > returnsBefore ? true : null), {
      tries: 60
    })
    // The views take the return while the tab is hidden.
    await win.waitForTimeout(300)
    await callMcp(app, 'focus', { sessionId: id })
    await skin.waitFor()
    const inPane = pane(id).locator('.chat-attachment-name', { hasText: file })
    const together = await until(
      async () =>
        (await box.inputValue()).startsWith(words) &&
        (await chip.count()) === 1 &&
        (await inPane.count()) === 1
          ? true
          : null,
      { tries: 60 }
    )
    t.check(
      `${testId}: handed back while another tab is on screen, its words and its file still come back together, to this skin alone`,
      !!queuedAgain && !!waitingId && !!away && !!handedBack && !!together,
      {
        queuedAgain,
        waitingId,
        away,
        handedBack,
        value: await box.inputValue(),
        chips: await chip.count(),
        inPane: await inPane.count()
      }
    )
    // Away with the file, if it came back, so the next skin starts clean.
    const remove = skin.getByRole('button', { name: `Remove ${file}`, exact: true })
    if ((await remove.count()) > 0) await remove.first().click()
    await box.fill('')
    await box.press('Escape')
    await idle()
    await box.fill('')
  }
}
