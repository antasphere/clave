import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { REPO } from './harness.mjs'
import {
  fleetWorld,
  connectMac,
  clickReady,
  eventually,
  owned,
  ownerReady,
  request,
  showMac,
  showServer
} from './fixtures/fleet-world.mjs'

const payload = (result) => {
  assert.notEqual(result.isError, true, 'isolated MCP command is accepted')
  return JSON.parse(result.content[0].text)
}
export async function run(t) {
  const world = await fleetWorld('requests')
  let mcp
  try {
    const report = world.load()
    const [server, other] = world.servers
    await request(server, '/launch-profiles', {
      profile: {
        id: 'fleet-recording-provider',
        name: 'Fleet recording protocol fixture',
        family: 'codex',
        command: [process.execPath, path.join(REPO, 'tests/e2e/fixtures/fleet-provider.mjs')],
        additionalArgs: []
      }
    })
    const provider = await request(server, '/sessions/start', {
      cwd: server.root,
      options: {
        claudeMode: false,
        codexMode: true,
        launchProfileId: 'chat:codex:fleet-recording-provider'
      }
    })
    await eventually(
      async () => (await request(server, '/requests/pending')).pending.length === 2,
      'native provider requests wait with no desktop'
    )
    const configPath = path.join(server.dataDir, 'mcp-configs', `${provider.id}.json`)
    await eventually(() => existsSync(configPath), 'actual provider has a server-owned MCP config')
    const config = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.clave
    assert.equal(config.url, server.agentToolsUrl)
    mcp = new Client({ name: 'fleet-isolated-fixture', version: '1' })
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers }
      })
    )
    const question = payload(
      await mcp.callTool({
        name: 'clave_request_clarification',
        arguments: {
          description: 'Fleet explicit MCP clarification',
          questions: [{ question: 'Fleet branch?', options: [{ label: 'dev' }] }]
        }
      })
    )
    const secretFile = path.join(server.root, 'fixture-secret.env')
    const secret = payload(
      await mcp.callTool({
        name: 'clave_request_secret',
        arguments: {
          description: 'Fleet explicit MCP secret',
          action: { type: 'env-file', file: secretFile, key: 'FLEET_TEST_VALUE' }
        }
      })
    )
    await mcp.close()
    mcp = null
    const pending = (await request(server, '/requests/pending')).pending
    assert.equal(pending.length, 4)
    assert.equal(existsSync(secretFile), false)
    assert.deepEqual((await request(other, '/requests/pending')).pending, [])
    t.check(
      'native approval/clarification and explicit MCP clarification/secret remain pending without any Mac or MCP transport',
      true
    )

    const macA = await world.mac('a')
    const macB = await world.mac('b')
    // The first owner immediately opens its queued request dialog. Configure
    // the independent connections through their ordinary bridge so that the
    // request under test does not need answering just to add the second owner.
    await connectMac(macA, world.servers, { ui: false })
    await connectMac(macB, world.servers, { ui: false })
    const clients = [macA, macB]
    const nativeApproval = pending.find((p) => p.providerRequestId === '"fleet-native-approval"')
    const nativeQuestion = pending.find((p) => p.providerRequestId === '"fleet-native-question"')
    assert.ok(nativeApproval)
    assert.ok(nativeQuestion)
    const replies = () =>
      existsSync(path.join(server.root, 'provider-replies.jsonl'))
        ? readFileSync(path.join(server.root, 'provider-replies.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((s) => JSON.parse(s))
        : []
    const race = async (pendingRequest, responses) => {
      const outcomes = await Promise.all(
        clients.map((mac, index) =>
          mac.win.evaluate(({ key, response }) => window.electronAPI.fleetResolve(key, response), {
            key: owned('request', mac.owners[0].id, pendingRequest.id),
            response: responses[index]
          })
        )
      )
      assert.equal(
        outcomes.filter((o) => o.accepted).length,
        1,
        'exactly one client wins each resolution'
      )
      await eventually(
        async () =>
          !(await request(server, '/requests/pending')).pending.some(
            (p) => p.id === pendingRequest.id
          ),
        'settlement removes the owning pending request'
      )
      return outcomes.findIndex((o) => o.accepted)
    }
    // The Clave-tool requests (the MCP clarification and secret) still open
    // the request dialog on each Mac; native agent requests never do (#261).
    for (const mac of clients) {
      const dialog = mac.win.getByRole('dialog')
      await dialog.waitFor()
      const text = await dialog.innerText()
      assert.ok(text.includes('Fleet explicit MCP clarification'), 'the oldest Clave-tool request')
      assert.equal(text.includes(nativeApproval.description), false)
      // Set it aside, as a person reading their session does.
      await mac.win.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      await mac.win.getByRole('button', { name: 'Requests waiting (2)', exact: true }).waitFor()
    }
    // Native requests dock in their own session's pane, on each Mac, in the
    // dock a local session uses.
    const providerKey = (mac) => owned('session', mac.owners[0].id, provider.id)
    const dockOf = (mac) =>
      mac.win.locator(`.chat-host[data-session-id="${providerKey(mac)}"] .chat-prompt:visible`)
    const approvalRowOf = (mac) =>
      mac.win.locator(
        `.chat-host[data-session-id="${providerKey(mac)}"] .chat-permission-row[data-kind="permission"]:visible`
      )
    for (const mac of clients) {
      await showServer(mac, 0)
      await ownerReady(mac, mac.owners[0].id, providerKey(mac))
      await clickReady(mac.win.locator(`[data-sidebar-item-id="${providerKey(mac)}"]`))
      await dockOf(mac).getByText(nativeApproval.description, { exact: true }).waitFor()
      assert.equal(await mac.win.getByRole('dialog').count(), 0)
    }
    const accept = nativeApproval.options.find((o) => o.id === 'accept')
    assert.ok(accept, 'the approval offers its accept decision')
    await clickReady(dockOf(macA).getByRole('button', { name: accept.label, exact: true }))
    await eventually(
      () => replies().filter((r) => r.id === 'fleet-native-approval').length === 1,
      'provider receives one approval answer'
    )
    assert.equal(replies().find((r) => r.id === 'fleet-native-approval').result.decision, 'accept')
    // Mac B's dock moves on to the next request without being touched, and
    // its record of the approval says it was answered elsewhere.
    let macBDock = ''
    await eventually(async () => {
      macBDock = (await dockOf(macB).count()) ? await dockOf(macB).innerText() : ''
      return (
        macBDock.includes('Fleet public answer') && !macBDock.includes(nativeApproval.description)
      )
    }, 'the other Mac docks the question next').catch((error) => {
      throw new Error(`${error.message}; Mac B dock: ${JSON.stringify(macBDock)}`)
    })
    // One record per request, as in a local session: the server's replay of
    // a pending request and the history that first asked it are one row.
    const rowStates = (mac) =>
      approvalRowOf(mac).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-state')))
    await eventually(
      async () => JSON.stringify(await rowStates(macB)) === '["elsewhere"]',
      'the other Mac records the approval once, as answered elsewhere'
    )
    assert.deepEqual(await rowStates(macA), ['answered'])
    // A late answer from Mac B's view is refused by the server, never recorded.
    const lateApproval = await macB.win.evaluate(
      ({ id, providerRequestId }) =>
        window.electronAPI
          .sessionsWrite(id, {
            type: 'permission_response',
            id: providerRequestId,
            optionId: 'decline'
          })
          .then(
            () => 'accepted',
            () => 'refused'
          ),
      { id: providerKey(macB), providerRequestId: nativeApproval.providerRequestId }
    )
    assert.equal(lateApproval, 'refused')
    assert.equal(replies().filter((r) => r.id === 'fleet-native-approval').length, 1)
    t.check(
      'native approval docks in its session on both Macs, one answer settles it everywhere and a late one is refused',
      true
    )

    assert.deepEqual(
      nativeQuestion.questions.map((q) => q.id),
      ['fleet-public-id', 'fleet-private-id']
    )
    assert.deepEqual(
      nativeQuestion.questions.map((q) => q.question),
      ['Same fleet label?', 'Same fleet label?']
    )
    assert.deepEqual(nativeQuestion.secretQuestions, ['fleet-private-id'])
    const publicValues = ['Public answer from Mac A', 'Different public answer from Mac B']
    const privateValues = ['123-fleet-private-input', '456-fleet-other-answer']
    for (const [index, mac] of clients.entries()) {
      const dock = dockOf(mac)
      assert.ok((await dock.innerText()).includes('Fleet public answer'))
      const publicInput = dock.locator('textarea.chat-prompt-other')
      await publicInput.fill(publicValues[index])
      await dock.getByRole('button', { name: 'Next', exact: true }).click()
      const privateInput = dock.locator('input.chat-prompt-other')
      await privateInput.waitFor()
      assert.equal(await privateInput.getAttribute('type'), 'password')
      assert.equal(await privateInput.getAttribute('aria-label'), 'Fleet private answer')
      // Real key events pin the dock's number-key handler as well as input state.
      await privateInput.pressSequentially(privateValues[index])
      assert.equal(await privateInput.inputValue(), privateValues[index])
      await dock.getByRole('button', { name: 'Review', exact: true }).click()
      const review = await dock.innerText()
      assert.ok(review.includes(publicValues[index]))
      assert.equal(review.includes(privateValues[index]), false)
    }
    // Exercise the dock's actual answer-key mapping. A bridge-only race could
    // pass even if the view overwrote one same-label answer.
    await dockOf(macA).getByRole('button', { name: 'Send', exact: true }).click()
    await eventually(
      () => replies().filter((r) => r.id === 'fleet-native-question').length === 1,
      'provider receives the dock submission once'
    )
    assert.deepEqual(replies().find((r) => r.id === 'fleet-native-question').result.answers, {
      'fleet-public-id': { answers: [publicValues[0]] },
      'fleet-private-id': { answers: [privateValues[0]] }
    })
    for (const mac of clients)
      await eventually(async () => (await dockOf(mac).count()) === 0, 'the dock settles')
    const stale = await macB.win.evaluate(
      ({ key, response }) => window.electronAPI.fleetResolve(key, response),
      {
        key: owned('request', macB.owners[0].id, nativeQuestion.id),
        response: {
          type: 'permission',
          optionId: 'answer',
          answers: {
            'fleet-public-id': publicValues[1],
            'fleet-private-id': privateValues[1]
          }
        }
      }
    )
    assert.equal(stale.accepted, false)
    assert.equal(replies().filter((r) => r.id === 'fleet-native-question').length, 1)
    t.check(
      'same-label native public/private questions keep distinct IDs, masking and typed answers through the session dock and stale-client settlement',
      true
    )
    // The Clave-tool requests are still waiting in the dialog.
    for (const mac of clients) {
      await showMac(mac)
      await clickReady(mac.win.getByRole('button', { name: 'Requests waiting (2)', exact: true }))
    }

    const explicit = pending.find((p) => p.id === question.requestId)
    for (const mac of clients) await mac.win.getByLabel('Fleet branch?', { exact: true }).waitFor()
    const explicitKey = explicit.questions[0].id ?? 'Fleet branch?'
    await race(
      explicit,
      ['dev', 'other'].map((value) => ({
        type: 'clarification',
        answers: { [explicitKey]: value }
      }))
    )
    for (const mac of clients)
      await mac.win.getByLabel('Fleet branch?', { exact: true }).waitFor({ state: 'detached' })
    t.check(
      'explicit MCP clarification replays and first resolution dismisses it on both Macs',
      true
    )

    const secretRequest = pending.find((p) => p.id === secret.requestId)
    for (const mac of clients) {
      const input = mac.win.getByLabel('Secret value', { exact: true })
      await input.waitFor()
      assert.equal(await input.getAttribute('type'), 'password')
    }
    const values = ['fleet-synthetic-secret-one', 'fleet-synthetic-secret-two']
    const secretWinner = await race(
      secretRequest,
      values.map((value) => ({ type: 'secret', value }))
    )
    assert.equal(readFileSync(secretFile, 'utf8'), `FLEET_TEST_VALUE=${values[secretWinner]}\n`)
    assert.equal(existsSync(path.join(other.root, 'fixture-secret.env')), false)
    for (const mac of clients) {
      await mac.win.getByLabel('Secret value', { exact: true }).waitFor({ state: 'detached' })
      const history = await mac.win.evaluate(
        (id) => window.electronAPI.sessionsHistory(id),
        owned('session', mac.owners[0].id, provider.id)
      )
      const body = await mac.win.locator('body').innerText()
      for (const value of [...values, ...privateValues]) {
        assert.equal(JSON.stringify(history).includes(value), false)
        assert.equal(body.includes(value), false)
      }
      assert.deepEqual(mac.errors, [])
    }
    assert.deepEqual((await request(server, '/requests/pending')).pending, [])
    t.check(
      'explicit secret executes once on the owning server and answers stay out of both clients history and rendered text',
      true
    )
    // The Clave-tool requests above were answered from the Mac workspace. The
    // provider's tab itself shows only in a workspace of its server (#241).
    const providerRow = macA.win.locator(
      `[data-sidebar-item-id="${owned('session', macA.owners[0].id, provider.id)}"]`
    )
    await showServer(macA, 0)
    await providerRow.waitFor()
    await showMac(macA)
    await eventually(
      async () => (await providerRow.count()) === 0,
      'the provider tab is hidden in the Mac workspace'
    )
    t.check('the provider tab shows in its server workspace and never in the Mac workspace', true)
    assert.ok(report.runId)
  } finally {
    await mcp?.close()
    await world.close()
  }
}
