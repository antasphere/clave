/**
 * A server tab's digest is read on the launch of the server's own RECORD of
 * the session (PRDCT-4327). One daemon, one Mac; the tab is a real Claude
 * chat on the daemon over the stream-json stand-in
 * (`fixtures/claude-stream-stub.mjs`), so the server keeps a record of it, on
 * a NAMED server account. Under the harness no model runs: the daemon's
 * reply comes from CLAVE_E2E_DIGEST_REPLY, its `{account}` standing for the
 * account the read ran on.
 *
 * 1. Messages from another tab, typed into the chat: the timeline's digest
 *    names the tab's first account.
 * 2. The tab is switched to a second server account (`/sessions/restart`):
 *    the next timeline's digest names the second account.
 * 3. The daemon restarts: the tab has its record and no process. A digest
 *    asked of the server then can only come from the record, and names the
 *    second account.
 *
 * Fails if: the server reads anything but its record first (the resolver
 * reduced to the spawn's launch: step 3 is refused as an unknown tab), or a
 * switch leaves the record on the old account (step 2 or 3 names the first).
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { REPO, fixturePath } from './harness.mjs'
import {
  fleetWorld,
  connectMac,
  eventually,
  owned,
  request,
  showServer
} from './fixtures/fleet-world.mjs'

const REPLY = JSON.stringify({ needs_you: true, message: 1, summary: 'Read on {account}.' })
const header = (name, id) =>
  `[Message from Clave tab "${name}" — reply with clave_send_to_session sessionId="${id}"]\n`

/** `digestKey` of `src/shared/exchange-digest.ts`, the same FNV-1a: the key a
 *  host recomputes from the messages it is sent. */
const digestKey = (messages) => {
  const text = JSON.stringify(messages)
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${messages.length}-${(hash >>> 0).toString(36)}`
}

export async function run(t) {
  const transcripts = fixturePath(`digests-record-transcripts-${process.pid}`)
  const world = await fleetWorld('digests-record', {
    count: 1,
    env: { CLAVE_E2E_DIGEST_REPLY: REPLY, CLAVE_TRANSCRIPTS_ROOT: transcripts }
  })
  try {
    const [server] = world.servers
    await request(server, '/launch-profiles', {
      profile: {
        id: 'digests-record-stub',
        name: 'Digests record stream stub',
        family: 'claude',
        command: [process.execPath, path.join(REPO, 'tests/e2e/fixtures/claude-stream-stub.mjs')],
        additionalArgs: []
      }
    })
    const account = async (label) => {
      const added = await request(server, '/accounts/claude', { label })
      await request(server, '/accounts/claude/token', {
        id: added.id,
        token: `sk-ant-oat01-${'x'.repeat(80)}`
      })
      return added.id
    }
    const first = await account('First server account')
    const second = await account('Second server account')
    const started = await request(server, '/sessions/start', {
      cwd: server.root,
      options: {
        claudeMode: true,
        launchProfileId: 'chat:claude:digests-record-stub',
        claudeProfileId: first
      }
    })

    const mac = await world.mac('record')
    await connectMac(mac, world.servers, { ui: false })
    const key = owned('session', mac.owners[0].id, started.id)
    const { win } = mac
    await showServer(mac, 0)
    await win.locator(`[data-sidebar-item-id="${key}"]`).click()
    const pane = win.locator(`[data-session-id="${key}"]`)
    const chat = pane.locator('[data-testid="chat-view"]')
    const composer = chat.getByRole('textbox', { name: 'Message', exact: true })
    await chat.waitFor()

    /** Type a message as another tab delivers one, and wait for its answer. */
    const deliver = async (text) => {
      await eventually(() => composer.isEnabled(), 'the chat’s composer is enabled')
      await composer.fill(header('Verifier', 'v1') + text)
      await composer.press('Enter')
      await chat
        .locator('.chat-turn[data-role="assistant"]')
        .filter({ hasText: `stub heard:` })
        .filter({ hasText: text.slice(0, 20) })
        .first()
        .waitFor()
    }
    const lastDigest = async () => {
      const timeline = chat.locator('.exchange-timeline').last()
      await timeline.waitFor()
      await eventually(
        async () => ['done', 'failed'].includes(await timeline.getAttribute('data-digest')),
        'the timeline is read'
      )
      return {
        state: await timeline.getAttribute('data-digest'),
        text:
          (await timeline.locator('.exchange-digest-text').count()) > 0
            ? await timeline.locator('.exchange-digest-text').innerText()
            : await timeline.locator('.digest-unread-words').allInnerTexts()
      }
    }

    // ── 1. The tab's first account ──
    await deliver(`VERIFY-REPORT one ${world.run.slice(-6)}: fix it here?`)
    const one = await lastDigest()
    t.check(
      "a recorded server tab's digest is read on the tab's named server account",
      one.state === 'done' && one.text === `Read on ${first}.`,
      one
    )

    // ── 2. Switched to the second account mid-life ──
    await request(server, '/sessions/restart', {
      id: started.id,
      account: { claudeProfileId: second }
    })
    await deliver(`VERIFY-REPORT two ${world.run.slice(-6)}: merge now?`)
    const two = await lastDigest()
    t.check(
      'after the tab is switched to another server account, its next digest is read on that account',
      two.state === 'done' && two.text === `Read on ${second}.`,
      two
    )

    // ── 3. The daemon restarts: the record, and no process ──
    await mac.close()
    await world.restart(0)
    const messages = [{ from: 'Verifier', text: `VERIFY-REPORT three ${world.run.slice(-6)}` }]
    const answer = await request(server, '/digests/exchange', {
      sessionId: started.id,
      key: digestKey(messages),
      messages
    })
    t.check(
      'a tab the server knows only by its record is read on the account the record names',
      answer.ok === true && answer.summary === `Read on ${second}.`,
      answer
    )
    const unknown = [{ from: 'Verifier', text: 'nobody' }]
    const refused = await request(server, '/digests/exchange', {
      sessionId: '00000000-0000-4000-8000-00000000dead',
      key: digestKey(unknown),
      messages: unknown
    })
    t.check(
      'a tab the server has no record of is refused as such',
      refused.ok === false && refused.reason === 'unknown-session',
      refused
    )
    assert.ok(true)
  } finally {
    await world.close()
  }
}
