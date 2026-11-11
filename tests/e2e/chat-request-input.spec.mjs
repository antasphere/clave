import assert from 'node:assert/strict'
import { openChat, inject } from './chat-view.spec.mjs'
import { callMcp, fixturePath, until } from './harness.mjs'
import { mcpClient, tabAgent, toolPayload } from './mcp-client.mjs'

/* An agent asks the person for plain values through clave_request_input
   (PRDCT-4157) and the person answers in a card drawn in the chat under the
   agent's turn. What this spec holds in the real app, as the tab's own agent
   over the MCP server:
   - the call returns pending once its timeout passes, and the card is in the
     transcript, inline, never docked above the composer;
   - a typed answer that does not fit is refused where it is typed, and Send
     keeps the card;
   - the answers come back to the agent through clave_input_result, keyed by
     the question's id, a multi-select as an array, a confirmed link as done,
     and the approve reaches the agent as the person's next message;
   - the answered card collapses into the record of what was said;
   - the form lives across the agent's turns: a message typed while it is
     open leaves it open; the agent sets a field from what was said and the
     steps layout folds the answered step and moves on; the agent's own
     approve closes it; a later correction revises the record;
   - a skip answers dismissed;
   - a provider's own question (AskUserQuestion) is drawn inline too. */

const payload = (rpc) => {
  assert.notEqual(rpc?.result?.isError, true, `the tool accepted the call: ${JSON.stringify(rpc)}`)
  return toolPayload(rpc)
}

export async function run(t) {
  const chat = await openChat('chat-request-input')
  const { app, win, record, fixture, server } = chat
  const view = win.locator('[data-testid="chat-view"]')
  const dir = fixturePath('chat-request-input')
  try {
    const agent = await until(() => tabAgent(dir, record.id, [dir, server?.dataDir]))
    t.check('the echo tab has its own agent token for the Clave tools', agent !== null)
    if (!agent) return
    const mcp = mcpClient(agent.url, agent.token)
    await mcp.init()

    /* 1. The onboarding's form: asked at once, drawn inline, pending to the agent. */
    // Awaited later: caught here so a failed check before then never leaves
    // a rejection unhandled when the app closes under the pending call.
    const asked = mcp
      .call('clave_request_input', {
        description: 'Three things before this machine is set up.',
        timeoutSeconds: 2,
        questions: [
          { id: 'email', label: 'Your team e-mail', kind: 'email', hint: 'The one on the hub' },
          { id: 'login', label: 'Your GitHub login', kind: 'github-login' },
          {
            id: 'projects',
            label: 'The client projects you join',
            kind: 'choice',
            multiSelect: true,
            optional: true,
            options: [{ label: 'syndicable' }, { label: 'reb' }, { label: 'wat' }]
          },
          {
            id: 'sign',
            label: 'Sign in to GitHub in your browser, then come back',
            kind: 'link',
            url: 'https://github.com/login',
            confirm: "I'm signed in"
          }
        ]
      })
      .catch((error) => ({ error: String(error) }))
    // A form the agent asked floats at the end of the conversation while it
    // is open (the tail after the rows); a provider's own question stays in
    // its row. Both are inline, never docked.
    const card = view.locator('.chat-column .chat-prompt[data-inline="true"][data-kind="question"]')
    await card.waitFor()
    t.check('the card is drawn in the transcript, inline', true)
    assert.equal(
      await view.locator('.chat-composer-wrap .chat-prompt').count(),
      0,
      'nothing is docked above the composer for a question'
    )
    assert.match(await card.locator('.chat-prompt-eyebrow').innerText(), /asks/i)
    assert.match(await card.innerText(), /Three things before this machine is set up\./)
    assert.equal(await card.locator('.chat-field-wrap').count(), 4, 'one field per question')
    // One question open at a time (PRDCT-4416): the first, the rest folded to
    // their line; the rail ends on an empty seat level with the buttons.
    assert.equal(
      await card.locator('.chat-ask-field[data-folded="true"][data-state="upcoming"]').count(),
      3,
      'only the first question of the form is open'
    )
    assert.equal(await card.locator('.chat-ask-end[data-ready="true"]').count(), 0)
    assert.equal(
      await card.locator('.chat-ask-owed').innerText(),
      '3 answers to go',
      'an Approve that is off says how many answers are owed'
    )
    const [endSeat, approveBox] = await Promise.all([
      card.locator('.chat-ask-end > .chat-ask-seat').boundingBox(),
      card.getByRole('button', { name: /^Approve/ }).boundingBox()
    ])
    assert.ok(
      endSeat &&
        approveBox &&
        Math.abs(endSeat.y + endSeat.height / 2 - (approveBox.y + approveBox.height / 2)) <= 1,
      `the rail's end seat is level with the buttons: ${JSON.stringify({ endSeat, approveBox })}`
    )
    t.check('the form opens on its first question, the rail ending level with Approve', true)
    const first = payload(await asked)
    t.check(
      'the call returned pending with its request id once the timeout passed',
      first.status === 'pending' && typeof first.requestId === 'string',
      first
    )

    /* 2. A typed answer that does not fit is said where it is typed; a field
          left empty is not judged for leaving it (the person may answer in
          the chat). */
    const email = card.locator('input[inputmode="email"]')
    await email.focus()
    await view.getByRole('textbox', { name: 'Message', exact: true }).focus()
    await win.waitForTimeout(150)
    assert.equal(
      await card.locator('.chat-field-problem').count(),
      0,
      'an empty field is not judged when the person leaves it for the composer'
    )
    await email.fill('luca@antasphere')
    // Approve is off while an answer is owed (PRDCT-4418); the count beside
    // it leads to the first one owed and says what is wrong there.
    assert.equal(await card.getByRole('button', { name: /^Approve/ }).isDisabled(), true)
    await card.locator('.chat-ask-owed').click()
    await card.locator('.chat-field-problem').first().waitFor()
    assert.match(await card.locator('.chat-field-problem').first().innerText(), /not an e-mail/)
    assert.equal(await card.count(), 1, 'the card stays until the answers fit')
    t.check('an e-mail with a typo is refused under its field and nothing is sent', true)

    /* 3. The answers, sent, reach the agent keyed by id. */
    await email.fill('luca@antasphere.com')
    // The answer stays open, and the next question opens under it.
    const folds = await until(async () => {
      const n = await card.locator('.chat-ask-field[data-folded="true"]').count()
      return n === 2 ? n : null
    })
    assert.equal(folds, 2, 'the question after the answered one opened, the others still folded')
    assert.equal(await email.isVisible(), true, 'the answered question stays open')
    t.check('answering a question keeps it open and opens the next', true)
    await card.locator('.chat-field-wrap[data-kind="github-login"] input').fill('luca-a')
    // The optional question stands last (PRDCT-4429): it opens once the
    // link above it is confirmed.
    await card.getByRole('button', { name: "I'm signed in" }).click()
    await card.getByRole('checkbox', { name: /reb/ }).click()
    await card.getByRole('checkbox', { name: /wat/ }).click()
    await card.locator('.chat-ask-end[data-ready="true"]').waitFor()
    t.check('every answer in, the rail ends on a filled seat', true)
    await card.getByRole('button', { name: /^Approve/ }).click()
    const result = payload(
      await mcp.call('clave_input_result', { requestId: first.requestId, waitSeconds: 10 })
    )
    assert.deepEqual(result, {
      requestId: first.requestId,
      status: 'completed',
      answers: {
        email: 'luca@antasphere.com',
        login: 'luca-a',
        projects: ['reb', 'wat'],
        sign: 'done'
      }
    })
    t.check(
      'the answers came back to the agent, the multi-select as an array, the link as done',
      true
    )
    const row = view.locator('.chat-permission-row[data-kind="question"][data-state="answered"]')
    await row.waitFor()
    assert.match(await row.innerText(), /luca-a/)
    assert.match(await row.innerText(), /reb, wat/)
    assert.match(await row.innerText(), /Approved/i)
    assert.equal(await row.locator('.chat-ask-field[data-folded="true"]').count(), 4)
    assert.equal(
      await row.locator('.chat-ask-end[data-ready="true"]').count(),
      1,
      'the record ends its rail on a filled seat'
    )
    assert.equal(await card.count(), 0, 'the card closed into its record')
    t.check('the approved card stays as the closed form, every step folded with its answer', true)
    // Nothing polled when the person approved (the tool's own wait had
    // passed): the approve went to the agent as the person's next message,
    // which the echo agent answers back word for word. The message itself
    // draws no bubble: the record row stands for it.
    await until(async () =>
      (await view.innerText()).includes('was approved by the person') ? true : null
    )
    assert.match(await view.innerText(), /Your GitHub login: luca-a/)
    const bubbles = await view
      .locator('.chat-rows [data-side="end"], .chat-rows [data-role="user"]')
      .allInnerTexts()
    assert.ok(
      bubbles.every((text) => !text.includes('was approved')),
      "the approve is read in the agent's echo, never as a bubble of the person"
    )
    t.check("the approve reached the agent as the person's message, drawn once as the record", true)

    /* 4. The form lives across the agent's turns and follows the agent's writes. */
    const second = payload(
      await mcp.call('clave_request_input', {
        description: 'Three more.',
        layout: 'steps',
        questions: [
          { id: 'name', label: 'How should we call you?' },
          { id: 'nick', label: 'A nickname, if you like', optional: true },
          { id: 'when', label: 'Your start date', kind: 'date' }
        ]
      })
    )
    assert.equal(second.status, 'pending', 'the default wait is none: the agent ends its turn')
    await card.waitFor()
    assert.equal(await card.locator('.chat-prompt-step').innerText(), '1/3')
    // A message typed while the form is open: the echo agent answers it and
    // ends its turn, and the card is still there, still live.
    await view.getByRole('textbox', { name: 'Message', exact: true }).fill('hello there')
    await view.getByRole('textbox', { name: 'Message', exact: true }).press('Enter')
    await until(async () => ((await view.innerText()).includes('hello there') ? true : null))
    await win.waitForTimeout(300)
    assert.equal(await card.count(), 1, 'the card survives the turn')
    // The message went above the form: the form floats at the end.
    const lastBubble = view
      .locator('.chat-rows [data-side="end"], .chat-rows [data-role="user"]')
      .last()
    const bubbleBox = await lastBubble.boundingBox()
    const cardBox = await card.boundingBox()
    assert.ok(
      bubbleBox && cardBox && cardBox.y > bubbleBox.y,
      'the form sits below the message typed while it was open'
    )
    assert.equal(
      await view.locator('.chat-permission-row[data-state="elsewhere"]').count(),
      0,
      'nothing reads No longer awaiting an answer'
    )
    // The tab reads as waiting for the person where the sidebar reads it:
    // the renderer's own store, fed by the server's state pushes, after the
    // turn's done (a blocked published inside the delivery of done ended on
    // done there, verifier round 3).
    const sidebar = await until(async () => {
      const res = await callMcp(app, 'list', {})
      const me = res?.sessions?.find((x) => x.id === record.id)
      return me?.agentState === 'blocked' ? me : null
    })
    assert.ok(sidebar, 'the sidebar reads blocked while the form is open')
    t.check(
      "a message typed while the form is open leaves the form live across the agent's turn",
      true
    )
    // The agent sets the first step from what was said: the card folds it
    // into one line and moves on to the second step.
    const refused = await mcp.call('clave_input_set', {
      requestId: second.requestId,
      answers: { when: 'tomorrow' }
    })
    assert.equal(refused?.result?.isError, true, 'a value that does not fit its kind is refused')
    assert.match(toolPayload(refused)?.raw ?? '', /"when": A date, as YYYY-MM-DD/)
    const setName = payload(
      await mcp.call('clave_input_set', { requestId: second.requestId, answers: { name: 'Luca' } })
    )
    assert.deepEqual(setName, {
      requestId: second.requestId,
      status: 'pending',
      answers: { name: 'Luca' }
    })
    await until(async () =>
      (await card.locator('.chat-prompt-step').innerText()) === '2/3' ? true : null
    )
    const foldedLine = card.locator('.chat-ask-field[data-folded="true"][data-state="done"]')
    assert.equal(await foldedLine.count(), 1, 'the answered step folded into one line')
    // The step still to come stands below, its question alone (PRDCT-4322).
    assert.equal(
      await card.locator('.chat-ask-field[data-folded="true"][data-state="upcoming"]').count(),
      1,
      'the third step waits below, folded to its question'
    )
    assert.match(await foldedLine.innerText(), /How should we call you\?/)
    assert.match(await foldedLine.innerText(), /Luca/)
    assert.match(await card.innerText(), /filled in what you said/)
    t.check(
      'a field the agent set is refused when it does not fit, else lands, folds its step and the card moves on',
      true
    )
    // The person's own Next goes one page, the optional question included:
    // back to the first, Next lands on the second, not past it.
    await card.getByRole('button', { name: 'Back', exact: true }).click()
    assert.equal(await card.locator('.chat-prompt-step').innerText(), '1/3')
    await card.getByRole('button', { name: 'Next', exact: true }).click()
    assert.equal(await card.locator('.chat-prompt-step').innerText(), '2/3')
    await card.getByRole('button', { name: 'Next', exact: true }).click()
    assert.equal(await card.locator('.chat-prompt-step').innerText(), '3/3')
    t.check("the person's Next goes one page and never skips an optional question", true)
    // The form floats at the end: messages typed while it is open land
    // above it, it keeps its standing, and it is never carried off by the
    // virtualised rows.
    for (let i = 0; i < 6; i++) {
      await view
        .getByRole('textbox', { name: 'Message', exact: true })
        .fill(`filler ${i}: a long line so the transcript grows above the form while it is open`)
      await view.getByRole('textbox', { name: 'Message', exact: true }).press('Enter')
      await win.waitForTimeout(150)
    }
    await until(async () => ((await view.innerText()).includes('filler 5') ? true : null))
    assert.equal(await card.count(), 1, 'the form is still there')
    assert.equal(await card.locator('.chat-prompt-step').innerText(), '3/3')
    assert.equal(await card.locator('.chat-ask-field[data-folded="true"]').count(), 2)
    assert.match(await card.innerText(), /filled in what you said/)
    const filler = view
      .locator('.chat-rows [data-side="end"], .chat-rows [data-role="user"]')
      .last()
    const fillerBox = await filler.boundingBox()
    const tailBox = await card.boundingBox()
    assert.ok(fillerBox && tailBox && tailBox.y > fillerBox.y, 'the form is below the last message')
    t.check(
      'the open form stays at the end of the conversation, under what was said meanwhile, at its step',
      true
    )
    // A note under the step the agent could not fill from what was said.
    payload(
      await mcp.call('clave_input_set', {
        requestId: second.requestId,
        answers: {},
        notes: { when: 'I did not catch a date in that' }
      })
    )
    await card.locator('.chat-field-note').waitFor()
    assert.match(await card.locator('.chat-field-note').innerText(), /did not catch a date/)
    t.check("the agent's note stands under the field it could not fill", true)
    // The agent reads the form as it stands, then sets the last step: the
    // card reaches its review, both lines folded, Approve under them.
    const pending = payload(await mcp.call('clave_input_result', { requestId: second.requestId }))
    assert.deepEqual(pending, {
      requestId: second.requestId,
      status: 'pending',
      answers: { name: 'Luca' }
    })
    payload(
      await mcp.call('clave_input_set', {
        requestId: second.requestId,
        answers: { when: '2026-11-17' }
      })
    )
    assert.ok(
      await until(async () =>
        (await card.locator('.chat-prompt-body[data-review="true"]').count()) === 1 ? true : null
      ),
      'the card reached its review once every step had an answer'
    )
    assert.equal(await card.locator('.chat-ask-field[data-folded="true"]').count(), 3)
    assert.equal(await card.locator('.chat-field-note').count(), 0, 'the note went with the change')
    assert.match(
      await card.locator('.chat-ask-field[data-folded="true"]').nth(1).innerText(),
      /Left empty/
    )
    assert.equal(
      await card.locator('.chat-prompt-step').count(),
      0,
      'the review page counts no step'
    )
    const approve = card.getByRole('button', { name: 'Approve', exact: true })
    assert.equal(await approve.count(), 1)
    t.check('with every step set the card shows its review: the lines folded and Approve', true)
    // From the review, a folded line reopens its step, and Next from there
    // goes one page even onto a step the agent already filled.
    await card.locator('.chat-ask-field[data-folded="true"]').nth(1).locator('button').click()
    assert.equal(await card.locator('.chat-prompt-step').innerText(), '2/3')
    await card.getByRole('button', { name: 'Next', exact: true }).click()
    assert.equal(await card.locator('.chat-prompt-step').innerText(), '3/3')
    t.check('Next lands on a step the agent filled rather than skipping it', true)
    // PRDCT-4210: the person retypes the name the agent set. A beat later
    // the form's draft holds it, so the agent reads it; the card keeps it as
    // typed and nothing lands on it as the agent's fill.
    await card.locator('.chat-ask-field[data-folded="true"]').nth(0).locator('button').click()
    assert.equal(await card.locator('.chat-prompt-step').innerText(), '1/3')
    const flashes = await card.locator('.chat-ask-flash').count()
    await card.locator('#chat-field-name').fill('Luca P')
    const typedRead = await until(async () => {
      const read = payload(await mcp.call('clave_input_result', { requestId: second.requestId }))
      return read?.answers?.name === 'Luca P' ? read : null
    })
    assert.deepEqual(typedRead, {
      requestId: second.requestId,
      status: 'pending',
      answers: { name: 'Luca P', when: '2026-11-17' }
    })
    await win.waitForTimeout(600)
    assert.equal(await card.locator('#chat-field-name').inputValue(), 'Luca P')
    assert.equal(
      await card.locator('.chat-ask-flash').count(),
      flashes,
      "the person's own typing never lands as the agent's"
    )
    t.check("what the person types reaches the form's draft and the agent reads it", true)
    // The view mounts again (the plugin off and on): the card starts from the
    // server's draft, and the person typing one field leaves the agent's fill
    // of another where it is (verifier round 1, Major 2).
    await win.evaluate(() => window.electronAPI.pluginsDisable('clave.chat-view'))
    await until(async () => ((await view.count()) === 0 ? true : null))
    await win.evaluate(() =>
      window.electronAPI.pluginsEnable('clave.chat-view', ['sessions.read', 'sessions.write'])
    )
    await view.locator('textarea:not(:disabled)').waitFor()
    await card.waitFor()
    assert.equal(await card.locator('.chat-prompt-step').innerText(), '1/3')
    assert.equal(await card.locator('#chat-field-name').inputValue(), 'Luca P')
    // The agent's field on another step is shown too, from the server's
    // draft (verifier round 2: the seeding was unpinned).
    await card.getByRole('button', { name: 'Next', exact: true }).click()
    await card.getByRole('button', { name: 'Next', exact: true }).click()
    assert.equal(await card.locator('.chat-prompt-step').innerText(), '3/3')
    assert.equal(await card.locator('#chat-field-when').inputValue(), '2026-11-17')
    await card.getByRole('button', { name: 'Back', exact: true }).click()
    await card.getByRole('button', { name: 'Back', exact: true }).click()
    assert.equal(await card.locator('.chat-prompt-step').innerText(), '1/3')
    await card.locator('#chat-field-name').fill('Luca Q')
    const afterRemount = await until(async () => {
      const read = payload(await mcp.call('clave_input_result', { requestId: second.requestId }))
      return read?.answers?.name === 'Luca Q' ? read : null
    })
    assert.deepEqual(afterRemount?.answers, { name: 'Luca Q', when: '2026-11-17' })
    t.check("after the view mounts again, the person's typing keeps the agent's other fields", true)
    // The person says the agent's first name was right after all: the agent
    // sets it again, to the value it once set, and the card shows it, so the
    // card and the draft agree (verifier round 1, Major 1).
    payload(
      await mcp.call('clave_input_set', { requestId: second.requestId, answers: { name: 'Luca' } })
    )
    assert.ok(
      await until(async () => {
        const text = await card.innerText()
        return /Luca(?! [PQ])/.test(text) && !text.includes('Luca Q') ? true : null
      }),
      'the agent setting a field again lands over what the person typed'
    )
    t.check('the agent setting a field again, to its earlier value, lands on the card', true)
    // And the person retypes it once more, the correction the agent approves.
    if ((await card.locator('.chat-prompt-step').innerText()) !== '1/3')
      await card.locator('.chat-ask-field[data-folded="true"]').nth(0).locator('button').click()
    assert.equal(await card.locator('.chat-prompt-step').innerText(), '1/3')
    await card.locator('#chat-field-name').fill('Luca P')
    assert.ok(
      await until(async () => {
        const read = payload(await mcp.call('clave_input_result', { requestId: second.requestId }))
        return read?.answers?.name === 'Luca P' ? true : null
      })
    )
    // A word of the agent about another field leaves the person's typing
    // where it is, on the card and in the draft (verifier round 2: the
    // view's own record of what it sent was unpinned).
    payload(
      await mcp.call('clave_input_set', {
        requestId: second.requestId,
        answers: {},
        notes: { when: 'that date is a Tuesday' }
      })
    )
    await win.waitForTimeout(700)
    assert.equal(await card.locator('#chat-field-name').inputValue(), 'Luca P')
    assert.equal(
      payload(await mcp.call('clave_input_result', { requestId: second.requestId }))?.answers?.name,
      'Luca P'
    )
    t.check("an agent's word about another field leaves the person's typing as it is", true)
    // The agent approves it itself (the person said to go ahead): the card
    // collapses, no message is owed, the answers are the record's, the
    // person's correction among them.
    const submitted = payload(
      await mcp.call('clave_input_set', { requestId: second.requestId, answers: {}, submit: true })
    )
    assert.deepEqual(submitted, {
      requestId: second.requestId,
      status: 'completed',
      answers: { name: 'Luca P', when: '2026-11-17' }
    })
    await until(async () => ((await card.count()) === 0 ? true : null))
    // The closed form stands where the open one did, at the end: the last
    // record of the conversation (the first form's row is far above, out of
    // the virtualised rows by now).
    const secondRow = view
      .locator('.chat-permission-row[data-kind="question"][data-state="answered"]')
      .last()
    assert.match(await secondRow.innerText(), /Approved/i)
    assert.equal(await secondRow.locator('.chat-ask-field[data-folded="true"]').count(), 3)
    assert.match(await secondRow.innerText(), /2026-11-17/)
    assert.match(await secondRow.innerText(), /Luca P/)
    t.check(
      "the agent's own approve closes the form into its record, with what the person typed",
      true
    )
    // A later correction: the record reads Revised with the new value, and
    // the tool reads it so.
    const revised = payload(
      await mcp.call('clave_input_set', {
        requestId: second.requestId,
        answers: { name: 'Luca A' }
      })
    )
    assert.deepEqual(revised, {
      requestId: second.requestId,
      status: 'completed',
      answers: { name: 'Luca A', when: '2026-11-17' },
      revised: true
    })
    await until(async () =>
      (await secondRow.innerText()).includes('REVISED') ||
      (await secondRow.innerText()).includes('Revised')
        ? true
        : null
    )
    assert.match(await secondRow.innerText(), /Luca A/)
    t.check('a correction after the approve revises the record in place', true)

    // Back to the end of the transcript, where the next cards arrive.
    await view.locator('.chat-scroll').evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })

    /* 5. The person's correction of a field the agent set survives a
          remount, and a skip answers dismissed, in the steps layout. */
    const third = payload(
      await mcp.call('clave_request_input', {
        description: 'One more.',
        layout: 'steps',
        questions: [
          { id: 'name', label: 'How should we call you?' },
          { id: 'when', label: 'Your start date', kind: 'date' }
        ]
      })
    )
    await card.waitFor()
    assert.equal(await card.locator('.chat-prompt-step').innerText(), '1/2')
    payload(
      await mcp.call('clave_input_set', { requestId: third.requestId, answers: { name: 'Luca' } })
    )
    await until(async () =>
      (await card.locator('.chat-prompt-step').innerText()) === '2/2' ? true : null
    )
    await card.getByRole('button', { name: 'Back', exact: true }).click()
    assert.ok(
      await until(async () =>
        (await card.locator('.chat-prompt-step').innerText()) === '1/2' ? true : null
      ),
      `back to the first step: ${(await card.innerText()).replace(/\n/g, ' | ')}`
    )
    const nameField = card.locator('.chat-field-wrap[data-kind="text"] input')
    assert.ok(
      await until(async () => ((await nameField.count()) === 1 ? true : null)),
      `the name field is there: ${(await card.innerText()).replace(/\n/g, ' | ')}`
    )
    await nameField.fill('Luca B')
    await card.getByRole('button', { name: 'Next', exact: true }).click()
    assert.equal(await card.locator('.chat-prompt-step').innerText(), '2/2')
    for (let i = 0; i < 6; i++) {
      await view
        .getByRole('textbox', { name: 'Message', exact: true })
        .fill(
          `filler ${i} again: a long line so the transcript grows under the form and the card leaves the view`
        )
      await view.getByRole('textbox', { name: 'Message', exact: true }).press('Enter')
      await win.waitForTimeout(150)
    }
    await until(async () => ((await view.innerText()).includes('filler 5 again') ? true : null))
    assert.equal(await card.count(), 1, 'the form is still there')
    assert.equal(await card.locator('.chat-prompt-step').innerText(), '2/2')
    assert.match(
      await card.locator('.chat-ask-field[data-folded="true"]').first().innerText(),
      /Luca B/
    )
    t.check(
      "the person's correction of a field the agent set stands while the conversation goes on",
      true
    )
    await card.getByRole('button', { name: 'Skip', exact: true }).click()
    const skipped = payload(
      await mcp.call('clave_input_result', { requestId: third.requestId, waitSeconds: 10 })
    )
    assert.equal(skipped.status, 'dismissed', JSON.stringify(skipped))
    t.check('a skipped request answers dismissed to the agent', true)

    /* 5b. A form stands its optional questions last, an optional one left
           empty says "Nothing to say" to open the next, and the record of a
           skip runs its accent no further than its last answer (PRDCT-4429). */
    const fourth = payload(
      await mcp.call('clave_request_input', {
        description: 'Two small things.',
        questions: [
          { id: 'note', label: 'Anything to add?', optional: true },
          { id: 'nick', label: 'Your nickname' },
          {
            id: 'tone',
            label: 'Which tone?',
            kind: 'choice',
            optional: true,
            options: [{ label: 'Short' }, { label: 'Long' }]
          }
        ]
      })
    )
    await card.waitFor()
    assert.deepEqual(
      await card.locator('.chat-ask-field .chat-field-question').allTextContents(),
      ['Your nickname', 'Anything to add?', 'Which tone?'],
      'the required question first, the optional ones after, in the order asked'
    )
    await card.locator('.chat-field-wrap input').first().fill('Lu')
    const pass = card.getByRole('button', { name: 'Nothing to say' })
    await pass.waitFor()
    assert.equal(await card.locator('.chat-ask-field[data-folded="true"]').count(), 1)
    await pass.click()
    assert.ok(
      await until(async () =>
        (await card.locator('.chat-ask-field[data-folded="true"]').count()) === 0 ? true : null
      ),
      'the next question opened'
    )
    assert.equal(await pass.count(), 0, 'the last question has no way on to offer')
    assert.equal(await card.getByRole('button', { name: /^Approve/ }).isDisabled(), false)
    t.check('optional questions stand last and "Nothing to say" opens the next', true)
    await card.getByRole('button', { name: 'Skip', exact: true }).click()
    payload(await mcp.call('clave_input_result', { requestId: fourth.requestId, waitSeconds: 10 }))
    const skippedRecord = view
      .locator('.chat-permission-row[data-kind="question"]', { hasText: 'Two small things.' })
      .last()
    await skippedRecord.waitFor()
    const rail = await skippedRecord.locator('.chat-ask-fields').evaluate((ol) => ({
      accent: parseFloat(getComputedStyle(ol, '::after').height),
      line: parseFloat(getComputedStyle(ol, '::before').height)
    }))
    assert.ok(rail.accent < rail.line / 2, `the skip's accent stops short: ${JSON.stringify(rail)}`)
    t.check("a skipped record's accent runs no further than its last answer", true)
    await view.locator('.chat-scroll').evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })

    /* 6. A provider's own question is inline too, answered through the host. */
    await fixture.evaluate(() => {
      const host = globalThis.__claveE2E.sessionHost
      const write = host.write
      globalThis.__inlineWrites = []
      host.write = (id, input) => {
        globalThis.__inlineWrites.push(input)
        if (input.type === 'permission_response') return Promise.resolve()
        return write.call(host, id, input)
      }
    })
    await inject(fixture, record.id, [
      {
        type: 'permission_request',
        id: 'ask-native',
        description: 'Claude asks a question',
        toolName: 'AskUserQuestion',
        input: {},
        questions: [
          {
            question: 'Send now or draft?',
            options: [{ label: 'Send now' }, { label: 'Draft only' }]
          }
        ],
        options: [
          { id: 'answer', label: 'Submit' },
          { id: 'deny', label: 'Skip' }
        ]
      }
    ])
    await card.waitFor()
    assert.match(await card.innerText(), /Send now or draft\?/)
    await card.getByRole('radio', { name: /Draft only/ }).click()
    await card.getByRole('button', { name: 'Send', exact: true }).click()
    const writes = await until(async () => {
      const w = await fixture.evaluate(() => globalThis.__inlineWrites)
      return w.some((x) => x.type === 'permission_response') ? w : null
    })
    const reply = writes.find((x) => x.type === 'permission_response')
    assert.deepEqual(reply, {
      type: 'permission_response',
      id: 'ask-native',
      optionId: 'answer',
      answers: { 'Send now or draft?': 'Draft only' }
    })
    t.check("a provider's own question is drawn inline and answered through the host", true)
  } finally {
    await chat.close()
  }
}
