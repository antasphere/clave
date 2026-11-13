// The pane header's status, the sidebar row's own glyph: with nothing to say
// yet it is an empty grey ring there (and only there, the sidebar row stays
// empty), it gives way to the spinner once the agent works, and its centre
// sits as far from the header's left edge as from its top.
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

export async function run(t) {
  const chat = await openChat('pane-header-status')
  const { win, record, fixture } = chat
  try {
    const header = `.chat-host[data-session-id="${record.id}"] .pane-header`
    const row = `[data-sidebar-item-id="${record.id}"]`
    await win.locator(`${header} .sidebar-tab-status`).waitFor()

    const fresh = await win.evaluate(
      ({ header, row }) => ({
        header: !!document.querySelector(`${header} .sidebar-tab-status .sidebar-tab-placeholder`),
        sidebar: !!document.querySelector(`${row} .sidebar-tab-placeholder`),
        glyph: document.querySelector(`${header} .sidebar-tab-status`)?.getAttribute('data-glyph')
      }),
      { header, row }
    )
    t.check('a fresh chat: the header shows the empty ring', fresh.header && !fresh.glyph, fresh)
    t.check('the sidebar row does not', !fresh.sidebar, fresh)

    const geometry = await win.evaluate((header) => {
      const h = document.querySelector(header)
      const box = h.getBoundingClientRect()
      const border = parseFloat(getComputedStyle(h).borderBottomWidth)
      const slot = h.querySelector('.sidebar-tab-status').getBoundingClientRect()
      return {
        fromTop: slot.top + slot.height / 2 - box.top,
        fromLeft: slot.left + slot.width / 2 - box.left,
        height: box.height - border
      }
    }, header)
    t.check(
      "the status's centre is as far from the left edge as from the top",
      Math.abs(geometry.fromTop - geometry.fromLeft) <= 0.5 &&
        Math.abs(geometry.fromTop - geometry.height / 2) <= 0.5,
      geometry
    )

    await inject(fixture, record.id, [{ type: 'state_change', state: 'working' }])
    const working = await until(async () =>
      (await win.locator(`${header} .sidebar-tab-spinner`).count()) ? true : null
    )
    t.check('working: the spinner replaces the ring', !!working)
    t.equal(
      'no ring while there is a glyph',
      await win.locator(`${header} .sidebar-tab-placeholder`).count(),
      0
    )
  } finally {
    await chat.close()
  }
}
