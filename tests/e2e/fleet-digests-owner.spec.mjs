/**
 * A server tab's exchange digest is read by the server the tab runs on, on
 * the tab's own NAMED server account, and every client of that server reads
 * the same one (PRDCT-4327). One daemon, two Macs. Under the harness no model
 * runs: the daemon's reply comes from CLAVE_E2E_DIGEST_REPLY, its `{account}`
 * standing for the account the read ran on, so the summary says which one.
 * The Macs are given NO reply: a digest read on a Mac fails there.
 *
 * Fails if:
 * - the window reads a server tab's digest on this Mac (the route): the Mac
 *   has no reply, the card fails instead of showing the server's summary;
 * - the server reads the launch anywhere but its own record of the session:
 *   the summary names `default`, not the tab's account;
 * - the digest is filed on the Mac rather than the server: the second Mac
 *   finds nothing and reads it fresh (`data-digest-fresh`);
 * - a failure is final for the run: Ask again never reads it.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  fleetWorld,
  connectMac,
  eventually,
  owned,
  request,
  showServer
} from './fixtures/fleet-world.mjs'

const header = (name, id) =>
  `[Message from Clave tab "${name}" — reply with clave_send_to_session sessionId="${id}"]\n`
const exchange = (tag) => [
  { type: 'user_message', text: `Coordinate with the verifier ${tag}.` },
  { type: 'assistant_text', delta: 'Asking the verifier.', final: true },
  { type: 'user_message', text: header('Verifier', 'v1') + `VERIFY-ACK ${tag}: starting.` },
  {
    type: 'user_message',
    text: header('Verifier', 'v1') + `VERIFY-REPORT ${tag}: one blocking finding. Fix it here?`
  },
  { type: 'assistant_text', delta: 'Waiting.', final: true }
]
const REPLY = JSON.stringify({ needs_you: true, message: 2, summary: 'Read on {account}.' })

const inject = (server, id, events) =>
  server.fixture.evaluate(
    ({ id, events }) => {
      for (const event of events) globalThis.__claveE2E.echo.inject(id, { kind: 'event', event })
    },
    { id, events }
  )
const setReply = (server, reply) =>
  server.fixture.evaluate((reply) => {
    process.env.CLAVE_E2E_DIGEST_REPLY = reply
  }, reply)

async function openTab(mac, key) {
  await showServer(mac, 0)
  await mac.win.locator(`[data-sidebar-item-id="${key}"]`).click()
  const chat = mac.win.locator(`[data-session-id="${key}"] [data-testid="chat-view"]`)
  await chat.waitFor()
  return chat
}

export async function run(t) {
  const world = await fleetWorld('digests-owner', {
    count: 1,
    env: { CLAVE_E2E_DIGEST_REPLY: REPLY }
  })
  try {
    const [server] = world.servers
    const account = await request(server, '/accounts/claude', { label: 'Named on the server' })
    const started = await request(server, '/sessions/start', {
      cwd: server.root,
      options: {
        claudeMode: true,
        launchProfileId: 'dev-echo-adapter',
        claudeProfileId: account.id
      }
    })

    // ── Mac A: the server reads the digest, on the tab's named account ──
    const a = await world.mac('a')
    await connectMac(a, world.servers, { ui: false })
    const key = owned('session', a.owners[0].id, started.id)
    const chatA = await openTab(a, key)
    await inject(server, started.id, exchange('one'))
    const timelineA = chatA.locator('.exchange-timeline').first()
    await timelineA.waitFor()
    await eventually(
      async () => ['done', 'failed'].includes(await timelineA.getAttribute('data-digest')),
      'the first timeline is read'
    )
    const shownA = {
      state: await timelineA.getAttribute('data-digest'),
      text:
        (await timelineA.locator('.exchange-digest-text').count()) > 0
          ? await timelineA.locator('.exchange-digest-text').innerText()
          : null
    }
    t.check(
      "a server tab's digest is read by its server on the tab's named server account",
      shownA.state === 'done' && shownA.text === `Read on ${account.id}.`,
      shownA
    )
    const filed = await request(
      server,
      `/digests/exchanges-of?sessionId=${encodeURIComponent(started.id)}`
    )
    t.check(
      "the digest is filed in the server's data folder under the server's id of the tab",
      Object.values(filed).some((d) => d.summary === `Read on ${account.id}.`),
      filed
    )
    const macFile = path.join(a.dir, 'exchange-digests.json')
    const onMac = existsSync(macFile) ? Object.keys(JSON.parse(readFileSync(macFile, 'utf8'))) : []
    t.check('nothing of it is filed on the Mac', onMac.length === 0, onMac)

    // ── Mac B: a second client reads the same digest, found filed ──
    const b = await world.mac('b')
    await connectMac(b, world.servers, { ui: false })
    const keyB = owned('session', b.owners[0].id, started.id)
    const chatB = await openTab(b, keyB)
    const timelineB = chatB.locator('.exchange-timeline').first()
    await timelineB.waitFor()
    await eventually(
      async () => (await timelineB.getAttribute('data-digest')) === 'done',
      'the second Mac shows the digest'
    )
    const shownB = {
      text: await timelineB.locator('.exchange-digest-text').innerText(),
      fresh: await timelineB.getAttribute('data-digest-fresh')
    }
    t.check(
      'a second client of the server reads the same digest, found filed rather than read again',
      shownB.text === `Read on ${account.id}.` && shownB.fresh === null,
      shownB
    )
    await b.close()

    // ── A read that fails says why, and Ask again reads it ──
    await setReply(server, 'E2E_FAIL:limit')
    await inject(server, started.id, exchange('two'))
    const timelines = chatA.locator('.exchange-timeline')
    await eventually(async () => (await timelines.count()) >= 2, 'the second timeline is drawn')
    const second = timelines.last()
    await eventually(
      async () => (await second.getAttribute('data-digest')) === 'failed',
      'the second timeline fails to read'
    )
    const line = await second.locator('.digest-unread-words').innerText()
    t.check(
      'a failed read shows one quiet line with the class of its reason',
      line === 'Not read: the account is at its limit.',
      { line }
    )
    await setReply(server, REPLY)
    await second.getByRole('button', { name: 'Ask again', exact: true }).click()
    await eventually(
      async () => (await second.getAttribute('data-digest')) === 'done',
      'Ask again reads it'
    )
    t.check(
      'Ask again reads the failed digest on the server',
      (await second.locator('.exchange-digest-text').innerText()) === `Read on ${account.id}.` &&
        (await second.locator('.digest-unread').count()) === 0,
      true
    )
    assert.deepEqual(a.errors, [])
  } finally {
    await world.close()
  }
}
