// Pinned to the in-process server for the reason chat-view.spec.mjs gives:
// the chat's views are plugin views leased from the shell's plugin host.
/**
 * Appearance → Agent mark, through the bundled orbs plugin (`plugins/orbs`).
 *
 * The mark is what stands for an agent in three slots — the sidebar tab's
 * icon, the chat pane's status before its title, the mark at the end of a
 * transcript while the agent works — and for a tool call in flight. By
 * default it is the provider's logo and the kind's glyph; a mark pack a
 * plugin contributes (`contributes.marks[]`) swaps all of them, here for one
 * of the nine `thinking-orbs` animations the user picks, moving only while
 * the agent works. Everything here fails silently in the app — a canvas that
 * never mounts leaves an empty slot, a ring left on an orb reads as a glitch,
 * a pack whose plugin is disabled must fall back rather than vanish, and a
 * choice not written to localStorage is forgotten at the next launch — so
 * the spec asserts the rendered element, its state attributes, the ring's
 * computed style and the saved keys, through the echo adapter so nothing
 * calls a model.
 */
import assert from 'node:assert/strict'
import { until } from './harness.mjs'
import { openChat, inject } from './chat-view.spec.mjs'

const SHOTS = process.env.ORB_SHOTS || ''
const PACK = 'clave.orbs/orbs'

export async function run(t) {
  const chat = await openChat('agent-mark-orb')
  const { app, win, record } = chat
  const tab = `[data-sidebar-item-id="${record.id}"] .sidebar-tab-icon`
  const shot = async (name) => {
    if (SHOTS) await win.screenshot({ path: `${SHOTS}/${name}.png` })
  }
  const kernelState = (state) =>
    app.evaluate(
      ({ BrowserWindow }, { id, state }) =>
        BrowserWindow.getAllWindows()[0].webContents.send(`agent:state:${id}`, state),
      { id: record.id, state }
    )
  try {
    // The default: the provider's logo, an SVG, no canvas anywhere.
    assert.equal(await win.locator(`${tab} svg`).count(), 1)
    assert.equal(await win.locator('canvas[data-orb-state]').count(), 0)
    t.check('a fresh app draws the logo on the tab and no orb', true)

    await win.click('.sidebar-footer-btn[aria-label="Settings"]')
    await win.click('[data-settings-nav-row="appearance"]')
    await win.locator('[data-agent-mark-option="logo"][data-active="true"]').waitFor()
    assert.equal(
      await win.locator('[data-agent-mark-option]').count(),
      2,
      'the row offers the logo and the one bundled pack'
    )
    assert.equal(
      await win.locator('.orb-swatch').count(),
      0,
      'no picker while the logo is the mark'
    )
    await win.click(`[data-agent-mark-option="${PACK}"]`)
    await win.locator(`[data-agent-mark-option="${PACK}"][data-active="true"]`).waitFor()
    const swatches = await win.locator('.orb-swatch').count()
    t.equal('the orb picker offers the nine orbs the library ships', swatches, 9)
    assert.equal(
      await win.locator('.orb-swatch[data-selected="true"]').getAttribute('data-orb-option'),
      'working'
    )
    // Every swatch draws its own orb, live.
    assert.equal(await win.locator('.orb-swatch canvas[data-working="true"]').count(), 9)
    await win.click('[data-orb-option="weaving"]')
    await win.locator('.orb-swatch[data-selected="true"][data-orb-option="weaving"]').waitFor()
    t.check('the pack’s own settings block offers the nine orbs; picking one selects it', true)
    await shot('settings-orb')

    // The sample beside the switch shows the orb at rest and at work.
    assert.equal(
      await win
        .locator('[data-testid="agent-mark-sample"] canvas[data-orb-state="weaving"]')
        .count(),
      2
    )

    // Back on the chat tab: the tab icon is the chosen orb, still.
    await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
    await win.locator(`[data-sidebar-item-id="${record.id}"] button`).first().click()
    await win.locator('[data-testid="chat-view"]').waitFor()
    const tabOrb = win.locator(`${tab}[data-mark="pack"] canvas[data-orb-state="weaving"]`)
    await tabOrb.waitFor()
    assert.equal(await win.locator(`${tab} svg`).count(), 0, 'the logo is gone from the tab')
    assert.equal(await tabOrb.getAttribute('data-working'), null, 'at rest while idle')
    // Scoped to the pane: the Settings page stays mounted with its own two samples.
    const pane = `.chat-host[data-session-id="${record.id}"]`
    assert.equal(
      await win.locator(`${pane} .pane-status-mark canvas[data-orb-state="weaving"]`).count(),
      1
    )
    assert.equal(
      await win.locator(`${pane} .pane-status-dot`).count(),
      0,
      'the pane dot is the orb now'
    )
    t.check('the tab icon and the pane status are the chosen orb, still while idle', true)

    // The agent works: the orb moves, on the tab and at the end of the transcript,
    // and the logo's ring stays off the tab.
    await kernelState('working')
    await inject(chat.fixture, record.id, [{ type: 'state_change', state: 'working' }])
    await win.locator(`${tab}[data-status="working"] canvas[data-working="true"]`).waitFor()
    const mark = '[data-testid="chat-view"] .chat-provider-mark'
    await win.locator(`${mark}[data-mark="pack"] canvas[data-working="true"]`).waitFor()
    assert.equal(
      await win.locator(`${mark} svg`).count(),
      0,
      'the transcript mark is the orb, not the breathing logo'
    )
    const ring = await win.evaluate(
      (sel) => getComputedStyle(document.querySelector(sel), '::before').content,
      `${tab}[data-status="working"]`
    )
    assert.equal(ring, 'none', `the working ring must stay off the orb, got ${ring}`)
    const breathing = await win.evaluate(
      (sel) => getComputedStyle(document.querySelector(sel)).animationName,
      mark
    )
    assert.equal(breathing, 'none', `the orb must not also breathe, got ${breathing}`)
    await shot('chat-working-orb')
    t.check(
      'while working, the orb moves on the tab and in the chat, with no ring and no breathing',
      true
    )

    // A tool call in flight is its kind's orb; finished, it keeps the kind's glyph.
    await inject(chat.fixture, record.id, [
      { type: 'tool_call', id: 'o1', name: 'Grep', input: { pattern: 'orb' } }
    ])
    const row = win.locator('[data-testid="chat-view"] .chat-tool-status[data-running="true"]')
    await row.locator('canvas[data-orb-state="searching"][data-working="true"]').waitFor()
    assert.equal(await row.getAttribute('data-mark'), 'pack')
    await inject(chat.fixture, record.id, [{ type: 'tool_result', id: 'o1', output: 'found' }])
    await win
      .locator('[data-testid="chat-view"] .chat-tool-status[aria-label="Complete"]')
      .waitFor()
    assert.equal(
      await win.locator('[data-testid="chat-view"] .chat-tool-status canvas').count(),
      0,
      'a finished call keeps its glyph'
    )
    t.check('a running tool call is its kind’s orb; a finished one is its glyph again', true)

    // The agent stops: the orb rests, the transcript mark leaves.
    await inject(chat.fixture, record.id, [{ type: 'state_change', state: 'done' }])
    await kernelState('done')
    assert.ok(
      await until(async () => (await win.locator(mark).count()) === 0),
      'the mark must leave when the agent stops'
    )
    await until(async () => (await tabOrb.getAttribute('data-working')) === null)
    t.check('when the agent stops, the orb rests and the transcript mark leaves', true)

    // Saved, so the next launch draws the same.
    const saved = await win.evaluate(() => ({
      mark: localStorage.getItem('clave-agent-mark'),
      orb: localStorage.getItem('clave-orbs-state')
    }))
    t.equal('the mark is saved as the pack’s id', saved.mark, PACK)
    t.equal('the orb is saved by the pack', saved.orb, 'weaving')

    // The pack belongs to its plugin: disabled, the logo is back and the
    // choice is kept for when it returns.
    await win.evaluate(() => window.electronAPI.pluginsDisable('clave.orbs'))
    await win.locator(`${tab} svg`).waitFor()
    assert.ok(
      await until(async () => (await win.locator('canvas[data-orb-state]').count()) === 0),
      'no orb may stay while the plugin is disabled'
    )
    await win.evaluate(() => window.electronAPI.pluginsEnable('clave.orbs', []))
    await tabOrb.waitFor()
    assert.equal(
      await win.evaluate(() => localStorage.getItem('clave-agent-mark')),
      PACK,
      'the choice survives the plugin being off'
    )
    t.check('disabling the plugin falls back to the logo; enabling it brings the orb back', true)

    // Back to the logo: the SVG returns, the canvases go.
    await win.click('.sidebar-footer-btn[aria-label="Settings"]')
    await win.click('[data-settings-nav-row="appearance"]')
    await win.click('[data-agent-mark-option="logo"]')
    await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
    await win.locator(`[data-sidebar-item-id="${record.id}"] button`).first().click()
    await win.locator(`${tab} svg`).waitFor()
    assert.equal(await win.locator('canvas[data-orb-state]').count(), 0)
    t.check('switching back to the logo restores the brand marks everywhere', true)
  } finally {
    await chat.close()
  }
}
