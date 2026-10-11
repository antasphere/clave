// The Activity page (PRDCT-3385): Settings → Activity draws today's record.
// An echo session works for a second, and the page shows it as a lane with a
// burst, a coverage that is not nothing, and a day you can step away from and
// back to. Built on the echo chat like activity-record.spec.mjs; the burst
// exists only if the recorder wrote the session's state rows, so a recorder
// that stops writing them turns this spec red.
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

const pause = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(t) {
  const chat = await openChat('activity-page')
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

    await next.click()
    t.check('the next day brings Today back', (await title.textContent()) === 'Today')
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
