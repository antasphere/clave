// A plugin's own page as a session view, and the boundary around it.
//
// The fixture plugin is LINKED, not bundled: a surface view is how a plugin the
// user installed can render a session at all, which native views deliberately
// do not allow. Three of the checks below are negative — the guest cannot reach
// the app's document, the app's bridge, or any session but the one its lease
// names — and each was mutated red once before being trusted (see the PR).
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { until } from './harness.mjs'
import { openChat, inject } from './chat-view.spec.mjs'

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/surface-view-plugin'
)
const PLUGIN = 'fixture.surface-view'
const VIEW = `${PLUGIN}/log`

/** Walk the menu to a label with the arrows, one press per poll so the
 *  highlight has settled before the next read — pressing faster than the menu
 *  updates overshoots and lands on a neighbour. */
async function choose(win, picker, label) {
  const items = win.getByRole('menuitem')
  await picker.click()
  await items.first().waitFor()
  const highlighted = win.locator('[role="menuitem"][data-highlighted]')
  const landed = await until(
    async () => {
      const current = await highlighted.innerText().catch(() => '')
      if (current.trim() === label) return true
      await win.keyboard.press('ArrowDown')
      return false
    },
    { tries: 12, gapMs: 120 }
  )
  assert.ok(landed, `never highlighted ${label}`)
  await win.keyboard.press('Enter')
  await items.first().waitFor({ state: 'detached' })
}
const guestFrames = (win) => win.frames().filter((f) => f.url().startsWith('clave-preview://'))
const guestFrame = async (win) => until(() => guestFrames(win)[0])
/** The guest frame leased to one session. Two surface panes show the same page
 *  on the same token, so the session it was handed is what tells them apart. */
const guestFor = async (win, sessionId) =>
  until(async () => {
    for (const frame of guestFrames(win)) {
      const held = await frame.evaluate(() => window.__fixture?.state.sessionId).catch(() => null)
      if (held === sessionId) return frame
    }
    return null
  })

export async function run(t) {
  const fixture = await openChat('surface-view')
  const { app, win, record } = fixture
  try {
    await app.evaluate(({ ipcMain }) => {
      globalThis.__viewLeases = []
      const original = ipcMain._invokeHandlers.get('plugins:view-lease')
      ipcMain._invokeHandlers.set('plugins:view-lease', (event, ...args) => {
        const granted = original(event, ...args)
        globalThis.__viewLeases.push(granted.leaseId)
        return granted
      })
    })
    const linked = await win.evaluate(async (dir) => {
      const id = await window.electronAPI.pluginsLink(dir)
      await window.electronAPI.pluginsEnable(id, ['sessions.read', 'sessions.write'])
      return id
    }, FIXTURE)
    assert.equal(linked, PLUGIN)
    t.check('a linked surface plugin activates with its session grants', true)

    // Scoped to this session's pane: a second session opens a pane of its own
    // later, with a picker of its own.
    const picker = win
      .locator(`.chat-host[data-session-id="${record.id}"]`)
      .getByLabel('Change view', { exact: true })
    await picker.waitFor()
    await picker.click()
    assert.deepEqual(await win.getByRole('menuitem').allInnerTexts(), [
      'Chat',
      'Compact',
      'Fixture log'
    ])
    await win.keyboard.press('Escape')
    await win.getByRole('menuitem').first().waitFor({ state: 'detached' })
    t.check('a linked plugin contributes a view the picker offers beside the bundled ones', true)

    await choose(win, picker, 'Fixture log')
    const iframe = win.locator(
      `.chat-host[data-session-id="${record.id}"] [data-view-id="${VIEW}"] iframe`
    )
    await iframe.waitFor()
    const sandbox = await iframe.getAttribute('sandbox')
    assert.equal(sandbox, 'allow-scripts')
    assert.ok(!sandbox.includes('allow-same-origin'))
    assert.match(await iframe.getAttribute('src'), /^clave-preview:\/\//)
    t.check('the guest renders in a sandboxed frame that is never same-origin', true)

    const guest = await guestFrame(win)
    assert.ok(
      await until(
        async () => (await guest.evaluate(() => window.__fixture.state.sessionId)) === record.id
      )
    )
    t.check('the host hands the guest its session id over the init message', true)

    // Through the real path, not the renderer-side injection the chat specs
    // use: the lease subscribes in MAIN, so only what the session manager
    // publishes reaches it — which is the point of a lease.
    await win.evaluate(
      (id) =>
        window.electronAPI.sessionsWrite(id, { type: 'user_message', text: 'seen by the guest' }),
      record.id
    )
    assert.ok(
      await until(async () =>
        (await guest.evaluate(() => window.__fixture.state.events)).some((e) =>
          `${e.text ?? ''}${e.delta ?? ''}`.includes('seen by the guest')
        )
      )
    )
    t.check('the session events reach the guest through the lease', true)

    // NEGATIVE 1 and 2, asserted from inside the guest.
    assert.equal(await guest.evaluate(() => window.__fixture.state.parentDom), 'blocked')
    t.check('the guest cannot reach the app document', true)
    assert.equal(await guest.evaluate(() => window.__fixture.state.electronApi), 'absent')
    t.check('the guest has no electronAPI', true)

    // NEGATIVE 3: a second session exists, and the guest tries to aim a write
    // at it by smuggling its id into the params.
    await win.locator('.launcher-split .launcher-btn').click()
    const second = await until(async () =>
      (await win.evaluate(() => window.electronAPI.sessionsList())).find(
        (s) => s.adapterId === 'echo' && s.id !== record.id
      )
    )
    assert.ok(second)
    const answer = await guest.evaluate(
      (id) => window.__fixture.write('written by the guest', id),
      second.id
    )
    assert.equal(answer.error ?? null, null)
    const leased = win.locator(`.chat-host[data-session-id="${record.id}"]`)
    const other = win.locator(`.chat-host[data-session-id="${second.id}"]`)
    assert.ok(
      await until(async () => (await leased.innerText()).includes('written by the guest')),
      'the leased session never received the write'
    )
    assert.ok(!(await other.innerText()).includes('written by the guest'))
    t.check('a guest write lands on the leased session and never on the one it named', true)

    // The header follows the view ON SCREEN. The conversation view is mounted
    // and hidden behind this one, and it reports a model of its own the moment
    // one is announced; the header must not take it, because the reader is not
    // looking at that view. (Injected on the renderer channel, which is the
    // hidden native view's path and not the lease's.)
    await inject(app, record.id, [
      { type: 'session_meta', model: 'fixture-model', providerSessionId: 'fixture' }
    ])
    await until(async () => (await leased.innerText()).includes('fixture-model'), {
      tries: 6,
      gapMs: 150
    })
    assert.equal(await leased.locator('.pane-header-meta').count(), 0)
    t.check('a view that is not on screen never writes the header', true)

    // TWO guest frames at once, of two different sessions. Every host listens on
    // the same window for messages, so what keeps one guest out of another's
    // lease is the host checking that the message came from ITS OWN frame.
    const secondPicker = win
      .locator(`.chat-host[data-session-id="${second.id}"]`)
      .getByLabel('Change view', { exact: true })
    await secondPicker.waitFor()
    await choose(win, secondPicker, 'Fixture log')
    await until(async () => guestFrames(win).length === 2)
    const guestA = await guestFor(win, record.id)
    const guestB = await guestFor(win, second.id)
    assert.ok(guestA && guestB && guestA !== guestB)
    await guestA.evaluate(() => window.__fixture.write('only the first guest said this'))
    assert.ok(
      await until(async () => (await leased.innerText()).includes('only the first guest said this'))
    )
    // The other session must not have heard it: its host saw the message and
    // dropped it, because it did not come from the frame it hosts.
    assert.ok(!(await other.innerText()).includes('only the first guest said this'))
    assert.equal(
      await guestB.evaluate(() => window.__fixture.state.events.length),
      await guestB.evaluate(
        () =>
          window.__fixture.state.events.filter((e) => !String(e.text ?? '').includes('first guest'))
            .length
      )
    )
    t.check('one guest cannot drive another guest lease, in the same window', true)

    // Disabling the plugin takes the view off the pane AND the authority with
    // it: the guest's frame goes, and the lease it held answers nothing.
    const held = await app.evaluate(() => globalThis.__viewLeases.at(-1))
    await win.evaluate(() => window.electronAPI.pluginsDisable('fixture.surface-view'))
    assert.ok(
      await until(async () => (await win.locator(`[data-view-id="${VIEW}"]`).count()) === 0)
    )
    assert.match(
      await win.evaluate(
        (leaseId) =>
          window.electronAPI
            .pluginsViewRequest(leaseId, 'session.get')
            .then(() => 'answered')
            .catch((error) => String(error)),
        held
      ),
      /Unknown view lease/
    )
    // The pane did not go blank: it fell back to a view that is still there.
    assert.ok(
      await until(async () => (await win.locator('[data-view-id]:not([hidden])').count()) > 0)
    )
    await win.evaluate(() =>
      window.electronAPI.pluginsEnable('fixture.surface-view', ['sessions.read', 'sessions.write'])
    )
    // Attached, not visible: a second session's pane is the one on screen by
    // now, and this one is rendered behind it.
    await leased.locator(`[data-view-id="${VIEW}"] iframe`).first().waitFor({ state: 'attached' })
    t.check('disabling the plugin removes its view and revokes the lease it held', true)

    // The lease is the pane's, and main is what enforces it: a renderer that
    // reloads cannot revoke what it no longer remembers, so main drops the
    // lease itself. Reload, then try the lease that was minted: it answers
    // nothing, although the plugin is still running and still granted.
    const minted = await app.evaluate(() => globalThis.__viewLeases ?? [])
    assert.ok(minted.length >= 1)
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    const afterReload = await win.evaluate(
      (leaseId) =>
        window.electronAPI
          .pluginsViewRequest(leaseId, 'session.get')
          .then(() => 'answered')
          .catch((error) => String(error)),
      minted[minted.length - 1]
    )
    assert.match(afterReload, /Unknown view lease/)
    const stillActive = await win.evaluate(async () => {
      const list = await window.electronAPI.pluginsList()
      return list.find((p) => p.id === 'fixture.surface-view')?.status ?? null
    })
    assert.equal(stillActive, 'active')
    t.check('a lease dies with the renderer that held it, the plugin keeps running', true)
  } finally {
    await fixture.close()
  }
}
