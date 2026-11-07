import assert from 'node:assert/strict'
import { openChat, inject } from './chat-view.spec.mjs'
import { fixturePath, until } from './harness.mjs'
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
     the question's id, a multi-select as an array, a confirmed link as done;
   - the answered card collapses into the record of what was said;
   - a skip answers dismissed;
   - a provider's own question (AskUserQuestion) is drawn inline too. */

const payload = (rpc) => {
  assert.notEqual(rpc?.result?.isError, true, `the tool accepted the call: ${JSON.stringify(rpc)}`)
  return toolPayload(rpc)
}

export async function run(t) {
  const chat = await openChat('chat-request-input')
  const { win, record, fixture, server } = chat
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
        timeoutSeconds: 5,
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
    const card = view.locator('.chat-rows .chat-prompt[data-inline="true"][data-kind="question"]')
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
    const first = payload(await asked)
    t.check(
      'the call returned pending with its request id once the timeout passed',
      first.status === 'pending' && typeof first.requestId === 'string',
      first
    )

    /* 2. A typed answer that does not fit is said where it is typed. */
    const email = card.locator('input[inputmode="email"]')
    await email.fill('luca@antasphere')
    await card.getByRole('button', { name: /^Send/ }).click()
    await card.locator('.chat-field-problem').first().waitFor()
    assert.match(await card.locator('.chat-field-problem').first().innerText(), /not an e-mail/)
    assert.equal(await card.count(), 1, 'the card stays until the answers fit')
    t.check('an e-mail with a typo is refused under its field and nothing is sent', true)

    /* 3. The answers, sent, reach the agent keyed by id. */
    await email.fill('luca@antasphere.com')
    await card.locator('.chat-field-wrap[data-kind="github-login"] input').fill('luca-a')
    await card.getByRole('checkbox', { name: /reb/ }).click()
    await card.getByRole('checkbox', { name: /wat/ }).click()
    await card.getByRole('button', { name: "I'm signed in" }).click()
    await card.getByRole('button', { name: /^Send/ }).click()
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
    assert.equal(await card.count(), 0, 'the card collapsed into its record')
    t.check('the answered card collapsed into the transcript record of what was said', true)

    /* 4. A skip answers dismissed, in the steps layout. */
    const second = mcp
      .call('clave_request_input', {
        description: 'One more.',
        layout: 'steps',
        timeoutSeconds: 5,
        questions: [
          { id: 'name', label: 'How should we call you?' },
          { id: 'when', label: 'Your start date', kind: 'date' }
        ]
      })
      .catch((error) => ({ error: String(error) }))
    await card.waitFor()
    assert.equal(await card.locator('.chat-prompt-step').innerText(), '1/2')
    await card.getByRole('button', { name: 'Skip', exact: true }).click()
    const skipped = payload(await second)
    assert.equal(skipped.status, 'dismissed', JSON.stringify(skipped))
    t.check('a skipped request answers dismissed to the agent', true)

    /* 5. A provider's own question is inline too, answered through the host. */
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
