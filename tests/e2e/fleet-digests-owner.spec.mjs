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
const WORK_REPLY = JSON.stringify({ title: 'Titled on {account}', needs_you: false, note: null })

// A turn of working notes (three, the fold's minimum, `MIN_NOTES`) that
// folds into one work card once it is over.
let calls = 0
const tool = () => {
  const id = `wd-${++calls}`
  return [
    { type: 'tool_call', id, name: 'Bash', input: { command: `cmd ${id}` } },
    { type: 'tool_result', id, output: 'ok' }
  ]
}
const turn = (tag) => [
  { type: 'state_change', state: 'working' },
  { type: 'user_message', text: `work ${tag}` },
  { type: 'assistant_text', delta: `First note of ${tag}: reading the code.`, final: true },
  ...tool(),
  { type: 'assistant_text', delta: `Second note of ${tag}: the fix is in.`, final: true },
  ...tool(),
  { type: 'assistant_text', delta: `Third note of ${tag}: the tests pass.`, final: true },
  ...tool(),
  { type: 'assistant_text', delta: `Done with ${tag}.`, final: true },
  { type: 'state_change', state: 'idle' }
]

const inject = (server, id, events) =>
  server.fixture.evaluate(
    ({ id, events }) => {
      for (const event of events) globalThis.__claveE2E.echo.inject(id, { kind: 'event', event })
    },
    { id, events }
  )
const setReply = (server, reply, name = 'CLAVE_E2E_DIGEST_REPLY') =>
  server.fixture.evaluate(
    ({ reply, name }) => {
      process.env[name] = reply
    },
    { reply, name }
  )

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
    env: { CLAVE_E2E_DIGEST_REPLY: REPLY, CLAVE_E2E_WORK_DIGEST_REPLY: WORK_REPLY }
  })
  try {
    const [server] = world.servers
    const account = await request(server, '/accounts/claude', { label: 'Named on the server' })
    // A named account reads with its token, as the CLI would (`testAccount`).
    await request(server, '/accounts/claude/token', {
      id: account.id,
      token: `sk-ant-oat01-${'x'.repeat(80)}`
    })
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

    // ── A work card on the server tab: titled by the server, on the tab's account ──
    await inject(server, started.id, turn('one'))
    const cardA = chatA.locator('.work-stretch').first()
    await cardA.waitFor()
    await eventually(
      async () => ['done', 'failed'].includes(await cardA.getAttribute('data-digest')),
      'the first work card is titled'
    )
    const titleA = await cardA.locator('.stretch-title-words').innerText()
    t.check(
      "a server tab's work card is titled by its server on the tab's named server account",
      (await cardA.getAttribute('data-digest')) === 'done' && titleA === `Titled on ${account.id}`,
      { titleA }
    )
    const workFiled = await request(
      server,
      `/digests/work-of?sessionId=${encodeURIComponent(started.id)}`
    )
    t.check(
      'the title is filed on the server under the tab it was asked for',
      Object.values(workFiled).some((d) => d.title === `Titled on ${account.id}`),
      workFiled
    )

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
    const cardB = chatB.locator('.work-stretch').first()
    await cardB.waitFor()
    await eventually(
      async () => (await cardB.getAttribute('data-digest')) === 'done',
      'the second Mac shows the work card titled'
    )
    const workB = {
      title: await cardB.locator('.stretch-title-words').innerText(),
      fresh: await cardB.getAttribute('data-digest-fresh')
    }
    t.check(
      'a second client finds the work card title filed rather than read again',
      workB.title === `Titled on ${account.id}` && workB.fresh === null,
      workB
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
      line === 'Not read: this account is at its limit.',
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

    // ── A work card whose title could not be read says so, and Ask again titles it ──
    await setReply(server, 'E2E_FAIL:limit', 'CLAVE_E2E_WORK_DIGEST_REPLY')
    await inject(server, started.id, turn('two'))
    const cards = chatA.locator('.work-stretch')
    await eventually(async () => (await cards.count()) >= 2, 'the second work card is drawn')
    const failedCard = cards.last()
    await eventually(
      async () => (await failedCard.getAttribute('data-digest')) === 'failed',
      'the second work card fails to be titled'
    )
    const workLine = await failedCard.locator('.digest-unread-words').innerText()
    t.check(
      'a work card that could not be titled says why in one line',
      workLine === 'No title: this account is at its limit.',
      { workLine }
    )
    await setReply(server, WORK_REPLY, 'CLAVE_E2E_WORK_DIGEST_REPLY')
    // From the keyboard: the control takes the focus and Enter asks.
    const again = failedCard.getByRole('button', { name: 'Ask again', exact: true })
    await again.focus()
    await a.win.keyboard.press('Enter')
    await eventually(
      async () => (await failedCard.getAttribute('data-digest')) === 'done',
      'Ask again titles the work card'
    )
    t.check(
      'Ask again on a work card, pressed with Enter, titles it on the server, and the card stays closed',
      (await failedCard.locator('.stretch-title-words').innerText()) ===
        `Titled on ${account.id}` &&
        (await failedCard.locator('.digest-unread').count()) === 0 &&
        !(await failedCard.locator('details.stretch-card').evaluate((el) => el.open)),
      true
    )
    assert.deepEqual(a.errors, [])
  } finally {
    await world.close()
  }
}
