import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO } from './harness.mjs'
import {
  fleetWorld,
  clickReady,
  connectMac,
  eventually,
  owned,
  ownerReady,
  request,
  showServer
} from './fixtures/fleet-world.mjs'

// A server session whose past holds a finished question under the id its live
// private question carries now: a restarted provider numbers its requests
// from zero again (#261, verification round 2, V3). The dock must answer the
// live question with the live question's masking, and keep the old one as a
// closed record. The control gives the old question an id of its own.
export async function run(t) {
  for (const reused of [true, false]) {
    const world = await fleetWorld(`request-history-${reused ? 'reused' : 'distinct'}`)
    try {
      const server = world.servers[0]
      await request(server, '/launch-profiles', {
        profile: {
          id: 'fleet-history-provider',
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
          launchProfileId: 'chat:codex:fleet-history-provider'
        }
      })
      await eventually(
        async () => (await request(server, '/requests/pending')).pending.length === 2,
        'the live approval and question wait on the server'
      )
      const pending = (await request(server, '/requests/pending')).pending
      const approval = pending.find((r) => r.providerRequestId === '"fleet-native-approval"')
      const question = pending.find((r) => r.providerRequestId === '"fleet-native-question"')
      assert.deepEqual(question.secretQuestions, ['fleet-private-id'])
      // The past an older process left: the same question, public, answered.
      await server.fixture.evaluate(
        ({ id, question, reused }) => {
          const host = globalThis.__claveE2E.sessionHost
          const history = host.history
          const questions = question.questions.map((q, i) => ({
            ...q,
            header: `Previous public field ${i + 1}`
          }))
          const old = {
            type: 'permission_request',
            id: reused ? question.providerRequestId : '"older-process-question"',
            description: question.description,
            toolName: question.toolName,
            options: question.options,
            questions,
            input: {
              threadId: 'older-thread',
              turnId: 'older-turn',
              itemId: 'older-item',
              questions: questions.map((q) => ({ ...q, isSecret: false }))
            }
          }
          host.history = (sid, before, limit) => {
            const page = history.call(host, sid, before, limit)
            return sid === id && before === undefined
              ? {
                  ...page,
                  items: [
                    { event: old, at: 1 },
                    { event: { type: 'state_change', state: 'done' }, at: 2 },
                    ...page.items
                  ]
                }
              : page
          }
        },
        { id: provider.id, question, reused }
      )
      const mac = await world.mac('history')
      await connectMac(mac, [server], { ui: false })
      const key = owned('session', mac.owners[0].id, provider.id)
      await showServer(mac, 0)
      await ownerReady(mac, mac.owners[0].id, key)
      await clickReady(mac.win.locator(`[data-sidebar-item-id="${key}"]`))
      const pane = mac.win.locator(`.chat-host[data-session-id="${key}"]`)
      const questionRows = pane.locator('.chat-permission-row[data-kind="question"]:visible')
      await eventually(
        async () => (await questionRows.count()) === 2,
        'the old and the live question are two records'
      )
      // The live approval comes first, then the live question: never the old one.
      const dock = pane.locator('.chat-prompt:visible')
      await dock.getByText(approval.description, { exact: true }).waitFor()
      const accept = approval.options.find((o) => o.id === 'accept')
      await clickReady(dock.getByRole('button', { name: accept.label, exact: true }))
      await eventually(
        async () => (await dock.innerText()).includes('Fleet public answer'),
        'the live question follows the approval'
      )
      assert.equal((await dock.innerText()).includes('Previous public field'), false)
      await dock.locator('textarea.chat-prompt-other').fill('synthetic public response')
      await dock.getByRole('button', { name: 'Next', exact: true }).click()
      const privateField = dock.locator('input.chat-prompt-other')
      await privateField.waitFor()
      assert.equal(await privateField.getAttribute('type'), 'password')
      const secret = `srvq-synthetic-private-${reused ? 'reused' : 'distinct'}`
      await privateField.fill(secret)
      await dock.getByRole('button', { name: 'Review', exact: true }).click()
      assert.equal((await dock.innerText()).includes(secret), false, 'masked at review')
      await dock.getByRole('button', { name: 'Send', exact: true }).click()
      const replies = () => {
        const file = path.join(server.root, 'provider-replies.jsonl')
        return existsSync(file)
          ? readFileSync(file, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((s) => JSON.parse(s))
          : []
      }
      await eventually(
        () => replies().filter((r) => r.id === 'fleet-native-question').length === 1,
        'the live provider receives the answer once'
      )
      assert.deepEqual(replies().find((r) => r.id === 'fleet-native-question').result.answers, {
        'fleet-public-id': { answers: ['synthetic public response'] },
        'fleet-private-id': { answers: [secret] }
      })
      await eventually(async () => (await dock.count()) === 0, 'the dock settles')
      assert.equal((await pane.innerText()).includes(secret), false, 'kept out of the transcript')
      const states = await questionRows.evaluateAll((rows) =>
        rows.map((row) => row.getAttribute('data-state'))
      )
      assert.deepEqual(states, ['elsewhere', 'answered'], 'the old record stays closed')
      assert.deepEqual(mac.errors, [])
      t.check(
        reused
          ? 'an older question under the live id never replaces the live question or its masking'
          : 'an older question under its own id stays a closed record beside the live one',
        true
      )
    } finally {
      await world.close()
    }
  }
}
