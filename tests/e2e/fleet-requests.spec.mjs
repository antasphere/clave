import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { REPO } from './harness.mjs'
import {
  fleetWorld,
  connectMac,
  eventually,
  owned,
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
    for (const mac of clients)
      await mac.win.getByText(nativeApproval.description, { exact: true }).waitFor()
    const approvalWinner = await race(nativeApproval, [
      { type: 'permission', optionId: 'accept' },
      { type: 'permission', optionId: 'decline' }
    ])
    await eventually(
      () => replies().filter((r) => r.id === 'fleet-native-approval').length === 1,
      'provider receives one approval answer'
    )
    assert.equal(
      replies().find((r) => r.id === 'fleet-native-approval').result.decision,
      approvalWinner ? 'decline' : 'accept'
    )
    t.check(
      'native approval replays to both Macs and exactly one provider response settles everywhere',
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
      const publicInput = mac.win.getByLabel('Fleet public answer', { exact: true })
      const privateInput = mac.win.getByLabel('Fleet private answer', { exact: true })
      await publicInput.waitFor()
      await privateInput.waitFor()
      assert.equal(await publicInput.getAttribute('type'), 'text')
      assert.equal(await privateInput.getAttribute('type'), 'password')
      await publicInput.fill(publicValues[index])
      // Real key events pin the numeric-key handler as well as input state.
      await privateInput.pressSequentially(privateValues[index])
      assert.equal(await publicInput.inputValue(), publicValues[index])
      assert.equal(await privateInput.inputValue(), privateValues[index])
    }
    // Exercise the consumer's actual answer-key mapping. A bridge-only race
    // could pass even if the renderer overwrote one same-label answer.
    const submit = nativeQuestion.options.find((option) => option.id === 'answer')
    assert.ok(submit, 'native clarification advertises its submission action')
    await macA.win.getByRole('button', { name: submit.label, exact: true }).click()
    await eventually(
      () => replies().filter((r) => r.id === 'fleet-native-question').length === 1,
      'provider receives the UI submission once'
    )
    assert.deepEqual(replies().find((r) => r.id === 'fleet-native-question').result.answers, {
      'fleet-public-id': { answers: [publicValues[0]] },
      'fleet-private-id': { answers: [privateValues[0]] }
    })
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
    for (const mac of clients) {
      await mac.win
        .getByLabel('Fleet public answer', { exact: true })
        .waitFor({ state: 'detached' })
      await mac.win
        .getByLabel('Fleet private answer', { exact: true })
        .waitFor({ state: 'detached' })
    }
    t.check(
      'same-label native public/private questions keep distinct IDs, masking and typed answers through UI submission and stale-client settlement',
      true
    )

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
    // The requests above were answered from the Mac workspace. The provider's
    // tab itself shows only in a workspace of its server (#241).
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
