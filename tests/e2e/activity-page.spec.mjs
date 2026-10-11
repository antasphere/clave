// The Activity page (PRDCT-3386): Settings → Activity draws the record. An
// echo session works for a second, and the page shows it as a lane with a
// burst on today's tape; a day seeded two days back carries a known session
// inside a known app run, so the hatching, the lane and the range's Coverage
// are checked against figures and not only against "not nothing". Built on
// the echo chat like activity-record.spec.mjs; the burst exists only if the
// recorder wrote the session's state rows, so a recorder that stops writing
// them turns this spec red, and so does a fold that answers the day without
// its minute arrays or a Coverage divided by the wrong number of days.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Two days back, local time: the app ran 09:00–13:00 and one Claude session
 *  was open 10:00–12:00, working the whole two hours. */
function seedRecord(dir) {
  const now = new Date()
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2)
  const at = (h, m = 0) =>
    new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).toISOString()
  const rows = [
    { v: 1, ts: at(9), kind: 'app', app: 'start' },
    {
      v: 1,
      ts: at(10),
      kind: 'open',
      id: 'seeded',
      provider: 'claude',
      cwd: '/seed',
      name: 'Seeded session',
      model: null
    },
    { v: 1, ts: at(10), kind: 'state', id: 'seeded', state: 'working' },
    { v: 1, ts: at(12), kind: 'state', id: 'seeded', state: 'idle' },
    { v: 1, ts: at(12), kind: 'close', id: 'seeded', name: 'Seeded session' },
    { v: 1, ts: at(13), kind: 'app', app: 'quit' }
  ]
  mkdirSync(path.join(dir, 'activity'), { recursive: true })
  writeFileSync(
    path.join(dir, 'activity', 'activity.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
  )
  return dayKey(day)
}

export async function run(t) {
  let seededDay = ''
  const chat = await openChat('activity-page', [], undefined, {}, (dir) => {
    seededDay = seedRecord(dir)
  })
  const { app, win, record, fixture } = chat
  try {
    await inject(fixture, record.id, [{ type: 'state_change', state: 'working' }])
    await pause(1200)
    await inject(fixture, record.id, [{ type: 'state_change', state: 'done' }])

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu:open-settings-section', 'activity')
    })
    await win.waitForSelector('[data-settings-page="activity"]', { timeout: 10_000 })

    t.check(
      'the sidebar selects the Activity row',
      (await win.locator('[data-settings-nav-row="activity"]').getAttribute('data-selected')) ===
        'true'
    )

    const lane = `[data-activity-lane][data-session-id="${record.id}"]`
    t.check(
      'the echo session is exactly one lane of today',
      await until(async () => (await win.locator(lane).count()) === 1),
      await win.locator('[data-activity-lane]').count()
    )
    t.check(
      'the lane carries its working burst',
      await until(async () => (await win.locator(`${lane} [data-activity-burst]`).count()) >= 1),
      await win.locator(`${lane} [data-activity-burst]`).count()
    )
    const tapePath = () =>
      win.locator('[data-activity-tape] .activity-tape-working').getAttribute('d')
    t.check(
      "today's tape draws the working minutes",
      await until(async () => ((await tapePath()) ?? '').length > 0),
      await tapePath()
    )

    const coverage = win
      .locator('[data-activity-headlines] .usage-tile')
      .filter({ has: win.locator('.usage-tile-label', { hasText: /^Coverage$/ }) })
      .locator('.usage-tile-value')
    let coverageText = ''
    t.check(
      'the Coverage tile is not 0 %',
      await until(async () => {
        if ((await coverage.count()) !== 1) return false
        coverageText = (await coverage.textContent())?.trim() ?? ''
        return coverageText !== '' && coverageText !== '0 %'
      }),
      coverageText
    )
    // The seeded 120 minutes over seven days: 120 / 10080 is 1.19 %, written 1 %.
    await win.locator('[data-activity-range-chip="7d"]').click()
    t.check(
      'over 7 days the Coverage tile reads the seeded two hours against seven days',
      await until(async () => ((await coverage.textContent())?.trim() ?? '') === '1 %'),
      await coverage.textContent()
    )

    const title = win.locator('[data-activity-day-title]')
    const prev = win.locator('[data-activity-day-prev]')
    const next = win.locator('[data-activity-day-next]')
    t.check('the day opens on Today', (await title.textContent()) === 'Today')
    t.check('the next-day button is disabled on today', await next.isDisabled())

    await prev.click()
    const yesterday = (await title.textContent()) ?? ''
    t.check(
      'the previous day changes the heading',
      yesterday !== 'Today' && yesterday !== '',
      yesterday
    )
    t.check(
      'the previous day has no lane for the session',
      await until(async () => (await win.locator(lane).count()) === 0)
    )
    t.check('the next-day button is enabled on yesterday', !(await next.isDisabled()))

    await prev.click()
    const seededLane = '[data-activity-lane][data-session-id="seeded"]'
    t.check(
      'two days back shows the seeded session as one lane with one burst',
      await until(
        async () =>
          (await win.locator(seededLane).count()) === 1 &&
          (await win.locator(`${seededLane} [data-activity-burst]`).count()) === 1
      ),
      await win.locator('[data-activity-lane]').count()
    )
    assert.equal(
      await win.locator('[data-activity-day]').getAttribute('data-activity-day'),
      seededDay
    )
    // The app ran 09:00–13:00 with the session open 10:00–12:00: closed
    // before nine and after one, two hatches, never under the open session.
    t.check(
      'the hours the app was closed are hatched in two stretches',
      await until(
        async () => (await win.locator('[data-activity-tape] .activity-tape-closed').count()) === 2
      ),
      await win.locator('[data-activity-tape] .activity-tape-closed').count()
    )
    const sum = (await win.locator('.activity-day-sum').textContent()) ?? ''
    t.check(
      'the day header sums two hours of agent time and 8 % covered',
      sum.startsWith('2 h 00 agent time · 8 % covered'),
      sum
    )

    await next.click()
    await next.click()
    t.check('two next days bring Today back', (await title.textContent()) === 'Today')
    t.check(
      'and the lane with it',
      await until(async () => (await win.locator(lane).count()) === 1)
    )

    const foot = (await win.locator('[data-activity-foot]').textContent()) ?? ''
    t.check(
      'the footer says the record stays here',
      foot.includes('Nothing leaves the machine'),
      foot
    )
  } finally {
    await chat.close()
  }
}
