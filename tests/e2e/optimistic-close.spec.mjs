// Closing a tab removes its row at once (PRDCT-5315). A Claude chat's process
// takes about a second to exit after its stop signal, and every close used to
// wait for it before the row left the sidebar (974 to 1236 ms measured on
// 27 November 2026). The chat here runs a stand-in CLI on a Clave server that
// waits 900 ms after its stop signal, as the real CLI does.
//
// Fails if: the row is still in the sidebar 400 ms after « Delete » is
// clicked, the stand-in is never stopped, or a tab whose server is gone when
// it is closed does not come back with the mark before its title and a
// tooltip naming the server and saying the tab is still open.
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { REPO } from './harness.mjs'
import {
  connectMac,
  eventually,
  fleetWorld,
  owned,
  request,
  showServer
} from './fixtures/fleet-world.mjs'

const EXIT_DELAY_MS = 900
const ROW_GONE_WITHIN_MS = 400

const lines = (file) => {
  try {
    return readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Arm a watch for the row's removal; the promise resolves with the ms from
 *  the arm to the row leaving the DOM, or -1 after five seconds. */
const armRowGone = (win, key) =>
  win.evaluate((key) => {
    const start = performance.now()
    window.__rowGone = new Promise((resolve) => {
      const gone = () => !document.querySelector(`[data-sidebar-item-id="${CSS.escape(key)}"]`)
      const timer = setTimeout(() => {
        obs.disconnect()
        resolve(-1)
      }, 5000)
      const obs = new MutationObserver(() => {
        if (!gone()) return
        obs.disconnect()
        clearTimeout(timer)
        resolve(Math.round(performance.now() - start))
      })
      obs.observe(document.body, { subtree: true, childList: true })
    })
  }, key)

async function closeFromSidebar(win, key) {
  const row = win.locator(`[data-sidebar-item-id="${key}"] .sidebar-item`)
  await row.hover()
  await row.locator('.sidebar-item-close').click()
  const confirm = win.getByRole('button', { name: 'Delete', exact: true })
  await confirm.waitFor()
  await armRowGone(win, key)
  await confirm.click()
}

export async function run(t) {
  const world = await fleetWorld('optimistic-close', { count: 1 })
  try {
    const [server] = world.servers
    const processes = () => lines(path.join(server.root, 'claude-stub-processes.jsonl'))
    await request(server, '/launch-profiles', {
      profile: {
        id: 'slow-exit-stub',
        name: 'Slow exit stream stub',
        family: 'claude',
        command: [process.execPath, path.join(REPO, 'tests/e2e/fixtures/claude-stream-stub.mjs')],
        additionalArgs: ['--stub-exit-delay', String(EXIT_DELAY_MS)]
      }
    })
    const start = () =>
      request(server, '/sessions/start', {
        cwd: server.root,
        options: { claudeMode: true, launchProfileId: 'chat:claude:slow-exit-stub' }
      })
    const chat = await start()
    const spare = await start()

    const mac = await world.mac('close')
    await connectMac(mac, world.servers, { ui: false })
    const owner = mac.owners[0].id
    const { win } = mac
    const key = owned('session', owner, chat.id)
    const spareKey = owned('session', owner, spare.id)
    await showServer(mac, 0)

    // Each chat's CLI runs on the server; the one this chat runs is the one
    // its message reaches.
    const inputs = () => lines(path.join(server.root, 'claude-stub-input.jsonl'))
    await win.locator(`[data-sidebar-item-id="${key}"]`).click()
    const composer = win
      .locator(`[data-session-id="${key}"] [data-testid="chat-view"]`)
      .getByRole('textbox', { name: 'Message', exact: true })
    await eventually(() => composer.isEnabled(), 'the chat composer is enabled')
    await composer.fill('hello from the close spec')
    await composer.press('Enter')
    const reached = () =>
      inputs().find(
        (i) =>
          i.frame.type === 'user' &&
          JSON.stringify(i.frame.message?.content ?? '').includes('hello from the close spec')
      )
    await eventually(() => !!reached(), "the chat's message reaches its stand-in CLI")
    const { pid } = reached()
    t.check('the chat runs on a stand-in CLI that is alive', alive(pid) && processes().length >= 1)

    await closeFromSidebar(win, key)
    const goneMs = await win.evaluate(() => window.__rowGone)
    t.check(
      `the chat's row leaves within ${ROW_GONE_WITHIN_MS} ms of « Delete », its CLI taking ${EXIT_DELAY_MS} ms to stop`,
      goneMs >= 0 && goneMs < ROW_GONE_WITHIN_MS,
      `row gone after ${goneMs} ms`
    )
    await eventually(() => !alive(pid), 'the stand-in CLI is stopped behind the row')
    t.check('the stand-in CLI was stopped', !alive(pid))
    await eventually(
      async () =>
        !(await win.evaluate((id) => window.electronAPI.fleetSnapshot(id), owner)).sessions.some(
          (s) => s.id.endsWith(chat.id)
        ),
      'the server no longer lists the chat'
    )
    t.check(
      'the row does not come back once the stop returned',
      (await win.locator(`[data-sidebar-item-id="${key}"]`).count()) === 0
    )

    // The server goes away; closing its tab cannot be done, so the tab comes
    // back where it was, with the mark and the reason.
    await server.stop()
    await closeFromSidebar(win, spareKey)
    const spareGoneMs = await win.evaluate(() => window.__rowGone)
    t.check(
      'the row of a tab whose server is gone still leaves at once',
      spareGoneMs >= 0 && spareGoneMs < ROW_GONE_WITHIN_MS,
      `row gone after ${spareGoneMs} ms`
    )
    const mark = win.locator(`[data-sidebar-item-id="${spareKey}"] [data-testid="tab-close-error"]`)
    await eventually(async () => (await mark.count()) === 1, 'the tab comes back with the mark')
    t.check('the tab comes back with the mark before its title', (await mark.count()) === 1)
    await mark.hover()
    // Radix draws the content twice, once for screen readers.
    const tooltip = win
      .getByText('Personal VPS 1 could not close this tab', { exact: false })
      .first()
    await eventually(() => tooltip.isVisible(), 'the tooltip names the server')
    t.check('hovering the mark names the server that could not close it', await tooltip.isVisible())
    t.check(
      'the tooltip says the tab is still open',
      await win.getByText('The tab is still open. Close it again to retry.').first().isVisible()
    )
    console.log(`the mark says: ${await tooltip.textContent()}`)
    t.check('no page error', mac.errors.length === 0, mac.errors.join('\n'))
  } finally {
    await world.close()
  }
}
