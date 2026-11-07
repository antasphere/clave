// The phone is told when an agent needs you (the mobile wave, lane B; decisions
// 9 and 10 of the spec, issue #282). On the real app attached to a standalone
// server started with the recording push transport (`--push-fake`, which the
// harness hands to the server beside `--dev-echo-adapter`):
//
// 1. a question raised in an echo session (a permission_request frame carrying
//    a question, injected where the session lives) becomes a pending request
//    of the server, and ONE push is recorded for the fake phone, in the
//    question category, with the session's id, the question's text and the
//    pending request's id, and nothing of the request's input;
// 2. a chat message written twice with one client message id appears once in
//    the session's history, the echo answers it once, the server says it
//    accepted on the status route, says an id never sent is absent, and keeps
//    the id accepted in the ledger file under its data directory.
//
// Pinned attached: the pending-requests service lives on the standalone entry
// only (the in-process server has none, and takes the frame road instead,
// which the unit tests cover). What makes it able to fail: drop the notifier's
// request subscription and no push is recorded; leak the frame's `input` into
// the payload and the secret check goes red; drop the write ledger and the
// message lands twice.
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'
import { readServerDiscovery } from '../../scripts/server-process.mjs'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const SECRET = 'E2E-INPUT-SECRET-7731'
const QUESTION = 'Which branch do we ship from?'

const serverGet = async (server, path) => {
  const res = await fetch(server.url + path, {
    headers: { authorization: `Bearer ${server.token}` }
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const serverPost = async (server, path, body) => {
  const res = await fetch(server.url + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

export async function run(t) {
  const chat = await openChat('mobile-notify', ['--push-fake'], undefined, {}, null, {
    server: 'attached'
  })
  const { win, record, fixture, server } = chat
  try {
    const sent = () => fixture.evaluate(() => globalThis.__claveE2E.notify.sent())
    // ── A fake phone pairs: a push target of the server ──
    await fixture.evaluate(() => {
      const notify = globalThis.__claveE2E.notify
      if (!notify) throw new Error('no notify hooks on the server: is --push-fake on?')
      notify.targets.add({ deviceId: 'phone-1', platform: 'ios', token: 'ios-token-1' })
    })
    const status = await serverGet(server, '/notify/status')
    t.check(
      'the server says the fake stands in for both transports and holds one target',
      status.status === 200 &&
        status.body?.fake === true &&
        status.body?.transports?.ios === true &&
        status.body?.targets === 1,
      status
    )
    t.check(
      'the status route refuses a caller without the token',
      (await fetch(server.url + '/notify/status')).status === 401
    )

    // ── 1. A question raised in the session reaches the phone once ──
    await inject(fixture, record.id, [
      {
        type: 'permission_request',
        id: 'ask-1',
        description: 'Echo asks 1 question',
        toolName: 'AskUserQuestion',
        input: { secret: SECRET },
        options: [{ id: 'answer', label: 'Submit' }],
        questions: [{ question: QUESTION, options: [] }]
      }
    ])
    const first = await until(
      async () => {
        const all = await sent()
        return all.length ? all : null
      },
      { tries: 60, gapMs: 250 }
    )
    t.check('a question raised in the session produces a recorded push', !!first, first)
    const push = first?.[0]
    t.check(
      'the push goes to the fake phone, in the question category, with the session id and the question text',
      push?.deviceId === 'phone-1' &&
        push?.payload?.category === 'question' &&
        push?.payload?.sessionId === record.id &&
        push?.payload?.text === QUESTION &&
        push?.payload?.serverId === readServerDiscovery(server.dataDir)?.serverId,
      push
    )
    const pending = await serverGet(server, '/requests/pending')
    const request = pending.body?.pending?.find((r) => r.sessionId === record.id)
    t.check(
      'its request id is the pending request the phone resolves with',
      !!request && push?.payload?.requestId === request.id,
      { pending: pending.body, requestId: push?.payload?.requestId }
    )
    t.check(
      'a free-text question offers a reply from the notification',
      JSON.stringify(push?.payload?.actions) === JSON.stringify(['reply', 'open']),
      push?.payload?.actions
    )
    t.check(
      'nothing of the request’s input reached the push',
      !JSON.stringify(first).includes(SECRET),
      first
    )
    // Answered from here, as the phone would: no second push follows.
    const resolved = await serverPost(server, '/requests/resolve', {
      requestId: request?.id,
      response: { type: 'permission', optionId: 'answer', answers: { [QUESTION]: 'dev' } }
    })
    t.check(
      'the question is answered through the requests route',
      resolved.body?.accepted === true,
      resolved
    )
    await win.waitForTimeout(2500)
    const afterAnswer = await sent()
    t.check(
      'one push for the question, and none more once it is answered',
      afterAnswer.filter((s) => s.payload.category === 'question').length === 1,
      afterAnswer
    )

    // ── 2. A message written twice with one client id lands once ──
    const write = (clientMessageId) =>
      win.evaluate(
        ({ id, clientMessageId }) =>
          window.electronAPI
            .sessionsWrite(id, {
              type: 'user_message',
              text: 'twice over a flaky link',
              clientMessageId
            })
            .then(
              () => 'ok',
              (error) => `refused: ${error?.message}`
            ),
        { id: record.id, clientMessageId }
      )
    const outcomes = await Promise.all([write('e2e-twice-00001'), write('e2e-twice-00001')])
    t.check(
      'both writes are answered as the first one was',
      outcomes.join(',') === 'ok,ok',
      outcomes
    )
    const history = await until(
      async () => {
        const page = await win.evaluate((id) => window.electronAPI.sessionsHistory(id), record.id)
        return page?.items?.some((i) => i.event.type === 'assistant_text') ? page : null
      },
      { tries: 40, gapMs: 250 }
    )
    const messages = history?.items?.filter(
      (i) => i.event.type === 'user_message' && i.event.text === 'twice over a flaky link'
    )
    t.check(
      'the message appears once in the session’s history, with its client id',
      messages?.length === 1 && messages[0].event.clientMessageId === 'e2e-twice-00001',
      history?.items
    )
    const replies = history?.items?.filter(
      (i) => i.event.type === 'assistant_text' && i.event.delta === 'twice over a flaky link'
    )
    t.check('and the echo answered it once', replies?.length === 1, replies)
    const landed = await serverGet(
      server,
      `/sessions/writes?id=${encodeURIComponent(record.id)}&clientMessageId=e2e-twice-00001`
    )
    t.check(
      'the server says the id was accepted, with when',
      landed.status === 200 &&
        landed.body?.status === 'accepted' &&
        typeof landed.body?.at === 'number',
      landed
    )
    const never = await serverGet(
      server,
      `/sessions/writes?id=${encodeURIComponent(record.id)}&clientMessageId=e2e-never-00001`
    )
    t.check(
      'and that an id never sent is absent: the ledger is complete and never saw it',
      never.status === 200 && never.body?.status === 'absent',
      never
    )
    // The ledger is a file of the server's: it outlives the process.
    const ledgerFile = path.join(server.dataDir, 'write-ledger', `${record.id}.ledger.json`)
    const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : null
    t.check(
      'the ledger is persisted under the server’s data directory, complete, with the id accepted',
      ledger?.complete === true && ledger?.entries?.['e2e-twice-00001']?.status === 'accepted',
      ledger
    )
    const finished = (await sent()).filter((s) => s.payload.category === 'finished')
    t.check(
      'one turn ran, so one finished push went to the phone',
      finished.length === 1 && finished[0].payload.sessionId === record.id,
      finished
    )
  } finally {
    await chat.close()
  }
}
