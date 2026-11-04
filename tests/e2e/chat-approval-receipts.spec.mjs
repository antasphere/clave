import assert from 'node:assert/strict'
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* The transcript's record of answered approvals. What this spec holds in the
   real app: a run of routine approvals the reader allowed is ONE row that
   opens to its receipts, each naming what was allowed in words a reader
   understands rather than the protocol's method name; a request still
   waiting, one the reader refused, one settled from another client and a
   question each keep a row of their own and are never folded away. The
   requests are shaped as the Codex adapter emits them (toolName the protocol
   method, input the frame's params, the decisions as their raw ids), the
   shape Valentin met on 3 November 2026 as a wall of identical grey rows. */

const SERVER = 'clave_f5d8a4fb794a'
const command = (id, cmd) => ({
  type: 'permission_request',
  id,
  description: cmd,
  toolName: 'item/commandExecution/requestApproval',
  input: { threadId: 't', turnId: 'u', itemId: `item-${id}`, command: cmd, cwd: '/work' },
  options: ['accept', 'acceptForSession', 'decline', 'cancel'].map((o) => ({ id: o, label: o }))
})
// The approval frame as codex 0.166.0 sends it, captured by the lane's
// verifier on 3 November 2026: the tool named in the message alone, _meta
// carrying the kind, the description and the params, no tool_name key.
const claveTool = (id, tool) => ({
  type: 'permission_request',
  id,
  description: `Allow the ${SERVER} MCP server to run tool "${tool}"?`,
  toolName: 'mcpServer/elicitation/request',
  input: {
    threadId: 't',
    turnId: 'u',
    serverName: SERVER,
    mode: 'form',
    message: `Allow the ${SERVER} MCP server to run tool "${tool}"?`,
    requestedSchema: { type: 'object', properties: {} },
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      tool_description: 'Send a message to another agent tab',
      tool_params: { sessionId: 'parent', message: 'STATUS' },
      tool_params_display: [{ name: 'sessionId', value: 'parent', display_name: 'sessionId' }]
    }
  },
  options: ['accept', 'decline', 'cancel'].map((o) => ({ id: o, label: o }))
})

export async function run(t) {
  const chat = await openChat('chat-approval-receipts')
  const { win, record, fixture } = chat
  const view = win.locator('[data-testid="chat-view"]')
  const dock = view.locator('.chat-prompt[data-kind="permission"]')
  const runs = view.locator('.chat-approval-run')
  const rows = view.locator('.chat-permission-row')
  const folded = view.locator('.chat-approval-run .chat-permission-row')
  try {
    await fixture.evaluate(() => {
      const host = globalThis.__claveE2E.sessionHost
      const write = host.write
      host.write = (id, input) =>
        input.type === 'permission_response' ? Promise.resolve() : write.call(host, id, input)
    })
    /** One request docked, answered by its button, and gone from the dock. */
    const ask = async (request, name) => {
      await inject(fixture, record.id, [request])
      await dock.waitFor()
      await dock.getByRole('button', { name, exact: true }).click()
      assert.ok(
        await until(async () => (await dock.count()) === 0),
        'the answered request left the dock'
      )
    }
    await inject(fixture, record.id, [{ type: 'user_message', text: 'coordinate the lanes' }])
    await ask(command('c1', 'npm test'), 'accept')
    await inject(fixture, record.id, [
      { type: 'tool_call', id: 'g1', name: 'commandExecution', input: { command: 'npm test' } },
      { type: 'tool_result', id: 'g1', output: 'ok' }
    ])
    await ask(claveTool('m1', 'clave_send_to_session'), 'accept')
    await ask(command('c1b', 'npm run lint'), 'acceptForSession')
    await runs.first().waitFor()
    assert.equal(await runs.count(), 1)
    const run1 = runs.first()
    assert.equal(await run1.getAttribute('data-count'), '3')
    const head = await run1.locator('> summary').innerText()
    assert.match(head, /Allowed 3 requests/)
    assert.match(head, /Run a command/)
    assert.match(head, /clave_send_to_session/)
    assert.doesNotMatch(head, /requestApproval|elicitation|clave_f5d8a4fb794a/)
    // Closed until the reader says otherwise, its receipts not in the document.
    assert.equal(await run1.evaluate((el) => el.open), false)
    assert.equal(await rows.count(), 0)
    t.check('three allowed approvals fold into one closed row that says what was allowed', true)

    await run1.locator('> summary').click()
    assert.ok(
      await until(async () => (await folded.count()) === 3),
      'the run opened to its three receipts'
    )
    const texts = await folded.allInnerTexts()
    assert.match(texts[0], /Allowed/)
    assert.match(texts[0], /Run a command/)
    assert.match(texts[0], /npm test/)
    assert.match(texts[1], /Allowed/)
    assert.match(texts[1], /Use clave_send_to_session/)
    assert.match(texts[1], /Clave/)
    assert.match(texts[2], /Allowed for the session/)
    assert.match(texts[2], /npm run lint/)
    for (const text of texts)
      assert.doesNotMatch(text, /requestApproval|elicitation|clave_f5d8a4fb794a/)
    t.check('the row opens to one receipt per request, each readable and recoverable', true)

    // A refusal is its own row, outside the run, and the run stays as it was.
    await ask(command('c2', 'rm -rf dist'), 'decline')
    assert.ok(
      await until(async () => (await rows.count()) === 4),
      'the refusal got a row of its own'
    )
    assert.equal(await runs.count(), 1)
    assert.equal(await run1.getAttribute('data-count'), '3')
    const refused = view.locator('.chat-permission-row[data-state="answered"]').nth(3)
    assert.match(await refused.innerText(), /Declined/)
    assert.match(await refused.innerText(), /rm -rf dist/)
    assert.equal(await view.locator('.chat-approval-run .chat-permission-row').count(), 3)
    t.check('a refusal keeps its own visible row and never joins the run', true)

    // A request still waiting is its own row and docks; settled from another
    // client, it says so and stays.
    await inject(fixture, record.id, [command('c3', 'curl https://example.test')])
    await dock.waitFor()
    const waiting = view.locator('.chat-permission-row[data-state="waiting"]')
    await waiting.waitFor()
    assert.match(await waiting.innerText(), /Waiting for your approval/)
    assert.match(await waiting.innerText(), /curl https:\/\/example\.test/)
    assert.equal(await runs.count(), 1)
    await inject(fixture, record.id, [{ type: 'state_change', state: 'working' }])
    const elsewhere = view.locator('.chat-permission-row[data-state="elsewhere"]')
    await elsewhere.waitFor()
    assert.match(await elsewhere.innerText(), /No longer awaiting an answer/)
    assert.equal(await dock.count(), 0)
    assert.equal(await runs.count(), 1)
    t.check('a pending request and one settled elsewhere stay visible on their own rows', true)

    // A question is answered, recorded on its own row, and ends the run: the
    // approvals after it start another.
    await inject(fixture, record.id, [
      {
        type: 'permission_request',
        id: 'q1',
        description: 'Which lane next?',
        options: [
          { id: 'a', label: 'Lane A' },
          { id: 'b', label: 'Lane B' }
        ]
      }
    ])
    const question = view.locator('.chat-prompt[data-kind="question"]')
    await question.waitFor()
    await question.getByRole('radio', { name: /Lane B/ }).click()
    assert.ok(
      await until(async () => (await question.count()) === 0),
      'the answered question left the dock'
    )
    const answered = view.locator('.chat-permission-row[data-kind="question"]')
    await answered.waitFor()
    assert.match(await answered.innerText(), /Answered/)
    await ask(command('c4', 'git status'), 'accept')
    await ask(command('c5', 'git diff'), 'accept')
    assert.ok(
      await until(async () => (await runs.count()) === 2),
      'the approvals after the question started a new run'
    )
    assert.equal(await runs.nth(1).getAttribute('data-count'), '2')
    // The second run has its own key and its own disclosure: it renders
    // closed although the first run was opened above (a run keyed by a
    // request id Codex restarts at zero would have inherited that state).
    assert.equal(await runs.nth(1).evaluate((el) => el.open), false)
    assert.equal(await runs.nth(1).locator('.chat-permission-row').count(), 0)
    assert.equal(await runs.nth(0).evaluate((el) => el.open), true)
    assert.equal(
      await view.locator('.chat-approval-run .chat-permission-row[data-kind="question"]').count(),
      0
    )
    t.check('a question keeps its own row and the approvals after it start a new run', true)
  } finally {
    await chat.close()
  }
}
