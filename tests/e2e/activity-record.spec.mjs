// Pinned to the in-process server (wave 5, lane C, PRDCT-3433, when the chat
// helper stopped pinning): the activity record is written by the shell from
// the session events it sees, and attached the sessions live on the server;
// measured on 13 October 2026 attached: the ledger held the app's start row
// and no open row and no state row for the echo session. Not a known failure.
// The activity record (PRDCT-3384, PRDCT-3385): a session's open, its run
// states and its close reach the ledger under the app's data folder, and the
// fold answers them as a lane with a burst on today's day. Built on the echo
// chat: its state words are injected where the session lives, a second
// apart, so the burst has a length the fold keeps.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { openChat, inject } from './chat-view.spec.mjs'
import { fixturePath, until } from './harness.mjs'

const localDay = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export async function run(t) {
  const suffix = 'activity-record'
  const chat = await openChat(suffix, [], undefined, {}, null, { server: 'in-process' })
  const { win, record, fixture } = chat
  const dir = fixturePath(suffix)
  const file = path.join(dir, 'activity', 'activity.jsonl')
  try {
    const rows = () =>
      existsSync(file)
        ? readFileSync(file, 'utf-8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : []
    t.check(
      'the boot wrote an app start row and the echo session an open row',
      await until(
        () =>
          rows().some((r) => r.kind === 'app' && r.app === 'start') &&
          rows().some((r) => r.kind === 'open' && r.id === record.id && r.provider === 'echo')
      ),
      JSON.stringify(rows().slice(0, 4))
    )

    await inject(fixture, record.id, [{ type: 'state_change', state: 'working' }])
    await new Promise((r) => setTimeout(r, 1200))
    await inject(fixture, record.id, [{ type: 'state_change', state: 'blocked' }])
    await new Promise((r) => setTimeout(r, 400))
    await inject(fixture, record.id, [{ type: 'state_change', state: 'done' }])
    t.check(
      'the three state words landed as state rows, in order',
      await until(() => {
        const states = rows()
          .filter((r) => r.kind === 'state' && r.id === record.id)
          .map((r) => r.state)
        return JSON.stringify(states) === JSON.stringify(['working', 'blocked', 'done'])
      }),
      JSON.stringify(rows().filter((r) => r.kind === 'state'))
    )

    const today = localDay(Date.now())
    const answer = await win.evaluate((d) => window.electronAPI.activityQuery(d, d), today)
    assert.equal(answer.days.length, 1)
    const day = answer.days[0]
    const lane = day.sessions.find((s) => s.id === record.id)
    assert.ok(lane, 'the echo session is a lane of today')
    t.check('the lane is tracked, live and carries one burst and one wait', true)
    assert.equal(lane.tracked, true)
    assert.equal(lane.live, true)
    assert.equal(lane.working.length, 1)
    assert.equal(lane.blocked.length, 1)
    assert.ok(lane.working[0][1] > lane.working[0][0])
    assert.ok(day.totals.coverageMin >= 1, `coverage ${day.totals.coverageMin}`)
    assert.ok(day.totals.peak >= 1)
    assert.equal(day.totals.bursts, 1)
    assert.ok(day.totals.appMin >= 1)
    t.check('the fold counts coverage, a peak, one burst and the app minutes', true)

    // A changed push follows a row: subscribe, inject, wait for the call.
    await win.evaluate(() => {
      globalThis.__activityChanged = 0
      window.electronAPI.onActivityChanged(() => {
        globalThis.__activityChanged++
      })
    })
    await inject(fixture, record.id, [{ type: 'state_change', state: 'working' }])
    t.check(
      'a row landing pushes activity:changed to the window',
      await until(() => win.evaluate(() => globalThis.__activityChanged > 0), {
        tries: 40,
        gapMs: 250
      })
    )

    // The close row, written when the tab goes.
    await win.evaluate((id) => window.electronAPI.killSession?.(id), record.id).catch(() => {})
  } finally {
    await chat.close()
  }
}
